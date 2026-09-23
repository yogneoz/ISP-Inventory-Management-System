/**
 * Repository for the procurement domain — every SQL string and param-list
 * builder for purchase orders, purchase invoices, vendor payments, and the
 * vendor ledger lives here, following the same pattern as ./bootstrap.repo.ts.
 *
 * procurement.controller.ts keeps only HTTP concerns (request shaping, cache
 * updates, audit logging, response bodies); query text and column lists are
 * defined once in this layer.
 */
import type { QueryResult } from 'pg';

/** Minimal query interface satisfied by the pg Pool (and test doubles). */
export interface QueryExecutor {
  query(text: string, values?: unknown[]): Promise<QueryResult<any>>;
}

// ---------------------------------------------------------------------------
// Purchase Orders
// ---------------------------------------------------------------------------

export const PO_SELECT_COLUMNS =
  'id, po_number AS "poNumber", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", order_date_ad AS "orderDateAD", order_date_bs AS "orderDateBS", expected_delivery_date_ad AS "expectedDeliveryDateAD", status, subtotal_amount AS "subtotalAmount", tax_amount AS "taxAmount", total_amount AS "totalAmount", notes, items';

export function buildPoListSql(branchId?: unknown): { sql: string; params: unknown[] } {
  const filter = branchId && branchId !== 'ALL';
  return {
    sql:
      `SELECT ${PO_SELECT_COLUMNS} FROM purchase_orders` +
      (filter ? ' WHERE branch_id = $1' : '') +
      ' ORDER BY created_at DESC',
    params: filter ? [branchId] : [],
  };
}

export interface PurchaseOrderQueryOptions {
  branchId?: unknown;
  status?: unknown;
  /** Exact case-insensitive supplier-name match (register vendor filter). */
  supplier?: unknown;
  /** Free-text search across PO number, supplier name and the items blob. */
  query?: unknown;
  /** Inclusive lower bound on order_date_ad, AD YYYY-MM-DD. */
  dateFromAD?: unknown;
  /** Inclusive upper bound on order_date_ad, AD YYYY-MM-DD. */
  dateToAD?: unknown;
}

/**
 * Builds the purchase-orders WHERE fragment (starting with ' WHERE 1=1')
 * shared by the paged list, the aggregate (count + value sums) and the
 * per-status count queries.
 */
export function buildPurchaseOrderWhere(opts: PurchaseOrderQueryOptions): { whereSql: string; params: unknown[] } {
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
  if (opts.supplier && typeof opts.supplier === 'string' && opts.supplier.trim() && opts.supplier !== 'ALL') {
    params.push(opts.supplier.trim().toLowerCase());
    whereSql += ` AND LOWER(supplier_name) = $${params.length}`;
  }
  if (opts.query && typeof opts.query === 'string' && opts.query.trim()) {
    const like = `%${opts.query.trim().toLowerCase()}%`;
    params.push(like);
    whereSql += ` AND (LOWER(po_number) LIKE $${params.length} OR LOWER(supplier_name) LIKE $${params.length} OR LOWER(items::text) LIKE $${params.length})`;
  }
  if (typeof opts.dateFromAD === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateFromAD)) {
    params.push(opts.dateFromAD);
    whereSql += ` AND order_date_ad >= $${params.length}::date`;
  }
  if (typeof opts.dateToAD === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateToAD)) {
    params.push(opts.dateToAD);
    whereSql += ` AND order_date_ad <= $${params.length}::date`;
  }
  return { whereSql, params };
}

/** Count + pending/received value sums over the same filter (register KPIs). */
export function buildPurchaseOrderAggregateQuery(opts: PurchaseOrderQueryOptions): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildPurchaseOrderWhere(opts);
  const sql =
    'SELECT COUNT(*)::int AS count, ' +
    "COALESCE(SUM(total_amount) FILTER (WHERE status <> 'RECEIVED' AND status <> 'CANCELLED'), 0)::float AS pending_value, " +
    "COALESCE(SUM(total_amount) FILTER (WHERE status = 'RECEIVED'), 0)::float AS received_value " +
    'FROM purchase_orders' + whereSql;
  return { sql, params };
}

