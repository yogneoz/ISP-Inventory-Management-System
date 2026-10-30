/**
 * WTY-1 warranty coverage reads/writes. Pure builders — no pool access — so the
 * controllers keep the repo-layer convention and every query is unit-testable.
 *
 * One table holds both directions: VENDOR (what a supplier owes us) and SELLER
 * (what we give a customer). `end_date_ad` is the authoritative date; the
 * computed state uses the same 30-day boundary as the shared date helper.
 */
import type { WarrantyCoverageType } from '../../../client/src/types';
import { warrantyStateFor } from '../../../shared/warrantyTerm';

export type WarrantyStatus = 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'RETURNED';

export interface WarrantyQueryOptions {
  coverageType: WarrantyCoverageType;
  /** Branch ids allowed by the session; an empty array means no rows. */
  branchScope?: string[];
  branchId?: unknown;
  query?: unknown;
  status?: unknown;
  category?: unknown;
  startFrom?: unknown;
  startTo?: unknown;
}

/** The SQL twin of `warrantyStateFor`; filtering and rendering use one rule. */
export const WARRANTY_STATE_SQL = {
  VALID: 'w.end_date_ad > CURRENT_DATE + 30',
  EXPIRING_SOON: 'w.end_date_ad >= CURRENT_DATE AND w.end_date_ad <= CURRENT_DATE + 30',
  EXPIRED: 'w.end_date_ad < CURRENT_DATE',
  /** Not a date state: a retired row (returned unit, correction, reversal). */
  RETURNED: 'w.is_current = FALSE',
} as const;

export const WARRANTY_STATE_CASE_SQL = `CASE
  WHEN w.is_current = FALSE THEN 'RETURNED'
  WHEN w.end_date_ad < CURRENT_DATE THEN 'EXPIRED'
  WHEN w.end_date_ad <= CURRENT_DATE + 30 THEN 'EXPIRING_SOON'
  ELSE 'VALID' END`;

export const WARRANTY_SELECT_COLUMNS = `w.id,
  w.coverage_type AS "coverageType",
  w.item_category AS "itemCategory",
  w.product_id AS "productId",
  w.product_name AS "productName",
  w.serial_number AS "serialNumber",
  w.branch_id AS "branchId",
  COALESCE(b.name, w.branch_id) AS "branchName",
  w.party_name AS "partyName",
  w.source_type AS "sourceType",
  w.source_id AS "sourceId",
  w.source_number AS "sourceNumber",
  w.start_date_ad AS "startDateAD",
  w.end_date_ad AS "endDateAD",
  w.term_months AS "termMonths",
  w.start_basis AS "startBasis",
  w.notes,
  w.is_current AS "isCurrent",
  w.superseded_at AS "supersededAt",
  w.retired_reason AS "retiredReason",
  w.retired_ref AS "retiredRef",
  w.is_demo AS "isDemo",
  ${WARRANTY_STATE_CASE_SQL} AS "warrantyState",
  (w.end_date_ad - CURRENT_DATE)::int AS "daysRemaining"`;

export const WARRANTY_RECORD_COLUMNS = `id,
  coverage_type AS "coverageType",
  item_category AS "itemCategory",
  product_id AS "productId",
  product_name AS "productName",
  serial_number AS "serialNumber",
  asset_id AS "assetId",
  device_record_id AS "deviceRecordId",
  branch_id AS "branchId",
  party_id AS "partyId",
  party_name AS "partyName",
  source_type AS "sourceType",
  source_id AS "sourceId",
  source_number AS "sourceNumber",
  start_date_ad AS "startDateAD",
  end_date_ad AS "endDateAD",
  term_months AS "termMonths",
  start_basis AS "startBasis",
  notes,
  is_current AS "isCurrent",
  superseded_at AS "supersededAt",
  retired_reason AS "retiredReason",
  retired_ref AS "retiredRef",
  is_demo AS "isDemo"`;

const STATUSES = new Set<WarrantyStatus>(['VALID', 'EXPIRING_SOON', 'EXPIRED', 'RETURNED']);

function normalizeStatus(value: unknown): WarrantyStatus | undefined {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return STATUSES.has(normalized as WarrantyStatus) ? (normalized as WarrantyStatus) : undefined;
}

function normalizeCategory(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return normalized === 'CPE' || normalized === 'FIXED_ASSET' || normalized === 'SOLD_PRODUCT'
    ? normalized
    : undefined;
}

