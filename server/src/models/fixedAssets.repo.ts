/**
 * Fixed-asset reads (ASSET-1).
 *
 * `fixed_assets` left the login payload, so the registers, the statement /
 * closing aggregates and the deployment pickers read it here. Every builder
 * takes the caller's branch scope; SQL lives in this model (no-inline-SQL gate).
 *
 * The text predicate reuses the exact expression behind
 * `idx_assets_global_trgm` (schema.sql), so a register search is index-backed;
 * the page order is stable on `(created_at DESC, id DESC)` and backed by
 * `idx_fixed_assets_page`.
 */
import { ASSET_SELECT_COLUMNS } from './inventory.repo';

/** Must stay byte-for-byte equivalent to `idx_assets_global_trgm`'s expression. */
export const FA_SEARCH_TEXT_SQL =
  "lower(COALESCE(tag_number, '') || ' ' || COALESCE(name, '') || ' ' || " +
  "COALESCE(category, '') || ' ' || COALESCE(assigned_customer_name, '') || ' ' || " +
  "COALESCE(invoice_no, '') || ' ' || COALESCE(supplier_name, ''))";

export const FIXED_ASSET_PAGE_SIZE_DEFAULT = 15;
export const FIXED_ASSET_PAGE_SIZE_MAX = 200;
/** Hard cap for the bounded register export; the caller reports truncation. */
export const FIXED_ASSET_EXPORT_MAX = 20000;
/** Deployment pickers only need assignable units; beyond this they report truncation. */
export const FIXED_ASSET_AVAILABLE_MAX = 2000;

/** The statuses the register and its status filter can name (schema CHECK). */
export const FIXED_ASSET_STATUSES = [
  'ACTIVE',
  'DISPOSED',
  'WRITTEN_OFF',
  'MAINTENANCE',
  'IN_USE',
  'ASSIGNED_TO_CUSTOMER',
  'ASSIGNED_TO_LOCATION',
] as const;
export type FixedAssetStatus = (typeof FIXED_ASSET_STATUSES)[number];

/** Only whitelisted statuses reach SQL; unknown values mean "no status filter". */
export function normalizeFixedAssetStatuses(status: unknown): FixedAssetStatus[] {
  const raw = Array.isArray(status) ? status : typeof status === 'string' ? status.split(',') : [];
  const allowed = new Set<string>(FIXED_ASSET_STATUSES);
  const result: FixedAssetStatus[] = [];
  for (const value of raw) {
    const normalized = String(value || '').trim().toUpperCase();
    if (allowed.has(normalized) && !result.includes(normalized as FixedAssetStatus)) {
      result.push(normalized as FixedAssetStatus);
    }
  }
  return result;
}

export interface FixedAssetQueryOptions {
  /** A single branch id, or 'ALL'. Ignored when `branchScope` is present. */
  branchId?: unknown;
  /** Explicit allowed-branch list resolved from the authenticated user. */
  branchScope?: string[];
  /** One status, a comma-separated list, or an array. */
  status?: unknown;
  category?: unknown;
  /** Asset Deployments: only rows that are assigned to a customer or location. */
  assigned?: boolean;
  /** Asset Deployments' deployment-type filter: CUSTOMER or LOCATION. */
  assignedType?: unknown;
  /** Asset Deployments' POP/location filter. */
  assignedLocationId?: unknown;
  /** Deployment pickers: only ACTIVE, unassigned rows. */
  available?: boolean;
  /** 'created' (default, register order) or 'invoiceDate' (depreciation date-wise). */
  sort?: unknown;
  query?: unknown;
  /** Acquisition (or placed-in-service) date window. */
  acquisitionFrom?: unknown;
  acquisitionTo?: unknown;
}

/** Strict YYYY-MM-DD, so a bad bound is dropped rather than reaching a DATE cast. */
function dateBound(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : undefined;
}

