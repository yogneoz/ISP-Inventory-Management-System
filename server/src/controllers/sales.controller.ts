/**
 * Sales controller — HTTP orchestration for the sales domain (sales invoices
 * and sales returns). Routes forward here; every handler returns a promise
 * whose rejection is forwarded to the central error middleware by the route
 * forwarder. SQL lives in ../models/sales.repo.ts.
 */
import type { Request, Response } from 'express';
import {
  getPgConnected, pgPool, issueNextDocNumber, inventoryStock, logAuditEvent,
  withTransaction, branches, products, suppliers, setInventoryStock, withAppended,
  getUserFromReq, purchaseReturns, customerMasterRecords, findBsDayRecordForAdDate,
  customerPayments,
} from '../app';
import { salesInvoices, salesReturns } from '../state/runtimeState';
import { computeBillTotals } from '../utils/money';
import { resolveBsDateForLedger } from '../utils/bsDate';
import {
  buildSalesInvoiceListSql, SI_INSERT_SQL, siInsertParams, SI_FIND_SQL, SI_EXISTS_SQL,
  SI_DEDUCT_STOCK_SQL, SI_RESTORE_STOCK_SQL, SI_TXN_LOG_SQL, siTxnLogParams,
  buildSalesReturnListSql, SR_INSERT_SQL, srInsertParams, SR_EXISTS_SQL, SR_LOCK_INVOICE_SQL,
  SR_RETURNED_QTY_SQL, SR_RESTOCK_SQL, srRestockParams, SR_REDEDUCT_STOCK_SQL, SR_CANCEL_SQL,
  SR_TXN_LOG_SQL, srTxnLogParams, SR_SELECT_COLUMNS, SR_FIND_ONE_SQL,
  LEDGER_CUSTOMER_INVOICES_SQL, LEDGER_CUSTOMER_RETURNS_SQL,
  SR_SERIAL_FLIP_SQL, SR_DAMAGE_INSERT_SQL, srDamageInsertParams, SR_DAMAGE_CANCEL_SQL,
  SR_POST_DRAFT_SQL, SR_CANCEL_DRAFT_SQL,
  CP_INSERT_SQL, cpInsertParams, CP_LOCK_STATUS_SQL, CP_REVERSE_SQL,
  SI_RECORD_PAYMENT_SQL, SI_UNDO_PAYMENT_SQL, LEDGER_CUSTOMER_PAYMENTS_SQL,
} from '../models/sales.repo';
import { intFromEnv } from '../utils/envGuard';

/**
 * Approval threshold for returns: a return whose recomputed grand total
 * exceeds this many NPR is inserted as DRAFT (no stock/ledger effect) until
 * explicitly approved via POST /:id/post. Override with
 * RETURNS_APPROVAL_THRESHOLD_NPR; 0 disables the gating.
 */
const RETURNS_APPROVAL_THRESHOLD_NPR = intFromEnv('RETURNS_APPROVAL_THRESHOLD_NPR', 200000, { min: 0 });

/** Extracts device serials from a return item (accepts strings or pairs). */
function returnItemSerials(item: any): string[] {
  return (item.deviceSerials || [])
    .map((s: any) => (typeof s === 'string' ? s : s?.deviceSerial))
    .filter((s: any) => typeof s === 'string' && s.trim())
    .map((s: string) => s.trim());
}

/**
 * Serial-tracked products must return with exactly one serial per unit
 * (plan Milestone B §7). Validated before the return row is inserted.
 */
function validateReturnSerials(items: any[]): string | null {
  for (const item of items) {
    const product = products.find((p) => p.id === item.productId);
    if (!product?.requiresSerialTracking) continue;
    const qty = Math.abs(Number(item.quantity)) || 0;
    const serials = returnItemSerials(item);
    if (serials.length !== qty) {
      return `${item.productName || item.productId} is serial-tracked: ${qty} serial(s) required, ${serials.length} provided.`;
    }
  }
  return null;
}

/**
 * Applies a sales return's posting effects inside an open transaction:
 * restock (when restockable) OR damage-register rows (when not), SALES_RETURN
 * ledger rows, and serial_log flips back to IN_STOCK with a history entry.
 */
