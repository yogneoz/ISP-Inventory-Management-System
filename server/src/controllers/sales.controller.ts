/**
 * Sales controller — HTTP orchestration for the sales domain (sales invoices
 * and sales returns). Routes forward here; every handler returns a promise
 * whose rejection is forwarded to the central error middleware by the route
 * forwarder. SQL lives in ../models/sales.repo.ts.
 */
import { businessDateAD } from '../../../shared/businessDate';
import type { Request, Response } from 'express';
import {
  getPgConnected, pgPool, issueNextDocNumber, inventoryStock, logAuditEvent,
  withTransaction, branches, products, setInventoryStock, withPrepended,
  transactionLogs, setTransactionLogs,
  getUserFromReq, customerMasterRecords,
  customerPayments, companyProfile,
} from '../app';
import { resolveDocumentNumber, retireDocumentNumber } from '../utils/docNumber';
import { decodeKeysetCursor, encodeKeysetCursor, cursorTimestamp, keysetEnvelope, keysetLimit, requireLargeTableScope } from '../utils/keysetCursor';
import { salesInvoices, salesReturns, setSalesInvoices, setSalesReturns } from '../state/runtimeState';
import { computeBillTotals, defaultVatRateFor, resolveLedgerUnitCost, roundMoney } from '../utils/money';
import { TransactionLog } from '../../../client/src/types';
import { demoSalesInvoiceTxn, demoSalesReturnTxn, demoSalesReturnCancelTxn, findOrCreateDemoStock } from '../models/txnLogRows';
import { bsDateOr400 } from '../utils/bsDate';
import {
  buildSalesInvoiceListSql, buildSalesInvoiceCountQuery, buildSalesInvoicePagedQuery,
  buildSalesInvoiceKeysetQuery,
  SI_INSERT_SQL, siInsertParams, SI_FIND_SQL, SI_EXISTS_SQL, ENSURE_SALES_INVOICE_PARTITION_SQL,
  SI_DEDUCT_STOCK_SQL, SI_RESTORE_STOCK_SQL, SI_TXN_LOG_SQL, siTxnLogParams,
  buildSalesReturnListSql, buildSalesReturnCountQuery, buildSalesReturnPagedQuery,
  buildSalesReturnKeysetQuery,
  SR_INSERT_SQL, srInsertParams, SR_EXISTS_SQL, SR_LOCK_INVOICE_SQL,
  SR_RETURNED_QTY_SQL, SR_RESTOCK_SQL, srRestockParams, SR_REDEDUCT_STOCK_SQL, SR_CANCEL_SQL,
  SR_TXN_LOG_SQL, srTxnLogParams, SR_FIND_ONE_SQL,
  SR_CANCEL_TXN_LOG_SQL, srCancelTxnLogParams,
  SR_SERIAL_FLIP_SQL, SR_DAMAGE_INSERT_SQL, srDamageInsertParams, SR_DAMAGE_CANCEL_SQL,
  SR_POST_DRAFT_SQL, SR_CANCEL_DRAFT_SQL,
  CP_INSERT_SQL, cpInsertParams, CP_LOCK_STATUS_SQL, CP_REVERSE_SQL, CP_FIND_BY_ID_SQL,
  CP_REFUND_SQL, CP_CHARGEBACK_SQL, CP_SETTLED_GROSS_SQL, CP_PROVIDER_TXN_EXISTS_SQL,
  CPA_INSERT_SQL, cpaInsertParams, CPA_LIST_POSTED_BY_PAYMENT_SQL, CPA_REVERSE_BY_PAYMENT_SQL,
  SI_RECORD_PAYMENT_SQL, SI_UNDO_PAYMENT_SQL, SI_LOCK_FOR_PAYMENT_SQL,
  SI_CLAIM_SERIAL_SQL, siClaimSerialParams,
  SI_FIND_ONE_SQL, SI_LOCK_FOR_CANCEL_SQL, SI_CANCEL_SQL,
  SI_BLOCKING_PAYMENTS_SQL, SI_BLOCKING_RETURNS_SQL,
  SI_CLAIMED_SERIALS_SQL, SI_RELEASE_SERIAL_SQL, siCancelTxnLogParams,
} from '../models/sales.repo';
import { CUSTOMER_FIND_BY_ID_OR_CODE_SQL, CUSTOMER_FIND_BY_NAME_SQL } from '../models/masterdata.repo';
import { planSerialGateEntries, resolveSerialGateInDb, serialGateKey } from '../services/serialGate.service';
import { findAreaById, findSalesAgentById } from './salesMasters.controller';
import {
  buildSellerCoverageCaptures,
  recordWarrantyCoverageMirror,
  supersedeCoverageBySource,
  supersedeCoverageBySourceMirror,
  supersedeSellerCoverageForSerials,
  retireCoverageForSerials,
  retireCoverageForSerialsMirror,
  writeSellerCoveragePlan,
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
import { intFromEnv } from '../utils/envGuard';
import { firstLineQuantityRefusal } from '../utils/lineQuantity';
import { ApiError } from '../errors/ApiError';
import { postSalesInvoiceLedger, reverseInvoiceJournal } from '../services/invoicePosting.service';
import { resolveInvoiceTerms } from '../services/billTerms.service';
import {
  postCustomerReceiptLedger,
  postWalletChargebackLedger,
  postWalletRefundLedger,
  reverseCustomerReceiptJournal,
} from '../services/paymentPosting.service';
import { buildPartyLedger, buildPartyLedgerPage } from '../services/partyLedger.service';
import {
  loadSalesIssueCosts,
  postSalesReturnJournal,
  reverseReturnJournal,
  type ReturnCogsEntry,
} from '../services/returnPosting.service';

/** Audit actor for document postings (email, falling back to the display name). */
function actorOf(req: any): string | null {
  const user = getUserFromReq(req);
  return user.email || user.name || null;
}

/**
 * Restores every invoice a receipt settled and marks the allocation rows
 * reversed. The legacy `invoice_id` fallback keeps pre-allocation receipts
 * correct until migration 0017 has run. Call inside the payment transaction.
 */
async function reversePaymentAllocations(
  client: any,
  payment: any,
  reason: string,
  actor: string
): Promise<void> {
  const reversed = await client.query(CPA_REVERSE_BY_PAYMENT_SQL, [payment.id, actor, reason]);
  if (reversed.rows.length > 0) {
    for (const row of reversed.rows) {
      await client.query(SI_UNDO_PAYMENT_SQL, [Number(row.amount), row.invoiceId]);
    }
    return;
  }
  if (payment.invoiceId) {
    await client.query(SI_UNDO_PAYMENT_SQL, [Number(payment.amount), payment.invoiceId]);
  }
}

/**
 * Approval threshold for returns: a return whose recomputed grand total
 * exceeds this many NPR is inserted as DRAFT (no stock/ledger effect) until
 * explicitly approved via POST /:id/post. Override with
 * RETURNS_APPROVAL_THRESHOLD_NPR; 0 disables the gating.
 */
const RETURNS_APPROVAL_THRESHOLD_NPR = intFromEnv('RETURNS_APPROVAL_THRESHOLD_NPR', 200000, { min: 0 });

/** The product rule both return flows share (quantity-only lines carry none). */
function isSerialTrackedProduct(productId?: string): boolean {
  return Boolean(products.find((p) => p.id === productId)?.requiresSerialTracking);
}

/**
 * Applies a sales return's posting effects inside an open transaction:
 * restock (when restockable) OR damage-register rows (when not), SALES_RETURN
 * ledger rows, and serial_log flips back to IN_STOCK with a history entry.
 */
async function applySalesReturnEffects(client: any, ret: any, items: any[], branchId: string, createdBy?: string): Promise<void> {
  // A restockable return puts value back into inventory at the exact cost the
  // original sale relieved. The invoice's own movement rows record that cost;
  // a line with no record is refused before anything is written, rather than
  // valued at the product's standard cost and silently drifting from COGS.
  const restockable = ret.restockable !== false;
  const issueCosts = restockable
    ? await loadSalesIssueCosts(
        client,
        String(ret.originalInvoiceNumber || ''),
        items.map((item) => String(item.productId || ''))
      )
    : new Map<string, number>();
  if (restockable) {
    for (const item of items) {
      const qty = Math.abs(Number(item.quantity)) || 0;
      if (qty > 0 && !issueCosts.has(String(item.productId))) {
        throw new ApiError(
          400,
          `Sales return ${ret.returnNumber}: the original sale records no issue cost for ${item.productName || item.productId}. ` +
            'The return cannot be valued — nothing was posted.'
        );
      }
    }
  }
  const cogs: ReturnCogsEntry[] = [];
  for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
    const item = items[itemIdx];
    const qty = Math.abs(Number(item.quantity)) || 0;
    const unitCost = Number(issueCosts.get(String(item.productId))) || 0;
    if (ret.restockable !== false) {
      const restocked = await client.query(SR_RESTOCK_SQL, srRestockParams(branchId, item, unitCost));
      // Real ledger balance: RETURNING gives the post-restock QOH, so the
      // SALES_RETURN row records the TRUE before/after instead of 0/changed.
      const after = Number(restocked.rows?.[0]?.quantity_on_hand);
      const stockBefore = Number.isFinite(after) ? after - qty : undefined;
      await client.query(SR_TXN_LOG_SQL, srTxnLogParams(ret, item, branchId, itemIdx, stockBefore, unitCost));
      if (qty > 0 && unitCost > 0) cogs.push({ productId: String(item.productId), quantity: qty, unitCost });
    } else {
      // Non-restockable: route the units into the damage register (plan extras
      // — returned-but-damaged units never pollute sellable stock). No QOH
      // ledger row is written: quantity_on_hand never moved, and the old
      // unconditional +qty SALES_RETURN row claimed a restock that did not
      // happen. The damage register (damaged-pool sub-ledger) carries these
      // units instead.
      await client.query(
        SR_DAMAGE_INSERT_SQL,
        srDamageInsertParams(ret, item, branchId, `${ret.returnNumber}-SR-${itemIdx}`, createdBy)
      );
    }
    const serials = returnLineSerials(item).map((entry) => entry.deviceSerial);
    // A returned unit is no longer covered by the promise the sale made. The
    // row is retired (not deleted) with the credit note that did it, so the
    // register can show it under Returned and the serial keeps its history.
    await retireCoverageForSerials(client, 'SELLER', serials, {
      reason: 'SALES_RETURN',
      ref: ret.returnNumber,
    });
    if (serials.length > 0) {
      const flipped = await client.query(SR_SERIAL_FLIP_SQL, [
        serials.map((serial) => serial.toLowerCase()),
        'IN_STOCK',
        JSON.stringify([{
          status: 'IN_STOCK',
          sourceType: 'SALES_RETURN',
          sourceId: ret.id,
          dateAD: String(ret.returnDateAD || '').split('T')[0],
          notes: `Returned by customer via ${ret.returnNumber}`,
        }]),
        ['CUSTOMER_ASSIGNED'],
      ]);
      if (flipped.rowCount !== serials.length) {
        throw new Error(
          `Could not claim all ${serials.length} returned serial(s) — one or more are no longer ` +
            `sold/CUSTOMER_ASSIGNED. Nothing was posted.`
        );
      }
    }
  }

  // Revenue/VAT/AR and the inventory/COGS mirror all commit with the restock.
  await postSalesReturnJournal(client, { ret, cogs, actor: createdBy });
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
  const { branchId, customerId, status, query, dateFromAD, dateToAD, openOnly, page, pageSize, all, cursor, limit } = req.query;
  // SCALE-2: cursor reads are the register's stable path. The first request
  // omits `cursor` but sends `limit`; later requests send the opaque cursor.
  const wantsCursor = cursor !== undefined || limit !== undefined;
  if (wantsCursor && !requireLargeTableScope(res, {
    branchId, dateFrom: dateFromAD, dateTo: dateToAD, customerId, report: true,
  })) return;
  const parsedCursor = cursor === undefined ? undefined : decodeKeysetCursor(cursor, 'sales_invoices', 2);
  if (cursor !== undefined && !parsedCursor) {
    return res.status(400).json({ code: 'INVALID_CURSOR', message: 'The sales-invoice cursor is invalid. Reload the list and retry.' });
  }
  // Paged mode: ?page=N (optional pageSize) returns an envelope with the page
  // slice and the filtered total (the purchase-orders pattern). Filters
  // without a page param keep the legacy full-array response; a bare
  // ?branchId= request is unchanged.
  const wantsPaged = page !== undefined || pageSize !== undefined || all === '1';
  const wantsFiltering = wantsPaged || wantsCursor || status || query || dateFromAD || dateToAD || openOnly;
  if (getPgConnected() && wantsFiltering) {
    try {
      const opts = { branchId, customerId, status, query, dateFromAD, dateToAD, openOnly };
      if (wantsCursor && all !== '1') {
        const size = keysetLimit(limit, 50, 500);
        const q = buildSalesInvoiceKeysetQuery(
          opts,
          parsedCursor ? [String(parsedCursor[0]), String(parsedCursor[1])] : undefined,
          size
        );
        const r = await pgPool.query(q.sql, q.params as any[]);
        const hasMore = r.rows.length > size;
        const items = hasMore ? r.rows.slice(0, size) : r.rows;
        const last = items[items.length - 1];
        const nextCursor = hasMore && last
          ? encodeKeysetCursor('sales_invoices', [cursorTimestamp(last.createdAt), String(last.id)])
          : null;
        return res.json(keysetEnvelope(items, nextCursor, hasMore));
      }
      if (wantsPaged) {
        const size = Math.max(1, Math.min(500, Number(pageSize) || 50));
        const n = Math.max(1, Math.min(Math.max(1, Math.floor(10000 / size)), Number(page) || 1));
        const countQ = buildSalesInvoiceCountQuery(opts);
        const countR = await pgPool.query(countQ.sql, countQ.params as any[]);
        const totalItems = Number(countR.rows[0]?.count || 0);
        const listQ = buildSalesInvoicePagedQuery(opts, all === '1' ? undefined : { page: n, pageSize: size });
        const r = await pgPool.query(listQ.sql, listQ.params as any[]);
        return res.json({
          data: r.rows,
          page: all === '1' ? 1 : n,
          pageSize: all === '1' ? totalItems : size,
          totalItems,
        });
      }
      const filteredQ = buildSalesInvoicePagedQuery(opts);
      const filteredR = await pgPool.query(filteredQ.sql, filteredQ.params as any[]);
      return res.json(filteredR.rows);
    } catch (err) {
      console.error('Error fetching sales invoices from DB:', err);
    }
  }
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

/**
 * Serial gate for a sales invoice — the server half of "every serial must
 * exist in inventory before the sale posts". Runs inside the invoice
 * transaction:
 *
 *  1. serial-tracked lines must supply exactly one device + PON serial per unit;
 *  2. every serial must already exist in serial_log as IN_STOCK at the branch
 *     being sold from, for the product being sold, with a matching PON (and a
 *     matching MAC whenever one was scanned);
 *  3. the matched rows are claimed IN_STOCK → CUSTOMER_ASSIGNED in the same
 *     transaction, which is exactly what Sales Returns later flip back
 *     (SR_SERIAL_FLIP_SQL) — so a serial can never be sold twice.
 *
 * Throws with a user-facing message; the caller's transaction rolls back.
 * Only reachable with Postgres connected, matching the stock-deduction path.
 */
async function claimInvoiceSerials(
  client: any,
  items: any[],
  inv: Record<string, any>,
  targetBranchId: string,
  invDate: string
): Promise<void> {
  // Slice 2: resolution and refusal are the SHARED gate's job, not this
  // controller's. Sales was the one endpoint that already resolved against
  // serial_log; it now enforces byte-for-byte the same rule as deploy, damage
  // and the stock operations, so "is this unit real, in stock and mine?" has a
  // single answer everywhere. Sales keeps its own claim transition below
  // (SI_CLAIM_SERIAL_SQL) because Sales Returns flips it back symmetrically.
  const plan = planSerialGateEntries(items, products as any[]);
  if (plan.error) throw new Error(plan.error);
  if (plan.entries.length === 0) return;

  const keys = [...new Set(plan.entries.map((e) => serialGateKey(e.deviceSerial)))];
  const atBranch = branches.find((b) => b.id === targetBranchId)?.name || targetBranchId;
  await resolveSerialGateInDb(
    client,
    plan.entries,
    { branchId: targetBranchId, branchLabel: atBranch, matchMac: true, matchProduct: true },
    { action: 'sold', productName: (e) => e.productName }
  );

  const history = [
    {
      status: 'CUSTOMER_ASSIGNED',
      sourceType: 'SALES_INVOICE',
      sourceId: inv.invoiceNumber,
      dateAD: String(invDate || '').split('T')[0],
      notes: `Sold on sales invoice ${inv.invoiceNumber}`,
    },
  ];
  const upd = await client.query(SI_CLAIM_SERIAL_SQL, siClaimSerialParams(inv, history, keys));
  if (Number(upd.rowCount) !== keys.length) {
    throw new Error('Could not claim one or more serials for this sale — nothing was posted.');
  }
}

/** Forwarded from sales.routes.ts (post_salesInvoices). */
export async function post_salesInvoices(req: any, res: Response): Promise<any> {
  try {
    const items = req.body.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'A sales invoice requires at least one item line.' });
    }
    // QTY-1: the ceiling the screens clamp to is enforced here too, so a POST
    // that never went through the UI cannot carry an absurd or fractional
    // quantity into stock and the ledger.
    const quantityRefusal = firstLineQuantityRefusal(items);
    if (quantityRefusal) return res.status(400).json({ message: quantityRefusal });
    // C1: totals recomputed from line primitives; client aggregates ignored.
    const totals = computeBillTotals(items, undefined, defaultVatRateFor(companyProfile));
    const targetBranchId = req.body.branchId || branches[0]?.id || 'WH001';
    const invDate = req.body.invoiceDateAD || req.body.invoiceDateAd || businessDateAD();
    const invoiceNumber = await resolveDocumentNumber({
      provided: req.body.invoiceNumber,
      docType: 'INV',
      branchId: targetBranchId,
      dateAd: invDate,
    });
    // BS dates are mandatory: derive from bs_day_records for the invoice's
    // own AD date; 400 when unseeded.
    const invoiceDateBS = await bsDateOr400(res, invDate);
    if (!invoiceDateBS) return;
    // Bill terms turn the party's credit days into a stored due date. An
    // explicit override wins; otherwise the selected term (or the customer's
    // default) supplies it. The resolved date is snapshotted on the invoice.
    const terms = await resolveInvoiceTerms({
      invoiceDateAD: invDate,
      dueDateAD: req.body.dueDateAD || req.body.dueDateAd || null,
      dueDateBS: req.body.dueDateBS || req.body.dueDateBs || null,
      billTermsId: req.body.billTermsId || null,
      partyType: 'CUSTOMER',
      partyId: req.body.customerId || null,
    });

    // Sales dimensions are snapshotted at posting. Resolve the names from the
    // masters now, so renaming/retiring an area or agent later cannot rewrite
    // this invoice's history; an unknown id is a 400 rather than a silent null.
    const area = req.body.areaId ? await findAreaById(String(req.body.areaId)) : null;
    if (req.body.areaId && !area) return res.status(400).json({ message: 'The selected sales area was not found.' });
    const agent = req.body.agentId ? await findSalesAgentById(String(req.body.agentId)) : null;
    if (req.body.agentId && !agent) return res.status(400).json({ message: 'The selected sales agent was not found.' });

    const newInv: any = {
      id: req.body.id || `si-${Date.now()}`,
      invoiceNumber,
      customerId: req.body.customerId || null,
      customerName: req.body.customerName || 'Walk-in Customer',
      branchId: targetBranchId,
      invoiceDateAD: invDate,
      invoiceDateBS,
      billTermsId: terms.billTermsId,
      dueDateAD: terms.dueDateAD,
      dueDateBS: terms.dueDateBS,
      areaId: area?.id || null,
      areaName: area?.name || null,
      agentId: agent?.id || null,
      agentName: agent?.name || null,
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

    // WTY-5: a sold serial carries the promise we made with this invoice.
    // Planned before any write, so a covered line without an expiry refuses the
    // invoice instead of silently inventing the product default.
    const sellerWarrantyPlan = buildSellerCoverageCaptures({
      startDateAD: invDate,
      entries: items.flatMap((item: any) =>
        (Array.isArray(item?.deviceSerials) ? item.deviceSerials : [])
          .map((entry: any) => String(typeof entry === 'string' ? entry : entry?.deviceSerial || '').trim())
          .filter((serial: string) => serial.length > 0)
          .map((serial: string) => ({
            deviceSerial: serial,
            productId: item.productId || null,
            productName: item.productName || 'Product',
            warrantyCovered: item.sellerWarrantyCovered,
            warrantyEndDateAD: item.sellerWarrantyEndDateAD,
          }))
      ),
      productFor: (productId) => products.find((entry) => entry.id === productId),
      partyId: newInv.customerId || null,
      partyName: newInv.customerName || null,
      branchId: targetBranchId,
      sourceType: 'SALES_INVOICE',
      sourceId: newInv.id,
      sourceNumber: invoiceNumber,
      itemCategory: 'SOLD_PRODUCT',
      startBasis: 'SALE_DATE',
    });
    if (sellerWarrantyPlan.error) return res.status(400).json({ message: sellerWarrantyPlan.error });

    if (getPgConnected()) {
      // All-or-nothing: invoice insert + per-item guarded stock deduction +
      // movement ledger + accounting journal + audit row. A missing posting
      // default, a closed period or a rejected journal rolls the WHOLE invoice
      // back — there is no document without its ledger entry.
      await withTransaction(async (client) => {
        // SCALE-3: provision the invoice's month before it lands (same SQL
        // function the boot provisioner and check:partitions call).
        await client.query(ENSURE_SALES_INVOICE_PARTITION_SQL, [newInv.invoiceDateAD]);
        await client.query(SI_INSERT_SQL, siInsertParams(newInv, JSON.stringify(items)));
        await claimInvoiceSerials(client, items, newInv, targetBranchId, invDate);
        await writeSellerCoveragePlan(client, sellerWarrantyPlan.captures);
        const cogs: Array<{ productId: string; quantity: number; unitCost: number }> = [];
        for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
          const item = items[itemIdx];
          const qty = Math.abs(Number(item.quantity)) || 0;
          const deducted = await client.query(SI_DEDUCT_STOCK_SQL, [qty, item.productId, targetBranchId]);
          if (deducted.rowCount !== 1) {
            throw new Error(`Insufficient stock to sell ${qty} × ${item.productName || item.productId} at branch ${targetBranchId}.`);
          }
          // Real ledger balance: the guarded UPDATE RETURNING gives the
          // post-deduction QOH, so before = after + qty.
          const after = Number(deducted.rows?.[0]?.quantity_on_hand);
          const stockBefore = Number.isFinite(after) ? after + qty : undefined;
          const averageCost = Number(deducted.rows?.[0]?.average_cost);
          const issueCost =
            Number.isFinite(averageCost) && averageCost > 0
              ? averageCost
              : resolveLedgerUnitCost(products, item);
          if (issueCost > 0 && qty > 0) {
            cogs.push({ productId: item.productId, quantity: qty, unitCost: issueCost });
          }
          // The movement row records the same weighted cost the journal used,
          // so a later return can relieve exactly what the sale relieved.
          await client.query(SI_TXN_LOG_SQL, siTxnLogParams(newInv, item, targetBranchId, itemIdx, stockBefore, issueCost));
        }
        await postSalesInvoiceLedger(client, { invoice: newInv, cogs, actor: actorOf(req) });
        await logAuditEvent(
          req,
          'CREATE_SALES_INVOICE',
          'SALES',
          `Created Sales Invoice #${newInv.invoiceNumber} for customer ${newInv.customerName}`,
          targetBranchId,
          client
        );
      });
    } else {
      // Demo mode (no PG): mirror the same effects in memory so the finance
      // register and movement ledger stay consistent with or without the DB
      // (audit gap: creates used to leave the ledger empty when PG was down).
      // newInv is already POSTED; the demo insert mirrors it verbatim.
      setSalesInvoices(withPrepended(salesInvoices, newInv));
      const newTxns: TransactionLog[] = [];
      for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
        const item = items[itemIdx];
        const qty = Math.abs(Number(item.quantity)) || 0;
        const { stock, before } = findOrCreateDemoStock(inventoryStock, setInventoryStock, item.productId, targetBranchId);
        stock.quantityOnHand = Math.max(0, before - qty);
        stock.lastUpdated = new Date().toISOString();
        newTxns.push(demoSalesInvoiceTxn(itemIdx, {
          productId: item.productId, productSku: item.sku, productName: item.productName,
          branchId: targetBranchId, quantityBefore: before, quantityChanged: -qty,
          unitCost: resolveLedgerUnitCost(products, item), referenceDocId: invoiceNumber,
          timestampAD: newInv.invoiceDateAD, timestampBS: newInv.invoiceDateBS,
        }));
      }
      if (newTxns.length > 0) setTransactionLogs([...newTxns, ...transactionLogs]);
      for (const capture of sellerWarrantyPlan.captures) recordWarrantyCoverageMirror(capture);
    }

    // Demo mode has no transaction to join, so the audit row is written here.
    if (!getPgConnected()) {
      await logAuditEvent(req, 'CREATE_SALES_INVOICE', 'SALES', `Created Sales Invoice #${newInv.invoiceNumber} for customer ${newInv.customerName}`);
    }
    res.status(201).json(newInv);
  } catch (err: any) {
    // A business refusal (missing posting default, closed period) is expected
    // input, not a server fault, and should not print a stack trace.
    if (!(err instanceof ApiError)) console.error('Error creating sales invoice:', err);
    res.status(err instanceof ApiError ? err.status : 400).json({ message: err.message || 'Failed to create sales invoice.' });
  }
}

