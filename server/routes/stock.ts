/**
 * Route module: stock
 */
import { Router } from 'express';
import * as store from '../store';
import { pgPool, isPgConnected, withTransaction } from '../lib/db';
import {
  snapshotStore,
  restoreSnapshot,
  writeThroughPg,
  sendWriteFailure,
  commitLocalMirror,
  isDurableWriteError,
} from '../lib/writeGuard';
import {
  requireRole,
  requireAuth,
  logAuditEvent,
  sanitizeUser,
  findUserByIdOrEmail,
  migrateUserPasswordIfNeeded,
  getUserFromReq,
} from '../lib/auth';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  createSession,
  destroySession,
  destroyUserSessions,
  extractBearerToken,
  getTodayBsStamp,
  normalizeRole,
  MIN_PASSWORD_LENGTH,
  getSession,
} from '../lib/authUtils';
import {
  broadcastChange,
  dataVersion,
  setDataVersion,
  bumpDataVersion,
  addSseClient,
  removeSseClient,
  forEachSseClient,
} from '../lib/sync';
import { getGenAIClient } from '../lib/ai';
import type {
  User,
  Supplier,
  Branch,
  Product,
  CompanyProfile,
  InventoryStock,
  Asset,
  PurchaseOrder,
  PurchaseInvoice,
  Shipment,
  StockOperation,
  FiscalYear,
  AuditLog,
  TransactionLog,
  CustomerDeviceRecord,
  CustomerRecord,
  ApprovalRequest,
  Category,
  UnitOfMeasure,
  LocationRecord,
} from '../../src/types';

const router = Router();

router.get('/api/stock', async (req, res) => {
  const { branchId } = req.query;
  if (isPgConnected) {
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
    return res.json(store.inventoryStock.filter((s) => s.branchId === branchId));
  }
  res.json(store.inventoryStock);
});

router.patch('/api/stock/:id', async (req, res) => {
  const __writeSnap = snapshotStore(['inventoryStock', 'transactionLogs', 'assetRegister', 'stockOperations']);
  try {
    const { id } = req.params;
    const { quantityOnHand, minReorderLevel, damagedQty, reason, changeType } = req.body;
    let stk = store.inventoryStock.find((s) => s.id === id);

    if (isPgConnected && !stk) {
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

    const prod = store.products.find((p) => p.id === stk.productId);

    await writeThroughPg('DB_WRITE', async () => {
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
    });

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
        timestampBS: getTodayBsStamp(),
      };
      store.transactionLogs.unshift(newTxn);

      await writeThroughPg('DB_WRITE', async () => {
        await pgPool.query(
          `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13);`,
          [newTxn.id, newTxn.transactionNumber, newTxn.productId, newTxn.productSku, newTxn.productName, newTxn.branchId, newTxn.changeType, newTxn.quantityBefore, newTxn.quantityChanged, newTxn.quantityAfter, newTxn.unitCost, newTxn.referenceDocId, newTxn.timestampBS]
        );
      });
    } else if (quantityOnHand !== undefined && (stk.quantityOnHand - qtyBefore !== 0)) {
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
        timestampBS: getTodayBsStamp(),
      };
      store.transactionLogs.unshift(newTxn);

      await writeThroughPg('DB_WRITE', async () => {
        await pgPool.query(
          `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13);`,
          [newTxn.id, newTxn.transactionNumber, newTxn.productId, newTxn.productSku, newTxn.productName, newTxn.branchId, newTxn.changeType, newTxn.quantityBefore, newTxn.quantityChanged, newTxn.quantityAfter, newTxn.unitCost, newTxn.referenceDocId, newTxn.timestampBS]
        );
      });
    }

    commitLocalMirror();
    res.json(stk);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error updating stock level:', err);
    return sendWriteFailure(res, err);
  }
});

router.patch('/api/stock/:id/reorder-level', async (req, res) => {
  const __writeSnap = snapshotStore(['inventoryStock', 'transactionLogs', 'assetRegister', 'stockOperations']);
  try {
    const { id } = req.params;
    const { minReorderLevel, productId, branchId } = req.body;
    let stk = store.inventoryStock.find((s) => s.id === id);

    if (!stk && (productId || req.body.productId) && (branchId || req.body.branchId)) {
      const pId = productId || req.body.productId;
      const bId = branchId || req.body.branchId;
      stk = store.inventoryStock.find((s) => s.productId === pId && s.branchId === bId);
    }

    if (!stk) {
      let pId = productId || req.body.productId;
      let bId = branchId || req.body.branchId;

      if (!pId || !bId) {
        const parts = id.split('-');
        if (parts.length >= 3) {
          if (store.products.some((p) => p.id === parts[1])) {
            pId = parts[1];
            bId = parts[2];
          } else if (store.branches.some((b) => b.id === parts[2])) {
            pId = parts[1];
            bId = parts[2];
          }
        }
      }

      if (!pId) pId = store.products[0]?.id;
      if (!bId) bId = store.branches[0]?.id;

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
        store.inventoryStock.push(stk);
      }
    }

    if (!stk) {
      return res.status(404).json({ message: 'Stock record not found' });
    }

    stk.minReorderLevel = Number(minReorderLevel);
    stk.lastUpdated = new Date().toISOString();

    await writeThroughPg('DB_WRITE', async () => {
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
    });

    commitLocalMirror();
    broadcastChange({ type: 'STOCK_UPDATED', entity: 'stock', branchId: stk.branchId });
    res.json(stk);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error setting reorder level:', err);
    return sendWriteFailure(res, err);
  }
});

