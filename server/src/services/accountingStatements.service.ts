/**
 * Financial statements read side — trial balance, profit and loss, and balance
 * sheet, computed from the POSTED journal lines rather than from operational
 * documents.
 *
 * Why this layer exists: the ledger was write-only until now. Every figure
 * here comes from `gl_journal_lines` joined to a POSTED `gl_journals` header,
 * so a statement cannot quietly disagree with the journal that produced it.
 * The existing management view is untouched; these endpoints are a second,
 * statutory read that can be reconciled to it.
 *
 * Sign convention: repository rows expose a debit-positive signed balance
 * (`debit - credit`). Presentation turns that into the account type's natural
 * side (assets/expenses positive when debited, liabilities/equity/income
 * positive when credited). A contra account therefore shows as a negative
 * amount inside its section instead of pretending to be the opposite type.
 *
 * The balance sheet closes with `currentEarnings` (income − expenses through
 * the as-of date) because this build has no year-end closing entry yet. With
 * one fiscal year in scope that is exact; once a closing process exists it
 * must replace this line, not be added beside it.
 *
 * Range semantics:
 *   - trial balance: opening before `from`, turnover inside `from`..`to`,
 *     closing through `to`;
 *   - profit and loss: turnover inside `from`..`to` only;
 *   - balance sheet: cumulative through `to` (no `from`), because a balance
 *     is a point-in-time figure.
 * `from` defaults to the start of the fiscal year containing `to` for the two
 * flow statements, so a caller that only names an as-of date still gets a
 * meaningful period rather than an empty one.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import {
  ACCOUNT_BALANCE_ROWS_SQL,
  ACCOUNT_BY_ID_SQL,
  BS_LEDGER_SUMMARY_SQL,
  LEDGER_RANGE_TOTALS_SQL,
  ACCOUNT_GROUP_LIST_SQL,
  CASH_BANK_ACCOUNT_ROWS_SQL,
  CASH_FLOW_JOURNAL_ROWS_SQL,
  CONTROL_AGREEMENT_ROWS_SQL,
  FISCAL_YEAR_BOUNDS_SQL,
  STATEMENT_GROUP_LINES_SQL,
  STATEMENT_GROUPS,
  STATEMENT_BRANCHES_SQL,
  FISCAL_YEAR_BALANCE_ACCOUNT_ROWS_SQL,
  TRIAL_BALANCE_ACCOUNT_LINES_SQL,
  TRIAL_BALANCE_GROUP_LINES_SQL,
  type AccountType,
  type StatementGroup,
} from '../models/accounting.repo';
import {
  PERIOD_ALIGNED_WINDOW_SQL,
  PERIOD_BALANCE_ACCOUNT_ROWS_SQL,
} from '../models/readModels.repo';
import { isAccountingDate, type AccountingClient } from './accounting.service';

export type StatementMode =
  | 'TRIAL_BALANCE'
  | 'PROFIT_AND_LOSS'
  | 'BALANCE_SHEET'
  | 'BALANCE_SHEET_MOVEMENT'
  | 'CASH_FLOW';

export interface StatementWindow {
  /** Opening window starts here; `null` means "from inception". */
  from: string | null;
  to: string;
  /** `null` rolls every branch up to company level. */
  branchId: string | null;
  /** A session with no branch assignment reads an empty, honest statement. */
  empty: boolean;
  /**
   * Set when the window is exactly one closed fiscal year: the statement then
   * reads the immutable `fiscal_year_balances` snapshot instead of scanning
   * `gl_journal_lines`. It carries the same figures the ledger window would
   * return (see FISCAL_YEAR_BALANCE_ACCOUNT_ROWS_SQL), so it is a read-path
   * switch, not a different definition.
   */
  snapshotFiscalYearId?: string | null;
  /**
   * Set when the window is exactly a run of whole monthly periods, so the
   * statement can read `gl_period_balances` instead of scanning
   * `gl_journal_lines`. The model is period-granular: a window with a
   * mid-period edge has no rows that describe it, so it stays on the ledger.
   * Like the snapshot above, this is a read-path switch — the figures are the
   * ledger's, per `PERIOD_BALANCE_ACCOUNT_ROWS_SQL`.
   */
  periodBalances?: boolean;
}

export interface StatementScope {
  branchId: string | null;
  empty: boolean;
}

export interface AccountBalanceRow {
  accountId: string;
  code: string;
  name: string;
  isActive: boolean;
  subledgerType: string;
  postingRole: string | null;
  accountKind: 'CASH' | 'BANK' | 'WALLET' | 'OTHER';
  groupId: string;
  parentGroupId: string | null;
  groupCode: string;
  groupName: string;
  accountType: AccountType;
  statementGroup: StatementGroup;
  groupSortOrder: number;
  openingBalance: number;
  periodDebit: number;
  periodCredit: number;
}

export interface TrialBalanceAccount {
  accountId: string;
  code: string;
  name: string;
  groupCode: string;
  groupName: string;
  accountType: AccountType;
  statementGroup: StatementGroup;
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

/**
 * One node of the trial balance's group tree: a top-level group carries its
 * direct accounts and its sub-groups, and every node carries a subtotal over
 * its direct accounts plus its sub-groups.
 */
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
  statementGroup: StatementGroup;
  label: string;
  amount: number;
  groups: StatementGroupBlock[];
}

/** Opening, in-period and closing figures for one movement-view line. */
export interface BalanceSheetMovementAmount {
  opening: number;
  period: number;
  closing: number;
  /** Closing − opening; this is the same movement as `period` after tie-out. */
  change: number;
  /** Null when opening is zero, because there is no meaningful base. */
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
  statementGroup: StatementGroup;
  label: string;
  groups: BalanceSheetMovementGroup[];
}

export interface BalanceSheetMovementResponse {
  statement: 'BALANCE_SHEET_MOVEMENT';
  branchId: string | null;
  /** First day of the movement window; opening is the balance before it. */
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
  /** Positive is a cash receipt; negative is a cash payment. */
  amount: number;
  /** Number of posted journals that make up this line. */
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

export type BranchStatementMatrixRowKind = 'SECTION' | 'GROUP' | 'ACCOUNT' | 'SUMMARY';

/** One branch column on the consolidated statement. */
export interface BranchStatementMatrixBranch {
  branchId: string;
  code: string;
  name: string;
}

/**
 * One line of the branch matrix. `amounts` is keyed by branch id; a branch
 * with no activity for this line is absent from the map (the client displays
 * zero). `total` is the sum of every branch column.
 */
export interface BranchStatementMatrixRow {
  key: string;
  kind: BranchStatementMatrixRowKind;
  statementGroup: StatementGroup | null;
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
  branches: BranchStatementMatrixBranch[];
  rows: BranchStatementMatrixRow[];
}

export type BranchBalanceSheetView = 'CLOSING' | 'MOVEMENT';

export interface BranchBalanceSheetMatrixResponse {
  statement: 'BRANCH_BALANCE_SHEET';
  branchId: string | null;
  from: string | null;
  asOf: string;
  view: BranchBalanceSheetView;
  branches: BranchStatementMatrixBranch[];
  rows: BranchStatementMatrixRow[];
}

export type StatementGroupDrilldownMode = Extract<
  StatementMode,
  'PROFIT_AND_LOSS' | 'BALANCE_SHEET'
>;

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
  statementGroup: StatementGroup;
  /** The group's direct accounts plus every sub-group beneath it. */
  amount: number;
}

export interface StatementGroupLinesResponse {
  statement: StatementGroupDrilldownMode;
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
  statementGroup: StatementGroup;
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  closingDebit: number;
  closingCredit: number;
}

/**
 * Totals over every matching line, independent of the per-window page.
 * Opening and closing are net per account, exactly like the trial balance
 * columns; period debit and credit are posted turnover.
 */
export interface TrialBalanceLineTotals {
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  closingDebit: number;
  closingCredit: number;
  openingEntryCount: number;
  periodEntryCount: number;
  entryCount: number;
}

