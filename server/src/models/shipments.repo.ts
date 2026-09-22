/**
 * Repository for the shipments domain — every SQL string and param-list
 * builder for inter-branch transfers lives here, following the same pattern
 * as ./procurement.repo.ts.
 *
 * shipments.controller.ts keeps only HTTP concerns (request shaping, cache
 * updates, audit logging, response bodies); query text and column lists are
 * defined once in this layer.
 */

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const SHIPMENT_SELECT_COLUMNS =
  'id, tracking_code AS "trackingCode", type, source_branch_id AS "sourceBranchId", source_branch_name AS "sourceBranchName", destination_branch_id AS "destinationBranchId", destination_branch_name AS "destinationBranchName", dispatch_date_ad AS "dispatchDateAD", dispatch_date_bs AS "dispatchDateBS", estimated_arrival_ad AS "estimatedArrivalAD", status, notes, items, received_by_notes AS "receivedByNotes", received_date_ad AS "receivedDateAD", received_date_bs AS "receivedDateBS", has_discrepancy AS "hasDiscrepancy"';

export const SHIPMENT_LIST_SQL =
  `SELECT ${SHIPMENT_SELECT_COLUMNS} FROM shipments ORDER BY created_at DESC`;

/** Existence probe before upserting a shipment (drives stock side effects). */
export const SHIPMENT_EXISTS_SQL = 'SELECT 1 FROM shipments WHERE id = $1 OR tracking_code = $2 LIMIT 1';

// ---------------------------------------------------------------------------
// Create (dispatch)
// ---------------------------------------------------------------------------

export const SHIPMENT_UPSERT_SQL = `INSERT INTO shipments (
   id, tracking_code, type, source_branch_id, source_branch_name, destination_branch_id, destination_branch_name, dispatch_date_ad, dispatch_date_bs, estimated_arrival_ad, status, notes, items
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
 ON CONFLICT (id) DO UPDATE SET
   status = EXCLUDED.status,
   items = EXCLUDED.items;`;

export function shipmentUpsertParams(sh: Record<string, any>): unknown[] {
  return [
    sh.id,
    sh.trackingCode,
    sh.type || 'INTER_BRANCH',
    sh.sourceBranchId,
    sh.sourceBranchName,
    sh.destinationBranchId,
    sh.destinationBranchName,
    sh.dispatchDateAD,
    sh.dispatchDateBS,
    sh.estimatedArrivalAD || sh.estimatedArrivalAd || null,
    sh.status,
    sh.notes || '',
    JSON.stringify(sh.items),
  ];
}

/**
 * Default quantity shipped per item when neither quantitySent nor quantity is
 * set — preserved verbatim from the controller (`|| 1`).
 */
export function shipmentQtySent(item: Record<string, any>): number {
  return Number(item.quantitySent || item.quantity || 1);
}

/** Deducts shipped quantity from the source branch, guarding on stock level. */
export const SHIPMENT_DEDUCT_SOURCE_SQL = `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP
 WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`;

/** Reserves incoming stock at the destination branch for a dispatched item. */
export const SHIPMENT_INCOMING_DEST_SQL = `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty)
 VALUES ($1, $2, $3, 0, $4)
 ON CONFLICT (product_id, branch_id) DO UPDATE SET
   incoming_qty = inventory_stock.incoming_qty + $4,
   last_updated = CURRENT_TIMESTAMP;`;

export function shipmentIncomingDestParams(destBranchId: string, item: Record<string, any>): unknown[] {
  return [`stk-${destBranchId.toLowerCase()}-${item.productId}`, item.productId, destBranchId, shipmentQtySent(item)];
}

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

export const SHIPMENT_RECEIVE_UPDATE_SQL =
  'UPDATE shipments SET status = $1, received_by_notes = $2, received_date_ad = CURRENT_DATE, received_date_bs = $3, has_discrepancy = $4, items = $5 WHERE id = $6';

/** Settles incoming stock into on-hand at the destination branch. */
export const SHIPMENT_RECEIVE_STOCK_SQL = `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty)
 VALUES ($1, $2, $3, $4, 0)
 ON CONFLICT (product_id, branch_id) DO UPDATE SET
   incoming_qty = GREATEST(0, inventory_stock.incoming_qty - $4),
   quantity_on_hand = inventory_stock.quantity_on_hand + $4,
   last_updated = CURRENT_TIMESTAMP;`;

export function shipmentReceiveStockParams(destBranchId: string, item: Record<string, any>): unknown[] {
  // quantityReceived = 0 must stay 0 (full-loss receipt); only fall back when
  // the field is nullish or non-numeric.
  const received = item.quantityReceived;
  const qty =
    received !== undefined && received !== null && received !== '' && !Number.isNaN(Number(received))
      ? Number(received)
      : Number(item.quantitySent) || 1;
  return [`stk-${destBranchId.toLowerCase()}-${item.productId}`, item.productId, destBranchId, qty];
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/** Locks the shipment row and reads the fields needed to reverse its stock. */
export const SHIPMENT_FIND_FOR_CANCEL_SQL =
  'SELECT status, source_branch_id AS "sourceBranchId", destination_branch_id AS "destinationBranchId", items, notes FROM shipments WHERE id = $1 OR tracking_code = $1 FOR UPDATE';

export const SHIPMENT_CANCEL_SQL =
  'UPDATE shipments SET status = $1, notes = $2 WHERE id = $3 OR tracking_code = $3';

/** Returns shipped quantity to the source branch on cancellation. */
export const SHIPMENT_CANCEL_RESTORE_SOURCE_SQL =
  'UPDATE inventory_stock SET quantity_on_hand = inventory_stock.quantity_on_hand + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;';

/** Releases reserved incoming stock at the destination on cancellation. */
export const SHIPMENT_CANCEL_RELEASE_DEST_SQL =
  'UPDATE inventory_stock SET incoming_qty = GREATEST(0, incoming_qty - $1), last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;';

