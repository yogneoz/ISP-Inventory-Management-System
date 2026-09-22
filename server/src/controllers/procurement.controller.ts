/**
 * Procurement controller — HTTP orchestration for the procurement domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { getPgConnected, pgPool, purchaseOrders, issueNextDocNumber, setPurchaseOrders, withReplaced, withPrepended, inventoryStock, logAuditEvent, purchaseInvoices, withTransaction, branches, products, setPurchaseInvoices, suppliers, setInventoryStock, withAppended, customerDeviceRecords, setCustomerDeviceRecords, vendorPayments, getUserFromReq, broadcastChange, VENDOR_PAYMENT_SELECT, providerSupplierIdFromName, findBsDayRecordForAdDate, setVendorPayments } from '../app';
import { VendorPayment, VendorPaymentMethod } from '../../../client/src/types';
import {
  buildPoListSql, PO_UPSERT_SQL, poUpsertParams, PO_UPDATE_SQL, poUpdateParams, PO_FIND_FOR_DELETE_SQL, PO_DELETE_SQL,
  PO_FIND_BY_REF_SQL, PO_MARK_STATUS_SQL, PO_INCOMING_STOCK_SQL, poIncomingStockParams, PO_RELEASE_INCOMING_SQL,
  buildPiListSql, PI_UPSERT_SQL, piUpsertParams, PI_RECEIVE_STOCK_SQL, piReceiveStockParams,
  PI_TXN_LOG_SQL, piTxnLogParams, PI_DELETE_SQL, PI_RECORD_PAYMENT_SQL, PI_RESET_PAYMENT_SQL, PI_UNDO_PAYMENT_SQL,
  PI_LOCK_FOR_UPDATE_SQL, PI_BALANCE_AFTER_SQL, VP_LOCK_STATUS_SQL,
  PI_REVERSE_STOCK_SQL, CDR_ASSIGNED_CHECK_SQL, CDR_IN_STOCK_DELETE_SQL, PI_FIND_FOR_PAYMENT_SQL,
  VP_REVERSE_SQL, VP_INSERT_SQL, vpInsertParams, buildVendorPaymentWhere, VP_ORDER_BY, VP_BY_INVOICE_SQL_SUFFIX,
  LEDGER_INVOICES_SQL, ledgerNameParams, LEDGER_PAYMENTS_SQL_SUFFIX,
  PO_PATCH_STATUS_SQL, PI_EXISTS_SQL, PI_FIND_FOR_DELETE_SQL,
  FY_BY_ID_SQL, FY_BY_START_SQL, FY_CURRENT_SQL, VENDOR_OPENING_BALANCE_SQL,
} from '../models/procurement.repo';
/** Forwarded from procurement.routes.ts (get_purchaseOrders). */
export async function get_purchaseOrders(req: any, res: Response): Promise<any> {
const { branchId } = req.query;
  if (getPgConnected()) {
    try {
      const { sql: q, params } = buildPoListSql(branchId);
      const r = await pgPool.query(q, params as any[]);
      res.json(r.rows);
      return;
    } catch (err) {
      console.error('Error fetching POs from DB:', err);
    }
  }
  if (branchId && branchId !== 'ALL') {
    res.json(purchaseOrders.filter((po) => po.branchId === branchId));
    return;
  }
  res.json(purchaseOrders);

}

