/**
 * Budget service — account-level monthly budgets per fiscal year and branch,
 * plus the budget-vs-actual read.
 *
 * The variance actual is computed from `gl_journal_lines` joined to a POSTED
 * `gl_journals` header, the same source as the statutory statements. It is not
 * copied from an operational register or stored on the budget row.
 *
 * Sign convention (pinned by tests): `variance = budget - actual`. A positive
 * variance is money still available; a negative variance is overspend (or, for
 * an income target, actual above target). `variancePercent = variance / budget
 * * 100` when the budget is greater than zero, otherwise `null`. No percentage
 * is invented when there is nothing to divide by.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import { isAccountingDate, type AccountingClient } from './accounting.service';
import {
  BUDGET_ACCOUNTS_BY_IDS_SQL,
  BUDGET_ACCOUNT_OPTIONS_SQL,
  BUDGET_BRANCH_SQL,
  BUDGET_FISCAL_YEAR_SQL,
  BUDGET_HEADER_BY_SCOPE_LOCK_SQL,
  BUDGET_HEADER_BY_SCOPE_SQL,
  BUDGET_HEADER_INSERT_SQL,
  BUDGET_HEADER_TOUCH_SQL,
  BUDGET_LINES_BY_SCOPE_SQL,
  BUDGET_LINES_DELETE_SQL,
  BUDGET_LINE_INSERT_SQL,
  BUDGET_PERIODS_BY_FISCAL_YEAR_SQL,
  BUDGET_PERIODS_BY_KEYS_SQL,
  BUDGET_SET_LOCK_SQL,
  BUDGET_VERSION_BY_ID_SQL,
  BUDGET_VERSION_INSERT_SQL,
  BUDGET_VERSIONS_BY_BUDGET_SQL,
  BUDGET_BRANCH_UTILISATION_SQL,
  BUDGET_VARIANCE_LINES_SQL,
  BUDGET_VARIANCE_ROWS_SQL,
  type BudgetAccountOption,
  type BudgetBranchRow,
  type BudgetFiscalYearRow,
  type BudgetLineRow,
  type BudgetPeriodOption,
  type BudgetVersionLineRow,
  type BudgetVersionRow,
  type BudgetVersionSource,
  type BudgetVersionSummaryRow,
} from '../models/budget.repo';

const MAX_AMOUNT = 999_999_999_999.99;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

function percentOf(part: number, base: number): number | null {
  if (!(base > 0)) return null;
  return Math.round((part / base) * 10000) / 100;
}

function amount(value: unknown, label: string): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, `${label}: a numeric budget amount is required.`);
  }
  if (parsed < 0) {
    throw new ApiError(400, `${label}: a budget amount cannot be negative.`);
  }
  const rounded = roundMoney(parsed);
  if (rounded > MAX_AMOUNT) {
    throw new ApiError(400, `${label}: the budget amount is too large.`);
  }
  return rounded;
}

function snapshotLines(rows: any[]): BudgetVersionLineRow[] {
  return rows.map((row): BudgetVersionLineRow => ({
    periodKey: String(row.periodKey),
    accountId: String(row.accountId),
    amount: money(row.amount),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    accountType: row.accountType === 'INCOME' ? 'INCOME' : 'EXPENSE',
  }));
}

function parseVersionLines(value: unknown): BudgetVersionLineRow[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((line): line is Record<string, unknown> => Boolean(line) && typeof line === 'object')
    .map((line): BudgetVersionLineRow => ({
      periodKey: String(line.periodKey ?? ''),
      accountId: String(line.accountId ?? ''),
      amount: money(line.amount),
      code: String(line.code ?? ''),
      name: String(line.name ?? ''),
      accountType: line.accountType === 'INCOME' ? 'INCOME' : 'EXPENSE',
    }))
    .filter((line) => line.periodKey && line.accountId);
}

/** Append an immutable snapshot inside the caller's transaction. */
async function appendBudgetVersion(
  client: AccountingClient,
  budgetId: string,
  actor: string | null,
  source: BudgetVersionSource,
  sourceDetail: string | null,
  lines: BudgetVersionLineRow[]
): Promise<BudgetVersionSummaryRow> {
  const id = `glbv-${crypto.randomUUID()}`;
  const row = (await client.query(BUDGET_VERSION_INSERT_SQL, [
    id,
    budgetId,
    actor,
    source,
    sourceDetail,
    JSON.stringify(lines),
  ])).rows[0];
  return {
    id,
    version: Number(row.version) || 0,
    actor,
    createdAt: String(row.createdAt),
    source,
    sourceDetail,
    lineCount: lines.length,
    totalAmount: roundMoney(lines.reduce((sum, line) => sum + line.amount, 0)),
  };
}

