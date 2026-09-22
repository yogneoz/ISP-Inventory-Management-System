/**
 * Repository for the misc domain — SQL for audit logs, transaction logs,
 * approval requests, customer device (serial) status changes, pull-out
 * transactions, and stock-audit reconciliation, following the same pattern
 * as ./procurement.repo.ts and ./shipments.repo.ts.
 *
 * misc.controller.ts keeps only HTTP concerns; query text and column lists
 * are defined once in this layer.
 */
import type { ApprovalRequest, InventoryStock, TransactionLog } from '../../../client/src/types';

// ---------------------------------------------------------------------------
// DB status probe
// ---------------------------------------------------------------------------

export const DB_STATUS_PROBE_SQL =
  'SELECT current_database(), version(), (SELECT count(*) FROM information_schema.tables WHERE table_schema = \'public\') as tables';

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export const AUDIT_SELECT_PREFIX =
  'SELECT id, user_email AS "userEmail", user_name AS "userName", action, module, details, timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS", branch_id AS "branchId" FROM audit_logs';

export function buildAuditTrailQuery(branchId?: unknown, limit?: unknown): { sql: string; params: unknown[] } {
  let sql = AUDIT_SELECT_PREFIX;
  const params: unknown[] = [];
  if (branchId && branchId !== 'ALL') {
    sql += ' WHERE branch_id = $1';
    params.push(branchId);
  }
  sql += ' ORDER BY timestamp_ad DESC';
  if (limit) {
    params.push(Number(limit));
    sql += ` LIMIT $${params.length}`;
  }
  return { sql, params };
}

// ---------------------------------------------------------------------------
// Transaction logs
// ---------------------------------------------------------------------------

export const TXN_LOG_SELECT_PREFIX =
  'SELECT id, transaction_number AS "transactionNumber", product_id AS "productId", product_sku AS "productSku", product_name AS "productName", branch_id AS "branchId", change_type AS "changeType", quantity_before AS "quantityBefore", quantity_changed AS "quantityChanged", quantity_after AS "quantityAfter", unit_cost AS "unitCost", reference_doc_id AS "referenceDocId", timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS" FROM transaction_logs';

export function buildTransactionLogQuery(branchId?: unknown, productId?: unknown, limit?: unknown): { sql: string; params: unknown[] } {
  let sql = TXN_LOG_SELECT_PREFIX;
  const params: unknown[] = [];
  const conds: string[] = [];
  if (branchId && branchId !== 'ALL') {
    params.push(branchId);
    conds.push(`branch_id = $${params.length}`);
  }
  if (productId && productId !== 'ALL') {
    params.push(productId);
    conds.push(`product_id = $${params.length}`);
  }
  if (conds.length > 0) {
    sql += ' WHERE ' + conds.join(' AND ');
  }
  sql += ' ORDER BY timestamp_ad DESC';
  if (limit) {
    params.push(Number(limit));
    sql += ` LIMIT $${params.length}`;
  }
  return { sql, params };
}

// ---------------------------------------------------------------------------
// Approval requests
// ---------------------------------------------------------------------------

export const AR_SELECT_PREFIX =
  'SELECT id, request_number AS "requestNumber", type, target_id AS "targetId", customer_name AS "customerName", customer_code AS "customerCode", device_serial AS "deviceSerial", pon_serial AS "ponSerial", product_name AS "productName", current_status AS "currentStatus", requested_status AS "requestedStatus", requested_by_role AS "requestedByRole", requested_by_email AS "requestedByEmail", requested_by_name AS "requestedByName", branch_id AS "branchId", branch_name AS "branchName", reason, restock_qty_on_approval AS "restockQtyOnApproval", status, requested_at_ad AS "requestedAtAD", requested_at_bs AS "requestedAtBS", processed_by_email AS "processedByEmail", processed_by_name AS "processedByName", processed_by_role AS "processedByRole", processed_at_ad AS "processedAtAD", processed_at_bs AS "processedAtBS", rejection_reason AS "rejectionReason" FROM approval_requests';

/** Column set without requested-at timestamps — used for single-row lookups. */
export const AR_SELECT_PREFIX_SHORT =
  'SELECT id, request_number AS "requestNumber", type, target_id AS "targetId", customer_name AS "customerName", customer_code AS "customerCode", device_serial AS "deviceSerial", pon_serial AS "ponSerial", product_name AS "productName", current_status AS "currentStatus", requested_status AS "requestedStatus", requested_by_role AS "requestedByRole", requested_by_email AS "requestedByEmail", requested_by_name AS "requestedByName", branch_id AS "branchId", branch_name AS "branchName", reason, restock_qty_on_approval AS "restockQtyOnApproval", status FROM approval_requests';

export function buildApprovalRequestQuery(branchId?: unknown, status?: unknown): { sql: string; params: unknown[] } {
  let sql = AR_SELECT_PREFIX;
  const params: unknown[] = [];
  const conds: string[] = [];
  if (branchId && branchId !== 'ALL') {
    params.push(branchId);
    conds.push(`branch_id = $${params.length}`);
  }
  if (status && typeof status === 'string' && status !== 'ALL') {
    params.push(status);
    conds.push(`status = $${params.length}`);
  }
  if (conds.length > 0) {
    sql += ' WHERE ' + conds.join(' AND ');
  }
  sql += ' ORDER BY requested_at_ad DESC';
  return { sql, params };
}

