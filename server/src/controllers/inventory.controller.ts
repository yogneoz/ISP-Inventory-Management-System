/**
 * Inventory controller — HTTP orchestration for the inventory domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { bsDateOr400 } from '../utils/bsDate';
import { getPgConnected, pgPool, inventoryStock, products, setTransactionLogs, withPrepended, transactionLogs, getUserFromReq, damageRecords, setDamageRecords, withReplaced, branches, setInventoryStock, withAppended, broadcastChange, withTransaction, logAuditEvent, assetRegister, purchaseInvoices, setAssetRegister, stockOperations, customerDeviceRecords, detectDateTypeMismatch, findBsDayRecordForAdDate, issueNextDocNumber, getFiscalYearCodeForDate, getFiscalYearIdForDate, setStockOperations, serialLogs, mutable, setCustomerDeviceRecords, runSerialEditCapture, setSerialLogs, customerMasterRecords } from '../app';
import { DamageRecord, TransactionLog, CustomerDeviceRecord } from '../../../client/src/types';
import { calculateFixedAssetValues } from '../../../client/src/utils/depreciation';
import { buildDamageRecordInsert, quarantineSerialsInDb, quarantineInMemorySerials, deriveDamageItems, validateReversalAvailability, buildReversalLedgerWithStock, buildReversalLedgerFromRestoredRows, restoreSerialsInDb, mirrorReversal, restoreInMemorySerials, buildDamagePoolLedgerChange } from '../services/damage.service';
import { shouldRestockOnUnassign, buildRestockTransaction, restoreInMemorySerial, cpeFindPatterns, buildCpeReversalClose } from '../services/unassignRestock.service';
import { SerialGateError, planSerialGateEntries, resolveSerialGateInDb, resolveSerialGateInMemory, serialGateKey } from '../services/serialGate.service';
import { OperationError, errorResponse } from '../utils/operationError';
import { validateDualEditPayload, applyDualEdit, generateParkTag } from '../services/serialEditCapture.service';
import { isActiveCdrStatus, upsertCdrMirror } from '../services/cdrSerialSync';
import { computeOperationTotalValue, computeLegacyOperationTotalValue } from '../utils/money';
import { resolveBsDateForLedger, todayBs } from '../utils/bsDate';
import {
  buildStockListQuery,
  STOCK_FIND_BY_ID_SQL,
  STOCK_UPSERT_LEVELS_SQL,
  stockUpsertLevelsParams,
  STOCK_UPSERT_REORDER_SQL,
  stockUpsertReorderParams,
  STOCK_RECONCILE_UPSERT_SQL,
  stockReconcileUpsertParams,
  STOCK_RECONCILE_DAMAGED_ADJUST_SQL,
  stockReconcileDamagedAdjustParams,
  TXN_INSERT_NOW_SQL,
  miscPulloutTxnParams,
  TXN_INSERT_ON_CONFLICT_SQL,
  txnInsertOnConflictParams,
  STOCK_REVERSE_DAMAGE_BATCH_SQL,
  stockReverseDamageBatchParams,
  STOCK_LOCK_FOR_UPDATE_SQL,
  stockLockForUpdateParams,
  LockedStockRow,
  STOCK_RETURN_QOH_BATCH_SQL,
  stockReturnQohBatchParams,
  DAMAGE_RECORD_CANCEL_BATCH_SQL,
  damageRecordCancelBatchParams,
  buildTxnMultiRowInsertSql,
  flattenTxnParams,
  DAMAGE_RECORD_ADJUSTMENT_SQL,
  damageAdjustmentParams,
  DAMAGE_RECORD_AUDIT_SHORTAGE_SQL,
  damageAuditShortageParams,
  ASSET_UPSERT_SQL,
  assetUpsertParams,
  ASSET_SET_ASSIGNMENT_SQL,
  STOCK_RETURN_FROM_ASSET_SQL,
  CDR_FIND_ACTIVE_BY_ASSET_TAG_SQL,
  CDR_CLOSE_ON_ASSET_REVERSAL_SQL,
  CDR_NOTES_BY_ID_SQL,
  buildStockOperationCountQuery,
  buildStockOperationStatusCountQuery,
  buildStockOperationPagedQuery,
  STOCK_OPERATION_INSERT_SQL,
  stockOperationInsertParams,
  STOCK_DAMAGE_APPLY_SQL,
  STOCK_RELEASE_DAMAGED_SQL,
  STOCK_CONSUME_QOH_SQL,
  STOCK_OPERATION_CANCEL_SQL,
  STOCK_OPERATION_FIND_BY_ID_SQL,
  STOCK_OPERATION_FIND_FOR_RECEIVE_SQL,
  STOCK_OPERATION_SET_STATUS_SQL,
  PULLOUT_RECEIVE_STOCK_SQL,
  pulloutReceiveStockParams,
  buildCustomerDeviceListQuery,
  CDR_DUPLICATE_CHECK_SQL,
  CDR_SERIAL_ROW_SQL,
  CDR_REDEPLOY_BY_SERIAL_SQL,
  cdrRedeployParams,
  CUSTOMER_FOR_CDR_INSERT_SQL,
  CDR_ASSIGNMENT_DAMAGED_RETURN_SQL,
  CDR_EXISTING_STATUS_SQL,
  CDR_FIND_NARROW_SQL,
  CDR_UPDATE_STATUS_SQL,
  CDR_FIND_ALL_BY_ID_SQL,
  CDR_EXCHANGE_STATUS_SQL,
  CDR_EXCHANGE_INSERT_SQL,
  CDR_UPSERT_SQL,
  customerDeviceInsertParams,
  CDR_ASSIGNMENT_STOCK_SQL,
  cdrAssignmentStockParams,
  CDR_ASSIGNMENT_STOCK_RETURN_SQL,
  cdrAssignmentReturnParams,
  CDR_ASSET_DEPLOY_PROOF_SQL,
  CDR_CUSTOMER_COUNT_UPSERT_SQL,
  customerCountUpsertParams,
  buildSerialLookupSql,
  buildSerialLogQuery,
  buildSerialLogCountQuery,
  buildSerialLogStatusCountQuery,
  SERIAL_LOG_FIND_IN_STOCK_BY_SERIAL_SQL,
  SERIAL_LOG_ASSIGN_ON_DEPLOY_SQL,
  SERIAL_LOG_RESTORE_ON_UNASSIGN_SQL,
  SERIAL_LOG_SYNC_ON_CDR_SQL,
  serialLogCdrSyncParams,
  SERIAL_LOG_IDENTITY_BY_SERIAL_SQL,
} from '../models/inventory.repo';
import {
  serialStatusForCdrStatus,
  serialStatusForExchangeAction,
  cdrHistoryEntry,
  flipSerialMirror,
} from '../services/cdrSerialSync';

/**
 * Register write for a deployment or exchange, keyed on the device serial.
 *
 * customer_device_records holds at most one row per serial (the partial
 * unique index uq_customer_device_device_serial), so a serial the register has
 * seen before can never be INSERTed again: re-renting a collected ONU has to
 * re-activate its existing row, or the insert fails and rolls back the whole
 * deployment transaction — stock deduction, ledger row and serial flip
 * included. An ACTIVE row means the register already tracks that unit out with
 * a customer, so nothing is written.
 */
/** Human branch label for serial-gate refusals (falls back to the id). */
function branchLabelFor(branchId: string): string {
  return branches.find((b) => b.id === branchId)?.name || branchId;
}

async function registerCustomerDeviceRow(
  client: any,
  row: CustomerDeviceRecord
): Promise<'INSERTED' | 'REACTIVATED' | 'ALREADY_ACTIVE'> {
  const existing = await client.query(CDR_SERIAL_ROW_SQL, [String(row.deviceSerial)]);
  if (!existing.rowCount) {
    await client.query(CDR_EXCHANGE_INSERT_SQL, customerDeviceInsertParams(row));
    return 'INSERTED';
  }
  if (isActiveCdrStatus(existing.rows[0]?.status)) return 'ALREADY_ACTIVE';
  await client.query(CDR_REDEPLOY_BY_SERIAL_SQL, cdrRedeployParams(row));
  return 'REACTIVATED';
}

/** Forwarded from inventory.routes.ts (get_stock). */
export async function get_stock(req: any, res: Response): Promise<any> {
const { branchId } = req.query;
  if (getPgConnected()) {
    try {
      const { sql, params } = buildStockListQuery(branchId);
      const r = await pgPool.query(sql, params);
      res.json(r.rows);
      return;
    } catch (err) {
      console.error('Error fetching stock from DB:', err);
    }
  }
  if (branchId && branchId !== 'ALL') {
    res.json(inventoryStock.filter((s) => s.branchId === branchId));
    return;
  }
  res.json(inventoryStock);

}

