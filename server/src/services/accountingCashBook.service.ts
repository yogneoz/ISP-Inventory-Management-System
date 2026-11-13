/**
 * Cash, bank and wallet book read side (ACC-2).
 *
 * The book is derived only from POSTED journal lines on the custody ledgers:
 * CASH for a branch till, BANK for a bank account, WALLET for a provider
 * clearing account. It deliberately does not read customer_payments or
 * vendor_payments: those documents create the journal, and the journal is what
 * this book — like every other accounting read — trusts.
 *
 * Cash books are branch balances: a shared cash ledger's company balance is not
 * a till. Bank and wallet books are per external account, so their opening,
 * receipts, payments and closing are company-wide while `branchReceipts` and
 * `branchPayments` show the selected branch's share. That distinction is why a
 * branch filter can never turn a shared bank's balance into a fictitious branch
 * balance.
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

export type CashBookKind = 'CASH' | 'BANK' | 'WALLET' | 'CASH_BANK';

export interface CashBookOptions {
  /** A single custody kind; omitted keeps the legacy combined cash+bank view. */
  kind?: CashBookKind;
  /** Narrow the book to one custody account. */
  accountId?: string | null;
}

export interface CashBookEntry {
  journalDateAD: string;
  journalNo: string;
  journalId: string;
  sourceType: string;
  sourceId: string | null;
  branchId: string;
  branchCode: string | null;
  branchName: string | null;
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
  accountKind: 'CASH' | 'BANK' | 'WALLET';
  postingRole: string | null;
  /** Owner branch; NULL means the custody account is shared. */
  branchId: string | null;
  branchCode: string | null;
  branchName: string | null;
  isShared: boolean;
  providerCode: string | null;
  merchantId: string | null;
  settlementAccountId: string | null;
  bankName: string | null;
  bankBranch: string | null;
  accountNumber: string | null;
  accountHolder: string | null;
  swiftCode: string | null;
  isActive: boolean;
  opening: number;
  receipts: number;
  payments: number;
  closing: number;
  /** Movement in the selected branch/window (company-wide for a global read). */
  branchReceipts: number;
  branchPayments: number;
  branchMovement: number;
  entries: CashBookEntry[];
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

function emptyBook(window: StatementWindow, book: CashBookKind) {
  return {
    book,
    branchId: statementBranchLabel(window),
    from: window.from,
    to: window.to,
    accounts: [] as CashBookAccount[],
    opening: 0,
    receipts: 0,
    payments: 0,
    closing: 0,
    branchReceipts: 0,
    branchPayments: 0,
    branchMovement: 0,
  };
}

export async function buildCashBook(
  client: AccountingClient,
  window: StatementWindow,
  options: CashBookOptions = {}
) {
  const book: CashBookKind = options.kind || 'CASH_BANK';
  if (window.empty) return emptyBook(window, book);

  const kinds =
    book === 'CASH'
      ? ['CASH']
      : book === 'BANK'
        ? ['BANK']
        : book === 'WALLET'
          ? ['WALLET']
          : ['CASH', 'BANK', 'WALLET'];
  // Bank and wallet balances belong to the external account, not to a branch.
  // Their company balance is returned beside the branch movement.
  const companyWide = book === 'BANK' || book === 'WALLET';
  const accountId = options.accountId || null;

  const [accountRows, entryRows] = await Promise.all([
    client.query(CASH_BANK_ACCOUNT_ROWS_SQL, [
      window.from,
      window.to,
      window.branchId,
      kinds,
      companyWide,
      accountId,
    ]),
    client.query(CASH_BANK_ENTRY_ROWS_SQL, [
      window.from,
      window.to,
      window.branchId,
      kinds,
      companyWide,
      accountId,
    ]),
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
    const branchReceipts = money(row.branchReceipts);
    const branchPayments = money(row.branchPayments);
    let running = opening;
    const entries = (entriesByAccount.get(String(row.accountId)) || []).map((entry: any) => {
      const debit = money(entry.debit);
      const credit = money(entry.credit);
      running = roundMoney(running + debit - credit);
      return {
        journalDateAD: String(entry.journalDateAD).slice(0, 10),
        journalNo: String(entry.journalNo),
        journalId: String(entry.journalId),
        sourceType: String(entry.sourceType),
        sourceId: entry.sourceId ? String(entry.sourceId) : null,
        branchId: String(entry.branchId),
        branchCode: entry.branchCode ? String(entry.branchCode) : null,
        branchName: entry.branchName ? String(entry.branchName) : null,
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
      accountKind:
        row.accountKind === 'CASH' ? 'CASH' : row.accountKind === 'WALLET' ? 'WALLET' : 'BANK',
      postingRole: row.postingRole ? String(row.postingRole) : null,
      branchId: row.branchId ? String(row.branchId) : null,
      branchCode: row.branchCode ? String(row.branchCode) : null,
      branchName: row.branchName ? String(row.branchName) : null,
      isShared: !row.branchId,
      providerCode: row.providerCode ? String(row.providerCode) : null,
      merchantId: row.merchantId ? String(row.merchantId) : null,
      settlementAccountId: row.settlementAccountId ? String(row.settlementAccountId) : null,
      bankName: row.bankName ? String(row.bankName) : null,
      bankBranch: row.bankBranch ? String(row.bankBranch) : null,
      accountNumber: row.accountNumber ? String(row.accountNumber) : null,
      accountHolder: row.accountHolder ? String(row.accountHolder) : null,
      swiftCode: row.swiftCode ? String(row.swiftCode) : null,
      isActive: row.isActive === true,
      opening,
      receipts,
      payments,
      closing: roundMoney(opening + receipts - payments),
      branchReceipts,
      branchPayments,
      branchMovement: roundMoney(branchReceipts - branchPayments),
      entries,
    };
  });

  const sum = (pick: (account: CashBookAccount) => number) =>
    roundMoney(accounts.reduce((total, account) => total + pick(account), 0));

  const opening = sum((account) => account.opening);
  const receipts = sum((account) => account.receipts);
  const payments = sum((account) => account.payments);
  const branchReceipts = sum((account) => account.branchReceipts);
  const branchPayments = sum((account) => account.branchPayments);

  return {
    book,
    branchId: statementBranchLabel(window),
    from: window.from,
    to: window.to,
    accounts,
    opening,
    receipts,
    payments,
    closing: roundMoney(opening + receipts - payments),
    branchReceipts,
    branchPayments,
    branchMovement: roundMoney(branchReceipts - branchPayments),
  };
}
