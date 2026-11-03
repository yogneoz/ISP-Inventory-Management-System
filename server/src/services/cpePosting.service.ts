/**
 * Ledger postings for the fixed-asset register.
 *
 * This module owns the value side of an asset's life: capitalisation (direct,
 * or the reclassification of a cost a purchase bill already put into
 * inventory), periodic depreciation, and disposal. Deployed customer-premises
 * equipment is the stock-funded case of the same life: a unit issued from
 * branch stock moves Inventory → Deployed CPE Assets at the stock row's moving
 * weighted average, and a release reverses that movement at the recorded issue
 * cost.
 *
 * Depreciation and disposal read the value actually posted for the asset from
 * the journal lines, never the register's cached columns, so a repeated run or
 * a stale mirror cannot double-count. Every account comes from the chart's
 * posting roles; nothing here knows an account code.
 *
 * The caller owns the transaction; these functions only resolve accounts and
 * write the balanced journal, so the asset row and its ledger entry commit (or
 * roll back) together.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import {
  ACCOUNTS_BY_POSTING_ROLES_SQL,
  ASSET_DEPRECIATION_POSTED_SQL,
  JOURNAL_FIND_BY_SOURCE_SQL,
  JOURNAL_SOURCE_ACCOUNT_NET_SQL,
  type PostingRole,
} from '../models/accounting.repo';
import {
  postJournal,
  type AccountingClient,
  type JournalLineInput,
} from './accounting.service';

interface PostingAccount {
  id: string;
  code: string;
  name: string;
  postingRole: string | null;
  isControl?: boolean;
  subledgerType?: string;
}

export interface CpeValueMovement {
  branchId: string;
  productId: string;
  quantity: number;
  unitCost: number;
  dateAD: string;
  sourceType: 'CPE_ASSET' | 'CPE_DEVICE';
  sourceId: string;
  memo: string;
  actor?: string | null;
}

async function loadCpeAccounts(client: AccountingClient): Promise<{
  cpeAsset: PostingAccount;
  inventory: PostingAccount;
}> {
  const rows = (await client.query(ACCOUNTS_BY_POSTING_ROLES_SQL, [
    ['CPE_ASSET', 'INVENTORY'],
  ])).rows as PostingAccount[];
  const cpeAsset = rows.find((row) => row.postingRole === 'CPE_ASSET');
  const inventory = rows.find((row) => row.postingRole === 'INVENTORY');
  const missing = [
    !cpeAsset ? 'CPE_ASSET' : '',
    !inventory ? 'INVENTORY' : '',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ApiError(
      400,
      `Accounting is not configured for CPE movements: no active account has the ${missing.join(
        ', '
      )} posting default. Map it in Accounting → Posting defaults, then post the device again.`
    );
  }
  return { cpeAsset: cpeAsset!, inventory: inventory! };
}

function valueOf(input: CpeValueMovement): number {
  return roundMoney(Math.abs(Number(input.quantity) || 0) * Math.max(0, Number(input.unitCost) || 0));
}

/** Stock issue: Inventory → Deployed CPE Assets at the issue cost. */
export async function postCpeIssueJournal(client: AccountingClient, input: CpeValueMovement) {
  const value = valueOf(input);
  if (value < 0.005) return null;
  const accounts = await loadCpeAccounts(client);
  const lines: JournalLineInput[] = [
    { accountId: accounts.cpeAsset.id, debit: value, credit: 0, memo: `${input.memo} — CPE asset issued` },
    { accountId: accounts.inventory.id, debit: 0, credit: value, memo: `${input.memo} — inventory released` },
  ];
  return postJournal(client, {
    journalDateAD: input.dateAD,
    branchId: input.branchId,
    memo: input.memo,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    actor: input.actor || null,
    lines,
  });
}

/** Release/collection: Deployed CPE Assets → Inventory at the recorded issue cost. */
export async function postCpeReleaseJournal(client: AccountingClient, input: CpeValueMovement) {
  const value = valueOf(input);
  if (value < 0.005) return null;
  const accounts = await loadCpeAccounts(client);
  const lines: JournalLineInput[] = [
    { accountId: accounts.inventory.id, debit: value, credit: 0, memo: `${input.memo} — inventory returned` },
    { accountId: accounts.cpeAsset.id, debit: 0, credit: value, memo: `${input.memo} — CPE asset released` },
  ];
  return postJournal(client, {
    journalDateAD: input.dateAD,
    branchId: input.branchId,
    memo: input.memo,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    actor: input.actor || null,
    lines,
  });
}

/**
 * Resolve posting defaults for an asset journal. `required` roles refuse the
 * document when unmapped; `optional` roles are returned only when the chart has
 * one (disposal gain/loss depend on the sale outcome, so both cannot be
 * required).
 */
