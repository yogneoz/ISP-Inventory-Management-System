/**
 * SQL for the payroll-input projection that closes Phase 1.
 *
 * The figures are DERIVED ON READ from the attendance register and approved
 * leave requests; nothing is materialised, so there is no counter that can
 * drift when a day is corrected or a leave request is cancelled. The model:
 *
 * - One row per active employee in the caller's branch scope (or one employee).
 * - Attendance rows inside the period are the authoritative daily fact. Their
 *   statuses become present / half / absent / leave / holiday / weekend days,
 *   and their recorded overtime hours are summed.
 * - Approved leave only fills calendar days that have NO attendance row. A day
 *   covered by both therefore counts once, on the attendance side.
 * - Approved leave is clipped to the period, so leave that starts before or
 *   ends after the period contributes only its inside days.
 * - A paid leave type adds to payable days; an unpaid type adds to LOP days.
 *   Pending, rejected and cancelled requests contribute nothing.
 * - `payableDays = present + 0.5 × half + attendance leave + holiday + weekend
 *   + paid approved leave`; `lopDays = absent + 0.5 × half + unpaid approved
 *   leave`. Overtime is reported in hours, never folded into days.
 *
 * The projection is read-only: there is no mutation to audit here. The
 * attendance and leave endpoints already write their audit rows in the same
 * transaction as the data this query reads.
 */

export const HR_PAYROLL_INPUT_LIST_SQL = `WITH period AS (
  SELECT $1::date AS from_date, $2::date AS to_date
), emps AS (
  SELECT e.id, e.employee_code, e.name, e.branch_id, b.name AS branch_name
  FROM employees e
  JOIN branches b ON b.id = e.branch_id
  WHERE e.is_active = TRUE
    AND ($3::varchar IS NULL OR e.branch_id = $3)
    AND ($4::varchar[] IS NULL OR e.branch_id = ANY($4::varchar[]))
    AND ($5::varchar IS NULL OR e.id = $5)
), att_days AS (
  SELECT a.employee_id, a.attendance_date_ad, a.status, a.overtime_hours
  FROM hr_attendance a, period p
  WHERE a.attendance_date_ad BETWEEN p.from_date AND p.to_date
), att AS (
  SELECT d.employee_id,
    COUNT(*) FILTER (WHERE d.status = 'PRESENT') AS present_days,
    COUNT(*) FILTER (WHERE d.status = 'HALF_DAY') AS half_days,
    COUNT(*) FILTER (WHERE d.status = 'ABSENT') AS absent_days,
    COUNT(*) FILTER (WHERE d.status = 'LEAVE') AS attendance_leave_days,
    COUNT(*) FILTER (WHERE d.status = 'HOLIDAY') AS holiday_days,
    COUNT(*) FILTER (WHERE d.status = 'WEEKEND') AS weekend_days,
    COALESCE(SUM(d.overtime_hours), 0) AS overtime_hours
  FROM att_days d
  GROUP BY d.employee_id
), leave_overlap AS (
  SELECT r.employee_id, t.is_paid,
    GREATEST(r.start_date_ad, p.from_date) AS overlap_start,
    LEAST(r.end_date_ad, p.to_date) AS overlap_end
  FROM hr_leave_requests r
  JOIN hr_leave_types t ON t.id = r.leave_type_id
  CROSS JOIN period p
  WHERE r.status = 'APPROVED'
    AND r.start_date_ad <= p.to_date
    AND r.end_date_ad >= p.from_date
), leave_counted AS (
  SELECT l.employee_id, l.is_paid,
    SUM(
      (l.overlap_end - l.overlap_start + 1)
      - (SELECT COUNT(*)
           FROM att_days d
          WHERE d.employee_id = l.employee_id
            AND d.attendance_date_ad BETWEEN l.overlap_start AND l.overlap_end)
    ) AS days
  FROM leave_overlap l
  GROUP BY l.employee_id, l.is_paid
), adj AS (
  SELECT a.id, a.employee_id, a.period_key,
    a.incentive_amount, a.arrears_amount, a.advance_amount, a.loan_amount, a.notes
  FROM hr_payroll_adjustments a
  WHERE a.period_key = $6
)
SELECT e.id AS "employeeId",
  e.employee_code AS "employeeCode",
  e.name AS "employeeName",
  e.branch_id AS "branchId",
  e.branch_name AS "branchName",
  COALESCE(att.present_days, 0)::numeric AS "presentDays",
  COALESCE(att.half_days, 0)::numeric AS "halfDays",
  COALESCE(att.absent_days, 0)::numeric AS "absentDays",
  COALESCE(att.attendance_leave_days, 0)::numeric AS "attendanceLeaveDays",
  COALESCE(att.holiday_days, 0)::numeric AS "holidayDays",
  COALESCE(att.weekend_days, 0)::numeric AS "weekendDays",
  COALESCE(att.overtime_hours, 0)::numeric AS "overtimeHours",
  adj.id AS "adjustmentId",
  adj.period_key AS "adjustmentPeriodKey",
  COALESCE(adj.incentive_amount, 0)::numeric AS "incentiveAmount",
  COALESCE(adj.arrears_amount, 0)::numeric AS "arrearsAmount",
  COALESCE(adj.advance_amount, 0)::numeric AS "advanceAmount",
  COALESCE(adj.loan_amount, 0)::numeric AS "loanAmount",
  adj.notes AS "adjustmentNotes",
  COALESCE(paid.days, 0)::numeric AS "paidLeaveDays",
  COALESCE(unpaid.days, 0)::numeric AS "unpaidLeaveDays",
  (COALESCE(att.present_days, 0)
    + COALESCE(att.half_days, 0) * 0.5
    + COALESCE(att.attendance_leave_days, 0)
    + COALESCE(att.holiday_days, 0)
    + COALESCE(att.weekend_days, 0)
    + COALESCE(paid.days, 0))::numeric AS "payableDays",
  (COALESCE(att.absent_days, 0)
    + COALESCE(att.half_days, 0) * 0.5
    + COALESCE(unpaid.days, 0))::numeric AS "lopDays"
FROM emps e
LEFT JOIN att ON att.employee_id = e.id
LEFT JOIN leave_counted paid ON paid.employee_id = e.id AND paid.is_paid = TRUE
LEFT JOIN leave_counted unpaid ON unpaid.employee_id = e.id AND unpaid.is_paid = FALSE
LEFT JOIN adj ON adj.employee_id = e.id
ORDER BY e.employee_code ASC
LIMIT 2000`;

