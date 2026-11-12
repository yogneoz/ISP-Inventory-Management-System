/**
 * SQL for the People & HR organisation catalogue.
 *
 * Departments, designations and work stations share one small, typed table.
 * Employees keep their text value when a master is renamed or retired; the
 * stored id is resolved from that text on write, and the unmatched report
 * finds rows whose text no longer names an entry.
 */

import { buildEmployeeWhere, type EmployeeListOptions } from './payroll.repo';

export const HR_ORG_KINDS = ['DEPARTMENT', 'DESIGNATION', 'WORK_STATION'] as const;
export type HrOrgKind = (typeof HR_ORG_KINDS)[number];

export const HR_ORG_MASTER_COLUMNS = `id,
  kind,
  name,
  code,
  is_active AS "isActive",
  is_demo AS "isDemo",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

/** `$1` is an optional kind filter; `$2` true keeps only active rows. */
export const HR_ORG_MASTER_LIST_SQL = `SELECT ${HR_ORG_MASTER_COLUMNS}
FROM hr_org_masters
WHERE ($1::varchar IS NULL OR kind = $1)
  AND ($2::boolean = FALSE OR is_active = TRUE)
ORDER BY
  CASE kind
    WHEN 'DEPARTMENT' THEN 1
    WHEN 'DESIGNATION' THEN 2
    WHEN 'WORK_STATION' THEN 3
    ELSE 4
  END ASC,
  LOWER(name) ASC,
  id ASC
LIMIT 1000`;

export const HR_ORG_MASTER_BY_ID_SQL = `SELECT ${HR_ORG_MASTER_COLUMNS}
FROM hr_org_masters
WHERE id = $1
LIMIT 1`;

export const HR_ORG_MASTER_INSERT_SQL = `INSERT INTO hr_org_masters (
  id, kind, name, code, is_active, is_demo, created_by
) VALUES ($1, $2, $3, $4, $5, FALSE, $6)
RETURNING ${HR_ORG_MASTER_COLUMNS}`;

/**
 * One grouped read for the three tab headcounts. Counting through the stored
 * ids (not the text) means a renamed master keeps its employees counted, and
 * the branch scope is the same one the employee list applies.
 */
export function buildHrOrgHeadcountQuery(opts: EmployeeListOptions = {}) {
  const { whereSql, params } = buildEmployeeWhere(opts);
  return {
    sql: `WITH scoped AS (
  SELECT department_id, designation_id, workstation_id FROM employees${whereSql}
)
SELECT 'DEPARTMENT' AS kind, count(department_id)::int AS count FROM scoped
UNION ALL
SELECT 'DESIGNATION' AS kind, count(designation_id)::int AS count FROM scoped
UNION ALL
SELECT 'WORK_STATION' AS kind, count(workstation_id)::int AS count FROM scoped`,
    params,
  };
}

/**
 * Employees whose stored department/designation/work-station text does not
 * match any catalogue entry — the rows the Org Masters screen can relink.
 * Designations count as matched when either the name or the code agrees, the
 * same rule the write path uses. Branch scope comes from the shared employee
 * WHERE, so the report never shows another branch's staff. The union is wrapped
 * because ORDER BY on a union may only name result columns, not expressions.
 */
export function buildHrOrgUnmatchedQuery(opts: EmployeeListOptions = {}) {
  const { whereSql, params } = buildEmployeeWhere(opts);
  return {
    sql: `WITH scoped AS (
  SELECT id, employee_code, name, branch_id, department, designation, designation_code,
    work_station, is_active
  FROM employees${whereSql}
)
SELECT * FROM (
  SELECT id AS "employeeId", employee_code AS "employeeCode", name,
    branch_id AS "branchId", 'DEPARTMENT' AS field, department AS value,
    is_active AS "isActive"
  FROM scoped e
  WHERE btrim(e.department) <> ''
    AND NOT EXISTS (
      SELECT 1 FROM hr_org_masters m
      WHERE m.kind = 'DEPARTMENT' AND lower(btrim(m.name)) = lower(btrim(e.department))
    )
  UNION ALL
  SELECT id, employee_code, name, branch_id, 'DESIGNATION', designation, is_active
  FROM scoped e
  WHERE btrim(e.designation) <> ''
    AND NOT EXISTS (
      SELECT 1 FROM hr_org_masters m
      WHERE m.kind = 'DESIGNATION'
        AND (
          lower(btrim(m.name)) = lower(btrim(e.designation))
          OR (m.code IS NOT NULL AND e.designation_code IS NOT NULL
            AND lower(btrim(m.code)) = lower(btrim(e.designation_code)))
        )
    )
  UNION ALL
  SELECT id, employee_code, name, branch_id, 'WORK_STATION', work_station, is_active
  FROM scoped e
  WHERE btrim(e.work_station) <> ''
    AND NOT EXISTS (
      SELECT 1 FROM hr_org_masters m
      WHERE m.kind = 'WORK_STATION' AND lower(btrim(m.name)) = lower(btrim(e.work_station))
    )
) rows
ORDER BY field, lower(value), name
LIMIT 500`,
    params,
  };
}

/**
 * The graded designation catalogue (master sheet). Reporting lines point at a
 * designation id, so a post with no holder is still a node in the tree; the
 * label covers lines that leave the company (Board, Audit Committee).
 */
export const HR_ORG_DESIGNATIONS_SQL = `SELECT m.id,
  m.name,
  m.code,
  p.department_master_id AS "departmentId",
  d.name AS department,
  p.grade,
  g.career_band AS "careerBand",
  g.min_salary AS "bandMin",
  g.max_salary AS "bandMax",
  p.reports_to_master_id AS "reportsToId",
  rt.name AS "reportsTo",
  p.reports_to_label AS "reportsToLabel",
  p.dotted_line_to AS "dottedLineTo",
  p.branch_scope AS "branchScope",
  p.system_role AS "systemRole",
  p.responsibilities,
  p.phase,
  p.role_status AS "roleStatus",
  p.change_note AS "changeNote"