/** Parses the invoice's stored items JSONB (a string only on some read paths). */
function invoiceItems(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Void a posted sales invoice — POST /api/sales-invoices/:id/cancel.
 *
 * One transaction, all-or-nothing, so stock, serial_log, the ledger and the
 * invoice can never disagree:
 *   1. lock the invoice row (serialises against a concurrent payment, return
 *      or second void) and re-check its status from the database,
 *   2. refuse while posted customer payments or live credit notes still
 *      reference it — those documents must be undone first,
 *   3. flip POSTED → CANCELLED (guarded, race-safe),
 *   4. restore every line's deducted stock at the invoice branch,
 *   5. release every serial the invoice claimed (CUSTOMER_ASSIGNED → IN_STOCK)
 *      with a history entry,
 *   6. append a compensating SALES_INVOICE_CANCELLED ledger row per line, so
 *      the movement ledger nets the sale back to zero.
 */
export async function post_salesInvoiceCancel(req: any, res: Response): Promise<any> {
  try {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();

    if (!getPgConnected()) {
      return res.status(503).json({
        message: 'PostgreSQL is unavailable — a sales invoice cannot be cancelled without the database.',
      });
    }

    // Precise 404/400 before the transaction opens (the locked re-read inside
    // it is what actually decides the outcome).
    const found = await pgPool.query(SI_FIND_ONE_SQL, [id]);
    const existing: any = found.rows[0];
    if (!existing) return res.status(404).json({ message: 'Sales invoice not found.' });
    if (existing.status === 'CANCELLED') {
      return res.status(400).json({ message: `Sales invoice ${existing.invoiceNumber} is already cancelled.` });
    }

    const cancelAD = businessDateAD();
    // BS dates are mandatory even for the cancellation stamp.
    const cancelBS = await bsDateOr400(res, cancelAD);
    if (!cancelBS) return;

    await withTransaction(async (client) => {
      const lockedRes = await client.query(SI_LOCK_FOR_CANCEL_SQL, [id]);
      const inv: any = lockedRes.rows[0];
      if (!inv) throw new Error('Sales invoice not found.');
      if (String(inv.status) !== 'POSTED') {
        throw new Error(`Sales invoice ${inv.invoiceNumber} is already cancelled.`);
      }

      const payments = await client.query(SI_BLOCKING_PAYMENTS_SQL, [id]);
      const paymentCount = Number(payments.rows[0]?.count || 0);
      if (paymentCount > 0) {
        throw new Error(
          `Cannot cancel ${inv.invoiceNumber}: ${paymentCount} posted customer payment(s) reference it — reverse them first.`
        );
      }
      if (Number(inv.amountPaid) > 0) {
        throw new Error(
          `Cannot cancel ${inv.invoiceNumber}: NPR ${Number(inv.amountPaid).toFixed(2)} has already been received on it.`
        );
      }
      const returns = await client.query(SI_BLOCKING_RETURNS_SQL, [id]);
      const returnCount = Number(returns.rows[0]?.count || 0);
      if (returnCount > 0) {
        throw new Error(
          `Cannot cancel ${inv.invoiceNumber}: ${returnCount} sales return(s) still reference it — cancel them first.`
        );
      }

      const cancelled = await client.query(SI_CANCEL_SQL, [id]);
      if (cancelled.rowCount !== 1) {
        throw new Error('Sales invoice was already cancelled by another user.');
      }
      await retireDocumentNumber(client, {
        docType: 'INV',
        number: inv.invoiceNumber,
        branchId: inv.branchId,
        documentId: String(inv.id),
        reason: reason || 'Sales invoice cancelled',
      });

      const items = invoiceItems(inv.items);
      for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
        const item = items[itemIdx];
        const qty = Math.abs(Number(item.quantity)) || 0;
        let restoreAfter: number | undefined;
        if (qty > 0) {
          const restored = await client.query(SI_RESTORE_STOCK_SQL, [qty, item.productId, inv.branchId]);
          if (restored.rowCount !== 1) {
            throw new Error(
              `Could not restore stock for ${item.productName || item.productId} at branch ${inv.branchId} — nothing was cancelled.`
            );
          }
          const after = Number(restored.rows?.[0]?.quantity_on_hand);
          restoreAfter = Number.isFinite(after) ? after - qty : undefined;
        }
        await client.query(SI_TXN_LOG_SQL, siCancelTxnLogParams(inv, item, inv.branchId, itemIdx, { ad: cancelAD, bs: cancelBS }, restoreAfter, resolveLedgerUnitCost(products, item)));
      }

      const claimed = await client.query(SI_CLAIMED_SERIALS_SQL, [inv.invoiceNumber]);
      const serials: string[] = claimed.rows.map((r: any) => r.device_serial).filter(Boolean);
      if (serials.length > 0) {
        const history = [
          {
            status: 'IN_STOCK',
            sourceType: 'SALES_INVOICE_CANCELLED',
            sourceId: inv.invoiceNumber,
            dateAD: cancelAD,
            notes: `Sales invoice ${inv.invoiceNumber} cancelled${reason ? ` — ${reason}` : ''}`,
          },
        ];
        const released = await client.query(SI_RELEASE_SERIAL_SQL, [JSON.stringify(history), serials]);
        if (released.rowCount !== serials.length) {
          throw new Error('Could not release one or more serials — nothing was cancelled.');
        }
      }
      // The cancelled invoice no longer promises any warranty.
      await supersedeCoverageBySource(client, 'SELLER', 'SALES_INVOICE', String(inv.id));
      // A cancelled invoice whose serials went back to stock also ends any
      // promise keyed by the unit (covers rows from other capture paths).
      if (serials.length > 0) await supersedeSellerCoverageForSerials(client, serials);
      // Reverse the sale's ledger entry in the SAME transaction: the contra
      // journal nets AR, revenue, VAT and COGS to zero, and a failure here
      // undoes the cancellation rather than leaving stock and ledger apart.
      await reverseInvoiceJournal(client, {
        sourceType: 'SALES_INVOICE',
        sourceId: String(inv.id),
        dateAD: cancelAD,
        reason,
        actor: actorOf(req),
      });
    });

    // Keep the in-memory bootstrap mirror in step so the register does not
    // flash a stale POSTED row before the next cache refresh.
    setSalesInvoices(
      salesInvoices.map((i) =>
        i.id === existing.id || i.invoiceNumber === existing.invoiceNumber ? { ...i, status: 'CANCELLED' as const } : i
      )
    );
    if (!getPgConnected()) {
      supersedeCoverageBySourceMirror('SELLER', 'SALES_INVOICE', String(existing.id));
    }

    await logAuditEvent(req, 'CANCEL_SALES_INVOICE', 'SALES', `Cancelled Sales Invoice #${existing.invoiceNumber}${reason ? ` — ${reason}` : ''}`);
    res.json({ ...existing, status: 'CANCELLED' });
  } catch (err: any) {
    if (!(err instanceof ApiError)) console.error('Error cancelling sales invoice:', err);
    res.status(err instanceof ApiError ? err.status : 400).json({ message: err.message || 'Failed to cancel sales invoice.' });
  }
}

