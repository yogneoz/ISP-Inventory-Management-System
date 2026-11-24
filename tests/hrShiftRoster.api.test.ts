/**
 * `/api/hr/shift-roster` — the writer the roster table never had.
 *
 * The mobile bootstrap reads `employee_shift_roster` to answer "today's shift".
 * Before this route existed nothing wrote the table, so `shiftWindow` was always
 * `NO_SHIFT` outside a hand-seeded demo. These cases pin the write, the read,
 * the removal, and the rule that an employee cannot be rostered into a branch
 * they do not belong to.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';

dotenv.config();

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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const BRANCH = 'roster-test-branch';
const OTHER_BRANCH = 'roster-test-branch-2';
const EMP = 'roster-test-emp';
const EMP_OTHER = 'roster-test-emp-2';
const SHIFT = 'roster-test-shift';

const ADMIN = {
  id: 'roster-test-admin',
  email: 'roster-test@example.com',
  name: 'Roster Test Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('shift roster API (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);

  async function request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON bodies are tolerated, only the status is asserted */
    }
    return { status: res.status, json };
  }

  async function cleanup() {
    await pool!.query("DELETE FROM employee_shift_roster WHERE employee_id LIKE 'roster-test-emp%'");
    await pool!.query("DELETE FROM employees WHERE id LIKE 'roster-test-emp%'");
    await pool!.query("DELETE FROM hr_shifts WHERE id = $1", [SHIFT]);
    await pool!.query("DELETE FROM audit_logs WHERE branch_id LIKE 'roster-test-branch%'");
    await pool!.query("DELETE FROM branches WHERE id LIKE 'roster-test-branch%'");
  }

  before(async () => {
    await cleanup();
    const { ensurePostgresConnection } = await import('../server/db');
    assert.equal(await ensurePostgresConnection(), true, 'the dev database must be reachable');
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'RSTR', 'Roster Test Branch', 'Test'), ($2, 'RSTR2', 'Roster Other Branch', 'Test')`,
      [BRANCH, OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO employees (id, employee_code, name, branch_id, department)
       VALUES ($1, 'RST-001', 'Roster Test Employee', $2, 'Field'),
              ($3, 'RST-002', 'Roster Other Employee', $4, 'Field')`,
      [EMP, BRANCH, EMP_OTHER, OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO hr_shifts (id, code, name, start_time, end_time)
       VALUES ($1, 'RST-DAY', 'Roster Day', '09:00', '18:00')`,
      [SHIFT]
    );

    setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () =>
      new Promise<void>((done) => {
        (server as any).closeAllConnections?.();
        server.close(() => done());
      });
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('a seat is written, read back with its BS half, and removed', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const created = await request('POST', '/api/hr/shift-roster', {
      branchId: BRANCH,
      employeeId: EMP,
      shiftId: SHIFT,
      shiftDateAD: today,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.employeeId, EMP);
    assert.equal(created.json.shiftDateAD, today);
    assert.ok(created.json.shiftDateBS, 'the BS half is derived by the service');

    const listed = await request('GET', `/api/hr/shift-roster?branchId=${BRANCH}&from=${today}&to=${today}`);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    assert.equal(listed.json.roster.length, 1);
    assert.equal(listed.json.roster[0].shiftCode, 'RST-DAY');
    assert.equal(listed.json.roster[0].shiftDateBS, created.json.shiftDateBS);

    // The same seat is idempotent rather than a second row.
    const again = await request('POST', '/api/hr/shift-roster', {
      branchId: BRANCH,
      employeeId: EMP,
      shiftId: SHIFT,
      shiftDateAD: today,
    });
    assert.equal(again.status, 201);
    assert.equal(again.json.id, created.json.id);

    const removed = await request('DELETE', `/api/hr/shift-roster/${created.json.id}`, {
      branchId: BRANCH,
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    const empty = await request('GET', `/api/hr/shift-roster?branchId=${BRANCH}&from=${today}&to=${today}`);
    assert.equal(empty.json.roster.length, 0);
  });

  test('an employee from another branch cannot be rostered in', async () => {
    const refused = await request('POST', '/api/hr/shift-roster', {
      branchId: BRANCH,
      employeeId: EMP_OTHER,
      shiftId: SHIFT,
      shiftDateAD: new Date().toISOString().slice(0, 10),
    });
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
  });

  test('a bad date or a missing shift is refused before any write', async () => {
    const badDate = await request('POST', '/api/hr/shift-roster', {
      branchId: BRANCH,
      employeeId: EMP,
      shiftId: SHIFT,
      shiftDateAD: '2026-02-31',
    });
    assert.equal(badDate.status, 400, JSON.stringify(badDate.json));

    const badShift = await request('POST', '/api/hr/shift-roster', {
      branchId: BRANCH,
      employeeId: EMP,
      shiftId: 'no-such-shift',
      shiftDateAD: new Date().toISOString().slice(0, 10),
    });
    assert.equal(badShift.status, 404, JSON.stringify(badShift.json));
  });
});