/** Forwarded from procurement.routes.ts (post_purchaseOrders). */
export async function post_purchaseOrders(req: any, res: Response): Promise<any> {
try {
    const items = req.body.items || [];
    const subtotalAmount = items.reduce((s: number, i: any) => s + (i.subtotal || (i.quantity * (i.unitPrice || 0))), 0);
    const taxAmount = items.reduce((s: number, i: any) => s + (i.taxAmount || 0), 0);
    const totalAmount = subtotalAmount + taxAmount;

    const poBranchId = req.body.branchId || 'WH001';
    const poOrderDate = req.body.orderDateAD || req.body.orderDateAd || new Date().toISOString().split('T')[0];
    const poNumber = req.body.poNumber || (await issueNextDocNumber(poBranchId, 'PO', poOrderDate));

    const newPO = {
      id: req.body.id || `po-${Date.now()}`,
      poNumber,
      subtotalAmount,
      taxAmount,
      totalAmount,
      orderDateAd: poOrderDate,
      orderDateBs: req.body.orderDateBS || req.body.orderDateBs || '2083-04-10 BS',
      ...req.body,
    };

    const idx = purchaseOrders.findIndex((p) => p.id === newPO.id);
    setPurchaseOrders(idx >= 0 ? withReplaced(purchaseOrders, idx, newPO) : withPrepended(purchaseOrders, newPO));

    if (getPgConnected()) {
      // PO header + reserved incoming stock commit atomically: a failure after
      // the upsert would otherwise leave incoming_qty reserved with no PO.
      await withTransaction(async (client) => {
        await client.query(PO_UPSERT_SQL, poUpsertParams(newPO, JSON.stringify(items)));

        if (newPO.branchId && Array.isArray(items)) {
          for (const item of items) {
            await client.query(PO_INCOMING_STOCK_SQL, poIncomingStockParams(newPO.branchId, item));
          }
        }
      });
    }

    if (newPO.branchId && Array.isArray(items)) {
      items.forEach((item: any) => {
        let stk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === newPO.branchId);
        if (stk) {
          stk.incomingQty = (stk.incomingQty || 0) + (Number(item.quantity) || 0);
          stk.lastUpdated = new Date().toISOString();
        }
      });
    }
    logAuditEvent(req, 'CREATE_PURCHASE_ORDER', 'PROCUREMENT', `Created Purchase Order #${newPO.poNumber} for supplier ${newPO.supplierName || 'Vendor'}`);
    res.status(201).json(newPO);
  } catch (err: any) {
    console.error('Error creating purchase order:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from procurement.routes.ts (put_Id). */
export async function put_Id(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const index = purchaseOrders.findIndex((p) => p.id === id);
    const existingPO = purchaseOrders[index];

    const items = req.body.items || existingPO?.items || [];
    const subtotalAmount = items.reduce((s: number, i: any) => s + (i.subtotal || (i.quantity * i.unitPrice)), 0);
    const taxAmount = items.reduce((s: number, i: any) => s + (i.taxAmount || 0), 0);
    const totalAmount = subtotalAmount + taxAmount;

    const updatedPO = {
      ...(existingPO || {}),
      ...req.body,
      subtotalAmount,
      taxAmount,
      totalAmount,
      items,
    };
    if (index >= 0) setPurchaseOrders(withReplaced(purchaseOrders, index, updatedPO));

    if (getPgConnected()) {
      await pgPool.query(PO_UPDATE_SQL, poUpdateParams(updatedPO, JSON.stringify(items), id));
    }
    logAuditEvent(req, 'UPDATE_PURCHASE_ORDER', 'PROCUREMENT', `Updated Purchase Order #${updatedPO.poNumber}`);
    res.json(updatedPO);
  } catch (err: any) {
    console.error('Error updating purchase order:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from procurement.routes.ts (delete_Id). */
export async function delete_Id(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    let po: any = purchaseOrders.find((entry) => entry.id === id);
    if (getPgConnected() && !po) {
      const result = await pgPool.query(PO_FIND_FOR_DELETE_SQL, [id]);
      po = result.rows[0];
    }
    if (!po) return res.status(404).json({ message: 'Purchase Order not found' });
    if (['RECEIVED', 'IN_PROGRESS'].includes(po.status)) {
      res.status(409).json({ message: 'Received or in-progress purchase orders cannot be deleted.' });
      return;
    }

    const linkedInvoice = purchaseInvoices.some((invoice) => invoice.poReferenceId === po.id || invoice.poReferenceId === po.poNumber);
    if (linkedInvoice) return res.status(409).json({ message: 'Delete the linked Purchase Invoice before deleting this Purchase Order.' });

    const items = typeof po.items === 'string' ? JSON.parse(po.items) : (po.items || []);
    if (getPgConnected()) {
      await withTransaction(async (client) => {
        for (const item of items) {
          await client.query(PO_RELEASE_INCOMING_SQL, [Number(item.quantity) || 0, item.productId, po.branchId]);
        }
        await client.query(PO_DELETE_SQL, [id]);
      });
    }

    setPurchaseOrders(purchaseOrders.filter((entry) => entry.id !== id));
    inventoryStock.forEach((stock) => {
      if (stock.branchId !== po.branchId) return;
      const item = items.find((entry: any) => entry.productId === stock.productId);
      if (item) stock.incomingQty = Math.max(0, (stock.incomingQty || 0) - (Number(item.quantity) || 0));
    });
    logAuditEvent(req, 'DELETE_PURCHASE_ORDER', 'PROCUREMENT', `Deleted Purchase Order #${po.poNumber}`);
    res.json({ success: true, deletedId: id });
  } catch (err: any) {
    console.error('Error deleting purchase order:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from procurement.routes.ts (patch_status). */
export async function patch_status(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const { status } = req.body;
    const po = purchaseOrders.find((p) => p.id === id);
    if (po) po.status = status;

    if (getPgConnected()) {
      await pgPool.query(PO_PATCH_STATUS_SQL, [status, id]);
    }
    logAuditEvent(req, 'UPDATE_PO_STATUS', 'PROCUREMENT', `Changed Purchase Order status to ${status}`);
    res.json(po || req.body);
  } catch (err: any) {
    console.error('Error updating PO status:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from procurement.routes.ts (get_purchaseInvoices). */
export async function get_purchaseInvoices(req: any, res: Response): Promise<any> {
const { branchId } = req.query;
  if (getPgConnected()) {
    try {
      const { sql: q, params } = buildPiListSql(branchId);
      const r = await pgPool.query(q, params as any[]);
      res.json(r.rows);
      return;
    } catch (err) {
      console.error('Error fetching purchase invoices from DB:', err);
    }
  }
  if (branchId && branchId !== 'ALL') {
    res.json(purchaseInvoices.filter((inv) => inv.branchId === branchId));
    return;
  }
  res.json(purchaseInvoices);

}

/** Forwarded from procurement.routes.ts (post_purchaseInvoices). */
export async function post_purchaseInvoices(req: any, res: Response): Promise<any> {
try {
    const targetBranchId = req.body.branchId || branches[0]?.id || 'WH001';
    const invDate = req.body.invoiceDateAD || req.body.invoiceDateAd || new Date().toISOString().split('T')[0];
    const invoiceNumber = req.body.invoiceNumber || (await issueNextDocNumber(targetBranchId, 'PI', invDate));
    const newInv = {
      id: req.body.id || `inv-${Date.now()}`,
      invoiceNumber,
      invoiceDateAD: invDate,
      invoiceDateBS: req.body.invoiceDateBS || req.body.invoiceDateBs || '2083-04-10 BS',
      ...req.body,
    };
    const items = req.body.items || req.body.lines || [];
    // Guard: the vendor bill date (stored as dueDateAD) can never be after the purchase date
    if (newInv.dueDateAD && newInv.invoiceDateAD && newInv.dueDateAD > newInv.invoiceDateAD) {
      res.status(400).json({ message: 'Vendor bill date cannot be after the purchase date.' });
      return;
    }
    const poReference = newInv.poReferenceId || req.body.poId;
    if (poReference) {
      let linkedPO = purchaseOrders.find((po) => po.id === poReference || po.poNumber === poReference);
      if (!linkedPO && getPgConnected()) {
        const poResult = await pgPool.query(PO_FIND_BY_REF_SQL, [poReference]);
        linkedPO = poResult.rows[0];
        if (linkedPO && typeof linkedPO.items === 'string') linkedPO.items = JSON.parse(linkedPO.items);
      }
      if (!linkedPO) return res.status(400).json({ message: 'The selected Purchase Order was not found.' });

      const poItems = new Map(linkedPO.items.map((item) => [item.productId, item]));
      const invoiceItems = new Map(items.map((item: any) => [item.productId, item]));
      const exceeding = items.find((item: any) => Number(item.quantity) > Number(poItems.get(item.productId)?.quantity || 0));
      const quantityMismatch = items.find((item: any) => Number(item.quantity) !== Number(poItems.get(item.productId)?.quantity || 0));
      const missing = linkedPO.items.find((item) => !invoiceItems.has(item.productId));
      const extra = items.find((item: any) => !poItems.has(item.productId));
      const typeMismatch = items.find((item: any) => {
        const poItem = poItems.get(item.productId);
        const product = products.find((entry) => entry.id === item.productId);
        return poItem && (item.productGroup || product?.productGroup) !== (poItem.productGroup || product?.productGroup);
      });
      if (exceeding) return res.status(400).json({ message: `Quantity exceeding PO for ${exceeding.productName || exceeding.productId}. Ordered quantity: ${poItems.get(exceeding.productId)?.quantity || 0}.` });
      if (missing) return res.status(400).json({ message: `PO product missing from vendor bill: ${missing.productName}.` });
      if (extra) return res.status(400).json({ message: `Product not present in selected Purchase Order: ${extra.productName || extra.productId}.` });
      if (typeMismatch) return res.status(400).json({ message: `Product type does not match the selected Purchase Order: ${typeMismatch.productName || typeMismatch.productId}.` });
      if (quantityMismatch) return res.status(400).json({ message: `Quantity must match the selected Purchase Order for ${quantityMismatch.productName || quantityMismatch.productId}.` });
      if (invoiceItems.size !== poItems.size) return res.status(400).json({ message: 'Purchase Order and vendor bill products must match exactly.' });
    }

    let invoiceAlreadyExists = purchaseInvoices.some((invoice) => invoice.id === newInv.id || invoice.invoiceNumber === newInv.invoiceNumber);
    if (getPgConnected() && !invoiceAlreadyExists) {
      const existing = await pgPool.query(PI_EXISTS_SQL, [newInv.id, newInv.invoiceNumber]);
      invoiceAlreadyExists = existing.rowCount === 1;
    }
    const idx = purchaseInvoices.findIndex((i) => i.id === newInv.id);
    setPurchaseInvoices(idx >= 0 ? withReplaced(purchaseInvoices, idx, newInv) : withPrepended(purchaseInvoices, newInv));

    // Resolve supplierId from the selected supplier name for the sub-ledger FK
    const supplierId = req.body.supplierId || undefined;
    const supLookup = suppliers.find(
      (s) => s.id === supplierId || s.name.toLowerCase() === (newInv.supplierName || '').toLowerCase()
    );
    const resolvedSupplierId = supplierId || supLookup?.id || null;

    if (getPgConnected()) {
      // All-or-nothing: invoice upsert + per-item stock receive + txn log + PO
      // status flip must commit together or not at all.
      await withTransaction(async (client) => {
        await client.query(PI_UPSERT_SQL, piUpsertParams({
          ...newInv,
          poReferenceId: newInv.poReferenceId || newInv.poId,
          supplierId: resolvedSupplierId,
          supplierName: newInv.supplierName || 'Vendor',
          branchId: targetBranchId,
        }, JSON.stringify(items)));

        if (!invoiceAlreadyExists) for (const item of items) {
          await client.query(PI_RECEIVE_STOCK_SQL, piReceiveStockParams(targetBranchId, item));

          await client.query(PI_TXN_LOG_SQL, piTxnLogParams(newInv, item, targetBranchId));
        }

        const poRef = newInv.poReferenceId || req.body.poId;
        if (poRef) {
          await client.query(PO_MARK_STATUS_SQL, ['RECEIVED', poRef]);
        }
      });
    }

    // Detect the PO used in this vendor bill and mark it RECEIVED (in-memory mirror for non-DB mode; DB mode is updated above)
    const billPoRef = newInv.poReferenceId || req.body.poId;
    const billLinkedPO = purchaseOrders.find((p) => p.id === billPoRef || p.poNumber === billPoRef);
    if (billLinkedPO) billLinkedPO.status = 'RECEIVED';

    if (!invoiceAlreadyExists) items.forEach((item: any) => {
      let stk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === targetBranchId);
      if (!stk) {
        stk = {
          id: `stk-${targetBranchId.toLowerCase()}-${item.productId}`,
          productId: item.productId,
          branchId: targetBranchId,
          quantityOnHand: 0,
          damagedQty: 0,
          reservedQty: 0,
          incomingQty: 0,
          minReorderLevel: 5,
          lastUpdated: new Date().toISOString(),
        };
        setInventoryStock(withAppended(inventoryStock, stk));
      }
      stk.quantityOnHand += Number(item.quantity) || 0;
      stk.lastUpdated = new Date().toISOString();
    });
    logAuditEvent(req, 'CREATE_PURCHASE_INVOICE', 'PROCUREMENT', `Created Purchase Invoice #${newInv.invoiceNumber}`);
    res.status(201).json(newInv);
  } catch (err: any) {
    console.error('Error creating purchase invoice:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from procurement.routes.ts (delete_Id2). */
export async function delete_Id2(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    let invoice: any = purchaseInvoices.find((entry) => entry.id === id);
    if (getPgConnected() && !invoice) {
      const result = await pgPool.query(PI_FIND_FOR_DELETE_SQL, [id]);
      invoice = result.rows[0];
    }
    if (!invoice) return res.status(404).json({ message: 'Purchase Invoice not found' });

    const items = typeof invoice.items === 'string' ? JSON.parse(invoice.items) : (invoice.items || []);
    const quantities = new Map<string, number>();
    const serials = items.flatMap((item: any) => (item.deviceSerials || []).map((serial: any) => serial.deviceSerial).filter(Boolean));
    items.forEach((item: any) => quantities.set(item.productId, (quantities.get(item.productId) || 0) + (Number(item.quantity) || 0)));

    const purchaseRefs = [invoice.vendorBillNumber, invoice.invoiceNumber].filter(Boolean);
    const localAssignedSerial = customerDeviceRecords.some(
      (record) => serials.includes(record.deviceSerial) && purchaseRefs.includes(record.purchaseBillRef || '') && record.status !== 'IN_STOCK'
    );
    if (localAssignedSerial) return res.status(409).json({ message: 'This invoice has serial devices that are already assigned or consumed and cannot be deleted.' });

    if (getPgConnected()) {
      // Invoice deletion + stock reversal + PO status restore commit atomically.
      // Serials is checked before the transaction as a fast path; the guarded
      // re-check inside runs under the same tx as the mutations.
      await withTransaction(async (client) => {
        if (serials.length > 0 && purchaseRefs.length > 0) {
          const assigned = await client.query(CDR_ASSIGNED_CHECK_SQL, [serials, purchaseRefs]);
          if (assigned.rowCount) throw new Error('This invoice has serial devices that are already assigned or consumed and cannot be deleted.');
        }
        for (const [productId, quantity] of quantities) {
          const updated = await client.query(PI_REVERSE_STOCK_SQL, [quantity, productId, invoice.branchId]);
          if (updated.rowCount !== 1) throw new Error(`Insufficient stock to reverse invoice item ${productId}.`);
        }
        if (serials.length > 0 && purchaseRefs.length > 0) {
          await client.query(CDR_IN_STOCK_DELETE_SQL, [serials, purchaseRefs]);
        }
        await client.query(PI_DELETE_SQL, [id]);
        if (invoice.poReferenceId) {
          await client.query(PO_MARK_STATUS_SQL, ['APPROVED', invoice.poReferenceId]);
        }
      });
    }

    setPurchaseInvoices(purchaseInvoices.filter((entry) => entry.id !== id));
    inventoryStock.forEach((stock) => {
      if (stock.branchId !== invoice.branchId) return;
      const quantity = quantities.get(stock.productId);
      if (quantity) stock.quantityOnHand = Math.max(0, stock.quantityOnHand - quantity);
    });
    setCustomerDeviceRecords(customerDeviceRecords.filter(
      (record) => !(serials.includes(record.deviceSerial) && purchaseRefs.includes(record.purchaseBillRef || '') && record.status === 'IN_STOCK')
    ));
    const linkedPO = purchaseOrders.find((entry) => entry.id === invoice.poReferenceId || entry.poNumber === invoice.poReferenceId);
    if (linkedPO) linkedPO.status = 'APPROVED';
    logAuditEvent(req, 'DELETE_PURCHASE_INVOICE', 'PROCUREMENT', `Deleted Purchase Invoice #${invoice.invoiceNumber} and reversed its stock`);
    res.json({ success: true, deletedId: id });
  } catch (err: any) {
    console.error('Error deleting purchase invoice:', err);
    res.status(409).json({ message: err.message || 'Unable to delete purchase invoice.' });
  }

}

/** Forwarded from procurement.routes.ts (post_pay). */
export async function post_pay(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const { amount } = req.body;

    const paymentAmount = Number(amount);
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      res.status(400).json({ message: 'Payment amount must be a number greater than 0.' });
      return;
    }

    if (!getPgConnected()) {
      // Demo mode: keep the legacy in-memory balance update.
      const inv = purchaseInvoices.find((i) => i.id === id);
      if (inv) {
        inv.amountPaid += paymentAmount;
        inv.paymentStatus = inv.amountPaid >= inv.grandTotal ? 'PAID' : 'PARTIAL';
      }
      logAuditEvent(req, 'RECORD_INVOICE_PAYMENT', 'PROCUREMENT', `Recorded payment of NPR ${paymentAmount.toLocaleString()} for Invoice`);
      res.json(inv || { message: 'Payment recorded' });
      return;
    }

    const invRes = await pgPool.query(PI_FIND_FOR_PAYMENT_SQL, [id]);
    const inv = invRes.rows[0];
    if (!inv) {
      res.status(404).json({ message: 'Purchase invoice not found' });
      return;
    }

    // Read-modify-write against the authoritative row inside a transaction so
    // concurrent payments cannot interleave and corrupt the balance (the
    // UPDATE itself re-derives payment_status from the final amount_paid).
    const finalRes = await withTransaction(async (client) => {
      const locked = await client.query(PI_LOCK_FOR_UPDATE_SQL, [id]);
      if (!locked.rows[0]) {
        const notFound: any = new Error('Purchase invoice not found');
        notFound.statusCode = 404;
        throw notFound;
      }
      await client.query(PI_RECORD_PAYMENT_SQL, [paymentAmount, id]);
      const after = await client.query(PI_BALANCE_AFTER_SQL, [id]);
      return after.rows[0];
    });

    logAuditEvent(req, 'RECORD_INVOICE_PAYMENT', 'PROCUREMENT', `Recorded payment of NPR ${paymentAmount.toLocaleString()} for Invoice`);
    res.json({ ...inv, amountPaid: Number(finalRes.amountPaid), paymentStatus: finalRes.paymentStatus, message: 'Payment recorded' });
  } catch (err: any) {
    console.error('Error recording payment:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from procurement.routes.ts (post_reversePayments). */
export async function post_reversePayments(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      res.status(400).json({ message: 'A reversal reason is required.' });
      return;
    }

    const inv = purchaseInvoices.find((i) => i.id === id);
    if (!inv) {
      res.status(404).json({ message: 'Purchase invoice not found.' });
      return;
    }
    // A reversal is only meaningful once the bill is fully settled. Compute
    // from amounts (rather than trusting paymentStatus) so invoices with a
    // stale PARTIAL flag but a full amountPaid are still recognized.
    const grandTotal = Number(inv.grandTotal) || 0;
    const amountPaid = Number(inv.amountPaid) || 0;
    if (grandTotal <= 0 || amountPaid < grandTotal) {
      res.status(409).json({ message: `Invoice #${inv.invoiceNumber} is not fully paid (status: ${inv.paymentStatus}, amount paid: ${amountPaid.toLocaleString()}).` });
      return;
    }

    // Find all POSTED payments for this invoice
    const paymentsToReverse = vendorPayments.filter((p) => p.invoiceId === id && p.status === 'POSTED');
    if (paymentsToReverse.length === 0) {
      res.status(409).json({ message: `No posted payments found for invoice #${inv.invoiceNumber}.` });
      return;
    }
    // Capture the settled total BEFORE resetting it so the audit trail and
    // response can report the actual reversed amount.
    const reversedTotal = paymentsToReverse.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        for (const payment of paymentsToReverse) {
          // Guarded per-row reversal: a payment concurrently reversed (or
          // voided) between the pre-check and this write aborts the whole
          // transaction, leaving the invoice balance untouched.
          const current = await client.query(VP_LOCK_STATUS_SQL, [payment.id]);
          if (!current.rows[0] || current.rows[0].status !== 'POSTED') {
            throw new Error(`Payment #${payment.paymentNumber} is no longer POSTED and cannot be reversed.`);
          }
          await client.query(VP_REVERSE_SQL, [reason, getUserFromReq(req).email || 'system', payment.id]);
        }
        // Reset the invoice amount_paid and payment_status
        await client.query(PI_RESET_PAYMENT_SQL, [id]);
      });
    }

    // Update in-memory state
    for (const payment of paymentsToReverse) {
      payment.status = 'REVERSED';
      payment.reversalReason = reason;
      payment.reversedBy = getUserFromReq(req).email || 'system';
      payment.reversedAtAD = new Date().toISOString();
    }
    inv.amountPaid = 0;
    inv.paymentStatus = 'UNPAID';

    logAuditEvent(
      req,
      'REVERSE_INVOICE_PAYMENTS',
      'PROCUREMENT',
      `Reversed ${paymentsToReverse.length} payment(s) totaling NPR ${reversedTotal.toLocaleString()} for Invoice #${inv.invoiceNumber} (${reason})`,
      inv.branchId
    );
    broadcastChange({ type: 'INVOICE_PAYMENTS_REVERSED', entity: 'purchase-invoices', branchId: inv.branchId });
    res.json({
      success: true,
      message: `Reversed ${paymentsToReverse.length} payment(s) totaling NPR ${reversedTotal.toLocaleString()} for Invoice #${inv.invoiceNumber}.`,
      reversedCount: paymentsToReverse.length,
      reversedTotal,
      invoiceId: inv.id,
    });
  } catch (err: any) {
    console.error('Error reversing invoice payments:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from procurement.routes.ts (get_vendorPayments). */
export async function get_vendorPayments(req: any, res: Response): Promise<any> {
const { supplierId, invoiceId, branchId, status, fromAd, toAd, fiscalYearId } = req.query;
  if (getPgConnected()) {
    try {
      const { where, params } = buildVendorPaymentWhere({ supplierId, invoiceId, branchId, status, fiscalYearId, fromAd, toAd });
      const r = await pgPool.query(`${VENDOR_PAYMENT_SELECT}${where}${VP_ORDER_BY}`, params as any[]);
      res.json(r.rows);
      return;
    } catch (err: any) {
      console.error('Error fetching vendor payments from DB:', err);
    }
  }
  let list = vendorPayments;
  if (supplierId) list = list.filter((p) => p.supplierId === String(supplierId));
  if (invoiceId) list = list.filter((p) => p.invoiceId === String(invoiceId));
  if (branchId && branchId !== 'ALL') list = list.filter((p) => p.branchId === String(branchId));
  if (status) list = list.filter((p) => p.status === String(status));
  if (fiscalYearId) list = list.filter((p) => p.fiscalYearId === String(fiscalYearId));
  if (fromAd) {
    const from = String(fromAd).split('T')[0];
    list = list.filter((p) => String(p.paymentDateAD || '').split('T')[0] >= from);
  }
  if (toAd) {
    const to = String(toAd).split('T')[0];
    list = list.filter((p) => String(p.paymentDateAD || '').split('T')[0] <= to);
  }
  res.json(list);

}

/** Forwarded from procurement.routes.ts (get_payments). */
export async function get_payments(req: any, res: Response): Promise<any> {
const { id } = req.params;
  if (getPgConnected()) {
    try {
      const r = await pgPool.query(`${VENDOR_PAYMENT_SELECT}${VP_BY_INVOICE_SQL_SUFFIX}`, [id]);
      res.json(r.rows);
      return;
    } catch (err: any) {
      console.error('Error fetching invoice payments from DB:', err);
    }
  }
  res.json(vendorPayments.filter((p) => p.invoiceId === id));

}

/** Forwarded from procurement.routes.ts (post_vendorPayments). */
export async function post_vendorPayments(req: any, res: Response): Promise<any> {
try {
    const body = req.body || {};
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ message: 'Payment amount must be greater than 0.' });
      return;
    }

    // Resolve the invoice first so supplier + branch can be inherited from it.
    let linkedInvoice: any = body.invoiceId
      ? purchaseInvoices.find((inv) => inv.id === body.invoiceId || inv.invoiceNumber === body.invoiceId)
      : undefined;
    if (!linkedInvoice && body.invoiceId && getPgConnected()) {
      const invRes = await pgPool.query(PI_FIND_FOR_PAYMENT_SQL, [body.invoiceId]);
      linkedInvoice = invRes.rows[0];
    }

    // Resolve supplier: explicit supplierId, else supplierName, else from invoice.
    let supplierId: string | undefined = body.supplierId || undefined;
    let supplierName = body.supplierName || linkedInvoice?.supplierName || '';
    if (!supplierId && supplierName) {
      const matched = suppliers.find((s) =>
        s.name.toLowerCase() === String(supplierName).toLowerCase()
      ) || suppliers.find((s) =>
        String(supplierName).toLowerCase().includes(s.name.toLowerCase())
      );
      if (matched) supplierId = matched.id;
    }
    if (!supplierId && body.supplierName) {
      supplierId = providerSupplierIdFromName(String(body.supplierName));
    }
    if (!supplierId && supplierName) {
      supplierId = providerSupplierIdFromName(supplierName);
    }
    if (!supplierName && supplierId) {
      const sup = suppliers.find((s) => s.id === supplierId);
      supplierName = sup?.name || '';
    }
    if (!supplierName) {
      res.status(400).json({ message: 'Supplier is required to record a vendor payment.' });
      return;
    }

    const branchId = body.branchId || linkedInvoice?.branchId || getUserFromReq(req).branchId || branches[0]?.id || 'WH001';
    const paymentDateAD = String(body.paymentDateAD || new Date().toISOString().split('T')[0]).split('T')[0];
    let paymentDateBS = body.paymentDateBS || linkedInvoice?.invoiceDateBS || '';
    try {
      const bsDay = await findBsDayRecordForAdDate(paymentDateAD);
      if (bsDay.found && bsDay.record?.bsDate) paymentDateBS = bsDay.record.bsDate;
    } catch (_e) {}
    if (!paymentDateBS) paymentDateBS = '2083-04-16 BS';

    const paymentMethod = (body.paymentMethod || 'CASH').toUpperCase();
    // Generate payment number from the daily per-branch sequence based on the
    // payment method: CP = Cash Payment, BP = Bank Payment
    // (transfer/cheque/card/online). Format: CP-BRC01-202609150001
    const payDocType = paymentMethod === 'CASH' ? 'CP' : 'BP';
    const paymentNumber = body.paymentNumber || (await issueNextDocNumber(branchId, payDocType, paymentDateAD));
    const id = `vp-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    const newPayment: VendorPayment = {
      id,
      paymentNumber,
      supplierId: supplierId || '',
      supplierName,
      branchId,
      invoiceId: linkedInvoice?.id || body.invoiceId || null,
      invoiceNumber: linkedInvoice?.invoiceNumber || body.invoiceNumber || null,
      paymentDateAD,
      paymentDateBS,
      amount,
      paymentMethod: paymentMethod as VendorPaymentMethod,
      bankName: body.bankName || null,
      bankBranch: body.bankBranch || null,
      accountNumber: body.accountNumber || null,
      chequeNumber: body.chequeNumber || null,
      chequeDateAD: body.chequeDateAD || null,
      chequeDateBS: body.chequeDateBS || null,
      transactionReference: body.transactionReference || null,
      notes: body.notes || null,
      status: 'POSTED',
      reversalReason: null,
      reversedBy: null,
      reversedAtAD: null,
      originalPaymentId: null,
      isDemo: false,
      createdBy: getUserFromReq(req).email || 'system',
    };

    setVendorPayments(withPrepended(vendorPayments, newPayment));

    if (getPgConnected()) {
      await pgPool.query(VP_INSERT_SQL, vpInsertParams(newPayment));
    }
    logAuditEvent(
      req,
      'RECORD_VENDOR_PAYMENT',
      'PROCUREMENT',
      `Recorded vendor payment #${paymentNumber} of NPR ${amount.toLocaleString()} to ${supplierName} via ${paymentMethod}`,
      branchId
    );
    broadcastChange({ type: 'VENDOR_PAYMENT', entity: 'purchase-invoices', branchId });
    res.status(201).json(newPayment);
  } catch (err: any) {
    console.error('Error creating vendor payment:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from procurement.routes.ts (post_reverse). */
export async function post_reverse(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      res.status(400).json({ message: 'A reversal reason is required.' });
      return;
    }
    const payment = vendorPayments.find((p) => p.id === id);
    if (!payment) {
      res.status(404).json({ message: 'Vendor payment not found.' });
      return;
    }
    if (payment.status !== 'POSTED') {
      res.status(409).json({ message: `Payment #${payment.paymentNumber} is already ${payment.status.toLowerCase()}.` });
      return;
    }

    if (getPgConnected()) {
      // Payment row + invoice-balance adjustment commit atomically; the
      // guarded re-check inside the tx closes the TOCTOU window between the
      // pre-check above and the write.
      await withTransaction(async (client) => {
        const current = await client.query(VP_LOCK_STATUS_SQL, [id]);
        if (!current.rows[0]) {
          const notFound: any = new Error('Vendor payment not found.');
          notFound.statusCode = 404;
          throw notFound;
        }
        if (current.rows[0].status !== 'POSTED') {
          const conflict: any = new Error(`Payment #${payment.paymentNumber} is already ${String(current.rows[0].status).toLowerCase()}.`);
          conflict.statusCode = 409;
          throw conflict;
        }
        // Reverse the payment row.
        await client.query(VP_REVERSE_SQL, [reason, getUserFromReq(req).email || 'system', id]);
        // Undo the amount from the linked invoice so its balance is restored.
        if (payment.invoiceId) {
          await client.query(PI_UNDO_PAYMENT_SQL, [Number(payment.amount) || 0, payment.invoiceId]);
        }
      });
    }

    payment.status = 'REVERSED';
    payment.reversalReason = reason;
    payment.reversedBy = getUserFromReq(req).email || 'system';
    payment.reversedAtAD = new Date().toISOString();

    // Mirror the invoice decrement in memory (only when not pg-connected).
    if (!getPgConnected() && payment.invoiceId) {
      const inv = purchaseInvoices.find((i) => i.id === payment.invoiceId);
      if (inv) {
        inv.amountPaid = Math.max(0, Number(inv.amountPaid || 0) - Number(payment.amount || 0));
        inv.paymentStatus = inv.amountPaid >= (Number(inv.grandTotal) || 0) ? 'PAID' : inv.amountPaid > 0 ? 'PARTIAL' : 'UNPAID';
      }
    }

    logAuditEvent(
      req,
      'REVERSE_VENDOR_PAYMENT',
      'PROCUREMENT',
      `Reversed vendor payment #${payment.paymentNumber} of NPR ${Number(payment.amount || 0).toLocaleString()} (${reason})`,
      payment.branchId
    );
    broadcastChange({ type: 'VENDOR_PAYMENT_REVERSED', entity: 'purchase-invoices', branchId: payment.branchId });
    res.json({
      success: true,
      message: `Payment #${payment.paymentNumber} reversed.`,
      paymentId: payment.id,
    });
  } catch (err: any) {
    console.error('Error reversing vendor payment:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from procurement.routes.ts (get_ledger). */
export async function get_ledger(req: any, res: Response): Promise<any> {
try {
    const { supplierId } = req.params;
    const { fromAd, toAd, fiscalYearId, branchId } = req.query;
    const supplier = suppliers.find((s) => s.id === supplierId);
    if (!supplier) {
      res.status(404).json({ message: 'Supplier not found.' });
      return;
    }

    const nameMatcher = (name: string) =>
      String(name || '').toLowerCase() === supplier.name.toLowerCase() ||
      String(name || '').toLowerCase().includes(supplier.name.toLowerCase()) ||
      supplier.name.toLowerCase().includes(String(name || '').toLowerCase());

    // Match invoices/payments by the exact supplier_id FK first (the reliable
    // route since duplicate supplier names can exist; e.g. demo vs real rows),
    // and fall back to name matching only for legacy rows without a supplier_id.
    const bySupplierId = (inv: any) =>
      inv.supplierId && inv.supplierId === supplier.id;
    const byLegacyName = (inv: any) => !inv.supplierId && nameMatcher(inv.supplierName);

    let invoices: any[] = purchaseInvoices.filter((inv) => bySupplierId(inv) || byLegacyName(inv));
    let payments: VendorPayment[] = vendorPayments.filter((p) =>
      (p.supplierId && p.supplierId === supplier.id) || byLegacyName(p)
    );

    if (getPgConnected()) {
      try {
        const invRes = await pgPool.query(LEDGER_INVOICES_SQL, ledgerNameParams(supplier));
        invoices = invRes.rows;
        const payRes = await pgPool.query(
          `${VENDOR_PAYMENT_SELECT}${LEDGER_PAYMENTS_SQL_SUFFIX}`,
          ledgerNameParams(supplier) as any[]
        );
        payments = payRes.rows;
      } catch (err: any) {
        console.error('Vendor ledger DB query failed, using cache:', err?.message || err);
      }
    }

    // Apply branch + fiscal-year/date scoping.
    const from = String(fromAd || '').split('T')[0];
    const to = String(toAd || '').split('T')[0];
    const scopedDate = (date: any) => {
      const d = String(date || '').split('T')[0];
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    };
    const inScope = (branch: string | undefined, date: any) =>
      (!branchId || branchId === 'ALL' || branch === branchId) && scopedDate(date);

    const invoiceLines = invoices
      .filter((inv) => inScope(inv.branchId, inv.invoiceDateAD))
      .map((inv) => ({
        id: `inv-${inv.id}`,
        documentNumber: inv.invoiceNumber,
        dateAD: String(inv.invoiceDateAD || '').split('T')[0],
        dateBS: inv.invoiceDateBS || '',
        amount: Number(inv.grandTotal) || 0,
        vatAmount: Number(inv.vatAmount) || 0,
        type: 'INVOICE' as const,
        notes: inv.notes || `Purchase invoice ${inv.invoiceNumber}`,
        paymentMethod: undefined,
        debit: Number(inv.grandTotal) || 0,
        credit: 0,
      }));

    const paymentLines = payments
      .filter((p) => p.status === 'POSTED' && inScope(p.branchId, p.paymentDateAD))
      .map((p) => ({
        id: `pay-${p.id}`,
        documentNumber: p.paymentNumber,
        dateAD: String(p.paymentDateAD || '').split('T')[0],
        dateBS: p.paymentDateBS || '',
        amount: Number(p.amount) || 0,
        vatAmount: undefined,
        type: 'PAYMENT' as const,
        notes: p.notes || `Payment via ${p.paymentMethod}${p.chequeNumber ? ` (Chq ${p.chequeNumber})` : ''}`,
        paymentMethod: p.paymentMethod,
        debit: 0,
        credit: Number(p.amount) || 0,
      }));

    const allLines = [...invoiceLines, ...paymentLines].sort((a, b) =>
      a.dateAD === b.dateAD ? a.documentNumber.localeCompare(b.documentNumber) : a.dateAD.localeCompare(b.dateAD)
    );

    // Resolve the fiscal-year opening balance from the vendor_opening_balances
    // register. Priority: explicit fiscalYearId → a from-date that equals a known
    // fiscal year start → the current fiscal year. When a persisted opening
    // exists, it is the carry-forward of the previous year's closing balance.
    let fyStartAD = '';
    let persistedOpening = 0;
    let usedPersistedOpening = false;
    if (getPgConnected()) {
      try {
        let fyRow: any = null;
        if (fiscalYearId) {
          const fyRes = await pgPool.query(FY_BY_ID_SQL, [fiscalYearId]);
          fyRow = fyRes.rows[0] || null;
        } else if (from) {
          const fyRes = await pgPool.query(FY_BY_START_SQL, [from]);
          fyRow = fyRes.rows[0] || null;
        } else {
          const fyRes = await pgPool.query(FY_CURRENT_SQL);
          fyRow = fyRes.rows[0] || null;
        }
        if (fyRow) {
          fyStartAD = String(fyRow.startDateAD || '').split('T')[0];
          const obRes = await pgPool.query(VENDOR_OPENING_BALANCE_SQL, [fyRow.id, supplier.id, branchId === 'ALL' ? null : branchId]);
          persistedOpening = Number(obRes.rows[0]?.total) || 0;
          usedPersistedOpening = true;
        }
      } catch (err: any) {
        console.warn('Vendor ledger fiscal-year opening lookup failed, falling back to period-net:', err?.message || err);
      }
    }

    // Opening balance:
    //  - With a persisted fiscal-year opening: that carry-forward value, plus any
    //    net activity between the fiscal-year start and an explicit earlier
    //    cut-off (`from`). The ledger period then begins at `from`.
    //  - Without a persisted opening (legacy / no fiscal year configured): net
    //    (debits - credits) strictly before the `from` date.
    let openingBalance: number;
    let periodLines: typeof allLines;
    if (usedPersistedOpening && fyStartAD) {
      const periodStart = from && from > fyStartAD ? from : fyStartAD;
      openingBalance =
        persistedOpening +
        allLines
          .filter((line) => line.dateAD >= fyStartAD && line.dateAD < periodStart)
          .reduce((sum, line) => sum + line.debit - line.credit, 0);
      periodLines = allLines.filter((line) => line.dateAD >= periodStart);
    } else {
      openingBalance = allLines
        .filter((line) => from && line.dateAD < from)
        .reduce((sum, line) => sum + line.debit - line.credit, 0);
      periodLines = allLines.filter((line) => !from || line.dateAD >= from);
    }

    let running = openingBalance;
    const ledger = periodLines.map((line) => {
      running += line.debit - line.credit;
      return { ...line, balance: running };
    });

    const periodDebit = ledger.reduce((sum, line) => sum + line.debit, 0);
    const periodCredit = ledger.reduce((sum, line) => sum + line.credit, 0);

    res.json({
      supplier: { id: supplier.id, name: supplier.name },
      openingBalance,
      openingSource: usedPersistedOpening && fyStartAD ? 'FISCAL_YEAR_OPENING' : 'PERIOD_NET',
      fiscalYearStartAD: fyStartAD || null,
      totalDebit: periodDebit,
      totalCredit: periodCredit,
      closingBalance: openingBalance + periodDebit - periodCredit,
      ledger,
    });
  } catch (err: any) {
    console.error('Error building vendor ledger:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

