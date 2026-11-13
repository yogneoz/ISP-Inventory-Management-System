/**
 * ACC-4 inventory-to-finance reconciliation SQL.
 *
 * The register is the authoritative quantity and moving-average valuation; the
 * GL inventory account is the authoritative posted value. The report compares
 * them by branch and product, then compares the period's COGS and stock-expense
 * journals with the transaction rows that describe the same movements.
 */

export const INVENTORY_VALUATION_ROWS_SQL = `SELECT s.branch_id AS "branchId",
  b.code AS "branchCode",
  b.name AS "branchName",
  s.product_id AS "productId",
  COALESCE(p.sku, '') AS sku,
  COALESCE(p.name, s.product_id) AS "productName",
  s.quantity_on_hand::float8 AS quantity,
  s.average_cost::float8 AS "averageCost",
  ROUND(s.quantity_on_hand * s.average_cost, 2)::float8 AS value
FROM inventory_stock s
JOIN branches b ON b.id = s.branch_id
LEFT JOIN products p ON p.id = s.product_id
WHERE ($1::varchar IS NULL OR s.branch_id = $1)
ORDER BY b.code ASC, p.sku ASC NULLS LAST, s.product_id ASC`;

/** The INVENTORY control balance through the as-of date, by branch. */
export const INVENTORY_CONTROL_SQL = `SELECT jl.branch_id AS "branchId",
  COALESCE(SUM(jl.debit - jl.credit), 0)::float8 AS balance
FROM gl_journal_lines jl
JOIN gl_journals j ON j.id = jl.journal_id
WHERE jl.account_id = $1
  AND j.status = 'POSTED'
  AND j.journal_date_ad <= $3::date
  AND ($2::varchar IS NULL OR jl.branch_id = $2)
GROUP BY jl.branch_id
ORDER BY jl.branch_id ASC`;

/** COGS posted in the period, by branch. */
export const INVENTORY_COGS_GL_SQL = `SELECT jl.branch_id AS "branchId",
  COALESCE(SUM(jl.debit - jl.credit), 0)::float8 AS amount
FROM gl_journal_lines jl
JOIN gl_journals j ON j.id = jl.journal_id
WHERE jl.account_id = $1
  AND j.status = 'POSTED'
  AND j.journal_date_ad >= $3::date
  AND j.journal_date_ad <= $4::date
  AND ($2::varchar IS NULL OR jl.branch_id = $2)
GROUP BY jl.branch_id
ORDER BY jl.branch_id ASC`;

/**
 * Sale and return movement rows carry the exact issue cost the COGS journal
 * used. The signed cost is `-quantity_changed * unit_cost`: a sale has a
 * negative quantity and adds COGS, a restock has a positive quantity and
 * reverses it, and the cancellation rows use the same sign convention.
 */
export const INVENTORY_COGS_SOURCE_SQL = `SELECT tl.branch_id AS "branchId",
  COALESCE(SUM(-tl.quantity_changed * tl.unit_cost), 0)::float8 AS amount
FROM transaction_logs tl
WHERE tl.change_type IN (
  'SALES_INVOICE', 'SALES_RETURN', 'SALES_INVOICE_CANCELLED', 'SALES_RETURN_CANCELLED',
  'SALE', 'RETURN'
)
  AND tl.timestamp_ad::date >= $2::date
  AND tl.timestamp_ad::date <= $3::date
  AND ($1::varchar IS NULL OR tl.branch_id = $1)
GROUP BY tl.branch_id
ORDER BY tl.branch_id ASC`;

/** Stock-expense posted in the period, by branch. */
export const INVENTORY_STOCK_EXPENSE_GL_SQL = `SELECT jl.branch_id AS "branchId",
  COALESCE(SUM(jl.debit - jl.credit), 0)::float8 AS amount
FROM gl_journal_lines jl
JOIN gl_journals j ON j.id = jl.journal_id
WHERE jl.account_id = $1
  AND j.status = 'POSTED'
  AND j.journal_date_ad >= $3::date
  AND j.journal_date_ad <= $4::date
  AND ($2::varchar IS NULL OR jl.branch_id = $2)
GROUP BY jl.branch_id
ORDER BY jl.branch_id ASC`;

/** Adjustment and damage documents with the same signed value convention. */
export const INVENTORY_STOCK_EXPENSE_SOURCE_SQL = `SELECT tl.branch_id AS "branchId",
  COALESCE(SUM(-tl.quantity_changed * tl.unit_cost), 0)::float8 AS amount
FROM transaction_logs tl
WHERE tl.change_type IN (
  'STOCK_ADJUSTMENT', 'MANUAL_ADJUSTMENT', 'DAMAGE', 'DAMAGE_REVERSED',
  'PHYSICAL_AUDIT_EXCESS', 'PHYSICAL_AUDIT_SHORTAGE', 'PULLOUT',
  'CONSUMABLE_ISSUE', 'STOCK_OUT', 'DISPOSAL'
)
  AND tl.timestamp_ad::date >= $2::date
  AND tl.timestamp_ad::date <= $3::date
  AND ($1::varchar IS NULL OR tl.branch_id = $1)
GROUP BY tl.branch_id
ORDER BY tl.branch_id ASC`;

export const INVENTORY_BRANCHES_SQL = `SELECT id AS "branchId", code AS "branchCode", name AS "branchName"
FROM branches
WHERE ($1::varchar IS NULL OR id = $1)
ORDER BY code ASC`;
