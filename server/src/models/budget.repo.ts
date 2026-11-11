/**
 * Budget read/write SQL. Budget amounts live per fiscal year, branch, period
 * and profit-and-loss account; actuals are never stored here. The variance
 * query joins the budget aggregate to the same POSTED `gl_journal_lines`
 * source the financial statements use, so a budget report cannot drift from
 * the ledger that produced it.
 */

export type BudgetAccountType = 'INCOME' | 'EXPENSE';

export interface BudgetFiscalYearRow {
  id: string;
  code: string;
  startDateAD: string;
  endDateAD: string;
}

export interface BudgetBranchRow {
  id: string;
  code: string;
  name: string;
}

export interface BudgetHeaderRow {
  id: string;
  fiscalYearId: string;
  branchId: string;
  lockedBy: string | null;
  lockedAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface BudgetLineRow {
  periodKey: string;
  accountId: string;
  amount: number;
  code: string;
  name: string;
  accountType: BudgetAccountType;
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

export interface BudgetAccountLookupRow extends BudgetAccountOption {
  isActive: boolean;
}

export interface BudgetSourceLineRow {
  periodKey: string;
  accountId: string;
  amount: number;
  code: string | null;
  name: string | null;
  accountType: BudgetAccountType | null;
}

export type BudgetVersionSource =
  | 'BASELINE'
  | 'SAVE'
  | 'COPY'
  | 'COPY_REPLACE'
  | 'IMPORT'
  | 'IMPORT_REPLACE'
  | 'RESTORE';

export interface BudgetVersionLineRow {
  periodKey: string;
  accountId: string;
  amount: number;
  code: string;
  name: string;
  accountType: BudgetAccountType;
}

export interface BudgetVersionSummaryRow {
  id: string;
  version: number;
  actor: string | null;
  createdAt: string;
  source: BudgetVersionSource;
  sourceDetail: string | null;
  lineCount: number;
  totalAmount: number;
}

export interface BudgetVersionRow extends BudgetVersionSummaryRow {
  lines: unknown;
}

export interface BudgetVarianceSourceRow {
  accountId: string;
  code: string;
  name: string;
  accountType: BudgetAccountType;
  statementGroup: string;
  budget: number;
  actual: number;
}

/** The fiscal year a budget belongs to, with its exact AD bounds. */
export const BUDGET_FISCAL_YEAR_SQL = `SELECT id, code,
  start_date_ad::text AS "startDateAD",
  end_date_ad::text AS "endDateAD"
FROM fiscal_years
WHERE id = $1`;

export const BUDGET_BRANCH_SQL = `SELECT id, code, name
FROM branches
WHERE id = $1`;

/** One header per fiscal year + branch, created lazily on the first save. */
export const BUDGET_HEADER_BY_SCOPE_SQL = `SELECT id,
  fiscal_year_id AS "fiscalYearId",
  branch_id AS "branchId",
  locked_by AS "lockedBy",
  locked_at::text AS "lockedAt",
  updated_by AS "updatedBy",
  updated_at::text AS "updatedAt"
FROM gl_budgets
WHERE fiscal_year_id = $1 AND branch_id = $2`;

/** The save and lock paths take this row lock so a concurrent edit cannot
 *  slip past the explicit budget lock. */
export const BUDGET_HEADER_BY_SCOPE_LOCK_SQL = `SELECT id,
  fiscal_year_id AS "fiscalYearId",
  branch_id AS "branchId",
  locked_by AS "lockedBy",
  locked_at::text AS "lockedAt",
  updated_by AS "updatedBy",
  updated_at::text AS "updatedAt"
FROM gl_budgets
WHERE fiscal_year_id = $1 AND branch_id = $2
FOR UPDATE`;

export const BUDGET_LINES_BY_SCOPE_SQL = `SELECT bl.period_key AS "periodKey",
  bl.account_id AS "accountId",
  bl.amount::numeric AS amount,
  a.code,
  a.name,
  g.account_type AS "accountType"
FROM gl_budget_lines bl
JOIN gl_budgets b ON b.id = bl.budget_id
JOIN gl_accounts a ON a.id = bl.account_id
JOIN gl_account_groups g ON g.id = a.group_id
WHERE b.fiscal_year_id = $1 AND b.branch_id = $2
ORDER BY bl.period_key ASC, a.code ASC`;

export const BUDGET_PERIODS_BY_FISCAL_YEAR_SQL = `SELECT period_key AS "periodKey",
  start_date_ad::text AS "startDateAD",
  end_date_ad::text AS "endDateAD",
  status
FROM gl_periods
WHERE fiscal_year_id = $1
ORDER BY start_date_ad ASC`;

/** Budgets are account-level and profit-and-loss only, so inactive ledgers
 *  cannot be added while an already-budgeted inactive ledger still reports. */
export const BUDGET_ACCOUNT_OPTIONS_SQL = `SELECT a.id,
  a.code,
  a.name,
  g.account_type AS "accountType",
  g.statement_group AS "statementGroup"
FROM gl_accounts a
JOIN gl_account_groups g ON g.id = a.group_id
WHERE a.is_active = TRUE AND g.account_type IN ('INCOME', 'EXPENSE')
ORDER BY a.code ASC`;

export const BUDGET_ACCOUNTS_BY_IDS_SQL = `SELECT a.id,
  a.code,
  a.name,
  g.account_type AS "accountType"
FROM gl_accounts a
JOIN gl_account_groups g ON g.id = a.group_id
WHERE a.id = ANY($1::varchar[])`;

/** CSV imports address accounts by their stable chart code, never by a row id. */
export const BUDGET_ACCOUNTS_BY_CODES_SQL = `SELECT a.id,
  a.code,
  a.name,
  a.is_active AS "isActive",
  g.account_type AS "accountType",
  g.statement_group AS "statementGroup"
FROM gl_accounts a
JOIN gl_account_groups g ON g.id = a.group_id
WHERE a.code = ANY($1::varchar[])`;

export const BUDGET_PERIODS_BY_KEYS_SQL = `SELECT period_key AS "periodKey",
  status
FROM gl_periods
WHERE fiscal_year_id = $1 AND period_key = ANY($2::varchar[])`;

/** The latest earlier fiscal year that already has a budget for this branch. */
export const BUDGET_PREVIOUS_FISCAL_YEAR_SQL = `SELECT f.id, f.code,
  f.start_date_ad::text AS "startDateAD",
  f.end_date_ad::text AS "endDateAD"
FROM fiscal_years f
JOIN gl_budgets b ON b.fiscal_year_id = f.id
WHERE b.branch_id = $1
  AND f.start_date_ad < $2::date
ORDER BY f.start_date_ad DESC
LIMIT 1`;

/** Source rows keep unknown chart accounts visible so a copy can report them. */
export const BUDGET_SOURCE_LINES_SQL = `SELECT bl.period_key AS "periodKey",
  bl.account_id AS "accountId",
  bl.amount::numeric AS amount,
  a.code,
  a.name,
  g.account_type AS "accountType"
FROM gl_budget_lines bl
JOIN gl_budgets b ON b.id = bl.budget_id
LEFT JOIN gl_accounts a ON a.id = bl.account_id
LEFT JOIN gl_account_groups g ON g.id = a.group_id
WHERE b.fiscal_year_id = $1 AND b.branch_id = $2
ORDER BY bl.period_key ASC, a.code ASC`;

export const BUDGET_HEADER_INSERT_SQL = `INSERT INTO gl_budgets (
  id, fiscal_year_id, branch_id, created_by, updated_by
) VALUES ($1, $2, $3, $4, $4)
RETURNING id`;

export const BUDGET_HEADER_TOUCH_SQL = `UPDATE gl_budgets SET
  updated_by = $2,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;

/** Set or clear the explicit lock. The stored lines are never touched. */
export const BUDGET_SET_LOCK_SQL = `UPDATE gl_budgets SET
  locked_at = CASE WHEN $2::boolean THEN CURRENT_TIMESTAMP ELSE NULL END,
  locked_by = CASE WHEN $2::boolean THEN $3::varchar ELSE NULL END,
  updated_by = $3,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

export const BUDGET_LINES_DELETE_SQL = `DELETE FROM gl_budget_lines WHERE budget_id = $1`;

export const BUDGET_LINE_INSERT_SQL = `INSERT INTO gl_budget_lines (
  id, budget_id, period_key, account_id, amount
) VALUES ($1, $2, $3, $4, $5)`;

/** Append one immutable prior-state snapshot. The header row lock serialises
 *  version allocation, so MAX + 1 cannot race another writer. */
export const BUDGET_VERSION_INSERT_SQL = `INSERT INTO gl_budget_versions (
  id, budget_id, version_no, actor, source, source_detail, lines
) VALUES (
  $1, $2,
  (SELECT COALESCE(MAX(version_no), 0) + 1
   FROM gl_budget_versions WHERE budget_id = $2::varchar),
  $3, $4, $5, $6::jsonb
)
RETURNING version_no AS version, created_at::text AS "createdAt"`;

/** Version list for one budget, newest first. Lines stay out of the list. */
export const BUDGET_VERSIONS_BY_BUDGET_SQL = `SELECT id,
  version_no AS version,
  actor,
  created_at::text AS "createdAt",
  source,
  source_detail AS "sourceDetail",
  jsonb_array_length(lines)::int AS "lineCount",
  COALESCE((
    SELECT SUM((entry->>'amount')::numeric)
    FROM jsonb_array_elements(lines) entry
  ), 0)::numeric AS "totalAmount"
FROM gl_budget_versions
WHERE budget_id = $1
ORDER BY version_no DESC`;

/** One version with its exact stored lines, scoped by the owning budget. */
export const BUDGET_VERSION_BY_ID_SQL = `SELECT id,
  version_no AS version,
  actor,
  created_at::text AS "createdAt",
  source,
  source_detail AS "sourceDetail",
  jsonb_array_length(lines)::int AS "lineCount",
  COALESCE((
    SELECT SUM((entry->>'amount')::numeric)
    FROM jsonb_array_elements(lines) entry
  ), 0)::numeric AS "totalAmount",
  lines
FROM gl_budget_versions
WHERE id = $1 AND budget_id = $2`;

/**
 * Variance rows: every account that has a budget, a posted actual, or both.
 * `$1` is the fiscal year, `$2` the branch (NULL rolls every branch up), `$3`
 * and `$4` the inclusive window. Budget totals only count periods wholly
 * inside the window, so a partial month cannot be compared with a full-month
 * budget. Actuals use the account type's natural side: expenses positive when
 * debited, income positive when credited, exactly like `presented()` in the
 * statement service. Only POSTED journals count.
 */
export const BUDGET_VARIANCE_LINES_SQL = `WITH scoped AS (
  SELECT l.id,
    j.id AS journal_id,
    j.journal_no,
    j.journal_date_ad,
    j.source_type,
    j.source_id,
    l.branch_id,
    l.line_no,
    l.memo,
    j.memo AS journal_memo,
    l.debit,
    l.credit,
    CASE WHEN g.account_type = 'EXPENSE'
      THEN l.debit - l.credit
      ELSE l.credit - l.debit
    END AS actual
  FROM gl_journal_lines l
  JOIN gl_journals j ON j.id = l.journal_id
  JOIN gl_accounts a ON a.id = l.account_id
  JOIN gl_account_groups g ON g.id = a.group_id
  WHERE l.account_id = $1::varchar
    AND j.status = 'POSTED'
    AND j.journal_date_ad >= $3::date
    AND j.journal_date_ad <= $4::date
    AND ($2::varchar IS NULL OR l.branch_id = $2::varchar)
    AND g.account_type IN ('INCOME', 'EXPENSE')
)
SELECT id,
  journal_id AS "journalId",
  journal_no AS "journalNo",
  journal_date_ad::text AS "journalDateAD",
  source_type AS "sourceType",
  source_id AS "sourceId",
  branch_id AS "branchId",
  line_no AS "lineNo",
  memo,
  journal_memo AS "journalMemo",
  debit::numeric AS debit,
  credit::numeric AS credit,
  actual::numeric AS amount,
  COALESCE(SUM(debit) OVER (), 0)::numeric AS "debitTotal",
  COALESCE(SUM(credit) OVER (), 0)::numeric AS "creditTotal",
  COALESCE(SUM(actual) OVER (), 0)::numeric AS "actualTotal",
  COUNT(*) OVER ()::int AS "entryCount"
FROM scoped
ORDER BY journal_date_ad ASC, journal_no ASC, line_no ASC, id ASC
LIMIT $5::int`;

/**
 * Branch utilisation cards: the same budget-period and POSTED-actual
 * predicates as BUDGET_VARIANCE_ROWS_SQL, grouped by the branch that owns the
 * budget or posted line. A branch with neither is omitted rather than shown as
 * a misleading zero card. `$1` fiscal year, `$2` branch (NULL = every branch),
 * `$3`/`$4` inclusive window.
 */
export const BUDGET_BRANCH_UTILISATION_SQL = `WITH budget_totals AS (
  SELECT b.branch_id, SUM(bl.amount) AS amount
  FROM gl_budget_lines bl
  JOIN gl_budgets b ON b.id = bl.budget_id
  JOIN gl_periods p
    ON p.fiscal_year_id = b.fiscal_year_id
   AND p.period_key = bl.period_key
  WHERE b.fiscal_year_id = $1::varchar
    AND ($2::varchar IS NULL OR b.branch_id = $2::varchar)
    AND p.start_date_ad >= $3::date
    AND p.end_date_ad <= $4::date
  GROUP BY b.branch_id
), actual_totals AS (
  SELECT l.branch_id,
    SUM(CASE WHEN g.account_type = 'EXPENSE'
      THEN l.debit - l.credit
      ELSE l.credit - l.debit
    END) AS amount
  FROM gl_journal_lines l
  JOIN gl_journals j ON j.id = l.journal_id
  JOIN gl_accounts a ON a.id = l.account_id
  JOIN gl_account_groups g ON g.id = a.group_id
  WHERE j.status = 'POSTED'
    AND j.journal_date_ad >= $3::date
    AND j.journal_date_ad <= $4::date
    AND ($2::varchar IS NULL OR l.branch_id = $2::varchar)
    AND g.account_type IN ('INCOME', 'EXPENSE')
  GROUP BY l.branch_id
)
SELECT br.id AS "branchId",
  br.code,
  br.name,
  COALESCE(bt.amount, 0)::numeric AS budget,
  COALESCE(at.amount, 0)::numeric AS actual
FROM branches br
LEFT JOIN budget_totals bt ON bt.branch_id = br.id
LEFT JOIN actual_totals at ON at.branch_id = br.id
WHERE bt.amount IS NOT NULL OR at.amount IS NOT NULL
ORDER BY br.name ASC, br.code ASC`;

export const BUDGET_VARIANCE_ROWS_SQL = `WITH budget_totals AS (
  SELECT bl.account_id, SUM(bl.amount) AS amount
  FROM gl_budget_lines bl
  JOIN gl_budgets b ON b.id = bl.budget_id
  JOIN gl_periods p
    ON p.fiscal_year_id = b.fiscal_year_id
   AND p.period_key = bl.period_key
  WHERE b.fiscal_year_id = $1::varchar
    AND ($2::varchar IS NULL OR b.branch_id = $2::varchar)
    AND p.start_date_ad >= $3::date
    AND p.end_date_ad <= $4::date
  GROUP BY bl.account_id
), actual_totals AS (
  SELECT l.account_id,
    SUM(CASE WHEN g.account_type = 'EXPENSE'
      THEN l.debit - l.credit
      ELSE l.credit - l.debit
    END) AS amount
  FROM gl_journal_lines l
  JOIN gl_journals j ON j.id = l.journal_id
  JOIN gl_accounts a ON a.id = l.account_id
  JOIN gl_account_groups g ON g.id = a.group_id
  WHERE j.status = 'POSTED'
    AND j.journal_date_ad >= $3::date
    AND j.journal_date_ad <= $4::date
    AND ($2::varchar IS NULL OR l.branch_id = $2::varchar)
    AND g.account_type IN ('INCOME', 'EXPENSE')
  GROUP BY l.account_id
)
SELECT a.id AS "accountId",
  a.code,
  a.name,
  g.account_type AS "accountType",
  g.statement_group AS "statementGroup",
  COALESCE(bt.amount, 0)::numeric AS budget,
  COALESCE(at.amount, 0)::numeric AS actual
FROM gl_accounts a
JOIN gl_account_groups g ON g.id = a.group_id
LEFT JOIN budget_totals bt ON bt.account_id = a.id
LEFT JOIN actual_totals at ON at.account_id = a.id
WHERE g.account_type IN ('INCOME', 'EXPENSE')
  AND (bt.amount IS NOT NULL OR at.amount IS NOT NULL)
ORDER BY g.statement_group ASC, a.code ASC`;