/** Forwarded from sales.routes.ts (get_salesReturns). */
export async function get_salesReturns(req: any, res: Response): Promise<any> {
  const { branchId, status, query, dateFromAD, dateToAD, page, pageSize, all, cursor, limit } = req.query;
  const wantsCursor = cursor !== undefined || limit !== undefined;
  if (wantsCursor && !requireLargeTableScope(res, {
    branchId, dateFrom: dateFromAD, dateTo: dateToAD, report: true,
  })) return;
  const parsedCursor = cursor === undefined ? undefined : decodeKeysetCursor(cursor, 'sales_returns', 2);
  if (cursor !== undefined && !parsedCursor) {
    return res.status(400).json({ code: 'INVALID_CURSOR', message: 'The sales-returns cursor is invalid. Reload the list and retry.' });
  }
  // Paged mode: ?page=N (optional pageSize) returns an envelope with the page
  // slice and the filtered total (the purchase-orders pattern). Filters
  // without a page param keep the legacy full-array response; a bare
  // ?branchId= request is unchanged.
  const wantsPaged = page !== undefined || pageSize !== undefined || all === '1' || wantsCursor;
  const wantsFiltering = wantsPaged || status || query || dateFromAD || dateToAD;
  if (getPgConnected() && wantsFiltering) {
    try {
      const opts = { branchId, status, query, dateFromAD, dateToAD };
      if (wantsCursor && all !== '1') {
        const size = keysetLimit(limit, 50, 500);
        const q = buildSalesReturnKeysetQuery(
          opts,
          parsedCursor ? [String(parsedCursor[0]), String(parsedCursor[1])] : undefined,
          size
        );
        const r = await pgPool.query(q.sql, q.params as any[]);
        const hasMore = r.rows.length > size;
        const items = hasMore ? r.rows.slice(0, size) : r.rows;
        const last = items[items.length - 1];
        const nextCursor = hasMore && last
          ? encodeKeysetCursor('sales_returns', [cursorTimestamp(last.createdAt), String(last.id)])
          : null;
        return res.json(keysetEnvelope(items, nextCursor, hasMore));
      }
      if (wantsPaged) {
        const n = Math.max(1, Number(page) || 1);
        const size = Math.max(1, Math.min(500, Number(pageSize) || 50));
        const countQ = buildSalesReturnCountQuery(opts);
        const countR = await pgPool.query(countQ.sql, countQ.params as any[]);
        const totalItems = Number(countR.rows[0]?.count || 0);
        const listQ = buildSalesReturnPagedQuery(opts, all === '1' ? undefined : { page: n, pageSize: size });
        const r = await pgPool.query(listQ.sql, listQ.params as any[]);
        return res.json({
          data: r.rows,
          page: all === '1' ? 1 : n,
          pageSize: all === '1' ? totalItems : size,
          totalItems,
        });
      }
      const filteredQ = buildSalesReturnPagedQuery(opts);
      const filteredR = await pgPool.query(filteredQ.sql, filteredQ.params as any[]);
      return res.json(filteredR.rows);
    } catch (err) {
      console.error('Error fetching sales returns from DB:', err);
    }
  }
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
    // QTY-1: whole numbers only. A return is bounded by the invoice line it
    // reverses (checked below), not by the typed-line ceiling, so a legacy
    // line above the ceiling stays returnable.
    const quantityRefusal = firstLineQuantityRefusal(items, { uncapped: true });
    if (quantityRefusal) return res.status(400).json({ message: quantityRefusal });

    // C1: totals are recomputed from line primitives; client aggregates ignored.
    const totals = computeBillTotals(items);
    const targetBranchId = req.body.branchId || branches[0]?.id || 'WH001';
    const retDate = req.body.returnDateAD || req.body.returnDateAd || businessDateAD();
    // BS dates are mandatory: derive from bs_day_records for the return's
    // own AD date; 400 when unseeded.
    const srReturnDateBS = await bsDateOr400(res, retDate);
    if (!srReturnDateBS) return;
    const returnNumber = await resolveDocumentNumber({
      provided: req.body.returnNumber,
      docType: 'CN',
      branchId: targetBranchId,
      dateAd: retDate,
    });

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

    // Return serials: shape first (count per unit, no duplicates), then the
    // register (exists, product, original invoice, expected state) and hydrate
    // MAC/PON from it. The browser names units; it never defines their identity.
    const serialViolation = validateReturnSerialCounts(items, isSerialTrackedProduct);
    if (serialViolation) return res.status(400).json({ message: serialViolation });
    const returnSerialList = collectReturnSerials(items);
    if (returnSerialList.length > 0) {
      const serialRows: Map<string, SerialLogRow> = getPgConnected()
        ? await loadReturnSerialRows(pgPool, returnSerialList)
        : serialRowsFromInvoiceItems(invoiceRow.items || []);
      if (getPgConnected()) {
        const registerViolation = validateReturnSerialsAgainstRegister(items, serialRows, {
          kind: 'SALES',
          invoiceItems: invoiceRow.items || [],
          branchId: targetBranchId,
        });
        if (registerViolation) return res.status(400).json({ message: registerViolation });
      }
      hydrateReturnSerialEntries(items, serialRows);
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
      returnDateBS: srReturnDateBS,
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
    } else {
      // Demo mode (no PG): persist the return and, when POSTED, mirror the
      // stock effect + SALES_RETURN ledger rows in memory (the PG transaction
      // above is skipped entirely when the DB is down). A POSTED restockable
      // return credits sellable stock; a non-restockable one routes to the
      // damage register and writes NO QOH row (quantity never moved) — the
      // same rule the PG path follows.
      setSalesReturns(withPrepended(salesReturns, newRet));
      if (newRet.status === 'POSTED' && newRet.restockable !== false) {
        const demoTxns: TransactionLog[] = [];
        items.forEach((item: any, itemIdx: number) => {
          const qty = Math.abs(Number(item.quantity)) || 0;
          const { stock, before } = findOrCreateDemoStock(inventoryStock, setInventoryStock, item.productId, targetBranchId);
          stock.quantityOnHand = before + qty;
          stock.lastUpdated = new Date().toISOString();
          demoTxns.push(demoSalesReturnTxn(itemIdx, {
            productId: item.productId, productSku: item.sku, productName: item.productName,
            branchId: targetBranchId, quantityBefore: before, quantityChanged: qty,
            unitCost: resolveLedgerUnitCost(products, item), referenceDocId: returnNumber,
            timestampAD: newRet.returnDateAD, timestampBS: newRet.returnDateBS,
          }));
        });
        if (demoTxns.length > 0) setTransactionLogs([...demoTxns, ...transactionLogs]);
      }
      // Demo twin of the coverage retirement in applySalesReturnEffects.
      if (newRet.status === 'POSTED') {
        retireCoverageForSerialsMirror('SELLER', collectReturnSerials(items), {
          reason: 'SALES_RETURN',
          ref: returnNumber,
        });
      }
    }

    if (newRet.status === 'DRAFT') {
      await logAuditEvent(req, 'CREATE_SALES_RETURN_DRAFT', 'SALES', `Sales Return #${newRet.returnNumber} (Rs. ${newRet.grandTotal}) held for approval (threshold Rs. ${RETURNS_APPROVAL_THRESHOLD_NPR})`);
      return res.status(201).json({ ...newRet, pendingApproval: true, approvalThreshold: RETURNS_APPROVAL_THRESHOLD_NPR });
    }

    await logAuditEvent(req, 'CREATE_SALES_RETURN', 'SALES', `Created Sales Return #${newRet.returnNumber} against invoice ${newRet.originalInvoiceNumber} (customer ${newRet.customerName}, ${newRet.restockable ? 'restocked' : 'routed to damage register'})`);
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

    // BS date for the compensating ledger rows: today's seeded BS record.
    const srCancelAD = businessDateAD();
    const srCancelBS = await bsDateOr400(res, srCancelAD);
    if (!srCancelBS) return;

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        // Guarded cancel: flips status only when still POSTED/DRAFT (race-safe).
        // POSTED returns also reverse their stock/ledger/damage effects; DRAFT
        // returns never posted, so there is nothing to reverse.
        const cancelled = ret.status === 'DRAFT'
          ? await client.query(SR_CANCEL_DRAFT_SQL, [ret.id])
          : await client.query(SR_CANCEL_SQL, [ret.id]);
        if (cancelled.rowCount !== 1) throw new Error('Return was already cancelled by another user.');
        await retireDocumentNumber(client, {
          docType: 'CN',
          number: ret.returnNumber,
          branchId: ret.branchId,
          documentId: String(ret.id),
          reason: reason || 'Sales return cancelled',
        });
        if (ret.status === 'POSTED') {
          // The return's own issue costs drive the re-deduction, so cancelling
          // the credit note removes exactly the value it added.
          const cancelCosts = ret.restockable !== false
            ? await loadSalesIssueCosts(
                client,
                String(ret.originalInvoiceNumber || ''),
                (ret.items || []).map((item: any) => String(item.productId || ''))
              )
            : new Map<string, number>();
          if (ret.restockable !== false) {
            let cancelLineIdx = 0;
            for (const item of ret.items || []) {
              const redeductQty = Math.abs(Number(item.quantity)) || 0;
              const unitCost = Number(cancelCosts.get(String(item.productId))) || 0;
              if (redeductQty > 0 && unitCost <= 0) {
                throw new ApiError(
                  400,
                  `Sales return ${ret.returnNumber}: the original sale records no issue cost for ${item.productName || item.productId}; the cancellation was refused.`
                );
              }
              const rededucted = await client.query(SR_REDEDUCT_STOCK_SQL, [redeductQty, unitCost, item.productId, ret.branchId]);
              if (rededucted.rowCount !== 1) {
                throw new Error(`Could not reverse restocked stock for ${item.productName || item.productId} at branch ${ret.branchId} — nothing was cancelled.`);
              }
              // Compensating SALES_RETURN_CANCELLED ledger row: the original
              // restock row stays, so a negative mirror nets the return back
              // to zero with the TRUE balance from the re-deduct's RETURNING.
              const after = Number(rededucted.rows?.[0]?.quantity_on_hand);
              const stockBefore = Number.isFinite(after) ? after + redeductQty : 0;
              await client.query(
                SR_CANCEL_TXN_LOG_SQL,
                srCancelTxnLogParams(ret, item, ret.branchId, cancelLineIdx++, stockBefore, { ad: srCancelAD, bs: srCancelBS }, unitCost)
              );
            }
          } else {
            // Cancel the damage-register rows this return created.
            await client.query(SR_DAMAGE_CANCEL_SQL, [`${ret.returnNumber}-SR-%`]);
          }
          await reverseReturnJournal(client, {
            kind: 'SALES_RETURN',
            returnId: String(ret.id),
            dateAD: srCancelAD,
            reason: reason || 'Sales return cancelled',
            actor: actorOf(req),
          });
          for (const item of ret.items || []) {
            const serials = returnLineSerials(item).map((entry) => entry.deviceSerial);
            if (serials.length > 0) {
              const flipped = await client.query(SR_SERIAL_FLIP_SQL, [
                serials.map((serial) => serial.toLowerCase()),
                'SOLD',
                JSON.stringify([{
                  status: 'SOLD',
                  sourceType: 'SALES_RETURN_CANCELLED',
                  sourceId: ret.id,
                  dateAD: businessDateAD(),
                  notes: `Sales return ${ret.returnNumber} cancelled`,
                }]),
                ['IN_STOCK'],
              ]);
              if (flipped.rowCount !== serials.length) {
                throw new Error(
                  `Could not release the returned serial(s) for ${ret.returnNumber} — one or more ` +
                    `are no longer IN_STOCK. Nothing was cancelled.`
                );
              }
            }
          }
        }
      });
    } else if (ret.status === 'POSTED' && ret.restockable !== false) {
      // Demo mode (no PG): mirror the POSTED-cancel restock reversal in memory
      // — re-deduct the credited stock and append compensating
      // SALES_RETURN_CANCELLED rows (a negative mirror of the original
      // restock). A non-restockable return credited no sellable stock, so
      // there is nothing to reverse — matching the PG path.
      const demoCancelTxns: TransactionLog[] = [];
      let demoCancelLine = 0;
      (ret.items || []).forEach((item: any) => {
        const redeductQty = Math.abs(Number(item.quantity)) || 0;
        const { stock, before } = findOrCreateDemoStock(inventoryStock, setInventoryStock, item.productId, ret.branchId);
        stock.quantityOnHand = Math.max(0, before - redeductQty);
        stock.lastUpdated = new Date().toISOString();
        demoCancelTxns.push(demoSalesReturnCancelTxn(demoCancelLine++, {
          productId: item.productId, productSku: item.sku, productName: item.productName,
          branchId: ret.branchId, quantityBefore: before, quantityChanged: -redeductQty,
          unitCost: resolveLedgerUnitCost(products, item), referenceDocId: ret.returnNumber,
          timestampAD: srCancelAD, timestampBS: srCancelBS,
        }));
      });
      if (demoCancelTxns.length > 0) setTransactionLogs([...demoCancelTxns, ...transactionLogs]);
    }

    await logAuditEvent(req, 'CANCEL_SALES_RETURN', 'SALES', `Cancelled ${ret.status === 'DRAFT' ? 'draft ' : ''}Sales Return #${ret.returnNumber}${reason ? ` — ${reason}` : ''}`);
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

      // The stored serials were validated at creation; approving later still
      // needs the shape check, and the guarded flip inside the transaction
      // refuses any unit that moved in the meantime.
      const serialViolation = validateReturnSerialCounts(items, isSerialTrackedProduct);
      if (serialViolation) return res.status(400).json({ message: serialViolation });

      await withTransaction(async (client) => {
        const posted = await client.query(SR_POST_DRAFT_SQL, [ret.id]);
        if (posted.rowCount !== 1) throw new Error('Return was already approved or cancelled by another user.');
        await applySalesReturnEffects(client, ret, items, ret.branchId, getUserFromReq(req)?.email);
      });
    }

    await logAuditEvent(req, 'APPROVE_SALES_RETURN', 'SALES', `Approved Sales Return #${ret.returnNumber} (draft → posted)`);
    res.json({ ...ret, status: 'POSTED' });
  } catch (err: any) {
    console.error('Error approving sales return:', err);
    res.status(400).json({ message: err.message || 'Failed to approve sales return.' });
  }
}

