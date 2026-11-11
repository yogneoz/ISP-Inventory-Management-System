/**
 * Recurring-journal and month-end-close persistence.
 *
 * A template is branch-owned; its lines are formulas, never pre-computed
 * amounts. The generated journal goes through the shared balanced-journal
 * service. `gl_recurring_runs` is the idempotency ledger: its unique
 * (template_id, run_date) key is what makes a second run for the same due date
 * return the first journal instead of posting again.
 *
 * Close tasks are company-wide because a period is company-wide. The default
 * templates are copied into a period on first read/close, then every status,
 * owner, note and evidence change is a normal row update with an audit event.
 */

const TEMPLATE_HEADER_SQL = `SELECT t.id,
  t.code,
  t.name,
  t.description,
  t.branch_id AS "branchId",
  b.code AS "branchCode",
  b.name AS "branchName",
  t.frequency,
  t.start_date_ad::text AS "startDateAD",
  t.end_date_ad::text AS "endDateAD",
  t.next_run_date::text AS "nextRunDate",
  t.last_run_date::text AS "lastRunDate",
  t.last_journal_id AS "lastJournalId",
  t.active,
  t.created_by AS "createdBy",
  t.updated_by AS "updatedBy",
  t.created_at AS "createdAt",
  t.updated_at AS "updatedAt"
FROM gl_recurring_templates t
JOIN branches b ON b.id = t.branch_id`;

export const RECURRING_TEMPLATE_LIST_SQL = `${TEMPLATE_HEADER_SQL},
  (SELECT COUNT(*)::int FROM gl_recurring_template_lines l WHERE l.template_id = t.id) AS "lineCount",
  (SELECT COUNT(*)::int FROM gl_recurring_runs r WHERE r.template_id = t.id) AS "runCount"
WHERE ($1::varchar IS NULL OR t.branch_id = $1)
ORDER BY t.active DESC, t.next_run_date ASC, t.code ASC`;

export const RECURRING_TEMPLATE_BY_ID_SQL = `${TEMPLATE_HEADER_SQL}
WHERE t.id = $1`;

export const RECURRING_TEMPLATE_LOCK_SQL = `${TEMPLATE_HEADER_SQL}
WHERE t.id = $1
FOR UPDATE`;

export const RECURRING_LINES_SQL = `SELECT l.id,
  l.template_id AS "templateId",
  l.line_no AS "lineNo",
  l.account_id AS "accountId",
  a.code AS "accountCode",
  a.name AS "accountName",
  a.is_control AS "isControl",
  a.subledger_type AS "subledgerType",
  a.is_active AS "accountActive",
  l.side,
  l.amount_formula AS "amountFormula",
  l.memo,
  l.party_id AS "partyId",
  l.party_name AS "partyName",
  l.cost_center_id AS "costCenterId",
  c.code AS "costCenterCode",
  c.name AS "costCenterName"
FROM gl_recurring_template_lines l
JOIN gl_accounts a ON a.id = l.account_id
LEFT JOIN cost_centers c ON c.id = l.cost_center_id
WHERE l.template_id = $1
ORDER BY l.line_no ASC`;

export const RECURRING_TEMPLATE_INSERT_SQL = `INSERT INTO gl_recurring_templates (
  id, code, name, description, branch_id, frequency, start_date_ad, end_date_ad,
  next_run_date, active, created_by, updated_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`;

export const RECURRING_TEMPLATE_UPDATE_SQL = `UPDATE gl_recurring_templates SET
  name = $2,
  description = $3,
  frequency = $4,
  start_date_ad = $5,
  end_date_ad = $6,
  next_run_date = $7,
  active = $8,
  updated_by = $9,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;

export const RECURRING_TEMPLATE_AFTER_RUN_SQL = `UPDATE gl_recurring_templates SET
  next_run_date = $2,
  last_run_date = $3,
  last_journal_id = $4,
  active = CASE
    WHEN $5::boolean = TRUE AND end_date_ad IS NOT NULL AND $2::date > end_date_ad THEN FALSE
    ELSE active
  END,
  updated_by = $6,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;

export const RECURRING_TEMPLATE_DELETE_SQL = `DELETE FROM gl_recurring_templates WHERE id = $1`;

export const RECURRING_LINE_DELETE_SQL = `DELETE FROM gl_recurring_template_lines WHERE template_id = $1`;

export const RECURRING_LINE_INSERT_SQL = `INSERT INTO gl_recurring_template_lines (
  id, template_id, line_no, account_id, side, amount_formula, memo,
  party_id, party_name, cost_center_id
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

export const RECURRING_RUN_BY_DATE_SQL = `SELECT r.id,
  r.run_date::text AS "runDate",
  r.journal_id AS "journalId",
  j.journal_no AS "journalNo",
  j.journal_date_ad::text AS "journalDateAD",
  j.status AS "journalStatus",
  j.source_type AS "sourceType",
  j.source_id AS "sourceId"