/** The generated-run read: one adjustment row per employee in the branch. */
export const HR_PAYROLL_ADJUSTMENTS_BY_BRANCH_PERIOD_SQL = `SELECT
  a.employee_id AS "employeeId",
  a.incentive_amount::numeric AS "incentiveAmount",
  a.arrears_amount::numeric AS "arrearsAmount",
  a.advance_amount::numeric AS "advanceAmount",
  a.loan_amount::numeric AS "loanAmount"
FROM hr_payroll_adjustments a
JOIN employees e ON e.id = a.employee_id
WHERE a.period_key = $1 AND e.branch_id = $2
ORDER BY e.employee_code ASC`;

/**
 * One row per employee + month. The upsert is intentional: a correction before
 * the draft is generated replaces the input rather than stacking a second row.
 */
export const HR_PAYROLL_ADJUSTMENT_UPSERT_SQL = `INSERT INTO hr_payroll_adjustments (
  id, employee_id, period_key, incentive_amount, arrears_amount, advance_amount,
  loan_amount, notes, is_demo, created_by, updated_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, $9, $9)
ON CONFLICT (employee_id, period_key) DO UPDATE SET
  incentive_amount = EXCLUDED.incentive_amount,
  arrears_amount = EXCLUDED.arrears_amount,
  advance_amount = EXCLUDED.advance_amount,
  loan_amount = EXCLUDED.loan_amount,
  notes = EXCLUDED.notes,
  updated_by = EXCLUDED.updated_by,
  updated_at = CURRENT_TIMESTAMP
RETURNING id,
  employee_id AS "employeeId",
  period_key AS "periodKey",
  incentive_amount::numeric AS "incentiveAmount",
  arrears_amount::numeric AS "arrearsAmount",
  advance_amount::numeric AS "advanceAmount",
  loan_amount::numeric AS "loanAmount",
  notes,
  updated_at AS "updatedAt"`;
