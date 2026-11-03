/**
 * Ledger postings for sales and purchase returns.
 *
 * A return is the mirror of the document that created the balance, not a new
 * transaction class:
 *   - sales return: debit the sales revenue and output-VAT sides, credit the
 *     customer's AR, and put the goods back into inventory at the exact issue
 *     cost the original sale relieved (debit inventory / credit COGS);
 *   - purchase return: debit the supplier's AP, credit inventory at the bill
 *     value being returned, and credit input VAT.
 *
 * The caller owns the transaction and supplies already-resolved costs. A
 * missing cost is refused before any stock moves: a return that silently
 * values goods at zero would unbalance inventory against its control account.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import {
  ACCOUNTS_BY_POSTING_ROLES_SQL,
  type PostingRole,
} from '../models/accounting.repo';
import { SR_ISSUE_COSTS_SQL } from '../models/sales.repo';
import {
  postJournal,
  type AccountingClient,
  type JournalLineInput,
} from './accounting.service';
import { reverseSourceJournal } from './invoicePosting.service';

const SALES_RETURN_ROLES = ['AR_CONTROL', 'SALES', 'TAX_OUTPUT', 'COGS', 'INVENTORY'] as const satisfies readonly PostingRole[];
const PURCHASE_RETURN_ROLES = ['AP_CONTROL', 'INVENTORY', 'TAX_INPUT'] as const satisfies readonly PostingRole[];

interface PostingAccount {
  id: string;
  code: string;
  name: string;
  isControl: boolean;
  subledgerType: string;
  postingRole: string | null;
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

async function loadDefaults(
  client: AccountingClient,
  roles: readonly PostingRole[],
  document: string
): Promise<Record<string, PostingAccount>> {
  const rows = (await client.query(ACCOUNTS_BY_POSTING_ROLES_SQL, [roles])).rows as PostingAccount[];
  const byRole: Record<string, PostingAccount> = {};
  for (const row of rows) {
    if (row.postingRole) byRole[row.postingRole] = row;
  }
  const missing = roles.filter((role) => !byRole[role]);
  if (missing.length > 0) {
    throw new ApiError(
      400,
      `Accounting is not configured for ${document}: no active account has the ${missing.join(
        ', '
      )} posting default. Set it in Accounting → Posting defaults, then post the return again.`
    );
  }
  return byRole;
}

function controlLine(
  account: PostingAccount,
  debit: number,
  credit: number,
  partyId: unknown,
  partyName: unknown,
  memo: string
): JournalLineInput {
  return {
    accountId: account.id,
    debit,
    credit,
    memo,
    subledgerType: account.subledgerType,
    partyId: typeof partyId === 'string' && partyId.trim() ? partyId.trim() : null,
    partyName: typeof partyName === 'string' && partyName.trim() ? partyName.trim() : null,
  };
}

function ordinaryLine(account: PostingAccount, debit: number, credit: number, memo: string): JournalLineInput {
  return { accountId: account.id, debit, credit, memo };
}

export interface ReturnCogsEntry {
  productId: string;
  quantity: number;
  unitCost: number;
}

/**
 * Reads the weighted issue cost each product was sold at, from the original
 * invoice's movement rows. Returns only products that have a positive recorded
 * quantity; the caller refuses any returned line it cannot value.
 */
export async function loadSalesIssueCosts(
  client: AccountingClient,
  invoiceNumber: string,
  productIds: readonly string[]
): Promise<Map<string, number>> {
  const ids = Array.from(new Set(productIds.filter(Boolean)));
  const costs = new Map<string, number>();
  if (!invoiceNumber || ids.length === 0) return costs;
  const rows = (await client.query(SR_ISSUE_COSTS_SQL, [invoiceNumber, ids])).rows;
  for (const row of rows) {
    const quantity = Number(row.quantity);
    const value = Number(row.value);
    if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(value)) {
      costs.set(String(row.productId), roundMoney(value / quantity));
    }
  }
  return costs;
}

export interface SalesReturnLedgerInput {
  ret: {
    id: string;
    returnNumber: string;
    branchId: string;
    returnDateAD: string;
    customerId?: string | null;
    customerName?: string | null;
    grandTotal: number | string;
    vatAmount: number | string;
  };
  /** Value of the units going back into sellable stock; empty for a
   *  non-restockable (damaged) return. */
  cogs: readonly ReturnCogsEntry[];
  actor?: string | null;
}

