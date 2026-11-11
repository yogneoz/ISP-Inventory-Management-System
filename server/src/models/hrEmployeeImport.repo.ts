/**
 * SQL for the employee master-sheet import.
 *
 * The importer resolves the sheet's branch and work-station text against real
 * rows rather than creating anything: the plan's mapping rule says a master row
 * must never silently invent a branch. Only the employee-code lookup is needed
 * for idempotency; every write reuses the employee repository.
 */

export interface ImportLookupRow {
  id: string;
  code: string | null;
  name: string;
}

export const HR_IMPORT_BRANCHES_SQL = `SELECT id, code, name
FROM branches
ORDER BY id ASC`;

/** Work stations are the label-only org masters added in slice 4. */
export const HR_IMPORT_WORK_STATIONS_SQL = `SELECT id, code, name
FROM hr_org_masters
WHERE kind = 'WORK_STATION'
ORDER BY LOWER(name) ASC, id ASC`;

/** `$1` is a text[] of normalized employee codes. */
export const HR_IMPORT_EMPLOYEES_BY_CODE_SQL = `SELECT
  id,
  employee_code AS "employeeCode",
  branch_id AS "branchId"
FROM employees
WHERE employee_code = ANY($1::varchar[])`;
