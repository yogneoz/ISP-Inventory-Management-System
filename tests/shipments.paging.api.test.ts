/**
 * VOL-3 — the paged/overview shipment reads over real HTTP + PostgreSQL.
 *
 * PROVES:
 *   1. GET /api/shipments/page returns a bounded envelope (`data`, `page`,
 *      `pageSize`, `totalItems`) and consecutive pages do not overlap.
 *   2. Its filters (status, direction, search, destination list) narrow both
 *      the page and the total together.
 *   3. GET /api/shipments/overview reports exact per-status counts and returns
 *      every still-in-flight row, excluding final statuses from `pending`.
 *   4. Branch scope is a SERVER decision: a branch-bound account sees only
 *      shipments touching its branches, and naming a foreign branch is a 403.
 *   5. GET /api/bootstrap no longer carries `shipments`.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { ensureReferenceData } from './fixtures/referenceData';

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
  id: 'spg-super', email: 'spg-super@example.com', name: 'SPG Test',
  role: 'SUPER_ADMIN', branchId: 'WH001',
  allowedBranchIds: ['WH001'], canSwitchUser: false,
} as any;

const BRANCH_USER = {
  id: 'spg-branch', email: 'spg-branch@example.com', name: 'SPG Branch',
  role: 'ACCOUNTANT', branchId: 'BRH01',
  allowedBranchIds: ['BRH01'], canSwitchUser: false,
} as any;

// Every read in this suite carries this prefix in the tracking code, so other
// suites' shipment rows can never change a total.
const PREFIX = 'ST-SPG-';

describe('shipment page + overview reads (VOL-3)', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const superToken = issueAuthToken(SUPER_USER);
  const branchToken = issueAuthToken(BRANCH_USER);
  const extraBranch = 'spg-br3';

  const seed = async () => {
    await pool!.query("DELETE FROM shipments WHERE id LIKE 'spg-%'");
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'SPG3', 'SPG Branch 3', 'T')
       ON CONFLICT (id) DO NOTHING`,
      [extraBranch]
    );
    const rows: Array<[string, string, string, string, string, string, string, string]> = [
      ['spg-p1', `${PREFIX}1`, 'WH001', 'BRH01', '2026-10-10', 'IN_TRANSIT', 'SPG Central Warehouse', 'SPG Branch 1'],
      ['spg-p2', `${PREFIX}2`, 'BRH01', 'WH001', '2026-10-05', 'RECEIVED', 'SPG Branch 1', 'SPG Central Warehouse'],
      ['spg-p3', `${PREFIX}3`, 'WH001', extraBranch, '2026-09-01', 'CANCELLED', 'SPG Central Warehouse', 'SPG Branch 3'],
      ['spg-p4', `${PREFIX}4`, 'BRH01', extraBranch, '2026-10-12', 'IN_TRANSIT', 'SPG Branch 1', 'SPG Branch 3'],
    ];
    for (const [id, code, source, destination, date, status, sourceName, destName] of rows) {
      // A received row must carry its BS receipt date (schema constraint
      // shipments_received_bs_required).
      const receivedBs = status === 'RECEIVED' || status === 'DELIVERED' ? '2082-06-19 BS' : null;
      await pool!.query(
        `INSERT INTO shipments (id, tracking_code, type, source_branch_id, source_branch_name,
           destination_branch_id, destination_branch_name, dispatch_date_ad, dispatch_date_bs, status, items,
           received_date_ad, received_date_bs)
         VALUES ($1,$2,'INTER_BRANCH',$3,$4,$5,$6,$7::date,'2082-06-24 BS',$8,$9::jsonb,$10::date,$11)`,
        [id, code, source, sourceName, destination, destName, date, status, JSON.stringify([{ productId: 'spg-prod', productName: 'SPG Router', quantitySent: 2 }]), receivedBs ? '2026-10-06' : null, receivedBs]
      );
    }
  };

  before(async () => {
    if (!dbReachable) return;
    await ensureReferenceData(pool!);
    await seed();
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
      await pool.query("DELETE FROM shipments WHERE id LIKE 'spg-%'");
      await pool.query('DELETE FROM branches WHERE id = $1', [extraBranch]);
      await pool.end();
    }
  });

  async function get(urlPath: string, token = superToken) {
    const res = await fetch('http://127.0.0.1:' + port + urlPath, {
      headers: { authorization: 'Bearer ' + token },
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  const scoped = (extra = '') => `/api/shipments/page?search=${encodeURIComponent(PREFIX)}${extra}`;

  test('page returns a bounded envelope and pages do not overlap', { skip: skipNoDb }, async () => {
    const first = await get(scoped('&page=1&pageSize=2'));
    assert.equal(first.status, 200);
    assert.equal(first.json?.totalItems, 4);
    assert.equal(first.json?.page, 1);
    assert.equal(first.json?.pageSize, 2);
    assert.equal(first.json?.data?.length, 2);

    const second = await get(scoped('&page=2&pageSize=2'));
    assert.equal(second.json?.data?.length, 2);
    const ids = [...first.json.data, ...second.json.data].map((row: any) => row.id).sort();
    assert.deepEqual(ids, ['spg-p1', 'spg-p2', 'spg-p3', 'spg-p4']);

    const beyond = await get(scoped('&page=9&pageSize=2'));
    assert.equal(beyond.json?.data?.length, 0);
    assert.equal(beyond.json?.totalItems, 4);
  });

  test('filters narrow the page and the total together', { skip: skipNoDb }, async () => {
    const inTransit = await get(scoped('&status=IN_TRANSIT'));
    assert.equal(inTransit.json?.totalItems, 2);
    assert.deepEqual(inTransit.json.data.map((row: any) => row.id).sort(), ['spg-p1', 'spg-p4']);

    const createdByBranch = await get(scoped('&branchId=BRH01&direction=CREATED'));
    assert.deepEqual(createdByBranch.json.data.map((row: any) => row.id).sort(), ['spg-p2', 'spg-p4']);

    const toWarehouse = await get(scoped('&destinationBranchIds=WH001'));
    assert.deepEqual(toWarehouse.json.data.map((row: any) => row.id), ['spg-p2']);

    const dated = await get(scoped('&dateFromAD=2026-10-01&dateToAD=2026-10-11'));
    assert.deepEqual(dated.json.data.map((row: any) => row.id).sort(), ['spg-p1', 'spg-p2']);

    const pageSizeCap = await get(scoped('&pageSize=5000'));
    assert.equal(pageSizeCap.json?.pageSize, 200, 'a caller cannot request the national ledger as one page');
  });

  test('overview reports exact counts and only actionable rows as pending', { skip: skipNoDb }, async () => {
    const { status, json } = await get(`/api/shipments/overview?search=${encodeURIComponent(PREFIX)}`);
    assert.equal(status, 200);
    assert.equal(json?.total, 4);
    assert.deepEqual(json?.counts, { IN_TRANSIT: 2, RECEIVED: 1, CANCELLED: 1 });
    assert.deepEqual(json.pending.map((row: any) => row.id).sort(), ['spg-p1', 'spg-p4']);
    assert.equal(json.recent.length, 4);
    assert.equal(json.pendingCapped, false);
  });

  test('a branch account cannot widen its read', { skip: skipNoDb }, async () => {
    // The app-level branch guard requires a branch-scoped account to name one
    // of its own branches on every read; the controller then pins the SQL to it.
    const own = await get(scoped('&branchId=BRH01'), branchToken);
    assert.equal(own.status, 200, `branch read failed: ${JSON.stringify(own.json).slice(0, 300)}`);
    assert.deepEqual(own.json.data.map((row: any) => row.id).sort(), ['spg-p1', 'spg-p2', 'spg-p4']);

    const foreign = await get(scoped('&branchId=WH001'), branchToken);
    assert.equal(foreign.status, 403, 'a foreign branchId must be refused, not silently intersected');

    const overview = await get(
      `/api/shipments/overview?search=${encodeURIComponent(PREFIX)}&branchId=BRH01`,
      branchToken
    );
    assert.equal(overview.json?.total, 3);
  });

  test('the bootstrap payload no longer carries shipments', { skip: skipNoDb }, async () => {
    const { status, json } = await get('/api/bootstrap');
    assert.equal(status, 200);
    assert.ok(!('shipments' in (json || {})), 'shipments must come from /page and /overview, not the login payload');
  });
});
