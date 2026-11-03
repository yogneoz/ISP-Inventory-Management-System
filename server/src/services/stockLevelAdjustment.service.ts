/**
 * Direct stock-level corrections (PATCH /api/stock/:id).
 *
 * A level correction is a stock document like any other: it changes quantity,
 * so it must change inventory value at the row's weighted average inside the
 * same transaction. This service owns the locked read, the delta calculation,
 * the value journal, the movement-ledger row and the optional damage record.
 * The caller owns BEGIN/COMMIT and the in-memory mirror update.
 */
import crypto from 'crypto';
import { ApiError } from '../errors/ApiError';
import {
  DAMAGE_RECORD_ADJUSTMENT_SQL,
  STOCK_LOCK_BY_ID_SQL,
  STOCK_UPSERT_LEVELS_SQL,
  TXN_INSERT_NOW_SQL,
  damageAdjustmentParams,
  miscPulloutTxnParams,
  stockUpsertLevelsParams,
} from '../models/inventory.repo';
import { buildDamagePoolLedgerChange } from './damage.service';
import { postStockValueJournal } from './stockPosting.service';
import type { AccountingClient } from './accounting.service';
import type { DamageRecord, TransactionLog } from '../../../client/src/types';

export interface StockLevelAdjustmentInput {
  stockId: string;
  quantityOnHand?: number;
  damagedQty?: number;
  minReorderLevel?: number;
  reason?: string;
  changeType?: string;
  actor: string | null;
  actorName: string;
  journalDateAD: string;
  timestampBS: string;
  product?: {
    id?: string;
    sku?: string;
    name?: string;
    costPrice?: number;
  };
}

export interface StockLevelAdjustmentResult {
  previous: { quantityOnHand: number; damagedQty: number };
  stock: {
    id: string;
    productId: string;
    branchId: string;
    quantityOnHand: number;
    damagedQty: number;
    reservedQty: number;
    incomingQty: number;
    minReorderLevel: number;
    lastUpdated: string;
  };
  transactionLog: TransactionLog | null;
  damageRecord: DamageRecord | null;
  journalId: string | null;
  adjustmentId: string;
}

/** Pure delta calculation, shared with the demo-mode mirror path. */
export function computeStockLevelAdjustment(
  current: { quantityOnHand: number; damagedQty: number },
  input: Pick<StockLevelAdjustmentInput, 'quantityOnHand' | 'damagedQty'>
): { quantityOnHand: number; damagedQty: number } {
  const damagedQty = input.damagedQty === undefined ? current.damagedQty : input.damagedQty;
  let quantityOnHand = current.quantityOnHand;
  if (input.quantityOnHand !== undefined) {
    quantityOnHand = input.quantityOnHand;
  } else if (input.damagedQty !== undefined) {
    quantityOnHand = Math.max(0, current.quantityOnHand - (damagedQty - current.damagedQty));
  }
  return { quantityOnHand, damagedQty };
}

/**
 * Apply one direct correction on the caller's transaction client.
 *
 * The stock row is locked before its average is read, so two concurrent edits
 * cannot both journal the same pre-edit balance. Any journal refusal (closed
 * period, missing posting default, unknown branch) propagates and rolls back
 * the quantity change with it.
 */