// ---------------------------------------------------------------------------
// Customer Receivables Ledger — reads the posted AR party subledger.
// ---------------------------------------------------------------------------

/**
 * Forwarded from sales.routes.ts (get_customerLedger).
 *
 * The statement is built by `buildPartyLedger` from `gl_subledger_entries` on
 * the AR control account. Invoices, receipts and returns are display labels on
 * those posted rows; they are not the source of the amount. That keeps manual
 * journals, opening balances, unapplied receipts, write-offs and linked
 * reversals visible in the same statement.
 */
export async function get_customerLedger(req: any, res: Response): Promise<any> {
  try {
    const { customerId } = req.params;
    const { fromAd, toAd, branchId, cursor, limit, all } = req.query;
    const exportAll = all === '1' || all === 'true';
    const paged = cursor !== undefined || limit !== undefined || exportAll;
    let customer: any;
    if (getPgConnected()) {
      const found = await pgPool.query(CUSTOMER_FIND_BY_ID_OR_CODE_SQL, [customerId]);
      customer = found.rows[0];
    } else {
      customer = customerMasterRecords.find((c: any) => c.id === customerId || c.customerId === customerId);
    }
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found.' });
    }

    // AUTHZ-3: the route's branch filter scopes the LEDGER LINES, but it did
    // not scope the CUSTOMER. A branch user could pass their own branchId and
    // a customer id from another branch, and the 200-vs-404 answer plus the
    // customer's name leaked that record. Legacy rows without a branch stay
    // readable (they predate the column).
    const ledgerUser = getUserFromReq(req) as any;
    if (
      ledgerUser?.email &&
      ledgerUser.role !== 'SUPER_ADMIN' &&
      ledgerUser.role !== 'HEAD_OFFICE_ADMIN' &&
      ledgerUser.branchId !== 'ALL'
    ) {
      const allowedBranches = new Set<string>(
        [ledgerUser.branchId || '', ...((ledgerUser.allowedBranchIds as string[]) || [])].filter(Boolean)
      );
      if (customer.branchId && !allowedBranches.has(String(customer.branchId))) {
        return res.status(404).json({ message: 'Customer not found.' });
      }
    }

    if (!getPgConnected()) {
      return res.status(503).json({ message: 'The customer statement requires the accounting database.' });
    }

    if (
      paged &&
      !requireLargeTableScope(res, {
        branchId,
        dateFrom: fromAd,
        dateTo: toAd,
        report: true,
      })
    ) {
      return;
    }

    if (exportAll && cursor !== undefined) {
      return res.status(400).json({
        code: 'INVALID_CURSOR',
        message: 'The customer-statement export cannot combine all=1 with a cursor. Reload the statement and retry.',
      });
    }

    if (exportAll) {
      const statement = await buildPartyLedger(pgPool, {
        side: 'CUSTOMER',
        partyId: customer.id,
        partyName: customer.customerName,
        branchId: branchId as string | undefined,
        from: fromAd,
        to: toAd,
      });
      return res.json(
        keysetEnvelope(statement.ledger, null, false, {
          customer: { id: customer.id, customerId: customer.customerId, name: customer.customerName },
          ...statement,
          ledger: statement.ledger,
          totalEntries: statement.ledger.length,
          exportAll: true,
        })
      );
    }

    let cursorKey: [string, string] | null = null;
    if (cursor !== undefined) {
      const decoded = decodeKeysetCursor(cursor, 'gl_subledger_entries', 2);
      if (!decoded) {
        return res.status(400).json({
          code: 'INVALID_CURSOR',
          message: 'The customer-statement cursor is invalid. Reload the statement and retry.',
        });
      }
      cursorKey = [String(decoded[0]), String(decoded[1])];
    }

    const partyInput = {
      side: 'CUSTOMER',
      partyId: customer.id,
      partyName: customer.customerName,
      branchId: branchId as string | undefined,
      from: fromAd,
      to: toAd,
    } as const;

    if (paged) {
      const page = await buildPartyLedgerPage(pgPool, {
        ...partyInput,
        cursor: cursorKey,
        limit: keysetLimit(limit, 50, 500),
      });
      if (!page) {
        return res.status(400).json({
          code: 'INVALID_CURSOR',
          message: 'The customer-statement cursor is outside the selected statement. Reload it and retry.',
        });
      }
      const nextCursor = page.nextCursorKey
        ? encodeKeysetCursor('gl_subledger_entries', page.nextCursorKey)
        : null;
      const { nextCursorKey: _nextCursorKey, ...statement } = page;
      return res.json(
        keysetEnvelope(statement.ledger, nextCursor, page.hasMore, {
          customer: { id: customer.id, customerId: customer.customerId, name: customer.customerName },
          ...statement,
          ledger: statement.ledger,
          totalEntries: page.totalEntries,
        })
      );
    }

    const statement = await buildPartyLedger(pgPool, partyInput);

    res.json({
      customer: { id: customer.id, customerId: customer.customerId, name: customer.customerName },
      ...statement,
    });
  } catch (err: any) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ message: err.message });
    }
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

    // A receipt is either explicitly allocated across invoices or an unapplied
    // advance. The old `invoiceId` + `amount` shape remains the one-invoice
    // compatibility path; the new shape is `allocations: [{ invoiceId, amount }]`.
    const rawAllocations = Array.isArray(body.allocations) ? body.allocations : null;
    if (rawAllocations && body.invoiceId) {
      return res.status(400).json({ message: 'Use either invoiceId or allocations on a receipt, not both.' });
    }
    const allocationRequests: Array<{ invoiceId: string; amount: number }> = [];
    if (rawAllocations) {
      for (const row of rawAllocations) {
        const invoiceId = String(row?.invoiceId || '').trim();
        const lineAmount = roundMoney(Number(row?.amount));
        if (!invoiceId || !Number.isFinite(lineAmount) || lineAmount <= 0) {
          return res.status(400).json({ message: 'Every receipt allocation needs an invoice and a positive amount.' });
        }
        allocationRequests.push({ invoiceId, amount: lineAmount });
      }
      if (allocationRequests.length === 0) {
        return res.status(400).json({ message: 'A receipt allocation list cannot be empty.' });
      }
    } else if (body.invoiceId) {
      allocationRequests.push({ invoiceId: String(body.invoiceId), amount: roundMoney(amount) });
    }
    const allocatedTotal = roundMoney(
      allocationRequests.reduce((sum, row) => sum + row.amount, 0)
    );
    if (allocatedTotal > amount + 0.005) {
      return res.status(400).json({
        message: `Allocations total ${allocatedTotal.toFixed(2)} but the receipt is only ${amount.toFixed(2)}.`,
      });
    }

    // Resolve every named invoice once. The lock inside the transaction decides
    // the live balance; this pass establishes identity, customer and branch.
    const allocationInvoices: Array<{ request: { invoiceId: string; amount: number }; invoice: any }> = [];
    for (const request of allocationRequests) {
      let invoice: any = salesInvoices.find(
        (inv) => inv.id === request.invoiceId || inv.invoiceNumber === request.invoiceId
      );
      if (!invoice && getPgConnected()) {
        invoice = (await pgPool.query(SI_FIND_ONE_SQL, [request.invoiceId])).rows[0];
      }
      if (!invoice) {
        return res.status(404).json({ message: `The invoice ${request.invoiceId} selected for this receipt was not found.` });
      }
      if (allocationInvoices.some((row) => row.invoice.id === invoice.id)) {
        return res.status(400).json({ message: `Invoice ${invoice.invoiceNumber} appears twice in the allocation list.` });
      }
      allocationInvoices.push({ request, invoice });
    }
    const linkedInvoice = allocationInvoices[0]?.invoice;
    // The header's single-invoice link claims the receipt settled that invoice.
    // A partly applied receipt (some of it left as an advance) must not claim
    // it: the allocation rows are the authority, and `invoiceId` is only the
    // one-invoice compatibility path.
    const singleInvoice =
      allocationInvoices.length === 1 && Math.abs(roundMoney(amount - allocatedTotal)) < 0.005
        ? linkedInvoice
        : null;

    let customerId: string | null = body.customerId || linkedInvoice?.customerId || null;
    let customerName = body.customerName || linkedInvoice?.customerName || '';
    if (!customerId && customerName) {
      let matched: any;
      if (getPgConnected()) {
        const found = await pgPool.query(CUSTOMER_FIND_BY_NAME_SQL, [customerName]);
        matched = found.rows[0];
      } else {
        matched = customerMasterRecords.find((c: any) =>
          c.customerName.toLowerCase() === customerName.toLowerCase()
        ) || customerMasterRecords.find((c: any) =>
          customerName.toLowerCase().includes(c.customerName.toLowerCase())
        );
      }
      customerId = matched?.id || null;
    }
    if (!customerName && customerId) {
      let cust: any;
      if (getPgConnected()) {
        const found = await pgPool.query(CUSTOMER_FIND_BY_ID_OR_CODE_SQL, [customerId]);
        cust = found.rows[0];
      } else {
        cust = customerMasterRecords.find((c: any) => c.id === customerId);
      }
      customerName = cust?.customerName || '';
    }
    if (!customerName) {
      return res.status(400).json({ message: 'Customer is required to record a customer payment.' });
    }

    // A receipt against invoices belongs to one branch. Mixing branches in a
    // single cash document is refused: the cash book is a branch custody view.
    const invoiceCustomers = new Set(
      allocationInvoices.map((row) => row.invoice.customerId).filter(Boolean).map(String)
    );
    if (invoiceCustomers.size > 1) {
      return res.status(400).json({ message: 'One receipt cannot allocate across different customers.' });
    }
    const invoiceBranches = new Set(
      allocationInvoices.map((row) => row.invoice.branchId).filter(Boolean).map(String)
    );
    if (invoiceBranches.size > 1) {
      return res.status(400).json({ message: 'One receipt cannot allocate across different branches.' });
    }
    if (linkedInvoice?.customerId && customerId && String(linkedInvoice.customerId) !== String(customerId)) {
      return res.status(400).json({ message: 'The receipt customer does not match the allocated invoice customer.' });
    }
    const branchId = linkedInvoice?.branchId || body.branchId || getUserFromReq(req)?.branchId || branches[0]?.id || 'WH001';
    const paymentDateAD = String(body.paymentDateAD || businessDateAD()).split('T')[0];
    // BS dates are mandatory: derive from bs_day_records for the payment's
    // OWN AD date; 400 when unseeded (no fallback, no empty string).
    const paymentDateBS = await bsDateOr400(res, paymentDateAD);
    if (!paymentDateBS) return;

    const paymentMethod = String(body.paymentMethod || 'CASH').toUpperCase();
    const isWallet = paymentMethod === 'ONLINE';
    const providerCode = isWallet ? String(body.providerCode || '').trim().toUpperCase() : null;
    const providerTransactionId = isWallet
      ? String(body.providerTransactionId || '').trim().slice(0, 200)
      : null;
    if (isWallet && !['ESEWA', 'KHALTI', 'NEPAL_PAY'].includes(providerCode || '')) {
      return res.status(400).json({ message: 'An ONLINE receipt must name ESEWA, KHALTI or NEPAL_PAY.' });
    }
    if (isWallet && !providerTransactionId) {
      return res.status(400).json({ message: 'A provider transaction id is required for an ONLINE receipt.' });
    }
    const grossAmount = isWallet ? Number(body.grossAmount ?? amount) : amount;
    const feeAmount = isWallet ? Number(body.feeAmount ?? 0) : 0;
    if (isWallet && (!Number.isFinite(grossAmount) || grossAmount !== amount)) {
      return res.status(400).json({ message: 'The wallet gross amount must equal the receipt amount.' });
    }
    if (isWallet && (!Number.isFinite(feeAmount) || feeAmount < 0)) {
      return res.status(400).json({ message: 'The provider fee cannot be negative.' });
    }
    const netAmount = isWallet ? Number(body.netAmount ?? grossAmount - feeAmount) : amount;
    if (isWallet && (!Number.isFinite(netAmount) || netAmount <= 0 || netAmount !== grossAmount - feeAmount)) {
      return res.status(400).json({ message: 'Wallet net must be gross minus fee and remain greater than zero.' });
    }
    if (!isWallet && (body.providerCode || body.providerTransactionId || Number(body.feeAmount) > 0)) {
      return res.status(400).json({ message: 'Provider details and fees are only valid on an ONLINE wallet receipt.' });
    }
    if (isWallet && getPgConnected()) {
      const duplicate = await pgPool.query(CP_PROVIDER_TXN_EXISTS_SQL, [providerCode, providerTransactionId]);
      if (duplicate.rows[0]) {
        return res.status(409).json({ message: `Provider transaction ${providerTransactionId} is already recorded.` });
      }
    }
    // CR = cash receipt, BR = bank/wallet receipt — mirrors the vendor side's
    // CP/BP split. ONLINE still gets a BR number because it is not till cash.
    const payDocType = paymentMethod === 'CASH' ? 'CR' : 'BR';
    // The register is the only authority for a new receipt number. Importers
    // must use an explicit migration path, not a body override.
    const paymentNumber = await issueNextDocNumber(branchId, payDocType, paymentDateAD);
    let chequeDateBS: string | null = null;
    if (body.chequeDateAD) {
      chequeDateBS = await bsDateOr400(res, body.chequeDateAD);
      if (!chequeDateBS) return;
    }

    const newPayment = {
      id: `cp-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
      paymentNumber,
      customerId,
      customerName,
      branchId,
      invoiceId: singleInvoice?.id || null,
      invoiceNumber: singleInvoice?.invoiceNumber || body.invoiceNumber || null,
      allocations: allocationInvoices.map((row) => ({
        invoiceId: row.invoice.id,
        invoiceNumber: row.invoice.invoiceNumber,
        amount: row.request.amount,
      })),
      paymentDateAD,
      paymentDateBS,
      amount,
      paymentMethod,
      bankName: body.bankName || null,
      bankBranch: body.bankBranch || null,
      accountNumber: body.accountNumber || null,
      chequeNumber: body.chequeNumber || null,
      chequeDateAD: body.chequeDateAD || null,
      chequeDateBS,
      transactionReference: body.transactionReference || null,
      settlementAccountId: body.settlementAccountId || null,
      providerCode,
      providerTransactionId,
      grossAmount,
      feeAmount,
      netAmount,
      notes: body.notes || null,
      status: 'POSTED',
      createdBy: getUserFromReq(req)?.email || 'system',
    };

    if (getPgConnected()) {
      // Payment row, invoice balance, AR settlement, journal and audit commit
      // atomically. A missing posting default or a closed period rolls the
      // whole receipt back — no cash movement without its ledger entry.
      await withTransaction(async (client) => {
        // Lock every invoice in a deterministic order. The balance check and
        // the update are one race-safe unit; a concurrent receipt cannot spend
        // the same open balance twice.
        const lockedById = new Map<string, any>();
        const invoiceIds = [...new Set(allocationInvoices.map((row) => String(row.invoice.id)))].sort();
        for (const invoiceId of invoiceIds) {
          const locked = (await client.query(SI_LOCK_FOR_PAYMENT_SQL, [invoiceId])).rows[0];
          if (!locked) {
            throw new ApiError(404, 'An invoice selected for this receipt was not found.');
          }
          lockedById.set(invoiceId, locked);
        }
        for (const row of allocationInvoices) {
          const locked = lockedById.get(String(row.invoice.id));
          if (!locked) throw new ApiError(404, 'An invoice selected for this receipt was not found.');
          if (String(locked.status || '').toUpperCase() !== 'POSTED') {
            throw new ApiError(409, `Invoice ${locked.invoiceNumber} is ${String(locked.status || 'not posted').toLowerCase()} and cannot receive a payment.`);
          }
          if (locked.customerId && customerId && String(locked.customerId) !== String(customerId)) {
            throw new ApiError(400, `Invoice ${locked.invoiceNumber} belongs to a different customer.`);
          }
          if (locked.branchId && String(locked.branchId) !== String(branchId)) {
            throw new ApiError(400, `Invoice ${locked.invoiceNumber} belongs to a different branch.`);
          }
          const remaining = roundMoney(
            Number(locked.grandTotal || 0) - Number(locked.amountPaid || 0)
          );
          if (remaining <= 0) {
            throw new ApiError(409, `Invoice ${locked.invoiceNumber} is already fully paid.`);
          }
          if (row.request.amount > remaining + 0.005) {
            // REC-1: name the excess and the lane that can carry it, so the
            // operator can record it as an advance instead of guessing.
            const excess = roundMoney(row.request.amount - remaining);
            throw new ApiError(
              400,
              `Allocation ${row.request.amount.toFixed(2)} exceeds the ${remaining.toFixed(2)} still open on invoice ${locked.invoiceNumber} by ${excess.toFixed(2)}. ` +
                'An invoice can never take more than it still owes — record the excess as a separate unapplied advance (a receipt with no allocation).'
            );
          }
        }
        await client.query(CP_INSERT_SQL, cpInsertParams(newPayment));
        for (let index = 0; index < allocationInvoices.length; index += 1) {
          const row = allocationInvoices[index];
          await client.query(CPA_INSERT_SQL, cpaInsertParams({
            id: `cpa-${newPayment.id}-${index}`,
            paymentId: newPayment.id,
            invoiceId: row.invoice.id,
            amount: row.request.amount,
          }));
          const applied = await client.query(SI_RECORD_PAYMENT_SQL, [row.request.amount, row.invoice.id]);
          if (applied.rowCount !== 1) {
            throw new ApiError(
              409,
              `Invoice ${row.invoice.invoiceNumber} changed while the receipt was being applied; no balance was over-allocated.`
            );
          }
        }
        await postCustomerReceiptLedger(client, { receipt: newPayment, actor: actorOf(req) });
        await logAuditEvent(
          req,
          'RECORD_CUSTOMER_PAYMENT',
          'SALES',
          `Recorded customer payment #${paymentNumber} of NPR ${amount.toLocaleString()} from ${customerName} via ${paymentMethod}`,
          branchId,
          client
        );
      });
    } else {
      for (const row of allocationInvoices) {
        const invoice = salesInvoices.find((entry) => entry.id === row.invoice.id);
        if (!invoice) continue;
        invoice.amountPaid = Number(invoice.amountPaid || 0) + row.request.amount;
        invoice.paymentStatus =
          invoice.amountPaid >= Number(invoice.grandTotal || 0) ? 'PAID' : 'PARTIAL';
      }
      await logAuditEvent(req, 'RECORD_CUSTOMER_PAYMENT', 'SALES', `Recorded customer payment #${paymentNumber} of NPR ${amount.toLocaleString()} from ${customerName} via ${paymentMethod}`, branchId);
    }

    res.status(201).json(newPayment);
  } catch (err: any) {
    // A missing posting default or a closed period is expected input, not a
    // server fault: surface its 400/409 instead of a generic database 500.
    if (!(err instanceof ApiError)) console.error('Error creating customer payment:', err);
    res.status(err instanceof ApiError ? err.status : err?.code === '23505' ? 409 : 500).json({
      message:
        err instanceof ApiError
          ? err.message
          : err?.code === '23505'
            ? 'That provider transaction id is already recorded.'
            : `Database error: ${err.message}`,
    });
  }
}