/** Per-status counts with the same filter fragment (register KPI cards). */
export function buildPurchaseOrderStatusCountQuery(opts: PurchaseOrderQueryOptions): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildPurchaseOrderWhere(opts);
  return { sql: 'SELECT status, COUNT(*)::int AS count FROM purchase_orders' + whereSql + ' GROUP BY status', params };
}

/** Paged purchase-orders list query (1-indexed page, clamped LIMIT/OFFSET). */
export function buildPurchaseOrderPagedQuery(opts: PurchaseOrderQueryOptions, paging?: { page: number; pageSize: number }): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildPurchaseOrderWhere(opts);
  let sql = `SELECT ${PO_SELECT_COLUMNS} FROM purchase_orders` + whereSql + ' ORDER BY created_at DESC';
  if (paging) {
    const pageSize = Math.max(1, Math.min(500, Math.floor(paging.pageSize)));
    const page = Math.max(1, Math.floor(paging.page));
    sql += ` LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
  }
  return { sql, params };
}

export const PO_UPSERT_SQL = `INSERT INTO purchase_orders (
   id, po_number, supplier_id, supplier_name, branch_id, order_date_ad, order_date_bs, expected_delivery_date_ad, status, subtotal_amount, tax_amount, total_amount, notes, items
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
 ON CONFLICT (id) DO UPDATE SET
   status = EXCLUDED.status,
   subtotal_amount = EXCLUDED.subtotal_amount,
   tax_amount = EXCLUDED.tax_amount,
   total_amount = EXCLUDED.total_amount,
   notes = EXCLUDED.notes,
   items = EXCLUDED.items;`;

export function poUpsertParams(po: Record<string, any>, itemsJson: string): unknown[] {
  return [
    po.id,
    po.poNumber,
    po.supplierId || null,
    po.supplierName || 'Vendor',
    po.branchId || 'WH001',
    po.orderDateAd,
    po.orderDateBs,
    po.expectedDeliveryDateAD || po.expectedDeliveryDateAd || null,
    po.status || 'DRAFT',
    po.subtotalAmount,
    po.taxAmount,
    po.totalAmount,
    po.notes || '',
    itemsJson,
  ];
}

export const PO_UPDATE_SQL = `UPDATE purchase_orders SET
   supplier_name = $1, branch_id = $2, status = $3, subtotal_amount = $4, tax_amount = $5, total_amount = $6, notes = $7, items = $8
 WHERE id = $9;`;

export function poUpdateParams(po: Record<string, any>, itemsJson: string, id: string): unknown[] {
  return [
    po.supplierName,
    po.branchId,
    po.status,
    po.subtotalAmount,
    po.taxAmount,
    po.totalAmount,
    po.notes,
    itemsJson,
    id,
  ];
}

export const PO_FIND_FOR_DELETE_SQL =
  'SELECT id, po_number AS "poNumber", status, items, branch_id AS "branchId" FROM purchase_orders WHERE id = $1';

export const PO_DELETE_SQL = 'DELETE FROM purchase_orders WHERE id = $1';

export const PO_FIND_BY_REF_SQL =
  'SELECT id, po_number AS "poNumber", supplier_name AS "supplierName", branch_id AS "branchId", status, items FROM purchase_orders WHERE id = $1 OR po_number = $1 LIMIT 1';

export const PO_MARK_STATUS_SQL = 'UPDATE purchase_orders SET status = $1 WHERE id = $2 OR po_number = $2';

/** Reserves incoming stock for a PO item (upsert with additive incoming_qty). */
export const PO_INCOMING_STOCK_SQL = `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty)
 VALUES ($1, $2, $3, 0, $4)
 ON CONFLICT (product_id, branch_id) DO UPDATE SET
   incoming_qty = inventory_stock.incoming_qty + EXCLUDED.incoming_qty,
   last_updated = CURRENT_TIMESTAMP;`;

export function poIncomingStockParams(branchId: string, item: Record<string, any>): unknown[] {
  return [`stk-${branchId.toLowerCase()}-${item.productId}`, item.productId, branchId, Number(item.quantity) || 0];
}

/** Releases reserved incoming stock when a PO is deleted. */
export const PO_RELEASE_INCOMING_SQL = `UPDATE inventory_stock SET incoming_qty = GREATEST(0, incoming_qty - $1), last_updated = CURRENT_TIMESTAMP
 WHERE product_id = $2 AND branch_id = $3`;

// ---------------------------------------------------------------------------
// Purchase Invoices
// ---------------------------------------------------------------------------

export const PI_SELECT_COLUMNS =
  'id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", vendor_bill_number AS "vendorBillNumber", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS", due_date_ad AS "dueDateAD", due_date_bs AS "dueDateBS", taxable_amount AS "taxableAmount", vat_amount AS "vatAmount", non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal", payment_status AS "paymentStatus", payment_method AS "paymentMethod", amount_paid AS "amountPaid", notes, items';

export function buildPiListSql(branchId?: unknown): { sql: string; params: unknown[] } {
  const filter = branchId && branchId !== 'ALL';
  return {
    sql:
      `SELECT ${PI_SELECT_COLUMNS} FROM purchase_invoices` +
      (filter ? ' WHERE branch_id = $1' : '') +
      ' ORDER BY created_at DESC',
    params: filter ? [branchId] : [],
  };
}

export interface PurchaseInvoiceQueryOptions {
  branchId?: unknown;
  paymentStatus?: unknown;
  /** Exact case-insensitive supplier-name match (register vendor filter). */
  supplier?: unknown;
  /** Free-text search across invoice #, vendor bill #, supplier and items. */
  query?: unknown;
  /** Inclusive lower bound on invoice_date_ad, AD YYYY-MM-DD. */
  dateFromAD?: unknown;
  /** Inclusive upper bound on invoice_date_ad, AD YYYY-MM-DD. */
  dateToAD?: unknown;
}

/**
 * Builds the purchase-invoices WHERE fragment (starting with ' WHERE 1=1')
 * shared by the paged list, the aggregate (count + amount sums) and the
 * per-payment-status count queries.
 */
export function buildPurchaseInvoiceWhere(opts: PurchaseInvoiceQueryOptions): { whereSql: string; params: unknown[] } {
  let whereSql = ' WHERE 1=1';
  const params: unknown[] = [];
  if (opts.branchId && opts.branchId !== 'ALL') {
    params.push(opts.branchId as string);
    whereSql += ` AND branch_id = $${params.length}`;
  }
  if (opts.paymentStatus && opts.paymentStatus !== 'ALL') {
    params.push(opts.paymentStatus as string);
    whereSql += ` AND payment_status = $${params.length}`;
  }
  if (opts.supplier && typeof opts.supplier === 'string' && opts.supplier.trim() && opts.supplier !== 'ALL') {
    params.push(opts.supplier.trim().toLowerCase());
    whereSql += ` AND LOWER(supplier_name) = $${params.length}`;
  }
  if (opts.query && typeof opts.query === 'string' && opts.query.trim()) {
    const like = `%${opts.query.trim().toLowerCase()}%`;
    params.push(like);
    whereSql += ` AND (LOWER(invoice_number) LIKE $${params.length} OR LOWER(COALESCE(vendor_bill_number, '')) LIKE $${params.length} OR LOWER(supplier_name) LIKE $${params.length} OR LOWER(items::text) LIKE $${params.length})`;
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

/** Count + taxable/VAT/grand/unpaid sums over the same filter (register KPIs). */
export function buildPurchaseInvoiceAggregateQuery(opts: PurchaseInvoiceQueryOptions): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildPurchaseInvoiceWhere(opts);
  const sql =
    'SELECT COUNT(*)::int AS count, ' +
    'COALESCE(SUM(taxable_amount), 0)::float AS taxable_sum, ' +
    'COALESCE(SUM(vat_amount), 0)::float AS vat_sum, ' +
    'COALESCE(SUM(grand_total), 0)::float AS grand_sum, ' +
    'COALESCE(SUM(grand_total - amount_paid), 0)::float AS unpaid_sum ' +
    'FROM purchase_invoices' + whereSql;
  return { sql, params };
}

/** Per-payment-status counts with the same filter fragment. */
export function buildPurchaseInvoiceStatusCountQuery(opts: PurchaseInvoiceQueryOptions): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildPurchaseInvoiceWhere(opts);
  return { sql: 'SELECT payment_status AS status, COUNT(*)::int AS count FROM purchase_invoices' + whereSql + ' GROUP BY payment_status', params };
}

/** Paged purchase-invoices list query (1-indexed page, clamped LIMIT/OFFSET). */
export function buildPurchaseInvoicePagedQuery(opts: PurchaseInvoiceQueryOptions, paging?: { page: number; pageSize: number }): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildPurchaseInvoiceWhere(opts);
  let sql = `SELECT ${PI_SELECT_COLUMNS} FROM purchase_invoices` + whereSql + ' ORDER BY created_at DESC';
  if (paging) {
    const pageSize = Math.max(1, Math.min(500, Math.floor(paging.pageSize)));
    const page = Math.max(1, Math.floor(paging.page));
    sql += ` LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
  }
  return { sql, params };
}

