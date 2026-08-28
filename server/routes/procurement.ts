/**
 * Route module: procurement
 */
import { Router } from 'express';
import * as store from '../store';
import { pgPool, isPgConnected, withTransaction } from '../lib/db';
import { validateBody, poCreateSchema } from '../lib/validate';
import { readPgOrStore, num } from '../lib/pgReads';
import {
  snapshotStore,
  restoreSnapshot,
  writeThroughPg,
  sendWriteFailure,
  commitLocalMirror,
} from '../lib/writeGuard';
import { requireRole, logAuditEvent } from '../lib/auth';
import { getTodayBsStamp } from '../lib/authUtils';

import type { Product } from '../../src/types';

const router = Router();

router.get('/api/purchase-orders', async (req, res) => {
  const { branchId } = req.query;
  const bf = branchId && branchId !== 'ALL' ? String(branchId) : null;
  const rows = await readPgOrStore<any>({
    label: 'po.list',
    sql:
      `SELECT id, po_number AS "poNumber", supplier_name AS "supplierName", branch_id AS "branchId",
              order_date_ad AS "orderDateAD", order_date_bs AS "orderDateBS",
              expected_delivery_date_ad AS "expectedDeliveryDateAD", status,
              subtotal_amount AS "subtotalAmount", tax_amount AS "taxAmount",
              total_amount AS "totalAmount", notes, items
       FROM purchase_orders` +
      (bf ? ' WHERE branch_id = $1' : '') +
      ' ORDER BY created_at DESC NULLS LAST',
    params: bf ? [bf] : [],
    fallback: () => (bf ? store.purchaseOrders.filter((p) => p.branchId === bf) : store.purchaseOrders),
    map: (r) => ({
      ...r,
      subtotalAmount: num(r.subtotalAmount),
      taxAmount: num(r.taxAmount),
      totalAmount: num(r.totalAmount),
      items: typeof r.items === 'string' ? JSON.parse(r.items || '[]') : r.items || [],
    }),
    onRows: (rows) => {
      if (!isPgConnected) return;
      if (!bf) store.replaceCollection('purchaseOrders', rows as any);
    },
  });
  res.json(rows);
});

router.post('/api/purchase-orders', validateBody(poCreateSchema), async (req, res) => {
  const __writeSnap = snapshotStore(['purchaseOrders', 'purchaseInvoices', 'inventoryStock', 'transactionLogs', 'assetRegister']);
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

    await writeThroughPg('CREATE_PURCHASE_ORDER', async () => {
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
    });

    if (newPO.branchId && Array.isArray(items)) {
      items.forEach((item: any) => {
        let stk = store.inventoryStock.find((s) => s.productId === item.productId && s.branchId === newPO.branchId);
        if (stk) {
          stk.incomingQty = (stk.incomingQty || 0) + (Number(item.quantity) || 0);
          stk.lastUpdated = new Date().toISOString();
        }
      });
    }

    commitLocalMirror();
    logAuditEvent(req, 'CREATE_PURCHASE_ORDER', 'PROCUREMENT', `Created Purchase Order #${newPO.poNumber} for supplier ${newPO.supplierName || 'Vendor'}`);
    res.status(201).json(newPO);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error creating purchase order:', err);
    return sendWriteFailure(res, err);
  }
});

router.put('/api/purchase-orders/:id', async (req, res) => {
  const __writeSnap = snapshotStore(['purchaseOrders', 'purchaseInvoices', 'inventoryStock', 'transactionLogs', 'assetRegister']);
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

    await writeThroughPg('UPDATE_PURCHASE_ORDER', async () => {
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
    });

    commitLocalMirror();
    logAuditEvent(req, 'UPDATE_PURCHASE_ORDER', 'PROCUREMENT', `Updated Purchase Order #${updatedPO.poNumber}`);
    res.json(updatedPO);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error updating purchase order:', err);
    return sendWriteFailure(res, err);
  }
});

router.patch('/api/purchase-orders/:id/status', async (req, res) => {
  const __writeSnap = snapshotStore(['purchaseOrders', 'purchaseInvoices', 'inventoryStock', 'transactionLogs', 'assetRegister']);
  try {
    const { id } = req.params;
    const { status } = req.body;
    const po = store.purchaseOrders.find((p) => p.id === id);
    if (po) po.status = status;

    await writeThroughPg('UPDATE_PO_STATUS', async () => {
      await pgPool.query('UPDATE purchase_orders SET status = $1 WHERE id = $2', [status, id]);
    });

    commitLocalMirror();
    logAuditEvent(req, 'UPDATE_PO_STATUS', 'PROCUREMENT', `Changed Purchase Order status to ${status}`);
    res.json(po || req.body);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error updating PO status:', err);
    return sendWriteFailure(res, err);
  }
});

