/**
 * Repository for GET /api/bootstrap — all SQL for the app's initial data load
 * lives here, driven by the per-table column mappings in ./columnMappings.ts.
 *
 * server.ts keeps only HTTP concerns (fiscal-year selection, financial summary
 * computation, response shaping); every query and column list is defined once
 * in this layer.
 */
import type { QueryResult } from 'pg';
import { BOOTSTRAP_TABLES, type TableQueryConfig } from './columnMappings';

/** Minimal query interface satisfied by the pg Pool (and test doubles). */
export interface QueryExecutor {
  query(text: string, values?: unknown[]): Promise<QueryResult<any>>;
}

/** Branch/fiscal-year filters resolved by the caller (server.ts handler). */
export interface BootstrapScopeParams {
  branchId?: string;
  fiscalYearId?: string;
  fiscalYearStartAD?: string;
  fiscalYearEndAD?: string;
}

/**
 * Builds a WHERE clause + params for one bootstrap query: optional branch
 * filter (single column, or an OR pair for shipments) and the fiscal-year AD
 * date range on the table's primary date column. Mirrors the original
 * `scoped()` helper inside the bootstrap handler exactly.
 */
export function buildScopedWhere(
  scope: TableQueryConfig['scope'],
  params0: BootstrapScopeParams
): { where: string; params: any[] } {
  const conds: string[] = [];
  const params: any[] = [];
  const bId = params0.branchId;
  const hasFyScope = Boolean(params0.fiscalYearStartAD && params0.fiscalYearEndAD);

  if (bId && scope?.branchCol) {
    params.push(bId);
    conds.push(`${scope.branchCol} = $${params.length}`);
  }
  if (bId && scope?.branchOrCols) {
    params.push(bId, bId);
    conds.push(`(${scope.branchOrCols[0]} = $${params.length - 1} OR ${scope.branchOrCols[1]} = $${params.length})`);
  }
  if (hasFyScope && scope?.dateCol) {
    params.push(params0.fiscalYearStartAD, params0.fiscalYearEndAD);
    conds.push(`${scope.dateCol} >= $${params.length - 1}`);
    conds.push(`${scope.dateCol} <= $${params.length}`);
  }
  return { where: conds.length ? ` WHERE ${conds.join(' AND ')}` : '', params };
}

/** Generates `SELECT <col> AS "alias", ... FROM <table><where>` from a config. */
export function buildSelectSql(cfg: TableQueryConfig, where: string): string {
  const selectList = cfg.columns
    .map(([col, alias, cast]) => `${col}${cast || ''} AS "${alias}"`)
    .join(', ');
  return `SELECT ${selectList} FROM ${cfg.table}${where}`;
}

/** Runs one mapped table query with the given scope. */
export async function fetchTable(
  pool: QueryExecutor,
  cfg: TableQueryConfig,
  scopeParams: BootstrapScopeParams,
  /** Overrides the static `cfg.limit` (auditLogs uses 200 for its payload). */
  limitOverride?: number
): Promise<any[]> {
  const { where, params } = buildScopedWhere(cfg.scope, scopeParams);
  let sql = buildSelectSql(cfg, where);
  if (cfg.orderBy) sql += ` ORDER BY ${cfg.orderBy}`;
  const limit = limitOverride ?? cfg.limit;
  if (limit) sql += ` LIMIT ${limit}`;
  const result = await pool.query(sql, params);
  return result.rows;
}

/**
 * Reads ONE bootstrap slice live from PostgreSQL (mirror-drift fix #7):
 * the payload key → BOOTSTRAP_TABLES config the full bootstrap uses, so the
 * targeted refresh returns exactly what a full bootstrap would — straight
 * from the database, never from an in-memory mirror. auditLogs applies the
 * same 200-row payload cap. Throws when the key has no table mapping (the
 * caller falls back to the operational cache / mirror) — which now includes the
 * retired `customerDevices` key, whose mapping lives in CACHE_ONLY_TABLES for
 * the operational cache alone (CDR-2).
 */
export async function fetchBootstrapSlice(
  pool: QueryExecutor,
  key: string,
  scopeParams: BootstrapScopeParams
): Promise<any> {
  const cfg = (BOOTSTRAP_TABLES as Record<string, TableQueryConfig>)[key];
  if (!cfg) throw new Error(`no bootstrap table mapping for key ${key}`);
  const limit = key === 'auditLogs'
    ? BOOTSTRAP_TABLES.auditLogs.cache?.bootstrapLimitOnly
    : undefined;
  const rows = await fetchTable(pool, cfg, scopeParams, limit);
  return key === 'companyProfile' ? rows[0] : rows;
}

/**
 * Fiscal years use a custom select: the AD dates are cast to ::text so the
 * client receives plain 'YYYY-MM-DD' strings.
 */
export async function fetchFiscalYears(pool: QueryExecutor): Promise<any[]> {
  const result = await pool.query(
    'SELECT id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD", start_date_bs AS "startDateBS", end_date_bs AS "endDateBS", is_current AS "isCurrent", is_closed AS "isClosed", is_demo AS "isDemo", is_provisional AS "isProvisional" FROM fiscal_years ORDER BY start_date_ad DESC'
  );
  return result.rows;
}

/**
 * When viewing a non-current fiscal year, stock comes from the year's opening
 * snapshot instead of live inventory_stock.
 */