/** Forwarded from sales.routes.ts (post_customerPaymentReverse). */
export async function post_customerPaymentReverse(req: any, res: Response): Promise<any> {
  try {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ message: 'A reversal reason is required.' });
    // PostgreSQL is the only decision source when connected: a payment created
    // by the real write path is not in the in-memory mirror.
    const payment = getPgConnected()
      ? (await pgPool.query(CP_FIND_BY_ID_SQL, [id])).rows[0]
      : customerPayments.find((p) => p.id === id);
    if (!payment) return res.status(404).json({ message: 'Customer payment not found.' });
    if (payment.status !== 'POSTED') {
      return res.status(409).json({ message: `Payment #${payment.paymentNumber} is already ${String(payment.status).toLowerCase()}.` });
    }

    if (getPgConnected() && payment.paymentMethod === 'ONLINE') {
      const settled = Number((await pgPool.query(CP_SETTLED_GROSS_SQL, [id])).rows[0]?.settledGross) || 0;
      if (settled > 0) {
        return res.status(409).json({
          message: `Payment #${payment.paymentNumber} already has NPR ${settled.toFixed(2)} settled with the provider. Use a chargeback instead of reversing a settled receipt.`,
        });
      }
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
        await reversePaymentAllocations(client, payment, reason, getUserFromReq(req)?.email || 'system');
        // The contra journal joins the same transaction: a reversed receipt
        // cannot leave its original cash/AR entry standing alone.
        await reverseCustomerReceiptJournal(client, {
          paymentId: id,
          reason,
          actor: actorOf(req),
        });
        await logAuditEvent(
          req,
          'REVERSE_CUSTOMER_PAYMENT',
          'SALES',
          `Reversed customer payment #${payment.paymentNumber} — ${reason}`,
          payment.branchId,
          client
        );
      });
    } else {
      await logAuditEvent(req, 'REVERSE_CUSTOMER_PAYMENT', 'SALES', `Reversed customer payment #${payment.paymentNumber} — ${reason}`);
    }

    res.json({ ...payment, status: 'REVERSED', reversalReason: reason });
  } catch (err: any) {
    if (!(err instanceof ApiError)) console.error('Error reversing customer payment:', err);
    res.status(err instanceof ApiError ? err.status : err.statusCode || 500).json({
      message: err.message || 'Failed to reverse customer payment.',
    });
  }
}