async function applySalesReturnEffects(client: any, ret: any, items: any[], branchId: string, createdBy?: string): Promise<void> {
  for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
    const item = items[itemIdx];
    if (ret.restockable !== false) {
      await client.query(SR_RESTOCK_SQL, srRestockParams(branchId, item));
    } else {
      // Non-restockable: route the units into the damage register (plan extras
      // — returned-but-damaged units never pollute sellable stock).
      await client.query(
        SR_DAMAGE_INSERT_SQL,
        srDamageInsertParams(ret, item, branchId, `${ret.returnNumber}-SR-${itemIdx}`, createdBy)
      );
    }
    await client.query(SR_TXN_LOG_SQL, srTxnLogParams(ret, item, branchId, itemIdx));
    const serials = returnItemSerials(item);
    if (serials.length > 0) {
      await client.query(SR_SERIAL_FLIP_SQL, [
        serials,
        'IN_STOCK',
        JSON.stringify([{
          status: 'IN_STOCK',
          sourceType: 'SALES_RETURN',
          sourceId: ret.id,
          dateAD: String(ret.returnDateAD || '').split('T')[0],
          notes: `Returned by customer via ${ret.returnNumber}`,
        }]),
      ]);
    }
  }
}

/** Over-return validation shared by post_salesReturns: returnable = sold − posted-returned. */
function srValidateAgainstInvoice(invoiceItems: any[], returnItems: any[], alreadyReturned: Map<string, number>): string | null {
  for (const item of returnItems) {
    const sold = invoiceItems.find((i) => i.productId === item.productId);
    if (!sold) return `Product not present in the original invoice: ${item.productName || item.productId}.`;
    const soldQty = Math.abs(Number(sold.quantity)) || 0;
    const returned = alreadyReturned.get(item.productId) || 0;
    const requesting = Math.abs(Number(item.quantity)) || 0;
    if (requesting > soldQty - returned) {
      return `Over-return for ${item.productName || item.productId}: sold ${soldQty}, already returned ${returned}, requested ${requesting}.`;
    }
  }
  return null;
}

/** Forwarded from sales.routes.ts (get_salesInvoices). */
export async function get_salesInvoices(req: any, res: Response): Promise<any> {
  const { branchId } = req.query;
  if (getPgConnected()) {
    try {
      const { sql, params } = buildSalesInvoiceListSql(branchId);
      const r = await pgPool.query(sql, params as any[]);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching sales invoices from DB:', err);
    }
  }
  const list = branchId && branchId !== 'ALL'
    ? salesInvoices.filter((i) => i.branchId === branchId)
    : salesInvoices;
  res.json(list);
}

/** Forwarded from sales.routes.ts (post_salesInvoices). */
export async function post_salesInvoices(req: any, res: Response): Promise<any> {
  try {
    const items = req.body.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'A sales invoice requires at least one item line.' });
    }
    // C1: totals recomputed from line primitives; client aggregates ignored.
    const totals = computeBillTotals(items);
    const targetBranchId = req.body.branchId || branches[0]?.id || 'WH001';
    const invDate = req.body.invoiceDateAD || req.body.invoiceDateAd || new Date().toISOString().split('T')[0];
    const invoiceNumber = req.body.invoiceNumber || (await issueNextDocNumber(targetBranchId, 'INV', invDate));

    const newInv: any = {
      id: req.body.id || `si-${Date.now()}`,
      invoiceNumber,
      customerId: req.body.customerId || null,
      customerName: req.body.customerName || 'Walk-in Customer',
      branchId: targetBranchId,
      invoiceDateAD: invDate,
      invoiceDateBS: req.body.invoiceDateBS || req.body.invoiceDateBs || await resolveBsDateForLedger(invDate),
      dueDateAD: req.body.dueDateAD || req.body.dueDateAd || null,
      dueDateBS: req.body.dueDateBS || req.body.dueDateBs || null,
      taxableAmount: totals.taxableAmount,
      vatAmount: totals.vatAmount,
      nonTaxableAmount: totals.nonTaxableAmount,
      grandTotal: totals.grandTotal,
      paymentStatus: req.body.paymentStatus || 'UNPAID',
      paymentMethod: req.body.paymentMethod || 'CREDIT',
      amountPaid: Number(req.body.amountPaid) || 0,
      notes: req.body.notes || '',
      items,
    };

    let alreadyExists = salesInvoices.some((i) => i.id === newInv.id || i.invoiceNumber === invoiceNumber);
    if (getPgConnected() && !alreadyExists) {
      const e = await pgPool.query(SI_EXISTS_SQL, [newInv.id, invoiceNumber]);
      alreadyExists = e.rowCount === 1;
    }
    if (alreadyExists) return res.status(409).json({ message: `Sales invoice ${invoiceNumber} already exists.` });

    if (getPgConnected()) {
      // All-or-nothing: invoice insert + per-item guarded stock deduction + ledger.
      await withTransaction(async (client) => {
        await client.query(SI_INSERT_SQL, siInsertParams(newInv, JSON.stringify(items)));
        for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
          const item = items[itemIdx];
          const qty = Math.abs(Number(item.quantity)) || 0;
          const deducted = await client.query(SI_DEDUCT_STOCK_SQL, [qty, item.productId, targetBranchId]);
          if (deducted.rowCount !== 1) {
            throw new Error(`Insufficient stock to sell ${qty} × ${item.productName || item.productId} at branch ${targetBranchId}.`);
          }
          await client.query(SI_TXN_LOG_SQL, siTxnLogParams(newInv, item, targetBranchId, itemIdx));
        }
      });
    }

    logAuditEvent(req, 'CREATE_SALES_INVOICE', 'SALES', `Created Sales Invoice #${newInv.invoiceNumber} for customer ${newInv.customerName}`);
    res.status(201).json(newInv);
  } catch (err: any) {
    console.error('Error creating sales invoice:', err);
    res.status(400).json({ message: err.message || 'Failed to create sales invoice.' });
  }
}

