/**
 * Ledger postings for sales and purchase returns.
 *
 * A return is the mirror of the document that created the balance, not a new
 * transaction class:
 *   - sales return: debit the dedicated Sales Returns contra-income ledger and
 *     the output-VAT side, credit the customer's AR, and put the goods back
 *     into inventory at the exact issue cost the original sale relieved
 *     (debit inventory / credit COGS);
 *   - purchase return: debit the supplier's AP, credit inventory at the bill
 *     value being returned, and credit input VAT.
 *
 * Sales returns do not post against the sales revenue account: gross revenue
 * and returns stay separately visible, and the return's direction comes from
 * the Sales Returns account's own debit-normal side.
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
  postJournalLegs,
  type AccountingClient,
  type JournalLeg,
} from './accounting.service';
import { reverseSourceJournal } from './invoicePosting.service';

const SALES_RETURN_ROLES = ['AR_CONTROL', 'SALES_RETURNS', 'TAX_OUTPUT', 'COGS', 'INVENTORY'] as const satisfies readonly PostingRole[];
const PURCHASE_RETURN_ROLES = ['AP_CONTROL', 'INVENTORY', 'TAX_INPUT'] as const satisfies readonly PostingRole[];

interface PostingAccount {
  id: string;
  code: string;
  name: string;
  isControl: boolean;
  subledgerType: string;
  postingRole: string | null;
  /** `D` or `C`: the permanent side the leg engine posts against. */
  accountNormalBalance: string;
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

function controlLeg(
  account: PostingAccount,
  increase: boolean,
  amount: number,
  partyId: unknown,
  partyName: unknown,
  memo: string
): JournalLeg {
  return {
    accountId: account.id,
    increase,
    amount,
    memo,
    subledgerType: account.subledgerType,
    partyId: typeof partyId === 'string' && partyId.trim() ? partyId.trim() : null,
    partyName: typeof partyName === 'string' && partyName.trim() ? partyName.trim() : null,
  };
}

function ordinaryLeg(account: PostingAccount, increase: boolean, amount: number, memo: string): JournalLeg {
  return { accountId: account.id, increase, amount, memo };
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
  const legs: JournalLeg[] = [];
  if (total > 0) {
    legs.push(
      controlLeg(
        defaults.AR_CONTROL,
        false,
        total,
        input.ret.customerId,
        input.ret.customerName,
        `${memo} — customer credit`
      )
    );
  }
  // Contra-income: the returns ledger is debit-normal, so a return increases
  // it. Revenue itself is left untouched, so gross sales and returns are both
  // readable.
  if (revenue > 0) legs.push(ordinaryLeg(defaults.SALES_RETURNS, true, revenue, `${memo} — revenue returned`));
  if (vat > 0) legs.push(ordinaryLeg(defaults.TAX_OUTPUT, false, vat, `${memo} — output VAT reversed`));
  if (cogsTotal > 0) {
    legs.push(ordinaryLeg(defaults.INVENTORY, true, cogsTotal, `${memo} — inventory restored at issue cost`));
    legs.push(ordinaryLeg(defaults.COGS, false, cogsTotal, `${memo} — COGS reversed at issue cost`));
  }
  if (legs.length < 2) return null;

  return postJournalLegs(client, {
    journalDateAD: input.ret.returnDateAD,
    branchId: input.ret.branchId,
    memo,
    sourceType: 'SALES_RETURN',
    sourceId: input.ret.id,
    actor: input.actor || null,
    legs,
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
  const legs: JournalLeg[] = [
    controlLeg(
      defaults.AP_CONTROL,
      false,
      total,
      input.ret.supplierId,
      input.ret.supplierName,
      `${memo} — supplier debit`
    ),
  ];
  if (net > 0) legs.push(ordinaryLeg(defaults.INVENTORY, false, net, `${memo} — inventory returned`));
  if (vat > 0) legs.push(ordinaryLeg(defaults.TAX_INPUT, false, vat, `${memo} — input VAT reversed`));
  if (legs.length < 2) return null;

  return postJournalLegs(client, {
    journalDateAD: input.ret.returnDateAD,
    branchId: input.ret.branchId,
    memo,
    sourceType: 'PURCHASE_RETURN',
    sourceId: input.ret.id,
    actor: input.actor || null,
    legs,
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