/** Clamped paging values, echoed to the client so its footer can trust them. */
export function normalizeFixedAssetPaging(page?: unknown, pageSize?: unknown): { page: number; pageSize: number } {
  const requestedSize = Math.floor(Number(pageSize));
  const size = Number.isFinite(requestedSize) && requestedSize > 0
    ? Math.min(FIXED_ASSET_PAGE_SIZE_MAX, requestedSize)
    : FIXED_ASSET_PAGE_SIZE_DEFAULT;
  const requestedPage = Math.floor(Number(page));
  return { page: Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1, pageSize: size };
}

/**
 * WHERE fragment shared by the register page, its count/export, the overview
 * aggregate and the deployment-picker reads.
 */
export function buildFixedAssetWhere(opts: FixedAssetQueryOptions = {}): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (Array.isArray(opts.branchScope)) {
    if (opts.branchScope.length === 0) {
      conditions.push('FALSE');
    } else {
      params.push(opts.branchScope);
      conditions.push(`branch_id = ANY($${params.length})`);
    }
  } else if (typeof opts.branchId === 'string' && opts.branchId && opts.branchId !== 'ALL') {
    params.push(opts.branchId);
    conditions.push(`branch_id = $${params.length}`);
  }

  if (opts.query && typeof opts.query === 'string' && opts.query.trim()) {
    params.push(`%${opts.query.trim().toLowerCase()}%`);
    conditions.push(`${FA_SEARCH_TEXT_SQL} LIKE $${params.length}`);
  }

  const statuses = normalizeFixedAssetStatuses(opts.status);
  if (statuses.length > 0) {
    params.push(statuses);
    conditions.push(`UPPER(status) = ANY($${params.length})`);
  }

  if (opts.category && typeof opts.category === 'string' && opts.category.trim() && opts.category !== 'ALL') {
    params.push(opts.category.trim());
    conditions.push(`category = $${params.length}`);
  }

  if (opts.assigned) {
    conditions.push(
      "(assigned_type IS NOT NULL OR UPPER(status) IN ('ASSIGNED_TO_CUSTOMER', 'ASSIGNED_TO_LOCATION'))"
    );
  }

  if (opts.assignedType === 'CUSTOMER' || opts.assignedType === 'LOCATION') {
    params.push(opts.assignedType);
    conditions.push(`assigned_type = $${params.length}`);
  }

  if (typeof opts.assignedLocationId === 'string' && opts.assignedLocationId.trim() && opts.assignedLocationId !== 'ALL') {
    params.push(opts.assignedLocationId.trim());
    conditions.push(`assigned_location_id = $${params.length}`);
  }

  if (opts.available) {
    conditions.push(
      "UPPER(status) = 'ACTIVE' AND assigned_type IS NULL AND " +
        'assigned_customer_id IS NULL AND assigned_location_id IS NULL'
    );
  }

  const from = dateBound(opts.acquisitionFrom);
  if (from) {
    params.push(from);
    conditions.push(`COALESCE(placed_in_service_date_ad, acquisition_date_ad) >= $${params.length}`);
  }
  const to = dateBound(opts.acquisitionTo);
  if (to) {
    params.push(to);
    conditions.push(`COALESCE(placed_in_service_date_ad, acquisition_date_ad) <= $${params.length}`);
  }

  return { whereSql: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '', params };
}