export const AR_INSERT_SQL = `INSERT INTO approval_requests (id, request_number, type, target_id, customer_name, customer_code, device_serial, pon_serial, product_name, current_status, requested_status, requested_by_role, requested_by_email, requested_by_name, branch_id, branch_name, reason, restock_qty_on_approval, status, requested_at_ad, requested_at_bs)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW(), $20)`;

export function arInsertParams(r: ApprovalRequest): unknown[] {
  return [
    r.id,
    r.requestNumber,
    r.type,
    r.targetId || null,
    r.customerName || '',
    r.customerCode || '',
    r.deviceSerial || '',
    r.ponSerial || '',
    r.productName || '',
    r.currentStatus || 'ACTIVE',
    r.requestedStatus || '',
    r.requestedByRole || '',
    r.requestedByEmail || '',
    r.requestedByName || '',
    r.branchId || null,
    r.branchName || '',
    r.reason || '',
    !!r.restockQtyOnApproval,
    'PENDING',
    r.requestedAtBS,
  ];
}

export const AR_FIND_BY_ID_SQL = AR_SELECT_PREFIX_SHORT + ' WHERE id = $1';

export const AR_FIND_BY_ANY_ID_SQL = 'SELECT * FROM approval_requests WHERE id = $1';

/** Full close-out update (used for rejection and cancellation). */
export const AR_CLOSE_OUT_SQL =
  'UPDATE approval_requests SET status = $1, processed_by_email = $2, processed_by_name = $3, processed_by_role = $4, processed_at_ad = NOW(), processed_at_bs = $5, rejection_reason = $6 WHERE id = $7';

export function arCloseOutParams(r: ApprovalRequest): unknown[] {
  return [
    r.status,
    r.processedByEmail,
    r.processedByName,
    r.processedByRole,
    r.processedAtBS,
    r.rejectionReason ?? null,
    r.id,
  ];
}

/** Approval update without a rejection reason. */
export const AR_APPROVE_SQL =
  'UPDATE approval_requests SET status = $1, processed_by_email = $2, processed_by_name = $3, processed_by_role = $4, processed_at_ad = NOW(), processed_at_bs = $5 WHERE id = $6';

// ---------------------------------------------------------------------------
// Approval close-out — shipment cancel executed on approval
// ---------------------------------------------------------------------------

/** Narrow cancel-update used by post_process's transfer-cancel execution. */
export const AR_SHIPMENT_CANCEL_SQL =
  'UPDATE shipments SET status = $1, notes = $2 WHERE id = $3';

/** Restores shipped quantity to the source branch when a transfer is cancelled via approval.
 *  Re-exported from shipments.repo so the cancel SQL has a single canonical text. */
export { SHIPMENT_CANCEL_RESTORE_SOURCE_SQL as AR_SHIPMENT_RESTORE_SOURCE_SQL } from './shipments.repo';
/** Releases reserved incoming stock at the destination when a transfer is cancelled via approval. */
export { SHIPMENT_CANCEL_RELEASE_DEST_SQL as AR_SHIPMENT_RELEASE_DEST_SQL } from './shipments.repo';

// ---------------------------------------------------------------------------
// Customer device status change (executed on approval)
// ---------------------------------------------------------------------------

export const CDR_SET_STATUS_SQL =
  'UPDATE customer_device_records SET status = $1 WHERE id = $2 OR device_serial = $3';

// ---------------------------------------------------------------------------
// Pull-out restock (approval restock + disconnect auto-restock)
// ---------------------------------------------------------------------------

/** One-upserts stock with additive quantity_on_hand (+1); id = stk-<branch>-<product>. */
export const MISC_PULLOUT_STOCK_UPSERT_SQL = `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty)
 VALUES ($1, $2, $3, $4, $5, $6, $7)
 ON CONFLICT (id) DO UPDATE SET quantity_on_hand = inventory_stock.quantity_on_hand + 1, last_updated = NOW();`;

export function miscPulloutStockParams(stk: InventoryStock): unknown[] {
  return [
    stk.id,
    stk.productId,
    stk.branchId,
    stk.quantityOnHand,
    stk.damagedQty || 0,
    stk.reservedQty || 0,
    stk.incomingQty || 0,
  ];
}

/** Pull-out transaction-log insert (change_type PULLOUT, quantity_changed 1). */
export const MISC_PULLOUT_TXN_SQL = `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13);`;

export function miscPulloutTxnParams(txn: TransactionLog): unknown[] {
  return [
    txn.id,
    txn.transactionNumber,
    txn.productId,
    txn.productSku,
    txn.productName,
    txn.branchId,
    txn.changeType,
    txn.quantityBefore,
    txn.quantityChanged,
    txn.quantityAfter,
    txn.unitCost,
    txn.referenceDocId,
    txn.timestampBS,
  ];
}

// ---------------------------------------------------------------------------
// Stock-audit reconciliation (executed on approval)
// ---------------------------------------------------------------------------

/** Sets the absolute counted quantity per variance item; id = stk-<branch>-<product>. */
export const AUDIT_RECONCILE_STOCK_SQL = `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand)
 VALUES ($1, $2, $3, $4)
 ON CONFLICT (id) DO UPDATE SET quantity_on_hand = EXCLUDED.quantity_on_hand;`;

export function auditReconcileStockParams(branchId: string, item: Record<string, any>): unknown[] {
  return [
    `stk-${branchId.toLowerCase()}-${item.productId}`,
    item.productId,
    branchId,
    Number(item.countedQty) || 0,
  ];
}
