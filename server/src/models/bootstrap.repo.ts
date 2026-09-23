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
  scopeParams: BootstrapScopeParams
): Promise<any[]> {
  const { where, params } = buildScopedWhere(cfg.scope, scopeParams);
  let sql = buildSelectSql(cfg, where);
  if (cfg.orderBy) sql += ` ORDER BY ${cfg.orderBy}`;
  if (cfg.limit) sql += ` LIMIT ${cfg.limit}`;
  const result = await pool.query(sql, params);
  return result.rows;
}

/**
 * Fiscal years use a custom select: the AD dates are cast to ::text so the
 * client receives plain 'YYYY-MM-DD' strings.
 */
export async function fetchFiscalYears(pool: QueryExecutor): Promise<any[]> {
  const result = await pool.query(
    'SELECT id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD", start_date_bs AS "startDateBS", end_date_bs AS "endDateBS", is_current AS "isCurrent", is_closed AS "isClosed", is_demo AS "isDemo" FROM fiscal_years ORDER BY start_date_ad DESC'
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

/**
 * Vendor Opening Balances total (for correct Accounts Payable =
 * opening + invoices − payments).
 */
export async function fetchVendorOpeningBalanceTotal(
  pool: QueryExecutor,
  fiscalYearId: string,
  branchId?: string
): Promise<number> {
  const result = await pool.query(
    `SELECT COALESCE(SUM(opening_balance), 0)::float AS "totalOpeningBalance"
     FROM vendor_opening_balances
     WHERE fiscal_year_id = $1${branchId ? ' AND branch_id = $2' : ''}`,
    branchId ? [fiscalYearId, branchId] : [fiscalYearId]
  );
  return Number(result.rows[0]?.totalOpeningBalance || 0);
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
 * All 23 operational queries of the bootstrap load, run as one parallel
 * fan-out (single round-trip batch). Field names match the payload keys the
 * server.ts handler assembles. Throws on the first failing query so the
 * handler's existing catch/503 handling stays in charge.
 */
export async function fetchOperationalData(
  pool: QueryExecutor,
  scopeParams: BootstrapScopeParams
): Promise<{
  branches: any[];
  products: any[];
  stock: any[];
  assets: any[];
  customerDevices: any[];
  customers: any[];
  purchaseOrders: any[];
  purchaseInvoices: any[];
  shipments: any[];
  stockOperations: any[];
  auditLogs: any[];
  transactionLogs: any[];
  suppliers: any[];
  users: any[];
  approvalRequests: any[];
  categories: any[];
  uom: any[];
  locations: any[];    companyProfile: any[];
    damageRecords: any[];
    vendorPayments: any[];
    vendorOpeningBalanceTotal: number;
}> {
  const [
    branches,
    products,
    stock,
    assets,
    customerDevices,
    customers,
    purchaseOrders,
    purchaseInvoices,
    shipments,
    stockOperations,
    auditLogs,
    transactionLogs,
    suppliers,
    users,
    approvalRequests,
    categories,
    uom,
    locations,
    companyProfile,
    damageRecords,
    vendorPayments,
    vendorOpeningBalanceTotal,
  ] = await Promise.all([
    fetchTable(pool, BOOTSTRAP_TABLES.branches, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.products, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.stock, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.assets, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.customerDevices, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.customers, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.purchaseOrders, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.purchaseInvoices, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.shipments, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.stockOperations, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.auditLogs, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.transactionLogs, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.suppliers, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.users, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.approvalRequests, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.categories, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.uom, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.locations, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.companyProfile, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.damageRecords, scopeParams),
    fetchTable(pool, BOOTSTRAP_TABLES.vendorPayments, scopeParams),
    // Vendor opening balance needs the selected fiscal year id; the original
    // handler dereferenced selectedFiscalYear.id the same way (a missing year
    // fails the query and surfaces through the handler's catch → 503).
    fetchVendorOpeningBalanceTotal(pool, scopeParams.fiscalYearId as string, scopeParams.branchId),
    // NOTE: the serial_log fetch was removed — the register is served by the
    // paged GET /api/serial-log endpoint instead (see SerialLogQueryOptions),
    // so bootstrapping no longer loads the whole ledger.
  ]);

  return {
    branches,
    products,
    stock,
    assets,
    customerDevices,
    customers,
    purchaseOrders,
    purchaseInvoices,
    shipments,
    stockOperations,
    auditLogs,
    transactionLogs,
    suppliers,
    users,
    approvalRequests,
    categories,
    uom,
    locations,
    companyProfile,
    damageRecords,
    vendorPayments,
    vendorOpeningBalanceTotal,
  };
}