/** Forwarded from sales.routes.ts (get_salesReturns). */
export async function get_salesReturns(req: any, res: Response): Promise<any> {
  const { branchId } = req.query;
  if (getPgConnected()) {
    try {
      const { sql, params } = buildSalesReturnListSql(branchId);
      const r = await pgPool.query(sql, params as any[]);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching sales returns from DB:', err);
    }
  }
  const list = branchId && branchId !== 'ALL'
    ? salesReturns.filter((r) => r.branchId === branchId)
    : salesReturns;
  res.json(list);
}

/** Forwarded from sales.routes.ts (post_salesReturns). */
export async function post_salesReturns(req: any, res: Response): Promise<any> {
  try {
    const items = req.body.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'A sales return requires at least one item line.' });
    }
    const originalRef = req.body.originalInvoiceId || req.body.invoiceId || req.body.invoiceNumber;
    if (!originalRef) {
      return res.status(400).json({ message: 'A sales return must reference the original sales invoice.' });
    }

    // C1: totals are recomputed from line primitives; client aggregates ignored.
    const totals = computeBillTotals(items);
    const targetBranchId = req.body.branchId || branches[0]?.id || 'WH001';
    const retDate = req.body.returnDateAD || req.body.returnDateAd || new Date().toISOString().split('T')[0];
    const returnNumber = req.body.returnNumber || (await issueNextDocNumber(targetBranchId, 'CN', retDate));

    let invoiceRow: any = salesInvoices.find((i) => i.id === originalRef || i.invoiceNumber === originalRef);
    if (!invoiceRow && getPgConnected()) {
      const r = await pgPool.query(SR_LOCK_INVOICE_SQL, [originalRef]);
      invoiceRow = r.rows[0];
      if (invoiceRow && typeof invoiceRow.items === 'string') invoiceRow.items = JSON.parse(invoiceRow.items);
    }
    if (!invoiceRow) {
      return res.status(400).json({ message: 'The original sales invoice was not found.' });
    }
    if (getPgConnected() && !invoiceRow.items) {
      const r = await pgPool.query(SR_LOCK_INVOICE_SQL, [invoiceRow.id]);
      invoiceRow = { ...invoiceRow, ...r.rows[0] };
      if (invoiceRow.items && typeof invoiceRow.items === 'string') invoiceRow.items = JSON.parse(invoiceRow.items);
    }

    const newRet: any = {
      id: req.body.id || `sr-${Date.now()}`,
      returnNumber,
      originalInvoiceId: invoiceRow.id,
      originalInvoiceNumber: invoiceRow.invoiceNumber,
      customerId: req.body.customerId || null,
      customerName: req.body.customerName || 'Walk-in Customer',
      branchId: targetBranchId,
      returnDateAD: retDate,
      returnDateBS: req.body.returnDateBS || req.body.returnDateBs || await resolveBsDateForLedger(retDate),
      reason: req.body.reason || 'DEFECTIVE',
      restockable: req.body.restockable !== false,
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

    const serialViolation = validateReturnSerials(items);
    if (serialViolation) return res.status(400).json({ message: serialViolation });

    if (getPgConnected()) {
      // Over-return guard: per (invoice, product) already-returned quantity,
      // computed inside the same transaction that inserts the return.
      const perProductReturned = new Map<string, number>();
      for (const item of items) {
        const r = await pgPool.query(SR_RETURNED_QTY_SQL, [invoiceRow.id, item.productId]);
        perProductReturned.set(item.productId, Number(r.rows[0]?.returned_qty || 0));
      }
      const violation = srValidateAgainstInvoice(invoiceRow.items || [], items, perProductReturned);
      if (violation) return res.status(400).json({ message: violation });

      let dup = salesReturns.some((r) => r.id === newRet.id || r.returnNumber === returnNumber);
      if (!dup) {
        const e = await pgPool.query(SR_EXISTS_SQL, [newRet.id, returnNumber]);
        dup = e.rowCount === 1;
      }
      if (dup) return res.status(409).json({ message: `Sales return ${returnNumber} already exists.` });

      // All-or-nothing: return insert + (when POSTED) restock/damage routing,
      // ledger rows, and serial flips. DRAFT inserts alone.
      await withTransaction(async (client) => {
        await client.query(SR_INSERT_SQL, srInsertParams(newRet, JSON.stringify(items)));
        if (newRet.status === 'POSTED') {
          await applySalesReturnEffects(client, newRet, items, targetBranchId, getUserFromReq(req)?.email);
        }
      });
    }

    if (newRet.status === 'DRAFT') {
      logAuditEvent(req, 'CREATE_SALES_RETURN_DRAFT', 'SALES', `Sales Return #${newRet.returnNumber} (Rs. ${newRet.grandTotal}) held for approval (threshold Rs. ${RETURNS_APPROVAL_THRESHOLD_NPR})`);
      return res.status(201).json({ ...newRet, pendingApproval: true, approvalThreshold: RETURNS_APPROVAL_THRESHOLD_NPR });
    }

    logAuditEvent(req, 'CREATE_SALES_RETURN', 'SALES', `Created Sales Return #${newRet.returnNumber} against invoice ${newRet.originalInvoiceNumber} (customer ${newRet.customerName}, ${newRet.restockable ? 'restocked' : 'routed to damage register'})`);
    res.status(201).json(newRet);
  } catch (err: any) {
    console.error('Error creating sales return:', err);
    res.status(400).json({ message: err.message || 'Failed to create sales return.' });
  }
}