FROM hr_org_masters m
LEFT JOIN hr_designation_profiles p ON p.master_id = m.id
LEFT JOIN hr_salary_grades g ON g.grade = p.grade
LEFT JOIN hr_org_masters d ON d.id = p.department_master_id
LEFT JOIN hr_org_masters rt ON rt.id = p.reports_to_master_id
WHERE m.kind = 'DESIGNATION' AND m.is_active
ORDER BY g.min_salary DESC NULLS LAST, LOWER(m.name) ASC, m.id ASC`;

export const HR_ORG_DEPARTMENTS_SQL = `SELECT m.id,
  m.name,
  m.code,
  p.head_designation_master_id AS "headId",
  h.name AS head,
  p.mandate
FROM hr_org_masters m
LEFT JOIN hr_department_profiles p ON p.master_id = m.id
LEFT JOIN hr_org_masters h ON h.id = p.head_designation_master_id
WHERE m.kind = 'DEPARTMENT' AND m.is_active
ORDER BY LOWER(m.name) ASC, m.id ASC`;

export const HR_SALARY_GRADES_SQL = `SELECT grade,
  career_band AS "careerBand",
  role_tier AS "roleTier",
  min_salary AS "min",
  step1_salary AS "step1",
  step2_salary AS "step2",
  step3_salary AS "step3",
  max_salary AS "max",
  band_spread AS "bandSpread",
  promotion_rule AS "promotionRule"
FROM hr_salary_grades
ORDER BY min_salary DESC, grade ASC`;

export const HR_ORG_CLUSTERS_SQL = `SELECT c.id,
  c.name,
  c.hub,
  c.province,
  c.notes,
  (SELECT count(*)::int FROM hr_branch_plan b WHERE b.cluster_id = c.id) AS "branchCount"
FROM hr_org_clusters c
ORDER BY c.id ASC`;

export const HR_BRANCH_PLAN_SQL = `SELECT b.code,
  b.name,
  b.cluster_id AS "clusterId",
  c.name AS "clusterName",
  b.cluster_hub AS "clusterHub",
  b.province,
  b.tier,
  b.head_designation AS "headDesignation",
  b.branch_id AS "branchId"
