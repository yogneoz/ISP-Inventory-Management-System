/**
 * Ledger postings for the two operational documents that move the most money:
 * sales invoices and purchase invoices.
 *
 * The functions here run on the caller's transaction client. They never open a
 * transaction of their own, so the document, its stock movement, its subledger
 * entries, its audit row and its journal either all commit or all roll back.
 *
 * Account choice comes from the chart's posting defaults, never from a
 * hard-coded code:
 *   - sales:     AR control (customer subledger), sales revenue, output VAT,
 *                and COGS / inventory at the deducted row's weighted-average
 *                cost;
 *   - purchases: inventory, input VAT, AP control (supplier subledger).
 *
 * A missing default is a configuration failure and refuses the document. It is
 * never silently skipped: an invoice that quietly posts no journal is worse
 * than one that refuses and says which account to map.
 *
 * Cancellations/voids post a contra journal rather than deleting rows. The
 * original stays POSTED and the reversal carries `reversal_of_id`, so the two
 * sides net to zero in every balance query while the audit trail remains
 * complete.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import {
  ACCOUNTS_BY_POSTING_ROLES_SQL,
  JOURNAL_FIND_BY_SOURCE_SQL,
  type PostingRole,
} from '../models/accounting.repo';
import {
  postJournal,
  readJournal,
  type AccountingClient,
  type JournalLineInput,
} from './accounting.service';

const SALES_ROLES = [
  'AR_CONTROL',
  'SALES',
  'TAX_OUTPUT',
  'COGS',
  'INVENTORY',
] as const satisfies readonly PostingRole[];

const PURCHASE_ROLES = ['AP_CONTROL', 'INVENTORY', 'TAX_INPUT'] as const satisfies readonly PostingRole[];

interface PostingAccount {
  id: string;
  code: string;
  name: string;
  isControl: boolean;
  subledgerType: string;
}

async function loadPostingDefaults(
  client: AccountingClient,
  roles: readonly PostingRole[]
): Promise<Record<string, PostingAccount>> {
  const rows = (await client.query(ACCOUNTS_BY_POSTING_ROLES_SQL, [roles])).rows;
  const byRole: Record<string, PostingAccount> = {};
  for (const row of rows) {
    if (row.postingRole) byRole[row.postingRole] = row;
  }
  const missing = roles.filter((role) => !byRole[role]);
  if (missing.length > 0) {
    throw new ApiError(
      400,
      `Accounting is not configured for invoices: no active account has the ${missing.join(
        ', '
      )} posting default. Set it in Accounting → Posting defaults, then post the invoice again.`
    );
  }
  return byRole;
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
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

export interface InvoiceCogsEntry {
  productId: string;
  quantity: number;
  /** Weighted-average unit cost read from the stock row inside the same transaction. */
  unitCost: number;
}

export interface SalesInvoiceLedgerInput {
  invoice: {
    id: string;
    invoiceNumber: string;
    branchId: string;
    invoiceDateAD: string;
    customerId?: string | null;
    customerName?: string | null;
    grandTotal: number | string;
    vatAmount: number | string;
  };
  cogs: readonly InvoiceCogsEntry[];
  actor?: string | null;
}

/**
 * Debit AR / credit revenue + output VAT, plus debit COGS / credit inventory at
 * weighted-average cost. Returns null only for a genuinely zero-value invoice,
 * which has no ledger effect.
 */
export async function postSalesInvoiceLedger(client: AccountingClient, input: SalesInvoiceLedgerInput) {
  const total = money(input.invoice.grandTotal);
  const vat = money(input.invoice.vatAmount);
  const revenue = roundMoney(total - vat);
  const cogsTotal = roundMoney(
    input.cogs.reduce((sum, entry) => sum + money(entry.quantity) * money(entry.unitCost), 0)
  );
  if (Math.abs(total) < 0.005 && Math.abs(cogsTotal) < 0.005) return null;

  const defaults = await loadPostingDefaults(client, SALES_ROLES);
  const memo = `Sales invoice ${input.invoice.invoiceNumber}`;
  const lines: JournalLineInput[] = [];
  if (total > 0) {
    lines.push(
      controlLine(defaults.AR_CONTROL, total, 0, input.invoice.customerId, input.invoice.customerName, memo)
    );
  }
  if (revenue > 0) lines.push(ordinaryLine(defaults.SALES, 0, revenue, memo));
  if (vat > 0) lines.push(ordinaryLine(defaults.TAX_OUTPUT, 0, vat, memo));
  if (cogsTotal > 0) {
    lines.push(ordinaryLine(defaults.COGS, cogsTotal, 0, `${memo} — weighted-average cost`));
    lines.push(ordinaryLine(defaults.INVENTORY, 0, cogsTotal, `${memo} — weighted-average cost`));
  }
  if (lines.length < 2) return null;

  return postJournal(client, {
    journalDateAD: input.invoice.invoiceDateAD,
    branchId: input.invoice.branchId,
    memo,
    sourceType: 'SALES_INVOICE',
    sourceId: input.invoice.id,
    actor: input.actor || null,
    lines,
  });
}

