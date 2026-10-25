/**
 * CPE ↔ fixed-asset lifecycle (CPE-3, decision D1).
 *
 * Collection and exchange used to move the CPE row, serial_log and stock while
 * leaving the fixed asset frozen on the old customer/serial. The two reversal
 * routes also keyed their restock rows differently, so reversing one
 * collection through both could credit stock twice.
 *
 * This module is the ONE place the asset rule lives:
 *   - collection: asset → ACTIVE, assignment cleared, serial returned; one
 *     stock credit, keyed by the fixed-asset id, only when the deployment
 *     proved a STOCK_OUT (an asset that never drew branch stock is not
 *     restocked);
 *   - exchange: same tag and assignment, device_serial moved to the
 *     replacement, notes carry the old → new serial; the replacement's
 *     STOCK_OUT is posted in the same transaction as the old unit's credit.
 *
 * All writes use the caller's transaction client. A refusal throws
 * OperationError so the controller's usual errorResponse maps it to 4xx and
 * rolls the whole transaction back.
 */
import type { TransactionLog } from '../../../client/src/types';
import {
  CDR_NOTES_BY_ID_SQL,
  CPE_REPLACEMENT_UNIT_SQL,
  FIXED_ASSET_COLLECT_SQL,
  FIXED_ASSET_DEPLOY_PROOF_SQL,
  FIXED_ASSET_LOCK_BY_ID_SQL,
  FIXED_ASSET_LOCK_BY_SERIAL_OR_TAG_SQL,
  FIXED_ASSET_MOVE_SERIAL_SQL,
  STOCK_CONSUME_QOH_SQL,
  STOCK_LOCK_ONE_SQL,
  STOCK_RETURN_FROM_ASSET_SQL,
  TXN_FIND_BY_ID_SQL,
  TXN_INSERT_ON_CONFLICT_SQL,
  txnInsertOnConflictParams,
} from '../models/inventory.repo';
import { OperationError } from '../utils/operationError';

export interface CpeAssetRow {
  id: string;
  tagNumber: string;
  productId: string | null;
  branchId: string | null;
  status: string;
  deviceSerial: string | null;
  assignedCustomerId?: string | null;
  assignedCustomerName?: string | null;
  assignedLocationId?: string | null;
  assignedLocationName?: string | null;
  assignmentNotes?: string | null;
}

export interface LifecycleProduct {
  id: string;
  sku?: string;
  name?: string;
  costPrice?: number;
}

export interface CollectCpeAssetInput {
  client: any;
  /** Asset id when the caller already has the row (asset-unassign path). */
  assetId?: string | null;
  /** CPE row; its notes carry the asset tag stamped at deployment. */
  cpeId?: string | null;
  deviceSerial?: string | null;
  requestNumber?: string | null;
  todayAD: string;
  todayBS?: string;
  branchId?: string | null;
  products?: readonly LifecycleProduct[];
  /** Used when no fixed asset is linked (legacy CPE-only collection). */
  fallbackProduct?: LifecycleProduct | null;
  allowUnlinkedRestock?: boolean;
  changeType?: 'PULLOUT' | 'MANUAL_ADJUSTMENT';
}

export interface CollectCpeAssetResult {
  asset: CpeAssetRow | null;
  assetCollected: boolean;
  alreadyCollected: boolean;
  stockCredited: boolean;
  ledger: TransactionLog | null;
  reason: string;
}

export interface ExchangeCpeAssetInput {
  client: any;
  cpeId?: string | null;
  oldSerial: string;
  newSerial: string;
  newCdrId: string;
  todayAD: string;
  todayBS?: string;
  branchId?: string | null;
  newProductName?: string | null;
  replacementProductId?: string | null;
  products?: readonly LifecycleProduct[];
}

export interface ExchangeCpeAssetResult {
  asset: CpeAssetRow | null;
  assetMoved: boolean;
  replacementStockDeducted: boolean;
  ledger: TransactionLog | null;
}

/** Reads the tag the deployment flow stamped into a CPE record's notes. */
export function extractCpeAssetTag(notes: unknown): string {
  const text = String(notes || '');
  const match = text.match(/\[(?:FIXED ASSET CPE|RENTAL CPE ASSET)\s*-\s*Tag:\s*([^\]]+)\]/i);
  return match ? match[1].trim() : '';
}

