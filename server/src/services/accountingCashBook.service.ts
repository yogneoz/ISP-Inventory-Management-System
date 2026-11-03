/**
 * Cash/bank book read side.
 *
 * The book is derived only from POSTED journal lines on accounts that carry the
 * CASH or BANK posting default. It deliberately does not read customer_payments
 * or vendor_payments: those documents create the journal, and the journal is
 * what this book — like every other accounting read — trusts.
 *
 * Opening is the signed balance before `from`; receipts and payments are the
 * gross debits and credits inside `from`..`to`; closing is opening plus the
 * movement. For the same branch and date the total closing equals the balance
 * sheet's `cashAndBank` figure, because both use the same rows and roles.
 */
import { roundMoney } from '../utils/money';
import {
  CASH_BANK_ACCOUNT_ROWS_SQL,
  CASH_BANK_ENTRY_ROWS_SQL,
} from '../models/accounting.repo';
import type { AccountingClient } from './accounting.service';
import {
  statementBranchLabel,
  type StatementWindow,
} from './accountingStatements.service';

export interface CashBookEntry {
  journalDateAD: string;
  journalNo: string;
  sourceType: string;
  sourceId: string | null;
  branchId: string;
  memo: string | null;
  debit: number;
  credit: number;
  type: 'RECEIPT' | 'PAYMENT';
  /** Signed running balance including the opening figure. */
  balance: number;
}

export interface CashBookAccount {
  accountId: string;
  code: string;
  name: string;
  postingRole: string;
  isActive: boolean;
  opening: number;
  receipts: number;
  payments: number;
  closing: number;
  entries: CashBookEntry[];
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

export async function buildCashBook(client: AccountingClient, window: StatementWindow) {
  if (window.empty) {
    return {
      book: 'CASH_BANK' as const,
      branchId: statementBranchLabel(window),
      from: window.from,
      to: window.to,
      accounts: [] as CashBookAccount[],
      opening: 0,
      receipts: 0,
      payments: 0,
      closing: 0,
    };
  }

  const [accountRows, entryRows] = await Promise.all([
    client.query(CASH_BANK_ACCOUNT_ROWS_SQL, [window.from, window.to, window.branchId]),
    client.query(CASH_BANK_ENTRY_ROWS_SQL, [window.from, window.to, window.branchId]),
  ]);

  const entriesByAccount = new Map<string, any[]>();
  for (const row of entryRows.rows) {
    const key = String(row.accountId);
    const list = entriesByAccount.get(key);
    if (list) list.push(row);
    else entriesByAccount.set(key, [row]);
  }

  const accounts: CashBookAccount[] = accountRows.rows.map((row: any) => {
    const opening = money(row.opening);
    const receipts = money(row.receipts);
    const payments = money(row.payments);
    let running = opening;
    const entries = (entriesByAccount.get(String(row.accountId)) || []).map((entry: any) => {
      const debit = money(entry.debit);
      const credit = money(entry.credit);
      running = roundMoney(running + debit - credit);
      return {
        journalDateAD: String(entry.journalDateAD).slice(0, 10),
        journalNo: String(entry.journalNo),
        sourceType: String(entry.sourceType),
        sourceId: entry.sourceId ? String(entry.sourceId) : null,
        branchId: String(entry.branchId),
        memo: entry.memo ? String(entry.memo) : null,
        debit,
        credit,
        type: debit > 0 ? ('RECEIPT' as const) : ('PAYMENT' as const),
        balance: running,
      };
    });
    return {
      accountId: String(row.accountId),
      code: String(row.code),
      name: String(row.name),
      postingRole: String(row.postingRole),
      isActive: row.isActive === true,
      opening,
      receipts,
      payments,
      closing: roundMoney(opening + receipts - payments),
      entries,
    };
  });

  const sum = (pick: (account: CashBookAccount) => number) =>
    roundMoney(accounts.reduce((total, account) => total + pick(account), 0));

  const opening = sum((account) => account.opening);
  const receipts = sum((account) => account.receipts);
  const payments = sum((account) => account.payments);
  const closing = roundMoney(opening + receipts - payments);

  return {
    book: 'CASH_BANK' as const,
    branchId: statementBranchLabel(window),
    from: window.from,
    to: window.to,
    accounts,
    opening,
    receipts,
    payments,
    closing,
  };
}
