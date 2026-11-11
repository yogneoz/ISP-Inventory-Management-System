/**
 * Aggregate reads for the People & HR workforce report.
 *
 * This is deliberately a reporting layer over the existing employee and leave
 * ledger: it stores nothing, writes nothing and returns no employee PII. The
 * controller supplies the session's branch scope; the SQL only filters it.
 *
 * Attrition uses the stored `employees.separation_date_ad` only. `is_active`
 * and mutable `updated_at` are never exit-date proxies. The rate denominator
 * is the period-start headcount among employees with a recorded joining date;
 * the controller returns a null rate with a reason when that baseline is
 * incomplete instead of estimating one.
 *
 * Leave liability is a CURRENT-YEAR DAY balance, not a money amount. Entitlement
 * and adjustment are stored on `hr_leave_balances`; used days are derived from
 * APPROVED requests in the same calendar year, exactly as the leave register
 * does. Inactive employees are excluded so the figure covers the current
 * workforce, and the response exposes the balance year so the scope is clear.
 */

export const HR_REPORTS_BALANCE_YEAR_SQL = `SELECT
  EXTRACT(YEAR FROM CURRENT_DATE)::int AS "balanceYear"`;

export const HR_REPORTS_HEADCOUNT_SQL = `SELECT
  e.branch_id AS "branchId",
  COALESCE(b.name, e.branch_id) AS "branchName",
  COALESCE(NULLIF(BTRIM(e.department), ''), 'Unassigned') AS "department",
  COUNT(*)::int AS "count"
FROM employees e
LEFT JOIN branches b ON b.id = e.branch_id
WHERE e.is_active = TRUE
  AND ($1::varchar[] IS NULL OR e.branch_id = ANY($1::varchar[]))
GROUP BY e.branch_id, b.name, e.department
ORDER BY COALESCE(b.name, e.branch_id) ASC,
         COALESCE(NULLIF(BTRIM(e.department), ''), 'Unassigned') ASC`;

export const HR_REPORTS_ATTRITION_BY_BRANCH_SQL = `SELECT
  e.branch_id AS "branchId",
  COALESCE(b.name, e.branch_id) AS "branchName",
  COUNT(*) FILTER (
    WHERE e.separation_date_ad BETWEEN $1::date AND $2::date
  )::int AS "separations",
  COUNT(*) FILTER (
    WHERE e.joining_date_ad IS NOT NULL
      AND e.joining_date_ad <= $1::date
      AND (e.separation_date_ad IS NULL OR e.separation_date_ad >= $1::date)
  )::int AS "headcountAtStart",
  COUNT(*) FILTER (
    WHERE e.joining_date_ad IS NULL
      AND (e.separation_date_ad IS NULL OR e.separation_date_ad >= $1::date)
  )::int AS "unknownJoiningCount"
FROM employees e
LEFT JOIN branches b ON b.id = e.branch_id
WHERE ($3::varchar[] IS NULL OR e.branch_id = ANY($3::varchar[]))
GROUP BY e.branch_id, b.name
ORDER BY COALESCE(b.name, e.branch_id) ASC, e.branch_id ASC`;

