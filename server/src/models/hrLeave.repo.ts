/**
 * SQL for the Phase 1 leave ledger.
 *
 * A balance row stores only entitlement and adjustment for one employee +
 * leave type + calendar year. Usage is derived from APPROVED requests, so the
 * approve/reject/cancel transitions cannot leave a separate "used" counter out
 * of step: rejecting or cancelling a request simply stops contributing days.
 *
 * Requests are branch custody like attendance: the controller intersects the
 * caller's allowed branches on every list and refuses a write outside them. A
 * pending or approved request blocks an overlapping request for the same
 * employee; rejected/cancelled rows stay as history and block nothing.
 */

export const HR_LEAVE_REQUEST_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type HrLeaveRequestStatus = (typeof HR_LEAVE_REQUEST_STATUSES)[number];

export const HR_LEAVE_BALANCE_COLUMNS = `b.id,
  b.employee_id AS "employeeId",
  e.employee_code AS "employeeCode",
  e.name AS "employeeName",
  b.branch_id AS "branchId",
  br.name AS "branchName",
  b.leave_type_id AS "leaveTypeId",
  t.code AS "leaveTypeCode",
  t.name AS "leaveTypeName",
  t.is_paid AS "leaveTypePaid",
  b.balance_year AS "balanceYear",
  b.entitlement_days::numeric AS "entitlementDays",
  b.adjustment_days::numeric AS "adjustmentDays",
  COALESCE(u.used_days, 0)::numeric AS "usedDays",
  (b.entitlement_days + b.adjustment_days - COALESCE(u.used_days, 0))::numeric AS "remainingDays",
  b.notes,
  b.created_at AS "createdAt",
  b.updated_at AS "updatedAt"`;

const HR_LEAVE_BALANCE_FROM = `FROM hr_leave_balances b
JOIN employees e ON e.id = b.employee_id
JOIN branches br ON br.id = b.branch_id
JOIN hr_leave_types t ON t.id = b.leave_type_id
LEFT JOIN LATERAL (
  SELECT SUM(r.days_count) AS used_days
  FROM hr_leave_requests r
  WHERE r.employee_id = b.employee_id
    AND r.leave_type_id = b.leave_type_id
    AND r.status = 'APPROVED'
    AND EXTRACT(YEAR FROM r.start_date_ad)::int = b.balance_year
) u ON TRUE`;

export const HR_LEAVE_BALANCE_LIST_SQL = `SELECT ${HR_LEAVE_BALANCE_COLUMNS}
${HR_LEAVE_BALANCE_FROM}
WHERE ($1::varchar IS NULL OR b.branch_id = $1)
  AND ($2::varchar[] IS NULL OR b.branch_id = ANY($2::varchar[]))
  AND ($3::integer IS NULL OR b.balance_year = $3)
  AND ($4::varchar IS NULL OR b.employee_id = $4)
  AND ($5::varchar IS NULL OR b.leave_type_id = $5)
ORDER BY b.balance_year DESC, e.employee_code ASC, t.name ASC, b.id ASC
LIMIT 2000`;

export const HR_LEAVE_BALANCE_BY_ID_SQL = `SELECT ${HR_LEAVE_BALANCE_COLUMNS}
${HR_LEAVE_BALANCE_FROM}
WHERE b.id = $1
LIMIT 1`;

/** Locks the balance row an approval is about to spend against. */
export const HR_LEAVE_BALANCE_BY_KEY_LOCK_SQL = `SELECT
  id,
  entitlement_days::numeric AS "entitlementDays",
  adjustment_days::numeric AS "adjustmentDays"
FROM hr_leave_balances
WHERE employee_id = $1 AND leave_type_id = $2 AND balance_year = $3
FOR UPDATE`;

export const HR_LEAVE_BALANCE_INSERT_SQL = `INSERT INTO hr_leave_balances (
  id, employee_id, branch_id, leave_type_id, balance_year, entitlement_days,
  adjustment_days, notes, is_demo, created_by, updated_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, $9, $9)
RETURNING id`;

export const HR_LEAVE_BALANCE_UPDATE_SQL = `UPDATE hr_leave_balances SET
  entitlement_days = $2,
  adjustment_days = $3,
  notes = $4,
  updated_by = $5,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

/** Approved days already spent in a year, used for the approval check. */
export const HR_LEAVE_BALANCE_USED_SQL = `SELECT
  COALESCE(SUM(days_count), 0)::numeric AS "usedDays"
