/**
 * Ledger posting for a partner-sourced service invoice.
 *
 * Why this is not `postSalesInvoiceLedger`: a subscription package has no stock
 * behind it. The sales path runs `SI_DEDUCT_STOCK_SQL` for every line and
 * refuses the document when the stock is absent, so a service sale cannot ride
 * it without inventing inventory. This posting therefore carries exactly three
 * legs — debit AR control (customer subledger), credit service revenue, credit
 * output VAT — and never touches COGS or inventory.
 *
 * It runs on the caller's transaction client, like the other posting services,
 * so the service invoice, its lines, its subledger entries, its journal and its
 * audit row commit together.
 *
 * Account choice comes from the chart's posting defaults (AR_CONTROL, SALES,
 * TAX_OUTPUT), never from a hard-coded account id; a missing default refuses the
 * invoice with the name of the role that must be mapped.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import { ACCOUNTS_BY_POSTING_ROLES_SQL, type PostingRole } from '../models/accounting.repo';
import { postJournal, type AccountingClient, type JournalLineInput } from './accounting.service';
import { ensurePartySubledgerBook } from './partyLedgerBook.service';

const SERVICE_ROLES = ['AR_CONTROL', 'SALES', 'TAX_OUTPUT'] as const satisfies readonly PostingRole[];

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
      `Accounting is not configured for service invoices: no active account has the ${missing.join(
        ', '
      )} posting default. Set it in Accounting → Posting defaults, then ingest the subscription again.`
    );
  }
  return byRole;
}

export interface ServiceInvoiceLedgerInput {
  invoice: {
    id: string;
    invoiceNumber: string;
    branchId: string;
    invoiceDateAD: string;
    customerId?: string | null;
    customerName: string;
    subtotal: number;
    taxAmount: number;
    total: number;
  };
  actor?: string | null;
}

/**
 * Posts Dr AR / Cr revenue / Cr output VAT. Returns the journal id so the
 * document can point at the entry that carries it.
 */
export async function postServiceInvoiceLedger(
  client: AccountingClient,
  input: ServiceInvoiceLedgerInput
): Promise<{ id: string; journalNo: string } | null> {
  const total = roundMoney(Number(input.invoice.total) || 0);
  const tax = roundMoney(Number(input.invoice.taxAmount) || 0);
  const revenue = roundMoney(Number(input.invoice.subtotal) || 0);
  if (total <= 0) return null;

  const defaults = await loadPostingDefaults(client, SERVICE_ROLES);
  const memo = `Service invoice ${input.invoice.invoiceNumber} — ${input.invoice.customerName}`;

  // The AR control account only accepts a line whose subledger party has a book;
  // create the customer's book first, in this same transaction.
  if (!input.invoice.customerId) {
    throw new ApiError(
      400,
      'A service invoice needs an internal customer before it can post to receivables.'
    );
  }
  await ensurePartySubledgerBook(client, {
    type: 'CUSTOMER',
    partyId: input.invoice.customerId,
    partyName: input.invoice.customerName,
    partyCode: null,
  });

  const lines: JournalLineInput[] = [
    {
      accountId: defaults.AR_CONTROL.id,
      debit: total,
      credit: 0,
      memo,
      subledgerType: defaults.AR_CONTROL.subledgerType,
      partyId: input.invoice.customerId,
      partyName: input.invoice.customerName,
    },
  ];
  if (revenue > 0) {
    lines.push({ accountId: defaults.SALES.id, debit: 0, credit: revenue, memo });
  }
  if (tax > 0) {
    lines.push({ accountId: defaults.TAX_OUTPUT.id, debit: 0, credit: tax, memo });
  }
  if (lines.length < 2) return null;

  const posted = await postJournal(client, {
    journalDateAD: input.invoice.invoiceDateAD,
    branchId: input.invoice.branchId,
    memo,
    sourceType: 'SERVICE_INVOICE',
    sourceId: input.invoice.id,
    actor: input.actor || null,
    lines,
  });
  return { id: posted.id, journalNo: posted.journalNo };
}
