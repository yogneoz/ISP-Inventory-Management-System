/**
 * Shipments controller — HTTP orchestration for the shipments domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { getPgConnected, pgPool, shipments, branches, detectDateTypeMismatch, findBsDayRecordForAdDate, getUserFromReq, issueNextDocNumber, permissionMatrix, setShipments, withReplaced, withPrepended, withTransaction, inventoryStock, setInventoryStock, transactionLogs, setTransactionLogs, products, logAuditEvent, serialLogs, setSerialLogs } from '../app';
import { planSerialGateEntries, resolveSerialGateInDb, SerialGateError, serialGateKey } from '../services/serialGate.service';
import { OperationError, errorResponse } from '../utils/operationError';
import {
  SHIPMENT_LIST_SQL, SHIPMENT_UPSERT_SQL, SHIPMENT_FIND_FOR_OVERWRITE_SQL, shipmentUpsertParams,
  shipmentQtySent, SHIPMENT_DEDUCT_SOURCE_SQL, SHIPMENT_INCOMING_DEST_SQL, shipmentIncomingDestParams,
  SHIPMENT_RECEIVE_UPDATE_SQL, SHIPMENT_RECEIVE_STOCK_SQL, shipmentReceiveStockParams,
  SHIPMENT_FIND_FOR_CANCEL_SQL, SHIPMENT_CANCEL_SQL, SHIPMENT_CANCEL_RESTORE_SOURCE_SQL, SHIPMENT_CANCEL_RELEASE_DEST_SQL,
  shipmentReceivedQty, SHIPMENT_UNDO_RECEIVE_STOCK_SQL, SHIPMENT_UNDO_RECEIVE_UPDATE_SQL, SHIPMENT_STOCK_LOCK_SQL,
  SERIAL_LOG_TRANSFER_FLIP_SQL, serialLogTransferFlipParams,
} from '../models/shipments.repo';
import { buildTxnMultiRowInsertSql, flattenTxnParams, txnInsertOnConflictParams } from '../models/inventory.repo';
import { bsDateOr400 } from '../utils/bsDate';
import type { TransactionLog } from '../../../client/src/types';

/**
 * Builds one movement-ledger row for a shipment leg: TRANSFER_OUT at the
 * source on dispatch, TRANSFER_IN at the destination on receipt, and the
 * compensating types on the two undo paths. quantityBefore is read from the
 * stock row LOCKED in the same transaction, so before + changed = after
 * always reconciles with inventory_stock.
 */
function buildTransferTxn(
  sh: { id: string; trackingCode: string },
  item: any,
  index: number,
  branchId: string,
  changeType: TransactionLog['changeType'],
  before: number,
  changed: number,
  timestampAD: string,
  timestampBS: string
): TransactionLog {
  const product = products.find((entry) => entry.id === item.productId);
  return {
    id: `txn-sh-${sh.id}-${changeType}-${index}`,
    transactionNumber: `${sh.trackingCode}-${index + 1}`,
    productId: item.productId,
    productSku: product?.sku || item.sku || '',
    productName: product?.name || item.productName || 'Product',
    branchId,
    changeType,
    quantityBefore: before,
    quantityChanged: changed,
    quantityAfter: Math.max(0, before + changed),
    unitCost: Number(item.unitCost ?? product?.costPrice) || 0,
    referenceDocId: sh.id,
    timestampAD: new Date(`${timestampAD}T00:00:00.000Z`).toISOString(),
    timestampBS,
  };
}

/**
 * Serial-register history entry for one transfer leg (same {status, sourceType,
 * sourceId, dateAD, notes} shape the other serial flows append).
 */
function shipmentSerialHistory(status: string, sourceId: string, dateAD: string, notes: string) {
  return [{ status, sourceType: 'SHIPMENT', sourceId, dateAD, notes }];
}

/**
 * In-memory (demo-mode) twin of SERIAL_LOG_TRANSFER_FLIP_SQL: flips only rows
 * that are currently in `fromStatus`, so both modes report identically.
 */