/** Refund an unsettled wallet receipt (the provider has not paid us yet). */
export async function post_customerPaymentRefund(req: any, res: Response): Promise<any> {
  try {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ message: 'A refund reason of at least 3 characters is required.' });
    const payment = getPgConnected()
      ? (await pgPool.query(CP_FIND_BY_ID_SQL, [id])).rows[0]
      : customerPayments.find((p) => p.id === id);
    if (!payment) return res.status(404).json({ message: 'Customer payment not found.' });
    if (payment.paymentMethod !== 'ONLINE') {
      return res.status(400).json({ message: 'Only an ONLINE wallet receipt can be refunded through the provider.' });
    }
    if (payment.status !== 'POSTED') {
      return res.status(409).json({ message: `Payment #${payment.paymentNumber} is already ${String(payment.status).toLowerCase()}.` });
    }
    const settled = Number((await pgPool.query(CP_SETTLED_GROSS_SQL, [id])).rows[0]?.settledGross) || 0;
    if (settled > 0) {
      return res.status(409).json({
        message: `NPR ${settled.toFixed(2)} of this receipt is already settled. Record a chargeback instead of a refund.`,
      });
    }

    await withTransaction(async (client) => {
      const current = await client.query(CP_LOCK_STATUS_SQL, [id]);
      if (!current.rows[0] || current.rows[0].status !== 'POSTED') {
        const conflict: any = new Error('That payment changed while the refund was being recorded.');
        conflict.statusCode = 409;
        throw conflict;
      }
      await client.query(CP_REFUND_SQL, [reason, getUserFromReq(req)?.email || 'system', id]);
      await reversePaymentAllocations(client, payment, reason, getUserFromReq(req)?.email || 'system');
      await postWalletRefundLedger(client, { receipt: payment, reason, actor: actorOf(req) });
      await logAuditEvent(
        req,
        'REFUND_CUSTOMER_PAYMENT',
        'SALES',
        `Refunded wallet payment #${payment.paymentNumber} (${payment.providerCode || 'provider'}) — ${reason}`,
        payment.branchId,
        client
      );
    });
    return res.json({ ...payment, status: 'REFUNDED', reversalReason: reason });
  } catch (err: any) {
    if (!(err instanceof ApiError)) console.error('Error refunding customer payment:', err);
    return res.status(err instanceof ApiError ? err.status : err.statusCode || 500).json({
      message: err.message || 'Failed to refund customer payment.',
    });
  }
}

