/**
 * Cost-centre allocation SQL for the budget read side.
 *
 * A profile is scoped by fiscal year + branch. `account_group = 'DEFAULT'`
 * carries the branch fallback split; a real expense statement group (for
 * example OPERATING_EXPENSE) is an override for that group. Percentages are
 * stored in basis points so the service can require an exact 100.00% total.
 *
 * Actuals are always POSTED expense lines grouped by their stored
 * `cost_center_id`. The NULL group is the explicit unallocated amount; it is
 * never spread over the profile ratios.
 */

export interface BudgetAllocationProfileRow {
  id: string;
  fiscalYearId: string;
  branchId: string;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface BudgetAllocationRuleRow {
  id: string;
  accountGroup: string;
  costCenterId: string;
  percentageBp: number;
  code: string;
  name: string;
  branchId: string | null;
  active: boolean;
}

export interface BudgetAllocationCentreRow {
  id: string;
  code: string;
  name: string;
  branchId: string | null;
  parentId: string | null;
  active: boolean;
}

export interface BudgetAllocationGroupBudgetRow {
  accountGroup: string;
  budget: number;
}

export interface BudgetAllocationActualRow {
  costCenterId: string | null;
  costCenterCode: string | null;
  costCenterName: string | null;
  costCenterBranchId: string | null;
  lineCount: number;
  actual: number;
}

export const ALLOCATION_PROFILE_BY_SCOPE_SQL = `SELECT p.id,
  p.fiscal_year_id AS "fiscalYearId",
  p.branch_id AS "branchId",
  p.updated_by AS "updatedBy",
  p.updated_at::text AS "updatedAt"
FROM gl_budget_allocation_profiles p
WHERE p.fiscal_year_id = $1 AND p.branch_id = $2`;

/** Serialises concurrent rule replacement for one existing profile. */
export const ALLOCATION_PROFILE_BY_SCOPE_LOCK_SQL = `${ALLOCATION_PROFILE_BY_SCOPE_SQL}
FOR UPDATE`;

export const ALLOCATION_PROFILE_INSERT_SQL = `INSERT INTO gl_budget_allocation_profiles (
  id, fiscal_year_id, branch_id, created_by, updated_by
) VALUES ($1, $2, $3, $4, $4)
RETURNING id`;

export const ALLOCATION_PROFILE_TOUCH_SQL = `UPDATE gl_budget_allocation_profiles SET
  updated_by = $2,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;

export const ALLOCATION_RULES_BY_PROFILE_SQL = `SELECT l.id,
  l.account_group AS "accountGroup",
  l.cost_center_id AS "costCenterId",
  l.percentage_bp::int AS "percentageBp",
  cc.code,
  cc.name,
  cc.branch_id AS "branchId",
  cc.active
FROM gl_budget_allocation_lines l
JOIN cost_centers cc ON cc.id = l.cost_center_id
WHERE l.profile_id = $1
ORDER BY l.account_group ASC, cc.code ASC`;

export const ALLOCATION_RULES_DELETE_SQL = `DELETE FROM gl_budget_allocation_lines
WHERE profile_id = $1`;

export const ALLOCATION_RULE_INSERT_SQL = `INSERT INTO gl_budget_allocation_lines (
  id, profile_id, account_group, cost_center_id, percentage_bp
) VALUES ($1, $2, $3, $4, $5)`;

/**
 * Active centres usable by a branch: global centres plus centres owned by the
 * branch. Inactive rows are returned by the rules query above so a retired
 * centre in an existing profile remains visible for repair.
 */
export const ALLOCATION_CENTRES_SQL = `SELECT cc.id,
  cc.code,
  cc.name,
  cc.branch_id AS "branchId",
  cc.parent_id AS "parentId",
  cc.active
FROM cost_centers cc
WHERE cc.branch_id IS NULL OR cc.branch_id = $1
ORDER BY cc.code ASC`;

/** Every expense statement group the chart currently declares. */
export const ALLOCATION_EXPENSE_GROUPS_SQL = `SELECT DISTINCT g.statement_group AS "accountGroup"
FROM gl_account_groups g
WHERE g.account_type = 'EXPENSE'
ORDER BY g.statement_group ASC`;

/**
 * Budget amounts by expense statement group for one branch and window. Only
 * whole accounting periods inside the window count, exactly like the budget
 * variance report, so a partial month cannot be allocated against a full-month
 * amount.
 */
export const ALLOCATION_GROUP_BUDGETS_SQL = `SELECT g.statement_group AS "accountGroup",
  COALESCE(SUM(bl.amount), 0)::numeric AS budget
FROM gl_budget_lines bl
JOIN gl_budgets b ON b.id = bl.budget_id
JOIN gl_periods p
  ON p.fiscal_year_id = b.fiscal_year_id
 AND p.period_key = bl.period_key
JOIN gl_accounts a ON a.id = bl.account_id
JOIN gl_account_groups g ON g.id = a.group_id
WHERE b.fiscal_year_id = $1
  AND b.branch_id = $2
  AND g.account_type = 'EXPENSE'
  AND p.start_date_ad >= $3::date
  AND p.end_date_ad <= $4::date
GROUP BY g.statement_group
ORDER BY g.statement_group ASC`;

/**
 * Tagged and untagged POSTED expense actuals for one branch and window. One
 * row is the NULL cost-centre group, which the service reports as the explicit
 * unallocated amount. The natural expense side is debit - credit.
 */
export const ALLOCATION_ACTUALS_SQL = `SELECT jl.cost_center_id AS "costCenterId",
  cc.code AS "costCenterCode",
  cc.name AS "costCenterName",
  cc.branch_id AS "costCenterBranchId",
  COUNT(*)::int AS "lineCount",
  COALESCE(SUM(jl.debit - jl.credit), 0)::numeric AS actual
FROM gl_journal_lines jl
JOIN gl_journals j ON j.id = jl.journal_id
JOIN gl_accounts a ON a.id = jl.account_id
JOIN gl_account_groups g ON g.id = a.group_id
LEFT JOIN cost_centers cc ON cc.id = jl.cost_center_id
WHERE j.status = 'POSTED'
  AND jl.branch_id = $1
  AND j.journal_date_ad >= $2::date
  AND j.journal_date_ad <= $3::date
  AND g.account_type = 'EXPENSE'
GROUP BY jl.cost_center_id, cc.code, cc.name, cc.branch_id
ORDER BY cc.code ASC NULLS LAST`;