export const HR_REPORTS_LEAVE_LIABILITY_SQL = `SELECT
  t.id AS "leaveTypeId",
  t.code AS "leaveTypeCode",
  t.name AS "leaveTypeName",
  t.is_paid AS "leaveTypePaid",
  COUNT(DISTINCT b.employee_id)::int AS "employeeCount",
  COALESCE(SUM(b.entitlement_days), 0)::numeric AS "entitlementDays",
  COALESCE(SUM(b.adjustment_days), 0)::numeric AS "adjustmentDays",
  COALESCE(SUM(COALESCE(u.used_days, 0)), 0)::numeric AS "usedDays",
  COALESCE(
    SUM(b.entitlement_days + b.adjustment_days - COALESCE(u.used_days, 0)),
    0
  )::numeric AS "remainingDays"
FROM hr_leave_balances b
JOIN employees e ON e.id = b.employee_id AND e.is_active = TRUE
JOIN hr_leave_types t ON t.id = b.leave_type_id
LEFT JOIN LATERAL (
  SELECT SUM(r.days_count) AS used_days
  FROM hr_leave_requests r
  WHERE r.employee_id = b.employee_id
    AND r.leave_type_id = b.leave_type_id
    AND r.status = 'APPROVED'
    AND EXTRACT(YEAR FROM r.start_date_ad)::int = b.balance_year
) u ON TRUE
WHERE b.balance_year = EXTRACT(YEAR FROM CURRENT_DATE)::int
  -- Scope by the employee's current branch, not a possibly stale balance
  -- branch snapshot, so a transferred employee's liability follows them.
  AND ($1::varchar[] IS NULL OR e.branch_id = ANY($1::varchar[]))
GROUP BY t.id, t.code, t.name, t.is_paid
ORDER BY t.name ASC, t.id ASC`;

/**
 * Payroll-cost aggregates from POSTED/PAID run lines only. Draft and approved
 * runs are working papers, not committed payroll, so counting them would turn
 * an editable estimate into a reported cost. All amounts are the immutable
 * line snapshots the payroll output/register already reads.
 *
 * `allowances` is the same residual the payslip uses: gross less basic,
 * overtime, incentive and arrears, plus the LOP deduction that reduced basic.
 * `deductions` is employee-side TDS + SSF + advances + loans; employer SSF is
 * deliberately excluded here and reported by the statutory filing aggregate.
 */
export const HR_REPORTS_PAYROLL_COST_BY_BRANCH_SQL = `SELECT
  r.branch_id AS "branchId",
  COALESCE(b.name, r.branch_id) AS "branchName",
  COUNT(DISTINCT r.id)::int AS "runCount",
  COUNT(*)::int AS "lineCount",
  COALESCE(SUM(l.gross_amount), 0)::numeric AS "gross",
  COALESCE(SUM(l.basic_amount), 0)::numeric AS "basic",
  COALESCE(SUM(
    l.gross_amount - l.basic_amount - l.overtime_amount - l.incentive_amount
    - l.arrears_amount + l.lop_deduction
  ), 0)::numeric AS "allowances",
  COALESCE(SUM(l.overtime_amount), 0)::numeric AS "overtime",
  COALESCE(SUM(l.incentive_amount), 0)::numeric AS "incentive",
  COALESCE(SUM(l.arrears_amount), 0)::numeric AS "arrears",
  COALESCE(SUM(l.lop_deduction), 0)::numeric AS "lopDeduction",
  COALESCE(SUM(
    l.tds_amount + l.ssf_amount + l.advance_deduction + l.loan_deduction
  ), 0)::numeric AS "deductions",
  COALESCE(SUM(l.net_amount), 0)::numeric AS "net"
FROM payroll_runs r
JOIN payroll_run_lines l ON l.run_id = r.id
LEFT JOIN branches b ON b.id = r.branch_id
WHERE r.status IN ('POSTED', 'PAID')
  AND r.run_date_ad BETWEEN $1::date AND $2::date
  AND ($3::varchar[] IS NULL OR r.branch_id = ANY($3::varchar[]))
GROUP BY r.branch_id, b.name
ORDER BY COALESCE(b.name, r.branch_id) ASC, r.branch_id ASC`;