async function loadScope(
  client: AccountingClient,
  fiscalYearIdRaw: unknown,
  branchIdRaw: unknown
): Promise<{ fiscalYear: BudgetFiscalYearRow; branch: BudgetBranchRow }> {
  const fiscalYearId = text(fiscalYearIdRaw, 50);
  if (!fiscalYearId) throw new ApiError(400, 'A fiscal year id is required.');
  const fiscalYear = (await client.query(BUDGET_FISCAL_YEAR_SQL, [fiscalYearId]))
    .rows[0] as BudgetFiscalYearRow | undefined;
  if (!fiscalYear) throw new ApiError(404, 'Fiscal year not found.');

  const branchId = text(branchIdRaw, 50);
  if (!branchId) throw new ApiError(400, 'Choose a branch to view or edit its budget.');
  const branch = (await client.query(BUDGET_BRANCH_SQL, [branchId]))
    .rows[0] as BudgetBranchRow | undefined;
  if (!branch) throw new ApiError(400, `Branch ${branchId} does not exist.`);

  return { fiscalYear, branch };
}

export interface BudgetEditorResponse {
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
  lines: BudgetLineRow[];
}

/** Read one fiscal year + branch budget, including the editor's pick lists. */
export async function readBudget(
  client: AccountingClient,
  fiscalYearId: unknown,
  branchId: unknown
): Promise<BudgetEditorResponse> {
  const { fiscalYear, branch } = await loadScope(client, fiscalYearId, branchId);

  const header = (await client.query(BUDGET_HEADER_BY_SCOPE_SQL, [fiscalYear.id, branch.id]))
    .rows[0];
  const [periodRows, accountRows, lineRows] = await Promise.all([
    client.query(BUDGET_PERIODS_BY_FISCAL_YEAR_SQL, [fiscalYear.id]),
    client.query(BUDGET_ACCOUNT_OPTIONS_SQL),
    header
      ? client.query(BUDGET_LINES_BY_SCOPE_SQL, [fiscalYear.id, branch.id])
      : Promise.resolve({ rows: [] as any[] }),
  ]);

  return {
    fiscalYearId: fiscalYear.id,
    fiscalYearCode: fiscalYear.code,
    branchId: branch.id,
    branchName: branch.name,
    budgetId: header ? String(header.id) : null,
    locked: Boolean(header?.lockedAt),
    lockedBy: header?.lockedBy ? String(header.lockedBy) : null,
    lockedAt: header?.lockedAt ? String(header.lockedAt) : null,
    updatedAt: header?.updatedAt ? String(header.updatedAt) : null,
    periods: (periodRows.rows as any[]).map((row) => ({
      periodKey: String(row.periodKey),
      startDateAD: String(row.startDateAD),
      endDateAD: String(row.endDateAD),
      status: row.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
    })),
    accounts: (accountRows.rows as any[]).map((row) => ({
      id: String(row.id),
      code: String(row.code),
      name: String(row.name),
      accountType: row.accountType === 'INCOME' ? 'INCOME' : 'EXPENSE',
      statementGroup: String(row.statementGroup),
    })),
    lines: (lineRows.rows as any[]).map((row) => ({
      periodKey: String(row.periodKey),
      accountId: String(row.accountId),
      amount: money(row.amount),
      code: String(row.code),
      name: String(row.name),
      accountType: row.accountType === 'INCOME' ? 'INCOME' : 'EXPENSE',
    })),
  };
}

export interface BudgetSaveInput {
  fiscalYearId?: unknown;
  branchId?: unknown;
  lines?: unknown;
}

/**
 * Replace a budget's open-period lines. Existing lines in a CLOSED accounting
 * period are immutable: a payload that changes or adds one is refused, and a
 * line omitted from the payload is kept rather than deleted. That keeps a
 * closed period's budget reportable while still refusing edits to it.
 */
