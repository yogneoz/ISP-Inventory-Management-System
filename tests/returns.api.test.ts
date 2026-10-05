/**
 * Returns & sales-invoices register GETs (GET /api/purchase-returns,
 * /api/sales-returns, /api/sales-invoices) — HTTP-layer integration tests.
 *
 * Covers the paged-envelope contract the two rewired registers
 * (ReturnsRegister, SalesInvoices) now depend on:
 *
 *  1. ENVELOPE — ?page=N (with or without filters) returns
 *     { data, page, pageSize, totalItems } and never an array.
 *  2. REGRESSION — a filter (query/status/date/branch) WITHOUT a page param
 *     keeps the legacy full-array response, and a filter WITH a page param
 *     stays an envelope. This pins the bug where a SQL error in the paged
 *     branch was swallowed and the handler fell through to the legacy array,
 *     silently defeating paging (the shell-stripped `$` placeholders made
 *     every filtered+paged query throw).
 *  3. all=1 returns every filtered row in one envelope (pageSize = total).
 *  4. Page past the end returns an empty slice with the true total.
 *  5. The endpoints require auth (401 without a bearer token).
 *
 * Read-only: no fixtures are written to the shared database. Proves the
 * contract on a real Express app wired exactly as production
 * (createApp + registerAllRoutes) against real PostgreSQL. Skips without a
 * reachable PostgreSQL (DATABASE_URL).
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

const SUPER_USER = {
  id: 'rettest-super', email: 'rettest-super@example.com', name: 'Ret Test Super',
  role: 'SUPER_ADMIN', branchId: 'WH001',
  allowedBranchIds: ['WH001', 'BRH01'], canSwitchUser: false,
} as any;

const REGISTERS = ['purchase-returns', 'sales-returns', 'sales-invoices'];

/** The paged envelope contract: an object with a data array + paging meta. */
const isEnvelope = (j: any) =>
  j !== null &&
  !Array.isArray(j) &&
  Array.isArray(j.data) &&
  Number.isInteger(j.page) &&
  Number.isInteger(j.pageSize) &&
  typeof j.totalItems === 'number';

describe('paged register GETs (purchase-returns, sales-returns, sales-invoices)', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(SUPER_USER);

  before(async () => {
    if (!dbReachable) return;
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
    if (pool && dbReachable) await pool.end();
  });

  async function get(path: string, withToken = true) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      headers: withToken ? { authorization: 'Bearer ' + token } : {},
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  test('guard: no bearer token -> 401 on all three registers', { skip: skipNoDb }, async () => {
    for (const reg of REGISTERS) {
      const { status } = await get('/api/' + reg + '?page=1&pageSize=5', false);
      assert.equal(status, 401, reg + ' must require authentication');
    }
  });

  test('?page + ?pageSize returns the envelope on all three registers', { skip: skipNoDb }, async () => {
    for (const reg of REGISTERS) {
      const { status, json } = await get('/api/' + reg + '?page=1&pageSize=2');
      assert.equal(status, 200, JSON.stringify(json));
      assert.ok(isEnvelope(json), reg + ' paged request must return { data, page, pageSize, totalItems }, got: ' + JSON.stringify(json).slice(0, 120));
      assert.equal(json.page, 1);
      assert.equal(json.pageSize, 2);
      assert.ok(json.data.length <= 2, 'a page never exceeds its pageSize');
      assert.ok(json.totalItems >= json.data.length, 'total covers the slice');
    }
  });

  test('REGRESSION: a text query WITH a page param stays an envelope (no silent fall-through)', { skip: skipNoDb }, async () => {
    // Each query matches the demo numbering (INV-/DN-/CN-), but even a
    // zero-match query must return the envelope — the paged branch used to
    // throw (stripped `$` placeholders) and fall through to the legacy array.
    const cases: [string, string][] = [
      ['sales-invoices', 'INV'],
      ['purchase-returns', 'DN'],
      ['sales-returns', 'CN'],
    ];
    for (const [reg, q] of cases) {
      const { status, json } = await get('/api/' + reg + '?page=1&pageSize=3&query=' + q);
      assert.equal(status, 200, JSON.stringify(json));
      assert.ok(isEnvelope(json), reg + '?query+page must stay an envelope, got: ' + JSON.stringify(json).slice(0, 120));
      assert.equal(json.pageSize, 3);
    }
  });

  test('status, date and branch filters WITH a page param stay envelopes', { skip: skipNoDb }, async () => {
    const cases = [
      'sales-invoices?page=1&pageSize=5&status=UNPAID',
      'sales-invoices?page=1&pageSize=5&branchId=WH001',
      'sales-returns?page=1&pageSize=5&dateFromAD=2020-01-01',
      'purchase-returns?page=1&pageSize=5&dateToAD=2030-12-31&status=ALL',
    ];
    for (const path of cases) {
      const { status, json } = await get('/api/' + path);
      assert.equal(status, 200, JSON.stringify(json));
      assert.ok(isEnvelope(json), path + ' must be an envelope, got: ' + JSON.stringify(json).slice(0, 120));
    }
    // The status filter really applies when rows exist.
    const { json: unpaid } = await get('/api/sales-invoices?page=1&pageSize=5&status=UNPAID');
    for (const row of unpaid.data) {
      assert.equal(row.paymentStatus, 'UNPAID', 'status filter must reach the SQL WHERE clause');
    }
  });

  test('without a page param the legacy full-array shapes are preserved', { skip: skipNoDb }, async () => {
    const cases = [
      'purchase-returns',
      'sales-returns',
      'sales-invoices',
      'sales-invoices?query=INV',
      'purchase-returns?query=DN',
      'sales-invoices?branchId=WH001',
    ];
    for (const path of cases) {
      const { status, json } = await get('/api/' + path);
      assert.equal(status, 200, JSON.stringify(json));
      assert.ok(Array.isArray(json), path + ' without ?page must stay the legacy array, got: ' + JSON.stringify(json).slice(0, 120));
    }
  });

  test('all=1 returns every filtered row in one envelope', { skip: skipNoDb }, async () => {
    for (const reg of REGISTERS) {
      const { status, json } = await get('/api/' + reg + '?all=1');
      assert.equal(status, 200, JSON.stringify(json));
      assert.ok(isEnvelope(json), reg + '?all=1 must be an envelope');
      assert.equal(json.pageSize, json.totalItems, 'all=1 pages over the whole filtered set');
      assert.equal(json.data.length, json.totalItems, 'all=1 slices every row');
    }
  });

  test('a page past the end returns an empty slice with the true total', { skip: skipNoDb }, async () => {
    const first = await get('/api/purchase-returns?page=1&pageSize=5');
    assert.ok(isEnvelope(first.json));
    const far = await get('/api/purchase-returns?page=9999&pageSize=5');
    assert.equal(far.status, 200);
    assert.ok(isEnvelope(far.json));
    assert.deepEqual(far.json.data, [], 'an out-of-range page is empty, not an error');
    assert.equal(far.json.totalItems, first.json.totalItems, 'the count ignores the page window');
  });
});
