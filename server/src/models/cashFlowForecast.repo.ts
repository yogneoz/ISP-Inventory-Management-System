/**
 * Persistence for the forward cash-flow forecast's supplemental inputs.
 *
 * A manual input is a branch-owned, dated adjustment whose amount is a safe
 * arithmetic formula. Recurring and payroll projections are read-only here:
 * they come from the persisted scheduling and payroll tables, never from a
 * second forecast copy that could drift from the source registers.
 */

export const CASH_FLOW_MANUAL_INPUT_COLUMNS = `i.id,
  i.branch_id AS "branchId",
  b.code AS "branchCode",
  b.name AS "branchName",
  i.expected_date_ad::text AS "expectedDateAD",
  i.expected_date_bs AS "expectedDateBS",
  i.direction,
  i.amount_formula AS "amountFormula",
  i.description,
  i.created_by AS "createdBy",
  i.updated_by AS "updatedBy",
  i.created_at AS "createdAt",
  i.updated_at AS "updatedAt",
  EXISTS (
    SELECT 1 FROM gl_periods p
    WHERE p.status = 'CLOSED'
      AND i.expected_date_ad BETWEEN p.start_date_ad AND p.end_date_ad
  ) AS "closedPeriod"`;

const MANUAL_INPUT_FROM = `FROM gl_cash_flow_manual_inputs i
JOIN branches b ON b.id = i.branch_id`;

export const CASH_FLOW_MANUAL_INPUT_LIST_SQL = `SELECT ${CASH_FLOW_MANUAL_INPUT_COLUMNS}
${MANUAL_INPUT_FROM}
WHERE ($1::varchar IS NULL OR i.branch_id = $1)
ORDER BY i.expected_date_ad ASC, i.created_at ASC, i.id ASC
LIMIT 500`;

export const CASH_FLOW_MANUAL_INPUT_BY_ID_SQL = `SELECT ${CASH_FLOW_MANUAL_INPUT_COLUMNS}
${MANUAL_INPUT_FROM}
WHERE i.id = $1`;

export const CASH_FLOW_MANUAL_INPUT_INSERT_SQL = `INSERT INTO gl_cash_flow_manual_inputs (
  id, branch_id, expected_date_ad, expected_date_bs, direction,
  amount_formula, description, created_by, updated_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`;

export const CASH_FLOW_MANUAL_INPUT_UPDATE_SQL = `UPDATE gl_cash_flow_manual_inputs SET
  expected_date_ad = $2,
  expected_date_bs = $3,
  direction = $4,
  amount_formula = $5,
  description = $6,
  updated_by = $7,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;

export const CASH_FLOW_MANUAL_INPUT_DELETE_SQL =
  'DELETE FROM gl_cash_flow_manual_inputs WHERE id = $1';

/**
 * Due/next-run dates are read as text so a DATE never becomes a JS timestamp
 * and shifts by one day in a non-UTC process. The account kind is what makes a
 * recurring template's cash effect derivable without a second chart read.
 */
export const CASH_FLOW_RECURRING_TEMPLATES_SQL = `SELECT t.id,
  t.code,
  t.name,
  t.branch_id AS "branchId",
  t.frequency,
  t.next_run_date::text AS "nextRunDate",
  t.end_date_ad::text AS "endDateAD",
  l.line_no AS "lineNo",
  l.side,
  l.amount_formula AS "amountFormula",
  a.code AS "accountCode",
  a.name AS "accountName",
  a.account_kind AS "accountKind",
  a.is_active AS "accountActive"
FROM gl_recurring_templates t
JOIN gl_recurring_template_lines l ON l.template_id = t.id
JOIN gl_accounts a ON a.id = l.account_id
WHERE t.active = TRUE
  AND ($1::varchar IS NULL OR t.branch_id = $1)
ORDER BY t.next_run_date ASC, t.code ASC, l.line_no ASC`;

/**
 * An unpaid, approved/posted run is a committed salary obligation. DRAFT is
 * not yet a commitment; PAID and any run with a payment journal have already
 * left cash. The run date is the payroll period's payment date because the
 * payroll master has no separate schedule field.
 */
export const CASH_FLOW_PAYROLL_OBLIGATIONS_SQL = `SELECT r.id,
  r.run_no AS "runNo",
  r.branch_id AS "branchId",
  r.period_key AS "periodKey",
  r.run_date_ad::text AS "runDateAD",
  r.net_total::numeric AS "netTotal",
  r.status
FROM payroll_runs r
WHERE r.status IN ('APPROVED', 'POSTED')
  AND r.paid_journal_id IS NULL
  AND r.net_total > 0
  AND ($1::varchar IS NULL OR r.branch_id = $1)
  AND r.run_date_ad <= $2::date
ORDER BY r.run_date_ad ASC, r.run_no ASC`;

export const CASH_FLOW_PERIODS_IN_RANGE_SQL = `SELECT p.period_key AS "periodKey",
  p.status,
  p.start_date_ad::text AS "startDateAD",
  p.end_date_ad::text AS "endDateAD"
FROM gl_periods p
WHERE p.start_date_ad <= $2::date
  AND p.end_date_ad >= $1::date
ORDER BY p.start_date_ad ASC`;

export const CASH_FLOW_PERIOD_FOR_DATE_SQL = `SELECT p.period_key AS "periodKey",
  p.status
FROM gl_periods p
WHERE $1::date BETWEEN p.start_date_ad AND p.end_date_ad
ORDER BY p.start_date_ad DESC
LIMIT 1`;
