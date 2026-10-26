/**
 * VOL-1 — the transaction log leaves the bootstrap and becomes one scoped,
 * paged read.
 *
 * The movement history used to arrive in GET /api/bootstrap for the whole
 * fiscal year, with no branch filter; the Dashboard rendered eight rows, the
 * Audit Trail paginated the array in the browser, and the movement ledger
 * merged it client-side. These tests pin the replacement contract:
 *
 *  1. SOURCE — the bootstrap controller/serializer no longer carries
 *     `transactionLogs`, App holds no such state/prop, and the three consuming
 *     screens call the scoped endpoint instead.
 *  2. ENVELOPE — page/pageSize return `{ data, page, pageSize, totalItems,
 *     capped }`, newest first; `order=asc` reverses it; page 2 is a slice.
 *  3. SCOPE — `dateFromAD`/`dateToAD` are inclusive calendar days.
 *  4. AUTH — a branch account cannot widen the read by omitting branchId or
 *     passing another branch (403); a global account may ask for all.
 *  5. EXPORT — `all=1` returns the bounded envelope used by CSV/ledger; the
 *     legacy bare-array shape still answers a request with no page params.
 *
 * Fixtures are throwaway branches/product/rows created here and removed in
 * after(). Skips the HTTP half without a reachable PostgreSQL.
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

dotenv.config();

const ROOT = path.resolve('.');
const BRANCH_A = 'vol1-br-a';
const BRANCH_B = 'vol1-br-b';
const PRODUCT = 'vol1-prod';
const PREFIX = 'vol1-';

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
  id: 'vol1-super', email: 'vol1-super@example.com', name: 'VOL1 Super',
  role: 'SUPER_ADMIN', branchId: BRANCH_A,
  allowedBranchIds: [BRANCH_A, BRANCH_B], canSwitchUser: false,
} as any;
const BRANCH_USER = {
  id: 'vol1-branch', email: 'vol1-branch@example.com', name: 'VOL1 Branch',
  role: 'FRONT_DESK', branchId: BRANCH_A,
  allowedBranchIds: [BRANCH_A], canSwitchUser: false,
} as any;

const ROWS = [
  { id: `${PREFIX}tx1`, transaction: 'VOL1-1', branch: BRANCH_A, at: '2026-01-01T10:00:00Z' },
  { id: `${PREFIX}tx2`, transaction: 'VOL1-2', branch: BRANCH_A, at: '2026-01-02T10:00:00Z' },
  { id: `${PREFIX}tx3`, transaction: 'VOL1-3', branch: BRANCH_A, at: '2026-01-03T10:00:00Z' },
  { id: `${PREFIX}tx4`, transaction: 'VOL1-4', branch: BRANCH_B, at: '2026-01-02T11:00:00Z' },
  // Outside the tested date range: must never appear.
  { id: `${PREFIX}tx-old`, transaction: 'VOL1-OLD', branch: BRANCH_A, at: '2025-12-30T10:00:00Z' },
];

async function cleanup(): Promise<void> {
  if (!pool) return;
  await pool.query("DELETE FROM transaction_logs WHERE id LIKE 'vol1-%'");
  await pool.query('DELETE FROM products WHERE id = $1', [PRODUCT]);
  await pool.query('DELETE FROM branches WHERE id IN ($1, $2)', [BRANCH_A, BRANCH_B]);
}

describe('VOL-1 — transaction log source contract', () => {
  test('the bootstrap response and App no longer carry transactionLogs', () => {
    const controller = fs.readFileSync(
      path.join(ROOT, 'server/src/controllers/bootstrap.controller.ts'),
      'utf8'
    );
    const payload = controller.slice(
      controller.lastIndexOf('return res.json({'),
      controller.lastIndexOf('} catch')
    );
    assert.ok(!/transactionLogs\s*:/.test(payload), 'GET /api/bootstrap must not serialize transactionLogs');

    const repo = fs.readFileSync(path.join(ROOT, 'server/src/models/bootstrap.repo.ts'), 'utf8');
    assert.ok(
      !/fetchTable\(pool, BOOTSTRAP_TABLES\.transactionLogs/.test(repo),
      'fetchOperationalData must not read the transaction log wholesale'
    );

    const app = fs.readFileSync(path.join(ROOT, 'client/src/App.tsx'), 'utf8');
    assert.ok(!app.includes('transactionLogs'), 'App must not hold or pass a transactionLogs slice');

    const screens = [
      'client/src/features/dashboard/Dashboard.tsx',
      'client/src/features/finance/AuditTrailReports.tsx',
      'client/src/features/inventory/StockMovementLedger.tsx',
    ];
    for (const screen of screens) {
      const source = fs.readFileSync(path.join(ROOT, screen), 'utf8');
      assert.match(source, /getTransactionLogs/, `${screen} must read its own scoped movement rows`);
      assert.match(source, /dateFromAD:/, `${screen} must bound the read to the fiscal year`);
      assert.match(source, /branchId:/, `${screen} must pass its branch scope`);
    }

    const dashboard = fs.readFileSync(path.join(ROOT, screens[0]), 'utf8');
    assert.match(dashboard, /page:\s*1/, 'Dashboard must ask for the first page');
    assert.match(dashboard, /pageSize:\s*8/, 'Dashboard renders eight recent rows');
    assert.match(dashboard, /setRecentLogsRetryKey/, 'Dashboard needs a retry path for the read');

    const audit = fs.readFileSync(path.join(ROOT, screens[1]), 'utf8');
    assert.match(audit, /pageSize:\s*txnPageSize/, 'Audit Trail pages the movement log on the server');
    assert.match(audit, /envelope\.capped/, 'Audit Trail must state a capped export');

    const ledger = fs.readFileSync(path.join(ROOT, screens[2]), 'utf8');
    assert.match(ledger, /all:\s*true/, 'the ledger reads one bounded window, not a page loop');
    assert.match(ledger, /envelope\.capped/, 'the ledger must state its bounded window');
  });
});

describe('VOL-1 — GET /api/transaction-logs paged contract', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const superToken = issueAuthToken(SUPER_USER);
  const branchToken = issueAuthToken(BRANCH_USER);

  before(async () => {
    if (!dbReachable || !pool) return;
    await cleanup();
    await pool.query(
      'INSERT INTO branches (id, code, name, location) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
      [BRANCH_A, 'VOL1A', 'VOL1 Branch A', 'test', BRANCH_B, 'VOL1B', 'VOL1 Branch B', 'test']
    );
    await pool.query(
      `INSERT INTO products (id, sku, name, category, product_group, unit, cost_price, selling_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [PRODUCT, 'VOL1-SKU', 'VOL1 Fixture Product', 'Fixture', 'Product Item', 'Pcs', 10, 20]
    );
    for (const row of ROWS) {
      await pool.query(
        `INSERT INTO transaction_logs
           (id, transaction_number, product_id, product_sku, product_name, branch_id,
            change_type, quantity_before, quantity_changed, quantity_after, unit_cost,
            reference_doc_id, timestamp_ad, timestamp_bs, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, 'STOCK_ADJUSTMENT', 10, -1, 9, 10,
                 $7, $8, '2082-09-17', FALSE)`,
        [row.id, row.transaction, PRODUCT, 'VOL1-SKU', 'VOL1 Fixture Product', row.branch, row.transaction, row.at]
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

  async function get(urlPath: string, token: string) {
    const res = await fetch('http://127.0.0.1:' + port + urlPath, {
      headers: { authorization: 'Bearer ' + token },
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* a non-JSON body is a finding */ }
    return { status: res.status, json };
  }

  const scoped = (extra = '') =>
    `/api/transaction-logs?branchId=${BRANCH_A}&dateFromAD=2026-01-01&dateToAD=2026-01-31${extra}`;

  test('page 1 returns the newest slice and the filtered total', { skip: skipNoDb }, async () => {
    const { status, json } = await get(scoped('&page=1&pageSize=2'), superToken);
    assert.equal(status, 200);
    assert.equal(json.page, 1);
    assert.equal(json.pageSize, 2);
    assert.equal(json.totalItems, 3, 'the old row and branch B must be excluded');
    assert.equal(json.capped, false);
    assert.deepEqual(json.data.map((r: any) => r.id), [`${PREFIX}tx3`, `${PREFIX}tx2`]);
    assert.equal(json.data[0].transactionNumber, 'VOL1-3');
  });

  test('page 2 is the next slice; order=asc reverses the sequence', { skip: skipNoDb }, async () => {
    const page2 = await get(scoped('&page=2&pageSize=2'), superToken);
    assert.equal(page2.status, 200);
    assert.deepEqual(page2.json.data.map((r: any) => r.id), [`${PREFIX}tx1`]);

    const asc = await get(scoped('&page=1&pageSize=3&order=asc'), superToken);
    assert.equal(asc.status, 200);
    assert.deepEqual(asc.json.data.map((r: any) => r.id), [`${PREFIX}tx1`, `${PREFIX}tx2`, `${PREFIX}tx3`]);
  });

  test('a branch account is pinned to its own branches and cannot widen the read', { skip: skipNoDb }, async () => {
    const own = await get('/api/transaction-logs?dateFromAD=2026-01-01&dateToAD=2026-01-31&page=1&pageSize=10', branchToken);
    assert.equal(own.status, 200);
    assert.equal(own.json.totalItems, 3, 'omitting branchId must mean "my branches", not "all branches"');
    assert.deepEqual(
      [...new Set(own.json.data.map((r: any) => r.branchId))],
      [BRANCH_A]
    );

    const all = await get('/api/transaction-logs?branchId=ALL&page=1&pageSize=10', branchToken);
    assert.equal(all.status, 403, 'the shared branch middleware must refuse an explicit ALL for a branch account');
    assert.match(all.json.message, /cannot access all branches/);

    const other = await get(`/api/transaction-logs?branchId=${BRANCH_B}&page=1&pageSize=10`, branchToken);
    assert.equal(other.status, 403);
    assert.match(other.json.message, /not authorized for the requested branch/);
  });

  test('a global account may read all branches; the date window is inclusive', { skip: skipNoDb }, async () => {
    const all = await get('/api/transaction-logs?dateFromAD=2026-01-01&dateToAD=2026-01-31&page=1&pageSize=10', superToken);
    assert.equal(all.status, 200);
    assert.equal(all.json.totalItems, 4);
    assert.ok(all.json.data.some((r: any) => r.branchId === BRANCH_B));
    assert.ok(!all.json.data.some((r: any) => r.id === `${PREFIX}tx-old`));
  });

  test('all=1 returns the bounded export envelope, and no page params keeps the legacy array', { skip: skipNoDb }, async () => {
    const all = await get(scoped('&all=1'), superToken);
    assert.equal(all.status, 200);
    assert.equal(all.json.totalItems, 3);
    assert.equal(all.json.data.length, 3);
    assert.equal(all.json.capped, false);

    const legacy = await get(scoped(), superToken);
    assert.equal(legacy.status, 200);
    assert.ok(Array.isArray(legacy.json), 'a request without page/all must still receive the legacy array');
    assert.equal(legacy.json.length, 3);
  });

  test('without a bearer token the endpoint is 401', { skip: skipNoDb }, async () => {
    const res = await fetch(`http://127.0.0.1:${port}${scoped('&page=1&pageSize=2')}`);
    assert.equal(res.status, 401);
  });
});
