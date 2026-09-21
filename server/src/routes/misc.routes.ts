/**
 * Misc routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerMiscRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import {
  approvalRequests,
  auditTrail,
  branches,
  customerDeviceRecords,
  getPgConnected,
  getUserFromReq,
  inventoryStock,
  logAuditEvent,
  products,
  requireRole,
  setApprovalRequests,
  setInventoryStock,
  setPgConnected,
  setTransactionLogs,
  shipments,
  transactionLogs,
  withAppended,
  withPrepended,
  withTransaction,
} from '../app';
import { ensurePostgresConnection, pgPool, realPoolInstance, setIsPgConnected } from '../app';
import type { ApprovalRequest, AuditLog, CustomerDeviceRecord, TransactionLog } from '../../../client/src/types';

export function registerMiscRoutes(app: Express) {
app.get('/api/db/status', async (req, res) => {
  let isConnected = await ensurePostgresConnection();
  let errorDetails = '';
  let tableCount = 0;

  if (isConnected && realPoolInstance) {
    try {
      const client = await realPoolInstance.connect();
      const testRes = await client.query('SELECT current_database(), version(), (SELECT count(*) FROM information_schema.tables WHERE table_schema = \'public\') as tables');
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
});

app.get('/api/audit-trail', async (req, res) => {
  const { branchId, limit } = req.query;
  if (getPgConnected()) {
    try {
      let sql = `SELECT id, user_email AS "userEmail", user_name AS "userName", action, module, details, timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS", branch_id AS "branchId" FROM audit_logs`;
      const params: any[] = [];
      if (branchId && branchId !== 'ALL') {
        sql += ` WHERE branch_id = $1`;
        params.push(branchId);
      }
      sql += ` ORDER BY timestamp_ad DESC`;
      if (limit) {
        params.push(Number(limit));
        sql += ` LIMIT $${params.length}`;
      }
      const r = await pgPool.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching audit trail from DB:', err);
    }
  }
  let list = auditTrail;
  if (branchId && branchId !== 'ALL') {
    list = list.filter((a) => a.branchId === branchId);
  }
  res.json(list);
});

app.get('/api/transaction-logs', async (req, res) => {
  const { branchId, productId, limit } = req.query;
  if (getPgConnected()) {
    try {
      let sql = `SELECT id, transaction_number AS "transactionNumber", product_id AS "productId", product_sku AS "productSku", product_name AS "productName", branch_id AS "branchId", change_type AS "changeType", quantity_before AS "quantityBefore", quantity_changed AS "quantityChanged", quantity_after AS "quantityAfter", unit_cost AS "unitCost", reference_doc_id AS "referenceDocId", timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS" FROM transaction_logs`;
      const params: any[] = [];
      const conds: string[] = [];

      if (branchId && branchId !== 'ALL') {
        params.push(branchId);
        conds.push(`branch_id = $${params.length}`);
      }
      if (productId && productId !== 'ALL') {
        params.push(productId);
        conds.push(`product_id = $${params.length}`);
      }
      if (conds.length > 0) {
        sql += ` WHERE ` + conds.join(' AND ');
      }
      sql += ` ORDER BY timestamp_ad DESC`;
      if (limit) {
        params.push(Number(limit));
        sql += ` LIMIT $${params.length}`;
      }
      const r = await pgPool.query(sql, params);
      return res.json(r.rows);
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
});

app.get('/api/approval-requests', async (req, res) => {
  const { branchId, status } = req.query;
  if (getPgConnected()) {
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

  let list = approvalRequests;
  if (branchId && branchId !== 'ALL') {
    list = list.filter((r) => r.branchId === branchId);
  }
  if (status && typeof status === 'string' && status !== 'ALL') {
    list = list.filter((r) => r.status === status);
  }
  res.json(list);
});

app.post('/api/approval-requests', async (req, res) => {
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
});

app.post('/api/approval-requests/:id/process', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'BRANCH_MANAGER', 'AUDITOR'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, approverUser, rejectionReason } = req.body; // status: 'APPROVED' | 'REJECTED'

    let request = approvalRequests.find((r) => r.id === id);
    if (getPgConnected() && !request) {
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
    request.processedAtBS = '2083-04-22 BS';

    if (status === 'REJECTED') {
      request.rejectionReason = rejectionReason || 'Request rejected by administrator';

      if (getPgConnected()) {
        await withTransaction(async (client) => {
          await client.query(
            `UPDATE approval_requests SET status = $1, processed_by_email = $2, processed_by_name = $3, processed_by_role = $4, processed_at_ad = NOW(), processed_at_bs = $5, rejection_reason = $6 WHERE id = $7`,
            [status, request.processedByEmail, request.processedByName, request.processedByRole, request.processedAtBS, request.rejectionReason, id]
          );
        });
      }

      logAuditEvent(req, 'APPROVAL_REQUEST_REJECTED', 'OPERATIONS', `Rejected approval request #${request.requestNumber} for ${request.customerName} (${request.deviceSerial}): ${request.rejectionReason}`, request.branchId);
      return res.json({ request, message: 'Approval request rejected successfully' });
    }

    if (getPgConnected()) {
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
              timestampBS: '2083-04-22 BS',
            };
            setTransactionLogs(withPrepended(transactionLogs, newTxn));

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
});

app.post('/api/approval-requests/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, reason } = req.body;

    let request = approvalRequests.find((r) => r.id === id);
    if (getPgConnected() && !request) {
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
    request.processedAtBS = '2083-04-22 BS';
    request.rejectionReason = reason?.trim() || 'Request cancelled by user';

    if (getPgConnected()) {
      await pgPool.query(
        `UPDATE approval_requests SET status = $1, processed_by_email = $2, processed_by_name = $3, processed_by_role = $4, processed_at_ad = NOW(), processed_at_bs = $5, rejection_reason = $6 WHERE id = $7`,
        ['CANCELLED', request.processedByEmail, request.processedByName, request.processedByRole, request.processedAtBS, request.rejectionReason, id]
      );
    }

    logAuditEvent(req, 'APPROVAL_REQUEST_CANCELLED', 'OPERATIONS', `Cancelled approval request #${request.requestNumber} for ${request.customerName || id} (${request.deviceSerial || id}). Reason: ${request.rejectionReason}`, request.branchId);

    res.json({ request, message: 'Approval request cancelled successfully' });
  } catch (err: any) {
    console.error('Error cancelling approval request:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

}
