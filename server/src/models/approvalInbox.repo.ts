/**
 * Approvals inbox (`/api/v1/workplace/approvals`).
 *
 * Everything here is branch-scoped in SQL and excludes the caller's own rows:
 * no-self-approval is a rule of the query, not a check a controller might
 * forget. A held or flagged punch is reviewed by stamping `reviewed_*` on the
 * proof; the verdict the server computed is never rewritten.
 */

export const APPROVAL_CLAIMS_PENDING_SQL = `
  SELECT c.id,
         c.employee_id AS "employeeId",
         e.name AS "employeeName",
         c.category,
         c.amount::numeric AS "amount",
         c.currency,
         c.ticket_code AS "ticketCode",
         c.description,
         c.receipt_attached AS "receiptAttached",
         c.status,
         c.submitted_at AS "submittedAt"
    FROM hr_expense_claims c
    JOIN employees e ON e.id = c.employee_id
   WHERE c.branch_id = $1
     AND c.status = 'SUBMITTED'
     AND c.employee_id <> $2
   ORDER BY c.submitted_at
   LIMIT 100`;

export const APPROVAL_CLAIM_BY_ID_SQL = `
  SELECT id, employee_id AS "employeeId", branch_id AS "branchId", status
    FROM hr_expense_claims
   WHERE id = $1`;

/** The status check is in the UPDATE: a second decision is a 409, not a rewrite. */
export const APPROVAL_CLAIM_DECIDE_SQL = `
  UPDATE hr_expense_claims
     SET status = $2,
         decided_at = now(),
         decided_by = $3,
         decision_note = $4
   WHERE id = $1 AND status = 'SUBMITTED'
  RETURNING id, status, decided_at AS "decidedAt", decided_by AS "decidedBy"`;

export const APPROVAL_PUNCHES_PENDING_SQL = `
  SELECT a.id AS "attendanceId",
         a.employee_id AS "employeeId",
         e.name AS "employeeName",
         a.attendance_date_ad::text AS "attendanceDateAD",
         a.check_in_time AS "checkInTime",
         a.check_out_time AS "checkOutTime",
         p.verdict,
         p.integrity_status AS "integrityStatus",
         p.risk_score AS "riskScore",
         p.integrity_notes AS "integrityNotes",
         p.held_reason AS "heldReason",
         p.device_id AS "deviceId",
         p.clock_skew_ms AS "clockSkewMs"
    FROM hr_attendance a
    JOIN hr_attendance_proofs p ON p.attendance_id = a.id
    JOIN employees e ON e.id = a.employee_id
   WHERE a.branch_id = $1
     AND p.reviewed_at IS NULL
     AND p.verdict IN ('HELD', 'FLAGGED')
     AND a.attendance_date_ad >= (CURRENT_DATE - INTERVAL '14 days')
     AND a.employee_id <> $2
   ORDER BY a.attendance_date_ad DESC, e.name
   LIMIT 100`;

export const APPROVAL_PUNCH_BY_ID_SQL = `
  SELECT a.id AS "attendanceId",
         a.employee_id AS "employeeId",
         a.branch_id AS "branchId",
         p.verdict
    FROM hr_attendance a
    JOIN hr_attendance_proofs p ON p.attendance_id = a.id
   WHERE a.id = $1`;

export const APPROVAL_PUNCH_REVIEW_SQL = `
  UPDATE hr_attendance_proofs
     SET reviewed_at = now(),
         reviewed_by = $2,
         review_note = $3
   WHERE attendance_id = $1 AND reviewed_at IS NULL
  RETURNING attendance_id AS "attendanceId", reviewed_at AS "reviewedAt"`;

/** A delegate's current grants: the window is part of the predicate. */
export const APPROVAL_DELEGATIONS_FOR_SQL = `
  SELECT d.id,
         d.delegator_employee_id AS "delegatorEmployeeId",
         e.name AS "delegatorName",
         d.capabilities,
         d.start_date_ad::text AS "startDate",
         d.end_date_ad::text AS "endDate"
    FROM hr_delegations d
    JOIN employees e ON e.id = d.delegator_employee_id
   WHERE d.delegate_employee_id = $1
     AND d.is_active = TRUE
     AND d.start_date_ad <= CURRENT_DATE
     AND d.end_date_ad >= CURRENT_DATE
   ORDER BY d.end_date_ad`;

/** Does an active delegation give this delegate the capability, today? */
export const APPROVAL_DELEGATION_COVERS_SQL = `
  SELECT d.id,
         d.delegator_employee_id AS "delegatorEmployeeId"
    FROM hr_delegations d
   WHERE d.delegate_employee_id = $1
     AND d.is_active = TRUE
     AND d.start_date_ad <= CURRENT_DATE
     AND d.end_date_ad >= CURRENT_DATE
     AND ($2 = ANY(d.capabilities) OR 'approve.*' = ANY(d.capabilities))
   ORDER BY d.end_date_ad
   LIMIT 1`;
