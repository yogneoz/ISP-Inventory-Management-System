/**
 * Route module: logistics
 */
import { Router } from 'express';
import * as store from '../store';
import { pgPool, isPgConnected, withTransaction } from '../lib/db';
import { validateBody, shipmentCreateSchema } from '../lib/validate';
import { readPgOrStore, num } from '../lib/pgReads';
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

router.get('/api/shipments', async (req, res) => {
  const { branchId } = req.query;
  const bf = branchId && branchId !== 'ALL' ? String(branchId) : null;
  const rows = await readPgOrStore<any>({
    label: 'shipments.list',
    sql:
      `SELECT id, tracking_code AS "trackingCode", type, source_branch_id AS "sourceBranchId", source_branch_name AS "sourceBranchName",
              destination_branch_id AS "destinationBranchId", destination_branch_name AS "destinationBranchName",
              dispatch_date_ad AS "dispatchDateAD", dispatch_date_bs AS "dispatchDateBS",
              estimated_arrival_ad AS "estimatedArrivalAD", status, notes, items,
              received_by_notes AS "receivedByNotes", received_date_ad AS "receivedDateAD",
              received_date_bs AS "receivedDateBS", has_discrepancy AS "hasDiscrepancy"
       FROM shipments` +
      (bf ? ' WHERE source_branch_id = $1 OR destination_branch_id = $1' : '') +
      ' ORDER BY created_at DESC NULLS LAST',
    params: bf ? [bf] : [],
    fallback: () =>
      bf
        ? store.shipments.filter((s) => s.sourceBranchId === bf || s.destinationBranchId === bf)
        : store.shipments,
    map: (r) => ({
      ...r,
      items: typeof r.items === 'string' ? JSON.parse(r.items || '[]') : r.items || [],
    }),
    onRows: (rows) => {
      if (!isPgConnected) return;
      if (!bf) store.replaceCollection('shipments', rows as any);
    },
  });
  res.json(rows);
});

