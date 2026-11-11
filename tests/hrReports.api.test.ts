/**
 * Phase 3 HR Reports — session-scoped workforce aggregates.
 *
 * The fixture seeds two branches, active/inactive employees, two leave types,
 * current and prior-year balances, and APPROVED/PENDING/REJECTED requests. It
 * then drives the real HTTP route:
 *
 *   1. headcount is active-only and aggregates by branch and department;
 *   2. leave liability is current-year DAYS from entitlement + adjustment −
 *      APPROVED usage, excluding inactive employees and prior-year rows;
 *   3. attrition counts only stored separation dates, uses the period-start
 *      headcount and returns a null rate with a reason when that baseline is
 *      incomplete;
 *   4. a branch manager cannot widen scope, name ALL, repeat a branch filter,
 *      or pass an employee/user/tenant/document selector;
 *   5. the endpoints are private/no-store and mutate nothing;
 *   6. payroll cost, overtime and SSF/TDS filing read only stored
 *      POSTED/PAID run-line snapshots, never a draft or a re-derived estimate.
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

const BRANCH_A = 'hr-rpt-br-a';
const BRANCH_B = 'hr-rpt-br-b';

const ADMIN = {
  id: 'hr-rpt-user-admin',
  email: 'hr-rpt-admin@example.com',
  name: 'HR Report Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

const MANAGER_A = {
  id: 'hr-rpt-user-a',
  email: 'hr-rpt-a@example.com',
  name: 'HR Report Manager A',
  role: 'HR_MANAGER',
  branchId: BRANCH_A,
  allowedBranchIds: [BRANCH_A],
  canSwitchUser: false,
} as any;

const MANAGER_B = {
  id: 'hr-rpt-user-b',
  email: 'hr-rpt-b@example.com',
  name: 'HR Report Manager B',
  role: 'HR_MANAGER',
  branchId: BRANCH_B,
  allowedBranchIds: [BRANCH_B],
  canSwitchUser: false,
} as any;

// A two-branch account keeps the aggregate deterministic while still proving
// that a session-scoped report sees more than one permitted branch. A global
// SUPER_ADMIN would count every other test's employees in a shared database.
const MULTI = {
  id: 'hr-rpt-user-multi',
  email: 'hr-rpt-multi@example.com',
  name: 'HR Report Multi-Branch Manager',
  role: 'HR_MANAGER',
  branchId: BRANCH_A,
  allowedBranchIds: [BRANCH_A, BRANCH_B],
  canSwitchUser: false,
} as any;

const FRONT_DESK = {
  id: 'hr-rpt-user-front',
  email: 'hr-rpt-front@example.com',
  name: 'HR Report Front Desk',
  role: 'FRONT_DESK',
  branchId: BRANCH_A,
  allowedBranchIds: [BRANCH_A],
  canSwitchUser: false,
} as any;

const REPORT_YEAR = new Date().getUTCFullYear();
const EMPLOYEES = [
  ['hr-rpt-emp-a1', 'RPT-A1', 'Report Alice', BRANCH_A, 'Operations', true, '2020-01-01', null],
  ['hr-rpt-emp-a2', 'RPT-A2', 'Report Bob', BRANCH_A, 'Operations', true, '2020-01-01', null],
  ['hr-rpt-emp-a3', 'RPT-A3', 'Report Cara', BRANCH_A, 'Sales', true, '2020-01-01', null],
  ['hr-rpt-emp-a4', 'RPT-A4', 'Report Dana Inactive', BRANCH_A, 'Sales', false, '2020-01-01', `${REPORT_YEAR}-02-14`],
  ['hr-rpt-emp-b1', 'RPT-B1', 'Report Dan', BRANCH_B, 'Operations', true, '2020-01-01', null],
  ['hr-rpt-emp-b2', 'RPT-B2', 'Report Eve', BRANCH_B, null, true, '2020-01-01', null],
  ['hr-rpt-emp-b3', 'RPT-B3', 'Report Fay', BRANCH_B, 'Support', true, '2020-01-01', null],
  ['hr-rpt-emp-b4', 'RPT-B4', 'Report Gus Inactive', BRANCH_B, 'Support', false, '2020-01-01', `${REPORT_YEAR}-08-09`],
] as const;

// Posted/paid runs only. The DRAFT run and its line are deliberately present
// so the report can prove it excludes uncommitted payroll rather than simply
// finding no drafts in the fixture.
const PAYROLL_RUNS = [
  ['hr-rpt-payrun-a-2026-09', 'RPT-PAY-A-2026-09', BRANCH_A, '2026-09', '2026-09-30', '2083-06-14', 'POSTED'],
  ['hr-rpt-payrun-b-2026-09', 'RPT-PAY-B-2026-09', BRANCH_B, '2026-09', '2026-09-30', '2083-06-14', 'PAID'],
  ['hr-rpt-payrun-a-2026-10', 'RPT-PAY-A-2026-10', BRANCH_A, '2026-10', '2026-10-31', '2083-07-15', 'POSTED'],
  ['hr-rpt-payrun-a-2026-11', 'RPT-PAY-A-2026-11', BRANCH_A, '2026-11', '2026-11-30', '2083-08-15', 'DRAFT'],
] as const;

const PAYROLL_LINES = [
  // A1: basic 1,000 + allowances 200 + overtime 200 + incentive 50 + arrears 10.
  ['hr-rpt-payline-a1-2026-09', 'hr-rpt-payrun-a-2026-09', 'hr-rpt-emp-a1', 'RPT-A1', 'Report Alice', '2026-09', 1000, 0, 0, 2, 200, 50, 10, 1460, 100, 110, 200, 0, 0, 1250],
  // A2: basic 800 + allowances 100, TDS only (not SSF-eligible), no overtime.
  ['hr-rpt-payline-a2-2026-09', 'hr-rpt-payrun-a-2026-09', 'hr-rpt-emp-a2', 'RPT-A2', 'Report Bob', '2026-09', 800, 0, 0, 0, 0, 0, 0, 900, 90, 0, 0, 0, 0, 810],
  // B1: basic 800 + allowances 100 + overtime 120.
  ['hr-rpt-payline-b1-2026-09', 'hr-rpt-payrun-b-2026-09', 'hr-rpt-emp-b1', 'RPT-B1', 'Report Dan', '2026-09', 800, 0, 0, 1, 120, 0, 0, 1020, 50, 99, 180, 0, 0, 871],
  // A3: basic only, proving zero-allowance and zero-overtime rows remain honest.
  ['hr-rpt-payline-a3-2026-10', 'hr-rpt-payrun-a-2026-10', 'hr-rpt-emp-a3', 'RPT-A3', 'Report Cara', '2026-10', 700, 0, 0, 0, 0, 0, 0, 700, 70, 77, 140, 0, 0, 553],
  // Uncommitted run: must never contribute to any report.
  ['hr-rpt-payline-a1-2026-11', 'hr-rpt-payrun-a-2026-11', 'hr-rpt-emp-a1', 'RPT-A1', 'Report Alice', '2026-11', 99999, 0, 0, 100, 10000, 0, 0, 109999, 0, 0, 0, 0, 0, 109999],
] as const;

const REQUESTS = [
  // a1 annual: 3 approved this year, 2 approved last year (excluded by year).
  ['hr-rpt-req-a1-now', 'RPT-REQ-A1-NOW', 'hr-rpt-emp-a1', BRANCH_A, 'hr-rpt-lt-annual', 3, 'APPROVED', 0],
  ['hr-rpt-req-a1-old', 'RPT-REQ-A1-OLD', 'hr-rpt-emp-a1', BRANCH_A, 'hr-rpt-lt-annual', 2, 'APPROVED', -1],
  // a2 annual: 4 approved, plus pending/rejected rows that must not consume days.
  ['hr-rpt-req-a2-now', 'RPT-REQ-A2-NOW', 'hr-rpt-emp-a2', BRANCH_A, 'hr-rpt-lt-annual', 4, 'APPROVED', 0],
  ['hr-rpt-req-a2-pending', 'RPT-REQ-A2-PENDING', 'hr-rpt-emp-a2', BRANCH_A, 'hr-rpt-lt-annual', 100, 'PENDING', 0],
  // b1 annual: rejected request must not consume days.
  ['hr-rpt-req-b1-rejected', 'RPT-REQ-B1-REJECTED', 'hr-rpt-emp-b1', BRANCH_B, 'hr-rpt-lt-annual', 10, 'REJECTED', 0],
  // b3 sick: 2 approved.
  ['hr-rpt-req-b3-sick', 'RPT-REQ-B3-SICK', 'hr-rpt-emp-b3', BRANCH_B, 'hr-rpt-lt-sick', 2, 'APPROVED', 0],
] as const;

describe('HR workforce reports (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const adminToken = issueAuthToken(ADMIN);
  const managerAToken = issueAuthToken(MANAGER_A);
  const managerBToken = issueAuthToken(MANAGER_B);
  const multiToken = issueAuthToken(MULTI);
  const frontDeskToken = issueAuthToken(FRONT_DESK);
  let balanceYear = 0;
  let yearStart = '';

  async function request(
    method: 'GET' | 'POST',
    path: string,
    auth: string | null = adminToken
  ) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: auth === null ? {} : { authorization: 'Bearer ' + auth },
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON error bodies are still asserted by status */
    }
    return { status: res.status, json, headers: res.headers };
  }

  const get = (path: string, auth: string | null = adminToken) =>
    request('GET', path, auth);

  async function fixtureCounts() {
    const { rows } = await pool!.query(
      `SELECT
         (SELECT COUNT(*)::int FROM hr_leave_requests WHERE id LIKE 'hr-rpt-%') AS requests,
         (SELECT COUNT(*)::int FROM hr_leave_balances WHERE id LIKE 'hr-rpt-%') AS balances,
         (SELECT COUNT(*)::int FROM hr_leave_types WHERE id LIKE 'hr-rpt-%') AS leave_types,
         (SELECT COUNT(*)::int FROM payroll_run_lines WHERE id LIKE 'hr-rpt-%') AS payroll_lines,
         (SELECT COUNT(*)::int FROM payroll_runs WHERE id LIKE 'hr-rpt-%') AS payroll_runs,
         (SELECT COUNT(*)::int FROM employees WHERE id LIKE 'hr-rpt-emp-%') AS employees,
         (SELECT COUNT(*)::int FROM users WHERE id LIKE 'hr-rpt-user-%') AS users,
         (SELECT COUNT(*)::int FROM branches WHERE id LIKE 'hr-rpt-br-%') AS branches`
    );
    return rows[0];
  }

  async function cleanup() {
    await pool!.query("DELETE FROM payroll_run_lines WHERE id LIKE 'hr-rpt-%'");
    await pool!.query("DELETE FROM payroll_runs WHERE id LIKE 'hr-rpt-%'");
    await pool!.query("DELETE FROM hr_leave_requests WHERE id LIKE 'hr-rpt-%'");
    await pool!.query("DELETE FROM hr_leave_balances WHERE id LIKE 'hr-rpt-%'");
    await pool!.query("DELETE FROM hr_leave_types WHERE id LIKE 'hr-rpt-%'");
    await pool!.query("DELETE FROM employees WHERE id LIKE 'hr-rpt-emp-%'");
    await pool!.query("DELETE FROM users WHERE id LIKE 'hr-rpt-user-%'");
    await pool!.query("DELETE FROM branches WHERE id LIKE 'hr-rpt-br-%'");
  }

  before(async () => {
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'RPTA', 'Report Branch A', 'Test'),
              ($2, 'RPTB', 'Report Branch B', 'Test')`,
      [BRANCH_A, BRANCH_B]
    );
    for (const user of [MANAGER_A, MANAGER_B, MULTI, FRONT_DESK]) {
      await pool!.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
         VALUES ($1, $2, 'test-not-a-real-hash', $3, $4, $5, ARRAY[$6]::text[], 'active')`,
        [user.id, user.email, user.name, user.role, user.branchId, user.branchId]
      );
    }

    for (const [
      id,
      code,
      name,
      branchId,
      department,
      active,
      joiningDateAD,
      separationDateAD,
    ] of EMPLOYEES) {
      await pool!.query(
        `INSERT INTO employees (
           id, employee_code, name, branch_id, department, is_active,
           joining_date_ad, separation_date_ad
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, code, name, branchId, department, active, joiningDateAD, separationDateAD]
      );
    }

    for (const [id, runNo, branchId, periodKey, runDateAD, runDateBS, status] of PAYROLL_RUNS) {
      await pool!.query(
        `INSERT INTO payroll_runs (
           id, run_no, branch_id, period_key, run_date_ad, run_date_bs, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, runNo, branchId, periodKey, runDateAD, runDateBS, status]
      );
    }
    for (const [
      id,
      runId,
      employeeId,
      employeeCode,
      employeeName,
      periodKey,
      basicAmount,
      lopDeduction,
      payableDays,
      overtimeHours,
      overtimeAmount,
      incentive,
      arrears,
      gross,
      tds,
      ssf,
      employerSsf,
      advance,
      loan,
      net,
    ] of PAYROLL_LINES) {
      await pool!.query(
        `INSERT INTO payroll_run_lines (
           id, run_id, employee_id, employee_code, employee_name, period_key,
           basic_amount, payable_days, lop_days, lop_deduction, overtime_hours,
           overtime_amount, incentive_amount, arrears_amount, gross_amount,
           tds_amount, ssf_amount, employer_ssf_amount, advance_deduction,
           loan_deduction, net_amount
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19, $20)`,
        [
          id,
          runId,
          employeeId,
          employeeCode,
          employeeName,
          periodKey,
          basicAmount,
          payableDays,
          lopDeduction,
          overtimeHours,
          overtimeAmount,
          incentive,
          arrears,
          gross,
          tds,
          ssf,
          employerSsf,
          advance,
          loan,
          net,
        ]
      );
    }

    await pool!.query(
      `INSERT INTO hr_leave_types (id, code, name, annual_quota_days, is_paid, is_active)
       VALUES ('hr-rpt-lt-annual', 'RPT-ANNUAL', 'Report Annual', 20, TRUE, TRUE),
              ('hr-rpt-lt-sick', 'RPT-SICK', 'Report Sick', 10, FALSE, TRUE)`
    );

    const { rows } = await pool!.query(
      `SELECT EXTRACT(YEAR FROM CURRENT_DATE)::int AS "year"`
    );
    balanceYear = Number(rows[0].year);
    yearStart = `${balanceYear}-01-01`;

    const balances = [
      ['hr-rpt-bal-a1-annual', 'hr-rpt-emp-a1', BRANCH_A, 'hr-rpt-lt-annual', 20, 2],
      ['hr-rpt-bal-a2-annual', 'hr-rpt-emp-a2', BRANCH_A, 'hr-rpt-lt-annual', 10, 0],
      ['hr-rpt-bal-b1-annual', 'hr-rpt-emp-b1', BRANCH_B, 'hr-rpt-lt-annual', 15, 0],
      ['hr-rpt-bal-a2-sick', 'hr-rpt-emp-a2', BRANCH_A, 'hr-rpt-lt-sick', 5, -1],
      ['hr-rpt-bal-b3-sick', 'hr-rpt-emp-b3', BRANCH_B, 'hr-rpt-lt-sick', 8, 0],
      // Must be excluded: prior year, inactive employee.
      ['hr-rpt-bal-a1-old', 'hr-rpt-emp-a1', BRANCH_A, 'hr-rpt-lt-annual', 99, 0],
      ['hr-rpt-bal-a4-inactive', 'hr-rpt-emp-a4', BRANCH_A, 'hr-rpt-lt-annual', 30, 0],
      ['hr-rpt-bal-b4-inactive', 'hr-rpt-emp-b4', BRANCH_B, 'hr-rpt-lt-sick', 99, 0],
    ] as const;
    for (const [id, employeeId, branchId, leaveTypeId, entitlement, adjustment] of balances) {
      const year = id.endsWith('-old') ? balanceYear - 1 : balanceYear;
      await pool!.query(
        `INSERT INTO hr_leave_balances (
           id, employee_id, branch_id, leave_type_id, balance_year,
           entitlement_days, adjustment_days
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, employeeId, branchId, leaveTypeId, year, entitlement, adjustment]
      );
    }

    let index = 0;
    for (const [id, requestNo, employeeId, branchId, leaveTypeId, days, status, yearOffset] of REQUESTS) {
      const year = balanceYear + yearOffset;
      const start = `${year}-03-${String(10 + index).padStart(2, '0')}`;
      const end = `${year}-03-${String(10 + index).padStart(2, '0')}`;
      await pool!.query(
        `INSERT INTO hr_leave_requests (
           id, request_no, employee_id, branch_id, leave_type_id,
           start_date_ad, end_date_ad, days_count, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, requestNo, employeeId, branchId, leaveTypeId, start, end, days, status]
      );
      index += 1;
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

  test('multi-branch scope aggregates active headcount and current-year leave without fabrication', async () => {
    const beforeCounts = await fixtureCounts();
    const response = await get(
      `/api/hr/reports/workforce?dateFrom=${yearStart}&dateTo=${balanceYear}-12-31`,
      multiToken
    );
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Object.keys(response.json).sort(), [
      'asOf',
      'attrition',
      'headcount',
      'leaveLiability',
      'period',
      'scope',
    ]);
    assert.deepEqual(response.json.period, {
      fromAD: yearStart,
      toAD: `${balanceYear}-12-31`,
    });
    assert.equal(response.json.scope.branchId, null, 'a multi-branch reader has no single branch scope');
    assert.equal(response.json.headcount.total, 6, 'four inactive employees stay out');
    assert.deepEqual(
      response.json.headcount.byBranch,
      [
        { branchId: BRANCH_A, branchName: 'Report Branch A', count: 3 },
        { branchId: BRANCH_B, branchName: 'Report Branch B', count: 3 },
      ]
    );
    assert.deepEqual(
      Object.fromEntries(
        response.json.headcount.byDepartment.map((row: any) => [row.department, row.count])
      ),
      { Operations: 3, Sales: 1, Support: 1, Unassigned: 1 }
    );

    assert.equal(response.json.attrition.available, true);
    assert.equal(response.json.attrition.separations, 2);
    assert.equal(response.json.attrition.ratePercent, 25);
    assert.equal(response.json.attrition.rateBasis, 'PERIOD_START_HEADCOUNT');
    assert.equal(response.json.attrition.headcountAtStart, 8);
    assert.equal(response.json.attrition.unknownJoiningCount, 0);
    assert.equal(response.json.attrition.reason, null);
    assert.deepEqual(response.json.attrition.byBranch, [
      {
        branchId: BRANCH_A,
        branchName: 'Report Branch A',
        separations: 1,
        headcountAtStart: 4,
        unknownJoiningCount: 0,
        ratePercent: 25,
      },
      {
        branchId: BRANCH_B,
        branchName: 'Report Branch B',
        separations: 1,
        headcountAtStart: 4,
        unknownJoiningCount: 0,
        ratePercent: 25,
      },
    ]);

    assert.equal(response.json.leaveLiability.balanceYear, balanceYear);
    assert.equal(response.json.leaveLiability.totalEntitlementDays, 58);
    assert.equal(response.json.leaveLiability.totalAdjustmentDays, 1);
    assert.equal(response.json.leaveLiability.totalUsedDays, 9);
    assert.equal(response.json.leaveLiability.totalRemainingDays, 50);
    assert.deepEqual(
      response.json.leaveLiability.byLeaveType.map((row: any) => ({
        code: row.leaveTypeCode,
        paid: row.leaveTypePaid,
        employees: row.employeeCount,
        entitled: row.entitlementDays,
        adjusted: row.adjustmentDays,
        used: row.usedDays,
        remaining: row.remainingDays,
      })),
      [
        {
          code: 'RPT-ANNUAL',
          paid: true,
          employees: 3,
          entitled: 45,
          adjusted: 2,
          used: 7,
          remaining: 40,
        },
        {
          code: 'RPT-SICK',
          paid: false,
          employees: 2,
          entitled: 13,
          adjusted: -1,
          used: 2,
          remaining: 10,
        },
      ]
    );

    assert.deepEqual(await fixtureCounts(), beforeCounts, 'the report must not mutate its source tables');
  });

  test('a branch manager sees only their branch, including a redundant own-branch filter', async () => {
    const defaultScope = await get('/api/hr/reports/workforce', managerAToken);
    assert.equal(defaultScope.status, 200, JSON.stringify(defaultScope.json));
    assert.equal(defaultScope.json.scope.branchId, BRANCH_A);
    assert.equal(defaultScope.json.headcount.total, 3);
    assert.deepEqual(defaultScope.json.headcount.byBranch, [
      { branchId: BRANCH_A, branchName: 'Report Branch A', count: 3 },
    ]);
    assert.deepEqual(defaultScope.json.headcount.byDepartment, [
      { department: 'Operations', count: 2 },
      { department: 'Sales', count: 1 },
    ]);
    assert.equal(defaultScope.json.attrition.separations, 1);
    assert.equal(defaultScope.json.attrition.headcountAtStart, 4);
    assert.equal(defaultScope.json.attrition.ratePercent, 25);
    assert.equal(defaultScope.json.leaveLiability.totalEntitlementDays, 35);
    assert.equal(defaultScope.json.leaveLiability.totalAdjustmentDays, 1);
    assert.equal(defaultScope.json.leaveLiability.totalUsedDays, 7);
    assert.equal(defaultScope.json.leaveLiability.totalRemainingDays, 29);

    const ownBranch = await get(
      `/api/hr/reports/workforce?branchId=${BRANCH_A}`,
      managerAToken
    );
    assert.equal(ownBranch.status, 200, JSON.stringify(ownBranch.json));
    assert.deepEqual(ownBranch.json.headcount, defaultScope.json.headcount);

    const branchB = await get(
      `/api/hr/reports/workforce?branchId=${BRANCH_B}`,
      managerBToken
    );
    assert.equal(branchB.status, 200, JSON.stringify(branchB.json));
    assert.equal(branchB.json.scope.branchId, BRANCH_B);
    assert.equal(branchB.json.headcount.total, 3);
    assert.equal(branchB.json.attrition.separations, 1);
    assert.equal(branchB.json.attrition.headcountAtStart, 4);
    assert.equal(branchB.json.attrition.ratePercent, 25);
    assert.equal(branchB.json.leaveLiability.totalRemainingDays, 21);
  });

  test('attrition counts stored separation dates and refuses to invent a rate without a baseline', async () => {
    const boundary = await get(
      `/api/hr/reports/workforce?dateFrom=${REPORT_YEAR}-02-14&dateTo=${REPORT_YEAR}-02-14`,
      managerAToken
    );
    assert.equal(boundary.status, 200, JSON.stringify(boundary.json));
    assert.equal(boundary.json.attrition.separations, 1, 'the period ends are inclusive');
    assert.equal(boundary.json.attrition.headcountAtStart, 4);
    assert.equal(boundary.json.attrition.ratePercent, 25);

    const dayAfter = await get(
      `/api/hr/reports/workforce?dateFrom=${REPORT_YEAR}-02-15&dateTo=${REPORT_YEAR}-12-31`,
      managerAToken
    );
    assert.equal(dayAfter.status, 200, JSON.stringify(dayAfter.json));
    assert.equal(dayAfter.json.attrition.separations, 0);
    assert.equal(dayAfter.json.attrition.ratePercent, 0);
    assert.equal(dayAfter.json.attrition.reason, null);

    await pool!.query("UPDATE employees SET joining_date_ad = NULL WHERE id = 'hr-rpt-emp-a1'");
    try {
      const incomplete = await get(
        `/api/hr/reports/workforce?dateFrom=${yearStart}&dateTo=${balanceYear}-12-31`,
        managerAToken
      );
      assert.equal(incomplete.status, 200, JSON.stringify(incomplete.json));
      assert.equal(incomplete.json.attrition.separations, 1);
      assert.equal(incomplete.json.attrition.headcountAtStart, 3);
      assert.equal(incomplete.json.attrition.unknownJoiningCount, 1);
      assert.equal(incomplete.json.attrition.ratePercent, null);
      assert.match(
        incomplete.json.attrition.reason,
        /1 employee in scope has no joining date.*period-start headcount is incomplete/i
      );
    } finally {
      await pool!.query(
        "UPDATE employees SET joining_date_ad = '2020-01-01' WHERE id = 'hr-rpt-emp-a1'"
      );
    }

    const beforeAnyJoining = await get(
      '/api/hr/reports/workforce?dateFrom=2019-01-01&dateTo=2019-12-31',
      managerAToken
    );
    assert.equal(beforeAnyJoining.status, 200, JSON.stringify(beforeAnyJoining.json));
    assert.equal(beforeAnyJoining.json.attrition.separations, 0);
    assert.equal(beforeAnyJoining.json.attrition.headcountAtStart, 0);
    assert.equal(beforeAnyJoining.json.attrition.ratePercent, null);
    assert.match(
      beforeAnyJoining.json.attrition.reason,
      /No employees with a recorded joining date were employed at the start of the period/i
    );
  });

  test('cross-branch, ALL, repeated and unknown selectors are refused', async () => {
    const refused = [
      `/api/hr/reports/workforce?branchId=ALL`,
      `/api/hr/reports/workforce?branchId=${BRANCH_B}`,
      `/api/hr/reports/workforce?branchId=${BRANCH_A}&branchId=${BRANCH_B}`,
      `/api/hr/reports/workforce?branch_id=${BRANCH_B}`,
      `/api/hr/reports/workforce?employeeId=hr-rpt-emp-b1`,
      `/api/hr/reports/workforce?employee_id=hr-rpt-emp-b1`,
      `/api/hr/reports/workforce?userId=hr-rpt-user-b`,
      `/api/hr/reports/workforce?tenantId=hr-rpt-br-b`,
      `/api/hr/reports/workforce?documentId=hr-rpt-doc`,
      `/api/hr/reports/workforce?page=1`,
      `/api/hr/reports/workforce?dateFrom=2026-01-01&dateTo=2026-12-31&unknown=1`,
    ];
    for (const path of refused) {
      const response = await get(path, managerAToken);
      assert.equal(response.status, 403, `${path} must be refused`);
    }

    const adminAll = await get('/api/hr/reports/workforce?branchId=ALL', adminToken);
    assert.equal(adminAll.status, 403, 'even a global reader cannot request the ALL pseudo-branch');

    const unauthenticated = await get('/api/hr/reports/workforce', null);
    assert.equal(unauthenticated.status, 401);

    const denied = await get('/api/hr/reports/workforce', frontDeskToken);
    assert.equal(denied.status, 403, 'a role without the HR read grant must be refused');
  });

  test('invalid dates are 400 and there is no write route', async () => {
    const badDates = [
      '/api/hr/reports/workforce?dateFrom=not-a-date',
      '/api/hr/reports/workforce?dateTo=2026-02-31',
      `/api/hr/reports/workforce?dateFrom=${balanceYear}-12-31&dateTo=${balanceYear}-01-01`,
    ];
    for (const path of badDates) {
      const response = await get(path, managerAToken);
      assert.equal(response.status, 400, `${path} must be rejected as invalid dates`);
    }
    const write = await request('POST', '/api/hr/reports/workforce', managerAToken);
    assert.equal(write.status, 404, 'the workforce report is read-only');
  });

  test('payroll report returns stored cost, overtime and statutory figures and excludes drafts', async () => {
    const beforeCounts = await fixtureCounts();
    const response = await get(
      '/api/hr/reports/payroll?dateFrom=2026-09-01&dateTo=2026-10-31',
      multiToken
    );
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Object.keys(response.json).sort(), [
      'asOf',
      'basis',
      'overtime',
      'payrollCost',
      'period',
      'scope',
      'ssf',
      'statutory',
    ]);
    assert.deepEqual(response.json.period, {
      fromAD: '2026-09-01',
      toAD: '2026-10-31',
    });
    assert.equal(response.json.scope.branchId, null);
    assert.deepEqual(response.json.basis, {
      source: 'payroll_run_lines',
      runStatuses: ['POSTED', 'PAID'],
    });

    assert.equal(response.json.payrollCost.available, true);
    assert.deepEqual(response.json.payrollCost.totals, {
      runCount: 3,
      lineCount: 4,
      gross: 4080,
      employerSsf: 520,
      totalCost: 4600,
      basic: 3300,
      allowances: 400,
      overtime: 320,
      incentive: 50,
      arrears: 10,
      lopDeduction: 0,
      deductions: 596,
      net: 3484,
    });
    // Employer cost is gross wages plus the employer SSF share — the same total
    // the payroll journal debits to salary expense.
    assert.equal(
      response.json.payrollCost.totals.totalCost,
      response.json.payrollCost.totals.gross + response.json.payrollCost.totals.employerSsf
    );
    assert.deepEqual(response.json.payrollCost.byBranch, [
      {
        branchId: BRANCH_A,
        branchName: 'Report Branch A',
        runCount: 2,
        lineCount: 3,
        gross: 3060,
        employerSsf: 340,
        totalCost: 3400,
        basic: 2500,
        allowances: 300,
        overtime: 200,
        incentive: 50,
        arrears: 10,
        lopDeduction: 0,
        deductions: 447,
        net: 2613,
      },
      {
        branchId: BRANCH_B,
        branchName: 'Report Branch B',
        runCount: 1,
        lineCount: 1,
        gross: 1020,
        employerSsf: 180,
        totalCost: 1200,
        basic: 800,
        allowances: 100,
        overtime: 120,
        incentive: 0,
        arrears: 0,
        lopDeduction: 0,
        deductions: 149,
        net: 871,
      },
    ]);
    assert.deepEqual(response.json.payrollCost.byPeriod, [
      {
        periodKey: '2026-09',
        runCount: 2,
        lineCount: 3,
        gross: 3380,
        employerSsf: 380,
        totalCost: 3760,
        basic: 2600,
        allowances: 400,
        overtime: 320,
        incentive: 50,
        arrears: 10,
        lopDeduction: 0,
        deductions: 449,
        net: 2931,
      },
      {
        periodKey: '2026-10',
        runCount: 1,
        lineCount: 1,
        gross: 700,
        employerSsf: 140,
        totalCost: 840,
        basic: 700,
        allowances: 0,
        overtime: 0,
        incentive: 0,
        arrears: 0,
        lopDeduction: 0,
        deductions: 147,
        net: 553,
      },
    ]);

    assert.equal(response.json.overtime.available, true);
    assert.deepEqual(response.json.overtime.totals, {
      employeeCount: 2,
      overtimeHours: 3,
      overtimeAmount: 320,
    });
    assert.deepEqual(response.json.overtime.byBranch, [
      {
        branchId: BRANCH_A,
        branchName: 'Report Branch A',
        employeeCount: 1,
        overtimeHours: 2,
        overtimeAmount: 200,
      },
      {
        branchId: BRANCH_B,
        branchName: 'Report Branch B',
        employeeCount: 1,
        overtimeHours: 1,
        overtimeAmount: 120,
      },
    ]);
    assert.deepEqual(response.json.overtime.byDepartment, [
      {
        department: 'Operations',
        employeeCount: 2,
        overtimeHours: 3,
        overtimeAmount: 320,
      },
    ]);
    assert.deepEqual(
      response.json.overtime.byEmployee.map((row: any) => ({
        code: row.employeeCode,
        branch: row.branchId,
        department: row.department,
        hours: row.overtimeHours,
        amount: row.overtimeAmount,
      })),
      [
        { code: 'RPT-A1', branch: BRANCH_A, department: 'Operations', hours: 2, amount: 200 },
        { code: 'RPT-B1', branch: BRANCH_B, department: 'Operations', hours: 1, amount: 120 },
      ]
    );

    assert.equal(response.json.statutory.available, true);
    assert.deepEqual(response.json.statutory.totals, {
      payslipCount: 4,
      employeeSsf: 286,
      employerSsf: 520,
      totalSsf: 806,
      tds: 310,
    });
    assert.deepEqual(response.json.statutory.byPeriod, [
      {
        periodKey: '2026-09',
        payslipCount: 3,
        employeeSsf: 209,
        employerSsf: 380,
        totalSsf: 589,
        tds: 240,
      },
      {
        periodKey: '2026-10',
        payslipCount: 1,
        employeeSsf: 77,
        employerSsf: 140,
        totalSsf: 217,
        tds: 70,
      },
    ]);
    assert.equal(
      JSON.stringify(response.json).includes('109999'),
      false,
      'the DRAFT run line must not leak into any filing aggregate'
    );
    assert.deepEqual(await fixtureCounts(), beforeCounts, 'the report must not mutate its source tables');
  });

  test('payroll report respects branch scope for every family', async () => {
    const a = await get(
      '/api/hr/reports/payroll?dateFrom=2026-09-01&dateTo=2026-10-31',
      managerAToken
    );
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(a.json.scope.branchId, BRANCH_A);
    assert.equal(a.json.payrollCost.totals.gross, 3060);
    assert.equal(a.json.payrollCost.totals.runCount, 2);

    // Branch A's posted lines withheld 110 + 77 employee SSF and 200 + 140
    // employer SSF; none of those runs carries a statutory config, and the
    // fixture posts no journal, so the tie-out must say so rather than pass.
    assert.equal(a.json.ssf.employeeSsf, 187);
    assert.equal(a.json.ssf.employerSsf, 340);
    assert.equal(a.json.ssf.payable, 527);
    assert.equal(a.json.ssf.configured, 0);
    assert.equal(a.json.ssf.unconfiguredLines, 2);
    assert.equal(a.json.ssf.rateMismatchLines, 0);
    assert.equal(a.json.ssf.matches, false);
    assert.ok(
      a.json.ssf.controlBalance === null || a.json.ssf.controlBalance === 0,
      'the fixture posts no SSF journal in this branch'
    );

    // The branch gap must be traceable to the two contributing employees.
    assert.equal(a.json.ssf.byEmployee.length, 2);
    const ssfAlice = a.json.ssf.byEmployee.find((row: any) => row.employeeCode === 'RPT-A1');
    const ssfCara = a.json.ssf.byEmployee.find((row: any) => row.employeeCode === 'RPT-A3');
    assert.equal(ssfAlice.employeeSsf, 110);
    assert.equal(ssfAlice.employerSsf, 200);
    assert.equal(ssfAlice.payable, 310);
    assert.equal(ssfAlice.difference, -310);
    assert.equal(ssfAlice.matches, false);
    assert.equal(ssfCara.payable, 217);
    assert.equal(ssfCara.difference, -217);
    assert.equal(
      a.json.ssf.byEmployee.reduce((sum: number, row: any) => sum + row.payable, 0),
      a.json.ssf.payable,
      'the employee rows must add up to the branch payable'
    );
    assert.deepEqual(
      a.json.payrollCost.byBranch.map((row: any) => row.branchId),
      [BRANCH_A]
    );
    assert.deepEqual(a.json.overtime.totals, {
      employeeCount: 1,
      overtimeHours: 2,
      overtimeAmount: 200,
    });
    assert.deepEqual(a.json.statutory.totals, {
      payslipCount: 3,
      employeeSsf: 187,
      employerSsf: 340,
      totalSsf: 527,
      tds: 260,
    });

    const ownBranch = await get(
      `/api/hr/reports/payroll?branchId=${BRANCH_A}&dateFrom=2026-09-01&dateTo=2026-10-31`,
      managerAToken
    );
    assert.equal(ownBranch.status, 200, JSON.stringify(ownBranch.json));
    assert.deepEqual(ownBranch.json.payrollCost, a.json.payrollCost);

    const b = await get(
      '/api/hr/reports/payroll?dateFrom=2026-09-01&dateTo=2026-10-31',
      managerBToken
    );
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(b.json.scope.branchId, BRANCH_B);
    assert.equal(b.json.payrollCost.totals.gross, 1020);
    assert.equal(b.json.statutory.totals.employeeSsf, 99);
    assert.equal(b.json.statutory.totals.employerSsf, 180);
    assert.equal(b.json.statutory.totals.tds, 50);
  });

  test('payroll report refuses cross-branch, ALL, repeated, unknown and malformed filters', async () => {
    const refused = [
      '/api/hr/reports/payroll?branchId=ALL',
      `/api/hr/reports/payroll?branchId=${BRANCH_B}`,
      `/api/hr/reports/payroll?branchId=${BRANCH_A}&branchId=${BRANCH_B}`,
      `/api/hr/reports/payroll?branch_id=${BRANCH_B}`,
      `/api/hr/reports/payroll?employeeId=hr-rpt-emp-b1`,
      `/api/hr/reports/payroll?employee_id=hr-rpt-emp-b1`,
      `/api/hr/reports/payroll?userId=hr-rpt-user-b`,
      `/api/hr/reports/payroll?tenantId=hr-rpt-br-b`,
      `/api/hr/reports/payroll?documentId=hr-rpt-doc`,
      `/api/hr/reports/payroll?page=1`,
    ];
    for (const path of refused) {
      const response = await get(path, managerAToken);
      assert.equal(response.status, 403, `${path} must be refused`);
    }

    const adminAll = await get('/api/hr/reports/payroll?branchId=ALL', adminToken);
    assert.equal(adminAll.status, 403, 'even a global reader cannot request the ALL pseudo-branch');

    for (const path of [
      '/api/hr/reports/payroll?dateFrom=not-a-date',
      '/api/hr/reports/payroll?dateTo=2026-02-31',
      '/api/hr/reports/payroll?dateFrom=2026-12-31&dateTo=2026-01-01',
    ]) {
      const response = await get(path, managerAToken);
      assert.equal(response.status, 400, `${path} must be rejected as invalid dates`);
    }

    const unauthenticated = await get('/api/hr/reports/payroll', null);
    assert.equal(unauthenticated.status, 401);
    const denied = await get('/api/hr/reports/payroll', frontDeskToken);
    assert.equal(denied.status, 403, 'a role without the HR read grant must be refused');
    const write = await request('POST', '/api/hr/reports/payroll', managerAToken);
    assert.equal(write.status, 404, 'the payroll report is read-only');
  });
});