async function loadAssetAccounts(
  client: AccountingClient,
  required: readonly PostingRole[],
  optional: readonly PostingRole[] = []
): Promise<Record<string, PostingAccount>> {
  const roles = [...new Set<PostingRole>([...required, ...optional])];
  const rows = (await client.query(ACCOUNTS_BY_POSTING_ROLES_SQL, [roles])).rows as PostingAccount[];
  const byRole: Record<string, PostingAccount> = {};
  for (const row of rows) {
    if (row.postingRole) byRole[row.postingRole] = row;
  }
  const missing = required.filter((role) => !byRole[role]);
  if (missing.length > 0) {
    throw new ApiError(
      400,
      `Accounting is not configured for fixed assets: no active account has the ${missing.join(
        ', '
      )} posting default. Map it in Accounting → Posting defaults, then post again.`
    );
  }
  return byRole;
}

function needAccount(
  accounts: Record<string, PostingAccount>,
  role: PostingRole,
  subject: string
): PostingAccount {
  const account = accounts[role];
  if (!account) {
    throw new ApiError(
      400,
      `Accounting is not configured for ${subject}: no active account has the ${role} posting default. Map it in Accounting → Posting defaults, then post again.`
    );
  }
  return account;
}

/** Cash/bank for a settlement method; CREDIT and an unnamed supplier mean AP. */
function settlementRole(method: unknown, hasSupplier: boolean): PostingRole {
  const normalized = String(method || '').trim().toUpperCase();
  if (normalized === 'CREDIT') return 'AP_CONTROL';
  if (['BANK', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE', 'CARD'].includes(normalized)) return 'BANK';
  if (normalized === 'CASH') return 'CASH';
  // No method named: a supplier name means it was bought on credit; otherwise
  // the common direct-capitalisation case is a cash purchase.
  return hasSupplier ? 'AP_CONTROL' : 'CASH';
}

function controlLine(
  account: PostingAccount,
  debit: number,
  credit: number,
  partyId: string | null,
  partyName: string | null,
  memo: string
): JournalLineInput {
  return {
    accountId: account.id,
    debit,
    credit,
    memo,
    subledgerType: account.subledgerType || 'SUPPLIER',
    partyId,
    partyName,
  };
}

export interface FixedAssetAcquisitionInput {
  assetId: string;
  tagNumber: string;
  branchId: string;
  dateAD: string;
  cost: number;
  /** The purchase bill whose line funded the asset, when there is one. */
  purchaseInvoiceId?: string | null;
  purchaseInvoiceNumber?: string | null;
  /** True when the bill's own journal is POSTED (its payable already exists). */
  invoicePosted?: boolean;
  supplierId?: string | null;
  supplierName?: string | null;
  /** CASH / BANK_TRANSFER / CHEQUE / ONLINE / CARD / CREDIT, as the UI sends it. */
  paymentMethod?: string | null;
  actor?: string | null;
}

/**
 * Capitalise a fixed asset.
 *
 * A purchase bill has already debited inventory and credited the supplier, so
 * capitalising its line moves the cost out of inventory rather than raising a
 * second payable. A legacy bill with no posted journal has no payable in the
 * ledger yet, so capitalisation recognises it. Direct capitalisation settles
 * against cash/bank, or AP when it was bought on supplier credit.
 */
export async function postFixedAssetAcquisitionJournal(
  client: AccountingClient,
  input: FixedAssetAcquisitionInput
) {
  const cost = roundMoney(Math.max(0, Number(input.cost) || 0));
  if (cost < 0.005) return null;

  // A retried create must not post a second acquisition for the same asset.
  const existing = (await client.query(JOURNAL_FIND_BY_SOURCE_SQL, [
    'FIXED_ASSET_ACQUISITION',
    input.assetId,
  ])).rows[0];
  if (existing) return null;

  const invoiceRef = input.purchaseInvoiceNumber || input.purchaseInvoiceId || '';
  let memo = `Fixed asset ${input.tagNumber} capitalised`;
  let lines: JournalLineInput[];

  if (input.purchaseInvoiceId && input.invoicePosted) {
    const accounts = await loadAssetAccounts(client, ['FIXED_ASSET', 'INVENTORY']);
    memo += ` — cost reclassified from inventory for purchase invoice ${invoiceRef}`;
    lines = [
      { accountId: accounts.FIXED_ASSET.id, debit: cost, credit: 0, memo },
      { accountId: accounts.INVENTORY.id, debit: 0, credit: cost, memo: `${memo} — inventory released` },
    ];
  } else if (input.purchaseInvoiceId) {
    const accounts = await loadAssetAccounts(client, ['FIXED_ASSET', 'AP_CONTROL']);
    memo += ` — payable recognised for purchase invoice ${invoiceRef}`;
    lines = [
      { accountId: accounts.FIXED_ASSET.id, debit: cost, credit: 0, memo },
      controlLine(
        accounts.AP_CONTROL,
        0,
        cost,
        input.supplierId || null,
        input.supplierName || 'Fixed asset supplier',
        memo
      ),
    ];
  } else {
    const hasSupplier = Boolean(input.supplierName || input.supplierId);
    const role = settlementRole(input.paymentMethod, hasSupplier);
    const accounts = await loadAssetAccounts(client, ['FIXED_ASSET', role]);
    memo += role === 'AP_CONTROL' ? ' — bought on supplier credit' : ' — settled directly';
    lines = [
      { accountId: accounts.FIXED_ASSET.id, debit: cost, credit: 0, memo },
      role === 'AP_CONTROL'
        ? controlLine(
            accounts.AP_CONTROL,
            0,
            cost,
            input.supplierId || null,
            input.supplierName || 'Fixed asset supplier',
            memo
          )
        : { accountId: accounts[role].id, debit: 0, credit: cost, memo },
    ];
  }

  return postJournal(client, {
    journalDateAD: input.dateAD,
    branchId: input.branchId,
    memo,
    sourceType: 'FIXED_ASSET_ACQUISITION',
    sourceId: input.assetId,
    actor: input.actor || null,
    lines,
  });
}

export interface FixedAssetDepreciationInput {
  assetId: string;
  tagNumber: string;
  branchId: string;
  periodKey: string;
  dateAD: string;
  amount: number;
  actor?: string | null;
}

/** One period's depreciation for one asset: expense → accumulated depreciation. */
export async function postFixedAssetDepreciationJournal(
  client: AccountingClient,
  input: FixedAssetDepreciationInput
) {
  const amount = roundMoney(Math.max(0, Number(input.amount) || 0));
  if (amount < 0.005) return null;
  const accounts = await loadAssetAccounts(client, [
    'DEPRECIATION_EXPENSE',
    'ACCUMULATED_DEPRECIATION',
  ]);
  const memo = `Depreciation of fixed asset ${input.tagNumber} for ${input.periodKey}`;
  const lines: JournalLineInput[] = [
    {
      accountId: accounts.DEPRECIATION_EXPENSE.id,
      debit: amount,
      credit: 0,
      memo,
    },
    {
      accountId: accounts.ACCUMULATED_DEPRECIATION.id,
      debit: 0,
      credit: amount,
      memo,
    },
  ];
  return postJournal(client, {
    journalDateAD: input.dateAD,
    branchId: input.branchId,
    memo,
    sourceType: 'FIXED_ASSET_DEPRECIATION',
    sourceId: `${input.assetId}:${input.periodKey}`,
    actor: input.actor || null,
    lines,
  });
}

export interface FixedAssetDisposalInput {
  assetId: string;
  tagNumber: string;
  branchId: string;
  dateAD: string;
  proceeds?: number;
  paymentMethod?: string | null;
  actor?: string | null;
}

/**
 * Dispose of a capitalised asset: clear its posted cost and accumulated
 * depreciation, bring in the proceeds, and recognise the difference as a gain
 * or a loss. The cost account is whichever one actually holds the value
 * (direct capitalisation vs stock-deployed CPE), read from the journal lines.
 */
export async function postFixedAssetDisposalJournal(
  client: AccountingClient,
  input: FixedAssetDisposalInput
) {
  const existing = (await client.query(JOURNAL_FIND_BY_SOURCE_SQL, [
    'FIXED_ASSET_DISPOSAL',
    input.assetId,
  ])).rows[0];
  if (existing) {
    throw new ApiError(
      409,
      `Fixed asset ${input.tagNumber} is already disposed in the ledger (journal ${existing.journalNo}).`
    );
  }

  const accounts = await loadAssetAccounts(
    client,
    ['FIXED_ASSET', 'ACCUMULATED_DEPRECIATION'],
    ['CPE_ASSET', 'CASH', 'BANK', 'GAIN_ON_DISPOSAL', 'LOSS_ON_DISPOSAL']
  );
  const [fixedValue, cpeValue] = await Promise.all([
    client.query(JOURNAL_SOURCE_ACCOUNT_NET_SQL, [input.assetId, [accounts.FIXED_ASSET.id]]),
    accounts.CPE_ASSET
      ? client.query(JOURNAL_SOURCE_ACCOUNT_NET_SQL, [input.assetId, [accounts.CPE_ASSET.id]])
      : Promise.resolve({ rows: [{ net: 0 }] } as any),
  ]);
  const fixedCost = roundMoney(Math.max(0, Number(fixedValue.rows[0]?.net) || 0));
  const cpeCost = roundMoney(Math.max(0, Number(cpeValue.rows[0]?.net) || 0));
  const cost = roundMoney(fixedCost + cpeCost);
  if (cost < 0.005) {
    throw new ApiError(
      409,
      `Fixed asset ${input.tagNumber} has no posted cost in this branch's ledger, so a disposal would credit an asset that was never capitalised. Capitalise it first, then dispose.`
    );
  }

  const accumulatedResult = await client.query(ASSET_DEPRECIATION_POSTED_SQL, [
    `${input.assetId}:`,
    accounts.ACCUMULATED_DEPRECIATION.id,
  ]);
  const accumulated = Math.min(
    roundMoney(Math.max(0, Number(accumulatedResult.rows[0]?.posted) || 0)),
    cost
  );
  const proceeds = roundMoney(Math.max(0, Number(input.proceeds) || 0));
  const netBookValue = roundMoney(cost - accumulated);
  const gain = proceeds > netBookValue ? roundMoney(proceeds - netBookValue) : 0;
  const loss = proceeds < netBookValue ? roundMoney(netBookValue - proceeds) : 0;

  const memo = `Disposal of fixed asset ${input.tagNumber}`;
  const lines: JournalLineInput[] = [];
  if (accumulated > 0) {
    lines.push({
      accountId: accounts.ACCUMULATED_DEPRECIATION.id,
      debit: accumulated,
      credit: 0,
      memo: `${memo} — accumulated depreciation cleared`,
    });
  }
  if (proceeds > 0) {
    const role = settlementRole(input.paymentMethod, false);
    if (role === 'AP_CONTROL') {
      throw new ApiError(400, 'Disposal proceeds must be received by cash or bank, not on credit.');
    }
    lines.push({
      accountId: needAccount(accounts, role, 'fixed-asset disposal').id,
      debit: proceeds,
      credit: 0,
      memo: `${memo} — proceeds received`,
    });
  }
  if (loss > 0) {
    lines.push({
      accountId: needAccount(accounts, 'LOSS_ON_DISPOSAL', 'fixed-asset disposal').id,
      debit: loss,
      credit: 0,
      memo: `${memo} — loss on disposal`,
    });
  }
  if (fixedCost > 0) {
    lines.push({
      accountId: accounts.FIXED_ASSET.id,
      debit: 0,
      credit: fixedCost,
      memo: `${memo} — cost cleared`,
    });
  }
  if (cpeCost > 0) {
    lines.push({
      accountId: needAccount(accounts, 'CPE_ASSET', 'fixed-asset disposal').id,
      debit: 0,
      credit: cpeCost,
      memo: `${memo} — deployed CPE cost cleared`,
    });
  }
  if (gain > 0) {
    lines.push({
      accountId: needAccount(accounts, 'GAIN_ON_DISPOSAL', 'fixed-asset disposal').id,
      debit: 0,
      credit: gain,
      memo: `${memo} — gain on disposal`,
    });
  }

  return postJournal(client, {
    journalDateAD: input.dateAD,
    branchId: input.branchId,
    memo,
    sourceType: 'FIXED_ASSET_DISPOSAL',
    sourceId: input.assetId,
    actor: input.actor || null,
    lines,
  });
}

/**
 * The cost actually capitalised for one asset, summed across the direct-asset
 * and stock-deployed accounts. Zero means no acquisition journal exists (a
 * legacy register row), and a run must not depreciate a value the ledger does
 * not carry.
 */
export async function readFixedAssetCostValue(client: AccountingClient, assetId: string): Promise<number> {
  const accounts = await loadAssetAccounts(client, [], ['FIXED_ASSET', 'CPE_ASSET']);
  const accountIds = [accounts.FIXED_ASSET?.id, accounts.CPE_ASSET?.id].filter(Boolean) as string[];
  if (accountIds.length === 0) return 0;
  const result = await client.query(JOURNAL_SOURCE_ACCOUNT_NET_SQL, [assetId, accountIds]);
  return roundMoney(Math.max(0, Number(result.rows[0]?.net) || 0));
}

/** Accumulated depreciation already posted for one asset. */
export async function readFixedAssetDepreciationPosted(
  client: AccountingClient,
  assetId: string
): Promise<number> {
  const accounts = await loadAssetAccounts(client, [], ['ACCUMULATED_DEPRECIATION']);
  if (!accounts.ACCUMULATED_DEPRECIATION) return 0;
  const result = await client.query(ASSET_DEPRECIATION_POSTED_SQL, [
    `${assetId}:`,
    accounts.ACCUMULATED_DEPRECIATION.id,
  ]);
  return roundMoney(Math.max(0, Number(result.rows[0]?.posted) || 0));
}
