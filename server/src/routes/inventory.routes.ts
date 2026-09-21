/**
 * Inventory routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerInventoryRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import {
  assetRegister,
  branches,
  broadcastChange,
  customerDeviceRecords,
  damageRecords,
  detectDateTypeMismatch,
  findBsDayRecordForAdDate,
  getDataVersion,
  getFiscalYearCodeForDate,
  getFiscalYearIdForDate,
  getPgConnected,
  getUserFromReq,
  handleUpdateSerials,
  inventoryStock,
  issueNextDocNumber,
  logAuditEvent,
  mutable,
  products,
  purchaseInvoices,
  requirePermission,
  requireRole,
  requireStockOperationPermission,
  runSerialEditCapture,
  serialLogs,
  setAssetRegister,
  setCustomerDeviceRecords,
  setDamageRecords,
  setDataVersion,
  setInventoryStock,
  setSerialLogs,
  setStockOperations,
  setTransactionLogs,
  stockOperations,
  transactionLogs,
  users,
  withAppended,
  withPrepended,
  withReplaced,
  withTransaction,
} from '../app';
import { pgPool } from '../app';
import { calculateFixedAssetValues } from '../../../client/src/utils/depreciation';
import { buildDamageRecordInsert, buildReversalLedgerWithStock, deriveDamageItems, mirrorReversal, quarantineInMemorySerials, quarantineSerialsInDb, restoreInMemorySerials, restoreSerialsInDb, validateReversalAvailability } from '../services/damage.service';
import { applyDualEdit, generateParkTag, validateDualEditPayload } from '../services/serialEditCapture.service';
import type { CustomerDeviceRecord, DamageRecord, SerialLog, TransactionLog } from '../../../client/src/types';

export function registerInventoryRoutes(app: Express) {
app.get('/api/stock', async (req, res) => {
  const { branchId } = req.query;
  if (getPgConnected()) {
    try {
      let sql = `SELECT id, product_id AS "productId", branch_id AS "branchId", quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty", reserved_qty AS "reservedQty", incoming_qty AS "incomingQty", min_reorder_level AS "minReorderLevel", last_updated AS "lastUpdated" FROM inventory_stock`;
      const params: any[] = [];
      if (branchId && branchId !== 'ALL') {
        sql += ` WHERE branch_id = $1`;
        params.push(branchId);
      }
      sql += ` ORDER BY branch_id, product_id`;
      const r = await pgPool.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching stock from DB:', err);
    }
  }
  if (branchId && branchId !== 'ALL') {
    return res.json(inventoryStock.filter((s) => s.branchId === branchId));
  }
  res.json(inventoryStock);
});

app.patch('/api/stock/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { quantityOnHand, minReorderLevel, damagedQty, reason, changeType } = req.body;
    for (const [field, value] of Object.entries({ quantityOnHand, minReorderLevel, damagedQty })) {
      if (value !== undefined && (!Number.isInteger(Number(value)) || Number(value) < 0)) {
        return res.status(400).json({ message: `${field} must be a non-negative integer.` });
      }
    }
    let stk = inventoryStock.find((s) => s.id === id);

    if (getPgConnected() && !stk) {
      const r = await pgPool.query(
        'SELECT id, product_id AS "productId", branch_id AS "branchId", quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty", reserved_qty AS "reservedQty", incoming_qty AS "incomingQty", min_reorder_level AS "minReorderLevel" FROM inventory_stock WHERE id = $1',
        [id]
      );
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
      await pgPool.query(
        `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level, last_updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (id) DO UPDATE SET
           quantity_on_hand = EXCLUDED.quantity_on_hand,
           damaged_qty = EXCLUDED.damaged_qty,
           min_reorder_level = EXCLUDED.min_reorder_level,
           last_updated = NOW();`,
        [stk.id, stk.productId, stk.branchId, stk.quantityOnHand || 0, stk.damagedQty || 0, stk.reservedQty || 0, stk.incomingQty || 0, stk.minReorderLevel || 5]
      );
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
        await pgPool.query(
          `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13);`,
          [newTxn.id, newTxn.transactionNumber, newTxn.productId, newTxn.productSku, newTxn.productName, newTxn.branchId, newTxn.changeType, newTxn.quantityBefore, newTxn.quantityChanged, newTxn.quantityAfter, newTxn.unitCost, newTxn.referenceDocId, newTxn.timestampBS]
        );
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
              `INSERT INTO damage_records (
                 id, damage_reference, product_id, branch_id, quantity_damaged, unit_cost, total_cost,
                 damage_date_ad, damage_date_bs, damage_reason, status, salvage_value, gl_account_code,
                 write_off_loss, approved_by, notes, is_demo, created_by
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'IDENTIFIED', 0, 'GL-5120 (Loss on Inventory Scrap & Write-off)', 0, $11, $12, FALSE, $13)
               ON CONFLICT (id) DO NOTHING`,
              [
                damageRecordId,
                damageRef,
                stk.productId,
                stk.branchId,
                absAffected,
                prod?.costPrice || 0,
                (prod?.costPrice || 0) * absAffected,
                todayAD,
                '2083-04-16 BS',
                damageReason,
                getUserFromReq(req).name || 'Stock Manager',
                reason || 'Damaged stock balance verification',
                getUserFromReq(req).email || 'system',
              ]
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
        await pgPool.query(
          `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13);`,
          [newTxn.id, newTxn.transactionNumber, newTxn.productId, newTxn.productSku, newTxn.productName, newTxn.branchId, newTxn.changeType, newTxn.quantityBefore, newTxn.quantityChanged, newTxn.quantityAfter, newTxn.unitCost, newTxn.referenceDocId, newTxn.timestampBS]
        );
      }
    }
  } catch (err: any) {
    console.error('Error updating stock level:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.patch('/api/stock/:id/reorder-level', async (req, res) => {
  try {
    const { id } = req.params;
    const { minReorderLevel, productId, branchId } = req.body;
    if (!Number.isInteger(Number(minReorderLevel)) || Number(minReorderLevel) < 0) {
      return res.status(400).json({ message: 'Reorder level must be a non-negative integer.' });
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
      return res.status(404).json({ message: 'Stock record not found' });
    }

    stk.minReorderLevel = Number(minReorderLevel);
    stk.lastUpdated = new Date().toISOString();

    if (getPgConnected()) {
      await pgPool.query(
        `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET min_reorder_level = $8`,
        [
          stk.id,
          stk.productId,
          stk.branchId,
          stk.quantityOnHand || 0,
          stk.damagedQty || 0,
          stk.reservedQty || 0,
          stk.incomingQty || 0,
          stk.minReorderLevel,
        ]
      );
    }
    broadcastChange({ type: 'STOCK_UPDATED', entity: 'stock', branchId: stk.branchId });
    res.json(stk);
  } catch (err: any) {
    console.error('Error setting reorder level:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.post('/api/stock/bulk-reorder-levels', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER'), async (req, res) => {
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

              await client.query(
                `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (id) DO UPDATE SET min_reorder_level = $8`,
                [
                  stk.id,
                  stk.productId,
                  stk.branchId,
                  stk.quantityOnHand || 0,
                  stk.damagedQty || 0,
                  stk.reservedQty || 0,
                  stk.incomingQty || 0,
                  stk.minReorderLevel,
                ]
              );
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
});

app.post('/api/stock/reconcile-audit', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER', 'AUDITOR'), async (req, res) => {
  try {
    const { branchId, auditRefNumber, varianceItems, auditorName, userEmail, notes } = req.body;
    if (!branchId || !Array.isArray(varianceItems)) {
      return res.status(400).json({ message: 'Invalid stock reconciliation payload' });
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

          await client.query(
            `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET quantity_on_hand = EXCLUDED.quantity_on_hand;`,
            [stk.id, stk.productId, stk.branchId, stk.quantityOnHand, stk.damagedQty || 0, stk.reservedQty || 0, stk.incomingQty || 0]
          );

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

          await client.query(
            `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13);`,
            [newTxn.id, newTxn.transactionNumber, newTxn.productId, newTxn.productSku, newTxn.productName, newTxn.branchId, newTxn.changeType, newTxn.quantityBefore, newTxn.quantityChanged, newTxn.quantityAfter, newTxn.unitCost, newTxn.referenceDocId, newTxn.timestampBS]
          );

          // Physical audit reconciliation also records the damage lifecycle:
          // a negative shortage for a product that already has damaged stock is
          // reflected in the damage register so it shows up in the ledger.
          if (delta < 0 && Number(item.damagedQty ?? stk.damagedQty ?? 0) > 0) {
            const damageQtyRec = Number(item.damagedQty ?? stk.damagedQty ?? 0);
            await client.query(
              `INSERT INTO damage_records (
                 id, damage_reference, product_id, branch_id, quantity_damaged, unit_cost, total_cost,
                 damage_date_ad, damage_date_bs, damage_reason, status, salvage_value, gl_account_code,
                 write_off_loss, approved_by, notes, is_demo, created_by
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OTHER', 'IDENTIFIED', 0, 'GL-5120 (Loss on Inventory Scrap & Write-off)', 0, $10, $11, FALSE, $12)
               ON CONFLICT (id) DO NOTHING`,
              [
                `dmr-audit-${auditRefNumber || 'AUD'}-${item.productId}`,
                `AUDIT-${auditRefNumber || Date.now()}-${item.productId}`,
                item.productId,
                branchId,
                Math.min(damageQtyRec, Math.abs(delta)),
                unitCost || prod?.costPrice || 0,
                (unitCost || prod?.costPrice || 0) * Math.min(damageQtyRec, Math.abs(delta)),
                new Date().toISOString().split('T')[0],
                '2083-04-22 BS',
                auditorName || userEmail || 'AUDITOR',
                notes || `Physical audit shortage write-off (${auditRefNumber || 'DIRECT'})`,
                userEmail || 'system',
              ]
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
});

app.get('/api/assets', async (req, res) => {
  const { branchId } = req.query;
  if (getPgConnected()) {
    try {
      const q =
        'SELECT id, tag_number AS "tagNumber", name, category, branch_id AS "branchId", acquisition_date_ad AS "acquisitionDateAD", acquisition_date_bs AS "acquisitionDateBS", purchase_invoice_date_ad AS "purchaseInvoiceDateAD", purchase_invoice_date_bs AS "purchaseInvoiceDateBS", capitalization_date_ad AS "capitalizationDateAD", placed_in_service_date_ad AS "placedInServiceDateAD", acquisition_cost AS "acquisitionCost", depreciation_method AS "depreciationMethod", depreciation_rate_percent AS "depreciationRatePercent", accumulated_depreciation AS "accumulatedDepreciation", net_book_value AS "netBookValue", status, supplier_name AS "supplierName", invoice_no AS "invoiceNo", purchase_invoice_id AS "purchaseInvoiceId", product_id AS "productId" FROM fixed_assets' +
        (branchId && branchId !== 'ALL' ? ' WHERE branch_id = $1' : '') +
        ' ORDER BY created_at DESC';
      const params = branchId && branchId !== 'ALL' ? [branchId] : [];
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
});

app.post('/api/assets', requirePermission('assets-manage'), async (req, res) => {
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
      await pgPool.query(
        `INSERT INTO fixed_assets (
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
           status = EXCLUDED.status;`,
        [
          newAsset.id,
          newAsset.tagNumber,
          newAsset.name,
          newAsset.category,
          newAsset.branchId,
          newAsset.acquisitionDateAD,
          newAsset.acquisitionDateBS,
          newAsset.purchaseInvoiceDateAD,
          newAsset.purchaseInvoiceDateBS,
          newAsset.capitalizationDateAD,
          newAsset.placedInServiceDateAD,
          newAsset.acquisitionCost,
          newAsset.depreciationMethod,
          newAsset.depreciationRatePercent,
          newAsset.accumulatedDepreciation,
          newAsset.netBookValue,
          newAsset.status,
          newAsset.supplierName,
          newAsset.invoiceNo,
          newAsset.purchaseInvoiceId,
          newAsset.productId,
        ]
      );
    }
    logAuditEvent(req, 'ASSIGN_FIXED_ASSET', 'FIXED_ASSETS', `Assigned / Registered Fixed Asset Tag #${newAsset.tagNumber} (${newAsset.name}) at branch ${newAsset.branchId}`);
    res.status(201).json(newAsset);
  } catch (err: any) {
    console.error('Error creating fixed asset:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.patch('/api/assets/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const asset = assetRegister.find((a) => a.id === id);
    if (asset) Object.assign(asset, req.body);

    if (getPgConnected()) {
      await pgPool.query('UPDATE fixed_assets SET status = $1 WHERE id = $2', [req.body.status || 'ACTIVE', id]);
    }
    logAuditEvent(req, 'UPDATE_ASSET_STATUS', 'FIXED_ASSETS', `Updated Fixed Asset status to ${req.body.status || 'UPDATED'}`);
    res.json(asset || req.body);
  } catch (err: any) {
    console.error('Error updating asset status:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.get('/api/stock-operations', async (req, res) => {
  const { branchId } = req.query;
  if (getPgConnected()) {
    try {
      const q =
        'SELECT id, reference_number AS "referenceNumber", type, technician_name AS "technicianName", work_order_ref AS "workOrderRef", branch_id AS "branchId", branch_name AS "branchName", destination_warehouse_id AS "destinationWarehouseId", destination_warehouse_name AS "destinationWarehouseName", product_id AS "productId", quantity_changed AS "quantityChanged", cost_per_unit AS "costPerUnit", total_value AS "totalValue", reason, inspector_name AS "inspectorName", date_ad AS "dateAD", date_bs AS "dateBS", fiscal_year AS "fiscalYear", status, items FROM stock_operations' +
        (branchId && branchId !== 'ALL' ? ' WHERE branch_id = $1 OR destination_warehouse_id = $1' : '') +
        ' ORDER BY created_at DESC';
      const params = branchId && branchId !== 'ALL' ? [branchId] : [];
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
});

app.post('/api/stock-operations', requireStockOperationPermission, async (req, res) => {
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
          return res.status(400).json({ message: `Insufficient inventory for ${item.productName || item.productId}. Available: ${availableQuantity}, requested: ${quantity}.` });
        }
        const isSerialized = product ? product.requiresSerialTracking !== false && product.trackingType !== 'QUANTITY_ONLY' : true;
        if (isSerialized) {
          const serialEntries = item.deviceSerials || [];
          if (serialEntries.length < quantity) {
            return res.status(400).json({ message: `Serial/PON details are required for every unit of ${item.productName || item.productId}.` });
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
              return res.status(400).json({ message: `Device Serial/PON must match an IN_STOCK inventory record for ${item.productName || item.productId}.` });
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
      return res.status(400).json({ message: opDateMismatch, dateTypeMismatch: true });
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
        `INSERT INTO stock_operations (
           id, reference_number, type, technician_name, work_order_ref, branch_id, branch_name, destination_warehouse_id, destination_warehouse_name, product_id, quantity_changed, cost_per_unit, total_value, reason, inspector_name, date_ad, date_bs, fiscal_year, status, items
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           items = EXCLUDED.items;`,
        [
          newOp.id,
          newOp.referenceNumber,
          opType,
          newOp.technicianName || null,
          newOp.workOrderRef || null,
          newOp.branchId || 'WH001',
          newOp.branchName,
          newOp.destinationWarehouseId,
          newOp.destinationWarehouseName,
          newOp.productId || null,
          Number(newOp.quantityChanged) || 0,
          Number(newOp.costPerUnit) || 0,
          totalValue,
          newOp.reason || '',
          newOp.inspectorName || null,
          newOp.dateAD,
          newOp.dateBS,
          newOp.fiscalYear,
          newOp.status,
          JSON.stringify(items),
        ]
        );

        for (const item of operationItems) {
          const qty = Number(item.quantity) || 1;
          let result;
          if (opType === 'DAMAGE') {
            result = await client.query(
            `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, damaged_qty = damaged_qty + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`,
            [qty, item.productId, newOp.branchId]
            );
          } else if (opType === 'PULLOUT') {
            result = await client.query(
            item.condition === 'DAMAGED_STOCK'
              ? `UPDATE inventory_stock SET damaged_qty = damaged_qty - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND damaged_qty >= $1;`
              : `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`,
              [qty, item.productId, newOp.branchId]
            );
          } else if (opType === 'STOCK_OUT' || opType === 'CONSUMABLE_ISSUE') {
            result = await client.query(
            `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`,
              [qty, item.productId, newOp.branchId]
            );
          }
          if (stockConsumingType && result && result.rowCount !== 1) {
            throw new Error(`Stock changed before this operation could be posted for ${item.productName || item.productId}. Please retry.`);
          }
        }

        for (const txn of operationTransactions) {
          await client.query(
            `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (id) DO NOTHING`,
            [txn.id, txn.transactionNumber, txn.productId, txn.productSku, txn.productName, txn.branchId, txn.changeType, txn.quantityBefore, txn.quantityChanged, txn.quantityAfter, txn.unitCost, txn.referenceDocId, txn.timestampAD, txn.timestampBS]
          );
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
});

app.post('/api/stock-operations/:id/reverse', requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER'), requirePermission('branch-damage-mark'), async (req, res) => {
  try {
    const { id } = req.params;
    const reason = String(req.body.reason || '').trim();
    const reversedBy =
      (req.body.user && (req.body.user.name || req.body.user.email)) ||
      req.body.reversedBy ||
      'Super Admin';
    if (!reason) {
      return res.status(400).json({ message: 'A reversal reason is required as a safeguard before undoing a damage record.' });
    }

    const opIndex = stockOperations.findIndex((o) => o.id === id);
    if (opIndex < 0) {
      return res.status(404).json({ message: 'Stock operation not found.' });
    }
    const op = stockOperations[opIndex];
    if (op.type !== 'DAMAGE') {
      return res.status(400).json({ message: 'Only DAMAGE stock operations can be reversed.' });
    }
    if (op.status === 'CANCELLED') {
      return res.status(400).json({ message: 'This damage record has already been reversed.' });
    }

    const operationItems: any[] = deriveDamageItems(op);

    if (operationItems.length === 0) {
      return res.status(400).json({ message: 'No items were found on this damage operation to reverse.' });
    }

    // Pre-flight availability check (safeguard: refuse partial / mismatched reversals)
    const availabilityError = validateReversalAvailability(op, operationItems, inventoryStock);
    if (availabilityError) {
      return res.status(400).json({ message: availabilityError });
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
            `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand + $1, damaged_qty = damaged_qty - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND damaged_qty >= $1;`,
            [qty, item.productId, op.branchId]
          );
          if (result.rowCount !== 1) {
            throw new Error(`Damaged stock changed before reversal could complete for ${item.productName || item.productId}.`);
          }
          await client.query(
            `UPDATE damage_records SET status = 'CANCELLED', notes = COALESCE(notes, '') || ' | REVERSED (' || $3 || ') by ' || $4 WHERE (damage_reference = $1 OR id = $2) AND status <> 'CANCELLED';`,
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

        await client.query(
          `UPDATE stock_operations SET status = 'CANCELLED', updated_by = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2;`,
          [reversedBy, op.id]
        );

        for (const txn of reversalLedger) {
          await client.query(
            `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (id) DO NOTHING`,
            [txn.id, txn.transactionNumber, txn.productId, txn.productSku, txn.productName, txn.branchId, txn.changeType, txn.quantityBefore, txn.quantityChanged, txn.quantityAfter, txn.unitCost, txn.referenceDocId, txn.timestampAD, txn.timestampBS]
          );
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
});

app.post('/api/stock-operations/:id/receive', async (req, res) => {
  try {
    const { id } = req.params;
    let op = stockOperations.find((o) => o.id === id);
    if (op && op.status === 'RECEIVED') {
      return res.status(409).json({ message: 'This stock operation has already been received.' });
    }

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        const current = await client.query('SELECT status, destination_warehouse_id AS "destinationWarehouseId", items FROM stock_operations WHERE id = $1 FOR UPDATE', [id]);
        if (!current.rows[0]) throw new Error('Stock operation not found.');
        if (current.rows[0].status === 'RECEIVED') throw new Error('This stock operation has already been received.');
        await client.query('UPDATE stock_operations SET status = $1 WHERE id = $2', ['RECEIVED', id]);
        const whId = current.rows[0].destinationWarehouseId || op?.destinationWarehouseId || 'WH001';
        const items = typeof current.rows[0].items === 'string' ? JSON.parse(current.rows[0].items) : (current.rows[0].items || op?.items || []);
        for (const item of items) {
          const qty = Number(item.quantity) || 1;
          await client.query(
            `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty)
             VALUES ($1, $2, $3, $4, 0)
             ON CONFLICT (product_id, branch_id) DO UPDATE SET
               quantity_on_hand = inventory_stock.quantity_on_hand + $4,
               last_updated = CURRENT_TIMESTAMP;`,
            [`stk-${whId.toLowerCase()}-${item.productId}`, item.productId, whId, qty]
          );
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
});

app.get('/api/customer-devices', async (req, res) => {
  const { branchId, query } = req.query;

  if (getPgConnected()) {
    try {
      let sql = `SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", contact_phone AS "contactPhone", installation_address AS "installationAddress", branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", status, issued_date_ad AS "issuedDateAD", issued_date_bs AS "issuedDateBS", purchase_bill_ref AS "purchaseBillRef", notes FROM customer_device_records`;
      const params: any[] = [];
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

      const r = await pgPool.query(sql, params);
      return res.json(r.rows);
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
});

app.post('/api/customer-devices', requirePermission('customers-manage'), async (req, res) => {
  try {
    const newRecord: CustomerDeviceRecord = {
      id: req.body.id || `cust-${Date.now()}`,
      ...req.body,
    };
    const normalizedDeviceSerial = String(newRecord.deviceSerial || '').trim().toUpperCase();
    const normalizedPonSerial = String(newRecord.ponSerial || '').trim().toUpperCase();
    if (!normalizedDeviceSerial || !normalizedPonSerial) {
      return res.status(400).json({ message: 'Device serial and PON serial are required.' });
    }
    const duplicateLocal = customerDeviceRecords.find((record) =>
      record.id !== newRecord.id &&
      (String(record.deviceSerial || '').trim().toUpperCase() === normalizedDeviceSerial ||
        String(record.ponSerial || '').trim().toUpperCase() === normalizedPonSerial)
    );
    if (duplicateLocal) return res.status(409).json({ message: 'Device serial or PON serial is already registered.' });
    if (getPgConnected()) {
      const duplicateDb = await pgPool.query(
        `SELECT 1 FROM customer_device_records
         WHERE id <> $1 AND (UPPER(TRIM(device_serial)) = $2 OR UPPER(TRIM(pon_serial)) = $3) LIMIT 1`,
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
      const existingRecord = await pgPool.query('SELECT status FROM customer_device_records WHERE id = $1', [newRecord.id]);
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
            `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand + $1, last_updated = CURRENT_TIMESTAMP
             WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $4
             RETURNING quantity_on_hand`,
            [stockChange, product.id, branchId, assignmentDelta > 0 ? 1 : 0]
          );
          if (stockResult.rowCount !== 1) throw new Error(`Insufficient available stock for ${newRecord.productName}.`);
        }
        await client.query(
          `INSERT INTO customer_device_records (
           id, customer_id, customer_name, customer_code, contact_phone, installation_address, branch_id, product_name, device_serial, pon_serial, mac_address, status, issued_date_ad, issued_date_bs, purchase_bill_ref, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           branch_id = EXCLUDED.branch_id,
           notes = EXCLUDED.notes;`,
          [
          newRecord.id,
          newRecord.customerId || custCode,
          newRecord.customerName,
          custCode,
          newRecord.contactPhone || '',
          newRecord.installationAddress || '',
          branchId,
          newRecord.productName,
          newRecord.deviceSerial,
          newRecord.ponSerial || newRecord.deviceSerial,
          newRecord.macAddress || null,
          nextStatus,
          newRecord.issuedDateAD || new Date().toISOString().split('T')[0],
          newRecord.issuedDateBS || '2083-04-16 BS',
          newRecord.purchaseBillRef || null,
          newRecord.notes || '',
          ]
        );

        const countDelta = assignmentDelta;
        await client.query(
        `INSERT INTO customer_records (id, customer_id, customer_name, username, contact_number, branch_id, address, status, assigned_devices_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8)
         ON CONFLICT (customer_id) DO UPDATE SET
           assigned_devices_count = GREATEST(0, customer_records.assigned_devices_count + $8);`,
        [
          custCode || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
          custCode || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
          newRecord.customerName,
          newRecord.customerName.toLowerCase().replace(/\s+/g, '.'),
          newRecord.contactPhone || '9800000000',
          newRecord.branchId || 'WH001',
          newRecord.installationAddress || 'Nepal',
          countDelta,
        ]
        );
      });
    } else if (assignmentDelta !== 0 && product) {
      const stockRecord = inventoryStock.find((entry) => entry.productId === product.id && entry.branchId === branchId);
      if (!stockRecord || (assignmentDelta > 0 && stockRecord.quantityOnHand < 1)) {
        return res.status(400).json({ message: `Insufficient available stock for ${newRecord.productName}.` });
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
});

app.patch('/api/customer-devices/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    let record = customerDeviceRecords.find((c) => c.id === id);

    if (getPgConnected() && !record) {
      const r = await pgPool.query('SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", status FROM customer_device_records WHERE id = $1', [id]);
      if (r.rows.length > 0) record = r.rows[0];
    }
    if (!record) return res.status(404).json({ message: 'Customer device record not found' });

    const oldStatus = record.status;
    const isDisconn = status === 'DISCONNECTED' || status === 'ROUTER_COLLECTED';
    const newStatusStr = isDisconn ? 'ROUTER_COLLECTED' : status;

    record.status = newStatusStr;

    if (getPgConnected()) {
      await pgPool.query('UPDATE customer_device_records SET status = $1 WHERE id = $2', [newStatusStr, id]);
    }
    logAuditEvent(req, 'UPDATE_CPE_DEVICE_STATUS', 'CPE_MANAGEMENT', `Updated CPE Device ${record.deviceSerial} status from ${oldStatus} to ${newStatusStr}`, record.branchId);
    res.json(record);
  } catch (err: any) {
    console.error('Error updating CPE device status:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.patch('/api/inventory/serials', requirePermission('edit-device-serials'), handleUpdateSerials);
app.patch('/api/customer-devices/:id/serials', requirePermission('edit-device-serials'), handleUpdateSerials);

// ---------------------------------------------------------------------------
// Serial lookup — resolves a typed value (device serial, PON, or MAC) to the
// device that already holds it, across serial_log, customer_device_records,
// and fixed_assets. Powers the live duplicate detection in the serial edit
// modal so a conflicting device can be loaded into the second edit panel,
// even when it lives outside the user's branch-scoped register.
// ---------------------------------------------------------------------------
app.get('/api/inventory/serials/lookup', requirePermission('edit-device-serials'), async (req, res) => {
  try {
    const value = String(req.query.value || '').trim();
    const exclude = Array.isArray(req.query.exclude)
      ? req.query.exclude.map((v: any) => String(v || '').trim().toUpperCase()).filter(Boolean)
      : String(req.query.exclude || '').trim().toUpperCase()
        ? [String(req.query.exclude).trim().toUpperCase()]
        : [];
    if (!value) return res.status(400).json({ message: 'value query parameter is required.' });
    if (!getPgConnected()) return res.status(503).json({ message: 'Database not connected.' });

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

    // 1. serial_log (register — one row per serial)
    const slRes = await pgPool.query(
      `SELECT device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress",
              product_id AS "productId", product_name AS "productName", branch_id AS "branchId",
              customer_id AS "customerId", customer_name AS "customerName", status
       FROM serial_log
       WHERE (lower(trim(device_serial)) = lower(trim($1))
           OR lower(trim(pon_serial)) = lower(trim($1))
           OR lower(trim(mac_address)) = lower(trim($1)))${notSelf}
       LIMIT 1`,
      params
    );
    if (slRes.rows.length > 0) {
      return res.json({ ...slRes.rows[0], source: 'SERIAL_LOG' });
    }

    // 2. customer_device_records (customer assignments)
    const cdrRes = await pgPool.query(
      `SELECT device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress",
              product_name AS "productName", branch_id AS "branchId",
              customer_id AS "customerId", customer_name AS "customerName", status
       FROM customer_device_records
       WHERE (lower(trim(device_serial)) = lower(trim($1))
           OR lower(trim(pon_serial)) = lower(trim($1))
           OR lower(trim(mac_address)) = lower(trim($1)))${notSelf}
       LIMIT 1`,
      params
    );
    if (cdrRes.rows.length > 0) {
      return res.json({ ...cdrRes.rows[0], source: 'CUSTOMER_DEVICE' });
    }

    // 3. fixed_assets (device serial stored as tag_number)
    const faRes = await pgPool.query(
      `SELECT tag_number AS "deviceSerial", name AS "productName", branch_id AS "branchId"
       FROM fixed_assets
       WHERE lower(trim(tag_number)) = lower(trim($1))${notSelfAsset}
       LIMIT 1`,
      params
    );
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

    return res.status(404).json({ message: 'No device holds this serial.' });
  } catch (err: any) {
    console.error('Error looking up serial:', err);
    return res.status(500).json({ message: err.message || 'Database error' });
  }
});

app.patch('/api/customer-devices/:id/serials', requirePermission('edit-device-serials'), handleUpdateSerials);

// ---------------------------------------------------------------------------
// Serial lookup — resolves a typed value (device serial, PON, or MAC) to the
// device that already holds it, across serial_log, customer_device_records,
// and fixed_assets. Powers the live duplicate detection in the serial edit
// modal so a conflicting device can be loaded into the second edit panel,
// even when it lives outside the user's branch-scoped register.
// ---------------------------------------------------------------------------
app.get('/api/inventory/serials/lookup', requirePermission('edit-device-serials'), async (req, res) => {
  try {
    const value = String(req.query.value || '').trim();
    const exclude = Array.isArray(req.query.exclude)
      ? req.query.exclude.map((v: any) => String(v || '').trim().toUpperCase()).filter(Boolean)
      : String(req.query.exclude || '').trim().toUpperCase()
        ? [String(req.query.exclude).trim().toUpperCase()]
        : [];
    if (!value) return res.status(400).json({ message: 'value query parameter is required.' });
    if (!getPgConnected()) return res.status(503).json({ message: 'Database not connected.' });

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

    // 1. serial_log (register — one row per serial)
    const slRes = await pgPool.query(
      `SELECT device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress",
              product_id AS "productId", product_name AS "productName", branch_id AS "branchId",
              customer_id AS "customerId", customer_name AS "customerName", status
       FROM serial_log
       WHERE (lower(trim(device_serial)) = lower(trim($1))
           OR lower(trim(pon_serial)) = lower(trim($1))
           OR lower(trim(mac_address)) = lower(trim($1)))${notSelf}
       LIMIT 1`,
      params
    );
    if (slRes.rows.length > 0) {
      return res.json({ ...slRes.rows[0], source: 'SERIAL_LOG' });
    }

    // 2. customer_device_records (customer assignments)
    const cdrRes = await pgPool.query(
      `SELECT device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress",
              product_name AS "productName", branch_id AS "branchId",
              customer_id AS "customerId", customer_name AS "customerName", status
       FROM customer_device_records
       WHERE (lower(trim(device_serial)) = lower(trim($1))
           OR lower(trim(pon_serial)) = lower(trim($1))
           OR lower(trim(mac_address)) = lower(trim($1)))${notSelf}
       LIMIT 1`,
      params
    );
    if (cdrRes.rows.length > 0) {
      return res.json({ ...cdrRes.rows[0], source: 'CUSTOMER_DEVICE' });
    }

    // 3. fixed_assets (device serial stored as tag_number)
    const faRes = await pgPool.query(
      `SELECT tag_number AS "deviceSerial", name AS "productName", branch_id AS "branchId"
       FROM fixed_assets
       WHERE lower(trim(tag_number)) = lower(trim($1))${notSelfAsset}
       LIMIT 1`,
      params
    );
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

    return res.status(404).json({ message: 'No device holds this serial.' });
  } catch (err: any) {
    console.error('Error looking up serial:', err);
    return res.status(500).json({ message: err.message || 'Database error' });
  }
});

app.get('/api/inventory/serials/lookup', requirePermission('edit-device-serials'), async (req, res) => {
  try {
    const value = String(req.query.value || '').trim();
    const exclude = Array.isArray(req.query.exclude)
      ? req.query.exclude.map((v: any) => String(v || '').trim().toUpperCase()).filter(Boolean)
      : String(req.query.exclude || '').trim().toUpperCase()
        ? [String(req.query.exclude).trim().toUpperCase()]
        : [];
    if (!value) return res.status(400).json({ message: 'value query parameter is required.' });
    if (!getPgConnected()) return res.status(503).json({ message: 'Database not connected.' });

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

    // 1. serial_log (register — one row per serial)
    const slRes = await pgPool.query(
      `SELECT device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress",
              product_id AS "productId", product_name AS "productName", branch_id AS "branchId",
              customer_id AS "customerId", customer_name AS "customerName", status
       FROM serial_log
       WHERE (lower(trim(device_serial)) = lower(trim($1))
           OR lower(trim(pon_serial)) = lower(trim($1))
           OR lower(trim(mac_address)) = lower(trim($1)))${notSelf}
       LIMIT 1`,
      params
    );
    if (slRes.rows.length > 0) {
      return res.json({ ...slRes.rows[0], source: 'SERIAL_LOG' });
    }

    // 2. customer_device_records (customer assignments)
    const cdrRes = await pgPool.query(
      `SELECT device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress",
              product_name AS "productName", branch_id AS "branchId",
              customer_id AS "customerId", customer_name AS "customerName", status
       FROM customer_device_records
       WHERE (lower(trim(device_serial)) = lower(trim($1))
           OR lower(trim(pon_serial)) = lower(trim($1))
           OR lower(trim(mac_address)) = lower(trim($1)))${notSelf}
       LIMIT 1`,
      params
    );
    if (cdrRes.rows.length > 0) {
      return res.json({ ...cdrRes.rows[0], source: 'CUSTOMER_DEVICE' });
    }

    // 3. fixed_assets (device serial stored as tag_number)
    const faRes = await pgPool.query(
      `SELECT tag_number AS "deviceSerial", name AS "productName", branch_id AS "branchId"
       FROM fixed_assets
       WHERE lower(trim(tag_number)) = lower(trim($1))${notSelfAsset}
       LIMIT 1`,
      params
    );
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

    return res.status(404).json({ message: 'No device holds this serial.' });
  } catch (err: any) {
    console.error('Error looking up serial:', err);
    return res.status(500).json({ message: err.message || 'Database error' });
  }
});

app.post('/api/inventory/serials/dual', requirePermission('edit-device-serials'), async (req: any, res: any) => {
  try {
    const { a, b } = req.body || {};
    const validationError = validateDualEditPayload(a, b);
    if (validationError) {
      return res.status(validationError.status).json({ message: validationError.message });
    }

    const result = await applyDualEdit(runSerialEditCapture, req.user, a, b, generateParkTag());
    if (result.ok === false) {
      // One transaction per edit; a failed step leaves prior steps applied
      // (each step is itself atomic). The failure payload reports which step
      // failed so the client can show the exact conflict.
      return res.status(result.status).json(result.payload);
    }

    return res.json({ success: true, message: 'Serial corrections applied across all inventory records.', results: result.results });
  } catch (err: any) {
    console.error('Error applying dual serial correction:', err);
    return res.status(err.status || 500).json({ message: err.message || 'Database error' });
  }
});

app.post('/api/customer-devices/exchange', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'FIELD_TECHNICIAN', 'BRANCH_MANAGER'), async (req, res) => {
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
      const r = await pgPool.query('SELECT * FROM customer_device_records WHERE id = $1', [oldDeviceId]);
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
        await client.query('UPDATE customer_device_records SET status = $1, notes = $2 WHERE id = $3', ['EXCHANGED', oldRecord.notes, oldDeviceId]);

        await client.query(
          `INSERT INTO customer_device_records (
             id, customer_id, customer_name, customer_code, contact_phone, installation_address, branch_id, product_name, device_serial, pon_serial, mac_address, status, issued_date_ad, issued_date_bs, purchase_bill_ref, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);`,
          [
            newRecord.id,
            newRecord.customerId,
            newRecord.customerName,
            newRecord.customerCode,
            newRecord.contactPhone || '',
            newRecord.installationAddress || '',
            newRecord.branchId || 'WH001',
            newRecord.productName,
            newRecord.deviceSerial,
            newRecord.ponSerial || newRecord.deviceSerial,
            newRecord.macAddress || null,
            newRecord.status,
            newRecord.issuedDateAD,
            newRecord.issuedDateBS,
            newRecord.purchaseBillRef || null,
            newRecord.notes,
          ]
        );
      });
    }
    logAuditEvent(req, 'DEVICE_EXCHANGE', 'CPE_MANAGEMENT', `Exchanged CPE Device for ${oldRecord.customerName}. Replaced SN ${oldRecord.deviceSerial} -> New SN ${newDeviceSerial}`, oldRecord.branchId);
    res.status(201).json({ oldRecord, newRecord, message: 'Customer device successfully exchanged and inventory synchronized.' });
  } catch (err: any) {
    console.error('Error exchanging customer device:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.get('/api/serial-log', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER', 'BRANCH_MANAGER', 'FRONT_DESK', 'AUDITOR', 'PROCUREMENT_OFFICER', 'FIELD_TECHNICIAN'), async (req, res) => {
  try {
    const { branchId, status, query } = req.query;
    const user = (req as any).user;
    let sql = `SELECT id, device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", product_id AS "productId", product_name AS "productName", branch_id AS "branchId", customer_id AS "customerId", customer_name AS "customerName", status, source_type AS "sourceType", source_id AS "sourceId", history_json AS "historyJson", created_at AS "createdAt", updated_at AS "updatedAt" FROM serial_log WHERE 1=1`;
    const params: any[] = [];
    let paramIdx = 0;
    // Branch scoping: non-global users may only read their own branches.
    if (user && user.role !== 'SUPER_ADMIN' && user.role !== 'HEAD_OFFICE_ADMIN') {
      const allowed = new Set<string>([user.branchId || '', ...(user.allowedBranchIds || [])].filter(Boolean));
      const requestedBranchId = typeof branchId === 'string' && branchId !== 'ALL' && branchId.trim() !== '' ? branchId : undefined;
      if (requestedBranchId && !allowed.has(requestedBranchId)) {
        return res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
      }
      if (allowed.size === 0) {
        return res.json([]);
      }
      const scopedIds = requestedBranchId ? [requestedBranchId] : [...allowed];
      const placeholders = scopedIds.map((_, i) => `$${params.length + i + 1}`).join(', ');
      sql += ` AND branch_id IN (${placeholders})`;
      params.push(...scopedIds);
      paramIdx += scopedIds.length;
    }
    if (branchId && branchId !== 'ALL' && (user.role === 'SUPER_ADMIN' || user.role === 'HEAD_OFFICE_ADMIN')) { params.push(branchId as string); paramIdx++; sql += ` AND branch_id = $${paramIdx}`; }
    if (status && status !== 'ALL') { params.push(status as string); paramIdx++; sql += ` AND status = $${paramIdx}`; }
    if (query && typeof query === 'string' && query.trim()) {
      const like = `%${query.trim().toLowerCase()}%`;
      params.push(like); paramIdx++;
      sql += ` AND (LOWER(device_serial) LIKE $${paramIdx} OR LOWER(COALESCE(pon_serial, '')) LIKE $${paramIdx} OR LOWER(COALESCE(mac_address, '')) LIKE $${paramIdx} OR LOWER(product_name) LIKE $${paramIdx} OR LOWER(COALESCE(customer_name, '')) LIKE $${paramIdx})`;
    }
    sql += ` ORDER BY created_at DESC`;
    const r = await pgPool.query(sql, params);
    res.json(r.rows);
  } catch (err) {
    console.error('Error fetching serial log:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

app.post('/api/serial-log', requirePermission('edit-device-serials'), async (req, res) => {
  try {
    const { deviceSerial, ponSerial, macAddress, productId, productName, branchId, customerId, customerName, status, sourceType, sourceId, notes } = req.body;
    const serial = String(deviceSerial || '').trim();
    if (!serial) return res.status(400).json({ message: 'deviceSerial is required' });
    const st = status || 'IN_STOCK';
    const src = sourceType || 'PURCHASE';
    const now = new Date().toISOString();
    const historyEntry = { status: st, sourceType: src, sourceId: sourceId || null, dateAD: now.slice(0, 10), notes: notes || null };
    // Upsert keyed on the unique lower(device_serial) index so one serial = one row.
    const existing = await pgPool.query('SELECT id, history_json FROM serial_log WHERE lower(trim(device_serial)) = lower(trim($1))', [serial]);
    let id: string;
    let history: any[];
    if (existing.rows.length > 0) {
      id = existing.rows[0].id;
      try { history = JSON.parse(existing.rows[0].history_json || '[]'); } catch { history = []; }
      history.push(historyEntry);
      await pgPool.query(
        `UPDATE serial_log SET pon_serial = COALESCE($1, pon_serial), mac_address = COALESCE($2, mac_address),
          product_id = COALESCE($3, product_id), product_name = COALESCE($4, product_name),
          branch_id = COALESCE($5, branch_id),          customer_id = COALESCE($6, customer_id), customer_name = COALESCE($7, customer_name),
          status = $8, source_type = $9, source_id = COALESCE($10, source_id),
          history_json = $11, updated_at = $12 WHERE id = $13`,
        [ponSerial || null, macAddress || null, productId || null, productName || null, branchId || null,
          customerId || null, customerName || null, st, src, sourceId || null, JSON.stringify(history), now, id]
      );
    } else {
      id = `sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      history = [historyEntry];
      await pgPool.query(
        `INSERT INTO serial_log (id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id, customer_id, customer_name, status, source_type, source_id, history_json, created_at, updated_at, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, FALSE)`,
        [id, serial, ponSerial || null, macAddress || null, productId || null, productName || null, branchId || null, customerId || null, customerName || null, st, src, sourceId || null, JSON.stringify(history), now, now]
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
});

}
