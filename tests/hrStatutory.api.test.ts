import { purgeAuditLogs } from './support/purgeAuditLogs';
/**
 * Phase 2 statutory deductions — fiscal-year TDS slabs and SSF rates.
 *
 * The suite drives the real routes against PostgreSQL:
 *
 *   1. a config is versioned by fiscal year and a salary date resolves the
 *      matching year, not merely the newest config;
 *   2. SSF eligibility changes both the 11%/20% amounts and taxable gross;
 *   3. progressive TDS is correct inside a mid band and above the top band;
 *   4. gapped/overlapping/malformed slabs and duplicate year configs are 422s;
 *   5. config reads are branch-readable, writes are global-admin-only, and the
 *      computation route refuses another branch's structure;
 *   6. create/update audit rows are written and failed validation writes none.
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

const BRANCH = 'hr-stat-test-branch';
const OTHER_BRANCH = 'hr-stat-test-branch-2';
const FY_2090 = 'fy-hr-stat-2090';
const FY_2091 = 'fy-hr-stat-2091';
const FY_2092 = 'fy-hr-stat-2092';
const FY_2093 = 'fy-hr-stat-2093';

const ADMIN = {
  id: 'stat-admin',
  email: 'stat-admin@example.com',
  name: 'STAT Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;
const HR_MANAGER = {
  id: 'stat-hr-manager',
  email: 'stat-hr-manager@example.com',
  name: 'STAT HR Manager',
  role: 'HR_MANAGER',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;
const HR_OFFICER = {
  id: 'stat-hr-officer',
  email: 'stat-hr-officer@example.com',
  name: 'STAT HR Officer',
  role: 'HR_OFFICER',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;
const AUDITOR = {
  id: 'stat-auditor',
  email: 'stat-auditor@example.com',
  name: 'STAT Auditor',
  role: 'AUDITOR',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;
const ACCOUNTANT = {
  id: 'stat-accountant',
  email: 'stat-accountant@example.com',
  name: 'STAT Accountant',
  role: 'ACCOUNTANT',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;

const MID_SLABS = [
  { lowerBound: 0, upperBound: 50000, ratePercent: 5 },
  { lowerBound: 50000, upperBound: 100000, ratePercent: 15 },
  { lowerBound: 100000, upperBound: null, ratePercent: 25 },
];
const FY_2091_SLABS = [
  { lowerBound: 0, upperBound: 60000, ratePercent: 2 },
  { lowerBound: 60000, upperBound: 120000, ratePercent: 12 },
  { lowerBound: 120000, upperBound: null, ratePercent: 22 },
];
const UPDATED_SLABS = [
  { lowerBound: 0, upperBound: 40000, ratePercent: 2 },
  { lowerBound: 40000, upperBound: 80000, ratePercent: 12 },
  { lowerBound: 80000, upperBound: null, ratePercent: 22 },
];

describe('fiscal-year TDS slabs and SSF rates (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const adminToken = issueAuthToken(ADMIN);
  const managerToken = issueAuthToken(HR_MANAGER);
  const officerToken = issueAuthToken(HR_OFFICER);
  const auditorToken = issueAuthToken(AUDITOR);
  const accountantToken = issueAuthToken(ACCOUNTANT);

  let config2090: any = null;
  let config2091: any = null;
  let midStructure: any = null;
  let nonSsfStructure: any = null;
  let topStructure: any = null;
  let newerYearStructure: any = null;
  let noConfigStructure: any = null;
  let otherBranchStructure: any = null;

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

  function employeeBody(code: string, branchId: string, ssfEligible: boolean) {
    return {
      employeeCode: code,
      name: `Statutory Test ${code}`,
      branchId,
      department: 'Finance',
      designation: 'Payroll Analyst',
      joiningDateAD: '2090-07-17',
      ssfEligible,
      monthlySalary: 70000,
    };
  }

  async function salaryBody(employeeId: string, effectiveFrom: string, gross: number) {
    return {
      employeeId,
      effectiveFrom,
      monthlyGross: gross,
      ssfEligible: true,
    };
  }

  async function auditCount(): Promise<number> {
    const { rows } = await pool!.query(
      `SELECT COUNT(*)::int AS count
         FROM audit_logs
        WHERE action IN ('CREATE_HR_STATUTORY_CONFIG', 'UPDATE_HR_STATUTORY_CONFIG')
          AND (details LIKE '%FY 2090/91%' OR details LIKE '%FY 2091/92%'
               OR details LIKE '%FY 2092/93%' OR details LIKE '%FY 2093/94%')`
    );
    return Number(rows[0].count);
  }

  async function cleanup() {
    await pool!.query(
      `DELETE FROM hr_employee_salary
        WHERE branch_id = ANY($1::varchar[])
           OR employee_id IN (SELECT id FROM employees WHERE employee_code LIKE 'SAL-STAT-%')`,
      [[BRANCH, OTHER_BRANCH]]
    );
    await pool!.query(
      `DELETE FROM hr_statutory_configs
        WHERE fiscal_year_id = ANY($1::varchar[])`,
      [[FY_2090, FY_2091, FY_2092, FY_2093]]
    );
    await purgeAuditLogs(pool!, 
      `DELETE FROM audit_logs
        WHERE (action IN ('CREATE_HR_STATUTORY_CONFIG', 'UPDATE_HR_STATUTORY_CONFIG')
               AND (details LIKE '%FY 2090/91%' OR details LIKE '%FY 2091/92%'
                    OR details LIKE '%FY 2092/93%' OR details LIKE '%FY 2093/94%'))
           OR details LIKE '%SAL-STAT-%'`,
      []
    );
    await pool!.query("DELETE FROM employees WHERE employee_code LIKE 'SAL-STAT-%'");
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [
      [BRANCH, OTHER_BRANCH],
    ]);
    await pool!.query('DELETE FROM fiscal_years WHERE id = ANY($1::varchar[])', [
      [FY_2090, FY_2091, FY_2092, FY_2093],
    ]);
  }

  before(async () => {
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'STATB', 'Statutory Test Branch', 'Test'),
              ($2, 'STATB2', 'Statutory Test Branch 2', 'Test')`,
      [BRANCH, OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO fiscal_years
         (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed)
       VALUES ($1, '2090/91', '2090-07-16', '2091-07-15', '2090-04-01', '2091-03-31', FALSE, FALSE),
              ($2, '2091/92', '2091-07-16', '2092-07-15', '2091-04-01', '2092-03-31', FALSE, FALSE),
              ($3, '2092/93', '2092-07-16', '2093-07-15', '2092-04-01', '2093-03-31', FALSE, FALSE),
              ($4, '2093/94', '2093-07-16', '2094-07-15', '2093-04-01', '2094-03-31', FALSE, FALSE)`,
      [FY_2090, FY_2091, FY_2092, FY_2093]
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

    const emp1 = (await post('/api/employees', employeeBody('SAL-STAT-01', BRANCH, true))).json;
    const emp2 = (await post('/api/employees', employeeBody('SAL-STAT-02', BRANCH, false))).json;
    const emp3 = (await post('/api/employees', employeeBody('SAL-STAT-03', BRANCH, true))).json;
    const emp4 = (await post('/api/employees', employeeBody('SAL-STAT-04', OTHER_BRANCH, true))).json;
    const emp5 = (await post('/api/employees', employeeBody('SAL-STAT-05', BRANCH, true))).json;

    midStructure = (
      await post('/api/hr/employee-salaries', await salaryBody(emp1.id, '2090-08-01', 70000))
    ).json;
    newerYearStructure = (
      await post('/api/hr/employee-salaries', await salaryBody(emp1.id, '2091-08-01', 120000))
    ).json;
    nonSsfStructure = (
      await post(
        '/api/hr/employee-salaries',
        { employeeId: emp2.id, effectiveFrom: '2090-08-01', monthlyGross: 70000, ssfEligible: false }
      )
    ).json;
    topStructure = (
      await post('/api/hr/employee-salaries', await salaryBody(emp3.id, '2090-08-01', 300000))
    ).json;
    otherBranchStructure = (
      await post('/api/hr/employee-salaries', await salaryBody(emp4.id, '2090-08-01', 70000))
    ).json;
    noConfigStructure = (
      await post('/api/hr/employee-salaries', await salaryBody(emp5.id, '2092-08-01', 70000))
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

  test('fiscal-year configs resolve and compute mid-band, top-band and SSF cases', async () => {
    const created2090 = await post('/api/hr/statutory-configs', {
      fiscalYearId: FY_2090,
      employeeSsfPercent: 11,
      employerSsfPercent: 20,
      notes: 'Statutory test FY 2090/91',
      slabs: MID_SLABS,
    });
    assert.equal(created2090.status, 201, JSON.stringify(created2090.json));
    config2090 = created2090.json;
    assert.equal(config2090.fiscalYearCode, '2090/91');
    assert.equal(config2090.slabs.length, 3);
    assert.deepEqual(
      config2090.slabs.map((slab: any) => [slab.lowerBound, slab.upperBound, slab.ratePercent]),
      [
        [0, 50000, 5],
        [50000, 100000, 15],
        [100000, null, 25],
      ]
    );

    const created2091 = await post('/api/hr/statutory-configs', {
      fiscalYearId: FY_2091,
      employeeSsfPercent: 12,
      employerSsfPercent: 21,
      notes: 'Statutory test FY 2091/92',
      slabs: FY_2091_SLABS,
    });
    assert.equal(created2091.status, 201, JSON.stringify(created2091.json));
    config2091 = created2091.json;

    // Mid band, SSF eligible: taxable 70,000 − 4,620 = 65,380. SSF already
    // includes salary tax, so there is no separate TDS.
    const mid = await get(`/api/hr/employee-salaries/${midStructure.id}/statutory?asOf=2090-09-15`);
    assert.equal(mid.status, 200, JSON.stringify(mid.json));
    assert.equal(mid.json.fiscalYear.code, '2090/91');
    assert.equal(mid.json.basicAmount, 42000);
    assert.equal(mid.json.employeeSsf, 4620);
    assert.equal(mid.json.employerSsf, 8400);
    assert.equal(mid.json.taxableGross, 65380);
    assert.equal(mid.json.monthlyTds, 0);
    assert.equal(mid.json.annualTds, 0);
    assert.equal(mid.json.netAfterStatutory, 65380);
    assert.deepEqual(mid.json.slabs, [], 'SSF includes salary tax, so there are no TDS bands');

    // Same gross, no SSF: taxable 70,000 and no contribution amounts.
    const noSsf = await get(
      `/api/hr/employee-salaries/${nonSsfStructure.id}/statutory?asOf=2090-09-15`
    );
    assert.equal(noSsf.status, 200, JSON.stringify(noSsf.json));
    assert.equal(noSsf.json.ssfEligible, false);
    assert.equal(noSsf.json.employeeSsf, 0);
    assert.equal(noSsf.json.employerSsf, 0);
    assert.equal(noSsf.json.taxableGross, 70000);
    assert.equal(noSsf.json.monthlyTds, 5500);
    assert.equal(noSsf.json.annualTds, 66000);

    // Above the top band: taxable 300,000 − 19,800 = 280,200, still no TDS
    // because the employee contributes to SSF.
    const top = await get(`/api/hr/employee-salaries/${topStructure.id}/statutory?asOf=2090-09-15`);
    assert.equal(top.status, 200, JSON.stringify(top.json));
    assert.equal(top.json.taxableGross, 280200);
    assert.equal(top.json.monthlyTds, 0);
    assert.equal(top.json.annualTds, 0);
    assert.deepEqual(top.json.slabs, []);

    // The later structure's date selects the 2091/92 config, not the 2090 one.
    const newer = await get(
      `/api/hr/employee-salaries/${newerYearStructure.id}/statutory?asOf=2091-09-15`
    );
    assert.equal(newer.status, 200, JSON.stringify(newer.json));
    assert.equal(newer.json.fiscalYear.code, '2091/92');
    assert.equal(newer.json.employeeSsfPercent, 12);
    assert.equal(newer.json.employeeSsf, 8640);
    assert.equal(newer.json.employerSsf, 15120);
    assert.equal(newer.json.taxableGross, 111360);
    assert.equal(newer.json.monthlyTds, 0);
    assert.equal(newer.json.annualTds, 0);

    // A missing fiscal year and an as-of date before the structure are 422s.
    assert.equal(
      (
        await get(
          `/api/hr/employee-salaries/${newerYearStructure.id}/statutory?asOf=2095-01-01`
        )
      ).status,
      422
    );
    assert.equal(
      (
        await get(
          `/api/hr/employee-salaries/${midStructure.id}/statutory?asOf=2090-07-01`
        )
      ).status,
      422
    );

    const noConfig = await get(
      `/api/hr/employee-salaries/${noConfigStructure.id}/statutory?asOf=2092-09-15`
    );
    assert.equal(noConfig.status, 422);
    assert.match(noConfig.json.message, /2092\/93/);
  });

  test('a corrected slab table is the version that computes', async () => {
    const updated = await patch(`/api/hr/statutory-configs/${config2090.id}`, {
      employeeSsfPercent: 10,
      employerSsfPercent: 21,
      slabs: UPDATED_SLABS,
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.equal(updated.json.employeeSsfPercent, 10);
    assert.equal(updated.json.slabs[0].ratePercent, 2);

    const recomputed = await get(
      `/api/hr/employee-salaries/${midStructure.id}/statutory?asOf=2090-09-15`
    );
    assert.equal(recomputed.status, 200, JSON.stringify(recomputed.json));
    assert.equal(recomputed.json.configId, config2090.id);
    assert.equal(recomputed.json.employeeSsf, 4200);
    assert.equal(recomputed.json.employerSsf, 8820);
    assert.equal(recomputed.json.taxableGross, 65800);
    assert.equal(recomputed.json.monthlyTds, 0);
  });

  test('malformed slabs and duplicate fiscal-year configs are 422s', async () => {
    const bad = async (slabs: unknown[], label: string) => {
      const res = await post('/api/hr/statutory-configs', {
        fiscalYearId: FY_2093,
        employeeSsfPercent: 11,
        employerSsfPercent: 20,
        slabs,
      });
      assert.equal(res.status, 422, `${label}: ${JSON.stringify(res.json)}`);
      assert.ok(res.json?.message, `${label} needs a clear message`);
      return res;
    };

    await bad(
      [
        { lowerBound: 0, upperBound: 50000, ratePercent: 5 },
        { lowerBound: 60000, upperBound: 100000, ratePercent: 15 },
        { lowerBound: 100000, upperBound: null, ratePercent: 25 },
      ],
      'gap'
    );
    await bad(
      [
        { lowerBound: 0, upperBound: 50000, ratePercent: 5 },
        { lowerBound: 40000, upperBound: 100000, ratePercent: 15 },
        { lowerBound: 100000, upperBound: null, ratePercent: 25 },
      ],
      'overlap'
    );
    await bad(
      [
        { lowerBound: 0, upperBound: 50000, ratePercent: 5 },
        { lowerBound: 50000, upperBound: 100000, ratePercent: 15 },
      ],
      'missing open top'
    );
    await bad(
      [
        { lowerBound: 0, upperBound: 50000, ratePercent: 5 },
        { lowerBound: 50000, upperBound: null, ratePercent: 15 },
        { lowerBound: 100000, upperBound: null, ratePercent: 25 },
      ],
      'open middle'
    );
    await bad(
      [
        { lowerBound: 10000, upperBound: 50000, ratePercent: 5 },
        { lowerBound: 50000, upperBound: null, ratePercent: 15 },
      ],
      'does not start at zero'
    );
    await bad(
      [
        { lowerBound: 0, upperBound: 50000, ratePercent: -1 },
        { lowerBound: 50000, upperBound: null, ratePercent: 15 },
      ],
      'negative rate'
    );
    await bad(
      [
        { lowerBound: 0, upperBound: 50000, ratePercent: 101 },
        { lowerBound: 50000, upperBound: null, ratePercent: 15 },
      ],
      'rate over 100'
    );
    await bad(
      [
        { lowerBound: 0, upperBound: 50000, ratePercent: 5 },
        { lowerBound: 0, upperBound: 100000, ratePercent: 15 },
        { lowerBound: 100000, upperBound: null, ratePercent: 25 },
      ],
      'duplicate lower bound'
    );

    const duplicate = await post('/api/hr/statutory-configs', {
      fiscalYearId: FY_2090,
      employeeSsfPercent: 11,
      employerSsfPercent: 20,
      slabs: MID_SLABS,
    });
    assert.equal(duplicate.status, 422, JSON.stringify(duplicate.json));
    assert.match(duplicate.json.message, /already exists/i);

    const unknownYear = await post('/api/hr/statutory-configs', {
      fiscalYearId: 'fy-does-not-exist',
      slabs: MID_SLABS,
    });
    assert.equal(unknownYear.status, 404);

    assert.equal(
      (await post('/api/hr/statutory-configs', { fiscalYearId: FY_2093, slabs: [] })).status,
      422
    );
  });

  test('config reads are HR-readable, writes are global-admin-only, and computation is branch-scoped', async () => {
    const managerRead = await get(`/api/hr/statutory-configs?fiscalYearId=${FY_2090}`, managerToken);
    assert.equal(managerRead.status, 200, JSON.stringify(managerRead.json));
    assert.equal(managerRead.json.length, 1);

    const officerRead = await get('/api/hr/statutory-configs', officerToken);
    assert.equal(officerRead.status, 200, JSON.stringify(officerRead.json));
    assert.ok(officerRead.json.length >= 1);

    assert.equal(
      (
        await post(
          '/api/hr/statutory-configs',
          { fiscalYearId: FY_2093, slabs: MID_SLABS },
          managerToken
        )
      ).status,
      403
    );
    assert.equal(
      (await patch(`/api/hr/statutory-configs/${config2090.id}`, { notes: 'manager' }, managerToken))
        .status,
      403
    );
    assert.equal(
      (
        await post(
          '/api/hr/statutory-configs',
          { fiscalYearId: FY_2093, slabs: MID_SLABS },
          officerToken
        )
      ).status,
      403
    );
    assert.equal(
      (
        await post(
          '/api/hr/statutory-configs',
          { fiscalYearId: FY_2093, slabs: MID_SLABS },
          auditorToken
        )
      ).status,
      403
    );
    // The legacy payroll grant is accepted by the permission check, but this
    // company-wide table still needs a global account.
    assert.equal(
      (
        await post(
          '/api/hr/statutory-configs',
          { fiscalYearId: FY_2093, slabs: MID_SLABS },
          accountantToken
        )
      ).status,
      403
    );

    assert.equal(
      (
        await get(
          `/api/hr/employee-salaries/${otherBranchStructure.id}/statutory?asOf=2090-09-15`,
          managerToken
        )
      ).status,
      403
    );
    assert.equal(
      (
        await get(
          `/api/hr/employee-salaries/${otherBranchStructure.id}/statutory?asOf=2090-09-15`
        )
      ).status,
      200
    );
  });

  test('config mutations audit in the transaction and refusals write none', async () => {
    const before = await auditCount();
    assert.ok(before >= 3, 'create plus correction audit rows');

    const created = await post('/api/hr/statutory-configs', {
      fiscalYearId: FY_2093,
      employeeSsfPercent: 11,
      employerSsfPercent: 20,
      notes: 'Statutory test FY 2093/94',
      slabs: MID_SLABS,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(await auditCount(), before + 1);

    const afterCreate = await auditCount();
    const refused = await patch(`/api/hr/statutory-configs/${created.json.id}`, {
      slabs: [{ lowerBound: 0, upperBound: 50000, ratePercent: 10 }],
    });
    assert.equal(refused.status, 422);
    assert.equal(await auditCount(), afterCreate, 'a refused correction writes no audit row');

    const { rows } = await pool!.query(
      `SELECT action, details
         FROM audit_logs
        WHERE action IN ('CREATE_HR_STATUTORY_CONFIG', 'UPDATE_HR_STATUTORY_CONFIG')
          AND (details LIKE '%FY 2090/91%' OR details LIKE '%FY 2091/92%'
               OR details LIKE '%FY 2093/94%')`
    );
    assert.ok(rows.some((row: any) => row.action === 'CREATE_HR_STATUTORY_CONFIG'));
    assert.ok(rows.some((row: any) => row.action === 'UPDATE_HR_STATUTORY_CONFIG'));
  });
});
