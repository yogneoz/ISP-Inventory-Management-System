/**
 * Repository for the sales domain — every SQL string and param-list builder
 * for sales invoices and sales returns lives here, following the same pattern
 * as ./procurement.repo.ts.
 *
 * sales.controller.ts keeps only HTTP concerns (request shaping, cache
 * updates, audit logging, response bodies); query text and column lists are
 * defined once in this layer.
 */
import type { QueryResult } from 'pg';

/** Minimal query interface satisfied by the pg Pool (and test doubles). */
export interface QueryExecutor {
  query(text: string, values?: unknown[]): Promise<QueryResult<any>>;
}

// ---------------------------------------------------------------------------
// Sales Invoices (INV-…)
// ---------------------------------------------------------------------------

export const SI_SELECT_COLUMNS =
  'id, invoice_number AS "invoiceNumber", customer_id AS "customerId", customer_name AS "customerName", branch_id AS "branchId", invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS", due_date_ad AS "dueDateAD", due_date_bs AS "dueDateBS", taxable_amount AS "taxableAmount", vat_amount AS "vatAmount", non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal", payment_status AS "paymentStatus", payment_method AS "paymentMethod", amount_paid AS "amountPaid", status, notes, items, fiscal_year_id AS "fiscalYearId", is_demo AS "isDemo", created_by AS "createdBy", created_at AS "createdAt"';

export function buildSalesInvoiceListSql(branchId?: unknown): { sql: string; params: unknown[] } {
  const filter = branchId && branchId !== 'ALL';
  return {
    sql:
      `SELECT ${SI_SELECT_COLUMNS} FROM sales_invoices` +
      (filter ? ' WHERE branch_id = $1' : '') +
      ' ORDER BY created_at DESC',
    params: filter ? [branchId] : [],
  };
}

export interface SalesInvoiceQueryOptions {
  branchId?: unknown;
  /** Maps to payment_status (UNPAID / PARTIAL / PAID / …). */
  status?: unknown;
  /** Free-text search across invoice # and customer name. */
  query?: unknown;
  /** Inclusive lower bound on invoice_date_ad, AD YYYY-MM-DD. */
  dateFromAD?: unknown;
  /** Inclusive upper bound on invoice_date_ad, AD YYYY-MM-DD. */
  dateToAD?: unknown;
}

/** WHERE fragment shared by the sales-invoices count and paged list queries. */
export function buildSalesInvoiceWhere(opts: SalesInvoiceQueryOptions): { whereSql: string; params: unknown[] } {
  let whereSql = ' WHERE 1=1';
  const params: unknown[] = [];
  if (opts.branchId && opts.branchId !== 'ALL') {
    params.push(opts.branchId as string);
    whereSql += ` AND branch_id = $${params.length}`;
  }
  if (opts.status && opts.status !== 'ALL') {
    params.push(opts.status as string);
    whereSql += ` AND payment_status = $${params.length}`;
  }
  if (opts.query && typeof opts.query === 'string' && opts.query.trim()) {
    const like = `%${opts.query.trim().toLowerCase()}%`;
    params.push(like);
    whereSql += ` AND (LOWER(invoice_number) LIKE $${params.length}` +
      ` OR LOWER(customer_name) LIKE $${params.length})`;
  }
  if (typeof opts.dateFromAD === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateFromAD)) {
    params.push(opts.dateFromAD);
    whereSql += ` AND invoice_date_ad >= $${params.length}::date`;
  }
  if (typeof opts.dateToAD === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateToAD)) {
    params.push(opts.dateToAD);
    whereSql += ` AND invoice_date_ad <= $${params.length}::date`;
  }
  return { whereSql, params };
}

/** Filtered row count for the paged envelope. */
export function buildSalesInvoiceCountQuery(opts: SalesInvoiceQueryOptions): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildSalesInvoiceWhere(opts);
  return { sql: 'SELECT COUNT(*)::int AS count FROM sales_invoices' + whereSql, params };
}