function flipShipmentSerialsMirror(
  deviceSerials: readonly string[],
  fromStatus: string,
  toStatus: string,
  branchId: string | null,
  sourceId: string,
  dateAD: string,
  notes: string
): void {
  const keys = new Set(deviceSerials.map((s) => serialGateKey(s)).filter(Boolean));
  if (keys.size === 0) return;
  const entry = shipmentSerialHistory(toStatus, sourceId, dateAD, notes)[0];
  let changed = false;
  const next = serialLogs.map((row: any) => {
    if (!keys.has(serialGateKey(row?.deviceSerial)) || String(row?.status || '') !== fromStatus) return row;
    changed = true;
    const history = Array.isArray(row?.history) ? [...row.history, entry] : [entry];
    return {
      ...row,
      status: toStatus,
      branchId: branchId ?? row?.branchId,
      sourceType: 'SHIPMENT',
      sourceId,
      history,
      historyJson: JSON.stringify(history),
      updatedAt: new Date().toISOString(),
    };
  });
  if (changed) setSerialLogs(next as any);
}

/** Maps a serial-gate refusal to its HTTP status; anything else stays a 500. */
function shipmentErrorResponse(err: any): { status: number; message: string } {
  if (err instanceof SerialGateError) return { status: err.status, message: err.message };
  return errorResponse(err);
}

/**
 * Merges ledger rows into the in-memory mirror, deduplicating by id so the
 * PG path (which already persisted its rows) and the demo-mode path can both
 * call it safely.
 */
function appendLedgerMirror(rows: TransactionLog[]): void {
  if (rows.length === 0) return;
  const known = new Set(transactionLogs.map((entry) => entry.id));
  const fresh: TransactionLog[] = [];
  for (const row of rows) {
    if (!known.has(row.id)) {
      known.add(row.id);
      fresh.push(row);
    }
  }
  if (fresh.length > 0) setTransactionLogs([...fresh, ...transactionLogs]);
}

