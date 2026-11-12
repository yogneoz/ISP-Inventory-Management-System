/**
 * Party statements read the POSTED subledger, not the operational registers.
 *
 * A customer/vendor statement is a view of `gl_subledger_entries` on the chart's
 * AR/AP control account. Invoices, receipts and returns enrich the row with a
 * document number and payment method, but they never decide the debit/credit.
 * That is what keeps a manual journal, an opening balance, a write-off or a
 * future adjustment visible in the same statement as the documents.
 *
 * The response also carries the account-level tie-out: the GL control balance
 * against the sum of every party book on that account. A single party's balance
 * never equals the control account, so comparing it to the control would be a
 * false reconciliation; the statement shows both facts separately.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import { isAccountingDate, type AccountingClient } from './accounting.service';
import {
  AGING_CONTROL_ACCOUNT_SQL,
  PARTY_LEDGER_CONTROL_BALANCE_SQL,
  PARTY_LEDGER_ROWS_SQL,
  PARTY_LEDGER_SUBLEDGER_BALANCE_SQL,
  type PostingRole,
} from '../models/accounting.repo';

export type PartyLedgerSide = 'CUSTOMER' | 'SUPPLIER';
export type PartyLedgerLineType = 'INVOICE' | 'PAYMENT' | 'RETURN' | 'OPENING' | 'ADJUSTMENT';

export interface PartyLedgerLine {
  id: string;
  documentNumber: string;
  dateAD: string;
  dateBS: string;
  type: PartyLedgerLineType;
  notes: string;
  paymentMethod?: string | null;
  debit: number;
  credit: number;
  balance: number;
}

export interface PartyLedgerResult {
  side: PartyLedgerSide;
  account: { id: string; code: string; name: string; postingRole: PostingRole };
  openingBalance: number;
  openingSource: 'POSTED_SUBLEDGER';
  fiscalYearStartAD: null;
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
  ledger: PartyLedgerLine[];
  tieOut: {
    partyBalance: number;
    controlBalance: number;
    subledgerBalance: number;
    difference: number;
    status: 'RECONCILED' | 'DIFFERENCE';
    /** The control account whose whole subledger is being tied out. */
    controlAccountCode: string;
    controlAccountName: string;
  };
}

function optionalDate(value: unknown, field: string): string | null {
  const date = typeof value === 'string' ? value.trim() : '';
  if (!date) return null;
  if (!isAccountingDate(date)) {
    throw new ApiError(400, `${field} must be a real date (YYYY-MM-DD).`);
  }
  return date;
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

/**
 * Build one party statement from posted subledger rows.
 *
 * `displaySign` converts the control account's natural debit-positive balance
 * into the statement's vocabulary: AR is debit-positive (money owed to us), AP
 * is credit-positive (money we owe). The GL and subledger totals get the same
 * conversion so the displayed difference is directly comparable.
 */
export async function buildPartyLedger(
  client: AccountingClient,
  input: {
    side: PartyLedgerSide;
    partyId: string;
    partyName?: string | null;
    branchId?: string | null;
    from?: unknown;
    to?: unknown;
  }
): Promise<PartyLedgerResult> {
  const partyId = String(input.partyId || '').trim();
  if (!partyId) throw new ApiError(400, 'A party id is required.');
  const from = optionalDate(input.from, 'From date');
  const to = optionalDate(input.to, 'To date');
  if (from && to && from > to) {
    throw new ApiError(400, 'The from date must not be after the to date.');
  }
  const branchId = input.branchId && input.branchId !== 'ALL' ? input.branchId : null;
  const role: PostingRole = input.side === 'CUSTOMER' ? 'AR_CONTROL' : 'AP_CONTROL';
  const account = (await client.query(AGING_CONTROL_ACCOUNT_SQL, [role])).rows[0] as
    | { id: string; code: string; name: string; postingRole: PostingRole }
    | undefined;
  if (!account) {
    throw new ApiError(
      400,
      `Accounting is not configured for ${input.side.toLowerCase()} statements: no active account has the ${role} posting default. Set it in Accounting → Posting defaults.`
    );
  }

  // Read through `to` only; the opening split happens here so a statement with
  // a from-date still sees every movement before it. No operational table is a
  // source of debit/credit.
  const rows = (
    await client.query(PARTY_LEDGER_ROWS_SQL, [
      account.id,
      partyId,
      String(input.partyName || ''),
      branchId,
      null,
      to,
    ])
  ).rows as any[];

  const displaySign = input.side === 'CUSTOMER' ? 1 : -1;
  const displayDebit = (row: any) => money(displaySign === 1 ? row.debit : row.credit);
  const displayCredit = (row: any) => money(displaySign === 1 ? row.credit : row.debit);

  let opening = 0;
  const periodRows: any[] = [];
  for (const row of rows) {
    const date = String(row.entryDateAD || '').slice(0, 10);
    const signed = roundMoney(displayDebit(row) - displayCredit(row));
    if (from && date < from) {
      opening = roundMoney(opening + signed);
      continue;
    }
    periodRows.push(row);
  }

  let running = opening;
  const ledger: PartyLedgerLine[] = periodRows.map((row) => {
    const debit = displayDebit(row);
    const credit = displayCredit(row);
    running = roundMoney(running + debit - credit);
    return {
      id: String(row.id),
      documentNumber: String(row.documentNumber || row.journalNo || ''),
      dateAD: String(row.entryDateAD || '').slice(0, 10),
      dateBS: String(row.entryDateBS || ''),
      type: String(row.type || 'ADJUSTMENT') as PartyLedgerLineType,
      notes: String(row.notes || ''),
      paymentMethod: row.paymentMethod ? String(row.paymentMethod) : null,
      debit,
      credit,
      balance: running,
    };
  });

  const totalDebit = roundMoney(ledger.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = roundMoney(ledger.reduce((sum, line) => sum + line.credit, 0));
  const closingBalance = roundMoney(opening + totalDebit - totalCredit);

  const [controlRow, subledgerRow] = await Promise.all([
    client.query(PARTY_LEDGER_CONTROL_BALANCE_SQL, [account.id, to, branchId]),
    client.query(PARTY_LEDGER_SUBLEDGER_BALANCE_SQL, [account.id, to, branchId]),
  ]);
  const controlBalance = roundMoney(money(controlRow.rows[0]?.balance) * displaySign);
  const subledgerBalance = roundMoney(money(subledgerRow.rows[0]?.balance) * displaySign);
  const difference = roundMoney(controlBalance - subledgerBalance);

  return {
    side: input.side,
    account: {
      id: account.id,
      code: account.code,
      name: account.name,
      postingRole: role,
    },
    openingBalance: opening,
    openingSource: 'POSTED_SUBLEDGER',
    fiscalYearStartAD: null,
    totalDebit,
    totalCredit,
    closingBalance,
    ledger,
    tieOut: {
      partyBalance: closingBalance,
      controlBalance,
      subledgerBalance,
      difference,
      status: Math.abs(difference) < 0.005 ? 'RECONCILED' : 'DIFFERENCE',
      controlAccountCode: account.code,
      controlAccountName: account.name,
    },
  };
}