/** Forwarded from inventory.routes.ts (patch_Id). */
export async function patch_Id(req: any, res: Response): Promise<any> {
try {
    // C4: BS dates for ledger/audit rows come from the seeded bs_day_records
    // for "today", never from hardcoded strings.
    const todayBsForLedger = await resolveBsDateForLedger();
    const { id } = req.params;
    const { quantityOnHand, minReorderLevel, damagedQty, reason, changeType } = req.body;
    for (const [field, value] of Object.entries({ quantityOnHand, minReorderLevel, damagedQty })) {
      if (value !== undefined && (!Number.isInteger(Number(value)) || Number(value) < 0)) {
        res.status(400).json({ message: `${field} must be a non-negative integer.` });
        return;
      }
    }
    let stk = inventoryStock.find((s) => s.id === id);

    if (getPgConnected() && !stk) {
      const r = await pgPool.query(STOCK_FIND_BY_ID_SQL, [id]);
      if (r.rows.length > 0) stk = r.rows[0];
    }
    if (!stk) return res.status(404).json({ message: 'Stock record not found' });

    let qtyBefore = stk.quantityOnHand || 0;
    let oldDamaged = stk.damagedQty || 0;

    if (damagedQty !== undefined) {
      const newDam = Math.max(0, Number(damagedQty));
      const damDiff = newDam - oldDamaged;
      stk.damagedQty = newDam;

      if (quantityOnHand === undefined) {
        stk.quantityOnHand = Math.max(0, (stk.quantityOnHand || 0) - damDiff);
      } else {
        stk.quantityOnHand = Number(quantityOnHand);
      }
    } else if (quantityOnHand !== undefined) {
      stk.quantityOnHand = Number(quantityOnHand);
    }
    if (minReorderLevel !== undefined) {
      stk.minReorderLevel = Number(minReorderLevel);
    }
    stk.lastUpdated = new Date().toISOString();

    const prod = products.find((p) => p.id === stk.productId);

    if (getPgConnected()) {
      await pgPool.query(STOCK_UPSERT_LEVELS_SQL, stockUpsertLevelsParams(stk));
    }

    const isDamageChange = changeType === 'DAMAGE' || (damagedQty !== undefined && stk.damagedQty !== oldDamaged);

    if (isDamageChange) {
      const damDiff = (stk.damagedQty || 0) - oldDamaged;
      const newTxn = {
        id: `txn-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
        transactionNumber: `TXN-DMG-${Math.floor(10000 + Math.random() * 90000)}`,
        productId: stk.productId,
        productSku: prod?.sku || '',
        productName: prod?.name || '',
        branchId: stk.branchId,
        changeType: 'DAMAGE' as const,
        quantityBefore: oldDamaged,
        // Damaged-pool ledger: before + changed = after (pool semantics —
        // an increase in damaged units is negative, a decrease positive).
        quantityChanged: buildDamagePoolLedgerChange(oldDamaged, stk.damagedQty || 0).quantityChanged,
        quantityAfter: stk.damagedQty || 0,
        unitCost: prod?.costPrice || 0,
        referenceDocId: reason || 'DMG-VERIFICATION',
        timestampAD: new Date().toISOString(),
        timestampBS: todayBsForLedger,
      };
      setTransactionLogs(withPrepended(transactionLogs, newTxn));

      if (getPgConnected()) {
        await pgPool.query(TXN_INSERT_NOW_SQL, miscPulloutTxnParams(newTxn as TransactionLog));
      }
    }

    // Manual damage adjustments (PATCH /api/stock/:id with a damagedQty
    // delta) also create/update a damage_records lifecycle entry so the
    // damage register stays in sync with the stock level.
    if (damagedQty !== undefined && Number(damagedQty) !== oldDamaged) {
      const affectedQty = isDamageChange && Number(damagedQty) > oldDamaged
        ? Number(damagedQty) - oldDamaged
        : oldDamaged - Number(damagedQty);
      const absAffected = Math.abs(affectedQty || 0);
      if (absAffected > 0) {
        const todayAD = new Date().toISOString().split('T')[0];
        const damageRef = `DMR-ADJ-${stk.id}-${Date.now()}`;
        const damageRecordId = `dmr-adj-${stk.id}-${Date.now()}`;
        const knownReason = (reason || 'Damaged stock balance verification').toUpperCase();
        const damageReason = ['PHYSICAL_DAMAGE', 'TRANSIT_DAMAGE', 'STORAGE_DAMAGE', 'EXPIRED', 'RETURN_DAMAGE', 'QUALITY_DEFECT', 'OTHER'].find((r) => knownReason.includes(r)) || 'OTHER';
        try {
          if (getPgConnected()) {
            await pgPool.query(
              DAMAGE_RECORD_ADJUSTMENT_SQL,
              damageAdjustmentParams({
                id: damageRecordId,
                damageReference: damageRef,
                productId: stk.productId,
                branchId: stk.branchId,
                quantityDamaged: absAffected,
                unitCost: prod?.costPrice || 0,
                totalCost: (prod?.costPrice || 0) * absAffected,
                damageDateAD: todayAD,
                damageDateBS: todayBsForLedger,
                damageReason,
                approvedBy: getUserFromReq(req).name || 'Stock Manager',
                notes: reason || 'Damaged stock balance verification',
                createdBy: getUserFromReq(req).email || 'system',
              })
            );
          }
          const existingIdx = damageRecords.findIndex((dr) => dr.id === damageRecordId || dr.damageReference === damageRef);
          if (existingIdx >= 0) {
            setDamageRecords(withReplaced(damageRecords, existingIdx, {
              ...damageRecords[existingIdx],
              quantityDamaged: absAffected,
              status: 'IDENTIFIED',
              damageReason: damageReason as DamageRecord['damageReason'],
            }));
          } else {
            setDamageRecords(withPrepended(damageRecords, {
              id: damageRecordId,
              damageReference: damageRef,
              productId: stk.productId,
              branchId: stk.branchId,
              quantityDamaged: absAffected,
              unitCost: prod?.costPrice || 0,
              totalCost: (prod?.costPrice || 0) * absAffected,
              damageDateAD: todayAD,
              damageDateBS: todayBsForLedger,
              damageReason: damageReason as DamageRecord['damageReason'],
              status: 'IDENTIFIED',
              salvageValue: 0,
              glAccountCode: 'GL-5120 (Loss on Inventory Scrap & Write-off)',
              writeOffLoss: 0,
              approvedBy: getUserFromReq(req).name || 'Stock Manager',
              notes: reason || 'Damaged stock balance verification',
              isDemo: false,
              createdBy: getUserFromReq(req).email || 'system',
            } as DamageRecord));
          }
        } catch (drErr: any) {
          console.warn('Damage record sync notice:', drErr?.message || drErr);
        }
      }
    }

    if (!isDamageChange && quantityOnHand !== undefined && (stk.quantityOnHand - qtyBefore !== 0)) {
      const newTxn: TransactionLog = {
        id: `txn-${Date.now()}`,
        transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
        productId: stk.productId,
        productSku: prod?.sku || '',
        productName: prod?.name || '',
        branchId: stk.branchId,
        changeType: 'MANUAL_ADJUSTMENT' as const,
        quantityBefore: qtyBefore,
        quantityChanged: stk.quantityOnHand - qtyBefore,
        quantityAfter: stk.quantityOnHand,
        unitCost: prod?.costPrice || 0,
        referenceDocId: reason || 'STOCK_ADJUSTMENT',
        timestampAD: new Date().toISOString(),
        timestampBS: todayBsForLedger,
      };
      setTransactionLogs(withPrepended(transactionLogs, newTxn));

      if (getPgConnected()) {
        await pgPool.query(TXN_INSERT_NOW_SQL, miscPulloutTxnParams(newTxn as TransactionLog));
      }
    }
  } catch (err: any) {
    console.error('Error updating stock level:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from inventory.routes.ts (patch_reorderLevel). */
export async function patch_reorderLevel(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const { minReorderLevel, productId, branchId } = req.body;
    if (!Number.isInteger(Number(minReorderLevel)) || Number(minReorderLevel) < 0) {
      res.status(400).json({ message: 'Reorder level must be a non-negative integer.' });
      return;
    }
    let stk = inventoryStock.find((s) => s.id === id);

    if (!stk && (productId || req.body.productId) && (branchId || req.body.branchId)) {
      const pId = productId || req.body.productId;
      const bId = branchId || req.body.branchId;
      stk = inventoryStock.find((s) => s.productId === pId && s.branchId === bId);
    }

    if (!stk) {
      let pId = productId || req.body.productId;
      let bId = branchId || req.body.branchId;

      if (!pId || !bId) {
        const parts = id.split('-');
        if (parts.length >= 3) {
          if (products.some((p) => p.id === parts[1])) {
            pId = parts[1];
            bId = parts[2];
          } else if (branches.some((b) => b.id === parts[2])) {
            pId = parts[1];
            bId = parts[2];
          }
        }
      }

      if (!pId) pId = products[0]?.id;
      if (!bId) bId = branches[0]?.id;

      if (pId && bId) {
        stk = {
          id: id.startsWith('stk-') ? id : `stk-${bId.toLowerCase()}-${pId}`,
          productId: pId,
          branchId: bId,
          quantityOnHand: 0,
          damagedQty: 0,
          reservedQty: 0,
          incomingQty: 0,
          minReorderLevel: Number(minReorderLevel) || 5,
          lastUpdated: new Date().toISOString(),
        };
        setInventoryStock(withAppended(inventoryStock, stk));
      }
    }

    if (!stk) {
      res.status(404).json({ message: 'Stock record not found' });
      return;
    }

    stk.minReorderLevel = Number(minReorderLevel);
    stk.lastUpdated = new Date().toISOString();

    if (getPgConnected()) {
      await pgPool.query(STOCK_UPSERT_REORDER_SQL, stockUpsertReorderParams(stk));
    }
    broadcastChange({ type: 'STOCK_UPDATED', entity: 'stock', branchId: stk.branchId });
    res.json(stk);
  } catch (err: any) {
    console.error('Error setting reorder level:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from inventory.routes.ts (post_bulkReorderLevels). */
export async function post_bulkReorderLevels(req: any, res: Response): Promise<any> {
try {
    const { updates } = req.body;
    if (Array.isArray(updates)) {
      if (getPgConnected()) {
        await withTransaction(async (client) => {
          for (const u of updates) {
            let stk = inventoryStock.find((s) => s.id === u.stockId);
            if (!stk && u.productId && u.branchId) {
              stk = inventoryStock.find((s) => s.productId === u.productId && s.branchId === u.branchId);
            }
            if (!stk && u.productId && u.branchId) {
              stk = {
                id: u.stockId || `stk-${u.branchId.toLowerCase()}-${u.productId}`,
                productId: u.productId,
                branchId: u.branchId,
                quantityOnHand: 0,
                damagedQty: 0,
                reservedQty: 0,
                incomingQty: 0,
                minReorderLevel: Number(u.minReorderLevel),
                lastUpdated: new Date().toISOString(),
              };
              setInventoryStock(withAppended(inventoryStock, stk));
            }
            if (stk) {
              stk.minReorderLevel = Number(u.minReorderLevel);
              stk.lastUpdated = new Date().toISOString();

              await client.query(STOCK_UPSERT_REORDER_SQL, stockUpsertReorderParams(stk));
            }
          }

        });
      } else {
        for (const u of updates) {
          let stk = inventoryStock.find((s) => s.id === u.stockId);
          if (!stk && u.productId && u.branchId) {
            stk = inventoryStock.find((s) => s.productId === u.productId && s.branchId === u.branchId);
          }
          if (stk) {
            stk.minReorderLevel = Number(u.minReorderLevel);
            stk.lastUpdated = new Date().toISOString();
          }
        }
      }
      broadcastChange({ type: 'STOCK_UPDATED', entity: 'stock' });
    }
    res.json({ success: true, count: updates?.length || 0 });
  } catch (err: any) {
    console.error('Error bulk updating reorder levels:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from inventory.routes.ts (post_reconcileAudit). */
export async function post_reconcileAudit(req: any, res: Response): Promise<any> {
try {
    // C4: BS dates for audit ledger rows derive from bs_day_records.
    const auditBsDate = await resolveBsDateForLedger();
    const { branchId, auditRefNumber, varianceItems, auditorName, userEmail, notes } = req.body;
    if (!branchId || !Array.isArray(varianceItems)) {
      res.status(400).json({ message: 'Invalid stock reconciliation payload' });
      return;
    }

    let totalAdjusted = 0;
    let netFinancialImpact = 0;

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        for (const item of varianceItems) {
          let stk = inventoryStock.find(
            (s) => s.productId === item.productId && s.branchId === branchId
          );

          if (!stk) {
            stk = {
              id: `stk-${branchId.toLowerCase()}-${item.productId}`,
              productId: item.productId,
              branchId: branchId,
              quantityOnHand: 0,
              damagedQty: 0,
              reservedQty: 0,
              incomingQty: 0,
              lastUpdated: new Date().toISOString(),
            };
            setInventoryStock(withAppended(inventoryStock, stk));
          }

          const qtyBefore = stk.quantityOnHand || 0;
          const targetCounted = Number(item.countedQty) || 0;
          const delta = targetCounted - qtyBefore;
          const unitCost = item.unitCost || 0;

          stk.quantityOnHand = targetCounted;
          stk.lastUpdated = new Date().toISOString();
          totalAdjusted += 1;
          netFinancialImpact += delta * unitCost;

          const prod = products.find((p) => p.id === item.productId);

          await client.query(STOCK_RECONCILE_UPSERT_SQL, stockReconcileUpsertParams(stk));

          const newTxn: TransactionLog = {
            id: `txn-${Date.now()}-${item.productId}-aud`,
            transactionNumber: `TXN-AUD-${Math.floor(10000 + Math.random() * 90000)}`,
            productId: item.productId,
            productSku: prod?.sku || item.sku || '',
            productName: prod?.name || item.productName || '',
            branchId: branchId,
            changeType: (delta > 0 ? 'PHYSICAL_AUDIT_EXCESS' : 'PHYSICAL_AUDIT_SHORTAGE') as TransactionLog['changeType'],
            quantityBefore: qtyBefore,
            quantityChanged: delta,
            quantityAfter: stk.quantityOnHand,
            unitCost: unitCost || prod?.costPrice || 0,
            referenceDocId: auditRefNumber || `AUDIT-${Date.now()}`,
            timestampAD: new Date().toISOString(),
            timestampBS: auditBsDate,
          };
          setTransactionLogs(withPrepended(transactionLogs, newTxn));

          await client.query(TXN_INSERT_NOW_SQL, miscPulloutTxnParams(newTxn));

          // Physical audit reconciliation also records the damage lifecycle:
          // a negative shortage for a product that already has damaged stock
          // is reflected in the damage register so it shows up in the ledger.
          // Stock-wins semantics: the counted total is authoritative, so the
          // written-off units are ALSO removed from damaged_qty here — the
          // damage register (which records the same write-off quantity) and
          // inventory_stock stay consistent instead of double-counting the
          // shortage in the damaged pool.
          if (delta < 0 && Number(item.damagedQty ?? stk.damagedQty ?? 0) > 0) {
            const damageQtyRec = Number(item.damagedQty ?? stk.damagedQty ?? 0);
            const writtenOff = Math.min(damageQtyRec, Math.abs(delta));
            await client.query(
              DAMAGE_RECORD_AUDIT_SHORTAGE_SQL,
              damageAuditShortageParams({
                id: `dmr-audit-${auditRefNumber || 'AUD'}-${item.productId}`,
                damageReference: `AUDIT-${auditRefNumber || Date.now()}-${item.productId}`,
                productId: item.productId,
                branchId,
                quantityDamaged: writtenOff,
                unitCost: unitCost || prod?.costPrice || 0,
                totalCost: (unitCost || prod?.costPrice || 0) * writtenOff,
                damageDateAD: new Date().toISOString().split('T')[0],
                damageDateBS: auditBsDate,
                approvedBy: auditorName || userEmail || 'AUDITOR',
                notes: notes || `Physical audit shortage write-off (${auditRefNumber || 'DIRECT'})`,
                createdBy: userEmail || 'system',
              })
            );
            await client.query(
              STOCK_RECONCILE_DAMAGED_ADJUST_SQL,
              stockReconcileDamagedAdjustParams(writtenOff, item.productId, branchId)
            );
            stk.damagedQty = Math.max(0, (stk.damagedQty || 0) - writtenOff);
          }
        }
      });
    } else {
      // Demo mode: stock moved here too, but until now no PHYSICAL_AUDIT_*
      // rows were written, so the ledger silently missed every reconciliation
      // that ran without PG. Record them with the same real before/after the
      // PG path persists.
      const auditTxns: TransactionLog[] = [];
      for (const item of varianceItems) {
        let stk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === branchId);
        if (!stk) {
          const createdRow: any = {
            id: `stk-${branchId.toLowerCase()}-${item.productId}`,
            productId: item.productId,
            branchId: branchId,
            quantityOnHand: 0,
            damagedQty: 0,
            reservedQty: 0,
            incomingQty: 0,
            lastUpdated: new Date().toISOString(),
          };
          setInventoryStock(withAppended(inventoryStock, createdRow));
          stk = createdRow;
        }
        const auditedStk = stk as NonNullable<typeof stk>;
        const qtyBefore = auditedStk.quantityOnHand || 0;
        const targetCounted = Number(item.countedQty) || 0;
        const delta = targetCounted - qtyBefore;
        const unitCost = item.unitCost || 0;
        auditedStk.quantityOnHand = targetCounted;
        auditedStk.lastUpdated = new Date().toISOString();
        totalAdjusted += 1;
        netFinancialImpact += delta * unitCost;
        if (delta === 0) continue;
        const prod = products.find((p) => p.id === item.productId);
        auditTxns.push({
          id: `txn-${Date.now()}-${item.productId}-aud`,
          transactionNumber: `TXN-AUD-${Math.floor(10000 + Math.random() * 90000)}`,
          productId: item.productId,
          productSku: prod?.sku || item.sku || '',
          productName: prod?.name || item.productName || '',
          branchId: branchId,
          changeType: (delta > 0 ? 'PHYSICAL_AUDIT_EXCESS' : 'PHYSICAL_AUDIT_SHORTAGE') as TransactionLog['changeType'],
          quantityBefore: qtyBefore,
          quantityChanged: delta,
          quantityAfter: targetCounted,
          unitCost: unitCost || prod?.costPrice || 0,
          referenceDocId: auditRefNumber || `AUDIT-${Date.now()}`,
          timestampAD: new Date().toISOString(),
          timestampBS: auditBsDate,
        } as TransactionLog);
      }
      if (auditTxns.length > 0) setTransactionLogs([...auditTxns, ...transactionLogs]);
    }

    const branch = branches.find((b) => b.id === branchId);

    logAuditEvent(
      req,
      'STOCK_AUDIT_RECONCILED',
      'INVENTORY_AUDIT',
      `Directly Authorized & Reconciled Physical Stock Audit #${auditRefNumber || 'DIRECT'} for ${branch?.name || branchId}. Adjusted ${totalAdjusted} variance items to physical count. Net Financial Impact: NPR ${netFinancialImpact.toLocaleString()}. Notes: ${notes || 'Direct Stock Reconcile'}`,
      branchId
    );
    res.json({
      success: true,
      totalAdjusted,
      netFinancialImpact,
      message: `Physical stock reconciled successfully for ${branch?.name || branchId}`,
    });
  } catch (err: any) {
    console.error('Error reconciling stock audit:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from inventory.routes.ts (get_assets). */
/** Forwarded from inventory.routes.ts (post_assets). */
export async function post_assets(req: any, res: Response): Promise<any> {
try {
    const tagNum = req.body.tagNumber || req.body.assetTag || `AST-${Math.floor(1000 + Math.random() * 9000)}`;
    // C4: resolve the BS fallback from the AD date actually being stored.
    const newAssetAcquisitionAD = String(req.body.acquisitionDateAD || req.body.acquisitionDateAd || new Date().toISOString().split('T')[0]).split('T')[0];
    const newAsset = {
      id: req.body.id || `ast-${Date.now()}`,
      tagNumber: tagNum,
      name: req.body.name || 'Fixed Asset',
      category: req.body.category || 'Equipment',
      branchId: req.body.branchId || 'WH001',
      acquisitionDateAD: req.body.acquisitionDateAD || req.body.acquisitionDateAd || new Date().toISOString().split('T')[0],
      // C4: BS fallback derives from the actually-stored AD date.
      acquisitionDateBS: req.body.acquisitionDateBS || req.body.acquisitionDateBs || await resolveBsDateForLedger(newAssetAcquisitionAD),
      purchaseInvoiceDateAD: req.body.purchaseInvoiceDateAD || req.body.purchaseInvoiceDateAd || req.body.acquisitionDateAD || req.body.acquisitionDateAd || new Date().toISOString().split('T')[0],
      purchaseInvoiceDateBS: req.body.purchaseInvoiceDateBS || req.body.purchaseInvoiceDateBs || req.body.acquisitionDateBS || req.body.acquisitionDateBs || await resolveBsDateForLedger(newAssetAcquisitionAD),
      capitalizationDateAD: req.body.capitalizationDateAD || req.body.capitalizationDateAd || req.body.acquisitionDateAD || req.body.acquisitionDateAd || new Date().toISOString().split('T')[0],
      placedInServiceDateAD: req.body.placedInServiceDateAD || req.body.placedInServiceDateAd || req.body.acquisitionDateAD || req.body.acquisitionDateAd || new Date().toISOString().split('T')[0],
      acquisitionCost: Number(req.body.acquisitionCost) || 0,
      depreciationMethod: req.body.depreciationMethod || 'STRAIGHT_LINE',
      depreciationRatePercent: Number(req.body.depreciationRatePercent || req.body.depreciationRate) || 15,
      accumulatedDepreciation: 0,
      netBookValue: 0,
      status: req.body.status || 'ACTIVE',
      supplierName: req.body.supplierName || '',
      invoiceNo: req.body.invoiceNo || '',
      purchaseInvoiceId: req.body.purchaseInvoiceId || null,
      productId: req.body.productId || null,
      // Assignment metadata for assets created already-deployed (Assign Fixed
      // Asset flow creates serialized assets straight into POP/customer use).
      assignedType: req.body.assignedType || null,
      assignedCustomerId: req.body.assignedCustomerId || null,
      assignedCustomerName: req.body.assignedCustomerName || null,
      assignedLocationId: req.body.assignedLocationId || null,
      assignedLocationName: req.body.assignedLocationName || null,
      assignmentDateAD: req.body.assignmentDateAD || null,
      assignmentDateBS: req.body.assignmentDateBS || null,
      assignmentNotes: req.body.assignmentNotes || null,
      // Serial of the IN_STOCK unit consumed from branch stock (deploy-from-stock flow).
      deviceSerial: req.body.deviceSerial || null,
      // Optional device identity forwarded to the rental-CPE row this flow
      // now creates atomically (PON / MAC are CDR columns, not asset columns).
      devicePonSerial: req.body.devicePonSerial || null,
      deviceMacAddress: req.body.deviceMacAddress || null,
    };

    const linkedInvoice = newAsset.purchaseInvoiceId
      ? purchaseInvoices.find((invoice) => invoice.id === newAsset.purchaseInvoiceId)
      : undefined;
    if (linkedInvoice && !req.body.purchaseInvoiceDateAD && !req.body.purchaseInvoiceDateAd) {
      newAsset.purchaseInvoiceDateAD = linkedInvoice.invoiceDateAD;
      newAsset.purchaseInvoiceDateBS = linkedInvoice.invoiceDateBS;
    }

    // BS dates are mandatory on asset writes: derive any missing BS date
    // from bs_day_records for the asset's own AD dates; 400 when a calendar
    // day is unseeded (never persist empty, estimated, or hardcoded BS).
    if (!String(newAsset.acquisitionDateBS || '').trim()) {
      const acqBS = await bsDateOr400(res, newAsset.acquisitionDateAD);
      if (!acqBS) return;
      newAsset.acquisitionDateBS = acqBS;
    }
    if (newAsset.assignmentDateAD && !String(newAsset.assignmentDateBS || '').trim()) {
      const asnBS = await bsDateOr400(res, newAsset.assignmentDateAD);
      if (!asnBS) return;
      newAsset.assignmentDateBS = asnBS;
    }
    if (newAsset.purchaseInvoiceDateAD && !String(newAsset.purchaseInvoiceDateBS || '').trim()) {
      const piBS = await bsDateOr400(res, newAsset.purchaseInvoiceDateAD);
      if (!piBS) return;
      newAsset.purchaseInvoiceDateBS = piBS;
    }

    const computedValues = calculateFixedAssetValues({
      ...newAsset,
      acquisitionDateAD: newAsset.acquisitionDateAD,
    });
    newAsset.accumulatedDepreciation = computedValues.accumulatedDepreciation;
    newAsset.netBookValue = computedValues.netBookValue;
    // Deploy-from-stock deduction: an asset created straight into deployment
    // (ASSIGNED_TO_*) from a catalog product consumes one unit of that
    // product's quantity_on_hand at the fulfilling branch. This mirrors the
    // STOCK_OUT the legacy handleCreateAsset path posts, so the flag is opt-in
    // and the two paths can never double-deduct. Serialized units also flip
    // their serial_log row IN_STOCK → POP_LOCATION_ASSIGNED / CUSTOMER_ASSIGNED.
    const deployFromStock = req.body.deployFromStock === true &&
      ['ASSIGNED_TO_LOCATION', 'ASSIGNED_TO_CUSTOMER'].includes(String(newAsset.status)) &&
      Boolean(newAsset.productId);
    if (deployFromStock) {
      const qty = 1;
      const branchId = String(newAsset.branchId);
      const stockRecord = inventoryStock.find((entry) => entry.productId === newAsset.productId && entry.branchId === branchId);
      if (!stockRecord || Number(stockRecord.quantityOnHand) < qty) {
        res.status(400).json({ message: `Insufficient inventory for ${newAsset.name}. Available: ${stockRecord ? Number(stockRecord.quantityOnHand) : 0}, requested: ${qty}.` });
        return;
      }
      const product = products.find((entry) => entry.id === newAsset.productId);
      const txn = {
        id: `txn-asset-${newAsset.id}`,
        transactionNumber: `${newAsset.tagNumber}-1`,
        productId: newAsset.productId,
        productSku: product?.sku || '',
        productName: product?.name || newAsset.name,
        branchId,
        changeType: 'STOCK_OUT' as const,
        quantityBefore: Number(stockRecord.quantityOnHand),
        quantityChanged: -qty,
        quantityAfter: Math.max(0, Number(stockRecord.quantityOnHand) - qty),
        unitCost: Number(newAsset.acquisitionCost) || product?.costPrice || 0,
        referenceDocId: newAsset.tagNumber,
        timestampAD: String(newAsset.acquisitionDateAD).split('T')[0],
        timestampBS: newAsset.acquisitionDateBS,
      };

      if (getPgConnected()) {
        await withTransaction(async (client) => {
          // C3 pattern: lock the stock row and re-verify availability from
          // database truth before writing (mirror pre-flight can race).
          const locked = await client.query(
            STOCK_LOCK_FOR_UPDATE_SQL,
            stockLockForUpdateParams([{ productId: newAsset.productId }], branchId)
          );
          const row = (locked.rows || [])[0] as LockedStockRow | undefined;
          if (!row || Number(row.quantity_on_hand) < qty) {
            throw new OperationError(400, `Insufficient inventory for ${newAsset.name}. Available: ${row ? Number(row.quantity_on_hand) : 0}, requested: ${qty}.`);
          }
          const result = await client.query(STOCK_CONSUME_QOH_SQL, [qty, newAsset.productId, branchId]);
          if (result.rowCount !== 1) {
            throw new Error(`Stock changed before this asset could be registered. Please retry.`);
          }
          await client.query(TXN_INSERT_ON_CONFLICT_SQL, txnInsertOnConflictParams(txn));

          // Slice 2: the SHARED gate resolves the unit before any of it moves.
          // This used to be a bare lookup whose `if (rowCount)` silently
          // skipped the register flip when the serial was absent — so a unit
          // that was never received, or one already sold / in transit /
          // damaged / held elsewhere, could be deployed against branch stock
          // anyway, and the register quietly disagreed with the ledger. Now an
          // unresolvable serial refuses the whole request with the register's
          // own reason.
          //
          // MAC is deliberately not matched yet: the Assign Fixed Asset panel
          // still pre-fills a placeholder MAC (removed in Slice 4), so matching
          // it here would refuse genuine deployments.
          if (newAsset.deviceSerial) {
            await resolveSerialGateInDb(
              client,
              [{
                deviceSerial: String(newAsset.deviceSerial),
                ponSerial: String(newAsset.devicePonSerial || ''),
                macAddress: '',
                productId: String(newAsset.productId || ''),
                productName: String(newAsset.name || ''),
              }],
              { branchId: String(newAsset.branchId), branchLabel: branchLabelFor(String(newAsset.branchId)), matchProduct: true, matchMac: false },
              { action: 'deployed' }
            );
            const histRes = await client.query(
              SERIAL_LOG_FIND_IN_STOCK_BY_SERIAL_SQL,
              [String(newAsset.deviceSerial)]
            );
            if (histRes.rowCount) {
              let hist: any[] = [];
              try {
                hist = typeof histRes.rows[0].history_json === 'string'
                  ? JSON.parse(histRes.rows[0].history_json || '[]')
                  : histRes.rows[0].history_json || [];
              } catch {
                hist = [];
              }
              hist.push({
                status: newAsset.status,
                sourceType: 'FIXED_ASSET',
                sourceId: newAsset.id,
                dateAD: newAsset.acquisitionDateAD,
                notes: `Deployed as fixed asset ${newAsset.tagNumber}`,
              });
              await client.query(
                SERIAL_LOG_ASSIGN_ON_DEPLOY_SQL,
                [newAsset.status === 'ASSIGNED_TO_CUSTOMER' ? 'CUSTOMER_ASSIGNED' : 'POP_LOCATION_ASSIGNED', newAsset.id, JSON.stringify(hist), new Date().toISOString(), histRes.rows[0].id,
                 newAsset.status === 'ASSIGNED_TO_CUSTOMER' ? (newAsset.assignedCustomerId || null) : null,
                 newAsset.status === 'ASSIGNED_TO_CUSTOMER' ? (newAsset.assignedCustomerName || null) : null]
              );
            }
          }

          // Rental-CPE row, same transaction as the deploy (drift guard):
          // the Assign Fixed Asset panel used to fire a SECOND request
          // (createCustomerDevice) after this one committed — if it failed
          // or raced, serial_log said CUSTOMER_ASSIGNED while the Customer
          // Device Serials directory had no row. One transaction = the two
          // registers cannot disagree.
          if (newAsset.status === 'ASSIGNED_TO_CUSTOMER' && newAsset.deviceSerial) {
            {
              const custMeta = await client.query(CUSTOMER_FOR_CDR_INSERT_SQL, [newAsset.assignedCustomerId || '']);
              const cust = (custMeta.rows || [])[0];
              const issuedAD = String(newAsset.assignmentDateAD || newAsset.acquisitionDateAD).split('T')[0];
              const cdrRow: CustomerDeviceRecord = {
                id: `cdr-asset-${newAsset.id}`,
                customerId: newAsset.assignedCustomerId || undefined,
                // The customer master is authoritative for the name: the panel's
                // label carries the code too ("Example Customer 2 (CUS-10292)").
                customerName: cust?.customer_name || newAsset.assignedCustomerName || 'Unknown Customer',
                customerCode: cust?.customer_id || newAsset.assignedCustomerId || 'N/A',
                contactPhone: cust?.contact_number || '',
                installationAddress: cust?.address || '',
                branchId: newAsset.branchId,
                productName: newAsset.name,
                deviceSerial: newAsset.deviceSerial,
                ponSerial: newAsset.devicePonSerial || String(newAsset.deviceSerial),
                macAddress: newAsset.deviceMacAddress || undefined,
                status: 'RENTAL',
                issuedDateAD: issuedAD,
                issuedDateBS: newAsset.assignmentDateBS || newAsset.acquisitionDateBS,
                purchaseBillRef: undefined,
                // Tag-stamped notes: the unassign reversal closes this row via
                // cpeFindPatterns(asset.tagNumber) — keep the marker intact.
                notes: `[RENTAL CPE ASSET - Tag: ${newAsset.tagNumber}]${newAsset.assignmentNotes ? ' ' + newAsset.assignmentNotes : ''}`,
              };
              await registerCustomerDeviceRow(client, cdrRow);
            }
          }
        });
      }

      // In-memory mirrors so the UI reflects the deduction immediately.
      stockRecord.quantityOnHand -= qty;
      stockRecord.lastUpdated = new Date().toISOString();
      setTransactionLogs([txn as any, ...transactionLogs]);
      // PG-down demo mode only: flip the mirror serial directly. With PG
      // connected, SERIAL_LOG_ASSIGN_ON_DEPLOY_SQL already ran inside the
      // write transaction above and cacheRefreshHook re-derives serialLogs
      // from PG truth before the response is sent (mirror step 4).
      if (newAsset.deviceSerial && !getPgConnected()) {
        const sl = serialLogs.find((e) => String(e.deviceSerial || '').trim().toLowerCase() === String(newAsset.deviceSerial).trim().toLowerCase() && e.status === 'IN_STOCK');
        // Slice 2 (demo mode: PostgreSQL down): the SAME gate rule against the
        // in-memory register, so this path refuses exactly what the database
        // path refuses instead of silently skipping an unknown serial. Runs
        // before any mirror mutation below.
        resolveSerialGateInMemory(
          serialLogs,
          [{
            deviceSerial: String(newAsset.deviceSerial),
            ponSerial: String(newAsset.devicePonSerial || ''),
            macAddress: '',
            productId: String(newAsset.productId || ''),
            productName: String(newAsset.name || ''),
          }],
          { branchId: String(newAsset.branchId), branchLabel: branchLabelFor(String(newAsset.branchId)), matchProduct: true, matchMac: false },
          { action: 'deployed' }
        );
        if (sl) {
          sl.status = newAsset.status === 'ASSIGNED_TO_CUSTOMER' ? 'CUSTOMER_ASSIGNED' : 'POP_LOCATION_ASSIGNED';
          sl.sourceType = 'FIXED_ASSET';
          sl.sourceId = newAsset.id;
          if (newAsset.status === 'ASSIGNED_TO_CUSTOMER') {
            sl.customerId = newAsset.assignedCustomerId || undefined;
            sl.customerName = newAsset.assignedCustomerName || undefined;
          }
          sl.updatedAt = new Date().toISOString();
        }
        // Demo-mode twin of the transactional rental-CPE write above.
        if (newAsset.status === 'ASSIGNED_TO_CUSTOMER') {
          {
            const custObj = customerMasterRecords.find((c) => c.id === newAsset.assignedCustomerId || c.customerId === newAsset.assignedCustomerId);
            const cdrRow: CustomerDeviceRecord = {
              id: `cdr-asset-${newAsset.id}`,
              customerId: newAsset.assignedCustomerId || undefined,
              customerName: custObj?.customerName || newAsset.assignedCustomerName || 'Unknown Customer',
              customerCode: custObj?.customerId || newAsset.assignedCustomerId || 'N/A',
              contactPhone: custObj?.contactNumber || '',
              installationAddress: custObj?.address || '',
              branchId: newAsset.branchId,
              productName: newAsset.name,
              deviceSerial: newAsset.deviceSerial,
              ponSerial: newAsset.devicePonSerial || String(newAsset.deviceSerial),
              macAddress: newAsset.deviceMacAddress || undefined,
              status: 'RENTAL',
              issuedDateAD: String(newAsset.assignmentDateAD || newAsset.acquisitionDateAD).split('T')[0],
              issuedDateBS: newAsset.assignmentDateBS || newAsset.acquisitionDateBS,
              purchaseBillRef: undefined,
              notes: `[RENTAL CPE ASSET - Tag: ${newAsset.tagNumber}]${newAsset.assignmentNotes ? ' ' + newAsset.assignmentNotes : ''}`,
            };
            setCustomerDeviceRecords(upsertCdrMirror(customerDeviceRecords, cdrRow).rows);
          }
        }
      }
    }

    // The in-memory register write happens only AFTER the deploy transaction
    // committed (and after the demo-mode path completed): a deploy the serial
    // gate refuses must not leave a phantom asset behind in the register.
    const idx = assetRegister.findIndex((a) => a.id === newAsset.id);
    setAssetRegister(idx >= 0 ? withReplaced(assetRegister, idx, newAsset as any) : withPrepended(assetRegister, newAsset as any));

    if (getPgConnected()) {
      await pgPool.query(ASSET_UPSERT_SQL, assetUpsertParams(newAsset));
    }
    logAuditEvent(req, 'ASSIGN_FIXED_ASSET', 'FIXED_ASSETS', `Assigned / Registered Fixed Asset Tag #${newAsset.tagNumber} (${newAsset.name}) at branch ${newAsset.branchId}${deployFromStock ? ` — deducted ${1} unit of ${newAsset.productId} from branch stock` : ''}`);
    res.status(201).json(newAsset);
  } catch (err: any) {
    // A serial the register does not know (or has already moved on) is a
    // caller error: report the register's own reason instead of a 500.
    if (err instanceof SerialGateError) {
      res.status(err.status).json({ message: err.message });
      return;
    }
    console.error('Error creating fixed asset:', err);
    const mapped = errorResponse(err);
    res.status(mapped.status).json({ message: mapped.message });
  }

}

/** Forwarded from inventory.routes.ts (patch_status). */
export async function patch_status(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const asset = assetRegister.find((a) => a.id === id);
    const prevStatus = asset ? String(asset.status || '') : '';
    if (asset) Object.assign(asset, req.body);

    // Unassign restock: a deploy-from-stock asset (catalog product created
    // straight into deployment, proven by its STOCK_OUT ledger row) returns
    // one unit to branch stock and its serial back to IN_STOCK. Guarded by
    // the ledger row so non-stock assets (already-registered in the ledger)
    // and duplicate unassign calls never double-restore.
    const isUnassign = String(req.body?.status || '') === 'ACTIVE' &&
      ['ASSIGNED_TO_LOCATION', 'ASSIGNED_TO_CUSTOMER'].includes(prevStatus);
    if (isUnassign && asset?.productId) {
      const branchId = String(asset.branchId);
      if (shouldRestockOnUnassign({ newStatus: req.body?.status, prevStatus, asset, transactionLogs })) {
        const stockRecord = inventoryStock.find((entry) => entry.productId === asset.productId && entry.branchId === branchId);
        const quantityBefore = Number(stockRecord?.quantityOnHand) || 0;
        const restockTxn = buildRestockTransaction({ asset, branchId, quantityBefore, todayAD: new Date().toISOString().split('T')[0], products });

        if (getPgConnected()) {
          await withTransaction(async (client) => {
            await client.query(STOCK_RETURN_FROM_ASSET_SQL, [asset.productId, branchId, 1, `stk-${asset.productId}-${branchId}`]);
            await client.query(TXN_INSERT_ON_CONFLICT_SQL, txnInsertOnConflictParams(restockTxn));
            // Flip the unit's serial back to IN_STOCK at the branch.
            if (asset.deviceSerial) {
              await client.query(
                SERIAL_LOG_RESTORE_ON_UNASSIGN_SQL,
                [asset.id, new Date().toISOString(), String(asset.deviceSerial)]
              );
            }

            // Close the rental-CPE customer_device_records row the deployment
            // created (joined via the asset tag stamped in its notes) so the
            // customer device register never shows an active rental for a
            // reversed deployment. Atomic with the stock restore.
            let cpeId: string | undefined;
            for (const pattern of cpeFindPatterns(asset.tagNumber)) {
              const cpeRes = await client.query(CDR_FIND_ACTIVE_BY_ASSET_TAG_SQL, [pattern]);
              const row = (cpeRes.rows || [])[0];
              if (row?.id) { cpeId = row.id; break; }
            }
            if (cpeId) {
              const cpeNotesRes = await client.query(CDR_NOTES_BY_ID_SQL, [cpeId]);
              const close = buildCpeReversalClose({
                prevNotes: String(cpeNotesRes.rows?.[0]?.notes || ''),
                tag: asset.tagNumber,
                todayAD: new Date().toISOString().split('T')[0],
              });
              await client.query(CDR_CLOSE_ON_ASSET_REVERSAL_SQL, [close.status, close.notes, cpeId]);
            }
          });
        }

        // In-memory mirrors so the UI reflects the restoration immediately.
        if (stockRecord) {
          stockRecord.quantityOnHand += 1;
          stockRecord.lastUpdated = new Date().toISOString();
        }
        setTransactionLogs([restockTxn as any, ...transactionLogs]);
        // PG-down demo mode only: with PG connected,
        // SERIAL_LOG_RESTORE_ON_UNASSIGN_SQL above already restored the serial
        // in the transaction and cacheRefreshHook re-derives the mirror.
        if (!getPgConnected()) restoreInMemorySerial(serialLogs, asset);
        logAuditEvent(req, 'UNASSIGN_FIXED_ASSET', 'FIXED_ASSETS', `Unassigned Fixed Asset Tag #${asset.tagNumber} — restored 1 unit of ${asset.productId} to branch ${branchId} stock`);
      }
    }

    if (getPgConnected()) {
      // Persist the full assignment payload, not just status: the Assign
      // Fixed Asset flow sends assignedType/customer/location and dates, and
      // clearing any of them (unassign) must also reach the database.
      const b = req.body || {};
      await pgPool.query(ASSET_SET_ASSIGNMENT_SQL, [
        b.status || 'ACTIVE',
        b.assignedType || null,
        b.assignedCustomerId || null,
        b.assignedCustomerName || null,
        b.assignedLocationId || null,
        b.assignedLocationName || null,
        b.assignmentDateAD || null,
        b.assignmentDateBS || null,
        b.assignmentNotes || null,
        id,
      ]);
    }
    logAuditEvent(req, 'UPDATE_ASSET_STATUS', 'FIXED_ASSETS', `Updated Fixed Asset status to ${req.body.status || 'UPDATED'}`);
    res.json(asset || req.body);
  } catch (err: any) {
    console.error('Error updating asset status:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from inventory.routes.ts (get_stockOperations). */
export async function get_stockOperations(req: any, res: Response): Promise<any> {
const { branchId, type, status, query, dateFromAD, dateToAD, page, pageSize, all } = req.query;
  // Paged mode: ?page=N (with optional pageSize) returns an envelope with the
  // page slice, the filtered total, and per-status counts. ?all=1 returns
  // every filtered row (CSV export). No page param keeps the legacy
  // full-array shape for existing callers (bootstrap consumers, damage
  // tracking).
  const wantsPaged = page !== undefined || pageSize !== undefined || all === '1';
  // Mirror step 3: when PG is up the list is ALWAYS read live — even the
  // unfiltered legacy shape (previously it served the mirror while the paged
  // path read PG). The mirror below is demo mode / PG-down fallback only.
  if (getPgConnected()) {
    try {
      const opts = { branchId, type, status, query, dateFromAD, dateToAD };
      if (wantsPaged) {
        const n = Math.max(1, Number(page) || 1);
        const size = Math.max(1, Math.min(500, Number(pageSize) || 50));
        const countR = await pgPool.query(buildStockOperationCountQuery(opts).sql, buildStockOperationCountQuery(opts).params);
        const totalItems = Number(countR.rows[0]?.count || 0);
        const statusQ = buildStockOperationStatusCountQuery(opts);
        const statusR = await pgPool.query(statusQ.sql, statusQ.params);
        const statusCounts: Record<string, number> = {};
        for (const row of statusR.rows) statusCounts[String(row.status)] = Number(row.count);
        const listQ = buildStockOperationPagedQuery(opts, all === '1' ? undefined : { page: n, pageSize: size });
        const r = await pgPool.query(listQ.sql, listQ.params);
        return res.json({
          data: r.rows,
          page: all === '1' ? 1 : n,
          pageSize: all === '1' ? totalItems : size,
          totalItems,
          statusCounts,
        });
      }
      const { sql: q, params } = buildStockOperationPagedQuery(opts);
      const r = await pgPool.query(q, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching stock ops from DB:', err);
    }
  }
  if (branchId && branchId !== 'ALL') {
    return res.json(
      stockOperations.filter((op) => op.branchId === branchId || op.destinationWarehouseId === branchId)
    );
  }
  res.json(stockOperations);

}

/** Forwarded from inventory.routes.ts (post_stockOperations). */
export async function post_stockOperations(req: any, res: Response): Promise<any> {
try {
    const opType = req.body.type || 'DAMAGE';
    const branchObj = branches.find((b) => b.id === req.body.branchId);
    const destWarehouseObj = branches.find((b) => b.id === (req.body.destinationWarehouseId || 'WH001'));
    const items = req.body.items || [];
    // MANUAL_ADJUSTMENT carries a SIGNED quantity (negative draws stock,
    // positive credits it); every other type draws stock and keeps the legacy
    // absolute fallback for the single-item request shape.
    const manualDeltaOf = (item: any): number =>
      opType === 'MANUAL_ADJUSTMENT' ? Number(item.quantity) || 0 : 0;
    const usesDamagedPool = (item: any): boolean =>
      opType === 'DISPOSAL' || item.condition === 'DAMAGED_STOCK';
    const operationItems = items.length > 0
      ? items
      : req.body.productId
      ? [{ productId: req.body.productId, productName: req.body.productName || '', quantity: opType === 'MANUAL_ADJUSTMENT' ? (Number(req.body.quantityChanged) || 0) : Math.abs(Number(req.body.quantityChanged) || 0), deviceSerials: req.body.deviceSerials || [] }]
      : [];
    // DISPOSAL writes units off the damaged pool and MANUAL_ADJUSTMENT can
    // credit stock — both move inventory, so both join the drawing types in
    // the lock + guarded-apply path (stock-movement audit).
    const stockConsumingType = ['DAMAGE', 'PULLOUT', 'STOCK_OUT', 'CONSUMABLE_ISSUE', 'DISPOSAL', 'MANUAL_ADJUSTMENT'].includes(opType);
    // Serial/PON register checks only apply to operations that DRAW serialized
    // units out of stock; disposals draw quarantined units and manual credits
    // have no serials to match against the IN_STOCK register.
    const serialValidatedType = ['DAMAGE', 'PULLOUT', 'STOCK_OUT', 'CONSUMABLE_ISSUE'].includes(opType);
    if (stockConsumingType) {
      for (const item of operationItems) {
        const product = products.find((entry) => entry.id === item.productId);
        const stockRecord = inventoryStock.find((entry) => entry.productId === item.productId && entry.branchId === req.body.branchId);
        const manualDelta = manualDeltaOf(item);
        const quantity = opType === 'MANUAL_ADJUSTMENT' ? Math.abs(manualDelta) : Number(item.quantity) || 0;
        const availableQuantity = usesDamagedPool(item)
          ? Number(stockRecord?.damagedQty) || 0
          : Number(stockRecord?.quantityOnHand) || 0;
        if (opType === 'MANUAL_ADJUSTMENT' && manualDelta === 0) {
          continue; // zero-delta adjustment: no stock movement to verify
        }
        if (opType === 'MANUAL_ADJUSTMENT' && manualDelta > 0) {
          if (quantity < 1) {
            res.status(400).json({ message: `Invalid adjustment quantity for ${item.productName || item.productId}.` });
            return;
          }
        } else if (!stockRecord || quantity < 1 || availableQuantity < quantity) {
          res.status(400).json({ message: `Insufficient inventory for ${item.productName || item.productId}. Available: ${availableQuantity}, requested: ${quantity}.` });
          return;
        }
        const isSerialized = serialValidatedType && (product ? product.requiresSerialTracking !== false && product.trackingType !== 'QUANTITY_ONLY' : true);
        if (isSerialized) {
          const serialEntries = item.deviceSerials || [];
          if (serialEntries.length < quantity) {
            res.status(400).json({ message: `Serial/PON details are required for every unit of ${item.productName || item.productId}.` });
            return;
          }
          // Slice 2: the RESOLUTION used to happen here against
          // `customerDeviceRecords` — an in-memory mirror, read outside the
          // transaction, that no longer carries stock units at all (the
          // register does). The shared gate below resolves each serial against
          // `serial_log` under the operation's own lock instead, so a stale
          // mirror can no longer accept or refuse a unit. Only the cheap shape
          // gate stays here; it needs no database.
        }
      }
    }
    // C1: totalValue is ALWAYS recomputed server-side from quantities and
    // resolved unit costs — a client-supplied per-item totalValue is ignored.
    // The unit-cost fallback chain matches the movement ledger below.
    let totalValue = 0;
    if (items.length > 0) {
      totalValue = computeOperationTotalValue(items, (it: any) => {
        const product = products.find((entry) => entry.id === it.productId);
        return Number(it.unitCost ?? it.costPerUnit ?? req.body.costPerUnit) || product?.costPrice || 0;
      });
    } else if (req.body.quantityChanged && req.body.costPerUnit) {
      totalValue = computeLegacyOperationTotalValue(req.body.quantityChanged, req.body.costPerUnit);
    }

    // BS calendar gate: a stock operation may only be posted when its date has
    // a seeded BS day record in bs_day_records (Nepali date is mandatory).
    const rawOpDateAD = req.body.dateAD || req.body.dateAd;
    const opDateMismatch = detectDateTypeMismatch(rawOpDateAD, 'dateAD');
    if (opDateMismatch) {
      res.status(400).json({ message: opDateMismatch, dateTypeMismatch: true });
      return;
    }
    const opDateAD = String(rawOpDateAD || new Date().toISOString().split('T')[0]).split('T')[0];
    // Shared derive-or-400 resolver: the refusal carries bsDateReason +
    // calendarCoverage so the client can offer the seeding screen.
    const opDateBS = await bsDateOr400(res, opDateAD);
    if (!opDateBS) return;

    const opBranchId = req.body.branchId || 'WH001';
    // Map operation type to document type code for numbering:
    // DAMAGE → DMG, PULLOUT → PLT, STOCK_OUT → SALE, CONSUMABLE_ISSUE → CON,
    // MANUAL_ADJUSTMENT → SA, others → their first 4 letters.
    const opTypeDocMap: Record<string, string> = {
      DAMAGE: 'DMG',
      PULLOUT: 'PLT',
      STOCK_OUT: 'SALE',
      CONSUMABLE_ISSUE: 'CON',
      MANUAL_ADJUSTMENT: 'SA',
      DISPOSAL: 'DSP',
    };
    const docType = opTypeDocMap[opType] || opType.slice(0, 4).toUpperCase();
    const newOp = {
      ...req.body,
      id: req.body.id || `op-${Date.now()}`,
      referenceNumber: req.body.referenceNumber || (await issueNextDocNumber(opBranchId, docType, opDateAD)),
      // Date integrity: the AD date stays in the AD column, and the BS date is
      // ALWAYS derived from the seeded bs_day_records DB record for that AD
      // date. A client-supplied dateBS can never override it (prevents
      // BS-in-AD / AD-in-BS mismatches from reaching the database).
      dateAD: opDateAD,
      dateBS: opDateBS,
      totalValue,
      fiscalYear: req.body.fiscalYear || getFiscalYearCodeForDate(opDateAD),
      branchName: branchObj?.name || req.body.branchName || 'Branch',
      destinationWarehouseId: destWarehouseObj?.id || req.body.destinationWarehouseId || 'WH001',
      destinationWarehouseName: destWarehouseObj?.name || req.body.destinationWarehouseName || 'Headquarters Warehouse',
      status: req.body.status || (opType === 'PULLOUT' ? 'DISPATCHED' : 'LOGGED'),
    };

    // Slice 2: plan the units this operation draws and resolve them through the
    // ONE shared gate — under the transaction's own row lock below, so the
    // unit cannot change between "is it ours?" and "consume it". A refusal
    // names the register's own reason and the operation posts nothing.
    const serialGatePlan = serialValidatedType
      ? planSerialGateEntries(operationItems as Array<Record<string, any>>, products as any[])
      : { entries: [], error: null as string | null };
    if (serialGatePlan.error) {
      res.status(400).json({ message: serialGatePlan.error });
      return;
    }
    const gateAction = opType === 'DAMAGE'
      ? 'marked damaged'
      : opType === 'PULLOUT'
        ? 'pulled out'
        : opType === 'STOCK_OUT'
          ? 'sold'
          : 'issued';
    const gateRules = {
      branchId: String(newOp.branchId || opBranchId),
      branchLabel: branchLabelFor(String(newOp.branchId || opBranchId)),
      matchProduct: true,
      // A PON the operator typed is always checked against the register; a
      // blank one is not demanded here, because PON is mandatory only for
      // SERIAL_MAC_PON products.
      matchPonWhenProvided: true,
      matchMac: false,
    };

    // Keep the movement ledger authoritative for stock operations as well as
    // purchase invoices and transfers. Pullouts from damaged stock do not
    // change available quantity_on_hand, so they are intentionally excluded
    // from this quantity ledger — as are zero-delta manual adjustments (no
    // movement happened). DISPOSAL rows carry the DAMAGED pool before/after
    // (quantity_on_hand never held those units); every other row is
    // quantity_on_hand semantics with before + changed = after.
    const operationTransactions: TransactionLog[] = operationItems
      .filter((item: any) => !(opType === 'PULLOUT' && item.condition === 'DAMAGED_STOCK'))
      .filter((item: any) => !(opType === 'MANUAL_ADJUSTMENT' && (Number(item.quantity) || 0) === 0))
      .map((item: any, index: number) => {
        const stockRecord = inventoryStock.find(
          (entry) => entry.productId === item.productId && entry.branchId === newOp.branchId
        );
        const product = products.find((entry) => entry.id === item.productId);
        const quantity = Number(item.quantity) || 1;
        const manualDelta = manualDeltaOf(item);
        const quantityBefore = opType === 'DISPOSAL'
          ? Number(stockRecord?.damagedQty) || 0
          : Number(stockRecord?.quantityOnHand) || 0;
        // DAMAGE ops move units from usable to damaged (still consuming
        // quantity_on_hand); PULLOUT / STOCK_OUT / CONSUMABLE_ISSUE consume
        // quantity_on_hand; DISPOSAL shrinks the damaged pool only;
        // MANUAL_ADJUSTMENT applies its signed quantity verbatim.
        const quantityChanged = opType === 'DISPOSAL'
          ? -Math.abs(quantity)
          : opType === 'MANUAL_ADJUSTMENT'
            ? manualDelta
            : -(opType === 'DAMAGE' ? quantity : Math.abs(quantity));
        const quantityAfter = opType === 'DISPOSAL'
          ? Math.max(0, quantityBefore - Math.abs(quantity))
          : opType === 'MANUAL_ADJUSTMENT'
            ? Math.max(0, quantityBefore + manualDelta)
            : Math.max(0, quantityBefore - quantity);
        return {
          id: `txn-${newOp.id}-${item.productId}-${index}`,
          transactionNumber: `${newOp.referenceNumber}-${index + 1}`,
          productId: item.productId,
          productSku: product?.sku || item.sku || '',
          productName: product?.name || item.productName || 'Product',
          branchId: newOp.branchId,
          changeType: (opType === 'DAMAGE' ? 'DAMAGE' : opType) as TransactionLog['changeType'],
          quantityBefore,
          quantityChanged,
          quantityAfter,
          unitCost: Number(item.unitCost ?? item.costPerUnit ?? newOp.costPerUnit) || product?.costPrice || 0,
          referenceDocId: newOp.referenceNumber,
          timestampAD: new Date(`${newOp.dateAD}T00:00:00.000Z`).toISOString(),
          timestampBS: newOp.dateBS,
        };
      });

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        // C3 (mirror step 4): lock the affected inventory_stock rows and
        // re-verify availability from DATABASE truth before writing. The
        // mirror pre-flight above can race concurrent writers; from here on
        // the locked rows cannot change until commit. Serializing on
        // product_id keeps the lock order deterministic (no deadlocks).
        if (stockConsumingType) {
          const locked = await client.query(
            STOCK_LOCK_FOR_UPDATE_SQL,
            stockLockForUpdateParams(operationItems as Array<{ productId: string }>, newOp.branchId)
          );
          const lockedMap = new Map<string, LockedStockRow>(
            (locked.rows || []).map((r: LockedStockRow) => [r.product_id, r])
          );
          // Rebuild each ledger row's before/after from the LOCKED DB truth:
          // the mirror the rows were drafted from can be stale, and an
          // inaccurate quantity_before/after would break the ledger's
          // before + changed = after invariant for concurrent movements.
          for (const txn of operationTransactions) {
            const row = lockedMap.get(txn.productId);
            if (!row) continue; // credit creates the row; mirror 0 is correct
            const before = opType === 'DISPOSAL'
              ? Number(row.damaged_qty) || 0
              : Number(row.quantity_on_hand) || 0;
            txn.quantityBefore = before;
            txn.quantityAfter = Math.max(0, before + txn.quantityChanged);
          }
          // Availability is aggregated PER PRODUCT (and pool): two lines of the
          // same product must not each fit inside the same locked balance. The
          // refusal is an OperationError so the client sees a 400 with the
          // numbers instead of a generic 500.
          const requestedUsable = new Map<string, { qty: number; name: string }>();
          const requestedDamaged = new Map<string, { qty: number; name: string }>();
          for (const item of operationItems) {
            const manualDelta = manualDeltaOf(item);
            if (opType === 'MANUAL_ADJUSTMENT' && manualDelta >= 0) continue; // credit needs no existing row
            const quantity = opType === 'MANUAL_ADJUSTMENT' ? -manualDelta : Number(item.quantity) || 0;
            const bag = usesDamagedPool(item) ? requestedDamaged : requestedUsable;
            const entry = bag.get(item.productId) || { qty: 0, name: String(item.productName || item.productId) };
            entry.qty += quantity;
            bag.set(item.productId, entry);
          }
          for (const [productId, requested] of requestedDamaged) {
            const row = lockedMap.get(productId);
            const available = row ? Number(row.damaged_qty) || 0 : 0;
            if (available < requested.qty) {
              throw new OperationError(400, `Insufficient damaged stock for ${requested.name}. Available: ${available}, requested: ${requested.qty}.`);
            }
          }
          for (const [productId, requested] of requestedUsable) {
            const row = lockedMap.get(productId);
            const available = row ? Number(row.quantity_on_hand) || 0 : 0;
            if (available < requested.qty) {
              throw new OperationError(400, `Insufficient inventory for ${requested.name}. Available: ${available}, requested: ${requested.qty}.`);
            }
          }
        }

        // Slice 2: resolve every unit this operation consumes against the
        // register, inside the same transaction that moves the stock. Locks the
        // register rows, so a serial sold/assigned/damaged since the mirror was
        // read is refused here rather than consumed twice.
        await resolveSerialGateInDb(client, serialGatePlan.entries, gateRules, {
          action: gateAction,
          productName: (entry) => entry.productName,
        });

        await client.query(
          STOCK_OPERATION_INSERT_SQL,
          stockOperationInsertParams(newOp, opType, totalValue, JSON.stringify(items))
        );

        for (const item of operationItems) {
          const qty = Number(item.quantity) || 1;
          const manualDelta = manualDeltaOf(item);
          let result;
          if (opType === 'DAMAGE') {
            result = await client.query(STOCK_DAMAGE_APPLY_SQL, [qty, item.productId, newOp.branchId]);
          } else if (opType === 'PULLOUT') {
            result = await client.query(
              item.condition === 'DAMAGED_STOCK' ? STOCK_RELEASE_DAMAGED_SQL : STOCK_CONSUME_QOH_SQL,
              [qty, item.productId, newOp.branchId]
            );
          } else if (opType === 'STOCK_OUT' || opType === 'CONSUMABLE_ISSUE') {
            result = await client.query(STOCK_CONSUME_QOH_SQL, [qty, item.productId, newOp.branchId]);
          } else if (opType === 'DISPOSAL') {
            // Write-off: units leave the DAMAGED pool (quantity_on_hand never
            // held them), guarded on damaged_qty so a disposal can never
            // write off more than the pool carries.
            result = await client.query(STOCK_RELEASE_DAMAGED_SQL, [Math.abs(qty), item.productId, newOp.branchId]);
          } else if (opType === 'MANUAL_ADJUSTMENT' && manualDelta !== 0) {
            if (manualDelta < 0) {
              result = await client.query(STOCK_CONSUME_QOH_SQL, [-manualDelta, item.productId, newOp.branchId]);
            } else {
              // Credit upserts, so a product/branch without a stock row yet
              // materialises instead of failing the whole operation.
              result = await client.query(PULLOUT_RECEIVE_STOCK_SQL, [
                `stk-${newOp.branchId.toLowerCase()}-${item.productId}`,
                item.productId,
                newOp.branchId,
                manualDelta,
              ]);
            }
          }
          if (stockConsumingType && result && result.rowCount !== 1) {
            throw new Error(`Stock changed before this operation could be posted for ${item.productName || item.productId}. Please retry.`);
          }
        }

        for (const txn of operationTransactions) {
          await client.query(TXN_INSERT_ON_CONFLICT_SQL, txnInsertOnConflictParams(txn));
        }

        // Persist a damage_records lifecycle entry for every DAMAGE stock
        // operation, so the damage register (table 7b) always faithfully
        // reflects what was actually written to inventory_stock.
        if (opType === 'DAMAGE') {
          for (const item of operationItems) {
            const qty = Number(item.quantity) || 0;
            if (qty <= 0) continue;
            const product = products.find((entry) => entry.id === item.productId);
            const fiscalYearId = newOp.fiscalYear ? getFiscalYearIdForDate(newOp.dateAD) : null;
            // damage_records row + in-memory mirror built once (single source
            // of truth for ids, references, cost resolution and the reason
            // mapping) in server/services/damage.service.ts.
            const rec = buildDamageRecordInsert(newOp as any, item, fiscalYearId, product?.costPrice);
            await client.query(rec.sql, rec.params);
          }

          // Mark the damaged units' serials in serial_log so the register
          // reflects the quarantine (IN_STOCK → DAMAGED) — and a later
          // reversal can restore them. Only rows still IN_STOCK are
          // downgraded; serials already assigned elsewhere are never touched.
          await quarantineSerialsInDb(client, operationItems as any, newOp as any, new Date().toISOString());
        }
      });
    } else if (serialGatePlan.entries.length > 0) {
      // Slice 2 (demo mode: PostgreSQL down): the SAME rule against the
      // in-memory register, so both modes refuse identically instead of the
      // demo path accepting what the database path rejects.
      resolveSerialGateInMemory(serialLogs, serialGatePlan.entries, gateRules, {
        action: gateAction,
        productName: (entry) => entry.productName,
      });
    }
    const idx = stockOperations.findIndex((o) => o.id === newOp.id);
    setStockOperations(idx >= 0 ? withReplaced(stockOperations, idx, newOp) : withPrepended(stockOperations, newOp));
    if (stockConsumingType) {
      for (const item of operationItems) {
        let stockRecord = inventoryStock.find((entry) => entry.productId === item.productId && entry.branchId === newOp.branchId);
        const quantity = Number(item.quantity) || 0;
        const manualDelta = manualDeltaOf(item);
        if (opType === 'MANUAL_ADJUSTMENT' && manualDelta === 0) continue;
        if (!stockRecord && opType === 'MANUAL_ADJUSTMENT' && manualDelta > 0) {
          // Credit materialises the branch row the same way the PG upsert does.
          const creditedRow: any = {
            id: `stk-${newOp.branchId.toLowerCase()}-${item.productId}`,
            productId: item.productId,
            branchId: newOp.branchId,
            quantityOnHand: 0,
            damagedQty: 0,
            reservedQty: 0,
            incomingQty: 0,
            minReorderLevel: 5,
            lastUpdated: new Date().toISOString(),
          };
          stockRecord = creditedRow;
          setInventoryStock(withAppended(inventoryStock, creditedRow));
        }
        if (stockRecord) {
          if (opType === 'DISPOSAL') {
            stockRecord.damagedQty = Math.max(0, (stockRecord.damagedQty || 0) - Math.abs(quantity));
          } else if (opType === 'PULLOUT' && item.condition === 'DAMAGED_STOCK') {
            stockRecord.damagedQty = Math.max(0, (stockRecord.damagedQty || 0) - quantity);
          } else if (opType === 'MANUAL_ADJUSTMENT') {
            stockRecord.quantityOnHand = Math.max(0, (stockRecord.quantityOnHand || 0) + manualDelta);
          } else {
            stockRecord.quantityOnHand -= quantity;
          }
          if (opType === 'DAMAGE') {
            stockRecord.damagedQty = (stockRecord.damagedQty || 0) + quantity;
            // PG-down demo mode only: mirror the serial quarantine directly.
            // With PG connected, quarantineSerialsInDb already wrote the
            // IN_STOCK → DAMAGED transition inside the same transaction and
            // the Serial Log Register reads PG (cacheRefreshHook reconciles
            // the mirror after the response).
            if (!getPgConnected()) {
              quarantineInMemorySerials(serialLogs, [item] as any, newOp as any);
            }
            // Keep the in-memory damage register in lock-step with the DB so
            // the Damaged Stock screen and ledger reflect it immediately.
            const damageRef = `${newOp.referenceNumber}-${item.productId}`;
            const existingDamage = damageRecords.find(
              (dr) => dr.damageReference === damageRef || dr.id === `dmr-${newOp.id}-${item.productId}`
            );
            if (!existingDamage) {
              const rec = buildDamageRecordInsert(newOp as any, item, newOp.fiscalYear ? getFiscalYearCodeForDate(newOp.dateAD) : null);
              setDamageRecords(withPrepended(damageRecords, rec.mirror as DamageRecord));
            }
          }
          stockRecord.lastUpdated = new Date().toISOString();
        }
      }
    }
    setTransactionLogs([
      ...operationTransactions.filter((txn) => !transactionLogs.some((entry) => entry.id === txn.id)),
      ...transactionLogs,
    ]);
    logAuditEvent(req, `CREATE_STOCK_${opType}`, 'STOCK_OPERATIONS', `Created Stock Operation ${newOp.referenceNumber}`);
    res.status(201).json(newOp);
  } catch (err: any) {
    // A refused serial is a caller error, not a server fault: report the
    // register's own reason with its own status instead of a generic 500.
    if (err instanceof SerialGateError) {
      res.status(err.status).json({ message: err.message });
      return;
    }
    console.error('Error creating stock operation:', err);
    const mapped = errorResponse(err);
    res.status(mapped.status).json({ message: mapped.message });
  }

}

/** Forwarded from inventory.routes.ts (post_reverse). */
export async function post_reverse(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const reason = String(req.body.reason || '').trim();
    const reversedBy =
      (req.body.user && (req.body.user.name || req.body.user.email)) ||
      req.body.reversedBy ||
      'Super Admin';
    if (!reason) {
      res.status(400).json({ message: 'A reversal reason is required as a safeguard before undoing a damage record.' });
      return;
    }

    // Mirror step 3: PG-first read — DB truth drives the type/status guards;
    // opIndex is only the mirror write target below (withReplaced is a no-op
    // at -1 when the mirror has not hydrated the row).
    const opIndex = stockOperations.findIndex((o) => o.id === id);
    let op: any = opIndex >= 0 ? stockOperations[opIndex] : undefined;
    if (getPgConnected()) {
      const r = await pgPool.query(STOCK_OPERATION_FIND_BY_ID_SQL, [id]);
      if (r.rows.length > 0) op = r.rows[0];
    }
    if (!op) {
      res.status(404).json({ message: 'Stock operation not found.' });
      return;
    }
    if (op.type !== 'DAMAGE') {
      res.status(400).json({ message: 'Only DAMAGE stock operations can be reversed.' });
      return;
    }
    if (op.status === 'CANCELLED') {
      res.status(400).json({ message: 'This damage record has already been reversed.' });
      return;
    }

    const operationItems: any[] = deriveDamageItems(op);

    if (operationItems.length === 0) {
      res.status(400).json({ message: 'No items were found on this damage operation to reverse.' });
      return;
    }

    // Pre-flight availability check (safeguard: refuse partial / mismatched reversals)
    const availabilityError = validateReversalAvailability(op, operationItems, inventoryStock);
    if (availabilityError) {
      res.status(400).json({ message: availabilityError });
      return;
    }

    // Reversal ledger date (today), with the same BS calendar gate used on creation.
    const reversalDateAD = new Date().toISOString().split('T')[0];
    const bsDayForRev = await findBsDayRecordForAdDate(reversalDateAD);
    const reversalDateBS = bsDayForRev.found ? `${bsDayForRev.record.bsDate} BS` : op.dateBS;

    let reversalLedger: TransactionLog[] = [];

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        // Batched stock restore: one set-based UPDATE restores every item's
        // damaged qty back to available stock (previously one UPDATE per
        // item, holding the pooled client for the whole loop).
        const stockDeltas = operationItems
          .map((item: any) => ({ productId: item.productId, quantity: Number(item.quantity) || 0 }))
          .filter((d: { productId: any; quantity: number }) => d.productId && d.quantity > 0);
        let returnedRows: Array<{ product_id: string; quantity_on_hand: number | string }> = [];
        if (stockDeltas.length > 0) {
          // C3 (mirror step 4): lock the damaged-stock rows and re-verify
          // from DB truth before restoring — the mirror pre-flight above can
          // race a concurrent reversal of the same damage batch.
          const lockedRev = await client.query(
            STOCK_LOCK_FOR_UPDATE_SQL,
            stockLockForUpdateParams(stockDeltas, op.branchId)
          );
          const lockedRevMap = new Map<string, LockedStockRow>(
            (lockedRev.rows || []).map((r: LockedStockRow) => [r.product_id, r])
          );
          for (const delta of stockDeltas) {
            const row = lockedRevMap.get(delta.productId);
            if (!row || Number(row.damaged_qty) < delta.quantity) {
              throw new Error(`Damaged stock changed before reversal could complete for product ${delta.productId}. Available damaged: ${row ? Number(row.damaged_qty) : 0}, needed: ${delta.quantity}.`);
            }
          }
          const result = await client.query(
            STOCK_REVERSE_DAMAGE_BATCH_SQL,
            stockReverseDamageBatchParams(stockDeltas, op.branchId)
          );
          if (result.rowCount !== stockDeltas.length) {
            throw new Error('Damaged stock changed before reversal could complete.');
          }
          // Ledger truth comes from the rows this transaction just updated
          // (RETURNING quantity_on_hand = post-restore quantity), not from a
          // possibly-stale in-memory mirror.
          returnedRows = result.rows || [];
        }

        // Reversal ledger built from the authoritative post-update PG rows.
        reversalLedger = buildReversalLedgerFromRestoredRows(op, operationItems, {
          reversalDateAD,
          reversalDateBS,
          products,
          restoredRows: returnedRows.map((r) => ({
            productId: r.product_id,
            quantityOnHand: Number(r.quantity_on_hand) || 0,
          })),
          fallbackStockRows: inventoryStock,
        });

        // Batched damage-record cancellation: one UPDATE cancels every row
        // of this operation (previously one UPDATE per item).
        await client.query(
          DAMAGE_RECORD_CANCEL_BATCH_SQL,
          damageRecordCancelBatchParams(
            operationItems.map((item: any) => `${op.referenceNumber}-${item.productId}`),
            operationItems.map((item: any) => `dmr-${op.id}-${item.productId}`),
            reason,
            reversedBy
          )
        );

        // Serial restore keeps its per-item loop by design — each item has
        // genuinely different serial payloads and history entries.
        for (const item of operationItems) {
          // Restore serials that THIS operation marked DAMAGED (IN_STOCK →
          // DAMAGED on creation). Only rows still DAMAGED with source_id =
          // this op are restored — serials quarantined by a different, still-
          // active damage record are left untouched. Legacy ops without
          // serials in their payload fall back to source_id attribution.
          await restoreSerialsInDb(
            client,
            item.deviceSerials,
            { id: op.id, referenceNumber: op.referenceNumber },
            `Restored — damage ${op.referenceNumber} reversed by ${reversedBy}: ${reason}`,
            new Date().toISOString()
          );
        }

        await client.query(STOCK_OPERATION_CANCEL_SQL, [reversedBy, op.id]);

        // Batched ledger insert: one multi-row statement instead of one per
        // reversal entry.
        if (reversalLedger.length > 0) {
          await client.query(
            buildTxnMultiRowInsertSql(reversalLedger.length),
            flattenTxnParams(reversalLedger.map((txn) => txnInsertOnConflictParams(txn)))
          );
        }
      });
    }

    // Update the caches (pure copies — the refresh fan-out will reconcile
    // against PostgreSQL) so the UI reflects the reversal immediately.
    // Non-DB demo mode still builds the ledger from the in-memory rows.
    const reversalLedgerDemo: TransactionLog[] = getPgConnected()
      ? []
      : buildReversalLedgerWithStock(op, operationItems, {
          reversalDateAD,
          reversalDateBS,
          products,
          stockRows: inventoryStock,
        });

    const { updatedOp, stockRows, damageRecords: cancelledRecords } = mirrorReversal(
      op,
      operationItems,
      { reason, reversedBy, reversalDateAD, reversalDateBS },
      { stockRows: inventoryStock, damageRecords }
    );
    setStockOperations(withReplaced(stockOperations, opIndex, updatedOp));
    setInventoryStock(stockRows);
    setDamageRecords(cancelledRecords);

    // PG-down demo mode only: mirror the serial restoration directly. With PG
    // connected, restoreSerialsInDb already ran inside the transaction above
    // and cacheRefreshHook re-derives the mirror from PG after the response.
    if (!getPgConnected()) {
      restoreInMemorySerials(
        mutable(serialLogs),
        operationItems.flatMap((item: any) => (Array.isArray(item.deviceSerials) ? item.deviceSerials : [])),
        op,
        `Restored — damage ${op.referenceNumber} reversed by ${reversedBy}: ${reason}`,
        reversalDateAD
      );
    }

    setTransactionLogs([
      ...(reversalLedger.length > 0 ? reversalLedger : reversalLedgerDemo).filter((txn) => !transactionLogs.some((entry) => entry.id === txn.id)),
      ...transactionLogs,
    ]);

    logAuditEvent(req, 'REVERSE_STOCK_DAMAGE', 'STOCK_OPERATIONS', `Reversed damage record ${op.referenceNumber} — ${reason}`);
    res.json({ message: 'Damage record reversed successfully. Units restored to available stock.', operation: updatedOp });
  } catch (err: any) {
    console.error('Error reversing stock operation:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/**
 * Reverse a CONSUMABLE_ISSUE stock operation. Permission 'consumable-issue-reverse'
 * is enforced by the route middleware; the reason is mandatory and kept on the
 * audit trail. Issued units are returned to usable stock at the original branch,
 * a CONSUMABLE_ISSUE-reversal ledger entry is written, and the operation status
 * flips to CANCELLED with reversal metadata attached.
 */
export async function post_reverseConsumable(req: any, res: Response): Promise<any> {
  try {
    const { id } = req.params;
    const reason = String(req.body.reason || '').trim();
    const reversedBy =
      (req.body.user && (req.body.user.name || req.body.user.email)) ||
      req.body.reversedBy ||
      'Super Admin';
    if (!reason) {
      res.status(400).json({ message: 'A reversal reason is required as a safeguard before undoing a consumable issue.' });
      return;
    }

    // Mirror step 3: PG-first read — see post_reverse above.
    const opIndex = stockOperations.findIndex((o) => o.id === id);
    let op: any = opIndex >= 0 ? stockOperations[opIndex] : undefined;
    if (getPgConnected()) {
      const r = await pgPool.query(STOCK_OPERATION_FIND_BY_ID_SQL, [id]);
      if (r.rows.length > 0) op = r.rows[0];
    }
    if (!op) {
      res.status(404).json({ message: 'Stock operation not found.' });
      return;
    }
    if (op.type !== 'CONSUMABLE_ISSUE') {
      res.status(400).json({ message: 'Only CONSUMABLE_ISSUE stock operations can be reversed here.' });
      return;
    }
    if (op.status === 'CANCELLED') {
      res.status(400).json({ message: 'This consumable issue has already been reversed.' });
      return;
    }

    const operationItems: any[] = Array.isArray(op.items) && op.items.length > 0
      ? op.items
      : op.productId
        ? [{ productId: op.productId, productName: op.productName || '', quantity: Math.abs(Number(op.quantityChanged) || 0), unitCost: op.costPerUnit }]
        : [];
    if (operationItems.length === 0) {
      res.status(400).json({ message: 'No items were found on this consumable issue to reverse.' });
      return;
    }

    // Reversal ledger date (today), with the same BS calendar gate used on creation.
    const reversalDateAD = new Date().toISOString().split('T')[0];
    const bsDayForRev = await findBsDayRecordForAdDate(reversalDateAD);
    const reversalDateBS = bsDayForRev.found ? `${bsDayForRev.record.bsDate} BS` : op.dateBS;

    const reversalLedger: TransactionLog[] = operationItems.map((item: any) => {
      const qty = Number(item.quantity) || 0;
      const product = products.find((p) => p.id === item.productId);
      const stockRecord = inventoryStock.find((s) => s.productId === item.productId && s.branchId === op.branchId);
      const unitCost = Number(item.unitCost ?? item.costPerUnit ?? op.costPerUnit) || product?.costPrice || 0;
      const quantityBefore = Number(stockRecord?.quantityOnHand) || 0;
      return {
        id: `txn-${op.id}-crev-${item.productId}`,
        transactionNumber: `${op.referenceNumber}-CREV`,
        productId: item.productId,
        productSku: item.sku || product?.sku || '',
        productName: product?.name || item.productName || 'Product',
        branchId: op.branchId,
        changeType: 'CONSUMABLE_ISSUE',
        quantityBefore,
        quantityChanged: qty,
        quantityAfter: quantityBefore + qty,
        unitCost,
        referenceDocId: op.referenceNumber,
        timestampAD: new Date(`${reversalDateAD}T00:00:00.000Z`).toISOString(),
        timestampBS: reversalDateBS,
      } as TransactionLog;
    });

    const updatedOp: any = {
      ...op,
      status: 'CANCELLED',
      reversalReason: reason,
      reversedBy,
      reversedAtAD: reversalDateAD,
      reversedAtBS: reversalDateBS,
    };

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        // Batched stock return: one set-based UPDATE returns every item's
        // quantity to branch stock (previously one UPDATE per item, holding
        // the pooled client for the whole loop).
        const stockDeltas = operationItems
          .map((item: any) => ({ productId: item.productId, quantity: Number(item.quantity) || 0 }))
          .filter((d: { productId: any; quantity: number }) => d.productId && d.quantity > 0);
        if (stockDeltas.length > 0) {
          await client.query(
            STOCK_RETURN_QOH_BATCH_SQL,
            stockReturnQohBatchParams(stockDeltas, op.branchId)
          );
        }
        await client.query(STOCK_OPERATION_CANCEL_SQL, [reversedBy, op.id]);
        // Batched ledger insert: one multi-row statement instead of one per
        // reversal entry.
        if (reversalLedger.length > 0) {
          await client.query(
            buildTxnMultiRowInsertSql(reversalLedger.length),
            flattenTxnParams(reversalLedger.map((txn) => txnInsertOnConflictParams(txn)))
          );
        }
      });
    }

    // In-memory mirrors so the UI reflects the reversal immediately.
    const stockRows = [...inventoryStock];
    for (const item of operationItems) {
      const qty = Number(item.quantity) || 0;
      if (qty <= 0) continue;
      const stockIdx = stockRows.findIndex((s) => s.productId === item.productId && s.branchId === op.branchId);
      if (stockIdx >= 0) {
        stockRows[stockIdx] = {
          ...stockRows[stockIdx],
          quantityOnHand: (stockRows[stockIdx].quantityOnHand || 0) + qty,
          lastUpdated: new Date().toISOString(),
        };
      }
    }
    setInventoryStock(stockRows);
    setStockOperations(withReplaced(stockOperations, opIndex, updatedOp));
    setTransactionLogs([
      ...reversalLedger.filter((txn) => !transactionLogs.some((entry) => entry.id === txn.id)),
      ...transactionLogs,
    ]);

    logAuditEvent(req, 'REVERSE_CONSUMABLE_ISSUE', 'STOCK_OPERATIONS', `Reversed consumable issue ${op.referenceNumber} — ${reason}`);
    res.json({ message: 'Consumable issue reversed successfully. Units returned to available stock.', operation: updatedOp });
  } catch (err: any) {
    console.error('Error reversing consumable issue:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from inventory.routes.ts (post_receive). */
export async function post_receive(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    // Mirror step 3: PG-first read — DB truth drives the 409 pre-check, the
    // transaction fallbacks and the response body; the mirror below only
    // serves demo mode / PG-down.
    const mirrorOp = stockOperations.find((o) => o.id === id);
    let op = mirrorOp;
    if (getPgConnected()) {
      const r = await pgPool.query(STOCK_OPERATION_FIND_BY_ID_SQL, [id]);
      if (r.rows.length > 0) op = r.rows[0];
    }
    if (op && op.status === 'RECEIVED') {
      res.status(409).json({ message: 'This stock operation has already been received.' });
      return;
    }

    // Ledger rows for the destination credit: TRANSFER_IN at the receiving
    // warehouse, with before/after read from the row LOCKED in the same
    // transaction (PG) or from the mirror (demo mode).
    const receiveTxns: TransactionLog[] = [];
    const buildReceiveTxn = (
      receiveOp: { id: string; referenceNumber?: string },
      item: any,
      idx: number,
      whId: string,
      qty: number,
      before: number
    ): TransactionLog => {
      const product = products.find((entry) => entry.id === item.productId);
      return {
        id: `txn-${receiveOp.id}-recv-${item.productId}`,
        transactionNumber: `${receiveOp.referenceNumber || receiveOp.id}-RCV-${idx + 1}`,
        productId: item.productId,
        productSku: product?.sku || item.sku || '',
        productName: product?.name || item.productName || 'Product',
        branchId: whId,
        changeType: 'TRANSFER_IN',
        quantityBefore: before,
        quantityChanged: qty,
        quantityAfter: before + qty,
        unitCost: Number(item.unitCost ?? item.costPerUnit ?? product?.costPrice) || 0,
        referenceDocId: receiveOp.id,
        timestampAD: new Date(`${op?.dateAD || new Date().toISOString().split('T')[0]}T00:00:00.000Z`).toISOString(),
        timestampBS: op?.dateBS || '',
      } as TransactionLog;
    };

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        const current = await client.query(STOCK_OPERATION_FIND_FOR_RECEIVE_SQL, [id]);
        if (!current.rows[0]) throw new Error('Stock operation not found.');
        if (current.rows[0].status === 'RECEIVED') throw new Error('This stock operation has already been received.');
        await client.query(STOCK_OPERATION_SET_STATUS_SQL, ['RECEIVED', id]);
        const whId = current.rows[0].destinationWarehouseId || op?.destinationWarehouseId || 'WH001';
        const items = typeof current.rows[0].items === 'string' ? JSON.parse(current.rows[0].items) : (current.rows[0].items || op?.items || []);
        // Lock the destination rows so each TRANSFER_IN row records the TRUE
        // quantity before/after inside this same transaction.
        const lockedRows = await client.query(
          STOCK_LOCK_FOR_UPDATE_SQL,
          stockLockForUpdateParams(items as Array<{ productId: string }>, whId)
        );
        const beforeByProduct = new Map<string, number>(
          (lockedRows.rows || []).map((row: any) => [String(row.product_id), Number(row.quantity_on_hand) || 0])
        );
        let lineIdx = 0;
        for (const item of items) {
          const qty = Number(item.quantity) || 1;
          const before = beforeByProduct.get(String(item.productId)) || 0;
          await client.query(PULLOUT_RECEIVE_STOCK_SQL, pulloutReceiveStockParams(whId, item));
          receiveTxns.push(buildReceiveTxn(current.rows[0], item, lineIdx++, whId, qty, before));
        }
        if (receiveTxns.length > 0) {
          await client.query(
            buildTxnMultiRowInsertSql(receiveTxns.length),
            flattenTxnParams(receiveTxns.map((txn) => txnInsertOnConflictParams(txn)))
          );
        }
      });
    } else {
      // Demo mode: the destination warehouse credit previously never happened
      // at all here — only the status flipped, so received pullouts silently
      // vanished from stock. Credit the mirror and record the same TRANSFER_IN
      // rows the PG path writes.
      const whId = op?.destinationWarehouseId || 'WH001';
      const items = (op?.items || []) as any[];
      items.forEach((item: any, idx: number) => {
        const qty = Number(item.quantity) || 1;
        let destStk = inventoryStock.find(
          (entry) => entry.productId === item.productId && entry.branchId === whId
        );
        const before = Number(destStk?.quantityOnHand) || 0;
        if (!destStk) {
          const creditedRow: any = {
            id: `stk-${whId.toLowerCase()}-${item.productId}`,
            productId: item.productId,
            branchId: whId,
            quantityOnHand: 0,
            damagedQty: 0,
            reservedQty: 0,
            incomingQty: 0,
            minReorderLevel: 5,
            lastUpdated: new Date().toISOString(),
          };
          setInventoryStock(withAppended(inventoryStock, creditedRow));
          destStk = creditedRow;
        }
        const creditedStk = destStk as NonNullable<typeof destStk>;
        creditedStk.quantityOnHand = before + qty;
        creditedStk.lastUpdated = new Date().toISOString();
        if (op) receiveTxns.push(buildReceiveTxn(op, item, idx, whId, qty, before));
      });
    }
    if (op) op.status = 'RECEIVED';
    // Dual-write: when the read came from PG the mirror copy still needs its
    // status flipped (it used to BE the `op` object above).
    if (mirrorOp && mirrorOp !== op) mirrorOp.status = 'RECEIVED';
    if (receiveTxns.length > 0) {
      const known = new Set(transactionLogs.map((entry) => entry.id));
      const fresh = receiveTxns.filter((txn) => !known.has(txn.id));
      if (fresh.length > 0) setTransactionLogs([...fresh, ...transactionLogs]);
    }
    logAuditEvent(req, 'RECEIVE_PULLOUT_BIN', 'STOCK_OPERATIONS', `Received Pullout Bin`);
    res.json(op || { message: 'Stock operation received' });
  } catch (err: any) {
    console.error('Error receiving stock operation:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from inventory.routes.ts (get_customerDevices). */
export async function get_customerDevices(req: any, res: Response): Promise<any> {
const { branchId, query } = req.query;

  if (getPgConnected()) {
    try {
      const { sql, params } = buildCustomerDeviceListQuery(branchId, query);

      const r = await pgPool.query(sql, params);
      res.json(r.rows);
      return;
    } catch (err) {
      console.error('Error fetching customer devices from DB:', err);
    }
  }

  let list = customerDeviceRecords;

  if (branchId && branchId !== 'ALL') {
    list = list.filter((c) => c.branchId === branchId);
  }

  if (query && typeof query === 'string' && query.trim()) {
    const q = query.toLowerCase().trim();
    list = list.filter(
      (c) =>
        c.deviceSerial.toLowerCase().includes(q) ||
        c.ponSerial.toLowerCase().includes(q) ||
        (c.macAddress && c.macAddress.toLowerCase().includes(q)) ||
        c.customerName.toLowerCase().includes(q) ||
        c.customerCode.toLowerCase().includes(q) ||
        c.contactPhone.toLowerCase().includes(q)
    );
  }

  res.json(list);

}

/** Forwarded from inventory.routes.ts (post_customerDevices). */
export async function post_customerDevices(req: any, res: Response): Promise<any> {
try {
    const newRecord: CustomerDeviceRecord = {
      id: req.body.id || `cust-${Date.now()}`,
      ...req.body,
    };
    const normalizedDeviceSerial = String(newRecord.deviceSerial || '').trim().toUpperCase();
    const normalizedPonSerial = String(newRecord.ponSerial || '').trim().toUpperCase();
    if (!normalizedDeviceSerial || !normalizedPonSerial) {
      res.status(400).json({ message: 'Device serial and PON serial are required.' });
      return;
    }
    const duplicateLocal = customerDeviceRecords.find((record) =>
      record.id !== newRecord.id &&
      (String(record.deviceSerial || '').trim().toUpperCase() === normalizedDeviceSerial ||
        String(record.ponSerial || '').trim().toUpperCase() === normalizedPonSerial)
    );
    if (duplicateLocal) return res.status(409).json({ message: 'Device serial or PON serial is already registered.' });
    if (getPgConnected()) {
      const duplicateDb = await pgPool.query(
        CDR_DUPLICATE_CHECK_SQL,
        [newRecord.id, normalizedDeviceSerial, normalizedPonSerial]
      );
      if (duplicateDb.rowCount) return res.status(409).json({ message: 'Device serial or PON serial is already registered.' });
    }
    const custCode = newRecord.customerCode || newRecord.customerId;
    const branchId = newRecord.branchId || 'WH001';
    const nextStatus = newRecord.status || 'ACTIVE';
    const previousRecord = customerDeviceRecords.find((c) => c.id === newRecord.id);
    let previousStatus = previousRecord?.status;
    if (getPgConnected() && !previousStatus) {
      const existingRecord = await pgPool.query(CDR_EXISTING_STATUS_SQL, [newRecord.id]);
      previousStatus = existingRecord.rows[0]?.status;
    }
    const wasAssigned = Boolean(previousStatus && previousStatus !== 'IN_STOCK');
    const isAssigned = nextStatus !== 'IN_STOCK';
    const assignmentDelta = (isAssigned ? 1 : 0) - (wasAssigned ? 1 : 0);
    const product = products.find((entry) => entry.name.trim().toLowerCase() === String(newRecord.productName || '').trim().toLowerCase());
    if (isAssigned && !product) return res.status(400).json({ message: 'A valid product is required when assigning a device.' });

    const issuedDateAD = newRecord.issuedDateAD || new Date().toISOString().split('T')[0];
    const issuedDateBS = newRecord.issuedDateBS || todayBs(); // C4: from bs_day_records cache

    // ---------------------------------------------------------------------
    // Single-movement guard (stock-movement audit): a unit deployed by the
    // Assign Fixed Asset flow (deployFromStock) already consumed one stock
    // unit and wrote its own STOCK_OUT ledger row (`txn-asset-<assetId>`).
    // The rental-CPE record that same flow creates must NOT consume a second
    // unit: when the serial carries that proof, the stock change (either
    // direction) is skipped and the asset's ledger row stands as the single
    // movement for the device. Every stock change this endpoint DOES apply
    // writes its own ledger row below, so the movement ledger always matches
    // inventory_stock.
    // ---------------------------------------------------------------------
    let stockAlreadyConsumedByAsset = false;
    if (assignmentDelta !== 0 && normalizedDeviceSerial) {
      if (getPgConnected()) {
        const proof = await pgPool.query(CDR_ASSET_DEPLOY_PROOF_SQL, [normalizedDeviceSerial]);
        stockAlreadyConsumedByAsset = (proof.rowCount ?? 0) > 0;
      } else {
        const deployed = serialLogs.find(
          (entry) =>
            String(entry.deviceSerial || '').trim().toUpperCase() === normalizedDeviceSerial &&
            entry.sourceType === 'FIXED_ASSET' &&
            entry.sourceId
        );
        stockAlreadyConsumedByAsset = Boolean(
          deployed && transactionLogs.some((txn) => txn.id === `txn-asset-${deployed.sourceId}`)
        );
      }
    }
    const applyStockChange = assignmentDelta !== 0 && Boolean(product) && !stockAlreadyConsumedByAsset;

    /** Ledger row for the ±1 stock movement this endpoint applies. */
    const buildAssignmentTxn = (quantityBefore: number, quantityAfter: number): TransactionLog => ({
      id: `txn-cdr-${newRecord.id}-${assignmentDelta > 0 ? 'assign' : 'release'}`,
      transactionNumber: `TXN-CDR-${Math.floor(10000 + Math.random() * 90000)}`,
      productId: product!.id,
      productSku: product!.sku || '',
      productName: product!.name || newRecord.productName || 'Product',
      branchId,
      changeType: (assignmentDelta > 0 ? 'STOCK_OUT' : 'MANUAL_ADJUSTMENT') as TransactionLog['changeType'],
      quantityBefore,
      quantityChanged: quantityAfter - quantityBefore,
      quantityAfter,
      unitCost: Number(product!.costPrice) || 0,
      referenceDocId: custCode || normalizedDeviceSerial || newRecord.id,
      timestampAD: issuedDateAD,
      timestampBS: issuedDateBS,
    });

    // Assignment picks a unit out of branch stock: the DEVICE SERIAL must name
    // an IN_STOCK register row of this branch. Without this gate a CDR row
    // could name a unit the register never received (or one held elsewhere),
    // and the UPDATE-if-exists sync below would silently no-op.
    const assignmentGateEntry = {
      deviceSerial: normalizedDeviceSerial,
      ponSerial: '',
      macAddress: '',
      productId: product?.id || '',
      productName: product?.name || String(newRecord.productName || ''),
    };
    const assignmentGateRules = { branchId, allowedStatuses: ['IN_STOCK'] as const, matchProduct: false };
    if (isAssigned && normalizedDeviceSerial && !stockAlreadyConsumedByAsset && !getPgConnected()) {
      resolveSerialGateInMemory(serialLogs as any, [assignmentGateEntry], assignmentGateRules, {
        action: 'assigned to a customer',
      });
    }

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        if (isAssigned && normalizedDeviceSerial && !stockAlreadyConsumedByAsset) {
          await resolveSerialGateInDb(client, [assignmentGateEntry], assignmentGateRules, {
            action: 'assigned to a customer',
          });
        }
        if (applyStockChange && product) {
          const stockChange = assignmentDelta < 0 ? 1 : -1;
          // Both directions return the true post-update balance so the ledger
          // row records database-accurate before/after quantities.
          const stockResult = stockChange < 0
            ? await client.query(
                CDR_ASSIGNMENT_STOCK_SQL,
                cdrAssignmentStockParams(stockChange, product.id, branchId, 1)
              )
            : await client.query(
                CDR_ASSIGNMENT_STOCK_RETURN_SQL,
                cdrAssignmentReturnParams(stockChange, product.id, branchId)
              );
          if (stockResult.rowCount !== 1) throw new Error(`Insufficient available stock for ${newRecord.productName}.`);
          const quantityAfter = Number(stockResult.rows[0]?.quantity_on_hand);
          await client.query(
            TXN_INSERT_ON_CONFLICT_SQL,
            txnInsertOnConflictParams(buildAssignmentTxn(quantityAfter - stockChange, quantityAfter))
          );
        }
        await client.query(
          CDR_UPSERT_SQL,
          customerDeviceInsertParams({
            ...newRecord,
            customerId: newRecord.customerId || custCode,
            customerCode: custCode,
            branchId,
            status: nextStatus,
            issuedDateAD,
            issuedDateBS,
          } as CustomerDeviceRecord)
        );

        // Sync the Serial Log Register: assigning (or releasing) a device in
        // this directory must flip the unit's register status, or the
        // register's status filter disagrees with the customer directory
        // (CDR↔serial_log audit). UPDATE-if-exists — a serial the register
        // never received is not fabricated here.
        if (normalizedDeviceSerial) {
          const serialStatus = serialStatusForCdrStatus(nextStatus);
          if (serialStatus) {
            await client.query(
              SERIAL_LOG_SYNC_ON_CDR_SQL,
              serialLogCdrSyncParams({
                status: serialStatus,
                customerId: newRecord.customerId || custCode || null,
                customerName: newRecord.customerName || null,
                branchId,
                historyEntry: cdrHistoryEntry(
                  serialStatus,
                  newRecord.id,
                  issuedDateAD,
                  `Customer device assignment: status ${nextStatus} for ${newRecord.customerName}`
                ),
                deviceSerial: normalizedDeviceSerial,
              })
            );
          }
        }

        const countDelta = assignmentDelta;
        await client.query(
          CDR_CUSTOMER_COUNT_UPSERT_SQL,
          customerCountUpsertParams({
            id: custCode || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
            customerId: custCode || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
            customerName: newRecord.customerName,
            username: newRecord.customerName.toLowerCase().replace(/\s+/g, '.'),
            contactPhone: newRecord.contactPhone || '9800000000',
            branchId: newRecord.branchId || 'WH001',
            installationAddress: newRecord.installationAddress || 'Nepal',
            countDelta,
          })
        );
      });
    } else if (applyStockChange && product) {
      const stockRecord = inventoryStock.find((entry) => entry.productId === product.id && entry.branchId === branchId);
      if (assignmentDelta > 0 && (!stockRecord || stockRecord.quantityOnHand < 1)) {
        res.status(400).json({ message: `Insufficient available stock for ${newRecord.productName}.` });
        return;
      }
      const quantityBefore = Number(stockRecord?.quantityOnHand) || 0;
      const quantityAfter = assignmentDelta > 0 ? quantityBefore - 1 : quantityBefore + 1;
      if (stockRecord) {
        stockRecord.quantityOnHand = quantityAfter;
        stockRecord.lastUpdated = new Date().toISOString();
      } else {
        // Release materialises the branch row the same way the PG path does.
        setInventoryStock(withAppended(inventoryStock, {
          id: `stk-${branchId.toLowerCase()}-${product.id}`,
          productId: product.id,
          branchId,
          quantityOnHand: quantityAfter,
          damagedQty: 0,
          reservedQty: 0,
          incomingQty: 0,
          minReorderLevel: 5,
          lastUpdated: new Date().toISOString(),
        }));
      }
      setTransactionLogs(withPrepended(transactionLogs, buildAssignmentTxn(quantityBefore, quantityAfter)));
    }
    const idx = customerDeviceRecords.findIndex((c) => c.id === newRecord.id);
    setCustomerDeviceRecords(idx >= 0
      ? withReplaced(customerDeviceRecords, idx, { ...newRecord, status: nextStatus, branchId })
      : withPrepended(customerDeviceRecords, { ...newRecord, status: nextStatus, branchId }));
    // Demo mode: mirror the register flip the PG path wrote above.
    if (!getPgConnected() && normalizedDeviceSerial) {
      const serialStatus = serialStatusForCdrStatus(nextStatus);
      if (serialStatus) {
        setSerialLogs(flipSerialMirror(
          serialLogs,
          normalizedDeviceSerial,
          serialStatus,
          newRecord.customerId || custCode || null,
          newRecord.customerName || null,
          cdrHistoryEntry(
            serialStatus,
            newRecord.id,
            issuedDateAD,
            `Customer device assignment: status ${nextStatus} for ${newRecord.customerName}`
          )
        ));
      }
    }
    logAuditEvent(req, 'ASSIGN_CUSTOMER_CPE', 'CPE_MANAGEMENT', `Assigned CPE Device Serial ${newRecord.deviceSerial} (PON: ${newRecord.ponSerial || 'N/A'}) to customer ${newRecord.customerName}`, newRecord.branchId);
    res.status(201).json(newRecord);
  } catch (err: any) {
    console.error('Error adding customer device:', err);
    const mapped = errorResponse(err);
    res.status(mapped.status).json({ message: mapped.message });
  }

}