export async function saveBudget(
  client: AccountingClient,
  input: BudgetSaveInput,
  actor: string | null,
  source: BudgetVersionSource = 'SAVE',
  sourceDetail: string | null = null
): Promise<BudgetEditorResponse> {
  const { fiscalYear, branch } = await loadScope(
    client,
    input.fiscalYearId,
    input.branchId
  );

  const header = (await client.query(BUDGET_HEADER_BY_SCOPE_LOCK_SQL, [
    fiscalYear.id,
    branch.id,
  ])).rows[0];
  if (header?.lockedAt) {
    throw new ApiError(
      409,
      `The FY ${fiscalYear.code} budget for ${branch.name} is locked. Unlock it before changing budget lines.`
    );
  }

  if (!Array.isArray(input.lines)) {
    throw new ApiError(400, 'Budget lines must be an array.');
  }
  if (input.lines.length > 5000) {
    throw new ApiError(400, 'A budget can hold at most 5000 lines.');
  }

  const accountIds = [
    ...new Set(
      input.lines
        .map((line) => text((line as any)?.accountId, 50))
        .filter(Boolean)
    ),
  ];
  const periodKeys = [
    ...new Set(
      input.lines
        .map((line) => text((line as any)?.periodKey, 7))
        .filter(Boolean)
    ),
  ];

  const accountRows = accountIds.length
    ? (await client.query(BUDGET_ACCOUNTS_BY_IDS_SQL, [accountIds])).rows
    : [];
  const accountsById = new Map<string, any>(
    accountRows.map((row) => [String(row.id), row])
  );
  const periodRows = periodKeys.length
    ? (
        await client.query(BUDGET_PERIODS_BY_KEYS_SQL, [
          fiscalYear.id,
          periodKeys,
        ])
      ).rows
    : [];
  const periodsByKey = new Map<string, any>(
    periodRows.map((row) => [String(row.periodKey), row])
  );

  const desired = new Map<
    string,
    { periodKey: string; accountId: string; amount: number }
  >();
  input.lines.forEach((raw, index) => {
    const label = `Line ${index + 1}`;
    const periodKey = text((raw as any)?.periodKey, 7);
    const accountId = text((raw as any)?.accountId, 50);
    if (!periodKey) throw new ApiError(400, `${label}: a period is required.`);
    if (!periodsByKey.has(periodKey)) {
      throw new ApiError(
        400,
        `${label}: accounting period ${periodKey} does not belong to fiscal year ${fiscalYear.code}.`
      );
    }
    if (!accountId) throw new ApiError(400, `${label}: an account is required.`);
    const account = accountsById.get(accountId);
    if (!account) throw new ApiError(400, `${label}: account not found.`);
    if (account.accountType !== 'INCOME' && account.accountType !== 'EXPENSE') {
      throw new ApiError(
        400,
        `${label}: budget lines must use a profit-and-loss account.`
      );
    }
    const key = `${periodKey}|${accountId}`;
    if (desired.has(key)) {
      throw new ApiError(
        400,
        `${label}: ${account.code} already has a line for ${periodKey}.`
      );
    }
    desired.set(key, {
      periodKey,
      accountId,
      amount: amount((raw as any)?.amount, label),
    });
  });

  const existingRows = header
    ? (
        await client.query(BUDGET_LINES_BY_SCOPE_SQL, [
          fiscalYear.id,
          branch.id,
        ])
      ).rows
    : [];
  const existing = new Map<string, any>(
    existingRows.map((row) => [
      `${String(row.periodKey)}|${String(row.accountId)}`,
      row,
    ])
  );

  for (const [key, line] of desired) {
    if (periodsByKey.get(line.periodKey)?.status !== 'CLOSED') continue;
    const current = existing.get(key);
    if (!current) {
      throw new ApiError(
        409,
        `Accounting period ${line.periodKey} is closed. Reopen it before adding a budget line.`
      );
    }
    if (money(current.amount) !== line.amount) {
      throw new ApiError(
        409,
        `Accounting period ${line.periodKey} is closed. Reopen it before editing its budget.`
      );
    }
  }

  const finalLines = new Map(desired);
  for (const [key, row] of existing) {
    if (desired.has(key)) continue;
    if (periodsByKey.get(String(row.periodKey))?.status === 'CLOSED') {
      finalLines.set(key, {
        periodKey: String(row.periodKey),
        accountId: String(row.accountId),
        amount: money(row.amount),
      });
    }
  }

  let budgetId = header ? String(header.id) : '';
  if (!budgetId) {
    budgetId = `glb-${crypto.randomUUID()}`;
    await client.query(BUDGET_HEADER_INSERT_SQL, [
      budgetId,
      fiscalYear.id,
      branch.id,
      actor,
    ]);
    // An initial save has no prior lines, but an existing budget must never
    // have empty history. The baseline is the explicit empty prior state.
    await appendBudgetVersion(
      client,
      budgetId,
      actor,
      'BASELINE',
      'Initial budget baseline',
      []
    );
  } else {
    await appendBudgetVersion(
      client,
      budgetId,
      actor,
      source,
      sourceDetail,
      snapshotLines(existingRows)
    );
  }

  await client.query(BUDGET_LINES_DELETE_SQL, [budgetId]);
  for (const line of finalLines.values()) {
    await client.query(BUDGET_LINE_INSERT_SQL, [
      `glbl-${crypto.randomUUID()}`,
      budgetId,
      line.periodKey,
      line.accountId,
      line.amount,
    ]);
  }
  await client.query(BUDGET_HEADER_TOUCH_SQL, [budgetId, actor]);

  return readBudget(client, fiscalYear.id, branch.id);
}

