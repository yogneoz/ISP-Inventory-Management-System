/**
 * Accounting read API — statements, cash book, chart of accounts and posting
 * defaults.
 *
 * Every figure here is computed by the server from posted journal lines; the
 * client never derives a statement locally. The workspace screen consumes these
 * endpoints so it cannot quietly disagree with the ledger.
 */
import { fetchJson } from './http';
import type { BillTerm, CostCenter, NarrationTemplate, NarrationTransactionType } from '../../types';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
export type AccountKind = 'CASH' | 'BANK' | 'WALLET' | 'OTHER';

export interface AccountingGroup {
  id: string;
  /** Null for a top-level group; a sub-group names its parent. */
  parentId: string | null;
  code: string;
  name: string;
  accountType: AccountType;
  statementGroup: string;
  normalBalance: string;
  sortOrder: number;
  isActive: boolean;
  isDemo: boolean;
}

export interface AccountingAccount {
  id: string;
  code: string;
  name: string;
  groupId: string;
  /** Operator note: what belongs in the account and how it posts. */
  description: string | null;
  /** The standard's own citation for the account, e.g. "NAS 16" or "NFRS 15". */
  statutoryReference: string | null;
  /** Legacy GL-master metadata (short name, category, terms, currency). */
  masterProfile?: Record<string, unknown>;
  isControl: boolean;
  subledgerType: string;
  postingRole: string | null;
  /** Classifies every till, bank and wallet clearing ledger. */
  accountKind?: AccountKind;
  /** Owner branch; null/undefined means the custody ledger is shared. */
  branchId?: string | null;
  providerCode?: string | null;
  merchantId?: string | null;
  settlementAccountId?: string | null;
  bankName?: string | null;
  bankBranch?: string | null;
  accountNumber?: string | null;
  accountHolder?: string | null;
  swiftCode?: string | null;
  isActive: boolean;
  isDemo: boolean;
  groupCode: string;
  groupName: string;
  accountType: AccountType;
  statementGroup: string;
  normalBalance: string;
}

export interface SettlementAccount {
  id: string;
  code: string;
  name: string;
  accountKind: 'CASH' | 'BANK' | 'WALLET';
  postingRole: 'CASH' | 'BANK' | null;
  providerCode?: 'ESEWA' | 'KHALTI' | 'NEPAL_PAY' | null;
  bankName?: string | null;
  bankBranch?: string | null;
  accountNumber?: string | null;
  accountHolder?: string | null;
  swiftCode?: string | null;
}

export interface PostingDefault {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  statementGroup: string;
  isControl: boolean;
  subledgerType: string;
}

export interface PostingDefaultsResponse {
  defaults: Record<string, PostingDefault>;
}

export interface StatementQuery {
  /** Omit (or pass ALL) for the company-level roll-up. */
  branchId?: string;
  /** As-of date in YYYY-MM-DD form; the server defaults to today. */
  to?: string;
  /** Optional period start for the flow statements. */
  from?: string;
  /** Cash-book custody filter; other statement reads ignore it. */
  kind?: 'CASH' | 'BANK' | 'WALLET' | 'CASH_BANK';
  /** Narrow a cash/bank/wallet book to one custody account. */
  accountId?: string;
  /** Closing or movement presentation for the branch balance-sheet matrix. */
  view?: 'CLOSING' | 'MOVEMENT';
}

export interface StatementAccountAmount {
  accountId: string;
  code: string;
  name: string;
  groupCode: string;
  groupName: string;
  amount: number;
}

export interface StatementGroupBlock {
  groupId: string;
  parentGroupId: string | null;
  groupCode: string;
  groupName: string;
  sortOrder: number;
  /** This group's direct accounts plus every sub-group beneath it. */
  amount: number;
  accounts: StatementAccountAmount[];
  children: StatementGroupBlock[];
}

export interface StatementSection {
  statementGroup: string;
  label: string;
  amount: number;
  groups: StatementGroupBlock[];
}

export interface ControlAgreement {
  accountId: string;
  code: string;
  name: string;
  subledgerType: string;
  glBalance: number;
  subledgerBalance: number;
  difference: number;
  status: 'RECONCILED' | 'DIFFERENCE';
}

export interface TrialBalanceAccount {
  accountId: string;
  code: string;
  name: string;
  groupCode: string;
  groupName: string;
  accountType: AccountType;
  statementGroup: string;
  subledgerType: string;
  openingBalance: number;
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  closingBalance: number;
  closingDebit: number;
  closingCredit: number;
}

export interface TrialBalanceGroup {
  groupId: string;
  code: string;
  name: string;
  parentGroupId: string | null;
  sortOrder: number;
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  closingDebit: number;
  closingCredit: number;
  accounts: TrialBalanceAccount[];
  children: TrialBalanceGroup[];
}

