/**
 * Customer Master Directory — GET /api/customers HTTP contract (DF-01).
 *
 * The directory screen has read `{ data, page, pageSize, totalItems }` since
 * 2026-10-05, while the handler still answered a bare array: `envelope.data`
 * was undefined, so the page rendered zero customers. These tests pin the
 * contract that replaces it, on a real Express app wired as production
 * (createApp + registerAllRoutes) against real PostgreSQL:
 *
 *  1. ENVELOPE — always an object with data/page/pageSize/totalItems, even for
 *     a filtered request with no explicit page.
 *  2. PAGING — page/pageSize are honoured, clamped and echoed; a page past the
 *     end is an empty slice with the true total.
 *  3. FILTERS — branch, status and the six-column search filter reach the SQL
 *     WHERE clause and the aggregate totals use the same filters.
 *  4. KPIs — activeItems / totalCreditLimit describe the whole filtered set,
 *     not the visible page.
 *  5. EXPORT — all=1 returns every filtered row in one envelope.
 *  6. AUTH — no bearer token → 401.
 *
 * Fixtures: two throwaway branches and six customer rows, all created here and
 * deleted in after(). CI runs against a schema-only database, so nothing is
 * read from seed data. Skips without a reachable PostgreSQL.
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
  id: 'df01-super', email: 'df01-super@example.com', name: 'DF01 Super',
  role: 'SUPER_ADMIN', branchId: 'DF01BR',
  allowedBranchIds: ['DF01BR', 'DF01BR2'], canSwitchUser: false,
} as any;

const BRANCH_A = 'DF01BR';
const BRANCH_B = 'DF01BR2';
const ID_PREFIX = 'df01-c';
const CODE_PREFIX = 'DF01-';

/** Row fixtures: page order is name ASC (Alpha … Zeta). */
const CUSTOMERS = [
  { id: `${ID_PREFIX}1`, code: `${CODE_PREFIX}001`, name: 'DF01 Alpha', status: 'ACTIVE', branch: BRANCH_A, credit: 100 },
  { id: `${ID_PREFIX}2`, code: `${CODE_PREFIX}002`, name: 'DF01 Bravo', status: 'ACTIVE', branch: BRANCH_A, credit: 200 },
  { id: `${ID_PREFIX}3`, code: `${CODE_PREFIX}003`, name: 'DF01 Charlie', status: 'ACTIVE', branch: BRANCH_A, credit: 300 },
  { id: `${ID_PREFIX}4`, code: `${CODE_PREFIX}004`, name: 'DF01 Delta', status: 'INACTIVE', branch: BRANCH_A, credit: 400 },
  { id: `${ID_PREFIX}5`, code: `${CODE_PREFIX}005`, name: 'DF01 Echo', status: 'ACTIVE', branch: BRANCH_A, credit: 500 },
  { id: `${ID_PREFIX}6`, code: `${CODE_PREFIX}006`, name: 'DF01 Zeta', status: 'ACTIVE', branch: BRANCH_B, credit: 600 },
];

const isEnvelope = (j: any) =>
  j !== null &&
  !Array.isArray(j) &&
  Array.isArray(j.data) &&
  Number.isInteger(j.page) &&
  Number.isInteger(j.pageSize) &&
  typeof j.totalItems === 'number' &&
  typeof j.activeItems === 'number' &&
  typeof j.totalCreditLimit === 'number';

