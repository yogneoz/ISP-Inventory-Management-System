/**
 * Shipments controller — HTTP orchestration for the shipments domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { getPgConnected, pgPool, shipments, branches, detectDateTypeMismatch, findBsDayRecordForAdDate, getUserFromReq, issueNextDocNumber, permissionMatrix, setShipments, withReplaced, withPrepended, withTransaction, inventoryStock, logAuditEvent } from '../app';
import {
  SHIPMENT_LIST_SQL, SHIPMENT_UPSERT_SQL, SHIPMENT_FIND_FOR_OVERWRITE_SQL, shipmentUpsertParams,
  shipmentQtySent, SHIPMENT_DEDUCT_SOURCE_SQL, SHIPMENT_INCOMING_DEST_SQL, shipmentIncomingDestParams,
  SHIPMENT_RECEIVE_UPDATE_SQL, SHIPMENT_RECEIVE_STOCK_SQL, shipmentReceiveStockParams,
  SHIPMENT_FIND_FOR_CANCEL_SQL, SHIPMENT_CANCEL_SQL, SHIPMENT_CANCEL_RESTORE_SOURCE_SQL, SHIPMENT_CANCEL_RELEASE_DEST_SQL,
  shipmentReceivedQty, SHIPMENT_UNDO_RECEIVE_STOCK_SQL, SHIPMENT_UNDO_RECEIVE_UPDATE_SQL,
} from '../models/shipments.repo';
/** Forwarded from shipments.routes.ts (get_shipments). */
export async function get_shipments(req: any, res: Response): Promise<any> {
// Audience scoping: branch-bound accounts only ever see shipments that
  // touch one of their own branches (mirrors the bootstrap scope for these
  // roles); SUPER_ADMIN and HQ-wide accounts see everything. The route is
  // authenticated via requireAuth, so req.user is present.
  const user = req.user || getUserFromReq(req);
  const scoped = (rows: readonly any[]): readonly any[] => {
    if (
      !user ||
      user.role === 'SUPER_ADMIN' ||
      user.role === 'HEAD_OFFICE_ADMIN' ||
      !user.branchId ||
      user.branchId === 'ALL'
    ) {
      return rows;
    }
    const mine = new Set<string>([user.branchId, ...(user.allowedBranchIds || [])]);
    return rows.filter((row) => {
      const src = row.sourceBranchId ?? row.source_branch_id;
      const dst = row.destinationBranchId ?? row.destination_branch_id;
      return mine.has(src) || mine.has(dst);
    });
  };
  if (getPgConnected()) {
    try {
      const r = await pgPool.query(SHIPMENT_LIST_SQL);
      res.json(scoped(r.rows));
      return;
    } catch (err) {
      console.error('Error fetching shipments from DB:', err);
    }
  }
  res.json(scoped(shipments));

}