export interface BsLedgerMonth {
  fiscalYear: string;
  bsYear: number;
  bsMonth: number;
  bsMonthName: string;
  bsMonthNameNp: string;
  quarter: string;
  startAD: string;
  endAD: string;
  startBS: string;
  endBS: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface BsLedgerQuarter {
  fiscalYear: string;
  bsYear: number;
  quarter: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface BsLedgerSummaryResponse {
  statement: 'BS_LEDGER_SUMMARY';
  branchId: string | null;
  from: string | null;
  to: string;
  months: BsLedgerMonth[];
  quarters: BsLedgerQuarter[];
  totals: { debit: number; credit: number; balance: number };
  adTotals: { debit: number; credit: number; balance: number };
  difference: number;
  reconciled: boolean;
}

export interface TrialBalanceResponse {
  statement: 'TRIAL_BALANCE';
  branchId: string | null;
  from: string | null;
  to: string;
  /** Top-level groups with their sub-groups, direct accounts and subtotals. */
  groups: TrialBalanceGroup[];
  sections: StatementSection[];
  accounts: TrialBalanceAccount[];
  totals: {
    openingDebit: number;
    openingCredit: number;
    periodDebit: number;
    periodCredit: number;
    closingDebit: number;
    closingCredit: number;
  };
  balanced: boolean;
  controls: ControlAgreement[];
  controlsReconciled: boolean;
}

export interface ProfitAndLossResponse {
  statement: 'PROFIT_AND_LOSS';
  branchId: string | null;
  from: string | null;
  to: string;
  sections: StatementSection[];
  revenue: number;
  otherIncome: number;
  totalIncome: number;
  costOfSales: number;
  operatingExpense: number;
  otherExpense: number;
  totalExpenses: number;
  grossProfit: number;
  netProfit: number;
}

export interface BranchProfitAndLossMatrixBranch {
  branchId: string;
  code: string;
  name: string;
}

export type BranchProfitAndLossMatrixRowKind = 'SECTION' | 'GROUP' | 'ACCOUNT' | 'SUMMARY';

export interface BranchProfitAndLossMatrixRow {
  key: string;
  kind: BranchProfitAndLossMatrixRowKind;
  statementGroup: string | null;
  code: string | null;
  label: string;
  level: number;
  amounts: Record<string, number>;
  total: number;
}

export interface BranchProfitAndLossMatrixResponse {
  statement: 'BRANCH_PROFIT_AND_LOSS';
  branchId: string | null;
  from: string | null;
  to: string;
  branches: BranchProfitAndLossMatrixBranch[];
  rows: BranchProfitAndLossMatrixRow[];
}

export type BranchBalanceSheetView = 'CLOSING' | 'MOVEMENT';

export interface BranchBalanceSheetMatrixResponse {
  statement: 'BRANCH_BALANCE_SHEET';
  branchId: string | null;
  from: string | null;
  asOf: string;
  view: BranchBalanceSheetView;
  branches: BranchProfitAndLossMatrixBranch[];
  rows: BranchProfitAndLossMatrixRow[];
}

export interface BalanceSheetResponse {
  statement: 'BALANCE_SHEET';
  branchId: string | null;
  from: null;
  asOf: string;
  assets: { sections: StatementSection[]; total: number };
  liabilities: { sections: StatementSection[]; total: number };
  equity: {
    sections: StatementSection[];
    postedTotal: number;
    currentEarnings: number;
    total: number;
  };
  totalAssets: number;
  cashAndBank: number;
  totalLiabilities: number;
  totalEquity: number;
  totalLiabilitiesAndEquity: number;
  difference: number;
  balanced: boolean;
  interBranch: { dueFromHeadOffice: number; dueToHeadOffice: number };
}

/** One opening/period/closing line on the balance-sheet movement view. */
export interface BalanceSheetMovementAmount {
  opening: number;
  period: number;
  closing: number;
  /** Closing − opening. */
  change: number;
  /** Null when opening is zero. */
  changePercent: number | null;
}

export interface BalanceSheetMovementAccount extends BalanceSheetMovementAmount {
  accountId: string;
  code: string;
  name: string;
  groupCode: string;
  groupName: string;
  accountType: AccountType;
}

export interface BalanceSheetMovementGroup extends BalanceSheetMovementAmount {
  groupId: string;
  parentGroupId: string | null;
  groupCode: string;
  groupName: string;
  sortOrder: number;
  accounts: BalanceSheetMovementAccount[];
  children: BalanceSheetMovementGroup[];
}

export interface BalanceSheetMovementSection extends BalanceSheetMovementAmount {
  statementGroup: string;
  label: string;
  groups: BalanceSheetMovementGroup[];
}

export interface BalanceSheetMovementResponse {
  statement: 'BALANCE_SHEET_MOVEMENT';
  branchId: string | null;
  from: string;
  asOf: string;
  assets: { sections: BalanceSheetMovementSection[]; total: BalanceSheetMovementAmount };
  liabilities: { sections: BalanceSheetMovementSection[]; total: BalanceSheetMovementAmount };
  equity: {
    sections: BalanceSheetMovementSection[];
    postedTotal: BalanceSheetMovementAmount;
    currentEarnings: BalanceSheetMovementAmount;
    total: BalanceSheetMovementAmount;
  };
  totalAssets: BalanceSheetMovementAmount;
  cashAndBank: BalanceSheetMovementAmount;
  totalLiabilities: BalanceSheetMovementAmount;
  totalEquity: BalanceSheetMovementAmount;
  totalLiabilitiesAndEquity: BalanceSheetMovementAmount;
  difference: BalanceSheetMovementAmount;
  balanced: boolean;
  interBranch: {
    dueFromHeadOffice: BalanceSheetMovementAmount;
    dueToHeadOffice: BalanceSheetMovementAmount;
  };
}

export type CashFlowSectionKey = 'OPERATING' | 'INVESTING' | 'FINANCING';

export interface CashFlowLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  groupCode: string;
  groupName: string;
  /** Positive is a receipt; negative is a payment. */
  amount: number;
  journalCount: number;
}

export interface CashFlowSection {
  key: CashFlowSectionKey;
  label: string;
  amount: number;
  lines: CashFlowLine[];
}

export interface CashFlowResponse {
  statement: 'CASH_FLOW';
  method: 'DIRECT';
  branchId: string | null;
  from: string | null;
  to: string;
  openingCash: number;
  closingCash: number;
  cashBookClosing: number;
  netCashFlow: number;
  classifiedCashFlow: number;
  difference: number;
  reconciled: boolean;
  sections: CashFlowSection[];
}

export type CashFlowForecastSource = 'AR' | 'AP' | 'RECURRING' | 'PAYROLL' | 'MANUAL';
export type CashFlowForecastDirection = 'INFLOW' | 'OUTFLOW';
export type CashFlowForecastItemKind =
  | 'INVOICE'
  | 'ADJUSTMENT'
  | 'CREDIT'
  | 'RECURRING'
  | 'PAYROLL'
  | 'MANUAL';

export interface CashFlowForecastQuery {
  branchId?: string;
  /** As-of date; the server defaults to today. */
  asOf?: string;
  /** Number of 7-day buckets, 1–26. Defaults to 13. */
  weeks?: number;
  /** Closing cash below this figure raises the warning. Defaults to 0. */
  minCash?: number;
}

export interface CashFlowForecastItem {
  kind: CashFlowForecastItemKind;
  source: CashFlowForecastSource;
  direction: CashFlowForecastDirection;
  documentId: string | null;
  documentNo: string | null;
  partyId: string;
  partyName: string;
  dueDateAD: string;
  bucketKey: string | null;
  bucketIndex: number | null;
  overdue: boolean;
  description: string;
  amount: number;
}

export interface CashFlowForecastBucket {
  key: string;
  label: string;
  fromAD: string;
  toAD: string;
  receipts: number;
  customerCredits: number;
  payments: number;
  supplierCredits: number;
  recurringInflows: number;
  recurringOutflows: number;
  payrollOutflows: number;
  manualInflows: number;
  manualOutflows: number;
  inflows: number;
  outflows: number;
  netCashFlow: number;
  closingCash: number;
  belowMinimum: boolean;
  itemCount: number;
}

export interface CashFlowForecastTieOut {
  grossTotal: number;
  unappliedCredit: number;
  total: number;
  controlBalance: number;
  difference: number;
  reconciled: boolean;
  openItemCount: number;
  overdueAmount: number;
}

export interface CashFlowForecastSourceSummary {
  scheduledCount: number;
  scheduledAmount: number;
  includedCount: number;
  includedAmount: number;
  overdueAmount: number;
  beyondHorizon: { count: number; amount: number };
  closedPeriodExcluded: { count: number; amount: number };
}

export interface CashFlowManualInput {
  id: string;
  branchId: string;
  branchCode: string;
  branchName: string;
  expectedDateAD: string;
  expectedDateBS: string;
  direction: CashFlowForecastDirection;
  amountFormula: string;
  amount: number;
  description: string;
  closedPeriod: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CashFlowManualInputInput {
  branchId?: string;
  expectedDateAD: string;
  direction: CashFlowForecastDirection;
  amountFormula: string;
  description: string;
}

export interface CashFlowManualInputsResponse {
  inputs: CashFlowManualInput[];
  count: number;
}

export interface CashFlowForecastResponse {
  statement: 'CASH_FLOW_FORECAST';
  basis: 'WEEKLY';
  branchId: string | null;
  asOf: string;
  weeks: number;
  minCash: number;
  openingCash: number;
  totalInflows: number;
  totalOutflows: number;
  netCashFlow: number;
  closingCash: number;
  minimumClosingCash: number;
  openingBelowMinimum: boolean;
  warning: boolean;
  firstBreach: { bucketKey: string; closingCash: number } | null;
  breaches: string[];
  buckets: CashFlowForecastBucket[];
  items: CashFlowForecastItem[];
  manualInputs: CashFlowManualInput[];
  ar: CashFlowForecastTieOut;
  ap: CashFlowForecastTieOut;
  sources: {
    recurring: CashFlowForecastSourceSummary;
    payroll: CashFlowForecastSourceSummary;
    manual: CashFlowForecastSourceSummary;
  };
  beyondHorizon: {
    ar: { count: number; amount: number };
    ap: { count: number; amount: number };
    recurring: { count: number; amount: number };
    payroll: { count: number; amount: number };
    manual: { count: number; amount: number };
  };
}

export type StatementGroupDrilldownStatement = 'PROFIT_AND_LOSS' | 'BALANCE_SHEET';

/** One POSTED journal line behind a statement group subtotal. */
export interface StatementGroupLine {
  id: string;
  journalId: string;
  journalNo: string;
  journalDateAD: string;
  sourceType: string;
  sourceId: string | null;
  branchId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  lineNo: number;
  memo: string | null;
  journalMemo: string | null;
  debit: number;
  credit: number;
  /** The line's contribution to the subtotal, natural-side positive. */
  amount: number;
}

export interface StatementGroupSummary {
  groupId: string;
  parentGroupId: string | null;
  groupCode: string;
  groupName: string;
  sortOrder: number;
  accountType: AccountType;
  statementGroup: string;
  /** The group's direct accounts plus every sub-group beneath it. */
  amount: number;
}

export interface StatementGroupLinesResponse {
  statement: StatementGroupDrilldownStatement;
  branchId: string | null;
  from: string | null;
  to: string;
  group: StatementGroupSummary;
  entries: StatementGroupLine[];
  /** Totals over every matching line, not just the returned page. */
  totals: { debit: number; credit: number; amount: number; entryCount: number };
  truncated: boolean;
  limit: number;
}

export interface StatementGroupLinesQuery {
  groupId: string;
  statement: StatementGroupDrilldownStatement;
  branchId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export type TrialBalanceGroupLineWindow = 'OPENING' | 'PERIOD';

/** One POSTED line behind a trial-balance group subtotal. */
export interface TrialBalanceGroupLine extends Omit<StatementGroupLine, 'amount'> {
  /** Opening lines are before `from`; period lines fall inside `from`..`to`. */
  window: TrialBalanceGroupLineWindow;
}

export interface TrialBalanceGroupSummary {
  groupId: string;
  parentGroupId: string | null;
  groupCode: string;
  groupName: string;
  sortOrder: number;
  accountType: AccountType;
  statementGroup: string;
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  closingDebit: number;
  closingCredit: number;
}

export interface TrialBalanceGroupLinesResponse {
  statement: 'TRIAL_BALANCE';
  branchId: string | null;
  from: string | null;
  to: string;
  group: TrialBalanceGroupSummary;
  entries: TrialBalanceGroupLine[];
  /**
   * Totals over every matching line, independent of the per-window page.
   * Opening and closing are net per account, like the trial balance columns;
   * period debit and credit are posted turnover.
   */
  totals: {
    openingDebit: number;
    openingCredit: number;
    periodDebit: number;
    periodCredit: number;
    closingDebit: number;
    closingCredit: number;
    openingEntryCount: number;
    periodEntryCount: number;
    entryCount: number;
  };
  truncated: boolean;
  limit: number;
}

export interface TrialBalanceGroupLinesQuery {
  groupId: string;
  branchId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/** One POSTED line behind a trial-balance account row. */
export interface TrialBalanceAccountLine extends TrialBalanceGroupLine {
  /** Debit-positive (`debit - credit`) after this line within its window. */
  runningBalance: number;
}

export interface TrialBalanceAccountLinesResponse {
  statement: 'TRIAL_BALANCE';
  branchId: string | null;
  from: string | null;
  to: string;
  account: TrialBalanceAccount;
  entries: TrialBalanceAccountLine[];
  totals: TrialBalanceGroupLinesResponse['totals'];
  truncated: boolean;
  limit: number;
}

export interface TrialBalanceAccountLinesQuery {
  accountId: string;
  branchId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface CashBookEntry {
  journalDateAD: string;
  journalNo: string;
  journalId: string;
  sourceType: string;
  sourceId: string | null;
  branchId: string;
  branchCode?: string | null;
  branchName?: string | null;
  memo: string | null;
  debit: number;
  credit: number;
  type: 'RECEIPT' | 'PAYMENT';
  balance: number;
}

export interface CashBookAccount {
  accountId: string;
  code: string;
  name: string;
  accountKind?: 'CASH' | 'BANK' | 'WALLET';
  postingRole: string | null;
  branchId?: string | null;
  branchCode?: string | null;
  branchName?: string | null;
  isShared?: boolean;
  providerCode?: string | null;
  merchantId?: string | null;
  settlementAccountId?: string | null;
  bankName?: string | null;
  bankBranch?: string | null;
  accountNumber?: string | null;
  accountHolder?: string | null;
  swiftCode?: string | null;
  isActive: boolean;
  opening: number;
  receipts: number;
  payments: number;
  closing: number;
  branchReceipts: number;
  branchPayments: number;
  branchMovement: number;
  entries: CashBookEntry[];
}

export interface CashBookResponse {
  book: 'CASH' | 'BANK' | 'WALLET' | 'CASH_BANK';
  branchId: string | null;
  from: string | null;
  to: string;
  accounts: CashBookAccount[];
  opening: number;
  receipts: number;
  payments: number;
  closing: number;
  branchReceipts: number;
  branchPayments: number;
  branchMovement: number;
}

export interface BankReconciliationAccount {
  accountId: string;
  code: string;
  name: string;
  bankName: string | null;
  bankBranch: string | null;
  accountNumber: string | null;
  accountHolder: string | null;
  isActive: boolean;
}

export interface BankBookEntry {
  journalLineId: string;
  journalId: string;
  journalNo: string;
  journalDateAD: string;
  sourceType: string;
  sourceId: string | null;
  journalMemo: string | null;
  memo: string | null;
  debit: number;
  credit: number;
  /** Positive when the bank ledger was debited (money in). */
  amount: number;
  branchId: string;
  branchCode: string;
  branchName: string;
  matchedStatementLineId: string | null;
}

export interface BankStatementLine {
  id: string;
  statementDate: string;
  statementDateBS: string;
  description: string;
  reference: string | null;
  /** Positive = deposit, negative = withdrawal. */
  amount: number;
  importBatchId: string;
  importSource: 'CSV' | 'OFX';
  matchedJournalLineId: string | null;
  matchedAt: string | null;
  matchedBy: string | null;
  matchedJournalNo: string | null;
  matchedJournalDate: string | null;
  matchedBranchId: string | null;
  matchedBranchCode: string | null;
  matchedBranchName: string | null;
  suggestedJournalLineId: string | null;
}

export interface BankReconciliationSession {
  id: string;
  bankAccountId: string;
  periodStart: string;
  periodEnd: string;
  periodStartBS: string;
  periodEndBS: string;
  openingStatementBalance: number;
  closingStatementBalance: number;
  status: 'OPEN' | 'LOCKED';
  lockedAt: string | null;
  lockedBy: string | null;
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenReason: string | null;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BankReconciliationResponse {
  from: string;
  to: string;
  accounts: BankReconciliationAccount[];
  account: BankReconciliationAccount | null;
  session: BankReconciliationSession | null;
  statement: {
    openingBalance: number;
    closingBalance: number;
    movement: number;
    lineCount: number;
    matchedCount: number;
    unmatchedCount: number;
    unmatchedAmount: number;
  };
  book: {
    openingBalance: number;
    closingBalance: number;
    movement: number;
    lineCount: number;
    entries: BankBookEntry[];
    truncated: boolean;
  };
  difference: number;
  reconciled: boolean;
  lines: BankStatementLine[];
  linesTruncated: boolean;
}

export interface BankReconciliationQuery {
  accountId?: string;
  from?: string;
  to?: string;
}

export interface BankStatementImportIssue {
  row: number;
  message: string;
}

export interface BankStatementImportResponse {
  batchId: string;
  parsed: number;
  imported: number;
  duplicates: number;
  errors: BankStatementImportIssue[];
  source: 'CSV' | 'OFX';
  workspace: BankReconciliationResponse;
}

export interface BankReconciliationActionContext extends BankReconciliationQuery {
  accountId: string;
}

export interface BankReconciliationImportInput extends BankReconciliationActionContext {
  content: string;
  format?: 'CSV' | 'OFX';
  fileName?: string;
}

export interface BankReconciliationSessionInput extends BankReconciliationActionContext {
  openingStatementBalance: number;
  closingStatementBalance: number;
}

export interface BankReconciliationSessionActionResponse {
  session: BankReconciliationSession;
  workspace: BankReconciliationResponse;
  changed?: boolean;
  reason?: string;
}

export interface BankReconciliationMatchResponse {
  lineId: string;
  journalLineId: string;
  journalNo: string;
  amount: number;
  workspace: BankReconciliationResponse;
}

export interface WalletReconciliationQuery {
  accountId?: string;
  from?: string;
  to?: string;
}

export interface WalletAccountOption {
  accountId: string;
  code: string;
  name: string;
  providerCode: 'ESEWA' | 'KHALTI' | 'NEPAL_PAY' | null;
  settlementAccountId: string | null;
  branchId: string | null;
  branchCode: string | null;
  isActive: boolean;
}

export interface WalletPendingReceipt {
  id: string;
  paymentNumber: string;
  customerName: string;
  paymentDateAD: string;
  providerCode: string | null;
  providerTransactionId: string | null;
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  settledGross: number;
  outstandingGross: number;
}

export interface WalletSettlementRow {
  id: string;
  settlementNumber: string;
  customerPaymentId: string;
  paymentNumber: string;
  customerName: string;
  bankAccountId: string;
  bankAccountCode: string;
  settlementDateAD: string;
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  providerReference: string | null;
  journalId: string;
  status: string;
}

export interface ProviderStatementLine {
  id: string;
  statementDate: string;
  statementDateBS: string;
  description: string;
  reference: string | null;
  amount: number;
  importBatchId: string;
  importSource: 'CSV' | 'OFX';
  matchedSettlementId: string | null;
  matchedAt: string | null;
  matchedBy: string | null;
  matchedSettlementNumber: string | null;
  matchedSettlementNet: number | null;
  suggestedSettlementId: string | null;
}

export interface WalletReconciliationResponse {
  from: string;
  to: string;
  accounts: WalletAccountOption[];
  account: WalletAccountOption | null;
  summary: {
    ledgerOpening: number;
    ledgerReceipts: number;
    ledgerSettlements: number;
    ledgerClosing: number;
    grossReceipts: number;
    receiptCount: number;
    settledGross: number;
    settlementCount: number;
    fees: number;
    netBanked: number;
    unsettledGross: number;
    difference: number;
    reconciled: boolean;
  };
  pending: WalletPendingReceipt[];
  settlements: WalletSettlementRow[];
  statement: {
    lineCount: number;
    matchedCount: number;
    unmatchedCount: number;
    unmatchedAmount: number;
    movement: number;
  };
  lines: ProviderStatementLine[];
  linesTruncated: boolean;
}

export interface WalletSettlementCreateInput extends WalletReconciliationQuery {
  customerPaymentId: string;
  bankAccountId: string;
  settlementDateAD: string;
  grossAmount: number;
  feeAmount: number;
  providerReference?: string;
}

export interface WalletSettlementActionResponse {
  settlement: {
    id: string;
    settlementNumber: string;
    customerPaymentId: string;
    paymentNumber: string;
    customerName: string;
    providerCode: string;
    providerTransactionId: string | null;
    walletAccountId: string;
    walletAccountCode: string;
    bankAccountId: string;
    bankAccountCode: string;
    settlementDateAD: string;
    grossAmount: number;
    feeAmount: number;
    netAmount: number;
    providerReference: string | null;
    journalId: string;
    status: string;
  };
  workspace: WalletReconciliationResponse;
}

export interface ProviderStatementImportInput extends WalletReconciliationQuery {
  accountId: string;
  content: string;
  format?: 'CSV' | 'OFX';
  fileName?: string;
}

export interface ProviderStatementImportResponse {
  batchId: string;
  parsed: number;
  imported: number;
  duplicates: number;
  autoMatched: number;
  errors: BankStatementImportIssue[];
  source: 'CSV' | 'OFX';
  workspace: WalletReconciliationResponse;
}

export interface ProviderStatementMatchResponse {
  lineId: string;
  settlementId: string;
  amount: number;
  workspace: WalletReconciliationResponse;
}

export type AgingType = 'AR' | 'AP';
export type AgingBucketKey =
  | 'CURRENT'
  | 'DAYS_1_30'
  | 'DAYS_31_60'
  | 'DAYS_61_90'
  | 'DAYS_90_PLUS';

export interface AgingBucket {
  key: AgingBucketKey;
  label: string;
  minDays: number | null;
  maxDays: number | null;
  amount: number;
}

export interface AgingItemRow {
  kind: 'INVOICE' | 'ADJUSTMENT' | 'CREDIT';
  documentId: string | null;
  documentNo: string | null;
  documentDateAD: string;
  dueDateAD: string | null;
  termsDays: number | null;
  daysPastDue: number | null;
  bucket: AgingBucketKey | null;
  branchId: string;
  journalNo: string;
  sourceType: string;
  description: string;
  originalAmount: number;
  allocatedAmount: number;
  amount: number;
}

export interface AgingParty {
  partyId: string;
  partyName: string;
  buckets: Record<AgingBucketKey, number>;
  /** Open charges before credits. */
  grossTotal: number;
  unappliedCredit: number;
  /** Open charges less unapplied credits. */
  total: number;
  rows: AgingItemRow[];
}

export interface AgingResponse {
  report: 'AR_AGING' | 'AP_AGING';
  type: AgingType;
  asOf: string;
  branchId: string | null;
  account: {
    accountId: string;
    code: string;
    name: string;
    postingRole: string;
    subledgerType: string;
    isActive: boolean;
  };
  buckets: AgingBucket[];
  parties: AgingParty[];
  totals: Record<AgingBucketKey, number> & {
    /** Open charges before credits (the sum of the buckets). */
    grossTotal: number;
    unappliedCredit: number;
    /** Gross total less credits; ties to the control-account balance. */
    total: number;
    controlBalance: number;
    difference: number;
    reconciled: boolean;
  };
}

export interface AgingQuery {
  type: AgingType;
  /** Omit (or pass ALL) for the company-level roll-up. */
  branchId?: string;
  /** As-of date in YYYY-MM-DD form; the server defaults to today. */
  asOf?: string;
}

export interface ControlReconciliationResponse {
  accountId: string;
  accountCode: string;
  accountName: string;
  subledgerType: string;
  branchId: string;
  glBalance: number;
  subledgerBalance: number;
  difference: number;
  status: 'RECONCILED' | 'DIFFERENCE';
  lineCount: number;
  entryCount: number;
  parties: Array<{ partyId: string; partyName: string; balance: number }>;
}

function statementQuery(query: StatementQuery = {}): string {
  const params = new URLSearchParams();
  if (query.branchId && query.branchId !== 'ALL') params.set('branchId', query.branchId);
  if (query.to) params.set('to', query.to);
  if (query.from) params.set('from', query.from);
  if (query.kind) params.set('kind', query.kind);
  if (query.accountId) params.set('accountId', query.accountId);
  if (query.view) params.set('view', query.view);
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

export interface AccountingGroupInput {
  parentId?: string | null;
  code: string;
  name: string;
  accountType: AccountType;
  statementGroup: string;
  normalBalance?: 'DEBIT' | 'CREDIT';
  sortOrder?: number;
}

export interface AccountingGroupPatch {
  /** The code and statement mapping are fixed once the group exists. */
  name?: string;
  sortOrder?: number;
  /** Only an empty group (no accounts, no children) may move. */
  parentId?: string | null;
}

export interface AccountingAccountInput {
  code: string;
  name: string;
  groupId: string;
  description?: string | null;
  masterProfile?: Record<string, unknown>;
  subledgerType?: string;
  postingRole?: string | null;
  accountKind?: AccountKind;
  branchId?: string | null;
  providerCode?: string | null;
  merchantId?: string | null;
  settlementAccountId?: string | null;
  bankName?: string | null;
  bankBranch?: string | null;
  accountNumber?: string | null;
  accountHolder?: string | null;
  swiftCode?: string | null;
}

export interface AccountingAccountPatch {
  name?: string;
  description?: string | null;
  masterProfile?: Record<string, unknown>;
  /**
   * A posted account may move only to a group with the same account type,
   * statement group and normal balance, so history keeps its classification.
   */
  groupId?: string;
  postingRole?: string | null;
  accountKind?: AccountKind;
  branchId?: string | null;
  providerCode?: string | null;
  merchantId?: string | null;
  settlementAccountId?: string | null;
  bankName?: string | null;
  bankBranch?: string | null;
  accountNumber?: string | null;
  accountHolder?: string | null;
  swiftCode?: string | null;
  isActive?: boolean;
}

export async function getAccountingGroups(): Promise<AccountingGroup[]> {
  return fetchJson('/api/accounting/groups');
}

export async function createAccountingGroup(input: AccountingGroupInput): Promise<AccountingGroup> {
  return fetchJson('/api/accounting/groups', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateAccountingGroup(
  id: string,
  input: AccountingGroupPatch
): Promise<AccountingGroup> {
  return fetchJson(`/api/accounting/groups/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteAccountingGroup(id: string): Promise<{ deleted: boolean; id: string }> {
  return fetchJson(`/api/accounting/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function createAccountingAccount(
  input: AccountingAccountInput
): Promise<AccountingAccount> {
  return fetchJson('/api/accounting/accounts', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateAccountingAccount(
  id: string,
  input: AccountingAccountPatch
): Promise<AccountingAccount> {
  return fetchJson(`/api/accounting/accounts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteAccountingAccount(id: string): Promise<{ deleted: boolean; id: string }> {
  return fetchJson(`/api/accounting/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function getAccountingAccounts(includeInactive = false): Promise<AccountingAccount[]> {
  return fetchJson(`/api/accounting/accounts${includeInactive ? '?includeInactive=1' : ''}`);
}

/**
 * Bounded ledger search for the entry-form pickers. The screen no longer loads
 * the whole chart: each keystroke asks for the matching rows (max 20 by
 * default), so opening a voucher stays fast on a large chart.
 */
export async function searchAccountingAccounts(
  query: string,
  options: { kind?: 'CASH' | 'BANK' | 'WALLET' | 'CASH_BANK'; limit?: number } = {}
): Promise<AccountingAccount[]> {
  const params = new URLSearchParams({ q: query.trim() });
  if (options.kind) params.set('kind', options.kind);
  if (options.limit) params.set('limit', String(options.limit));
  return fetchJson(`/api/accounting/accounts/search?${params.toString()}`);
}

/** Active cash/bank ledgers for payment settlement pickers. */
export async function getSettlementAccounts(): Promise<SettlementAccount[]> {
  return fetchJson('/api/accounting/settlement-accounts');
}

export async function getPostingDefaults(): Promise<PostingDefaultsResponse> {
  return fetchJson('/api/accounting/posting-defaults');
}

export interface BillTermInput {
  code: string;
  name: string;
  dueDays: number;
  discountDays?: number | null;
  discountPercent?: number | null;
  active?: boolean;
}

export async function getBillTerms(includeInactive = true): Promise<BillTerm[]> {
  return fetchJson(`/api/accounting/bill-terms${includeInactive ? '?includeInactive=1' : ''}`);
}

export async function createBillTerm(input: BillTermInput): Promise<BillTerm> {
  return fetchJson('/api/accounting/bill-terms', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateBillTerm(
  id: string,
  input: Partial<BillTermInput>
): Promise<BillTerm> {
  return fetchJson(`/api/accounting/bill-terms/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteBillTerm(id: string): Promise<{ deleted: boolean; id: string }> {
  return fetchJson(`/api/accounting/bill-terms/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface CostCenterInput {
  code: string;
  name: string;
  parentId?: string | null;
  branchId?: string | null;
  active?: boolean;
}

export async function getCostCenters(includeInactive = true): Promise<CostCenter[]> {
  return fetchJson(`/api/accounting/cost-centers${includeInactive ? '?includeInactive=1' : ''}`);
}

export async function createCostCenter(input: CostCenterInput): Promise<CostCenter> {
  return fetchJson('/api/accounting/cost-centers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateCostCenter(
  id: string,
  input: Partial<CostCenterInput>
): Promise<CostCenter> {
  return fetchJson(`/api/accounting/cost-centers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteCostCenter(id: string): Promise<{ deleted: boolean; id: string }> {
  return fetchJson(`/api/accounting/cost-centers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface NarrationTemplateInput {
  code: string;
  text: string;
  transactionType: NarrationTransactionType;
  active?: boolean;
}

export async function getNarrationTemplates(
  includeInactive = true,
  type?: NarrationTransactionType
): Promise<NarrationTemplate[]> {
  const params = new URLSearchParams();
  if (includeInactive) params.set('includeInactive', '1');
  if (type) params.set('type', type);
  const suffix = params.toString();
  return fetchJson(`/api/accounting/narrations${suffix ? `?${suffix}` : ''}`);
}

export async function createNarrationTemplate(
  input: NarrationTemplateInput
): Promise<NarrationTemplate> {
  return fetchJson('/api/accounting/narrations', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateNarrationTemplate(
  id: string,
  input: Partial<NarrationTemplateInput>
): Promise<NarrationTemplate> {
  return fetchJson(`/api/accounting/narrations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteNarrationTemplate(
  id: string
): Promise<{ deleted: boolean; id: string }> {
  return fetchJson(`/api/accounting/narrations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export type BudgetAccountType = 'INCOME' | 'EXPENSE';

export interface BudgetQuery {
  fiscalYearId: string;
  /** Omit or pass ALL for the company roll-up (variance reads only). */
  branchId?: string;
  from?: string;
  to?: string;
}

export interface BudgetLine {
  periodKey: string;
  accountId: string;
  amount: number;
  code?: string;
  name?: string;
  accountType?: BudgetAccountType;
}

export interface BudgetPeriodOption {
  periodKey: string;
  startDateAD: string;
  endDateAD: string;
  status: 'OPEN' | 'CLOSED';
}

export interface BudgetAccountOption {
  id: string;
  code: string;
  name: string;
  accountType: BudgetAccountType;
  statementGroup: string;
}

export interface BudgetResponse {
  fiscalYearId: string;
  fiscalYearCode: string;
  branchId: string;
  branchName: string;
  budgetId: string | null;
  locked: boolean;
  lockedBy: string | null;
  lockedAt: string | null;
  updatedAt: string | null;
  periods: BudgetPeriodOption[];
  accounts: BudgetAccountOption[];
  lines: BudgetLine[];
}

export interface BudgetSaveInput {
  fiscalYearId: string;
  branchId: string;
  lines: Array<{ periodKey: string; accountId: string; amount: number }>;
}

export interface BudgetLockInput {
  fiscalYearId: string;
  branchId: string;
  locked: boolean;
}

export interface BudgetLockResponse {
  status: 'LOCKED' | 'UNLOCKED' | 'UNCHANGED';
  budget: BudgetResponse;
}

export type BudgetVersionSource =
  | 'BASELINE'
  | 'SAVE'
  | 'COPY'
  | 'COPY_REPLACE'
  | 'IMPORT'
  | 'IMPORT_REPLACE'
  | 'RESTORE';

export interface BudgetVersionSummary {
  id: string;
  version: number;
  actor: string | null;
  createdAt: string;
  source: BudgetVersionSource;
  sourceDetail: string | null;
  lineCount: number;
  totalAmount: number;
}

export interface BudgetHistoryResponse {
  fiscalYearId: string;
  fiscalYearCode: string;
  branchId: string;
  branchName: string;
  versions: BudgetVersionSummary[];
}

export interface BudgetVersionDetail extends BudgetVersionSummary {
  lines: BudgetLine[];
}

export interface BudgetVersionResponse extends BudgetHistoryResponse {
  version: BudgetVersionDetail;
}

export interface BudgetRestoreResponse {
  status: 'RESTORED';
  restoredVersion: number;
  snapshot: BudgetVersionSummary;
  budget: BudgetResponse;
}

export interface BudgetCopyInput {
  targetFiscalYearId: string;
  branchId: string;
  sourceFiscalYearId?: string;
  replace?: boolean;
}

export interface BudgetSkippedAccount {
  accountId: string;
  code: string | null;
  name: string | null;
  reason: 'MISSING_FROM_CHART' | 'NOT_PROFIT_AND_LOSS';
}

export interface BudgetPeriodMapping {
  sourcePeriodKey: string;
  targetPeriodKey: string;
  sourceStartDateAD: string;
  targetStartDateAD: string;
}

export interface BudgetCopyResponse {
  status: 'COPIED' | 'REPLACED' | 'UNCHANGED';
  sourceFiscalYearId: string;
  sourceFiscalYearCode: string;
  targetFiscalYearId: string;
  targetFiscalYearCode: string;
  branchId: string;
  branchName: string;
  sourceLines: number;
  mappedLines: number;
  copiedLines: number;
  skippedAccounts: BudgetSkippedAccount[];
  periodMapping: BudgetPeriodMapping[];
  unmappedPeriods: string[];
  replacedExisting: boolean;
  budget: BudgetResponse;
}

export interface BudgetImportInput {
  fiscalYearId: string;
  branchId: string;
  csv: string;
  replace?: boolean;
}

export interface BudgetImportError {
  row: number;
  message: string;
}

export interface BudgetImportResponse {
  status: 'IMPORTED' | 'REPLACED' | 'UNCHANGED' | 'REFUSED';
  httpStatus: number;
  importedLines: number;
  replacedExisting: boolean;
  errors: BudgetImportError[];
  budget: BudgetResponse | null;
}

export interface BudgetVarianceRow {
  accountId: string;
  code: string;
  name: string;
  accountType: BudgetAccountType;
  statementGroup: string;
  budget: number;
  actual: number;
  /** budget - actual; positive is remaining, negative is over budget. */
  variance: number;
  /** variance / budget * 100; null when the budget is zero. */
  variancePercent: number | null;
}

export interface BudgetVarianceResponse {
  fiscalYearId: string;
  fiscalYearCode: string;
  branchId: string;
  from: string;
  to: string;
  rows: BudgetVarianceRow[];
  totals: {
    budget: number;
    actual: number;
    variance: number;
    variancePercent: number | null;
  };
}

export interface BudgetOverspendAlert {
  accountId: string;
  code: string;
  name: string;
  accountType: 'EXPENSE';
  statementGroup: string;
  budget: number;
  actual: number;
  variance: number;
  variancePercent: number | null;
  /** actual - budget; always positive for an alert. */
  overBy: number;
  overPercent: number;
  utilisationPercent: number;
}

export interface BudgetOverspendAlertsQuery extends BudgetQuery {
  limit?: number;
}

export interface BudgetOverspendAlertsResponse {
  fiscalYearId: string;
  fiscalYearCode: string;
  branchId: string;
  from: string;
  to: string;
  alerts: BudgetOverspendAlert[];
  totals: {
    alertCount: number;
    budget: number;
    actual: number;
    overBy: number;
  };
  tieOut: {
    sourceBudget: number;
    sourceActual: number;
    alertBudget: number;
    alertActual: number;
    budgetDifference: number;
    actualDifference: number;
    reconciled: boolean;
  };
  truncated: boolean;
  limit: number;
}

export interface BudgetBranchUtilisationRow {
  branchId: string;
  code: string;
  name: string;
  budget: number;
  actual: number;
  /** budget - actual; positive is remaining, negative is over plan. */
  variance: number;
  variancePercent: number | null;
  /** actual / budget * 100; null when the branch has no budget in the window. */
  utilisationPercent: number | null;
}

export interface BudgetBranchUtilisationResponse {
  fiscalYearId: string;
  fiscalYearCode: string;
  branchId: string;
  from: string;
  to: string;
  branches: BudgetBranchUtilisationRow[];
  totals: BudgetVarianceResponse['totals'];
  tieOut: {
    budget: number;
    actual: number;
    cardBudget: number;
    cardActual: number;
    budgetDifference: number;
    actualDifference: number;
    reconciled: boolean;
  };
}

export interface BudgetVarianceLine {
  id: string;
  journalId: string;
  journalNo: string;
  journalDateAD: string;
  sourceType: string;
  sourceId: string | null;
  branchId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  lineNo: number;
  memo: string | null;
  journalMemo: string | null;
  debit: number;
  credit: number;
  /** Natural-side actual: expense debit − credit, income credit − debit. */
  amount: number;
}

export interface BudgetVarianceLinesQuery extends BudgetQuery {
  accountId: string;
  limit?: number;
}

export interface BudgetVarianceLinesResponse {
  fiscalYearId: string;
  fiscalYearCode: string;
  branchId: string;
  from: string;
  to: string;
  account: BudgetVarianceRow;
  entries: BudgetVarianceLine[];
  totals: {
    debit: number;
    credit: number;
    actual: number;
    entryCount: number;
  };
  tieOut: {
    budget: number;
    actual: number;
    variance: number;
    variancePercent: number | null;
    lineActual: number;
    difference: number;
    reconciled: boolean;
  };
  truncated: boolean;
  limit: number;
}

export type BudgetAllocationStatus = 'MISSING' | 'READY';

export interface BudgetAllocationRule {
  accountGroup: string;
  costCenterId: string;
  percentage: number;
  percentageBp: number;
  code: string;
  name: string;
  branchId: string | null;
  active: boolean;
}

export interface BudgetAllocationGroup {
  accountGroup: string;
  label: string;
  budget: number;
  hasOverride: boolean;
  rules: BudgetAllocationRule[];
}

export interface BudgetAllocationCentre {
  id: string;
  code: string;
  name: string;
  branchId: string | null;
  parentId: string | null;
  active: boolean;
}

export interface BudgetAllocationResponse {
  fiscalYearId: string;
  fiscalYearCode: string;
  branchId: string;
  branchName: string;
  profileId: string | null;
  status: BudgetAllocationStatus;
  locked: boolean;
  lockedBy: string | null;
  lockedAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  totalExpenseBudget: number;
  rules: BudgetAllocationRule[];
  groups: BudgetAllocationGroup[];
  centres: BudgetAllocationCentre[];
}

export interface BudgetAllocationInput {
  fiscalYearId: string;
  branchId: string;
  rules: Array<{ accountGroup: string; costCenterId: string; percentage: number }>;
}

export interface BudgetDepartmentRow {
  costCenterId: string;
  code: string;
  name: string;
  budget: number;
  actual: number;
  variance: number;
  variancePercent: number | null;
  utilisationPercent: number | null;
  lineCount: number;
  inAllocation: boolean;
}

export interface BudgetDepartmentResponse {
  fiscalYearId: string;
  fiscalYearCode: string;
  branchId: string;
  branchName: string;
  profileId: string | null;
  status: BudgetAllocationStatus;
  from: string;
  to: string;
  departments: BudgetDepartmentRow[];
  groups: Array<{
    accountGroup: string;
    label: string;
    budget: number;
    hasOverride: boolean;
  }>;
  totals: {
    expenseBudget: number;
    allocatedBudget: number;
    expenseActual: number;
    taggedActual: number;
    unallocatedActual: number;
  };
  coverage: {
    totalExpenseLines: number;
    taggedExpenseLines: number;
    untaggedExpenseLines: number;
    taggedPercent: number | null;
  };
  unallocated: {
    actual: number;
    lineCount: number;
  };
  tieOut: {
    budgetDifference: number;
    actualDifference: number;
    reconciled: boolean;
  };
}

function budgetQueryString(query: BudgetQuery): string {
  const params = new URLSearchParams({ fiscalYearId: query.fiscalYearId });
  if (query.branchId && query.branchId !== 'ALL') params.set('branchId', query.branchId);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  return `?${params.toString()}`;
}

export async function getAccountingBudget(query: BudgetQuery): Promise<BudgetResponse> {
  return fetchJson(`/api/accounting/budgets${budgetQueryString(query)}`);
}

export async function saveAccountingBudget(input: BudgetSaveInput): Promise<BudgetResponse> {
  return fetchJson('/api/accounting/budgets', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function setAccountingBudgetLock(
  input: BudgetLockInput
): Promise<BudgetLockResponse> {
  return fetchJson('/api/accounting/budgets/lock', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getAccountingBudgetHistory(
  query: Pick<BudgetQuery, 'fiscalYearId' | 'branchId'>
): Promise<BudgetHistoryResponse> {
  return fetchJson(`/api/accounting/budgets/history${budgetQueryString(query)}`);
}

export async function getAccountingBudgetVersion(query: {
  fiscalYearId: string;
  branchId?: string;
  versionId: string;
}): Promise<BudgetVersionResponse> {
  const base = budgetQueryString(query);
  return fetchJson(
    `/api/accounting/budgets/history/${encodeURIComponent(query.versionId)}${base}`
  );
}

export async function restoreAccountingBudgetVersion(input: {
  fiscalYearId: string;
  branchId: string;
  versionId: string;
}): Promise<BudgetRestoreResponse> {
  return fetchJson(
    `/api/accounting/budgets/history/${encodeURIComponent(input.versionId)}/restore`,
    {
      method: 'POST',
      body: JSON.stringify({
        fiscalYearId: input.fiscalYearId,
        branchId: input.branchId,
      }),
    }
  );
}

export async function getAccountingBudgetVariance(
  query: BudgetQuery
): Promise<BudgetVarianceResponse> {
  return fetchJson(`/api/accounting/budgets/variance${budgetQueryString(query)}`);
}

export async function getAccountingBudgetAlerts(
  query: BudgetOverspendAlertsQuery
): Promise<BudgetOverspendAlertsResponse> {
  const base = budgetQueryString(query);
  return fetchJson(
    `/api/accounting/budgets/variance/alerts${base}${query.limit ? `&limit=${query.limit}` : ''}`
  );
}

export async function getAccountingBudgetVarianceUtilisation(
  query: BudgetQuery
): Promise<BudgetBranchUtilisationResponse> {
  return fetchJson(`/api/accounting/budgets/variance/utilisation${budgetQueryString(query)}`);
}

export async function getAccountingBudgetVarianceLines(
  query: BudgetVarianceLinesQuery
): Promise<BudgetVarianceLinesResponse> {
  const params = new URLSearchParams({
    fiscalYearId: query.fiscalYearId,
    accountId: query.accountId,
  });
  if (query.branchId && query.branchId !== 'ALL') params.set('branchId', query.branchId);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.limit) params.set('limit', String(query.limit));
  return fetchJson(`/api/accounting/budgets/variance/lines?${params.toString()}`);
}

export async function getAccountingBudgetAllocation(
  query: Pick<BudgetQuery, 'fiscalYearId' | 'branchId'>
): Promise<BudgetAllocationResponse> {
  return fetchJson(`/api/accounting/budgets/allocation${budgetQueryString(query)}`);
}

export async function saveAccountingBudgetAllocation(
  input: BudgetAllocationInput
): Promise<BudgetAllocationResponse> {
  return fetchJson('/api/accounting/budgets/allocation', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function getAccountingBudgetDepartmentVariance(
  query: BudgetQuery
): Promise<BudgetDepartmentResponse> {
  return fetchJson(`/api/accounting/budgets/variance/departments${budgetQueryString(query)}`);
}

export async function copyAccountingBudget(
  input: BudgetCopyInput
): Promise<BudgetCopyResponse> {
  return fetchJson('/api/accounting/budgets/copy', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** The structured refusal body carries row errors; suppress the generic toast. */
export async function importAccountingBudgetCsv(
  input: BudgetImportInput
): Promise<BudgetImportResponse> {
  return fetchJson(
    '/api/accounting/budgets/import',
    { method: 'POST', body: JSON.stringify(input) },
    { silent: true }
  );
}

export async function getAccountingBudgetCsv(
  query: Pick<BudgetQuery, 'fiscalYearId' | 'branchId'>
): Promise<Blob> {
  const { fetchBlob } = await import('./blob');
  return fetchBlob(`/api/accounting/budgets/export${budgetQueryString(query)}`);
}

export async function getTrialBalance(query: StatementQuery = {}): Promise<TrialBalanceResponse> {
  return fetchJson(`/api/accounting/statements/trial-balance${statementQuery(query)}`);
}

export async function getBsLedgerSummary(
  query: StatementQuery = {}
): Promise<BsLedgerSummaryResponse> {
  return fetchJson(`/api/accounting/statements/bs-summary${statementQuery(query)}`);
}

export async function getProfitAndLoss(query: StatementQuery = {}): Promise<ProfitAndLossResponse> {
  return fetchJson(`/api/accounting/statements/profit-and-loss${statementQuery(query)}`);
}

export async function getBranchProfitAndLossMatrix(
  query: StatementQuery = {}
): Promise<BranchProfitAndLossMatrixResponse> {
  return fetchJson(`/api/accounting/statements/branch-profit-and-loss${statementQuery(query)}`);
}

export async function getBranchBalanceSheetMatrix(
  query: StatementQuery = {}
): Promise<BranchBalanceSheetMatrixResponse> {
  return fetchJson(`/api/accounting/statements/branch-balance-sheet${statementQuery(query)}`);
}

export async function getBalanceSheet(query: StatementQuery = {}): Promise<BalanceSheetResponse> {
  return fetchJson(`/api/accounting/statements/balance-sheet${statementQuery({ branchId: query.branchId, to: query.to })}`);
}

export async function getBalanceSheetMovement(
  query: StatementQuery = {}
): Promise<BalanceSheetMovementResponse> {
  return fetchJson(`/api/accounting/statements/balance-sheet-movement${statementQuery(query)}`);
}

export async function getCashFlow(query: StatementQuery = {}): Promise<CashFlowResponse> {
  return fetchJson(`/api/accounting/statements/cash-flow${statementQuery(query)}`);
}

/** The same direct cash-flow statement, rendered server-side as a PDF. */
export async function getCashFlowPdf(query: StatementQuery = {}): Promise<Blob> {
  const { fetchBlob } = await import('./blob');
  return fetchBlob(`/api/accounting/statements/cash-flow/print${statementQuery(query)}`);
}

function cashFlowForecastQueryString(query: CashFlowForecastQuery = {}): string {
  const params = new URLSearchParams();
  if (query.branchId && query.branchId !== 'ALL') params.set('branchId', query.branchId);
  if (query.asOf) params.set('asOf', query.asOf);
  if (query.weeks) params.set('weeks', String(query.weeks));
  if (query.minCash !== undefined && query.minCash !== null) {
    params.set('minCash', String(query.minCash));
  }
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
}

export async function getCashFlowForecast(
  query: CashFlowForecastQuery = {}
): Promise<CashFlowForecastResponse> {
  return fetchJson(
    `/api/accounting/statements/cash-flow/forecast${cashFlowForecastQueryString(query)}`
  );
}

/** The same forecast as CSV, exported through the authenticated blob route. */
export async function getCashFlowForecastCsv(
  query: CashFlowForecastQuery = {}
): Promise<Blob> {
  const { fetchBlob } = await import('./blob');
  return fetchBlob(
    `/api/accounting/statements/cash-flow/forecast/export${cashFlowForecastQueryString(query)}`
  );
}

export async function getCashFlowManualInputs(
  query: Pick<CashFlowForecastQuery, 'branchId'> = {}
): Promise<CashFlowManualInputsResponse> {
  const params = new URLSearchParams();
  if (query.branchId && query.branchId !== 'ALL') params.set('branchId', query.branchId);
  const suffix = params.toString();
  return fetchJson(`/api/accounting/cash-flow/manual-inputs${suffix ? `?${suffix}` : ''}`);
}

export async function createCashFlowManualInput(
  input: CashFlowManualInputInput
): Promise<CashFlowManualInput> {
  return fetchJson('/api/accounting/cash-flow/manual-inputs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateCashFlowManualInput(
  id: string,
  input: Partial<CashFlowManualInputInput>
): Promise<CashFlowManualInput> {
  return fetchJson(`/api/accounting/cash-flow/manual-inputs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteCashFlowManualInput(
  id: string
): Promise<{ deleted: true; id: string }> {
  return fetchJson(`/api/accounting/cash-flow/manual-inputs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function getStatementGroupLines(
  query: StatementGroupLinesQuery
): Promise<StatementGroupLinesResponse> {
  const params = new URLSearchParams({
    statement: query.statement,
    groupId: query.groupId,
  });
  if (query.branchId && query.branchId !== 'ALL') params.set('branchId', query.branchId);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.limit) params.set('limit', String(query.limit));
  return fetchJson(`/api/accounting/statements/group-lines?${params.toString()}`);
}

export async function getTrialBalanceGroupLines(
  query: TrialBalanceGroupLinesQuery
): Promise<TrialBalanceGroupLinesResponse> {
  const params = new URLSearchParams({
    statement: 'TRIAL_BALANCE',
    groupId: query.groupId,
  });
  if (query.branchId && query.branchId !== 'ALL') params.set('branchId', query.branchId);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.limit) params.set('limit', String(query.limit));
  return fetchJson(`/api/accounting/statements/group-lines?${params.toString()}`);
}

export async function getTrialBalanceAccountLines(
  query: TrialBalanceAccountLinesQuery
): Promise<TrialBalanceAccountLinesResponse> {
  const params = new URLSearchParams({ accountId: query.accountId });
  if (query.branchId && query.branchId !== 'ALL') params.set('branchId', query.branchId);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.limit) params.set('limit', String(query.limit));
  return fetchJson(`/api/accounting/statements/account-lines?${params.toString()}`);
}

export async function getCashBook(query: StatementQuery = {}): Promise<CashBookResponse> {
  return fetchJson(`/api/accounting/cash-book${statementQuery(query)}`);
}

export async function getBankPosition(query: StatementQuery = {}): Promise<CashBookResponse> {
  return fetchJson(`/api/accounting/bank-position${statementQuery(query)}`);
}

function walletReconciliationQueryString(query: WalletReconciliationQuery = {}): string {
  const params = new URLSearchParams();
  if (query.accountId) params.set('accountId', query.accountId);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
}

export async function getWalletReconciliation(
  query: WalletReconciliationQuery = {}
): Promise<WalletReconciliationResponse> {
  return fetchJson(`/api/accounting/wallet-reconciliation${walletReconciliationQueryString(query)}`);
}

export async function createPaymentSettlement(
  input: WalletSettlementCreateInput
): Promise<WalletSettlementActionResponse> {
  return fetchJson('/api/accounting/wallet-settlements', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function importProviderStatement(
  input: ProviderStatementImportInput
): Promise<ProviderStatementImportResponse> {
  return fetchJson('/api/accounting/wallet-reconciliation/import', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function matchProviderStatementLine(
  lineId: string,
  settlementId: string,
  context: WalletReconciliationQuery & { accountId: string }
): Promise<ProviderStatementMatchResponse> {
  return fetchJson(
    `/api/accounting/wallet-reconciliation/lines/${encodeURIComponent(lineId)}/match`,
    { method: 'POST', body: JSON.stringify({ ...context, settlementId }) }
  );
}

function bankReconciliationQueryString(query: BankReconciliationQuery = {}): string {
  const params = new URLSearchParams();
  if (query.accountId) params.set('accountId', query.accountId);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
}

export async function getBankReconciliation(
  query: BankReconciliationQuery = {}
): Promise<BankReconciliationResponse> {
  return fetchJson(`/api/accounting/bank-reconciliation${bankReconciliationQueryString(query)}`);
}

export async function importBankStatement(
  input: BankReconciliationImportInput
): Promise<BankStatementImportResponse> {
  return fetchJson('/api/accounting/bank-reconciliation/import', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function matchBankStatementLine(
  lineId: string,
  journalLineId: string,
  context: BankReconciliationActionContext
): Promise<BankReconciliationMatchResponse> {
  return fetchJson(
    `/api/accounting/bank-reconciliation/lines/${encodeURIComponent(lineId)}/match`,
    { method: 'POST', body: JSON.stringify({ ...context, journalLineId }) }
  );
}

export async function unmatchBankStatementLine(
  lineId: string,
  context: BankReconciliationActionContext
): Promise<Omit<BankReconciliationMatchResponse, 'journalLineId' | 'journalNo'> & { previousJournalLineId: string }> {
  return fetchJson(
    `/api/accounting/bank-reconciliation/lines/${encodeURIComponent(lineId)}/unmatch`,
    { method: 'POST', body: JSON.stringify(context) }
  );
}

export async function saveBankReconciliationSession(
  input: BankReconciliationSessionInput
): Promise<BankReconciliationSessionActionResponse> {
  return fetchJson('/api/accounting/bank-reconciliation/sessions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function lockBankReconciliationSession(
  sessionId: string,
  context: BankReconciliationActionContext
): Promise<BankReconciliationSessionActionResponse> {
  return fetchJson(
    `/api/accounting/bank-reconciliation/sessions/${encodeURIComponent(sessionId)}/lock`,
    { method: 'POST', body: JSON.stringify(context) }
  );
}

export async function reopenBankReconciliationSession(
  sessionId: string,
  reason: string,
  context: BankReconciliationActionContext
): Promise<BankReconciliationSessionActionResponse> {
  return fetchJson(
    `/api/accounting/bank-reconciliation/sessions/${encodeURIComponent(sessionId)}/reopen`,
    { method: 'POST', body: JSON.stringify({ ...context, reason }) }
  );
}

export async function getAging(query: AgingQuery): Promise<AgingResponse> {
  const params = new URLSearchParams({ type: query.type });
  if (query.branchId && query.branchId !== 'ALL') params.set('branchId', query.branchId);
  if (query.asOf) params.set('asOf', query.asOf);
  return fetchJson(`/api/accounting/aging?${params.toString()}`);
}

export async function getControlReconciliation(
  accountId: string,
  branchId?: string
): Promise<ControlReconciliationResponse> {
  const params = new URLSearchParams({ accountId });
  if (branchId && branchId !== 'ALL') params.set('branchId', branchId);
  return fetchJson(`/api/accounting/reconciliations?${params.toString()}`);
}

export interface CashCloseRecord {
  id: string;
  branchId: string;
  businessDateAD: string;
  businessDateBS: string;
  openingCash: number;
  cashIn: number;
  cashOut: number;
  expectedClosing: number;
  countedClosing: number;
  /** counted − expected at close time. */
  variance: number;
  status: 'CLOSED' | 'OPEN';
  closedBy: string | null;
  closedAt: string | null;
  reopenedBy: string | null;
  reopenedAt: string | null;
}

export interface CashCloseBranch {
  branchId: string;
  code: string;
  name: string;
  opening: number;
  cashIn: number;
  cashOut: number;
  expectedClosing: number;
  status: 'CLOSED' | 'OPEN';
  countedClosing: number | null;
  variance: number | null;
  close: CashCloseRecord | null;
  /** A journal moved the day after the count was taken. */
  stale: boolean;
}

export interface CashPositionTotals {
  opening: number;
  cashIn: number;
  cashOut: number;
  expectedClosing: number;
  countedClosing: number;
  variance: number;
  closedBranches: number;
  openBranches: number;
}

export interface CashPositionResponse {
  dateAD: string;
  dateBS: string;
  branchId: string | null;
  branches: CashCloseBranch[];
  totals: CashPositionTotals;
}

export interface CashCloseBranchResponse {
  dateAD: string;
  dateBS: string;
  branchId: string;
  branch: CashCloseBranch;
  totals: CashPositionTotals;
}

export async function getDailyCashClose(
  branchId: string,
  dateAD: string
): Promise<CashCloseBranchResponse> {
  const params = new URLSearchParams({ branchId, dateAD });
  return fetchJson(`/api/accounting/cash-close?${params.toString()}`);
}

export async function getDailyCashCloseConsolidated(dateAD: string): Promise<CashPositionResponse> {
  return fetchJson(`/api/accounting/cash-close/consolidated?dateAD=${encodeURIComponent(dateAD)}`);
}

export async function closeDailyCash(
  branchId: string,
  dateAD: string,
  countedClosing: number
): Promise<CashCloseRecord> {
  return fetchJson('/api/accounting/cash-close', {
    method: 'POST',
    body: JSON.stringify({ branchId, dateAD, countedClosing }),
  });
}

export async function reopenDailyCashClose(id: string): Promise<CashCloseRecord> {
  return fetchJson(`/api/accounting/cash-close/${encodeURIComponent(id)}/reopen`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * Subledger master — one named book per control ledger, plus the figures that
 * prove the book still reconciles to its account.
 */
export interface AccountingSubledger {
  id: string;
  code: string;
  name: string;
  subledgerType: string;
  mainAccountId: string;
  /** NULL for the account-wide book; a master id for a party book. */
  partyId: string | null;
  description: string | null;
  isActive: boolean;
  isDemo: boolean;
  accountCode: string;
  accountName: string;
  accountPostingRole: string | null;
  groupCode: string;
  groupName: string;
  /** Rows and balance of THIS book in the selected branch. */
  entryCount: number;
  bookBalance: number;
  /** All books on the control account, in the selected branch. */
  subledgerBalance: number;
  glBalance: number;
  /** GL minus every book on the account; the account-level tie-out. */
  difference: number;
  unlinkedCount: number;
}

export interface AccountingSubledgerInput {
  code: string;
  name: string;
  mainAccountId: string;
  subledgerType?: string;
  /** Customer/supplier/employee master id; omit for the account-wide book. */
  partyId?: string | null;
  description?: string | null;
  isActive?: boolean;
}

export interface AccountingSubledgerPatch {
  name?: string;
  mainAccountId?: string;
  description?: string | null;
  isActive?: boolean;
}

export interface ChartHealth {
  missingPostingRoles: string[];
  controlAccountsWithoutSubledger: Array<{
    accountId: string;
    code: string;
    name: string;
    subledgerType: string;
    isActive: boolean;
  }>;
  inactiveAccountsHoldingRole: Array<{
    accountId: string;
    code: string;
    name: string;
    postingRole: string;
  }>;
  unlinkedSubledgerRows: {
    /** False when the server omits the field (an older chart-health payload). */
    available?: boolean;
    count: number;
    amount: number;
    rows: Array<{
      id: string;
      journalId: string;
      accountId: string;
      accountCode: string;
      accountName: string;
      subledgerType: string;
      partyId: string | null;
      partyName: string | null;
      branchId: string;
      entryDateAD: string;
      debit: number;
      credit: number;
    }>;
  };
  totals: {
    accounts: number;
    controlAccounts: number;
    subledgers: number;
    activeSubledgers: number;
    unlinkedSubledgerRows: number;
  };
}

export async function getAccountingSubledgers(
  includeInactive = true,
  branchId?: string
): Promise<AccountingSubledger[]> {
  const params = new URLSearchParams({ includeInactive: includeInactive ? '1' : '0' });
  if (branchId && branchId !== 'ALL') params.set('branchId', branchId);
  return fetchJson(`/api/accounting/subledgers?${params.toString()}`);
}

export async function createAccountingSubledger(
  input: AccountingSubledgerInput
): Promise<AccountingSubledger> {
  return fetchJson('/api/accounting/subledgers', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateAccountingSubledger(
  id: string,
  input: AccountingSubledgerPatch
): Promise<AccountingSubledger> {
  return fetchJson(`/api/accounting/subledgers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteAccountingSubledger(
  id: string
): Promise<{ deleted: boolean; id: string }> {
  return fetchJson(`/api/accounting/subledgers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function generateAccountingSubledgers(mainAccountId: string): Promise<{
  created: number;
  skipped: number;
  linkedEntries: number;
  total: number;
  accountCode: string;
  subledgerType: string;
}> {
  return fetchJson('/api/accounting/subledgers/generate', {
    method: 'POST',
    body: JSON.stringify({ mainAccountId }),
  });
}

export interface PartyLedgerBalanceRow {
  partyId: string;
  /** Debit-positive posted subledger movement. */
  debit: number;
  credit: number;
  balance: number;
}

export interface PartyControlAccount {
  id: string;
  code: string;
  name: string;
  postingRole: string;
  subledgerType: string;
  groupCode: string | null;
  groupName: string | null;
  parentGroupCode: string | null;
  parentGroupName: string | null;
}

export interface PartyBalancesResponse {
  type: 'CUSTOMER' | 'SUPPLIER';
  controlAccount: PartyControlAccount | null;
  balances: PartyLedgerBalanceRow[];
  message?: string;
}

/** Posted Dr/Cr balances for one directory page, plus the control it posts to. */
export async function getPartyBalances(params: {
  type: 'CUSTOMER' | 'SUPPLIER';
  partyIds: string[];
  branchId?: string;
}): Promise<PartyBalancesResponse> {
  const query = new URLSearchParams({ type: params.type });
  if (params.partyIds.length) query.set('partyIds', params.partyIds.join(','));
  if (params.branchId && params.branchId !== 'ALL') query.set('branchId', params.branchId);
  return fetchJson(`/api/accounting/party-balances?${query.toString()}`);
}

export async function getChartHealth(): Promise<ChartHealth> {
  return fetchJson<ChartHealth>('/api/accounting/chart-health');
}

export async function seedChartDefaults(): Promise<{
  added: { groups: number; accounts: number; subledgers: number };
  message: string;
}> {
  return fetchJson('/api/accounting/chart-defaults', { method: 'POST' });
}

export interface AccountingSubledgerLedgerEntry {
  id: string;
  journalId: string;
  journalNo: string;
  journalLineId: string;
  accountId: string;
  subledgerType: string;
  partyId: string | null;
  partyName: string | null;
  branchId: string;
  entryDateAD: string;
  debit: number;
  credit: number;
  memo: string;
}

export interface AccountingSubledgerPartyBalance {
  partyId: string | null;
  partyName: string;
  balance: number;
}

export interface AccountingSubledgerLedger {
  book: {
    id: string;
    code: string;
    name: string;
    subledgerType: string;
    mainAccountId: string;
    partyId: string | null;
    accountCode: string;
    accountName: string;
  };
  from: string | null;
  to: string | null;
  branchId: string | null;
  entries: AccountingSubledgerLedgerEntry[];
  parties: AccountingSubledgerPartyBalance[];
  totals: { debit: number; credit: number; balance: number };
  unlinkedCount: number;
}

export async function getAccountingSubledgerEntries(
  id: string,
  options: { from?: string; to?: string; branchId?: string } = {}
): Promise<AccountingSubledgerLedger> {
  const params = new URLSearchParams();
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  if (options.branchId) params.set('branchId', options.branchId);
  const query = params.toString();
  return fetchJson(
    `/api/accounting/subledgers/${encodeURIComponent(id)}/entries${query ? `?${query}` : ''}`
  );
}

/** One employee option for an EMPLOYEE control-account line. */
export interface AccountingEmployee {
  id: string;
  employeeCode: string;
  name: string;
  branchId: string;
  defaultCostCenterId: string | null;
  department: string | null;
  designation: string | null;
  isActive: boolean;
}

export async function getAccountingEmployees(
  branchId?: string,
  query?: string,
  limit?: number
): Promise<AccountingEmployee[]> {
  const params = new URLSearchParams();
  if (branchId && branchId !== 'ALL') params.set('branchId', branchId);
  if (query?.trim()) params.set('query', query.trim());
  if (limit) params.set('limit', String(limit));
  return fetchJson(`/api/employees/search?${params.toString()}`);
}

/** One posted employee-subledger line across every employee control account. */
export interface EmployeeLedgerEntry {
  id: string;
  journalId: string;
  journalNo: string;
  journalDateAD: string;
  entryDateAD: string;
  entryDateBS: string | null;
  sourceType: string;
  voucherType: string | null;
  referenceNo: string | null;
  reversalOfId: string | null;
  memo: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  branchId: string;
  debit: number;
  credit: number;
}

/** One employee control account, split into opening, period and closing. */
export interface EmployeeLedgerAccount {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  postingRole: string | null;
  openingDebit: number;
  openingCredit: number;
  openingBalance: number;
  presentedOpeningBalance: number;
  debit: number;
  credit: number;
  balance: number;
  presentedBalance: number;
  closingBalance: number;
  presentedClosingBalance: number;
}

export interface EmployeeLedgerResponse {
  employee: AccountingEmployee;
  branchId: string;
  from: string | null;
  to: string | null;
  currency: string;
  accounts: EmployeeLedgerAccount[];
  entries: EmployeeLedgerEntry[];
  unlinkedCount: number;
  totals: {
    debit: number;
    credit: number;
    openingDebit: number;
    openingCredit: number;
    openingBalance: number;
    closingBalance: number;
  };
}

/** GET /api/employees/:id/ledger — the posted employee subledger, `gl-view` only. */
export async function getEmployeeLedger(
  employeeId: string,
  options: { from?: string; to?: string; branchId?: string } = {}
): Promise<EmployeeLedgerResponse> {
  const params = new URLSearchParams();
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  if (options.branchId) params.set('branchId', options.branchId);
  const query = params.toString();
  return fetchJson(
    `/api/employees/${encodeURIComponent(employeeId)}/ledger${query ? `?${query}` : ''}`
  );
}

/** A line as posted through the manual journal endpoint. Amounts are NPR. */
export interface AccountingJournalLineInput {
  accountId: string;
  debit?: number;
  credit?: number;
  memo?: string | null;
  subledgerType?: string;
  partyId?: string | null;
  partyName?: string | null;
}

export interface AccountingJournalInput {
  journalDateAD: string;
  branchId: string;
  memo?: string | null;
  sourceType?: string;
  voucherType?: string;
  /** Register class for a manual cash/bank voucher (CR/BR/CP/BP/CT/JV). */
  documentType?: string | null;
  voucherClass?: string | null;
  referenceNo?: string | null;
  referenceDateAD?: string | null;
  chequeNo?: string | null;
  chequeDateAD?: string | null;
  currency?: string;
  exchangeRate?: number;
  lines: AccountingJournalLineInput[];
}

export interface AccountingJournalLine extends AccountingJournalLineInput {
  id: string;
  journalId: string;
  lineNo: number;
  accountCode: string;
  accountName: string;
  isControl: boolean;
  branchId: string;
  costCenterId: string | null;
  costCenterCode: string | null;
  costCenterName: string | null;
  debit: number;
  credit: number;
}

/** The subledger row posted alongside a control-account journal line. */
export interface AccountingJournalSubledgerEntry {
  id: string;
  journalId: string;
  journalLineId: string;
  accountId: string;
  subledgerId: string | null;
  subledgerType: string;
  partyId: string | null;
  partyName: string | null;
  branchId: string;
  entryDateAD: string;
  entryDateBS: string;
  debit: number;
  credit: number;
}

export interface AccountingJournal {
  id: string;
  journalNo: string;
  journalDateAD: string;
  journalDateBS: string;
  fiscalYearId: string;
  fiscalYearCode: string;
  periodId: string;
  periodKey: string;
  branchId: string;
  branchName: string | null;
  sourceType: string;
  sourceId: string | null;
  voucherType: string;
  voucherClass: string | null;
  referenceNo: string | null;
  referenceDateAD: string | null;
  referenceDateBS: string | null;
  chequeNo: string | null;
  chequeDateAD: string | null;
  chequeDateBS: string | null;
  currency: string;
  exchangeRate: number;
  memo: string | null;
  status: string;
  reversalOfId: string | null;
  /** Id of the contra that reversed this voucher, when one is posted. */
  reversalJournalId: string | null;
  /** The contra that reversed this voucher, when one is posted. */
  reversalJournalNo: string | null;
  /** When this voucher is itself a reversal, the original it reversed. */
  reversalOfNo: string | null;
  postedAt: string;
  postedBy: string | null;
  isDemo: boolean;
  totalDebit: number;
  totalCredit: number;
  lines: AccountingJournalLine[];
  subledgerEntries: AccountingJournalSubledgerEntry[];
}

export interface AccountingJournalListQuery {
  branchId?: string;
  from?: string;
  to?: string;
  status?: string;
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface AccountingJournalListResponse {
  data: AccountingJournal[];
  page: number;
  pageSize: number;
  totalItems: number;
}

export async function postAccountingJournal(
  input: AccountingJournalInput
): Promise<AccountingJournal> {
  return fetchJson('/api/accounting/journals', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Post one branch's opening trial balance. The server picks the earliest open
 * period, refuses a second post for the branch, and requires balanced lines.
 */
export interface OpeningBalanceInput {
  branchId: string;
  lines: AccountingJournalLineInput[];
  /** The Opening Balances register that owns this per-branch journal. */
  register?: 'GL' | 'CUSTOMER';
}

export async function postOpeningBalances(input: OpeningBalanceInput): Promise<AccountingJournal> {
  return fetchJson('/api/accounting/opening-balances', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface AccountingJournalReversalInput {
  journalDateAD: string;
  reason: string;
}

/**
 * Post the contra voucher that reverses a posted manual/cash voucher. The
 * original remains posted and auditable; the server refuses an operational
 * source, a second reversal and a closed period.
 */
export async function reverseAccountingJournal(
  id: string,
  input: AccountingJournalReversalInput
): Promise<AccountingJournal> {
  return fetchJson(`/api/accounting/journals/${encodeURIComponent(id)}/reverse`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getAccountingJournal(id: string): Promise<AccountingJournal> {
  return fetchJson(`/api/accounting/journals/${encodeURIComponent(id)}`);
}

export async function getAccountingJournals(
  query: AccountingJournalListQuery = {}
): Promise<AccountingJournalListResponse> {
  const params = new URLSearchParams();
  if (query.branchId && query.branchId !== 'ALL') params.set('branchId', query.branchId);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.status) params.set('status', query.status);
  if (query.query) params.set('query', query.query);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  const suffix = params.toString();
  return fetchJson(`/api/accounting/journals${suffix ? `?${suffix}` : ''}`);
}
