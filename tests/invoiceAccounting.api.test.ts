/**
 * Invoice → ledger integration, driven through the real HTTP routes against
 * PostgreSQL.
 *
 * This is the gate for the pass that made the ledger matter: until an invoice
 * writes a journal, the accounting module is only exercised by manual entries.
 * The claims pinned here are transactional, so repository-level tests cannot
 * see a half-written document:
 *
 *   1. a purchase bill debits inventory + input VAT and credits AP, and raises
 *      the moving weighted-average cost by the bill's actual unit price;
 *   2. a sales invoice debits AR at the grand total, credits revenue + output
 *      VAT, and expenses COGS / relieves inventory at that weighted average;
 *   3. the invoice's customer/supplier subledger rows reconcile to the control
 *      account, and the create audit row commits with the invoice;
 *   4. voiding the sales invoice posts a linked contra journal, so every
 *      control balance returns to zero without deleting the original rows;
 *   5. deleting the purchase bill does the same for inventory/VAT/AP and
 *      rewinds the average cost;
 *   6. a journal rejected after the document writes (the ledger amount limit)
 *      rolls the invoice, stock, journal and audit row all back together.
 *
 * The last case is deliberately NOT a missing-default manipulation: the chart
 * is shared by every suite in the run, so disabling a posting role here could
 * fail an unrelated invoice test running in parallel. Missing defaults are
 * still refused by the same service and covered by the chart/role validation in
 * accounting.api.test.ts.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';
import { ensureReferenceData } from './fixtures/referenceData';
import { postSalesInvoiceLedger } from '../server/src/services/invoicePosting.service';

dotenv.config();

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const BR = 'ia-branch';
const PRODUCT = 'ia-prod';
const FAIL_PRODUCT = 'ia-fail-prod';
const today = new Date().toISOString().split('T')[0];

const ADMIN = {
  id: 'ia-admin',
  email: 'ia-admin@example.com',
  name: 'IA Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('invoice ledger posting (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);
  let arAccountId = '';

  async function request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: 'Bearer ' + token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON is itself a finding */ }
    return { status: res.status, json };
  }

  const get = (path: string) => request('GET', path);
  const post = (path: string, body: unknown) => request('POST', path, body);
  const del = (path: string) => request('DELETE', path);

  async function cleanup() {
    // Journals first: their branch FK blocks deleting the test branch.
    await pool!.query("DELETE FROM gl_journals WHERE source_id LIKE 'ia-%'");
    await pool!.query("DELETE FROM sales_invoices WHERE id LIKE 'ia-%'");
    await pool!.query("DELETE FROM purchase_invoices WHERE id LIKE 'ia-%'");
    await pool!.query("DELETE FROM customer_records WHERE id LIKE 'ia-%'");
    await pool!.query("DELETE FROM inventory_stock WHERE product_id LIKE 'ia-%'");
    await pool!.query("DELETE FROM transaction_logs WHERE product_id LIKE 'ia-%'");
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%IA-SI-%' OR details LIKE '%IA-PI-%'");
    await pool!.query("DELETE FROM products WHERE id LIKE 'ia-%'");
    await pool!.query('DELETE FROM branches WHERE id = $1', [BR]);
  }

  async function journalFor(sourceType: string, sourceId: string) {
    const { rows } = await pool!.query(
      `SELECT id, journal_no AS "journalNo", status, branch_id AS "branchId",
              source_type AS "sourceType", source_id AS "sourceId",
              reversal_of_id AS "reversalOfId", journal_date_ad AS "journalDateAD"
         FROM gl_journals
        WHERE source_type = $1 AND source_id = $2
        ORDER BY posted_at ASC, journal_no ASC`,
      [sourceType, sourceId]
    );
    return rows;
  }

  async function journalLines(journalId: string) {
    const { rows } = await pool!.query(
      `SELECT a.code, a.name, l.debit::numeric AS debit, l.credit::numeric AS credit
         FROM gl_journal_lines l
         JOIN gl_accounts a ON a.id = l.account_id
        WHERE l.journal_id = $1
        ORDER BY l.line_no ASC`,
      [journalId]
    );
    return rows.map((row) => ({ ...row, debit: Number(row.debit), credit: Number(row.credit) }));
  }

  async function journalTotals(journalId: string) {
    const { rows } = await pool!.query(
      `SELECT COALESCE(SUM(debit), 0)::numeric AS debit, COALESCE(SUM(credit), 0)::numeric AS credit
         FROM gl_journal_lines WHERE journal_id = $1`,
      [journalId]
    );
    return { debit: Number(rows[0]?.debit || 0), credit: Number(rows[0]?.credit || 0) };
  }

  async function subledgerRows(journalId: string) {
    const { rows } = await pool!.query(
      `SELECT subledger_type AS "subledgerType", party_id AS "partyId", party_name AS "partyName",
              debit::numeric AS debit, credit::numeric AS credit
         FROM gl_subledger_entries
        WHERE journal_id = $1
        ORDER BY created_at ASC`,
      [journalId]
    );
    return rows.map((row) => ({ ...row, debit: Number(row.debit), credit: Number(row.credit) }));
  }

  async function reconcile(accountId: string) {
    const res = await get(`/api/accounting/reconciliations?accountId=${encodeURIComponent(accountId)}&branchId=${BR}`);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json;
  }

  function invoiceLine(overrides: Record<string, any> = {}) {
    return {
      productId: PRODUCT,
      productName: 'IA Router',
      sku: 'IA-SKU',
      unit: 'Pcs',
      quantity: 1,
      unitPrice: 100,
      discount: 0,
      taxRate: 13,
      isTaxExempt: false,
      ...overrides,
    };
  }

  before(async () => {
    await ensureReferenceData(pool!, today);
    await cleanup();

    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'IAB', 'IA Ledger Branch', 'Test')`,
      [BR]
    );
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, status)
       VALUES ('ia-customer', 'ia-customer', 'IA Customer', '9800000000', $1, 'ACTIVE')`,
      [BR]
    );
    for (const [id, sku, name] of [
      [PRODUCT, 'IA-SKU', 'IA Router'],
      [FAIL_PRODUCT, 'IA-FAIL-SKU', 'IA Ledger-Limit Router'],
    ]) {
      await pool!.query(
        `INSERT INTO products
          (id, name, sku, category, product_group, unit, cost_price, selling_price,
           requires_serial_tracking, tracking_type)
         VALUES ($1, $2, $3, 'Equipment', 'Product Item', 'Pcs', 90, 150, FALSE, 'QUANTITY_ONLY')`,
        [id, name, sku]
      );
    }
    // The failing invoice needs enough stock for its 1000-unit line. Its
    // average cost is deliberately positive so a rollback that loses the stock
    // value would be visible.
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, average_cost, min_reorder_level)
       VALUES ('stk-ia-fail', $1, $2, 1000, 10, 1)`,
      [FAIL_PRODUCT, BR]
    );

    const ar = await pool!.query("SELECT id FROM gl_accounts WHERE posting_role = 'AR_CONTROL' AND is_active = TRUE LIMIT 1");
    arAccountId = ar.rows[0]?.id;
    assert.ok(arAccountId, 'the default chart must expose an AR control account');

    const matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    setPermissionMatrix(matrix);

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
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('a purchase bill posts inventory + input VAT / AP and sets weighted-average cost', async () => {
    const res = await post('/api/purchase-invoices', {
      id: 'ia-pi-1',
      invoiceNumber: 'IA-PI-1',
      branchId: BR,
      invoiceDateAD: today,
      supplierName: 'IA Supplier',
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      // A bill-level discount must lower the capitalised stock value, not just
      // the AP total: 1000 gross − 100 discount = 900 net, VAT 117, AP 1017.
      totalDiscount: 100,
      items: [invoiceLine({ quantity: 10, unitPrice: 100 })],
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.grandTotal, 1017, 'the existing response body is unchanged');
    assert.equal(res.json.vatAmount, 117);

    const stock = await pool!.query(
      "SELECT quantity_on_hand::int AS qty, average_cost::numeric AS avg FROM inventory_stock WHERE product_id = $1 AND branch_id = $2",
      [PRODUCT, BR]
    );
    assert.equal(stock.rows[0].qty, 10);
    assert.equal(Number(stock.rows[0].avg), 90, 'the moving average is the net cost after the bill discount');

    const [journal] = await journalFor('PURCHASE_INVOICE', 'ia-pi-1');
    assert.ok(journal, 'the bill must write a journal in its own transaction');
    assert.equal(journal.status, 'POSTED');
    assert.equal(journal.branchId, BR);
    const totals = await journalTotals(journal.id);
    assert.equal(totals.debit, 1017);
    assert.equal(totals.credit, 1017);

    const lines = await journalLines(journal.id);
    const inventory = lines.find((line) => line.code === '1200');
    const inputVat = lines.find((line) => line.code === '1300');
    const payable = lines.find((line) => line.code === '2100');
    assert.equal(inventory?.debit, 900, 'inventory is debited at the net bill value');
    assert.equal(inputVat?.debit, 117);
    assert.equal(payable?.credit, 1017, 'AP is credited at the grand total');

    const subledger = await subledgerRows(journal.id);
    assert.equal(subledger.length, 1);
    assert.equal(subledger[0].subledgerType, 'SUPPLIER');
    assert.equal(subledger[0].partyName, 'IA Supplier');
    assert.equal(subledger[0].credit, 1017);

    const audit = await pool!.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'CREATE_PURCHASE_INVOICE' AND details LIKE '%IA-PI-1%'"
    );
    assert.equal(Number(audit.rows[0].n), 1, 'the create audit row commits with the bill');
  });

  test('a sales invoice posts AR / revenue / output VAT and COGS at weighted-average cost', async () => {
    const res = await post('/api/sales-invoices', {
      id: 'ia-si-1',
      invoiceNumber: 'IA-SI-1',
      customerId: 'ia-customer',
      customerName: 'IA Customer',
      branchId: BR,
      invoiceDateAD: today,
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      items: [invoiceLine({ quantity: 2, unitPrice: 150 })],
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.grandTotal, 339, 'the existing response body is unchanged');

    const stock = await pool!.query(
      "SELECT quantity_on_hand::int AS qty, average_cost::numeric AS avg FROM inventory_stock WHERE product_id = $1 AND branch_id = $2",
      [PRODUCT, BR]
    );
    assert.equal(stock.rows[0].qty, 8);
    assert.equal(Number(stock.rows[0].avg), 90);

    const [journal] = await journalFor('SALES_INVOICE', 'ia-si-1');
    assert.ok(journal, 'the invoice must write a journal in its own transaction');
    assert.equal(journal.status, 'POSTED');
    assert.equal(journal.branchId, BR);
    const totals = await journalTotals(journal.id);
    assert.equal(totals.debit, 519, 'AR 339 + COGS 180');
    assert.equal(totals.credit, 519, 'revenue 300 + VAT 39 + inventory 180');

    const lines = await journalLines(journal.id);
    assert.equal(lines.find((line) => line.code === '1100')?.debit, 339);
    assert.equal(lines.find((line) => line.code === '4000')?.credit, 300);
    assert.equal(lines.find((line) => line.code === '2200')?.credit, 39);
    assert.equal(lines.find((line) => line.code === '5000')?.debit, 180, '2 × 90 weighted average');
    assert.equal(lines.find((line) => line.code === '1200')?.credit, 180);

    const subledger = await subledgerRows(journal.id);
    assert.equal(subledger.length, 1);
    assert.equal(subledger[0].subledgerType, 'CUSTOMER');
    assert.equal(subledger[0].partyId, 'ia-customer');
    assert.equal(subledger[0].debit, 339);

    const reconciled = await reconcile(arAccountId);
    assert.equal(reconciled.glBalance, 339);
    assert.equal(reconciled.subledgerBalance, 339);
    assert.equal(reconciled.difference, 0);
    assert.equal(reconciled.status, 'RECONCILED');

    const audit = await pool!.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'CREATE_SALES_INVOICE' AND details LIKE '%IA-SI-1%'"
    );
    assert.equal(Number(audit.rows[0].n), 1, 'the create audit row commits with the invoice');
  });

  test('voiding the sales invoice posts a linked contra journal and zeroes the control account', async () => {
    const res = await post('/api/sales-invoices/ia-si-1/cancel', { reason: 'IA reversal test' });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.status, 'CANCELLED');

    const originals = await journalFor('SALES_INVOICE', 'ia-si-1');
    const reversals = await journalFor('SALES_INVOICE_REVERSAL', 'ia-si-1');
    assert.equal(originals.length, 1);
    assert.equal(reversals.length, 1);
    assert.equal(originals[0].status, 'POSTED', 'the original rows stay for the audit trail');
    assert.equal(reversals[0].status, 'POSTED');
    assert.equal(reversals[0].reversalOfId, originals[0].id);

    const originalLines = await journalLines(originals[0].id);
    const reversalLines = await journalLines(reversals[0].id);
    assert.equal(reversalLines.length, originalLines.length);
    const ar = reversalLines.find((line) => line.code === '1100');
    assert.equal(ar?.credit, 339, 'the contra journal swaps debit and credit');
    assert.equal(reversalLines.find((line) => line.code === '5000')?.credit, 180);

    const reversalSubledger = await subledgerRows(reversals[0].id);
    assert.equal(reversalSubledger[0].subledgerType, 'CUSTOMER');
    assert.equal(reversalSubledger[0].partyId, 'ia-customer');
    assert.equal(reversalSubledger[0].credit, 339);

    const reconciled = await reconcile(arAccountId);
    assert.equal(reconciled.glBalance, 0);
    assert.equal(reconciled.subledgerBalance, 0);
    assert.equal(reconciled.difference, 0);
    assert.equal(reconciled.status, 'RECONCILED');

    const stock = await pool!.query(
      "SELECT quantity_on_hand::int AS qty FROM inventory_stock WHERE product_id = $1 AND branch_id = $2",
      [PRODUCT, BR]
    );
    assert.equal(stock.rows[0].qty, 10, 'the void restored every sold unit');
  });

  test('deleting the purchase bill reverses its journal and rewinds the average cost', async () => {
    const res = await del('/api/purchase-invoices/ia-pi-1');
    assert.equal(res.status, 200, JSON.stringify(res.json));

    const originals = await journalFor('PURCHASE_INVOICE', 'ia-pi-1');
    const reversals = await journalFor('PURCHASE_INVOICE_REVERSAL', 'ia-pi-1');
    assert.equal(originals.length, 1);
    assert.equal(reversals.length, 1);
    assert.equal(reversals[0].reversalOfId, originals[0].id);

    const stock = await pool!.query(
      "SELECT quantity_on_hand::int AS qty, average_cost::numeric AS avg FROM inventory_stock WHERE product_id = $1 AND branch_id = $2",
      [PRODUCT, BR]
    );
    assert.equal(stock.rows[0].qty, 0);
    assert.equal(Number(stock.rows[0].avg), 0, 'the last removal resets the average instead of keeping a stale cost');

    const inventoryBalance = await pool!.query(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0)::numeric AS balance
         FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.account_id
        WHERE a.code = '1200' AND l.branch_id = $1`,
      [BR]
    );
    assert.equal(Number(inventoryBalance.rows[0].balance), 0);

    const ap = await pool!.query("SELECT id FROM gl_accounts WHERE posting_role = 'AP_CONTROL' AND is_active = TRUE LIMIT 1");
    const reconciled = await reconcile(ap.rows[0].id);
    assert.equal(reconciled.glBalance, 0);
    assert.equal(reconciled.subledgerBalance, 0);
    assert.equal(reconciled.difference, 0);
  });

  test('a missing posting default refuses the posting and names every missing role', async () => {
    // A fake client returning no accounts isolates the configuration refusal:
    // it must happen before any journal/line write, not be a silent skip.
    const emptyChart = { query: async () => ({ rows: [] }) };
    await assert.rejects(
      postSalesInvoiceLedger(emptyChart as any, {
        invoice: {
          id: 'ia-no-chart',
          invoiceNumber: 'IA-NO-CHART',
          branchId: BR,
          invoiceDateAD: today,
          grandTotal: 100,
          vatAmount: 13,
        },
        cogs: [],
      }),
      /no active account has the AR_CONTROL, SALES, TAX_OUTPUT, COGS, INVENTORY posting default/
    );
  });

  test('a posting failure after the document writes rolls the invoice, stock, journal and audit back together', async () => {
    const res = await post('/api/sales-invoices', {
      id: 'ia-si-fail',
      invoiceNumber: 'IA-SI-FAIL',
      customerId: 'ia-customer',
      customerName: 'IA Customer',
      branchId: BR,
      invoiceDateAD: today,
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      items: [invoiceLine({
        productId: FAIL_PRODUCT,
        productName: 'IA Ledger-Limit Router',
        sku: 'IA-FAIL-SKU',
        quantity: 1000,
        unitPrice: 200_000_000,
      })],
    });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.match(String(res.json?.message), /ledger limit/i);

    const invoice = await pool!.query("SELECT count(*)::int AS n FROM sales_invoices WHERE id = 'ia-si-fail'");
    assert.equal(Number(invoice.rows[0].n), 0, 'no half-written invoice may survive');
    const stock = await pool!.query(
      "SELECT quantity_on_hand::int AS qty FROM inventory_stock WHERE product_id = $1 AND branch_id = $2",
      [FAIL_PRODUCT, BR]
    );
    assert.equal(stock.rows[0].qty, 1000, 'the deducted stock was rolled back');
    const journal = await pool!.query("SELECT count(*)::int AS n FROM gl_journals WHERE source_id = 'ia-si-fail'");
    assert.equal(Number(journal.rows[0].n), 0, 'no journal may survive');
    const audit = await pool!.query("SELECT count(*)::int AS n FROM audit_logs WHERE details LIKE '%IA-SI-FAIL%'");
    assert.equal(Number(audit.rows[0].n), 0, 'no audit row may claim the refused invoice was created');
  });
});