FROM hr_leave_requests
WHERE employee_id = $1
  AND leave_type_id = $2
  AND status = 'APPROVED'
  AND EXTRACT(YEAR FROM start_date_ad)::int = $3`;

export const HR_LEAVE_REQUEST_COLUMNS = `r.id,
  r.request_no AS "requestNo",
  r.employee_id AS "employeeId",
  e.employee_code AS "employeeCode",
  e.name AS "employeeName",
  r.branch_id AS "branchId",
  br.name AS "branchName",
  r.leave_type_id AS "leaveTypeId",
  t.code AS "leaveTypeCode",
  t.name AS "leaveTypeName",
  r.start_date_ad::text AS "startDateAD",
  r.end_date_ad::text AS "endDateAD",
  r.start_date_bs AS "startDateBS",
  r.end_date_bs AS "endDateBS",
  r.days_count::numeric AS "daysCount",
  r.reason,
  r.status,
  r.decided_by AS "decidedBy",
  r.decided_at AS "decidedAt",
  r.decision_note AS "decisionNote",
  r.created_by AS "createdBy",
  r.created_at AS "createdAt",
  r.updated_at AS "updatedAt"`;

const HR_LEAVE_REQUEST_FROM = `FROM hr_leave_requests r
JOIN employees e ON e.id = r.employee_id
JOIN branches br ON br.id = r.branch_id
JOIN hr_leave_types t ON t.id = r.leave_type_id`;

export const HR_LEAVE_REQUEST_LIST_SQL = `SELECT ${HR_LEAVE_REQUEST_COLUMNS}
${HR_LEAVE_REQUEST_FROM}
WHERE ($1::varchar IS NULL OR r.branch_id = $1)
  AND ($2::varchar[] IS NULL OR r.branch_id = ANY($2::varchar[]))
  AND ($3::varchar IS NULL OR r.status = $3)
  AND ($4::varchar IS NULL OR r.employee_id = $4)
  AND ($5::date IS NULL OR r.end_date_ad >= $5)
  AND ($6::date IS NULL OR r.start_date_ad <= $6)
ORDER BY r.start_date_ad DESC, e.employee_code ASC, r.id ASC
LIMIT 2000`;

export const HR_LEAVE_REQUEST_BY_ID_SQL = `SELECT ${HR_LEAVE_REQUEST_COLUMNS}
${HR_LEAVE_REQUEST_FROM}
WHERE r.id = $1
LIMIT 1`;

/** Row lock for a decision; the guarded status update follows in the same tx. */
export const HR_LEAVE_REQUEST_LOCK_SQL = `SELECT
  id,
  status,
  branch_id AS "branchId",
  employee_id AS "employeeId",
  leave_type_id AS "leaveTypeId",
  start_date_ad::text AS "startDateAD",
  end_date_ad::text AS "endDateAD",
  days_count::numeric AS "daysCount"
FROM hr_leave_requests
WHERE id = $1
FOR UPDATE`;

export const HR_LEAVE_REQUEST_OVERLAP_SQL = `SELECT
  id,
  request_no AS "requestNo"
FROM hr_leave_requests
WHERE employee_id = $1
  AND status IN ('PENDING', 'APPROVED')
  AND start_date_ad <= $3
  AND end_date_ad >= $2
LIMIT 1`;

/**
 * Serializes request creation per employee for the transaction, so two
 * simultaneous submits cannot both pass the overlap check. The lock is
 * transaction-scoped and released on commit or rollback.
 */
export const HR_LEAVE_REQUEST_ADVISORY_LOCK_SQL =
  'SELECT pg_advisory_xact_lock(hashtext($1))';

export const HR_LEAVE_REQUEST_INSERT_SQL = `INSERT INTO hr_leave_requests (
  id, request_no, employee_id, branch_id, leave_type_id, start_date_ad,
  end_date_ad, start_date_bs, end_date_bs, days_count, reason, status,
  is_demo, created_by, updated_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING', FALSE, $12, $12)
RETURNING id`;

/**
 * Guarded transition: the current status must be one of `$5`, so two clicks on
 * Approve cannot both write a decision.
 */
export const HR_LEAVE_REQUEST_DECIDE_SQL = `UPDATE hr_leave_requests SET
  status = $2,
  decided_by = $3,
  decided_at = CURRENT_TIMESTAMP,
  decision_note = $4,
  updated_by = $3,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status = ANY($5::varchar[])
RETURNING id`;
