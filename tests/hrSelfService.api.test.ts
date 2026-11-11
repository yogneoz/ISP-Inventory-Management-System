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
 *   5. reads never mutate the employee row;
 *   6. the one write is the caller's own contact card/photo: HR-owned columns
 *      and unknown fields are refused by name, malformed values and an
 *      oversized/non-image photo are refused, and each save audits once.
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
  'profilePhoto',
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
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

  test('a permitted save changes only the contact card and the photo', async () => {
    const columns = `monthly_salary::text AS salary, bank_account, bank_name, pan_number,
      ssf_number, designation, designation_code, employment_type, personal_contact,
      personal_email, address, emergency_contact_person, emergency_contact_number,
      profile_photo`;
    const before = (await pool!.query(`SELECT ${columns} FROM employees WHERE id = $1`, [empA.id]))
      .rows[0];

    const photo = `data:image/jpeg;base64,${Buffer.from('resized-square-photo').toString('base64')}`;
    const saved = await request(
      'PUT',
      '/api/hr/self-service/profile',
      {
        personalContact: '9811111111',
        personalEmail: 'new.address@example.com',
        address: 'Pokhara, Nepal',
        emergencyContactPerson: 'New Emergency Contact',
        emergencyContactNumber: '9822222222',
        profilePhoto: photo,
      },
      userAToken
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.id, empA.id, 'the write returns the caller own row');
    assert.equal(saved.json.personalContact, '9811111111');
    assert.equal(saved.json.personalEmail, 'new.address@example.com');
    assert.equal(saved.json.address, 'Pokhara, Nepal');
    assert.equal(saved.json.emergencyContactPerson, 'New Emergency Contact');
    assert.equal(saved.json.emergencyContactNumber, '9822222222');
    assert.equal(saved.json.profilePhoto, photo);

    // HR-owned columns come back from the same row, untouched.
    assert.equal(saved.json.monthlySalary, '123456.78');
    assert.equal(saved.json.panNumber, '900000001');
    assert.equal(saved.json.bankAccount, 'ACC-ESS-1');
    assert.equal(saved.json.designation, 'ESS Analyst');

    const after = (await pool!.query(`SELECT ${columns} FROM employees WHERE id = $1`, [empA.id]))
      .rows[0];
    for (const column of ['salary', 'bank_account', 'bank_name', 'pan_number', 'ssf_number', 'designation', 'designation_code', 'employment_type']) {
      assert.deepEqual(after[column], before[column], `${column} must not change from self-service`);
    }
    assert.equal(after.profile_photo, photo);

    // A null photo clears the picture; the other fields save as given.
    const cleared = await request(
      'PUT',
      '/api/hr/self-service/profile',
      {
        personalContact: null,
        personalEmail: null,
        address: null,
        emergencyContactPerson: null,
        emergencyContactNumber: null,
        profilePhoto: null,
      },
      userAToken
    );
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
    assert.equal(cleared.json.personalContact, null);
    assert.equal(cleared.json.profilePhoto, null);

    // Put the fixture values back for the later cases.
    const restored = await request(
      'PUT',
      '/api/hr/self-service/profile',
      {
        personalContact: '9800000001',
        personalEmail: 'ess-001@personal.example',
        address: 'Kathmandu, Nepal',
        emergencyContactPerson: 'ESS Emergency',
        emergencyContactNumber: '9800000002',
        profilePhoto: null,
      },
      userAToken
    );
    assert.equal(restored.status, 200);
    assert.equal(restored.json.address, 'Kathmandu, Nepal');
  });

  test('HR-only, malformed and oversized values are refused without writing', async () => {
    const before = (await pool!.query(
      'SELECT personal_contact, personal_email, profile_photo FROM employees WHERE id = $1',
      [empA.id]
    )).rows[0];
    const auditsBefore = (
      await pool!.query(
        "SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = 'UPDATE_SELF_SERVICE_PROFILE'"
      )
    ).rows[0].count;

    const cases: Array<[string, unknown, number]> = [
      ['salary', { monthlySalary: 999999 }, 400],
      ['bank account', { bankAccount: 'ACC-HACK' }, 400],
      ['designation', { designation: 'CEO' }, 400],
      ['employee code', { employeeCode: 'HACK-1' }, 400],
      // The branch guard answers before the controller: a body naming another
      // branch is refused as out-of-scope, not as an unknown field.
      ['branch', { branchId: OTHER_BRANCH }, 403],
      ['unknown field', { nickname: 'x' }, 400],
      ['bad phone', { personalContact: 'call-me' }, 400],
      ['bad e-mail', { personalEmail: 'not-an-email' }, 400],
      ['bad photo type', { profilePhoto: 'data:text/plain;base64,AAAA' }, 400],
      ['oversized photo', { profilePhoto: `data:image/jpeg;base64,${'A'.repeat(300 * 1024)}` }, 413],
    ];

    for (const [label, body, status] of cases) {
      const refused = await request('PUT', '/api/hr/self-service/profile', body, userAToken);
      assert.equal(refused.status, status, `${label}: ${JSON.stringify(refused.json)}`);
    }

    const after = (await pool!.query(
      'SELECT personal_contact, personal_email, profile_photo FROM employees WHERE id = $1',
      [empA.id]
    )).rows[0];
    assert.deepEqual(after, before, 'a refused save must change nothing');
    const auditsAfter = (
      await pool!.query(
        "SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = 'UPDATE_SELF_SERVICE_PROFILE'"
      )
    ).rows[0].count;
    assert.equal(auditsAfter, auditsBefore, 'a refused save must not audit');
  });

  test('the write needs the grant, and branch scope still applies', async () => {
    const deniedMatrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    deniedMatrix['hr-self-service'].FRONT_DESK = false;
    setPermissionMatrix(deniedMatrix);
    try {
      const denied = await request(
        'PUT',
        '/api/hr/self-service/profile',
        { personalContact: '9800000001' },
        userAToken
      );
      assert.equal(denied.status, 403, 'a role without hr-self-service must not write');
    } finally {
      setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    }

    const unauthenticated = await request(
      'PUT',
      '/api/hr/self-service/profile',
      { personalContact: '9800000001' },
      null
    );
    assert.equal(unauthenticated.status, 401);

    // The linked employee sits in a branch this account may not act on.
    const cross = await request(
      'PUT',
      '/api/hr/self-service/profile',
      { personalContact: '9800000001' },
      crossToken
    );
    assert.equal(cross.status, 403, 'a cross-branch linked employee must be refused');

    // A selector cannot redirect the write to a colleague
    const selector = await request(
      'PUT',
      '/api/hr/self-service/profile?employeeId=' + encodeURIComponent(empB.id),
      { personalContact: '9800000001' },
      userAToken
    );
    assert.equal(selector.status, 403, 'employee selectors are refused on write too');
  });

  test('each successful save writes exactly one self-service audit row', async () => {
    const count = async (): Promise<number> =>
      Number(
        (
          await pool!.query(
            "SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = 'UPDATE_SELF_SERVICE_PROFILE'"
          )
        ).rows[0].count
      );
    const before = await count();
    const saved = await request(
      'PUT',
      '/api/hr/self-service/profile',
      {
        personalContact: '9800000001',
        personalEmail: 'ess-001@personal.example',
        address: 'Kathmandu, Nepal',
        emergencyContactPerson: 'ESS Emergency',
        emergencyContactNumber: '9800000002',
        profilePhoto: null,
      },
      userAToken
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal((await count()) - before, 1, 'one audit row per save');

    const row = (await pool!.query(
      "SELECT module, branch_id FROM audit_logs WHERE action = 'UPDATE_SELF_SERVICE_PROFILE' ORDER BY timestamp_ad DESC LIMIT 1"
    )).rows[0];
    assert.equal(row.module, 'AUTH');
    assert.equal(row.branch_id, BRANCH);
  });
});