/** Route a settled provider reversal to chargeback expense with an audit reason. */
export async function post_customerPaymentChargeback(req: any, res: Response): Promise<any> {
  try {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ message: 'A chargeback reason of at least 3 characters is required.' });
    const payment = getPgConnected()
      ? (await pgPool.query(CP_FIND_BY_ID_SQL, [id])).rows[0]
      : customerPayments.find((p) => p.id === id);
    if (!payment) return res.status(404).json({ message: 'Customer payment not found.' });
    if (payment.paymentMethod !== 'ONLINE') {
      return res.status(400).json({ message: 'Only an ONLINE wallet receipt can be charged back through the provider.' });
    }
    if (payment.status !== 'POSTED') {
      return res.status(409).json({ message: `Payment #${payment.paymentNumber} is already ${String(payment.status).toLowerCase()}.` });
    }

    await withTransaction(async (client) => {
      const current = await client.query(CP_LOCK_STATUS_SQL, [id]);
      if (!current.rows[0] || current.rows[0].status !== 'POSTED') {
        const conflict: any = new Error('That payment changed while the chargeback was being recorded.');
        conflict.statusCode = 409;
        throw conflict;
      }
      await client.query(CP_CHARGEBACK_SQL, [reason, getUserFromReq(req)?.email || 'system', id]);
      await reversePaymentAllocations(client, payment, reason, getUserFromReq(req)?.email || 'system');
      await postWalletChargebackLedger(client, { receipt: payment, reason, actor: actorOf(req) });
      await logAuditEvent(
        req,
        'CHARGEBACK_CUSTOMER_PAYMENT',
        'SALES',
        `Chargeback wallet payment #${payment.paymentNumber} (${payment.providerCode || 'provider'}) — ${reason}`,
        payment.branchId,
        client
      );
    });
    return res.json({ ...payment, status: 'CHARGEBACK', reversalReason: reason });
  } catch (err: any) {
    if (!(err instanceof ApiError)) console.error('Error recording customer payment chargeback:', err);
    return res.status(err instanceof ApiError ? err.status : err.statusCode || 500).json({
      message: err.message || 'Failed to record customer payment chargeback.',
    });
  }
}