export interface BudgetHistoryResponse {
  fiscalYearId: string;
  fiscalYearCode: string;
  branchId: string;
  branchName: string;
  versions: BudgetVersionSummaryRow[];
}

export interface BudgetVersionResponse {
  fiscalYearId: string;
  fiscalYearCode: string;
  branchId: string;
  branchName: string;
  version: BudgetVersionSummaryRow & { lines: BudgetVersionLineRow[] };
}

/** Read the immutable version list for one concrete branch budget. */
export async function readBudgetHistory(
  client: AccountingClient,
  fiscalYearId: unknown,
  branchId: unknown
): Promise<BudgetHistoryResponse> {
  const { fiscalYear, branch } = await loadScope(client, fiscalYearId, branchId);
  const header = (await client.query(BUDGET_HEADER_BY_SCOPE_SQL, [fiscalYear.id, branch.id]))
    .rows[0];
  if (!header) {
    return {
      fiscalYearId: fiscalYear.id,
      fiscalYearCode: fiscalYear.code,
      branchId: branch.id,
      branchName: branch.name,
      versions: [],
    };
  }
  const versions = (
    (await client.query(BUDGET_VERSIONS_BY_BUDGET_SQL, [header.id])).rows as any[]
  ).map((row) => ({
    id: String(row.id),
    version: Number(row.version) || 0,
    actor: row.actor ? String(row.actor) : null,
    createdAt: String(row.createdAt),
    source: row.source as BudgetVersionSource,
    sourceDetail: row.sourceDetail ? String(row.sourceDetail) : null,
    lineCount: Number(row.lineCount) || 0,
    totalAmount: money(row.totalAmount),
  }));
  return {
    fiscalYearId: fiscalYear.id,
    fiscalYearCode: fiscalYear.code,
    branchId: branch.id,
    branchName: branch.name,
    versions,
  };
}

/** Read one immutable version, including the exact lines stored in it. */
export async function readBudgetVersion(
  client: AccountingClient,
  fiscalYearId: unknown,
  branchId: unknown,
  versionId: unknown
): Promise<BudgetVersionResponse> {
  const { fiscalYear, branch } = await loadScope(client, fiscalYearId, branchId);
  const id = text(versionId, 80);
  if (!id) throw new ApiError(400, 'A budget version id is required.');
  const header = (await client.query(BUDGET_HEADER_BY_SCOPE_SQL, [fiscalYear.id, branch.id]))
    .rows[0];
  if (!header) throw new ApiError(404, 'No budget history exists for this branch.');
  const row = (await client.query(BUDGET_VERSION_BY_ID_SQL, [id, header.id])).rows[0] as
    | BudgetVersionRow
    | undefined;
  if (!row) throw new ApiError(404, 'Budget version not found.');
  const version = {
    id: String(row.id),
    version: Number(row.version) || 0,
    actor: row.actor ? String(row.actor) : null,
    createdAt: String(row.createdAt),
    source: row.source,
    sourceDetail: row.sourceDetail ? String(row.sourceDetail) : null,
    lineCount: Number(row.lineCount) || 0,
    totalAmount: money(row.totalAmount),
    lines: parseVersionLines(row.lines),
  };
  return {
    fiscalYearId: fiscalYear.id,
    fiscalYearCode: fiscalYear.code,
    branchId: branch.id,
    branchName: branch.name,
    version,
  };
}