router.post('/api/shipments', validateBody(shipmentCreateSchema), async (req, res) => {
  const __writeSnap = snapshotStore(['shipments', 'stockOperations', 'inventoryStock', 'transactionLogs']);
  try {
    const sourceBranch = store.branches.find((b) => b.id === req.body.sourceBranchId);
    const destBranch = store.branches.find((b) => b.id === req.body.destinationBranchId);

    const newShipment = {
      id: req.body.id || `sh-${Date.now()}`,
      trackingCode: req.body.trackingCode || store.generateStandardTransactionId(req.body.sourceBranchId || 'WH001', 'TRF'),
      sourceBranchName: sourceBranch?.name || req.body.sourceBranchName || 'Source',
      destinationBranchName: destBranch?.name || req.body.destinationBranchName || 'Destination',
      dispatchDateAD: req.body.dispatchDateAD || req.body.dispatchDateAd || new Date().toISOString().split('T')[0],
      dispatchDateBS: req.body.dispatchDateBS || req.body.dispatchDateBs || '2083-04-10 BS',
      status: req.body.status || 'IN_TRANSIT',
      items: req.body.items || [],
      ...req.body,
    };

    const idx = store.shipments.findIndex((s) => s.id === newShipment.id);
    if (idx >= 0) store.shipments[idx] = newShipment;
    else store.shipments.unshift(newShipment);

    await writeThroughPg('DB_WRITE', async () => {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO shipments (
             id, tracking_code, type, source_branch_id, source_branch_name, destination_branch_id, destination_branch_name, dispatch_date_ad, dispatch_date_bs, estimated_arrival_ad, status, notes, items
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             items = EXCLUDED.items;`,
          [
            newShipment.id,
            newShipment.trackingCode,
            newShipment.type || 'INTER_BRANCH',
            newShipment.sourceBranchId,
            newShipment.sourceBranchName,
            newShipment.destinationBranchId,
            newShipment.destinationBranchName,
            newShipment.dispatchDateAD,
            newShipment.dispatchDateBS,
            newShipment.estimatedArrivalAD || newShipment.estimatedArrivalAd || null,
            newShipment.status,
            newShipment.notes || '',
            JSON.stringify(newShipment.items),
          ]
        );

        if (newShipment.type === 'INTER_BRANCH' && newShipment.sourceBranchId) {
          for (const item of newShipment.items) {
            const qtySent = Number(item.quantitySent || item.quantity || 1);
            await client.query(
              `UPDATE inventory_stock SET quantity_on_hand = GREATEST(0, quantity_on_hand - $1), last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
              [qtySent, item.productId, newShipment.sourceBranchId]
            );

            if (newShipment.destinationBranchId) {
              await client.query(
                `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty)
                 VALUES ($1, $2, $3, 0, $4)
                 ON CONFLICT (product_id, branch_id) DO UPDATE SET
                   incoming_qty = inventory_stock.incoming_qty + $4,
                   last_updated = CURRENT_TIMESTAMP;`,
                [`stk-${newShipment.destinationBranchId.toLowerCase()}-${item.productId}`, item.productId, newShipment.destinationBranchId, qtySent]
              );
            }
          }
        }
      });
    });

    if (newShipment.type === 'INTER_BRANCH' && newShipment.sourceBranchId) {
      newShipment.items.forEach((item: any) => {
        const qtySent = Number(item.quantitySent || item.quantity || 1);
        let sourceStk = store.inventoryStock.find((s) => s.productId === item.productId && s.branchId === newShipment.sourceBranchId);
        if (sourceStk) {
          sourceStk.quantityOnHand = Math.max(0, sourceStk.quantityOnHand - qtySent);
          sourceStk.lastUpdated = new Date().toISOString();
        }
        if (newShipment.destinationBranchId) {
          let destStk = store.inventoryStock.find((s) => s.productId === item.productId && s.branchId === newShipment.destinationBranchId);
          if (destStk) {
            destStk.incomingQty = (destStk.incomingQty || 0) + qtySent;
            destStk.lastUpdated = new Date().toISOString();
          }
        }
      });
    }

    commitLocalMirror();
    logAuditEvent(req, 'CREATE_SHIPMENT', 'LOGISTICS', `Created Shipment #${newShipment.trackingCode}`);
    res.status(201).json(newShipment);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error creating shipment:', err);
    return sendWriteFailure(res, err);
  }
});

