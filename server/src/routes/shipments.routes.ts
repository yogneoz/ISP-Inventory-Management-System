/**
 * Shipments routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerShipmentsRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import {
  branches,
  detectDateTypeMismatch,
  findBsDayRecordForAdDate,
  getPgConnected,
  inventoryStock,
  issueNextDocNumber,
  logAuditEvent,
  requirePermission,
  setShipments,
  shipments,
  withPrepended,
  withReplaced,
  withTransaction,
} from '../app';
import { pgPool } from '../app';

export function registerShipmentsRoutes(app: Express) {
app.get('/api/shipments', async (req, res) => {
  if (getPgConnected()) {
    try {
      const r = await pgPool.query(
        'SELECT id, tracking_code AS "trackingCode", type, source_branch_id AS "sourceBranchId", source_branch_name AS "sourceBranchName", destination_branch_id AS "destinationBranchId", destination_branch_name AS "destinationBranchName", dispatch_date_ad AS "dispatchDateAD", dispatch_date_bs AS "dispatchDateBS", estimated_arrival_ad AS "estimatedArrivalAD", status, notes, items, received_by_notes AS "receivedByNotes", received_date_ad AS "receivedDateAD", received_date_bs AS "receivedDateBS", has_discrepancy AS "hasDiscrepancy" FROM shipments ORDER BY created_at DESC'
      );
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching shipments from DB:', err);
    }
  }
  res.json(shipments);
});

app.post('/api/shipments', requirePermission('shipment-create'), async (req, res) => {
  try {
    const sourceBranch = branches.find((b) => b.id === req.body.sourceBranchId);
    const destBranch = branches.find((b) => b.id === req.body.destinationBranchId);

    // BS calendar gate: a shipment dispatch may only be posted when its date
    // has a seeded BS day record in bs_day_records (Nepali date is mandatory).
    const rawDispatchDateAD = req.body.dispatchDateAD || req.body.dispatchDateAd;
    const dispatchDateMismatch = detectDateTypeMismatch(rawDispatchDateAD, 'dispatchDateAD');
    if (dispatchDateMismatch) {
      return res.status(400).json({ message: dispatchDateMismatch, dateTypeMismatch: true });
    }
    const dispatchDateAD = String(rawDispatchDateAD || new Date().toISOString().split('T')[0]).split('T')[0];
    const bsDayForShipment = await findBsDayRecordForAdDate(dispatchDateAD);
    if (!bsDayForShipment.found) {
      return res.status(400).json({
        message: `BS date is not available for ${dispatchDateAD}. Please contact your system administrator for BS month seeding.`,
        bsDateMissing: true,
      });
    }

    const sourceBranchId = req.body.sourceBranchId || branches[0]?.id || 'WH001';
    const trackingCode = req.body.trackingCode || (await issueNextDocNumber(sourceBranchId, 'ST', dispatchDateAD));

    const newShipment = {
      ...req.body,
      id: req.body.id || `sh-${Date.now()}`,
      trackingCode,
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

    let shipmentAlreadyExists = shipments.some((s) => s.id === newShipment.id || s.trackingCode === newShipment.trackingCode);
    if (getPgConnected() && !shipmentAlreadyExists) {
      const existing = await pgPool.query(
        'SELECT 1 FROM shipments WHERE id = $1 OR tracking_code = $2 LIMIT 1',
        [newShipment.id, newShipment.trackingCode]
      );
      shipmentAlreadyExists = existing.rowCount === 1;
    }

    const idx = shipments.findIndex((s) => s.id === newShipment.id);
    setShipments(idx >= 0 ? withReplaced(shipments, idx, newShipment) : withPrepended(shipments, newShipment));

    if (getPgConnected()) {
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

        if (!shipmentAlreadyExists && newShipment.type === 'INTER_BRANCH' && newShipment.sourceBranchId) {
          for (const item of newShipment.items) {
            const qtySent = Number(item.quantitySent || item.quantity || 1);
            const updated = await client.query(
              `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP
               WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`,
              [qtySent, item.productId, newShipment.sourceBranchId]
            );
            if (updated.rowCount !== 1) throw new Error(`Insufficient stock for ${item.productName || item.productId}.`);

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
});

app.post('/api/shipments/:id/receive', requirePermission('wh-receive-pullouts'), async (req, res) => {
  try {
    const { id } = req.params;
    const { receivedItems, receivedByNotes } = req.body || {};
    let sh = shipments.find((s) => s.id === id);
    if (!sh) return res.status(404).json({ message: 'Shipment not found' });
    if (['RECEIVED', 'DELIVERED', 'CANCELLED'].includes(sh.status)) {
      return res.status(409).json({ message: `Shipment ${sh.trackingCode} is already ${sh.status.toLowerCase()} and cannot be received again.` });
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
          `UPDATE shipments SET status = $1, received_by_notes = $2, received_date_ad = CURRENT_DATE, received_date_bs = $3, has_discrepancy = $4, items = $5 WHERE id = $6`,
          [sh.status, sh.receivedByNotes, receivedDateBS, hasDiscrepancy, JSON.stringify(sh.items), id]
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
    }
    logAuditEvent(req, 'RECEIVE_SHIPMENT', 'LOGISTICS', `Received Shipment #${sh.trackingCode}`);
    res.json(sh);
  } catch (err: any) {
    console.error('Error receiving shipment:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.post('/api/shipments/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, reason } = req.body || {};

    let sh = shipments.find((s) => s.id === id || s.trackingCode === id);
    if (!sh) return res.status(404).json({ message: 'Shipment / transfer not found' });
    if (sh.status === 'RECEIVED' || sh.status === 'DELIVERED') {
      return res.status(400).json({ message: 'Transfers that have already been received cannot be cancelled.' });
    }
    if (sh.status === 'CANCELLED') {
      return res.status(400).json({ message: `Transfer ${sh.trackingCode} is already cancelled.` });
    }

    const cancellationNotes = (sh.notes ? sh.notes + ' | ' : '') + `Transfer cancelled by ${user?.name || 'Admin'}${reason ? ': ' + reason : ''}`;

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        const current = await client.query('SELECT status, source_branch_id AS "sourceBranchId", destination_branch_id AS "destinationBranchId", items, notes FROM shipments WHERE id = $1 OR tracking_code = $1 FOR UPDATE', [id]);
        if (!current.rows[0]) throw new Error('Shipment / transfer not found.');
        if (['RECEIVED', 'DELIVERED'].includes(current.rows[0].status)) throw new Error('Transfers that have already been received cannot be cancelled.');
        if (current.rows[0].status === 'CANCELLED') throw new Error('This transfer is already cancelled.');
        const sourceBranchId = current.rows[0].sourceBranchId || sh.sourceBranchId;
        const destinationBranchId = current.rows[0].destinationBranchId || sh.destinationBranchId;
        const items = typeof current.rows[0].items === 'string' ? JSON.parse(current.rows[0].items) : (current.rows[0].items || sh.items);
        await client.query('UPDATE shipments SET status = $1, notes = $2 WHERE id = $3 OR tracking_code = $3', ['CANCELLED', cancellationNotes, id]);
        for (const item of items) {
          const qtySent = Number(item.quantitySent || item.quantity) || 1;
          if (qtySent > 0 && sourceBranchId) {
            await client.query(
              `UPDATE inventory_stock SET quantity_on_hand = inventory_stock.quantity_on_hand + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
              [qtySent, item.productId, sourceBranchId]
            );
          }
          if (qtySent > 0 && destinationBranchId) {
            await client.query(
              `UPDATE inventory_stock SET incoming_qty = GREATEST(0, incoming_qty - $1), last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
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
});

app.post('/api/shipments/:id/cancel-receive', (req, res) => {
  return res.status(400).json({
    message: 'Received transfers cannot be cancelled. Only In-Transit transfers can be cancelled.',
  });
});

}