/** A deployed asset is one that still names a customer/location assignment. */
export function isDeployedAsset(asset: CpeAssetRow | null | undefined): boolean {
  if (!asset) return false;
  if (asset.assignedCustomerId || asset.assignedLocationId) return true;
  return ['ASSIGNED_TO_CUSTOMER', 'ASSIGNED_TO_LOCATION', 'IN_USE'].includes(
    String(asset.status || '').toUpperCase()
  );
}

/**
 * One idempotency id per collection event. Keying on the fixed-asset id (not
 * the route or request number) is what makes the approval path, the direct
 * status PATCH and the asset-unassign screen agree: whichever runs first
 * inserts the row, every later path sees it and never credits again.
 */
export function collectionLedgerId(key: string): string {
  const safe = String(key || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .slice(0, 64);
  return `txn-cpe-collect-${safe || 'unknown'}`;
}

/** One idempotency id per exchange replacement movement. */
export function exchangeOutLedgerId(newCdrId: string): string {
  const safe = String(newCdrId || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .slice(0, 64);
  return `txn-cpe-exchange-out-${safe || 'unknown'}`;
}

/** Collection keeps the old assignment history in the notes column. */
export function buildAssetCollectionNotes(
  prevNotes: string | null | undefined,
  opts: { todayAD: string; requestNumber?: string | null; serial?: string | null }
): string {
  const parts: string[] = [];
  if (prevNotes) parts.push(String(prevNotes));
  const serial = String(opts.serial || '').trim();
  const request = String(opts.requestNumber || '').trim();
  parts.push(
    `[COLLECTED ${opts.todayAD}] CPE collection${request ? ` ${request}` : ''}` +
      (serial ? `; serial ${serial} returned to stock` : '') +
      '.'
  );
  return parts.join(' | ');
}

/** Exchange keeps the tag and assignment, recording the identity move. */
export function buildAssetExchangeNotes(
  prevNotes: string | null | undefined,
  opts: { todayAD: string; oldSerial: string; newSerial: string }
): string {
  const parts: string[] = [];
  if (prevNotes) parts.push(String(prevNotes));
  parts.push(
    `[EXCHANGED ${opts.todayAD}] Serial ${opts.oldSerial} → ${opts.newSerial}; asset tag preserved.`
  );
  return parts.join(' | ');
}

/**
 * Finds the asset behind a CPE row. The caller's client is already in a
 * transaction, so both reads and the FOR UPDATE lock are part of it.
 */
export async function findCpeAsset(
  client: any,
  opts: { assetId?: string | null; cpeId?: string | null; deviceSerial?: string | null }
): Promise<CpeAssetRow | null> {
  if (opts.assetId) {
    const byId = await client.query(FIXED_ASSET_LOCK_BY_ID_SQL, [opts.assetId]);
    if (byId.rows[0]) return byId.rows[0] as CpeAssetRow;
  }
  let tag = '';
  if (opts.cpeId) {
    const notes = await client.query(CDR_NOTES_BY_ID_SQL, [opts.cpeId]);
    tag = extractCpeAssetTag(notes.rows[0]?.notes);
  }
  const serial = String(opts.deviceSerial || '').trim();
  if (!serial && !tag) return null;
  const found = await client.query(FIXED_ASSET_LOCK_BY_SERIAL_OR_TAG_SQL, [serial, tag]);
  return (found.rows[0] as CpeAssetRow) || null;
}

function productFor(
  products: readonly LifecycleProduct[] | undefined,
  id: string | null | undefined,
  fallback?: LifecycleProduct | null
): LifecycleProduct | null {
  if (!id) return fallback || null;
  return products?.find((p) => p.id === id) || fallback || null;
}

function collectionLedgerRow(opts: {
  id: string;
  transactionNumber: string;
  product: LifecycleProduct;
  productId: string;
  branchId: string;
  before: number;
  after: number;
  changeType: 'PULLOUT' | 'MANUAL_ADJUSTMENT';
  referenceDocId: string;
  todayAD: string;
  todayBS?: string;
}): TransactionLog {
  return {
    id: opts.id,
    transactionNumber: opts.transactionNumber,
    productId: opts.productId,
    productSku: opts.product.sku || '',
    productName: opts.product.name || 'Product',
    branchId: opts.branchId,
    changeType: opts.changeType,
    quantityBefore: opts.before,
    quantityChanged: 1,
    quantityAfter: opts.after,
    unitCost: Number(opts.product.costPrice) || 0,
    referenceDocId: opts.referenceDocId,
    timestampAD: opts.todayAD,
    timestampBS: opts.todayBS || '',
  } as TransactionLog;
}

/**
 * Applies the collection half of D1. Returns the asset, whether it was moved,
 * the one ledger row (if this call credited stock) and why a no-op happened.
 */
export async function collectCpeFixedAsset(input: CollectCpeAssetInput): Promise<CollectCpeAssetResult> {
  const { client } = input;
  const asset = await findCpeAsset(client, {
    assetId: input.assetId,
    cpeId: input.cpeId,
    deviceSerial: input.deviceSerial,
  });

  if (!asset) {
    if (!input.allowUnlinkedRestock || !input.fallbackProduct?.id || !input.branchId) {
      return {
        asset: null,
        assetCollected: false,
        alreadyCollected: false,
        stockCredited: false,
        ledger: null,
        reason: 'no linked asset and no unlinked stock credit requested',
      };
    }
    // Unlinked legacy row: the CPE id is the one key every route shares
    // (approval execution and the direct status PATCH both have it). The
    // request number is only a fallback for a row that no longer exists.
    const key = String(input.cpeId || input.requestNumber || input.deviceSerial || 'unlinked');
    const ledgerId = collectionLedgerId(key);
    const existing = await client.query(TXN_FIND_BY_ID_SQL, [ledgerId]);
    if (existing.rows[0]) {
      return {
        asset: null,
        assetCollected: false,
        alreadyCollected: false,
        stockCredited: false,
        ledger: null,
        reason: 'collection stock was already credited for this request',
      };
    }
    const locked = await client.query(STOCK_LOCK_ONE_SQL, [input.fallbackProduct.id, input.branchId]);
    const before = locked.rows[0] ? Number(locked.rows[0].quantity_on_hand) || 0 : 0;
    const returned = await client.query(STOCK_RETURN_FROM_ASSET_SQL, [
      input.fallbackProduct.id,
      input.branchId,
      1,
      `stk-${input.fallbackProduct.id}-${input.branchId}`,
    ]);
    const after = Number(returned.rows[0]?.quantity_on_hand ?? before + 1);
    const ledger = collectionLedgerRow({
      id: ledgerId,
      transactionNumber: `CPE-COLLECT-${String(input.requestNumber || input.cpeId || 'UNLINKED')}`,
      product: input.fallbackProduct,
      productId: input.fallbackProduct.id,
      branchId: input.branchId,
      before: Math.max(0, after - 1),
      after,
      changeType: input.changeType || 'PULLOUT',
      referenceDocId: `CPE_COLLECT:${key}`.slice(0, 100),
      todayAD: input.todayAD,
      todayBS: input.todayBS,
    });
    await client.query(TXN_INSERT_ON_CONFLICT_SQL, txnInsertOnConflictParams(ledger));
    return {
      asset: null,
      assetCollected: false,
      alreadyCollected: false,
      stockCredited: true,
      ledger,
      reason: 'credit posted for an unlinked CPE collection',
    };
  }

  if (!isDeployedAsset(asset)) {
    return {
      asset,
      assetCollected: false,
      alreadyCollected: true,
      stockCredited: false,
      ledger: null,
      reason: 'asset is already unassigned',
    };
  }

  const ledgerId = collectionLedgerId(asset.id);
  const existing = await client.query(TXN_FIND_BY_ID_SQL, [ledgerId]);
  const product = productFor(input.products, asset.productId, input.fallbackProduct);
  const productId = String(asset.productId || product?.id || '');
  const branchId = String(asset.branchId || input.branchId || '');
  let proof = false;
  if (productId) {
    const proofRes = await client.query(FIXED_ASSET_DEPLOY_PROOF_SQL, [
      productId,
      asset.tagNumber,
      asset.deviceSerial || '',
    ]);
    proof = Boolean(proofRes.rows[0]);
  }

  let ledger: TransactionLog | null = null;
  if (!existing.rows[0] && proof && productId && branchId && product) {
    const locked = await client.query(STOCK_LOCK_ONE_SQL, [productId, branchId]);
    const before = locked.rows[0] ? Number(locked.rows[0].quantity_on_hand) || 0 : 0;
    const returned = await client.query(STOCK_RETURN_FROM_ASSET_SQL, [
      productId,
      branchId,
      1,
      `stk-${productId}-${branchId}`,
    ]);
    const after = Number(returned.rows[0]?.quantity_on_hand ?? before + 1);
    ledger = collectionLedgerRow({
      id: ledgerId,
      transactionNumber: `CPE-COLLECT-${asset.tagNumber}`,
      product,
      productId,
      branchId,
      before: Math.max(0, after - 1),
      after,
      changeType: input.changeType || 'PULLOUT',
      referenceDocId: `CPE_COLLECT:${asset.tagNumber}`.slice(0, 100),
      todayAD: input.todayAD,
      todayBS: input.todayBS,
    });
    await client.query(TXN_INSERT_ON_CONFLICT_SQL, txnInsertOnConflictParams(ledger));
  }

  await client.query(FIXED_ASSET_COLLECT_SQL, [
    asset.id,
    buildAssetCollectionNotes(asset.assignmentNotes, {
      todayAD: input.todayAD,
      requestNumber: input.requestNumber,
      serial: asset.deviceSerial,
    }),
  ]);

  return {
    asset,
    assetCollected: true,
    alreadyCollected: false,
    stockCredited: Boolean(ledger),
    ledger,
    reason: ledger
      ? 'asset unassigned and one stock unit credited'
      : existing.rows[0]
        ? 'asset unassigned; this collection already credited stock'
        : 'asset unassigned; deployment never drew branch stock, so none was credited',
  };
}

/**
 * Applies the exchange half of D1. The asset keeps its tag and customer; only
 * its serial identity moves. The replacement's stock-out is posted here so it
 * can never commit without the old unit's disposition in the same transaction.
 */
export async function exchangeCpeFixedAsset(input: ExchangeCpeAssetInput): Promise<ExchangeCpeAssetResult> {
  const { client } = input;
  const asset = await findCpeAsset(client, {
    cpeId: input.cpeId,
    deviceSerial: input.oldSerial,
  });

  if (asset) {
    await client.query(FIXED_ASSET_MOVE_SERIAL_SQL, [
      asset.id,
      input.newSerial,
      buildAssetExchangeNotes(asset.assignmentNotes, {
        todayAD: input.todayAD,
        oldSerial: input.oldSerial,
        newSerial: input.newSerial,
      }),
    ]);
  }

  const ledgerId = exchangeOutLedgerId(input.newCdrId);
  const existing = await client.query(TXN_FIND_BY_ID_SQL, [ledgerId]);

  let replacementProductId = String(input.replacementProductId || '');
  if (!replacementProductId) {
    const unit = await client.query(CPE_REPLACEMENT_UNIT_SQL, [input.newSerial]);
    replacementProductId = String(unit.rows[0]?.productId || '');
  }
  const product =
    productFor(input.products, replacementProductId, null) ||
    input.products?.find(
      (p) => p.name?.trim().toLowerCase() === String(input.newProductName || '').trim().toLowerCase()
    ) ||
    null;
  if (!replacementProductId) replacementProductId = String(product?.id || '');

  const branchId = String(input.branchId || asset?.branchId || '');
  if (!existing.rows[0] && replacementProductId && branchId) {
    const locked = await client.query(STOCK_LOCK_ONE_SQL, [replacementProductId, branchId]);
    const row = locked.rows[0];
    if (row) {
      const before = Number(row.quantity_on_hand) || 0;
      if (before < 1) {
        throw new OperationError(
          409,
          `Replacement unit ${input.newSerial} is registered but branch stock is empty; the exchange was not applied.`
        );
      }
      await client.query(STOCK_CONSUME_QOH_SQL, [1, replacementProductId, branchId]);
      const ledger = {
        id: ledgerId,
        transactionNumber: `CPE-EXCHANGE-OUT-${input.newCdrId}`,
        productId: replacementProductId,
        productSku: product?.sku || '',
        productName: product?.name || input.newProductName || 'Product',
        branchId,
        changeType: 'STOCK_OUT' as const,
        quantityBefore: before,
        quantityChanged: -1,
        quantityAfter: before - 1,
        unitCost: Number(product?.costPrice) || 0,
        referenceDocId: input.newCdrId,
        timestampAD: input.todayAD,
        timestampBS: input.todayBS || '',
      } as TransactionLog;
      await client.query(TXN_INSERT_ON_CONFLICT_SQL, txnInsertOnConflictParams(ledger));
      return {
        asset,
        assetMoved: Boolean(asset),
        replacementStockDeducted: true,
        ledger,
      };
    }
  }

  return {
    asset,
    assetMoved: Boolean(asset),
    replacementStockDeducted: false,
    ledger: null,
  };
}