/** Forwarded from sales.routes.ts (post_salesReturnCancel). */
export async function post_salesReturnCancel(req: any, res: Response): Promise<any> {
  try {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();
    let ret: any = salesReturns.find((r) => r.id === id || r.returnNumber === id);
    if (!ret && getPgConnected()) {
      const r = await pgPool.query(SR_FIND_ONE_SQL, [id]);
      ret = r.rows[0];
      if (ret && typeof ret.items === 'string') ret.items = JSON.parse(ret.items);
    }
    if (!ret) return res.status(404).json({ message: 'Sales return not found.' });
    if (ret.status !== 'POSTED' && ret.status !== 'DRAFT') {
      return res.status(400).json({ message: `Only POSTED or DRAFT returns can be cancelled (current status: ${ret.status}).` });
    }

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        // Guarded cancel: flips status only when still POSTED/DRAFT (race-safe).
        // POSTED returns also reverse their stock/ledger/damage effects; DRAFT
        // returns never posted, so there is nothing to reverse.
        const cancelled = ret.status === 'DRAFT'
          ? await client.query(SR_CANCEL_DRAFT_SQL, [ret.id])
          : await client.query(SR_CANCEL_SQL, [ret.id]);
        if (cancelled.rowCount !== 1) throw new Error('Return was already cancelled by another user.');
        if (ret.status === 'POSTED') {
          if (ret.restockable !== false) {
            for (const item of ret.items || []) {
              await client.query(SR_REDEDUCT_STOCK_SQL, [Math.abs(Number(item.quantity)) || 0, item.productId, ret.branchId]);
            }
          } else {
            // Cancel the damage-register rows this return created.
            await client.query(SR_DAMAGE_CANCEL_SQL, [`${ret.returnNumber}-SR-%`]);
          }
          for (const item of ret.items || []) {
            const serials = returnItemSerials(item);
            if (serials.length > 0) {
              await client.query(SR_SERIAL_FLIP_SQL, [
                serials,
                'SOLD',
                JSON.stringify([{
                  status: 'SOLD',
                  sourceType: 'SALES_RETURN_CANCELLED',
                  sourceId: ret.id,
                  dateAD: new Date().toISOString().split('T')[0],
                  notes: `Sales return ${ret.returnNumber} cancelled`,
                }]),
              ]);
            }
          }
        }
      });
    }

    logAuditEvent(req, 'CANCEL_SALES_RETURN', 'SALES', `Cancelled ${ret.status === 'DRAFT' ? 'draft ' : ''}Sales Return #${ret.returnNumber}${reason ? ` — ${reason}` : ''}`);
    res.json({ ...ret, status: 'CANCELLED' });
  } catch (err: any) {
    console.error('Error cancelling sales return:', err);
    res.status(400).json({ message: err.message || 'Failed to cancel sales return.' });
  }
}

