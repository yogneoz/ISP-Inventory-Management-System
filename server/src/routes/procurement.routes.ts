/**
 * Procurement routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerProcurementRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import {
  branches,
  broadcastChange,
  customerDeviceRecords,
  findBsDayRecordForAdDate,
  getPgConnected,
  getUserFromReq,
  inventoryStock,
  issueNextDocNumber,
  logAuditEvent,
  products,
  providerSupplierIdFromName,
  purchaseInvoices,
  purchaseOrders,
  requirePermission,
  requireRole,
  setCustomerDeviceRecords,
  setInventoryStock,
  setPurchaseInvoices,
  setPurchaseOrders,
  setVendorPayments,
  suppliers,
  vendorPayments,
  withAppended,
  withPrepended,
  withReplaced,
  withTransaction,
} from '../app';
import { VENDOR_PAYMENT_SELECT, pgPool } from '../app';
import type { VendorPayment, VendorPaymentMethod } from '../../../client/src/types';

export function registerProcurementRoutes(app: Express) {
app.get('/api/purchase-orders', async (req, res) => {
  const { branchId } = req.query;
  if (getPgConnected()) {
    try {
      const q =
        'SELECT id, po_number AS "poNumber", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", order_date_ad AS "orderDateAD", order_date_bs AS "orderDateBS", expected_delivery_date_ad AS "expectedDeliveryDateAD", status, subtotal_amount AS "subtotalAmount", tax_amount AS "taxAmount", total_amount AS "totalAmount", notes, items FROM purchase_orders' +
        (branchId && branchId !== 'ALL' ? ' WHERE branch_id = $1' : '') +
        ' ORDER BY created_at DESC';
      const params = branchId && branchId !== 'ALL' ? [branchId] : [];
      const r = await pgPool.query(q, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching POs from DB:', err);
    }
  }
  if (branchId && branchId !== 'ALL') {
    return res.json(purchaseOrders.filter((po) => po.branchId === branchId));
  }
  res.json(purchaseOrders);
});

app.post('/api/purchase-orders', requirePermission('po-create'), async (req, res) => {
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
      await pgPool.query(
        `INSERT INTO purchase_orders (
           id, po_number, supplier_id, supplier_name, branch_id, order_date_ad, order_date_bs, expected_delivery_date_ad, status, subtotal_amount, tax_amount, total_amount, notes, items
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           subtotal_amount = EXCLUDED.subtotal_amount,
           tax_amount = EXCLUDED.tax_amount,
           total_amount = EXCLUDED.total_amount,
           notes = EXCLUDED.notes,
           items = EXCLUDED.items;`,
        [
          newPO.id,
          newPO.poNumber,
          newPO.supplierId || null,
          newPO.supplierName || 'Vendor',
          newPO.branchId || 'WH001',
          newPO.orderDateAd,
          newPO.orderDateBs,
          newPO.expectedDeliveryDateAD || newPO.expectedDeliveryDateAd || null,
          newPO.status || 'DRAFT',
          newPO.subtotalAmount,
          newPO.taxAmount,
          newPO.totalAmount,
          newPO.notes || '',
          JSON.stringify(items),
        ]
      );

      if (newPO.branchId && Array.isArray(items)) {
        for (const item of items) {
          await pgPool.query(
            `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty)
             VALUES ($1, $2, $3, 0, $4)
             ON CONFLICT (product_id, branch_id) DO UPDATE SET
               incoming_qty = inventory_stock.incoming_qty + EXCLUDED.incoming_qty,
               last_updated = CURRENT_TIMESTAMP;`,
            [`stk-${newPO.branchId.toLowerCase()}-${item.productId}`, item.productId, newPO.branchId, Number(item.quantity) || 0]
          );
        }
      }
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
});

app.put('/api/purchase-orders/:id', requirePermission('po-create'), async (req, res) => {
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
      await pgPool.query(
        `UPDATE purchase_orders SET
           supplier_name = $1, branch_id = $2, status = $3, subtotal_amount = $4, tax_amount = $5, total_amount = $6, notes = $7, items = $8
         WHERE id = $9;`,
        [
          updatedPO.supplierName,
          updatedPO.branchId,
          updatedPO.status,
          updatedPO.subtotalAmount,
          updatedPO.taxAmount,
          updatedPO.totalAmount,
          updatedPO.notes,
          JSON.stringify(items),
          id,
        ]
      );
    }
    logAuditEvent(req, 'UPDATE_PURCHASE_ORDER', 'PROCUREMENT', `Updated Purchase Order #${updatedPO.poNumber}`);
    res.json(updatedPO);
  } catch (err: any) {
    console.error('Error updating purchase order:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/purchase-orders/:id', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'PROCUREMENT_OFFICER'), requirePermission('po-delete'), async (req, res) => {
  try {
    const { id } = req.params;
    let po: any = purchaseOrders.find((entry) => entry.id === id);
    if (getPgConnected() && !po) {
      const result = await pgPool.query('SELECT id, po_number AS "poNumber", status, items, branch_id AS "branchId" FROM purchase_orders WHERE id = $1', [id]);
      po = result.rows[0];
    }
    if (!po) return res.status(404).json({ message: 'Purchase Order not found' });
    if (['RECEIVED', 'IN_PROGRESS'].includes(po.status)) {
      return res.status(409).json({ message: 'Received or in-progress purchase orders cannot be deleted.' });
    }

    const linkedInvoice = purchaseInvoices.some((invoice) => invoice.poReferenceId === po.id || invoice.poReferenceId === po.poNumber);
    if (linkedInvoice) return res.status(409).json({ message: 'Delete the linked Purchase Invoice before deleting this Purchase Order.' });

    const items = typeof po.items === 'string' ? JSON.parse(po.items) : (po.items || []);
    if (getPgConnected()) {
      await withTransaction(async (client) => {
        for (const item of items) {
          await client.query(
            `UPDATE inventory_stock SET incoming_qty = GREATEST(0, incoming_qty - $1), last_updated = CURRENT_TIMESTAMP
             WHERE product_id = $2 AND branch_id = $3`,
            [Number(item.quantity) || 0, item.productId, po.branchId]
          );
        }
        await client.query('DELETE FROM purchase_orders WHERE id = $1', [id]);
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
});

app.patch('/api/purchase-orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const po = purchaseOrders.find((p) => p.id === id);
    if (po) po.status = status;

    if (getPgConnected()) {
      await pgPool.query('UPDATE purchase_orders SET status = $1 WHERE id = $2', [status, id]);
    }
    logAuditEvent(req, 'UPDATE_PO_STATUS', 'PROCUREMENT', `Changed Purchase Order status to ${status}`);
    res.json(po || req.body);
  } catch (err: any) {
    console.error('Error updating PO status:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.get('/api/purchase-invoices', async (req, res) => {
  const { branchId } = req.query;
  if (getPgConnected()) {
    try {
      const q =
        'SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", vendor_bill_number AS "vendorBillNumber", supplier_id AS "supplierId", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS", due_date_ad AS "dueDateAD", due_date_bs AS "dueDateBS", taxable_amount AS "taxableAmount", vat_amount AS "vatAmount", non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal", payment_status AS "paymentStatus", payment_method AS "paymentMethod", amount_paid AS "amountPaid", notes, items FROM purchase_invoices' +
        (branchId && branchId !== 'ALL' ? ' WHERE branch_id = $1' : '') +
        ' ORDER BY created_at DESC';
      const params = branchId && branchId !== 'ALL' ? [branchId] : [];
      const r = await pgPool.query(q, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching purchase invoices from DB:', err);
    }
  }
  if (branchId && branchId !== 'ALL') {
    return res.json(purchaseInvoices.filter((inv) => inv.branchId === branchId));
  }
  res.json(purchaseInvoices);
});

app.post('/api/purchase-invoices', requirePermission('inv-create'), async (req, res) => {
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
      return res.status(400).json({ message: 'Vendor bill date cannot be after the purchase date.' });
    }
    const poReference = newInv.poReferenceId || req.body.poId;
    if (poReference) {
      let linkedPO = purchaseOrders.find((po) => po.id === poReference || po.poNumber === poReference);
      if (!linkedPO && getPgConnected()) {
        const poResult = await pgPool.query(
          'SELECT id, po_number AS "poNumber", supplier_name AS "supplierName", branch_id AS "branchId", status, items FROM purchase_orders WHERE id = $1 OR po_number = $1 LIMIT 1',
          [poReference]
        );
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
      const existing = await pgPool.query(
        'SELECT 1 FROM purchase_invoices WHERE id = $1 OR invoice_number = $2 LIMIT 1',
        [newInv.id, newInv.invoiceNumber]
      );
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
      await pgPool.query(
        `INSERT INTO purchase_invoices (
           id, invoice_number, po_reference_id, vendor_bill_number, supplier_id, supplier_name, branch_id, invoice_date_ad, invoice_date_bs, due_date_ad, due_date_bs, taxable_amount, vat_amount, non_taxable_amount, grand_total, payment_status, payment_method, amount_paid, notes, items
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         ON CONFLICT (id) DO UPDATE SET
           payment_status = EXCLUDED.payment_status,
           payment_method = EXCLUDED.payment_method,
           amount_paid = EXCLUDED.amount_paid,
           notes = EXCLUDED.notes,
           items = EXCLUDED.items;`,
        [
          newInv.id,
          newInv.invoiceNumber,
          newInv.poReferenceId || newInv.poId || null,
          newInv.vendorBillNumber || null,
          resolvedSupplierId,
          newInv.supplierName || 'Vendor',
          targetBranchId,
          newInv.invoiceDateAD,
          newInv.invoiceDateBS,
          newInv.dueDateAD || newInv.dueDateAd || null,
          newInv.dueDateBS || newInv.dueDateBs || null,
          Number(newInv.taxableAmount) || 0,
          Number(newInv.vatAmount) || 0,
          Number(newInv.nonTaxableAmount) || 0,
          Number(newInv.grandTotal) || 0,
          newInv.paymentStatus || 'UNPAID',
          newInv.paymentMethod || 'CREDIT',
          Number(newInv.amountPaid) || 0,
          newInv.notes || '',
          JSON.stringify(items),
        ]
      );

      if (!invoiceAlreadyExists) for (const item of items) {
        const qtyToAdd = Number(item.quantity) || 0;
        await pgPool.query(
          `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, min_reorder_level)
           VALUES ($1, $2, $3, $4, 5)
           ON CONFLICT (product_id, branch_id) DO UPDATE SET
             quantity_on_hand = inventory_stock.quantity_on_hand + $4,
             last_updated = CURRENT_TIMESTAMP;`,
          [`stk-${targetBranchId.toLowerCase()}-${item.productId}`, item.productId, targetBranchId, qtyToAdd]
        );

        await pgPool.query(
          `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8, $9, $10, $11, $12)`,
          [`txn-${Date.now()}-${item.productId}`, `TXN-${Math.floor(10000 + Math.random() * 90000)}`, item.productId, item.sku || '', item.productName || 'Product', targetBranchId, 'PURCHASE_INVOICE', qtyToAdd, Number(item.unitPrice) || 0, newInv.invoiceNumber, newInv.invoiceDateAD || new Date().toISOString(), newInv.invoiceDateBS || '2083-04-16 BS']
        );
      }

      const poRef = newInv.poReferenceId || req.body.poId;
      if (poRef) {
        await pgPool.query('UPDATE purchase_orders SET status = $1 WHERE id = $2 OR po_number = $2', ['RECEIVED', poRef]);
      }
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
});

app.delete('/api/purchase-invoices/:id', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'ACCOUNTANT', 'PROCUREMENT_OFFICER'), async (req, res) => {
  try {
    const { id } = req.params;
    let invoice: any = purchaseInvoices.find((entry) => entry.id === id);
    if (getPgConnected() && !invoice) {
      const result = await pgPool.query('SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", vendor_bill_number AS "vendorBillNumber", branch_id AS "branchId", notes, items FROM purchase_invoices WHERE id = $1', [id]);
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
      await withTransaction(async (client) => {
        if (serials.length > 0 && purchaseRefs.length > 0) {
          const assigned = await client.query(
            `SELECT 1 FROM customer_device_records
             WHERE device_serial = ANY($1::text[]) AND purchase_bill_ref = ANY($2::text[]) AND status <> 'IN_STOCK' LIMIT 1`,
            [serials, purchaseRefs]
          );
          if (assigned.rowCount) throw new Error('This invoice has serial devices that are already assigned or consumed and cannot be deleted.');
        }
        for (const [productId, quantity] of quantities) {
          const updated = await client.query(
            `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP
             WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1`,
            [quantity, productId, invoice.branchId]
          );
          if (updated.rowCount !== 1) throw new Error(`Insufficient stock to reverse invoice item ${productId}.`);
        }
        if (serials.length > 0 && purchaseRefs.length > 0) {
          await client.query(
            `DELETE FROM customer_device_records
             WHERE device_serial = ANY($1::text[]) AND purchase_bill_ref = ANY($2::text[]) AND status = 'IN_STOCK'`,
            [serials, purchaseRefs]
          );
        }
        await client.query('DELETE FROM purchase_invoices WHERE id = $1', [id]);
        if (invoice.poReferenceId) {
          await client.query('UPDATE purchase_orders SET status = $1 WHERE id = $2 OR po_number = $2', ['APPROVED', invoice.poReferenceId]);
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
});

app.post('/api/purchase-invoices/:id/pay', requirePermission('inv-pay'), async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;
    const inv = purchaseInvoices.find((i) => i.id === id);
    if (inv) {
      inv.amountPaid += Number(amount);
      inv.paymentStatus = inv.amountPaid >= inv.grandTotal ? 'PAID' : 'PARTIAL';
    }

    if (getPgConnected()) {
      await pgPool.query(
        `UPDATE purchase_invoices SET
           amount_paid = amount_paid + $1,
           payment_status = CASE WHEN (amount_paid + $1) >= grand_total THEN 'PAID' ELSE 'PARTIAL' END
         WHERE id = $2;`,
        [Number(amount), id]
      );
    }
    logAuditEvent(req, 'RECORD_INVOICE_PAYMENT', 'PROCUREMENT', `Recorded payment of NPR ${Number(amount).toLocaleString()} for Invoice`);
    res.json(inv || { message: 'Payment recorded' });
  } catch (err: any) {
    console.error('Error recording payment:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.post('/api/purchase-invoices/:id/reverse-payments', requirePermission('inv-pay'), async (req, res) => {
  try {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ message: 'A reversal reason is required.' });
    }

    const inv = purchaseInvoices.find((i) => i.id === id);
    if (!inv) {
      return res.status(404).json({ message: 'Purchase invoice not found.' });
    }
    // A reversal is only meaningful once the bill is fully settled. Compute
    // from amounts (rather than trusting paymentStatus) so invoices with a
    // stale PARTIAL flag but a full amountPaid are still recognized.
    const grandTotal = Number(inv.grandTotal) || 0;
    const amountPaid = Number(inv.amountPaid) || 0;
    if (grandTotal <= 0 || amountPaid < grandTotal) {
      return res.status(409).json({ message: `Invoice #${inv.invoiceNumber} is not fully paid (status: ${inv.paymentStatus}, amount paid: ${amountPaid.toLocaleString()}).` });
    }

    // Find all POSTED payments for this invoice
    const paymentsToReverse = vendorPayments.filter((p) => p.invoiceId === id && p.status === 'POSTED');
    if (paymentsToReverse.length === 0) {
      return res.status(409).json({ message: `No posted payments found for invoice #${inv.invoiceNumber}.` });
    }
    // Capture the settled total BEFORE resetting it so the audit trail and
    // response can report the actual reversed amount.
    const reversedTotal = paymentsToReverse.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        // Reverse all payments for this invoice
        for (const payment of paymentsToReverse) {
          await client.query(
            `UPDATE vendor_payments SET
               status = 'REVERSED',
               reversal_reason = $1,
               reversed_by = $2,
               reversed_at_ad = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [reason, getUserFromReq(req).email || 'system', payment.id]
          );
        }
        // Reset the invoice amount_paid and payment_status
        await client.query(
          `UPDATE purchase_invoices SET
             amount_paid = 0,
             payment_status = 'UNPAID'
           WHERE id = $1`,
          [id]
        );
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
});

app.get('/api/vendor-payments', async (req, res) => {
  const { supplierId, invoiceId, branchId, status, fromAd, toAd, fiscalYearId } = req.query;
  if (getPgConnected()) {
    try {
      const conds: string[] = [];
      const params: any[] = [];
      const push = (sql: string, value: any) => {
        if (value !== undefined && value !== null && value !== '') {
          params.push(value);
          conds.push(`${sql} = $${params.length}`);
        }
      };
      push('supplier_id', supplierId);
      push('invoice_id', invoiceId);
      push('branch_id', branchId && branchId !== 'ALL' ? branchId : undefined);
      push('status', status);
      push('fiscal_year_id', fiscalYearId);
      if (fromAd) {
        params.push(String(fromAd).split('T')[0]);
        conds.push(`payment_date_ad >= $${params.length}`);
      }
      if (toAd) {
        params.push(String(toAd).split('T')[0]);
        conds.push(`payment_date_ad <= $${params.length}`);
      }
      const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
      const r = await pgPool.query(`${VENDOR_PAYMENT_SELECT}${where} ORDER BY payment_date_ad DESC, created_at DESC`, params);
      return res.json(r.rows);
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
});

app.get('/api/purchase-invoices/:id/payments', async (req, res) => {
  const { id } = req.params;
  if (getPgConnected()) {
    try {
      const r = await pgPool.query(
        `${VENDOR_PAYMENT_SELECT} WHERE invoice_id = $1 ORDER BY payment_date_ad DESC, created_at DESC`,
        [id]
      );
      return res.json(r.rows);
    } catch (err: any) {
      console.error('Error fetching invoice payments from DB:', err);
    }
  }
  res.json(vendorPayments.filter((p) => p.invoiceId === id));
});

app.post('/api/vendor-payments', requirePermission('inv-pay'), async (req, res) => {
  try {
    const body = req.body || {};
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'Payment amount must be greater than 0.' });
    }

    // Resolve the invoice first so supplier + branch can be inherited from it.
    let linkedInvoice: any = body.invoiceId
      ? purchaseInvoices.find((inv) => inv.id === body.invoiceId || inv.invoiceNumber === body.invoiceId)
      : undefined;
    if (!linkedInvoice && body.invoiceId && getPgConnected()) {
      const invRes = await pgPool.query(
        `SELECT id, invoice_number AS "invoiceNumber", supplier_name AS "supplierName",
                branch_id AS "branchId",
                invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS",
                grand_total AS "grandTotal", amount_paid AS "amountPaid"
         FROM purchase_invoices WHERE id = $1 OR invoice_number = $1 LIMIT 1`,
        [body.invoiceId]
      );
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
      return res.status(400).json({ message: 'Supplier is required to record a vendor payment.' });
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
      await pgPool.query(
        `INSERT INTO vendor_payments (
           id, payment_number, supplier_id, supplier_name, branch_id, invoice_id, invoice_number,
           payment_date_ad, payment_date_bs, amount, payment_method, bank_name, bank_branch,
           account_number, cheque_number, cheque_date_ad, cheque_date_bs, transaction_reference,
           notes, status, is_demo, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, FALSE, $21)
         ON CONFLICT (id) DO NOTHING`,
        [
          newPayment.id, newPayment.paymentNumber, newPayment.supplierId || null, newPayment.supplierName,
          newPayment.branchId, newPayment.invoiceId, newPayment.invoiceNumber,
          newPayment.paymentDateAD, newPayment.paymentDateBS, newPayment.amount, newPayment.paymentMethod,
          newPayment.bankName, newPayment.bankBranch, newPayment.accountNumber, newPayment.chequeNumber,
          newPayment.chequeDateAD, newPayment.chequeDateBS, newPayment.transactionReference,
          newPayment.notes, newPayment.status, newPayment.createdBy,
        ]
      );
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
});

app.post('/api/vendor-payments/:id/reverse', requirePermission('inv-pay'), async (req, res) => {
  try {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ message: 'A reversal reason is required.' });
    }
    const payment = vendorPayments.find((p) => p.id === id);
    if (!payment) {
      return res.status(404).json({ message: 'Vendor payment not found.' });
    }
    if (payment.status !== 'POSTED') {
      return res.status(409).json({ message: `Payment #${payment.paymentNumber} is already ${payment.status.toLowerCase()}.` });
    }

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        // Reverse the payment row.
        await client.query(
          `UPDATE vendor_payments SET
             status = 'REVERSED',
             reversal_reason = $1,
             reversed_by = $2,
             reversed_at_ad = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [reason, getUserFromReq(req).email || 'system', id]
        );
        // Undo the amount from the linked invoice so its balance is restored.
        if (payment.invoiceId) {
          await client.query(
            `UPDATE purchase_invoices SET
               amount_paid = GREATEST(0, amount_paid - $1),
               payment_status = CASE WHEN (amount_paid - $1) >= grand_total THEN 'PAID'
                                     WHEN (amount_paid - $1) > 0 THEN 'PARTIAL'
                                     ELSE 'UNPAID' END
             WHERE id = $2`,
            [Number(payment.amount) || 0, payment.invoiceId]
          );
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
});

app.get('/api/vendors/:supplierId/ledger', async (req, res) => {
  try {
    const { supplierId } = req.params;
    const { fromAd, toAd, fiscalYearId, branchId } = req.query;
    const supplier = suppliers.find((s) => s.id === supplierId);
    if (!supplier) {
      return res.status(404).json({ message: 'Supplier not found.' });
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
        const invRes = await pgPool.query(
          `SELECT id, invoice_number AS "invoiceNumber", supplier_id AS "supplierId", supplier_name AS "supplierName",
                  branch_id AS "branchId", invoice_date_ad AS "invoiceDateAD",
                  invoice_date_bs AS "invoiceDateBS", vat_amount AS "vatAmount",
                  grand_total AS "grandTotal", notes
           FROM purchase_invoices
           WHERE supplier_id = $1 OR (supplier_id IS NULL AND (LOWER(supplier_name) = LOWER($2) OR LOWER(supplier_name) LIKE LOWER($3)))`,
          [supplier.id, supplier.name, `%${supplier.name}%`]
        );
        invoices = invRes.rows;
        const payRes = await pgPool.query(
          `${VENDOR_PAYMENT_SELECT} WHERE supplier_id = $1 OR (supplier_id IS NULL OR supplier_id = '') AND (LOWER(supplier_name) = LOWER($2) OR LOWER(supplier_name) LIKE LOWER($3))`,
          [supplier.id, supplier.name, `%${supplier.name}%`]
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
          const fyRes = await pgPool.query(
            'SELECT id, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD" FROM fiscal_years WHERE id = $1',
            [fiscalYearId]
          );
          fyRow = fyRes.rows[0] || null;
        } else if (from) {
          const fyRes = await pgPool.query(
            'SELECT id, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD" FROM fiscal_years WHERE start_date_ad = $1::date LIMIT 1',
            [from]
          );
          fyRow = fyRes.rows[0] || null;
        } else {
          const fyRes = await pgPool.query(
            'SELECT id, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD" FROM fiscal_years WHERE is_current = TRUE ORDER BY start_date_ad DESC LIMIT 1'
          );
          fyRow = fyRes.rows[0] || null;
        }
        if (fyRow) {
          fyStartAD = String(fyRow.startDateAD || '').split('T')[0];
          const obRes = await pgPool.query(
            `SELECT COALESCE(SUM(opening_balance), 0)::float AS total
             FROM vendor_opening_balances
             WHERE fiscal_year_id = $1 AND supplier_id = $2
               AND ($3::text IS NULL OR $3 = 'ALL' OR branch_id = $3)`,
            [fyRow.id, supplier.id, branchId === 'ALL' ? null : branchId]
          );
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
});

}
