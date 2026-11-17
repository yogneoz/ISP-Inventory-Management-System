import { purgeAuditLogs } from './support/purgeAuditLogs';
/**
 * Phase 2 payroll preparation — effective-dated salary structures.
 *
 * These cases drive the real HTTP routes against PostgreSQL and pin the rules
 * the payroll run will rely on:
 *
 *   1. monthly gross defaults to BASIC 60% / HRA 40%;
 *   2. a structure resolves to the newest revision effective on or before the
 *      as-of date, and history stays readable;
 *   3. branch scope covers lists, named employees and by-id reads/writes;
 *   4. view-only HR roles read but cannot write; the legacy payroll grant can;
 *   5. every create/update writes its audit row with the employee's branch, and
 *      validation failures write none.
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

const SAL_BRANCH = 'hr-salary-test-branch';
const OTHER_BRANCH = 'hr-salary-test-branch-2';

const ADMIN = {
  id: 'sal-admin',
  email: 'sal-admin@example.com',
  name: 'SAL Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

const HR_MANAGER = {
  id: 'sal-hr-manager',
  email: 'sal-hr-manager@example.com',
  name: 'SAL HR Manager',
  role: 'HR_MANAGER',
  branchId: SAL_BRANCH,
  allowedBranchIds: [SAL_BRANCH],
  canSwitchUser: false,
} as any;

const HR_OFFICER = {
  id: 'sal-hr-officer',
  email: 'sal-hr-officer@example.com',
  name: 'SAL HR Officer',
  role: 'HR_OFFICER',
  branchId: SAL_BRANCH,
  allowedBranchIds: [SAL_BRANCH],
  canSwitchUser: false,
} as any;

const AUDITOR = {
  id: 'sal-auditor',
  email: 'sal-auditor@example.com',
  name: 'SAL Auditor',
  role: 'AUDITOR',
  branchId: SAL_BRANCH,
  allowedBranchIds: [SAL_BRANCH],
  canSwitchUser: false,
} as any;

const ACCOUNTANT = {
  id: 'sal-accountant',
  email: 'sal-accountant@example.com',
  name: 'SAL Accountant',
  role: 'ACCOUNTANT',
  branchId: SAL_BRANCH,
  allowedBranchIds: [SAL_BRANCH],
  canSwitchUser: false,
} as any;

describe('effective-dated salary structures (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const adminToken = issueAuthToken(ADMIN);
  const managerToken = issueAuthToken(HR_MANAGER);
  const officerToken = issueAuthToken(HR_OFFICER);
  const auditorToken = issueAuthToken(AUDITOR);
  const accountantToken = issueAuthToken(ACCOUNTANT);

  let emp1: any = null;
  let emp2: any = null;
  let emp3: any = null;
  let structure1: any = null;
  let structure2: any = null;
  let otherStructure: any = null;

  async function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
      /* a non-JSON body is itself a finding */
    }
    return { status: res.status, json };
  }

  const get = (path: string, auth = adminToken) => request('GET', path, undefined, auth);
  const post = (path: string, body: unknown, auth = adminToken) => request('POST', path, body, auth);
  const patch = (path: string, body: unknown, auth = adminToken) =>
    request('PATCH', path, body, auth);

  function employeeBody(code: string, branchId: string, ssfEligible = true) {
    return {
      employeeCode: code,
      name: `Salary Test ${code}`,
      branchId,
      department: 'Finance',
      designation: 'Payroll Analyst',
      joiningDateAD: '2026-01-01',
      ssfEligible,
      monthlySalary: 100000,
    };
  }

  async function auditCountFor(code: string): Promise<number> {
    const { rows } = await pool!.query(
      `SELECT COUNT(*)::int AS count
         FROM audit_logs
        WHERE action IN ('CREATE_HR_SALARY_STRUCTURE', 'UPDATE_HR_SALARY_STRUCTURE')
          AND details LIKE $1`,
      [`%${code}%`]
    );
    return Number(rows[0].count);
  }

  async function cleanup() {
    await pool!.query(
      `DELETE FROM hr_employee_salary
        WHERE branch_id = ANY($1::varchar[])
           OR employee_id IN (SELECT id FROM employees WHERE employee_code LIKE 'SAL-%')`,
      [[SAL_BRANCH, OTHER_BRANCH]]
    );
    await purgeAuditLogs(pool!, 
      `DELETE FROM audit_logs
        WHERE action IN ('CREATE_HR_SALARY_STRUCTURE', 'UPDATE_HR_SALARY_STRUCTURE')
          AND (branch_id = ANY($1::varchar[]) OR details LIKE '%SAL-%')`,
      [[SAL_BRANCH, OTHER_BRANCH]]
    );
    await pool!.query("DELETE FROM employees WHERE employee_code LIKE 'SAL-%'");
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [
      [SAL_BRANCH, OTHER_BRANCH],
    ]);
  }

  before(async () => {
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'SALB', 'Salary Test Branch', 'Test'),
              ($2, 'SALB2', 'Salary Test Branch 2', 'Test')`,
      [SAL_BRANCH, OTHER_BRANCH]
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

    emp1 = (await post('/api/employees', employeeBody('SAL-001', SAL_BRANCH))).json;
    emp2 = (await post('/api/employees', employeeBody('SAL-002', OTHER_BRANCH, false))).json;
    emp3 = (await post('/api/employees', employeeBody('SAL-003', SAL_BRANCH))).json;
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('basic/HR-allowance defaults and effective-date resolution', async () => {
    const first = await post(
      '/api/hr/employee-salaries',
      {
        employeeId: emp1.id,
        effectiveFrom: '2026-01-01',
        monthlyGross: 100000,
        ssfEligible: true,
        overtimeRate: 500,
        tdsMonthly: 5000,
        notes: 'Initial structure',
      },
      managerToken
    );
    assert.equal(first.status, 201, JSON.stringify(first.json));
    structure1 = first.json;
    assert.equal(structure1.employeeCode, 'SAL-001');
    assert.equal(structure1.branchId, SAL_BRANCH);
    assert.equal(structure1.effectiveFrom, '2026-01-01');
    assert.equal(structure1.basicAmount, 60000, '60% of gross is basic');
    assert.equal(structure1.hraAmount, 40000, 'the remainder is HR allowance');
    assert.equal(structure1.monthlyGross, 100000);
    assert.equal(structure1.overtimeRate, 500);
    assert.equal(structure1.tdsMonthly, 5000);
    assert.equal(structure1.ssfEligible, true);
    assert.equal(structure1.components.length, 2);
    assert.deepEqual(
      structure1.components.map((component: any) => component.componentCode),
      ['BASIC', 'HRA']
    );
    assert.equal(structure1.components[0].amount, 60000);
    assert.equal(structure1.components[1].amount, 40000);

    const newer = await post(
      '/api/hr/employee-salaries',
      {
        employeeId: emp1.id,
        effectiveFrom: '2026-07-01',
        basicAmount: 66000,
        hraAmount: 44000,
        ssfEligible: true,
        overtimeRate: 550,
        tdsMonthly: 6000,
      },
      managerToken
    );
    assert.equal(newer.status, 201, JSON.stringify(newer.json));
    structure2 = newer.json;
    assert.equal(structure2.monthlyGross, 110000);

    const march = await get(
      `/api/hr/employee-salaries?employeeId=${emp1.id}&asOf=2026-03-15`,
      managerToken
    );
    assert.equal(march.status, 200, JSON.stringify(march.json));
    assert.equal(march.json.length, 1, 'one structure per employee as of a date');
    assert.equal(march.json[0].id, structure1.id);
    assert.equal(march.json[0].basicAmount, 60000);

    const august = await get(
      `/api/hr/employee-salaries?employeeId=${emp1.id}&asOf=2026-08-15`,
      managerToken
    );
    assert.equal(august.status, 200, JSON.stringify(august.json));
    assert.equal(august.json[0].id, structure2.id);
    assert.equal(august.json[0].basicAmount, 66000);

    const beforeAny = await get(
      `/api/hr/employee-salaries?employeeId=${emp1.id}&asOf=2025-12-31`,
      managerToken
    );
    assert.equal(beforeAny.status, 200);
    assert.equal(beforeAny.json.length, 0, 'a structure does not apply before its effective date');

    const history = await get(`/api/hr/employee-salaries?employeeId=${emp1.id}`, managerToken);
    assert.equal(history.status, 200, JSON.stringify(history.json));
    assert.equal(history.json.length, 2);
    assert.equal(history.json[0].id, structure2.id, 'history is newest first');
    assert.equal(history.json[1].id, structure1.id);

    const byId = await get(`/api/hr/employee-salaries/${structure1.id}`, managerToken);
    assert.equal(byId.status, 200, JSON.stringify(byId.json));
    assert.equal(byId.json.id, structure1.id);
    assert.equal(byId.json.components.length, 2);
  });

  test('validation rejects bad dates, amounts, components and duplicate effective dates', async () => {
    const missingDate = await post(
      '/api/hr/employee-salaries',
      { employeeId: emp1.id, monthlyGross: 1000 },
      managerToken
    );
    assert.equal(missingDate.status, 400);

    const impossibleDate = await post(
      '/api/hr/employee-salaries',
      { employeeId: emp1.id, effectiveFrom: '2026-02-30', monthlyGross: 1000 },
      managerToken
    );
    assert.equal(impossibleDate.status, 400);

    const unknownEmployee = await post(
      '/api/hr/employee-salaries',
      { employeeId: 'does-not-exist', effectiveFrom: '2026-01-01', monthlyGross: 1000 },
      managerToken
    );
    assert.equal(unknownEmployee.status, 404);

    const noAmounts = await post(
      '/api/hr/employee-salaries',
      { employeeId: emp1.id, effectiveFrom: '2026-02-01' },
      managerToken
    );
    assert.equal(noAmounts.status, 400);

    const negative = await post(
      '/api/hr/employee-salaries',
      { employeeId: emp1.id, effectiveFrom: '2026-02-01', monthlyGross: -1 },
      managerToken
    );
    assert.equal(negative.status, 400);

    const duplicate = await post(
      '/api/hr/employee-salaries',
      { employeeId: emp1.id, effectiveFrom: '2026-01-01', monthlyGross: 90000 },
      managerToken
    );
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));

    const emptyComponents = await post(
      '/api/hr/employee-salaries',
      { employeeId: emp1.id, effectiveFrom: '2026-02-01', components: [] },
      managerToken
    );
    assert.equal(emptyComponents.status, 400);

    const noEarning = await post(
      '/api/hr/employee-salaries',
      {
        employeeId: emp1.id,
        effectiveFrom: '2026-02-01',
        components: [{ code: 'TAX', kind: 'DEDUCTION', amount: 100 }],
      },
      managerToken
    );
    assert.equal(noEarning.status, 400);

    const duplicateComponent = await post(
      '/api/hr/employee-salaries',
      {
        employeeId: emp1.id,
        effectiveFrom: '2026-02-01',
        components: [
          { code: 'BASIC', amount: 1000 },
          { code: 'BASIC', amount: 2000 },
        ],
      },
      managerToken
    );
    assert.equal(duplicateComponent.status, 400);

    const changeEmployee = await patch(
      `/api/hr/employee-salaries/${structure1.id}`,
      { employeeId: emp3.id },
      managerToken
    );
    assert.equal(changeEmployee.status, 400);

    const changeDate = await patch(
      `/api/hr/employee-salaries/${structure1.id}`,
      { effectiveFrom: '2026-03-01' },
      managerToken
    );
    assert.equal(changeDate.status, 400);
  });

  test('branch scope covers lists, named employees and by-id reads/writes', async () => {
    const created = await post(
      '/api/hr/employee-salaries',
      {
        employeeId: emp2.id,
        effectiveFrom: '2026-01-01',
        monthlyGross: 80000,
        notes: 'Other branch',
      },
      adminToken
    );
    assert.equal(created.status, 201, JSON.stringify(created.json));
    otherStructure = created.json;

    const scoped = await get('/api/hr/employee-salaries', managerToken);
    assert.equal(scoped.status, 200, JSON.stringify(scoped.json));
    assert.ok(scoped.json.length > 0);
    assert.ok(
      scoped.json.every((row: any) => row.branchId === SAL_BRANCH),
      'an unscoped read must stay inside the manager branch'
    );
    assert.ok(!scoped.json.some((row: any) => row.employeeCode === 'SAL-002'));

    assert.equal(
      (await get(`/api/hr/employee-salaries?branchId=${OTHER_BRANCH}`, managerToken)).status,
      403
    );
    assert.equal(
      (await get(`/api/hr/employee-salaries?employeeId=${emp2.id}`, managerToken)).status,
      403
    );
    assert.equal(
      (await get(`/api/hr/employee-salaries/${otherStructure.id}`, managerToken)).status,
      403
    );
    assert.equal(
      (
        await post(
          '/api/hr/employee-salaries',
          { employeeId: emp2.id, effectiveFrom: '2026-04-01', monthlyGross: 90000 },
          managerToken
        )
      ).status,
      403
    );
    assert.equal(
      (await patch(`/api/hr/employee-salaries/${otherStructure.id}`, { notes: 'x' }, managerToken))
        .status,
      403
    );

    const adminList = await get(`/api/hr/employee-salaries?asOf=2026-06-01`);
    assert.equal(adminList.status, 200, JSON.stringify(adminList.json));
    assert.ok(adminList.json.some((row: any) => row.id === structure1.id));
    assert.ok(adminList.json.some((row: any) => row.id === otherStructure.id));
    const otherOnly = await get(`/api/hr/employee-salaries?branchId=${OTHER_BRANCH}`);
    assert.equal(otherOnly.status, 200);
    assert.equal(otherOnly.json.length, 1);
    assert.equal(otherOnly.json[0].id, otherStructure.id);
  });

  test('view-only roles read, the legacy payroll grant writes', async () => {
    const officerList = await get('/api/hr/employee-salaries', officerToken);
    assert.equal(officerList.status, 200, JSON.stringify(officerList.json));
    assert.ok(officerList.json.length > 0);
    assert.equal(
      (
        await post(
          '/api/hr/employee-salaries',
          { employeeId: emp3.id, effectiveFrom: '2026-02-01', monthlyGross: 50000 },
          officerToken
        )
      ).status,
      403
    );
    assert.equal(
      (await patch(`/api/hr/employee-salaries/${structure1.id}`, { notes: 'officer' }, officerToken))
        .status,
      403
    );

    const auditorList = await get('/api/hr/employee-salaries', auditorToken);
    assert.equal(auditorList.status, 200, JSON.stringify(auditorList.json));
    assert.equal(
      (
        await post(
          '/api/hr/employee-salaries',
          { employeeId: emp3.id, effectiveFrom: '2026-02-01', monthlyGross: 50000 },
          auditorToken
        )
      ).status,
      403
    );

    const legacy = await post(
      '/api/hr/employee-salaries',
      { employeeId: emp3.id, effectiveFrom: '2026-02-01', monthlyGross: 50000 },
      accountantToken
    );
    assert.equal(legacy.status, 201, JSON.stringify(legacy.json));
    assert.equal(legacy.json.basicAmount, 30000);
    assert.equal(legacy.json.hraAmount, 20000);
    assert.equal(
      (await patch(`/api/hr/employee-salaries/${legacy.json.id}`, { notes: 'legacy edit' }, accountantToken))
        .status,
      200
    );
  });

  test('updates keep the revision, replace components and audit in the transaction', async () => {
    const before = await auditCountFor('SAL-001');

    const updated = await patch(
      `/api/hr/employee-salaries/${structure1.id}`,
      {
        ssfEligible: false,
        overtimeRate: 450.5,
        tdsMonthly: 2500,
        notes: 'Corrected header',
      },
      managerToken
    );
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.equal(updated.json.ssfEligible, false);
    assert.equal(updated.json.overtimeRate, 450.5);
    assert.equal(updated.json.tdsMonthly, 2500);
    assert.equal(updated.json.notes, 'Corrected header');
    assert.equal(updated.json.basicAmount, 60000, 'header edits do not rewrite components');
    assert.equal(updated.json.effectiveFrom, '2026-01-01');
    assert.equal(await auditCountFor('SAL-001'), before + 1);

    const replaced = await patch(
      `/api/hr/employee-salaries/${structure1.id}`,
      {
        components: [
          { code: 'BASIC', name: 'Basic Salary', amount: 70000 },
          { code: 'HRA', name: 'HR Allowance', amount: 30000 },
        ],
      },
      managerToken
    );
    assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
    assert.equal(replaced.json.basicAmount, 70000);
    assert.equal(replaced.json.hraAmount, 30000);
    assert.equal(replaced.json.monthlyGross, 100000);
    assert.equal(replaced.json.components.length, 2);
    assert.equal(await auditCountFor('SAL-001'), before + 2);

    const afterGood = await auditCountFor('SAL-001');
    const rejected = await patch(
      `/api/hr/employee-salaries/${structure1.id}`,
      { overtimeRate: -1 },
      managerToken
    );
    assert.equal(rejected.status, 400);
    assert.equal(await auditCountFor('SAL-001'), afterGood, 'a refused update writes no audit row');

    const { rows } = await pool!.query(
      `SELECT action, branch_id AS "branchId", details
         FROM audit_logs
        WHERE action IN ('CREATE_HR_SALARY_STRUCTURE', 'UPDATE_HR_SALARY_STRUCTURE')
          AND details LIKE '%SAL-001%'`
    );
    assert.ok(rows.length >= 4);
    assert.ok(rows.every((row: any) => row.branchId === SAL_BRANCH));
  });
});