export interface BudgetRestoreInput {
  fiscalYearId?: unknown;
  branchId?: unknown;
  versionId?: unknown;
}

export interface BudgetRestoreResponse {
  status: 'RESTORED';
  restoredVersion: number;
  /** The snapshot of the state that was active before this restore. */
  snapshot: BudgetVersionSummaryRow;
  budget: BudgetEditorResponse;
}

/** Restore an immutable prior state, writing a new snapshot instead of
 *  rewriting history. Closed periods and the explicit lock still win. */
export async function restoreBudgetVersion(
  client: AccountingClient,
  input: BudgetRestoreInput,
  actor: string | null
): Promise<BudgetRestoreResponse> {
  const { fiscalYear, branch } = await loadScope(
    client,
    input.fiscalYearId,
    input.branchId
  );
  const header = (await client.query(BUDGET_HEADER_BY_SCOPE_LOCK_SQL, [
    fiscalYear.id,
    branch.id,
  ])).rows[0];
  if (!header) throw new ApiError(404, 'No budget exists for this branch to restore.');
  if (header.lockedAt) {
    throw new ApiError(
      409,
      `The FY ${fiscalYear.code} budget for ${branch.name} is locked. Unlock it before restoring a version.`
    );
  }

  const versionId = text(input.versionId, 80);
  if (!versionId) throw new ApiError(400, 'A budget version id is required.');
  const versionRow = (await client.query(BUDGET_VERSION_BY_ID_SQL, [
    versionId,
    header.id,
  ])).rows[0] as BudgetVersionRow | undefined;
  if (!versionRow) throw new ApiError(404, 'Budget version not found.');

  const targetLines = parseVersionLines(versionRow.lines);
  const currentRows = (
    await client.query(BUDGET_LINES_BY_SCOPE_SQL, [fiscalYear.id, branch.id])
  ).rows as any[];
  const currentByKey = new Map(
    currentRows.map((row) => [`${String(row.periodKey)}|${String(row.accountId)}`, row])
  );
  const targetByKey = new Map(
    targetLines.map((line) => [`${line.periodKey}|${line.accountId}`, line])
  );
  const closed = new Set(
    ((await client.query(BUDGET_PERIODS_BY_FISCAL_YEAR_SQL, [fiscalYear.id])).rows as any[])
      .filter((period) => period.status === 'CLOSED')
      .map((period) => String(period.periodKey))
  );
  for (const line of targetLines) {
    if (!closed.has(line.periodKey)) continue;
    const current = currentByKey.get(`${line.periodKey}|${line.accountId}`);
    if (!current || money(current.amount) !== line.amount) {
      throw new ApiError(
        409,
        `Accounting period ${line.periodKey} is closed. Reopen it before restoring this version.`
      );
    }
  }
  for (const current of currentRows) {
    if (!closed.has(String(current.periodKey))) continue;
    if (!targetByKey.has(`${String(current.periodKey)}|${String(current.accountId)}`)) {
      throw new ApiError(
        409,
        `Accounting period ${String(current.periodKey)} is closed. Reopen it before restoring this version.`
      );
    }
  }

  const snapshot = await appendBudgetVersion(
    client,
    String(header.id),
    actor,
    'RESTORE',
    `Restored version ${Number(versionRow.version)}`,
    snapshotLines(currentRows)
  );
  await client.query(BUDGET_LINES_DELETE_SQL, [header.id]);
  for (const line of targetLines) {
    await client.query(BUDGET_LINE_INSERT_SQL, [
      `glbl-${crypto.randomUUID()}`,
      header.id,
      line.periodKey,
      line.accountId,
      line.amount,
    ]);
  }
  await client.query(BUDGET_HEADER_TOUCH_SQL, [header.id, actor]);

  return {
    status: 'RESTORED',
    restoredVersion: Number(versionRow.version),
    snapshot,
    budget: await readBudget(client, fiscalYear.id, branch.id),
  };
}

