/**
 * Inventory controller — HTTP orchestration for the inventory domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { getPgConnected, pgPool, inventoryStock, products, setTransactionLogs, withPrepended, transactionLogs, getUserFromReq, damageRecords, setDamageRecords, withReplaced, branches, setInventoryStock, withAppended, broadcastChange, withTransaction, logAuditEvent, assetRegister, purchaseInvoices, setAssetRegister, stockOperations, customerDeviceRecords, detectDateTypeMismatch, findBsDayRecordForAdDate, issueNextDocNumber, getFiscalYearCodeForDate, getFiscalYearIdForDate, setStockOperations, serialLogs, mutable, setCustomerDeviceRecords, runSerialEditCapture, setSerialLogs, setDataVersion, getDataVersion } from '../app';
import { DamageRecord, TransactionLog, CustomerDeviceRecord, SerialLog } from '../../../client/src/types';
import { calculateFixedAssetValues } from '../../../client/src/utils/depreciation';
import { buildDamageRecordInsert, quarantineSerialsInDb, quarantineInMemorySerials, deriveDamageItems, validateReversalAvailability, buildReversalLedgerWithStock, restoreSerialsInDb, mirrorReversal, restoreInMemorySerials } from '../services/damage.service';
import { validateDualEditPayload, applyDualEdit, generateParkTag } from '../services/serialEditCapture.service';
import {
  buildStockListQuery,
  STOCK_FIND_BY_ID_SQL,
  STOCK_UPSERT_LEVELS_SQL,
  stockUpsertLevelsParams,
  STOCK_UPSERT_REORDER_SQL,
  stockUpsertReorderParams,
  STOCK_RECONCILE_UPSERT_SQL,
  stockReconcileUpsertParams,
  TXN_INSERT_NOW_SQL,
  miscPulloutTxnParams,
  TXN_INSERT_ON_CONFLICT_SQL,
  txnInsertOnConflictParams,
  DAMAGE_RECORD_ADJUSTMENT_SQL,
  damageAdjustmentParams,
  DAMAGE_RECORD_AUDIT_SHORTAGE_SQL,
  damageAuditShortageParams,
  DAMAGE_RECORD_CANCEL_SQL,
  buildAssetListQuery,
  ASSET_UPSERT_SQL,
  assetUpsertParams,
  ASSET_SET_STATUS_SQL,
  buildStockOperationListQuery,
  STOCK_OPERATION_INSERT_SQL,
  stockOperationInsertParams,
  STOCK_DAMAGE_APPLY_SQL,
  STOCK_RELEASE_DAMAGED_SQL,
  STOCK_CONSUME_QOH_SQL,
  STOCK_REVERSE_DAMAGE_SQL,
  STOCK_OPERATION_CANCEL_SQL,
  STOCK_OPERATION_FIND_FOR_RECEIVE_SQL,
  STOCK_OPERATION_SET_STATUS_SQL,
  PULLOUT_RECEIVE_STOCK_SQL,
  pulloutReceiveStockParams,
  buildCustomerDeviceListQuery,
  CDR_DUPLICATE_CHECK_SQL,
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
  CDR_CUSTOMER_COUNT_UPSERT_SQL,
  customerCountUpsertParams,
  buildSerialLookupSql,
  buildSerialLogQuery,
  SERIAL_LOG_FIND_BY_DEVICE_SQL,
  SERIAL_LOG_UPDATE_SQL,
  serialLogUpdateParams,
  SERIAL_LOG_INSERT_SQL,
  serialLogInsertParams,
} from '../models/inventory.repo';
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
        quantityChanged: damDiff !== 0 ? -Math.abs(damDiff) : -(stk.damagedQty || 1),
        quantityAfter: stk.damagedQty || 0,
        unitCost: prod?.costPrice || 0,
        referenceDocId: reason || 'DMG-VERIFICATION',
        timestampAD: new Date().toISOString(),
        timestampBS: '2083-04-16 BS',
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
                damageDateBS: '2083-04-16 BS',
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
              damageDateBS: '2083-04-16 BS',
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
        timestampBS: '2083-04-16 BS',
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
            timestampBS: '2083-04-22 BS',
          };
          setTransactionLogs(withPrepended(transactionLogs, newTxn));

          await client.query(TXN_INSERT_NOW_SQL, miscPulloutTxnParams(newTxn));

          // Physical audit reconciliation also records the damage lifecycle:
          // a negative shortage for a product that already has damaged stock is
          // reflected in the damage register so it shows up in the ledger.
          if (delta < 0 && Number(item.damagedQty ?? stk.damagedQty ?? 0) > 0) {
            const damageQtyRec = Number(item.damagedQty ?? stk.damagedQty ?? 0);
            await client.query(
              DAMAGE_RECORD_AUDIT_SHORTAGE_SQL,
              damageAuditShortageParams({
                id: `dmr-audit-${auditRefNumber || 'AUD'}-${item.productId}`,
                damageReference: `AUDIT-${auditRefNumber || Date.now()}-${item.productId}`,
                productId: item.productId,
                branchId,
                quantityDamaged: Math.min(damageQtyRec, Math.abs(delta)),
                unitCost: unitCost || prod?.costPrice || 0,
                totalCost: (unitCost || prod?.costPrice || 0) * Math.min(damageQtyRec, Math.abs(delta)),
                damageDateAD: new Date().toISOString().split('T')[0],
                damageDateBS: '2083-04-22 BS',
                approvedBy: auditorName || userEmail || 'AUDITOR',
                notes: notes || `Physical audit shortage write-off (${auditRefNumber || 'DIRECT'})`,
                createdBy: userEmail || 'system',
              })
            );
          }
        }
      });
    } else {
      for (const item of varianceItems) {
        let stk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === branchId);
        if (stk) {
          const qtyBefore = stk.quantityOnHand || 0;
          const targetCounted = Number(item.countedQty) || 0;
          const delta = targetCounted - qtyBefore;
          stk.quantityOnHand = targetCounted;
          stk.lastUpdated = new Date().toISOString();
          totalAdjusted += 1;
          netFinancialImpact += delta * (item.unitCost || 0);
        }
      }
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
export async function get_assets(req: any, res: Response): Promise<any> {
const { branchId } = req.query;
  if (getPgConnected()) {
    try {
      const { sql: q, params } = buildAssetListQuery(branchId);
      const r = await pgPool.query(q, params);
      return res.json(r.rows.map((asset: any) => ({
        ...asset,
        ...calculateFixedAssetValues({
          ...asset,
          acquisitionDateAD: asset.placedInServiceDateAD || asset.acquisitionDateAD,
          asOfDateAD: new Date().toISOString().slice(0, 10),
        }),
      })));
    } catch (err) {
      console.error('Error fetching assets from DB:', err);
    }
  }
  const filtered = branchId && branchId !== 'ALL'
    ? assetRegister.filter((a) => a.branchId === branchId)
    : assetRegister;
  return res.json(filtered.map((asset) => ({
    ...asset,
    ...calculateFixedAssetValues({
      ...asset,
      acquisitionDateAD: asset.placedInServiceDateAD || asset.acquisitionDateAD,
      asOfDateAD: new Date().toISOString().slice(0, 10),
    }),
  })));

}

/** Forwarded from inventory.routes.ts (post_assets). */
export async function post_assets(req: any, res: Response): Promise<any> {
try {
    const tagNum = req.body.tagNumber || req.body.assetTag || `AST-${Math.floor(1000 + Math.random() * 9000)}`;
    const newAsset = {
      id: req.body.id || `ast-${Date.now()}`,
      tagNumber: tagNum,
      name: req.body.name || 'Fixed Asset',
      category: req.body.category || 'Equipment',
      branchId: req.body.branchId || 'WH001',
      acquisitionDateAD: req.body.acquisitionDateAD || req.body.acquisitionDateAd || new Date().toISOString().split('T')[0],
      acquisitionDateBS: req.body.acquisitionDateBS || req.body.acquisitionDateBs || '2083-04-10 BS',
      purchaseInvoiceDateAD: req.body.purchaseInvoiceDateAD || req.body.purchaseInvoiceDateAd || req.body.acquisitionDateAD || req.body.acquisitionDateAd || new Date().toISOString().split('T')[0],
      purchaseInvoiceDateBS: req.body.purchaseInvoiceDateBS || req.body.purchaseInvoiceDateBs || req.body.acquisitionDateBS || req.body.acquisitionDateBs || '2083-04-10 BS',
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
    };

    const linkedInvoice = newAsset.purchaseInvoiceId
      ? purchaseInvoices.find((invoice) => invoice.id === newAsset.purchaseInvoiceId)
      : undefined;
    if (linkedInvoice && !req.body.purchaseInvoiceDateAD && !req.body.purchaseInvoiceDateAd) {
      newAsset.purchaseInvoiceDateAD = linkedInvoice.invoiceDateAD;
      newAsset.purchaseInvoiceDateBS = linkedInvoice.invoiceDateBS;
    }

    const computedValues = calculateFixedAssetValues({
      ...newAsset,
      acquisitionDateAD: newAsset.acquisitionDateAD,
    });
    newAsset.accumulatedDepreciation = computedValues.accumulatedDepreciation;
    newAsset.netBookValue = computedValues.netBookValue;
    const idx = assetRegister.findIndex((a) => a.id === newAsset.id);
    setAssetRegister(idx >= 0 ? withReplaced(assetRegister, idx, newAsset as any) : withPrepended(assetRegister, newAsset as any));

    if (getPgConnected()) {
      await pgPool.query(ASSET_UPSERT_SQL, assetUpsertParams(newAsset));
    }
    logAuditEvent(req, 'ASSIGN_FIXED_ASSET', 'FIXED_ASSETS', `Assigned / Registered Fixed Asset Tag #${newAsset.tagNumber} (${newAsset.name}) at branch ${newAsset.branchId}`);
    res.status(201).json(newAsset);
  } catch (err: any) {
    console.error('Error creating fixed asset:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from inventory.routes.ts (patch_status). */
export async function patch_status(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const asset = assetRegister.find((a) => a.id === id);
    if (asset) Object.assign(asset, req.body);

    if (getPgConnected()) {
      await pgPool.query(ASSET_SET_STATUS_SQL, [req.body.status || 'ACTIVE', id]);
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
const { branchId } = req.query;
  if (getPgConnected()) {
    try {
      const { sql: q, params } = buildStockOperationListQuery(branchId);
      const r = await pgPool.query(q, params);
      res.json(r.rows);
      return;
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
    const operationItems = items.length > 0
      ? items
      : req.body.productId
      ? [{ productId: req.body.productId, productName: req.body.productName || '', quantity: Math.abs(Number(req.body.quantityChanged) || 0), deviceSerials: req.body.deviceSerials || [] }]
      : [];
    const stockConsumingType = ['DAMAGE', 'PULLOUT', 'STOCK_OUT', 'CONSUMABLE_ISSUE'].includes(opType);
    if (stockConsumingType) {
      for (const item of operationItems) {
        const product = products.find((entry) => entry.id === item.productId);
        const stockRecord = inventoryStock.find((entry) => entry.productId === item.productId && entry.branchId === req.body.branchId);
        const quantity = Number(item.quantity) || 0;
        const availableQuantity = item.condition === 'DAMAGED_STOCK'
          ? Number(stockRecord?.damagedQty) || 0
          : Number(stockRecord?.quantityOnHand) || 0;
        if (!stockRecord || quantity < 1 || availableQuantity < quantity) {
          res.status(400).json({ message: `Insufficient inventory for ${item.productName || item.productId}. Available: ${availableQuantity}, requested: ${quantity}.` });
          return;
        }
        const isSerialized = product ? product.requiresSerialTracking !== false && product.trackingType !== 'QUANTITY_ONLY' : true;
        if (isSerialized) {
          const serialEntries = item.deviceSerials || [];
          if (serialEntries.length < quantity) {
            res.status(400).json({ message: `Serial/PON details are required for every unit of ${item.productName || item.productId}.` });
            return;
          }
          for (let index = 0; index < quantity; index += 1) {
            const serial = serialEntries[index];
            const device = customerDeviceRecords.find((entry) =>
              entry.deviceSerial?.trim().toUpperCase() === serial.deviceSerial?.trim().toUpperCase() &&
              entry.ponSerial?.trim().toUpperCase() === serial.ponSerial?.trim().toUpperCase() &&
              entry.branchId === req.body.branchId &&
              entry.status === 'IN_STOCK' &&
              (!product || entry.productName?.trim().toLowerCase() === product.name.trim().toLowerCase())
            );
            if (!device) {
              res.status(400).json({ message: `Device Serial/PON must match an IN_STOCK inventory record for ${item.productName || item.productId}.` });
              return;
            }
          }
        }
      }
    }
    let totalValue = 0;
    if (items.length > 0) {
      totalValue = items.reduce((sum: number, it: any) => sum + (it.totalValue || it.quantity * (it.unitCost || 0)), 0);
    } else if (req.body.quantityChanged && req.body.costPerUnit) {
      totalValue = Math.abs(req.body.quantityChanged) * req.body.costPerUnit;
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
    const bsDayForOp = await findBsDayRecordForAdDate(opDateAD);
    if (!bsDayForOp.found) {
      return res.status(400).json({
        message: `BS date is not available for ${opDateAD}. Please contact your system administrator for BS month seeding.`,
        bsDateMissing: true,
      });
    }

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
      dateBS: `${bsDayForOp.record.bsDate} BS`,
      totalValue,
      fiscalYear: req.body.fiscalYear || getFiscalYearCodeForDate(opDateAD),
      branchName: branchObj?.name || req.body.branchName || 'Branch',
      destinationWarehouseId: destWarehouseObj?.id || req.body.destinationWarehouseId || 'WH001',
      destinationWarehouseName: destWarehouseObj?.name || req.body.destinationWarehouseName || 'Headquarters Warehouse',
      status: req.body.status || (opType === 'PULLOUT' ? 'DISPATCHED' : 'LOGGED'),
    };

    // Keep the movement ledger authoritative for stock operations as well as
    // purchase invoices and transfers. Pullouts from damaged stock do not
    // change available quantity_on_hand, so they are intentionally excluded
    // from this quantity ledger.
    const operationTransactions: TransactionLog[] = operationItems
      .filter((item: any) => !(opType === 'PULLOUT' && item.condition === 'DAMAGED_STOCK'))
      .map((item: any, index: number) => {
        const stockRecord = inventoryStock.find(
          (entry) => entry.productId === item.productId && entry.branchId === newOp.branchId
        );
        const product = products.find((entry) => entry.id === item.productId);
        const quantity = Number(item.quantity) || 1;
        const quantityBefore = Number(stockRecord?.quantityOnHand) || 0;
        // DAMAGE ops move units from usable to damaged, still consuming
        // quantity_on_hand; DISPOSAL / PULLOUT / STOCK_OUT consume stock too.
        const quantityChanged = -(opType === 'DAMAGE' ? quantity : Math.abs(quantity));
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
          quantityAfter: Math.max(0, quantityBefore - quantity),
          unitCost: Number(item.unitCost ?? item.costPerUnit ?? newOp.costPerUnit) || product?.costPrice || 0,
          referenceDocId: newOp.referenceNumber,
          timestampAD: new Date(`${newOp.dateAD}T00:00:00.000Z`).toISOString(),
          timestampBS: newOp.dateBS,
        };
      });

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        await client.query(
          STOCK_OPERATION_INSERT_SQL,
          stockOperationInsertParams(newOp, opType, totalValue, JSON.stringify(items))
        );

        for (const item of operationItems) {
          const qty = Number(item.quantity) || 1;
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
    }
    const idx = stockOperations.findIndex((o) => o.id === newOp.id);
    setStockOperations(idx >= 0 ? withReplaced(stockOperations, idx, newOp) : withPrepended(stockOperations, newOp));
    if (stockConsumingType) {
      for (const item of operationItems) {
        const stockRecord = inventoryStock.find((entry) => entry.productId === item.productId && entry.branchId === newOp.branchId);
        const quantity = Number(item.quantity) || 0;
        if (stockRecord) {
          if (opType === 'PULLOUT' && item.condition === 'DAMAGED_STOCK') {
            stockRecord.damagedQty = Math.max(0, (stockRecord.damagedQty || 0) - quantity);
          } else {
            stockRecord.quantityOnHand -= quantity;
          }
          if (opType === 'DAMAGE') {
            stockRecord.damagedQty = (stockRecord.damagedQty || 0) + quantity;
            // Mirror the serial quarantine (IN_STOCK → DAMAGED) into the
            // in-memory register so the Serial Log Register UI reflects it
            // without a reload.
            quarantineInMemorySerials(serialLogs, [item] as any, newOp as any);
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
    console.error('Error creating stock operation:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
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

    const opIndex = stockOperations.findIndex((o) => o.id === id);
    if (opIndex < 0) {
      res.status(404).json({ message: 'Stock operation not found.' });
      return;
    }
    const op = stockOperations[opIndex];
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

    const reversalLedger: TransactionLog[] = buildReversalLedgerWithStock(op, operationItems, {
      reversalDateAD,
      reversalDateBS,
      products,
      stockRows: inventoryStock,
    });

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        for (const item of operationItems) {
          const qty = Number(item.quantity) || 0;
          if (qty <= 0) continue;
          const result = await client.query(
            STOCK_REVERSE_DAMAGE_SQL,
            [qty, item.productId, op.branchId]
          );
          if (result.rowCount !== 1) {
            throw new Error(`Damaged stock changed before reversal could complete for ${item.productName || item.productId}.`);
          }
          await client.query(
            DAMAGE_RECORD_CANCEL_SQL,
            [`${op.referenceNumber}-${item.productId}`, `dmr-${op.id}-${item.productId}`, reason, reversedBy]
          );

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

        for (const txn of reversalLedger) {
          await client.query(TXN_INSERT_ON_CONFLICT_SQL, txnInsertOnConflictParams(txn));
        }
      });
    }

    // Update the caches (pure copies — the refresh fan-out will reconcile
    // against PostgreSQL) so the UI reflects the reversal immediately.
    const { updatedOp, stockRows, damageRecords: cancelledRecords } = mirrorReversal(
      op,
      operationItems,
      { reason, reversedBy, reversalDateAD, reversalDateBS },
      { stockRows: inventoryStock, damageRecords }
    );
    setStockOperations(withReplaced(stockOperations, opIndex, updatedOp));
    setInventoryStock(stockRows);
    setDamageRecords(cancelledRecords);

    // Mirror the serial restoration into the in-memory register too.
    restoreInMemorySerials(
      mutable(serialLogs),
      operationItems.flatMap((item: any) => (Array.isArray(item.deviceSerials) ? item.deviceSerials : [])),
      op,
      `Restored — damage ${op.referenceNumber} reversed by ${reversedBy}: ${reason}`,
      reversalDateAD
    );

    setTransactionLogs([
      ...reversalLedger.filter((txn) => !transactionLogs.some((entry) => entry.id === txn.id)),
      ...transactionLogs,
    ]);

    logAuditEvent(req, 'REVERSE_STOCK_DAMAGE', 'STOCK_OPERATIONS', `Reversed damage record ${op.referenceNumber} — ${reason}`);
    res.json({ message: 'Damage record reversed successfully. Units restored to available stock.', operation: updatedOp });
  } catch (err: any) {
    console.error('Error reversing stock operation:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from inventory.routes.ts (post_receive). */
export async function post_receive(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    let op = stockOperations.find((o) => o.id === id);
    if (op && op.status === 'RECEIVED') {
      res.status(409).json({ message: 'This stock operation has already been received.' });
      return;
    }

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        const current = await client.query(STOCK_OPERATION_FIND_FOR_RECEIVE_SQL, [id]);
        if (!current.rows[0]) throw new Error('Stock operation not found.');
        if (current.rows[0].status === 'RECEIVED') throw new Error('This stock operation has already been received.');
        await client.query(STOCK_OPERATION_SET_STATUS_SQL, ['RECEIVED', id]);
        const whId = current.rows[0].destinationWarehouseId || op?.destinationWarehouseId || 'WH001';
        const items = typeof current.rows[0].items === 'string' ? JSON.parse(current.rows[0].items) : (current.rows[0].items || op?.items || []);
        for (const item of items) {
          const qty = Number(item.quantity) || 1;
          await client.query(PULLOUT_RECEIVE_STOCK_SQL, pulloutReceiveStockParams(whId, item));
        }
      });
    }
    if (op) op.status = 'RECEIVED';
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

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        if (assignmentDelta !== 0 && product) {
          const stockChange = assignmentDelta < 0 ? 1 : -1;
          const stockResult = await client.query(
            CDR_ASSIGNMENT_STOCK_SQL,
            cdrAssignmentStockParams(stockChange, product.id, branchId, assignmentDelta > 0 ? 1 : 0)
          );
          if (stockResult.rowCount !== 1) throw new Error(`Insufficient available stock for ${newRecord.productName}.`);
        }
        await client.query(
          CDR_UPSERT_SQL,
          customerDeviceInsertParams({
            ...newRecord,
            customerId: newRecord.customerId || custCode,
            customerCode: custCode,
            branchId,
            status: nextStatus,
            issuedDateAD: newRecord.issuedDateAD || new Date().toISOString().split('T')[0],
            issuedDateBS: newRecord.issuedDateBS || '2083-04-16 BS',
          } as CustomerDeviceRecord)
        );

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
    } else if (assignmentDelta !== 0 && product) {
      const stockRecord = inventoryStock.find((entry) => entry.productId === product.id && entry.branchId === branchId);
      if (!stockRecord || (assignmentDelta > 0 && stockRecord.quantityOnHand < 1)) {
        res.status(400).json({ message: `Insufficient available stock for ${newRecord.productName}.` });
        return;
      }
      stockRecord.quantityOnHand -= assignmentDelta;
      stockRecord.lastUpdated = new Date().toISOString();
    }
    const idx = customerDeviceRecords.findIndex((c) => c.id === newRecord.id);
    setCustomerDeviceRecords(idx >= 0
      ? withReplaced(customerDeviceRecords, idx, { ...newRecord, status: nextStatus, branchId })
      : withPrepended(customerDeviceRecords, { ...newRecord, status: nextStatus, branchId }));
    logAuditEvent(req, 'ASSIGN_CUSTOMER_CPE', 'CPE_MANAGEMENT', `Assigned CPE Device Serial ${newRecord.deviceSerial} (PON: ${newRecord.ponSerial || 'N/A'}) to customer ${newRecord.customerName}`, newRecord.branchId);
    res.status(201).json(newRecord);
  } catch (err: any) {
    console.error('Error adding customer device:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
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
      await pgPool.query(CDR_UPDATE_STATUS_SQL, [newStatusStr, id]);
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
export async function get_lookup2(req: any, res: Response): Promise<any> {
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

/** Forwarded from inventory.routes.ts (get_lookup3). */
export async function get_lookup3(req: any, res: Response): Promise<any> {
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
try {
    const {
      oldDeviceId,
      exchangeReason,
      oldDeviceAction,
      newProductName,
      newDeviceSerial,
      newPonSerial,
      newMacAddress,
      notes,
      branchId,
    } = req.body;

    let oldRecord = customerDeviceRecords.find((c) => c.id === oldDeviceId);
    if (getPgConnected() && !oldRecord) {
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

    if (!oldRecord) return res.status(404).json({ message: 'Old customer device record not found' });

    const dateStrAD = new Date().toISOString().split('T')[0];

    oldRecord.status = 'EXCHANGED';
    oldRecord.notes = `[EXCHANGED on ${dateStrAD}] Reason: ${exchangeReason || 'Defective / Replacement'}. Old device disposition: ${oldDeviceAction}. Replacement SN: ${newDeviceSerial}. ${oldRecord.notes || ''}`;

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
      issuedDateBS: '2083-04-28 BS',
      purchaseBillRef: oldRecord.purchaseBillRef,
      notes: `[REPLACEMENT DEVICE] Replaced previous SN ${oldRecord.deviceSerial} on ${dateStrAD}. ${notes || ''}`,
    };

    setCustomerDeviceRecords(withPrepended(customerDeviceRecords, newRecord));

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        await client.query(CDR_EXCHANGE_STATUS_SQL, ['EXCHANGED', oldRecord.notes, oldDeviceId]);

        await client.query(CDR_EXCHANGE_INSERT_SQL, customerDeviceInsertParams(newRecord));
      });
    }
    logAuditEvent(req, 'DEVICE_EXCHANGE', 'CPE_MANAGEMENT', `Exchanged CPE Device for ${oldRecord.customerName}. Replaced SN ${oldRecord.deviceSerial} -> New SN ${newDeviceSerial}`, oldRecord.branchId);
    res.status(201).json({ oldRecord, newRecord, message: 'Customer device successfully exchanged and inventory synchronized.' });
  } catch (err: any) {
    console.error('Error exchanging customer device:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from inventory.routes.ts (get_serialLog). */
export async function get_serialLog(req: any, res: Response): Promise<any> {
try {
    const { branchId, status, query } = req.query;
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
    const { sql, params } = buildSerialLogQuery({ branchScope, globalBranchId, status, query });
    const r = await pgPool.query(sql, params);
    res.json(r.rows);
  } catch (err) {
    console.error('Error fetching serial log:', err);
    res.status(500).json({ message: 'Database error' });
  }

}

/** Forwarded from inventory.routes.ts (post_serialLog). */
export async function post_serialLog(req: any, res: Response): Promise<any> {
try {
    const { deviceSerial, ponSerial, macAddress, productId, productName, branchId, customerId, customerName, status, sourceType, sourceId, notes } = req.body;
    const serial = String(deviceSerial || '').trim();
    if (!serial) return res.status(400).json({ message: 'deviceSerial is required' });
    const st = status || 'IN_STOCK';
    const src = sourceType || 'PURCHASE';
    const now = new Date().toISOString();
    const historyEntry = { status: st, sourceType: src, sourceId: sourceId || null, dateAD: now.slice(0, 10), notes: notes || null };
    // Upsert keyed on the unique lower(device_serial) index so one serial = one row.
    const existing = await pgPool.query(SERIAL_LOG_FIND_BY_DEVICE_SQL, [serial]);
    let id: string;
    let history: any[];
    if (existing.rows.length > 0) {
      id = existing.rows[0].id;
      try { history = JSON.parse(existing.rows[0].history_json || '[]'); } catch { history = []; }
      history.push(historyEntry);
      await pgPool.query(
        SERIAL_LOG_UPDATE_SQL,
        serialLogUpdateParams({
          ponSerial: ponSerial || null,
          macAddress: macAddress || null,
          productId: productId || null,
          productName: productName || null,
          branchId: branchId || null,
          customerId: customerId || null,
          customerName: customerName || null,
          status: st,
          sourceType: src,
          sourceId: sourceId || null,
          historyJson: JSON.stringify(history),
          updatedAt: now,
          id,
        })
      );
    } else {
      id = `sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      history = [historyEntry];
      await pgPool.query(
        SERIAL_LOG_INSERT_SQL,
        serialLogInsertParams({
          id,
          deviceSerial: serial,
          ponSerial: ponSerial || null,
          macAddress: macAddress || null,
          productId: productId || null,
          productName: productName || null,
          branchId: branchId || null,
          customerId: customerId || null,
          customerName: customerName || null,
          status: st,
          sourceType: src,
          sourceId: sourceId || null,
          historyJson: JSON.stringify(history),
          timestamp: now,
        })
      );
    }
    const entry: SerialLog = { id, deviceSerial: serial, ponSerial, macAddress, productId, productName, branchId, customerId, customerName, status: st, sourceType: src, sourceId, history, createdAt: now, updatedAt: now };
    const idx = serialLogs.findIndex((s) => s.id === id);
    setSerialLogs(idx >= 0 ? withReplaced(serialLogs, idx, entry) : withPrepended(serialLogs, entry));
    logAuditEvent(req, 'SERIAL_LOG_UPSERT', 'INVENTORY', `Serial ${serial} logged as ${st} (${src})`);
    setDataVersion(getDataVersion() + 1);
    res.json({ success: true, id });
  } catch (err: any) {
    console.error('Error creating serial log entry:', err);
    res.status(500).json({ message: err.message });
  }

}

