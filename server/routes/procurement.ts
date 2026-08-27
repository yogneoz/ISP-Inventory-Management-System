/**
 * Route module: procurement
 */
import { Router } from 'express';
import * as store from '../store';
import { pgPool, isPgConnected, withTransaction } from '../lib/db';
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

router.get('/api/purchase-orders', async (req, res) => {
  const { branchId } = req.query;
  if (isPgConnected) {
    try {
      const q =
        'SELECT id, po_number AS "poNumber", supplier_name AS "supplierName", branch_id AS "branchId", order_date_ad AS "orderDateAd", order_date_bs AS "orderDateBs", expected_delivery_date_ad AS "expectedDeliveryDateAd", status, subtotal_amount AS "subtotalAmount", tax_amount AS "taxAmount", total_amount AS "totalAmount", notes, items FROM purchase_orders' +
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
    return res.json(store.purchaseOrders.filter((po) => po.branchId === branchId));
  }
  res.json(store.purchaseOrders);
});

router.post('/api/purchase-orders', async (req, res) => {
  try {
    const items = req.body.items || [];
    const subtotalAmount = items.reduce((s: number, i: any) => s + (i.subtotal || (i.quantity * (i.unitPrice || 0))), 0);
    const taxAmount = items.reduce((s: number, i: any) => s + (i.taxAmount || 0), 0);
    const totalAmount = subtotalAmount + taxAmount;

    const newPO = {
      id: req.body.id || `po-${Date.now()}`,
      poNumber: req.body.poNumber || store.generateStandardTransactionId(req.body.branchId || 'WH001', 'PO'),
      subtotalAmount,
      taxAmount,
      totalAmount,
      orderDateAd: req.body.orderDateAD || req.body.orderDateAd || new Date().toISOString().split('T')[0],
      orderDateBs: req.body.orderDateBS || req.body.orderDateBs || '2083-04-10 BS',
      ...req.body,
    };

    const idx = store.purchaseOrders.findIndex((p) => p.id === newPO.id);
    if (idx >= 0) store.purchaseOrders[idx] = newPO;
    else store.purchaseOrders.unshift(newPO);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO purchase_orders (
           id, po_number, supplier_name, branch_id, order_date_ad, order_date_bs, expected_delivery_date_ad, status, subtotal_amount, tax_amount, total_amount, notes, items
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        let stk = store.inventoryStock.find((s) => s.productId === item.productId && s.branchId === newPO.branchId);
        if (stk) {
          stk.incomingQty = (stk.incomingQty || 0) + (Number(item.quantity) || 0);
          stk.lastUpdated = new Date().toISOString();
        }
      });
    }

    store.saveDataStore();
    logAuditEvent(req, 'CREATE_PURCHASE_ORDER', 'PROCUREMENT', `Created Purchase Order #${newPO.poNumber} for supplier ${newPO.supplierName || 'Vendor'}`);
    res.status(201).json(newPO);
  } catch (err: any) {
    console.error('Error creating purchase order:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

router.put('/api/purchase-orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const index = store.purchaseOrders.findIndex((p) => p.id === id);
    const existingPO = store.purchaseOrders[index];

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
    if (index >= 0) store.purchaseOrders[index] = updatedPO;

    if (isPgConnected) {
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

    store.saveDataStore();
    logAuditEvent(req, 'UPDATE_PURCHASE_ORDER', 'PROCUREMENT', `Updated Purchase Order #${updatedPO.poNumber}`);
    res.json(updatedPO);
  } catch (err: any) {
    console.error('Error updating purchase order:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

router.patch('/api/purchase-orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const po = store.purchaseOrders.find((p) => p.id === id);
    if (po) po.status = status;

    if (isPgConnected) {
      await pgPool.query('UPDATE purchase_orders SET status = $1 WHERE id = $2', [status, id]);
    }

    store.saveDataStore();
    logAuditEvent(req, 'UPDATE_PO_STATUS', 'PROCUREMENT', `Changed Purchase Order status to ${status}`);
    res.json(po || req.body);
  } catch (err: any) {
    console.error('Error updating PO status:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

router.post('/api/purchase-orders/:id/receive', requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER', 'BRANCH_MANAGER'), async (req, res) => {
  try {
    const { id } = req.params;
    let po = store.purchaseOrders.find((p) => p.id === id);

    if (isPgConnected) {
      const r = await pgPool.query('SELECT id, po_number AS "poNumber", supplier_name AS "supplierName", branch_id AS "branchId", status, items FROM purchase_orders WHERE id = $1', [id]);
      if (r.rows.length > 0) po = r.rows[0];
    }
    if (!po) return res.status(404).json({ message: 'PO not found' });

    po.status = 'RECEIVED';

    if (isPgConnected) {
      await withTransaction(async (client) => {
        await client.query('UPDATE purchase_orders SET status = $1 WHERE id = $2', ['RECEIVED', id]);

        const items = typeof po.items === 'string' ? JSON.parse(po.items) : (po.items || []);
        for (const item of items) {
          await client.query(
            `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty)
             VALUES ($1, $2, $3, $4, 0)
             ON CONFLICT (product_id, branch_id) DO UPDATE SET
               incoming_qty = GREATEST(0, inventory_stock.incoming_qty - $4),
               quantity_on_hand = inventory_stock.quantity_on_hand + $4,
               last_updated = CURRENT_TIMESTAMP;`,
            [`stk-${po.branchId.toLowerCase()}-${item.productId}`, item.productId, po.branchId, Number(item.quantity) || 0]
          );

          const txnId = `txn-${Date.now()}-${item.productId}`;
          const txnNum = `TXN-${Math.floor(10000 + Math.random() * 90000)}`;
          await client.query(
            `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_bs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8, $9, $10, $11)`,
            [txnId, txnNum, item.productId, item.sku || '', item.productName || '', po.branchId, 'INBOUND_PO', Number(item.quantity) || 0, item.unitPrice || 0, po.poNumber, getTodayBsStamp()]
          );
        }
      });
    }

    if (po.items && Array.isArray(po.items)) {
      po.items.forEach((item: any) => {
        let stk = store.inventoryStock.find((s) => s.productId === item.productId && s.branchId === po.branchId);
        if (stk) {
          stk.incomingQty = Math.max(0, (stk.incomingQty || 0) - item.quantity);
          stk.quantityOnHand += item.quantity;
          stk.lastUpdated = new Date().toISOString();
        }
      });
    }

    store.saveDataStore();
    logAuditEvent(req, 'RECEIVE_PURCHASE_ORDER', 'PROCUREMENT', `Received goods for Purchase Order #${po.poNumber}`);
    res.json(po);
  } catch (err: any) {
    console.error('Error receiving PO:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Purchase Invoices
router.get('/api/purchase-invoices', async (req, res) => {
  const { branchId } = req.query;
  if (isPgConnected) {
    try {
      const q =
        'SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", supplier_name AS "supplierName", branch_id AS "branchId", invoice_date_ad AS "invoiceDateAd", invoice_date_bs AS "invoiceDateBs", due_date_ad AS "dueDateAd", due_date_bs AS "dueDateBs", taxable_amount AS "taxableAmount", vat_amount AS "vatAmount", non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal", payment_status AS "paymentStatus", amount_paid AS "amountPaid", items FROM purchase_invoices' +
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
    return res.json(store.purchaseInvoices.filter((inv) => inv.branchId === branchId));
  }
  res.json(store.purchaseInvoices);
});

router.post('/api/purchase-invoices', async (req, res) => {
  try {
    const targetBranchId = req.body.branchId || store.branches[0]?.id || 'WH001';
    const newInv = {
      id: req.body.id || `inv-${Date.now()}`,
      invoiceNumber: req.body.invoiceNumber || store.generateStandardTransactionId(targetBranchId, 'PI'),
      invoiceDateAD: req.body.invoiceDateAD || req.body.invoiceDateAd || new Date().toISOString().split('T')[0],
      invoiceDateBS: req.body.invoiceDateBS || req.body.invoiceDateBs || '2083-04-10 BS',
      ...req.body,
    };
    const items = req.body.items || req.body.lines || [];

    const idx = store.purchaseInvoices.findIndex((i) => i.id === newInv.id);
    if (idx >= 0) store.purchaseInvoices[idx] = newInv;
    else store.purchaseInvoices.unshift(newInv);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO purchase_invoices (
           id, invoice_number, po_reference_id, supplier_name, branch_id, invoice_date_ad, invoice_date_bs, due_date_ad, due_date_bs, taxable_amount, vat_amount, non_taxable_amount, grand_total, payment_status, amount_paid, items
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (id) DO UPDATE SET
           payment_status = EXCLUDED.payment_status,
           amount_paid = EXCLUDED.amount_paid;`,
        [
          newInv.id,
          newInv.invoiceNumber,
          newInv.poReferenceId || newInv.poId || null,
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
          Number(newInv.amountPaid) || 0,
          JSON.stringify(items),
        ]
      );

      for (const item of items) {
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
          `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_bs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8, $9, $10, $11)`,
          [`txn-${Date.now()}-${item.productId}`, `TXN-${Math.floor(10000 + Math.random() * 90000)}`, item.productId, item.sku || '', item.productName || 'Product', targetBranchId, 'PURCHASE_INVOICE', qtyToAdd, Number(item.unitPrice) || 0, newInv.invoiceNumber, getTodayBsStamp()]
        );
      }

      const poRef = newInv.poReferenceId || req.body.poId;
      if (poRef) {
        await pgPool.query('UPDATE purchase_orders SET status = $1 WHERE id = $2 OR po_number = $2', ['RECEIVED', poRef]);
      }
    }

    items.forEach((item: any) => {
      let stk = store.inventoryStock.find((s) => s.productId === item.productId && s.branchId === targetBranchId);
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
        store.inventoryStock.push(stk);
      }
      stk.quantityOnHand += Number(item.quantity) || 0;
      stk.lastUpdated = new Date().toISOString();
    });

    store.saveDataStore();
    logAuditEvent(req, 'CREATE_PURCHASE_INVOICE', 'PROCUREMENT', `Created Purchase Invoice #${newInv.invoiceNumber}`);
    res.status(201).json(newInv);
  } catch (err: any) {
    console.error('Error creating purchase invoice:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

router.post('/api/purchase-invoices/:id/pay', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;
    const inv = store.purchaseInvoices.find((i) => i.id === id);
    if (inv) {
      inv.amountPaid += Number(amount);
      inv.paymentStatus = inv.amountPaid >= inv.grandTotal ? 'PAID' : 'PARTIAL';
    }

    if (isPgConnected) {
      await pgPool.query(
        `UPDATE purchase_invoices SET
           amount_paid = amount_paid + $1,
           payment_status = CASE WHEN (amount_paid + $1) >= grand_total THEN 'PAID' ELSE 'PARTIAL' END
         WHERE id = $2;`,
        [Number(amount), id]
      );
    }

    store.saveDataStore();
    logAuditEvent(req, 'RECORD_INVOICE_PAYMENT', 'PROCUREMENT', `Recorded payment of NPR ${Number(amount).toLocaleString()} for Invoice`);
    res.json(inv || { message: 'Payment recorded' });
  } catch (err: any) {
    console.error('Error recording payment:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Shipments

export default router;
