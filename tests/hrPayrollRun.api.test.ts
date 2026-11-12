/**
 * Phase 2 payroll run lifecycle — generated DRAFT → APPROVED → POSTED → PAID.
 *
 * HR prepares a snapshot from effective salary structures, attendance/OT and
 * the fiscal year's TDS/SSF rules. Finance approves and posts it; the existing
 * manual direct-post route is deliberately not exercised here.
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
import { ensureBsDayRecords, ensureReferenceData } from './fixtures/referenceData';
import {
  buildPayrollOutput,
  buildPayrollReconciliation,
} from '../server/src/services/payrollOutput.service';

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

const BRANCH = 'payrun-draft-branch';
const OTHER_BRANCH = 'payrun-draft-branch-2';
const FY = 'fy-payrun-draft';
const FY_NO_CONFIG = 'fy-payrun-draft-no-config';
const FY_CODE = '2083-PAYRUN';
const PERIOD = '2027-04';
const RUN_DATE = '2027-04-30';
const DISCARD_PERIOD = '2027-05';
const DISCARD_DATE = '2027-05-31';
const NO_CONFIG_PERIOD = '2027-07';
const NO_CONFIG_DATE = '2027-07-31';

const ADMIN = {
  id: 'payrun-admin',
  email: 'payrun-admin@example.com',
  name: 'Payrun Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;
const HR_MANAGER = {
  id: 'payrun-hr-manager',
  email: 'payrun-hr-manager@example.com',
  name: 'Payrun HR Manager',
  role: 'HR_MANAGER',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;
const HR_OFFICER = {
  id: 'payrun-hr-officer',
  email: 'payrun-hr-officer@example.com',
  name: 'Payrun HR Officer',
  role: 'HR_OFFICER',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;
const AUDITOR = {
  id: 'payrun-auditor',
  email: 'payrun-auditor@example.com',
  name: 'Payrun Auditor',
  role: 'AUDITOR',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;
const FINANCE = {
  id: 'payrun-finance',
  email: 'payrun-finance@example.com',
  name: 'Payrun Finance',
  role: 'ACCOUNTANT',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;
const OTHER_HR = {
  id: 'payrun-other-hr',
  email: 'payrun-other-hr@example.com',
  name: 'Payrun Other HR',
  role: 'HR_MANAGER',
  branchId: OTHER_BRANCH,
  allowedBranchIds: [OTHER_BRANCH],
  canSwitchUser: false,
} as any;
const OTHER_AUDITOR = {
  id: 'payrun-other-auditor',
  email: 'payrun-other-auditor@example.com',
  name: 'Payrun Other Auditor',
  role: 'AUDITOR',
  branchId: OTHER_BRANCH,
  allowedBranchIds: [OTHER_BRANCH],
  canSwitchUser: false,
} as any;
const OTHER_FINANCE = {
  id: 'payrun-other-finance',
  email: 'payrun-other-finance@example.com',
  name: 'Payrun Other Finance',
  role: 'ACCOUNTANT',
  branchId: OTHER_BRANCH,
  allowedBranchIds: [OTHER_BRANCH],
  canSwitchUser: false,
} as any;

const SLABS = [
  { lowerBound: 0, upperBound: 50000, ratePercent: 5 },
  { lowerBound: 50000, upperBound: 100000, ratePercent: 10 },
  { lowerBound: 100000, upperBound: null, ratePercent: 20 },
];
const UPDATED_SLABS = [
  { lowerBound: 0, upperBound: 40000, ratePercent: 2 },
  { lowerBound: 40000, upperBound: 80000, ratePercent: 12 },
  { lowerBound: 80000, upperBound: null, ratePercent: 22 },
];

describe('generated payroll run lifecycle (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const adminToken = issueAuthToken(ADMIN);
  const hrToken = issueAuthToken(HR_MANAGER);
  const officerToken = issueAuthToken(HR_OFFICER);
  const auditorToken = issueAuthToken(AUDITOR);
  const financeToken = issueAuthToken(FINANCE);
  const otherHrToken = issueAuthToken(OTHER_HR);
  const otherAuditorToken = issueAuthToken(OTHER_AUDITOR);
  const otherFinanceToken = issueAuthToken(OTHER_FINANCE);

  let config: any = null;
  let empA: any = null;
  let empB: any = null;
  let empC: any = null;
  let salaryA: any = null;
  let salaryB: any = null;
  let draftRun: any = null;

  async function request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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
      /* 204 has no body */
    }
    return { status: res.status, json, headers: res.headers };
  }

  const get = (path: string, auth = adminToken) => request('GET', path, undefined, auth);
  const post = (path: string, body: unknown, auth = adminToken) => request('POST', path, body, auth);
  const put = (path: string, body: unknown, auth = adminToken) =>
    request('PUT', path, body, auth);
  const patch = (path: string, body: unknown, auth = adminToken) =>
    request('PATCH', path, body, auth);
  const del = (path: string, auth = adminToken) => request('DELETE', path, undefined, auth);

  function employeeBody(code: string) {
    return {
      employeeCode: code,
      name: `Payrun ${code}`,
      branchId: BRANCH,
      department: 'Finance',
      designation: 'Payroll Analyst',
      joiningDateAD: '2027-04-01',
      monthlySalary: 50000,
      bankName: 'Payrun Test Bank',
      bankAccount: `ACC-${code}`,
    };
  }

  async function createSalary(employeeId: string, gross: number, ssfEligible: boolean, overtimeRate = 0) {
    return post('/api/hr/employee-salaries', {
      employeeId,
      effectiveFrom: '2027-04-01',
      monthlyGross: gross,
      ssfEligible,
      overtimeRate,
    });
  }

  async function auditCount(action: string): Promise<number> {
    const { rows } = await pool!.query(
      `SELECT COUNT(*)::int AS count
         FROM audit_logs
        WHERE action = $1 AND branch_id = $2`,
      [action, BRANCH]
    );
    return Number(rows[0].count);
  }

  async function journalTotals(journalId: string) {
    const { rows } = await pool!.query(
      `SELECT COALESCE(SUM(debit), 0)::numeric AS debit,
              COALESCE(SUM(credit), 0)::numeric AS credit,
              COUNT(*)::int AS lines
         FROM gl_journal_lines
        WHERE journal_id = $1`,
      [journalId]
    );
    return {
      debit: Number(rows[0].debit),
      credit: Number(rows[0].credit),
      lines: Number(rows[0].lines),
    };
  }

  async function cleanup() {
    await pool!.query(
      `DELETE FROM gl_journals WHERE branch_id = ANY($1::varchar[])`,
      [[BRANCH, OTHER_BRANCH]]
    );
    await pool!.query(
      `DELETE FROM payroll_runs WHERE branch_id = ANY($1::varchar[])`,
      [[BRANCH, OTHER_BRANCH]]
    );
    await pool!.query(
      `DELETE FROM gl_periods WHERE fiscal_year_id = ANY($1::varchar[])`,
      [[FY, FY_NO_CONFIG]]
    );
    await pool!.query(
      `DELETE FROM hr_attendance WHERE branch_id = ANY($1::varchar[])`,
      [[BRANCH, OTHER_BRANCH]]
    );
    await pool!.query(
      `DELETE FROM hr_employee_salary WHERE branch_id = ANY($1::varchar[])`,
      [[BRANCH, OTHER_BRANCH]]
    );
    await pool!.query(
      `DELETE FROM hr_payroll_adjustments
        WHERE employee_id IN (SELECT id FROM employees WHERE employee_code LIKE 'PRD-%')`,
      []
    );
    await pool!.query(
      `DELETE FROM employees WHERE employee_code LIKE 'PRD-%'`,
      []
    );
    await pool!.query(
      `DELETE FROM hr_statutory_configs WHERE fiscal_year_id = ANY($1::varchar[])`,
      [[FY, FY_NO_CONFIG]]
    );
    await pool!.query(
      `DELETE FROM audit_logs
        WHERE branch_id = ANY($1::varchar[])
           OR details LIKE '%PRD-%'
           OR details LIKE '%2083-PAYRUN%'
           OR details LIKE '%2083-PAYRUN-NC%'`,
      [[BRANCH, OTHER_BRANCH]]
    );
    await pool!.query(
      `DELETE FROM branches WHERE id = ANY($1::varchar[])`,
      [[BRANCH, OTHER_BRANCH]]
    );
    await pool!.query(
      `DELETE FROM fiscal_years WHERE id = ANY($1::varchar[])`,
      [[FY, FY_NO_CONFIG]]
    );
  }

  before(async () => {
    await ensureReferenceData(pool!, RUN_DATE);
    const bs = await ensureBsDayRecords(pool!, [
      '2027-04-01',
      RUN_DATE,
      '2027-05-01',
      DISCARD_DATE,
      '2027-07-01',
      NO_CONFIG_DATE,
    ]);
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'PRDB', 'Payrun Draft Branch', 'Test'),
              ($2, 'PRDB2', 'Payrun Draft Branch 2', 'Test')`,
      [BRANCH, OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO fiscal_years
         (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed)
       VALUES ($1, $2, '2027-04-01', '2027-05-31', $3, $4, FALSE, FALSE),
              ($5, $6, '2027-07-01', '2027-07-31', $7, $8, FALSE, FALSE)`,
      [
        FY,
        FY_CODE,
        bs.get('2027-04-01')!,
        bs.get(DISCARD_DATE)!,
        FY_NO_CONFIG,
        '2083-PAYRUN-NC',
        bs.get('2027-07-01')!,
        bs.get(NO_CONFIG_DATE)!,
      ]
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

    const configRes = await post('/api/hr/statutory-configs', {
      fiscalYearId: FY,
      employeeSsfPercent: 10,
      employerSsfPercent: 20,
      notes: 'Payrun draft test configuration',
      slabs: SLABS,
    });
    assert.equal(configRes.status, 201, JSON.stringify(configRes.json));
    config = configRes.json;

    empA = (await post('/api/employees', employeeBody('PRD-01'))).json;
    empB = (await post('/api/employees', employeeBody('PRD-02'))).json;
    empC = (await post('/api/employees', employeeBody('PRD-03'))).json;
    assert.ok(empA?.id && empB?.id && empC?.id);

    const salaryARes = await createSalary(empA.id, 100000, true, 500);
    const salaryBRes = await createSalary(empB.id, 50000, false, 0);
    assert.equal(salaryARes.status, 201, JSON.stringify(salaryARes.json));
    assert.equal(salaryBRes.status, 201, JSON.stringify(salaryBRes.json));
    salaryA = salaryARes.json;
    salaryB = salaryBRes.json;

    const absent = await post('/api/hr/attendance', {
      employeeId: empA.id,
      attendanceDateAD: '2027-04-15',
      status: 'ABSENT',
    });
    const present = await post('/api/hr/attendance', {
      employeeId: empA.id,
      attendanceDateAD: '2027-04-16',
      status: 'PRESENT',
      overtimeHours: 2,
    });
    assert.equal(absent.status, 201, JSON.stringify(absent.json));
    assert.equal(present.status, 201, JSON.stringify(present.json));
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('validates, scopes and upserts incentive, arrears and recovery inputs', async () => {
    const officerWrite = await put(
      '/api/hr/payroll-inputs',
      { employeeId: empA.id, periodKey: PERIOD, incentiveAmount: 100 },
      officerToken
    );
    assert.equal(officerWrite.status, 403, JSON.stringify(officerWrite.json));

    const auditorWrite = await put(
      '/api/hr/payroll-inputs',
      { employeeId: empA.id, periodKey: PERIOD, incentiveAmount: 100 },
      auditorToken
    );
    assert.equal(auditorWrite.status, 403, JSON.stringify(auditorWrite.json));

    const otherBranchWrite = await put(
      '/api/hr/payroll-inputs',
      { employeeId: empA.id, periodKey: PERIOD, incentiveAmount: 100 },
      otherHrToken
    );
    assert.equal(otherBranchWrite.status, 403, JSON.stringify(otherBranchWrite.json));

    const negative = await put(
      '/api/hr/payroll-inputs',
      { employeeId: empA.id, periodKey: PERIOD, incentiveAmount: -1 },
      hrToken
    );
    assert.equal(negative.status, 400, JSON.stringify(negative.json));

    const badPeriod = await put(
      '/api/hr/payroll-inputs',
      { employeeId: empA.id, periodKey: '2027-13', incentiveAmount: 1 },
      hrToken
    );
    assert.equal(badPeriod.status, 400, JSON.stringify(badPeriod.json));

    const first = await put(
      '/api/hr/payroll-inputs',
      {
        employeeId: empA.id,
        periodKey: PERIOD,
        incentiveAmount: 4000,
        arrearsAmount: 2500,
        advanceAmount: 1000,
        loanAmount: 2000,
        notes: 'April incentive and loan installment',
      },
      hrToken
    );
    assert.equal(first.status, 200, JSON.stringify(first.json));

    const updated = await put(
      '/api/hr/payroll-inputs',
      {
        employeeId: empA.id,
        periodKey: PERIOD,
        incentiveAmount: 5000,
        arrearsAmount: 2500,
        advanceAmount: 1000,
        loanAmount: 2000,
        notes: 'April incentive and loan installment',
      },
      hrToken
    );
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.equal(Number(updated.json.incentiveAmount), 5000);

    const second = await put(
      '/api/hr/payroll-inputs',
      {
        employeeId: empB.id,
        periodKey: PERIOD,
        incentiveAmount: 2000,
        arrearsAmount: 1000,
        advanceAmount: 500,
      },
      hrToken
    );
    assert.equal(second.status, 200, JSON.stringify(second.json));

    const rows = await get(
      `/api/hr/payroll-inputs?from=2027-04-01&to=2027-04-30&branchId=${BRANCH}`,
      auditorToken
    );
    assert.equal(rows.status, 200, JSON.stringify(rows.json));
    const inputA = rows.json.find((row: any) => row.employeeCode === 'PRD-01');
    const inputB = rows.json.find((row: any) => row.employeeCode === 'PRD-02');
    assert.equal(Number(inputA.incentiveAmount), 5000);
    assert.equal(Number(inputA.arrearsAmount), 2500);
    assert.equal(Number(inputA.advanceAmount), 1000);
    assert.equal(Number(inputA.loanAmount), 2000);
    assert.equal(inputA.adjustmentPeriodKey, PERIOD);
    assert.equal(Number(inputB.incentiveAmount), 2000);
    assert.equal(Number(inputB.loanAmount), 0);

    const otherRows = await get(
      `/api/hr/payroll-inputs?from=2027-04-01&to=2027-04-30&branchId=${OTHER_BRANCH}`,
      otherAuditorToken
    );
    assert.equal(otherRows.status, 200, JSON.stringify(otherRows.json));
    assert.deepEqual(otherRows.json, []);

    const count = await pool!.query(
      `SELECT COUNT(*)::int AS count FROM hr_payroll_adjustments
        WHERE period_key = $1 AND employee_id = ANY($2::varchar[])`,
      [PERIOD, [empA.id, empB.id]]
    );
    assert.equal(Number(count.rows[0].count), 2, 'the upsert must not stack rows');
    assert.equal(await auditCount('SET_HR_PAYROLL_INPUT'), 3);
  });

  test('generates a DRAFT from structures, inputs and the fiscal-year config', async () => {
    const missingStructure = await post(
      '/api/payroll-runs/draft',
      { branchId: BRANCH, periodKey: PERIOD },
      hrToken
    );
    assert.equal(missingStructure.status, 422, JSON.stringify(missingStructure.json));
    assert.match(missingStructure.json.message, /PRD-03/);

    const deactivate = await patch(`/api/employees/${empC.id}`, { isActive: false });
    assert.equal(deactivate.status, 200, JSON.stringify(deactivate.json));

    const beforeDraftAudits = await auditCount('CREATE_PAYROLL_RUN_DRAFT');
    const created = await post(
      '/api/payroll-runs/draft',
      { branchId: BRANCH, periodKey: PERIOD },
      hrToken
    );
    assert.equal(created.status, 201, JSON.stringify(created.json));
    draftRun = created.json;
    assert.equal(draftRun.status, 'DRAFT');
    assert.match(draftRun.runNo, /^DRAFT-/);
    assert.equal(draftRun.periodKey, PERIOD);
    assert.equal(draftRun.runDateAD, RUN_DATE);
    assert.ok(draftRun.runDateBS);
    assert.equal(draftRun.journalId, null);
    assert.equal(draftRun.preparedBy, HR_MANAGER.email);
    assert.equal(draftRun.statutoryConfigId, config.id);
    assert.equal(draftRun.fiscalYearCode, FY_CODE);
    assert.equal(draftRun.lines.length, 2);

    const lineA = draftRun.lines.find((line: any) => line.employeeCode === 'PRD-01');
    const lineB = draftRun.lines.find((line: any) => line.employeeCode === 'PRD-02');
    assert.ok(lineA && lineB);

    // A: 100,000 gross, one absent day in a 30-day month, 2 OT hours at 500.
    assert.equal(Number(lineA.basicAmount), 58000);
    assert.equal(Number(lineA.payableDays), 1);
    assert.equal(Number(lineA.lopDays), 1);
    assert.equal(Number(lineA.lopDeduction), 3333.33);
    assert.equal(Number(lineA.overtimeHours), 2);
    assert.equal(Number(lineA.overtimeAmount), 1000);
    assert.equal(Number(lineA.incentive), 5000);
    assert.equal(Number(lineA.arrears), 2500);
    assert.equal(Number(lineA.advance), 1000);
    assert.equal(Number(lineA.loan), 2000);
    assert.equal(Number(lineA.gross), 105166.67);
    assert.equal(Number(lineA.ssf), 5800);
    assert.equal(Number(lineA.employerSsf), 11600);
    assert.equal(Number(lineA.tds), 0);
    assert.equal(Number(lineA.net), 96366.67);
    assert.equal(lineA.salaryId, salaryA.id);

    // B: no SSF, no attendance, 50,000 gross plus one-off earnings.
    assert.equal(Number(lineB.incentive), 2000);
    assert.equal(Number(lineB.arrears), 1000);
    assert.equal(Number(lineB.advance), 500);
    assert.equal(Number(lineB.loan), 0);
    assert.equal(Number(lineB.gross), 53000);
    assert.equal(Number(lineB.ssf), 0);
    assert.equal(Number(lineB.tds), 2800);
    assert.equal(Number(lineB.net), 49700);
    assert.equal(lineB.salaryId, salaryB.id);

    assert.equal(Number(draftRun.grossTotal), 158166.67);
    assert.equal(Number(draftRun.tdsTotal), 2800);
    assert.equal(Number(draftRun.ssfTotal), 5800);
    assert.equal(Number(draftRun.incentiveTotal), 7000);
    assert.equal(Number(draftRun.arrearsTotal), 3500);
    assert.equal(Number(draftRun.advanceTotal), 1500);
    assert.equal(Number(draftRun.loanTotal), 2000);
    assert.equal(Number(draftRun.netTotal), 146066.67);

    const journals = await pool!.query(
      'SELECT COUNT(*)::int AS count FROM gl_journals WHERE source_id = $1',
      [draftRun.id]
    );
    assert.equal(Number(journals.rows[0].count), 0, 'a draft must not touch the ledger');

    const list = await get(`/api/payroll-runs?branchId=${BRANCH}`, auditorToken);
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].status, 'DRAFT');

    // The draft is a snapshot: changing the period input now must not rewrite it.
    const inputChange = await put(
      '/api/hr/payroll-inputs',
      {
        employeeId: empA.id,
        periodKey: PERIOD,
        incentiveAmount: 9999,
        arrearsAmount: 9999,
        advanceAmount: 0,
        loanAmount: 0,
      },
      hrToken
    );
    assert.equal(inputChange.status, 200, JSON.stringify(inputChange.json));
    const afterInputChange = await get(`/api/payroll-runs/${draftRun.id}`);
    const snapshotA = afterInputChange.json.lines.find(
      (line: any) => line.employeeCode === 'PRD-01'
    );
    assert.equal(Number(snapshotA.incentive), 5000);
    assert.equal(Number(snapshotA.arrears), 2500);
    assert.equal(Number(snapshotA.loan), 2000);
    assert.equal(Number(snapshotA.net), 96366.67);

    // HR prepared the draft and must be able to follow it without holding gl-view.
    const hrList = await get(`/api/payroll-runs?branchId=${BRANCH}`, hrToken);
    assert.equal(hrList.status, 200, JSON.stringify(hrList.json));
    assert.equal(hrList.json.length, 1);
    const hrDetail = await get(`/api/payroll-runs/${draftRun.id}`, hrToken);
    assert.equal(hrDetail.status, 200, JSON.stringify(hrDetail.json));
    assert.equal(hrDetail.json.status, 'DRAFT');

    const duplicate = await post(
      '/api/payroll-runs/draft',
      { branchId: BRANCH, periodKey: PERIOD },
      hrToken
    );
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));
    assert.equal(
      await auditCount('CREATE_PAYROLL_RUN_DRAFT'),
      beforeDraftAudits + 1,
      'a refused duplicate must not write a second draft audit'
    );
  });

  test('enforces DRAFT → APPROVED → POSTED → PAID and posts balanced journals', async () => {
    const postBeforeApprove = await post(
      `/api/payroll-runs/${draftRun.id}/post`,
      {},
      financeToken
    );
    assert.equal(postBeforeApprove.status, 409, JSON.stringify(postBeforeApprove.json));

    const draftPayslips = await get(
      `/api/payroll-runs/${draftRun.id}/payslips`,
      auditorToken
    );
    assert.equal(draftPayslips.status, 409, JSON.stringify(draftPayslips.json));
    assert.match(draftPayslips.json.message, /only after posting/);
    const draftRegister = await get(
      `/api/payroll-runs/${draftRun.id}/register`,
      auditorToken
    );
    assert.equal(draftRegister.status, 409, JSON.stringify(draftRegister.json));

    const approveByHr = await post(
      `/api/payroll-runs/${draftRun.id}/approve`,
      {},
      hrToken
    );
    assert.equal(approveByHr.status, 403, JSON.stringify(approveByHr.json));

    const payBeforePost = await post(
      `/api/payroll-runs/${draftRun.id}/pay`,
      { paymentMethod: 'CASH' },
      financeToken
    );
    assert.equal(payBeforePost.status, 409, JSON.stringify(payBeforePost.json));

    // An older draft can still carry TDS. Approval must stop it before Finance
    // posts an SSF-eligible employee's TDS to the ledger.
    const tampered = await pool!.query(
      `UPDATE payroll_run_lines
          SET tds_amount = 100, net_amount = net_amount - 100
        WHERE run_id = $1 AND employee_code = 'PRD-01'`,
      [draftRun.id]
    );
    assert.equal(tampered.rowCount, 1);
    const refusedApprove = await post(
      `/api/payroll-runs/${draftRun.id}/approve`,
      {},
      financeToken
    );
    assert.equal(refusedApprove.status, 422, JSON.stringify(refusedApprove.json));
    assert.match(refusedApprove.json.message, /SSF-eligible/);
    await pool!.query(
      `UPDATE payroll_run_lines
          SET tds_amount = 0, net_amount = net_amount + 100
        WHERE run_id = $1 AND employee_code = 'PRD-01'`,
      [draftRun.id]
    );

    // The draft is a snapshot: editing the rule after preparation must not
    // rewrite the approved/posted lines.
    const configUpdate = await patch(`/api/hr/statutory-configs/${config.id}`, {
      employeeSsfPercent: 12,
      slabs: UPDATED_SLABS,
    });
    assert.equal(configUpdate.status, 200, JSON.stringify(configUpdate.json));

    const approved = await post(
      `/api/payroll-runs/${draftRun.id}/approve`,
      {},
      financeToken
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal(approved.json.status, 'APPROVED');
    assert.equal(approved.json.approvedBy, FINANCE.email);
    assert.ok(approved.json.approvedAt);

    const approvedPayslips = await get(
      `/api/payroll-runs/${draftRun.id}/payslips`,
      auditorToken
    );
    assert.equal(approvedPayslips.status, 409, JSON.stringify(approvedPayslips.json));
    const approvedRegister = await get(
      `/api/payroll-runs/${draftRun.id}/register`,
      auditorToken
    );
    assert.equal(approvedRegister.status, 409, JSON.stringify(approvedRegister.json));
    const approvedBankFile = await get(
      `/api/payroll-runs/${draftRun.id}/bank-file`,
      hrToken
    );
    assert.equal(approvedBankFile.status, 409, JSON.stringify(approvedBankFile.json));
    assert.match(approvedBankFile.json.message, /available only after posting/);

    const approvedRun = await get(`/api/payroll-runs/${draftRun.id}`);
    assert.equal(approvedRun.status, 200, JSON.stringify(approvedRun.json));
    const approvedLineA = approvedRun.json.lines.find(
      (line: any) => line.employeeCode === 'PRD-01'
    );
    assert.equal(Number(approvedLineA.ssf), 5800, 'the prepared SSF snapshot must survive a rule edit');
    assert.equal(
      Number(approvedLineA.tds),
      0,
      'an SSF-eligible line carries no TDS even after a rule edit'
    );

    const deleteApproved = await del(`/api/payroll-runs/${draftRun.id}`, hrToken);
    assert.equal(deleteApproved.status, 409, JSON.stringify(deleteApproved.json));

    const approveAgain = await post(
      `/api/payroll-runs/${draftRun.id}/approve`,
      {},
      financeToken
    );
    assert.equal(approveAgain.status, 409, JSON.stringify(approveAgain.json));

    const payApproved = await post(
      `/api/payroll-runs/${draftRun.id}/pay`,
      { paymentMethod: 'CASH' },
      financeToken
    );
    assert.equal(payApproved.status, 409, JSON.stringify(payApproved.json));

    const posted = await post(
      `/api/payroll-runs/${draftRun.id}/post`,
      {},
      financeToken
    );
    assert.equal(posted.status, 200, JSON.stringify(posted.json));
    assert.equal(posted.json.status, 'POSTED');
    assert.match(posted.json.runNo, /^PR-/);
    assert.equal(posted.json.journalId, posted.json.journal.id);
    assert.equal(posted.json.journalNo, posted.json.journal.journalNo);
    assert.equal(Number(posted.json.grossTotal), 158166.67);

    const runJournal = posted.json.journal;
    const runTotals = await journalTotals(runJournal.id);
    // Salary cost = gross 158,166.67 + employer SSF 11,600.00. The employer
    // share is credited to SSF payable per employee, so it adds two lines.
    assert.equal(runTotals.debit, 169766.67);
    assert.equal(runTotals.credit, 169766.67);
    assert.equal(runTotals.lines, 9);

    const postedList = await get(
      `/api/payroll-runs?branchId=${BRANCH}&status=POSTED`,
      auditorToken
    );
    assert.equal(postedList.status, 200, JSON.stringify(postedList.json));
    assert.equal(postedList.json.length, 1);

    const postedPostings = await get(
      `/api/payroll-runs/postings?branchId=${BRANCH}`,
      financeToken
    );
    assert.equal(postedPostings.status, 200, JSON.stringify(postedPostings.json));
    assert.equal(postedPostings.json.length, 1);
    assert.equal(postedPostings.json[0].status, 'POSTED');
    assert.equal(postedPostings.json[0].journalNo, runJournal.journalNo);

    const payByHr = await post(
      `/api/payroll-runs/${draftRun.id}/pay`,
      { paymentMethod: 'BANK' },
      hrToken
    );
    assert.equal(payByHr.status, 403, JSON.stringify(payByHr.json));

    const paid = await post(
      `/api/payroll-runs/${draftRun.id}/pay`,
      { paymentMethod: 'BANK' },
      financeToken
    );
    assert.equal(paid.status, 200, JSON.stringify(paid.json));
    assert.equal(paid.json.status, 'PAID');
    assert.equal(paid.json.paymentMethod, 'BANK');
    assert.equal(paid.json.paidDateAD, RUN_DATE);
    assert.equal(paid.json.paidJournalId, paid.json.journal.id);

    const paymentTotals = await journalTotals(paid.json.journal.id);
    assert.equal(paymentTotals.debit, 146066.67);
    assert.equal(paymentTotals.credit, 146066.67);

    // The posted journal must leave SSF payable holding exactly the employee
    // share withheld plus the employer share the company owes, and the payroll
    // report must tie that control balance back cleanly (no rate disagreement,
    // no unconfigured run, no difference).
    const ssfCredits = await pool!.query(
      `SELECT j.id AS "journalId", j.source_id AS "sourceId", jl.line_no AS "lineNo",
              jl.memo AS "memo", s.debit::numeric AS debit, s.credit::numeric AS credit
         FROM gl_subledger_entries s
         JOIN gl_journals j ON j.id = s.journal_id
         JOIN gl_accounts a ON a.id = s.account_id
         LEFT JOIN gl_journal_lines jl ON jl.id = s.journal_line_id
        WHERE a.posting_role = 'SSF_PAYABLE'
          AND s.party_id = $1
        ORDER BY j.id, jl.line_no`,
      [empA.id]
    );
    const runSsfRows = ssfCredits.rows.filter((row: any) => row.sourceId === draftRun.id);
    const runSsfTotal = runSsfRows.reduce(
      (sum: number, row: any) => sum + Number(row.credit) - Number(row.debit),
      0
    );
    assert.equal(
      runSsfTotal.toFixed(2),
      '17400.00',
      JSON.stringify(runSsfRows)
    );

    const ssfDate = String(posted.json.journal?.journalDateAD || RUN_DATE).slice(0, 10);
    const ssfReport = await get(
      `/api/hr/reports/payroll?branchId=${BRANCH}&dateFrom=${ssfDate}&dateTo=${ssfDate}`,
      hrToken
    );
    assert.equal(ssfReport.status, 200, JSON.stringify(ssfReport.json));
    const ssf = ssfReport.json.ssf;
    assert.equal(ssf.employeeSsf, 5800);
    assert.equal(ssf.employerSsf, 11600);
    assert.equal(ssf.payable, 17400);
    // The ledger tie-out is clean: the control account holds exactly the
    // employee share withheld plus the employer share owed.
    assert.equal(ssf.controlBalance, 17400);
    assert.equal(ssf.difference, 0);
    assert.equal(ssf.matches, true, JSON.stringify(ssf));
    assert.equal(ssf.reason, null);
    // The test edits the statutory rule between preparing and posting (10% →
    // 12%). The line snapshots the rate it was paid at, so the configured
    // contribution stays exact instead of following the edited config.
    assert.equal(ssf.configured, 17400);
    assert.equal(ssf.rateMismatchLines, 0);
    assert.equal(ssf.unconfiguredLines, 0);
    assert.equal(ssf.ratesMatch, true);
    assert.equal(ssf.rateNote, null);
    assert.equal(ssf.byEmployee.length, 1, 'only the SSF-eligible employee belongs here');
    assert.equal(ssf.byEmployee[0].employeeCode, 'PRD-01');
    assert.equal(ssf.byEmployee[0].payable, 17400);
    assert.equal(ssf.byEmployee[0].controlBalance, 17400);
    assert.equal(ssf.byEmployee[0].difference, 0);
    assert.equal(ssf.byEmployee[0].matches, true);
    assert.equal(ssf.byEmployee[0].ratesMatch, true);
    assert.equal(ssf.unattributedControl, 0);

    const paidList = await get(
      `/api/payroll-runs?branchId=${BRANCH}&status=PAID`,
      auditorToken
    );
    assert.equal(paidList.status, 200, JSON.stringify(paidList.json));
    assert.equal(paidList.json.length, 1);

    const postedAfterPay = await get(
      `/api/payroll-runs?branchId=${BRANCH}&status=POSTED`,
      auditorToken
    );
    assert.equal(postedAfterPay.json.length, 0);

    const payAgain = await post(
      `/api/payroll-runs/${draftRun.id}/pay`,
      { paymentMethod: 'BANK' },
      financeToken
    );
    assert.equal(payAgain.status, 409, JSON.stringify(payAgain.json));

    assert.equal(await auditCount('APPROVE_PAYROLL_RUN'), 1);
    assert.equal(await auditCount('POST_PAYROLL_RUN'), 1);
    assert.equal(await auditCount('PAY_PAYROLL_RUN'), 1);
  });

  test('serves a read-only, gl-view-only Finance payroll-postings register', async () => {
    const unauth = await fetch(`http://127.0.0.1:${port}/api/payroll-runs/postings?branchId=${BRANCH}`);
    assert.equal(unauth.status, 401);

    const hrRead = await get(`/api/payroll-runs/postings?branchId=${BRANCH}`, hrToken);
    assert.equal(hrRead.status, 403, JSON.stringify(hrRead.json));

    const otherBranchRead = await get(
      `/api/payroll-runs/postings?branchId=${BRANCH}`,
      otherAuditorToken
    );
    assert.equal(otherBranchRead.status, 403, JSON.stringify(otherBranchRead.json));

    const widen = await get('/api/payroll-runs/postings?branchId=ALL', auditorToken);
    assert.equal(widen.status, 403, JSON.stringify(widen.json));

    const invalidDate = await get(
      '/api/payroll-runs/postings?from=2027-13-01',
      auditorToken
    );
    assert.equal(invalidDate.status, 400, JSON.stringify(invalidDate.json));
    const reversedRange = await get(
      `/api/payroll-runs/postings?from=${RUN_DATE}&to=2027-04-01`,
      auditorToken
    );
    assert.equal(reversedRange.status, 400, JSON.stringify(reversedRange.json));

    // A draft in the same branch must never enter the Finance register.
    const draft = await post(
      '/api/payroll-runs/draft',
      { branchId: BRANCH, periodKey: DISCARD_PERIOD },
      hrToken
    );
    assert.equal(draft.status, 201, JSON.stringify(draft.json));
    const withDraftHidden = await get(
      `/api/payroll-runs/postings?branchId=${BRANCH}`,
      auditorToken
    );
    assert.equal(withDraftHidden.status, 200, JSON.stringify(withDraftHidden.json));
    assert.equal(withDraftHidden.json.length, 1);
    assert.equal(withDraftHidden.json[0].status, 'PAID');
    assert.ok(withDraftHidden.json.every((row: any) => row.id !== draft.json.id));

    const approvedDraft = await post(
      `/api/payroll-runs/${draft.json.id}/approve`,
      {},
      financeToken
    );
    assert.equal(approvedDraft.status, 200, JSON.stringify(approvedDraft.json));
    assert.equal(approvedDraft.json.status, 'APPROVED');
    const withApprovedHidden = await get(
      `/api/payroll-runs/postings?branchId=${BRANCH}`,
      auditorToken
    );
    assert.equal(withApprovedHidden.status, 200, JSON.stringify(withApprovedHidden.json));
    assert.equal(withApprovedHidden.json.length, 1);
    assert.ok(withApprovedHidden.json.every((row: any) => row.id !== draft.json.id));

    // Fixture cleanup only: delete directly so the later discard test keeps its
    // one-audit assertion, and the register read itself remains write-free.
    const discarded = await pool!.query('DELETE FROM payroll_runs WHERE id = $1', [draft.json.id]);
    assert.equal(discarded.rowCount, 1);

    const beforeRun = await pool!.query(
      `SELECT status, journal_id, paid_journal_id, gross_total::text, net_total::text
         FROM payroll_runs WHERE id = $1`,
      [draftRun.id]
    );
    const beforeJournals = await pool!.query(
      `SELECT COUNT(*)::int AS count FROM gl_journals WHERE branch_id = $1`,
      [BRANCH]
    );

    const register = await get(
      `/api/payroll-runs/postings?branchId=${BRANCH}&from=${RUN_DATE}&to=${RUN_DATE}`,
      auditorToken
    );
    assert.equal(register.status, 200, JSON.stringify(register.json));
    assert.equal(register.json.length, 1);
    const row = register.json[0];
    assert.match(row.runNo, /^PR-/);
    assert.equal(row.branchId, BRANCH);
    assert.equal(row.branchName, 'Payrun Draft Branch');
    assert.equal(row.periodKey, PERIOD);
    assert.equal(row.runDateAD, RUN_DATE);
    assert.ok(row.runDateBS);
    assert.equal(row.status, 'PAID');
    assert.equal(row.employeeCount, 2);
    assert.equal(Number(row.grossTotal).toFixed(2), '158166.67');
    assert.equal(Number(row.incentiveTotal).toFixed(2), '7000.00');
    assert.equal(Number(row.arrearsTotal).toFixed(2), '3500.00');
    assert.equal(Number(row.tdsTotal).toFixed(2), '2800.00');
    assert.equal(Number(row.ssfTotal).toFixed(2), '5800.00');
    assert.equal(Number(row.advanceTotal).toFixed(2), '1500.00');
    assert.equal(Number(row.loanTotal).toFixed(2), '2000.00');
    assert.equal(Number(row.netTotal).toFixed(2), '146066.67');
    // The posting now debits the full salary cost: gross wages 158,166.67 plus
    // the employer's SSF share 11,600.00 (a company cost, credited to SSF
    // payable). It used to stop at gross, which understated salary expense.
    assert.equal(Number(row.journalDebit).toFixed(2), '169766.67');
    assert.equal(Number(row.journalCredit).toFixed(2), '169766.67');
    assert.equal(Number(row.paymentDebit).toFixed(2), '146066.67');
    assert.equal(Number(row.paymentCredit).toFixed(2), '146066.67');
    assert.ok(row.journalNo);
    assert.ok(row.paymentJournalNo);
    assert.equal(row.journalStatus, 'POSTED');
    assert.equal(row.paymentJournalStatus, 'POSTED');
    assert.equal(row.paymentMethod, 'BANK');
    assert.equal(row.paidDateAD, RUN_DATE);

    const noMatch = await get(
      `/api/payroll-runs/postings?branchId=${BRANCH}&from=2027-05-01`,
      auditorToken
    );
    assert.equal(noMatch.status, 200, JSON.stringify(noMatch.json));
    assert.deepEqual(noMatch.json, []);
    const byRunNo = await get(
      `/api/payroll-runs/postings?branchId=${BRANCH}&query=${encodeURIComponent(row.runNo)}`,
      auditorToken
    );
    assert.equal(byRunNo.status, 200, JSON.stringify(byRunNo.json));
    assert.equal(byRunNo.json.length, 1);
    assert.equal(byRunNo.json[0].id, draftRun.id);

    const afterRun = await pool!.query(
      `SELECT status, journal_id, paid_journal_id, gross_total::text, net_total::text
         FROM payroll_runs WHERE id = $1`,
      [draftRun.id]
    );
    const afterJournals = await pool!.query(
      `SELECT COUNT(*)::int AS count FROM gl_journals WHERE branch_id = $1`,
      [BRANCH]
    );
    assert.deepEqual(afterRun.rows[0], beforeRun.rows[0], 'register reads must not mutate the run');
    assert.deepEqual(afterJournals.rows[0], beforeJournals.rows[0], 'register reads must not write journals');
  });

  test('serves posted payslips and a reconciled transfer register without ledger writes', async () => {
    const payslips = await get(`/api/payroll-runs/${draftRun.id}/payslips`, auditorToken);
    assert.equal(payslips.status, 200, JSON.stringify(payslips.json));
    assert.equal(payslips.headers.get('cache-control'), 'private, no-store');
    assert.equal(payslips.json.payslips.length, 2);
    assert.equal(payslips.json.reconciliation.matchesRun, true);
    assert.equal(payslips.json.reconciliation.matchesJournal, true);
    assert.equal(payslips.json.reconciliation.paymentMatchesRun, true);

    const lineA = payslips.json.payslips.find((row: any) => row.employeeCode === 'PRD-01');
    const lineB = payslips.json.payslips.find((row: any) => row.employeeCode === 'PRD-02');
    assert.ok(lineA && lineB);
    assert.equal(lineA.department, 'Finance');
    assert.equal(lineA.bankStatus, 'READY');
    assert.equal(lineA.bankAccount, null, 'the auditor must not receive bank details');
    assert.equal(lineA.detailsRestricted, true);
    assert.equal(lineA.basicAmount, 58000);
    assert.equal(lineA.allowances, 42000);
    assert.equal(lineA.overtimeAmount, 1000);
    assert.equal(lineA.incentive, 5000);
    assert.equal(lineA.arrears, 2500);
    assert.equal(lineA.lopDeduction, 3333.33);
    assert.equal(lineA.gross, 105166.67);
    assert.equal(lineA.tds, 0);
    assert.equal(lineA.ssf, 5800);
    assert.equal(lineA.employerSsf, 11600);
    assert.equal(lineA.totalDeductions, 8800);
    assert.equal(lineA.net, 96366.67);
    assert.equal(lineA.employerCost, 116766.67);
    assert.equal(lineA.fiscalYearCode, FY_CODE);
    assert.equal(lineA.status, 'PAID');

    assert.equal(lineB.basicAmount, 30000);
    assert.equal(lineB.allowances, 20000);
    assert.equal(lineB.incentive, 2000);
    assert.equal(lineB.arrears, 1000);
    assert.equal(lineB.gross, 53000);
    assert.equal(lineB.tds, 2800);
    assert.equal(lineB.net, 49700);

    const hrPayslips = await get(`/api/payroll-runs/${draftRun.id}/payslips`, hrToken);
    assert.equal(hrPayslips.status, 200, JSON.stringify(hrPayslips.json));
    const hrLineA = hrPayslips.json.payslips.find((row: any) => row.employeeCode === 'PRD-01');
    assert.equal(hrLineA.bankAccount, 'ACC-PRD-01');
    assert.equal(hrLineA.detailsRestricted, false);

    const single = await get(
      `/api/payroll-runs/${draftRun.id}/payslips/${empA.id}`,
      auditorToken
    );
    assert.equal(single.status, 200, JSON.stringify(single.json));
    assert.equal(single.headers.get('cache-control'), 'private, no-store');
    assert.equal(single.json.payslip.employeeCode, 'PRD-01');
    assert.equal(single.json.payslip.net, 96366.67);

    const register = await get(`/api/payroll-runs/${draftRun.id}/register`, auditorToken);
    assert.equal(register.status, 200, JSON.stringify(register.json));
    assert.equal(register.headers.get('cache-control'), 'private, no-store');
    assert.equal(register.json.rows.length, 2);
    assert.equal(register.json.totals.employees, 2);
    assert.equal(register.json.totals.basic, 88000);
    assert.equal(register.json.totals.allowances, 62000);
    assert.equal(register.json.totals.overtime, 1000);
    assert.equal(register.json.totals.incentive, 7000);
    assert.equal(register.json.totals.arrears, 3500);
    assert.equal(register.json.totals.lop, 3333.33);
    assert.equal(register.json.totals.gross, 158166.67);
    assert.equal(register.json.totals.tds, 2800);
    assert.equal(register.json.totals.ssf, 5800);
    assert.equal(register.json.totals.advance, 1500);
    assert.equal(register.json.totals.loan, 2000);
    assert.equal(register.json.totals.employerSsf, 11600);
    assert.equal(register.json.totals.net, 146066.67);
    assert.equal(register.json.totals.deductions, 12100);
    assert.equal(register.json.totals.employerCost, 169766.67);
    assert.equal(register.json.statutory.employeeSsf, 5800);
    assert.equal(register.json.statutory.employerSsf, 11600);
    assert.equal(register.json.statutory.tds, 2800);
    assert.equal(register.json.journal.totalDebit, 169766.67);
    assert.equal(register.json.journal.totalCredit, 169766.67);
    assert.equal(register.json.paymentJournal.totalDebit, 146066.67);
    assert.equal(register.json.paymentJournal.totalCredit, 146066.67);
    assert.equal(register.json.reconciliation.matchesRun, true);
    assert.equal(register.json.reconciliation.matchesJournal, true);
    assert.equal(register.json.reconciliation.paymentMatchesRun, true);

    // The badge must cover every run total the register prints, not just the
    // four headline figures: a stale advance/loan total is a mismatch too.
    const reconciliationOutput = buildPayrollOutput(
      {
        branchId: BRANCH,
        branchName: 'Reconciliation Branch',
        runNo: 'PR-RECON-1',
        periodKey: PERIOD,
        runDateAD: RUN_DATE,
        runDateBS: null,
        paidDateAD: null,
        paymentMethod: 'BANK',
        status: 'PAID',
        fiscalYearCode: FY_CODE,
      },
      [
        {
          employeeId: 'recon-employee',
          employeeCode: 'RECON-01',
          employeeName: 'Reconciliation Fixture',
          basicAmount: 100,
          gross: 100,
          tds: 0,
          ssf: 0,
          employerSsf: 0,
          advance: 25,
          loan: 10,
          net: 65,
          payableDays: 30,
          lopDays: 0,
          lopDeduction: 0,
          overtimeHours: 0,
          overtimeAmount: 0,
        },
      ],
      [
        {
          id: 'recon-employee',
          department: null,
          designation: null,
          panNumber: null,
          ssfNumber: null,
          bankName: null,
          bankAccount: null,
        },
      ],
      true
    );
    const reconciliationRun = {
      grossTotal: 100,
      tdsTotal: 0,
      ssfTotal: 0,
      advanceTotal: 25,
      loanTotal: 10,
      netTotal: 65,
    };
    assert.equal(
      buildPayrollReconciliation(reconciliationRun, reconciliationOutput, null, null).matchesRun,
      true
    );
    assert.equal(
      buildPayrollReconciliation(
        { ...reconciliationRun, advanceTotal: 0 },
        reconciliationOutput,
        null,
        null
      ).matchesRun,
      false,
      'a stale run advance total must fail the register reconciliation'
    );
    assert.equal(
      buildPayrollReconciliation(
        { ...reconciliationRun, loanTotal: 0 },
        reconciliationOutput,
        null,
        null
      ).matchesRun,
      false,
      'a stale run loan total must fail the register reconciliation'
    );
    assert.equal(
      buildPayrollReconciliation(
        { ...reconciliationRun, incentiveTotal: 1 },
        reconciliationOutput,
        null,
        null
      ).matchesRun,
      false,
      'a stale run incentive total must fail the register reconciliation'
    );
    assert.equal(
      buildPayrollReconciliation(
        { ...reconciliationRun, arrearsTotal: 1 },
        reconciliationOutput,
        null,
        null
      ).matchesRun,
      false,
      'a stale run arrears total must fail the register reconciliation'
    );

    const registerBankA = register.json.rows.find((row: any) => row.employeeCode === 'PRD-01');
    assert.equal(registerBankA.bankAccount, null, 'the register must not leak bank details to the auditor');
    assert.equal(registerBankA.bankStatus, 'READY');
    assert.equal(registerBankA.detailsRestricted, true);

    const officerRead = await get(`/api/payroll-runs/${draftRun.id}/register`, officerToken);
    assert.equal(officerRead.status, 403, JSON.stringify(officerRead.json));
    const otherBranchRead = await get(
      `/api/payroll-runs/${draftRun.id}/payslips`,
      otherAuditorToken
    );
    assert.equal(otherBranchRead.status, 403, JSON.stringify(otherBranchRead.json));
    const otherBranchRegister = await get(
      `/api/payroll-runs/${draftRun.id}/register`,
      otherFinanceToken
    );
    assert.equal(otherBranchRegister.status, 403, JSON.stringify(otherBranchRegister.json));

    const auditorBankFile = await get(
      `/api/payroll-runs/${draftRun.id}/bank-file`,
      auditorToken
    );
    assert.equal(auditorBankFile.status, 403, JSON.stringify(auditorBankFile.json));
    const otherBranchBankFile = await get(
      `/api/payroll-runs/${draftRun.id}/bank-file`,
      otherHrToken
    );
    assert.equal(otherBranchBankFile.status, 403, JSON.stringify(otherBranchBankFile.json));

    const beforeLedger = await pool!.query(
      `SELECT
         (SELECT COUNT(*)::int FROM gl_journals WHERE branch_id = $1) AS journals,
         (SELECT COUNT(*)::int FROM gl_journal_lines l JOIN gl_journals j ON j.id = l.journal_id WHERE j.branch_id = $1) AS lines`,
      [BRANCH]
    );
    const bankFile = await fetch(
      `http://127.0.0.1:${port}/api/payroll-runs/${draftRun.id}/bank-file`,
      { headers: { authorization: 'Bearer ' + hrToken } }
    );
    const bankCsv = await bankFile.text();
    assert.equal(bankFile.status, 200, bankCsv);
    assert.equal(bankFile.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(bankFile.headers.get('cache-control'), 'private, no-store');
    assert.ok(
      (bankFile.headers.get('content-disposition') || '').includes(
        `filename="payroll-bank-file-${register.json.runNo}.csv"`
      )
    );
    const bankLines = bankCsv.trim().split(/\r\n/);
    assert.equal(
      bankLines[0],
      'Employee Code,Beneficiary Name,Bank Name,Bank Account Number,Amount (NPR),Narration'
    );
    assert.equal(bankLines.length, 3, 'the bank file must contain exactly the two snapshot employees');
    const bankRowA = bankLines.find((line) => line.includes('"PRD-01"'));
    assert.ok(bankRowA, 'PRD-01 must be present in the bank file');
    assert.match(
      bankRowA!,
      /"Payrun Test Bank","ACC-PRD-01",96366\.67,"Salary 2027-04 PR-/
    );

    const snapshottedBanks = await pool!.query(
      `SELECT employee_code, bank_name, bank_account
       FROM payroll_run_lines WHERE run_id = $1 ORDER BY employee_code`,
      [draftRun.id]
    );
    assert.deepEqual(snapshottedBanks.rows, [
      { employee_code: 'PRD-01', bank_name: 'Payrun Test Bank', bank_account: 'ACC-PRD-01' },
      { employee_code: 'PRD-02', bank_name: 'Payrun Test Bank', bank_account: 'ACC-PRD-02' },
    ]);

    // A later employee-master edit must not rewrite a posted bank file. The
    // line snapshot is the authority, so clearing the employee's bank account
    // leaves this run payable and still names the original beneficiary.
    await pool!.query(
      'UPDATE employees SET bank_name = NULL, bank_account = NULL WHERE id = $1',
      [empB.id]
    );
    let snapshotBankStatus = 0;
    let snapshotBankCsv = '';
    let snapshotHrPayslips: any = null;
    try {
      const snapshotBank = await fetch(
        `http://127.0.0.1:${port}/api/payroll-runs/${draftRun.id}/bank-file`,
        { headers: { authorization: 'Bearer ' + hrToken } }
      );
      snapshotBankStatus = snapshotBank.status;
      snapshotBankCsv = await snapshotBank.text();
      snapshotHrPayslips = await get(
        `/api/payroll-runs/${draftRun.id}/payslips`,
        hrToken
      );
    } finally {
      await pool!.query('UPDATE employees SET bank_name = $1, bank_account = $2 WHERE id = $3', [
        'Payrun Test Bank',
        'ACC-PRD-02',
        empB.id,
      ]);
    }
    assert.equal(snapshotBankStatus, 200, snapshotBankCsv);
    assert.match(snapshotBankCsv, /"Payrun Test Bank","ACC-PRD-02",49700\.00/);
    const snapshotLineB = snapshotHrPayslips.json.payslips.find(
      (row: any) => row.employeeCode === 'PRD-02'
    );
    assert.equal(snapshotLineB.bankAccount, 'ACC-PRD-02');
    assert.equal(snapshotLineB.bankStatus, 'READY');

    const print = await fetch(
      `http://127.0.0.1:${port}/api/payroll-runs/${draftRun.id}/payslips/${empA.id}/print`,
      { headers: { authorization: 'Bearer ' + auditorToken } }
    );
    assert.equal(print.status, 200, 'posted payslip must produce a PDF');
    assert.match(print.headers.get('content-type') || '', /application\/pdf/);
    assert.ok((await print.arrayBuffer()).byteLength > 1000);
    const afterLedger = await pool!.query(
      `SELECT
         (SELECT COUNT(*)::int FROM gl_journals WHERE branch_id = $1) AS journals,
         (SELECT COUNT(*)::int FROM gl_journal_lines l JOIN gl_journals j ON j.id = l.journal_id WHERE j.branch_id = $1) AS lines`,
      [BRANCH]
    );
    assert.deepEqual(afterLedger.rows[0], beforeLedger.rows[0], 'output reads must not write ledger rows');
  });

  test('refuses missing configuration, unauthorized roles and another branch', async () => {
    const noConfig = await post(
      '/api/payroll-runs/draft',
      { branchId: BRANCH, periodKey: NO_CONFIG_PERIOD },
      hrToken
    );
    assert.equal(noConfig.status, 422, JSON.stringify(noConfig.json));
    assert.match(noConfig.json.message, /No statutory configuration/);

    const officerDraft = await post(
      '/api/payroll-runs/draft',
      { branchId: BRANCH, periodKey: DISCARD_PERIOD },
      officerToken
    );
    assert.equal(officerDraft.status, 403, JSON.stringify(officerDraft.json));

    const auditorDraft = await post(
      '/api/payroll-runs/draft',
      { branchId: BRANCH, periodKey: DISCARD_PERIOD },
      auditorToken
    );
    assert.equal(auditorDraft.status, 403, JSON.stringify(auditorDraft.json));

    const otherBranchDraft = await post(
      '/api/payroll-runs/draft',
      { branchId: BRANCH, periodKey: DISCARD_PERIOD },
      otherHrToken
    );
    assert.equal(otherBranchDraft.status, 403, JSON.stringify(otherBranchDraft.json));

    const officerRead = await get(`/api/payroll-runs/${draftRun.id}`, officerToken);
    assert.equal(officerRead.status, 403, JSON.stringify(officerRead.json));

    const otherRead = await get(`/api/payroll-runs/${draftRun.id}`, otherAuditorToken);
    assert.equal(otherRead.status, 403, JSON.stringify(otherRead.json));

    const otherList = await get(
      `/api/payroll-runs?branchId=${BRANCH}`,
      otherAuditorToken
    );
    assert.equal(otherList.status, 403, JSON.stringify(otherList.json));

    const otherApprove = await post(
      `/api/payroll-runs/${draftRun.id}/approve`,
      {},
      otherFinanceToken
    );
    assert.equal(otherApprove.status, 403, JSON.stringify(otherApprove.json));
  });

  test('discards only an unapproved DRAFT and permits a fresh draft', async () => {
    const mayDraft = await post(
      '/api/payroll-runs/draft',
      { branchId: BRANCH, periodKey: DISCARD_PERIOD },
      hrToken
    );
    assert.equal(mayDraft.status, 201, JSON.stringify(mayDraft.json));

    const auditorDelete = await del(`/api/payroll-runs/${mayDraft.json.id}`, auditorToken);
    assert.equal(auditorDelete.status, 403, JSON.stringify(auditorDelete.json));

    const discarded = await del(`/api/payroll-runs/${mayDraft.json.id}`, hrToken);
    assert.equal(discarded.status, 204, JSON.stringify(discarded.json));

    const gone = await get(`/api/payroll-runs/${mayDraft.json.id}`, auditorToken);
    assert.equal(gone.status, 404, JSON.stringify(gone.json));

    const recreated = await post(
      '/api/payroll-runs/draft',
      { branchId: BRANCH, periodKey: DISCARD_PERIOD },
      hrToken
    );
    assert.equal(recreated.status, 201, JSON.stringify(recreated.json));
    assert.equal(recreated.json.status, 'DRAFT');
    assert.equal(recreated.json.preparedBy, HR_MANAGER.email);
    assert.equal(await auditCount('DISCARD_PAYROLL_RUN_DRAFT'), 1);
  });
});