/** Paged sales-invoices list query (1-indexed page, clamped LIMIT/OFFSET). */
export function buildSalesInvoicePagedQuery(opts: SalesInvoiceQueryOptions, paging?: { page: number; pageSize: number }): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildSalesInvoiceWhere(opts);
  let sql = `SELECT ${SI_SELECT_COLUMNS} FROM sales_invoices` + whereSql + ' ORDER BY created_at DESC';
  if (paging) {
    const pageSize = Math.max(1, Math.min(500, Math.floor(paging.pageSize)));
    const page = Math.max(1, Math.floor(paging.page));
    sql += ` LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
  }
  return { sql, params };
}

export const SI_INSERT_SQL = `INSERT INTO sales_invoices (
   id, invoice_number, customer_id, customer_name, branch_id, invoice_date_ad, invoice_date_bs,
   due_date_ad, due_date_bs, taxable_amount, vat_amount, non_taxable_amount, grand_total,
   payment_status, payment_method, amount_paid, notes, items
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`;

export function siInsertParams(inv: Record<string, any>, itemsJson: string): unknown[] {
  return [
    inv.id,
    inv.invoiceNumber,
    inv.customerId || null,
    inv.customerName || 'Walk-in Customer',
    inv.branchId,
    inv.invoiceDateAD,
    inv.invoiceDateBS,
    inv.dueDateAD || null,
    inv.dueDateBS || null,
    Number(inv.taxableAmount) || 0,
    Number(inv.vatAmount) || 0,
    Number(inv.nonTaxableAmount) || 0,
    Number(inv.grandTotal) || 0,
    inv.paymentStatus || 'UNPAID',
    inv.paymentMethod || 'CREDIT',
    Number(inv.amountPaid) || 0,
    inv.notes || '',
    itemsJson,
  ];
}

/** Finds a sales invoice by id or number (duplicate guard + return lookups). */
export const SI_FIND_SQL =
  'SELECT id, invoice_number AS "invoiceNumber", branch_id AS "branchId", items FROM sales_invoices WHERE id = $1 OR invoice_number = $1 LIMIT 1';

/** Duplicate guard before insert. */
export const SI_EXISTS_SQL = 'SELECT 1 FROM sales_invoices WHERE id = $1 OR invoice_number = $2 LIMIT 1';

/** Loads one invoice (with its status and items) by id or invoice number. */
export const SI_FIND_ONE_SQL =
  `SELECT ${SI_SELECT_COLUMNS} FROM sales_invoices WHERE id = $1 OR invoice_number = $1 LIMIT 1`;

/**
 * Deducts sold stock from the branch. The WHERE quantity_on_hand >= qty guard
 * makes the UPDATE affect 0 rows when stock is insufficient — the controller
 * must check rowCount and abort the transaction (no negative stock).
 */
export const SI_DEDUCT_STOCK_SQL = `UPDATE inventory_stock
 SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP
 WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1`;

/** Restores stock when a sales invoice is cancelled/deleted. */
export const SI_RESTORE_STOCK_SQL = `UPDATE inventory_stock
 SET quantity_on_hand = quantity_on_hand + $1, last_updated = CURRENT_TIMESTAMP
 WHERE product_id = $2 AND branch_id = $3`;

/** Appends a SALES_INVOICE ledger row (negative quantity change). Mirrors PI_TXN_LOG_SQL. */
export const SI_TXN_LOG_SQL = `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
 VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8, $9, $10, $11, $12)`;

export function siTxnLogParams(inv: Record<string, any>, item: Record<string, any>, branchId: string, itemIndex = 0): unknown[] {
  return [
    `txn-${Date.now()}-${item.productId}-si-${itemIndex}`,
    `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
    item.productId,
    item.sku || '',
    item.productName || 'Product',
    branchId,
    'SALES_INVOICE',
    -(Math.abs(Number(item.quantity)) || 0),
    Number(item.unitPrice) || 0,
    inv.invoiceNumber,
    inv.invoiceDateAD || new Date().toISOString(),
    inv.invoiceDateBS || (() => { throw new Error('sales-invoice insert requires invoiceDateBS resolved from bs_day_records'); })(),
  ];
}

// ---------------------------------------------------------------------------
// Sales invoice serial claim (serial_log IN_STOCK → CUSTOMER_ASSIGNED)
// ---------------------------------------------------------------------------

/**
 * Locks the serial_log rows a sales invoice is about to sell. The partial
 * unique index on lower(trim(device_serial)) makes that key single-valued, so
 * FOR UPDATE pins each unit's row against a concurrent sale of the same
 * serial. `key` is the normalized match key so callers can line the rows up
 * with their own parsed serial pairs.
 */
