/**
 * SQL for fiscal-year-versioned statutory deductions.
 *
 * A configuration belongs to exactly one fiscal year. Its SSF rates live on the
 * header and its progressive monthly TDS bands live in `hr_tds_slabs`. Payroll
 * resolves the fiscal year from the as-of date, so each Finance Act is stored
 * against its own year and earlier payroll keeps the rules that were in force.
 */

export const HR_STATUTORY_CONFIG_COLUMNS = `c.id,
  c.fiscal_year_id AS "fiscalYearId",
  f.code AS "fiscalYearCode",
  f.start_date_ad::text AS "startDateAD",
  f.end_date_ad::text AS "endDateAD",
  c.employee_ssf_percent::numeric AS "employeeSsfPercent",
  c.employer_ssf_percent::numeric AS "employerSsfPercent",
  c.notes,
  c.created_by AS "createdBy",
  c.updated_by AS "updatedBy",
  c.created_at AS "createdAt",
  c.updated_at AS "updatedAt"`;

export const HR_STATUTORY_CONFIG_LIST_SQL = `SELECT ${HR_STATUTORY_CONFIG_COLUMNS}
FROM hr_statutory_configs c
JOIN fiscal_years f ON f.id = c.fiscal_year_id
WHERE ($1::varchar IS NULL OR c.fiscal_year_id = $1)
ORDER BY f.start_date_ad DESC, f.code DESC
LIMIT 100`;

export const HR_STATUTORY_CONFIG_BY_ID_SQL = `SELECT ${HR_STATUTORY_CONFIG_COLUMNS}
FROM hr_statutory_configs c
JOIN fiscal_years f ON f.id = c.fiscal_year_id
WHERE c.id = $1
LIMIT 1`;

export const HR_STATUTORY_CONFIG_BY_YEAR_SQL = `SELECT ${HR_STATUTORY_CONFIG_COLUMNS}
FROM hr_statutory_configs c
JOIN fiscal_years f ON f.id = c.fiscal_year_id
WHERE c.fiscal_year_id = $1
LIMIT 1`;

export const HR_STATUTORY_FISCAL_YEAR_BY_ID_SQL = `SELECT
  id,
  code,
  start_date_ad::text AS "startDateAD",
  end_date_ad::text AS "endDateAD"
FROM fiscal_years
WHERE id = $1
LIMIT 1`;

/** The fiscal year containing an AD date; the newest start wins if ranges overlap. */
export const HR_STATUTORY_FISCAL_YEAR_FOR_DATE_SQL = `SELECT
  id,
  code,
  start_date_ad::text AS "startDateAD",
  end_date_ad::text AS "endDateAD"
FROM fiscal_years
WHERE start_date_ad <= $1::date
  AND end_date_ad >= $1::date
ORDER BY start_date_ad DESC, code DESC
LIMIT 1`;

export const HR_STATUTORY_CONFIG_INSERT_SQL = `INSERT INTO hr_statutory_configs (
  id, fiscal_year_id, employee_ssf_percent, employer_ssf_percent, notes,
  is_demo, created_by
) VALUES ($1, $2, $3, $4, $5, FALSE, $6)
RETURNING id`;

export const HR_STATUTORY_CONFIG_UPDATE_SQL = `UPDATE hr_statutory_configs SET
  employee_ssf_percent = $2,
  employer_ssf_percent = $3,
  notes = $4,
  updated_by = $5,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

export const HR_STATUTORY_SLAB_COLUMNS = `id,
  config_id AS "configId",
  slab_order AS "slabOrder",
  lower_bound::numeric AS "lowerBound",
  upper_bound::numeric AS "upperBound",
  rate_percent::numeric AS "ratePercent"`;

export const HR_STATUTORY_SLABS_BY_CONFIG_IDS_SQL = `SELECT ${HR_STATUTORY_SLAB_COLUMNS}
FROM hr_tds_slabs
WHERE config_id = ANY($1::varchar[])
ORDER BY config_id ASC, slab_order ASC`;

export const HR_STATUTORY_SLAB_INSERT_SQL = `INSERT INTO hr_tds_slabs (
  id, config_id, slab_order, lower_bound, upper_bound, rate_percent
) VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id`;

export const HR_STATUTORY_SLABS_DELETE_SQL = `DELETE FROM hr_tds_slabs
WHERE config_id = $1
RETURNING id`;
