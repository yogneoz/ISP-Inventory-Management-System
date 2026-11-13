/**
 * Ledger foundation: opening balances and year-end closing.
 *
 * Both operations are orchestrations over `postJournal`, never a second write
 * path into the ledger. That is what keeps every invariant the journal service
 * already enforces — balanced lines, active accounts, control-account parties,
 * an open period and the fiscal-year membership — true for these entries too.
 *
 * Opening balances:
 *   - one active posting per branch and Opening Balances register, into the
 *     earliest OPEN monthly period (or the earliest OPEN fiscal year's first
 *     month when no period exists yet);
 *   - a per-branch + register advisory lock and the unique slot table make a
 *     concurrent save replace serially without a cross-register collision;
 *   - control-account lines must carry the right subledger party, and an
 *     ordinary account must not carry one (postJournal enforces both).
 *
 * Year-end closing:
 *   - every branch's cumulative income/expense balance through the fiscal-year
 *     end is closed to the chart's RETAINED_EARNINGS account;
 *   - one journal per branch, all in the caller's transaction, followed by the
 *     fiscal-year is_closed flag — so a failure on any branch rolls the whole
 *     close back;
 *   - an existing YEAR_END_CLOSE journal is refused even if the year was
 *     reopened, so the close can never double-post.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import { FY_CLOSE_SQL } from '../models/admin.repo';
import {
  ACCOUNTS_BY_POSTING_ROLES_SQL,
  EARLIEST_OPEN_FISCAL_YEAR_SQL,
  EARLIEST_OPEN_PERIOD_SQL,
  FISCAL_YEAR_BALANCES_EXISTS_SQL,
  FISCAL_YEAR_BALANCE_INSERT_SQL,
  FISCAL_YEAR_BOUNDS_SQL,
  FISCAL_YEAR_CLOSE_LOCK_SQL,
  FISCAL_YEAR_PNL_BALANCE_ROWS_SQL,
  FISCAL_YEAR_TRIAL_BALANCE_ROWS_SQL,
  OPENING_BALANCE_BY_SOURCE_SQL,
  OPENING_BALANCE_LOCK_SQL,
  OPENING_BALANCE_SLOT_DELETE_SQL,
  OPENING_BALANCE_SLOT_FOR_UPDATE_SQL,
  OPENING_BALANCE_SLOT_SET_SQL,
  YEAR_END_CLOSE_EXISTS_SQL,
  YEAR_END_CLOSE_LOCK_SQL,
} from '../models/accounting.repo';
import {
  postJournal,
  readJournal,
  type AccountingClient,
  type JournalLineInput,
} from './accounting.service';

const OPENING_SOURCE = 'OPENING_BALANCE';
const YEAR_END_SOURCE = 'YEAR_END_CLOSE';

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export type OpeningRegisterKey = 'gl' | 'customer' | 'stock' | 'vendor';

const OPENING_REGISTER_KEYS = new Set<OpeningRegisterKey>(['gl', 'customer', 'stock', 'vendor']);

function openingRegisterKey(value: unknown): OpeningRegisterKey {
  const key = text(value, 30).toLowerCase() as OpeningRegisterKey;
  if (!OPENING_REGISTER_KEYS.has(key)) {
    throw new ApiError(400, 'Unknown opening-balance register.');
  }
  return key;
}

export function openingSourceId(sourceKey: OpeningRegisterKey, branchId: string): string {
  return `${sourceKey}-opening:${text(branchId, 50)}`;
}

export interface PostOpeningBalancesInput {
  branchId?: unknown;
  lines?: JournalLineInput[];
  actor?: string | null;
  /** The Opening Balances register that owns this per-branch opening. */
  sourceKey: OpeningRegisterKey;
}

export interface PostOpeningBalancesResult {
  id: string;
  journalNo: string;
  periodId: string;
  fiscalYearId: string;
  journalDateAD: string;
  periodKey: string;
  totalDebit: number;
  totalCredit: number;
}

/**
 * Post one branch's opening trial balance into the earliest open period.
 * The caller owns the transaction so the journal, its subledger rows, the
 * duplicate check and any audit row commit or roll back together.
 */
