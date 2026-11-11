/**
 * Phase 3 employee self-service — the own-profile read.
 *
 * These cases drive the real HTTP route against PostgreSQL and prove the ESS
 * contract rather than the source text:
 *
 *   1. no token is a 401; a denied role is a 403;
 *   2. the endpoint returns ONLY the employee linked to the caller's user id,
 *      with the exact field set and exact two-decimal salary;
 *   3. employee/user selectors and an `ALL` branch widening are refused;
 *   4. an employee linked to a branch outside the account's allowed scope is
 *      refused, so branch scoping is enforced server-side;
 *   5. reads never mutate the employee row and there is no write path.
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

const BRANCH = 'hr-ess-test-branch';
const OTHER_BRANCH = 'hr-ess-test-branch-2';

const ADMIN = {
  id: 'ess-admin',
  email: 'ess-admin@example.com',
  name: 'ESS Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

function employeeUser(id: string, branchId: string) {
  return {
    id,
    email: `${id}@example.com`,
    name: `ESS User ${id}`,
    role: 'FRONT_DESK',
    branchId,
    allowedBranchIds: [branchId],
    canSwitchUser: false,
  } as any;
}

const USER_A = employeeUser('ess-user-a', BRANCH);
const USER_B = employeeUser('ess-user-b', BRANCH);
const USER_OTHER = employeeUser('ess-user-other', OTHER_BRANCH);
const USER_CROSS = employeeUser('ess-user-cross', BRANCH);

const PROFILE_KEYS = [
  'address',
  'bankAccount',
  'bankName',
  'branchId',
  'branchName',
  'contractExpiryAD',
  'createdAt',
  'dateOfBirthAD',
  'department',
  'designation',
  'designationCode',
  'employeeCode',
  'emergencyContactNumber',
  'emergencyContactPerson',
  'employmentType',
  'id',
  'internalEmail',
  'isActive',
  'joiningDateAD',
  'monthlySalary',
  'name',
  'panNumber',
  'personalContact',
  'personalEmail',
  'ssfEligible',
  'ssfNumber',
  'updatedAt',
  'workStation',
].sort();

describe('employee self-service profile (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const adminToken = issueAuthToken(ADMIN);
  const userAToken = issueAuthToken(USER_A);
  const userBToken = issueAuthToken(USER_B);
  const otherToken = issueAuthToken(USER_OTHER);
  const crossToken = issueAuthToken(USER_CROSS);

  let empA: any = null;
  let empB: any = null;
  let empOther: any = null;
  let empCross: any = null;

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

  function employeeBody(code: string, branchId: string, userId: string) {
    return {
      employeeCode: code,
      name: `ESS ${code}`,
      branchId,
      userId,
      department: 'Operations',
      designation: 'ESS Analyst',
      designationCode: 'ESS-AN',
      employmentType: 'Non-PB',
      workStation: 'Test Work Station',
      joiningDateAD: '2026-01-05',
      dateOfBirthAD: '1994-04-09',
      contractExpiryAD: '2027-01-04',
      internalEmail: `${code.toLowerCase()}@internal.example`,
      personalEmail: `${code.toLowerCase()}@personal.example`,
      personalContact: '9800000001',
      emergencyContactPerson: 'ESS Emergency',
      emergencyContactNumber: '9800000002',
      address: 'Kathmandu, Nepal',
      panNumber: '900000001',
      ssfNumber: 'SSF-ESS-1',
      ssfEligible: true,
      bankName: 'ESS Test Bank',
      bankAccount: 'ACC-ESS-1',
      monthlySalary: 123456.78,
    };
  }

  async function employeeCount(): Promise<number> {
    const { rows } = await pool!.query(
      "SELECT COUNT(*)::int AS count FROM employees WHERE employee_code LIKE 'ESS-%'"
    );
    return Number(rows[0].count);
  }

  async function cleanup() {
    await pool!.query("DELETE FROM employees WHERE employee_code LIKE 'ESS-%'");
    await pool!.query(
      "DELETE FROM audit_logs WHERE action = 'CREATE_EMPLOYEE' AND details LIKE '%ESS %'"
    );
    await pool!.query("DELETE FROM users WHERE id LIKE 'ess-user-%' OR id = 'ess-admin'");
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [[BRANCH, OTHER_BRANCH]]);
  }

  before(async () => {
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'ESSB', 'ESS Test Branch', 'Test'),
              ($2, 'ESSB2', 'ESS Other Branch', 'Test')`,
      [BRANCH, OTHER_BRANCH]
    );
    for (const user of [USER_A, USER_B, USER_OTHER, USER_CROSS]) {
      await pool!.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
         VALUES ($1, $2, 'test-not-a-real-hash', $3, $4, $5, ARRAY[$6]::text[], 'active')`,
        [user.id, user.email, user.name, user.role, user.branchId, user.branchId]
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

    empA = (
      await request('POST', '/api/employees', employeeBody('ESS-001', BRANCH, USER_A.id))
    ).json;
    empB = (
      await request('POST', '/api/employees', employeeBody('ESS-002', BRANCH, USER_B.id))
    ).json;
    empOther = (
      await request('POST', '/api/employees', employeeBody('ESS-003', OTHER_BRANCH, USER_OTHER.id))
    ).json;
    // This employee is linked to a branch-A account but filed under the other
    // branch; the ESS read must refuse it by branch scope.
    empCross = (
      await request('POST', '/api/employees', employeeBody('ESS-004', OTHER_BRANCH, USER_CROSS.id))
    ).json;
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('401 without a token, 403 without the self-service grant, and only the caller is returned', async () => {
    assert.ok(empA?.id && empB?.id && empOther?.id && empCross?.id, 'fixture employees must exist');

    const unauthenticated = await get('/api/hr/self-service/profile', null);
    assert.equal(unauthenticated.status, 401, JSON.stringify(unauthenticated.json));

    const deniedMatrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    deniedMatrix['hr-self-service'].FRONT_DESK = false;
    setPermissionMatrix(deniedMatrix);
    try {
      const denied = await get('/api/hr/self-service/profile', userAToken);
      assert.equal(denied.status, 403, 'a role without hr-self-service must be refused');
    } finally {
      setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    }

    const own = await get('/api/hr/self-service/profile', userAToken);
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Object.keys(own.json).sort(), PROFILE_KEYS, 'the exact own-profile field set');
    assert.equal(own.json.id, empA.id);
    assert.equal(own.json.employeeCode, 'ESS-001');
    assert.equal(own.json.name, 'ESS ESS-001');
    assert.equal(own.json.branchId, BRANCH);
    assert.equal(own.json.branchName, 'ESS Test Branch');
    assert.equal(own.json.department, 'Operations');
    assert.equal(own.json.designation, 'ESS Analyst');
    assert.equal(own.json.designationCode, 'ESS-AN');
    assert.equal(own.json.employmentType, 'Non-PB');
    assert.equal(own.json.workStation, 'Test Work Station');
    assert.equal(own.json.joiningDateAD, '2026-01-05');
    assert.equal(own.json.dateOfBirthAD, '1994-04-09');
    assert.equal(own.json.contractExpiryAD, '2027-01-04');
    assert.equal(own.json.internalEmail, 'ess-001@internal.example');
    assert.equal(own.json.personalEmail, 'ess-001@personal.example');
    assert.equal(own.json.personalContact, '9800000001');
    assert.equal(own.json.emergencyContactPerson, 'ESS Emergency');
    assert.equal(own.json.emergencyContactNumber, '9800000002');
    assert.equal(own.json.address, 'Kathmandu, Nepal');
    assert.equal(own.json.panNumber, '900000001');
    assert.equal(own.json.ssfNumber, 'SSF-ESS-1');
    assert.equal(own.json.ssfEligible, true);
    assert.equal(own.json.bankName, 'ESS Test Bank');
    assert.equal(own.json.bankAccount, 'ACC-ESS-1');
    assert.equal(own.json.monthlySalary, '123456.78', 'numeric salary keeps two decimals');
    assert.equal(own.json.isActive, true);

    // The second account is a different employee, and it never sees the first.
    const otherOwn = await get('/api/hr/self-service/profile', userBToken);
    assert.equal(otherOwn.status, 200);
    assert.equal(otherOwn.json.id, empB.id);
    assert.equal(otherOwn.json.employeeCode, 'ESS-002');
    assert.notEqual(otherOwn.json.id, empA.id);

    // A branch-B employee's own record is readable under its own token.
    const otherBranchOwn = await get('/api/hr/self-service/profile', otherToken);
    assert.equal(otherBranchOwn.status, 200);
    assert.equal(otherBranchOwn.json.id, empOther.id);
    assert.equal(otherBranchOwn.json.branchId, OTHER_BRANCH);

    // An admin with no linked employee gets 404 rather than a widened read.
    const unlinked = await get('/api/hr/self-service/profile', adminToken);
    assert.equal(unlinked.status, 404);
  });

  test('employee/user selectors and branch widening are refused, and cross-branch links are refused', async () => {
    const beforeCount = await employeeCount();

    for (const selector of [
      `?employeeId=${encodeURIComponent(empB.id)}`,
      `?userId=${encodeURIComponent(USER_B.id)}`,
      '?user_id=ess-user-b',
    ]) {
      const refused = await get(`/api/hr/self-service/profile${selector}`, userAToken);
      assert.equal(refused.status, 403, `${selector} must be refused`);
      assert.match(refused.json.message, /self-service always returns the signed-in employee/i);
    }

    const allWidening = await get('/api/hr/self-service/profile?branchId=ALL', userAToken);
    assert.equal(allWidening.status, 403, 'ALL must not widen the read');
    assert.match(allWidening.json.message, /all branches/i);

    const otherBranchFilter = await get(
      `/api/hr/self-service/profile?branchId=${encodeURIComponent(OTHER_BRANCH)}`,
      userAToken
    );
    assert.equal(otherBranchFilter.status, 403, 'a branch filter naming another branch must be refused');

    const ownBranchFilter = await get(
      `/api/hr/self-service/profile?branchId=${encodeURIComponent(BRANCH)}`,
      userAToken
    );
    assert.equal(ownBranchFilter.status, 200, 'the caller may name its own branch');
    assert.equal(ownBranchFilter.json.id, empA.id);

    // The linked employee is in another branch: own-user lookup is not enough.
    const cross = await get('/api/hr/self-service/profile', crossToken);
    assert.equal(cross.status, 403, 'an out-of-scope linked employee must be refused');

    const afterCount = await employeeCount();
    assert.equal(afterCount, beforeCount, 'reads must not create or delete employees');

    const noWrite = await request('POST', '/api/hr/self-service/profile', {}, userAToken);
    assert.equal(noWrite.status, 404, 'the route has no POST write path');
    const noPatch = await request('PATCH', '/api/hr/self-service/profile', {}, userAToken);
    assert.equal(noPatch.status, 404, 'the route has no PATCH write path');
    const noDelete = await request('DELETE', '/api/hr/self-service/profile', undefined, userAToken);
    assert.equal(noDelete.status, 404, 'the route has no DELETE write path');
  });
});