/** Forwarded from inventory.routes.ts (patch_status2). */
export async function patch_status2(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const { status } = req.body;
    let record = customerDeviceRecords.find((c) => c.id === id);

    if (getPgConnected() && !record) {
      const r = await pgPool.query(CDR_FIND_NARROW_SQL, [id]);
      if (r.rows.length > 0) record = r.rows[0];
    }
    if (!record) return res.status(404).json({ message: 'Customer device record not found' });

    const oldStatus = record.status;
    const isDisconn = status === 'DISCONNECTED' || status === 'ROUTER_COLLECTED';
    const newStatusStr = isDisconn ? 'ROUTER_COLLECTED' : status;

    record.status = newStatusStr;

    if (getPgConnected()) {
      // One transaction: the CDR status flip and the Serial Log Register
      // flip commit together or not at all (previously the register was
      // never told, so collected/refunded units stayed CUSTOMER_ASSIGNED
      // there forever — CDR↔serial_log audit finding).
      await withTransaction(async (client) => {
        await client.query(CDR_UPDATE_STATUS_SQL, [newStatusStr, id]);
        const serialStatus = serialStatusForCdrStatus(newStatusStr);
        if (serialStatus && record!.deviceSerial) {
          await client.query(
            SERIAL_LOG_SYNC_ON_CDR_SQL,
            serialLogCdrSyncParams({
              status: serialStatus,
              customerId: (record as any).customerId ?? null,
              customerName: (record as any).customerName ?? null,
              branchId: (record as any).branchId ?? null,
              historyEntry: cdrHistoryEntry(
                serialStatus,
                id,
                new Date().toISOString().split('T')[0],
                `CPE status change: ${oldStatus} → ${newStatusStr}`
              ),
              deviceSerial: record!.deviceSerial,
            })
          );
        }
      });
    }
    // Demo mode: mirror the register flip so both surfaces stay in step.
    if (!getPgConnected()) {
      const serialStatus = serialStatusForCdrStatus(newStatusStr);
      if (serialStatus && record.deviceSerial) {
        setSerialLogs(flipSerialMirror(
          serialLogs,
          record.deviceSerial,
          serialStatus,
          (record as any).customerId ?? null,
          (record as any).customerName ?? null,
          cdrHistoryEntry(
            serialStatus,
            id,
            new Date().toISOString().split('T')[0],
            `CPE status change: ${oldStatus} → ${newStatusStr}`
          )
        ));
      }
    }
    logAuditEvent(req, 'UPDATE_CPE_DEVICE_STATUS', 'CPE_MANAGEMENT', `Updated CPE Device ${record.deviceSerial} status from ${oldStatus} to ${newStatusStr}`, record.branchId);
    res.json(record);
  } catch (err: any) {
    console.error('Error updating CPE device status:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from inventory.routes.ts (get_lookup). */
export async function get_lookup(req: any, res: Response): Promise<any> {
try {
    const value = String(req.query.value || '').trim();
    const exclude = Array.isArray(req.query.exclude)
      ? req.query.exclude.map((v: any) => String(v || '').trim().toUpperCase()).filter(Boolean)
      : String(req.query.exclude || '').trim().toUpperCase()
        ? [String(req.query.exclude).trim().toUpperCase()]
        : [];
    if (!value) return res.status(400).json({ message: 'value query parameter is required.' });
    if (!getPgConnected()) return res.status(503).json({ message: 'Database not connected.' });

    const { params, serialLogSql, customerDeviceSql, fixedAssetSql } = buildSerialLookupSql(value, exclude);

    // 1. serial_log (register — one row per serial)
    const slRes = await pgPool.query(serialLogSql, params);
    if (slRes.rows.length > 0) {
      res.json({ ...slRes.rows[0], source: 'SERIAL_LOG' });
      return;
    }

    // 2. customer_device_records (customer assignments)
    const cdrRes = await pgPool.query(customerDeviceSql, params);
    if (cdrRes.rows.length > 0) {
      res.json({ ...cdrRes.rows[0], source: 'CUSTOMER_DEVICE' });
      return;
    }

    // 3. fixed_assets (device serial stored as tag_number)
    const faRes = await pgPool.query(fixedAssetSql, params);
    if (faRes.rows.length > 0) {
      return res.json({
        deviceSerial: faRes.rows[0].deviceSerial,
        ponSerial: null,
        macAddress: null,
        productName: faRes.rows[0].productName,
        branchId: faRes.rows[0].branchId,
        customerId: null,
        customerName: null,
        status: 'IN_STOCK',
        source: 'FIXED_ASSET',
      });
    }

    res.status(404).json({ message: 'No device holds this serial.' });
    return;
  } catch (err: any) {
    console.error('Error looking up serial:', err);
    res.status(500).json({ message: err.message || 'Database error' });
    return;
  }

}

/** Forwarded from inventory.routes.ts (get_lookup2). */
/** Forwarded from inventory.routes.ts (get_lookup3). */
/** Forwarded from inventory.routes.ts (post_dual). */
export async function post_dual(req: any, res: Response): Promise<any> {
try {
    const { a, b } = req.body || {};
    const validationError = validateDualEditPayload(a, b);
    if (validationError) {
      res.status(validationError.status).json({ message: validationError.message });
      return;
    }

    const result = await applyDualEdit(runSerialEditCapture, req.user, a, b, generateParkTag());
    if (result.ok === false) {
      // One transaction per edit; a failed step leaves prior steps applied
      // (each step is itself atomic). The failure payload reports which step
      // failed so the client can show the exact conflict.
      res.status(result.status).json(result.payload);
      return;
    }

    res.json({ success: true, message: 'Serial corrections applied across all inventory records.', results: result.results });
    return;
  } catch (err: any) {
    console.error('Error applying dual serial correction:', err);
    res.status(err.status || 500).json({ message: err.message || 'Database error' });
    return;
  }

}

/** Forwarded from inventory.routes.ts (post_exchange). */
export async function post_exchange(req: any, res: Response): Promise<any> {
  // Hoisted so the catch block can undo mirror writes when PG refuses.
  let mirrorOld: any = null;
  let cdrMirrorBefore: typeof customerDeviceRecords | null = null;
  let mirrorStatusBefore: { status: unknown; notes: unknown } | null = null;
try {
    const {
      oldDeviceId,
      exchangeReason,
      oldDeviceAction,
      newProductName,
      newDeviceSerial,
      notes,
      branchId,
    } = req.body;
    // Hydrated below from the register when blank (one-field UX).
    let { newPonSerial, newMacAddress } = req.body;

    // Mirror step 3: PG-first — the full-row read below used to run only on
    // a mirror miss, so a stale mirror row could seed the exchange response.
    mirrorOld = customerDeviceRecords.find((c) => c.id === oldDeviceId);
    let oldRecord: any;
    if (getPgConnected()) {
      const r = await pgPool.query(CDR_FIND_ALL_BY_ID_SQL, [oldDeviceId]);
      if (r.rows.length > 0) {
        const row = r.rows[0];
        oldRecord = {
          id: row.id,
          customerId: row.customer_id,
          customerName: row.customer_name,
          customerCode: row.customer_code,
          contactPhone: row.contact_phone,
          installationAddress: row.installation_address,
          branchId: row.branch_id,
          productName: row.product_name,
          deviceSerial: row.device_serial,
          ponSerial: row.pon_serial,
          macAddress: row.mac_address,
          status: row.status,
          issuedDateAD: row.issued_date_ad,
          issuedDateBS: row.issued_date_bs,
          purchaseBillRef: row.purchase_bill_ref,
          notes: row.notes,
        };
      }
    }

    if (!oldRecord) oldRecord = mirrorOld;

    if (!oldRecord) return res.status(404).json({ message: 'Old customer device record not found' });

    // The register holds one row per serial (and per PON serial), so a
    // replacement identity that another device already owns can never be
    // written. Checked BEFORE any state is touched (mirror row included) so a
    // conflict is a clean 409 rather than a half-applied exchange that ends in
    // a unique-index 500 and a rolled-back stock movement.
    if (getPgConnected() && newDeviceSerial) {
      const dupDevice = await pgPool.query(CDR_DUPLICATE_CHECK_SQL, [
        String(newDeviceSerial),
        String(newDeviceSerial).trim().toUpperCase(),
        String(newPonSerial || '').trim().toUpperCase(),
      ]);
      if (dupDevice.rowCount) {
        res.status(409).json({
          message: 'That device serial or PON serial is already registered to another device. Enter the replacement unit\'s own serial.',
        });
        return;
      }
    }

    // The replacement unit has to BE stock: this endpoint used to trust the
    // client's newDeviceSerial outright, so an exchange could hand a customer a
    // serial the register never received (or one sitting at another branch) and
    // the UPDATE-if-exists sync further down would silently no-op while the
    // customer row claimed the device. The register is now the authority, and
    // the same rule is re-applied with a row lock inside the transaction.
    const replacementSerial = String(newDeviceSerial || '').trim();
    const exchBranchId = String(branchId || oldRecord.branchId || '');
    const exchAction = String(oldDeviceAction || '').toUpperCase();
    const exchQty = 1;
    const replacementGateEntry = {
      deviceSerial: replacementSerial,
      ponSerial: String(newPonSerial || '').trim(),
      macAddress: String(newMacAddress || '').trim(),
      productId: '',
      productName: String(newProductName || oldRecord.productName || ''),
    };
    // A replacement may legitimately be a different model, so the product is not
    // matched; the branch and IN_STOCK are. Identity fields a caller DID send
    // are still checked, so a wrong PON/MAC is refused rather than overwritten.
    const replacementGateRules = {
      branchId: exchBranchId,
      allowedStatuses: ['IN_STOCK'] as const,
      matchProduct: false,
      matchPonWhenProvided: true,
      matchMac: true,
    };
    const replacementGateCtx = { action: 'used as a replacement device' };
    if (replacementSerial) {
      if (getPgConnected()) {
        // Pre-flight before any mirror state is touched, so a refusal is a clean
        // 400 that leaves the mirrors exactly as they were.
        await resolveSerialGateInDb(pgPool as any, [replacementGateEntry], replacementGateRules, replacementGateCtx);
      } else {
        resolveSerialGateInMemory(serialLogs as any, [replacementGateEntry], replacementGateRules, replacementGateCtx);
      }

      // Fill blank PON/MAC from the register row (one-field UX).
      if (getPgConnected()) {
        const identity = await pgPool.query(SERIAL_LOG_IDENTITY_BY_SERIAL_SQL, [replacementSerial]);
        const row = identity.rows[0];
        if (row) {
          if (!String(newPonSerial || '').trim()) newPonSerial = row.ponSerial || undefined;
          if (!String(newMacAddress || '').trim()) newMacAddress = row.macAddress || undefined;
        }
      } else {
        const row: any = serialLogs.find((r) => serialGateKey(r.deviceSerial) === serialGateKey(replacementSerial));
        if (row) {
          if (!String(newPonSerial || '').trim()) newPonSerial = row.ponSerial || undefined;
          if (!String(newMacAddress || '').trim()) newMacAddress = row.macAddress || undefined;
        }
      }
    }

    const dateStrAD = new Date().toISOString().split('T')[0];
    // A PG failure after the mirror writes below must not leave a phantom
    // replacement row and a flipped old record behind.
    cdrMirrorBefore = customerDeviceRecords;
    mirrorStatusBefore = mirrorOld ? { status: mirrorOld.status, notes: mirrorOld.notes } : null;

    oldRecord.status = 'EXCHANGED';
    oldRecord.notes = `[EXCHANGED on ${dateStrAD}] Reason: ${exchangeReason || 'Defective / Replacement'}. Old device disposition: ${oldDeviceAction}. Replacement SN: ${newDeviceSerial}. ${oldRecord.notes || ''}`;
    // Dual-write: the mirror copy used to BE oldRecord (mirror-first read),
    // so flip it explicitly when the read came from PG.
    if (mirrorOld && mirrorOld !== oldRecord) {
      mirrorOld.status = oldRecord.status;
      mirrorOld.notes = oldRecord.notes;
    }

    const newRecord: CustomerDeviceRecord = {
      id: `cust-${Date.now()}`,
      customerId: oldRecord.customerId,
      customerName: oldRecord.customerName,
      customerCode: oldRecord.customerCode,
      contactPhone: oldRecord.contactPhone,
      installationAddress: oldRecord.installationAddress,
      branchId: branchId || oldRecord.branchId,
      productName: newProductName || oldRecord.productName,
      deviceSerial: newDeviceSerial,
      ponSerial: newPonSerial,
      macAddress: newMacAddress || undefined,
      status: 'RENTAL',
      issuedDateAD: dateStrAD,
      issuedDateBS: todayBs(), // C4: from bs_day_records cache, not a hardcoded date
      purchaseBillRef: oldRecord.purchaseBillRef,
      notes: `[REPLACEMENT DEVICE] Replaced previous SN ${oldRecord.deviceSerial} on ${dateStrAD}. ${notes || ''}`,
    };

    setCustomerDeviceRecords(upsertCdrMirror(customerDeviceRecords, newRecord).rows);

    // Stock maintenance for the OLD unit's disposition (exchange audit fix):
    // the Exchange form promises "RESTOCK → +1 Stock" and "DAMAGE →
    // Quarantined RMA Stock", but the handler never touched inventory_stock,
    // so restocked units vanished from branch inventory and RMA units never
    // reached the damaged bucket. Product resolved by name (CDR carries the
    // product name only, same pattern as the approval restock in misc).
    const exchProd = products.find((p) => p.name.trim().toLowerCase() === String(oldRecord.productName || '').trim().toLowerCase());
    const exchStockTxn = (changeType: 'PULLOUT' | 'DAMAGE', before: number, after: number): TransactionLog => ({
      id: `txn-exchange-${oldDeviceId}-${Date.now()}`,
      transactionNumber: `EXC-${oldDeviceId}-${Date.now()}`,
      productId: exchProd?.id || '',
      productSku: exchProd?.sku || '',
      productName: oldRecord.productName,
      branchId: exchBranchId,
      changeType,
      quantityBefore: before,
      quantityChanged: 1,
      quantityAfter: after,
      unitCost: exchProd?.costPrice || 0,
      referenceDocId: newRecord.id,
      timestampAD: dateStrAD,
      timestampBS: newRecord.issuedDateBS,
    });

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        // Authoritative re-check: the pre-flight above could have been raced by
        // another consumer of this serial. FOR UPDATE pins the row until the
        // CUSTOMER_ASSIGNED flip below commits.
        if (replacementSerial) {
          await resolveSerialGateInDb(client, [replacementGateEntry], replacementGateRules, replacementGateCtx);
        }
        await client.query(CDR_EXCHANGE_STATUS_SQL, ['EXCHANGED', oldRecord.notes, oldDeviceId]);

        // Replacement row, serial-keyed: a serial the register has seen before
        // (e.g. a unit swapped back in) is re-activated instead of inserted.
        await registerCustomerDeviceRow(client, newRecord);

        // +1 usable stock (RESTOCK) or +1 damaged stock (DAMAGE) at the
        // fulfilling branch; DISPOSED is scrap and correctly adds nothing.
        if (exchProd && (exchAction === 'RESTOCK' || exchAction === 'DAMAGE')) {
          const returnParams = cdrAssignmentReturnParams(exchQty, exchProd.id, exchBranchId);
          const stockRes = exchAction === 'RESTOCK'
            ? await client.query(CDR_ASSIGNMENT_STOCK_RETURN_SQL, returnParams)
            : await client.query(CDR_ASSIGNMENT_DAMAGED_RETURN_SQL, returnParams);
          const col = exchAction === 'RESTOCK' ? 'quantity_on_hand' : 'damaged_qty';
          const quantityAfter = Number(stockRes.rows[0]?.[col]);
          if (Number.isFinite(quantityAfter)) {
            await client.query(
              TXN_INSERT_ON_CONFLICT_SQL,
              txnInsertOnConflictParams(exchStockTxn(exchAction === 'RESTOCK' ? 'PULLOUT' : 'DAMAGE', quantityAfter - exchQty, quantityAfter))
            );
          }
        }

        // Sync the Serial Log Register with BOTH halves of the exchange:
        // the old unit's disposition (restock → IN_STOCK, damage/disposal →
        // DAMAGED) and the replacement unit taking over the customer
        // (CUSTOMER_ASSIGNED). Neither was recorded before, so the register
        // kept the old serial assigned and never knew the new one
        // (CDR↔serial_log audit finding). UPDATE-if-exists on both.
        const exchangeDateAD = dateStrAD;
        const oldSerialStatus = serialStatusForExchangeAction(oldDeviceAction);
        await client.query(
          SERIAL_LOG_SYNC_ON_CDR_SQL,
          serialLogCdrSyncParams({
            status: oldSerialStatus,
            customerId: null,
            customerName: null,
            branchId: branchId || oldRecord.branchId || null,
            historyEntry: cdrHistoryEntry(
              oldSerialStatus,
              newRecord.id,
              exchangeDateAD,
              `Device exchanged for ${oldRecord.customerName}: old unit ${oldDeviceAction} (replaced by SN ${newDeviceSerial})`
            ),
            deviceSerial: oldRecord.deviceSerial,
          })
        );
        await client.query(
          SERIAL_LOG_SYNC_ON_CDR_SQL,
          serialLogCdrSyncParams({
            status: 'CUSTOMER_ASSIGNED',
            customerId: newRecord.customerId || null,
            customerName: newRecord.customerName || null,
            branchId: newRecord.branchId || null,
            historyEntry: cdrHistoryEntry(
              'CUSTOMER_ASSIGNED',
              newRecord.id,
              exchangeDateAD,
              `Replacement device assigned to ${newRecord.customerName} (replaced SN ${oldRecord.deviceSerial})`
            ),
            deviceSerial: newRecord.deviceSerial,
          })
        );
      });
    } else {
      // Demo mode: mirror both register flips.
      const oldSerialStatus = serialStatusForExchangeAction(oldDeviceAction);
      let nextSerials = flipSerialMirror(
        serialLogs,
        oldRecord.deviceSerial,
        oldSerialStatus,
        null,
        null,
        cdrHistoryEntry(
          oldSerialStatus,
          newRecord.id,
          dateStrAD,
          `Device exchanged for ${oldRecord.customerName}: old unit ${oldDeviceAction} (replaced by SN ${newDeviceSerial})`
        )
      );
      nextSerials = flipSerialMirror(
        nextSerials,
        newRecord.deviceSerial,
        'CUSTOMER_ASSIGNED',
        newRecord.customerId || null,
        newRecord.customerName || null,
        cdrHistoryEntry(
          'CUSTOMER_ASSIGNED',
          newRecord.id,
          dateStrAD,
          `Replacement device assigned to ${newRecord.customerName} (replaced SN ${oldRecord.deviceSerial})`
        )
      );
      setSerialLogs(nextSerials);
      // Demo-mode twin of the stock maintenance above.
      if (exchProd && (exchAction === 'RESTOCK' || exchAction === 'DAMAGE')) {
        let stk = inventoryStock.find((s) => s.productId === exchProd.id && s.branchId === exchBranchId);
        if (!stk) {
          stk = {
            id: `stk-${exchBranchId.toLowerCase()}-${exchProd.id}`,
            productId: exchProd.id,
            branchId: exchBranchId,
            quantityOnHand: 0,
            damagedQty: 0,
            reservedQty: 0,
            incomingQty: 0,
            lastUpdated: new Date().toISOString(),
          };
          setInventoryStock(withAppended(inventoryStock, stk));
        }
        const exchQohBefore = stk.quantityOnHand || 0;
        const exchDamagedBefore = stk.damagedQty || 0;
        if (exchAction === 'RESTOCK') stk.quantityOnHand = exchQohBefore + exchQty;
        else stk.damagedQty = exchDamagedBefore + exchQty;
        stk.lastUpdated = new Date().toISOString();
        setTransactionLogs(withPrepended(
          transactionLogs,
          exchStockTxn(
            exchAction === 'RESTOCK' ? 'PULLOUT' : 'DAMAGE',
            exchAction === 'RESTOCK' ? exchQohBefore : exchDamagedBefore,
            exchAction === 'RESTOCK' ? exchQohBefore + exchQty : exchDamagedBefore + exchQty
          )
        ));
      }
    }
    logAuditEvent(req, 'DEVICE_EXCHANGE', 'CPE_MANAGEMENT', `Exchanged CPE Device for ${oldRecord.customerName}. Replaced SN ${oldRecord.deviceSerial} -> New SN ${newDeviceSerial}${exchProd && (exchAction === 'RESTOCK' || exchAction === 'DAMAGE') ? ` — old unit ${exchAction === 'RESTOCK' ? 'restocked to branch inventory' : 'quarantined as damaged stock'}` : ''}`, oldRecord.branchId);
    res.status(201).json({ oldRecord, newRecord, message: 'Customer device successfully exchanged and inventory synchronized.' });
  } catch (err: any) {
    const status = Number(err?.status) || 500;
    // A refused exchange is a normal outcome for the operator, not a crash:
    // only log real failures, so an expected 400 does not page anyone.
    if (status >= 500) console.error('Error exchanging customer device:', err);
    // Roll the mirrors back when PG refused after they were written, so a
    // refused exchange never leaves a replacement row the database rejected.
    if (getPgConnected()) {
      if (mirrorOld && mirrorStatusBefore) {
        mirrorOld.status = mirrorStatusBefore.status;
        mirrorOld.notes = mirrorStatusBefore.notes;
      }
      // Null when the refusal happened before any mirror write (the common
      // case), so there is nothing to undo.
      if (cdrMirrorBefore) setCustomerDeviceRecords(cdrMirrorBefore);
    }
    res.status(status).json({ message: status === 500 ? `Database error: ${err.message}` : err.message });
  }

}