function dateBound(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim().slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

/** Filters shared by the page, the filtered count and the status summary. */
function buildWarrantyWhere(opts: WarrantyQueryOptions): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [opts.coverageType];
  // The Returned filter is a second population, not a date state: it reads the
  // rows a return/correction retired, while every other view reads current rows.
  const retired = normalizeStatus(opts.status) === 'RETURNED';
  const conditions: string[] = [
    retired ? 'w.is_current = FALSE' : 'w.is_current = TRUE',
    'w.coverage_type = $1',
  ];

  if (Array.isArray(opts.branchScope)) {
    if (opts.branchScope.length === 0) {
      conditions.push('FALSE');
    } else {
      params.push(opts.branchScope);
      conditions.push(`w.branch_id = ANY($${params.length})`);
    }
  } else if (typeof opts.branchId === 'string' && opts.branchId && opts.branchId !== 'ALL') {
    params.push(opts.branchId);
    conditions.push(`w.branch_id = $${params.length}`);
  }

  if (typeof opts.query === 'string' && opts.query.trim()) {
    params.push(`%${opts.query.trim().toLowerCase()}%`);
    conditions.push(
      `lower(COALESCE(w.product_name, '') || ' ' || COALESCE(w.serial_number, '') || ' ' || COALESCE(w.party_name, '') || ' ' || COALESCE(w.source_number, '') || ' ' || COALESCE(b.name, '')) LIKE $${params.length}`
    );
  }

  const category = normalizeCategory(opts.category);
  if (category) {
    params.push(category);
    conditions.push(`w.item_category = $${params.length}`);
  }

  const from = dateBound(opts.startFrom);
  if (from) {
    params.push(from);
    conditions.push(`w.start_date_ad >= $${params.length}`);
  }
  const to = dateBound(opts.startTo);
  if (to) {
    params.push(to);
    conditions.push(`w.start_date_ad <= $${params.length}`);
  }

  return { whereSql: ` WHERE ${conditions.join(' AND ')}`, params };
}

/** One page of current coverages, soonest expiry first. */
export function buildWarrantyPageQuery(
  opts: WarrantyQueryOptions,
  page = 1,
  pageSize = 25
): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildWarrantyWhere(opts);
  const status = normalizeStatus(opts.status);
  const statusClause = status ? ` AND ${WARRANTY_STATE_SQL[status]}` : '';
  const limit = Math.max(1, Math.min(500, Math.trunc(pageSize) || 25));
  const offset = (Math.max(1, Math.trunc(page) || 1) - 1) * limit;
  return {
    sql: `SELECT ${WARRANTY_SELECT_COLUMNS}
      FROM warranty_coverages w
      LEFT JOIN branches b ON b.id = w.branch_id${whereSql}${statusClause}
      ORDER BY w.end_date_ad ASC, w.id ASC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  };
}

/** Filtered total for the footer (status filter included). */
export function buildWarrantyCountQuery(opts: WarrantyQueryOptions): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildWarrantyWhere(opts);
  const status = normalizeStatus(opts.status);
  const statusClause = status ? ` AND ${WARRANTY_STATE_SQL[status]}` : '';
  return {
    sql: `SELECT COUNT(*)::int AS count
      FROM warranty_coverages w
      LEFT JOIN branches b ON b.id = w.branch_id${whereSql}${statusClause}`,
    params,
  };
}

/** KPI counts for the whole filtered population, ignoring the status filter. */
export function buildWarrantySummaryQuery(opts: WarrantyQueryOptions): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildWarrantyWhere(opts);
  return {
    // The three date states are about active coverage. A retired row shown
    // under the Returned filter belongs to `total` only, never "valid".
    sql: `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE w.is_current = TRUE AND ${WARRANTY_STATE_SQL.VALID})::int AS valid,
        COUNT(*) FILTER (WHERE w.is_current = TRUE AND ${WARRANTY_STATE_SQL.EXPIRING_SOON})::int AS expiring,
        COUNT(*) FILTER (WHERE w.is_current = TRUE AND ${WARRANTY_STATE_SQL.EXPIRED})::int AS expired
      FROM warranty_coverages w
      LEFT JOIN branches b ON b.id = w.branch_id${whereSql}`,
    params,
  };
}

export const WARRANTY_FIND_BY_ID_SQL = `SELECT ${WARRANTY_SELECT_COLUMNS}
  FROM warranty_coverages w
  LEFT JOIN branches b ON b.id = w.branch_id
  WHERE w.id = $1`;

export const WARRANTY_FIND_RECORD_BY_ID_SQL = `SELECT ${WARRANTY_RECORD_COLUMNS}
  FROM warranty_coverages WHERE id = $1`;

export const WARRANTY_INSERT_SQL = `INSERT INTO warranty_coverages (
  id, coverage_type, item_category, product_id, product_name, serial_number,
  asset_id, device_record_id, branch_id, party_id, party_name,
  source_type, source_id, source_number, start_date_ad, end_date_ad,
  term_months, start_basis, notes, is_current, is_demo, created_by, updated_by,
  created_at, updated_at
) VALUES (
  $1, $2, $3, $4, $5, $6,
  $7, $8, $9, $10, $11,
  $12, $13, $14, $15, $16,
  $17, $18, $19, TRUE, $20, $21, $22,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)`;

export interface WarrantyInsertInput {
  id: string;
  coverageType: WarrantyCoverageType;
  itemCategory: 'CPE' | 'FIXED_ASSET' | 'SOLD_PRODUCT';
  productId?: string | null;
  productName: string;
  serialNumber: string;
  assetId?: string | null;
  deviceRecordId?: string | null;
  branchId?: string | null;
  partyId?: string | null;
  partyName?: string | null;
  sourceType: string;
  sourceId?: string | null;
  sourceNumber?: string | null;
  startDateAD: string;
  endDateAD: string;
  termMonths?: number | null;
  startBasis: string;
  notes?: string | null;
  isDemo?: boolean;
  actor?: string | null;
}

export function warrantyInsertParams(rec: WarrantyInsertInput): unknown[] {
  return [
    rec.id,
    rec.coverageType,
    rec.itemCategory,
    rec.productId || null,
    rec.productName,
    rec.serialNumber,
    rec.assetId || null,
    rec.deviceRecordId || null,
    rec.branchId || null,
    rec.partyId || null,
    rec.partyName || null,
    rec.sourceType,
    rec.sourceId || null,
    rec.sourceNumber || null,
    rec.startDateAD,
    rec.endDateAD,
    rec.termMonths ?? null,
    rec.startBasis,
    rec.notes || null,
    Boolean(rec.isDemo),
    rec.actor || null,
    rec.actor || null,
  ];
}

/** Supersede the current row for a unit before inserting its next period. */
export const WARRANTY_SUPERSEDE_CURRENT_SQL = `UPDATE warranty_coverages SET
  is_current = FALSE, superseded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