export const SI_LOCK_SERIAL_SQL = `SELECT lower(trim(device_serial)) AS key,
 device_serial, pon_serial, mac_address, product_id, branch_id, status
 FROM serial_log
 WHERE lower(trim(device_serial)) = ANY($1::text[])
 FOR UPDATE`;

/** History entry appended to every claimed serial (mirrors SR_SERIAL_FLIP_SQL). */
export function siClaimSerialParams(
  inv: Record<string, any>,
  history: unknown[],
  serialKeys: string[]
): unknown[] {
  return [inv.customerId || null, inv.customerName || null, inv.invoiceNumber, JSON.stringify(history), serialKeys];
}

/**
 * Claims the locked serials for this invoice: IN_STOCK → CUSTOMER_ASSIGNED,
 * stamped with the buyer and the invoice number. Sales Returns later flip
 * them back with SR_SERIAL_FLIP_SQL. The status predicate means a serial that
 * slipped to another state between lock and claim makes rowCount miss, which
 * the caller turns into a rollback instead of a silent sell.
 */
export const SI_CLAIM_SERIAL_SQL = `UPDATE serial_log
 SET status = 'CUSTOMER_ASSIGNED',
     customer_id = $1,
     customer_name = $2,
     source_type = 'SALES_INVOICE',
     source_id = $3,
     history_json = (COALESCE(NULLIF(history_json, ''), '[]')::jsonb || $4::jsonb)::text,
     updated_at = CURRENT_TIMESTAMP
 WHERE lower(trim(device_serial)) = ANY($5::text[])
   AND status = 'IN_STOCK'`;

// ---------------------------------------------------------------------------
// Sales invoice cancel / void (POST /api/sales-invoices/:id/cancel)
// ---------------------------------------------------------------------------

/**
 * Locks the invoice row for the cancel transaction. FOR UPDATE serialises the
 * void against a concurrent payment/return touching the same invoice, and the
 * returned columns are exactly what the guards and the reversal need.
 */
export const SI_LOCK_FOR_CANCEL_SQL = `SELECT id, invoice_number AS "invoiceNumber",
 branch_id AS "branchId", status, amount_paid AS "amountPaid", items
 FROM sales_invoices
 WHERE id = $1 OR invoice_number = $1
 FOR UPDATE`;

/**
 * Marks the invoice CANCELLED. The `status = 'POSTED'` predicate makes the flip
 * race-safe: a second concurrent void finds 0 rows and the controller rolls
 * back instead of double-restoring stock.
 */
export const SI_CANCEL_SQL = `UPDATE sales_invoices
 SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
 WHERE (id = $1 OR invoice_number = $1) AND status = 'POSTED'`;

/** Posted receipts must be reversed before the invoice they pay can be voided. */
export const SI_BLOCKING_PAYMENTS_SQL = `SELECT count(*)::int AS count
 FROM customer_payments
 WHERE (invoice_id = $1 OR invoice_number = $1) AND status = 'POSTED'`;

/** Live credit notes must be cancelled before their invoice is voided. */
export const SI_BLOCKING_RETURNS_SQL = `SELECT count(*)::int AS count
 FROM sales_returns
 WHERE (original_invoice_id = $1 OR original_invoice_number = $1) AND status <> 'CANCELLED'`;

/**
 * The serials this invoice still holds claimed (one row per unit), locked so a
 * concurrent sale/return of the same units cannot slip in mid-cancel. Returns
 * rows that a sales return already flipped back, so they are never released
 * twice (returns are blocked by SI_BLOCKING_RETURNS_SQL anyway).
 */
export const SI_CLAIMED_SERIALS_SQL = `SELECT device_serial
 FROM serial_log
 WHERE source_type = 'SALES_INVOICE' AND source_id = $1 AND status = 'CUSTOMER_ASSIGNED'
 FOR UPDATE`;

/**
 * Releases the claimed serials: CUSTOMER_ASSIGNED → IN_STOCK, customer stamp
 * cleared, history entry appended (mirrors SR_SERIAL_FLIP_SQL). The source_*
 * columns stay stamped with the original sale so provenance survives; the
 * history records why the unit came back.
 */
export const SI_RELEASE_SERIAL_SQL = `UPDATE serial_log
 SET status = 'IN_STOCK',
     customer_id = NULL,
     customer_name = NULL,
     history_json = (COALESCE(NULLIF(history_json, ''), '[]')::jsonb || $1::jsonb)::text,
     updated_at = CURRENT_TIMESTAMP
 WHERE device_serial = ANY($2::text[])
   AND status = 'CUSTOMER_ASSIGNED'`;