export async function postOpeningBalances(
  client: AccountingClient,
  input: PostOpeningBalancesInput
): Promise<PostOpeningBalancesResult> {
  const branchId = text(input.branchId, 50);
  if (!branchId) throw new ApiError(400, 'A branch is required for opening balances.');
  const register = openingRegisterKey(input.sourceKey);
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (lines.length === 0) {
    throw new ApiError(400, 'At least one opening-balance line is required.');
  }

  // One advisory lock per branch + register. The slot table is the durable
  // one-active guarantee; this lock makes concurrent saves replace serially.
  await client.query(OPENING_BALANCE_LOCK_SQL, [`opening-balance:${branchId}:${register}`]);
  const labels: Record<OpeningRegisterKey, string> = {
    gl: 'General ledger',
    customer: 'Customer',
    stock: 'Stock',
    vendor: 'Vendor',
  };
  await reverseOpeningSource(client, {
    branchId,
    sourceKey: register,
    label: labels[register],
    actor: input.actor || null,
  });

  const period = (await client.query(EARLIEST_OPEN_PERIOD_SQL)).rows[0];
  let journalDateAD: string;
  let periodKey: string;
  if (period) {
    const periodStartAD = String(period.startDateAD).slice(0, 10);
    const periodEndAD = String(period.endDateAD).slice(0, 10);
    // A Nepali fiscal year starts mid-month, so its first period's calendar
    // span begins before the year. Post the opening on the year's first day in
    // that case; the period key is unchanged.
    const fiscalYearForStart = (
      await client.query(FISCAL_YEAR_BOUNDS_SQL, [periodStartAD])
    ).rows[0];
    if (fiscalYearForStart) {
      journalDateAD = periodStartAD;
    } else {
      const fiscalYearForEnd = (
        await client.query(FISCAL_YEAR_BOUNDS_SQL, [periodEndAD])
      ).rows[0];
      journalDateAD = fiscalYearForEnd
        ? String(fiscalYearForEnd.startDateAD).slice(0, 10)
        : periodStartAD;
    }
    periodKey = String(period.periodKey);
  } else {
    const fiscalYear = (await client.query(EARLIEST_OPEN_FISCAL_YEAR_SQL)).rows[0];
    if (!fiscalYear) {
      throw new ApiError(409, 'No open accounting period is available for opening balances.');
    }
    journalDateAD = String(fiscalYear.startDateAD).slice(0, 10);
    periodKey = journalDateAD.slice(0, 7);
  }

  const posted = await postJournal(client, {
    journalDateAD,
    branchId,
    sourceType: OPENING_SOURCE,
    sourceId: openingSourceId(register, branchId),
    memo: `Opening balances for branch ${branchId}`,
    lines,
    actor: input.actor || null,
    isDemo: false,
  });
  await client.query(OPENING_BALANCE_SLOT_SET_SQL, [branchId, register, posted.id]);

  return {
    ...posted,
    journalDateAD,
    periodKey,
    totalDebit: roundMoney(lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0)),
    totalCredit: roundMoney(lines.reduce((sum, line) => sum + (Number(line.credit) || 0), 0)),
  };
}

async function reverseOpeningSource(
  client: AccountingClient,
  input: {
    branchId: string;
    sourceKey: OpeningRegisterKey;
    label: string;
    actor?: string | null;
  }
): Promise<void> {
  const sourceId = openingSourceId(input.sourceKey, input.branchId);
  // The slot is authoritative. The source-id fallback adopts a legacy active
  // opening from before slots existed; the migration backfills the same rows.
  const slot = (await client.query(OPENING_BALANCE_SLOT_FOR_UPDATE_SQL, [input.branchId, input.sourceKey]))
    .rows[0];
  const existing = slot
    ? { id: slot.journalId, journalNo: slot.journalNo }
    : (await client.query(OPENING_BALANCE_BY_SOURCE_SQL, [sourceId])).rows[0];
  if (!existing) return;
  const original = await readJournal(client, String(existing.id));
  if (!original) throw new ApiError(409, `${input.label} opening journal ${existing.journalNo} could not be read.`);
  // A control line is only valid with its party, and the party lives on the
  // subledger row rather than the journal line. Carry it onto the reversal so
  // AP/AR openings reverse through the same control-account contract.
  const subledgerByLine = new Map<string, any>(
    (original.subledgerEntries || []).map((entry: any) => [String(entry.journalLineId), entry])
  );
  await postJournal(client, {
    journalDateAD: original.journalDateAD,
    branchId: input.branchId,
    sourceType: 'OPENING_BALANCE_REVERSAL',
    sourceId: `reversal-of:${existing.id}`,
    memo: `Reversal of ${input.label.toLowerCase()} opening journal ${original.journalNo} for branch ${input.branchId}`,
    reversalOfId: existing.id,
    lines: original.lines.map((line: any) => {
      const party = subledgerByLine.get(String(line.id));
      return {
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
        memo: `Reversal of ${original.journalNo}`,
        ...(party
          ? {
              subledgerType: party.subledgerType,
              partyId: party.partyId,
              partyName: party.partyName,
            }
          : {}),
      };
    }),
    actor: input.actor || null,
    isDemo: false,
  });
  await client.query(OPENING_BALANCE_SLOT_DELETE_SQL, [input.branchId, input.sourceKey]);
}