FROM gl_recurring_runs r
JOIN gl_journals j ON j.id = r.journal_id
WHERE r.template_id = $1 AND r.run_date = $2::date`;

export const RECURRING_RUN_INSERT_SQL = `INSERT INTO gl_recurring_runs (
  id, template_id, run_date, journal_id, generated_by
) VALUES ($1, $2, $3, $4, $5)`;

export const RECURRING_RUN_COUNT_SQL = `SELECT COUNT(*)::int AS count
FROM gl_recurring_runs WHERE template_id = $1`;

export const RECURRING_PERIOD_FOR_DATE_SQL = `SELECT p.id,
  p.period_key AS "periodKey",
  p.status,
  p.start_date_ad::text AS "startDateAD",
  p.end_date_ad::text AS "endDateAD",
  fy.code AS "fiscalYearCode"
FROM gl_periods p
JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
WHERE $1::date BETWEEN p.start_date_ad AND p.end_date_ad
ORDER BY p.start_date_ad DESC
LIMIT 1`;

const CLOSE_PERIOD_SQL = `SELECT p.id,
  p.fiscal_year_id AS "fiscalYearId",
  fy.code AS "fiscalYearCode",
  p.period_key AS "periodKey",
  p.start_date_ad::text AS "startDateAD",
  p.start_date_bs AS "startDateBS",
  p.end_date_ad::text AS "endDateAD",
  p.end_date_bs AS "endDateBS",
  p.status,
  p.closed_at AS "closedAt",
  p.closed_by AS "closedBy"
FROM gl_periods p
JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
WHERE p.id = $1`;

export const CLOSE_PERIOD_BY_ID_SQL = CLOSE_PERIOD_SQL;

export const CLOSE_PERIOD_LOCK_SQL = `${CLOSE_PERIOD_SQL}
FOR UPDATE`;

export const CLOSE_ITEM_ENSURE_SQL = `INSERT INTO gl_close_checklist_items (
  id, period_id, task_code, title, required, sort_order
)
SELECT 'glci-' || md5($1 || ':' || t.code), $1, t.code, t.title, t.required, t.sort_order
FROM gl_close_task_templates t
WHERE t.active = TRUE
ON CONFLICT (period_id, task_code) DO NOTHING`;

export const CLOSE_ITEMS_SQL = `SELECT i.id,
  i.period_id AS "periodId",
  i.task_code AS "taskCode",
  i.title,
  i.required,
  i.sort_order AS "sortOrder",
  i.status,
  i.owner,
  i.note,
  i.evidence_url AS "evidenceUrl",
  i.completed_at AS "completedAt",
  i.completed_by AS "completedBy",
  i.updated_by AS "updatedBy",
  i.created_at AS "createdAt",
  i.updated_at AS "updatedAt"
FROM gl_close_checklist_items i
WHERE i.period_id = $1
ORDER BY i.sort_order ASC, i.task_code ASC`;

export const CLOSE_ITEM_BY_ID_SQL = `SELECT i.id,
  i.period_id AS "periodId",
  i.task_code AS "taskCode",
  i.title,
  i.required,
  i.sort_order AS "sortOrder",
  i.status,
  i.owner,
  i.note,
  i.evidence_url AS "evidenceUrl",
  i.completed_at AS "completedAt",
  i.completed_by AS "completedBy",
  i.updated_by AS "updatedBy",
  i.created_at AS "createdAt",
  i.updated_at AS "updatedAt"
FROM gl_close_checklist_items i
WHERE i.period_id = $1 AND i.id = $2`;

export const CLOSE_ITEM_UPDATE_SQL = `UPDATE gl_close_checklist_items SET
  status = $3,
  owner = $4,
  note = $5,
  evidence_url = $6,
  completed_at = CASE WHEN $3::varchar = 'DONE' THEN CURRENT_TIMESTAMP ELSE NULL END,
  completed_by = CASE WHEN $3::varchar = 'DONE' THEN $7::varchar ELSE NULL END,
  updated_by = $7,
  updated_at = CURRENT_TIMESTAMP
WHERE period_id = $1 AND id = $2`;

export const CLOSE_INCOMPLETE_SQL = `SELECT id, task_code AS "taskCode", title
FROM gl_close_checklist_items
WHERE period_id = $1 AND required = TRUE AND status <> 'DONE'
ORDER BY sort_order ASC, task_code ASC`;

export const CLOSE_MARK_LOCK_SQL = `UPDATE gl_close_checklist_items SET
  status = $2,
  completed_at = CASE WHEN $2::varchar = 'DONE' THEN CURRENT_TIMESTAMP ELSE NULL END,
  completed_by = CASE WHEN $2::varchar = 'DONE' THEN $3::varchar ELSE NULL END,
  updated_by = $3,
  updated_at = CURRENT_TIMESTAMP
WHERE period_id = $1 AND task_code = 'LOCK_PERIOD'`;