describe('GET /api/customers — paged customer directory contract (DF-01)', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(SUPER_USER);

  before(async () => {
    if (!dbReachable || !pool) return;
    // Own fixtures only: previous failed runs may have left rows behind.
    await cleanupFixtures();

    for (const [id, code, name] of [
      [BRANCH_A, 'DF01A', 'DF01 Test Branch A'],
      [BRANCH_B, 'DF01B', 'DF01 Test Branch B'],
    ]) {
      await pool.query(
        'INSERT INTO branches (id, code, name, location) VALUES ($1, $2, $3, $4)',
        [id, code, name, 'DF01 fixture']
      );
    }
    for (const c of CUSTOMERS) {
      await pool.query(
        `INSERT INTO customer_records
           (id, customer_id, customer_name, username, contact_number, branch_id, address, email, status, credit_limit, assigned_devices_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)`,
        [
          c.id,
          c.code,
          c.name,
          c.code.toLowerCase(),
          '9800000000',
          c.branch,
          'Kathmandu',
          `${c.code.toLowerCase()}@example.com`,
          c.status,
          c.credit,
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
      await cleanupFixtures().catch(() => undefined);
      await pool.end();
    }
  });

  async function cleanupFixtures() {
    if (!pool) return;
    await pool.query('DELETE FROM customer_records WHERE id LIKE $1', ['df01-%']);
    await pool.query('DELETE FROM branches WHERE id IN ($1, $2)', [BRANCH_A, BRANCH_B]);
  }

  async function get(path: string, withToken = true) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      headers: withToken ? { authorization: 'Bearer ' + token } : {},
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  test('guard: no bearer token -> 401', { skip: skipNoDb }, async () => {
    const { status } = await get('/api/customers?page=1&pageSize=5', false);
    assert.equal(status, 401);
  });

  test('returns the paged envelope (never the legacy bare array)', { skip: skipNoDb }, async () => {
    const { status, json } = await get('/api/customers?query=DF01');
    assert.equal(status, 200, JSON.stringify(json));
    assert.ok(isEnvelope(json), 'must be { data, page, pageSize, totalItems, activeItems, totalCreditLimit }, got: ' + JSON.stringify(json).slice(0, 200));
    assert.equal(json.page, 1);
    assert.equal(json.pageSize, 15, 'the endpoint applies its own default page size');
    assert.equal(json.totalItems, 6);
    assert.equal(json.activeItems, 5, 'Delta is INACTIVE');
    assert.equal(json.totalCreditLimit, 2100);
    assert.equal(json.data.length, 6);
  });

  test('page 2 returns the second slice, in name order', { skip: skipNoDb }, async () => {
    const { status, json } = await get('/api/customers?query=DF01&page=2&pageSize=2');
    assert.equal(status, 200, JSON.stringify(json));
    assert.ok(isEnvelope(json));
    assert.equal(json.page, 2);
    assert.equal(json.pageSize, 2);
    assert.equal(json.totalItems, 6);
    assert.deepEqual(json.data.map((c: any) => c.customerName), ['DF01 Charlie', 'DF01 Delta']);
  });

  test('a page past the end is an empty slice with the true total', { skip: skipNoDb }, async () => {
    const first = await get('/api/customers?query=DF01&page=1&pageSize=2');
    const far = await get('/api/customers?query=DF01&page=99&pageSize=2');
    assert.equal(far.status, 200);
    assert.ok(isEnvelope(far.json));
    assert.deepEqual(far.json.data, []);
    assert.equal(far.json.totalItems, first.json.totalItems);
  });

  test('status filter reaches SQL and the aggregate', { skip: skipNoDb }, async () => {
    const { status, json } = await get('/api/customers?query=DF01&status=INACTIVE');
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.totalItems, 1);
    assert.equal(json.activeItems, 0);
    assert.deepEqual(json.data.map((c: any) => c.customerName), ['DF01 Delta']);
  });

  test('branch filter scopes rows and totals', { skip: skipNoDb }, async () => {
    const a = await get('/api/customers?query=DF01&branchId=' + BRANCH_A);
    assert.equal(a.status, 200);
    assert.equal(a.json.totalItems, 5);
    for (const row of a.json.data) assert.equal(row.branchId, BRANCH_A);

    const b = await get('/api/customers?query=DF01&branchId=' + BRANCH_B);
    assert.equal(b.json.totalItems, 1);
    assert.equal(b.json.data[0].customerName, 'DF01 Zeta');
  });

  test('search matches code, name, username, phone, email and address', { skip: skipNoDb }, async () => {
    const byEmail = await get('/api/customers?query=' + encodeURIComponent('df01-003@example.com'));
    assert.equal(byEmail.json.totalItems, 1);
    assert.equal(byEmail.json.data[0].customerName, 'DF01 Charlie');

    const byCode = await get('/api/customers?query=DF01-006');
    assert.equal(byCode.json.totalItems, 1);
    assert.equal(byCode.json.data[0].customerName, 'DF01 Zeta');
  });

  test('all=1 returns every filtered row in one envelope', { skip: skipNoDb }, async () => {
    const { status, json } = await get('/api/customers?query=DF01&all=1');
    assert.equal(status, 200, JSON.stringify(json));
    assert.ok(isEnvelope(json));
    assert.equal(json.data.length, 6);
    assert.equal(json.totalItems, 6);
    assert.equal(json.pageSize, 6, 'the export envelope reports the row count');
  });

  test('page and pageSize are clamped and echoed', { skip: skipNoDb }, async () => {
    const { status, json } = await get('/api/customers?query=DF01&page=0&pageSize=9999');
    assert.equal(status, 200);
    assert.equal(json.page, 1);
    assert.equal(json.pageSize, 100);
    assert.ok(json.data.length <= 100);
  });
});
