/**
 * SQL for the Phase 2 effective-dated salary structure.
 *
 * `hr_employee_salary` is the header: one row per employee and effective date.
 * A newer row supersedes an older one from its `effective_from`; history is
 * retained so payroll for an earlier period can still resolve the structure
 * that was in force then. `hr_salary_components` holds the amount lines
 * (BASIC/HRA and any additional earning, deduction or employer contribution).
 *
 * The branch lives on the header (derived from the employee by the controller),
 * so every list intersects the caller's allowed branches and the by-id route is
 * registered in the branch-scope middleware.
 */

export const HR_SALARY_COMPONENT_KINDS = [
  'EARNING',
  'DEDUCTION',
  'EMPLOYER_CONTRIBUTION',
] as const;
export type HrSalaryComponentKind = (typeof HR_SALARY_COMPONENT_KINDS)[number];

export const HR_SALARY_HEADER_COLUMNS = `s.id,
  s.employee_id AS "employeeId",
  e.employee_code AS "employeeCode",
  e.name AS "employeeName",
  s.branch_id AS "branchId",
  b.name AS "branchName",
  s.effective_from::text AS "effectiveFrom",
  s.ssf_eligible AS "ssfEligible",
  s.overtime_rate::numeric AS "overtimeRate",
  s.tds_monthly::numeric AS "tdsMonthly",
  s.notes,
  s.created_by AS "createdBy",
  s.updated_by AS "updatedBy",
  s.created_at AS "createdAt",
  s.updated_at AS "updatedAt"`;

const HR_SALARY_FROM = `FROM hr_employee_salary s
JOIN employees e ON e.id = s.employee_id
JOIN branches b ON b.id = s.branch_id`;

/**
 * Full history, newest effective date first per employee. Used when the caller
 * wants every revision (the UI's "show history" mode).
 */
export const HR_SALARY_LIST_SQL = `SELECT ${HR_SALARY_HEADER_COLUMNS}
${HR_SALARY_FROM}
WHERE ($1::varchar IS NULL OR s.branch_id = $1)
  AND ($2::varchar[] IS NULL OR s.branch_id = ANY($2::varchar[]))
  AND ($3::varchar IS NULL OR s.employee_id = $3)
ORDER BY e.employee_code ASC, s.effective_from DESC, s.id ASC
LIMIT 500`;

/**
 * One row per employee: the newest structure whose effective date is on or
 * before the as-of date. This is the payroll-resolution query.
 */
export const HR_SALARY_EFFECTIVE_LIST_SQL = `WITH latest AS (
  SELECT DISTINCT ON (s.employee_id) s.*
  FROM hr_employee_salary s
  WHERE ($1::varchar IS NULL OR s.branch_id = $1)
    AND ($2::varchar[] IS NULL OR s.branch_id = ANY($2::varchar[]))
    AND ($3::varchar IS NULL OR s.employee_id = $3)
    AND s.effective_from <= $4::date
  ORDER BY s.employee_id, s.effective_from DESC, s.id DESC
)
SELECT ${HR_SALARY_HEADER_COLUMNS}
FROM latest s
JOIN employees e ON e.id = s.employee_id
JOIN branches b ON b.id = s.branch_id
ORDER BY e.employee_code ASC, s.effective_from DESC
LIMIT 500`;

export const HR_SALARY_BY_ID_SQL = `SELECT ${HR_SALARY_HEADER_COLUMNS}
${HR_SALARY_FROM}
WHERE s.id = $1
LIMIT 1`;

export const HR_SALARY_EMPLOYEE_BY_ID_SQL = `SELECT
  id,
  employee_code AS "employeeCode",
  name,
  branch_id AS "branchId",
  is_active AS "isActive",
  ssf_eligible AS "ssfEligible"
FROM employees
WHERE id = $1
LIMIT 1`;

export const HR_SALARY_INSERT_SQL = `INSERT INTO hr_employee_salary (
  id, employee_id, branch_id, effective_from, ssf_eligible, overtime_rate,
  tds_monthly, notes, is_demo, created_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, $9)
RETURNING id`;

export const HR_SALARY_UPDATE_SQL = `UPDATE hr_employee_salary SET
  ssf_eligible = $2,
  overtime_rate = $3,
  tds_monthly = $4,
  notes = $5,
  updated_by = $6,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

export const HR_SALARY_COMPONENT_COLUMNS = `id,
  salary_id AS "salaryId",
  component_code AS "componentCode",
  component_name AS "componentName",
  kind,
  amount::numeric AS amount,
  is_taxable AS "isTaxable",
  is_ssf_applicable AS "isSsfApplicable",
  sort_order AS "sortOrder"`;

export const HR_SALARY_COMPONENTS_BY_SALARY_IDS_SQL = `SELECT ${HR_SALARY_COMPONENT_COLUMNS}
FROM hr_salary_components
WHERE salary_id = ANY($1::varchar[])
ORDER BY salary_id ASC, sort_order ASC, component_code ASC`;

export const HR_SALARY_COMPONENT_INSERT_SQL = `INSERT INTO hr_salary_components (
  id, salary_id, component_code, component_name, kind, amount,
  is_taxable, is_ssf_applicable, sort_order
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id`;

export const HR_SALARY_COMPONENTS_DELETE_SQL = `DELETE FROM hr_salary_components
WHERE salary_id = $1
RETURNING id`;