export const HR_REPORTS_PAYROLL_COST_BY_PERIOD_SQL = `SELECT
  r.period_key AS "periodKey",
  COUNT(DISTINCT r.id)::int AS "runCount",
  COUNT(*)::int AS "lineCount",
  COALESCE(SUM(l.gross_amount), 0)::numeric AS "gross",
  COALESCE(SUM(l.basic_amount), 0)::numeric AS "basic",
  COALESCE(SUM(
    l.gross_amount - l.basic_amount - l.overtime_amount - l.incentive_amount
    - l.arrears_amount + l.lop_deduction
  ), 0)::numeric AS "allowances",
  COALESCE(SUM(l.overtime_amount), 0)::numeric AS "overtime",
  COALESCE(SUM(l.incentive_amount), 0)::numeric AS "incentive",
  COALESCE(SUM(l.arrears_amount), 0)::numeric AS "arrears",
  COALESCE(SUM(l.lop_deduction), 0)::numeric AS "lopDeduction",
  COALESCE(SUM(
    l.tds_amount + l.ssf_amount + l.advance_deduction + l.loan_deduction
  ), 0)::numeric AS "deductions",
  COALESCE(SUM(l.net_amount), 0)::numeric AS "net"
FROM payroll_runs r
JOIN payroll_run_lines l ON l.run_id = r.id
WHERE r.status IN ('POSTED', 'PAID')
  AND r.run_date_ad BETWEEN $1::date AND $2::date
  AND ($3::varchar[] IS NULL OR r.branch_id = ANY($3::varchar[]))
GROUP BY r.period_key
ORDER BY r.period_key ASC`;

/**
 * Overtime is read from the same immutable run-line snapshot that pays it:
 * `overtime_hours` and `overtime_amount` were captured when the run was
 * generated. Current employee department is joined for the grouping label
 * only; a later transfer can move the label but cannot change the stored hours
 * or amount. Rows with neither hours nor pay are omitted rather than shown as
 * zero-overtime employees.
 */
export const HR_REPORTS_OVERTIME_BY_EMPLOYEE_SQL = `SELECT
  l.employee_id AS "employeeId",
  l.employee_code AS "employeeCode",
  l.employee_name AS "employeeName",
  r.branch_id AS "branchId",
  COALESCE(b.name, r.branch_id) AS "branchName",
  COALESCE(NULLIF(BTRIM(e.department), ''), 'Unassigned') AS "department",
  COUNT(*)::int AS "runCount",
  COALESCE(SUM(l.overtime_hours), 0)::numeric AS "overtimeHours",
  COALESCE(SUM(l.overtime_amount), 0)::numeric AS "overtimeAmount"
FROM payroll_runs r
JOIN payroll_run_lines l ON l.run_id = r.id
JOIN employees e ON e.id = l.employee_id
LEFT JOIN branches b ON b.id = r.branch_id
WHERE r.status IN ('POSTED', 'PAID')
  AND r.run_date_ad BETWEEN $1::date AND $2::date
  AND ($3::varchar[] IS NULL OR r.branch_id = ANY($3::varchar[]))
  AND (l.overtime_hours > 0 OR l.overtime_amount > 0)
GROUP BY l.employee_id, l.employee_code, l.employee_name, r.branch_id, b.name, e.department
ORDER BY "overtimeHours" DESC, l.employee_name ASC, l.employee_code ASC
LIMIT 2000`;

/**
 * SSF/TDS filing figures per payroll period, straight from the line columns
 * that payroll calculates and posts. `ssf_amount` is the employee contribution
 * withheld from net pay; `employer_ssf_amount` is the employer share; TDS is
 * `tds_amount`. Using lines rather than the run's `ssf_total` keeps the
 * employee and employer shares distinct.
 */
export const HR_REPORTS_STATUTORY_BY_PERIOD_SQL = `SELECT
  r.period_key AS "periodKey",
  COUNT(*)::int AS "payslipCount",
  COALESCE(SUM(l.ssf_amount), 0)::numeric AS "employeeSsf",
  COALESCE(SUM(l.employer_ssf_amount), 0)::numeric AS "employerSsf",
  COALESCE(SUM(l.tds_amount), 0)::numeric AS "tds"
FROM payroll_runs r
JOIN payroll_run_lines l ON l.run_id = r.id
WHERE r.status IN ('POSTED', 'PAID')
  AND r.run_date_ad BETWEEN $1::date AND $2::date
  AND ($3::varchar[] IS NULL OR r.branch_id = ANY($3::varchar[]))
GROUP BY r.period_key
ORDER BY r.period_key ASC`;
