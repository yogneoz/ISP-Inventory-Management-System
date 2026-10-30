/**
 * Procurement controller — HTTP orchestration for the procurement domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { getPgConnected, pgPool, purchaseOrders, issueNextDocNumber, setPurchaseOrders, withReplaced, withPrepended, inventoryStock, logAuditEvent, purchaseInvoices, withTransaction, branches, products, companyProfile, setPurchaseInvoices, suppliers, setInventoryStock, withAppended, customerDeviceRecords, setCustomerDeviceRecords, vendorPayments, getUserFromReq, broadcastChange, VENDOR_PAYMENT_SELECT, providerSupplierIdFromName, findBsDayRecordForAdDate, setVendorPayments, purchaseReturns, setPurchaseReturns, transactionLogs, setTransactionLogs, serialLogs, setSerialLogs, productGroups } from '../app';
import { VendorPayment, VendorPaymentMethod, TransactionLog } from '../../../client/src/types';
import { computeBillTotals, defaultVatRateFor, resolveLedgerUnitCost } from '../utils/money';
import { demoPurchaseInvoiceTxn, demoPurchaseReturnTxn, demoPurchaseReturnCancelTxn, findOrCreateDemoStock } from '../models/txnLogRows';
import { bsDateOr400 } from '../utils/bsDate';
import { intFromEnv } from '../utils/envGuard';
import { firstLineQuantityRefusal } from '../utils/lineQuantity';
import {
   PO_UPSERT_SQL, poUpsertParams, PO_UPDATE_SQL, poUpdateParams, PO_FIND_FOR_DELETE_SQL, PO_DELETE_SQL,
  PO_FIND_BY_REF_SQL, PO_MARK_STATUS_SQL, PO_INCOMING_STOCK_SQL, poIncomingStockParams, PO_RELEASE_INCOMING_SQL,
   PI_UPSERT_SQL, piUpsertParams, PI_RECEIVE_STOCK_SQL, piReceiveStockParams,
  PI_TXN_LOG_SQL, piTxnLogParams, PI_DELETE_SQL, PI_RECORD_PAYMENT_SQL, PI_RESET_PAYMENT_SQL, PI_UNDO_PAYMENT_SQL,
  PI_LOCK_FOR_UPDATE_SQL, PI_BALANCE_AFTER_SQL, VP_LOCK_STATUS_SQL,
  PI_REVERSE_STOCK_SQL, PI_CANCEL_TXN_LOG_SQL, piCancelTxnLogParams, CDR_ASSIGNED_CHECK_SQL, CDR_IN_STOCK_DELETE_SQL, PI_FIND_FOR_PAYMENT_SQL,
  VP_REVERSE_SQL, VP_INSERT_SQL, vpInsertParams, buildVendorPaymentWhere, VP_ORDER_BY, VP_BY_INVOICE_SQL_SUFFIX,
  LEDGER_INVOICES_SQL, ledgerNameParams, LEDGER_PAYMENTS_SQL_SUFFIX,
  PO_PATCH_STATUS_SQL, PI_EXISTS_SQL, PI_FIND_FOR_DELETE_SQL,
  PO_FIND_BY_ID_SQL, PI_FIND_BY_ID_SQL, PI_EXISTS_FOR_PO_SQL, VP_POSTED_BY_INVOICE_SQL, VP_FIND_BY_ID_SQL,
  buildPoListSql, buildPiListSql,
  FY_BY_ID_SQL, FY_BY_START_SQL, FY_CURRENT_SQL, VENDOR_OPENING_BALANCE_SQL,
  buildPurchaseOrderPagedQuery, buildPurchaseOrderAggregateQuery, buildPurchaseOrderStatusCountQuery,
  buildPurchaseInvoicePagedQuery, buildPurchaseInvoiceAggregateQuery, buildPurchaseInvoiceStatusCountQuery,
  buildPurchaseReturnListSql, buildPurchaseReturnCountQuery, buildPurchaseReturnPagedQuery,
  PR_INSERT_SQL, prInsertParams, PR_EXISTS_SQL, PR_LOCK_INVOICE_SQL,
  PR_RETURNED_QTY_SQL, PR_DEDUCT_STOCK_SQL, PR_RESTORE_STOCK_SQL, PR_CANCEL_SQL,
  PR_TXN_LOG_SQL, prTxnLogParams, PR_FIND_ONE_SQL, LEDGER_RETURNS_SQL,
  PR_CANCEL_TXN_LOG_SQL, prCancelTxnLogParams,
  PR_SERIAL_FLIP_SQL, PR_CANCEL_DRAFT_SQL, PR_POST_DRAFT_SQL,
} from '../models/procurement.repo';
import {
  SERIAL_LOG_FIND_BY_DEVICE_SQL, SERIAL_LOG_PON_OWNER_SQL, SERIAL_LOG_MAC_OWNER_SQL,
  SERIAL_LOG_INSERT_SQL, serialLogInsertParams, SERIAL_LOG_UPDATE_SQL, serialLogUpdateParams,
  SERIAL_LOG_DELETE_BY_INVOICE_SERIALS_SQL, SERIAL_LOG_MOVED_BY_INVOICE_SERIALS_SQL,
} from '../models/inventory.repo';
import {
  applyRegisterEntryToMirror, findMirrorRowBySerial, planPurchaseSerialEntries,
  purchaseRegisterHistoryEntry, SerialRegisterError,
} from '../services/serialRegister.service';
import type { PurchaseSerialEntry } from '../services/serialRegister.service';
import {
  buildPurchaseWarrantyCaptures,
  recordWarrantyCoverage,
  recordWarrantyCoverageMirror,
  retireCoverageForSerials,
  retireCoverageForSerialsMirror,
} from '../services/warranty.service';
import {
  collectReturnSerials,
  hydrateReturnSerialEntries,
  loadReturnSerialRows,
  returnLineSerials,
  serialRowsFromInvoiceItems,
  validateReturnSerialCounts,
  validateReturnSerialsAgainstRegister,
  type SerialLogRow,
} from '../services/returnSerials.service';
/** Forwarded from procurement.routes.ts (get_purchaseOrders). */
export async function get_purchaseOrders(req: any, res: Response): Promise<any> {
const { branchId, status, supplier, query, dateFromAD, dateToAD, page, pageSize, all } = req.query;
  // Paged mode: ?page=N (optional pageSize) returns an envelope with the page
  // slice, the filtered total, per-status counts, and pending/received value
  // sums for the register KPIs. ?all=1 returns every filtered row (CSV
  // export). No page param keeps the legacy full-array shape for existing
  // callers (bootstrap consumers, PI PO dropdowns, movement ledger).
  const wantsPaged = page !== undefined || pageSize !== undefined || all === '1';
  const wantsFiltering = wantsPaged || status || supplier || query || dateFromAD || dateToAD;
  if (getPgConnected()) {
    try {
      if (!wantsFiltering) {
        // Legacy full-array shape, still read from PostgreSQL so the register
        // never serves a stale mirror copy.
        const list = buildPoListSql(branchId);
        const allRows = await pgPool.query(list.sql, list.params as any[]);
        return res.json(allRows.rows);
      }
      const opts = { branchId, status, supplier, query, dateFromAD, dateToAD };
      if (wantsPaged) {
        const n = Math.max(1, Number(page) || 1);
        const size = Math.max(1, Math.min(500, Number(pageSize) || 50));
        const aggQ = buildPurchaseOrderAggregateQuery(opts);
        const aggR = await pgPool.query(aggQ.sql, aggQ.params as any[]);
        const agg = aggR.rows[0] || {};
        const statusQ = buildPurchaseOrderStatusCountQuery(opts);
        const statusR = await pgPool.query(statusQ.sql, statusQ.params as any[]);
        const statusCounts: Record<string, number> = {};
        for (const row of statusR.rows) statusCounts[String(row.status)] = Number(row.count);
        const listQ = buildPurchaseOrderPagedQuery(opts, all === '1' ? undefined : { page: n, pageSize: size });
        const r = await pgPool.query(listQ.sql, listQ.params as any[]);
        return res.json({
          data: r.rows,
          page: all === '1' ? 1 : n,
          pageSize: all === '1' ? Number(agg.count || 0) : size,
          totalItems: Number(agg.count || 0),
          statusCounts,
          pendingValue: Number(agg.pending_value || 0),
          receivedValue: Number(agg.received_value || 0),
        });
      }
      const { sql: q, params } = buildPurchaseOrderPagedQuery(opts);
      const r = await pgPool.query(q, params as any[]);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching POs from DB:', err);
      return res.status(500).json({ message: 'Could not load purchase orders from the database. Reload to retry.' });
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
    // QTY-1: a PO line reserves incoming stock, so it takes the UI ceiling at
    // the API too — whole numbers in [1, MAX_LINE_QUANTITY].
    const quantityRefusal = firstLineQuantityRefusal(items);
    if (quantityRefusal) return res.status(400).json({ message: quantityRefusal });
    // C1: PO totals are recomputed from line primitives (quantity × unitPrice,
    // taxRate/isTaxExempt) — client-supplied subtotal/taxAmount per line and
    // header totals are ignored. There is no PO-level discount input, so no
    // discount is passed and per-line discounts are clamped to line gross.
    const poTotals = computeBillTotals(items, undefined, defaultVatRateFor(companyProfile));
    const subtotalAmount = poTotals.netSubtotal;
    const taxAmount = poTotals.vatAmount;
    const totalAmount = poTotals.grandTotal;

    const poBranchId = req.body.branchId || 'WH001';
    const poOrderDate = req.body.orderDateAD || req.body.orderDateAd || new Date().toISOString().split('T')[0];
    const poNumber = req.body.poNumber || (await issueNextDocNumber(poBranchId, 'PO', poOrderDate));

    const newPO = {
      id: req.body.id || `po-${Date.now()}`,
      poNumber,
      ...req.body,
      orderDateAd: poOrderDate,
      orderDateBs: req.body.orderDateBS || req.body.orderDateBs,
      // C1: recomputed totals are applied AFTER the body spread so a
      // client-supplied subtotalAmount/taxAmount/totalAmount can never win.
      subtotalAmount,
      taxAmount,
      totalAmount,
    };

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
    } else {
      // Demo mode only: PostgreSQL is the single source of truth when connected.
      const idx = purchaseOrders.findIndex((p) => p.id === newPO.id);
      setPurchaseOrders(idx >= 0 ? withReplaced(purchaseOrders, idx, newPO) : withPrepended(purchaseOrders, newPO));
    }

    if (!getPgConnected() && newPO.branchId && Array.isArray(items)) {
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
    // QTY-1: validate the submitted lines before any lookup — an update can
    // grow a PO's lines, and a PO line reserves incoming stock.
    if (Array.isArray(req.body.items)) {
      const quantityRefusal = firstLineQuantityRefusal(req.body.items);
      if (quantityRefusal) return res.status(400).json({ message: quantityRefusal });
    }
    // PostgreSQL is the only decision source when connected; the mirror is a
    // demo-mode (PG-down) fallback only.
    let existingPO: any;
    if (getPgConnected()) {
      const result = await pgPool.query(PO_FIND_BY_ID_SQL, [id]);
      existingPO = result.rows[0];
    } else {
      existingPO = purchaseOrders.find((p) => p.id === id);
    }
    if (getPgConnected() && !existingPO) {
      return res.status(404).json({ message: 'Purchase Order not found' });
    }
    if (existingPO && typeof existingPO.items === 'string') existingPO.items = JSON.parse(existingPO.items);

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
    if (getPgConnected()) {
      await pgPool.query(PO_UPDATE_SQL, poUpdateParams(updatedPO, JSON.stringify(items), id));
    } else {
      const index = purchaseOrders.findIndex((p) => p.id === id);
      if (index >= 0) setPurchaseOrders(withReplaced(purchaseOrders, index, updatedPO));
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
    let po: any;
    if (getPgConnected()) {
      const result = await pgPool.query(PO_FIND_FOR_DELETE_SQL, [id]);
      po = result.rows[0];
    } else {
      po = purchaseOrders.find((entry) => entry.id === id);
    }
    if (!po) return res.status(404).json({ message: 'Purchase Order not found' });
    if (['RECEIVED', 'IN_PROGRESS'].includes(po.status)) {
      res.status(409).json({ message: 'Received or in-progress purchase orders cannot be deleted.' });
      return;
    }

    let linkedInvoice: boolean;
    if (getPgConnected()) {
      const linked = await pgPool.query(PI_EXISTS_FOR_PO_SQL, [po.id, po.poNumber]);
      linkedInvoice = (linked.rowCount || 0) > 0;
    } else {
      linkedInvoice = purchaseInvoices.some((invoice) => invoice.poReferenceId === po.id || invoice.poReferenceId === po.poNumber);
    }
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

    if (!getPgConnected()) {
      setPurchaseOrders(purchaseOrders.filter((entry) => entry.id !== id));
      inventoryStock.forEach((stock) => {
        if (stock.branchId !== po.branchId) return;
        const item = items.find((entry: any) => entry.productId === stock.productId);
        if (item) stock.incomingQty = Math.max(0, (stock.incomingQty || 0) - (Number(item.quantity) || 0));
      });
    }
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
    if (getPgConnected()) {
      await pgPool.query(PO_PATCH_STATUS_SQL, [status, id]);
      const updated = await pgPool.query(PO_FIND_BY_ID_SQL, [id]);
      const po = updated.rows[0];
      if (po && typeof po.items === 'string') po.items = JSON.parse(po.items);
      logAuditEvent(req, 'UPDATE_PO_STATUS', 'PROCUREMENT', `Changed Purchase Order status to ${status}`);
      return res.json(po || { ...req.body, id, status });
    }
    const po = purchaseOrders.find((p) => p.id === id);
    if (po) po.status = status;
    logAuditEvent(req, 'UPDATE_PO_STATUS', 'PROCUREMENT', `Changed Purchase Order status to ${status}`);
    res.json(po || req.body);
  } catch (err: any) {
    console.error('Error updating PO status:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from procurement.routes.ts (get_purchaseInvoices). */
export async function get_purchaseInvoices(req: any, res: Response): Promise<any> {
const { branchId, paymentStatus, supplier, query, dateFromAD, dateToAD, page, pageSize, all } = req.query;
  // Paged mode: ?page=N (optional pageSize) returns an envelope with the page
  // slice, the filtered total, per-payment-status counts, and the taxable/VAT/
  // grand/unpaid sums for the register KPIs. ?all=1 returns every filtered row
  // (CSV export). No page param keeps the legacy full-array shape.
  const wantsPaged = page !== undefined || pageSize !== undefined || all === '1';
  const wantsFiltering = wantsPaged || paymentStatus || supplier || query || dateFromAD || dateToAD;
  if (getPgConnected()) {
    try {
      if (!wantsFiltering) {
        // Legacy full-array shape, still read from PostgreSQL so the register
        // never serves a stale mirror copy.
        const list = buildPiListSql(branchId);
        const allRows = await pgPool.query(list.sql, list.params as any[]);
        return res.json(allRows.rows);
      }
      const opts = { branchId, paymentStatus, supplier, query, dateFromAD, dateToAD };
      if (wantsPaged) {
        const n = Math.max(1, Number(page) || 1);
        const size = Math.max(1, Math.min(500, Number(pageSize) || 50));
        const aggQ = buildPurchaseInvoiceAggregateQuery(opts);
        const aggR = await pgPool.query(aggQ.sql, aggQ.params as any[]);
        const agg = aggR.rows[0] || {};
        const statusQ = buildPurchaseInvoiceStatusCountQuery(opts);
        const statusR = await pgPool.query(statusQ.sql, statusQ.params as any[]);
        const statusCounts: Record<string, number> = {};
        for (const row of statusR.rows) statusCounts[String(row.status)] = Number(row.count);
        const listQ = buildPurchaseInvoicePagedQuery(opts, all === '1' ? undefined : { page: n, pageSize: size });
        const r = await pgPool.query(listQ.sql, listQ.params as any[]);
        return res.json({
          data: r.rows,
          page: all === '1' ? 1 : n,
          pageSize: all === '1' ? Number(agg.count || 0) : size,
          totalItems: Number(agg.count || 0),
          statusCounts,
          sums: {
            taxable: Number(agg.taxable_sum || 0),
            vat: Number(agg.vat_sum || 0),
            grand: Number(agg.grand_sum || 0),
            unpaid: Number(agg.unpaid_sum || 0),
          },
        });
      }
      const { sql: q, params } = buildPurchaseInvoicePagedQuery(opts);
      const r = await pgPool.query(q, params as any[]);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching purchase invoices from DB:', err);
      return res.status(500).json({ message: 'Could not load purchase invoices from the database. Reload to retry.' });
    }
  }
  if (branchId && branchId !== 'ALL') {
    res.json(purchaseInvoices.filter((inv) => inv.branchId === branchId));
    return;
  }
  res.json(purchaseInvoices);

}

/** Forwarded from procurement.routes.ts (post_purchaseInvoices). */
/**
 * Writes one register row per received unit, inside the caller's invoice
 * transaction (Slice 1 of the serial-register plan — docs/serial-register-audit.md).
 *
 * The purchase invoice is the ONLY writer of brand-new serials: the register is
 * created here, live, so the sales and stock gates see the unit immediately
 * instead of after a server restart.
 *
 * Sequence per unit — PON/MAC owner probe, then the device serial:
 *   unseen serial          → INSERT (ON CONFLICT DO NOTHING; 0 rows = race)
 *   RETURNED_TO_VENDOR row → re-activate in place (the vendor had taken it back)
 *   anything else          → SerialRegisterError: the invoice posts nothing.
 */
async function registerPurchaseSerials(
  client: any,
  entries: PurchaseSerialEntry[],
  inv: { id: string; invoiceNumber?: string; invoiceDateAD?: string },
  branchId: string
): Promise<void> {
  const history = purchaseRegisterHistoryEntry(
    { id: inv.id, invoiceNumber: inv.invoiceNumber },
    inv.invoiceDateAD || new Date().toISOString()
  );
  for (const entry of entries) {
    if (entry.ponSerial) {
      const ponOwner = await client.query(SERIAL_LOG_PON_OWNER_SQL, [entry.ponSerial, entry.deviceSerial]);
      if (ponOwner.rowCount) {
        throw new SerialRegisterError(400, `PON serial ${entry.ponSerial} already belongs to device serial ${ponOwner.rows[0].deviceSerial}.`);
      }
    }
    if (entry.macAddress) {
      const macOwner = await client.query(SERIAL_LOG_MAC_OWNER_SQL, [entry.macAddress, entry.deviceSerial]);
      if (macOwner.rowCount) {
        throw new SerialRegisterError(400, `MAC address ${entry.macAddress} already belongs to device serial ${macOwner.rows[0].deviceSerial}.`);
      }
    }
    const existing = await client.query(SERIAL_LOG_FIND_BY_DEVICE_SQL, [entry.deviceSerial]);
    const timestamp = new Date().toISOString();
    if (!existing.rowCount) {
      const inserted = await client.query(SERIAL_LOG_INSERT_SQL, serialLogInsertParams({
        id: `sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        deviceSerial: entry.deviceSerial,
        ponSerial: entry.ponSerial,
        macAddress: entry.macAddress,
        productId: entry.productId || null,
        productName: entry.productName,
        branchId,
        customerId: null,
        customerName: null,
        status: 'IN_STOCK',
        sourceType: 'PURCHASE',
        sourceId: inv.id,
        historyJson: JSON.stringify([history]),
        timestamp,
      }));
      if (!inserted.rowCount) {
        // ON CONFLICT DO NOTHING now also covers the register's PON/MAC
        // unique indexes (schema.sql): a concurrent bill took the device
        // serial, the PON or the MAC first. Either way this unit is refused
        // and the whole invoice is rolled back.
        throw new SerialRegisterError(409, `Device serial ${entry.deviceSerial} was registered by another transaction — nothing was posted.`);
      }
      continue;
    }
    const row = existing.rows[0];
    if (String(row.status) !== 'RETURNED_TO_VENDOR') {
      throw new SerialRegisterError(409, `Device serial ${entry.deviceSerial} is already in the serial register (${row.status}) — a unit cannot be received twice.`);
    }
    let rowHistory: any[] = [];
    try {
      rowHistory = typeof row.history_json === 'string' ? JSON.parse(row.history_json || '[]') : (row.history_json || []);
    } catch { rowHistory = []; }
    await client.query(SERIAL_LOG_UPDATE_SQL, serialLogUpdateParams({
      ponSerial: entry.ponSerial,
      macAddress: entry.macAddress,
      productId: entry.productId || null,
      productName: entry.productName,
      branchId,
      customerId: null,
      customerName: null,
      status: 'IN_STOCK',
      sourceType: 'PURCHASE',
      sourceId: inv.id,
      historyJson: JSON.stringify([...rowHistory, history]),
      updatedAt: timestamp,
      id: row.id,
    }));
  }
}

/** Forwarded from procurement.routes.ts (post_purchaseInvoices). */
export async function post_purchaseInvoices(req: any, res: Response): Promise<any> {
try {
    const items = req.body.items || req.body.lines || [];
    // QTY-1: whole numbers only. A bill matched to a Purchase Order is bounded
    // by that PO's line (the match rule below refuses any other value), so a
    // legacy PO line above the typed-line ceiling stays billable; a direct
    // bill has no such bound and takes the ceiling.
    const quantityRefusal = firstLineQuantityRefusal(items, {
      uncapped: Boolean(req.body.poReferenceId || req.body.poId),
    });
    if (quantityRefusal) return res.status(400).json({ message: quantityRefusal });
    const targetBranchId = req.body.branchId || branches[0]?.id || 'WH001';
    const invDate = req.body.invoiceDateAD || req.body.invoiceDateAd || new Date().toISOString().split('T')[0];
    const invoiceNumber = req.body.invoiceNumber || (await issueNextDocNumber(targetBranchId, 'PI', invDate));
    // BS dates are mandatory: derive from bs_day_records for the invoice's
    // own AD date; 400 when unseeded (client-supplied BS never overrides).
    const invoiceDateBS = await bsDateOr400(res, invDate);
    if (!invoiceDateBS) return;
    const newInv = {
      id: req.body.id || `inv-${Date.now()}`,
      invoiceNumber,
      invoiceDateAD: invDate,
      ...req.body,
      // Placed after the spread so a client-supplied BS can never override
      // the server-derived value.
      invoiceDateBS,
    };
    // C1: the invoice's financial aggregates are recomputed from line
    // primitives (quantity × unitPrice, per-line taxRate/isTaxExempt). A
    // bill-level totalDiscount is a legitimate business input (like qty and
    // price) and is kept, but clamped to [0, gross subtotal]. Client-supplied
    // taxableAmount / vatAmount / nonTaxableAmount / grandTotal are ignored.
    const piTotals = computeBillTotals(items, newInv.totalDiscount, defaultVatRateFor(companyProfile));
    newInv.subtotalAmount = piTotals.netSubtotal;
    newInv.taxableAmount = piTotals.taxableAmount;
    newInv.nonTaxableAmount = piTotals.nonTaxableAmount;
    newInv.vatAmount = piTotals.vatAmount;
    newInv.grandTotal = piTotals.grandTotal;
    // Guard: the vendor bill date (stored as dueDateAD) can never be after the purchase date
    if (newInv.dueDateAD && newInv.invoiceDateAD && newInv.dueDateAD > newInv.invoiceDateAD) {
      res.status(400).json({ message: 'Vendor bill date cannot be after the purchase date.' });
      return;
    }
    const poReference = newInv.poReferenceId || req.body.poId;
    if (poReference) {
      let linkedPO: any;
      if (getPgConnected()) {
        const poResult = await pgPool.query(PO_FIND_BY_REF_SQL, [poReference]);
        linkedPO = poResult.rows[0];
        if (linkedPO && typeof linkedPO.items === 'string') linkedPO.items = JSON.parse(linkedPO.items);
      } else {
        linkedPO = purchaseOrders.find((po) => po.id === poReference || po.poNumber === poReference);
      }
      if (!linkedPO) return res.status(400).json({ message: 'The selected Purchase Order was not found.' });

      const poItems = new Map<string, any>((linkedPO.items as any[]).map((item: any) => [item.productId, item]));
      const invoiceItems = new Map(items.map((item: any) => [item.productId, item]));
      const exceeding = items.find((item: any) => Number(item.quantity) > Number(poItems.get(item.productId)?.quantity || 0));
      const quantityMismatch = items.find((item: any) => Number(item.quantity) !== Number(poItems.get(item.productId)?.quantity || 0));
      const missing = (linkedPO.items as any[]).find((item: any) => !invoiceItems.has(item.productId));
      const extra = items.find((item: any) => !poItems.has(item.productId));
      // A group RENAME rewrites the product through the foreign key cascade but
      // not the historical PO line, so two different names are only a real
      // mismatch when they no longer resolve to the same behaviour.
      const behaviorOfGroup = (name?: string | null): string => {
        const clean = String(name ?? '').trim().toLowerCase();
        if (!clean) return 'STOCK_ITEM';
        return productGroups.find((g) => g.name.toLowerCase() === clean || g.code.toLowerCase() === clean)?.behavior || 'STOCK_ITEM';
      };
      const typeMismatch = items.find((item: any) => {
        const poItem = poItems.get(item.productId);
        if (!poItem) return false;
        const product = products.find((entry) => entry.id === item.productId);
        const invoiceGroup = item.productGroup || product?.productGroup;
        const poGroup = poItem.productGroup || product?.productGroup;
        if (invoiceGroup === poGroup) return false;
        return behaviorOfGroup(invoiceGroup) !== behaviorOfGroup(poGroup);
      });
      if (exceeding) return res.status(400).json({ message: `Quantity exceeding PO for ${exceeding.productName || exceeding.productId}. Ordered quantity: ${poItems.get(exceeding.productId)?.quantity || 0}.` });
      if (missing) return res.status(400).json({ message: `PO product missing from vendor bill: ${missing.productName}.` });
      if (extra) return res.status(400).json({ message: `Product not present in selected Purchase Order: ${extra.productName || extra.productId}.` });
      if (typeMismatch) return res.status(400).json({ message: `Product type does not match the selected Purchase Order: ${typeMismatch.productName || typeMismatch.productId}.` });
      if (quantityMismatch) return res.status(400).json({ message: `Quantity must match the selected Purchase Order for ${quantityMismatch.productName || quantityMismatch.productId}.` });
      if (invoiceItems.size !== poItems.size) return res.status(400).json({ message: 'Purchase Order and vendor bill products must match exactly.' });
    }

    let invoiceAlreadyExists: boolean;
    if (getPgConnected()) {
      const existing = await pgPool.query(PI_EXISTS_SQL, [newInv.id, newInv.invoiceNumber]);
      invoiceAlreadyExists = existing.rowCount === 1;
    } else {
      invoiceAlreadyExists = purchaseInvoices.some((invoice) => invoice.id === newInv.id || invoice.invoiceNumber === newInv.invoiceNumber);
    }

    // Slice 1 (serial register): plan and validate the units this bill will
    // register. Runs before ANY write, so an invalid bill posts nothing at all.
    const serialPlan = planPurchaseSerialEntries(items, products as any[], targetBranchId);
    if (serialPlan.error) {
      res.status(400).json({ message: serialPlan.error });
      return;
    }
    // Demo mode (PG down) has no register transaction below, so the duplicate
    // rule is checked against the in-memory register before anything mutates.
    if (!getPgConnected() && !invoiceAlreadyExists && serialPlan.entries.length > 0) {
      const clash = serialPlan.entries.find((entry) => {
        const existingRow = findMirrorRowBySerial(serialLogs, entry.deviceSerial);
        return Boolean(existingRow) && String((existingRow as any).status || '') !== 'RETURNED_TO_VENDOR';
      });
      if (clash) {
        res.status(409).json({ message: `Device serial ${clash.deviceSerial} is already in the serial register — a unit cannot be received twice.` });
        return;
      }
    }

    // Resolve supplierId from the selected supplier name for the sub-ledger FK
    const supplierId = req.body.supplierId || undefined;
    const supLookup = suppliers.find(
      (s) => s.id === supplierId || s.name.toLowerCase() === (newInv.supplierName || '').toLowerCase()
    );
    const resolvedSupplierId = supplierId || supLookup?.id || null;

    // WTY-4: the supplier's warranty is captured from the bill that creates the
    // units, one VENDOR row per serial. Planned before any write so a reversed
    // or malformed expiry refuses the whole bill.
    const warrantyPlan = buildPurchaseWarrantyCaptures({
      invoiceDateAD: newInv.invoiceDateAD,
      invoiceId: newInv.id,
      invoiceNumber: newInv.invoiceNumber,
      supplierId: resolvedSupplierId,
      supplierName: newInv.supplierName,
      branchId: targetBranchId,
      entries: serialPlan.entries,
      lines: items,
      productFor: (productId) => products.find((entry) => entry.id === productId) as any,
    });
    if (warrantyPlan.error) {
      res.status(400).json({ message: warrantyPlan.error });
      return;
    }

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

        if (!invoiceAlreadyExists) for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
          const item = items[itemIdx];
          const received = await client.query(PI_RECEIVE_STOCK_SQL, piReceiveStockParams(targetBranchId, item));

          // Real ledger balance: the upsert RETURNING gives the post-receipt
          // QOH, so the PURCHASE_INVOICE row records the TRUE before/after.
          const after = Number(received.rows?.[0]?.quantity_on_hand);
          const qty = Number(item.quantity) || 0;
          const stockBefore = Number.isFinite(after) ? after - qty : undefined;
          await client.query(PI_TXN_LOG_SQL, piTxnLogParams(newInv, item, targetBranchId, itemIdx, stockBefore));
        }

        // Slice 1: the register rows for this bill, in the SAME transaction as
        // the stock receive and the ledger rows — either the units are
        // registered or nothing posts.
        if (!invoiceAlreadyExists && serialPlan.entries.length > 0) {
          await registerPurchaseSerials(client, serialPlan.entries, newInv, targetBranchId);
        }

        // Same transaction as the receipt: either the units and their supplier
        // coverages both exist, or a rolled-back receipt leaves neither.
        if (!invoiceAlreadyExists) {
          for (const capture of warrantyPlan.captures) {
            await recordWarrantyCoverage(client, capture);
          }
        }

        const poRef = newInv.poReferenceId || req.body.poId;
        if (poRef) {
          await client.query(PO_MARK_STATUS_SQL, ['RECEIVED', poRef]);
        }
      });
    }

    // The invoice joins the in-memory mirror only after the transaction
    // committed: a refusal (duplicate serial, stock race) must not leave a
    // phantom invoice behind. PostgreSQL is the single source of truth when
    // connected, so the mirror is demo-mode only (bootstrap-trim step 5).
    if (!getPgConnected()) {
      const idx = purchaseInvoices.findIndex((i) => i.id === newInv.id);
      setPurchaseInvoices(idx >= 0 ? withReplaced(purchaseInvoices, idx, newInv) : withPrepended(purchaseInvoices, newInv));
    }

    // Demo mode (PG down) twin of the coverage write above.
    if (!getPgConnected() && !invoiceAlreadyExists) {
      for (const capture of warrantyPlan.captures) recordWarrantyCoverageMirror(capture);
    }

    // Demo mode (PG down) twin of the register write above.
    if (!getPgConnected() && !invoiceAlreadyExists && serialPlan.entries.length > 0) {
      const timestamp = new Date().toISOString();
      const history = purchaseRegisterHistoryEntry(newInv, newInv.invoiceDateAD);
      let rows: readonly any[] = serialLogs;
      for (const entry of serialPlan.entries) {
        rows = applyRegisterEntryToMirror(rows, entry, {
          id: `sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp,
          history,
          sourceId: newInv.id,
        }).rows;
      }
      setSerialLogs(rows);
    }

    // Detect the PO used in this vendor bill and mark it RECEIVED (in-memory
    // mirror for non-DB mode; DB mode is updated inside the transaction above).
    if (!getPgConnected()) {
      const billPoRef = newInv.poReferenceId || req.body.poId;
      const billLinkedPO = purchaseOrders.find((p) => p.id === billPoRef || p.poNumber === billPoRef);
      if (billLinkedPO) billLinkedPO.status = 'RECEIVED';
    }

    if (!getPgConnected() && !invoiceAlreadyExists) {
      const demoTxns: TransactionLog[] = [];
      items.forEach((item: any, itemIdx: number) => {
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
        const before = Number(stk.quantityOnHand) || 0;
        const qty = Number(item.quantity) || 0;
        stk.quantityOnHand = before + qty;
        stk.lastUpdated = new Date().toISOString();
        // PURCHASE_INVOICE ledger row at the document's unit price (the cost
        // the business actually paid), mirroring the PG path's before/after.
        demoTxns.push(demoPurchaseInvoiceTxn(itemIdx, {
          productId: item.productId, productSku: item.sku, productName: item.productName,
          branchId: targetBranchId, quantityBefore: before, quantityChanged: qty,
          unitCost: Number(item.unitPrice) || 0, referenceDocId: newInv.invoiceNumber,
          timestampAD: newInv.invoiceDateAD, timestampBS: newInv.invoiceDateBS,
        }));
      });
      if (demoTxns.length > 0) setTransactionLogs([...demoTxns, ...transactionLogs]);
    }
    logAuditEvent(req, 'CREATE_PURCHASE_INVOICE', 'PROCUREMENT', `Created Purchase Invoice #${newInv.invoiceNumber}`);
    res.status(201).json(newInv);
  } catch (err: any) {
    // A refused serial is a caller error, not a server fault: report the exact
    // reason with its own status instead of a generic 500.
    if (err instanceof SerialRegisterError) {
      res.status(err.status).json({ message: err.message });
      return;
    }
    // A unique-index violation here is a duplicate identity, not a server
    // fault: the register's device-serial/PON/MAC indexes (schema.sql) tripped
    // on a row another transaction committed between check and write.
    if (err?.code === '23505') {
      res.status(409).json({ message: 'A device serial, PON serial or MAC address in this bill was just registered by another transaction — nothing was posted.' });
      return;
    }
    console.error('Error creating purchase invoice:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from procurement.routes.ts (delete_Id2). */
export async function delete_Id2(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    let invoice: any;
    if (getPgConnected()) {
      const result = await pgPool.query(PI_FIND_FOR_DELETE_SQL, [id]);
      invoice = result.rows[0];
    } else {
      invoice = purchaseInvoices.find((entry) => entry.id === id);
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
        // Stock reversal + compensating ledger rows in ONE per-product pass:
        // the original PURCHASE_INVOICE rows stay (audit immutability), so
        // the deletion reverses them out of the movement ledger with positive
        // mirror rows carrying the TRUE balance from the guarded reversal's
        // RETURNING (before + restored = after).
        const cancelAD = new Date().toISOString().split('T')[0];
        const cancelBsRec = await findBsDayRecordForAdDate(cancelAD);
        const cancelBS = cancelBsRec.found ? `${cancelBsRec.record.bsDate} BS` : '';
        let lineIdx = 0;
        for (const [productId, quantity] of quantities) {
          const updated = await client.query(PI_REVERSE_STOCK_SQL, [quantity, productId, invoice.branchId]);
          if (updated.rowCount !== 1) throw new Error(`Insufficient stock to reverse invoice item ${productId}.`);
          const after = Number(updated.rows?.[0]?.quantity_on_hand);
          const stockBefore = Number.isFinite(after) ? after + quantity : 0;
          const item = items.find((entry: any) => entry.productId === productId) || { productId };
          await client.query(
            PI_CANCEL_TXN_LOG_SQL,
            piCancelTxnLogParams(invoice, item, invoice.branchId, lineIdx++, stockBefore, { ad: cancelAD, bs: cancelBS })
          );
        }
        if (serials.length > 0 && purchaseRefs.length > 0) {
          await client.query(CDR_IN_STOCK_DELETE_SQL, [serials, purchaseRefs]);
        }
        // Slice 1: the register rows this bill received leave with it. Keyed on
        // the bill's OWN serials, because a sale/deploy rewrites source_*; a
        // unit that has since moved keeps its row, and the deletion is refused
        // rather than orphaning that history.
        if (serials.length > 0) {
          const movedSerial = await client.query(SERIAL_LOG_MOVED_BY_INVOICE_SERIALS_SQL, [serials]);
          if (movedSerial.rowCount) {
            throw new Error(`This invoice registered device serial ${movedSerial.rows[0].deviceSerial}, which has since moved (sold, assigned or damaged) — it cannot be deleted.`);
          }
          await client.query(SERIAL_LOG_DELETE_BY_INVOICE_SERIALS_SQL, [serials]);
        }
        await client.query(PI_DELETE_SQL, [id]);
        if (invoice.poReferenceId) {
          await client.query(PO_MARK_STATUS_SQL, ['APPROVED', invoice.poReferenceId]);
        }
        // Audit entry joins the transaction (committed deletion never unlogged).
        await logAuditEvent(
          req,
          'DELETE_PURCHASE_INVOICE',
          'PROCUREMENT',
          `Deleted Purchase Invoice #${invoice.invoiceNumber} and reversed its stock`,
          undefined,
          client
        );
      });
    } else {
      logAuditEvent(req, 'DELETE_PURCHASE_INVOICE', 'PROCUREMENT', `Deleted Purchase Invoice #${invoice.invoiceNumber} and reversed its stock`);
    }

    // Demo-mode mirror cleanup only: the PostgreSQL path already reversed
    // stock, register rows and PO status inside the transaction above.
    if (!getPgConnected()) {
      setPurchaseInvoices(purchaseInvoices.filter((entry) => entry.id !== id));
      inventoryStock.forEach((stock) => {
        if (stock.branchId !== invoice.branchId) return;
        const quantity = quantities.get(stock.productId);
        if (quantity) stock.quantityOnHand = Math.max(0, stock.quantityOnHand - quantity);
      });
      setCustomerDeviceRecords(customerDeviceRecords.filter(
        (record) => !(serials.includes(record.deviceSerial) && purchaseRefs.includes(record.purchaseBillRef || '') && record.status === 'IN_STOCK')
      ));
      // Mirror of the transactional register cleanup (still-IN_STOCK rows only),
      // keyed the same way: this bill's own serials, never source_type/source_id.
      const invoiceSerialKeys = new Set(serials.map((s: string) => String(s).trim().toUpperCase()));
      setSerialLogs(serialLogs.filter(
        (record) => !(invoiceSerialKeys.has(String(record.deviceSerial || '').trim().toUpperCase()) && String(record.status || '') === 'IN_STOCK')
      ));
      const linkedPO = purchaseOrders.find((entry) => entry.id === invoice.poReferenceId || entry.poNumber === invoice.poReferenceId);
      if (linkedPO) linkedPO.status = 'APPROVED';
    }
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
    // The audit entry joins the same transaction: a committed payment is
    // never left unlogged.
    const finalRes = await withTransaction(async (client) => {
      const locked = await client.query(PI_LOCK_FOR_UPDATE_SQL, [id]);
      if (!locked.rows[0]) {
        const notFound: any = new Error('Purchase invoice not found');
        notFound.statusCode = 404;
        throw notFound;
      }
      await client.query(PI_RECORD_PAYMENT_SQL, [paymentAmount, id]);
      const after = await client.query(PI_BALANCE_AFTER_SQL, [id]);
      await logAuditEvent(
        req,
        'RECORD_INVOICE_PAYMENT',
        'PROCUREMENT',
        `Recorded payment of NPR ${paymentAmount.toLocaleString()} for Invoice`,
        undefined,
        client
      );
      return after.rows[0];
    });

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

    // PostgreSQL is the only decision source when connected: a mirror copy
    // must never decide whether a bill is settled or which payments reverse.
    let inv: any;
    if (getPgConnected()) {
      const invRes = await pgPool.query(PI_FIND_FOR_PAYMENT_SQL, [id]);
      inv = invRes.rows[0];
    } else {
      inv = purchaseInvoices.find((i) => i.id === id);
    }
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
    const paymentsToReverse: VendorPayment[] = getPgConnected()
      ? ((await pgPool.query(VP_POSTED_BY_INVOICE_SQL, [id])).rows as VendorPayment[])
      : vendorPayments.filter((p) => p.invoiceId === id && p.status === 'POSTED');
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
        // Audit entry joins the transaction (committed reversal never unlogged).
        await logAuditEvent(
          req,
          'REVERSE_INVOICE_PAYMENTS',
          'PROCUREMENT',
          `Reversed ${paymentsToReverse.length} payment(s) totaling NPR ${reversedTotal.toLocaleString()} for Invoice #${inv.invoiceNumber} (${reason})`,
          inv.branchId,
          client
        );
      });
    }

    // Demo-mode mirror state only; PostgreSQL already committed the reversal.
    if (!getPgConnected()) {
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
    }
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
      return res.status(500).json({ message: 'Could not load vendor payments from the database. Reload to retry.' });
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
      return res.status(500).json({ message: 'Could not load invoice payments from the database. Reload to retry.' });
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
    // PostgreSQL is the only source when connected (bootstrap-trim step 5).
    let linkedInvoice: any;
    if (body.invoiceId) {
      if (getPgConnected()) {
        const invRes = await pgPool.query(PI_FIND_FOR_PAYMENT_SQL, [body.invoiceId]);
        linkedInvoice = invRes.rows[0];
      } else {
        linkedInvoice = purchaseInvoices.find((inv) => inv.id === body.invoiceId || inv.invoiceNumber === body.invoiceId);
      }
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
    // BS dates are mandatory: derive from bs_day_records for the payment's
    // OWN AD date (never the linked invoice's date, never a fallback);
    // 400 when the calendar day is unseeded.
    const paymentDateBS = await bsDateOr400(res, paymentDateAD);
    if (!paymentDateBS) return;
    let chequeDateBS: string | null = null;
    if (body.chequeDateAD) {
      chequeDateBS = await bsDateOr400(res, body.chequeDateAD);
      if (!chequeDateBS) return;
    }

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
      chequeDateBS,
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

    if (getPgConnected()) {
      await pgPool.query(VP_INSERT_SQL, vpInsertParams(newPayment));
    } else {
      setVendorPayments(withPrepended(vendorPayments, newPayment));
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
    let payment: any;
    if (getPgConnected()) {
      const payRes = await pgPool.query(VP_FIND_BY_ID_SQL, [id]);
      payment = payRes.rows[0];
    } else {
      payment = vendorPayments.find((p) => p.id === id);
    }
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
        // Audit entry joins the transaction (committed reversal never unlogged).
        await logAuditEvent(
          req,
          'REVERSE_VENDOR_PAYMENT',
          'PROCUREMENT',
          `Reversed vendor payment #${payment.paymentNumber} of NPR ${Number(payment.amount || 0).toLocaleString()} (${reason})`,
          payment.branchId,
          client
        );
      });
    } else {
      logAuditEvent(
        req,
        'REVERSE_VENDOR_PAYMENT',
        'PROCUREMENT',
        `Reversed vendor payment #${payment.paymentNumber} of NPR ${Number(payment.amount || 0).toLocaleString()} (${reason})`,
        payment.branchId
      );
    }

    // Demo-mode mirror only; PostgreSQL already committed the reversal.
    if (!getPgConnected()) {
      payment.status = 'REVERSED';
      payment.reversalReason = reason;
      payment.reversedBy = getUserFromReq(req).email || 'system';
      payment.reversedAtAD = new Date().toISOString();
    }

    // Mirror the invoice decrement in memory (only when not pg-connected).
    if (!getPgConnected() && payment.invoiceId) {
      const inv = purchaseInvoices.find((i) => i.id === payment.invoiceId);
      if (inv) {
        inv.amountPaid = Math.max(0, Number(inv.amountPaid || 0) - Number(payment.amount || 0));
        inv.paymentStatus = inv.amountPaid >= (Number(inv.grandTotal) || 0) ? 'PAID' : inv.amountPaid > 0 ? 'PARTIAL' : 'UNPAID';
      }
    }

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

    let invoices: any[];
    let payments: VendorPayment[];
    let returns: any[];

    if (getPgConnected()) {
      // PostgreSQL is the ledger's only source: a failed read is an error, not
      // a cue to substitute a possibly stale mirror.
      try {
        const invRes = await pgPool.query(LEDGER_INVOICES_SQL, ledgerNameParams(supplier));
        invoices = invRes.rows;
        const payRes = await pgPool.query(
          `${VENDOR_PAYMENT_SELECT}${LEDGER_PAYMENTS_SQL_SUFFIX}`,
          ledgerNameParams(supplier) as any[]
        );
        payments = payRes.rows;
        // Posted purchase returns (debit notes) reduce the payable like payments.
        const retRes = await pgPool.query(LEDGER_RETURNS_SQL, ledgerNameParams(supplier));
        returns = retRes.rows;
      } catch (err: any) {
        console.error('Vendor ledger DB query failed:', err?.message || err);
        return res.status(500).json({ message: 'Could not load the vendor ledger from the database. Reload to retry.' });
      }
    } else {
      invoices = purchaseInvoices.filter((inv) => bySupplierId(inv) || byLegacyName(inv));
      payments = vendorPayments.filter((p) =>
        (p.supplierId && p.supplierId === supplier.id) || byLegacyName(p)
      );
      returns = purchaseReturns.filter((r: any) =>
        (r.supplierId && r.supplierId === supplier.id) || byLegacyName(r)
      );
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

    // Posted purchase returns (debit notes) are CREDIT lines: goods (and VAT)
    // go back to the vendor, so the closing payable reconciles as
    // opening + invoices − payments − returns.
    const returnLines = returns
      .filter((r: any) => r.status === 'POSTED' || r.status === undefined)
      .filter((r: any) => inScope(r.branchId, r.returnDateAD))
      .map((r: any) => ({
        id: `ret-${r.id}`,
        documentNumber: r.returnNumber,
        dateAD: String(r.returnDateAD || '').split('T')[0],
        dateBS: r.returnDateBS || '',
        amount: Number(r.grandTotal) || 0,
        vatAmount: undefined,
        type: 'RETURN' as const,
        notes: r.notes || `Purchase return${r.originalInvoiceNumber ? ` against ${r.originalInvoiceNumber}` : ''}`,
        paymentMethod: undefined,
        debit: 0,
        credit: Number(r.grandTotal) || 0,
      }));

    const allLines = [...invoiceLines, ...paymentLines, ...returnLines].sort((a, b) =>
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


// ---------------------------------------------------------------------------
// Purchase Returns (Debit Notes, DN-…) — HTTP orchestration
// ---------------------------------------------------------------------------

/** Over-return validation shared by post_purchaseReturns: returnable = invoiced − posted-returned. */
function prValidateAgainstInvoice(invoiceItems: any[], returnItems: any[], alreadyReturned: Map<string, number>): string | null {
  for (const item of returnItems) {
    const invoiced = invoiceItems.find((i) => i.productId === item.productId);
    if (!invoiced) return `Product not present in the original invoice: ${item.productName || item.productId}.`;
    const invoicedQty = Math.abs(Number(invoiced.quantity)) || 0;
    const returned = alreadyReturned.get(item.productId) || 0;
    const requesting = Math.abs(Number(item.quantity)) || 0;
    if (requesting > invoicedQty - returned) {
      return `Over-return for ${item.productName || item.productId}: invoiced ${invoicedQty}, already returned ${returned}, requested ${requesting}.`;
    }
  }
  return null;
}

/** Forwarded from procurement.routes.ts (get_purchaseReturns). */
export async function get_purchaseReturns(req: any, res: Response): Promise<any> {
  const { branchId, status, query, dateFromAD, dateToAD, page, pageSize, all } = req.query;
  // Paged mode: ?page=N (optional pageSize) returns an envelope with the page
  // slice and the filtered total (the purchase-orders pattern). Filters
  // without a page param keep the legacy full-array response; a bare
  // ?branchId= request is unchanged.
  const wantsPaged = page !== undefined || pageSize !== undefined || all === '1';
  const wantsFiltering = wantsPaged || status || query || dateFromAD || dateToAD;
  if (getPgConnected() && wantsFiltering) {
    try {
      const opts = { branchId, status, query, dateFromAD, dateToAD };
      if (wantsPaged) {
        const n = Math.max(1, Number(page) || 1);
        const size = Math.max(1, Math.min(500, Number(pageSize) || 50));
        const countQ = buildPurchaseReturnCountQuery(opts);
        const countR = await pgPool.query(countQ.sql, countQ.params as any[]);
        const totalItems = Number(countR.rows[0]?.count || 0);
        const listQ = buildPurchaseReturnPagedQuery(opts, all === '1' ? undefined : { page: n, pageSize: size });
        const r = await pgPool.query(listQ.sql, listQ.params as any[]);
        return res.json({
          data: r.rows,
          page: all === '1' ? 1 : n,
          pageSize: all === '1' ? totalItems : size,
          totalItems,
        });
      }
      const filteredQ = buildPurchaseReturnPagedQuery(opts);
      const filteredR = await pgPool.query(filteredQ.sql, filteredQ.params as any[]);
      return res.json(filteredR.rows);
    } catch (err) {
      console.error('Error fetching purchase returns from DB:', err);
    }
  }
  if (getPgConnected()) {
    try {
      const { sql, params } = buildPurchaseReturnListSql(branchId);
      const r = await pgPool.query(sql, params as any[]);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching purchase returns from DB:', err);
      return res.status(500).json({ message: 'Could not load purchase returns from the database. Reload to retry.' });
    }
  }
  const list = branchId && branchId !== 'ALL'
    ? purchaseReturns.filter((r) => r.branchId === branchId)
    : purchaseReturns;
  res.json(list);
}

/**
 * Approval threshold for returns (extras item): a return whose recomputed
 * grand total exceeds this many NPR is inserted as DRAFT (no stock/ledger
 * effect) until explicitly approved via POST /:id/post. Override with
 * RETURNS_APPROVAL_THRESHOLD_NPR; 0 disables the gating.
 */
const RETURNS_APPROVAL_THRESHOLD_NPR = intFromEnv('RETURNS_APPROVAL_THRESHOLD_NPR', 200000, { min: 0 });

/** The product rule both return flows share (quantity-only lines carry none). */
function isSerialTrackedProduct(productId?: string): boolean {
  return Boolean(products.find((p) => p.id === productId)?.requiresSerialTracking);
}

/**
 * Applies a purchase return's posting effects inside an open transaction:
 * stock deduction, PURCHASE_RETURN ledger rows, and serial_log flips to
 * RETURNED_TO_VENDOR with a history entry.
 */
async function applyPurchaseReturnEffects(client: any, ret: any, items: any[], branchId: string): Promise<void> {
  for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
    const item = items[itemIdx];
    const qty = Math.abs(Number(item.quantity)) || 0;
    const deducted = await client.query(PR_DEDUCT_STOCK_SQL, [qty, item.productId, branchId]);
    if (deducted.rowCount !== 1) {
      throw new Error(`Insufficient stock to return ${qty} × ${item.productName || item.productId} at branch ${branchId}.`);
    }
    // Real ledger balance: the guarded UPDATE RETURNING gives the
    // post-deduction QOH, so before = after + qty.
    const after = Number(deducted.rows?.[0]?.quantity_on_hand);
    const stockBefore = Number.isFinite(after) ? after + qty : undefined;
    await client.query(PR_TXN_LOG_SQL, prTxnLogParams(ret, item, branchId, itemIdx, stockBefore));
    const serials = returnLineSerials(item).map((entry) => entry.deviceSerial);
    // WTY-4: only the units this return actually took back lose their VENDOR
    // coverage — a partial return must not retire the rest of the bill. The row
    // is kept and marked, so the register can show why it ended.
    await retireCoverageForSerials(client, 'VENDOR', serials, {
      reason: 'PURCHASE_RETURN',
      ref: ret.returnNumber,
    });
    if (serials.length > 0) {
      const flipped = await client.query(PR_SERIAL_FLIP_SQL, [
        serials.map((serial) => serial.toLowerCase()),
        'RETURNED_TO_VENDOR',
        JSON.stringify([{
          status: 'RETURNED_TO_VENDOR',
          sourceType: 'PURCHASE_RETURN',
          sourceId: ret.id,
          dateAD: String(ret.returnDateAD || '').split('T')[0],
          notes: `Returned to vendor via ${ret.returnNumber}`,
        }]),
        ['IN_STOCK'],
      ]);
      if (flipped.rowCount !== serials.length) {
        throw new Error(
          `Could not claim all ${serials.length} returned serial(s) — one or more are no longer ` +
            `IN_STOCK at ${branchId}. Nothing was posted.`
        );
      }
    }
  }
}

/** Forwarded from procurement.routes.ts (post_purchaseReturns). */
export async function post_purchaseReturns(req: any, res: Response): Promise<any> {
  try {
    const items = req.body.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'A purchase return requires at least one item line.' });
    }
    const originalRef = req.body.originalInvoiceId || req.body.invoiceId || req.body.invoiceNumber;
    if (!originalRef) {
      return res.status(400).json({ message: 'A purchase return must reference the original purchase invoice.' });
    }
    // QTY-1: whole numbers only. A return is bounded by the invoice line it
    // reverses (checked below), not by the typed-line ceiling, so a legacy
    // line above the ceiling stays returnable.
    const quantityRefusal = firstLineQuantityRefusal(items, { uncapped: true });
    if (quantityRefusal) return res.status(400).json({ message: quantityRefusal });

    // C1: totals are recomputed from line primitives; client aggregates ignored.
    const totals = computeBillTotals(items, undefined, defaultVatRateFor(companyProfile));
    const targetBranchId = req.body.branchId || branches[0]?.id || 'WH001';
    const retDate = req.body.returnDateAD || req.body.returnDateAd || new Date().toISOString().split('T')[0];
    // BS dates are mandatory: derive from bs_day_records for the return's
    // own AD date; 400 when unseeded.
    const prReturnDateBS = await bsDateOr400(res, retDate);
    if (!prReturnDateBS) return;
    const returnNumber = req.body.returnNumber || (await issueNextDocNumber(targetBranchId, 'DN', retDate));

    // PostgreSQL first: a stale mirror invoice must never gate a return or
    // supply its item lines (bootstrap-trim step 5 applies to returns too).
    let invoiceRow: any;
    if (getPgConnected()) {
      const r = await pgPool.query(PR_LOCK_INVOICE_SQL, [originalRef]);
      invoiceRow = r.rows[0];
      if (invoiceRow && typeof invoiceRow.items === 'string') invoiceRow.items = JSON.parse(invoiceRow.items);
    } else {
      invoiceRow = purchaseInvoices.find((i) => i.id === originalRef || i.invoiceNumber === originalRef);
    }
    if (!invoiceRow) {
      return res.status(400).json({ message: 'The original purchase invoice was not found.' });
    }
    if (getPgConnected() && !invoiceRow.items) {
      // Re-read items inside the locked row if the cache copy lacked them.
      const r = await pgPool.query(PR_LOCK_INVOICE_SQL, [invoiceRow.id]);
      invoiceRow = { ...invoiceRow, ...r.rows[0] };
      if (invoiceRow.items && typeof invoiceRow.items === 'string') invoiceRow.items = JSON.parse(invoiceRow.items);
    }

    const newRet: any = {
      id: req.body.id || `pr-${Date.now()}`,
      returnNumber,
      originalInvoiceId: invoiceRow.id,
      originalInvoiceNumber: invoiceRow.invoiceNumber,
      supplierId: req.body.supplierId || invoiceRow.supplierId || null,
      supplierName: req.body.supplierName || invoiceRow.supplierName || 'Vendor',
      branchId: targetBranchId,
      returnDateAD: retDate,
      returnDateBS: prReturnDateBS,
      reason: req.body.reason || 'DEFECTIVE',
      notes: req.body.notes || '',
      taxableAmount: totals.taxableAmount,
      vatAmount: totals.vatAmount,
      nonTaxableAmount: totals.nonTaxableAmount,
      grandTotal: totals.grandTotal,
      // Approval gating: above the threshold the return is held as DRAFT with
      // no stock/ledger effect until POST /:id/post approves it.
      status: totals.grandTotal > RETURNS_APPROVAL_THRESHOLD_NPR ? 'DRAFT' : 'POSTED',
      items,
    };

    // Return serials: shape first (count per unit, no duplicates), then the
    // register (exists, product, original bill, IN_STOCK at this branch) and
    // hydrate MAC/PON from it. The browser names units; the register defines
    // their identity.
    const serialViolation = validateReturnSerialCounts(items, isSerialTrackedProduct);
    if (serialViolation) return res.status(400).json({ message: serialViolation });
    const returnSerialList = collectReturnSerials(items);
    if (returnSerialList.length > 0) {
      const serialRows: Map<string, SerialLogRow> = getPgConnected()
        ? await loadReturnSerialRows(pgPool, returnSerialList)
        : serialRowsFromInvoiceItems(invoiceRow.items || []);
      if (getPgConnected()) {
        const registerViolation = validateReturnSerialsAgainstRegister(items, serialRows, {
          kind: 'PURCHASE',
          invoiceItems: invoiceRow.items || [],
          branchId: targetBranchId,
        });
        if (registerViolation) return res.status(400).json({ message: registerViolation });
      }
      hydrateReturnSerialEntries(items, serialRows);
    }

    if (getPgConnected()) {
      // Over-return guard: per (invoice, product) already-returned quantity,
      // computed inside the same transaction that inserts the return.
      const perProductReturned = new Map<string, number>();
      for (const item of items) {
        const r = await pgPool.query(PR_RETURNED_QTY_SQL, [invoiceRow.id, item.productId]);
        perProductReturned.set(item.productId, Number(r.rows[0]?.returned_qty || 0));
      }
      const violation = prValidateAgainstInvoice(invoiceRow.items || [], items, perProductReturned);
      if (violation) return res.status(400).json({ message: violation });

      let dup = purchaseReturns.some((r) => r.id === newRet.id || r.returnNumber === returnNumber);
      if (!dup) {
        const e = await pgPool.query(PR_EXISTS_SQL, [newRet.id, returnNumber]);
        dup = e.rowCount === 1;
      }
      if (dup) return res.status(409).json({ message: `Purchase return ${returnNumber} already exists.` });

      // All-or-nothing: return insert + (when POSTED) per-item stock
      // deduction + ledger rows + serial flips. DRAFT inserts alone.
      await withTransaction(async (client) => {
        await client.query(PR_INSERT_SQL, prInsertParams(newRet, JSON.stringify(items)));
        if (newRet.status === 'POSTED') {
          await applyPurchaseReturnEffects(client, newRet, items, targetBranchId);
        }
      });
    } else {
      // Demo mode (no PG): persist the return and, when POSTED, mirror the
      // stock deduction + PURCHASE_RETURN ledger rows in memory (the PG
      // transaction above is skipped entirely when the DB is down).
      setPurchaseReturns(withPrepended(purchaseReturns, newRet));
      if (newRet.status === 'POSTED') {
        const demoTxns: TransactionLog[] = [];
        items.forEach((item: any, itemIdx: number) => {
          const qty = Math.abs(Number(item.quantity)) || 0;
          const { stock, before } = findOrCreateDemoStock(inventoryStock, setInventoryStock, item.productId, targetBranchId);
          stock.quantityOnHand = Math.max(0, before - qty);
          stock.lastUpdated = new Date().toISOString();
          demoTxns.push(demoPurchaseReturnTxn(itemIdx, {
            productId: item.productId, productSku: item.sku, productName: item.productName,
            branchId: targetBranchId, quantityBefore: before, quantityChanged: -qty,
            unitCost: resolveLedgerUnitCost(products, item), referenceDocId: returnNumber,
            timestampAD: newRet.returnDateAD, timestampBS: newRet.returnDateBS,
          }));
        });
        if (demoTxns.length > 0) setTransactionLogs([...demoTxns, ...transactionLogs]);
        // Demo twin of the per-unit retirement in applyPurchaseReturnEffects.
        retireCoverageForSerialsMirror('VENDOR', collectReturnSerials(items), {
          reason: 'PURCHASE_RETURN',
          ref: returnNumber,
        });
      }
    }

    if (newRet.status === 'DRAFT') {
      logAuditEvent(req, 'CREATE_PURCHASE_RETURN_DRAFT', 'PROCUREMENT', `Purchase Return #${newRet.returnNumber} (Rs. ${newRet.grandTotal}) held for approval (threshold Rs. ${RETURNS_APPROVAL_THRESHOLD_NPR})`);
      return res.status(201).json({ ...newRet, pendingApproval: true, approvalThreshold: RETURNS_APPROVAL_THRESHOLD_NPR });
    }

    logAuditEvent(req, 'CREATE_PURCHASE_RETURN', 'PROCUREMENT', `Created Purchase Return #${newRet.returnNumber} against invoice ${newRet.originalInvoiceNumber} (supplier ${newRet.supplierName})`);
    res.status(201).json(newRet);
  } catch (err: any) {
    console.error('Error creating purchase return:', err);
    res.status(400).json({ message: err.message || 'Failed to create purchase return.' });
  }
}

/** Forwarded from procurement.routes.ts (post_purchaseReturnCancel). */
export async function post_purchaseReturnCancel(req: any, res: Response): Promise<any> {
  try {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();
    let ret: any = purchaseReturns.find((r) => r.id === id || r.returnNumber === id);
    if (!ret && getPgConnected()) {
      const r = await pgPool.query(PR_FIND_ONE_SQL, [id]);
      ret = r.rows[0];
      if (ret && typeof ret.items === 'string') ret.items = JSON.parse(ret.items);
    }
    if (!ret) return res.status(404).json({ message: 'Purchase return not found.' });
    if (ret.status !== 'POSTED' && ret.status !== 'DRAFT') {
      return res.status(400).json({ message: `Only POSTED or DRAFT returns can be cancelled (current status: ${ret.status}).` });
    }

    // BS date for the compensating ledger rows: today's seeded BS record.
    const prCancelAD = new Date().toISOString().split('T')[0];
    const prCancelBsRec = await findBsDayRecordForAdDate(prCancelAD);
    const prCancelBS = prCancelBsRec.found ? `${prCancelBsRec.record.bsDate} BS` : '';

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        // Guarded cancel: flips status only when still POSTED/DRAFT (race-safe).
        // POSTED returns also restore the stock the return took out; DRAFT
        // returns had no stock effect, so there is nothing to restore.
        const cancelled = ret.status === 'DRAFT'
          ? await client.query(PR_CANCEL_DRAFT_SQL, [ret.id])
          : await client.query(PR_CANCEL_SQL, [ret.id]);
        if (cancelled.rowCount !== 1) throw new Error('Return was already cancelled by another user.');
        if (ret.status === 'POSTED') {
          let cancelLineIdx = 0;
          for (const item of ret.items || []) {
            const restoreQty = Math.abs(Number(item.quantity)) || 0;
            const restored = await client.query(PR_RESTORE_STOCK_SQL, [restoreQty, item.productId, ret.branchId]);
            // Compensating PURCHASE_RETURN_CANCELLED ledger row: the original
            // deduction row stays, so a positive mirror nets the return back
            // to zero with the TRUE balance from the restore's RETURNING.
            const after = Number(restored.rows?.[0]?.quantity_on_hand);
            const stockBefore = Number.isFinite(after) ? after - restoreQty : 0;
            await client.query(
              PR_CANCEL_TXN_LOG_SQL,
              prCancelTxnLogParams(ret, item, ret.branchId, cancelLineIdx++, stockBefore, { ad: prCancelAD, bs: prCancelBS })
            );
            const serials = returnLineSerials(item).map((entry) => entry.deviceSerial);
            if (serials.length > 0) {
              const flipped = await client.query(PR_SERIAL_FLIP_SQL, [
                serials.map((serial) => serial.toLowerCase()),
                'IN_STOCK',
                JSON.stringify([{
                  status: 'IN_STOCK',
                  sourceType: 'PURCHASE_RETURN_CANCELLED',
                  sourceId: ret.id,
                  dateAD: new Date().toISOString().split('T')[0],
                  notes: `Purchase return ${ret.returnNumber} cancelled`,
                }]),
                ['RETURNED_TO_VENDOR'],
              ]);
              if (flipped.rowCount !== serials.length) {
                throw new Error(
                  `Could not restore the returned serial(s) for ${ret.returnNumber} — one or more ` +
                    `are no longer RETURNED_TO_VENDOR. Nothing was cancelled.`
                );
              }
            }
          }
        }
      });
    } else if (ret.status === 'POSTED') {
      // Demo mode (no PG): mirror the POSTED-cancel effects in memory — restore
      // stock and append compensating PURCHASE_RETURN_CANCELLED rows. DRAFT
      // cancels had no stock effect, so there is nothing to restore.
      const demoTxns: TransactionLog[] = [];
      let cancelLineIdx = 0;
      (ret.items || []).forEach((item: any) => {
        const restoreQty = Math.abs(Number(item.quantity)) || 0;
        const { stock, before } = findOrCreateDemoStock(inventoryStock, setInventoryStock, item.productId, ret.branchId);
        stock.quantityOnHand = before + restoreQty;
        stock.lastUpdated = new Date().toISOString();
        demoTxns.push(demoPurchaseReturnCancelTxn(cancelLineIdx++, {
          productId: item.productId, productSku: item.sku, productName: item.productName,
          branchId: ret.branchId, quantityBefore: before, quantityChanged: restoreQty,
          unitCost: resolveLedgerUnitCost(products, item), referenceDocId: ret.returnNumber,
          timestampAD: prCancelAD, timestampBS: prCancelBS,
        }));
      });
      if (demoTxns.length > 0) setTransactionLogs([...demoTxns, ...transactionLogs]);
    }

    logAuditEvent(req, 'CANCEL_PURCHASE_RETURN', 'PROCUREMENT', `Cancelled ${ret.status === 'DRAFT' ? 'draft ' : ''}Purchase Return #${ret.returnNumber}${reason ? ` — ${reason}` : ''}`);
    res.json({ ...ret, status: 'CANCELLED' });
  } catch (err: any) {
    console.error('Error cancelling purchase return:', err);
    res.status(400).json({ message: err.message || 'Failed to cancel purchase return.' });
  }
}

