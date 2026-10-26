/**
 * VOL-2 — sales invoices leave the bootstrap; the Returns register searches
 * them through the paged endpoint instead.
 *
 * The fiscal year's invoices used to arrive in GET /api/bootstrap for two
 * consumers: the Returns create form's `<select>` and the Sales register's
 * failed-fetch fallback. Both are gone — the form searches by invoice number
 * or customer name, and the register keeps its own error/Retry state.
 *
 *  1. SOURCE — the bootstrap controller/repo no longer carry `salesInvoices`,
 *     App holds no such state/prop, ReturnsRegister takes no invoice array and
 *     renders a SearchPicker over `getSalesInvoices`, and the Sales register
 *     has no `invoices` prop or client-side fallback.
 *  2. SEARCH — an invoice outside page 1 (by the server's created_at order) is
 *     still found by number and by customer name, and the row carries its
 *     `items` lines, so the create form can prefill without a second read.
 *  3. PAYLOAD — GET /api/bootstrap omits the key entirely.
 *  4. AUTH — the search endpoint requires a bearer token.
 *
 * Fixtures are `vol2-` invoices created here and removed in after(); the suite
 * skips the HTTP half without a reachable PostgreSQL.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { ensureReferenceData } from './fixtures/referenceData';

dotenv.config();

const ROOT = path.resolve('.');
const PREFIX = 'vol2-';
const BRANCH = 'WH001';

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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const SUPER_USER = {
  id: 'vol2-super', email: 'vol2-super@example.com', name: 'VOL2 Super',
  role: 'SUPER_ADMIN', branchId: BRANCH, allowedBranchIds: [BRANCH], canSwitchUser: false,
} as any;

const INVOICE_COUNT = 8;

async function cleanup(): Promise<void> {
  if (!pool) return;
  await pool.query("DELETE FROM sales_invoices WHERE id LIKE 'vol2-%' OR invoice_number LIKE 'VOL2-%'");
}

describe('VOL-2 — sales-invoice source contract', () => {
  test('the bootstrap and App no longer carry salesInvoices', () => {
    const controller = fs.readFileSync(
      path.join(ROOT, 'server/src/controllers/bootstrap.controller.ts'),
      'utf8'
    );
    const payload = controller.slice(
      controller.lastIndexOf('return res.json({'),
      controller.lastIndexOf('} catch')
    );
    assert.ok(!/salesInvoices\s*:/.test(payload), 'GET /api/bootstrap must not serialize salesInvoices');

    const repo = fs.readFileSync(path.join(ROOT, 'server/src/models/bootstrap.repo.ts'), 'utf8');
    assert.ok(
      !/fetchTable\(pool, BOOTSTRAP_TABLES\.salesInvoices/.test(repo),
      'fetchOperationalData must not read the fiscal year of invoices wholesale'
    );

    const app = fs.readFileSync(path.join(ROOT, 'client/src/App.tsx'), 'utf8');
    assert.ok(!/\[salesInvoices, setSalesInvoices\]/.test(app), 'App must hold no salesInvoices state');
    assert.ok(!/data\.salesInvoices/.test(app), 'the bootstrap handler must not hydrate salesInvoices');
    assert.ok(!/invoices=\{salesInvoices\}/.test(app), 'no screen may receive the bootstrap invoice array');
    assert.ok(
      !/SALES:\s*\[[^\]]*'salesInvoices'/.test(app),
      'the SALES domain must not re-fetch a bootstrap salesInvoices slice'
    );

    const types = fs.readFileSync(path.join(ROOT, 'client/src/types/index.ts'), 'utf8');
    assert.ok(!/salesInvoices\?:/.test(types), 'BootstrapState must not declare a salesInvoices slice');
  });

  test('the returns form searches invoices; the sales register has no array fallback', () => {
    const returns = fs.readFileSync(
      path.join(ROOT, 'client/src/features/sales/ReturnsRegister.tsx'),
      'utf8'
    );
    assert.ok(!/salesInvoices:\s*SalesInvoice\[\]/.test(returns), 'ReturnsRegister must not take an invoice array');
    assert.match(returns, /api\.getSalesInvoices\(/, 'the picker must read the paged endpoint');
    assert.match(returns, /query:\s*q/, 'the picker must search server-side');
    assert.match(returns, /page:\s*1/, 'the picker searches the first result page');
    assert.match(returns, /pageSize:\s*20/, 'the picker fetches a bounded result page');
    assert.match(returns, /<SearchPicker<SalesInvoice>/, 'the sales kind uses the shared searchable picker');
    assert.match(returns, /refreshToken=\{sseRefreshKey\}/, 'a sales event must re-run an open search');
    assert.match(returns, /searchSalesInvoices/, 'the prefill path is fed by the picker result');
    // The purchase kind keeps its own slice; this item must not change it.
    assert.match(returns, /purchaseInvoices\.map/, 'the purchase invoice select is untouched');

    const sales = fs.readFileSync(
      path.join(ROOT, 'client/src/features/sales/SalesInvoices.tsx'),
      'utf8'
    );
    assert.ok(!/invoices:\s*SalesInvoice\[\]/.test(sales), 'SalesInvoices must not take the bootstrap array');
    assert.ok(!/let list = invoices/.test(sales), 'the failed-fetch fallback over the array must be gone');
    assert.match(sales, /const pageRows = siRows;/, 'the register renders the server page only');
    assert.match(sales, /<RegisterLoadError/, 'the failure path keeps its error + Retry notice');
  });
});

describe('VOL-2 — GET /api/sales-invoices search contract', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(SUPER_USER);

  before(async () => {
    if (!dbReachable || !pool) return;
    await cleanup();
    const { adDate, bsDate } = await ensureReferenceData(pool);
    const items = JSON.stringify([
      {
        productId: 'vol2-prod',
        productName: 'VOL2 Fixture Router',
        sku: 'VOL2-SKU',
        unit: 'Pcs',
        quantity: 2,
        unitPrice: 1000,
        taxRate: 13,
        subtotal: 2000,
        taxAmount: 260,
        total: 2260,
      },
    ]);

    for (let n = 1; n <= INVOICE_COUNT; n++) {
      const suffix = String(n).padStart(4, '0');
      // Newest created_at for the highest number, so the lowest number is the
      // one the default page order pushes outside page 1.
      await pool.query(
        `INSERT INTO sales_invoices
           (id, invoice_number, customer_name, branch_id, invoice_date_ad, invoice_date_bs,
            grand_total, payment_status, status, items, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 2260, 'UNPAID', 'POSTED', $7,
                 now() - ($8::int * interval '1 minute'))`,
        [
          `${PREFIX}si-${suffix}`,
          `VOL2-INV-${suffix}`,
          `VOL2 Customer ${suffix}`,
          BRANCH,
          adDate,
          bsDate,
          items,
          INVOICE_COUNT - n,
        ]
      );
    }

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
      await cleanup().catch(() => undefined);
      await pool.end();
    }
  });

  async function get(urlPath: string, authToken?: string) {
    const res = await fetch('http://127.0.0.1:' + port + urlPath, {
      headers: authToken ? { authorization: 'Bearer ' + authToken } : {},
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* a non-JSON body is a finding */ }
    return { status: res.status, json };
  }

  test('GET /api/bootstrap no longer ships the invoice ledger', { skip: skipNoDb }, async () => {
    const { status, json } = await get('/api/bootstrap', token);
    assert.equal(status, 200, 'bootstrap must still answer for a seeded install');
    assert.ok(json && typeof json === 'object', 'bootstrap must return a JSON object');
    assert.ok(!('salesInvoices' in json), 'bootstrap payload still ships salesInvoices');
  });

  test('an invoice outside page 1 is found by number with its lines', { skip: skipNoDb }, async () => {
    const first = await get('/api/sales-invoices?page=1&pageSize=5', token);
    assert.equal(first.status, 200);
    assert.equal(first.json.totalItems >= INVOICE_COUNT, true, 'all fixtures are counted');
    const firstPageIds = first.json.data.map((row: any) => row.invoiceNumber);
    assert.ok(
      !firstPageIds.includes('VOL2-INV-0001'),
      'the oldest fixture must not be on page 1 — otherwise the search proves nothing'
    );

    const found = await get('/api/sales-invoices?query=VOL2-INV-0001&page=1&pageSize=5', token);
    assert.equal(found.status, 200);
    assert.equal(found.json.totalItems, 1);
    assert.equal(found.json.data.length, 1);
    const invoice = found.json.data[0];
    assert.equal(invoice.invoiceNumber, 'VOL2-INV-0001');
    assert.equal(invoice.customerName, 'VOL2 Customer 0001');
    assert.equal(Array.isArray(invoice.items), true, 'the picker must receive the invoice lines');
    assert.equal(invoice.items.length, 1);
    assert.equal(invoice.items[0].productName, 'VOL2 Fixture Router');
    assert.equal(Number(invoice.items[0].quantity), 2);
  });

  test('search also matches the customer name', { skip: skipNoDb }, async () => {
    const found = await get('/api/sales-invoices?query=VOL2%20Customer%200003&page=1&pageSize=5', token);
    assert.equal(found.status, 200);
    assert.equal(found.json.totalItems, 1);
    assert.equal(found.json.data[0].invoiceNumber, 'VOL2-INV-0003');
  });

  test('the old legacy array shape is still what a request without page params gets', { skip: skipNoDb }, async () => {
    const { status, json } = await get('/api/sales-invoices?query=VOL2-INV-0001', token);
    assert.equal(status, 200);
    assert.equal(Array.isArray(json), true, 'an unscoped legacy caller must keep its array response');
    assert.equal(json.length, 1);
  });

  test('the search endpoint requires a bearer token', { skip: skipNoDb }, async () => {
    const { status } = await get('/api/sales-invoices?query=VOL2&page=1&pageSize=5');
    assert.equal(status, 401);
  });
});
