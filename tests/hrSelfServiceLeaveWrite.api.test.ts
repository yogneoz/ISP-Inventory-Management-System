/**
 * Employee self-service leave WRITES — the mobile client's create + withdraw.
 *
 * The reads are covered by hrSelfServiceLeave.api.test.ts; this file proves the
 * two write routes that app uses:
 *
 *   1. no token is 401 and a role without `hr-self-service` is 403;
 *   2. POST files a PENDING request for the employee linked to the caller's user
 *      id, returns the register's exact request shape and writes one audit row;
 *   3. a body naming another employee is refused (403), so the route can never
 *      file leave in someone else's name;
 *   4. window validation still holds: reversed dates, a cross-year window, a
 *      missing/unknown leave type and an overlapping request are refused;
 *   5. cancel withdraws the caller's own PENDING request, and a second cancel is
 *      a 409 rather than a silent success;
 *   6. another employee's request id is a 404 (not a 403), so the route does not
 *      confirm that a request exists outside the caller's records;
 *   7. approval is not reachable from the self-service routes.
 */
import { purgeAuditLogs } from './support/purgeAuditLogs';
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

const BRANCH = 'ess-lw-branch';
const ANNUAL = 'ess-lw-type-annual';
const EMP_A = 'ess-lw-emp-a';
const EMP_B = 'ess-lw-emp-b';

