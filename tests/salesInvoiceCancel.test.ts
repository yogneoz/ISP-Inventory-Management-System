/**
 * Cancel/void a posted sales invoice (POST /api/sales-invoices/:id/cancel) —
 * HTTP-layer integration tests, wired exactly as production (createApp +
 * registerAllRoutes) against real PostgreSQL.
 *
 * The void is the one path that has to keep four things in agreement at once —
 * the invoice document, inventory_stock, serial_log and the movement ledger —
 * so these tests prove the whole reversal, not just the status flip:
 *
 *  1. UNDO — a posted invoice (one plain line + one serial-carrying line) can
 *     be cancelled: 200, `status: CANCELLED` in the DB, every deducted unit is
 *     back on hand, every serial the invoice claimed is IN_STOCK with its
 *     customer stamp cleared and a history entry, and one
 *     SALES_INVOICE_CANCELLED ledger row per line (+qty) nets the original
 *     negative sale back to zero.
 *  2. GUARDS — a second void -> 400, unknown id -> 404, no token -> 401, a role
 *     without `sales-invoice-create` -> 403, an invoice with posted customer
 *     payments -> 400, an invoice with cash already received -> 400, an
 *     invoice with a live credit note -> 400 (and none of the rejected calls
 *     move stock, serials or status).
 *
 * Fixtures use an `sivtest-` id prefix and are removed in after(). Skips
 * without a reachable PostgreSQL (DATABASE_URL), like the other HTTP-layer
 * integration suites.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';

dotenv.config();

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipPositive = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const SUPER_USER = {
  id: 'sivtest-super', email: 'sivtest-super@example.com', name: 'SIV Test Super',
  role: 'SUPER_ADMIN', branchId: 'sivtest-br', allowedBranchIds: ['sivtest-br'], canSwitchUser: false,
} as any;
const AUDITOR_USER = {
  id: 'sivtest-aud', email: 'sivtest-aud@example.com', name: 'SIV Test Auditor',
  role: 'AUDITOR', branchId: 'sivtest-br', allowedBranchIds: ['sivtest-br'], canSwitchUser: false,
} as any;

const BR = 'sivtest-br';
const PROD = 'sivtest-prod';
const SERIAL = 'SIVTEST-DEV-1';
const PON = 'SIVTEST-PON-1';
const todayAD = new Date().toISOString().split('T')[0];

describe('cancel sales invoice (POST /api/sales-invoices/:id/cancel)', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const superToken = issueAuthToken(SUPER_USER);
  const auditorToken = issueAuthToken(AUDITOR_USER);
  let invoiceNumber = '';
  let invoiceId = '';

  before(async () => {
    if (!dbReachable) return;

    // Clear leftovers from aborted runs, then seed idempotently.
    await pool!.query("DELETE FROM customer_payments WHERE id LIKE 'sivtest-%' OR invoice_id LIKE 'sivtest-%'");
    await pool!.query("DELETE FROM sales_returns WHERE id LIKE 'sivtest-%'");
    await pool!.query("DELETE FROM sales_invoices WHERE id LIKE 'sivtest-%'");
    await pool!.query(`DELETE FROM transaction_logs WHERE product_id = '${PROD}'`);
    await pool!.query("DELETE FROM audit_logs WHERE user_email LIKE 'sivtest-%@example.com'");
    await pool!.query(`DELETE FROM serial_log WHERE device_serial = '${SERIAL}'`);
    await pool!.query("DELETE FROM inventory_stock WHERE product_id LIKE 'sivtest-%'");
    await pool!.query("DELETE FROM document_sequence_daily WHERE branch_id = '" + BR + "'");
    await pool!.query("DELETE FROM products WHERE id LIKE 'sivtest-%'");
    await pool!.query("DELETE FROM branches WHERE id LIKE 'sivtest-%'");

    await pool!.query(
      "INSERT INTO branches (id, code, name, location) VALUES ($1, 'SIVBR', 'SIV Test Branch', 'T')",
      [BR]
    );
    await pool!.query(
      "INSERT INTO products (id, sku, name, category, product_group, tax_rate) VALUES ($1, 'SIVSKU', 'SIV Test Product', 'Test', 'Product Item', 13)",
      [PROD]
    );
    await pool!.query(
      "INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty) VALUES ($1, $2, $3, 10, 0)",
      ['stk-' + BR + '-' + PROD, PROD, BR]
    );
    await pool!.query(
      `INSERT INTO serial_log (id, device_serial, pon_serial, product_id, product_name, branch_id, status, source_type)
       VALUES ($1, $2, $3, $4, 'SIV Test Product', $5, 'IN_STOCK', 'PURCHASE')`,
      ['sl-' + SERIAL.toLowerCase(), SERIAL, PON, PROD, BR]
    );

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () => new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server.close(() => done());
    });
  });

  after(async () => {
    if (close) await close();
    if (pool && dbReachable) {
      await pool.query("DELETE FROM customer_payments WHERE id LIKE 'sivtest-%' OR invoice_id LIKE 'sivtest-%'");
      await pool.query("DELETE FROM sales_returns WHERE id LIKE 'sivtest-%'");
      await pool.query("DELETE FROM sales_invoices WHERE id LIKE 'sivtest-%'");
      await pool.query(`DELETE FROM transaction_logs WHERE product_id = '${PROD}'`);
      await pool.query("DELETE FROM audit_logs WHERE user_email LIKE 'sivtest-%@example.com'");
      await pool.query(`DELETE FROM serial_log WHERE device_serial = '${SERIAL}'`);
      await pool.query("DELETE FROM inventory_stock WHERE product_id LIKE 'sivtest-%'");
      await pool.query("DELETE FROM document_sequence_daily WHERE branch_id = '" + BR + "'");
      await pool.query("DELETE FROM products WHERE id LIKE 'sivtest-%'");
      await pool.query("DELETE FROM branches WHERE id LIKE 'sivtest-%'");
      await pool.end();
    }
  });

  async function post(path: string, body: unknown, token?: string) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  async function stockQty() {
    const r = await pool!.query(
      'SELECT quantity_on_hand AS "qty" FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
      [PROD, BR]
    );
    return Number(r.rows[0]?.qty ?? -1);
  }

  async function invoiceRow(idOrNumber: string) {
    const r = await pool!.query(
      'SELECT id, invoice_number AS "invoiceNumber", status, amount_paid AS "amountPaid" FROM sales_invoices WHERE id = $1 OR invoice_number = $1',
      [idOrNumber]
    );
    return r.rows[0];
  }

  async function serialRow() {
    const r = await pool!.query(
      'SELECT status, customer_id AS "customerId", customer_name AS "customerName", source_type AS "sourceType", history_json AS "history" FROM serial_log WHERE device_serial = $1',
      [SERIAL]
    );
    return r.rows[0];
  }

  async function cancelLedgerRows() {
    const r = await pool!.query(
      `SELECT sum(quantity_changed)::int AS total, count(*)::int AS count
       FROM transaction_logs WHERE change_type = 'SALES_INVOICE_CANCELLED' AND product_id = $1`,
      [PROD]
    );
    return r.rows[0];
  }

  test('post: an invoice with a plain line and a serial line claims stock and serials', { skip: skipPositive }, async () => {
    const { status, json } = await post('/api/sales-invoices', {
      branchId: BR,
      customerName: 'SIV Test Customer',
      invoiceDateAD: todayAD,
      amountPaid: 0,
      paymentMethod: 'CREDIT',
      items: [
        { productId: PROD, productName: 'SIV Test Product', sku: 'SIVSKU', unit: 'Pcs',
          quantity: 2, unitPrice: 100, taxRate: 13, isTaxExempt: false },
        { productId: PROD, productName: 'SIV Test Product', sku: 'SIVSKU', unit: 'Pcs',
          quantity: 1, unitPrice: 100, taxRate: 13, isTaxExempt: false,
          deviceSerials: [{ deviceSerial: SERIAL, ponSerial: PON }] },
      ],
    }, superToken);
    assert.equal(status, 201, JSON.stringify(json));
    invoiceId = json.id;
    invoiceNumber = json.invoiceNumber;
    assert.ok(invoiceNumber, 'invoice number issued');

    assert.equal(await stockQty(), 7, '10 − (2 + 1) sold');
    const serial = await serialRow();
    assert.equal(serial.status, 'CUSTOMER_ASSIGNED');
    assert.equal(serial.sourceType, 'SALES_INVOICE');
    assert.equal(serial.customerName, 'SIV Test Customer');

    const inv = await invoiceRow(invoiceNumber);
    assert.equal(inv.status, 'POSTED');
  });

  test('undo: voiding restores stock, releases the serial and reverses the ledger', { skip: skipPositive }, async () => {
    const { status, json } = await post(`/api/sales-invoices/${encodeURIComponent(invoiceNumber)}/cancel`, {
      reason: 'integration test',
    }, superToken);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.status, 'CANCELLED');

    const inv = await invoiceRow(invoiceNumber);
    assert.equal(inv.status, 'CANCELLED', 'the document itself is marked cancelled');

    assert.equal(await stockQty(), 10, 'every sold unit is back on hand');

    const serial = await serialRow();
    assert.equal(serial.status, 'IN_STOCK', 'the claimed serial is released');
    assert.equal(serial.customerId, null, 'customer stamp cleared');
    assert.equal(serial.customerName, null);
    const history = JSON.parse(serial.history || '[]');
    assert.ok(
      history.some((h: any) => h.status === 'IN_STOCK' && h.sourceType === 'SALES_INVOICE_CANCELLED'),
      'the release is recorded in the serial history'
    );

    const ledger = await cancelLedgerRows();
    assert.equal(Number(ledger.count), 2, 'one compensating row per line');
    assert.equal(Number(ledger.total), 3, '+2 and +1 net the original −3 back to zero');

    const saleRows = await pool!.query(
      `SELECT sum(quantity_changed)::int AS total FROM transaction_logs
       WHERE change_type = 'SALES_INVOICE' AND reference_doc_id = $1`,
      [invoiceNumber]
    );
    assert.equal(Number(saleRows.rows[0].total), -3, 'the original sale rows are untouched');
    assert.equal(Number(ledger.total) + Number(saleRows.rows[0].total), 0, 'ledger nets to zero');
  });

  test('guard: a second void is 400 and changes nothing', { skip: skipPositive }, async () => {
    const { status, json } = await post(`/api/sales-invoices/${encodeURIComponent(invoiceNumber)}/cancel`, {}, superToken);
    assert.equal(status, 400);
    assert.match(String(json?.message), /already cancelled/i);
    assert.equal(await stockQty(), 10, 'no double restock');
    const ledger = await cancelLedgerRows();
    assert.equal(Number(ledger.count), 2, 'no duplicate ledger rows');
  });

  test('guard: unknown id -> 404, no token -> 401, a role without the permission -> 403', { skip: skipPositive }, async () => {
    assert.equal((await post('/api/sales-invoices/sivtest-nope/cancel', {}, superToken)).status, 404);
    assert.equal((await post(`/api/sales-invoices/${encodeURIComponent(invoiceNumber)}/cancel`, {})).status, 401);
    assert.equal((await post(`/api/sales-invoices/${encodeURIComponent(invoiceNumber)}/cancel`, {}, auditorToken)).status, 403);
    assert.equal(await stockQty(), 10, 'rejected calls touch nothing');
  });

  test('guard: an invoice with a posted customer payment cannot be voided', { skip: skipPositive }, async () => {
    const id = 'sivtest-inv-paid';
    await pool!.query(
      `INSERT INTO sales_invoices (id, invoice_number, customer_name, branch_id, invoice_date_ad, invoice_date_bs,
         grand_total, amount_paid, status, items)
       VALUES ($1, 'SIVTEST-PAID-1', 'SIV Paid Customer', $2, $3, 'BS', 100, 50, 'POSTED', '[]'::jsonb)`,
      [id, BR, todayAD]
    );
    await pool!.query(
      `INSERT INTO customer_payments (id, payment_number, customer_name, branch_id, invoice_id, invoice_number,
         payment_date_ad, amount, status)
       VALUES ($1, 'SIVTEST-CR-1', 'SIV Paid Customer', $2, $3, 'SIVTEST-PAID-1', $4, 50, 'POSTED')`,
      ['sivtest-pay-1', BR, id, todayAD]
    );

    const { status, json } = await post('/api/sales-invoices/' + id + '/cancel', {}, superToken);
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(String(json?.message), /posted customer payment/i);
    assert.equal((await invoiceRow(id)).status, 'POSTED', 'the invoice stays posted');
  });

  test('guard: cash already received on the invoice blocks the void', { skip: skipPositive }, async () => {
    const id = 'sivtest-inv-cash';
    await pool!.query(
      `INSERT INTO sales_invoices (id, invoice_number, customer_name, branch_id, invoice_date_ad, invoice_date_bs,
         grand_total, amount_paid, status, items)
       VALUES ($1, 'SIVTEST-CASH-1', 'SIV Cash Customer', $2, $3, 'BS', 100, 100, 'POSTED', '[]'::jsonb)`,
      [id, BR, todayAD]
    );
    const { status, json } = await post('/api/sales-invoices/' + id + '/cancel', {}, superToken);
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(String(json?.message), /already been received/i);
    assert.equal((await invoiceRow(id)).status, 'POSTED');
  });

  test('guard: an invoice with a live credit note cannot be voided', { skip: skipPositive }, async () => {
    const id = 'sivtest-inv-ret';
    await pool!.query(
      `INSERT INTO sales_invoices (id, invoice_number, customer_name, branch_id, invoice_date_ad, invoice_date_bs,
         grand_total, amount_paid, status, items)
       VALUES ($1, 'SIVTEST-RET-1', 'SIV Return Customer', $2, $3, 'BS', 100, 0, 'POSTED', '[]'::jsonb)`,
      [id, BR, todayAD]
    );
    await pool!.query(
      `INSERT INTO sales_returns (id, return_number, original_invoice_id, original_invoice_number, customer_name,
         branch_id, return_date_ad, return_date_bs, status, items)
       VALUES ($1, 'SIVTEST-CN-1', $2, 'SIVTEST-RET-1', 'SIV Return Customer', $3, $4, 'BS', 'POSTED', '[]'::jsonb)`,
      ['sivtest-ret-1', id, BR, todayAD]
    );

    const { status, json } = await post('/api/sales-invoices/' + id + '/cancel', {}, superToken);
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(String(json?.message), /sales return/i);
    assert.equal((await invoiceRow(id)).status, 'POSTED');
  });
});
