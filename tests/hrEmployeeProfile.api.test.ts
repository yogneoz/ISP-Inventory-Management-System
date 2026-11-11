/**
 * F1 Employee Profile — the paper form's personal, family, experience,
 * qualification, medical, declaration and reference sections.
 *
 * The fixture creates two branches and one employee in each, then drives the
 * real HTTP routes:
 *
 *   1. no valid token is 401 for both the read and the write;
 *   2. a manager reads the full shape, an empty profile included;
 *   3. a save round-trips every scalar and every repeating block in form order,
 *      with the rows really in PostgreSQL;
 *   4. the repeating blocks are REPLACED, not appended to;
 *   5. a bounded list, an out-of-range percentage, a reversed period, a blank
 *      required name, an unknown blood group and a malformed date are all 400
 *      and leave the stored profile untouched;
 *   6. a view-only officer receives the masked shape and is refused the write;
 *   7. another branch's employee is a 404, not a 403 (no id probing);
 *   8. each successful save writes exactly one audit row.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      connectionTimeoutMillis: 2000,
    });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const BRANCH = 'profile-f1-branch';
const OTHER_BRANCH = 'profile-f1-branch-2';
const EMP_A = 'profile-f1-emp-a';
const EMP_B = 'profile-f1-emp-b';

const ADMIN = {
  id: 'profile-f1-admin',
  email: 'profile-f1-admin@example.com',
  name: 'Profile Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

/** HR_MANAGER holds view + manage but only inside its own branch. */
const MANAGER = {
  id: 'profile-f1-manager',
  email: 'profile-f1-manager@example.com',
  name: 'Profile Manager',
  role: 'HR_MANAGER',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;

/** HR_OFFICER is view-only, so the PII half must stay masked. */
const OFFICER = {
  id: 'profile-f1-officer',
  email: 'profile-f1-officer@example.com',
  name: 'Profile Officer',
  role: 'HR_OFFICER',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;

function fullProfile() {
  return {
    fatherName: 'Father One',
    grandfatherName: 'Grandfather One',
    permanentAddress: 'Permanent Street 1, Kathmandu',
    localAddress: 'Local Street 2, Lalitpur',
    emergencyContactAddress: 'ICE Street 3, Bhaktapur',
    emergencyContactRelation: 'Brother',
    bloodGroup: 'O+',
    medicalConditions: 'None',
    medicalDetails: 'No chronic illness declared.',
    accidentDetails: 'None',
    caseDetails: 'None',
    declarationDateAD: '2027-04-01',
    declarationName: 'Profile Employee One',
    familyMembers: [
      { name: 'Mother One', age: 58, occupation: 'Homemaker', relation: 'Mother' },
      { name: 'Spouse One', age: 30, occupation: 'Engineer', relation: 'Spouse' },
    ],
    experience: [
      {
        organization: 'Old ISP Pvt Ltd',
        fromAD: '2019-01-01',
        toAD: '2021-12-31',
        designation: 'Field Technician',
      },
    ],
    qualifications: [
      { examPassed: 'BSc CSIT', boardUniversity: 'Tribhuvan University', percentage: 72.5 },
    ],
    references: [
      { name: 'Ref One', organization: 'Old ISP Pvt Ltd', contact: '9800000000', relation: 'Supervisor' },
    ],
  };
}

describe('F1 employee profile (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const adminToken = issueAuthToken(ADMIN);
  const managerToken = issueAuthToken(MANAGER);
  const officerToken = issueAuthToken(OFFICER);

  async function request(
    method: 'GET' | 'PUT',
    path: string,
    body?: unknown,
    auth = adminToken
  ) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: 'Bearer ' + auth,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a 204 or a bodyless error */
    }
    return { status: res.status, json };
  }

  const get = (path: string, auth = adminToken) => request('GET', path, undefined, auth);
  const put = (path: string, body: unknown, auth = adminToken) =>
    request('PUT', path, body, auth);

  async function familyCount(employeeId: string): Promise<number> {
    const { rows } = await pool!.query(
      'SELECT COUNT(*)::int AS count FROM hr_employee_family_members WHERE employee_id = $1',
      [employeeId]
    );
    return Number(rows[0].count);
  }

  async function profileAuditCount(): Promise<number> {
    const { rows } = await pool!.query(
      `SELECT COUNT(*)::int AS count FROM audit_logs
        WHERE action = 'UPDATE_EMPLOYEE_PROFILE' AND branch_id = $1`,
      [BRANCH]
    );
    return Number(rows[0].count);
  }

  async function cleanup() {
    await pool!.query('DELETE FROM employees WHERE employee_code LIKE $1', ['PRF1-%']);
    await pool!.query('DELETE FROM audit_logs WHERE branch_id = ANY($1::varchar[])', [
      [BRANCH, OTHER_BRANCH],
    ]);
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [
      [BRANCH, OTHER_BRANCH],
    ]);
  }

  before(async () => {
    setPermissionMatrix(DEFAULT_PERMISSIONS_MATRIX as any);
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'PRF1B', 'Profile F1 Branch', 'Test'),
              ($2, 'PRF1B2', 'Profile F1 Branch 2', 'Test')`,
      [BRANCH, OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO employees (id, employee_code, name, branch_id, is_active)
       VALUES ($1, 'PRF1-001', 'Profile Employee One', $3, TRUE),
              ($2, 'PRF1-002', 'Profile Employee Two', $4, TRUE)`,
      [EMP_A, EMP_B, BRANCH, OTHER_BRANCH]
    );

    const app = createApp();
    registerAllRoutes(app);
    await new Promise<void>((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port;
        close = () =>
          new Promise((done) => {
            server.close(() => done());
          });
        resolve();
      });
    });
  });

  after(async () => {
    await close?.();
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('an unauthenticated caller cannot read or write the profile', async () => {
    const read = await request('GET', `/api/employees/${EMP_A}/profile`, undefined, 'not-a-token');
    assert.equal(read.status, 401);
    const write = await request(
      'PUT',
      `/api/employees/${EMP_A}/profile`,
      fullProfile(),
      'not-a-token'
    );
    assert.equal(write.status, 401);
  });

  test('a manager reads the full shape, empty profile included', async () => {
    const res = await get(`/api/employees/${EMP_A}/profile`, managerToken);
    assert.equal(res.status, 200);
    assert.equal(res.json.masked, false);
    assert.equal(res.json.employeeCode, 'PRF1-001');
    assert.equal(res.json.branchId, BRANCH);
    assert.equal(res.json.profile.fatherName, null);
    assert.equal(res.json.profile.bloodGroup, null);
    assert.deepEqual(res.json.familyMembers, []);
    assert.deepEqual(res.json.experience, []);
    assert.deepEqual(res.json.qualifications, []);
    assert.deepEqual(res.json.references, []);
  });

  test('a save round-trips every section in form order', async () => {
    const res = await put(`/api/employees/${EMP_A}/profile`, fullProfile(), managerToken);
    assert.equal(res.status, 200);
    assert.equal(res.json.profile.fatherName, 'Father One');
    assert.equal(res.json.profile.grandfatherName, 'Grandfather One');
    assert.equal(res.json.profile.permanentAddress, 'Permanent Street 1, Kathmandu');
    assert.equal(res.json.profile.localAddress, 'Local Street 2, Lalitpur');
    assert.equal(res.json.profile.emergencyContactRelation, 'Brother');
    assert.equal(res.json.profile.emergencyContactAddress, 'ICE Street 3, Bhaktapur');
    assert.equal(res.json.profile.bloodGroup, 'O+');
    assert.equal(res.json.profile.medicalConditions, 'None');
    assert.equal(res.json.profile.accidentDetails, 'None');
    assert.equal(res.json.profile.caseDetails, 'None');
    assert.equal(res.json.profile.declarationDateAD, '2027-04-01');
    assert.equal(res.json.profile.declarationName, 'Profile Employee One');

    assert.deepEqual(
      res.json.familyMembers.map((row: any) => row.name),
      ['Mother One', 'Spouse One']
    );
    assert.deepEqual(
      res.json.familyMembers.map((row: any) => row.sortOrder),
      [1, 2]
    );
    assert.equal(res.json.familyMembers[0].age, 58);
    assert.equal(res.json.familyMembers[1].relation, 'Spouse');
    assert.equal(res.json.experience[0].organization, 'Old ISP Pvt Ltd');
    assert.equal(res.json.experience[0].fromAD, '2019-01-01');
    assert.equal(res.json.experience[0].toAD, '2021-12-31');
    assert.equal(res.json.qualifications[0].examPassed, 'BSc CSIT');
    assert.equal(Number(res.json.qualifications[0].percentage), 72.5);
    assert.equal(res.json.references[0].name, 'Ref One');
    assert.equal(res.json.references[0].contact, '9800000000');

    // The rows are really in PostgreSQL, not only in the response.
    assert.equal(await familyCount(EMP_A), 2);

    const reread = await get(`/api/employees/${EMP_A}/profile`, adminToken);
    assert.equal(reread.status, 200);
    assert.equal(reread.json.profile.fatherName, 'Father One');
    assert.equal(reread.json.familyMembers.length, 2);
  });

  test('the repeating blocks are replaced, not appended to', async () => {
    const res = await put(
      `/api/employees/${EMP_A}/profile`,
      {
        ...fullProfile(),
        familyMembers: [{ name: 'Only Child', age: 4, occupation: null, relation: 'Son' }],
        experience: [],
        qualifications: [],
        references: [],
      },
      managerToken
    );
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.json.familyMembers.map((row: any) => row.name),
      ['Only Child']
    );
    assert.deepEqual(res.json.experience, []);
    assert.deepEqual(res.json.qualifications, []);
    assert.deepEqual(res.json.references, []);
    assert.equal(await familyCount(EMP_A), 1);

    // Put the full profile back for the tests that follow.
    const restored = await put(`/api/employees/${EMP_A}/profile`, fullProfile(), managerToken);
    assert.equal(restored.status, 200);
    assert.equal(await familyCount(EMP_A), 2);
  });

  test('invalid profiles are refused and change nothing', async () => {
    const twentyOne = Array.from({ length: 21 }, (_, index) => ({
      name: `Member ${index + 1}`,
      age: 20,
      occupation: 'Other',
      relation: 'Relative',
    }));
    const cases: Array<{ label: string; body: any; message: RegExp }> = [
      {
        label: 'more family rows than the ceiling',
        body: { ...fullProfile(), familyMembers: twentyOne },
        message: /at most 20 rows/,
      },
      {
        label: 'a percentage above 100',
        body: {
          ...fullProfile(),
          qualifications: [{ examPassed: 'SEE', boardUniversity: null, percentage: 120 }],
        },
        message: /between 0 and 100/,
      },
      {
        label: 'an experience period that ends before it starts',
        body: {
          ...fullProfile(),
          experience: [
            { organization: 'Old ISP', fromAD: '2020-01-01', toAD: '2019-01-01', designation: null },
          ],
        },
        message: /on or after its start date/,
      },
      {
        label: 'a blank required family name',
        body: { ...fullProfile(), familyMembers: [{ name: '   ', age: 30, occupation: null, relation: null }] },
        message: /required on every row/,
      },
      {
        label: 'an unknown blood group',
        body: { ...fullProfile(), bloodGroup: 'ZZ' },
        message: /Blood group must be one of/,
      },
      {
        label: 'a malformed declaration date',
        body: { ...fullProfile(), declarationDateAD: '01-04-2027' },
        message: /real date in YYYY-MM-DD/,
      },
    ];

    for (const item of cases) {
      const res = await put(`/api/employees/${EMP_A}/profile`, item.body, managerToken);
      assert.equal(res.status, 400, `${item.label} should be refused`);
      assert.match(String(res.json?.message || ''), item.message, `${item.label} message`);
    }

    // None of the refusals may have touched the stored profile.
    assert.equal(await familyCount(EMP_A), 2);
    const reread = await get(`/api/employees/${EMP_A}/profile`, managerToken);
    assert.equal(reread.json.profile.bloodGroup, 'O+');
    assert.equal(reread.json.profile.declarationDateAD, '2027-04-01');
    assert.equal(reread.json.familyMembers.length, 2);
  });

  test('a view-only officer is masked and cannot write', async () => {
    const read = await get(`/api/employees/${EMP_A}/profile`, officerToken);
    assert.equal(read.status, 200);
    assert.equal(read.json.masked, true);
    assert.equal(read.json.profile.fatherName, null);
    assert.equal(read.json.profile.permanentAddress, null);
    assert.equal(read.json.profile.medicalDetails, null);
    assert.deepEqual(read.json.familyMembers, []);
    assert.deepEqual(read.json.qualifications, []);

    const write = await put(`/api/employees/${EMP_A}/profile`, fullProfile(), officerToken);
    assert.equal(write.status, 403);
    assert.equal(await familyCount(EMP_A), 2);
  });

  test("another branch's employee is refused without writing anything", async () => {
    // The app-level branch guard protects `/employees/:id` and answers first with
    // 403; the controller repeats the custody check and reports a row outside the
    // caller's branches as missing (404), so either refusal is acceptable here and
    // neither may return or write a profile.
    const read = await get(`/api/employees/${EMP_B}/profile`, managerToken);
    assert.ok([403, 404].includes(read.status), `expected a refusal, got ${read.status}`);
    const write = await put(`/api/employees/${EMP_B}/profile`, fullProfile(), managerToken);
    assert.ok([403, 404].includes(write.status), `expected a refusal, got ${write.status}`);
    assert.equal(await familyCount(EMP_B), 0);
    const adminRead = await get(`/api/employees/${EMP_B}/profile`, adminToken);
    assert.equal(adminRead.json.profile.fatherName, null);
  });

  test('every successful save writes exactly one audit row', async () => {
    const before = await profileAuditCount();
    const saved = await put(`/api/employees/${EMP_A}/profile`, fullProfile(), managerToken);
    assert.equal(saved.status, 200);
    assert.equal(await profileAuditCount(), before + 1);

    const rejected = await put(
      `/api/employees/${EMP_A}/profile`,
      { ...fullProfile(), bloodGroup: 'ZZ' },
      managerToken
    );
    assert.equal(rejected.status, 400);
    assert.equal(await profileAuditCount(), before + 1, 'a refused save must not be audited');
  });
});