router.post('/api/shipments/:id/receive', async (req, res) => {
  const __writeSnap = snapshotStore(['shipments', 'stockOperations', 'inventoryStock', 'transactionLogs']);
  try {
    const { id } = req.params;
    const { receivedItems, receivedByNotes } = req.body || {};
    let sh = store.shipments.find((s) => s.id === id);
    if (!sh) return res.status(404).json({ message: 'Shipment not found' });

    let hasDiscrepancy = false;
    sh.receivedByNotes = receivedByNotes || '';
    sh.receivedDateAD = new Date().toISOString().split('T')[0];
    sh.receivedDateBS = getTodayBsStamp();

    sh.items.forEach((item: any, idx: number) => {
      const verified = Array.isArray(receivedItems)
        ? receivedItems.find((ri: any) => ri.itemId === item.id) || receivedItems[idx]
        : null;
      const actualQtyReceived = verified !== null && verified !== undefined && verified.quantityReceived !== undefined
        ? Number(verified.quantityReceived)
        : (item.quantitySent || item.quantity || 1);

      item.quantityReceived = actualQtyReceived;
      if (actualQtyReceived < (item.quantitySent || item.quantity || 1)) hasDiscrepancy = true;
    });

    sh.hasDiscrepancy = hasDiscrepancy;
    sh.status = hasDiscrepancy ? 'DISCREPANCY' : 'RECEIVED';

    await writeThroughPg('RECEIVE_SHIPMENT', async () => {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE shipments SET status = $1, received_by_notes = $2, received_date_ad = CURRENT_DATE, received_date_bs = $3, has_discrepancy = $4, items = $5 WHERE id = $6`,
          [sh.status, sh.receivedByNotes, sh.receivedDateBS, hasDiscrepancy, JSON.stringify(sh.items), id]
        );

        for (const item of sh.items) {
          const actualQtyReceived = item.quantityReceived || item.quantitySent || 1;
          await client.query(
            `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty)
             VALUES ($1, $2, $3, $4, 0)
             ON CONFLICT (product_id, branch_id) DO UPDATE SET
               incoming_qty = GREATEST(0, inventory_stock.incoming_qty - $4),
               quantity_on_hand = inventory_stock.quantity_on_hand + $4,
               last_updated = CURRENT_TIMESTAMP;`,
            [`stk-${sh.destinationBranchId.toLowerCase()}-${item.productId}`, item.productId, sh.destinationBranchId, actualQtyReceived]
          );
        }
      });
    });

    // Mirror receive into memory store (source already deducted on dispatch)
    for (const item of sh.items as any[]) {
      const actualQtyReceived = Number(item.quantityReceived || item.quantitySent || item.quantity || 1);
      const qtySent = Number(item.quantitySent || item.quantity || 1);
      if (sh.destinationBranchId) {
        let destStk = store.inventoryStock.find(
          (s) => s.productId === item.productId && s.branchId === sh.destinationBranchId
        );
        if (!destStk) {
          destStk = {
            id: `stk-${String(sh.destinationBranchId).toLowerCase()}-${item.productId}`,
            productId: item.productId,
            branchId: sh.destinationBranchId,
            quantityOnHand: 0,
            damagedQty: 0,
            reservedQty: 0,
            incomingQty: 0,
            lastUpdated: new Date().toISOString(),
          };
          store.inventoryStock.push(destStk);
        }
        destStk.incomingQty = Math.max(0, (destStk.incomingQty || 0) - qtySent);
        destStk.quantityOnHand = (destStk.quantityOnHand || 0) + actualQtyReceived;
        destStk.lastUpdated = new Date().toISOString();
      }
    }

    commitLocalMirror();
    logAuditEvent(req, 'RECEIVE_SHIPMENT', 'LOGISTICS', `Received Shipment #${sh.trackingCode}`);
    res.json(sh);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error receiving shipment:', err);
    return sendWriteFailure(res, err);
  }
});

router.post('/api/shipments/:id/cancel', async (req, res) => {
  const __writeSnap = snapshotStore(['shipments', 'stockOperations', 'inventoryStock', 'transactionLogs']);
  try {
    const { id } = req.params;
    const { user, reason } = req.body || {};

    let sh = store.shipments.find((s) => s.id === id || s.trackingCode === id);
    if (!sh) return res.status(404).json({ message: 'Shipment / transfer not found' });
    if (sh.status === 'RECEIVED' || sh.status === 'DELIVERED') {
      return res.status(400).json({ message: 'Transfers that have already been received cannot be cancelled.' });
    }
    if (sh.status === 'CANCELLED') {
      return res.status(400).json({ message: `Transfer ${sh.trackingCode} is already cancelled.` });
    }

    sh.status = 'CANCELLED';
    sh.notes = (sh.notes ? sh.notes + ' | ' : '') + `Transfer cancelled by ${user?.name || 'Admin'}${reason ? ': ' + reason : ''}`;

    await writeThroughPg('CANCEL_TRANSFER', async () => {
      await pgPool.query('UPDATE shipments SET status = $1, notes = $2 WHERE id = $3 OR tracking_code = $3', ['CANCELLED', sh.notes, id]);

      for (const item of sh.items) {
        const qtySent = Number(item.quantitySent || (item as any).quantity) || 1;
        if (qtySent > 0 && sh.sourceBranchId) {
          await pgPool.query(
            `UPDATE inventory_stock SET quantity_on_hand = inventory_stock.quantity_on_hand + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
            [qtySent, item.productId, sh.sourceBranchId]
          );
        }
        if (qtySent > 0 && sh.destinationBranchId) {
          await pgPool.query(
            `UPDATE inventory_stock SET incoming_qty = GREATEST(0, incoming_qty - $1), last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
            [qtySent, item.productId, sh.destinationBranchId]
          );
        }
      }
    });

    commitLocalMirror();
    
    // Offline / memory mirror: restore source stock and clear destination incoming
    if (sh.sourceBranchId) {
      for (const item of sh.items as any[]) {
        const qtySent = Number(item.quantitySent || item.quantity || 1);
        if (qtySent <= 0) continue;
        const sourceStk = store.inventoryStock.find(
          (s) => s.productId === item.productId && s.branchId === sh.sourceBranchId
        );
        if (sourceStk) {
          sourceStk.quantityOnHand = (sourceStk.quantityOnHand || 0) + qtySent;
          sourceStk.lastUpdated = new Date().toISOString();
        }
        if (sh.destinationBranchId) {
          const destStk = store.inventoryStock.find(
            (s) => s.productId === item.productId && s.branchId === sh.destinationBranchId
          );
          if (destStk) {
            destStk.incomingQty = Math.max(0, (destStk.incomingQty || 0) - qtySent);
            destStk.lastUpdated = new Date().toISOString();
          }
        }
      }
    }

logAuditEvent(req, 'CANCEL_TRANSFER', 'LOGISTICS', `Cancelled transfer ${sh.trackingCode}`);
    res.json({ shipment: sh, message: `Transfer ${sh.trackingCode} cancelled successfully.` });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error cancelling transfer:', err);
    return sendWriteFailure(res, err);
  }
});

// Deprecated alias for backwards compatibility
router.post('/api/shipments/:id/cancel-receive', (req, res) => {
  return res.status(400).json({
    message: 'Received transfers cannot be cancelled. Only In-Transit transfers can be cancelled.',
  });
});

// Stock Operations (Pullout Bins, Damage Tagging & Adjustments)
router.get('/api/stock-operations', async (req, res) => {
  const { branchId } = req.query;
  const bf = branchId && branchId !== 'ALL' ? String(branchId) : null;
  const rows = await readPgOrStore<any>({
    label: 'stockOps.list',
    sql:
      `SELECT id, reference_number AS "referenceNumber", type, technician_name AS "technicianName",
              work_order_ref AS "workOrderRef", branch_id AS "branchId", branch_name AS "branchName",
              destination_warehouse_id AS "destinationWarehouseId",
              destination_warehouse_name AS "destinationWarehouseName",
              product_id AS "productId", quantity_changed AS "quantityChanged",
              cost_per_unit AS "costPerUnit", total_value AS "totalValue", reason,
              inspector_name AS "inspectorName", date_ad AS "dateAD", date_bs AS "dateBS",
              fiscal_year AS "fiscalYear", status, items
       FROM stock_operations` +
      (bf ? ' WHERE branch_id = $1' : '') +
      ' ORDER BY created_at DESC NULLS LAST',
    params: bf ? [bf] : [],
    fallback: () =>
      bf ? store.stockOperations.filter((o) => o.branchId === bf) : store.stockOperations,
    map: (r) => ({
      ...r,
      quantityChanged: num(r.quantityChanged),
      costPerUnit: num(r.costPerUnit),
      totalValue: num(r.totalValue),
      items: typeof r.items === 'string' ? JSON.parse(r.items || 'null') : r.items,
    }),
    onRows: (rows) => {
      if (!isPgConnected) return;
      if (!bf) store.replaceCollection('stockOperations', rows as any);
    },
  });
  res.json(rows);
});

router.post('/api/stock-operations', async (req, res) => {
  const __writeSnap = snapshotStore(['shipments', 'stockOperations', 'inventoryStock', 'transactionLogs']);
  try {
    const opType = req.body.type || 'DAMAGE';
    const branchObj = store.branches.find((b) => b.id === req.body.branchId);
    const destWarehouseObj = store.branches.find((b) => b.id === (req.body.destinationWarehouseId || 'WH001'));
    const items = req.body.items || [];
    let totalValue = 0;
    if (items.length > 0) {
      totalValue = items.reduce((sum: number, it: any) => sum + (it.totalValue || it.quantity * (it.unitCost || 0)), 0);
    } else if (req.body.quantityChanged && req.body.costPerUnit) {
      totalValue = Math.abs(req.body.quantityChanged) * req.body.costPerUnit;
    }

    const newOp = {
      id: req.body.id || `op-${Date.now()}`,
      referenceNumber: req.body.referenceNumber || store.generateStandardTransactionId(req.body.branchId || 'WH001', opType),
      dateAD: req.body.dateAD || req.body.dateAd || new Date().toISOString().split('T')[0],
      dateBS: req.body.dateBS || req.body.dateBs || getTodayBsStamp(),
      totalValue,
      fiscalYear: req.body.fiscalYear || '2082/83',
      branchName: branchObj?.name || req.body.branchName || 'Branch',
      destinationWarehouseId: destWarehouseObj?.id || req.body.destinationWarehouseId || 'WH001',
      destinationWarehouseName: destWarehouseObj?.name || req.body.destinationWarehouseName || 'Headquarters Warehouse',
      status: opType === 'PULLOUT' ? 'DISPATCHED' : 'LOGGED',
      ...req.body,
    };

    const idx = store.stockOperations.findIndex((o) => o.id === newOp.id);
    if (idx >= 0) store.stockOperations[idx] = newOp;
    else store.stockOperations.unshift(newOp);

    await writeThroughPg('DB_WRITE', async () => {
      await pgPool.query(
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

      for (const item of items) {
        const qty = Number(item.quantity) || 1;
        if (opType === 'DAMAGE') {
          await pgPool.query(
            `UPDATE inventory_stock SET quantity_on_hand = GREATEST(0, quantity_on_hand - $1), damaged_qty = damaged_qty + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
            [qty, item.productId, newOp.branchId]
          );
        } else if (opType === 'PULLOUT') {
          await pgPool.query(
            `UPDATE inventory_stock SET quantity_on_hand = GREATEST(0, quantity_on_hand - $1), last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
            [qty, item.productId, newOp.branchId]
          );
        } else if (opType === 'STOCK_OUT' || opType === 'CONSUMABLE_ISSUE') {
          await pgPool.query(
            `UPDATE inventory_stock SET quantity_on_hand = GREATEST(0, quantity_on_hand - $1), last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
            [qty, item.productId, newOp.branchId]
          );
        }
      }
    });

    commitLocalMirror();
    logAuditEvent(req, `CREATE_STOCK_${opType}`, 'STOCK_OPERATIONS', `Created Stock Operation ${newOp.referenceNumber}`);
    res.status(201).json(newOp);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error creating stock operation:', err);
    return sendWriteFailure(res, err);
  }
});

// Receive Pullout Bin at Warehouse
router.post('/api/stock-operations/:id/receive', async (req, res) => {
  const __writeSnap = snapshotStore(['shipments', 'stockOperations', 'inventoryStock', 'transactionLogs']);
  try {
    const { id } = req.params;
    let op = store.stockOperations.find((o) => o.id === id);
    if (op) op.status = 'RECEIVED';

    await writeThroughPg('RECEIVE_PULLOUT_BIN', async () => {
      await pgPool.query('UPDATE stock_operations SET status = $1 WHERE id = $2', ['RECEIVED', id]);
      if (op) {
        const whId = op.destinationWarehouseId || 'WH001';
        const items = typeof op.items === 'string' ? JSON.parse(op.items) : (op.items || []);
        for (const item of items) {
          const qty = Number(item.quantity) || 1;
          await pgPool.query(
            `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty)
             VALUES ($1, $2, $3, $4, 0)
             ON CONFLICT (product_id, branch_id) DO UPDATE SET
               quantity_on_hand = inventory_stock.quantity_on_hand + $4,
               last_updated = CURRENT_TIMESTAMP;`,
            [`stk-${whId.toLowerCase()}-${item.productId}`, item.productId, whId, qty]
          );
        }
      }
    });

    commitLocalMirror();
    logAuditEvent(req, 'RECEIVE_PULLOUT_BIN', 'STOCK_OPERATIONS', `Received Pullout Bin`);
    res.json(op || { message: 'Stock operation received' });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error receiving stock operation:', err);
    return sendWriteFailure(res, err);
  }
});

// Fiscal Years

export default router;