export async function applyStockLevelAdjustment(
  client: AccountingClient,
  input: StockLevelAdjustmentInput
): Promise<StockLevelAdjustmentResult> {
  const locked = await client.query(STOCK_LOCK_BY_ID_SQL, [input.stockId]);
  const row = locked.rows[0];
  if (!row) throw new ApiError(404, 'Stock record not found');

  const before = {
    quantityOnHand: Number(row.quantityOnHand) || 0,
    damagedQty: Number(row.damagedQty) || 0,
  };
  const next = computeStockLevelAdjustment(before, input);
  const delta = next.quantityOnHand - before.quantityOnHand;
  const averageCost = Number(row.averageCost) || 0;
  const fallbackCost = Math.max(0, Number(input.product?.costPrice) || 0);
  const unitCost = averageCost > 0 ? averageCost : fallbackCost;
  const adjustmentId = `stock-adjustment-${crypto.randomUUID()}`;
  const updatedAt = new Date().toISOString();

  const stock = {
    id: String(row.id),
    productId: String(row.productId),
    branchId: String(row.branchId),
    quantityOnHand: next.quantityOnHand,
    damagedQty: next.damagedQty,
    reservedQty: Number(row.reservedQty) || 0,
    incomingQty: Number(row.incomingQty) || 0,
    minReorderLevel:
      input.minReorderLevel === undefined
        ? Number(row.minReorderLevel) || 0
        : input.minReorderLevel,
    lastUpdated: updatedAt,
  };

  let journalId: string | null = null;
  if (delta !== 0) {
    const journal = await postStockValueJournal(client, {
      branchId: stock.branchId,
      journalDateAD: input.journalDateAD,
      sourceType: 'STOCK_ADJUSTMENT',
      sourceId: adjustmentId,
      memo: `Stock level correction ${stock.productId}${input.reason ? ` — ${input.reason}` : ''}`,
      movements: [{ productId: stock.productId, quantity: delta, unitCost }],
      actor: input.actor,
    });
    journalId = journal?.id || null;
  }

  await client.query(STOCK_UPSERT_LEVELS_SQL, stockUpsertLevelsParams(stock));

  const isDamageChange =
    input.changeType === 'DAMAGE' ||
    (input.damagedQty !== undefined && next.damagedQty !== before.damagedQty);
  let transactionLog: TransactionLog | null = null;
  if (isDamageChange || delta !== 0) {
    const damagePool = buildDamagePoolLedgerChange(before.damagedQty, next.damagedQty);
    transactionLog = {
      id: `txn-${adjustmentId}`,
      transactionNumber: `TXN-ADJ-${Math.floor(10000 + Math.random() * 90000)}`,
      productId: stock.productId,
      productSku: input.product?.sku || '',
      productName: input.product?.name || '',
      branchId: stock.branchId,
      changeType: isDamageChange ? 'DAMAGE' : 'MANUAL_ADJUSTMENT',
      quantityBefore: isDamageChange ? before.damagedQty : before.quantityOnHand,
      quantityChanged: isDamageChange ? damagePool.quantityChanged : delta,
      quantityAfter: isDamageChange ? next.damagedQty : next.quantityOnHand,
      unitCost: unitCost || fallbackCost,
      referenceDocId: input.reason || 'STOCK_ADJUSTMENT',
      timestampAD: new Date().toISOString(),
      timestampBS: input.timestampBS,
    };
    await client.query(TXN_INSERT_NOW_SQL, miscPulloutTxnParams(transactionLog));
  }

  let damageRecord: DamageRecord | null = null;
  if (input.damagedQty !== undefined && next.damagedQty !== before.damagedQty) {
    const affectedQty = Math.abs(next.damagedQty - before.damagedQty);
    const todayAD = input.journalDateAD;
    const damageRef = `DMR-ADJ-${stock.id}-${Date.now()}`;
    const damageRecordId = `dmr-adj-${stock.id}-${crypto.randomUUID()}`;
    const knownReason = (input.reason || 'Damaged stock balance verification').toUpperCase();
    const damageReason =
      ['PHYSICAL_DAMAGE', 'TRANSIT_DAMAGE', 'STORAGE_DAMAGE', 'EXPIRED', 'RETURN_DAMAGE', 'QUALITY_DEFECT', 'OTHER']
        .find((entry) => knownReason.includes(entry)) || 'OTHER';

    await client.query(
      DAMAGE_RECORD_ADJUSTMENT_SQL,
      damageAdjustmentParams({
        id: damageRecordId,
        damageReference: damageRef,
        productId: stock.productId,
        branchId: stock.branchId,
        quantityDamaged: affectedQty,
        unitCost,
        totalCost: unitCost * affectedQty,
        damageDateAD: todayAD,
        damageDateBS: input.timestampBS,
        damageReason,
        approvedBy: input.actorName || 'Stock Manager',
        notes: input.reason || 'Damaged stock balance verification',
        createdBy: input.actor || 'system',
      })
    );

    damageRecord = {
      id: damageRecordId,
      damageReference: damageRef,
      productId: stock.productId,
      branchId: stock.branchId,
      quantityDamaged: affectedQty,
      unitCost,
      totalCost: unitCost * affectedQty,
      damageDateAD: todayAD,
      damageDateBS: input.timestampBS,
      damageReason: damageReason as DamageRecord['damageReason'],
      status: 'IDENTIFIED',
      salvageValue: 0,
      glAccountCode: 'GL-5120 (Loss on Inventory Scrap & Write-off)',
      writeOffLoss: 0,
      approvedBy: input.actorName || 'Stock Manager',
      notes: input.reason || 'Damaged stock balance verification',
      isDemo: false,
      createdBy: input.actor || 'system',
    } as DamageRecord;
  }

  return { previous: before, stock, transactionLog, damageRecord, journalId, adjustmentId };
}
