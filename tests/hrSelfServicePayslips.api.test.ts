import { purgeAuditLogs } from './support/purgeAuditLogs';
/**
 * Phase 3 employee self-service — own posted/paid payslips.
 *
 * The fixture inserts immutable payroll snapshots directly (the payroll run
 * lifecycle has its own suite) and drives the real HTTP route:
 *
 *   1. no token is 401; a denied role is 403;
 *   2. only the employee linked to the caller's user id is returned, with the
 *      exact payslip field set and exact two-decimal amounts;
 *   3. another employee's payslips never appear in the first employee's list;
 *   4. DRAFT/APPROVED runs are excluded, while POSTED and PAID are visible;
 *   5. employee/user selectors, `branchId=ALL`, another branch and an
 *      out-of-scope employee link are refused;
 *   6. reads do not mutate the run or line rows and there is no write route.
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

const BRANCH = 'ess-pay-test-branch';
const OTHER_BRANCH = 'ess-pay-test-branch-2';
const PERIOD_1 = '2099-01';
const PERIOD_2 = '2099-02';
const PERIOD_3 = '2099-03';
const PERIOD_4 = '2099-04';

const ADMIN = {
  id: 'ess-pay-admin',
  email: 'ess-pay-admin@example.com',
  name: 'ESS Pay Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

function employeeUser(id: string, branchId: string) {
  return {
    id,
    email: `${id}@example.com`,
    name: `ESS Pay User ${id}`,
    role: 'FRONT_DESK',
    branchId,
    allowedBranchIds: [branchId],
    canSwitchUser: false,
  } as any;
}

const USER_A = employeeUser('ess-pay-user-a', BRANCH);
const USER_B = employeeUser('ess-pay-user-b', BRANCH);
const USER_OTHER = employeeUser('ess-pay-user-other', OTHER_BRANCH);
const USER_CROSS = employeeUser('ess-pay-user-cross', BRANCH);

const PAYSLIP_KEYS = [
  'advance',
  'allowances',
  'arrears',
  'bankAccount',
  'bankName',
  'bankStatus',
  'basicAmount',
  'branchId',
  'branchName',
  'department',
  'designation',
  'detailsRestricted',
  'employeeCode',
  'employeeId',
  'employeeName',
  'employerCost',
  'employerSsf',
  'fiscalYearCode',
  'gross',
  'incentive',
  'loan',
  'lopDays',
  'lopDeduction',
  'net',
  'overtimeAmount',
  'overtimeHours',
  'paidDateAD',
  'payableDays',
  'paymentMethod',
  'panNumber',
  'periodKey',
  'runDateAD',
  'runDateBS',
  'runNo',
  'ssf',
  'ssfNumber',
  'status',
  'tds',
  'totalDeductions',
].sort();

describe('employee self-service payslips (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
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
      name: `ESS Pay ${code}`,
      branchId,
      userId,
      department: 'Operations',
      designation: 'ESS Pay Analyst',
      designationCode: 'ESS-PAY',
      employmentType: 'Non-PB',
      workStation: 'Test Work Station',
      joiningDateAD: '2026-01-05',
      dateOfBirthAD: '1994-04-09',
      contractExpiryAD: '2027-01-04',
      internalEmail: `${code.toLowerCase()}@internal.example`,
      personalEmail: `${code.toLowerCase()}@personal.example`,
      personalContact: '9800000011',
      emergencyContactPerson: 'ESS Pay Emergency',
      emergencyContactNumber: '9800000012',
      address: 'Kathmandu, Nepal',
      panNumber: '900000011',
      ssfNumber: 'SSF-ESS-PAY-1',
      ssfEligible: true,
      bankName: 'ESS Pay Bank',
      bankAccount: 'ACC-ESS-PAY-1',
      monthlySalary: 123456.78,
    };
  }

  async function insertRun(input: {
    id: string;
    runNo: string;
    branchId: string;
    periodKey: string;
    runDateAD: string;
    status: 'DRAFT' | 'APPROVED' | 'POSTED' | 'PAID';
    runDateBS?: string;
    paidDateBS?: string;
    gross: number;
    tds: number;
    ssf: number;
    advance: number;
    loan: number;
    incentive: number;
    arrears: number;
    net: number;
    paidDateAD?: string | null;
    paymentMethod?: string | null;
  }) {
    await pool!.query(
      `INSERT INTO payroll_runs (
         id, run_no, branch_id, period_key, run_date_ad, gross_total, tds_total,
         ssf_total, advance_total, loan_total, incentive_total, arrears_total,
         net_total, status, paid_date_ad, paid_date_bs, payment_method, run_date_bs
       ) VALUES (
         $1, $2, $3, $4, $5::date, $6::numeric, $7::numeric, $8::numeric,
         $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric,
         $14, $15::date, $16, $17, $18
       )`,
      [
        input.id,
        input.runNo,
        input.branchId,
        input.periodKey,
        input.runDateAD,
        input.gross.toFixed(2),
        input.tds.toFixed(2),
        input.ssf.toFixed(2),
        input.advance.toFixed(2),
        input.loan.toFixed(2),
        input.incentive.toFixed(2),
        input.arrears.toFixed(2),
        input.net.toFixed(2),
        input.status,
        input.paidDateAD || null,
        input.paidDateBS || (input.paidDateAD ? `${input.periodKey}-02 BS` : null),
        input.paymentMethod || null,
        input.runDateBS || `${input.periodKey}-01 BS`,
      ]
    );
  }

  async function insertLine(input: {
    id: string;
    runId: string;
    employee: any;
    periodKey: string;
    basic: number;
    payableDays: number;
    lopDays: number;
    lopDeduction: number;
    overtimeHours: number;
    overtimeAmount: number;
    incentive: number;
    arrears: number;
    gross: number;
    tds: number;
    ssf: number;
    employerSsf: number;
    advance: number;
    loan: number;
    net: number;
  }) {
    await pool!.query(
      `INSERT INTO payroll_run_lines (
         id, run_id, employee_id, employee_code, employee_name, period_key,
         basic_amount, payable_days, lop_days, lop_deduction, overtime_hours,
         overtime_amount, incentive_amount, arrears_amount, gross_amount,
         tds_amount, ssf_amount, employer_ssf_amount, advance_deduction,
         loan_deduction, net_amount, bank_name, bank_account
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric,
         $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14::numeric,
         $15::numeric, $16::numeric, $17::numeric, $18::numeric, $19::numeric,
         $20::numeric, $21::numeric, $22, $23
       )`,
      [
        input.id,
        input.runId,
        input.employee.id,
        input.employee.employeeCode,
        input.employee.name,
        input.periodKey,
        input.basic.toFixed(2),
        input.payableDays.toFixed(2),
        input.lopDays.toFixed(2),
        input.lopDeduction.toFixed(2),
        input.overtimeHours.toFixed(2),
        input.overtimeAmount.toFixed(2),
        input.incentive.toFixed(2),
        input.arrears.toFixed(2),
        input.gross.toFixed(2),
        input.tds.toFixed(2),
        input.ssf.toFixed(2),
        input.employerSsf.toFixed(2),
        input.advance.toFixed(2),
        input.loan.toFixed(2),
        input.net.toFixed(2),
        input.employee.bankName ?? null,
        input.employee.bankAccount ?? null,
      ]
    );
  }

  async function payrollCounts() {
    const { rows } = await pool!.query(
      `SELECT
         (SELECT COUNT(*)::int FROM payroll_runs WHERE id LIKE 'ess-pay-run-%') AS runs,
         (SELECT COUNT(*)::int FROM payroll_run_lines WHERE run_id LIKE 'ess-pay-run-%') AS lines`
    );
    return rows[0];
  }

  async function cleanup() {
    await pool!.query("DELETE FROM payroll_run_lines WHERE run_id LIKE 'ess-pay-run-%'");
    await pool!.query("DELETE FROM payroll_runs WHERE id LIKE 'ess-pay-run-%'");
    await pool!.query("DELETE FROM employees WHERE employee_code LIKE 'ESS-PAY-%'");
    await purgeAuditLogs(pool!, 
      "DELETE FROM audit_logs WHERE action = 'CREATE_EMPLOYEE' AND details LIKE '%ESS-PAY-%'"
    );
    await pool!.query("DELETE FROM users WHERE id LIKE 'ess-pay-user-%' OR id = 'ess-pay-admin'");
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [[BRANCH, OTHER_BRANCH]]);
  }

  before(async () => {
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'ESSPB', 'ESS Pay Test Branch', 'Test'),
              ($2, 'ESSPB2', 'ESS Pay Other Branch', 'Test')`,
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
      await request('POST', '/api/employees', employeeBody('ESS-PAY-001', BRANCH, USER_A.id))
    ).json;
    empB = (
      await request('POST', '/api/employees', employeeBody('ESS-PAY-002', BRANCH, USER_B.id))
    ).json;
    empOther = (
      await request('POST', '/api/employees', employeeBody('ESS-PAY-003', OTHER_BRANCH, USER_OTHER.id))
    ).json;
    empCross = (
      await request('POST', '/api/employees', employeeBody('ESS-PAY-004', OTHER_BRANCH, USER_CROSS.id))
    ).json;

    await insertRun({
      id: 'ess-pay-run-1',
      runNo: 'ESS-PAY-2099-01',
      branchId: BRANCH,
      periodKey: PERIOD_1,
      runDateAD: '2099-01-31',
      status: 'PAID',
      gross: 135000,
      tds: 8936.67,
      ssf: 9900,
      advance: 1500,
      loan: 0,
      incentive: 5000,
      arrears: 0,
      net: 114663.33,
      paidDateAD: '2099-02-02',
      paymentMethod: 'BANK',
    });
    await insertLine({
      id: 'ess-pay-line-1a',
      runId: 'ess-pay-run-1',
      employee: empA,
      periodKey: PERIOD_1,
      basic: 60000,
      payableDays: 30,
      lopDays: 0,
      lopDeduction: 0,
      overtimeHours: 2,
      overtimeAmount: 1000,
      incentive: 5000,
      arrears: 0,
      gross: 105000,
      tds: 7436.67,
      ssf: 6600,
      employerSsf: 12000,
      advance: 1500,
      loan: 0,
      net: 89463.33,
    });
    await insertLine({
      id: 'ess-pay-line-1b',
      runId: 'ess-pay-run-1',
      employee: empB,
      periodKey: PERIOD_1,
      basic: 30000,
      payableDays: 30,
      lopDays: 0,
      lopDeduction: 0,
      overtimeHours: 0,
      overtimeAmount: 0,
      incentive: 0,
      arrears: 0,
      gross: 30000,
      tds: 1500,
      ssf: 3300,
      employerSsf: 6000,
      advance: 0,
      loan: 0,
      net: 25200,
    });

    await insertRun({
      id: 'ess-pay-run-2',
      runNo: 'ESS-PAY-2099-02',
      branchId: BRANCH,
      periodKey: PERIOD_2,
      runDateAD: '2099-02-28',
      status: 'POSTED',
      gross: 60000,
      tds: 3000,
      ssf: 6600,
      advance: 0,
      loan: 0,
      incentive: 0,
      arrears: 0,
      net: 50400,
    });
    await insertLine({
      id: 'ess-pay-line-2a',
      runId: 'ess-pay-run-2',
      employee: empA,
      periodKey: PERIOD_2,
      basic: 60000,
      payableDays: 28,
      lopDays: 0,
      lopDeduction: 0,
      overtimeHours: 0,
      overtimeAmount: 0,
      incentive: 0,
      arrears: 0,
      gross: 60000,
      tds: 3000,
      ssf: 6600,
      employerSsf: 12000,
      advance: 0,
      loan: 0,
      net: 50400,
    });

    await insertRun({
      id: 'ess-pay-run-3',
      runNo: 'ESS-PAY-2099-03',
      branchId: BRANCH,
      periodKey: PERIOD_3,
      runDateAD: '2099-03-31',
      status: 'DRAFT',
      gross: 60000,
      tds: 0,
      ssf: 0,
      advance: 0,
      loan: 0,
      incentive: 0,
      arrears: 0,
      net: 60000,
    });
    await insertLine({
      id: 'ess-pay-line-3a',
      runId: 'ess-pay-run-3',
      employee: empA,
      periodKey: PERIOD_3,
      basic: 60000,
      payableDays: 31,
      lopDays: 0,
      lopDeduction: 0,
      overtimeHours: 0,
      overtimeAmount: 0,
      incentive: 0,
      arrears: 0,
      gross: 60000,
      tds: 0,
      ssf: 0,
      employerSsf: 12000,
      advance: 0,
      loan: 0,
      net: 60000,
    });

    await insertRun({
      id: 'ess-pay-run-4',
      runNo: 'ESS-PAY-2099-04',
      branchId: BRANCH,
      periodKey: PERIOD_4,
      runDateAD: '2099-04-30',
      status: 'APPROVED',
      gross: 60000,
      tds: 0,
      ssf: 0,
      advance: 0,
      loan: 0,
      incentive: 0,
      arrears: 0,
      net: 60000,
    });
    await insertLine({
      id: 'ess-pay-line-4a',
      runId: 'ess-pay-run-4',
      employee: empA,
      periodKey: PERIOD_4,
      basic: 60000,
      payableDays: 30,
      lopDays: 0,
      lopDeduction: 0,
      overtimeHours: 0,
      overtimeAmount: 0,
      incentive: 0,
      arrears: 0,
      gross: 60000,
      tds: 0,
      ssf: 0,
      employerSsf: 12000,
      advance: 0,
      loan: 0,
      net: 60000,
    });

    await insertRun({
      id: 'ess-pay-run-5',
      runNo: 'ESS-PAY-2099-01B',
      branchId: OTHER_BRANCH,
      periodKey: PERIOD_1,
      runDateAD: '2099-01-31',
      status: 'POSTED',
      gross: 40000,
      tds: 2000,
      ssf: 4400,
      advance: 0,
      loan: 0,
      incentive: 0,
      arrears: 0,
      net: 33600,
    });
    await insertLine({
      id: 'ess-pay-line-5a',
      runId: 'ess-pay-run-5',
      employee: empOther,
      periodKey: PERIOD_1,
      basic: 40000,
      payableDays: 31,
      lopDays: 0,
      lopDeduction: 0,
      overtimeHours: 0,
      overtimeAmount: 0,
      incentive: 0,
      arrears: 0,
      gross: 40000,
      tds: 2000,
      ssf: 4400,
      employerSsf: 8000,
      advance: 0,
      loan: 0,
      net: 33600,
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

  test('401 without a token, 403 without the grant, and only own posted/paid payslips', async () => {
    assert.ok(empA?.id && empB?.id && empOther?.id && empCross?.id, 'fixture employees must exist');

    const unauthenticated = await get('/api/hr/self-service/payslips', null);
    assert.equal(unauthenticated.status, 401, JSON.stringify(unauthenticated.json));

    const deniedMatrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    deniedMatrix['hr-self-service'].FRONT_DESK = false;
    setPermissionMatrix(deniedMatrix);
    try {
      const denied = await get('/api/hr/self-service/payslips', userAToken);
      assert.equal(denied.status, 403, 'a role without hr-self-service must be refused');
    } finally {
      setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    }

    const own = await get('/api/hr/self-service/payslips', userAToken);
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Object.keys(own.json), ['payslips']);
    assert.equal(own.json.payslips.length, 2, 'only the two posted/paid A lines');
    assert.deepEqual(Object.keys(own.json.payslips[0]).sort(), PAYSLIP_KEYS, 'exact payslip fields');

    const paid = own.json.payslips.find((row: any) => row.runNo === 'ESS-PAY-2099-01');
    const posted = own.json.payslips.find((row: any) => row.runNo === 'ESS-PAY-2099-02');
    assert.ok(paid && posted, 'the PAID and POSTED runs must both be visible');
    assert.equal(paid.employeeId, empA.id);
    assert.equal(paid.employeeCode, 'ESS-PAY-001');
    assert.equal(paid.employeeName, 'ESS Pay ESS-PAY-001');
    assert.equal(paid.department, 'Operations');
    assert.equal(paid.designation, 'ESS Pay Analyst');
    assert.equal(paid.panNumber, '900000011');
    assert.equal(paid.ssfNumber, 'SSF-ESS-PAY-1');
    assert.equal(paid.bankName, 'ESS Pay Bank');
    assert.equal(paid.bankAccount, 'ACC-ESS-PAY-1');
    assert.equal(paid.bankStatus, 'READY');
    assert.equal(paid.detailsRestricted, false);
    assert.equal(paid.branchId, BRANCH);
    assert.equal(paid.branchName, 'ESS Pay Test Branch');
    assert.equal(paid.fiscalYearCode, null, '2099 is outside the seeded fiscal calendar');
    assert.equal(paid.periodKey, PERIOD_1);
    assert.equal(paid.runDateAD, '2099-01-31');
    assert.equal(paid.runDateBS, '2099-01-01 BS');
    assert.equal(paid.paidDateAD, '2099-02-02');
    assert.equal(paid.paymentMethod, 'BANK');
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.basicAmount, 60000);
    assert.equal(paid.allowances, 39000);
    assert.equal(paid.payableDays, 30);
    assert.equal(paid.lopDays, 0);
    assert.equal(paid.lopDeduction, 0);
    assert.equal(paid.overtimeHours, 2);
    assert.equal(paid.overtimeAmount, 1000);
    assert.equal(paid.incentive, 5000);
    assert.equal(paid.arrears, 0);
    assert.equal(paid.gross, 105000);
    assert.equal(paid.tds, 7436.67);
    assert.equal(paid.ssf, 6600);
    assert.equal(paid.employerSsf, 12000);
    assert.equal(paid.advance, 1500);
    assert.equal(paid.loan, 0);
    assert.equal(paid.totalDeductions, 15536.67);
    assert.equal(paid.employerCost, 117000);
    assert.equal(paid.net, 89463.33);

    assert.equal(posted.status, 'POSTED');
    assert.equal(posted.paidDateAD, null);
    assert.equal(posted.paymentMethod, null);
    assert.equal(posted.net, 50400);

    assert.ok(
      !own.json.payslips.some((row: any) =>
        ['ESS-PAY-2099-03', 'ESS-PAY-2099-04'].includes(row.runNo)
      ),
      'DRAFT and APPROVED runs must never be visible'
    );

    const b = await get('/api/hr/self-service/payslips', userBToken);
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(b.json.payslips.length, 1);
    assert.equal(b.json.payslips[0].employeeCode, 'ESS-PAY-002');
    assert.equal(b.json.payslips[0].net, 25200);
    assert.notEqual(b.json.payslips[0].employeeId, empA.id);

    const otherBranchOwn = await get('/api/hr/self-service/payslips', otherToken);
    assert.equal(otherBranchOwn.status, 200, JSON.stringify(otherBranchOwn.json));
    assert.equal(otherBranchOwn.json.payslips.length, 1);
    assert.equal(otherBranchOwn.json.payslips[0].employeeCode, 'ESS-PAY-003');
    assert.equal(otherBranchOwn.json.payslips[0].branchName, 'ESS Pay Other Branch');

    const unlinked = await get('/api/hr/self-service/payslips', adminToken);
    assert.equal(unlinked.status, 404, 'an account without a linked employee is not widened');
  });

  test('selectors, branch widening and cross-branch links are refused, with no write path', async () => {
    const beforeCounts = await payrollCounts();

    for (const selector of [
      `?employeeId=${encodeURIComponent(empB.id)}`,
      `?userId=${encodeURIComponent(USER_B.id)}`,
      '?user_id=ess-pay-user-b',
    ]) {
      const refused = await get(`/api/hr/self-service/payslips${selector}`, userAToken);
      assert.equal(refused.status, 403, `${selector} must be refused`);
      assert.match(refused.json.message, /self-service always returns the signed-in employee/i);
    }

    const allWidening = await get('/api/hr/self-service/payslips?branchId=ALL', userAToken);
    assert.equal(allWidening.status, 403, 'ALL must not widen the read');
    assert.match(allWidening.json.message, /all branches/i);

    const otherBranchFilter = await get(
      `/api/hr/self-service/payslips?branchId=${encodeURIComponent(OTHER_BRANCH)}`,
      userAToken
    );
    assert.equal(otherBranchFilter.status, 403, 'a branch filter naming another branch must be refused');

    const ownBranchFilter = await get(
      `/api/hr/self-service/payslips?branchId=${encodeURIComponent(BRANCH)}`,
      userAToken
    );
    assert.equal(ownBranchFilter.status, 200, 'the caller may name its own branch');
    assert.equal(ownBranchFilter.json.payslips.length, 2);

    const cross = await get('/api/hr/self-service/payslips', crossToken);
    assert.equal(cross.status, 403, 'an out-of-scope linked employee must be refused');

    const afterCounts = await payrollCounts();
    assert.deepEqual(afterCounts, beforeCounts, 'reads must not create or delete runs or lines');

    const noWrite = await request('POST', '/api/hr/self-service/payslips', {}, userAToken);
    assert.equal(noWrite.status, 404, 'the route has no POST write path');
    const noPatch = await request('PATCH', '/api/hr/self-service/payslips', {}, userAToken);
    assert.equal(noPatch.status, 404, 'the route has no PATCH write path');
    const noDelete = await request(
      'DELETE',
      '/api/hr/self-service/payslips',
      undefined,
      userAToken
    );
    assert.equal(noDelete.status, 404, 'the route has no DELETE write path');
  });
});