export interface TrialBalanceGroupLinesResponse {
  statement: 'TRIAL_BALANCE';
  branchId: string | null;
  from: string | null;
  to: string;
  group: TrialBalanceGroupSummary;
  entries: TrialBalanceGroupLine[];
  totals: TrialBalanceLineTotals;
  truncated: boolean;
  limit: number;
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
  totals: TrialBalanceLineTotals;
  truncated: boolean;
  limit: number;
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

const GROUP_LABELS: Record<StatementGroup, string> = {
  CURRENT_ASSET: 'Current assets',
  NON_CURRENT_ASSET: 'Non-current assets',
  CURRENT_LIABILITY: 'Current liabilities',
  NON_CURRENT_LIABILITY: 'Non-current liabilities',
  EQUITY: 'Equity',
  REVENUE: 'Revenue',
  COST_OF_SALES: 'Cost of sales',
  OPERATING_EXPENSE: 'Operating expenses',
  OTHER_INCOME: 'Other income',
  OTHER_EXPENSE: 'Other expenses',
};

const PROFIT_AND_LOSS_ORDER: readonly StatementGroup[] = [
  'REVENUE',
  'OTHER_INCOME',
  'COST_OF_SALES',
  'OPERATING_EXPENSE',
  'OTHER_EXPENSE',
];

/** Which chart side each drill-down statement may open. */
const DRILLDOWN_ACCOUNT_TYPES: Record<StatementGroupDrilldownMode, readonly AccountType[]> = {
  PROFIT_AND_LOSS: ['INCOME', 'EXPENSE'],
  BALANCE_SHEET: ['ASSET', 'LIABILITY', 'EQUITY'],
};

const DRILLDOWN_DEFAULT_LIMIT = 500;
const DRILLDOWN_MAX_LIMIT = 2000;

function emptyTrialBalanceTotals(): TrialBalanceLineTotals {
  return {
    openingDebit: 0,
    openingCredit: 0,
    periodDebit: 0,
    periodCredit: 0,
    closingDebit: 0,
    closingCredit: 0,
    openingEntryCount: 0,
    periodEntryCount: 0,
    entryCount: 0,
  };
}

function todayAD(): string {
  return new Date().toISOString().split('T')[0];
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

function requireDate(value: unknown, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isAccountingDate(raw)) {
    throw new ApiError(400, `${field} must be a real date in YYYY-MM-DD form.`);
  }
  return raw;
}

/**
 * Resolve the date window and branch for one statement request. The caller has
 * already resolved branch scope from the session; this only translates query
 * input and supplies the fiscal-year default for `from`.
 */
export async function resolveStatementWindow(
  client: AccountingClient,
  query: Record<string, unknown> | null | undefined,
  mode: StatementMode,
  scope: StatementScope
): Promise<StatementWindow> {
  const asOf = typeof query?.asOf === 'string' ? query.asOf.trim() : '';
  const rawTo = typeof query?.to === 'string' ? query.to.trim() : '';
  if (asOf && rawTo && asOf !== rawTo) {
    throw new ApiError(400, 'Use either asOf or to, not both.');
  }
  const to = requireDate(asOf || rawTo || todayAD(), 'Statement date');
  const rawFrom = typeof query?.from === 'string' ? query.from.trim() : '';

  if (mode === 'BALANCE_SHEET') {
    if (rawFrom) {
      throw new ApiError(400, 'A balance sheet is as of a date; use asOf or to, not from.');
    }
    return { from: null, to, branchId: scope.branchId, empty: Boolean(scope.empty) };
  }

  if (rawFrom) {
    const from = requireDate(rawFrom, 'Statement start date');
    if (from > to) throw new ApiError(400, 'The statement start date must not be after the end date.');
    return {
      from,
      to,
      branchId: scope.branchId,
      empty: Boolean(scope.empty),
      snapshotFiscalYearId: await closedYearSnapshotFor(client, from, to),
      periodBalances: await isPeriodAlignedWindow(client, from, to),
    };
  }

  const fiscalYear = (await client.query(FISCAL_YEAR_BOUNDS_SQL, [to])).rows[0];
  if (!fiscalYear) {
    throw new ApiError(
      400,
      `No fiscal year contains ${to}. Create the fiscal year first, or pass an explicit from date.`
    );
  }
  const from = String(fiscalYear.startDateAD).slice(0, 10);
  return {
    from,
    to,
    branchId: scope.branchId,
    empty: Boolean(scope.empty),
    snapshotFiscalYearId: await closedYearSnapshotFor(client, from, to),
    periodBalances: await isPeriodAlignedWindow(client, from, to),
  };
}

/**
 * Whether `from`..`to` is a run of whole monthly periods, which is the only
 * shape `gl_period_balances` can answer without the ledger (see
 * PERIOD_ALIGNED_WINDOW_SQL). A window that starts or ends inside a period is
 * still a valid statement; it just reads the lines.
 */
async function isPeriodAlignedWindow(
  client: AccountingClient,
  from: string,
  to: string
): Promise<boolean> {
  const row = (await client.query(PERIOD_ALIGNED_WINDOW_SQL, [from, to])).rows[0];
  return row?.aligned === true;
}

/**
 * The fiscal-year id whose immutable snapshot can serve this exact window, or
 * null. A snapshot covers one whole year (its opening is "before the year", its
 * turnover is "inside the year"), so a partial window must stay on the ledger;
 * only a closed year with a snapshot is eligible.
 */
async function closedYearSnapshotFor(
  client: AccountingClient,
  from: string,
  to: string
): Promise<string | null> {
  const fiscalYear = (await client.query(FISCAL_YEAR_BOUNDS_SQL, [to])).rows[0];
  if (!fiscalYear || fiscalYear.isClosed !== true) return null;
  if (String(fiscalYear.endDateAD).slice(0, 10) !== to) return null;
  if (String(fiscalYear.startDateAD).slice(0, 10) !== from) return null;
  return String(fiscalYear.id);
}

/** Signed balance: positive means the account is net-debited. */
export function closingSigned(row: AccountBalanceRow): number {
  return roundMoney(row.openingBalance + row.periodDebit - row.periodCredit);
}

export function periodSigned(row: AccountBalanceRow): number {
  return roundMoney(row.periodDebit - row.periodCredit);
}

/** Natural-side amount: assets and expenses are debit-positive, the rest credit-positive. */
export function presented(accountType: AccountType, signed: number): number {
  return roundMoney(accountType === 'ASSET' || accountType === 'EXPENSE' ? signed : -signed);
}

async function loadAccountBalances(
  client: AccountingClient,
  window: StatementWindow
): Promise<AccountBalanceRow[]> {
  if (window.empty) return [];
  const rows = (
    window.snapshotFiscalYearId
      ? await client.query(FISCAL_YEAR_BALANCE_ACCOUNT_ROWS_SQL, [
          window.snapshotFiscalYearId,
          window.branchId,
        ])
      : window.periodBalances === true
        ? await client.query(PERIOD_BALANCE_ACCOUNT_ROWS_SQL, [
            window.from,
            window.to,
            window.branchId,
          ])
        : await client.query(ACCOUNT_BALANCE_ROWS_SQL, [window.from, window.to, window.branchId])
  ).rows;
  return rows.map((row: any) => ({
    accountId: String(row.accountId),
    code: String(row.code),
    name: String(row.name),
    isActive: row.isActive === true,
    subledgerType: String(row.subledgerType || 'NONE'),
    postingRole: row.postingRole ? String(row.postingRole) : null,
    accountKind:
      row.accountKind === 'CASH' || row.accountKind === 'BANK' || row.accountKind === 'WALLET'
        ? row.accountKind
        : 'OTHER',
    groupId: String(row.groupId),
    parentGroupId: row.parentGroupId ? String(row.parentGroupId) : null,
    groupCode: String(row.groupCode),
    groupName: String(row.groupName),
    accountType: row.accountType as AccountType,
    statementGroup: row.statementGroup as StatementGroup,
    groupSortOrder: Number(row.groupSortOrder) || 0,
    openingBalance: money(row.openingBalance),
    periodDebit: money(row.periodDebit),
    periodCredit: money(row.periodCredit),
  }));
}

/**
 * Build the group → sub-group → account tree for one statement group. Every
 * node's amount is its direct accounts plus its children, so a group subtotal
 * and the section total are sums over the same leaves. Empty branches are
 * pruned; a parent kept only because a child has amounts still shows the
 * child's subtotal, never a zero of its own.
 */
function buildStatementGroupTree(
  groupRows: readonly any[],
  rows: readonly AccountBalanceRow[],
  statementGroup: StatementGroup,
  amountOf: (row: AccountBalanceRow) => number
): StatementGroupBlock[] {
  const candidates = groupRows.filter(
    (group) => String(group.statementGroup) === statementGroup
  );
  if (candidates.length === 0) return [];

  const nodes = new Map<string, StatementGroupBlock>();
  for (const group of candidates) {
    const id = String(group.id);
    nodes.set(id, {
      groupId: id,
      parentGroupId: group.parentId ? String(group.parentId) : null,
      groupCode: String(group.code),
      groupName: String(group.name),
      sortOrder: Number(group.sortOrder) || 0,
      amount: 0,
      accounts: [],
      children: [],
    });
  }

  const roots: StatementGroupBlock[] = [];
  for (const group of candidates) {
    const node = nodes.get(String(group.id))!;
    const parent = node.parentGroupId ? nodes.get(node.parentGroupId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  for (const row of rows) {
    const node = nodes.get(row.groupId);
    if (!node) continue;
    node.accounts.push({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      groupCode: row.groupCode,
      groupName: row.groupName,
      amount: amountOf(row),
    });
  }

  const byName = (left: StatementGroupBlock, right: StatementGroupBlock) =>
    left.sortOrder - right.sortOrder || left.groupCode.localeCompare(right.groupCode);

  const finalize = (node: StatementGroupBlock): boolean => {
    node.children = node.children.filter(finalize).sort(byName);
    node.accounts.sort((left, right) => left.code.localeCompare(right.code));
    node.amount = roundMoney(
      node.accounts.reduce((sum, account) => sum + account.amount, 0) +
        node.children.reduce((sum, child) => sum + child.amount, 0)
    );
    return node.accounts.length > 0 || node.children.length > 0;
  };

  return roots.filter(finalize).sort(byName);
}

function sectionize(
  groupRows: readonly any[],
  rows: readonly AccountBalanceRow[],
  order: readonly StatementGroup[],
  amountOf: (row: AccountBalanceRow) => number
): StatementSection[] {
  const sections: StatementSection[] = [];
  for (const statementGroup of order) {
    const inSection = rows.filter((row) => row.statementGroup === statementGroup);
    if (inSection.length === 0) continue;
    const groups = buildStatementGroupTree(groupRows, inSection, statementGroup, amountOf);
    if (groups.length === 0) continue;
    sections.push({
      statementGroup,
      label: GROUP_LABELS[statementGroup],
      amount: roundMoney(groups.reduce((sum, group) => sum + group.amount, 0)),
      groups,
    });
  }
  return sections;
}

async function loadGroupRows(client: AccountingClient, window: StatementWindow): Promise<any[]> {
  if (window.empty) return [];
  return (await client.query(ACCOUNT_GROUP_LIST_SQL)).rows;
}

async function loadControls(
  client: AccountingClient,
  window: StatementWindow
): Promise<ControlAgreement[]> {
  if (window.empty) return [];
  const rows = (await client.query(CONTROL_AGREEMENT_ROWS_SQL, [window.to, window.branchId])).rows;
  return rows.map((row: any) => {
    const glBalance = money(row.glBalance);
    const subledgerBalance = money(row.subledgerBalance);
    const difference = roundMoney(glBalance - subledgerBalance);
    return {
      accountId: String(row.accountId),
      code: String(row.code),
      name: String(row.name),
      subledgerType: String(row.subledgerType || 'NONE'),
      glBalance,
      subledgerBalance,
      difference,
      status: Math.abs(difference) < 0.005 ? 'RECONCILED' : 'DIFFERENCE',
    };
  });
}

export function statementBranchLabel(window: StatementWindow): string | null {
  if (window.branchId) return window.branchId;
  return window.empty ? null : 'ALL';
}

/**
 * Build the group → sub-group → ledger tree for the trial balance. Every node's
 * subtotal is the sum of its direct accounts plus its children, so a parent
 * group and the company total can never disagree with the account rows.
 */
function buildTrialBalanceGroups(
  groupRows: readonly any[],
  rows: readonly AccountBalanceRow[],
  accounts: readonly TrialBalanceAccount[]
): TrialBalanceGroup[] {
  const nodes = new Map<string, TrialBalanceGroup>();
  for (const group of groupRows) {
    const id = String(group.id);
    nodes.set(id, {
      groupId: id,
      code: String(group.code),
      name: String(group.name),
      parentGroupId: group.parentId ? String(group.parentId) : null,
      sortOrder: Number(group.sortOrder) || 0,
      openingDebit: 0,
      openingCredit: 0,
      periodDebit: 0,
      periodCredit: 0,
      closingDebit: 0,
      closingCredit: 0,
      accounts: [],
      children: [],
    });
  }

  const roots: TrialBalanceGroup[] = [];
  for (const group of groupRows) {
    const node = nodes.get(String(group.id))!;
    const parent = node.parentGroupId ? nodes.get(node.parentGroupId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  rows.forEach((row, index) => {
    nodes.get(row.groupId)?.accounts.push(accounts[index]);
  });

  const byName = (left: TrialBalanceGroup, right: TrialBalanceGroup) =>
    left.sortOrder - right.sortOrder || left.code.localeCompare(right.code);

  const finalize = (node: TrialBalanceGroup): boolean => {
    node.children = node.children.filter(finalize).sort(byName);
    node.accounts.sort((left, right) => left.code.localeCompare(right.code));
    const sum = (pick: (account: TrialBalanceAccount) => number) =>
      roundMoney(node.accounts.reduce((total, account) => total + pick(account), 0));
    let openingDebit = sum((account) => account.openingDebit);
    let openingCredit = sum((account) => account.openingCredit);
    let periodDebit = sum((account) => account.periodDebit);
    let periodCredit = sum((account) => account.periodCredit);
    let closingDebit = sum((account) => account.closingDebit);
    let closingCredit = sum((account) => account.closingCredit);
    for (const child of node.children) {
      openingDebit = roundMoney(openingDebit + child.openingDebit);
      openingCredit = roundMoney(openingCredit + child.openingCredit);
      periodDebit = roundMoney(periodDebit + child.periodDebit);
      periodCredit = roundMoney(periodCredit + child.periodCredit);
      closingDebit = roundMoney(closingDebit + child.closingDebit);
      closingCredit = roundMoney(closingCredit + child.closingCredit);
    }
    node.openingDebit = openingDebit;
    node.openingCredit = openingCredit;
    node.periodDebit = periodDebit;
    node.periodCredit = periodCredit;
    node.closingDebit = closingDebit;
    node.closingCredit = closingCredit;
    return node.accounts.length > 0 || node.children.length > 0;
  };

  return roots.filter(finalize).sort(byName);
}

/**
 * Trial balance: opening, turnover and closing by account, with debit and
 * credit columns and a control-account agreement block. `groups` carries the
 * same accounts nested under their group and sub-group, each with a subtotal.
 */
export async function buildTrialBalance(client: AccountingClient, window: StatementWindow) {
  const rows = (await loadAccountBalances(client, window)).filter(
    (row) => row.openingBalance !== 0 || row.periodDebit !== 0 || row.periodCredit !== 0
  );

  const accounts: TrialBalanceAccount[] = rows.map((row) => {
    const closing = closingSigned(row);
    return {
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      groupCode: row.groupCode,
      groupName: row.groupName,
      accountType: row.accountType,
      statementGroup: row.statementGroup,
      subledgerType: row.subledgerType,
      openingBalance: row.openingBalance,
      openingDebit: roundMoney(Math.max(row.openingBalance, 0)),
      openingCredit: roundMoney(Math.max(-row.openingBalance, 0)),
      periodDebit: row.periodDebit,
      periodCredit: row.periodCredit,
      closingBalance: closing,
      closingDebit: roundMoney(Math.max(closing, 0)),
      closingCredit: roundMoney(Math.max(-closing, 0)),
    };
  });

  const sum = (pick: (account: (typeof accounts)[number]) => number) =>
    roundMoney(accounts.reduce((total, account) => total + pick(account), 0));
  const totals = {
    openingDebit: sum((account) => account.openingDebit),
    openingCredit: sum((account) => account.openingCredit),
    periodDebit: sum((account) => account.periodDebit),
    periodCredit: sum((account) => account.periodCredit),
    closingDebit: sum((account) => account.closingDebit),
    closingCredit: sum((account) => account.closingCredit),
  };
  const balanced =
    Math.abs(totals.openingDebit - totals.openingCredit) < 0.005 &&
    Math.abs(totals.periodDebit - totals.periodCredit) < 0.005 &&
    Math.abs(totals.closingDebit - totals.closingCredit) < 0.005;

  const controls = await loadControls(client, window);
  const groupRows = await loadGroupRows(client, window);

  return {
    statement: 'TRIAL_BALANCE' as const,
    branchId: statementBranchLabel(window),
    from: window.from,
    to: window.to,
    groups: buildTrialBalanceGroups(groupRows, rows, accounts),
    sections: sectionize(groupRows, rows, STATEMENT_GROUPS, (row) =>
      presented(row.accountType, closingSigned(row))
    ),
    accounts,
    totals,
    balanced,
    controls,
    controlsReconciled: controls.every((control) => control.status === 'RECONCILED'),
  };
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

/**
 * BS-native ledger report. The AD window selects the rows; `bs_day_records`
 * supplies the Nepali year/month/quarter for every line, so this report is
 * complete without any client-side calendar conversion. A missing day record
 * cannot create a guessed month: the write gate already refuses that date.
 */
export async function buildBsLedgerSummary(client: AccountingClient, window: StatementWindow) {
  const rows = window.empty
    ? []
    : (await client.query(BS_LEDGER_SUMMARY_SQL, [window.from, window.to, window.branchId])).rows;
  const adTotalsRow = window.empty
    ? { debit: 0, credit: 0, balance: 0 }
    : (await client.query(LEDGER_RANGE_TOTALS_SQL, [window.from, window.to, window.branchId])).rows[0];

  const months: BsLedgerMonth[] = rows.map((row: any) => ({
    fiscalYear: String(row.fiscalYear),
    bsYear: Number(row.bsYear),
    bsMonth: Number(row.bsMonth),
    bsMonthName: String(row.bsMonthName),
    bsMonthNameNp: String(row.bsMonthNameNp),
    quarter: String(row.quarter),
    startAD: String(row.startAD),
    endAD: String(row.endAD),
    startBS: String(row.startBS),
    endBS: String(row.endBS),
    debit: roundMoney(Number(row.debit)),
    credit: roundMoney(Number(row.credit)),
    balance: roundMoney(Number(row.balance)),
  }));

  const quarterMap = new Map<string, BsLedgerQuarter>();
  for (const month of months) {
    const key = `${month.bsYear}|${month.quarter}`;
    const quarter = quarterMap.get(key) ?? {
      fiscalYear: month.fiscalYear,
      bsYear: month.bsYear,
      quarter: month.quarter,
      debit: 0,
      credit: 0,
      balance: 0,
    };
    quarter.debit = roundMoney(quarter.debit + month.debit);
    quarter.credit = roundMoney(quarter.credit + month.credit);
    quarter.balance = roundMoney(quarter.balance + month.balance);
    quarterMap.set(key, quarter);
  }

  const totals = months.reduce(
    (sum, month) => ({
      debit: roundMoney(sum.debit + month.debit),
      credit: roundMoney(sum.credit + month.credit),
      balance: roundMoney(sum.balance + month.balance),
    }),
    { debit: 0, credit: 0, balance: 0 }
  );
  const adTotals = {
    debit: roundMoney(Number(adTotalsRow?.debit ?? 0)),
    credit: roundMoney(Number(adTotalsRow?.credit ?? 0)),
    balance: roundMoney(Number(adTotalsRow?.balance ?? 0)),
  };
  const difference = roundMoney(
    Math.abs(totals.debit - adTotals.debit) +
      Math.abs(totals.credit - adTotals.credit) +
      Math.abs(totals.balance - adTotals.balance)
  );

  return {
    statement: 'BS_LEDGER_SUMMARY' as const,
    branchId: statementBranchLabel(window),
    from: window.from,
    to: window.to,
    months,
    quarters: [...quarterMap.values()].sort(
      (a, b) => a.bsYear - b.bsYear || a.quarter.localeCompare(b.quarter)
    ),
    totals,
    adTotals,
    difference,
    reconciled: difference < 0.005,
  };
}

/**
 * Profit and loss for `from`..`to`: turnover only, grouped by statement group
 * and account group. Contingent on the range — never on an opening balance.
 */
export async function buildProfitAndLoss(client: AccountingClient, window: StatementWindow) {
  const rows = (await loadAccountBalances(client, window)).filter(
    (row) =>
      (row.accountType === 'INCOME' || row.accountType === 'EXPENSE') &&
      (row.periodDebit !== 0 || row.periodCredit !== 0)
  );
  const groupRows = await loadGroupRows(client, window);
  const sections = sectionize(groupRows, rows, PROFIT_AND_LOSS_ORDER, (row) =>
    presented(row.accountType, periodSigned(row))
  );
  const amountOf = (statementGroup: StatementGroup) =>
    sections.find((section) => section.statementGroup === statementGroup)?.amount ?? 0;

  const revenue = amountOf('REVENUE');
  const otherIncome = amountOf('OTHER_INCOME');
  const costOfSales = amountOf('COST_OF_SALES');
  const operatingExpense = amountOf('OPERATING_EXPENSE');
  const otherExpense = amountOf('OTHER_EXPENSE');
  const totalIncome = roundMoney(revenue + otherIncome);
  const totalExpenses = roundMoney(costOfSales + operatingExpense + otherExpense);

  return {
    statement: 'PROFIT_AND_LOSS' as const,
    branchId: statementBranchLabel(window),
    from: window.from,
    to: window.to,
    sections,
    revenue,
    otherIncome,
    totalIncome,
    costOfSales,
    operatingExpense,
    otherExpense,
    totalExpenses,
    // Gross profit is trading revenue less cost of sales; other income is
    // non-operating and belongs only in net profit.
    grossProfit: roundMoney(revenue - costOfSales),
    netProfit: roundMoney(totalIncome - totalExpenses),
  };
}

/** Active branches available as columns, narrowed by the session's branch scope. */
export async function loadStatementBranches(
  client: AccountingClient,
  allowed?: Set<string>
): Promise<BranchStatementMatrixBranch[]> {
  const rows = (await client.query(STATEMENT_BRANCHES_SQL)).rows;
  return rows
    .map((row: any) => ({
      branchId: String(row.id),
      code: String(row.code),
      name: String(row.name),
    }))
    .filter((branch) => !allowed || allowed.has(branch.branchId));
}

/**
 * Branch-consolidated P&L/Trading matrix. Each column is built by the same
 * `buildProfitAndLoss` read as the single-branch statement, so a branch column
 * can never diverge from that branch's own P&L. The chart is shared, but the
 * merge is keyed by statement group, group code and account code so a
 * branch-specific chart row still gets its own line instead of being dropped.
 */
export async function buildBranchProfitAndLossMatrix(
  client: AccountingClient,
  window: StatementWindow,
  branches: readonly BranchStatementMatrixBranch[]
): Promise<BranchProfitAndLossMatrixResponse> {
  const rows: BranchStatementMatrixRow[] = [];
  const byKey = new Map<string, BranchStatementMatrixRow>();

  const add = (
    branchId: string,
    base: Omit<BranchStatementMatrixRow, 'amounts' | 'total'>,
    amount: number
  ) => {
    let row = byKey.get(base.key);
    if (!row) {
      row = { ...base, amounts: {}, total: 0 };
      byKey.set(base.key, row);
      rows.push(row);
    }
    row.amounts[branchId] = roundMoney(amount);
    row.total = roundMoney(row.total + amount);
  };

  for (const branch of branches) {
    const pnl = await buildProfitAndLoss(client, {
      ...window,
      branchId: branch.branchId,
      empty: false,
    });

    const addGroups = (
      groups: readonly any[],
      depth: number,
      statementGroup: StatementGroup
    ) => {
      for (const group of groups) {
        add(
          branch.branchId,
          {
            key: `group:${statementGroup}:${group.groupCode}`,
            kind: 'GROUP',
            statementGroup,
            code: group.groupCode,
            label: group.groupName,
            level: depth,
          },
          group.amount
        );
        for (const account of group.accounts) {
          add(
            branch.branchId,
            {
              key: `account:${statementGroup}:${group.groupCode}:${account.code}`,
              kind: 'ACCOUNT',
              statementGroup,
              code: account.code,
              label: account.name,
              level: depth + 1,
            },
            account.amount
          );
        }
        addGroups(group.children, depth + 1, statementGroup);
      }
    };

    for (const section of pnl.sections) {
      add(
        branch.branchId,
        {
          key: `section:${section.statementGroup}`,
          kind: 'SECTION',
          statementGroup: section.statementGroup,
          code: null,
          label: section.label,
          level: 0,
        },
        section.amount
      );
      addGroups(section.groups, 1, section.statementGroup);
    }

    const summaries: Array<[string, string, number]> = [
      ['TOTAL_INCOME', 'Total income', pnl.totalIncome],
      ['GROSS_PROFIT', 'Gross profit', pnl.grossProfit],
      ['TOTAL_EXPENSES', 'Total expenses', pnl.totalExpenses],
      ['NET_PROFIT', 'Net profit', pnl.netProfit],
    ];
    for (const [key, label, amount] of summaries) {
      add(
        branch.branchId,
        {
          key: `summary:${key}`,
          kind: 'SUMMARY',
          statementGroup: null,
          code: null,
          label,
          level: 0,
        },
        amount
      );
    }
  }

  return {
    statement: 'BRANCH_PROFIT_AND_LOSS',
    branchId: statementBranchLabel(window),
    from: window.from,
    to: window.to,
    branches: [...branches],
    rows,
  };
}

/**
 * Branch-consolidated balance sheet. Closing columns come from the statutory
 * per-branch balance sheet; Movement columns use the same per-branch movement
 * read and present the posted period change. The Total column is always the
 * sum of the branch columns for the selected presentation.
 */
export async function buildBranchBalanceSheetMatrix(
  client: AccountingClient,
  window: StatementWindow,
  branches: readonly BranchStatementMatrixBranch[],
  view: BranchBalanceSheetView
): Promise<BranchBalanceSheetMatrixResponse> {
  const rows: BranchStatementMatrixRow[] = [];
  const byKey = new Map<string, BranchStatementMatrixRow>();

  const add = (
    branchId: string,
    base: Omit<BranchStatementMatrixRow, 'amounts' | 'total'>,
    amount: number
  ) => {
    let row = byKey.get(base.key);
    if (!row) {
      row = { ...base, amounts: {}, total: 0 };
      byKey.set(base.key, row);
      rows.push(row);
    }
    row.amounts[branchId] = roundMoney(amount);
    row.total = roundMoney(row.total + amount);
  };

  const valueOf = (item: any): number =>
    typeof item === 'number'
      ? roundMoney(item)
      : roundMoney(Number(view === 'MOVEMENT' ? item?.period : item?.amount) || 0);

  for (const branch of branches) {
    const statement: any =
      view === 'MOVEMENT'
        ? await buildBalanceSheetMovement(client, {
            ...window,
            branchId: branch.branchId,
          })
        : await buildBalanceSheet(client, {
            ...window,
            branchId: branch.branchId,
            from: null,
          });

    const addGroups = (
      groups: readonly any[],
      depth: number,
      prefix: string,
      statementGroup: StatementGroup
    ) => {
      for (const group of groups) {
        add(
          branch.branchId,
          {
            key: `${prefix}:group:${statementGroup}:${group.groupCode}`,
            kind: 'GROUP',
            statementGroup,
            code: group.groupCode,
            label: group.groupName,
            level: depth,
          },
          valueOf(group)
        );
        for (const account of group.accounts) {
          add(
            branch.branchId,
            {
              key: `${prefix}:account:${statementGroup}:${group.groupCode}:${account.code}`,
              kind: 'ACCOUNT',
              statementGroup,
              code: account.code,
              label: account.name,
              level: depth + 1,
            },
            valueOf(account)
          );
        }
        addGroups(group.children, depth + 1, prefix, statementGroup);
      }
    };

    const addSections = (sections: readonly any[], prefix: string) => {
      for (const section of sections) {
        add(
          branch.branchId,
          {
            key: `${prefix}:section:${section.statementGroup}`,
            kind: 'SECTION',
            statementGroup: section.statementGroup,
            code: null,
            label: section.label,
            level: 0,
          },
          valueOf(section)
        );
        addGroups(section.groups, 1, prefix, section.statementGroup as StatementGroup);
      }
    };

    addSections(statement.assets.sections, 'asset');
    add(
      branch.branchId,
      {
        key: 'total:assets',
        kind: 'SUMMARY',
        statementGroup: null,
        code: null,
        label: 'Total assets',
        level: 0,
      },
      valueOf(statement.assets.total)
    );

    addSections(statement.liabilities.sections, 'liability');
    add(
      branch.branchId,
      {
        key: 'total:liabilities',
        kind: 'SUMMARY',
        statementGroup: null,
        code: null,
        label: 'Total liabilities',
        level: 0,
      },
      valueOf(statement.liabilities.total)
    );

    addSections(statement.equity.sections, 'equity');
    add(
      branch.branchId,
      {
        key: 'equity:current-earnings',
        kind: 'SUMMARY',
        statementGroup: 'EQUITY',
        code: null,
        label: 'Current earnings',
        level: 1,
      },
      valueOf(statement.equity.currentEarnings)
    );
    add(
      branch.branchId,
      {
        key: 'total:equity',
        kind: 'SUMMARY',
        statementGroup: 'EQUITY',
        code: null,
        label: 'Total equity',
        level: 0,
      },
      valueOf(statement.equity.total)
    );
    add(
      branch.branchId,
      {
        key: 'total:liabilities-and-equity',
        kind: 'SUMMARY',
        statementGroup: null,
        code: null,
        label: 'Total liabilities & equity',
        level: 0,
      },
      valueOf(statement.totalLiabilitiesAndEquity)
    );
    add(
      branch.branchId,
      {
        key: 'check:difference',
        kind: 'SUMMARY',
        statementGroup: null,
        code: null,
        label: 'Difference (assets − liabilities − equity)',
        level: 0,
      },
      valueOf(statement.difference)
    );
  }

  return {
    statement: 'BRANCH_BALANCE_SHEET',
    branchId: statementBranchLabel(window),
    from: view === 'MOVEMENT' ? window.from : null,
    asOf: window.to,
    view,
    branches: [...branches],
    rows,
  };
}

/**
 * Balance sheet as of `to`. `currentEarnings` keeps the accounting equation
 * closed while there is no year-end transfer; `interBranch` names the two
 * head-office custody sides even though they are already inside assets and
 * liabilities (it is a breakdown, never an addition).
 */
export async function buildBalanceSheet(client: AccountingClient, window: StatementWindow) {
  const rows = (await loadAccountBalances(client, window)).filter(
    (row) => closingSigned(row) !== 0
  );
  const amountOf = (row: AccountBalanceRow) => presented(row.accountType, closingSigned(row));
  const groupRows = await loadGroupRows(client, window);

  const assetSections = sectionize(
    groupRows,
    rows.filter((row) => row.accountType === 'ASSET'),
    STATEMENT_GROUPS,
    amountOf
  );
  const liabilitySections = sectionize(
    groupRows,
    rows.filter((row) => row.accountType === 'LIABILITY'),
    STATEMENT_GROUPS,
    amountOf
  );
  const equitySections = sectionize(
    groupRows,
    rows.filter((row) => row.accountType === 'EQUITY'),
    STATEMENT_GROUPS,
    amountOf
  );

  const incomeTotal = roundMoney(
    rows
      .filter((row) => row.accountType === 'INCOME')
      .reduce((total, row) => total + amountOf(row), 0)
  );
  const expenseTotal = roundMoney(
    rows
      .filter((row) => row.accountType === 'EXPENSE')
      .reduce((total, row) => total + amountOf(row), 0)
  );
  const currentEarnings = roundMoney(incomeTotal - expenseTotal);

  const sectionTotal = (sections: StatementSection[]) =>
    roundMoney(sections.reduce((total, section) => total + section.amount, 0));
  const totalAssets = sectionTotal(assetSections);
  // Cash/bank is a breakdown of current assets, not an addition to it: the
  // cash book endpoint's closing total must equal this figure for the same
  // branch and date, so it is computed from the same posted rows and roles.
  const cashAndBank = roundMoney(
    rows
      .filter((row) => row.accountKind === 'CASH' || row.accountKind === 'BANK' || row.accountKind === 'WALLET')
      .reduce((total, row) => total + amountOf(row), 0)
  );
  const totalLiabilities = sectionTotal(liabilitySections);
  const postedEquity = sectionTotal(equitySections);
  const totalEquity = roundMoney(postedEquity + currentEarnings);
  const totalLiabilitiesAndEquity = roundMoney(totalLiabilities + totalEquity);
  const difference = roundMoney(totalAssets - totalLiabilitiesAndEquity);

  const interBranchRows = rows.filter((row) => row.subledgerType === 'INTER_BRANCH');
  const dueFromHeadOffice = roundMoney(
    interBranchRows
      .filter((row) => row.accountType === 'ASSET')
      .reduce((total, row) => total + amountOf(row), 0)
  );
  const dueToHeadOffice = roundMoney(
    interBranchRows
      .filter((row) => row.accountType === 'LIABILITY')
      .reduce((total, row) => total + amountOf(row), 0)
  );

  return {
    statement: 'BALANCE_SHEET' as const,
    branchId: statementBranchLabel(window),
    from: null,
    asOf: window.to,
    assets: { sections: assetSections, total: totalAssets },
    liabilities: { sections: liabilitySections, total: totalLiabilities },
    equity: {
      sections: equitySections,
      postedTotal: postedEquity,
      currentEarnings,
      total: totalEquity,
    },
    totalAssets,
    cashAndBank,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity,
    difference,
    balanced: Math.abs(difference) < 0.005,
    interBranch: { dueFromHeadOffice, dueToHeadOffice },
  };
}

/**
 * One movement triple. The `period` figure is the posted turnover inside the
 * window; `change` is computed from the two balances instead of trusting a
 * separately accumulated number, so the columns always reconcile by
 * construction. A zero opening balance has no meaningful percentage base.
 */
function movementAmount(
  openingValue: number,
  periodValue: number,
  closingValue: number
): BalanceSheetMovementAmount {
  const opening = roundMoney(openingValue);
  const period = roundMoney(periodValue);
  const closing = roundMoney(closingValue);
  const change = roundMoney(closing - opening);
  return {
    opening,
    period,
    closing,
    change,
    changePercent: opening === 0 ? null : (change / Math.abs(opening)) * 100,
  };
}

function sumMovement(amounts: readonly BalanceSheetMovementAmount[]): BalanceSheetMovementAmount {
  let opening = 0;
  let period = 0;
  let closing = 0;
  for (const amount of amounts) {
    opening += amount.opening;
    period += amount.period;
    closing += amount.closing;
  }
  return movementAmount(opening, period, closing);
}

function addMovement(
  left: BalanceSheetMovementAmount,
  right: BalanceSheetMovementAmount
): BalanceSheetMovementAmount {
  return movementAmount(
    left.opening + right.opening,
    left.period + right.period,
    left.closing + right.closing
  );
}

function subtractMovement(
  left: BalanceSheetMovementAmount,
  right: BalanceSheetMovementAmount
): BalanceSheetMovementAmount {
  return movementAmount(
    left.opening - right.opening,
    left.period - right.period,
    left.closing - right.closing
  );
}

function movementAccount(row: AccountBalanceRow): BalanceSheetMovementAccount {
  return {
    accountId: row.accountId,
    code: row.code,
    name: row.name,
    groupCode: row.groupCode,
    groupName: row.groupName,
    accountType: row.accountType,
    ...movementAmount(
      presented(row.accountType, row.openingBalance),
      presented(row.accountType, periodSigned(row)),
      presented(row.accountType, closingSigned(row))
    ),
  };
}

function hasMovement(row: AccountBalanceRow): boolean {
  return (
    presented(row.accountType, row.openingBalance) !== 0 ||
    presented(row.accountType, periodSigned(row)) !== 0 ||
    presented(row.accountType, closingSigned(row)) !== 0
  );
}

/**
 * Movement-view group tree. It mirrors the closing balance sheet's hierarchy,
 * but a group is retained when it had an opening balance or a movement even if
 * its closing balance is zero — otherwise a fully reversed account would
 * disappear from the reconciliation.
 */
function buildBalanceSheetMovementTree(
  groupRows: readonly any[],
  rows: readonly AccountBalanceRow[],
  statementGroup: StatementGroup
): BalanceSheetMovementGroup[] {
  const candidates = groupRows.filter((group) => String(group.statementGroup) === statementGroup);
  if (candidates.length === 0) return [];

  const nodes = new Map<string, BalanceSheetMovementGroup>();
  for (const group of candidates) {
    const id = String(group.id);
    nodes.set(id, {
      groupId: id,
      parentGroupId: group.parentId ? String(group.parentId) : null,
      groupCode: String(group.code),
      groupName: String(group.name),
      sortOrder: Number(group.sortOrder) || 0,
      ...movementAmount(0, 0, 0),
      accounts: [],
      children: [],
    });
  }

  const roots: BalanceSheetMovementGroup[] = [];
  for (const group of candidates) {
    const node = nodes.get(String(group.id))!;
    const parent = node.parentGroupId ? nodes.get(node.parentGroupId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  for (const row of rows) {
    nodes.get(row.groupId)?.accounts.push(movementAccount(row));
  }

  const byName = (left: BalanceSheetMovementGroup, right: BalanceSheetMovementGroup) =>
    left.sortOrder - right.sortOrder || left.groupCode.localeCompare(right.groupCode);

  const finalize = (node: BalanceSheetMovementGroup): boolean => {
    node.children = node.children.filter(finalize).sort(byName);
    node.accounts.sort((left, right) => left.code.localeCompare(right.code));
    const total = sumMovement([...node.accounts, ...node.children]);
    Object.assign(node, total);
    return node.accounts.length > 0 || node.children.length > 0;
  };

  return roots.filter(finalize).sort(byName);
}

function sectionizeMovement(
  groupRows: readonly any[],
  rows: readonly AccountBalanceRow[],
  order: readonly StatementGroup[]
): BalanceSheetMovementSection[] {
  const sections: BalanceSheetMovementSection[] = [];
  for (const statementGroup of order) {
    const inSection = rows.filter((row) => row.statementGroup === statementGroup);
    if (inSection.length === 0) continue;
    const groups = buildBalanceSheetMovementTree(groupRows, inSection, statementGroup);
    if (groups.length === 0) continue;
    sections.push({
      statementGroup,
      label: GROUP_LABELS[statementGroup],
      ...sumMovement(groups),
      groups,
    });
  }
  return sections;
}

/**
 * Balance-sheet movement view: opening before `from`, turnover inside
 * `from`..`asOf`, and the closing balance. Current earnings is split the same
 * way as every other equity line (opening earnings + period profit = closing
 * earnings), so profit is counted exactly once in the closing column.
 */
export async function buildBalanceSheetMovement(
  client: AccountingClient,
  window: StatementWindow
): Promise<BalanceSheetMovementResponse> {
  if (!window.from) {
    throw new ApiError(400, 'A balance-sheet movement view needs a period start date.');
  }
  const allRows = await loadAccountBalances(client, window);
  const balanceRows = allRows.filter(
    (row) =>
      (row.accountType === 'ASSET' || row.accountType === 'LIABILITY' || row.accountType === 'EQUITY') &&
      hasMovement(row)
  );
  const groupRows = await loadGroupRows(client, window);

  const assetSections = sectionizeMovement(
    groupRows,
    balanceRows.filter((row) => row.accountType === 'ASSET'),
    STATEMENT_GROUPS
  );
  const liabilitySections = sectionizeMovement(
    groupRows,
    balanceRows.filter((row) => row.accountType === 'LIABILITY'),
    STATEMENT_GROUPS
  );
  const equitySections = sectionizeMovement(
    groupRows,
    balanceRows.filter((row) => row.accountType === 'EQUITY'),
    STATEMENT_GROUPS
  );

  // Current earnings is a movement line too: opening earnings is cumulative
  // income and expense before the window, and the period figure is this
  // window's profit. Adding closing earnings here instead would double-count.
  let openingEarnings = 0;
  let periodEarnings = 0;
  let closingEarnings = 0;
  for (const row of allRows) {
    if (row.accountType !== 'INCOME' && row.accountType !== 'EXPENSE') continue;
    const sign = row.accountType === 'INCOME' ? 1 : -1;
    openingEarnings += sign * presented(row.accountType, row.openingBalance);
    periodEarnings += sign * presented(row.accountType, periodSigned(row));
    closingEarnings += sign * presented(row.accountType, closingSigned(row));
  }
  const currentEarnings = movementAmount(openingEarnings, periodEarnings, closingEarnings);

  const totalAssets = sumMovement(assetSections);
  const totalLiabilities = sumMovement(liabilitySections);
  const postedEquity = sumMovement(equitySections);
  const totalEquity = addMovement(postedEquity, currentEarnings);
  const totalLiabilitiesAndEquity = addMovement(totalLiabilities, totalEquity);
  const difference = subtractMovement(totalAssets, totalLiabilitiesAndEquity);

  const cashAndBank = sumMovement(
    balanceRows
      .filter((row) => row.accountKind === 'CASH' || row.accountKind === 'BANK' || row.accountKind === 'WALLET')
      .map(movementAccount)
  );
  const interBranchRows = balanceRows.filter((row) => row.subledgerType === 'INTER_BRANCH');
  const dueFromHeadOffice = sumMovement(
    interBranchRows.filter((row) => row.accountType === 'ASSET').map(movementAccount)
  );
  const dueToHeadOffice = sumMovement(
    interBranchRows.filter((row) => row.accountType === 'LIABILITY').map(movementAccount)
  );

  return {
    statement: 'BALANCE_SHEET_MOVEMENT',
    branchId: statementBranchLabel(window),
    from: window.from,
    asOf: window.to,
    assets: { sections: assetSections, total: totalAssets },
    liabilities: { sections: liabilitySections, total: totalLiabilities },
    equity: {
      sections: equitySections,
      postedTotal: postedEquity,
      currentEarnings,
      total: totalEquity,
    },
    totalAssets,
    cashAndBank,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity,
    difference,
    balanced:
      Math.abs(difference.opening) < 0.005 &&
      Math.abs(difference.period) < 0.005 &&
      Math.abs(difference.closing) < 0.005,
    interBranch: { dueFromHeadOffice, dueToHeadOffice },
  };
}

const CASH_FLOW_SECTION_KEYS: CashFlowSectionKey[] = ['OPERATING', 'INVESTING', 'FINANCING'];
const CASH_FLOW_SECTION_LABELS: Record<CashFlowSectionKey, string> = {
  OPERATING: 'Operating activities',
  INVESTING: 'Investing activities',
  FINANCING: 'Financing activities',
};

function cashFlowSectionOf(row: any): CashFlowSectionKey {
  const accountType = String(row.accountType);
  const statementGroup = String(row.statementGroup);
  // A non-current asset movement is investing. Equity and long-term debt are
  // financing. Everything else — revenue, expense and working capital — is
  // operating. The chart's existing type/mapping is the authority; no parallel
  // cash-flow taxonomy can drift from it.
  if (statementGroup === 'NON_CURRENT_ASSET') return 'INVESTING';
  if (accountType === 'EQUITY' || statementGroup === 'NON_CURRENT_LIABILITY') {
    return 'FINANCING';
  }
  return 'OPERATING';
}

function emptyCashFlow(window: StatementWindow): CashFlowResponse {
  return {
    statement: 'CASH_FLOW',
    method: 'DIRECT',
    branchId: statementBranchLabel(window),
    from: window.from,
    to: window.to,
    openingCash: 0,
    closingCash: 0,
    cashBookClosing: 0,
    netCashFlow: 0,
    classifiedCashFlow: 0,
    difference: 0,
    reconciled: true,
    sections: CASH_FLOW_SECTION_KEYS.map((key) => ({
      key,
      label: CASH_FLOW_SECTION_LABELS[key],
      amount: 0,
      lines: [],
    })),
  };
}

/**
 * Direct cash-flow statement. Each posted journal contributes its net cash/bank
 * movement once, classified from its largest non-cash counterpart account.
 * That keeps a transfer between two cash accounts out of receipts/payments and
 * prevents a compound journal from being counted twice. Opening cash comes from
 * the same cash/bank account rows as the cash book, so the closing figure can
 * be tied back to it instead of being asserted by construction.
 */
export async function buildCashFlow(
  client: AccountingClient,
  window: StatementWindow
): Promise<CashFlowResponse> {
  if (window.empty) return emptyCashFlow(window);

  const [accountRows, journalRows] = await Promise.all([
    client.query(CASH_BANK_ACCOUNT_ROWS_SQL, [
      window.from,
      window.to,
      window.branchId,
      ['CASH', 'BANK', 'WALLET'],
      false,
      null,
    ]),
    client.query(CASH_FLOW_JOURNAL_ROWS_SQL, [window.from, window.to, window.branchId]),
  ]);

  let openingCash = 0;
  let cashBookClosing = 0;
  for (const row of accountRows.rows) {
    const opening = money(row.opening);
    openingCash = roundMoney(openingCash + opening);
    cashBookClosing = roundMoney(
      cashBookClosing + opening + money(row.receipts) - money(row.payments)
    );
  }

  type JournalBucket = {
    cashNet: number;
    counterparts: any[];
  };
  const byJournal = new Map<string, JournalBucket>();
  for (const row of journalRows.rows) {
    const journalId = String(row.journalId);
    const bucket = byJournal.get(journalId) ?? { cashNet: 0, counterparts: [] };
    const debit = money(row.debit);
    const credit = money(row.credit);
    if (row.accountKind === 'CASH' || row.accountKind === 'BANK' || row.accountKind === 'WALLET') {
      bucket.cashNet = roundMoney(bucket.cashNet + debit - credit);
    } else {
      bucket.counterparts.push(row);
    }
    byJournal.set(journalId, bucket);
  }

  const lines = new Map<string, CashFlowLine>();
  let netCashFlow = 0;
  for (const bucket of byJournal.values()) {
    if (Math.abs(bucket.cashNet) < 0.005) continue;
    const primary = bucket.counterparts
      .map((row) => ({ row, weight: Math.abs(money(row.debit) - money(row.credit)) }))
      .filter((candidate) => candidate.weight > 0)
      .sort(
        (left, right) =>
          right.weight - left.weight ||
          String(left.row.accountCode).localeCompare(String(right.row.accountCode))
      )[0]?.row;
    const section = primary ? cashFlowSectionOf(primary) : 'OPERATING';
    const key = primary ? String(primary.accountId) : 'UNCLASSIFIED';
    const existing = lines.get(key);
    if (existing) {
      existing.amount = roundMoney(existing.amount + bucket.cashNet);
      existing.journalCount += 1;
    } else {
      lines.set(key, {
        accountId: key,
        accountCode: primary ? String(primary.accountCode) : '—',
        accountName: primary ? String(primary.accountName) : 'Unclassified cash movement',
        groupCode: primary ? String(primary.groupCode) : '—',
        groupName: primary ? String(primary.groupName) : 'Unclassified',
        amount: roundMoney(bucket.cashNet),
        journalCount: 1,
      });
    }
    netCashFlow = roundMoney(netCashFlow + bucket.cashNet);
  }

  const sections = CASH_FLOW_SECTION_KEYS.map((key) => {
    const sectionLines = [...lines.values()]
      .filter((line) => {
        if (line.accountId === 'UNCLASSIFIED') return key === 'OPERATING';
        const source = journalRows.rows.find((row: any) => String(row.accountId) === line.accountId);
        return source ? cashFlowSectionOf(source) === key : key === 'OPERATING';
      })
      .sort((left, right) => left.accountCode.localeCompare(right.accountCode));
    return {
      key,
      label: CASH_FLOW_SECTION_LABELS[key],
      amount: roundMoney(sectionLines.reduce((total, line) => total + line.amount, 0)),
      lines: sectionLines,
    };
  });

  const classifiedCashFlow = roundMoney(
    sections.reduce((total, section) => total + section.amount, 0)
  );
  const closingCash = roundMoney(openingCash + netCashFlow);
  const difference = roundMoney(classifiedCashFlow - netCashFlow);
  const closingDifference = roundMoney(closingCash - cashBookClosing);

  return {
    statement: 'CASH_FLOW',
    method: 'DIRECT',
    branchId: statementBranchLabel(window),
    from: window.from,
    to: window.to,
    openingCash,
    closingCash,
    cashBookClosing,
    netCashFlow,
    classifiedCashFlow,
    difference,
    reconciled: Math.abs(difference) < 0.005 && Math.abs(closingDifference) < 0.005,
    sections,
  };
}

/**
 * The posted lines behind one profit-and-loss or balance-sheet group subtotal.
 *
 * The group tree is resolved from the chart (a group plus every sub-group),
 * then filtered by the SAME window and branch scope the statement used. The
 * totals are aggregated over every matching line before the page is cut, so
 * `group.amount` here must equal the group's `amount` on the statement. The
 * monthly flow statements use `from`..`to`; a balance sheet uses everything
 * through `to`, exactly like `buildBalanceSheet`.
 *
 * A group from the other statement side is refused rather than returning a
 * plausible-looking number from a section the caller cannot see.
 */
export async function buildStatementGroupLines(
  client: AccountingClient,
  window: StatementWindow,
  groupId: string,
  statement: StatementGroupDrilldownMode,
  limit = DRILLDOWN_DEFAULT_LIMIT
): Promise<StatementGroupLinesResponse> {
  const groupRows = (await client.query(ACCOUNT_GROUP_LIST_SQL)).rows;
  const group = groupRows.find((row: any) => String(row.id) === groupId);
  if (!group) throw new ApiError(404, 'Account group not found.');

  const accountType = String(group.accountType) as AccountType;
  if (!DRILLDOWN_ACCOUNT_TYPES[statement].includes(accountType)) {
    throw new ApiError(
      400,
      statement === 'PROFIT_AND_LOSS'
        ? 'That account group is not part of the profit and loss statement.'
        : 'That account group is not part of the balance sheet.'
    );
  }

  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(DRILLDOWN_MAX_LIMIT, Math.trunc(limit)))
    : DRILLDOWN_DEFAULT_LIMIT;
  const summary: StatementGroupSummary = {
    groupId: String(group.id),
    parentGroupId: group.parentId ? String(group.parentId) : null,
    groupCode: String(group.code),
    groupName: String(group.name),
    sortOrder: Number(group.sortOrder) || 0,
    accountType,
    statementGroup: String(group.statementGroup) as StatementGroup,
    amount: 0,
  };

  if (window.empty) {
    return {
      statement,
      branchId: statementBranchLabel(window),
      from: window.from,
      to: window.to,
      group: summary,
      entries: [],
      totals: { debit: 0, credit: 0, amount: 0, entryCount: 0 },
      truncated: false,
      limit: safeLimit,
    };
  }

  const rows = (
    await client.query(STATEMENT_GROUP_LINES_SQL, [
      groupId,
      window.from,
      window.to,
      window.branchId,
      safeLimit,
    ])
  ).rows;

  const first = rows[0];
  const entryCount = first ? Number(first.entryCount) || 0 : 0;
  const totalDebit = first ? money(first.totalDebit) : 0;
  const totalCredit = first ? money(first.totalCredit) : 0;
  const amount = presented(accountType, roundMoney(totalDebit - totalCredit));
  summary.amount = amount;

  const entries: StatementGroupLine[] = rows.map((row: any) => {
    const debit = money(row.debit);
    const credit = money(row.credit);
    return {
      id: String(row.id),
      journalId: String(row.journalId),
      journalNo: String(row.journalNo),
      journalDateAD: String(row.journalDateAD).slice(0, 10),
      sourceType: String(row.sourceType),
      sourceId: row.sourceId ? String(row.sourceId) : null,
      branchId: String(row.branchId),
      accountId: String(row.accountId),
      accountCode: String(row.accountCode),
      accountName: String(row.accountName),
      lineNo: Number(row.lineNo) || 0,
      memo: row.memo ? String(row.memo) : null,
      journalMemo: row.journalMemo ? String(row.journalMemo) : null,
      debit,
      credit,
      amount: presented(accountType, roundMoney(debit - credit)),
    };
  });

  return {
    statement,
    branchId: statementBranchLabel(window),
    from: window.from,
    to: window.to,
    group: summary,
    entries,
    totals: { debit: totalDebit, credit: totalCredit, amount, entryCount },
    truncated: entryCount > entries.length,
    limit: safeLimit,
  };
}

/**
 * The posted lines behind one trial-balance group subtotal.
 *
 * The group subtree is resolved from the chart, then every POSTED line through
 * `to` is split into the opening window (before `from`) and the period window
 * (`from`..`to`). The trial balance's opening and closing columns are net
 * balances per account, so those totals are netted per account before being
 * split into debit and credit; period debit and credit stay as posted
 * turnover. The response therefore carries both the group's statement figures
 * and the independent line totals, and the screen can prove they agree.
 *
 * The page limit applies per window: a group with hundreds of opening lines
 * still returns its first period lines, so neither half disappears from the
 * drill-down.
 */
export async function buildTrialBalanceGroupLines(
  client: AccountingClient,
  window: StatementWindow,
  groupId: string,
  limit = DRILLDOWN_DEFAULT_LIMIT
): Promise<TrialBalanceGroupLinesResponse> {
  const groupRows = (await client.query(ACCOUNT_GROUP_LIST_SQL)).rows;
  const group = groupRows.find((row: any) => String(row.id) === groupId);
  if (!group) throw new ApiError(404, 'Account group not found.');

  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(DRILLDOWN_MAX_LIMIT, Math.trunc(limit)))
    : DRILLDOWN_DEFAULT_LIMIT;
  const summary: TrialBalanceGroupSummary = {
    groupId: String(group.id),
    parentGroupId: group.parentId ? String(group.parentId) : null,
    groupCode: String(group.code),
    groupName: String(group.name),
    sortOrder: Number(group.sortOrder) || 0,
    accountType: String(group.accountType) as AccountType,
    statementGroup: String(group.statementGroup) as StatementGroup,
    openingDebit: 0,
    openingCredit: 0,
    periodDebit: 0,
    periodCredit: 0,
    closingDebit: 0,
    closingCredit: 0,
  };
  const emptyTotals = emptyTrialBalanceTotals();

  if (window.empty) {
    return {
      statement: 'TRIAL_BALANCE',
      branchId: statementBranchLabel(window),
      from: window.from,
      to: window.to,
      group: summary,
      entries: [],
      totals: emptyTotals,
      truncated: false,
      limit: safeLimit,
    };
  }

  const rows = (
    await client.query(TRIAL_BALANCE_GROUP_LINES_SQL, [
      groupId,
      window.from,
      window.to,
      window.branchId,
      safeLimit,
    ])
  ).rows;

  const first = rows[0];
  const totals: TrialBalanceLineTotals = first
    ? {
        openingDebit: money(first.openingDebit),
        openingCredit: money(first.openingCredit),
        periodDebit: money(first.periodDebit),
        periodCredit: money(first.periodCredit),
        closingDebit: money(first.closingDebit),
        closingCredit: money(first.closingCredit),
        openingEntryCount: Number(first.openingCount) || 0,
        periodEntryCount: Number(first.periodCount) || 0,
        entryCount: (Number(first.openingCount) || 0) + (Number(first.periodCount) || 0),
      }
    : emptyTotals;
  summary.openingDebit = totals.openingDebit;
  summary.openingCredit = totals.openingCredit;
  summary.periodDebit = totals.periodDebit;
  summary.periodCredit = totals.periodCredit;
  summary.closingDebit = totals.closingDebit;
  summary.closingCredit = totals.closingCredit;

  const entries: TrialBalanceGroupLine[] = rows.map((row: any) => {
    const lineWindow: TrialBalanceGroupLineWindow =
      String(row.lineWindow) === 'OPENING' ? 'OPENING' : 'PERIOD';
    return {
      id: String(row.id),
      journalId: String(row.journalId),
      journalNo: String(row.journalNo),
      journalDateAD: String(row.journalDateAD).slice(0, 10),
      sourceType: String(row.sourceType),
      sourceId: row.sourceId ? String(row.sourceId) : null,
      branchId: String(row.branchId),
      accountId: String(row.accountId),
      accountCode: String(row.accountCode),
      accountName: String(row.accountName),
      lineNo: Number(row.lineNo) || 0,
      memo: row.memo ? String(row.memo) : null,
      journalMemo: row.journalMemo ? String(row.journalMemo) : null,
      debit: money(row.debit),
      credit: money(row.credit),
      window: lineWindow,
    };
  });
  const openingEntries = entries.filter((entry) => entry.window === 'OPENING');
  const periodEntries = entries.filter((entry) => entry.window === 'PERIOD');

  return {
    statement: 'TRIAL_BALANCE',
    branchId: statementBranchLabel(window),
    from: window.from,
    to: window.to,
    group: summary,
    entries,
    totals,
    truncated:
      totals.openingEntryCount > openingEntries.length ||
      totals.periodEntryCount > periodEntries.length,
    limit: safeLimit,
  };
}

/**
 * The posted lines behind one trial-balance account row, with a running
 * balance.
 *
 * This is the account-level counterpart to `buildTrialBalanceGroupLines` and
 * follows the same conventions: opening lines are before `from`, period lines
 * are inside `from`..`to`, and the six statement figures net opening/closing
 * per account. The running balance is debit-positive and starts at zero for the
 * opening window; the period window starts at the net opening balance. That
 * makes the last opening line equal the opening figure and the last period line
 * equal the closing figure when the section is not truncated.
 *
 * The page limit applies per window, and the running balance is computed before
 * that limit, so the first returned rows keep their true balances even when a
 * later page is not shown.
 */
export async function buildTrialBalanceAccountLines(
  client: AccountingClient,
  window: StatementWindow,
  accountId: string,
  limit = DRILLDOWN_DEFAULT_LIMIT
): Promise<TrialBalanceAccountLinesResponse> {
  const accountRow = (await client.query(ACCOUNT_BY_ID_SQL, [accountId])).rows[0];
  if (!accountRow) throw new ApiError(404, 'Account not found.');

  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(DRILLDOWN_MAX_LIMIT, Math.trunc(limit)))
    : DRILLDOWN_DEFAULT_LIMIT;
  const account: TrialBalanceAccount = {
    accountId: String(accountRow.id),
    code: String(accountRow.code),
    name: String(accountRow.name),
    groupCode: String(accountRow.groupCode),
    groupName: String(accountRow.groupName),
    accountType: String(accountRow.accountType) as AccountType,
    statementGroup: String(accountRow.statementGroup) as StatementGroup,
    subledgerType: String(accountRow.subledgerType || 'NONE'),
    openingBalance: 0,
    openingDebit: 0,
    openingCredit: 0,
    periodDebit: 0,
    periodCredit: 0,
    closingBalance: 0,
    closingDebit: 0,
    closingCredit: 0,
  };

  if (window.empty) {
    return {
      statement: 'TRIAL_BALANCE',
      branchId: statementBranchLabel(window),
      from: window.from,
      to: window.to,
      account,
      entries: [],
      totals: emptyTrialBalanceTotals(),
      truncated: false,
      limit: safeLimit,
    };
  }

  const rows = (
    await client.query(TRIAL_BALANCE_ACCOUNT_LINES_SQL, [
      accountId,
      window.from,
      window.to,
      window.branchId,
      safeLimit,
    ])
  ).rows;

  const first = rows[0];
  const totals: TrialBalanceLineTotals = first
    ? {
        openingDebit: money(first.openingDebit),
        openingCredit: money(first.openingCredit),
        periodDebit: money(first.periodDebit),
        periodCredit: money(first.periodCredit),
        closingDebit: money(first.closingDebit),
        closingCredit: money(first.closingCredit),
        openingEntryCount: Number(first.openingCount) || 0,
        periodEntryCount: Number(first.periodCount) || 0,
        entryCount: (Number(first.openingCount) || 0) + (Number(first.periodCount) || 0),
      }
    : emptyTrialBalanceTotals();
  account.openingDebit = totals.openingDebit;
  account.openingCredit = totals.openingCredit;
  account.openingBalance = roundMoney(totals.openingDebit - totals.openingCredit);
  account.periodDebit = totals.periodDebit;
  account.periodCredit = totals.periodCredit;
  account.closingDebit = totals.closingDebit;
  account.closingCredit = totals.closingCredit;
  account.closingBalance = roundMoney(totals.closingDebit - totals.closingCredit);

  const entries: TrialBalanceAccountLine[] = rows.map((row: any) => {
    const lineWindow: TrialBalanceGroupLineWindow =
      String(row.lineWindow) === 'OPENING' ? 'OPENING' : 'PERIOD';
    return {
      id: String(row.id),
      journalId: String(row.journalId),
      journalNo: String(row.journalNo),
      journalDateAD: String(row.journalDateAD).slice(0, 10),
      sourceType: String(row.sourceType),
      sourceId: row.sourceId ? String(row.sourceId) : null,
      branchId: String(row.branchId),
      accountId: account.accountId,
      accountCode: account.code,
      accountName: account.name,
      lineNo: Number(row.lineNo) || 0,
      memo: row.memo ? String(row.memo) : null,
      journalMemo: row.journalMemo ? String(row.journalMemo) : null,
      debit: money(row.debit),
      credit: money(row.credit),
      window: lineWindow,
      runningBalance: money(row.runningBalance),
    };
  });
  const openingEntries = entries.filter((entry) => entry.window === 'OPENING');
  const periodEntries = entries.filter((entry) => entry.window === 'PERIOD');

  return {
    statement: 'TRIAL_BALANCE',
    branchId: statementBranchLabel(window),
    from: window.from,
    to: window.to,
    account,
    entries,
    totals,
    truncated:
      totals.openingEntryCount > openingEntries.length ||
      totals.periodEntryCount > periodEntries.length,
    limit: safeLimit,
  };
}
