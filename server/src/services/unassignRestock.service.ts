/**
 * Asset unassign restock service (extracted from inventory.controller
 * patch_status so the decision logic is unit-testable — same pattern as
 * damage.service.ts).
 *
 * A deploy-from-stock asset (catalog product created straight into deployment)
 * consumed one unit of branch stock and one serial_log unit. When that asset
 * is unassigned back to ACTIVE, this module decides whether the symmetric
 * restock must fire and builds its ledger row / in-memory mirrors.
 */

export interface RestockAsset {
  id: string;
  tagNumber: string;
  name?: string;
  productId?: string | null;
  branchId?: string | null;
  acquisitionCost?: number | null;
  deviceSerial?: string | null;
}

export interface RestockTxn {
  id: string;
  transactionNumber: string;
  productId: string;
  productSku: string;
  productName: string;
  branchId: string;
  changeType: 'MANUAL_ADJUSTMENT';
  quantityBefore: number;
  quantityChanged: number;
  quantityAfter: number;
  unitCost: number;
  referenceDocId: string;
  timestampAD: string;
  timestampBS: string;
}

export interface RestockLedgerRow {
  referenceDocId?: string;
  productId?: string;
  changeType?: string;
}

/**
 * Decides whether an unassign must fire the symmetric restock.
 *
 * Rules:
 *  - the request must move the asset back to ACTIVE from an ASSIGNED_TO_* state
 *  - the asset must reference a catalog product
 *  - a STOCK_OUT ledger row must prove the deploy deducted branch stock
 *  - no MANUAL_ADJUSTMENT restock row may exist yet (idempotency guard:
 *    repeat unassign calls never double-restore)
 */
export function shouldRestockOnUnassign(opts: {
  newStatus: string | undefined;
  prevStatus: string;
  asset: RestockAsset | undefined;
  transactionLogs: readonly RestockLedgerRow[];
}): boolean {
  if (String(opts.newStatus || '') !== 'ACTIVE') return false;
  if (!['ASSIGNED_TO_LOCATION', 'ASSIGNED_TO_CUSTOMER'].includes(opts.prevStatus)) return false;
  const asset = opts.asset;
  if (!asset?.productId) return false;
  const deployTxnExists = opts.transactionLogs.some(
    (t) => t.referenceDocId === asset.tagNumber && t.productId === asset.productId && t.changeType === 'STOCK_OUT'
  );
  const restockTxnExists = opts.transactionLogs.some(
    (t) => t.referenceDocId === asset.tagNumber && t.productId === asset.productId && t.changeType === 'MANUAL_ADJUSTMENT'
  );
  return deployTxnExists && !restockTxnExists;
}

/**
 * Builds the restock ledger row (+1 unit) with before/after quantities derived
 * from the current branch stock level.
 */
export function buildRestockTransaction(opts: {
  asset: RestockAsset;
  branchId: string;
  quantityBefore: number;
  todayAD: string;
  products: readonly { id: string; sku?: string; name?: string; costPrice?: number }[];
}): RestockTxn {
  const { asset } = opts;
  const product = opts.products.find((entry) => entry.id === asset.productId);
  return {
    id: `txn-asset-unassign-${asset.id}`,
    transactionNumber: `${asset.tagNumber}-RESTOCK`,
    productId: String(asset.productId),
    productSku: product?.sku || '',
    productName: product?.name || asset.name || '',
    branchId: opts.branchId,
    changeType: 'MANUAL_ADJUSTMENT',
    quantityBefore: opts.quantityBefore,
    quantityChanged: 1,
    quantityAfter: opts.quantityBefore + 1,
    unitCost: Number(asset.acquisitionCost) || product?.costPrice || 0,
    referenceDocId: asset.tagNumber,
    timestampAD: opts.todayAD,
    timestampBS: '',
  };
}

/**
 * In-memory mirror of the serial restore: flips the deployed serial back to
 * IN_STOCK in the runtime register (case/trim-insensitive match, only when it
 * is not already IN_STOCK). Accepts a readonly register and finds the live row
 * by identity so the caller's mutable backing array is mutated in place.
 */
export function restoreInMemorySerial(
  serialLogs: readonly any[],
  asset: RestockAsset
): boolean {
  if (!asset.deviceSerial) return false;
  const key = String(asset.deviceSerial).trim().toLowerCase();
  const sl = serialLogs.find(
    (e) => String(e.deviceSerial || '').trim().toLowerCase() === key && e.status !== 'IN_STOCK'
  );
  if (!sl) return false;
  sl.status = 'IN_STOCK';
  sl.updatedAt = new Date().toISOString();
  return true;
}