export interface PostStockOpeningBalancesInput {
  branchId: string;
  /** Sum of quantity_on_hand × unit_cost for the branch after the save. */
  totalValue: number;
  inventoryAccountId: string;
  offsetAccountId: string;
  actor?: string | null;
}

/**
 * Keep one branch's stock opening journal equal to the opening-stock register.
 * A re-save posts a linked reversal of the prior stock opening and then the new
 * valuation, so the ledger nets to the current register without duplicating the
 * opening. The caller owns the transaction that also wrote the quantity rows.
 */
export async function postStockOpeningBalances(
  client: AccountingClient,
  input: PostStockOpeningBalancesInput
): Promise<PostOpeningBalancesResult | null> {
  const branchId = text(input.branchId, 50);
  if (!branchId) throw new ApiError(400, 'A branch is required for stock opening balances.');
  const total = roundMoney(Number(input.totalValue) || 0);
  if (total <= 0) {
    await client.query(OPENING_BALANCE_LOCK_SQL, [`opening-balance:${branchId}:stock`]);
    await reverseOpeningSource(client, {
      branchId,
      sourceKey: 'stock',
      label: 'Stock',
      actor: input.actor,
    });
    return null;
  }

  return postOpeningBalances(client, {
    branchId,
    sourceKey: 'stock',
    actor: input.actor || null,
    lines: [
      {
        accountId: input.inventoryAccountId,
        debit: total,
        credit: 0,
        memo: 'Opening inventory valuation',
      },
      {
        accountId: input.offsetAccountId,
        debit: 0,
        credit: total,
        memo: 'Opening inventory equity offset',
      },
    ],
  });
}

export interface VendorOpeningLineInput {
  supplierId: string;
  supplierName: string;
  openingBalance: number;
}

export interface PostVendorOpeningBalancesInput {
  branchId: string;
  rows: VendorOpeningLineInput[];
  apControlAccountId: string;
  offsetAccountId: string;
  actor?: string | null;
}

/**
 * Keep one branch's supplier-opening journal equal to vendor_opening_balances.
 * Positive balances are payables (credit AP); negative balances are advances
 * (debit AP). The equity offset carries only the signed net, so mixed supplier
 * signs still produce one balanced journal. A re-save reverses the prior
 * vendor opening before posting the replacement, exactly like stock.
 */
export async function postVendorOpeningBalances(
  client: AccountingClient,
  input: PostVendorOpeningBalancesInput
): Promise<PostOpeningBalancesResult | null> {
  const branchId = text(input.branchId, 50);
  if (!branchId) throw new ApiError(400, 'A branch is required for vendor opening balances.');
  const lines: JournalLineInput[] = [];
  let net = 0;
  for (const row of input.rows) {
    const balance = roundMoney(Number(row.openingBalance) || 0);
    if (balance === 0) continue;
    net = roundMoney(net + balance);
    const common = {
      accountId: input.apControlAccountId,
      subledgerType: 'SUPPLIER' as const,
      partyId: row.supplierId,
      partyName: row.supplierName,
      memo: `Opening ${balance > 0 ? 'payable' : 'advance'} — ${row.supplierName} (${row.supplierId})`,
    };
    if (balance > 0) {
      lines.push({ ...common, debit: 0, credit: balance });
    } else {
      lines.push({ ...common, debit: Math.abs(balance), credit: 0 });
    }
  }
  if (net > 0) {
    lines.push({
      accountId: input.offsetAccountId,
      debit: net,
      credit: 0,
      memo: 'Opening payables equity offset',
    });
  } else if (net < 0) {
    lines.push({
      accountId: input.offsetAccountId,
      debit: 0,
      credit: Math.abs(net),
      memo: 'Opening supplier advances equity offset',
    });
  }
  if (lines.length === 0) {
    await client.query(OPENING_BALANCE_LOCK_SQL, [`opening-balance:${branchId}:vendor`]);
    await reverseOpeningSource(client, {
      branchId,
      sourceKey: 'vendor',
      label: 'Vendor',
      actor: input.actor,
    });
    return null;
  }

  return postOpeningBalances(client, {
    branchId,
    sourceKey: 'vendor',
    actor: input.actor || null,
    lines,
  });
}

export interface CloseFiscalYearInput {
  fiscalYearId?: unknown;
  actor?: string | null;
}