/** Forwarded from shipments.routes.ts (post_shipments). */
export async function post_shipments(req: any, res: Response): Promise<any> {
try {
    // VULN-001/003: authorize on the EFFECTIVE branch ids — the branches the
    // request will actually act on — not only the fields the client chose to
    // send. A missing source defaults to the caller's own branch (never a
    // different one); HQ-wide accounts (SUPER/HEAD_OFFICE, or a signed
    // 'ALL'/empty branch scope) keep the legacy first-branch default.
    const createActor = req.user || getUserFromReq(req) || {};
    const hqWideCreator =
      createActor.role === 'SUPER_ADMIN' ||
      createActor.role === 'HEAD_OFFICE_ADMIN' ||
      !createActor.branchId ||
      createActor.branchId === 'ALL';
    const creatorScope = new Set<string>([createActor.branchId || '', ...(createActor.allowedBranchIds || [])]);
    const effectiveSourceBranchId =
      (typeof req.body.sourceBranchId === 'string' && req.body.sourceBranchId) ||
      (hqWideCreator ? (branches[0]?.id || 'WH001') : createActor.branchId) ||
      '';
    const effectiveDestBranchId = typeof req.body.destinationBranchId === 'string' ? req.body.destinationBranchId : '';
    if (!hqWideCreator) {
      const effectiveBranches: Array<[string, string]> = [
        ['source', effectiveSourceBranchId],
        ['destination', effectiveDestBranchId],
      ];
      for (const [label, branchId] of effectiveBranches) {
        if (branchId && !creatorScope.has(branchId)) {
          return res.status(400).json({ message: `Forbidden: the ${label} branch '${branchId}' is outside your branch scope.` });
        }
      }
    }
    const sourceBranch = branches.find((b) => b.id === effectiveSourceBranchId);
    const destBranch = branches.find((b) => b.id === req.body.destinationBranchId);

    // BS calendar gate: a shipment dispatch may only be posted when its date
    // has a seeded BS day record in bs_day_records (Nepali date is mandatory).
    const rawDispatchDateAD = req.body.dispatchDateAD || req.body.dispatchDateAd;
    const dispatchDateMismatch = detectDateTypeMismatch(rawDispatchDateAD, 'dispatchDateAD');
    if (dispatchDateMismatch) {
      res.status(400).json({ message: dispatchDateMismatch, dateTypeMismatch: true });
      return;
    }
    const dispatchDateAD = String(rawDispatchDateAD || new Date().toISOString().split('T')[0]).split('T')[0];
    const bsDayForShipment = await findBsDayRecordForAdDate(dispatchDateAD);
    if (!bsDayForShipment.found) {
      return res.status(400).json({
        message: `BS date is not available for ${dispatchDateAD}. Please contact your system administrator for BS month seeding.`,
        bsDateMissing: true,
      });
    }

    const sourceBranchId = effectiveSourceBranchId;
    const trackingCode = req.body.trackingCode || (await issueNextDocNumber(sourceBranchId, 'ST', dispatchDateAD));

    const newShipment = {
      ...req.body,
      id: req.body.id || `sh-${Date.now()}`,
      trackingCode,
      // Stamped AFTER the spread so an omitted source can never erase the
      // effective branch the create was authorized against (VULN-001): the
      // stock deduction below now always runs against a real, in-scope branch.
      sourceBranchId,
      sourceBranchName: sourceBranch?.name || req.body.sourceBranchName || 'Source',
      destinationBranchName: destBranch?.name || req.body.destinationBranchName || 'Destination',
      // Date integrity: the AD dispatch date stays in the AD column, and the BS
      // date is ALWAYS derived from the seeded bs_day_records DB record. A
      // client-supplied dispatchDateBS can never override it.
      dispatchDateAD,
      dispatchDateBS: `${bsDayForShipment.record.bsDate} BS`,
      status: req.body.status || 'IN_TRANSIT',
      items: req.body.items || [],
    };

    // VULN-003: a client-supplied id / tracking code may name an existing
    // shipment. Overwriting its status/items is only allowed when that
    // shipment touches the caller's own branches; otherwise it is an
    // out-of-scope overwrite.
    let existingRow: { sourceBranchId?: string | null; destinationBranchId?: string | null } | null =
      (shipments.find((s) => s.id === newShipment.id || s.trackingCode === newShipment.trackingCode) as any) || null;
    if (getPgConnected()) {
      const existing = await pgPool.query(SHIPMENT_FIND_FOR_OVERWRITE_SQL, [newShipment.id, newShipment.trackingCode]);
      if (existing.rows[0]) existingRow = existing.rows[0];
    }
    const shipmentAlreadyExists = Boolean(existingRow);
    if (existingRow && !hqWideCreator) {
      const touched = [existingRow.sourceBranchId, existingRow.destinationBranchId].filter(Boolean) as string[];
      if (!touched.some((branchId) => creatorScope.has(branchId))) {
        return res.status(403).json({
          message: 'Forbidden: a shipment with this id or tracking code already exists outside your branch scope.',
        });
      }
    }

    const idx = shipments.findIndex((s) => s.id === newShipment.id);
    setShipments(idx >= 0 ? withReplaced(shipments, idx, newShipment) : withPrepended(shipments, newShipment));

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        await client.query(SHIPMENT_UPSERT_SQL, shipmentUpsertParams(newShipment));

        if (!shipmentAlreadyExists && newShipment.type === 'INTER_BRANCH' && newShipment.sourceBranchId) {
          for (const item of newShipment.items) {
            const qtySent = shipmentQtySent(item);
            const updated = await client.query(
              SHIPMENT_DEDUCT_SOURCE_SQL,
              [qtySent, item.productId, newShipment.sourceBranchId]
            );
            if (updated.rowCount !== 1) throw new Error(`Insufficient stock for ${item.productName || item.productId}.`);

            if (newShipment.destinationBranchId) {
              await client.query(
                SHIPMENT_INCOMING_DEST_SQL,
                shipmentIncomingDestParams(newShipment.destinationBranchId, item)
              );
            }
          }
        }
      });
    }

    if (!shipmentAlreadyExists && newShipment.type === 'INTER_BRANCH' && newShipment.sourceBranchId) {
      newShipment.items.forEach((item: any) => {
        const qtySent = Number(item.quantitySent || item.quantity || 1);
        let sourceStk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === newShipment.sourceBranchId);
        if (sourceStk) {
          sourceStk.quantityOnHand = Math.max(0, sourceStk.quantityOnHand - qtySent);
          sourceStk.lastUpdated = new Date().toISOString();
        }
        if (newShipment.destinationBranchId) {
          let destStk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === newShipment.destinationBranchId);
          if (destStk) {
            destStk.incomingQty = (destStk.incomingQty || 0) + qtySent;
            destStk.lastUpdated = new Date().toISOString();
          }
        }
      });
    }
    logAuditEvent(req, 'CREATE_SHIPMENT', 'LOGISTICS', `Created Shipment #${newShipment.trackingCode}`);
    res.status(201).json(newShipment);
  } catch (err: any) {
    console.error('Error creating shipment:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from shipments.routes.ts (post_receive). */
export async function post_receive(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const { receivedItems, receivedByNotes } = req.body || {};
    let sh = shipments.find((s) => s.id === id);
    if (!sh) return res.status(404).json({ message: 'Shipment not found' });
    if (['RECEIVED', 'DELIVERED', 'CANCELLED'].includes(sh.status)) {
      res.status(409).json({ message: `Shipment ${sh.trackingCode} is already ${sh.status.toLowerCase()} and cannot be received again.` });
      return;
    }

    // VULN-001: a shipment without a source branch never deducted inventory
    // (legacy rows or the pre-fix create omission), so crediting the
    // destination would fabricate stock out of nothing.
    if (!sh.sourceBranchId) {
      res.status(400).json({
        message: `Shipment ${sh.trackingCode} has no source branch, so its receipt would fabricate stock. Cancel it and recreate the dispatch from the sending branch.`,
      });
      return;
    }

    // Lane scoping: the route accepts EITHER warehouse receiving (pullouts,
    // supplier inbound) OR branch-transfer receiving (inter-branch lanes),
    // but each shipment only unlocks its own lane's operation in the
    // permission matrix. This is what makes a Permission Management toggle
    // authoritative: disabling wh-receive-pullouts stops warehouse-lane
    // receipts, and disabling branch-transfer-receive stops transfer
    // receipts on branch lanes. SUPER_ADMIN keeps its matrix bypass, and
    // enforceBranchAccess has already constrained branch-bound accounts to
    // shipments touching their own branches.
    const receiveUser = req.user || getUserFromReq(req);
    if (!receiveUser || !receiveUser.email) {
      return res.status(401).json({ message: 'Unauthorized: Authentication required' });
    }
    if (receiveUser.role !== 'SUPER_ADMIN') {
      // Destination affinity: receiving always happens on the destination
      // side, so the destination branch must fall inside the account's own
      // branch scope (branch users: their branch; HQ-wide accounts: any).
      const receiverBranches = new Set<string>([
        receiveUser.branchId || '',
        ...(receiveUser.allowedBranchIds || []),
      ]);
      const destInScope =
        !receiveUser.branchId ||
        receiveUser.branchId === 'ALL' ||
        receiverBranches.has(sh.destinationBranchId);
      if (!destInScope) {
        return res.status(403).json({
          message: `Forbidden: shipment ${sh.trackingCode} is not destined for a branch you operate.`,
        });
      }
      const destBranch = branches.find((b) => b.id === sh.destinationBranchId);
      const destIsWarehouse =
        sh.destinationBranchId === 'WH001' ||
        Boolean(destBranch?.isHeadquarters || destBranch?.isWarehouse) ||
        (destBranch?.code || '').toUpperCase().startsWith('WH') ||
        /warehouse|head office/i.test(destBranch?.name || '');
      const laneOp = destIsWarehouse ? 'wh-receive-pullouts' : 'branch-transfer-receive';
      const laneRow = permissionMatrix[laneOp];
      if (!laneRow || !laneRow[receiveUser.role]) {
        return res.status(403).json({
          message: `Forbidden: role '${receiveUser.role}' is not permitted for operation '${laneOp}' on this receiving lane.`,
        });
      }
    }

    let hasDiscrepancy = false;
    sh.receivedByNotes = receivedByNotes || '';
    sh.receivedDateAD = new Date().toISOString().split('T')[0];
    // Date integrity: the BS receipt date is ALWAYS derived from the seeded
    // bs_day_records row for the AD receipt date — a hardcoded or client-
    // supplied BS value is never stored in received_date_bs.
    const bsDayForReceipt = await findBsDayRecordForAdDate(sh.receivedDateAD);
    const receivedDateBS: string | null = bsDayForReceipt.found
      ? `${bsDayForReceipt.record.bsDate} BS`
      : null;
    sh.receivedDateBS = receivedDateBS || undefined;

    sh.items.forEach((item: any, idx: number) => {
      const verified = Array.isArray(receivedItems)
        ? receivedItems.find((ri: any) => ri.itemId === item.id) || receivedItems[idx]
        : null;
      const actualQtyReceived = verified !== null && verified !== undefined && verified.quantityReceived !== undefined
        ? Number(verified.quantityReceived)
        : (item.quantitySent || item.quantity || 1);
      if (!Number.isInteger(actualQtyReceived) || actualQtyReceived < 0) {
        throw new Error(`Received quantity for ${item.productName || item.productId} must be a non-negative integer.`);
      }

      item.quantityReceived = actualQtyReceived;
      if (actualQtyReceived < (item.quantitySent || item.quantity || 1)) hasDiscrepancy = true;
    });

    sh.hasDiscrepancy = hasDiscrepancy;
    sh.status = hasDiscrepancy ? 'DISCREPANCY' : 'RECEIVED';

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        await client.query(
          SHIPMENT_RECEIVE_UPDATE_SQL,
          [sh.status, sh.receivedByNotes, receivedDateBS, hasDiscrepancy, JSON.stringify(sh.items), id]
        );

        for (const item of sh.items) {
          await client.query(
            SHIPMENT_RECEIVE_STOCK_SQL,
            shipmentReceiveStockParams(sh.destinationBranchId, item)
          );
        }
      });
    }
    logAuditEvent(req, 'RECEIVE_SHIPMENT', 'LOGISTICS', `Received Shipment #${sh.trackingCode}`);
    res.json(sh);
  } catch (err: any) {
    console.error('Error receiving shipment:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from shipments.routes.ts (post_cancel). */
export async function post_cancel(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const { reason } = req.body || {};
    // Actor identity comes from the verified session, never the request body
    // (VULN-002): a spoofed body user must not reach the audit trail.
    const cancelActor = req.user || getUserFromReq(req) || {};

    let sh = shipments.find((s) => s.id === id || s.trackingCode === id);
    if (!sh) return res.status(404).json({ message: 'Shipment / transfer not found' });
    if (sh.status === 'RECEIVED' || sh.status === 'DELIVERED') {
      res.status(400).json({ message: 'Transfers that have already been received cannot be cancelled.' });
      return;
    }
    if (sh.status === 'CANCELLED') {
      res.status(400).json({ message: `Transfer ${sh.trackingCode} is already cancelled.` });
      return;
    }

    const cancellationNotes = (sh.notes ? sh.notes + ' | ' : '') + `Transfer cancelled by ${cancelActor.name || cancelActor.email || 'System'}${reason ? ': ' + reason : ''}`;

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        const current = await client.query(SHIPMENT_FIND_FOR_CANCEL_SQL, [id]);
        if (!current.rows[0]) throw new Error('Shipment / transfer not found.');
        if (['RECEIVED', 'DELIVERED'].includes(current.rows[0].status)) throw new Error('Transfers that have already been received cannot be cancelled.');
        if (current.rows[0].status === 'CANCELLED') throw new Error('This transfer is already cancelled.');
        const sourceBranchId = current.rows[0].sourceBranchId || sh.sourceBranchId;
        const destinationBranchId = current.rows[0].destinationBranchId || sh.destinationBranchId;
        const items = typeof current.rows[0].items === 'string' ? JSON.parse(current.rows[0].items) : (current.rows[0].items || sh.items);
        await client.query(SHIPMENT_CANCEL_SQL, ['CANCELLED', cancellationNotes, id]);
        for (const item of items) {
          const qtySent = shipmentQtySent(item);
          if (qtySent > 0 && sourceBranchId) {
            await client.query(
              SHIPMENT_CANCEL_RESTORE_SOURCE_SQL,
              [qtySent, item.productId, sourceBranchId]
            );
          }
          if (qtySent > 0 && destinationBranchId) {
            await client.query(
              SHIPMENT_CANCEL_RELEASE_DEST_SQL,
              [qtySent, item.productId, destinationBranchId]
            );
          }
        }
      });
    }
    sh.status = 'CANCELLED';
    sh.notes = cancellationNotes;
    logAuditEvent(req, 'CANCEL_TRANSFER', 'LOGISTICS', `Cancelled transfer ${sh.trackingCode}`);
    res.json({ shipment: sh, message: `Transfer ${sh.trackingCode} cancelled successfully.` });
  } catch (err: any) {
    console.error('Error cancelling transfer:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from shipments.routes.ts (post_cancelReceive). */
export async function post_cancelReceive(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const { reason } = req.body || {};
    // Actor identity comes from the verified session, never the request body.
    const undoActor = req.user || getUserFromReq(req) || {};

    let sh = shipments.find((s) => s.id === id || s.trackingCode === id);
    if (!sh) return res.status(404).json({ message: 'Shipment / transfer not found' });
    if (sh.status !== 'RECEIVED' && sh.status !== 'DISCREPANCY') {
      return res.status(400).json({
        message: `Only received transfers can have their receipt cancelled. Transfer ${sh.trackingCode} is ${sh.status}.`,
      });
    }

    const undoNote = (sh.notes ? sh.notes + ' | ' : '') + `Receipt cancelled by ${undoActor.name || undoActor.email || 'System'}${reason ? ': ' + reason : ''}`;

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        const current = await client.query(SHIPMENT_FIND_FOR_CANCEL_SQL, [id]);
        const row = current.rows[0];
        if (!row) throw new Error('Shipment / transfer not found.');
        if (row.status !== 'RECEIVED' && row.status !== 'DISCREPANCY') {
          throw new Error(`Only received transfers can have their receipt cancelled. Transfer is ${row.status}.`);
        }
        const destBranchId = row.destinationBranchId;
        const items = typeof row.items === 'string' ? JSON.parse(row.items) : (row.items || sh.items);
        for (const item of items) {
          const qty = shipmentReceivedQty(item);
          if (qty > 0 && destBranchId) {
            const undone = await client.query(SHIPMENT_UNDO_RECEIVE_STOCK_SQL, [qty, item.productId, destBranchId]);
            if (undone.rowCount !== 1) {
              throw new Error(`Insufficient stock at the destination branch to undo the receipt of ${item.productName || item.productId}.`);
            }
          }
        }
        await client.query(SHIPMENT_UNDO_RECEIVE_UPDATE_SQL, [id, undoNote]);
      });
    }

    // In-memory cache mirror (same contract as post_cancel): the shipment is
    // back In-Transit with its receive bookkeeping cleared. Stock caches are
    // re-read by the cache-refresh hook after this mutating response.
    sh.status = 'IN_TRANSIT';
    sh.receivedByNotes = undefined;
    sh.receivedDateAD = undefined;
    sh.receivedDateBS = undefined;
    sh.hasDiscrepancy = false;
    sh.notes = undoNote;

    logAuditEvent(req, 'CANCEL_RECEIVE_TRANSFER', 'LOGISTICS', `Cancelled receipt of Shipment #${sh.trackingCode}; reverted to In-Transit`);
    res.json({ shipment: sh, message: `Receipt of transfer ${sh.trackingCode} cancelled. Inventory restored to In-Transit status.` });
  } catch (err: any) {
    console.error('Error cancelling shipment receipt:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}
