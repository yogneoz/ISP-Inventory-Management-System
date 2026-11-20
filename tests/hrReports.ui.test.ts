/**
 * People & HR → HR Reports UI.
 *
 * The real-App route proves the lazy screen reads both the workforce and
 * payroll/statutory aggregates, renders every report family and refetches both
 * when the period changes or Refresh is pressed. Direct mounts cover the empty
 * states and the no-permission refusal without a read. Static checks keep the
 * route/nav/preload wiring and the payroll sections pinned.
 */
import { test } from 'node:test';
import { readScreenRoutes } from './harness/screenRouteSource';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { HrReports } from '../client/src/features/hr/HrReports';
import type { HrPayrollReport, HrWorkforceReport } from '../client/src/services/api/hr';
import { applyEffectivePermissions } from '../client/src/utils/permissions';
import { clearRecentBootstrapCache } from '../client/src/utils/sessionCache';
import { inAct, mountTree } from './harness/mount';
import {
  bootstrapFixture,
  installApiStubs,
  installEventSource,
  mountAppRouteTree,
  seedSession,
  settleUntil,
  smokeUser,
} from './harness/appRouteTreeProbe';

const report: HrWorkforceReport = {
  period: { fromAD: '2026-01-01', toAD: '2026-11-09' },
  asOf: '2026-11-09',
  scope: { branchId: null },
  headcount: {
    total: 6,
    byBranch: [
      { branchId: 'hr-rpt-br-a', branchName: 'Report Branch A', count: 3 },
      { branchId: 'hr-rpt-br-b', branchName: 'Report Branch B', count: 3 },
    ],
    byDepartment: [
      { department: 'Operations', count: 3 },
      { department: 'Sales', count: 1 },
      { department: 'Support', count: 1 },
      { department: 'Unassigned', count: 1 },
    ],
  },
  attrition: {
    available: true,
    separations: 2,
    ratePercent: 25,
    rateBasis: 'PERIOD_START_HEADCOUNT',
    headcountAtStart: 8,
    unknownJoiningCount: 0,
    reason: null,
    byBranch: [
      {
        branchId: 'hr-rpt-br-a',
        branchName: 'Report Branch A',
        separations: 1,
        headcountAtStart: 4,
        unknownJoiningCount: 0,
        ratePercent: 25,
      },
      {
        branchId: 'hr-rpt-br-b',
        branchName: 'Report Branch B',
        separations: 1,
        headcountAtStart: 4,
        unknownJoiningCount: 0,
        ratePercent: 25,
      },
    ],
  },
  leaveLiability: {
    balanceYear: 2026,
    totalEntitlementDays: 58,
    totalAdjustmentDays: 1,
    totalUsedDays: 9,
    totalRemainingDays: 50,
    byLeaveType: [
      {
        leaveTypeId: 'hr-rpt-lt-annual',
        leaveTypeCode: 'RPT-ANNUAL',
        leaveTypeName: 'Report Annual',
        leaveTypePaid: true,
        employeeCount: 3,
        entitlementDays: 45,
        adjustmentDays: 2,
        usedDays: 7,
        remainingDays: 40,
      },
      {
        leaveTypeId: 'hr-rpt-lt-sick',
        leaveTypeCode: 'RPT-SICK',
        leaveTypeName: 'Report Sick',
        leaveTypePaid: false,
        employeeCount: 2,
        entitlementDays: 13,
        adjustmentDays: -1,
        usedDays: 2,
        remainingDays: 10,
      },
    ],
  },
};