/**
 * Forwarded from sales.routes.ts (post_salesReturnApprove).
 *
 * Approves a DRAFT sales return (above-threshold gating): re-validates the
 * over-return guard, then flips DRAFT → POSTED and applies the full posting
 * effects (restock or damage routing, ledger rows, serial flips).
 */
export async function post_salesReturnApprove(req: any, res: Response): Promise<any> {
  try {
    const { id } = req.params;
    let ret: any = salesReturns.find((r) => r.id === id || r.returnNumber === id);
    if (!ret && getPgConnected()) {
      const r = await pgPool.query(SR_FIND_ONE_SQL, [id]);
      ret = r.rows[0];
      if (ret && typeof ret.items === 'string') ret.items = JSON.parse(ret.items);
    }
    if (!ret) return res.status(404).json({ message: 'Sales return not found.' });
    if (ret.status !== 'DRAFT') return res.status(400).json({ message: `Only DRAFT returns can be approved (current status: ${ret.status}).` });

    const items = ret.items || [];
    if (items.length === 0) return res.status(400).json({ message: 'Draft return has no item lines.' });

    // Re-validate the over-return guard against the ORIGINAL invoice at
    // approval time (other returns may have posted since the draft was made).
    let invoiceRow: any = salesInvoices.find((i) => i.id === ret.originalInvoiceId);
    if (!invoiceRow && getPgConnected()) {
      const r = await pgPool.query(SR_LOCK_INVOICE_SQL, [ret.originalInvoiceId]);
      invoiceRow = r.rows[0];
      if (invoiceRow && typeof invoiceRow.items === 'string') invoiceRow.items = JSON.parse(invoiceRow.items);
    }
    if (!invoiceRow) return res.status(400).json({ message: 'The original sales invoice no longer exists; the draft return cannot be approved.' });

    if (getPgConnected()) {
      const perProductReturned = new Map<string, number>();
      for (const item of items) {
        const r = await pgPool.query(SR_RETURNED_QTY_SQL, [ret.originalInvoiceId, item.productId]);
        perProductReturned.set(item.productId, Number(r.rows[0]?.returned_qty || 0));
      }
      const violation = srValidateAgainstInvoice(invoiceRow.items || [], items, perProductReturned);
      if (violation) return res.status(400).json({ message: violation });

      const serialViolation = validateReturnSerials(items);
      if (serialViolation) return res.status(400).json({ message: serialViolation });

      await withTransaction(async (client) => {
        const posted = await client.query(SR_POST_DRAFT_SQL, [ret.id]);
        if (posted.rowCount !== 1) throw new Error('Return was already approved or cancelled by another user.');
        await applySalesReturnEffects(client, ret, items, ret.branchId, getUserFromReq(req)?.email);
      });
    }

    logAuditEvent(req, 'APPROVE_SALES_RETURN', 'SALES', `Approved Sales Return #${ret.returnNumber} (draft → posted)`);
    res.json({ ...ret, status: 'POSTED' });
  } catch (err: any) {
    console.error('Error approving sales return:', err);
    res.status(400).json({ message: err.message || 'Failed to approve sales return.' });
  }
}