export interface CloseFiscalYearResult {
  fiscalYear: any;
  journalCount: number;
  snapshotRowCount: number;
}

interface CloseSnapshotEntry {
  branchId: string;
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  preCloseDebit: number;
  preCloseCredit: number;
  preCloseBalance: number;
  closeDebit: number;
  closeCredit: number;
}

/**
 * Close one fiscal year: post each branch's P&L residue to retained earnings,
 * then mark the year closed, all inside the caller's transaction.
 */
export async function closeFiscalYear(
  client: AccountingClient,
  input: CloseFiscalYearInput
): Promise<CloseFiscalYearResult> {
  const fiscalYearId = text(input.fiscalYearId, 50);
  if (!fiscalYearId) throw new ApiError(400, 'A fiscal year id is required.');

  await client.query(YEAR_END_CLOSE_LOCK_SQL, [`year-end-close:${fiscalYearId}`]);
  const fiscalYear = (await client.query(FISCAL_YEAR_CLOSE_LOCK_SQL, [fiscalYearId])).rows[0];
  if (!fiscalYear) throw new ApiError(404, 'Fiscal year not found.');
  if (fiscalYear.isClosed) {
    throw new ApiError(409, `Fiscal year ${fiscalYear.code} is already closed.`);
  }

  const existingClose = (await client.query(YEAR_END_CLOSE_EXISTS_SQL, [fiscalYearId])).rows[0];
  if (existingClose) {
    throw new ApiError(
      409,
      `A year-end close has already been posted for fiscal year ${fiscalYear.code}.`
    );
  }

  const existingSnapshot = (
    await client.query(FISCAL_YEAR_BALANCES_EXISTS_SQL, [fiscalYearId])
  ).rows[0];
  if (existingSnapshot) {
    throw new ApiError(
      409,
      `A balance snapshot already exists for fiscal year ${fiscalYear.code}; the close is single-shot.`
    );
  }

  // Capture the trial balance before the closing entries zero the P&L. Once
  // those entries commit, this pre-close position is not reconstructible.
  const preCloseRows = (
    await client.query(
      FISCAL_YEAR_TRIAL_BALANCE_ROWS_SQL,
      [String(fiscalYear.endDateAD).slice(0, 10)]
    )
  ).rows;
  const snapshot = new Map<string, CloseSnapshotEntry>();
  const accountMeta = new Map<string, { code: string; name: string; accountType: string }>();
  for (const row of preCloseRows) {
    const branchId = String(row.branchId);
    const accountId = String(row.accountId);
    const debit = roundMoney(Number(row.debit) || 0);
    const credit = roundMoney(Number(row.credit) || 0);
    snapshot.set(`${branchId}\u0000${accountId}`, {
      branchId,
      accountId,
      code: String(row.code),
      name: String(row.name),
      accountType: String(row.accountType),
      preCloseDebit: debit,
      preCloseCredit: credit,
      preCloseBalance: roundMoney(debit - credit),
      closeDebit: 0,
      closeCredit: 0,
    });
    accountMeta.set(accountId, {
      code: String(row.code),
      name: String(row.name),
      accountType: String(row.accountType),
    });
  }

  const rows = (
    await client.query(FISCAL_YEAR_PNL_BALANCE_ROWS_SQL, [String(fiscalYear.endDateAD).slice(0, 10)])
  ).rows;

  // An empty P&L (new company, nothing posted yet) still closes the year —
  // there is simply no closing journal to write.
  let retainedEarnings: any = null;
  if (rows.length > 0) {
    retainedEarnings = (
      await client.query(ACCOUNTS_BY_POSTING_ROLES_SQL, [['RETAINED_EARNINGS']])
    ).rows[0];
    if (!retainedEarnings) {
      throw new ApiError(
        400,
        'The RETAINED_EARNINGS posting default is not configured. Assign it to an active equity account before closing the year.'
      );
    }
    if (retainedEarnings.isControl) {
      throw new ApiError(
        400,
        `Retained earnings account ${retainedEarnings.code} is a control account; a year-end close cannot name a subledger party for it.`
      );
    }
    accountMeta.set(String(retainedEarnings.id), {
      code: String(retainedEarnings.code),
      name: String(retainedEarnings.name),
      accountType: String(retainedEarnings.accountType),
    });
  }

  const byBranch = new Map<string, any[]>();
  for (const row of rows) {
    const branchId = String(row.branchId);
    const branchRows = byBranch.get(branchId);
    if (branchRows) branchRows.push(row);
    else byBranch.set(branchId, [row]);
  }

  let journalCount = 0;
  for (const [branchId, balances] of byBranch) {
    const inactive = balances.find((row) => row.isActive !== true);
    if (inactive) {
      throw new ApiError(
        400,
        `Account ${inactive.code} is inactive but still carries a P&L balance; reactivate it before closing the year.`
      );
    }
    const control = balances.find((row) => row.isControl === true);
    if (control) {
      throw new ApiError(
        400,
        `P&L account ${control.code} is a control account; reactivate/remap it before closing the year.`
      );
    }

    const lines: JournalLineInput[] = [];
    let totalDebit = 0;
    let totalCredit = 0;
    for (const row of balances) {
      const signed = roundMoney(Number(row.signedBalance) || 0);
      if (Math.abs(signed) < 0.005) continue;
      // signed > 0 is a net debit (expense): credit it to zero. signed < 0 is
      // a net credit (income): debit it to zero.
      const debit = signed < 0 ? roundMoney(-signed) : 0;
      const credit = signed > 0 ? signed : 0;
      totalDebit = roundMoney(totalDebit + debit);
      totalCredit = roundMoney(totalCredit + credit);
      lines.push({
        accountId: row.accountId,
        debit,
        credit,
        memo: `Year-end close ${fiscalYear.code} — ${row.code} ${row.name}`,
      });
    }
    if (lines.length === 0) continue;

    // The P&L lines are the mirror of their balances; the retained-earnings
    // line is the net result that makes the closing journal balance.
    const retainedDifference = roundMoney(totalDebit - totalCredit);
    if (retainedDifference > 0) {
      lines.push({
        accountId: retainedEarnings.id,
        debit: 0,
        credit: retainedDifference,
        memo: `Year-end close ${fiscalYear.code} — retained earnings`,
      });
    } else if (retainedDifference < 0) {
      lines.push({
        accountId: retainedEarnings.id,
        debit: roundMoney(-retainedDifference),
        credit: 0,
        memo: `Year-end close ${fiscalYear.code} — retained earnings`,
      });
    }

    await postJournal(client, {
      journalDateAD: String(fiscalYear.endDateAD).slice(0, 10),
      branchId,
      sourceType: YEAR_END_SOURCE,
      sourceId: fiscalYearId,
      memo: `Year-end close ${fiscalYear.code} for branch ${branchId}`,
      lines,
      actor: input.actor || null,
      isDemo: false,
    });
    journalCount += 1;

    // Record the closing journal's effect on the pre-close position. Accounts
    // touched only by the close (typically retained earnings) gain a row here;
    // every other account already has one from the pre-close trial balance.
    for (const line of lines) {
      const accountId = String(line.accountId || '');
      const key = `${branchId}\u0000${accountId}`;
      let entry = snapshot.get(key);
      if (!entry) {
        const meta = accountMeta.get(accountId);
        if (!meta) {
          throw new ApiError(
            500,
            `Year-end close could not resolve account ${accountId} for its balance snapshot.`
          );
        }
        entry = {
          branchId,
          accountId,
          code: meta.code,
          name: meta.name,
          accountType: meta.accountType,
          preCloseDebit: 0,
          preCloseCredit: 0,
          preCloseBalance: 0,
          closeDebit: 0,
          closeCredit: 0,
        };
        snapshot.set(key, entry);
      }
      entry.closeDebit = roundMoney(entry.closeDebit + Number(line.debit || 0));
      entry.closeCredit = roundMoney(entry.closeCredit + Number(line.credit || 0));
    }
  }

  let snapshotRowCount = 0;
  for (const entry of snapshot.values()) {
    const postCloseBalance = roundMoney(
      entry.preCloseBalance + entry.closeDebit - entry.closeCredit
    );
    await client.query(FISCAL_YEAR_BALANCE_INSERT_SQL, [
      fiscalYearId,
      entry.branchId,
      entry.accountId,
      entry.code,
      entry.name,
      entry.accountType,
      entry.preCloseDebit,
      entry.preCloseCredit,
      entry.preCloseBalance,
      entry.closeDebit,
      entry.closeCredit,
      postCloseBalance,
    ]);
    snapshotRowCount += 1;
  }

  // One atomic outcome: the closing journals, the balance snapshot and this
  // flag either all commit or all roll back. The SQL keeps the existing
  // close-date guard.
  const closed = (await client.query(FY_CLOSE_SQL, [fiscalYearId])).rows[0];
  if (!closed) {
    throw new ApiError(
      400,
      `Fiscal year closing is available only after ${String(fiscalYear.endDateAD).slice(0, 10)}.`
    );
  }

  return { fiscalYear: closed, journalCount, snapshotRowCount };
}