/** Forwarded from shipments.routes.ts (get_shipments). */
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
    // Same derive-or-400 resolver the receipt path uses, so the refusal carries
    // bsDateReason + calendarCoverage and the UI can route the operator to the
    // BS Calendar screen instead of only printing a message.
    const dispatchDateBS = await bsDateOr400(res, dispatchDateAD);
    if (!dispatchDateBS) return;

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
      dispatchDateBS,
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
          // Slice E: a dispatched unit LEAVES the source branch's sellable pool.
          // Plan one entry per unit, resolve them through the shared gate under
          // this transaction's lock (IN_STOCK at the source), then flip
          // IN_STOCK → IN_TRANSIT so no other screen can sell it mid-transit.
          const transferSerialItems = newShipment.items.map((it: any) => ({
            ...it,
            quantity: shipmentQtySent(it),
          }));
          const serialPlan = planSerialGateEntries(transferSerialItems, products as any[]);
          if (serialPlan.error) throw new SerialGateError(400, serialPlan.error);
          await resolveSerialGateInDb(
            client,
            serialPlan.entries,
            {
              branchId: String(newShipment.sourceBranchId),
              branchLabel: sourceBranch?.name,
              matchProduct: true,
              allowedStatuses: ['IN_STOCK'],
            },
            { action: 'dispatched', productName: (entry) => entry.productName }
          );
          for (const entry of serialPlan.entries) {
            await client.query(
              SERIAL_LOG_TRANSFER_FLIP_SQL,
              serialLogTransferFlipParams(
                'IN_TRANSIT',
                null,
                shipmentSerialHistory('IN_TRANSIT', newShipment.trackingCode, dispatchDateAD, `Dispatched on transfer ${newShipment.trackingCode}`),
                newShipment.trackingCode,
                entry.deviceSerial,
                'IN_STOCK'
              )
            );
          }

          // Aggregate availability PER PRODUCT before any deduction: duplicate
          // lines of one product must not each pass against the same balance.
          // The refusal is a clean 400 with available/requested numbers.
          const requestedPerProduct = new Map<string, { qty: number; name: string }>();
          for (const item of newShipment.items) {
            const entry = requestedPerProduct.get(item.productId) || {
              qty: 0,
              name: String(item.productName || item.productId),
            };
            entry.qty += shipmentQtySent(item);
            requestedPerProduct.set(item.productId, entry);
          }
          for (const [productId, requested] of requestedPerProduct) {
            const lockedRow = await client.query(SHIPMENT_STOCK_LOCK_SQL, [productId, newShipment.sourceBranchId]);
            const available = Number(lockedRow.rows[0]?.quantityOnHand) || 0;
            if (available < requested.qty) {
              throw new OperationError(
                400,
                `Insufficient inventory at the source branch for ${requested.name}. Available: ${available}, requested: ${requested.qty}.`
              );
            }
          }

          const dispatchTxns: TransactionLog[] = [];
          let lineIdx = 0;
          for (const item of newShipment.items) {
            const qtySent = shipmentQtySent(item);
            // Lock the source row so the TRANSFER_OUT ledger row records the
            // TRUE quantity before/after inside this same transaction.
            const locked = await client.query(SHIPMENT_STOCK_LOCK_SQL, [item.productId, newShipment.sourceBranchId]);
            const before = Number(locked.rows[0]?.quantityOnHand) || 0;
            const updated = await client.query(
              SHIPMENT_DEDUCT_SOURCE_SQL,
              [qtySent, item.productId, newShipment.sourceBranchId]
            );
            if (updated.rowCount !== 1) {
              throw new OperationError(400, `Insufficient stock for ${item.productName || item.productId}. The source branch balance changed — reload and retry.`);
            }
            dispatchTxns.push(buildTransferTxn(newShipment, item, lineIdx++, newShipment.sourceBranchId, 'TRANSFER_OUT', before, -qtySent, newShipment.dispatchDateAD, newShipment.dispatchDateBS));

            if (newShipment.destinationBranchId) {
              await client.query(
                SHIPMENT_INCOMING_DEST_SQL,
                shipmentIncomingDestParams(newShipment.destinationBranchId, item)
              );
            }
          }
          if (dispatchTxns.length > 0) {
            await client.query(buildTxnMultiRowInsertSql(dispatchTxns.length), flattenTxnParams(dispatchTxns.map((txn) => txnInsertOnConflictParams(txn))));
          }
        }
      });
    }

    if (!shipmentAlreadyExists && newShipment.type === 'INTER_BRANCH' && newShipment.sourceBranchId) {
      // Demo-mode register mirror: same IN_STOCK → IN_TRANSIT flip.
      flipShipmentSerialsMirror(
        newShipment.items.flatMap((item: any) =>
          (Array.isArray(item.deviceSerials) ? item.deviceSerials : [])
            .slice(0, shipmentQtySent(item))
            .map((s: any) => String(typeof s === 'string' ? s : s?.deviceSerial || ''))
        ),
        'IN_STOCK',
        'IN_TRANSIT',
        null,
        newShipment.trackingCode,
        dispatchDateAD,
        `Dispatched on transfer ${newShipment.trackingCode}`
      );
      const dispatchTxns: TransactionLog[] = [];
      const dispatchSrcId = newShipment.sourceBranchId;
      newShipment.items.forEach((item: any, idx: number) => {
        const qtySent = Number(item.quantitySent || item.quantity || 1);
        let sourceStk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === newShipment.sourceBranchId);
        const before = Number(sourceStk?.quantityOnHand) || 0;
        if (sourceStk) {
          sourceStk.quantityOnHand = Math.max(0, sourceStk.quantityOnHand - qtySent);
          sourceStk.lastUpdated = new Date().toISOString();
        }
        dispatchTxns.push(buildTransferTxn(newShipment, item, idx, dispatchSrcId, 'TRANSFER_OUT', before, -qtySent, newShipment.dispatchDateAD, newShipment.dispatchDateBS));
        if (newShipment.destinationBranchId) {
          let destStk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === newShipment.destinationBranchId);
          if (destStk) {
            destStk.incomingQty = (destStk.incomingQty || 0) + qtySent;
            destStk.lastUpdated = new Date().toISOString();
          }
        }
      });
      appendLedgerMirror(dispatchTxns);
    }
    logAuditEvent(req, 'CREATE_SHIPMENT', 'LOGISTICS', `Created Shipment #${newShipment.trackingCode}`);
    res.status(201).json(newShipment);
  } catch (err: any) {
    console.error('Error creating shipment:', err);
    const mapped = shipmentErrorResponse(err);
    res.status(mapped.status).json({ message: mapped.message });
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
    // BS dates are mandatory: derive the receipt BS date from
    // bs_day_records for the receipt's own AD date; 400 when the day is
    // unseeded (the old behavior stored NULL, leaving a RECEIVED shipment
    // without its BS date).
    const receivedDateBS = await bsDateOr400(res, sh.receivedDateAD);
    if (!receivedDateBS) return;
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

      // Which dispatch serials actually arrived. The receive-verification modal
      // sends the ticked-off list; a direct API call falls back to the first N
      // dispatched serials. Units that did not arrive stay IN_TRANSIT at the
      // source so they remain traceable and cancellable.
      const verifiedSerials = Array.isArray(verified?.receivedSerials) ? verified.receivedSerials : [];
      const serialSource = verifiedSerials.length > 0
        ? verifiedSerials
        : (Array.isArray(item.deviceSerials) ? item.deviceSerials : []);
      item.receivedSerials = serialSource
        .slice(0, actualQtyReceived)
        .map((s: any) => String(typeof s === 'string' ? s : s?.deviceSerial || '').trim())
        .filter(Boolean)
        .map((deviceSerial: string) => ({ deviceSerial }));
    });

    sh.hasDiscrepancy = hasDiscrepancy;
    sh.status = hasDiscrepancy ? 'DISCREPANCY' : 'RECEIVED';

    const receiveTxns: TransactionLog[] = [];
    if (getPgConnected()) {
      await withTransaction(async (client) => {
        await client.query(
          SHIPMENT_RECEIVE_UPDATE_SQL,
          [sh.status, sh.receivedByNotes, receivedDateBS, hasDiscrepancy, JSON.stringify(sh.items), id]
        );

        // Slice E: received units land IN_STOCK at the destination branch. The
        // gate resolves them as IN_TRANSIT at the source under this lock; an
        // unknown or already-moved serial refuses the whole receipt.
        const receivedPlanItems = sh.items
          .map((item: any) => ({
            ...item,
            quantity: (item.receivedSerials || []).length,
            deviceSerials: item.receivedSerials || [],
          }))
          .filter((item: any) => item.quantity > 0);
        if (receivedPlanItems.length > 0) {
          const receivedPlan = planSerialGateEntries(receivedPlanItems, products as any[]);
          if (receivedPlan.error) throw new SerialGateError(400, receivedPlan.error);
          await resolveSerialGateInDb(
            client,
            receivedPlan.entries,
            {
              branchId: String(sh.sourceBranchId),
              matchProduct: true,
              allowedStatuses: ['IN_TRANSIT'],
            },
            { action: 'received', productName: (entry) => entry.productName }
          );
          for (const entry of receivedPlan.entries) {
            await client.query(
              SERIAL_LOG_TRANSFER_FLIP_SQL,
              serialLogTransferFlipParams(
                'IN_STOCK',
                sh.destinationBranchId || null,
                shipmentSerialHistory('IN_STOCK', sh.trackingCode, sh.receivedDateAD || new Date().toISOString().split('T')[0], `Received on transfer ${sh.trackingCode}`),
                sh.trackingCode,
                entry.deviceSerial,
                'IN_TRANSIT'
              )
            );
          }
        }

        let lineIdx = 0;
        for (const item of sh.items) {
          const receivedQty = shipmentReceivedQty(item);
          // Lock the destination row so the TRANSFER_IN ledger row records
          // the true quantity before/after alongside the credit itself.
          const locked = await client.query(SHIPMENT_STOCK_LOCK_SQL, [item.productId, sh.destinationBranchId]);
          const before = Number(locked.rows[0]?.quantityOnHand) || 0;
          await client.query(
            SHIPMENT_RECEIVE_STOCK_SQL,
            shipmentReceiveStockParams(sh.destinationBranchId, item)
          );
          if (sh.destinationBranchId) {
            receiveTxns.push(buildTransferTxn(sh, item, lineIdx++, sh.destinationBranchId, 'TRANSFER_IN', before, receivedQty, sh.receivedDateAD || new Date().toISOString().split('T')[0], receivedDateBS || ''));
          }
        }
        if (receiveTxns.length > 0) {
          await client.query(buildTxnMultiRowInsertSql(receiveTxns.length), flattenTxnParams(receiveTxns.map((txn) => txnInsertOnConflictParams(txn))));
        }
      });
    }
    // Mirror the settlement in memory: demo mode has no other path that ever
    // credited destination stock on receipt, so the ledger and QOH both lived
    // only on the PG path before this.
    if (sh.destinationBranchId) {
      const receiveDestId = sh.destinationBranchId;
      sh.items.forEach((item: any, idx: number) => {
        const receivedQty = shipmentReceivedQty(item);
        let destStk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === receiveDestId);
        if (!destStk) {
          destStk = {
            id: `stk-${receiveDestId.toLowerCase()}-${item.productId}`,
            productId: item.productId,
            branchId: receiveDestId,
            quantityOnHand: 0,
            damagedQty: 0,
            reservedQty: 0,
            incomingQty: 0,
            minReorderLevel: 5,
            lastUpdated: new Date().toISOString(),
          };
          setInventoryStock([...inventoryStock, destStk]);
        }
        const before = Number(destStk.quantityOnHand) || 0;
        destStk.quantityOnHand = before + receivedQty;
        destStk.incomingQty = Math.max(0, (destStk.incomingQty || 0) - receivedQty);
        destStk.lastUpdated = new Date().toISOString();
        receiveTxns.push(buildTransferTxn(sh, item, idx, receiveDestId, 'TRANSFER_IN', before, receivedQty, sh.receivedDateAD || new Date().toISOString().split('T')[0], receivedDateBS || ''));
      });
    }
    // Demo-mode register mirror: the received units land at the destination.
    flipShipmentSerialsMirror(
      sh.items.flatMap((item: any) => (item.receivedSerials || []).map((s: any) => String(s.deviceSerial || ''))),
      'IN_TRANSIT',
      'IN_STOCK',
      sh.destinationBranchId || null,
      sh.trackingCode,
      sh.receivedDateAD || new Date().toISOString().split('T')[0],
      `Received on transfer ${sh.trackingCode}`
    );
    appendLedgerMirror(receiveTxns);
    logAuditEvent(req, 'RECEIVE_SHIPMENT', 'LOGISTICS', `Received Shipment #${sh.trackingCode}`);
    res.json(sh);
  } catch (err: any) {
    console.error('Error receiving shipment:', err);
    const mapped = shipmentErrorResponse(err);
    res.status(mapped.status).json({ message: mapped.message });
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
    const cancelDateAD = new Date().toISOString().split('T')[0];
    const cancelBsDay = await findBsDayRecordForAdDate(cancelDateAD);
    const cancelDateBS = cancelBsDay.found ? `${cancelBsDay.record.bsDate} BS` : '';
    const cancelTxns: TransactionLog[] = [];

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
        let lineIdx = 0;
        for (const item of items) {
          const qtySent = shipmentQtySent(item);
          if (qtySent > 0 && sourceBranchId) {
            // Lock the source row so the TRANSFER_CANCELLED ledger row carries
            // the true before/after of the restoration.
            const locked = await client.query(SHIPMENT_STOCK_LOCK_SQL, [item.productId, sourceBranchId]);
            const before = Number(locked.rows[0]?.quantityOnHand) || 0;
            await client.query(
              SHIPMENT_CANCEL_RESTORE_SOURCE_SQL,
              [qtySent, item.productId, sourceBranchId]
            );
            cancelTxns.push(buildTransferTxn(sh, item, lineIdx++, sourceBranchId, 'TRANSFER_CANCELLED', before, qtySent, cancelDateAD, cancelDateBS));
          }
          if (qtySent > 0 && destinationBranchId) {
            await client.query(
              SHIPMENT_CANCEL_RELEASE_DEST_SQL,
              [qtySent, item.productId, destinationBranchId]
            );
          }
        }
        if (cancelTxns.length > 0) {
          await client.query(buildTxnMultiRowInsertSql(cancelTxns.length), flattenTxnParams(cancelTxns.map((txn) => txnInsertOnConflictParams(txn))));
        }

        // Slice E: units that never reached their destination go back to the
        // source branch's sellable pool (IN_TRANSIT → IN_STOCK).
        const cancelSerials = (items as any[]).flatMap((item: any) =>
          (Array.isArray(item?.deviceSerials) ? item.deviceSerials : []).map((s: any) =>
            String(typeof s === 'string' ? s : s?.deviceSerial || '').trim()
          )
        );
        for (const deviceSerial of cancelSerials.filter(Boolean)) {
          await client.query(
            SERIAL_LOG_TRANSFER_FLIP_SQL,
            serialLogTransferFlipParams(
              'IN_STOCK',
              sourceBranchId || null,
              shipmentSerialHistory('IN_STOCK', id, cancelDateAD, `Transfer ${id} cancelled`),
              id,
              deviceSerial,
              'IN_TRANSIT'
            )
          );
        }
      });
    }
    // Demo-mode register mirror for the same restoration.
    flipShipmentSerialsMirror(
      sh.items.flatMap((item: any) =>
        (Array.isArray(item?.deviceSerials) ? item.deviceSerials : []).map((s: any) =>
          String(typeof s === 'string' ? s : s?.deviceSerial || '')
        )
      ),
      'IN_TRANSIT',
      'IN_STOCK',
      sh.sourceBranchId || null,
      id,
      cancelDateAD,
      `Transfer ${id} cancelled`
    );
    // Mirror the restoration in memory: demo mode previously never returned
    // source stock or released the destination reservation on cancel.
    sh.items.forEach((item: any, idx: number) => {
      const qtySent = shipmentQtySent(item);
      if (qtySent <= 0) return;
      if (sh.sourceBranchId) {
        const sourceStk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === sh.sourceBranchId);
        const before = Number(sourceStk?.quantityOnHand) || 0;
        if (sourceStk) {
          sourceStk.quantityOnHand = before + qtySent;
          sourceStk.lastUpdated = new Date().toISOString();
        }
        cancelTxns.push(buildTransferTxn(sh, item, idx, sh.sourceBranchId, 'TRANSFER_CANCELLED', before, qtySent, cancelDateAD, cancelDateBS));
      }
      if (sh.destinationBranchId) {
        const destStk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === sh.destinationBranchId);
        if (destStk) {
          destStk.incomingQty = Math.max(0, (destStk.incomingQty || 0) - qtySent);
          destStk.lastUpdated = new Date().toISOString();
        }
      }
    });
    appendLedgerMirror(cancelTxns);
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
    const undoDateAD = new Date().toISOString().split('T')[0];
    const undoBsDay = await findBsDayRecordForAdDate(undoDateAD);
    const undoDateBS = undoBsDay.found ? `${undoBsDay.record.bsDate} BS` : '';
    const undoTxns: TransactionLog[] = [];

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
        let lineIdx = 0;
        for (const item of items) {
          const qty = shipmentReceivedQty(item);
          if (qty > 0 && destBranchId) {
            // Lock the destination row so the TRANSFER_RECEIPT_CANCELLED
            // ledger row carries the true before/after of the reversal.
            const locked = await client.query(SHIPMENT_STOCK_LOCK_SQL, [item.productId, destBranchId]);
            const before = Number(locked.rows[0]?.quantityOnHand) || 0;
            const undone = await client.query(SHIPMENT_UNDO_RECEIVE_STOCK_SQL, [qty, item.productId, destBranchId]);
            if (undone.rowCount !== 1) {
              throw new Error(`Insufficient stock at the destination branch to undo the receipt of ${item.productName || item.productId}.`);
            }
            undoTxns.push(buildTransferTxn(sh, item, lineIdx++, destBranchId, 'TRANSFER_RECEIPT_CANCELLED', before, -qty, undoDateAD, undoDateBS));
          }
        }
        if (undoTxns.length > 0) {
          await client.query(buildTxnMultiRowInsertSql(undoTxns.length), flattenTxnParams(undoTxns.map((txn) => txnInsertOnConflictParams(txn))));
        }

        // Slice E: undoing a receipt puts the units back in transit from the
        // source branch (IN_STOCK at the destination → IN_TRANSIT).
        const undoSerials = (items as any[]).flatMap((item: any) => {
          const list = Array.isArray(item?.receivedSerials) && item.receivedSerials.length > 0
            ? item.receivedSerials
            : (Array.isArray(item?.deviceSerials) ? item.deviceSerials : []);
          return list.map((s: any) => String(typeof s === 'string' ? s : s?.deviceSerial || '').trim());
        });
        for (const deviceSerial of undoSerials.filter(Boolean)) {
          await client.query(
            SERIAL_LOG_TRANSFER_FLIP_SQL,
            serialLogTransferFlipParams(
              'IN_TRANSIT',
              row.sourceBranchId || sh.sourceBranchId || null,
              shipmentSerialHistory('IN_TRANSIT', id, undoDateAD, `Receipt of transfer ${id} cancelled`),
              id,
              deviceSerial,
              'IN_STOCK'
            )
          );
        }
        await client.query(SHIPMENT_UNDO_RECEIVE_UPDATE_SQL, [id, undoNote]);
      });
    }

    // In-memory cache mirror (same contract as post_cancel): the shipment is
    // back In-Transit with its receive bookkeeping cleared. Destination stock
    // is reversed here too — demo mode previously never debited it, so the
    // undo silently kept fabricating credited units.
    if (sh.destinationBranchId) {
      const undoDestId = sh.destinationBranchId;
      sh.items.forEach((item: any, idx: number) => {
        const qty = shipmentReceivedQty(item);
        if (qty <= 0) return;
        const destStk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === undoDestId);
        const before = Number(destStk?.quantityOnHand) || 0;
        if (destStk) {
          destStk.quantityOnHand = Math.max(0, before - qty);
          destStk.incomingQty = (destStk.incomingQty || 0) + qty;
          destStk.lastUpdated = new Date().toISOString();
        }
        undoTxns.push(buildTransferTxn(sh, item, idx, undoDestId, 'TRANSFER_RECEIPT_CANCELLED', before, -qty, undoDateAD, undoDateBS));
      });
    }
    // Demo-mode register mirror for the undo.
    flipShipmentSerialsMirror(
      sh.items.flatMap((item: any) => {
        const list = Array.isArray(item?.receivedSerials) && item.receivedSerials.length > 0
          ? item.receivedSerials
          : (Array.isArray(item?.deviceSerials) ? item.deviceSerials : []);
        return list.map((s: any) => String(typeof s === 'string' ? s : s?.deviceSerial || ''));
      }),
      'IN_STOCK',
      'IN_TRANSIT',
      sh.sourceBranchId || null,
      id,
      undoDateAD,
      `Receipt of transfer ${id} cancelled`
    );
    appendLedgerMirror(undoTxns);
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
    const mapped = shipmentErrorResponse(err);
    res.status(mapped.status).json({ message: mapped.message });
  }

}