/** Forwarded from inventory.routes.ts (get_serialLog). */
export async function get_serialLog(req: any, res: Response): Promise<any> {
try {
    const { branchId, status, query, dateFromAD, dateToAD, page, pageSize, all } = req.query;
    const user = (req as any).user;
    // Branch scoping: non-global users may only read their own branches.
    let branchScope: string[] | undefined;
    let globalBranchId: unknown;
    if (user && user.role !== 'SUPER_ADMIN' && user.role !== 'HEAD_OFFICE_ADMIN') {
      const allowed = new Set<string>([user.branchId || '', ...(user.allowedBranchIds || [])].filter(Boolean));
      const requestedBranchId = typeof branchId === 'string' && branchId !== 'ALL' && branchId.trim() !== '' ? branchId : undefined;
      if (requestedBranchId && !allowed.has(requestedBranchId)) {
        res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
        return;
      }
      if (allowed.size === 0) {
        res.json([]);
        return;
      }
      branchScope = requestedBranchId ? [requestedBranchId] : [...allowed];
    } else {
      globalBranchId = branchId;
    }
    const opts = { branchScope, globalBranchId, status, query, dateFromAD, dateToAD };
    // Paged mode: ?page=N (with optional pageSize) returns an envelope with
    // the page slice, the filtered total, and per-status counts for the KPI
    // cards. ?all=1 returns every filtered row (CSV export). No page param
    // keeps the legacy full-array shape for existing callers.
    const wantsPaged = page !== undefined || pageSize !== undefined || all === '1';
    if (wantsPaged) {
      const n = Math.max(1, Number(page) || 1);
      const size = Math.max(1, Math.min(500, Number(pageSize) || 50));
      const countR = await pgPool.query(buildSerialLogCountQuery(opts).sql, buildSerialLogCountQuery(opts).params);
      const totalItems = Number(countR.rows[0]?.count || 0);
      const statusQ = buildSerialLogStatusCountQuery(opts);
      const statusR = await pgPool.query(statusQ.sql, statusQ.params);
      const statusCounts: Record<string, number> = {};
      for (const row of statusR.rows) statusCounts[String(row.status)] = Number(row.count);
      const listQ = buildSerialLogQuery(opts, all === '1' ? undefined : { page: n, pageSize: size });
      const r = await pgPool.query(listQ.sql, listQ.params);
      return res.json({
        data: r.rows,
        page: all === '1' ? 1 : n,
        pageSize: all === '1' ? totalItems : size,
        totalItems,
        statusCounts,
      });
    }
    const { sql, params } = buildSerialLogQuery(opts);
    const r = await pgPool.query(sql, params);
    res.json(r.rows);
  } catch (err) {
    console.error('Error fetching serial log:', err);
    res.status(500).json({ message: 'Database error' });
  }

}

/** Forwarded from inventory.routes.ts (post_serialLog). */