export const PI_UPSERT_SQL = `INSERT INTO purchase_invoices (
   id, invoice_number, po_reference_id, vendor_bill_number, supplier_id, supplier_name, branch_id, invoice_date_ad, invoice_date_bs, due_date_ad, due_date_bs, taxable_amount, vat_amount, non_taxable_amount, grand_total, payment_status, payment_method, amount_paid, notes, items
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
 ON CONFLICT (id) DO UPDATE SET
   payment_status = EXCLUDED.payment_status,
   payment_method = EXCLUDED.payment_method,
   amount_paid = EXCLUDED.amount_paid,
   notes = EXCLUDED.notes,
   items = EXCLUDED.items;`;

export function piUpsertParams(inv: Record<string, any>, itemsJson: string): unknown[] {
  return [
    inv.id,
    inv.invoiceNumber,
    inv.poReferenceId || inv.poId || null,
    inv.vendorBillNumber || null,
    inv.supplierId,
    inv.supplierName || 'Vendor',
    inv.branchId,
    inv.invoiceDateAD,
    inv.invoiceDateBS,
    inv.dueDateAD || inv.dueDateAd || null,
    inv.dueDateBS || inv.dueDateBs || null,
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

/** Receives stock for an invoice item (upsert with additive quantity_on_hand). */
export const PI_RECEIVE_STOCK_SQL = `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, min_reorder_level)
 VALUES ($1, $2, $3, $4, 5)
 ON CONFLICT (product_id, branch_id) DO UPDATE SET
   quantity_on_hand = inventory_stock.quantity_on_hand + $4,
   last_updated = CURRENT_TIMESTAMP;`;

export function piReceiveStockParams(branchId: string, item: Record<string, any>): unknown[] {
  return [`stk-${branchId.toLowerCase()}-${item.productId}`, item.productId, branchId, Number(item.quantity) || 0];
}

/** Appends a PURCHASE_INVOICE transaction log row for an invoice item. */
export const PI_TXN_LOG_SQL = `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
 VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8, $9, $10, $11, $12)`;

export function piTxnLogParams(inv: Record<string, any>, item: Record<string, any>, branchId: string): unknown[] {
  return [
    `txn-${Date.now()}-${item.productId}`,
    `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
    item.productId,
    item.sku || '',
    item.productName || 'Product',
    branchId,
    'PURCHASE_INVOICE',
    Number(item.quantity) || 0,
    Number(item.unitPrice) || 0,
    inv.invoiceNumber,
    inv.invoiceDateAD || new Date().toISOString(),
    inv.invoiceDateBS || '2083-04-16 BS',
  ];
}

export const PI_TXN_CHANGE_TYPE = 'PURCHASE_INVOICE';

export const PI_DELETE_SQL = 'DELETE FROM purchase_invoices WHERE id = $1';

/** Records a payment against an invoice (additive amount_paid + status case). */
export const PI_RECORD_PAYMENT_SQL = `UPDATE purchase_invoices SET
   amount_paid = amount_paid + $1,
   payment_status = CASE WHEN (amount_paid + $1) >= grand_total THEN 'PAID' ELSE 'PARTIAL' END
 WHERE id = $2;`;

/** Resets an invoice to fully unpaid (payment reversal). */
export const PI_RESET_PAYMENT_SQL = `UPDATE purchase_invoices SET
   amount_paid = 0,
   payment_status = 'UNPAID'
 WHERE id = $1`;

/** Restores an invoice balance after reversing one payment. */
export const PI_UNDO_PAYMENT_SQL = `UPDATE purchase_invoices SET
   amount_paid = GREATEST(0, amount_paid - $1),
   payment_status = CASE WHEN (amount_paid - $1) >= grand_total THEN 'PAID'
                         WHEN (amount_paid - $1) > 0 THEN 'PARTIAL'
                         ELSE 'UNPAID' END
 WHERE id = $2`;

/** Reverses received stock for a deleted invoice item, guarding on quantity. */
export const PI_REVERSE_STOCK_SQL = `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP
 WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1`;

export const CDR_ASSIGNED_CHECK_SQL =
  `SELECT 1 FROM customer_device_records
   WHERE device_serial = ANY($1::text[]) AND purchase_bill_ref = ANY($2::text[]) AND status <> 'IN_STOCK' LIMIT 1`;

export const CDR_IN_STOCK_DELETE_SQL =
  `DELETE FROM customer_device_records
   WHERE device_serial = ANY($1::text[]) AND purchase_bill_ref = ANY($2::text[]) AND status = 'IN_STOCK'`;

/** Locks an invoice row (FOR UPDATE) for read-modify-write payment updates. */
export const PI_LOCK_FOR_UPDATE_SQL =
  'SELECT amount_paid AS "amountPaid", grand_total AS "grandTotal" FROM purchase_invoices WHERE id = $1 FOR UPDATE';

/** Reads the post-update balance of an invoice inside the same transaction. */
export const PI_BALANCE_AFTER_SQL =
  'SELECT amount_paid AS "amountPaid", payment_status AS "paymentStatus" FROM purchase_invoices WHERE id = $1';

/** Locks a vendor-payment row (FOR UPDATE) before a status transition. */
export const VP_LOCK_STATUS_SQL = 'SELECT status FROM vendor_payments WHERE id = $1 FOR UPDATE';

export const PI_FIND_FOR_PAYMENT_SQL =
  `SELECT id, invoice_number AS "invoiceNumber", supplier_name AS "supplierName",
          branch_id AS "branchId",
          invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS",
          grand_total AS "grandTotal", amount_paid AS "amountPaid"
   FROM purchase_invoices WHERE id = $1 OR invoice_number = $1 LIMIT 1`;

// ---------------------------------------------------------------------------
// Vendor Payments
// ---------------------------------------------------------------------------

export const VP_REVERSE_SQL = `UPDATE vendor_payments SET
   status = 'REVERSED',
   reversal_reason = $1,
   reversed_by = $2,
   reversed_at_ad = CURRENT_TIMESTAMP,
   updated_at = CURRENT_TIMESTAMP
 WHERE id = $3`;

export const VP_INSERT_SQL = `INSERT INTO vendor_payments (
   id, payment_number, supplier_id, supplier_name, branch_id, invoice_id, invoice_number,
   payment_date_ad, payment_date_bs, amount, payment_method, bank_name, bank_branch,
   account_number, cheque_number, cheque_date_ad, cheque_date_bs, transaction_reference,
   notes, status, is_demo, created_by
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, FALSE, $21)
 ON CONFLICT (id) DO NOTHING`;

export function vpInsertParams(p: Record<string, any>): unknown[] {
  return [
    p.id, p.paymentNumber, p.supplierId || null, p.supplierName,
    p.branchId, p.invoiceId, p.invoiceNumber,
    p.paymentDateAD, p.paymentDateBS, p.amount, p.paymentMethod,
    p.bankName, p.bankBranch, p.accountNumber, p.chequeNumber,
    p.chequeDateAD, p.chequeDateBS, p.transactionReference,
    p.notes, p.status, p.createdBy,
  ];
}

export interface VendorPaymentFilters {
  supplierId?: unknown;
  invoiceId?: unknown;
  branchId?: unknown;
  status?: unknown;
  fiscalYearId?: unknown;
  fromAd?: unknown;
  toAd?: unknown;
}

/**
 * Builds the WHERE clause for the vendor-payments list query. Mirrors the
 * controller's `push()` helper verbatim: equality filters for supplier,
 * invoice, branch, status, and fiscal year; date-range on payment_date_ad.
 * Returns '' when no filters apply.
 */
export function buildVendorPaymentWhere(f: VendorPaymentFilters): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const push = (sql: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== '') {
      params.push(value);
      conds.push(`${sql} = $${params.length}`);
    }
  };
  push('supplier_id', f.supplierId);
  push('invoice_id', f.invoiceId);
  push('branch_id', f.branchId && f.branchId !== 'ALL' ? f.branchId : undefined);
  push('status', f.status);
  push('fiscal_year_id', f.fiscalYearId);
  if (f.fromAd) {
    params.push(String(f.fromAd).split('T')[0]);
    conds.push(`payment_date_ad >= $${params.length}`);
  }
  if (f.toAd) {
    params.push(String(f.toAd).split('T')[0]);
    conds.push(`payment_date_ad <= $${params.length}`);
  }
  return { where: conds.length ? ` WHERE ${conds.join(' AND ')}` : '', params };
}

export const VP_ORDER_BY = ' ORDER BY payment_date_ad DESC, created_at DESC';

export const VP_BY_INVOICE_SQL_SUFFIX = ' WHERE invoice_id = $1 ORDER BY payment_date_ad DESC, created_at DESC';

export const LEDGER_INVOICES_SQL =
  `SELECT id, invoice_number AS "invoiceNumber", supplier_id AS "supplierId", supplier_name AS "supplierName",
          branch_id AS "branchId", invoice_date_ad AS "invoiceDateAD",
          invoice_date_bs AS "invoiceDateBS", vat_amount AS "vatAmount",
          grand_total AS "grandTotal", notes
   FROM purchase_invoices
   WHERE supplier_id = $1 OR (supplier_id IS NULL AND (LOWER(supplier_name) = LOWER($2) OR LOWER(supplier_name) LIKE LOWER($3)))`;

export function ledgerNameParams(supplier: { id: string; name: string }): unknown[] {
  return [supplier.id, supplier.name, `%${supplier.name}%`];
}

export const LEDGER_PAYMENTS_SQL_SUFFIX =
  ' WHERE supplier_id = $1 OR (supplier_id IS NULL OR supplier_id = \'\') AND (LOWER(supplier_name) = LOWER($2) OR LOWER(supplier_name) LIKE LOWER($3))';

// ---------------------------------------------------------------------------
// Misc lookups
// ---------------------------------------------------------------------------

/** Updates only a PO's status (patch handler). */
export const PO_PATCH_STATUS_SQL = 'UPDATE purchase_orders SET status = $1 WHERE id = $2';

/** Existence probe before upserting an invoice (drives stock/txn side effects). */
export const PI_EXISTS_SQL = 'SELECT 1 FROM purchase_invoices WHERE id = $1 OR invoice_number = $2 LIMIT 1';

/** Loads a minimal invoice row for deletion/reversal. */
export const PI_FIND_FOR_DELETE_SQL =
  'SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", vendor_bill_number AS "vendorBillNumber", branch_id AS "branchId", notes, items FROM purchase_invoices WHERE id = $1';

export const FY_BY_ID_SQL =
  'SELECT id, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD" FROM fiscal_years WHERE id = $1';

export const FY_BY_START_SQL =
  'SELECT id, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD" FROM fiscal_years WHERE start_date_ad = $1::date LIMIT 1';

export const FY_CURRENT_SQL =
  'SELECT id, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD" FROM fiscal_years WHERE is_current = TRUE ORDER BY start_date_ad DESC LIMIT 1';

export const VENDOR_OPENING_BALANCE_SQL =
  `SELECT COALESCE(SUM(opening_balance), 0)::float AS total
   FROM vendor_opening_balances
   WHERE fiscal_year_id = $1 AND supplier_id = $2
     AND ($3::text IS NULL OR $3 = 'ALL' OR branch_id = $3)`;