const payrollReport: HrPayrollReport = {
  period: { fromAD: '2026-01-01', toAD: '2026-11-09' },
  asOf: '2026-11-09',
  scope: { branchId: null },
  basis: { source: 'payroll_run_lines', runStatuses: ['POSTED', 'PAID'] },
  payrollCost: {
    available: true,
    totals: {
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
    },
    byBranch: [
      {
        branchId: 'hr-rpt-br-a',
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
        branchId: 'hr-rpt-br-b',
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
    ],
    byPeriod: [
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
    ],
  },
  ssf: {
    available: true,
    employeeSsf: 286,
    employerSsf: 520,
    payable: 806,
    configuredEmployeeSsf: 286,
    configuredEmployerSsf: 520,
    configured: 806,
    controlAccount: { code: '2300', name: 'SSF Payable' },
    controlBalance: 806,
    controlLineCount: 8,
    difference: 0,
    rateMismatchLines: 0,
    unconfiguredLines: 0,
    byEmployee: [
      {
        employeeId: 'hr-rpt-emp-a1',
        employeeCode: 'RPT-A1',
        employeeName: 'Report Alice',
        branchId: 'hr-rpt-br-a',
        branchName: 'Report Branch A',
        lineCount: 1,
        employeeSsf: 110,
        employerSsf: 200,
        payable: 310,
        configuredEmployeeSsf: 110,
        configuredEmployerSsf: 200,
        configured: 310,
        controlBalance: 310,
        difference: 0,
        rateMismatchLines: 0,
        unconfiguredLines: 0,
        matches: true,
        ratesMatch: true,
      },
    ],
    unattributedControl: 0,
    matches: true,
    ratesMatch: true,
    reason: null,
    rateNote: null,
  },
  overtime: {
    available: true,
    totals: { employeeCount: 2, overtimeHours: 3, overtimeAmount: 320 },
    byBranch: [
      {
        branchId: 'hr-rpt-br-a',
        branchName: 'Report Branch A',
        employeeCount: 1,
        overtimeHours: 2,
        overtimeAmount: 200,
      },
      {
        branchId: 'hr-rpt-br-b',
        branchName: 'Report Branch B',
        employeeCount: 1,
        overtimeHours: 1,
        overtimeAmount: 120,
      },
    ],
    byDepartment: [
      {
        department: 'Operations',
        employeeCount: 2,
        overtimeHours: 3,
        overtimeAmount: 320,
      },
    ],
    byEmployee: [
      {
        employeeId: 'hr-rpt-emp-a1',
        employeeCode: 'RPT-A1',
        employeeName: 'Report Alice',
        branchId: 'hr-rpt-br-a',
        branchName: 'Report Branch A',
        department: 'Operations',
        runCount: 1,
        overtimeHours: 2,
        overtimeAmount: 200,
      },
      {
        employeeId: 'hr-rpt-emp-b1',
        employeeCode: 'RPT-B1',
        employeeName: 'Report Dan',
        branchId: 'hr-rpt-br-b',
        branchName: 'Report Branch B',
        department: 'Operations',
        runCount: 1,
        overtimeHours: 1,
        overtimeAmount: 120,
      },
    ],
  },
  statutory: {
    available: true,
    totals: {
      payslipCount: 4,
      employeeSsf: 286,
      employerSsf: 520,
      totalSsf: 806,
      tds: 310,
    },
    byPeriod: [
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
    ],
  },
};

const emptyPayrollReport: HrPayrollReport = {
  period: { fromAD: '2026-01-01', toAD: '2026-11-09' },
  asOf: '2026-11-09',
  scope: { branchId: null },
  basis: payrollReport.basis,
  payrollCost: {
    available: true,
    totals: {
      runCount: 0,
      lineCount: 0,
      gross: 0,
      employerSsf: 0,
      totalCost: 0,
      basic: 0,
      allowances: 0,
      overtime: 0,
      incentive: 0,
      arrears: 0,
      lopDeduction: 0,
      deductions: 0,
      net: 0,
    },
    byBranch: [],
    byPeriod: [],
  },
  ssf: {
    available: true,
    employeeSsf: 0,
    employerSsf: 0,
    payable: 0,
    configuredEmployeeSsf: 0,
    configuredEmployerSsf: 0,
    configured: 0,
    controlAccount: null,
    controlBalance: null,
    controlLineCount: 0,
    difference: null,
    rateMismatchLines: 0,
    unconfiguredLines: 0,
    byEmployee: [],
    unattributedControl: null,
    matches: null,
    ratesMatch: true,
    reason: null,
    rateNote: null,
  },
  overtime: {
    available: true,
    totals: { employeeCount: 0, overtimeHours: 0, overtimeAmount: 0 },
    byBranch: [],
    byDepartment: [],
    byEmployee: [],
  },
  statutory: {
    available: true,
    totals: { payslipCount: 0, employeeSsf: 0, employerSsf: 0, totalSsf: 0, tds: 0 },
    byPeriod: [],
  },
};

const emptyReport: HrWorkforceReport = {
  period: { fromAD: '2026-01-01', toAD: '2026-11-09' },
  asOf: '2026-11-09',
  scope: { branchId: null },
  headcount: { total: 0, byBranch: [], byDepartment: [] },
  attrition: {
    available: true,
    separations: 0,
    ratePercent: null,
    rateBasis: 'PERIOD_START_HEADCOUNT',
    headcountAtStart: 0,
    unknownJoiningCount: 0,
    reason: 'No employees with a recorded joining date were employed at the start of the period.',
    byBranch: [],
  },
  leaveLiability: {
    balanceYear: 2026,
    totalEntitlementDays: 0,
    totalAdjustmentDays: 0,
    totalUsedDays: 0,
    totalRemainingDays: 0,
    byLeaveType: [],
  },
};

test('HR Reports is route/nav/preload wired and renders payroll and statutory reports', () => {
  const screen = readFileSync('client/src/features/hr/HrReports.tsx', 'utf8');
  assert.match(screen, /getHrWorkforceReport/);
  assert.match(screen, /getHrPayrollReport/);
  assert.match(screen, /isOperationAllowed\('hr-employee-view'/);
  assert.match(screen, /useActivationKey\('hr-reports'\)/);
  assert.match(screen, /Payroll cost/);
  assert.match(screen, /Overtime/);
  assert.match(screen, /SSF & TDS filing/);
  assert.doesNotMatch(screen, /useDialog|text-\[9px\]/, 'no raw dialog or micro-label scale');

  const app = readScreenRoutes();
  assert.match(app, /screenRoute\('hr-reports'/);
  assert.match(app, /<HrReports currentUser=\{currentUser\} \/>/);
  const paths = readFileSync('client/src/routes/appPaths.ts', 'utf8');
  assert.match(paths, /'hr-reports': '\/people\/reports'/);
  const tabs = readFileSync('client/src/routes/tabPermissions.ts', 'utf8');
  assert.match(tabs, /const HR_VIEW = \['hr-employee-view', 'gl-payroll-manage'\]/);
  assert.match(tabs, /'hr-reports': HR_VIEW/);
  const preload = readFileSync('client/src/screenPreload.ts', 'utf8');
  assert.match(
    preload,
    /'hr-reports': \(\) => import\('\.\/features\/hr\/HrReports'\)/
  );
  const sidebar = readFileSync('client/src/components/layout/Sidebar.tsx', 'utf8');
  assert.match(sidebar, /label: 'HR Reports'/);
});

test('the real /people/reports route renders all report families and refetches both aggregates', async () => {
  const filled = {
    ...bootstrapFixture,
    userPreferences: { ...bootstrapFixture.userPreferences, activeTab: 'hr-reports' },
  };
  const workforceCalls: any[] = [];
  const payrollCalls: any[] = [];
  clearRecentBootstrapCache();
  window.history.replaceState({}, '', '/');
  seedSession('hr-reports');
  const restoreEventSource = installEventSource();
  const restoreApi = installApiStubs({
    getBootstrapState: async () => filled,
    getHrWorkforceReport: async (options: unknown) => {
      workforceCalls.push(options);
      return report;
    },
    getHrPayrollReport: async (options: unknown) => {
      payrollCalls.push(options);
      return payrollReport;
    },
  });
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => (tree.container.textContent || '').includes('Active headcount')),
      'the workforce report must render'
    );
    assert.ok(
      await settleUntil(() => (tree.container.textContent || '').includes('Payroll cost')),
      'the payroll report must render'
    );
    assert.equal(window.location.pathname, '/people/reports');
    const text = tree.container.textContent || '';
    assert.match(text, /HR Reports/);
    assert.match(text, /Active headcount/);
    assert.match(text, /Report Branch A/);
    assert.match(text, /Report Branch B/);
    assert.match(text, /Operations/);
    assert.match(text, /Report Annual/);
    assert.match(text, /Report Sick/);
    assert.match(text, /Unpaid/);
    assert.match(text, /Attrition & separations/);
    assert.match(text, /Stored separation dates/);
    assert.match(text, /Attrition rate/);
    assert.match(text, /Headcount at start/);
    assert.match(text, /25%/);
    assert.doesNotMatch(text, /No separations were recorded/);
    assert.match(text, /Leave liability/);
    assert.match(text, /Balance year 2026/);
    assert.match(text, /days remaining/);
    assert.match(text, /Leave figures are days, not a monetary value/i);
    assert.match(text, /Gross payroll/);
    assert.match(text, /Payroll cost/);
    assert.match(text, /By pay period/);
    assert.match(text, /Overtime/);
    assert.match(text, /Report Alice/);
    assert.match(text, /SSF & TDS filing/);
    assert.match(text, /Employee SSF/);
    assert.match(text, /Employer SSF/);
    assert.match(text, /SSF payable reconciliation/);
    assert.match(text, /SSF payable by employee/);
    assert.match(text, /RPT-A1/);
    assert.match(text, /Reconciled/);
    assert.match(text, /TDS withheld/);
    assert.match(text, /4,080/);
    assert.equal(
      workforceCalls.length,
      1,
      'the screen must read the workforce aggregate exactly once on mount'
    );
    assert.equal(
      payrollCalls.length,
      1,
      'the screen must read the payroll aggregate exactly once on mount'
    );
    assert.match(workforceCalls[0].dateFrom, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(workforceCalls[0].dateTo, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(payrollCalls[0], workforceCalls[0], 'both reports must use the same period');

    const period = tree.container.querySelector('#hr-report-period') as HTMLSelectElement | null;
    assert.ok(period, 'the screen must expose its period selector');
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      'value'
    )?.set;
    inAct(() => {
      valueSetter?.call(period, 'LAST_30_DAYS');
      period!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.ok(
      await settleUntil(() => workforceCalls.length === 2 && payrollCalls.length === 2),
      'changing the period must refetch both reports'
    );
    assert.notEqual(
      workforceCalls[1].dateFrom,
      workforceCalls[0].dateFrom,
      'the selected period must reach the workforce API'
    );
    assert.deepEqual(payrollCalls[1], workforceCalls[1], 'both reports must follow the period');

    const refresh = tree.container.querySelector('button[aria-label="Refresh HR report"]');
    assert.ok(refresh, 'the screen needs its refresh control');
    inAct(() => (refresh as HTMLButtonElement).click());
    assert.ok(
      await settleUntil(() => workforceCalls.length === 3 && payrollCalls.length === 3),
      'Refresh must re-read both aggregates'
    );
  } finally {
    tree.unmount();
    restoreApi();
    restoreEventSource();
    applyEffectivePermissions(null);
  }
});

test('an empty scope renders explicit empty states for every report family', async () => {
  const restoreApi = installApiStubs({
    getHrWorkforceReport: async () => emptyReport,
    getHrPayrollReport: async () => emptyPayrollReport,
  });
  const tree = mountTree(createElement(HrReports, { currentUser: smokeUser }));
  try {
    assert.ok(
      await settleUntil(() =>
        (tree.container.textContent || '').includes('No active employees in this reporting scope')
      ),
      'the empty state must render after the successful read'
    );
    const text = tree.container.textContent || '';
    assert.match(text, /No active employees in this reporting scope/);
    assert.match(text, /No leave balances are configured for the current year/);
    assert.match(text, /No posted payroll runs in this reporting period/);
    assert.match(text, /No overtime was recorded on posted payroll runs/);
    assert.match(text, /No SSF or TDS was withheld on posted payroll runs/);
    assert.match(text, /No employees are in this reporting scope/);
    assert.match(
      text,
      /No employees with a recorded joining date were employed at the start of the period/
    );
    assert.match(text, /Stored separation dates/);
  } finally {
    tree.unmount();
    restoreApi();
    applyEffectivePermissions(null);
  }

  const noSeparations = {
    ...report,
    attrition: {
      ...report.attrition,
      separations: 0,
      ratePercent: 0,
      byBranch: report.attrition.byBranch.map((row) => ({
        ...row,
        separations: 0,
        ratePercent: 0,
      })),
    },
  };
  const restoreNoSeparations = installApiStubs({
    getHrWorkforceReport: async () => noSeparations,
    getHrPayrollReport: async () => payrollReport,
  });
  const noSeparationsTree = mountTree(createElement(HrReports, { currentUser: smokeUser }));
  try {
    assert.ok(
      await settleUntil(() =>
        (noSeparationsTree.container.textContent || '').includes('No separations were recorded')
      ),
      'a zero-separation period must show its explicit empty state'
    );
    assert.match(noSeparationsTree.container.textContent || '', /No separations were recorded/);
    assert.match(noSeparationsTree.container.textContent || '', /Report Branch A/);
  } finally {
    noSeparationsTree.unmount();
    restoreNoSeparations();
    applyEffectivePermissions(null);
  }
});

test('a role without the HR read grant gets the refusal without calling the endpoint', () => {
  applyEffectivePermissions([], 'FRONT_DESK');
  let reads = 0;
  let payrollReads = 0;
  const restoreApi = installApiStubs({
    getHrWorkforceReport: async () => {
      reads += 1;
      return report;
    },
    getHrPayrollReport: async () => {
      payrollReads += 1;
      return payrollReport;
    },
  });
  const frontDesk = {
    ...bootstrapFixture,
    id: 'u-front-desk',
    role: 'FRONT_DESK',
    branchId: 'WH001',
  } as any;
  const tree = mountTree(createElement(HrReports, { currentUser: frontDesk }));
  try {
    assert.match(tree.container.textContent || '', /do not have permission to view HR reports/i);
    assert.equal(reads, 0, 'the refusal must not call the workforce report endpoint');
    assert.equal(payrollReads, 0, 'the refusal must not call the payroll report endpoint');
  } finally {
    tree.unmount();
    restoreApi();
    applyEffectivePermissions(null);
  }
});