/**
 * Appends the compensating ledger row for a cancelled invoice — the same
 * column order as SI_TXN_LOG_SQL, but with change_type
 * SALES_INVOICE_CANCELLED, a POSITIVE quantity (the sale wrote negative) and
 * the cancellation date, so the movement ledger nets the sale back to zero
 * and the reversal stays distinguishable from the original sale.
 */
export function siCancelTxnLogParams(
  inv: Record<string, any>,
  item: Record<string, any>,
  branchId: string,
  itemIndex = 0,
  cancelDate?: { ad: string; bs: string }
): unknown[] {
  return [
    `txn-${Date.now()}-${item.productId}-sic-${itemIndex}`,
    `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
    item.productId,
    item.sku || '',
    item.productName || 'Product',
    branchId,
    'SALES_INVOICE_CANCELLED',
    Math.abs(Number(item.quantity)) || 0,
    Number(item.unitPrice) || 0,
    inv.invoiceNumber,
    cancelDate?.ad || inv.invoiceDateAD || new Date().toISOString(),
    cancelDate?.bs || inv.invoiceDateBS || (() => { throw new Error('sales-invoice cancel requires a BS date resolved from bs_day_records'); })(),
  ];
}

// ---------------------------------------------------------------------------
// Sales Returns (Credit Notes, CN-…)
// ---------------------------------------------------------------------------

export const SR_SELECT_COLUMNS =
  'id, return_number AS "returnNumber", original_invoice_id AS "originalInvoiceId", original_invoice_number AS "originalInvoiceNumber", customer_id AS "customerId", customer_name AS "customerName", branch_id AS "branchId", return_date_ad AS "returnDateAD", return_date_bs AS "returnDateBS", reason, restockable, notes, taxable_amount AS "taxableAmount", vat_amount AS "vatAmount", non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal", status, items, fiscal_year_id AS "fiscalYearId", is_demo AS "isDemo", created_by AS "createdBy", created_at AS "createdAt"';

export function buildSalesReturnListSql(branchId?: unknown): { sql: string; params: unknown[] } {
  const filter = branchId && branchId !== 'ALL';
  return {
    sql:
      `SELECT ${SR_SELECT_COLUMNS} FROM sales_returns` +
      (filter ? ' WHERE branch_id = $1' : '') +
      ' ORDER BY created_at DESC',
    params: filter ? [branchId] : [],
  };
}

export interface SalesReturnQueryOptions {
  branchId?: unknown;
  status?: unknown;
  /** Free-text search across return #, original invoice #, customer and the items blob. */
  query?: unknown;
  /** Inclusive lower bound on return_date_ad, AD YYYY-MM-DD. */
  dateFromAD?: unknown;
  /** Inclusive upper bound on return_date_ad, AD YYYY-MM-DD. */
  dateToAD?: unknown;
}

/** WHERE fragment shared by the sales-returns count and paged list queries. */
export function buildSalesReturnWhere(opts: SalesReturnQueryOptions): { whereSql: string; params: unknown[] } {
  let whereSql = ' WHERE 1=1';
  const params: unknown[] = [];
  if (opts.branchId && opts.branchId !== 'ALL') {
    params.push(opts.branchId as string);
    whereSql += ` AND branch_id = $${params.length}`;
  }
  if (opts.status && opts.status !== 'ALL') {
    params.push(opts.status as string);
    whereSql += ` AND status = $${params.length}`;
  }
  if (opts.query && typeof opts.query === 'string' && opts.query.trim()) {
    const like = `%${opts.query.trim().toLowerCase()}%`;
    params.push(like);
    whereSql += ` AND (LOWER(return_number) LIKE $${params.length}` +
      ` OR LOWER(original_invoice_number) LIKE $${params.length}` +
      ` OR LOWER(customer_name) LIKE $${params.length}` +
      ` OR LOWER(items::text) LIKE $${params.length})`;
  }
  if (typeof opts.dateFromAD === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateFromAD)) {
    params.push(opts.dateFromAD);
    whereSql += ` AND return_date_ad >= $${params.length}::date`;
  }
  if (typeof opts.dateToAD === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateToAD)) {
    params.push(opts.dateToAD);
    whereSql += ` AND return_date_ad <= $${params.length}::date`;
  }
  return { whereSql, params };
}

/** Filtered row count for the paged envelope. */
export function buildSalesReturnCountQuery(opts: SalesReturnQueryOptions): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildSalesReturnWhere(opts);
  return { sql: 'SELECT COUNT(*)::int AS count FROM sales_returns' + whereSql, params };
}

/** Paged sales-returns list query (1-indexed page, clamped LIMIT/OFFSET). */
export function buildSalesReturnPagedQuery(opts: SalesReturnQueryOptions, paging?: { page: number; pageSize: number }): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildSalesReturnWhere(opts);
  let sql = `SELECT ${SR_SELECT_COLUMNS} FROM sales_returns` + whereSql + ' ORDER BY created_at DESC';
  if (paging) {
    const pageSize = Math.max(1, Math.min(500, Math.floor(paging.pageSize)));
    const page = Math.max(1, Math.floor(paging.page));
    sql += ` LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
  }
  return { sql, params };
}

