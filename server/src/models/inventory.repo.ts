/**
 * Repository for the inventory domain — every SQL string and param-list
 * builder for stock levels, reorder levels, stock operations (damage,
 * pull-out, stock-out, consumable issue), damage reversal, fixed assets,
 * customer devices (CPE), serial lookup, and the serial log register lives
 * here, following the same pattern as ./procurement.repo.ts and
 * ./misc.repo.ts.
 *
 * inventory.controller.ts keeps only HTTP concerns (request shaping, cache
 * updates, audit logging, response bodies); query text and column lists are
 * defined once in this layer.
 */
import type { CustomerDeviceRecord, TransactionLog } from '../../../client/src/types';

/** 13-bind transaction-log insert with timestamp_ad stamped server-side.
 *  Single canonical text lives in misc.repo — re-exported, not duplicated. */
export { MISC_PULLOUT_TXN_SQL as TXN_INSERT_NOW_SQL, miscPulloutTxnParams } from './misc.repo';

// ---------------------------------------------------------------------------
// Stock levels
// ---------------------------------------------------------------------------

export const STOCK_SELECT_COLUMNS =
  'id, product_id AS "productId", branch_id AS "branchId", quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty", reserved_qty AS "reservedQty", incoming_qty AS "incomingQty", min_reorder_level AS "minReorderLevel", last_updated AS "lastUpdated"';

/** Builds the stock list query with an optional branch filter. */
export function buildStockListQuery(branchId?: unknown): { sql: string; params: unknown[] } {
  const filter = branchId && branchId !== 'ALL';
  return {
    sql:
      `SELECT ${STOCK_SELECT_COLUMNS} FROM inventory_stock` +
      (filter ? ' WHERE branch_id = $1' : '') +
      ' ORDER BY branch_id, product_id',
    params: filter ? [branchId] : [],
  };
}

export const STOCK_FIND_BY_ID_SQL =
  'SELECT id, product_id AS "productId", branch_id AS "branchId", quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty", reserved_qty AS "reservedQty", incoming_qty AS "incomingQty", min_reorder_level AS "minReorderLevel" FROM inventory_stock WHERE id = $1';

/** Level-touching upsert (PATCH /api/stock/:id): stamps last_updated via NOW(). */
export const STOCK_UPSERT_LEVELS_SQL = `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level, last_updated)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
 ON CONFLICT (id) DO UPDATE SET
   quantity_on_hand = EXCLUDED.quantity_on_hand,
   damaged_qty = EXCLUDED.damaged_qty,
   min_reorder_level = EXCLUDED.min_reorder_level,
   last_updated = NOW();`;

export function stockUpsertLevelsParams(stk: Record<string, any>): unknown[] {
  return [
    stk.id,
    stk.productId,
    stk.branchId,
    stk.quantityOnHand || 0,
    stk.damagedQty || 0,
    stk.reservedQty || 0,
    stk.incomingQty || 0,
    stk.minReorderLevel || 5,
  ];
}

/** Reorder-level upsert: only min_reorder_level is refreshed on conflict. */
export const STOCK_UPSERT_REORDER_SQL = `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
 ON CONFLICT (id) DO UPDATE SET min_reorder_level = $8`;

export function stockUpsertReorderParams(stk: Record<string, any>): unknown[] {
  return [
    stk.id,
    stk.productId,
    stk.branchId,
    stk.quantityOnHand || 0,
    stk.damagedQty || 0,
    stk.reservedQty || 0,
    stk.incomingQty || 0,
    stk.minReorderLevel,
  ];
}

/** Physical-audit reconciliation upsert: sets the absolute counted quantity. */
export const STOCK_RECONCILE_UPSERT_SQL = `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty)
 VALUES ($1, $2, $3, $4, $5, $6, $7)
 ON CONFLICT (id) DO UPDATE SET quantity_on_hand = EXCLUDED.quantity_on_hand;`;

