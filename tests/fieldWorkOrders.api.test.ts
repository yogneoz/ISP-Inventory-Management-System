/**
 * Field capture — technician work orders over the real request path.
 *
 * PROVES, against a real Express app and real PostgreSQL:
 *   1. a technician can raise an order against a subscriber in their branch,
 *      assign it and complete it, and the row persists COMPLETED with a
 *      completion timestamp and the on-site connection details;
 *   2. a completed order cannot be completed or assigned again (409) — the
 *      state rule lives in the UPDATE, so a retry cannot double-write;
 *   3. validation refusals are 400: an unknown kind, a customer outside the
 *      branch, and a malformed scheduled date;
 *   4. authorization: an account without `field-work-order` is refused on both
 *      read and write, and a branch account cannot read or complete another
 *      branch's order (403).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix, setUsers } from '../server/src/state/runtimeState';

dotenv.config();

const BRANCH = 'WO-TEST-BR';
const OTHER_BRANCH = 'WO-TEST-OTHER';
const CUSTOMER = 'WO-TEST-CUS';

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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (work-order writes)';

const TECH = {
  id: 'wo-tech', email: 'wo-tech@example.com', name: 'Field Tech',
  role: 'FIELD_TECHNICIAN', branchId: BRANCH, allowedBranchIds: [], canSwitchUser: false,
} as any;
const OUTSIDER = {
  id: 'wo-outsider', email: 'wo-outsider@example.com', name: 'Other Branch',
  role: 'BRANCH_MANAGER', branchId: OTHER_BRANCH, allowedBranchIds: [OTHER_BRANCH], canSwitchUser: false,
} as any;
const AUDITOR = {
  id: 'wo-auditor', email: 'wo-auditor@example.com', name: 'Auditor',
  role: 'AUDITOR', branchId: BRANCH, allowedBranchIds: [], canSwitchUser: false,
} as any;

let server: http.Server | null = null;
let port = 0;

async function call(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

describe('field work orders (API)', { skip: skipNoDb }, () => {
  before(async () => {
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'WO1', 'Work order branch', 'Kathmandu')
       ON CONFLICT (id) DO NOTHING`,
      [BRANCH]
    );
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'WO2', 'Other work order branch', 'Pokhara')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, is_demo)
       VALUES ($1, $1, 'Work order customer', '9800000000', $2, FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER, BRANCH]
    );
    setUsers([TECH, OUTSIDER, AUDITOR]);
    setPermissionMatrix({
      'field-work-order': { FIELD_TECHNICIAN: true, BRANCH_MANAGER: true, AUDITOR: false },
    } as any);

    const app = createApp();
    registerAllRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => { (server as any).closeAllConnections?.(); server!.close(() => resolve()); });
    if (pool) {
      await pool.query('DELETE FROM field_work_orders WHERE branch_id = ANY($1::text[])', [[BRANCH, OTHER_BRANCH]]);
      await pool.query('DELETE FROM customer_records WHERE id = $1', [CUSTOMER]);
      await pool.query('DELETE FROM branches WHERE id = ANY($1::text[])', [[BRANCH, OTHER_BRANCH]]);
    }
    setUsers([]);
    setPermissionMatrix({});
  });

  test('a technician raises, assigns and completes a visit against a subscriber', async () => {
    const token = issueAuthToken(TECH);
    const created = await call('/api/field-work-orders', token, {
      method: 'POST',
      body: JSON.stringify({
        branchId: BRANCH,
        customerId: CUSTOMER,
        kind: 'install',
        scheduledDateAd: '2026-11-20',
        notes: 'New FTTH drop',
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.work_order_no, /^WO-\d{6}-\d{4}$/);
    assert.equal(created.body.status, 'OPEN');
    assert.equal(created.body.customer_name, 'Work order customer');
    assert.equal(created.headers.get('cache-control'), 'private, no-store');
    const id = created.body.id;

    const assigned = await call(`/api/field-work-orders/${id}/assign`, token, {
      method: 'PATCH',
      body: JSON.stringify({ technicianName: 'Field Tech' }),
    });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.status, 'ASSIGNED');

    const completed = await call(`/api/field-work-orders/${id}/complete`, token, {
      method: 'POST',
      body: JSON.stringify({
        completionNotes: 'Installed ONT, customer online.',
        ontSerial: 'ONT-12345',
        ipAddress: '10.10.20.31',
        planName: '100 Mbps',
      }),
    });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.status, 'COMPLETED');
    assert.ok(completed.body.completed_at, 'completion stamp is written');
    assert.equal(completed.body.ont_serial, 'ONT-12345');

    const persisted = await pool!.query(
      `SELECT status, completion_notes, completed_at FROM field_work_orders WHERE id = $1`,
      [id]
    );
    assert.equal(persisted.rows[0].status, 'COMPLETED');
    assert.ok(persisted.rows[0].completed_at);
  });

  test('a completed visit cannot be completed or reassigned again', async () => {
    const token = issueAuthToken(TECH);
    const list = await call('/api/field-work-orders?status=COMPLETED', token);
    assert.equal(list.status, 200);
    const id = list.body[0].id;
    const again = await call(`/api/field-work-orders/${id}/complete`, token, {
      method: 'POST',
      body: JSON.stringify({ completionNotes: 'second attempt' }),
    });
    assert.equal(again.status, 409);
    const assign = await call(`/api/field-work-orders/${id}/assign`, token, {
      method: 'PATCH',
      body: JSON.stringify({ technicianName: 'Someone Else' }),
    });
    assert.equal(assign.status, 409);
  });

  test('validation refuses an unknown kind, a foreign customer and a bad date', async () => {
    const token = issueAuthToken(TECH);
    const badKind = await call('/api/field-work-orders', token, {
      method: 'POST',
      body: JSON.stringify({ branchId: BRANCH, customerId: CUSTOMER, kind: 'TELEPORT', scheduledDateAd: '2026-11-20' }),
    });
    assert.equal(badKind.status, 400);
    const badCustomer = await call('/api/field-work-orders', token, {
      method: 'POST',
      body: JSON.stringify({ branchId: BRANCH, customerId: 'NO-SUCH-CUSTOMER', kind: 'SERVICE', scheduledDateAd: '2026-11-20' }),
    });
    assert.equal(badCustomer.status, 400);
    const badDate = await call('/api/field-work-orders', token, {
      method: 'POST',
      body: JSON.stringify({ branchId: BRANCH, customerId: CUSTOMER, kind: 'SERVICE', scheduledDateAd: '20-11-2026' }),
    });
    assert.equal(badDate.status, 400);
    const stillEmpty = await pool!.query(`SELECT count(*)::int AS n FROM field_work_orders WHERE kind = 'TELEPORT'`);
    assert.equal(stillEmpty.rows[0].n, 0);
  });

  test('permission and branch scope are enforced on reads and writes', async () => {
    const techToken = issueAuthToken(TECH);
    const created = await call('/api/field-work-orders', techToken, {
      method: 'POST',
      body: JSON.stringify({ branchId: BRANCH, customerId: CUSTOMER, kind: 'SERVICE', scheduledDateAd: '2026-11-21' }),
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const noPerm = await call('/api/field-work-orders', issueAuthToken(AUDITOR));
    assert.equal(noPerm.status, 403);
    const noPermWrite = await call('/api/field-work-orders', issueAuthToken(AUDITOR), {
      method: 'POST',
      body: JSON.stringify({ branchId: BRANCH, customerId: CUSTOMER, kind: 'SERVICE', scheduledDateAd: '2026-11-21' }),
    });
    assert.equal(noPermWrite.status, 403);

    const outsider = issueAuthToken(OUTSIDER);
    const crossRead = await call(`/api/field-work-orders/${id}`, outsider);
    assert.equal(crossRead.status, 403);
    const crossComplete = await call(`/api/field-work-orders/${id}/complete`, outsider, {
      method: 'POST',
      body: JSON.stringify({ completionNotes: 'not mine' }),
    });
    assert.equal(crossComplete.status, 403);
    const crossBranchCreate = await call('/api/field-work-orders', outsider, {
      method: 'POST',
      body: JSON.stringify({ branchId: BRANCH, customerId: CUSTOMER, kind: 'SERVICE', scheduledDateAd: '2026-11-21' }),
    });
    assert.equal(crossBranchCreate.status, 403);

    const outsiderList = await call('/api/field-work-orders', outsider);
    assert.equal(outsiderList.status, 200);
    assert.equal(outsiderList.body.length, 0, 'the list is branch-scoped, not filtered after the fact');
  });
});