router.post('/api/purchase-orders/:id/receive', requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER', 'BRANCH_MANAGER'), async (req, res) => {
  const __writeSnap = snapshotStore(['purchaseOrders', 'purchaseInvoices', 'inventoryStock', 'transactionLogs', 'assetRegister']);
  try {
    const { id } = req.params;
    let po = store.purchaseOrders.find((p) => p.id === id);

    await writeThroughPg('DB_WRITE', async () => {
      const r = await pgPool.query('SELECT id, po_number AS "poNumber", supplier_name AS "supplierName", branch_id AS "branchId", status, items FROM purchase_orders WHERE id = $1', [id]);
      if (r.rows.length > 0) po = r.rows[0];
    });
    if (!po) return res.status(404).json({ message: 'PO not found' });

    po.status = 'RECEIVED';

    await writeThroughPg('RECEIVE_PURCHASE_ORDER', async () => {
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
    });

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

    commitLocalMirror();
    logAuditEvent(req, 'RECEIVE_PURCHASE_ORDER', 'PROCUREMENT', `Received goods for Purchase Order #${po.poNumber}`);
    res.json(po);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error receiving PO:', err);
    return sendWriteFailure(res, err);
  }
});

// Purchase Invoices
router.get('/api/purchase-invoices', async (req, res) => {
  const { branchId } = req.query;
  const bf = branchId && branchId !== 'ALL' ? String(branchId) : null;
  const rows = await readPgOrStore<any>({
    label: 'invoices.list',
    sql:
      `SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId",
              supplier_name AS "supplierName", branch_id AS "branchId",
              invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS",
              due_date_ad AS "dueDateAD", due_date_bs AS "dueDateBS",
              taxable_amount AS "taxableAmount", vat_amount AS "vatAmount",
              non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal",
              payment_status AS "paymentStatus", amount_paid AS "amountPaid", items, notes
       FROM purchase_invoices` +
      (bf ? ' WHERE branch_id = $1' : '') +
      ' ORDER BY created_at DESC NULLS LAST',
    params: bf ? [bf] : [],
    fallback: () =>
      bf ? store.purchaseInvoices.filter((i) => i.branchId === bf) : store.purchaseInvoices,
    map: (r) => ({
      ...r,
      taxableAmount: num(r.taxableAmount),
      vatAmount: num(r.vatAmount),
      nonTaxableAmount: num(r.nonTaxableAmount),
      grandTotal: num(r.grandTotal),
      amountPaid: num(r.amountPaid),
      items: typeof r.items === 'string' ? JSON.parse(r.items || '[]') : r.items || [],
    }),
    onRows: (rows) => {
      if (!isPgConnected) return;
      if (!bf) store.replaceCollection('purchaseInvoices', rows as any);
    },
  });
  res.json(rows);
});

router.post('/api/purchase-invoices', async (req, res) => {
  const __writeSnap = snapshotStore(['purchaseOrders', 'purchaseInvoices', 'inventoryStock', 'transactionLogs', 'assetRegister']);
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

    await writeThroughPg('DB_WRITE', async () => {
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
    });

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

    commitLocalMirror();
    logAuditEvent(req, 'CREATE_PURCHASE_INVOICE', 'PROCUREMENT', `Created Purchase Invoice #${newInv.invoiceNumber}`);
    res.status(201).json(newInv);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error creating purchase invoice:', err);
    return sendWriteFailure(res, err);
  }
});

router.post('/api/purchase-invoices/:id/pay', async (req, res) => {
  const __writeSnap = snapshotStore(['purchaseOrders', 'purchaseInvoices', 'inventoryStock', 'transactionLogs', 'assetRegister']);
  try {
    const { id } = req.params;
    const { amount } = req.body;
    const inv = store.purchaseInvoices.find((i) => i.id === id);
    if (inv) {
      inv.amountPaid += Number(amount);
      inv.paymentStatus = inv.amountPaid >= inv.grandTotal ? 'PAID' : 'PARTIAL';
    }

    await writeThroughPg('RECORD_INVOICE_PAYMENT', async () => {
      await pgPool.query(
        `UPDATE purchase_invoices SET
           amount_paid = amount_paid + $1,
           payment_status = CASE WHEN (amount_paid + $1) >= grand_total THEN 'PAID' ELSE 'PARTIAL' END
         WHERE id = $2;`,
        [Number(amount), id]
      );
    });

    commitLocalMirror();
    logAuditEvent(req, 'RECORD_INVOICE_PAYMENT', 'PROCUREMENT', `Recorded payment of NPR ${Number(amount).toLocaleString()} for Invoice`);
    res.json(inv || { message: 'Payment recorded' });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error recording payment:', err);
    return sendWriteFailure(res, err);
  }
});

// Shipments

export default router;
