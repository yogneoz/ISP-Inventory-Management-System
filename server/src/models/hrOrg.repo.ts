/**
 * SQL for the People & HR organisation catalogue.
 *
 * Departments, designations and work stations share one small, typed table.
 * They are editable labels, not foreign keys from `employees`: existing
 * historical rows keep their text value when a master is renamed or retired.
 */

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

export const HR_ORG_MASTER_UPDATE_SQL = `UPDATE hr_org_masters SET
  name = $2,
  code = $3,
  is_active = $4,
  updated_by = $5,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING ${HR_ORG_MASTER_COLUMNS}`;
