/**
 * Route module: approvals
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

router.get('/api/approval-requests', async (req, res) => {
  const { branchId, status } = req.query;
  if (isPgConnected) {
    try {
      let sql = `SELECT id, request_number AS "requestNumber", type, target_id AS "targetId", customer_name AS "customerName", customer_code AS "customerCode", device_serial AS "deviceSerial", pon_serial AS "ponSerial", product_name AS "productName", current_status AS "currentStatus", requested_status AS "requestedStatus", requested_by_role AS "requestedByRole", requested_by_email AS "requestedByEmail", requested_by_name AS "requestedByName", branch_id AS "branchId", branch_name AS "branchName", reason, restock_qty_on_approval AS "restockQtyOnApproval", status, requested_at_ad AS "requestedAtAD", requested_at_bs AS "requestedAtBS", processed_by_email AS "processedByEmail", processed_by_name AS "processedByName", processed_by_role AS "processedByRole", processed_at_ad AS "processedAtAD", processed_at_bs AS "processedAtBS", rejection_reason AS "rejectionReason" FROM approval_requests`;
      const params: any[] = [];
      const conds: string[] = [];

      if (branchId && branchId !== 'ALL') {
        params.push(branchId);
        conds.push(`branch_id = $${params.length}`);
      }
      if (status && typeof status === 'string' && status !== 'ALL') {
        params.push(status);
        conds.push(`status = $${params.length}`);
      }
      if (conds.length > 0) {
        sql += ` WHERE ` + conds.join(' AND ');
      }
      sql += ` ORDER BY requested_at_ad DESC`;
      const r = await pgPool.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching approval requests from DB:', err);
    }
  }

  let list = store.approvalRequests;
  if (branchId && branchId !== 'ALL') {
    list = list.filter((r) => r.branchId === branchId);
  }
  if (status && typeof status === 'string' && status !== 'ALL') {
    list = list.filter((r) => r.status === status);
  }
  res.json(list);
});

router.post('/api/approval-requests', async (req, res) => {
  const __writeSnap = snapshotStore(['approvalRequests', 'customerDeviceRecords', 'shipments', 'inventoryStock', 'transactionLogs']);
  try {
    const count = store.approvalRequests.length + 1;
    const requestNumber = req.body.requestNumber || `APR-2083-${count.toString().padStart(3, '0')}`;

    const newRequest: ApprovalRequest = {
      id: `apr-${Date.now()}`,
      requestNumber,
      ...req.body,
      status: 'PENDING',
      requestedAtAD: new Date().toISOString(),
      requestedAtBS: getTodayBsStamp(),
    };

    store.approvalRequests.unshift(newRequest);

    await writeThroughPg('DB_WRITE', async () => {
      await pgPool.query(
        `INSERT INTO approval_requests (id, request_number, type, target_id, customer_name, customer_code, device_serial, pon_serial, product_name, current_status, requested_status, requested_by_role, requested_by_email, requested_by_name, branch_id, branch_name, reason, restock_qty_on_approval, status, requested_at_ad, requested_at_bs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW(), $20)`,
        [
          newRequest.id,
          newRequest.requestNumber,
          newRequest.type,
          newRequest.targetId || null,
          newRequest.customerName || '',
          newRequest.customerCode || '',
          newRequest.deviceSerial || '',
          newRequest.ponSerial || '',
          newRequest.productName || '',
          newRequest.currentStatus || 'ACTIVE',
          newRequest.requestedStatus || '',
          newRequest.requestedByRole || '',
          newRequest.requestedByEmail || '',
          newRequest.requestedByName || '',
          newRequest.branchId || null,
          newRequest.branchName || '',
          newRequest.reason || '',
          !!newRequest.restockQtyOnApproval,
          'PENDING',
          newRequest.requestedAtBS,
        ]
      );
    });

    // Log in Audit Trail
    const isTransferCancel = newRequest.type === 'CANCEL_TRANSFER' || newRequest.type === 'CANCEL_IN_TRANSIT_TRANSFER' || newRequest.type === 'CANCEL_RECEIVE_TRANSFER';
    const isStockAudit = newRequest.type === 'STOCK_AUDIT_RECONCILIATION';
    let logModule: AuditLog['module'] = 'OPERATIONS';
    let logDetails = `Submitted approval request #${newRequest.requestNumber} for ${newRequest.customerName} (${newRequest.deviceSerial}) status change to ${newRequest.requestedStatus}`;

    if (isTransferCancel) {
      logModule = 'BRANCH_OPERATIONS';
      logDetails = `Submitted approval request #${newRequest.requestNumber} to cancel in-transit transfer ${newRequest.customerName} (${newRequest.deviceSerial}) at ${newRequest.branchName || newRequest.branchId}. Reason: ${newRequest.reason}`;
    } else if (isStockAudit) {
      logModule = 'INVENTORY_AUDIT';
      logDetails = `Submitted Physical Stock Count Audit authorization request #${newRequest.requestNumber} for ${newRequest.branchName || newRequest.branchId} (${newRequest.auditData?.discrepancyCount || 0} variance items, Net Impact: NPR ${(newRequest.auditData?.netValueVariance || 0).toLocaleString()}). Reason: ${newRequest.reason}`;
    }

    logAuditEvent(req, 'APPROVAL_REQUEST_SUBMITTED', logModule, logDetails, newRequest.branchId);
    commitLocalMirror();
    res.status(201).json(newRequest);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error creating approval request:', err);
    return sendWriteFailure(res, err);
  }
});

router.post('/api/approval-requests/:id/process', requireRole('SUPER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_MANAGER', 'ACCOUNTANT'), async (req, res) => {
  const __writeSnap = snapshotStore(['approvalRequests', 'customerDeviceRecords', 'shipments', 'inventoryStock', 'transactionLogs']);
  try {
    const { id } = req.params;
    const { status, approverUser, rejectionReason } = req.body; // status: 'APPROVED' | 'REJECTED'

    let request = store.approvalRequests.find((r) => r.id === id);
    if (isPgConnected && !request) {
      const r = await pgPool.query(
        'SELECT id, request_number AS "requestNumber", type, target_id AS "targetId", customer_name AS "customerName", customer_code AS "customerCode", device_serial AS "deviceSerial", pon_serial AS "ponSerial", product_name AS "productName", current_status AS "currentStatus", requested_status AS "requestedStatus", requested_by_role AS "requestedByRole", requested_by_email AS "requestedByEmail", requested_by_name AS "requestedByName", branch_id AS "branchId", branch_name AS "branchName", reason, restock_qty_on_approval AS "restockQtyOnApproval", status FROM approval_requests WHERE id = $1',
        [id]
      );
      if (r.rows.length > 0) request = r.rows[0];
    }
    if (!request) return res.status(404).json({ message: 'Approval request not found' });

    const currentU = getUserFromReq(req);
    request.status = status;
    request.processedByEmail = approverUser?.email || currentU.email;
    request.processedByName = approverUser?.name || currentU.name;
    request.processedByRole = approverUser?.role || currentU.role;
    request.processedAtAD = new Date().toISOString();
    request.processedAtBS = getTodayBsStamp();

    if (status === 'REJECTED') {
      request.rejectionReason = rejectionReason || 'Request rejected by administrator';

      await writeThroughPg('APPROVAL_REQUEST_REJECTED', async () => {
        await withTransaction(async (client) => {
          await client.query(
            `UPDATE approval_requests SET status = $1, processed_by_email = $2, processed_by_name = $3, processed_by_role = $4, processed_at_ad = NOW(), processed_at_bs = $5, rejection_reason = $6 WHERE id = $7`,
            [status, request.processedByEmail, request.processedByName, request.processedByRole, request.processedAtBS, request.rejectionReason, id]
          );
        });
      });

      logAuditEvent(req, 'APPROVAL_REQUEST_REJECTED', 'OPERATIONS', `Rejected approval request #${request.requestNumber} for ${request.customerName} (${request.deviceSerial}): ${request.rejectionReason}`, request.branchId);

      commitLocalMirror();
      return res.json({ request, message: 'Approval request rejected successfully' });
    }

    await writeThroughPg('APPROVAL_REQUEST_REJECTED', async () => {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE approval_requests SET status = $1, processed_by_email = $2, processed_by_name = $3, processed_by_role = $4, processed_at_ad = NOW(), processed_at_bs = $5 WHERE id = $6`,
          [status, request.processedByEmail, request.processedByName, request.processedByRole, request.processedAtBS, id]
        );

        // IF APPROVED: execute the requested status change on customer device record
        if (request.type === 'CUSTOMER_DEVICE_STATUS') {
          const isDisconnectReq = request.requestedStatus === 'DISCONNECTED' || request.requestedStatus === 'ROUTER_COLLECTED';
          const targetStatus = isDisconnectReq ? 'ROUTER_COLLECTED' : request.requestedStatus;

          await client.query(
            `UPDATE customer_device_records SET status = $1 WHERE id = $2 OR device_serial = $3`,
            [targetStatus, request.targetId || '', request.deviceSerial || '']
          );

          if (request.restockQtyOnApproval || isDisconnectReq) {
            const prod = store.products.find((p) => p.name.toLowerCase() === request.productName?.toLowerCase()) || store.products[0];
            let stk = store.inventoryStock.find((s) => s.productId === prod.id && s.branchId === request.branchId);

            if (!stk) {
              stk = {
                id: `stk-${request.branchId.toLowerCase()}-${prod.id}`,
                productId: prod.id,
                branchId: request.branchId,
                quantityOnHand: 0,
                damagedQty: 0,
                reservedQty: 0,
                incomingQty: 0,
                lastUpdated: new Date().toISOString(),
              };
              store.inventoryStock.push(stk);
            }

            const qtyBefore = stk.quantityOnHand;
            stk.quantityOnHand += 1;
            stk.lastUpdated = new Date().toISOString();

            await client.query(
              `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (id) DO UPDATE SET quantity_on_hand = inventory_stock.quantity_on_hand + 1, last_updated = NOW();`,
              [stk.id, stk.productId, stk.branchId, stk.quantityOnHand, stk.damagedQty || 0, stk.reservedQty || 0, stk.incomingQty || 0]
            );

            const newTxn: TransactionLog = {
              id: `txn-${Date.now()}`,
              transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
              productId: prod.id,
              productSku: prod.sku,
              productName: prod.name,
              branchId: request.branchId,
              changeType: 'PULLOUT' as const,
              quantityBefore: qtyBefore,
              quantityChanged: 1,
              quantityAfter: stk.quantityOnHand,
              unitCost: prod.costPrice,
              referenceDocId: request.requestNumber,
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
        }

        // IF APPROVED: Cancel In-Transit Transfer
        if (
          request.type === 'CANCEL_TRANSFER' ||
          request.type === 'CANCEL_IN_TRANSIT_TRANSFER' ||
          request.type === 'CANCEL_RECEIVE_TRANSFER' ||
          (request.type && request.type.toUpperCase().includes('CANCEL_TRANSFER'))
        ) {
          const targetId = (request.targetId || request.shipmentData?.shipmentId || '').trim();
          const code1 = (request.deviceSerial || '').trim().toUpperCase();
          const code2 = (request.customerName || '').trim().toUpperCase();
          const code3 = (request.shipmentData?.trackingCode || '').trim().toUpperCase();

          const sh = store.shipments.find(
            (s) =>
              (targetId && s.id === targetId) ||
              (code1 && s.trackingCode && s.trackingCode.trim().toUpperCase() === code1) ||
              (code2 && s.trackingCode && s.trackingCode.trim().toUpperCase() === code2) ||
              (code3 && s.trackingCode && s.trackingCode.trim().toUpperCase() === code3) ||
              (targetId && s.trackingCode && s.trackingCode.trim().toUpperCase() === targetId.toUpperCase())
          );

          if (sh && sh.status !== 'CANCELLED' && sh.status !== 'RECEIVED' && sh.status !== 'DELIVERED') {
            const srcBranchObj = store.branches.find((b) => b.id === sh.sourceBranchId || b.code === sh.sourceBranchId);
            const srcBranchId = srcBranchObj?.id || sh.sourceBranchId;
            const destBranchObj = store.branches.find((b) => b.id === sh.destinationBranchId || b.code === sh.destinationBranchId);
            const destBranchId = destBranchObj?.id || sh.destinationBranchId;

            for (const item of sh.items) {
              const qtySent = Number(item.quantitySent || (item as any).quantity) || 1;
              if (qtySent > 0 && srcBranchId) {
                await client.query(
                  `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
                  [qtySent, item.productId, srcBranchId]
                );
              }
              if (qtySent > 0 && destBranchId) {
                await client.query(
                  `UPDATE inventory_stock SET incoming_qty = GREATEST(0, incoming_qty - $1), last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
                  [qtySent, item.productId, destBranchId]
                );
              }
            }

            sh.status = 'CANCELLED';
            sh.notes = (sh.notes ? sh.notes + ' | ' : '') + `Transfer cancelled via Approval #${request.requestNumber} on ${new Date().toISOString().split('T')[0]} by ${request.processedByName} (${request.processedByRole}). Stock restored to source branch.`;

            await client.query('UPDATE shipments SET status = $1, notes = $2 WHERE id = $3', ['CANCELLED', sh.notes, sh.id]);
          }
        }

        // IF APPROVED: Physical Stock Audit Reconciliation
        if (request.type === 'STOCK_AUDIT_RECONCILIATION' && request.auditData) {
          const auditData = request.auditData;
          const targetBranchId = request.branchId || auditData.branchId;

          if (auditData.varianceItems && Array.isArray(auditData.varianceItems)) {
            for (const item of auditData.varianceItems) {
              const targetCounted = Number(item.countedQty) || 0;
              await client.query(
                `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (id) DO UPDATE SET quantity_on_hand = EXCLUDED.quantity_on_hand;`,
                [`stk-${targetBranchId.toLowerCase()}-${item.productId}`, item.productId, targetBranchId, targetCounted]
              );
            }
          }
        }
      });
    });
    if (!isPgConnected) {
      // In-memory updates if PostgreSQL not connected
      if (request.type === 'CUSTOMER_DEVICE_STATUS') {
        const devRecord = store.customerDeviceRecords.find((c) => c.id === request.targetId || c.deviceSerial === request.deviceSerial);
        const isDisconnectReq = request.requestedStatus === 'DISCONNECTED' || request.requestedStatus === 'ROUTER_COLLECTED';
        const targetStatus = isDisconnectReq ? 'ROUTER_COLLECTED' : request.requestedStatus;
        if (devRecord) {
          devRecord.status = targetStatus as CustomerDeviceRecord['status'];
        }
      }
    }

    commitLocalMirror();
    res.json({ request, message: 'Approval request authorized and executed successfully' });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error processing approval request:', err);
    return sendWriteFailure(res, err);
  }
});

router.post('/api/approval-requests/:id/cancel', async (req, res) => {
  const __writeSnap = snapshotStore(['approvalRequests', 'customerDeviceRecords', 'shipments', 'inventoryStock', 'transactionLogs']);
  try {
    const { id } = req.params;
    const { user, reason } = req.body;

    let request = store.approvalRequests.find((r) => r.id === id);
    if (isPgConnected && !request) {
      const r = await pgPool.query('SELECT * FROM approval_requests WHERE id = $1', [id]);
      if (r.rows.length > 0) request = r.rows[0];
    }
    if (!request) return res.status(404).json({ message: 'Approval request not found' });

    if (request.status !== 'PENDING') {
      return res.status(400).json({ message: `Cannot cancel a request that is already ${request.status}` });
    }

    const currentU = getUserFromReq(req);
    request.status = 'CANCELLED';
    request.processedByEmail = user?.email || currentU.email || request.requestedByEmail;
    request.processedByName = user?.name || currentU.name || request.requestedByName;
    request.processedByRole = user?.role || currentU.role || request.requestedByRole;
    request.processedAtAD = new Date().toISOString();
    request.processedAtBS = getTodayBsStamp();
    request.rejectionReason = reason?.trim() || 'Request cancelled by user';

    await writeThroughPg('APPROVAL_REQUEST_CANCELLED', async () => {
      await pgPool.query(
        `UPDATE approval_requests SET status = $1, processed_by_email = $2, processed_by_name = $3, processed_by_role = $4, processed_at_ad = NOW(), processed_at_bs = $5, rejection_reason = $6 WHERE id = $7`,
        ['CANCELLED', request.processedByEmail, request.processedByName, request.processedByRole, request.processedAtBS, request.rejectionReason, id]
      );
    });

    logAuditEvent(req, 'APPROVAL_REQUEST_CANCELLED', 'OPERATIONS', `Cancelled approval request #${request.requestNumber} for ${request.customerName || id} (${request.deviceSerial || id}). Reason: ${request.rejectionReason}`, request.branchId);
    commitLocalMirror();

    res.json({ request, message: 'Approval request cancelled successfully' });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error cancelling approval request:', err);
    return sendWriteFailure(res, err);
  }
});

// Financial Reports Summary

export default router;