export function stockReconcileUpsertParams(stk: Record<string, any>): unknown[] {
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

// ---------------------------------------------------------------------------
// Transaction logs
// ---------------------------------------------------------------------------

/** 14-bind transaction-log insert with an explicit timestamp_ad; idempotent. */
export const TXN_INSERT_ON_CONFLICT_SQL = `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
 ON CONFLICT (id) DO NOTHING`;

export function txnInsertOnConflictParams(txn: TransactionLog): unknown[] {
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
    txn.timestampAD,
    txn.timestampBS,
  ];
}

// ---------------------------------------------------------------------------
// Damage records (manual PATCH adjustment + audit shortage)
// ---------------------------------------------------------------------------

/** Lifecycle entry for a manual damagedQty adjustment (PATCH /api/stock/:id). */
export const DAMAGE_RECORD_ADJUSTMENT_SQL = `INSERT INTO damage_records (
                 id, damage_reference, product_id, branch_id, quantity_damaged, unit_cost, total_cost,
                 damage_date_ad, damage_date_bs, damage_reason, status, salvage_value, gl_account_code,
                 write_off_loss, approved_by, notes, is_demo, created_by
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'IDENTIFIED', 0, 'GL-5120 (Loss on Inventory Scrap & Write-off)', 0, $11, $12, FALSE, $13)
               ON CONFLICT (id) DO NOTHING`;

export function damageAdjustmentParams(rec: {
  id: string;
  damageReference: string;
  productId: string;
  branchId: string;
  quantityDamaged: number;
  unitCost: number;
  totalCost: number;
  damageDateAD: string;
  damageDateBS: string;
  damageReason: string;
  approvedBy: string;
  notes: string;
  createdBy: string;
}): unknown[] {
  return [
    rec.id,
    rec.damageReference,
    rec.productId,
    rec.branchId,
    rec.quantityDamaged,
    rec.unitCost,
    rec.totalCost,
    rec.damageDateAD,
    rec.damageDateBS,
    rec.damageReason,
    rec.approvedBy,
    rec.notes,
    rec.createdBy,
  ];
}

/** Lifecycle entry for a physical-audit shortage write-off (reason literal OTHER). */
export const DAMAGE_RECORD_AUDIT_SHORTAGE_SQL = `INSERT INTO damage_records (
                 id, damage_reference, product_id, branch_id, quantity_damaged, unit_cost, total_cost,
                 damage_date_ad, damage_date_bs, damage_reason, status, salvage_value, gl_account_code,
                 write_off_loss, approved_by, notes, is_demo, created_by
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OTHER', 'IDENTIFIED', 0, 'GL-5120 (Loss on Inventory Scrap & Write-off)', 0, $10, $11, FALSE, $12)
               ON CONFLICT (id) DO NOTHING`;

export function damageAuditShortageParams(rec: {
  id: string;
  damageReference: string;
  productId: string;
  branchId: string;
  quantityDamaged: number;
  unitCost: number;
  totalCost: number;
  damageDateAD: string;
  damageDateBS: string;
  approvedBy: string;
  notes: string;
  createdBy: string;
}): unknown[] {
  return [
    rec.id,
    rec.damageReference,
    rec.productId,
    rec.branchId,
    rec.quantityDamaged,
    rec.unitCost,
    rec.totalCost,
    rec.damageDateAD,
    rec.damageDateBS,
    rec.approvedBy,
    rec.notes,
    rec.createdBy,
  ];
}

/** Cancels every non-cancelled damage-record row of a reversed damage op. */
export const DAMAGE_RECORD_CANCEL_SQL = `UPDATE damage_records SET status = 'CANCELLED', notes = COALESCE(notes, '') || ' | REVERSED (' || $3 || ') by ' || $4 WHERE (damage_reference = $1 OR id = $2) AND status <> 'CANCELLED';`;

// ---------------------------------------------------------------------------
// Fixed assets
// ---------------------------------------------------------------------------

export const ASSET_SELECT_COLUMNS =
  'id, tag_number AS "tagNumber", name, category, branch_id AS "branchId", acquisition_date_ad AS "acquisitionDateAD", acquisition_date_bs AS "acquisitionDateBS", purchase_invoice_date_ad AS "purchaseInvoiceDateAD", purchase_invoice_date_bs AS "purchaseInvoiceDateBS", capitalization_date_ad AS "capitalizationDateAD", placed_in_service_date_ad AS "placedInServiceDateAD", acquisition_cost AS "acquisitionCost", depreciation_method AS "depreciationMethod", depreciation_rate_percent AS "depreciationRatePercent", accumulated_depreciation AS "accumulatedDepreciation", net_book_value AS "netBookValue", status, supplier_name AS "supplierName", invoice_no AS "invoiceNo", purchase_invoice_id AS "purchaseInvoiceId", product_id AS "productId"';