const ADMIN = {
  id: 'ess-lw-admin',
  email: 'ess-lw-admin@example.com',
  name: 'ESS Leave Write Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

function employeeUser(id: string) {
  return {
    id,
    email: `${id}@example.com`,
    name: `ESS Leave Write ${id}`,
    role: 'FRONT_DESK',
    branchId: BRANCH,
    allowedBranchIds: [BRANCH],
    canSwitchUser: false,
  } as any;
}

const USER_A = employeeUser('ess-lw-user-a');
const USER_B = employeeUser('ess-lw-user-b');

describe('employee self-service leave writes (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const adminToken = issueAuthToken(ADMIN);
  const userAToken = issueAuthToken(USER_A);
  const userBToken = issueAuthToken(USER_B);

  async function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    auth?: string | null
  ) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(auth === null ? {} : { authorization: 'Bearer ' + (auth || adminToken) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a non-JSON response must not be hidden, only tolerated here */
    }
    return { status: res.status, json, headers: res.headers };
  }

  const createLeave = (body: unknown, auth?: string | null) =>
    request('POST', '/api/hr/self-service/leave', body, auth);
  const cancelLeave = (id: string, auth?: string | null) =>
    request('POST', `/api/hr/self-service/leave/${encodeURIComponent(id)}/cancel`, {}, auth);

  async function requestRows(employeeId: string) {
    return (
      await pool!.query(
        `SELECT id, request_no, status, days_count, employee_id, branch_id
           FROM hr_leave_requests WHERE employee_id = $1 ORDER BY created_at DESC, request_no DESC`,
        [employeeId]
      )
    ).rows;
  }

  async function cleanup() {
    await pool!.query("DELETE FROM hr_leave_requests WHERE employee_id LIKE 'ess-lw-emp-%'");
    await pool!.query('DELETE FROM employees WHERE id LIKE ' + `'ess-lw-emp-%'`);
    await pool!.query("DELETE FROM users WHERE id LIKE 'ess-lw-user-%' OR id = 'ess-lw-admin'");
    await pool!.query('DELETE FROM hr_leave_types WHERE id = $1', [ANNUAL]);
    await pool!.query('DELETE FROM branches WHERE id = $1', [BRANCH]);
    await purgeAuditLogs(pool!, 'DELETE FROM audit_logs WHERE branch_id = $1', [BRANCH]);
  }

  before(async () => {
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'ESSLW', 'ESS Leave Write Branch', 'Test')`,
      [BRANCH]
    );
    for (const user of [USER_A, USER_B]) {
      await pool!.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
         VALUES ($1, $2, 'test-not-a-real-hash', $3, $4, $5, ARRAY[$6]::text[], 'active')`,
        [user.id, user.email, user.name, user.role, user.branchId, user.branchId]
      );
    }
    await pool!.query(
      `INSERT INTO hr_leave_types (id, code, name, annual_quota_days, is_paid)
       VALUES ($1, 'ESSLW-ANNUAL', 'ESS Leave Write Annual', 20, TRUE)`,
      [ANNUAL]
    );
    for (const [id, code, name, userId] of [
      [EMP_A, 'ESSLW-001', 'ESS Leave Write A', USER_A.id],
      [EMP_B, 'ESSLW-002', 'ESS Leave Write B', USER_B.id],
    ] as const) {
      await pool!.query(
        `INSERT INTO employees (id, employee_code, name, branch_id, user_id, department)
         VALUES ($1, $2, $3, $4, $5, 'Operations')`,
        [id, code, name, BRANCH, userId]
      );
    }

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

  test('files a pending request for the signed-in employee and audits it once', async () => {
    const unauthenticated = await createLeave(
      { leaveTypeId: ANNUAL, startDateAD: '2026-04-01', endDateAD: '2026-04-03' },
      null
    );
    assert.equal(unauthenticated.status, 401, JSON.stringify(unauthenticated.json));

    const deniedMatrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    deniedMatrix['hr-self-service'].FRONT_DESK = false;
    setPermissionMatrix(deniedMatrix);
    try {
      const denied = await createLeave(
        { leaveTypeId: ANNUAL, startDateAD: '2026-04-01', endDateAD: '2026-04-03' },
        userAToken
      );
      assert.equal(denied.status, 403, 'a role without hr-self-service must not write');
    } finally {
      setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    }

    const created = await createLeave(
      {
        leaveTypeId: ANNUAL,
        startDateAD: '2026-04-01',
        endDateAD: '2026-04-03',
        reason: 'Family trip',
      },
      userAToken
    );
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.headers.get('cache-control'), 'private, no-store');
    assert.equal(created.json.status, 'PENDING', 'self-service cannot self-approve');
    assert.equal(created.json.startDateAD, '2026-04-01');
    assert.equal(created.json.endDateAD, '2026-04-03');
    assert.equal(created.json.daysCount, 3, 'three inclusive days');
    assert.equal(created.json.reason, 'Family trip');
    assert.match(created.json.requestNo, /^LR-2026-[0-9A-F]{6}$/);

    const rows = await requestRows(EMP_A);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].employee_id, EMP_A, 'the request belongs to the session employee');
    assert.equal(rows[0].branch_id, BRANCH, 'the branch comes from the employee, not the body');

    const audits = (
      await pool!.query(
        `SELECT action, details FROM audit_logs
          WHERE branch_id = $1 AND action = 'CREATE_HR_LEAVE_REQUEST'`,
        [BRANCH]
      )
    ).rows;
    assert.equal(audits.length, 1, 'exactly one create audit row');
    assert.match(audits[0].details, new RegExp(created.json.requestNo));

    const own = await request('GET', '/api/hr/self-service/leave', undefined, userAToken);
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.json.requests.length, 1, 'the new request appears in own history');
    assert.equal(own.json.requests[0].requestNo, created.json.requestNo);
  });

  test('refuses a body that names another employee', async () => {
    const refused = await createLeave(
      {
        employeeId: EMP_B,
        leaveTypeId: ANNUAL,
        startDateAD: '2026-05-04',
        endDateAD: '2026-05-04',
      },
      userAToken
    );
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
    assert.match(refused.json.message, /signed-in employee/i);
    assert.equal((await requestRows(EMP_B)).length, 0, 'nothing was filed for B');
  });

  test('keeps the register validation: window, year, type and overlap', async () => {
    const reversed = await createLeave(
      { leaveTypeId: ANNUAL, startDateAD: '2026-06-05', endDateAD: '2026-06-01' },
      userAToken
    );
    assert.equal(reversed.status, 400, JSON.stringify(reversed.json));

    const crossYear = await createLeave(
      { leaveTypeId: ANNUAL, startDateAD: '2026-12-30', endDateAD: '2027-01-02' },
      userAToken
    );
    assert.equal(crossYear.status, 400, JSON.stringify(crossYear.json));

    const noType = await createLeave(
      { startDateAD: '2026-06-01', endDateAD: '2026-06-02' },
      userAToken
    );
    assert.equal(noType.status, 400, JSON.stringify(noType.json));

    const unknownType = await createLeave(
      { leaveTypeId: 'ess-lw-type-missing', startDateAD: '2026-06-01', endDateAD: '2026-06-02' },
      userAToken
    );
    assert.equal(unknownType.status, 400, JSON.stringify(unknownType.json));

    const first = await createLeave(
      { leaveTypeId: ANNUAL, startDateAD: '2026-07-01', endDateAD: '2026-07-05' },
      userAToken
    );
    assert.equal(first.status, 201, JSON.stringify(first.json));

    const overlap = await createLeave(
      { leaveTypeId: ANNUAL, startDateAD: '2026-07-04', endDateAD: '2026-07-08' },
      userAToken
    );
    assert.equal(overlap.status, 409, JSON.stringify(overlap.json));
    assert.match(overlap.json.message, /already covers one of these days/i);
  });

  test('withdraws only the caller own request and never confirms another employee id', async () => {
    const mine = await createLeave(
      { leaveTypeId: ANNUAL, startDateAD: '2026-08-03', endDateAD: '2026-08-04' },
      userAToken
    );
    assert.equal(mine.status, 201, JSON.stringify(mine.json));

    const theirs = await createLeave(
      { leaveTypeId: ANNUAL, startDateAD: '2026-08-03', endDateAD: '2026-08-04' },
      userBToken
    );
    assert.equal(theirs.status, 201, JSON.stringify(theirs.json));

    const foreign = await cancelLeave(theirs.json.id, userAToken);
    assert.equal(foreign.status, 404, 'another employee request must read as absent');
    assert.equal((await requestRows(EMP_B))[0].status, 'PENDING');

    const cancelled = await cancelLeave(mine.json.id, userAToken);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
    assert.equal(cancelled.json.status, 'CANCELLED');
    assert.equal(cancelled.json.daysCount, 2);

    const again = await cancelLeave(mine.json.id, userAToken);
    assert.equal(again.status, 409, 'a settled request cannot be cancelled twice');

    const unknown = await cancelLeave('ess-lw-req-does-not-exist', userAToken);
    assert.equal(unknown.status, 404);

    const audits = (
      await pool!.query(
        `SELECT action FROM audit_logs
          WHERE branch_id = $1 AND action IN ('CREATE_HR_LEAVE_REQUEST','CANCEL_HR_LEAVE_REQUEST')`,
        [BRANCH]
      )
    ).rows.map((row: any) => row.action);
    assert.ok(audits.includes('CANCEL_HR_LEAVE_REQUEST'), 'the cancel is audited');
  });

  test('approval is not reachable through the self-service routes', async () => {
    const mine = await createLeave(
      { leaveTypeId: ANNUAL, startDateAD: '2026-09-07', endDateAD: '2026-09-07' },
      userAToken
    );
    assert.equal(mine.status, 201, JSON.stringify(mine.json));

    const approve = await request(
      'POST',
      `/api/hr/self-service/leave/${encodeURIComponent(mine.json.id)}/approve`,
      {},
      userAToken
    );
    assert.equal(approve.status, 404, 'no self-service approval route exists');

    const row = (await requestRows(EMP_A)).find((r: any) => r.id === mine.json.id);
    assert.equal(row.status, 'PENDING', 'the request stayed pending');
  });
});