export const SR_INSERT_SQL = `INSERT INTO sales_returns (
   id, return_number, original_invoice_id, original_invoice_number, customer_id, customer_name, branch_id,
   return_date_ad, return_date_bs, reason, restockable, notes, taxable_amount, vat_amount,
   non_taxable_amount, grand_total, status, items
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`;

export function srInsertParams(ret: Record<string, any>, itemsJson: string): unknown[] {
  return [
    ret.id,
    ret.returnNumber,
    ret.originalInvoiceId || null,
    ret.originalInvoiceNumber || null,
    ret.customerId || null,
    ret.customerName || 'Walk-in Customer',
    ret.branchId,
    ret.returnDateAD,
    ret.returnDateBS,
    ret.reason || 'DEFECTIVE',
    ret.restockable !== false,
    ret.notes || '',
    Number(ret.taxableAmount) || 0,
    Number(ret.vatAmount) || 0,
    Number(ret.nonTaxableAmount) || 0,
    Number(ret.grandTotal) || 0,
    ret.status || 'POSTED',
    itemsJson,
  ];
}

/** Finds a return by id or number (duplicate guard before insert). */
export const SR_EXISTS_SQL = 'SELECT 1 FROM sales_returns WHERE id = $1 OR return_number = $2 LIMIT 1';

/** Locks the original sales-invoice row for the over-return calculation. */
export const SR_LOCK_INVOICE_SQL =
  'SELECT id, invoice_number AS "invoiceNumber", branch_id AS "branchId", items FROM sales_invoices WHERE id = $1 OR invoice_number = $1 FOR UPDATE';

/** Total already-returned quantity for one (invoice, product) pair across POSTED returns. */
export const SR_RETURNED_QTY_SQL =
  `SELECT COALESCE(SUM((item->>'quantity')::numeric), 0)::float AS returned_qty
   FROM sales_returns, jsonb_array_elements(items) AS item
   WHERE original_invoice_id = $1 AND item->>'productId' = $2 AND status = 'POSTED'`;

/**
 * Restocks a returned unit (sales return posts stock back into the branch).
 * Non-restockable returns skip this and the unit is presumed damaged.
 */
export const SR_RESTOCK_SQL = `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, min_reorder_level)
 VALUES ($1, $2, $3, $4, 5)
 ON CONFLICT (product_id, branch_id) DO UPDATE SET
   quantity_on_hand = inventory_stock.quantity_on_hand + $4,
   last_updated = CURRENT_TIMESTAMP`;

export function srRestockParams(branchId: string, item: Record<string, any>): unknown[] {
  return [`stk-${branchId.toLowerCase()}-${item.productId}`, item.productId, branchId, Math.abs(Number(item.quantity)) || 0];
}

/** Deducts stock again when a posted sales return is cancelled. */
export const SR_REDEDUCT_STOCK_SQL = `UPDATE inventory_stock
 SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP
 WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1`;

/** Cancels a return only while it is still POSTED (idempotent no-op otherwise). */
export const SR_CANCEL_SQL = `UPDATE sales_returns SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'POSTED'`;

/** Appends a SALES_RETURN ledger row (positive quantity change). Mirrors PI_TXN_LOG_SQL. */
export const SR_TXN_LOG_SQL = `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
 VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8, $9, $10, $11, $12)`;

