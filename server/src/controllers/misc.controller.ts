/**
 * Misc controller — HTTP orchestration for the misc domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { ensurePostgresConnection, setPgConnected, setIsPgConnected, getPgConnected, pgPool, transactionLogs, approvalRequests, setApprovalRequests, withPrepended, logAuditEvent, getUserFromReq, withTransaction, withConnection, products, inventoryStock, setInventoryStock, withAppended, setTransactionLogs, shipments, branches, customerDeviceRecords, serialLogs, setSerialLogs, auditTrail } from '../app';
import { ApprovalRequest, AuditLog, CustomerDeviceRecord } from '../../../client/src/types';
import { todayBs } from '../utils/bsDate';
import {
  DB_STATUS_PROBE_SQL,
  buildAuditTrailQuery,
  AUDIT_TRAIL_DEFAULT_LIMIT,
  AUDIT_TRAIL_MAX_LIMIT,
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
  AUDIT_RECONCILE_STOCK_SQL,
  auditReconcileStockParams,
} from '../models/misc.repo';
import { shipmentReceivedQty, SHIPMENT_UNDO_RECEIVE_STOCK_SQL, SHIPMENT_UNDO_RECEIVE_UPDATE_SQL, SHIPMENT_FIND_CANDIDATES_SQL } from '../models/shipments.repo';
import { SERIAL_LOG_SYNC_ON_CDR_SQL, serialLogCdrSyncParams } from '../models/inventory.repo';
import { serialStatusForCdrStatus, cdrHistoryEntry, flipSerialMirror, isLegacyCdrStatus } from '../services/cdrSerialSync';
import { collectCpeFixedAsset } from '../services/cpeAssetLifecycle.service';
/** Forwarded from misc.routes.ts (get_status). */
export async function get_status(req: any, res: Response): Promise<any> {
let isConnected = await ensurePostgresConnection();
  let errorDetails = '';
  let tableCount = 0;

  if (isConnected) {
    try {
      const testRes: any = await withConnection((client: any) => client.query(DB_STATUS_PROBE_SQL));
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
const { branchId, serial, limit } = req.query;
  const user = (req as any).user;
  // Branch scoping, same contract as the serial log: non-global roles read only
  // their own/allowed branches, and may not ask for someone else's.
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
  // A serial's whole history is the point of this read, so the cap is a
  // safety bound, not a page size.
  const take = Math.min(AUDIT_TRAIL_MAX_LIMIT, Math.max(1, Number(limit) || AUDIT_TRAIL_DEFAULT_LIMIT));
  const term = typeof serial === 'string' ? serial.trim() : '';
  if (getPgConnected()) {
    const { sql, params } = buildAuditTrailQuery(branchScope ?? globalBranchId, take, term);
    const r = await pgPool.query(sql, params);
    res.json(r.rows);
    return;
  }
  // Demo mode: filter the in-memory mirror with the same semantics.
  const needle = term.toLowerCase();
  const scope = branchScope ? new Set(branchScope) : null;
  const rows = (auditTrail || []).filter((row) => {
    if (scope && !scope.has(String(row.branchId || ''))) return false;
    if (!scope && globalBranchId && globalBranchId !== 'ALL' && row.branchId !== globalBranchId) return false;
    return !needle || String(row.details || '').toLowerCase().includes(needle);
  });
  res.json(rows.slice(0, take));

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
      requestedAtBS: todayBs(), // C4: from bs_day_records cache
    };

    // The dead CPE vocabulary must not enter the approval queue either: an
    // approver would otherwise execute a DISCONNECTED/RETURNED transition the
    // direct route now refuses. Refuse it at submission, before any row exists.
    if (newRequest.type === 'CUSTOMER_DEVICE_STATUS' && isLegacyCdrStatus(newRequest.requestedStatus)) {
      return res.status(400).json({
        message: `${String(newRequest.requestedStatus).toUpperCase()} is a legacy read-only status. Use ROUTER_COLLECTED for a collection or REFUND/IN_STOCK for a return.`,
      });
    }

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

    // Legacy requests could predate the vocabulary cleanup (or be replayed
    // after it). An APPROVED legacy transition is refused before either the
    // request object, the queue row or the device moves; rejecting such a
    // request stays possible so the queue can always be cleared.
    if (
      status !== 'REJECTED' &&
      request.type === 'CUSTOMER_DEVICE_STATUS' &&
      isLegacyCdrStatus(request.requestedStatus)
    ) {
      return res.status(400).json({
        message: `${String(request.requestedStatus).toUpperCase()} is a legacy read-only status. Use ROUTER_COLLECTED for a collection or REFUND/IN_STOCK for a return.`,
      });
    }

    request.status = status;
    request.processedByEmail = approverUser?.email || currentU.email;
    request.processedByName = approverUser?.name || currentU.name;
    request.processedByRole = approverUser?.role || currentU.role;
    request.processedAtAD = new Date().toISOString();
    request.processedAtBS = todayBs(); // C4: from bs_day_records cache

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
          const targetStatus = String(request.requestedStatus || '').trim().toUpperCase();
          const isCollection = targetStatus === 'ROUTER_COLLECTED';

          await client.query(CDR_SET_STATUS_SQL, [targetStatus, request.targetId || '', request.deviceSerial || '']);

          // Sync the Serial Log Register with the approved status change:
          // collecting/refunding a device must free its register unit from
          // CUSTOMER_ASSIGNED, or the register's status filter disagrees
          // with the customer directory forever (CDR↔serial_log audit).
          const approvedSerialStatus = serialStatusForCdrStatus(targetStatus);
          if (approvedSerialStatus && (request.deviceSerial || '').trim()) {
            await client.query(
              SERIAL_LOG_SYNC_ON_CDR_SQL,
              serialLogCdrSyncParams({
                status: approvedSerialStatus,
                customerId: request.customerCode || null,
                customerName: request.customerName || null,
                branchId: request.branchId || null,
                historyEntry: cdrHistoryEntry(
                  approvedSerialStatus,
                  request.requestNumber,
                  new Date().toISOString().split('T')[0],
                  `Approved ${request.requestNumber}: CPE status ${request.currentStatus} → ${targetStatus}`
                ),
                deviceSerial: request.deviceSerial,
              })
            );
          }

          // CPE-3/D1: the fixed asset is the dedupe key, so an approval
          // collection and the asset-unassign screen cannot credit the same
          // return twice. One service owns the asset rule; legacy CPE rows
          // without a linked asset keep the request-keyed credit.
          if (request.restockQtyOnApproval || isCollection) {
            const fallbackProduct = products.find(
              (p) => p.name.toLowerCase() === request.productName?.toLowerCase()
            );
            const collected = await collectCpeFixedAsset({
              client,
              cpeId: request.targetId,
              deviceSerial: request.deviceSerial,
              requestNumber: request.requestNumber,
              todayAD: new Date().toISOString().split('T')[0],
              todayBS: todayBs(),
              branchId: request.branchId,
              products,
              fallbackProduct,
              allowUnlinkedRestock: true,
              changeType: 'PULLOUT',
            });
            if (collected.ledger) {
              const stockRow = inventoryStock.find(
                (s) => s.productId === collected.ledger!.productId && s.branchId === collected.ledger!.branchId
              );
              if (stockRow) {
                stockRow.quantityOnHand = collected.ledger.quantityAfter;
                stockRow.lastUpdated = new Date().toISOString();
              } else {
                setInventoryStock(
                  withAppended(inventoryStock, {
                    id: `stk-${collected.ledger.branchId.toLowerCase()}-${collected.ledger.productId}`,
                    productId: collected.ledger.productId,
                    branchId: collected.ledger.branchId,
                    quantityOnHand: collected.ledger.quantityAfter,
                    damagedQty: 0,
                    reservedQty: 0,
                    incomingQty: 0,
                    lastUpdated: new Date().toISOString(),
                  })
                );
              }
              setTransactionLogs(withPrepended(transactionLogs, collected.ledger));
            }
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

          // PostgreSQL is the only source when connected: the approval must
          // act on the live shipment row, not a mirror copy that another
          // instance may already have received or cancelled.
          const idCandidates = [targetId].filter(Boolean);
          const codeCandidates = [code1, code2, code3, targetId.toUpperCase()].filter(Boolean);
          let sh: any;
          if (getPgConnected()) {
            const found = await client.query(SHIPMENT_FIND_CANDIDATES_SQL, [idCandidates, codeCandidates]);
            sh = found.rows[0];
            if (sh && typeof sh.items === 'string') sh.items = JSON.parse(sh.items);
          } else {
            sh = shipments.find(
              (s) =>
                (targetId && s.id === targetId) ||
                (code1 && s.trackingCode && s.trackingCode.trim().toUpperCase() === code1) ||
                (code2 && s.trackingCode && s.trackingCode.trim().toUpperCase() === code2) ||
                (code3 && s.trackingCode && s.trackingCode.trim().toUpperCase() === code3) ||
                (targetId && s.trackingCode && s.trackingCode.trim().toUpperCase() === targetId.toUpperCase())
            );
          }

          // A CANCEL_RECEIVE_TRANSFER approval on a RECEIVED/DISCREPANCY shipment
          // undoes the receipt (destination stock reversed, shipment back
          // In-Transit). Every other cancel type keeps the original in-transit
          // semantics: RECEIVED/DELIVERED shipments are never touched.
          const undoReceive =
            !!sh &&
            request.type === 'CANCEL_RECEIVE_TRANSFER' &&
            (sh.status === 'RECEIVED' || sh.status === 'DISCREPANCY');
          if (undoReceive && sh) {
            const destBranchObj = branches.find((b) => b.id === sh.destinationBranchId || b.code === sh.destinationBranchId);
            const destBranchId = destBranchObj?.id || sh.destinationBranchId;
            for (const item of sh.items) {
              const qty = shipmentReceivedQty(item);
              if (qty > 0 && destBranchId) {
                const undone = await client.query(SHIPMENT_UNDO_RECEIVE_STOCK_SQL, [qty, item.productId, destBranchId]);
                if (undone.rowCount !== 1) {
                  throw new Error(`Insufficient stock at the destination branch to undo the receipt of ${item.productName || item.productId}.`);
                }
              }
            }
            const undoNote = (sh.notes ? sh.notes + ' | ' : '') + `Receipt cancelled via Approval #${request.requestNumber} on ${new Date().toISOString().split('T')[0]} by ${request.processedByName} (${request.processedByRole}). Reverted to In-Transit.`;
            await client.query(SHIPMENT_UNDO_RECEIVE_UPDATE_SQL, [sh.id, undoNote]);
            sh.status = 'IN_TRANSIT';
            sh.receivedByNotes = undefined;
            sh.receivedDateAD = undefined;
            sh.receivedDateBS = undefined;
            sh.hasDiscrepancy = false;
            sh.notes = undoNote;
          } else if (sh && sh.status !== 'CANCELLED' && sh.status !== 'RECEIVED' && sh.status !== 'DELIVERED') {
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
        const targetStatus = String(request.requestedStatus || '').trim().toUpperCase();
        if (devRecord) {
          devRecord.status = targetStatus as CustomerDeviceRecord['status'];
        }
        // Demo mode: mirror the register flip the PG path writes above.
        const approvedSerialStatus = serialStatusForCdrStatus(targetStatus);
        if (approvedSerialStatus && (request.deviceSerial || '').trim()) {
          setSerialLogs(flipSerialMirror(
            serialLogs,
            request.deviceSerial,
            approvedSerialStatus,
            request.customerCode || null,
            request.customerName || null,
            cdrHistoryEntry(
              approvedSerialStatus,
              request.requestNumber,
              new Date().toISOString().split('T')[0],
              `Approved ${request.requestNumber}: CPE status ${request.currentStatus} → ${targetStatus}`
            )
          ));
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
    request.processedAtBS = todayBs(); // C4: from bs_day_records cache
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