/** Builds the asset list query with an optional branch filter. */
export function buildAssetListQuery(branchId?: unknown): { sql: string; params: unknown[] } {
  const filter = branchId && branchId !== 'ALL';
  return {
    sql:
      `SELECT ${ASSET_SELECT_COLUMNS} FROM fixed_assets` +
      (filter ? ' WHERE branch_id = $1' : '') +
      ' ORDER BY created_at DESC',
    params: filter ? [branchId] : [],
  };
}

export const ASSET_UPSERT_SQL = `INSERT INTO fixed_assets (
   id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs, purchase_invoice_date_ad, purchase_invoice_date_bs, capitalization_date_ad, placed_in_service_date_ad, acquisition_cost, depreciation_method, depreciation_rate_percent, accumulated_depreciation, net_book_value, status, supplier_name, invoice_no, purchase_invoice_id, product_id
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
 ON CONFLICT (id) DO UPDATE SET
   tag_number = EXCLUDED.tag_number,
   name = EXCLUDED.name,
   category = EXCLUDED.category,
   branch_id = EXCLUDED.branch_id,
  purchase_invoice_date_ad = EXCLUDED.purchase_invoice_date_ad,
  purchase_invoice_date_bs = EXCLUDED.purchase_invoice_date_bs,
  capitalization_date_ad = EXCLUDED.capitalization_date_ad,
  placed_in_service_date_ad = EXCLUDED.placed_in_service_date_ad,
   acquisition_cost = EXCLUDED.acquisition_cost,
   net_book_value = EXCLUDED.net_book_value,
   status = EXCLUDED.status;`;

export function assetUpsertParams(a: Record<string, any>): unknown[] {
  return [
    a.id,
    a.tagNumber,
    a.name,
    a.category,
    a.branchId,
    a.acquisitionDateAD,
    a.acquisitionDateBS,
    a.purchaseInvoiceDateAD,
    a.purchaseInvoiceDateBS,
    a.capitalizationDateAD,
    a.placedInServiceDateAD,
    a.acquisitionCost,
    a.depreciationMethod,
    a.depreciationRatePercent,
    a.accumulatedDepreciation,
    a.netBookValue,
    a.status,
    a.supplierName,
    a.invoiceNo,
    a.purchaseInvoiceId,
    a.productId,
  ];
}

export const ASSET_SET_STATUS_SQL = 'UPDATE fixed_assets SET status = $1 WHERE id = $2';

// ---------------------------------------------------------------------------
// Stock operations
// ---------------------------------------------------------------------------

export const STOCK_OP_SELECT_COLUMNS =
  'id, reference_number AS "referenceNumber", type, technician_name AS "technicianName", work_order_ref AS "workOrderRef", branch_id AS "branchId", branch_name AS "branchName", destination_warehouse_id AS "destinationWarehouseId", destination_warehouse_name AS "destinationWarehouseName", product_id AS "productId", quantity_changed AS "quantityChanged", cost_per_unit AS "costPerUnit", total_value AS "totalValue", reason, inspector_name AS "inspectorName", date_ad AS "dateAD", date_bs AS "dateBS", fiscal_year AS "fiscalYear", status, items';

/**
 * Builds the stock-operations list query. A concrete branch also sees
 * operations destined for its warehouse (OR destination_warehouse_id).
 */
export function buildStockOperationListQuery(branchId?: unknown): { sql: string; params: unknown[] } {
  const filter = branchId && branchId !== 'ALL';
  return {
    sql:
      `SELECT ${STOCK_OP_SELECT_COLUMNS} FROM stock_operations` +
      (filter ? ' WHERE branch_id = $1 OR destination_warehouse_id = $1' : '') +
      ' ORDER BY created_at DESC',
    params: filter ? [branchId] : [],
  };
}