FROM hr_branch_plan b
JOIN hr_org_clusters c ON c.id = b.cluster_id
ORDER BY b.code ASC`;

/**
 * Employees for the org chart, with the catalogue designation they resolve to.
 * The join accepts the stored id, the name or the code so seeded and imported
 * rows chart correctly even when the id link was never written.
 */
export function buildHrOrgChartQuery(opts: EmployeeListOptions = {}) {
  const { whereSql, params } = buildEmployeeWhere(opts);
  return {
    sql: `WITH scoped AS (
  SELECT id, employee_code, name, branch_id, department, designation,
    designation_code, designation_id, work_station, is_active, profile_photo
  FROM employees${whereSql}
),
named AS (
  SELECT s.*, b.name AS branch_name
  FROM scoped s
  LEFT JOIN branches b ON b.id = s.branch_id
  WHERE s.is_active
)
SELECT n.id,
  n.employee_code AS "employeeCode",
  n.name,
  n.branch_id AS "branchId",
  n.branch_name AS "branchName",
  n.department,
  n.designation,
  n.designation_code AS "designationCode",
  n.work_station AS "workStation",
  n.profile_photo AS "profilePhoto",
  m.id AS "designationId",
  m.name AS "catalogueDesignation",
  p.grade,
  p.reports_to_master_id AS "reportsToId",
  rt.name AS "reportsTo",
  p.department_master_id AS "departmentId"
FROM named n
LEFT JOIN LATERAL (
  SELECT mm.id, mm.name
  FROM hr_org_masters mm
  WHERE mm.kind = 'DESIGNATION'
    AND (
      mm.id = n.designation_id
      OR lower(mm.name) = lower(n.designation)
      OR (n.designation_code IS NOT NULL AND mm.code IS NOT NULL
        AND lower(mm.code) = lower(n.designation_code))
    )
  ORDER BY (mm.id = n.designation_id) DESC,
    (lower(mm.name) = lower(n.designation)) DESC, mm.id ASC
  LIMIT 1
) m ON TRUE
LEFT JOIN hr_designation_profiles p ON p.master_id = m.id
LEFT JOIN hr_org_masters rt ON rt.id = p.reports_to_master_id
ORDER BY LOWER(n.name) ASC, n.employee_code ASC`,
    params,
  };
}

/** The design/profile half of a designation, read before a partial PATCH merges it. */
export const HR_DESIGNATION_PROFILE_BY_MASTER_SQL = `SELECT master_id AS "masterId",
  grade,
  reports_to_master_id AS "reportsToId",
  reports_to_label AS "reportsToLabel",
  dotted_line_to AS "dottedLineTo",
  branch_scope AS "branchScope"
FROM hr_designation_profiles
WHERE master_id = $1
LIMIT 1`;

/** Creating a profile row and editing one are the same statement. */
export const HR_DESIGNATION_PROFILE_UPSERT_SQL = `INSERT INTO hr_designation_profiles (
  master_id, grade, reports_to_master_id, reports_to_label, dotted_line_to, branch_scope, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
ON CONFLICT (master_id) DO UPDATE SET
  grade = EXCLUDED.grade,
  reports_to_master_id = EXCLUDED.reports_to_master_id,
  reports_to_label = EXCLUDED.reports_to_label,
  dotted_line_to = EXCLUDED.dotted_line_to,
  branch_scope = EXCLUDED.branch_scope,
  updated_at = CURRENT_TIMESTAMP
RETURNING master_id AS "masterId", grade, reports_to_master_id AS "reportsToId",
  reports_to_label AS "reportsToLabel", dotted_line_to AS "dottedLineTo",
  branch_scope AS "branchScope"`;

export const HR_SALARY_GRADE_BY_CODE_SQL = `SELECT grade FROM hr_salary_grades WHERE grade = $1 LIMIT 1`;

export const HR_ORG_MASTER_UPDATE_SQL = `UPDATE hr_org_masters SET
  name = $2,
  code = $3,
  is_active = $4,
  updated_by = $5,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING ${HR_ORG_MASTER_COLUMNS}`;
