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
export type AccountKind = 'CASH' | 'BANK' | 'OTHER';

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
  description: string | null;
  /** Legacy GL-master metadata (short name, category, terms, currency). */
  masterProfile?: Record<string, unknown>;
  isControl: boolean;
  subledgerType: string;
  postingRole: string | null;
  /** Classifies every till and bank ledger, including extras without a role. */
  accountKind?: AccountKind;
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
  accountKind: 'CASH' | 'BANK';
  postingRole: 'CASH' | 'BANK' | null;
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
  accountKind?: 'CASH' | 'BANK';
  postingRole: string | null;
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
  entries: CashBookEntry[];
}

export interface CashBookResponse {
  book: 'CASH_BANK';
  branchId: string | null;
  from: string | null;
  to: string;
  accounts: CashBookAccount[];
  opening: number;
  receipts: number;
  payments: number;
  closing: number;
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
  /** Refused once the account has posted lines, so history keeps its mapping. */
  groupId?: string;
  postingRole?: string | null;
  accountKind?: AccountKind;
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

export async function getTrialBalance(query: StatementQuery = {}): Promise<TrialBalanceResponse> {
  return fetchJson(`/api/accounting/statements/trial-balance${statementQuery(query)}`);
}

export async function getProfitAndLoss(query: StatementQuery = {}): Promise<ProfitAndLossResponse> {
  return fetchJson(`/api/accounting/statements/profit-and-loss${statementQuery(query)}`);
}

export async function getBalanceSheet(query: StatementQuery = {}): Promise<BalanceSheetResponse> {
  return fetchJson(`/api/accounting/statements/balance-sheet${statementQuery({ branchId: query.branchId, to: query.to })}`);
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
  branchId: string | null;
  branches: CashCloseBranch[];
  totals: CashPositionTotals;
}

export interface CashCloseBranchResponse {
  dateAD: string;
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
  totals: { accounts: number; controlAccounts: number; subledgers: number; activeSubledgers: number };
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

export async function getChartHealth(): Promise<ChartHealth> {
  return fetchJson('/api/accounting/chart-health');
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
  department: string | null;
  designation: string | null;
  isActive: boolean;
}

export async function getAccountingEmployees(
  branchId?: string
): Promise<AccountingEmployee[]> {
  const params = new URLSearchParams({ activeOnly: '1' });
  if (branchId && branchId !== 'ALL') params.set('branchId', branchId);
  return fetchJson(`/api/employees?${params.toString()}`);
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
  debit: number;
  credit: number;
}

export interface AccountingJournal {
  id: string;
  journalNo: string;
  journalDateAD: string;
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
  chequeNo: string | null;
  chequeDateAD: string | null;
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