WHERE coverage_type = $1 AND serial_number = $2 AND is_current = TRUE`;

/** Supersede by the document that created the coverage (reversals, returns). */
export const WARRANTY_SUPERSEDE_BY_SOURCE_SQL = `UPDATE warranty_coverages SET
  is_current = FALSE, superseded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
WHERE coverage_type = $1 AND source_type = $2 AND source_id = $3 AND is_current = TRUE`;

/** Supersede the current supplier row a fixed asset created (disposal/edit). */
export const WARRANTY_SUPERSEDE_BY_ASSET_SQL = `UPDATE warranty_coverages SET
  is_current = FALSE, superseded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
WHERE coverage_type = 'VENDOR' AND asset_id = $1 AND is_current = TRUE`;

/** Supersede every current row for a device record (collection/exchange). */
export const WARRANTY_SUPERSEDE_BY_DEVICE_SQL = `UPDATE warranty_coverages SET
  is_current = FALSE, superseded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
WHERE coverage_type = 'SELLER' AND device_record_id = $1 AND is_current = TRUE`;

/** Retire the seller promise for returned/sold units named by serial. */
export const WARRANTY_SUPERSEDE_SELLER_BY_SERIALS_SQL = `UPDATE warranty_coverages SET
  is_current = FALSE, superseded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
WHERE coverage_type = 'SELLER' AND serial_number = ANY($1) AND is_current = TRUE`;

/**
 * Retire coverage for exactly the units a return took back, recording why and
 * which document did it. The row is kept (never deleted): the register shows it
 * as RETURNED, and a unit that is later re-received can still show that its
 * previous coverage ended in a purchase return rather than expiring.
 */
export const WARRANTY_RETIRE_BY_SERIALS_SQL = `UPDATE warranty_coverages SET
  is_current = FALSE,
  superseded_at = CURRENT_TIMESTAMP,
  retired_reason = $3,
  retired_ref = $4,
  updated_at = CURRENT_TIMESTAMP
WHERE coverage_type = $1 AND serial_number = ANY($2) AND is_current = TRUE`;

/**
 * Retire exactly the row being corrected. A correction is a NEW period, not an
 * overwrite: the old row keeps its original dates for audit and drops out of
 * the current register, which is what makes "who changed a contractual expiry"
 * answerable later. Kept by id (not by unit) so a correction can never retire a
 * replacement that already landed in the same second.
 */
export const WARRANTY_SUPERSEDE_BY_ID_SQL = `UPDATE warranty_coverages SET
  is_current = FALSE,
  superseded_at = CURRENT_TIMESTAMP,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND is_current = TRUE`;

/** The current coverage for a unit (used when a capture path must update one). */
export const WARRANTY_FIND_CURRENT_SQL = `SELECT ${WARRANTY_RECORD_COLUMNS}
  FROM warranty_coverages
  WHERE coverage_type = $1 AND serial_number = $2 AND is_current = TRUE
  LIMIT 1`;

/** Store the status the DB would compute, for the PG-less mirror. */
export function warrantyStateForMirror(endDateAD: string): WarrantyStatus {
  return warrantyStateFor(endDateAD);
}

/** A coverage with both dates present and ordered. */
export function validCoverageDates(startDateAD: unknown, endDateAD: unknown): boolean {
  return (
    typeof startDateAD === 'string' &&
    typeof endDateAD === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(startDateAD) &&
    /^\d{4}-\d{2}-\d{2}$/.test(endDateAD) &&
    endDateAD >= startDateAD
  );
}