export const STOCK_OPERATION_INSERT_SQL = `INSERT INTO stock_operations (
   id, reference_number, type, technician_name, work_order_ref, branch_id, branch_name, destination_warehouse_id, destination_warehouse_name, product_id, quantity_changed, cost_per_unit, total_value, reason, inspector_name, date_ad, date_bs, fiscal_year, status, items
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
 ON CONFLICT (id) DO UPDATE SET
   status = EXCLUDED.status,
   items = EXCLUDED.items;`;

export function stockOperationInsertParams(
  op: Record<string, any>,
  opType: string,
  totalValue: number,
  itemsJson: string
): unknown[] {
  return [
    op.id,
    op.referenceNumber,
    opType,
    op.technicianName || null,
    op.workOrderRef || null,
    op.branchId || 'WH001',
    op.branchName,
    op.destinationWarehouseId,
    op.destinationWarehouseName,
    op.productId || null,
    Number(op.quantityChanged) || 0,
    Number(op.costPerUnit) || 0,
    totalValue,
    op.reason || '',
    op.inspectorName || null,
    op.dateAD,
    op.dateBS,
    op.fiscalYear,
    op.status,
    itemsJson,
  ];
}

/** DAMAGE: moves units from usable to damaged, guarding on usable stock. */
export const STOCK_DAMAGE_APPLY_SQL = `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, damaged_qty = damaged_qty + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`;

/** PULLOUT of damaged stock: releases damaged units only. */
export const STOCK_RELEASE_DAMAGED_SQL = `UPDATE inventory_stock SET damaged_qty = damaged_qty - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND damaged_qty >= $1;`;

/** Consumes usable stock (pull-out, stock-out, consumable issue). */
export const STOCK_CONSUME_QOH_SQL = `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`;

/** Reversal of a damage op: damaged units return to usable stock. */
export const STOCK_REVERSE_DAMAGE_SQL = `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand + $1, damaged_qty = damaged_qty - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND damaged_qty >= $1;`;

export const STOCK_OPERATION_CANCEL_SQL = `UPDATE stock_operations SET status = 'CANCELLED', updated_by = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2;`;

/** Locks a stock-operation row and reads the fields needed to receive it. */
export const STOCK_OPERATION_FIND_FOR_RECEIVE_SQL =
  'SELECT status, destination_warehouse_id AS "destinationWarehouseId", items FROM stock_operations WHERE id = $1 FOR UPDATE';

export const STOCK_OPERATION_SET_STATUS_SQL = 'UPDATE stock_operations SET status = $1 WHERE id = $2';

/** Settles received pull-out units into the destination warehouse stock. */
export const PULLOUT_RECEIVE_STOCK_SQL = `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty)
 VALUES ($1, $2, $3, $4, 0)
 ON CONFLICT (product_id, branch_id) DO UPDATE SET
   quantity_on_hand = inventory_stock.quantity_on_hand + $4,
   last_updated = CURRENT_TIMESTAMP;`;

export function pulloutReceiveStockParams(destBranchId: string, item: Record<string, any>): unknown[] {
  return [`stk-${destBranchId.toLowerCase()}-${item.productId}`, item.productId, destBranchId, Number(item.quantity) || 1];
}

// ---------------------------------------------------------------------------
// Customer devices (CPE)
// ---------------------------------------------------------------------------

export const CDR_SELECT_COLUMNS =
  'id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", contact_phone AS "contactPhone", installation_address AS "installationAddress", branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", status, issued_date_ad AS "issuedDateAD", issued_date_bs AS "issuedDateBS", purchase_bill_ref AS "purchaseBillRef", notes';

/**
 * Builds the customer-device list query with an optional branch filter and a
 * case-insensitive search across the six searchable columns. Mirrors the
 * inline SQL assembled in the controller verbatim.
 */
