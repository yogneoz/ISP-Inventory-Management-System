/**
 * Misc controller — HTTP orchestration for the misc domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { ensurePostgresConnection, realPoolInstance, setPgConnected, setIsPgConnected, getPgConnected, pgPool, auditTrail, transactionLogs, approvalRequests, setApprovalRequests, withPrepended, logAuditEvent, getUserFromReq, withTransaction, products, inventoryStock, setInventoryStock, withAppended, setTransactionLogs, shipments, branches, customerDeviceRecords } from '../app';
import { ApprovalRequest, AuditLog, TransactionLog, CustomerDeviceRecord } from '../../../client/src/types';
import {
  DB_STATUS_PROBE_SQL,
  buildAuditTrailQuery,
  buildTransactionLogQuery,
  buildApprovalRequestQuery,
  AR_INSERT_SQL,
  arInsertParams,
  AR_FIND_BY_ID_SQL,
  AR_FIND_BY_ANY_ID_SQL,
  AR_CLOSE_OUT_SQL,
  arCloseOutParams,
  AR_APPROVE_SQL,
  AR_SHIPMENT_CANCEL_SQL,
  AR_SHIPMENT_RESTORE_SOURCE_SQL,
  AR_SHIPMENT_RELEASE_DEST_SQL,
  CDR_SET_STATUS_SQL,
  MISC_PULLOUT_STOCK_UPSERT_SQL,
  miscPulloutStockParams,
  MISC_PULLOUT_TXN_SQL,
  miscPulloutTxnParams,
  AUDIT_RECONCILE_STOCK_SQL,
  auditReconcileStockParams,
} from '../models/misc.repo';
/** Forwarded from misc.routes.ts (get_status). */
export async function get_status(req: any, res: Response): Promise<any> {
let isConnected = await ensurePostgresConnection();
  let errorDetails = '';
  let tableCount = 0;

  if (isConnected && realPoolInstance) {
    try {
      const client = await realPoolInstance.connect();
      const testRes = await client.query(DB_STATUS_PROBE_SQL);
      client.release();
      isConnected = true;
      setPgConnected(true);
      setIsPgConnected(true);
      tableCount = parseInt(testRes.rows[0]?.tables || '0', 10);
    } catch (err: any) {
      isConnected = false;
      setPgConnected(false);
      setIsPgConnected(false);
      errorDetails = err?.message || 'Failed to connect to PostgreSQL server';
    }
  }

  res.json({
    isConnected,
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'inventory_db',
    user: process.env.POSTGRES_USER || 'inventory_user',
    tableCount,
    errorDetails,
  });

}

/** Forwarded from misc.routes.ts (get_auditTrail). */
export async function get_auditTrail(req: any, res: Response): Promise<any> {
const { branchId, limit } = req.query;
  if (getPgConnected()) {
    try {
      const { sql, params } = buildAuditTrailQuery(branchId, limit);
      const r = await pgPool.query(sql, params);
      res.json(r.rows);
      return;
    } catch (err) {
      console.error('Error fetching audit trail from DB:', err);
    }
  }
  let list = auditTrail;
  if (branchId && branchId !== 'ALL') {
    list = list.filter((a) => a.branchId === branchId);
  }
  res.json(list);

}

/** Forwarded from misc.routes.ts (get_transactionLogs). */
export async function get_transactionLogs(req: any, res: Response): Promise<any> {
const { branchId, productId, limit } = req.query;
  if (getPgConnected()) {
    try {
      const { sql, params } = buildTransactionLogQuery(branchId, productId, limit);
      const r = await pgPool.query(sql, params);
      res.json(r.rows);
      return;
    } catch (err) {
      console.error('Error fetching transaction logs from DB:', err);
    }
  }
  let list = transactionLogs;
  if (branchId && branchId !== 'ALL') {
    list = list.filter((t) => t.branchId === branchId);
  }
  if (productId && productId !== 'ALL') {
    list = list.filter((t) => t.productId === productId);
  }
  res.json(list);

}

/** Forwarded from misc.routes.ts (get_approvalRequests). */
export async function get_approvalRequests(req: any, res: Response): Promise<any> {
const { branchId, status } = req.query;
  if (getPgConnected()) {
    try {
      const { sql, params } = buildApprovalRequestQuery(branchId, status);
      const r = await pgPool.query(sql, params);
      res.json(r.rows);
      return;
    } catch (err) {
      console.error('Error fetching approval requests from DB:', err);
    }
  }

  let list = approvalRequests;
  if (branchId && branchId !== 'ALL') {
    list = list.filter((r) => r.branchId === branchId);
  }
  if (status && typeof status === 'string' && status !== 'ALL') {
    list = list.filter((r) => r.status === status);
  }
  res.json(list);

}

