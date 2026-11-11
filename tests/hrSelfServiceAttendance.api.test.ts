/**
 * Phase 3 employee self-service — own attendance in the recent window.
 *
 * The fixture writes attendance directly and drives the real HTTP route:
 *
 *   1. no token is 401; a denied role is 403;
 *   2. only the employee linked to the caller's user id is returned;
 *   3. the rolling 90-day window includes today−89 and excludes today−90;
 *   4. the summary is derived from the exact returned rows;
 *   5. employee/user selectors, `branchId=ALL`, another branch, a record path
 *      and an out-of-scope employee link are refused;
 *   6. reads do not mutate attendance and there is no write route.
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

const BRANCH = 'ess-att-branch';
const OTHER_BRANCH = 'ess-att-branch-2';

const ADMIN = {
  id: 'ess-att-admin',
  email: 'ess-att-admin@example.com',
  name: 'ESS Attendance Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

function employeeUser(id: string, branchId: string) {
  return {
    id,
    email: `${id}@example.com`,
    name: `ESS Attendance User ${id}`,
    role: 'FRONT_DESK',
    branchId,
    allowedBranchIds: [branchId],
    canSwitchUser: false,
  } as any;
}

const USER_A = employeeUser('ess-att-user-a', BRANCH);
const USER_B = employeeUser('ess-att-user-b', BRANCH);
const USER_OTHER = employeeUser('ess-att-user-other', OTHER_BRANCH);
const USER_CROSS = employeeUser('ess-att-user-cross', BRANCH);

const RECORD_KEYS = [
  'attendanceDateAD',
  'attendanceDateBS',
  'checkInTime',
  'checkOutTime',
  'id',
  'notes',
  'overtimeHours',
  'shiftCode',
  'shiftId',
  'shiftName',
  'source',
  'status',
  'updatedAt',
].sort();

const SUMMARY_KEYS = [
  'absentDays',
  'halfDays',
  'holidayDays',
  'leaveDays',
  'overtimeHours',
  'presentDays',
  'totalDays',
  'weekendDays',
].sort();

describe('employee self-service attendance (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
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

  async function attendanceCounts() {
    const { rows } = await pool!.query(
      `SELECT COUNT(*)::int AS rows FROM hr_attendance WHERE id LIKE 'ess-att-row-%'`
    );
    return rows[0];
  }

  async function cleanup() {
    await pool!.query("DELETE FROM hr_attendance WHERE id LIKE 'ess-att-row-%'");
    await pool!.query("DELETE FROM employees WHERE id LIKE 'ess-att-emp-%'");
    await pool!.query("DELETE FROM users WHERE id LIKE 'ess-att-user-%' OR id = 'ess-att-admin'");
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [[BRANCH, OTHER_BRANCH]]);
  }

  before(async () => {
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'ESSAB', 'ESS Attendance Test Branch', 'Test'),
              ($2, 'ESSAB2', 'ESS Attendance Other Branch', 'Test')`,
      [BRANCH, OTHER_BRANCH]
    );
    for (const user of [USER_A, USER_B, USER_OTHER, USER_CROSS]) {
      await pool!.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
         VALUES ($1, $2, 'test-not-a-real-hash', $3, $4, $5, ARRAY[$6]::text[], 'active')`,
        [user.id, user.email, user.name, user.role, user.branchId, user.branchId]
      );
    }

    const employees = [
      ['ess-att-emp-a', 'ESS-ATT-001', 'ESS Attendance A', BRANCH, USER_A.id],
      ['ess-att-emp-b', 'ESS-ATT-002', 'ESS Attendance B', BRANCH, USER_B.id],
      ['ess-att-emp-other', 'ESS-ATT-003', 'ESS Attendance Other', OTHER_BRANCH, USER_OTHER.id],
      ['ess-att-emp-cross', 'ESS-ATT-004', 'ESS Attendance Cross', OTHER_BRANCH, USER_CROSS.id],
    ];
    for (const [id, code, name, branchId, userId] of employees) {
      await pool!.query(
        `INSERT INTO employees (id, employee_code, name, branch_id, user_id, department)
         VALUES ($1, $2, $3, $4, $5, 'Operations')`,
        [id, code, name, branchId, userId]
      );
    }

    const attendance = [
      ['ess-att-row-a-today', 'ess-att-emp-a', BRANCH, 0, 'PRESENT', '09:05', '18:10', 1.25, 'Today shift'],
      ['ess-att-row-a-yesterday', 'ess-att-emp-a', BRANCH, 1, 'ABSENT', null, null, 0, null],
      ['ess-att-row-a-leave', 'ess-att-emp-a', BRANCH, 2, 'LEAVE', null, null, 0, 'Approved leave'],
      ['ess-att-row-a-half', 'ess-att-emp-a', BRANCH, 3, 'HALF_DAY', '09:00', '13:00', 1.5, null],
      ['ess-att-row-a-holiday', 'ess-att-emp-a', BRANCH, 4, 'HOLIDAY', null, null, 0, 'Public holiday'],
      ['ess-att-row-a-weekend', 'ess-att-emp-a', BRANCH, 5, 'WEEKEND', null, null, 0, null],
      ['ess-att-row-a-inside', 'ess-att-emp-a', BRANCH, 89, 'PRESENT', '10:00', '19:00', 0.75, 'Boundary day'],
      ['ess-att-row-a-outside', 'ess-att-emp-a', BRANCH, 90, 'PRESENT', null, null, 9, 'Too old'],
      ['ess-att-row-b', 'ess-att-emp-b', BRANCH, 1, 'PRESENT', null, null, 0, null],
      ['ess-att-row-other', 'ess-att-emp-other', OTHER_BRANCH, 1, 'ABSENT', null, null, 0, null],
      ['ess-att-row-cross', 'ess-att-emp-cross', OTHER_BRANCH, 1, 'PRESENT', null, null, 0, null],
    ];
    for (const [id, employeeId, branchId, dayOffset, status, checkIn, checkOut, overtime, notes] of attendance) {
      await pool!.query(
        `INSERT INTO hr_attendance (
           id, employee_id, branch_id, attendance_date_ad, attendance_date_bs,
           status, check_in_time, check_out_time, overtime_hours, notes, source
         ) VALUES (
           $1, $2, $3, CURRENT_DATE - $4::int, $5, $6, $7::time, $8::time,
           $9::numeric, $10, CASE WHEN $11::boolean THEN 'IMPORT' ELSE 'MANUAL' END
         )`,
        [
          id,
          employeeId,
          branchId,
          dayOffset,
          status === 'PRESENT' && dayOffset === 0 ? '2083-01-01 BS' : null,
          status,
          checkIn,
          checkOut,
          overtime,
          notes,
          status === 'PRESENT' && dayOffset === 0,
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

  test('401 without a token, 403 without the grant, and only own recent attendance', async () => {
    const unauthenticated = await get('/api/hr/self-service/attendance', null);
    assert.equal(unauthenticated.status, 401, JSON.stringify(unauthenticated.json));

    const deniedMatrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    deniedMatrix['hr-self-service'].FRONT_DESK = false;
    setPermissionMatrix(deniedMatrix);
    try {
      const denied = await get('/api/hr/self-service/attendance', userAToken);
      assert.equal(denied.status, 403, 'a role without hr-self-service must be refused');
    } finally {
      setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    }

    const own = await get('/api/hr/self-service/attendance', userAToken);
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Object.keys(own.json), [
      'windowStartAD',
      'windowEndAD',
      'windowDays',
      'summary',
      'records',
    ]);
    assert.equal(own.json.windowDays, 90);
    assert.equal(
      (Date.parse(own.json.windowEndAD) - Date.parse(own.json.windowStartAD)) / 86_400_000,
      89,
      'the window is today plus the previous 89 days'
    );
    assert.deepEqual(Object.keys(own.json.summary).sort(), SUMMARY_KEYS, 'exact summary fields');
    assert.deepEqual(
      own.json.summary,
      {
        totalDays: 7,
        presentDays: 2,
        absentDays: 1,
        leaveDays: 1,
        halfDays: 1,
        holidayDays: 1,
        weekendDays: 1,
        overtimeHours: 3.5,
      },
      'summary counts only returned rows'
    );
    assert.equal(own.json.records.length, 7, 'the 90-day boundary is included, day 91 is not');
    assert.deepEqual(Object.keys(own.json.records[0]).sort(), RECORD_KEYS, 'exact record fields');
    assert.deepEqual(
      own.json.records.map((row: any) => row.id),
      [
        'ess-att-row-a-today',
        'ess-att-row-a-yesterday',
        'ess-att-row-a-leave',
        'ess-att-row-a-half',
        'ess-att-row-a-holiday',
        'ess-att-row-a-weekend',
        'ess-att-row-a-inside',
      ],
      'attendance is newest first and excludes the out-of-window row'
    );
    assert.equal(own.json.records[0].checkInTime, '09:05');
    assert.equal(own.json.records[0].checkOutTime, '18:10');
    assert.equal(own.json.records[0].overtimeHours, 1.25);
    assert.equal(own.json.records[0].source, 'IMPORT');
    assert.equal(own.json.records[0].attendanceDateBS, '2083-01-01 BS');
    assert.equal(own.json.records[1].overtimeHours, 0);
    assert.equal(own.json.records[6].notes, 'Boundary day');

    const b = await get('/api/hr/self-service/attendance', userBToken);
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(b.json.records.length, 1);
    assert.equal(b.json.records[0].id, 'ess-att-row-b');
    assert.equal(b.json.summary.totalDays, 1);

    const otherBranchOwn = await get('/api/hr/self-service/attendance', otherToken);
    assert.equal(otherBranchOwn.status, 200, JSON.stringify(otherBranchOwn.json));
    assert.equal(otherBranchOwn.json.records[0].id, 'ess-att-row-other');

    const unlinked = await get('/api/hr/self-service/attendance', adminToken);
    assert.equal(unlinked.status, 404, 'an account without a linked employee is not widened');
  });

  test('selectors, branch widening, record paths and cross-branch links are refused, with no write path', async () => {
    const beforeCounts = await attendanceCounts();

    for (const selector of [
      '?employeeId=ess-att-emp-b',
      '?userId=ess-att-user-b',
      '?user_id=ess-att-user-b',
    ]) {
      const refused = await get(`/api/hr/self-service/attendance${selector}`, userAToken);
      assert.equal(refused.status, 403, `${selector} must be refused`);
      assert.match(refused.json.message, /self-service always returns the signed-in employee/i);
    }

    const allWidening = await get('/api/hr/self-service/attendance?branchId=ALL', userAToken);
    assert.equal(allWidening.status, 403, 'ALL must not widen the read');
    assert.match(allWidening.json.message, /all branches/i);

    const otherBranchFilter = await get(
      `/api/hr/self-service/attendance?branchId=${encodeURIComponent(OTHER_BRANCH)}`,
      userAToken
    );
    assert.equal(otherBranchFilter.status, 403, 'a branch filter naming another branch must be refused');

    const ownBranchFilter = await get(
      `/api/hr/self-service/attendance?branchId=${encodeURIComponent(BRANCH)}`,
      userAToken
    );
    assert.equal(ownBranchFilter.status, 200, 'the caller may name its own branch');
    assert.equal(ownBranchFilter.json.records.length, 7);

    const recordPath = await get('/api/hr/self-service/attendance/ess-att-row-a-today', userAToken);
    assert.equal(recordPath.status, 404, 'there is no record-id path to another day');

    const cross = await get('/api/hr/self-service/attendance', crossToken);
    assert.equal(cross.status, 403, 'an out-of-scope linked employee must be refused');

    const afterCounts = await attendanceCounts();
    assert.deepEqual(afterCounts, beforeCounts, 'reads must not create or delete attendance rows');

    const noWrite = await request('POST', '/api/hr/self-service/attendance', {}, userAToken);
    assert.equal(noWrite.status, 404, 'the route has no POST write path');
    const noPatch = await request('PATCH', '/api/hr/self-service/attendance', {}, userAToken);
    assert.equal(noPatch.status, 404, 'the route has no PATCH write path');
    const noDelete = await request('DELETE', '/api/hr/self-service/attendance', undefined, userAToken);
    assert.equal(noDelete.status, 404, 'the route has no DELETE write path');
  });
});