router.post('/api/stock/bulk-reorder-levels', requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER'), async (req, res) => {
  const __writeSnap = snapshotStore(['inventoryStock', 'transactionLogs', 'assetRegister', 'stockOperations']);
  try {
    const { updates } = req.body;
    if (Array.isArray(updates)) {
      await writeThroughPg('DB_WRITE', async () => {
        await withTransaction(async (client) => {
          for (const u of updates) {
            let stk = store.inventoryStock.find((s) => s.id === u.stockId);
            if (!stk && u.productId && u.branchId) {
              stk = store.inventoryStock.find((s) => s.productId === u.productId && s.branchId === u.branchId);
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
              store.inventoryStock.push(stk);
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
      });
    if (!isPgConnected) {
        for (const u of updates) {
          let stk = store.inventoryStock.find((s) => s.id === u.stockId);
          if (!stk && u.productId && u.branchId) {
            stk = store.inventoryStock.find((s) => s.productId === u.productId && s.branchId === u.branchId);
          }
          if (stk) {
            stk.minReorderLevel = Number(u.minReorderLevel);
            stk.lastUpdated = new Date().toISOString();
          }
        }
      }
      commitLocalMirror();
      broadcastChange({ type: 'STOCK_UPDATED', entity: 'stock' });
    }
    res.json({ success: true, count: updates?.length || 0 });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error bulk updating reorder levels:', err);
    return sendWriteFailure(res, err);
  }
});

// Physical Stock Audit Direct Reconciliation
router.post('/api/stock/reconcile-audit', requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER', 'ACCOUNTANT'), async (req, res) => {
  const __writeSnap = snapshotStore(['inventoryStock', 'transactionLogs', 'assetRegister', 'stockOperations']);
  try {
    const { branchId, auditRefNumber, varianceItems, auditorName, userEmail, notes } = req.body;
    if (!branchId || !Array.isArray(varianceItems)) {
      return res.status(400).json({ message: 'Invalid stock reconciliation payload' });
    }

    let totalAdjusted = 0;
    let netFinancialImpact = 0;

    await writeThroughPg('DB_WRITE', async () => {
      await withTransaction(async (client) => {
        for (const item of varianceItems) {
          let stk = store.inventoryStock.find(
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
            store.inventoryStock.push(stk);
          }

          const qtyBefore = stk.quantityOnHand || 0;
          const targetCounted = Number(item.countedQty) || 0;
          const delta = targetCounted - qtyBefore;
          const unitCost = item.unitCost || 0;

          stk.quantityOnHand = targetCounted;
          stk.lastUpdated = new Date().toISOString();
          totalAdjusted += 1;
          netFinancialImpact += delta * unitCost;

          const prod = store.products.find((p) => p.id === item.productId);

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
            timestampBS: getTodayBsStamp(),
          };
          store.transactionLogs.unshift(newTxn);

          await client.query(
            `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13);`,
            [newTxn.id, newTxn.transactionNumber, newTxn.productId, newTxn.productSku, newTxn.productName, newTxn.branchId, newTxn.changeType, newTxn.quantityBefore, newTxn.quantityChanged, newTxn.quantityAfter, newTxn.unitCost, newTxn.referenceDocId, newTxn.timestampBS]
          );
        }
      });
    });
    if (!isPgConnected) {
      for (const item of varianceItems) {
        let stk = store.inventoryStock.find((s) => s.productId === item.productId && s.branchId === branchId);
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

    const branch = store.branches.find((b) => b.id === branchId);

    logAuditEvent(
      req,
      'STOCK_AUDIT_RECONCILED',
      'INVENTORY_AUDIT',
      `Directly Authorized & Reconciled Physical Stock Audit #${auditRefNumber || 'DIRECT'} for ${branch?.name || branchId}. Adjusted ${totalAdjusted} variance items to physical count. Net Financial Impact: NPR ${netFinancialImpact.toLocaleString()}. Notes: ${notes || 'Direct Stock Reconcile'}`,
      branchId
    );

    commitLocalMirror();
    res.json({
      success: true,
      totalAdjusted,
      netFinancialImpact,
      message: `Physical stock reconciled successfully for ${branch?.name || branchId}`,
    });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error reconciling stock audit:', err);
    return sendWriteFailure(res, err);
  }
});

// Fixed Assets
router.get('/api/assets', async (req, res) => {
  const { branchId } = req.query;
  if (isPgConnected) {
    try {
      const q =
        'SELECT id, tag_number AS "tagNumber", name, category, branch_id AS "branchId", acquisition_date_ad AS "acquisitionDateAd", acquisition_date_bs AS "acquisitionDateBs", acquisition_cost AS "acquisitionCost", depreciation_method AS "depreciationMethod", depreciation_rate_percent AS "depreciationRatePercent", accumulated_depreciation AS "accumulatedDepreciation", net_book_value AS "netBookValue", status, supplier_name AS "supplierName", invoice_no AS "invoiceNo", purchase_invoice_id AS "purchaseInvoiceId", product_id AS "productId" FROM fixed_assets' +
        (branchId && branchId !== 'ALL' ? ' WHERE branch_id = $1' : '') +
        ' ORDER BY created_at DESC';
      const params = branchId && branchId !== 'ALL' ? [branchId] : [];
      const r = await pgPool.query(q, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching assets from DB:', err);
    }
  }
  if (branchId && branchId !== 'ALL') {
    return res.json(store.assetRegister.filter((a) => a.branchId === branchId));
  }
  res.json(store.assetRegister);
});

router.post('/api/assets', async (req, res) => {
  const __writeSnap = snapshotStore(['inventoryStock', 'transactionLogs', 'assetRegister', 'stockOperations']);
  try {
    const tagNum = req.body.tagNumber || req.body.assetTag || `AST-${Math.floor(1000 + Math.random() * 9000)}`;
    const newAsset = {
      id: req.body.id || `ast-${Date.now()}`,
      tagNumber: tagNum,
      name: req.body.name || 'Fixed Asset',
      category: req.body.category || 'Equipment',
      branchId: req.body.branchId || 'WH001',
      acquisitionDateAd: req.body.acquisitionDateAD || req.body.acquisitionDateAd || new Date().toISOString().split('T')[0],
      acquisitionDateBs: req.body.acquisitionDateBS || req.body.acquisitionDateBs || '2083-04-10 BS',
      acquisitionCost: Number(req.body.acquisitionCost) || 0,
      depreciationMethod: req.body.depreciationMethod || 'STRAIGHT_LINE',
      depreciationRatePercent: Number(req.body.depreciationRatePercent || req.body.depreciationRate) || 15,
      accumulatedDepreciation: Number(req.body.accumulatedDepreciation) || 0,
      netBookValue: Number(req.body.netBookValue ?? req.body.acquisitionCost) || 0,
      status: req.body.status || 'ACTIVE',
      supplierName: req.body.supplierName || '',
      invoiceNo: req.body.invoiceNo || '',
      purchaseInvoiceId: req.body.purchaseInvoiceId || null,
      productId: req.body.productId || null,
    };
    const idx = store.assetRegister.findIndex((a) => a.id === newAsset.id);
    if (idx >= 0) store.assetRegister[idx] = newAsset as any;
    else store.assetRegister.unshift(newAsset as any);

    await writeThroughPg('ASSIGN_FIXED_ASSET', async () => {
      await pgPool.query(
        `INSERT INTO fixed_assets (
           id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs, acquisition_cost, depreciation_method, depreciation_rate_percent, accumulated_depreciation, net_book_value, status, supplier_name, invoice_no, purchase_invoice_id, product_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET
           tag_number = EXCLUDED.tag_number,
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           branch_id = EXCLUDED.branch_id,
           acquisition_cost = EXCLUDED.acquisition_cost,
           net_book_value = EXCLUDED.net_book_value,
           status = EXCLUDED.status;`,
        [
          newAsset.id,
          newAsset.tagNumber,
          newAsset.name,
          newAsset.category,
          newAsset.branchId,
          newAsset.acquisitionDateAd,
          newAsset.acquisitionDateBs,
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
    });

    commitLocalMirror();
    logAuditEvent(req, 'ASSIGN_FIXED_ASSET', 'FIXED_ASSETS', `Assigned / Registered Fixed Asset Tag #${newAsset.tagNumber} (${newAsset.name}) at branch ${newAsset.branchId}`);
    res.status(201).json(newAsset);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error creating fixed asset:', err);
    return sendWriteFailure(res, err);
  }
});

router.patch('/api/assets/:id/status', async (req, res) => {
  const __writeSnap = snapshotStore(['inventoryStock', 'transactionLogs', 'assetRegister', 'stockOperations']);
  try {
    const { id } = req.params;
    const asset = store.assetRegister.find((a) => a.id === id);
    if (asset) Object.assign(asset, req.body);

    await writeThroughPg('UPDATE_ASSET_STATUS', async () => {
      await pgPool.query('UPDATE fixed_assets SET status = $1 WHERE id = $2', [req.body.status || 'ACTIVE', id]);
    });

    commitLocalMirror();
    logAuditEvent(req, 'UPDATE_ASSET_STATUS', 'FIXED_ASSETS', `Updated Fixed Asset status to ${req.body.status || 'UPDATED'}`);
    res.json(asset || req.body);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error updating asset status:', err);
    return sendWriteFailure(res, err);
  }
});

// Purchase Orders

export default router;