export interface BudgetVarianceQuery {
  fiscalYearId?: unknown;
  /** `null` rolls every branch up; the controller resolves this from session. */
  branchId: string | null;
  from?: unknown;
  to?: unknown;
}

export interface BudgetVarianceRow {
  accountId: string;
  code: string;
  name: string;
  accountType: 'INCOME' | 'EXPENSE';
  statementGroup: string;
  budget: number;
  actual: number;
  variance: number;
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

/** One budgeted expense account whose POSTED actual is above its budget. */
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
  /** overBy / budget * 100; always positive for an alert. */
  overPercent: number;
  /** actual / budget * 100; always above 100 for an alert. */
  utilisationPercent: number;
}

export interface BudgetOverspendAlertsQuery extends BudgetVarianceQuery {
  limit?: unknown;
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
  /** Totals cover every matching alert, even when `alerts` is limited. */
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

export interface BudgetVarianceLinesQuery extends BudgetVarianceQuery {
  accountId?: unknown;
  limit?: unknown;
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

export interface BudgetBranchUtilisationRow {
  branchId: string;
  code: string;
  name: string;
  budget: number;
  actual: number;
  variance: number;
  variancePercent: number | null;
  /** Actual / budget * 100; null when the branch has no budget in the window. */
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

const DRILLDOWN_DEFAULT_LIMIT = 500;
const DRILLDOWN_MAX_LIMIT = 2000;

export type BudgetLockStatus = 'LOCKED' | 'UNLOCKED' | 'UNCHANGED';

export interface BudgetLockInput {
  fiscalYearId?: unknown;
  branchId?: unknown;
  locked?: unknown;
}

export interface BudgetLockResponse {
  status: BudgetLockStatus;
  budget: BudgetEditorResponse;
}

/** Explicitly lock or unlock one saved branch budget. */
export async function setBudgetLock(
  client: AccountingClient,
  input: BudgetLockInput,
  actor: string | null
): Promise<BudgetLockResponse> {
  const { fiscalYear, branch } = await loadScope(
    client,
    input.fiscalYearId,
    input.branchId
  );
  if (typeof input.locked !== 'boolean') {
    throw new ApiError(400, 'The locked flag must be true or false.');
  }

  const header = (await client.query(BUDGET_HEADER_BY_SCOPE_LOCK_SQL, [
    fiscalYear.id,
    branch.id,
  ])).rows[0];
  if (!header) {
    throw new ApiError(
      404,
      `No budget exists for FY ${fiscalYear.code} ${branch.name} to lock. Save the budget first.`
    );
  }

  const nextLocked = input.locked;
  if (Boolean(header.lockedAt) === nextLocked) {
    return {
      status: 'UNCHANGED',
      budget: await readBudget(client, fiscalYear.id, branch.id),
    };
  }

  await client.query(BUDGET_SET_LOCK_SQL, [header.id, nextLocked, actor]);
  return {
    status: nextLocked ? 'LOCKED' : 'UNLOCKED',
    budget: await readBudget(client, fiscalYear.id, branch.id),
  };
}

/** Budget, actual, variance and variance percentage for one FY/branch/window. */
export async function buildBudgetVariance(
  client: AccountingClient,
  query: BudgetVarianceQuery
): Promise<BudgetVarianceResponse> {
  const fiscalYearId = text(query.fiscalYearId, 50);
  if (!fiscalYearId) throw new ApiError(400, 'A fiscal year id is required.');
  const fiscalYear = (await client.query(BUDGET_FISCAL_YEAR_SQL, [fiscalYearId]))
    .rows[0] as BudgetFiscalYearRow | undefined;
  if (!fiscalYear) throw new ApiError(404, 'Fiscal year not found.');

  let branchId = query.branchId;
  if (branchId) {
    const branch = (await client.query(BUDGET_BRANCH_SQL, [branchId])).rows[0];
    if (!branch) throw new ApiError(400, `Branch ${branchId} does not exist.`);
  } else {
    branchId = null;
  }

  const rawFrom = text(query.from, 10);
  const rawTo = text(query.to, 10);
  const from = rawFrom || fiscalYear.startDateAD;
  const to = rawTo || fiscalYear.endDateAD;
  if (!isAccountingDate(from)) {
    throw new ApiError(400, 'Budget window start must be a real date (YYYY-MM-DD).');
  }
  if (!isAccountingDate(to)) {
    throw new ApiError(400, 'Budget window end must be a real date (YYYY-MM-DD).');
  }
  if (from > to) {
    throw new ApiError(400, 'The budget window start must not be after its end.');
  }

  const rows = (await client.query(BUDGET_VARIANCE_ROWS_SQL, [
    fiscalYear.id,
    branchId,
    from,
    to,
  ])).rows.map((row: any): BudgetVarianceRow => {
    const budget = money(row.budget);
    const actual = money(row.actual);
    const variance = roundMoney(budget - actual);
    return {
      accountId: String(row.accountId),
      code: String(row.code),
      name: String(row.name),
      accountType: row.accountType === 'INCOME' ? 'INCOME' : 'EXPENSE',
      statementGroup: String(row.statementGroup),
      budget,
      actual,
      variance,
      variancePercent: percentOf(variance, budget),
    };
  });

  const totalBudget = roundMoney(rows.reduce((sum, row) => sum + row.budget, 0));
  const totalActual = roundMoney(rows.reduce((sum, row) => sum + row.actual, 0));
  const totalVariance = roundMoney(totalBudget - totalActual);

  return {
    fiscalYearId: fiscalYear.id,
    fiscalYearCode: fiscalYear.code,
    branchId: branchId || 'ALL',
    from,
    to,
    rows,
    totals: {
      budget: totalBudget,
      actual: totalActual,
      variance: totalVariance,
      variancePercent: percentOf(totalVariance, totalBudget),
    },
  };
}

const ALERT_DEFAULT_LIMIT = 5;
const ALERT_MAX_LIMIT = 50;

/**
 * Dashboard overspend feed. It reuses `buildBudgetVariance` for the fiscal
 * year, branch scope, inclusive window and natural-side POSTED actuals, then
 * keeps only budgeted expense accounts with actual above budget. Totals and
 * the source tie-out are computed over every matching row before the display
 * limit, so a truncated card list still reconciles to the variance report.
 */
export async function buildBudgetOverspendAlerts(
  client: AccountingClient,
  query: BudgetOverspendAlertsQuery
): Promise<BudgetOverspendAlertsResponse> {
  const variance = await buildBudgetVariance(client, query);
  const overspent = variance.rows
    .filter((row) => row.accountType === 'EXPENSE' && row.budget > 0 && row.actual > row.budget)
    .map((row): BudgetOverspendAlert => {
      const overBy = roundMoney(row.actual - row.budget);
      return {
        accountId: row.accountId,
        code: row.code,
        name: row.name,
        accountType: 'EXPENSE',
        statementGroup: row.statementGroup,
        budget: row.budget,
        actual: row.actual,
        variance: row.variance,
        variancePercent: row.variancePercent,
        overBy,
        overPercent: percentOf(overBy, row.budget) ?? 0,
        utilisationPercent: percentOf(row.actual, row.budget) ?? 0,
      };
    })
    .sort((a, b) => b.overBy - a.overBy || a.code.localeCompare(b.code));

  const requestedLimit = Number(query.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(ALERT_MAX_LIMIT, Math.trunc(requestedLimit))
    : ALERT_DEFAULT_LIMIT;
  const alerts = overspent.slice(0, limit);

  const sourceBudget = roundMoney(overspent.reduce((sum, row) => sum + row.budget, 0));
  const sourceActual = roundMoney(overspent.reduce((sum, row) => sum + row.actual, 0));
  const alertBudget = roundMoney(overspent.reduce((sum, row) => sum + row.budget, 0));
  const alertActual = roundMoney(overspent.reduce((sum, row) => sum + row.actual, 0));
  const budgetDifference = roundMoney(sourceBudget - alertBudget);
  const actualDifference = roundMoney(sourceActual - alertActual);

  return {
    fiscalYearId: variance.fiscalYearId,
    fiscalYearCode: variance.fiscalYearCode,
    branchId: variance.branchId,
    from: variance.from,
    to: variance.to,
    alerts,
    totals: {
      alertCount: overspent.length,
      budget: alertBudget,
      actual: alertActual,
      overBy: roundMoney(alertActual - alertBudget),
    },
    tieOut: {
      sourceBudget,
      sourceActual,
      alertBudget,
      alertActual,
      budgetDifference,
      actualDifference,
      reconciled: budgetDifference === 0 && actualDifference === 0,
    },
    truncated: overspent.length > alerts.length,
    limit,
  };
}

/** Branch cards that tie back to the same FY/branch/window variance totals. */
export async function buildBudgetBranchUtilisation(
  client: AccountingClient,
  query: BudgetVarianceQuery
): Promise<BudgetBranchUtilisationResponse> {
  const variance = await buildBudgetVariance(client, query);
  const rows = (await client.query(BUDGET_BRANCH_UTILISATION_SQL, [
    variance.fiscalYearId,
    variance.branchId === 'ALL' ? null : variance.branchId,
    variance.from,
    variance.to,
  ])).rows;
  const branches = rows.map((row: any): BudgetBranchUtilisationRow => {
    const budget = money(row.budget);
    const actual = money(row.actual);
    const varianceAmount = roundMoney(budget - actual);
    return {
      branchId: String(row.branchId),
      code: String(row.code),
      name: String(row.name),
      budget,
      actual,
      variance: varianceAmount,
      variancePercent: percentOf(varianceAmount, budget),
      utilisationPercent: percentOf(actual, budget),
    };
  });
  const cardBudget = roundMoney(branches.reduce((sum, row) => sum + row.budget, 0));
  const cardActual = roundMoney(branches.reduce((sum, row) => sum + row.actual, 0));
  const budgetDifference = roundMoney(variance.totals.budget - cardBudget);
  const actualDifference = roundMoney(variance.totals.actual - cardActual);

  return {
    fiscalYearId: variance.fiscalYearId,
    fiscalYearCode: variance.fiscalYearCode,
    branchId: variance.branchId,
    from: variance.from,
    to: variance.to,
    branches,
    totals: variance.totals,
    tieOut: {
      budget: variance.totals.budget,
      actual: variance.totals.actual,
      cardBudget,
      cardActual,
      budgetDifference,
      actualDifference,
      reconciled: budgetDifference === 0 && actualDifference === 0,
    },
  };
}

/** The POSTED journal lines behind one budget variance row. */
export async function buildBudgetVarianceLines(
  client: AccountingClient,
  query: BudgetVarianceLinesQuery
): Promise<BudgetVarianceLinesResponse> {
  const accountId = text(query.accountId, 50);
  if (!accountId) throw new ApiError(400, 'An account id is required.');

  const variance = await buildBudgetVariance(client, query);
  const account = variance.rows.find((row) => row.accountId === accountId);
  if (!account) {
    throw new ApiError(404, 'This account has no budget or posted actual in the selected window.');
  }

  const requestedLimit = Number(query.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(DRILLDOWN_MAX_LIMIT, Math.trunc(requestedLimit)))
    : DRILLDOWN_DEFAULT_LIMIT;
  const rows = (
    await client.query(BUDGET_VARIANCE_LINES_SQL, [
      accountId,
      variance.branchId === 'ALL' ? null : variance.branchId,
      variance.from,
      variance.to,
      limit,
    ])
  ).rows;
  const entries = rows.map((row: any): BudgetVarianceLine => ({
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
    amount: money(row.amount),
  }));

  const first = rows[0];
  const totals = first
    ? {
        debit: money(first.debitTotal),
        credit: money(first.creditTotal),
        actual: money(first.actualTotal),
        entryCount: Number(first.entryCount) || 0,
      }
    : { debit: 0, credit: 0, actual: 0, entryCount: 0 };
  const difference = roundMoney(account.actual - totals.actual);

  return {
    fiscalYearId: variance.fiscalYearId,
    fiscalYearCode: variance.fiscalYearCode,
    branchId: variance.branchId,
    from: variance.from,
    to: variance.to,
    account,
    entries,
    totals,
    tieOut: {
      budget: account.budget,
      actual: account.actual,
      variance: account.variance,
      variancePercent: account.variancePercent,
      lineActual: totals.actual,
      difference,
      reconciled: difference === 0,
    },
    truncated: totals.entryCount > entries.length,
    limit,
  };
}
