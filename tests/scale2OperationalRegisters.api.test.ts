/**
 * SCALE-2 operational registers — real HTTP page walks with insert boundaries.
 *
 * For fixed assets, warranty coverage, shipments, purchase orders and purchase
 * invoices: a newer row and a same-timestamp tie row inserted after page 1
 * must never leak into later pages, every pre-existing row must appear exactly
 * once, and the walk must terminate at nextCursor=null / hasMore=false. An
 * unscoped cursor request is SCOPE_REQUIRED; a tampered cursor is
 * 400 INVALID_CURSOR.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';

dotenv.config();

const BRANCH = 's3-br';
const BASE = Date.parse('2026-02-10T10:00:00.000Z');
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

const SUPER_USER = {
  id: 's3-super', email: 's3-super@example.com', name: 'S3 Super',
  role: 'SUPER_ADMIN', branchId: BRANCH,
  allowedBranchIds: [BRANCH], canSwitchUser: false,
} as any;

const stamp = (i: number) => new Date(BASE - i * 1000);

async function cleanup(db: pg.Pool | pg.Client) {
  await db.query("DELETE FROM warranty_coverages WHERE id LIKE 's3-wc-%'");
  await db.query("DELETE FROM shipments WHERE id LIKE 's3-sh-%'");
  await db.query("DELETE FROM purchase_invoices WHERE id LIKE 's3-pi-%'");
  await db.query("DELETE FROM purchase_orders WHERE id LIKE 's3-po-%'");
  await db.query("DELETE FROM fixed_assets WHERE id LIKE 's3-fa-%'");
  await db.query('DELETE FROM branches WHERE id = $1', [BRANCH]);
}

describe('SCALE-2 operational register cursors', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(SUPER_USER);

  before(async () => {
    if (!dbReachable || !pool) return;
    await cleanup(pool);
    await pool.query(
      "INSERT INTO branches (id, code, name, location) VALUES ($1, 'S3', 'S3 Branch', 'Test')",
      [BRANCH]
    );

    for (let i = 0; i < COUNT; i += 1) {
      const at = stamp(i);
      await pool.query(
        `INSERT INTO fixed_assets
           (id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs,
            acquisition_cost, net_book_value, status, created_at)
         VALUES ($1, $2, 'S3 Asset', 'IT Equipment', $3, '2026-02-10', '2082-10-27', 100, 100, 'ACTIVE', $4)`,
        [`s3-fa-${String(i).padStart(3, '0')}`, `S3-TAG-${i}`, BRANCH, at]
      );
      await pool.query(
        `INSERT INTO warranty_coverages
           (id, coverage_type, item_category, product_name, serial_number, branch_id,
            party_name, source_type, source_id, source_number,
            start_date_ad, start_date_bs, end_date_ad, end_date_bs,
            term_months, start_basis, is_current, is_demo, created_at)
         VALUES ($1, 'VENDOR', 'CPE', 'S3 CPE', $2, $3, 'S3 Supplier', 'PURCHASE', $1, $1,
           '2026-02-10', '2082-10-27', '2027-02-10', '2083-10-27', 12, 'MANUAL', TRUE, FALSE, $4)`,
        [`s3-wc-${String(i).padStart(3, '0')}`, `S3-SERIAL-${i}`, BRANCH, at]
      );
      await pool.query(
        `INSERT INTO shipments
           (id, tracking_code, type, source_branch_id, source_branch_name,
            destination_branch_id, destination_branch_name, dispatch_date_ad, dispatch_date_bs,
            status, items, created_at)
         VALUES ($1, $2, 'INTER_BRANCH', $3, 'S3 Branch', $3, 'S3 Branch',
           '2026-02-10', '2082-10-27', 'IN_TRANSIT', '[]'::jsonb, $4)`,
        [`s3-sh-${String(i).padStart(3, '0')}`, `S3-TRK-${i}`, BRANCH, at]
      );
      await pool.query(
        `INSERT INTO purchase_orders
           (id, po_number, supplier_name, branch_id, order_date_ad, order_date_bs,
            status, total_amount, items, created_at)
         VALUES ($1, $2, 'S3 Supplier', $3, '2026-02-10', '2082-10-27', 'APPROVED', 100, '[]'::jsonb, $4)`,
        [`s3-po-${String(i).padStart(3, '0')}`, `S3-PO-${i}`, BRANCH, at]
      );
      await pool.query(
        `INSERT INTO purchase_invoices
           (id, invoice_number, supplier_name, branch_id, invoice_date_ad, invoice_date_bs,
            grand_total, payment_status, items, created_at)
         VALUES ($1, $2, 'S3 Supplier', $3, '2026-02-10', '2082-10-27', 100, 'UNPAID', '[]'::jsonb, $4)`,
        [`s3-pi-${String(i).padStart(3, '0')}`, `S3-PI-${i}`, BRANCH, at]
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

  async function get(path: string) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { authorization: `Bearer ${token}` },
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

  async function insertBetween(label: string, last: any) {
    const id = (suffix: string) => `s3-${label}-${suffix}`;
    const created = new Date(BASE + 86_400_000);
    const tie = new Date(last.createdAt);
    if (label === 'fa') {
      for (const [key, at] of [['zzz-newer', created], ['zzz-tie', tie]] as const) {
        await pool!.query(
          `INSERT INTO fixed_assets
             (id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs,
              acquisition_cost, net_book_value, status, created_at)
           VALUES ($1, $2, 'S3 concurrent asset', 'IT Equipment', $3, '2026-02-11', '2082-10-28', 100, 100, 'ACTIVE', $4)`,
          [id(key), `S3-TAG-${key}`, BRANCH, at]
        );
      }
    } else if (label === 'wc') {
      for (const [key, at] of [['zzz-newer', created], ['zzz-tie', tie]] as const) {
        await pool!.query(
          `INSERT INTO warranty_coverages
             (id, coverage_type, item_category, product_name, serial_number, branch_id,
              party_name, source_type, source_id, source_number,
              start_date_ad, start_date_bs, end_date_ad, end_date_bs,
              term_months, start_basis, is_current, is_demo, created_at)
           VALUES ($1, 'VENDOR', 'CPE', 'S3 concurrent CPE', $2, $3, 'S3 Supplier', 'PURCHASE', $1, $1,
             '2026-02-11', '2082-10-28', '2027-02-11', '2083-10-28', 12, 'MANUAL', TRUE, FALSE, $4)`,
          [id(key), `S3-SERIAL-${key}`, BRANCH, at]
        );
      }
    } else if (label === 'sh') {
      for (const [key, at] of [['zzz-newer', created], ['zzz-tie', tie]] as const) {
        await pool!.query(
          `INSERT INTO shipments
             (id, tracking_code, type, source_branch_id, source_branch_name,
              destination_branch_id, destination_branch_name, dispatch_date_ad, dispatch_date_bs,
              status, items, created_at)
           VALUES ($1, $2, 'INTER_BRANCH', $3, 'S3 Branch', $3, 'S3 Branch',
             '2026-02-11', '2082-10-28', 'IN_TRANSIT', '[]'::jsonb, $4)`,
          [id(key), `S3-TRK-${key}`, BRANCH, at]
        );
      }
    } else if (label === 'po') {
      for (const [key, at] of [['zzz-newer', created], ['zzz-tie', tie]] as const) {
        await pool!.query(
          `INSERT INTO purchase_orders
             (id, po_number, supplier_name, branch_id, order_date_ad, order_date_bs,
              status, total_amount, items, created_at)
           VALUES ($1, $2, 'S3 Supplier', $3, '2026-02-11', '2082-10-28', 'APPROVED', 100, '[]'::jsonb, $4)`,
          [id(key), `S3-PO-${key}`, BRANCH, at]
        );
      }
    } else {
      for (const [key, at] of [['zzz-newer', created], ['zzz-tie', tie]] as const) {
        await pool!.query(
          `INSERT INTO purchase_invoices
             (id, invoice_number, supplier_name, branch_id, invoice_date_ad, invoice_date_bs,
              grand_total, payment_status, items, created_at)
           VALUES ($1, $2, 'S3 Supplier', $3, '2026-02-11', '2082-10-28', 100, 'UNPAID', '[]'::jsonb, $4)`,
          [id(key), `S3-PI-${key}`, BRANCH, at]
        );
      }
    }
  }

  async function walk(label: string, basePath: string, prefix: string) {
    const first = await get(`${basePath}&limit=10`);
    assert.equal(first.status, 200, `${label}: ${JSON.stringify(first.json)}`);
    assertPage(first.json);
    const all: any[] = first.json.items.slice();
    let cursor = first.json.nextCursor;

    await insertBetween(label, first.json.items[first.json.items.length - 1]);

    while (cursor) {
      const page = await get(`${basePath}&limit=10&cursor=${encodeURIComponent(cursor)}`);
      assert.equal(page.status, 200, `${label} next: ${JSON.stringify(page.json)}`);
      assertPage(page.json);
      all.push(...page.json.items);
      cursor = page.json.nextCursor;
    }
    for (const row of all) {
      assert.ok(!String(row.id).includes('zzz-newer'), `${label} leaked a newer row`);
    }
    const fixtures = all.filter((row) => !String(row.id).includes('zzz-'));
    assert.equal(fixtures.length, COUNT, `${label} returned every fixture exactly once`);
    assert.equal(new Set(fixtures.map((row) => row.id)).size, COUNT, `${label} has no duplicate fixture`);
    assert.ok(fixtures.every((row) => String(row.id).startsWith(prefix)), `${label} stays in its fixture set`);
    assert.equal(cursor, null, `${label} terminates`);
  }

  test('fixed assets walk', { skip: !dbReachable }, async () => {
    await walk('fa', `/api/fixed-assets/page?branchId=${BRANCH}`, 's3-fa-');
  });

  test('warranty coverage walk', { skip: !dbReachable }, async () => {
    await walk('wc', `/api/warranties/vendor?branchId=${BRANCH}`, 's3-wc-');
  });

  test('shipments walk', { skip: !dbReachable }, async () => {
    await walk('sh', `/api/shipments/page?branchId=${BRANCH}`, 's3-sh-');
  });

  test('purchase orders walk', { skip: !dbReachable }, async () => {
    await walk('po', `/api/purchase-orders?branchId=${BRANCH}`, 's3-po-');
  });

  test('purchase invoices walk', { skip: !dbReachable }, async () => {
    await walk('pi', `/api/purchase-invoices?branchId=${BRANCH}`, 's3-pi-');
  });

  test('unscoped cursor requests are refused', { skip: !dbReachable }, async () => {
    for (const path of [
      '/api/fixed-assets/page?limit=10',
      '/api/warranties/vendor?limit=10',
      '/api/shipments/page?limit=10',
      '/api/purchase-orders?limit=10',
      '/api/purchase-invoices?limit=10',
    ]) {
      const res = await get(path);
      assert.equal(res.status, 400, `${path}: ${JSON.stringify(res.json)}`);
      assert.equal(res.json?.code, 'SCOPE_REQUIRED', path);
    }
  });

  test('tampered cursors are refused', { skip: !dbReachable }, async () => {
    for (const path of [
      `/api/fixed-assets/page?branchId=${BRANCH}&limit=10&cursor=bad`,
      `/api/warranties/vendor?branchId=${BRANCH}&limit=10&cursor=bad`,
      `/api/shipments/page?branchId=${BRANCH}&limit=10&cursor=bad`,
      `/api/purchase-orders?branchId=${BRANCH}&limit=10&cursor=bad`,
      `/api/purchase-invoices?branchId=${BRANCH}&limit=10&cursor=bad`,
    ]) {
      const res = await get(path);
      assert.equal(res.status, 400, `${path}: ${JSON.stringify(res.json)}`);
      assert.equal(res.json?.code, 'INVALID_CURSOR', path);
    }
  });
});