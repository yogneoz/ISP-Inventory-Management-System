/**
 * Repository for the reports domain — every SQL string and param-list
 * builder for the financial-summary report lives here, following the same
 * pattern as ./inventory.repo.ts and ./auth.repo.ts.
 *
 * reports.controller.ts keeps only HTTP concerns (request shaping, fiscal-
 * year selection, in-memory fallback, response bodies); query text and
 * column lists are defined once in this layer.
 */

// ---------------------------------------------------------------------------
// Shared scope accumulators (dynamic WHERE building, fiscal-year + branch)
// ---------------------------------------------------------------------------

export interface FiscalBranchScope {
  fiscalYearId?: string;
  branchId?: string;
}

export interface AdDateRangeScope {
  startDateAD?: string;
  endDateAD?: string;
  branchId?: string;
}

/** Adds `fiscal_year_id = $n` when a fiscal year is selected. */
export function appendFiscalYearScope(conds: string[], params: unknown[], fiscalYearId?: string): void {
  if (fiscalYearId) {
    params.push(fiscalYearId);
    conds.push(`fiscal_year_id = $${params.length}`);
  }
}

/** Adds `branch_id = $n` when a concrete branch is selected. */
export function appendBranchScope(conds: string[], params: unknown[], branchId?: string): void {
  if (branchId) {
    params.push(branchId);
    conds.push(`branch_id = $${params.length}`);
  }
}

/** Adds an inclusive `[start, end]` date range on an AD date/timestamp column. */
export function appendAdDateRangeScope(
  conds: string[],
  params: unknown[],
  column: string,
  startDateAD?: string,
  endDateAD?: string
): void {
  if (startDateAD && endDateAD) {
    params.push(startDateAD, endDateAD);
    conds.push(`${column} >= $${params.length - 1}`);
    conds.push(`${column} <= $${params.length}`);
  }
}

/** Joins accumulated conditions into the final WHERE clause (or none). */
export function whereClause(conds: string[]): string {
  return conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
}

// ---------------------------------------------------------------------------
// Inventory asset value
// ---------------------------------------------------------------------------

/**
 * Inventory Asset Value: SUM(quantity * cost_price). For any year OTHER than
 * the current fiscal year, inventory is valued from that year's opening-stock
 * ledger (fiscal_year_opening_stock) — the live inventory_stock balance only
 * represents the current fiscal year and must not be reported for past or
 * closed years.
 */
export function buildInventoryValueQuery(opts: {
  useOpeningStock: boolean;
  fiscalYearId?: string;
  branchId?: string;
}): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  if (opts.useOpeningStock) {
    let sql = `SELECT SUM(os.quantity_on_hand * p.cost_price) AS total
                  FROM fiscal_year_opening_stock os
                  JOIN products p ON os.product_id = p.id
                  WHERE os.fiscal_year_id = $1`;
    params.push(opts.fiscalYearId);
    if (opts.branchId) {
      params.push(opts.branchId);
      sql += ` AND os.branch_id = $${params.length}`;
    }
    return { sql, params };
  }
  const conds: string[] = [];
  let sql = `SELECT SUM(s.quantity_on_hand * p.cost_price) AS total
                  FROM inventory_stock s
                  JOIN products p ON s.product_id = p.id`;
  if (opts.branchId) {
    params.push(opts.branchId);
    conds.push(`s.branch_id = $${params.length}`);
  }
  if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// Fixed asset value
// ---------------------------------------------------------------------------

/** Fixed Asset Value: net book value is a live snapshot; no per-FY history. */
export function buildFixedAssetValueQuery(
  hasBranch: boolean,
  branchId?: string
): { sql: string; params: unknown[] } {
  return {
    sql:
      `SELECT SUM(net_book_value) AS total FROM fixed_assets` + (hasBranch ? ' WHERE branch_id = $1' : ''),
    params: hasBranch ? [branchId] : [],
  };
}

// ---------------------------------------------------------------------------
// Accounts payable components
// ---------------------------------------------------------------------------

/** Current-period invoiced totals + VAT input tax, FY/branch scoped. */
export function buildPurchaseInvoiceTotalsQuery(opts: FiscalBranchScope): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  appendFiscalYearScope(conds, params, opts.fiscalYearId);
  appendBranchScope(conds, params, opts.branchId);
  return {
    sql:
      `SELECT SUM(grand_total) AS total_invoiced, SUM(vat_amount) AS total_vat FROM purchase_invoices` +
      whereClause(conds),
    params,
  };
}

/** Opening-balance carry-forward (same FY + branch scope). */
export function buildVendorOpeningBalanceQuery(opts: FiscalBranchScope): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  appendFiscalYearScope(conds, params, opts.fiscalYearId);
  appendBranchScope(conds, params, opts.branchId);
  return {
    sql:
      `SELECT COALESCE(SUM(opening_balance), 0)::float AS total_ob FROM vendor_opening_balances` +
      whereClause(conds),
    params,
  };
}

/**
 * Posted vendor payments in the same scope. Vendor payments are scoped by
 * payment_date_ad date range (like the bootstrap endpoint), because older
 * payments may have a NULL fiscal_year_id.
 */
export function buildVendorPaymentsQuery(opts: AdDateRangeScope): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  appendAdDateRangeScope(conds, params, 'payment_date_ad', opts.startDateAD, opts.endDateAD);
  appendBranchScope(conds, params, opts.branchId);
  conds.push(`status = 'POSTED'`);
  return {
    sql:
      `SELECT COALESCE(SUM(amount), 0)::float AS total_paid FROM vendor_payments` + whereClause(conds),
    params,
  };
}

// ---------------------------------------------------------------------------
// Damage loss + sales-derived revenue/COGS
// ---------------------------------------------------------------------------

/** Damage Loss Value, FY/branch scoped. */
export function buildDamageLossQuery(opts: FiscalBranchScope): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  appendFiscalYearScope(conds, params, opts.fiscalYearId);
  appendBranchScope(conds, params, opts.branchId);
  return {
    sql: `SELECT SUM(total_value) AS total FROM stock_operations` + whereClause(conds),
    params,
  };
}

/** Priced STOCK_OUT sale operations in the same FY/branch scope as inventory. */
export function buildStockOutOpsQuery(opts: AdDateRangeScope): { sql: string; params: unknown[] } {
  const conds: string[] = [`type = 'STOCK_OUT'`];
  const params: unknown[] = [];
  appendAdDateRangeScope(conds, params, 'date_ad', opts.startDateAD, opts.endDateAD);
  appendBranchScope(conds, params, opts.branchId);
  return {
    sql: `SELECT items FROM stock_operations` + whereClause(conds),
    params,
  };
}

/** Cost prices are needed to resolve cost for sale lines without unitCost. */
export const PRODUCT_COST_PRICE_SQL = 'SELECT id, cost_price AS "costPrice" FROM products';