export function srTxnLogParams(ret: Record<string, any>, item: Record<string, any>, branchId: string, itemIndex = 0): unknown[] {
  return [
    `txn-${Date.now()}-${item.productId}-sr-${itemIndex}`,
    `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
    item.productId,
    item.sku || '',
    item.productName || 'Product',
    branchId,
    'SALES_RETURN',
    Math.abs(Number(item.quantity)) || 0,
    Number(item.unitPrice) || 0,
    ret.returnNumber,
    ret.returnDateAD || new Date().toISOString(),
    ret.returnDateBS || (() => { throw new Error('sales-return insert requires returnDateBS resolved from bs_day_records'); })(),
  ];
}

/** Loads one sales return by id or number (cancel flow). */
export const SR_FIND_ONE_SQL = `SELECT ${SR_SELECT_COLUMNS} FROM sales_returns WHERE id = $1 OR return_number = $1 LIMIT 1`;

// ---------------------------------------------------------------------------
// Customer Receivables Ledger
// ---------------------------------------------------------------------------

/** Sales invoices for one customer — receivables-ledger debit lines. */
export const LEDGER_CUSTOMER_INVOICES_SQL =
  `SELECT id, invoice_number AS "invoiceNumber", branch_id AS "branchId",
          invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS",
          grand_total AS "grandTotal", amount_paid AS "amountPaid",
          payment_status AS "paymentStatus", notes
   FROM sales_invoices
   WHERE customer_id = $1 OR (customer_id IS NULL AND (LOWER(customer_name) = LOWER($2) OR LOWER(customer_name) LIKE LOWER($3)))`;

/** Posted sales returns (credit notes) for one customer — receivables-ledger credit lines. */
export const LEDGER_CUSTOMER_RETURNS_SQL =
  `SELECT id, return_number AS "returnNumber", original_invoice_number AS "originalInvoiceNumber",
          branch_id AS "branchId", return_date_ad AS "returnDateAD", return_date_bs AS "returnDateBS",
          grand_total AS "grandTotal", notes
   FROM sales_returns
   WHERE status = 'POSTED'
     AND (customer_id = $1 OR (customer_id IS NULL AND (LOWER(customer_name) = LOWER($2) OR LOWER(customer_name) LIKE LOWER($3))))`;

/**
 * Flips serial-tracked units when a sales return posts (back to IN_STOCK) or
 * when its cancellation re-issues them (back to SOLD). history_json is a TEXT
 * JSON array; the append keeps the {status, sourceType, sourceId, dateAD,
 * notes} entry shape used by serials.service.ts.
 */
export const SR_SERIAL_FLIP_SQL = `UPDATE serial_log
 SET status = $2,
     customer_id = NULL,
     customer_name = NULL,
     updated_at = CURRENT_TIMESTAMP,
     history_json = (COALESCE(NULLIF(history_json, ''), '[]')::jsonb || $3::jsonb)::text
 WHERE device_serial = ANY($1::text[])`;

/**
 * Non-restockable sales returns route their units into the damage register
 * instead of restocking them (reason RETURN_DAMAGE; status IDENTIFIED so the
 * existing damage/disposal workflow picks them up).
 */
export const SR_DAMAGE_INSERT_SQL = `INSERT INTO damage_records (
   id, damage_reference, product_id, branch_id, quantity_damaged, unit_cost, total_cost,
   damage_date_ad, damage_date_bs, damage_reason, status, notes, is_demo, created_by
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'RETURN_DAMAGE', 'IDENTIFIED', $10, FALSE, $11)`;

export function srDamageInsertParams(
  ret: Record<string, any>,
  item: Record<string, any>,
  branchId: string,
  damageReference: string,
  createdBy: string | undefined
): unknown[] {
  const qty = Math.abs(Number(item.quantity)) || 0;
  const unitCost = Number(item.unitPrice) || 0;
  return [
    `dmg-${ret.id}-${damageReference.split('-').pop()}`,
    damageReference,
    item.productId,
    branchId,
    qty,
    unitCost,
    Math.round(qty * unitCost * 100) / 100,
    ret.returnDateAD,
    ret.returnDateBS || '',
    `Sales return ${ret.returnNumber} (non-restockable)${ret.notes ? ` — ${ret.notes}` : ''}`,
    createdBy || 'sales-return',
  ];
}

/** Cancels the damage rows created by a non-restockable return when it is cancelled. */
export const SR_DAMAGE_CANCEL_SQL = `UPDATE damage_records
 SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
 WHERE damage_reference LIKE $1 AND status = 'IDENTIFIED'`;

/** Approves a DRAFT return: flips status only while still DRAFT (race-safe). */
export const SR_POST_DRAFT_SQL = `UPDATE sales_returns SET status = 'POSTED', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'DRAFT'`;

/** Cancels a DRAFT return (no stock effect — it never posted). */
export const SR_CANCEL_DRAFT_SQL = `UPDATE sales_returns SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'DRAFT'`;

// ---------------------------------------------------------------------------
// Customer Payments Sub-ledger (CR-… cash receipts / BR-… bank receipts)
// ---------------------------------------------------------------------------

export const CP_INSERT_SQL = `INSERT INTO customer_payments (
   id, payment_number, customer_id, customer_name, branch_id, invoice_id, invoice_number,
   payment_date_ad, payment_date_bs, amount, payment_method, bank_name, bank_branch,
   account_number, cheque_number, cheque_date_ad, cheque_date_bs, transaction_reference,
   notes, status, created_by
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'POSTED', $20)`;

export function cpInsertParams(p: Record<string, any>): unknown[] {
  return [
    p.id,
    p.paymentNumber,
    p.customerId || null,
    p.customerName || 'Walk-in Customer',
    p.branchId || null,
    p.invoiceId || null,
    p.invoiceNumber || null,
    p.paymentDateAD,
    p.paymentDateBS || null,
    Number(p.amount),
    p.paymentMethod || 'CASH',
    p.bankName || null,
    p.bankBranch || null,
    p.accountNumber || null,
    p.chequeNumber || null,
    p.chequeDateAD || null,
    p.chequeDateBS || null,
    p.transactionReference || null,
    p.notes || null,
    p.createdBy || 'system',
  ];
}

/** Locks a payment row (FOR UPDATE) before a status transition. */
export const CP_LOCK_STATUS_SQL = 'SELECT status FROM customer_payments WHERE id = $1 FOR UPDATE';

/** Reverses a payment (mirrors VP_REVERSE_SQL). */
export const CP_REVERSE_SQL = `UPDATE customer_payments SET
   status = 'REVERSED',
   reversal_reason = $1,
   reversed_by = $2,
   reversed_at_ad = CURRENT_TIMESTAMP,
   updated_at = CURRENT_TIMESTAMP
 WHERE id = $3 AND status = 'POSTED'`;

/**
 * Applies a payment to its sales invoice (additive amount_paid + status case),
 * mirroring PI_RECORD_PAYMENT_SQL. Guarded on the invoice still existing.
 */
export const SI_RECORD_PAYMENT_SQL = `UPDATE sales_invoices SET
   amount_paid = amount_paid + $1,
   payment_status = CASE WHEN (amount_paid + $1) >= grand_total THEN 'PAID' ELSE 'PARTIAL' END,
   updated_at = CURRENT_TIMESTAMP
 WHERE id = $2`;

/** Restores an invoice balance after reversing one payment (mirrors PI_UNDO_PAYMENT_SQL). */
export const SI_UNDO_PAYMENT_SQL = `UPDATE sales_invoices SET
   amount_paid = GREATEST(0, amount_paid - $1),
   payment_status = CASE WHEN (amount_paid - $1) >= grand_total THEN 'PAID'
                         WHEN (amount_paid - $1) > 0 THEN 'PARTIAL'
                         ELSE 'UNPAID' END,
   updated_at = CURRENT_TIMESTAMP
 WHERE id = $2`;

/** Posted customer payments for the receivables ledger (FK match + name fallback). */
export const LEDGER_CUSTOMER_PAYMENTS_SQL =
  `SELECT id, payment_number AS "paymentNumber", customer_id AS "customerId",
          customer_name AS "customerName", branch_id AS "branchId",
          invoice_id AS "invoiceId", invoice_number AS "invoiceNumber",
          payment_date_ad AS "paymentDateAD", payment_date_bs AS "paymentDateBS",
          amount, payment_method AS "paymentMethod", cheque_number AS "chequeNumber",
          notes, status
   FROM customer_payments
   WHERE customer_id = $1 OR (customer_id IS NULL AND (LOWER(customer_name) = LOWER($2) OR LOWER(customer_name) LIKE LOWER($3)))`;
