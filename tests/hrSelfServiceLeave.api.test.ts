/**
 * Phase 3 employee self-service — own leave balances and request history.
 *
 * The fixture writes the leave ledger directly and drives the real HTTP route:
 *
 *   1. no token is 401; a denied role is 403;
 *   2. only the employee linked to the caller's user id is returned;
 *   3. usage/remaining are derived from APPROVED requests in the same year;
 *   4. pending, rejected and cancelled history remains visible;
 *   5. employee/user selectors, `branchId=ALL`, another branch and an
 *      out-of-scope employee link are refused;
 *   6. reads do not mutate the ledger, and the only write paths are the
 *      create/withdraw routes covered by hrSelfServiceLeaveWrite.api.test.ts.
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

const BRANCH = 'ess-leave-branch';
const OTHER_BRANCH = 'ess-leave-branch-2';
const ANNUAL = 'ess-leave-type-annual';
const SICK = 'ess-leave-type-sick';

const ADMIN = {
  id: 'ess-leave-admin',
  email: 'ess-leave-admin@example.com',
  name: 'ESS Leave Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

function employeeUser(id: string, branchId: string) {
  return {
    id,
    email: `${id}@example.com`,
    name: `ESS Leave User ${id}`,
    role: 'FRONT_DESK',
    branchId,
    allowedBranchIds: [branchId],
    canSwitchUser: false,
  } as any;
}

const USER_A = employeeUser('ess-leave-user-a', BRANCH);
const USER_B = employeeUser('ess-leave-user-b', BRANCH);
const USER_OTHER = employeeUser('ess-leave-user-other', OTHER_BRANCH);
const USER_CROSS = employeeUser('ess-leave-user-cross', BRANCH);

const BALANCE_KEYS = [
  'adjustmentDays',
  'balanceYear',
  'entitlementDays',
  'id',
  'leaveTypeCode',
  'leaveTypeId',
  'leaveTypeName',
  'leaveTypePaid',
  'notes',
  'remainingDays',
  'updatedAt',
  'usedDays',
].sort();

const REQUEST_KEYS = [
  'createdAt',
  'daysCount',
  'decidedAt',
  'decidedBy',
  'decisionNote',
  'endDateAD',
  'endDateBS',
  'id',
  'leaveTypeCode',
  'leaveTypeId',
  'leaveTypeName',
  'reason',
  'requestNo',
  'startDateAD',
  'startDateBS',
  'status',
  'updatedAt',
].sort();

describe('employee self-service leave (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const adminToken = issueAuthToken(ADMIN);
  const userAToken = issueAuthToken(USER_A);
  const userBToken = issueAuthToken(USER_B);
  const otherToken = issueAuthToken(USER_OTHER);
  const crossToken = issueAuthToken(USER_CROSS);

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
      /* 404 has a JSON body, but do not hide a non-JSON response */
    }
    return { status: res.status, json, headers: res.headers };
  }

  const get = (path: string, auth?: string | null) => request('GET', path, undefined, auth);

  async function ledgerCounts() {
    const { rows } = await pool!.query(
      `SELECT
         (SELECT COUNT(*)::int FROM hr_leave_balances WHERE id LIKE 'ess-leave-bal-%') AS balances,
         (SELECT COUNT(*)::int FROM hr_leave_requests WHERE id LIKE 'ess-leave-req-%') AS requests`
    );
    return rows[0];
  }

  async function cleanup() {
    await pool!.query("DELETE FROM hr_leave_requests WHERE id LIKE 'ess-leave-req-%'");
    await pool!.query("DELETE FROM hr_leave_balances WHERE id LIKE 'ess-leave-bal-%'");
    await pool!.query("DELETE FROM employees WHERE id LIKE 'ess-leave-emp-%'");
    await pool!.query('DELETE FROM hr_leave_types WHERE id = ANY($1::varchar[])', [[ANNUAL, SICK]]);
    await pool!.query("DELETE FROM users WHERE id LIKE 'ess-leave-user-%' OR id = 'ess-leave-admin'");
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [[BRANCH, OTHER_BRANCH]]);
  }

  before(async () => {
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'ESSLB', 'ESS Leave Test Branch', 'Test'),
              ($2, 'ESSLB2', 'ESS Leave Other Branch', 'Test')`,
      [BRANCH, OTHER_BRANCH]
    );
    for (const user of [USER_A, USER_B, USER_OTHER, USER_CROSS]) {
      await pool!.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
         VALUES ($1, $2, 'test-not-a-real-hash', $3, $4, $5, ARRAY[$6]::text[], 'active')`,
        [user.id, user.email, user.name, user.role, user.branchId, user.branchId]
      );
    }
    await pool!.query(
      `INSERT INTO hr_leave_types (id, code, name, annual_quota_days, is_paid)
       VALUES ($1, 'EL-ANNUAL', 'ESS Annual Leave', 20, TRUE),
              ($2, 'EL-SICK', 'ESS Sick Leave', 10, FALSE)`,
      [ANNUAL, SICK]
    );

    const employees = [
      ['ess-leave-emp-a', 'ESS-LEAVE-001', 'ESS Leave A', BRANCH, USER_A.id],
      ['ess-leave-emp-b', 'ESS-LEAVE-002', 'ESS Leave B', BRANCH, USER_B.id],
      ['ess-leave-emp-other', 'ESS-LEAVE-003', 'ESS Leave Other', OTHER_BRANCH, USER_OTHER.id],
      ['ess-leave-emp-cross', 'ESS-LEAVE-004', 'ESS Leave Cross', OTHER_BRANCH, USER_CROSS.id],
    ];
    for (const [id, code, name, branchId, userId] of employees) {
      await pool!.query(
        `INSERT INTO employees (id, employee_code, name, branch_id, user_id, department)
         VALUES ($1, $2, $3, $4, $5, 'Operations')`,
        [id, code, name, branchId, userId]
      );
    }

    const balances = [
      ['ess-leave-bal-a-annual', 'ess-leave-emp-a', BRANCH, ANNUAL, 20, 2, null],
      ['ess-leave-bal-a-sick', 'ess-leave-emp-a', BRANCH, SICK, 10, 0, null],
      ['ess-leave-bal-b-annual', 'ess-leave-emp-b', BRANCH, ANNUAL, 15, 0, null],
      ['ess-leave-bal-other-sick', 'ess-leave-emp-other', OTHER_BRANCH, SICK, 10, 0, null],
      ['ess-leave-bal-cross-annual', 'ess-leave-emp-cross', OTHER_BRANCH, ANNUAL, 12, 0, null],
    ];
    for (const [id, employeeId, branchId, typeId, entitlement, adjustment, notes] of balances) {
      await pool!.query(
        `INSERT INTO hr_leave_balances (
           id, employee_id, branch_id, leave_type_id, balance_year,
           entitlement_days, adjustment_days, notes
         ) VALUES ($1, $2, $3, $4, 2099, $5::numeric, $6::numeric, $7)`,
        [id, employeeId, branchId, typeId, entitlement, adjustment, notes]
      );
    }

    const requests = [
      ['ess-leave-req-a-approved', 'ESS-LR-A-1', 'ess-leave-emp-a', BRANCH, ANNUAL, '2099-03-01', '2099-03-03', 3, 'APPROVED', 'Family event', 'HR Lead', 'Approved'],
      ['ess-leave-req-a-pending', 'ESS-LR-A-2', 'ess-leave-emp-a', BRANCH, ANNUAL, '2099-05-01', '2099-05-01', 1, 'PENDING', 'Personal', null, null],
      ['ess-leave-req-a-rejected', 'ESS-LR-A-3', 'ess-leave-emp-a', BRANCH, ANNUAL, '2099-07-01', '2099-07-02', 2, 'REJECTED', 'Trip', 'HR Lead', 'Team coverage'],
      ['ess-leave-req-a-cancelled', 'ESS-LR-A-4', 'ess-leave-emp-a', BRANCH, SICK, '2099-08-01', '2099-08-01', 1, 'CANCELLED', 'Recovered', null, null],
      ['ess-leave-req-b-approved', 'ESS-LR-B-1', 'ess-leave-emp-b', BRANCH, ANNUAL, '2099-04-01', '2099-04-02', 2, 'APPROVED', 'Family', 'HR Lead', null],
      ['ess-leave-req-other-pending', 'ESS-LR-O-1', 'ess-leave-emp-other', OTHER_BRANCH, SICK, '2099-06-01', '2099-06-01', 1, 'PENDING', 'Unwell', null, null],
      ['ess-leave-req-cross-approved', 'ESS-LR-C-1', 'ess-leave-emp-cross', OTHER_BRANCH, ANNUAL, '2099-09-01', '2099-09-02', 2, 'APPROVED', 'Event', 'HR Lead', null],
    ];
    for (const [id, no, employeeId, branchId, typeId, start, end, count, status, reason, decidedBy, decisionNote] of requests) {
      await pool!.query(
        `INSERT INTO hr_leave_requests (
           id, request_no, employee_id, branch_id, leave_type_id, start_date_ad,
           end_date_ad, start_date_bs, end_date_bs, days_count, reason, status,
           decided_by, decided_at, decision_note
         ) VALUES (
           $1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10::numeric, $11, $12,
           $13, CASE WHEN $13::varchar IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, $14
         )`,
        [
          id,
          no,
          employeeId,
          branchId,
          typeId,
          start,
          end,
          `${start} BS`,
          `${end} BS`,
          count,
          reason,
          status,
          decidedBy,
          decisionNote,
        ]
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

  test('401 without a token, 403 without the grant, and only own leave records', async () => {
    const unauthenticated = await get('/api/hr/self-service/leave', null);
    assert.equal(unauthenticated.status, 401, JSON.stringify(unauthenticated.json));

    const deniedMatrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    deniedMatrix['hr-self-service'].FRONT_DESK = false;
    setPermissionMatrix(deniedMatrix);
    try {
      const denied = await get('/api/hr/self-service/leave', userAToken);
      assert.equal(denied.status, 403, 'a role without hr-self-service must be refused');
    } finally {
      setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    }

    const own = await get('/api/hr/self-service/leave', userAToken);
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Object.keys(own.json), ['balances', 'requests']);
    assert.equal(own.json.balances.length, 2, 'only the two A balances');
    assert.equal(own.json.requests.length, 4, 'all four A request states are history');
    assert.deepEqual(Object.keys(own.json.balances[0]).sort(), BALANCE_KEYS, 'exact balance fields');
    assert.deepEqual(Object.keys(own.json.requests[0]).sort(), REQUEST_KEYS, 'exact request fields');

    const annual = own.json.balances.find((row: any) => row.leaveTypeCode === 'EL-ANNUAL');
    const sick = own.json.balances.find((row: any) => row.leaveTypeCode === 'EL-SICK');
    assert.ok(annual && sick, 'both configured balances must be visible');
    assert.equal(annual.leaveTypeName, 'ESS Annual Leave');
    assert.equal(annual.leaveTypePaid, true);
    assert.equal(annual.balanceYear, 2099);
    assert.equal(annual.entitlementDays, 20);
    assert.equal(annual.adjustmentDays, 2);
    assert.equal(annual.usedDays, 3, 'only the approved annual request counts');
    assert.equal(annual.remainingDays, 19);
    assert.equal(sick.remainingDays, 10);
    assert.equal(sick.leaveTypePaid, false);

    const approved = own.json.requests.find((row: any) => row.requestNo === 'ESS-LR-A-1');
    assert.ok(approved);
    assert.equal(approved.leaveTypeCode, 'EL-ANNUAL');
    assert.equal(approved.startDateAD, '2099-03-01');
    assert.equal(approved.endDateAD, '2099-03-03');
    assert.equal(approved.startDateBS, '2099-03-01 BS');
    assert.equal(approved.daysCount, 3);
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.reason, 'Family event');
    assert.equal(approved.decidedBy, 'HR Lead');
    assert.equal(approved.decisionNote, 'Approved');

    assert.deepEqual(
      own.json.requests.map((row: any) => row.requestNo),
      ['ESS-LR-A-4', 'ESS-LR-A-3', 'ESS-LR-A-2', 'ESS-LR-A-1'],
      'request history is newest first'
    );

    const b = await get('/api/hr/self-service/leave', userBToken);
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(b.json.balances.length, 1);
    assert.equal(b.json.balances[0].usedDays, 2);
    assert.equal(b.json.balances[0].remainingDays, 13);
    assert.equal(b.json.requests.length, 1);
    assert.equal(b.json.requests[0].requestNo, 'ESS-LR-B-1');

    const otherBranchOwn = await get('/api/hr/self-service/leave', otherToken);
    assert.equal(otherBranchOwn.status, 200, JSON.stringify(otherBranchOwn.json));
    assert.equal(otherBranchOwn.json.balances[0].leaveTypeCode, 'EL-SICK');
    assert.equal(otherBranchOwn.json.requests[0].requestNo, 'ESS-LR-O-1');

    const unlinked = await get('/api/hr/self-service/leave', adminToken);
    assert.equal(unlinked.status, 404, 'an account without a linked employee is not widened');
  });

  test('selectors, branch widening and cross-branch links are refused', async () => {
    const beforeCounts = await ledgerCounts();

    for (const selector of [
      '?employeeId=ess-leave-emp-b',
      '?userId=ess-leave-user-b',
      '?user_id=ess-leave-user-b',
    ]) {
      const refused = await get(`/api/hr/self-service/leave${selector}`, userAToken);
      assert.equal(refused.status, 403, `${selector} must be refused`);
      assert.match(refused.json.message, /self-service always returns the signed-in employee/i);
    }

    const allWidening = await get('/api/hr/self-service/leave?branchId=ALL', userAToken);
    assert.equal(allWidening.status, 403, 'ALL must not widen the read');
    assert.match(allWidening.json.message, /all branches/i);

    const otherBranchFilter = await get(
      `/api/hr/self-service/leave?branchId=${encodeURIComponent(OTHER_BRANCH)}`,
      userAToken
    );
    assert.equal(otherBranchFilter.status, 403, 'a branch filter naming another branch must be refused');

    const ownBranchFilter = await get(
      `/api/hr/self-service/leave?branchId=${encodeURIComponent(BRANCH)}`,
      userAToken
    );
    assert.equal(ownBranchFilter.status, 200, 'the caller may name its own branch');
    assert.equal(ownBranchFilter.json.balances.length, 2);

    const cross = await get('/api/hr/self-service/leave', crossToken);
    assert.equal(cross.status, 403, 'an out-of-scope linked employee must be refused');

    const afterCounts = await ledgerCounts();
    assert.deepEqual(afterCounts, beforeCounts, 'reads must not create or delete leave rows');

    // The only write path is POST (create) plus POST :id/cancel; an incomplete
    // body is refused by validation rather than reaching the ledger.
    const emptyCreate = await request('POST', '/api/hr/self-service/leave', {}, userAToken);
    assert.equal(emptyCreate.status, 400, JSON.stringify(emptyCreate.json));
    assert.match(emptyCreate.json.message, /leave type is required/i);
    const noPatch = await request('PATCH', '/api/hr/self-service/leave', {}, userAToken);
    assert.equal(noPatch.status, 404, 'the route has no PATCH write path');
    const noDelete = await request('DELETE', '/api/hr/self-service/leave', undefined, userAToken);
    assert.equal(noDelete.status, 404, 'the route has no DELETE write path');
    assert.deepEqual(await ledgerCounts(), beforeCounts, 'a refused create writes nothing');
  });
});