export function buildCustomerDeviceListQuery(branchId?: unknown, query?: unknown): { sql: string; params: unknown[] } {
  let sql = `SELECT ${CDR_SELECT_COLUMNS} FROM customer_device_records`;
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (branchId && branchId !== 'ALL') {
    params.push(branchId);
    conditions.push(`branch_id = $${params.length}`);
  }

  if (query && typeof query === 'string' && query.trim()) {
    params.push(`%${query.trim().toLowerCase()}%`);
    conditions.push(`(LOWER(device_serial) LIKE $${params.length} OR LOWER(pon_serial) LIKE $${params.length} OR LOWER(mac_address) LIKE $${params.length} OR LOWER(customer_name) LIKE $${params.length} OR LOWER(customer_code) LIKE $${params.length} OR LOWER(contact_phone) LIKE $${params.length})`);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY created_at DESC';
  return { sql, params };
}

export const CDR_DUPLICATE_CHECK_SQL = `SELECT 1 FROM customer_device_records
         WHERE id <> $1 AND (UPPER(TRIM(device_serial)) = $2 OR UPPER(TRIM(pon_serial)) = $3) LIMIT 1`;

export const CDR_EXISTING_STATUS_SQL = 'SELECT status FROM customer_device_records WHERE id = $1';

/** CDR_FIND_NARROW_SQL — narrow column set for the status-patch lookup. */
export const CDR_FIND_NARROW_SQL =
  'SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", status FROM customer_device_records WHERE id = $1';

/** Status-only update (status patch handler; no serial fallback). */
export const CDR_UPDATE_STATUS_SQL = 'UPDATE customer_device_records SET status = $1 WHERE id = $2';

/** Full row read for the device-exchange handler. */
export const CDR_FIND_ALL_BY_ID_SQL = 'SELECT * FROM customer_device_records WHERE id = $1';

export const CDR_EXCHANGE_STATUS_SQL =
  'UPDATE customer_device_records SET status = $1, notes = $2 WHERE id = $3';

/** Plain insert used when an exchange creates the replacement device row. */
export const CDR_EXCHANGE_INSERT_SQL = `INSERT INTO customer_device_records (
     id, customer_id, customer_name, customer_code, contact_phone, installation_address, branch_id, product_name, device_serial, pon_serial, mac_address, status, issued_date_ad, issued_date_bs, purchase_bill_ref, notes
   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);`;

/** Assignment upsert: status / branch / notes are refreshed on conflict. */
export const CDR_UPSERT_SQL = `INSERT INTO customer_device_records (
   id, customer_id, customer_name, customer_code, contact_phone, installation_address, branch_id, product_name, device_serial, pon_serial, mac_address, status, issued_date_ad, issued_date_bs, purchase_bill_ref, notes
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
 ON CONFLICT (id) DO UPDATE SET
   status = EXCLUDED.status,
   branch_id = EXCLUDED.branch_id,
   notes = EXCLUDED.notes;`;

/** Shared param builder for CDR_UPSERT_SQL and CDR_EXCHANGE_INSERT_SQL. */
export function customerDeviceInsertParams(r: CustomerDeviceRecord): unknown[] {
  return [
    r.id,
    r.customerId,
    r.customerName,
    r.customerCode,
    r.contactPhone || '',
    r.installationAddress || '',
    r.branchId || 'WH001',
    r.productName,
    r.deviceSerial,
    r.ponSerial || r.deviceSerial,
    r.macAddress || null,
    r.status,
    r.issuedDateAD,
    r.issuedDateBS,
    r.purchaseBillRef || null,
    r.notes || '',
  ];
}

/** Adjusts usable stock by stockChange when a device is assigned/released. */
export const CDR_ASSIGNMENT_STOCK_SQL = `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand + $1, last_updated = CURRENT_TIMESTAMP
 WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $4
 RETURNING quantity_on_hand`;

export function cdrAssignmentStockParams(
  stockChange: number,
  productId: string,
  branchId: string,
  minRequired: number
): unknown[] {
  return [stockChange, productId, branchId, minRequired];
}

/**
 * Auto-provisions/updates the customer directory row and its
 * assigned-devices counter (conflict keyed on customer_id).
 */
export const CDR_CUSTOMER_COUNT_UPSERT_SQL = `INSERT INTO customer_records (id, customer_id, customer_name, username, contact_number, branch_id, address, status, assigned_devices_count)
 VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8)
 ON CONFLICT (customer_id) DO UPDATE SET
   assigned_devices_count = GREATEST(0, customer_records.assigned_devices_count + $8);`;

export function customerCountUpsertParams(p: {
  id: string;
  customerId: string;
  customerName: string;
  username: string;
  contactPhone: string;
  branchId: string;
  installationAddress: string;
  countDelta: number;
}): unknown[] {
  return [
    p.id,
    p.customerId,
    p.customerName,
    p.username,
    p.contactPhone,
    p.branchId,
    p.installationAddress,
    p.countDelta,
  ];
}

// ---------------------------------------------------------------------------
// Serial lookup (GET /api/inventory/serials/lookup)
// ---------------------------------------------------------------------------

/**
 * Builds the three-statement serial lookup: serial_log register first, then
 * customer assignments, then fixed assets (device serial stored as
 * tag_number). `exclude` skips the edited device's own old values — every
 * match is case-insensitive and whitespace-trimmed.
 */
export function buildSerialLookupSql(value: string, exclude: string[]): {
  params: unknown[];
  serialLogSql: string;
  customerDeviceSql: string;
  fixedAssetSql: string;
} {
  const notSelf = exclude.length
    ? ` AND NOT (${['lower(trim(device_serial))', 'lower(trim(pon_serial))', 'lower(trim(mac_address))']
        .map((col) => `${col} IN (${exclude.map((_, i) => `lower(trim($${i + 2}))`).join(', ')})`)
        .join(' OR ')})`
    : '';
  // fixed_assets stores the device serial as tag_number and has no pon/mac
  // columns, so it needs its own exclusion clause built on tag_number only.
  const notSelfAsset = exclude.length
    ? ` AND NOT (lower(trim(tag_number)) IN (${exclude.map((_, i) => `lower(trim($${i + 2}))`).join(', ')}))`
    : '';
  const params = [value, ...exclude];

  return {
    params,
    serialLogSql: `SELECT device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress",
              product_id AS "productId", product_name AS "productName", branch_id AS "branchId",
              customer_id AS "customerId", customer_name AS "customerName", status
       FROM serial_log
       WHERE (lower(trim(device_serial)) = lower(trim($1))
           OR lower(trim(pon_serial)) = lower(trim($1))
           OR lower(trim(mac_address)) = lower(trim($1)))${notSelf}
       LIMIT 1`,
    customerDeviceSql: `SELECT device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress",
              product_name AS "productName", branch_id AS "branchId",
              customer_id AS "customerId", customer_name AS "customerName", status
       FROM customer_device_records
       WHERE (lower(trim(device_serial)) = lower(trim($1))
           OR lower(trim(pon_serial)) = lower(trim($1))
           OR lower(trim(mac_address)) = lower(trim($1)))${notSelf}
       LIMIT 1`,
    fixedAssetSql: `SELECT tag_number AS "deviceSerial", name AS "productName", branch_id AS "branchId"
       FROM fixed_assets
       WHERE lower(trim(tag_number)) = lower(trim($1))${notSelfAsset}
       LIMIT 1`,
  };
}

// ---------------------------------------------------------------------------
// Serial log register
// ---------------------------------------------------------------------------

export const SERIAL_LOG_SELECT_PREFIX =
  'SELECT id, device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", product_id AS "productId", product_name AS "productName", branch_id AS "branchId", customer_id AS "customerId", customer_name AS "customerName", status, source_type AS "sourceType", source_id AS "sourceId", history_json AS "historyJson", created_at AS "createdAt", updated_at AS "updatedAt" FROM serial_log';

export interface SerialLogQueryOptions {
  /** Non-global roles: explicit branch IN-list (already auth-resolved). */
  branchScope?: string[];
  /** Global roles: single optional branch equality filter. */
  globalBranchId?: unknown;
  status?: unknown;
  query?: unknown;
}

/**
 * Builds the serial-log register query. Branch scoping for non-global users
 * (the 403/empty-set decisions) is resolved by the controller and passed in
 * as `branchScope`; the SQL here stays purely textural.
 */
export function buildSerialLogQuery(opts: SerialLogQueryOptions): { sql: string; params: unknown[] } {
  let sql = SERIAL_LOG_SELECT_PREFIX + ' WHERE 1=1';
  const params: unknown[] = [];
  let paramIdx = 0;
  if (opts.branchScope && opts.branchScope.length > 0) {
    const placeholders = opts.branchScope.map((_, i) => `$${params.length + i + 1}`).join(', ');
    sql += ` AND branch_id IN (${placeholders})`;
    params.push(...opts.branchScope);
    paramIdx += opts.branchScope.length;
  }
  if (opts.globalBranchId && opts.globalBranchId !== 'ALL') {
    params.push(opts.globalBranchId as string);
    paramIdx++;
    sql += ` AND branch_id = $${paramIdx}`;
  }
  if (opts.status && opts.status !== 'ALL') {
    params.push(opts.status as string);
    paramIdx++;
    sql += ` AND status = $${paramIdx}`;
  }
  if (opts.query && typeof opts.query === 'string' && opts.query.trim()) {
    const like = `%${opts.query.trim().toLowerCase()}%`;
    params.push(like);
    paramIdx++;
    sql += ` AND (LOWER(device_serial) LIKE $${paramIdx} OR LOWER(COALESCE(pon_serial, '')) LIKE $${paramIdx} OR LOWER(COALESCE(mac_address, '')) LIKE $${paramIdx} OR LOWER(product_name) LIKE $${paramIdx} OR LOWER(COALESCE(customer_name, '')) LIKE $${paramIdx})`;
  }
  sql += ` ORDER BY created_at DESC`;
  return { sql, params };
}

/** Locks a serial_log history row (FOR UPDATE) for the upsert read-modify-write. */
export const SERIAL_LOG_LOCK_HISTORY_SQL =
  'SELECT history_json FROM serial_log WHERE id = $1 FOR UPDATE';

/** Idempotent upsert probe: one serial = one row (case/trim-insensitive). */
export const SERIAL_LOG_FIND_BY_DEVICE_SQL =
  'SELECT id, history_json FROM serial_log WHERE lower(trim(device_serial)) = lower(trim($1))';

export const SERIAL_LOG_UPDATE_SQL = `UPDATE serial_log SET pon_serial = COALESCE($1, pon_serial), mac_address = COALESCE($2, mac_address),
  product_id = COALESCE($3, product_id), product_name = COALESCE($4, product_name),
  branch_id = COALESCE($5, branch_id),          customer_id = COALESCE($6, customer_id), customer_name = COALESCE($7, customer_name),
  status = $8, source_type = $9, source_id = COALESCE($10, source_id),
  history_json = $11, updated_at = $12 WHERE id = $13`;

export function serialLogUpdateParams(rec: {
  ponSerial: string | null;
  macAddress: string | null;
  productId: string | null;
  productName: string | null;
  branchId: string | null;
  customerId: string | null;
  customerName: string | null;
  status: string;
  sourceType: string;
  sourceId: string | null;
  historyJson: string;
  updatedAt: string;
  id: string;
}): unknown[] {
  return [
    rec.ponSerial,
    rec.macAddress,
    rec.productId,
    rec.productName,
    rec.branchId,
    rec.customerId,
    rec.customerName,
    rec.status,
    rec.sourceType,
    rec.sourceId,
    rec.historyJson,
    rec.updatedAt,
    rec.id,
  ];
}

export const SERIAL_LOG_INSERT_SQL = `INSERT INTO serial_log (id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id, customer_id, customer_name, status, source_type, source_id, history_json, created_at, updated_at, is_demo)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, FALSE)`;

export function serialLogInsertParams(rec: {
  id: string;
  deviceSerial: string;
  ponSerial: string | null;
  macAddress: string | null;
  productId: string | null;
  productName: string | null;
  branchId: string | null;
  customerId: string | null;
  customerName: string | null;
  status: string;
  sourceType: string;
  sourceId: string | null;
  historyJson: string;
  timestamp: string;
}): unknown[] {
  return [
    rec.id,
    rec.deviceSerial,
    rec.ponSerial,
    rec.macAddress,
    rec.productId,
    rec.productName,
    rec.branchId,
    rec.customerId,
    rec.customerName,
    rec.status,
    rec.sourceType,
    rec.sourceId,
    rec.historyJson,
    rec.timestamp,
    rec.timestamp,
  ];
}