export async function fetchOpeningStock(
  pool: QueryExecutor,
  fiscalYearId: string,
  branchId?: string
): Promise<any[]> {
  const result = await pool.query(
    `SELECT 'opening-' || fiscal_year_id || '-' || product_id || '-' || branch_id AS id,
            product_id AS "productId", branch_id AS "branchId", quantity_on_hand AS "quantityOnHand",
            damaged_qty AS "damagedQty", 0 AS "reservedQty", 0 AS "incomingQty", 0 AS "minReorderLevel"
     FROM fiscal_year_opening_stock WHERE fiscal_year_id = $1${branchId ? ' AND branch_id = $2' : ''};`,
    branchId ? [fiscalYearId, branchId] : [fiscalYearId]
  );
  return result.rows;
}

/** Parses a serial_log row's historyJson (TEXT or JSONB) into a history array. */
export function parseSerialHistory(rows: any[]): any[] {
  return (rows || []).map((r: any) => {
    let history: any[] = [];
    try {
      history = typeof r.historyJson === 'string' ? JSON.parse(r.historyJson || '[]') : r.historyJson || [];
    } catch {
      history = [];
    }
    const { historyJson, ...rest } = r;
    return { ...rest, history };
  });
}

/**
 * The operational queries of the bootstrap load, run as one parallel fan-out
 * (single round-trip batch). Field names match the payload keys the handler
 * assembles. Throws on the first failing query so the handler's existing
 * catch/503 handling stays in charge.
 *
 * BOOT-1 (2026-10-26): purchase orders, purchase invoices, stock operations
 * and vendor payments are NOT read here. The first three were only inputs to
 * the financial summary, which now uses the aggregate SQL producer; none of
 * the three was serialized. Vendor payments was serialized but no client
 * read it. Each still has a BOOTSTRAP_TABLES mapping for the on-demand
 * `/api/bootstrap/local?key=` slices.
 *
 * VOL-3 (2026-10-26): shipments is NOT read here either. The transfer
 * register pages through GET /api/shipments/page and the shell/dashboard read
 * GET /api/shipments/overview (exact counts + the actionable rows), so the
 * fiscal year's entire dispatch history no longer enters the login payload.
 *
 * VOL-4a (2026-10-26): customers is NOT read here. `customer_records` is the
 * largest master table and the one that grows fastest (the modelled national
 * target is 120k+ rows); every screen that needs a customer now searches
 * GET /api/customers (paged, index-backed, branch-scoped from the session),
 * and the pickers hold the one row they picked. The BOOTSTRAP_TABLES mapping
 * stays for `/api/bootstrap/local?key=customers` and the demo cache mirror.
 *
 * VOL-4b (2026-10-26): customerDevices is NOT read here either. The device
 * register pages through GET /api/customer-devices/page and its KPIs read
 * GET /api/customer-devices/overview; the warranty directory has its own paged
 * union because warranty state is derived from the commissioned date. One row
 * per deployed/rented CPE, so this array grew with the customer base too.
 * CDR-2 (2026-10-27) then moved its mapping to CACHE_ONLY_TABLES and retired
 * the slice that shared it; the operational cache still reads the mapping.
 */
export async function fetchOperationalData(
  pool: QueryExecutor,
  scopeParams: BootstrapScopeParams
): Promise<{
  branches: any[];
  products: any[];
  stock: any[];
  purchaseReturns: any[];
  salesReturns: any[];
  auditLogs: any[];
  suppliers: any[];
  users: any[];
  approvalRequests: any[];
  categories: any[];
  productGroups: any[];
  uom: any[];    locations: any[];    companyProfile: any[];
    damageRecords: any[];
}> {
  const [
    branches,
    products,
    stock,
    purchaseReturns,
    salesReturns,
    auditLogs,
    suppliers,
    users,
    approvalRequests,
    categories,
    productGroups,
    uom,
    locations,
    companyProfile,
    damageRecords,
  ] = await Promise.all([
    fetchTable(pool, BOOTSTRAP_TABLES.branches, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.products, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.stock, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.purchaseReturns, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.salesReturns, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.auditLogs, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.suppliers, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.users, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.approvalRequests, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.categories, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.productGroups, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.uom, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.locations, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.companyProfile, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.damageRecords, scopeParams),
    // NOTE: the serial_log fetch was removed — the register is served by the
    // paged GET /api/serial-log endpoint instead (see SerialLogQueryOptions),
    // so bootstrapping no longer loads the whole ledger.
    // NOTE: sales_invoices is no longer fetched here either — the Returns
    // register searches GET /api/sales-invoices and the Sales register pages
    // it directly, so the fiscal year's invoices never enter first paint. The
    // column mapping stays in columnMappings.ts for the operational cache.
    // NOTE: shipments is served by GET /api/shipments/page (register) and
    // GET /api/shipments/overview (shell/dashboard), so the dispatch history
    // is read in bounded slices instead of on every login.
    // NOTE: customers is served by GET /api/customers (paged, searchable,
    // branch-scoped) — the pickers fetch at most 20 matching rows, so the
    // national directory never enters first paint.
    // NOTE: customer devices are served by GET /api/customer-devices/page
    // (register) and /overview (counts); the warranty directory reads its own
    // paged union, so the device table never enters first paint either.
    // NOTE: fixed assets are served by GET /api/fixed-assets/page (registers),
    // /overview (dashboard, statements, FY closing), /available (deployment
    // pickers) and /lookup (one row). The table grows for the life of the
    // business and never ages out by fiscal year, so it is read in bounded
    // slices, never in the login payload.
  ]);

  return {
    branches,
    products,
    stock,
    purchaseReturns,
    salesReturns,
    auditLogs,
    suppliers,
    users,
    approvalRequests,
    categories,
    productGroups,
    uom,
    locations,
    companyProfile,
    damageRecords,
  };
}
