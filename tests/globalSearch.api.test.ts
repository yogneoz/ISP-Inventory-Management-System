/**
 * TRIM-1 — bounded global search over real HTTP + PostgreSQL.
 *
 * The quick-search modal used to filter whole bootstrap slices in the browser.
 * At nationwide scale those slices are unbounded (12k+ customers, thousands of
 * documents a year), so the search is now one branch/FY-scoped server read with
 * a hard per-group cap. This suite pins the parts that matter:
 *
 *   1. auth — no token is 401, a too-short query is 400;
 *   2. a super user finds one row in every group, each capped at 5;
 *   3. a branch role CANNOT widen the search: omitting `branchId` is pinned to
 *      its own branch, and asking for another branch is 403;
 *   4. the fiscal-year header scopes the six groups it applies to;
 *   5. `%`/`_` are escaped, so a wildcard cannot become a full scan;
 *   6. a genuine miss is a 200 with empty groups (not the failure path).
 *
 * Fixtures use the `gsr-` / `GSR` prefixes; node --test runs files in parallel.
 * Skips without a reachable PostgreSQL.
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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const OWN = 'gsr-branch';
const OTHER = 'gsr-branch-other';
const PRODUCT = 'gsr-prod';
const FY = 'gsr-fy';
const FY2 = 'gsr-fy2';
const MATCH = 'GSRMATCH';

const superUser = {
  id: 'gsr-super', email: 'gsr-super@example.com', name: 'GSR Super',
  role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false,
} as any;
const branchUser = {
  id: 'gsr-bm', email: 'gsr-bm@example.com', name: 'GSR Branch Manager',
  role: 'BRANCH_MANAGER', branchId: OWN, allowedBranchIds: [OWN], canSwitchUser: false,
} as any;

describe('TRIM-1 global search', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const superToken = issueAuthToken(superUser);
  const branchToken = issueAuthToken(branchUser);

  before(async () => {
    if (!dbReachable) return;
    await cleanup();

    await pool!.query(
      "INSERT INTO branches (id, code, name, location) VALUES ($1, 'GSRB', 'GSR Branch', 'T'), ($2, 'GSRB2', 'GSR Other', 'T')",
      [OWN, OTHER]
    );
    await pool!.query(
      `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current)
       VALUES ($1, 'GSR 83/84', '2026-07-17', '2027-07-16', '2083-04-01', '2084-03-31', FALSE),
              ($2, 'GSR 84/85', '2027-07-17', '2028-07-16', '2084-04-01', '2085-03-31', FALSE)`,
      [FY, FY2]
    );
    await pool!.query(
      `INSERT INTO products (id, sku, name, category, product_group, selling_price, min_reorder_level)
       VALUES ($1, 'GSRSKU', 'GSR ${MATCH} Router', 'Equipment', 'Product Item', 1500, 5)`,
      [PRODUCT]
    );
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty)
       VALUES ('gsr-stock-own', $1, $2, 7, 0, 0, 0), ('gsr-stock-other', $1, $3, 11, 0, 0, 0)`,
      [PRODUCT, OWN, OTHER]
    );
    await pool!.query(
      `INSERT INTO purchase_orders (id, po_number, supplier_name, branch_id, order_date_ad, order_date_bs, status, total_amount, items, fiscal_year_id)
       VALUES ('gsr-po-own', 'GSR-PO-${MATCH}', 'GSR Supplier', $1, '2026-08-01', '2083-04-17 BS', 'APPROVED', 1500, '[]'::jsonb, $2),
              ('gsr-po-other', 'GSR-PO-OTHER-${MATCH}', 'GSR Supplier', $3, '2026-08-02', '2083-04-18 BS', 'APPROVED', 1500, '[]'::jsonb, $2)`,
      [OWN, FY, OTHER]
    );
    await pool!.query(
      `INSERT INTO purchase_invoices (id, invoice_number, supplier_name, branch_id, invoice_date_ad, invoice_date_bs, grand_total, payment_status, items, fiscal_year_id)
       VALUES ('gsr-inv-own', 'GSR-INV-${MATCH}', 'GSR Supplier', $1, '2026-08-03', '2083-04-19 BS', 1500, 'UNPAID', '[]'::jsonb, $3),
              ('gsr-inv-other', 'GSR-INV-OTHER-${MATCH}', 'GSR Supplier', $2, '2026-08-04', '2083-04-20 BS', 1500, 'UNPAID', '[]'::jsonb, $3),
              ('gsr-inv-fy2', 'GSR-INV-FY2-${MATCH}', 'GSR Supplier', $1, '2027-08-05', '2084-04-21 BS', 1500, 'UNPAID', '[]'::jsonb, $4)`,
      [OWN, OTHER, FY, FY2]
    );
    await pool!.query(
      `INSERT INTO shipments (id, tracking_code, source_branch_id, source_branch_name, destination_branch_id, destination_branch_name, dispatch_date_ad, dispatch_date_bs, status, items, fiscal_year_id)
       VALUES ('gsr-ship-own', 'GSR-SHIP-${MATCH}', $1, 'GSR Branch', $2, 'GSR Other', '2026-08-06', '2083-04-22 BS', 'IN_TRANSIT', '[{"productId":"${PRODUCT}"}]'::jsonb, $3),
              ('gsr-ship-other', 'GSR-SHIP-OTHER-${MATCH}', $2, 'GSR Other', 'BRH01', 'Branch 2', '2026-08-07', '2083-04-23 BS', 'IN_TRANSIT', '[]'::jsonb, $3)`,
      [OWN, OTHER, FY]
    );
    await pool!.query(
      `INSERT INTO fixed_assets (id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs, acquisition_cost, net_book_value, status, fiscal_year_id)
       VALUES ('gsr-asset-own', 'GSR-TAG-${MATCH}', 'GSR Asset ${MATCH}', 'IT Equipment', $1, '2026-08-08', '2083-04-24 BS', 5000, 5000, 'ACTIVE', $3),
              ('gsr-asset-other', 'GSR-TAG-OTHER-${MATCH}', 'GSR Asset Other', 'IT Equipment', $2, '2026-08-09', '2083-04-25 BS', 5000, 5000, 'ACTIVE', $3)`,
      [OWN, OTHER, FY]
    );
    await pool!.query(
      `INSERT INTO customer_device_records (id, customer_name, customer_code, branch_id, product_name, device_serial, pon_serial, status, issued_date_ad, issued_date_bs, fiscal_year_id)
       VALUES ('gsr-dev-own', 'GSR Customer ${MATCH}', 'GSRC-${MATCH}', $1, 'GSR ONU', 'GSR-DEV-${MATCH}', 'GSR-PON-1', 'ACTIVE', '2026-08-10', '2083-04-26 BS', $3),
              ('gsr-dev-other', 'GSR Customer Other', 'GSRC-OTHER-${MATCH}', $2, 'GSR ONU', 'GSR-DEV-OTHER', 'GSR-PON-2', 'ACTIVE', '2026-08-11', '2083-04-27 BS', $3)`,
      [OWN, OTHER, FY]
    );
    // Seven matching POs to prove the per-group cap.
    for (let i = 0; i < 7; i++) {
      await pool!.query(
        `INSERT INTO purchase_orders (id, po_number, supplier_name, branch_id, order_date_ad, order_date_bs, status, total_amount, items, fiscal_year_id)
         VALUES ($1, $2, 'GSR Cap Supplier', $3, '2026-08-12', '2083-04-28 BS', 'APPROVED', 1, '[]'::jsonb, $4)`,
        [`gsr-cap-${i}`, `GSR-CAP-GSRLIMIT-${i}`, OWN, FY]
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
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup() {
    if (!pool) return;
    await pool.query("DELETE FROM customer_device_records WHERE id LIKE 'gsr-%'");
    await pool.query("DELETE FROM fixed_assets WHERE id LIKE 'gsr-%'");
    await pool.query("DELETE FROM shipments WHERE id LIKE 'gsr-%'");
    await pool.query("DELETE FROM purchase_invoices WHERE id LIKE 'gsr-%'");
    await pool.query("DELETE FROM purchase_orders WHERE id LIKE 'gsr-%'");
    await pool.query("DELETE FROM inventory_stock WHERE id LIKE 'gsr-%'");
    await pool.query("DELETE FROM products WHERE id = 'gsr-prod'");
    await pool.query("DELETE FROM branches WHERE id LIKE 'gsr-%'");
    await pool.query("DELETE FROM fiscal_years WHERE id LIKE 'gsr-%'");
  }

  async function search(
    query: string,
    options: { token?: string; branchId?: string; fiscalYearId?: string } = {}
  ) {
    const params = new URLSearchParams({ q: query });
    if (options.branchId !== undefined) params.set('branchId', options.branchId);
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = 'Bearer ' + options.token;
    if (options.fiscalYearId) headers['x-fiscal-year-id'] = options.fiscalYearId;
    const res = await fetch(`http://127.0.0.1:${port}/api/global-search?${params.toString()}`, { headers });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON is a finding */ }
    return { status: res.status, json };
  }

  test('401 without a token and 400 for a one-character query', { skip: skipNoDb }, async () => {
    const anonymous = await search('GSR');
    assert.equal(anonymous.status, 401);
    const tooShort = await search('G', { token: superToken });
    assert.equal(tooShort.status, 400);
    assert.match(String(tooShort.json?.message), /at least 2 characters/);
  });

  test('a super user finds one row per group, each capped at five', { skip: skipNoDb }, async () => {
    const { status, json } = await search(MATCH, { token: superToken });
    assert.equal(status, 200, JSON.stringify(json));
    const r = json.results;
    assert.equal(r.products.length, 1);
    assert.equal(r.purchaseOrders.length, 2, 'own + other branch, both visible to a global role');
    assert.equal(r.invoices.length, 3, 'own + other + the own-branch FY2 invoice');
    assert.equal(r.shipments.length, 2);
    assert.equal(r.assets.length, 2);
    assert.equal(r.customerDevices.length, 2);
    assert.equal(r.products[0].stockQty, 18, 'ALL-branch stock is summed server-side');
    assert.equal(json.total, 12);

    const capped = await search('GSRLIMIT', { token: superToken });
    assert.equal(capped.status, 200);
    assert.equal(capped.json.results.purchaseOrders.length, 5, 'the per-group cap is 5');
    assert.equal(capped.json.limit, 5);
  });

  test('a branch role cannot widen the search by omitting branchId, and is 403 for another branch', { skip: skipNoDb }, async () => {
    const ownOnly = await search(MATCH, { token: branchToken });
    assert.equal(ownOnly.status, 200, JSON.stringify(ownOnly.json));
    const r = ownOnly.json.results;
    assert.equal(r.purchaseOrders.length, 1, 'only the own-branch PO');
    assert.equal(r.invoices.length, 2, 'own + own-branch FY2 invoice (no FY header = all years)');
    assert.equal(r.assets.length, 1);
    assert.equal(r.customerDevices.length, 1);
    assert.equal(r.products[0].stockQty, 7, 'the product quantity is the role branch’s stock');

    const widened = await search(MATCH, { token: branchToken, branchId: OTHER });
    assert.equal(widened.status, 403, 'a branch role must not read another branch');
    // Refused by enforceBranchAccess before the controller (defence in depth);
    // the controller has its own identical refusal for direct handler calls.
    assert.match(String(widened.json?.message), /not authorized/);
  });

  test('the fiscal-year header scopes the six growing groups', { skip: skipNoDb }, async () => {
    const current = await search('GSR-INV', { token: superToken, fiscalYearId: FY });
    assert.equal(current.status, 200);
    assert.equal(current.json.results.invoices.length, 2, 'own + other in this year');

    const nextYear = await search('GSR-INV', { token: superToken, fiscalYearId: FY2 });
    assert.equal(nextYear.status, 200);
    assert.equal(nextYear.json.results.invoices.length, 1, 'only the FY2 invoice');
    assert.equal(nextYear.json.results.invoices[0].id, 'gsr-inv-fy2');
  });

  test('LIKE wildcards are escaped and a genuine miss returns empty groups', { skip: skipNoDb }, async () => {
    const wildcard = await search('GSR%', { token: superToken });
    assert.equal(wildcard.status, 200);
    assert.equal(wildcard.json.results.purchaseOrders.length, 0, '% must be a literal, not a scan');
    assert.equal(wildcard.json.results.invoices.length, 0);
    assert.equal(wildcard.json.results.customerDevices.length, 0);

    const miss = await search('GSR-NOTHING-MATCHES-THIS', { token: superToken });
    assert.equal(miss.status, 200);
    assert.equal(miss.json.total, 0);
    assert.deepEqual(miss.json.results.products, []);
    assert.equal(typeof miss.json.query, 'string');
  });
});
