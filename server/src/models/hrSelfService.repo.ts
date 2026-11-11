/**
 * Employee self-service reads.
 *
 * The ESS profile is deliberately NOT the employee-master projection: it is
 * keyed by the authenticated account's `user_id`, never by an employee id the
 * caller supplies, and it returns only the fields an employee may see about
 * themselves (no `is_demo`, no audit columns, no unrelated master data).
 * Keeping the SQL here means the no-inline-SQL gate still holds and the
 * projection can be pinned field-by-field by the API suite.
 */

export const HR_SELF_PROFILE_SQL = `SELECT
  e.id,
  e.employee_code AS "employeeCode",
  e.name,
  e.branch_id AS "branchId",
  b.name AS "branchName",
  e.department,
  e.designation,
  e.designation_code AS "designationCode",
  e.employment_type AS "employmentType",
  e.work_station AS "workStation",
  e.joining_date_ad::text AS "joiningDateAD",
  e.contract_expiry_ad::text AS "contractExpiryAD",
  e.date_of_birth_ad::text AS "dateOfBirthAD",
  e.internal_email AS "internalEmail",
  e.personal_email AS "personalEmail",
  e.personal_contact AS "personalContact",
  e.emergency_contact_person AS "emergencyContactPerson",
  e.emergency_contact_number AS "emergencyContactNumber",
  e.address,
  e.pan_number AS "panNumber",
  e.ssf_number AS "ssfNumber",
  e.ssf_eligible AS "ssfEligible",
  e.bank_name AS "bankName",
  e.bank_account AS "bankAccount",
  e.monthly_salary AS "monthlySalary",
  e.is_active AS "isActive",
  e.created_at AS "createdAt",
  e.updated_at AS "updatedAt",
  e.profile_photo AS "profilePhoto"
FROM employees e
LEFT JOIN branches b ON b.id = e.branch_id
WHERE e.user_id = $1
LIMIT 1`;

/**
 * The ONLY write self-service exposes on the employee row.
 *
 * The column list IS the allow-list: contact details, address, emergency
 * contact and the photo belong to the employee. Salary, PAN/SSF ids, bank
 * details, designation and employment terms are absent by construction, so no
 * controller mistake can widen them.
 *
 * `user_id = $8` repeats the ownership check in SQL: even a stale employee id
 * from the session resolution cannot update a record this login does not own.
 */
export const HR_SELF_PROFILE_UPDATE_SQL = `UPDATE employees SET
  personal_contact = $2,
  personal_email = $3,
  address = $4,
  emergency_contact_person = $5,
  emergency_contact_number = $6,
  profile_photo = $7,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND user_id = $8
RETURNING id`;

/**
 * The signed-in employee's own posted/paid payslips. The join starts at
 * `employees.user_id`, so there is no caller-supplied employee id, and the run
 * status filter is in SQL as well as at the route/controller. A left join to
 * the fiscal year keeps a historical run readable when its date predates the
 * seeded calendar; the run-line snapshot remains the only source of figures.
 */
export const HR_SELF_PAYSLIPS_SQL = `SELECT
  l.id,
  l.run_id AS "runId",
  l.employee_id AS "employeeId",
  l.employee_code AS "employeeCode",
  l.employee_name AS "employeeName",
  l.bank_name AS "bankName",
  l.bank_account AS "bankAccount",
  l.period_key AS "periodKey",
  l.basic_amount::numeric AS "basicAmount",
  l.payable_days::numeric AS "payableDays",
  l.lop_days::numeric AS "lopDays",
  l.lop_deduction::numeric AS "lopDeduction",
  l.overtime_hours::numeric AS "overtimeHours",
  l.overtime_amount::numeric AS "overtimeAmount",
  l.incentive_amount::numeric AS "incentive",
  l.arrears_amount::numeric AS "arrears",
  l.gross_amount::numeric AS "gross",
  l.tds_amount::numeric AS "tds",
  l.ssf_amount::numeric AS "ssf",
  l.employer_ssf_amount::numeric AS "employerSsf",
  l.advance_deduction::numeric AS "advance",
  l.loan_deduction::numeric AS "loan",
  l.net_amount::numeric AS "net",
  r.run_no AS "runNo",
  r.branch_id AS "runBranchId",
  b.name AS "branchName",
  r.period_key AS "runPeriodKey",
  r.run_date_ad::text AS "runDateAD",
  r.run_date_bs AS "runDateBS",
  r.paid_date_ad::text AS "paidDateAD",
  r.payment_method AS "paymentMethod",
  r.status,
  fy.code AS "fiscalYearCode"
FROM employees e
JOIN payroll_run_lines l ON l.employee_id = e.id
JOIN payroll_runs r ON r.id = l.run_id
LEFT JOIN branches b ON b.id = r.branch_id
LEFT JOIN fiscal_years fy
  ON r.run_date_ad >= fy.start_date_ad AND r.run_date_ad <= fy.end_date_ad
WHERE e.user_id = $1
  AND r.status IN ('POSTED', 'PAID')
ORDER BY r.run_date_ad DESC, r.run_no DESC, l.id DESC`;

