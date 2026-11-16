/**
 * SCALE-2 remaining registers — real HTTP page walks with concurrent inserts.
 *
 * PROVES, against PostgreSQL and the production Express wiring:
 *  1. purchase-returns and sales-returns page by signed cursor, not OFFSET;
 *  2. stock-operations pages the pullout and damage+disposal registers;
 *  3. a customer-scoped sales-invoice read (the CustomerLedger receipt picker)
 *     pages by cursor;
 *  4. for every read, a newer row inserted between pages is never leaked into
 *     a later page, every pre-existing row is returned exactly once, and the
 *     walk terminates with nextCursor=null / hasMore=false;
 *  5. an unscoped cursor request is SCOPE_REQUIRED and a tampered cursor is a
 *     400 INVALID_CURSOR.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';

dotenv.config();

const BRANCH = 's2r-br';
const CUSTOMER = 's2r-cust';
const BASE = Date.parse('2026-01-10T10:00:00.000Z');
const COUNT = 45;

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const SUPER_USER = {
  id: 's2r-super', email: 's2r-super@example.com', name: 'S2R Super',
  role: 'SUPER_ADMIN', branchId: BRANCH,
  allowedBranchIds: [BRANCH], canSwitchUser: false,
} as any;

const stamp = (i: number) => new Date(BASE - i * 1000);

async function cleanup(db: pg.Pool | pg.Client) {
  await db.query('DELETE FROM sales_invoices WHERE id LIKE $1', ['s2r-si-%']);
  await db.query('DELETE FROM sales_returns WHERE id LIKE $1', ['s2r-sr-%']);
  await db.query('DELETE FROM purchase_returns WHERE id LIKE $1', ['s2r-pr-%']);
  await db.query('DELETE FROM stock_operations WHERE id LIKE $1', ['s2r-op-%']);
  await db.query('DELETE FROM customer_records WHERE id = $1', [CUSTOMER]);
  await db.query('DELETE FROM branches WHERE id = $1', [BRANCH]);
}

describe('SCALE-2 remaining register cursors', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(SUPER_USER);

  before(async () => {
    if (!dbReachable || !pool) return;
    await cleanup(pool);
    await pool.query(
      "INSERT INTO branches (id, code, name, location) VALUES ($1, 'S2R', 'S2R Branch', 'Test')",
      [BRANCH]
    );
    await pool.query(
      `INSERT INTO customer_records
         (id, customer_id, customer_name, username, contact_number, branch_id)
       VALUES ($1, 'S2R-CUST', 'S2R Customer', 's2r-customer', '9800000099', $2)`,
      [CUSTOMER, BRANCH]
    );

    for (let i = 0; i < COUNT; i += 1) {
      const id = `s2r-sr-${String(i).padStart(3, '0')}`;
      await pool.query(
        `INSERT INTO sales_returns
           (id, return_number, customer_name, branch_id, return_date_ad, return_date_bs, status, created_at)
         VALUES ($1, $2, 'S2R Customer', $3, '2026-01-10', '2082-09-26', 'POSTED', $4)`,
        [id, `S2R-CN-${i}`, BRANCH, stamp(i)]
      );
      const pid = `s2r-pr-${String(i).padStart(3, '0')}`;
      await pool.query(
        `INSERT INTO purchase_returns
           (id, return_number, supplier_name, branch_id, return_date_ad, return_date_bs, status, created_at)
         VALUES ($1, $2, 'S2R Supplier', $3, '2026-01-10', '2082-09-26', 'POSTED', $4)`,
        [pid, `S2R-DN-${i}`, BRANCH, stamp(i)]
      );
      const sid = `s2r-si-${String(i).padStart(3, '0')}`;
      await pool.query(
        `INSERT INTO sales_invoices
           (id, invoice_number, customer_id, customer_name, branch_id,
            invoice_date_ad, invoice_date_bs, status, grand_total, amount_paid, created_at)
         VALUES ($1, $2, $3, 'S2R Customer', $4, '2026-01-10', '2082-09-26', 'POSTED', 100, 0, $5)`,
        [sid, `S2R-INV-${i}`, CUSTOMER, BRANCH, stamp(i)]
      );
      const oid = `s2r-op-${String(i).padStart(3, '0')}`;
      const type = i % 2 === 0 ? 'PULLOUT' : i % 4 === 1 ? 'DAMAGE' : 'DISPOSAL';
      await pool.query(
        `INSERT INTO stock_operations
           (id, reference_number, type, branch_id, quantity_changed, reason, date_ad, date_bs, status, created_at)
         VALUES ($1, $2, $3, $4, -1, 'S2R fixture', '2026-01-10', '2082-09-26', 'LOGGED', $5)`,
        [oid, `S2R-OP-${i}`, type, BRANCH, stamp(i)]
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
      await cleanup(pool);
      await pool.end();
    }
  });

  async function get(path: string, withToken = true) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: withToken ? { authorization: `Bearer ${token}` } : {},
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* a non-JSON body is a finding */ }
    return { status: res.status, json };
  }

  function assertPage(body: any) {
    assert.ok(body && Array.isArray(body.items), 'cursor response must carry items: ' + JSON.stringify(body).slice(0, 160));
    assert.equal(body.items.length, body.data.length);
    assert.ok(body.items.length <= 10, 'the page never exceeds its limit');
    assert.equal(typeof body.hasMore, 'boolean');
  }

  async function walk(label: string, basePath: string) {
    const first = await get(`${basePath}&limit=10`);
    assert.equal(first.status, 200, `${label}: ${JSON.stringify(first.json)}`);
    assertPage(first.json);

    // A row newer than every fixture and a same-timestamp row that sorts after
    // the cursor both land between page 1 and page 2.
    const last = first.json.items[first.json.items.length - 1];
    const idPrefix = label === 'stock-pullout' || label === 'stock-damage'
      ? 's2r-op'
      : label === 'customer-invoices' ? 's2r-si' : label === 'sales-returns' ? 's2r-sr' : 's2r-pr';
    const newerId = `${idPrefix}-zzz-newer-${label}`;
    const tieId = newerId.replace('-newer', '-tie');
    if (label.startsWith('stock-')) {
      await pool!.query(
        `INSERT INTO stock_operations
           (id, reference_number, type, branch_id, quantity_changed, reason, date_ad, date_bs, status, created_at)
         VALUES ($1, $2, $3, $4, -1, 'concurrent', '2026-01-11', '2082-09-27', 'LOGGED', $5)`,
        [newerId, `S2R-${newerId}`, label === 'stock-pullout' ? 'PULLOUT' : 'DAMAGE', BRANCH, new Date(BASE + 86_400_000)]
      );
      await pool!.query(
        `INSERT INTO stock_operations
           (id, reference_number, type, branch_id, quantity_changed, reason, date_ad, date_bs, status, created_at)
         VALUES ($1, $2, $3, $4, -1, 'concurrent tie', '2026-01-11', '2082-09-27', 'LOGGED', $5)`,
        [tieId, `S2R-${tieId}`, label === 'stock-pullout' ? 'PULLOUT' : 'DAMAGE', BRANCH, new Date(last.createdAt)]
      );
    } else if (label === 'customer-invoices') {
      await pool!.query(
        `INSERT INTO sales_invoices
           (id, invoice_number, customer_id, customer_name, branch_id,
            invoice_date_ad, invoice_date_bs, status, grand_total, amount_paid, created_at)
         VALUES ($1, $2, $3, 'S2R Customer', $4, '2026-01-11', '2082-09-27', 'POSTED', 100, 0, $5)`,
        [newerId, `S2R-${newerId}`, CUSTOMER, BRANCH, new Date(BASE + 86_400_000)]
      );
      await pool!.query(
        `INSERT INTO sales_invoices
           (id, invoice_number, customer_id, customer_name, branch_id,
            invoice_date_ad, invoice_date_bs, status, grand_total, amount_paid, created_at)
         VALUES ($1, $2, $3, 'S2R Customer', $4, '2026-01-11', '2082-09-27', 'POSTED', 100, 0, $5)`,
        [tieId, `S2R-${tieId}`, CUSTOMER, BRANCH, new Date(last.createdAt)]
      );
    } else {
      const table = label === 'sales-returns' ? 'sales_returns' : 'purchase_returns';
      const prefix = label === 'sales-returns' ? 's2r-sr' : 's2r-pr';
      const numberPrefix = label === 'sales-returns' ? 'S2R-CN-X' : 'S2R-DN-X';
      const partyColumn = label === 'sales-returns' ? 'customer_name' : 'supplier_name';
      await pool!.query(
        `INSERT INTO ${table}
           (id, return_number, ${partyColumn}, branch_id, return_date_ad, return_date_bs, status, created_at)
         VALUES ($1, $2, 'S2R Party', $3, '2026-01-11', '2082-09-27', 'POSTED', $4)`,
        [newerId, `${numberPrefix}-NEW`, BRANCH, new Date(BASE + 86_400_000)]
      );
      await pool!.query(
        `INSERT INTO ${table}
           (id, return_number, ${partyColumn}, branch_id, return_date_ad, return_date_bs, status, created_at)
         VALUES ($1, $2, 'S2R Party', $3, '2026-01-11', '2082-09-27', 'POSTED', $4)`,
        [tieId, `${numberPrefix}-TIE`, BRANCH, new Date(last.createdAt)]
      );
      assert.ok(prefix);
    }

    const seen: string[] = first.json.items.map((row: any) => String(row.id));
    let cursor = first.json.nextCursor;
    let hasMore = first.json.hasMore;
    let pages = 1;
    while (hasMore) {
      assert.ok(cursor, `${label}: hasMore must carry a cursor`);
      const next = await get(`${basePath}&limit=10&cursor=${encodeURIComponent(cursor)}`);
      assert.equal(next.status, 200, `${label} page ${pages + 1}: ${JSON.stringify(next.json)}`);
      assertPage(next.json);
      seen.push(...next.json.items.map((row: any) => String(row.id)));
      cursor = next.json.nextCursor;
      hasMore = next.json.hasMore;
      pages += 1;
      assert.ok(pages < 20, `${label}: pagination did not terminate`);
    }

    assert.equal(cursor, null, `${label}: the final page must end with nextCursor=null`);
    assert.equal(hasMore, false, `${label}: the final page must end with hasMore=false`);
    const unique = new Set(seen);
    assert.equal(unique.size, seen.length, `${label}: duplicate rows across pages`);
    const expected = label === 'stock-pullout'
      ? Array.from({ length: COUNT }, (_, i) => i).filter((i) => i % 2 === 0)
      : label === 'stock-damage'
        ? Array.from({ length: COUNT }, (_, i) => i).filter((i) => i % 2 === 1)
        : Array.from({ length: COUNT }, (_, i) => i);
    for (const i of expected) {
      assert.ok(unique.has(`${idPrefix}-${String(i).padStart(3, '0')}`), `${label}: skipped fixture row ${i}`);
    }
    assert.ok(!unique.has(newerId), `${label}: a row newer than page 1 leaked into a later page`);
    assert.ok(!unique.has(tieId), `${label}: a same-timestamp row after the cursor leaked into a later page`);
  }

  test('purchase-returns walks a branch cursor across an insert boundary', { skip: skipNoDb }, async () => {
    await walk('purchase-returns', `/api/purchase-returns?branchId=${BRANCH}`);
  });

  test('sales-returns walks a branch cursor across an insert boundary', { skip: skipNoDb }, async () => {
    await walk('sales-returns', `/api/sales-returns?branchId=${BRANCH}`);
  });

  test('pullout stock operations walk a cursor across an insert boundary', { skip: skipNoDb }, async () => {
    await walk('stock-pullout', `/api/stock-operations?branchId=${BRANCH}&type=PULLOUT`);
  });

  test('damage+disposal stock operations walk one cursor across an insert boundary', { skip: skipNoDb }, async () => {
    const first = await get(`/api/stock-operations?branchId=${BRANCH}&type=DAMAGE,DISPOSAL&limit=10`);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.ok(first.json.items.every((row: any) => row.type === 'DAMAGE' || row.type === 'DISPOSAL'));
    // The shared walk() above inserts a DAMAGE row, which this type filter owns.
    await walk('stock-damage', `/api/stock-operations?branchId=${BRANCH}&type=DAMAGE,DISPOSAL`);
  });

  test('customer-scoped sales invoices walk a cursor across an insert boundary', { skip: skipNoDb }, async () => {
    await walk('customer-invoices', `/api/sales-invoices?customerId=${CUSTOMER}`);
  });

  test('unscoped and tampered cursor reads are refused', { skip: skipNoDb }, async () => {
    for (const path of [
      '/api/purchase-returns?limit=10',
      '/api/sales-returns?limit=10',
      '/api/stock-operations?limit=10',
      '/api/sales-invoices?limit=10',
    ]) {
      const { status, json } = await get(path);
      assert.equal(status, 400, path);
      assert.equal(json.code, 'SCOPE_REQUIRED', path);
    }
    for (const path of [
      `/api/purchase-returns?branchId=${BRANCH}&cursor=bad`,
      `/api/sales-returns?branchId=${BRANCH}&cursor=bad`,
      `/api/stock-operations?branchId=${BRANCH}&cursor=bad`,
      `/api/sales-invoices?customerId=${CUSTOMER}&cursor=bad`,
    ]) {
      const { status, json } = await get(path);
      assert.equal(status, 400, path);
      assert.equal(json.code, 'INVALID_CURSOR', path);
    }
  });
});