export interface PurchaseInvoiceLedgerInput {
  invoice: {
    id: string;
    invoiceNumber: string;
    branchId: string;
    invoiceDateAD: string;
    supplierId?: string | null;
    supplierName?: string | null;
    grandTotal: number | string;
    vatAmount: number | string;
  };
  actor?: string | null;
}

/** Debit inventory + input VAT / credit AP for a received vendor bill. */
export async function postPurchaseInvoiceLedger(client: AccountingClient, input: PurchaseInvoiceLedgerInput) {
  const total = money(input.invoice.grandTotal);
  const vat = money(input.invoice.vatAmount);
  const net = roundMoney(total - vat);
  if (Math.abs(total) < 0.005) return null;

  const defaults = await loadPostingDefaults(client, PURCHASE_ROLES);
  const memo = `Purchase invoice ${input.invoice.invoiceNumber}`;
  const lines: JournalLineInput[] = [];
  if (net > 0) lines.push(ordinaryLine(defaults.INVENTORY, net, 0, memo));
  if (vat > 0) lines.push(ordinaryLine(defaults.TAX_INPUT, vat, 0, memo));
  if (total > 0) {
    lines.push(
      controlLine(defaults.AP_CONTROL, 0, total, input.invoice.supplierId, input.invoice.supplierName, memo)
    );
  }
  if (lines.length < 2) return null;

  return postJournal(client, {
    journalDateAD: input.invoice.invoiceDateAD,
    branchId: input.invoice.branchId,
    memo,
    sourceType: 'PURCHASE_INVOICE',
    sourceId: input.invoice.id,
    actor: input.actor || null,
    lines,
  });
}

export interface ReverseSourceJournalInput {
  sourceType: string;
  /** Defaults to `${sourceType}_REVERSAL`. */
  reversalSourceType?: string;
  sourceId: string;
  /** The cancellation/void date; the reversal belongs in today's open period. */
  dateAD: string;
  reason: string;
  actor?: string | null;
}

/**
 * Post the contra journal for any posted source document and link it to the
 * original. Invoices and payment documents share the same rule, so they share
 * this function rather than growing a near-copy per document type.
 *
 * The original is left POSTED: both journals then contribute to balances and
 * net to exactly zero, while the reversal is a first-class auditable document.
 * A legacy document that predates ledger posting has no journal, so there is
 * nothing to reverse and the caller can still cancel it.
 */
export async function reverseSourceJournal(
  client: AccountingClient,
  input: ReverseSourceJournalInput
) {
  const found = (await client.query(JOURNAL_FIND_BY_SOURCE_SQL, [input.sourceType, input.sourceId])).rows[0];
  if (!found || found.status !== 'POSTED') return null;
  const original = await readJournal(client, found.id);
  if (!original) return null;

  const subledgerByLine = new Map<string, any>(
    (original.subledgerEntries || []).map((entry: any) => [String(entry.journalLineId), entry])
  );
  const lines = (original.lines || []).map((line: any) => {
    const base: JournalLineInput = {
      accountId: line.accountId,
      debit: money(line.credit),
      credit: money(line.debit),
      memo: `Reversal of ${original.journalNo}`,
    };
    if (line.isControl) {
      const party = subledgerByLine.get(String(line.id));
      base.subledgerType = line.subledgerType;
      base.partyId = party?.partyId ?? null;
      base.partyName = party?.partyName ?? null;
    }
    return base;
  });
  if (lines.length < 2) return null;

  return postJournal(client, {
    journalDateAD: input.dateAD,
    branchId: original.branchId,
    memo: `Reversal of ${original.journalNo} — ${input.sourceId}${input.reason ? ` (${input.reason})` : ''}`,
    sourceType: input.reversalSourceType || `${input.sourceType}_REVERSAL`,
    sourceId: input.sourceId,
    reversalOfId: original.id,
    actor: input.actor || null,
    lines,
  });
}

export interface ReverseInvoiceJournalInput {
  sourceType: 'SALES_INVOICE' | 'PURCHASE_INVOICE';
  sourceId: string;
  /** The cancellation/void date; the reversal belongs in today's open period. */
  dateAD: string;
  reason: string;
  actor?: string | null;
}

/** Invoice-specific wrapper over the shared contra-journal rule. */
export async function reverseInvoiceJournal(
  client: AccountingClient,
  input: ReverseInvoiceJournalInput
) {
  return reverseSourceJournal(client, input);
}
