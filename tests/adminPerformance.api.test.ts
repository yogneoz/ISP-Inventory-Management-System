/**
 * Phase 0A gap closure: the performance endpoint over authenticated HTTP.
 *
 * PROVES:
 *   1. GET /api/admin/performance returns the metrics snapshot to an
 *      authenticated account holding `admin-audit`.
 *   2. The same request from an authenticated account without that operation
 *      is a 403, not a metrics leak.
 *   3. The response is private/no-store and reports the Phase 0B shape:
 *      reference-only cache passes (zero full refreshes) plus request/database
 *      aggregates.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix, setUsers } from '../server/src/state/runtimeState';
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

const ADMIN = {
  id: 'perf-admin', email: 'perf-admin@example.com', name: 'Perf Admin',
  role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false,
} as any;
const NON_ADMIN = {
  id: 'perf-tech', email: 'perf-tech@example.com', name: 'Perf Technician',
  role: 'FIELD_TECHNICIAN', branchId: 'WH001', allowedBranchIds: ['WH001'], canSwitchUser: false,
} as any;

describe('GET /api/admin/performance — authenticated metrics', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;

  before(async () => {
    await ensureReferenceData(pool!);
    setUsers([ADMIN, NON_ADMIN]);
    setPermissionMatrix({
      'admin-audit': { SUPER_ADMIN: true, FIELD_TECHNICIAN: false },
    } as any);

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
    setUsers([]);
    setPermissionMatrix({});
    if (pool) await pool.end().catch(() => undefined);
  });

  const get = async (token?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/performance`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body: body ? JSON.parse(body) : null };
  };

  test('an authenticated admin receives the metrics snapshot', async () => {
    const token = issueAuthToken(ADMIN);
    const result = await get(token);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.ok(result.body.requests, 'requests aggregate is present');
    assert.ok(result.body.database, 'database aggregate is present');
    assert.ok(result.body.cacheRefresh, 'cache aggregates are present');
    assert.equal(result.body.cacheRefresh.passes, 0, 'Phase 0B removed the full refresh runner');
    assert.ok(Array.isArray(result.body.requests.routes));
  });

  test('an authenticated non-admin is denied', async () => {
    const result = await get(issueAuthToken(NON_ADMIN));
    assert.equal(result.status, 403);
    assert.match(result.body.message, /not permitted/i);
    assert.equal(result.body.requests, undefined, 'no metrics leak on denial');
  });

  test('an anonymous request is 401', async () => {
    const result = await get();
    assert.equal(result.status, 401);
  });

  test('a committed catalog write is visible to the next read with no cache reload', async () => {
    // The throughput guarantee is that a write does NOT re-read the reference
    // catalog, and the freshness guarantee is that the worker which took the
    // write serves it immediately (staleness bound 0). Both are asserted here,
    // on the same burst, so neither can regress silently.
    const token = issueAuthToken(ADMIN);
    const names = Array.from({ length: 10 }, (_, i) => `PERF fresh ${Date.now()}-${i}`);
    const writes = await Promise.all(
      names.map((name) =>
        fetch(`http://127.0.0.1:${port}/api/locations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name, type: 'STORE', branchId: 'WH001', address: 'PERF' }),
        }).then(async (response) => ({
          status: response.status,
          timing: response.headers.get('server-timing') || '',
          body: await response.json().catch(() => null),
        }))
      )
    );
    for (const write of writes) {
      assert.equal(write.status, 201, `write rejected: ${JSON.stringify(write.body)}`);
      assert.ok(
        !/cache-refresh/.test(write.timing),
        'the write path ran a catalog cache refresh'
      );
    }

    const list = (await fetch(`http://127.0.0.1:${port}/api/locations?branchId=WH001`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => response.json())) as any[];
    const present = new Set(list.map((row) => String(row.name)));
    for (const name of names) {
      assert.ok(present.has(name), `${name} was not visible after its commit`);
    }

    const metrics = await get(token);
    assert.equal(
      metrics.body.cacheRefresh.passes,
      0,
      'a committed write re-ran the reference-catalog fan-out'
    );

    for (const write of writes) {
      const id = (write.body as any)?.id;
      if (id) {
        await fetch(`http://127.0.0.1:${port}/api/locations/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    }
  });
});