/** Forwarded from misc.routes.ts (post_approvalRequests). */
export async function post_approvalRequests(req: any, res: Response): Promise<any> {
try {
    const count = approvalRequests.length + 1;
    const requestNumber = req.body.requestNumber || `APR-2083-${count.toString().padStart(3, '0')}`;

    const newRequest: ApprovalRequest = {
      id: `apr-${Date.now()}`,
      requestNumber,
      ...req.body,
      status: 'PENDING',
      requestedAtAD: new Date().toISOString(),
      requestedAtBS: '2083-04-22 BS',
    };

    setApprovalRequests(withPrepended(approvalRequests, newRequest));

    if (getPgConnected()) {
      await pgPool.query(AR_INSERT_SQL, arInsertParams(newRequest));
    }

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
    res.status(201).json(newRequest);
  } catch (err: any) {
    console.error('Error creating approval request:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from misc.routes.ts (post_process). */
export async function post_process(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const { status, approverUser, rejectionReason } = req.body; // status: 'APPROVED' | 'REJECTED'

    let request = approvalRequests.find((r) => r.id === id);
    if (getPgConnected() && !request) {
      const r = await pgPool.query(AR_FIND_BY_ID_SQL, [id]);
      if (r.rows.length > 0) request = r.rows[0];
    }
    if (!request) return res.status(404).json({ message: 'Approval request not found' });

    const currentU = getUserFromReq(req);
    request.status = status;
    request.processedByEmail = approverUser?.email || currentU.email;
    request.processedByName = approverUser?.name || currentU.name;
    request.processedByRole = approverUser?.role || currentU.role;
    request.processedAtAD = new Date().toISOString();
    request.processedAtBS = '2083-04-22 BS';

    if (status === 'REJECTED') {
      request.rejectionReason = rejectionReason || 'Request rejected by administrator';

      if (getPgConnected()) {
        await withTransaction(async (client) => {
          await client.query(AR_CLOSE_OUT_SQL, arCloseOutParams(request));
        });
      }

      logAuditEvent(req, 'APPROVAL_REQUEST_REJECTED', 'OPERATIONS', `Rejected approval request #${request.requestNumber} for ${request.customerName} (${request.deviceSerial}): ${request.rejectionReason}`, request.branchId);
      res.json({ request, message: 'Approval request rejected successfully' });
      return;
    }

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        await client.query(AR_APPROVE_SQL, [status, request.processedByEmail, request.processedByName, request.processedByRole, request.processedAtBS, id]);

        // IF APPROVED: execute the requested status change on customer device record
        if (request.type === 'CUSTOMER_DEVICE_STATUS') {
          const isDisconnectReq = request.requestedStatus === 'DISCONNECTED' || request.requestedStatus === 'ROUTER_COLLECTED';
          const targetStatus = isDisconnectReq ? 'ROUTER_COLLECTED' : request.requestedStatus;

          await client.query(CDR_SET_STATUS_SQL, [targetStatus, request.targetId || '', request.deviceSerial || '']);

          if (request.restockQtyOnApproval || isDisconnectReq) {
            const prod = products.find((p) => p.name.toLowerCase() === request.productName?.toLowerCase()) || products[0];
            let stk = inventoryStock.find((s) => s.productId === prod.id && s.branchId === request.branchId);

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
              setInventoryStock(withAppended(inventoryStock, stk));
            }

            const qtyBefore = stk.quantityOnHand;
            stk.quantityOnHand += 1;
            stk.lastUpdated = new Date().toISOString();

            await client.query(MISC_PULLOUT_STOCK_UPSERT_SQL, miscPulloutStockParams(stk));

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
              timestampBS: '2083-04-22 BS',
            };
            setTransactionLogs(withPrepended(transactionLogs, newTxn));

            await client.query(MISC_PULLOUT_TXN_SQL, miscPulloutTxnParams(newTxn));
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

          const sh = shipments.find(
            (s) =>
              (targetId && s.id === targetId) ||
              (code1 && s.trackingCode && s.trackingCode.trim().toUpperCase() === code1) ||
              (code2 && s.trackingCode && s.trackingCode.trim().toUpperCase() === code2) ||
              (code3 && s.trackingCode && s.trackingCode.trim().toUpperCase() === code3) ||
              (targetId && s.trackingCode && s.trackingCode.trim().toUpperCase() === targetId.toUpperCase())
          );

          if (sh && sh.status !== 'CANCELLED' && sh.status !== 'RECEIVED' && sh.status !== 'DELIVERED') {
            const srcBranchObj = branches.find((b) => b.id === sh.sourceBranchId || b.code === sh.sourceBranchId);
            const srcBranchId = srcBranchObj?.id || sh.sourceBranchId;
            const destBranchObj = branches.find((b) => b.id === sh.destinationBranchId || b.code === sh.destinationBranchId);
            const destBranchId = destBranchObj?.id || sh.destinationBranchId;

            for (const item of sh.items) {
              const qtySent = Number(item.quantitySent || (item as any).quantity) || 1;
              if (qtySent > 0 && srcBranchId) {
                await client.query(AR_SHIPMENT_RESTORE_SOURCE_SQL, [qtySent, item.productId, srcBranchId]);
              }
              if (qtySent > 0 && destBranchId) {
                await client.query(AR_SHIPMENT_RELEASE_DEST_SQL, [qtySent, item.productId, destBranchId]);
              }
            }

            sh.status = 'CANCELLED';
            sh.notes = (sh.notes ? sh.notes + ' | ' : '') + `Transfer cancelled via Approval #${request.requestNumber} on ${new Date().toISOString().split('T')[0]} by ${request.processedByName} (${request.processedByRole}). Stock restored to source branch.`;

            await client.query(AR_SHIPMENT_CANCEL_SQL, ['CANCELLED', sh.notes, sh.id]);
          }
        }

        // IF APPROVED: Physical Stock Audit Reconciliation
        if (request.type === 'STOCK_AUDIT_RECONCILIATION' && request.auditData) {
          const auditData = request.auditData;
          const targetBranchId = request.branchId || auditData.branchId;

          if (auditData.varianceItems && Array.isArray(auditData.varianceItems)) {
            for (const item of auditData.varianceItems) {
              const targetCounted = Number(item.countedQty) || 0;
              await client.query(AUDIT_RECONCILE_STOCK_SQL, auditReconcileStockParams(targetBranchId, item));
            }
          }
        }
      });
    } else {
      // In-memory updates if PostgreSQL not connected
      if (request.type === 'CUSTOMER_DEVICE_STATUS') {
        const devRecord = customerDeviceRecords.find((c) => c.id === request.targetId || c.deviceSerial === request.deviceSerial);
        const isDisconnectReq = request.requestedStatus === 'DISCONNECTED' || request.requestedStatus === 'ROUTER_COLLECTED';
        const targetStatus = isDisconnectReq ? 'ROUTER_COLLECTED' : request.requestedStatus;
        if (devRecord) {
          devRecord.status = targetStatus as CustomerDeviceRecord['status'];
        }
      }
    }
    res.json({ request, message: 'Approval request authorized and executed successfully' });
  } catch (err: any) {
    console.error('Error processing approval request:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from misc.routes.ts (post_cancel). */
export async function post_cancel(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const { user, reason } = req.body;

    let request = approvalRequests.find((r) => r.id === id);
    if (getPgConnected() && !request) {
      const r = await pgPool.query(AR_FIND_BY_ANY_ID_SQL, [id]);
      if (r.rows.length > 0) request = r.rows[0];
    }
    if (!request) return res.status(404).json({ message: 'Approval request not found' });

    if (request.status !== 'PENDING') {
      res.status(400).json({ message: `Cannot cancel a request that is already ${request.status}` });
      return;
    }

    const currentU = getUserFromReq(req);
    request.status = 'CANCELLED';
    request.processedByEmail = user?.email || currentU.email || request.requestedByEmail;
    request.processedByName = user?.name || currentU.name || request.requestedByName;
    request.processedByRole = user?.role || currentU.role || request.requestedByRole;
    request.processedAtAD = new Date().toISOString();
    request.processedAtBS = '2083-04-22 BS';
    request.rejectionReason = reason?.trim() || 'Request cancelled by user';

    if (getPgConnected()) {
      await pgPool.query(AR_CLOSE_OUT_SQL, arCloseOutParams(request));
    }

    logAuditEvent(req, 'APPROVAL_REQUEST_CANCELLED', 'OPERATIONS', `Cancelled approval request #${request.requestNumber} for ${request.customerName || id} (${request.deviceSerial || id}). Reason: ${request.rejectionReason}`, request.branchId);

    res.json({ request, message: 'Approval request cancelled successfully' });
  } catch (err: any) {
    console.error('Error cancelling approval request:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