// ---------------------------------------------------------------------------
// Customer Receivables Ledger — mirrors the vendor ledger for the sales side.
// ---------------------------------------------------------------------------

/**
 * Forwarded from sales.routes.ts (get_customerLedger).
 *
 * Ledger lines (customer's perspective: we hold THEIR receivable):
 *   - INVOICE  debit  = sales invoice grand total (customer owes us)
 *   - PAYMENT  credit = dated receipt from the customer_payments sub-ledger
 *     (POSTED rows only; the invoice's amount_paid is kept in sync by the
 *     payment endpoints so the register still shows settlement state)
 *   - RETURN   credit = posted sales return (credit note) grand total
 *
 * Closing balance = opening + debits − credits = what the customer still owes.
 * Opening balance uses the period-net method (no customer opening-balance
 * register exists, unlike vendor_opening_balances).
 */
export async function get_customerLedger(req: any, res: Response): Promise<any> {
  try {
    const { customerId } = req.params;
    const { fromAd, toAd, branchId } = req.query;
    const customer = customerMasterRecords.find((c: any) => c.id === customerId || c.customerId === customerId);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found.' });
    }

    const nameMatcher = (name: string) =>
      String(name || '').toLowerCase() === customer.customerName.toLowerCase() ||
      String(name || '').toLowerCase().includes(customer.customerName.toLowerCase()) ||
      customer.customerName.toLowerCase().includes(String(name || '').toLowerCase());

    const byCustomerId = (row: any) => row.customerId && row.customerId === customer.id;
    const byLegacyName = (row: any) => !row.customerId && nameMatcher(row.customerName);

    let invoices: any[] = salesInvoices.filter((i: any) => byCustomerId(i) || byLegacyName(i));
    let returns: any[] = salesReturns.filter((r: any) => byCustomerId(r) || byLegacyName(r));
    let payments: any[] = customerPayments.filter((p: any) =>
      (p.customerId && p.customerId === customer.id) || byLegacyName(p)
    );

    if (getPgConnected()) {
      try {
        const invRes = await pgPool.query(LEDGER_CUSTOMER_INVOICES_SQL, [customer.id, customer.customerName, `%${customer.customerName}%`]);
        invoices = invRes.rows;
        const retRes = await pgPool.query(LEDGER_CUSTOMER_RETURNS_SQL, [customer.id, customer.customerName, `%${customer.customerName}%`]);
        returns = retRes.rows;
        // Real dated receipts from the customer-payments sub-ledger replace
        // the earlier synthetic amount_paid mirror lines.
        const payRes = await pgPool.query(LEDGER_CUSTOMER_PAYMENTS_SQL, [customer.id, customer.customerName, `%${customer.customerName}%`]);
        payments = payRes.rows;
      } catch (err: any) {
        console.error('Customer ledger DB query failed, using cache:', err?.message || err);
      }
    }

    // Apply branch + date scoping (same semantics as the vendor ledger).
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
      .filter((inv: any) => inScope(inv.branchId, inv.invoiceDateAD))
      .map((inv: any) => ({
        id: `inv-${inv.id}`,
        documentNumber: inv.invoiceNumber,
        dateAD: String(inv.invoiceDateAD || '').split('T')[0],
        dateBS: inv.invoiceDateBS || '',
        amount: Number(inv.grandTotal) || 0,
        type: 'INVOICE' as const,
        notes: inv.notes || `Sales invoice to ${customer.customerName}`,
        paymentMethod: undefined,
        debit: Number(inv.grandTotal) || 0,
        credit: 0,
      }));

    // Dated receipt lines from the customer-payments sub-ledger (POSTED only).
    const paymentLines = payments
      .filter((p: any) => p.status === 'POSTED' || p.status === undefined)
      .filter((p: any) => inScope(p.branchId, p.paymentDateAD))
      .map((p: any) => ({
        id: `pay-${p.id}`,
        documentNumber: p.paymentNumber,
        dateAD: String(p.paymentDateAD || '').split('T')[0],
        dateBS: p.paymentDateBS || '',
        amount: Number(p.amount) || 0,
        type: 'PAYMENT' as const,
        notes: p.notes || `Receipt via ${p.paymentMethod}${p.chequeNumber ? ` (Chq ${p.chequeNumber})` : ''}`,        paymentMethod: p.paymentMethod,
        debit: 0,
        credit: Number(p.amount) || 0,
      }));

    // Posted sales returns (credit notes) reduce the receivable.
    const returnLines = returns
      .filter((r: any) => r.status === 'POSTED' || r.status === undefined)
      .filter((r: any) => inScope(r.branchId, r.returnDateAD))
      .map((r: any) => ({
        id: `ret-${r.id}`,
        documentNumber: r.returnNumber,
        dateAD: String(r.returnDateAD || '').split('T')[0],
        dateBS: r.returnDateBS || '',
        amount: Number(r.grandTotal) || 0,
        type: 'RETURN' as const,
        notes: r.notes || `Sales return${r.originalInvoiceNumber ? ` against ${r.originalInvoiceNumber}` : ''}`,
        paymentMethod: undefined,
        debit: 0,
        credit: Number(r.grandTotal) || 0,
      }));

    const allLines = [...invoiceLines, ...paymentLines, ...returnLines].sort((a: any, b: any) =>
      a.dateAD === b.dateAD ? a.documentNumber.localeCompare(b.documentNumber) : a.dateAD.localeCompare(b.dateAD)
    );

    // Period-net opening balance (no customer opening-balance register).
    let openingBalance = 0;
    let periodLines = allLines;
    if (from) {
      openingBalance = allLines
        .filter((line: any) => line.dateAD < from)
        .reduce((sum: number, line: any) => sum + line.debit - line.credit, 0);
      periodLines = allLines.filter((line: any) => line.dateAD >= from);
    }

    let running = openingBalance;
    const ledger = periodLines.map((line: any) => {
      running += line.debit - line.credit;
      return { ...line, balance: running };
    });

    const periodDebit = ledger.reduce((sum: number, line: any) => sum + line.debit, 0);
    const periodCredit = ledger.reduce((sum: number, line: any) => sum + line.credit, 0);

    res.json({
      customer: { id: customer.id, customerId: customer.customerId, name: customer.customerName },
      openingBalance,
      openingSource: 'PERIOD_NET',
      fiscalYearStartAD: null,
      totalDebit: periodDebit,
      totalCredit: periodCredit,
      closingBalance: openingBalance + periodDebit - periodCredit,
      ledger,
    });
  } catch (err: any) {
    console.error('Error building customer ledger:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
}

// ---------------------------------------------------------------------------
// Customer Payments Sub-ledger — record / reverse receipts (CR-/BR-…)
// ---------------------------------------------------------------------------

/** Forwarded from sales.routes.ts (post_customerPayments). */
export async function post_customerPayments(req: any, res: Response): Promise<any> {
  try {
    const body = req.body || {};
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'Payment amount must be greater than 0.' });
    }

    // Resolve the invoice first so customer + branch can be inherited from it.
    let linkedInvoice: any = body.invoiceId
      ? salesInvoices.find((inv) => inv.id === body.invoiceId || inv.invoiceNumber === body.invoiceId)
      : undefined;
    if (!linkedInvoice && body.invoiceId && getPgConnected()) {
      const invRes = await pgPool.query(SI_FIND_SQL, [body.invoiceId]);
      linkedInvoice = invRes.rows[0];
    }

    let customerId: string | null = body.customerId || linkedInvoice?.customerId || null;
    let customerName = body.customerName || linkedInvoice?.customerName || '';
    if (!customerId && customerName) {
      const matched = customerMasterRecords.find((c: any) =>
        c.customerName.toLowerCase() === customerName.toLowerCase()
      ) || customerMasterRecords.find((c: any) =>
        customerName.toLowerCase().includes(c.customerName.toLowerCase())
      );
      customerId = matched?.id || null;
    }
    if (!customerName && customerId) {
      const cust = customerMasterRecords.find((c: any) => c.id === customerId);
      customerName = cust?.customerName || '';
    }
    if (!customerName) {
      return res.status(400).json({ message: 'Customer is required to record a customer payment.' });
    }

    const branchId = body.branchId || linkedInvoice?.branchId || getUserFromReq(req)?.branchId || branches[0]?.id || 'WH001';
    const paymentDateAD = String(body.paymentDateAD || new Date().toISOString().split('T')[0]).split('T')[0];
    let paymentDateBS = body.paymentDateBS || '';
    try {
      const bsDay = await findBsDayRecordForAdDate(paymentDateAD);
      if (bsDay.found && bsDay.record?.bsDate) paymentDateBS = bsDay.record.bsDate;
    } catch (_e) {}
    if (!paymentDateBS) paymentDateBS = await resolveBsDateForLedger(paymentDateAD);

    const paymentMethod = String(body.paymentMethod || 'CASH').toUpperCase();
    // CR = cash receipt, BR = bank receipt (transfer/cheque/card/online) —
    // mirrors the vendor side's CP/BP split.
    const payDocType = paymentMethod === 'CASH' ? 'CR' : 'BR';
    const paymentNumber = body.paymentNumber || (await issueNextDocNumber(branchId, payDocType, paymentDateAD));

    const newPayment = {
      id: `cp-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
      paymentNumber,
      customerId,
      customerName,
      branchId,
      invoiceId: linkedInvoice?.id || body.invoiceId || null,
      invoiceNumber: linkedInvoice?.invoiceNumber || body.invoiceNumber || null,
      paymentDateAD,
      paymentDateBS,
      amount,
      paymentMethod,
      bankName: body.bankName || null,
      bankBranch: body.bankBranch || null,
      accountNumber: body.accountNumber || null,
      chequeNumber: body.chequeNumber || null,
      chequeDateAD: body.chequeDateAD || null,
      chequeDateBS: body.chequeDateBS || null,
      transactionReference: body.transactionReference || null,
      notes: body.notes || null,
      status: 'POSTED',
      createdBy: getUserFromReq(req)?.email || 'system',
    };

    if (getPgConnected()) {
      // Payment row + invoice balance adjustment commit atomically.
      await withTransaction(async (client) => {
        await client.query(CP_INSERT_SQL, cpInsertParams(newPayment));
        if (newPayment.invoiceId) {
          await client.query(SI_RECORD_PAYMENT_SQL, [amount, newPayment.invoiceId]);
        }
      });
    }

    logAuditEvent(req, 'RECORD_CUSTOMER_PAYMENT', 'SALES', `Recorded customer payment #${paymentNumber} of NPR ${amount.toLocaleString()} from ${customerName} via ${paymentMethod}`, branchId);
    res.status(201).json(newPayment);
  } catch (err: any) {
    console.error('Error creating customer payment:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
}

/** Forwarded from sales.routes.ts (post_customerPaymentReverse). */
export async function post_customerPaymentReverse(req: any, res: Response): Promise<any> {
  try {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ message: 'A reversal reason is required.' });
    const payment = customerPayments.find((p) => p.id === id);
    if (!payment) return res.status(404).json({ message: 'Customer payment not found.' });
    if (payment.status !== 'POSTED') {
      return res.status(409).json({ message: `Payment #${payment.paymentNumber} is already ${String(payment.status).toLowerCase()}.` });
    }

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        const current = await client.query(CP_LOCK_STATUS_SQL, [id]);
        if (!current.rows[0]) {
          const notFound: any = new Error('Customer payment not found.');
          notFound.statusCode = 404;
          throw notFound;
        }
        if (current.rows[0].status !== 'POSTED') {
          const conflict: any = new Error(`Payment #${payment.paymentNumber} is already ${String(current.rows[0].status).toLowerCase()}.`);
          conflict.statusCode = 409;
          throw conflict;
        }
        await client.query(CP_REVERSE_SQL, [reason, getUserFromReq(req)?.email || 'system', id]);
        if (payment.invoiceId) {
          await client.query(SI_UNDO_PAYMENT_SQL, [Number(payment.amount), payment.invoiceId]);
        }
      });
    }

    logAuditEvent(req, 'REVERSE_CUSTOMER_PAYMENT', 'SALES', `Reversed customer payment #${payment.paymentNumber} — ${reason}`);
    res.json({ ...payment, status: 'REVERSED', reversalReason: reason });
  } catch (err: any) {
    console.error('Error reversing customer payment:', err);
    res.status(err.statusCode || 500).json({ message: err.message || 'Failed to reverse customer payment.' });
  }
}