/**
 * The signed-in employee's own leave balances. Usage is derived from APPROVED
 * requests in the same year, exactly like the HR register, so a rejected or
 * cancelled request can never leave a stale used-days counter behind. The join
 * starts at `employees.user_id`; there is no caller-supplied employee filter.
 */
export const HR_SELF_LEAVE_BALANCES_SQL = `SELECT
  b.id,
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
  b.updated_at AS "updatedAt"
FROM employees e
JOIN hr_leave_balances b ON b.employee_id = e.id
JOIN hr_leave_types t ON t.id = b.leave_type_id
LEFT JOIN LATERAL (
  SELECT SUM(r.days_count) AS used_days
  FROM hr_leave_requests r
  WHERE r.employee_id = b.employee_id
    AND r.leave_type_id = b.leave_type_id
    AND r.status = 'APPROVED'
    AND EXTRACT(YEAR FROM r.start_date_ad)::int = b.balance_year
) u ON TRUE
WHERE e.user_id = $1
ORDER BY b.balance_year DESC, t.name ASC, b.id ASC`;

/**
 * The signed-in employee's own leave request history, including pending,
 * rejected and cancelled rows. It is read-only: request creation and decisions
 * stay on the HR attendance/leave routes, never on self-service.
 */
export const HR_SELF_LEAVE_REQUESTS_SQL = `SELECT
  r.id,
  r.request_no AS "requestNo",
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
  r.created_at AS "createdAt",
  r.updated_at AS "updatedAt"
FROM employees e
JOIN hr_leave_requests r ON r.employee_id = e.id
JOIN hr_leave_types t ON t.id = r.leave_type_id
WHERE e.user_id = $1
ORDER BY r.start_date_ad DESC, r.id ASC
LIMIT 2000`;

/**
 * Employee self-service attendance is deliberately recent-only: the screen is
 * a personal summary, not the HR register. The window is the rolling 90
 * calendar days ending today (today and the previous 89 days), so an old
 * attendance problem cannot turn this into an unbounded history read. The
 * hard row cap is a second bound because an employee can have at most one row
 * per day.
 */
export const HR_SELF_ATTENDANCE_WINDOW_DAYS = 90;
export const HR_SELF_ATTENDANCE_MAX_RECORDS = 366;

export const HR_SELF_ATTENDANCE_WINDOW_SQL = `SELECT
  CURRENT_DATE::text AS "windowEndAD",
  (CURRENT_DATE - ($1::int - 1))::text AS "windowStartAD"`;

export const HR_SELF_ATTENDANCE_SQL = `SELECT
  a.id,
  a.attendance_date_ad::text AS "attendanceDateAD",
  a.attendance_date_bs AS "attendanceDateBS",
  a.shift_id AS "shiftId",
  s.code AS "shiftCode",
  s.name AS "shiftName",
  a.status,
  to_char(a.check_in_time, 'HH24:MI') AS "checkInTime",
  to_char(a.check_out_time, 'HH24:MI') AS "checkOutTime",
  a.overtime_hours::numeric AS "overtimeHours",
  a.notes,
  a.source,
  a.updated_at AS "updatedAt"
FROM employees e
JOIN hr_attendance a ON a.employee_id = e.id
LEFT JOIN hr_shifts s ON s.id = a.shift_id
WHERE e.user_id = $1
  AND a.attendance_date_ad >= CURRENT_DATE - ($2::int - 1)
  AND a.attendance_date_ad <= CURRENT_DATE
ORDER BY a.attendance_date_ad DESC, a.id ASC
LIMIT ${HR_SELF_ATTENDANCE_MAX_RECORDS}`;

/**
 * Employee self-service documents. The vault has an expiry date but no issue
 * date column; `issuedOnAD` is therefore an explicit null rather than using
 * the upload timestamp as a fabricated issue date. The content URL is added by
 * the controller and points at the existing authenticated vault route, whose
 * own-record check is enforced there as well as here.
 */
export const HR_SELF_DOCUMENT_EXPIRY_SOON_DAYS = 30;

export const HR_SELF_DOCUMENTS_SQL = `SELECT
  d.id,
  d.doc_type AS "docType",
  d.original_name AS "title",
  d.mime_type AS "mimeType",
  d.byte_size AS "byteSize",
  NULL::text AS "issuedOnAD",
  d.expires_on_ad::text AS "expiresOnAD",
  CASE
    WHEN d.expires_on_ad IS NULL THEN 'NO_EXPIRY'
    WHEN d.expires_on_ad < CURRENT_DATE THEN 'EXPIRED'
    WHEN d.expires_on_ad <= CURRENT_DATE + ${HR_SELF_DOCUMENT_EXPIRY_SOON_DAYS} THEN 'EXPIRING'
    ELSE 'VALID'
  END AS "expiryStatus",
  d.created_at AS "uploadedAt",
  d.notes,
  d.uploaded_by AS "uploadedBy"
FROM employees e
JOIN hr_employee_documents d ON d.employee_id = e.id
WHERE e.user_id = $1
ORDER BY d.created_at DESC, d.id ASC
LIMIT 100`;
