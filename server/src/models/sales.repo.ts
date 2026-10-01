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
import { BS_DATE_FALLBACK } from '../utils/bsDate';

/** Minimal query interface satisfied by the pg Pool (and test doubles). */
export interface QueryExecutor {
  query(text: string, values?: unknown[]): Promise<QueryResult<any>>;
}

// ---------------------------------------------------------------------------
// Sales Invoices (INV-…)
// ---------------------------------------------------------------------------

export const SI_SELECT_COLUMNS =
  'id, invoice_number AS "invoiceNumber", customer_id AS "customerId", customer_name AS "customerName", branch_id AS "branchId", invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS", due_date_ad AS "dueDateAD", due_date_bs AS "dueDateBS", taxable_amount AS "taxableAmount", vat_amount AS "vatAmount", non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal", payment_status AS "paymentStatus", payment_method AS "paymentMethod", amount_paid AS "amountPaid", notes, items, fiscal_year_id AS "fiscalYearId", is_demo AS "isDemo", created_by AS "createdBy", created_at AS "createdAt"';

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
    inv.invoiceDateBS || BS_DATE_FALLBACK,
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
    ret.returnDateBS || BS_DATE_FALLBACK,
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