/**
 * Forwarded from procurement.routes.ts (post_purchaseReturnApprove).
 *
 * Approves a DRAFT purchase return (above-threshold gating): re-validates the
 * over-return guard, then flips DRAFT → POSTED and applies the full posting
 * effects (stock deduction, ledger rows, serial flips) in one transaction.
 */
export async function post_purchaseReturnApprove(req: any, res: Response): Promise<any> {
  try {
    const { id } = req.params;
    let ret: any = purchaseReturns.find((r) => r.id === id || r.returnNumber === id);
    if (!ret && getPgConnected()) {
      const r = await pgPool.query(PR_FIND_ONE_SQL, [id]);
      ret = r.rows[0];
      if (ret && typeof ret.items === 'string') ret.items = JSON.parse(ret.items);
    }
    if (!ret) return res.status(404).json({ message: 'Purchase return not found.' });
    if (ret.status !== 'DRAFT') return res.status(400).json({ message: `Only DRAFT returns can be approved (current status: ${ret.status}).` });

    const items = ret.items || [];
    if (items.length === 0) return res.status(400).json({ message: 'Draft return has no item lines.' });

    // Re-validate the over-return guard against the ORIGINAL invoice at
    // approval time (other returns may have posted since the draft was made).
    let invoiceRow: any;
    if (getPgConnected()) {
      const r = await pgPool.query(PR_LOCK_INVOICE_SQL, [ret.originalInvoiceId]);
      invoiceRow = r.rows[0];
      if (invoiceRow && typeof invoiceRow.items === 'string') invoiceRow.items = JSON.parse(invoiceRow.items);
    } else {
      invoiceRow = purchaseInvoices.find((i) => i.id === ret.originalInvoiceId);
    }
    if (!invoiceRow) return res.status(400).json({ message: 'The original purchase invoice no longer exists; the draft return cannot be approved.' });

    if (getPgConnected()) {
      const perProductReturned = new Map<string, number>();
      for (const item of items) {
        const r = await pgPool.query(PR_RETURNED_QTY_SQL, [ret.originalInvoiceId, item.productId]);
        perProductReturned.set(item.productId, Number(r.rows[0]?.returned_qty || 0));
      }
      const violation = prValidateAgainstInvoice(invoiceRow.items || [], items, perProductReturned);
      if (violation) return res.status(400).json({ message: violation });

      // The stored serials were validated at creation; approving later still
      // needs the shape check, and the guarded flip inside the transaction
      // refuses any unit that moved in the meantime.
      const serialViolation = validateReturnSerialCounts(items, isSerialTrackedProduct);
      if (serialViolation) return res.status(400).json({ message: serialViolation });

      await withTransaction(async (client) => {
        const posted = await client.query(PR_POST_DRAFT_SQL, [ret.id]);
        if (posted.rowCount !== 1) throw new Error('Return was already approved or cancelled by another user.');
        await applyPurchaseReturnEffects(client, ret, items, ret.branchId);
      });
    }

    logAuditEvent(req, 'APPROVE_PURCHASE_RETURN', 'PROCUREMENT', `Approved Purchase Return #${ret.returnNumber} (draft → posted)`);
    res.json({ ...ret, status: 'POSTED' });
  } catch (err: any) {
    console.error('Error approving purchase return:', err);
    res.status(400).json({ message: err.message || 'Failed to approve purchase return.' });
  }
}