/** The register page, ordered by the composite `(branch_id, created_at, id)` index. */
export function buildFixedAssetPageQuery(
  opts: FixedAssetQueryOptions = {},
  page = 1,
  pageSize = FIXED_ASSET_PAGE_SIZE_DEFAULT
) {
  const { whereSql, params } = buildFixedAssetWhere(opts);
  // The date-wise depreciation view is ordered by the party-invoice date the
  // screen displays, backed by idx_fixed_assets_invoice_date.
  const orderSql =
    opts.sort === 'invoiceDate'
      ? 'ORDER BY COALESCE(purchase_invoice_date_ad, acquisition_date_ad) DESC, id DESC'
      : 'ORDER BY created_at DESC, id DESC';
  const sql =
    `SELECT ${ASSET_SELECT_COLUMNS} FROM fixed_assets${whereSql} ` +
    `${orderSql} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
  return { sql, params };
}

/** Filtered total for the page footer and the export envelope. */
export function buildFixedAssetCountQuery(opts: FixedAssetQueryOptions = {}) {
  const { whereSql, params } = buildFixedAssetWhere(opts);
  return { sql: `SELECT COUNT(*)::int AS count FROM fixed_assets${whereSql}`, params };
}

/**
 * CSV/report export: every matching row, capped at one more than the limit so
 * the caller can report truncation instead of silently exporting a prefix.
 */
export function buildFixedAssetExportQuery(opts: FixedAssetQueryOptions = {}) {
  const { whereSql, params } = buildFixedAssetWhere(opts);
  const sql =
    `SELECT ${ASSET_SELECT_COLUMNS} FROM fixed_assets${whereSql} ` +
    `ORDER BY created_at DESC, id DESC LIMIT ${FIXED_ASSET_EXPORT_MAX + 1}`;
  return { sql, params };
}

/**
 * Narrow projection for the formula aggregates: every matching row without the
 * wide display columns. The caller applies the shared depreciation rule and
 * sums in Node, so totals equal the rows the registers render.
 */
export function buildFixedAssetAggregateQuery(opts: FixedAssetQueryOptions = {}) {
  const { whereSql, params } = buildFixedAssetWhere(opts);
  const sql =
    'SELECT id, tag_number AS "tagNumber", branch_id AS "branchId", status, ' +
    'acquisition_cost AS "acquisitionCost", depreciation_method AS "depreciationMethod", ' +
    'depreciation_rate_percent AS "depreciationRatePercent", ' +
    'accumulated_depreciation AS "accumulatedDepreciation", net_book_value AS "netBookValue", ' +
    'acquisition_date_ad AS "acquisitionDateAD", placed_in_service_date_ad AS "placedInServiceDateAD" ' +
    `FROM fixed_assets${whereSql}`;
  return { sql, params };
}

/** Deployment pickers: ACTIVE, unassigned units, one over the cap to detect truncation. */
export function buildFixedAssetAvailableQuery(opts: FixedAssetQueryOptions = {}) {
  const { whereSql, params } = buildFixedAssetWhere({ ...opts, available: true });
  const sql =
    `SELECT ${ASSET_SELECT_COLUMNS} FROM fixed_assets${whereSql} ` +
    `ORDER BY tag_number ASC, id ASC LIMIT ${FIXED_ASSET_AVAILABLE_MAX + 1}`;
  return { sql, params };
}

/** One asset by id, tag number or device serial, under the caller's branch scope. */
export function buildFixedAssetLookupQuery(
  scope: FixedAssetQueryOptions,
  value: { id?: unknown; tagNumber?: unknown; serial?: unknown }
) {
  const { whereSql, params } = buildFixedAssetWhere(scope);
  const clauses: string[] = [];
  for (const [column, raw] of [
    ['id', value.id],
    ['tag_number', value.tagNumber],
    ['device_serial', value.serial],
  ] as const) {
    if (typeof raw === 'string' && raw.trim()) {
      params.push(raw.trim());
      clauses.push(`${column} = $${params.length}`);
    }
  }
  if (clauses.length === 0) {
    // Unreachable through the controller (it 400s first); keeps the SQL valid.
    return { sql: `SELECT ${ASSET_SELECT_COLUMNS} FROM fixed_assets${whereSql} LIMIT 1`, params };
  }
  const joiner = whereSql ? ' AND ' : ' WHERE ';
  const sql = `SELECT ${ASSET_SELECT_COLUMNS} FROM fixed_assets${whereSql}${joiner}(${clauses.join(' OR ')}) LIMIT 1`;
  return { sql, params };
}