/** Debit revenue + output VAT + inventory; credit AR + COGS. */
export async function postSalesReturnJournal(client: AccountingClient, input: SalesReturnLedgerInput) {
  const total = money(input.ret.grandTotal);
  const vat = money(input.ret.vatAmount);
  const revenue = roundMoney(total - vat);
  const cogsTotal = roundMoney(
    input.cogs.reduce((sum, entry) => sum + money(entry.quantity) * money(entry.unitCost), 0)
  );
  if (Math.abs(total) < 0.005 && Math.abs(cogsTotal) < 0.005) return null;

  const defaults = await loadDefaults(client, SALES_RETURN_ROLES, 'sales returns');
  const memo = `Sales return ${input.ret.returnNumber}`;
  const lines: JournalLineInput[] = [];
  if (total > 0) {
    lines.push(
      controlLine(
        defaults.AR_CONTROL,
        0,
        total,
        input.ret.customerId,
        input.ret.customerName,
        `${memo} — customer credit`
      )
    );
  }
  if (revenue > 0) lines.push(ordinaryLine(defaults.SALES, revenue, 0, `${memo} — revenue reversed`));
  if (vat > 0) lines.push(ordinaryLine(defaults.TAX_OUTPUT, vat, 0, `${memo} — output VAT reversed`));
  if (cogsTotal > 0) {
    lines.push(ordinaryLine(defaults.INVENTORY, cogsTotal, 0, `${memo} — inventory restored at issue cost`));
    lines.push(ordinaryLine(defaults.COGS, 0, cogsTotal, `${memo} — COGS reversed at issue cost`));
  }
  if (lines.length < 2) return null;

  return postJournal(client, {
    journalDateAD: input.ret.returnDateAD,
    branchId: input.ret.branchId,
    memo,
    sourceType: 'SALES_RETURN',
    sourceId: input.ret.id,
    actor: input.actor || null,
    lines,
  });
}

export interface PurchaseReturnLedgerInput {
  ret: {
    id: string;
    returnNumber: string;
    branchId: string;
    returnDateAD: string;
    supplierId?: string | null;
    supplierName?: string | null;
    grandTotal: number | string;
    vatAmount: number | string;
  };
  actor?: string | null;
}

/** Debit AP; credit inventory + input VAT. */
export async function postPurchaseReturnJournal(client: AccountingClient, input: PurchaseReturnLedgerInput) {
  const total = money(input.ret.grandTotal);
  const vat = money(input.ret.vatAmount);
  const net = roundMoney(total - vat);
  if (Math.abs(total) < 0.005) return null;

  const defaults = await loadDefaults(client, PURCHASE_RETURN_ROLES, 'purchase returns');
  const memo = `Purchase return ${input.ret.returnNumber}`;
  const lines: JournalLineInput[] = [
    controlLine(
      defaults.AP_CONTROL,
      total,
      0,
      input.ret.supplierId,
      input.ret.supplierName,
      `${memo} — supplier debit`
    ),
  ];
  if (net > 0) lines.push(ordinaryLine(defaults.INVENTORY, 0, net, `${memo} — inventory returned`));
  if (vat > 0) lines.push(ordinaryLine(defaults.TAX_INPUT, 0, vat, `${memo} — input VAT reversed`));
  if (lines.length < 2) return null;

  return postJournal(client, {
    journalDateAD: input.ret.returnDateAD,
    branchId: input.ret.branchId,
    memo,
    sourceType: 'PURCHASE_RETURN',
    sourceId: input.ret.id,
    actor: input.actor || null,
    lines,
  });
}

/** Linked contra journal for a cancelled return; legacy returns have none. */
export async function reverseReturnJournal(
  client: AccountingClient,
  input: {
    kind: 'SALES_RETURN' | 'PURCHASE_RETURN';
    returnId: string;
    dateAD: string;
    reason: string;
    actor?: string | null;
  }
) {
  return reverseSourceJournal(client, {
    sourceType: input.kind,
    reversalSourceType: `${input.kind}_REVERSAL`,
    sourceId: input.returnId,
    dateAD: input.dateAD,
    reason: input.reason,
    actor: input.actor || null,
  });
}
