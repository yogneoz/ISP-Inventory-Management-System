/**
 * Employee self-service payslips UI.
 *
 * A mounted real-App happy path (route, lazy screen, own-payslip read) plus a
 * direct mount proving a role without `hr-self-service` shows the refusal and
 * makes NO read. Static pins cover route/nav/preload wiring and the absence of
 * any payroll write action.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import type { User } from '../client/src/types';
import type { HrPayrollPayslip } from '../client/src/services/api/hr';
import { EmployeePayslips } from '../client/src/features/hr/EmployeePayslips';
import { formatMoneyPrecise } from '../client/src/utils/nprFormat';
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
} from './harness/appRouteTreeProbe';

const paid: HrPayrollPayslip = {
  employeeId: 'emp-ess-1',
  employeeCode: 'ESS-100',
  employeeName: 'Self Service Employee',
  department: 'Operations',
  designation: 'Network Technician',
  panNumber: '600123456',
  ssfNumber: 'SSF-ESS-100',
  bankName: 'Test Bank',
  bankAccount: '000111222333',
  bankStatus: 'READY',
  detailsRestricted: false,
  branchId: 'WH001',
  branchName: 'Warehouse',
  fiscalYearCode: '2083-84',
  runNo: 'PR-ESS-2099-01',
  periodKey: '2099-01',
  runDateAD: '2099-01-31',
  runDateBS: null,
  paidDateAD: '2099-02-02',
  paymentMethod: 'BANK',
  status: 'PAID',
  basicAmount: 60000,
  allowances: 39000,
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
  totalDeductions: 15536.67,
  employerCost: 117000,
  net: 89463.33,
};

const posted: HrPayrollPayslip = {
  ...paid,
  runNo: 'PR-ESS-2099-02',
  periodKey: '2099-02',
  runDateAD: '2099-02-28',
  paidDateAD: null,
  paymentMethod: null,
  status: 'POSTED',
  basicAmount: 60000,
  allowances: 0,
  payableDays: 28,
  overtimeHours: 0,
  overtimeAmount: 0,
  incentive: 0,
  gross: 60000,
  tds: 3000,
  ssf: 6600,
  employerSsf: 12000,
  advance: 0,
  totalDeductions: 9600,
  employerCost: 72000,
  net: 50400,
};

test('My Payslips is route/nav/preload wired, read-only and gated by hr-self-service', () => {
  const screen = readFileSync('client/src/features/hr/EmployeePayslips.tsx', 'utf8');
  assert.match(screen, /getMyHrPayslips/);
  assert.match(screen, /isOperationAllowed\('hr-self-service'/);
  assert.match(screen, /useActivationKey\('hr-self-payslips'\)/);
  assert.doesNotMatch(
    screen,
    /(createHrPayroll|approveHrPayroll|postHrPayroll|payHrPayroll|discardHrPayroll|saveHrPayrollInput|createEmployee|updateEmployee)/,
    'the self-service payslip screen must not expose a write action'
  );

  const app = readFileSync('client/src/App.tsx', 'utf8');
  assert.match(app, /screenRoute\('hr-self-payslips'/);
  assert.match(app, /EmployeePayslips currentUser=\{currentUser\}/);
  const paths = readFileSync('client/src/routes/appPaths.ts', 'utf8');
  assert.match(paths, /'hr-self-payslips': '\/people\/payslips'/);
  const tabs = readFileSync('client/src/routes/tabPermissions.ts', 'utf8');
  assert.match(tabs, /'hr-self-payslips': 'hr-self-service'/);
  const preload = readFileSync('client/src/screenPreload.ts', 'utf8');
  assert.match(
    preload,
    /'hr-self-payslips': \(\) => import\('\.\/features\/hr\/EmployeePayslips'\)/
  );
  const sidebar = readFileSync('client/src/components/layout/Sidebar.tsx', 'utf8');
  assert.match(sidebar, /label: 'My Payslips'/);
});

test('the real route renders only the signed-in employee payslips', async () => {
  const filled = {
    ...bootstrapFixture,
    userPreferences: { ...bootstrapFixture.userPreferences, activeTab: 'hr-self-payslips' },
  };
  const calls: unknown[] = [];
  clearRecentBootstrapCache();
  window.history.replaceState({}, '', '/');
  seedSession('hr-self-payslips');
  const restoreEventSource = installEventSource();
  const restoreApi = installApiStubs({
    getBootstrapState: async () => filled,
    getMyHrPayslips: async () => {
      calls.push('payslips');
      return { payslips: [posted, paid] };
    },
  });
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => (tree.container.textContent || '').includes('PR-ESS-2099-02')),
      'the own payslips must render'
    );
    const text = tree.container.textContent || '';
    assert.equal(window.location.pathname, '/people/payslips');
    assert.match(text, /My Payslips/);
    assert.match(text, /PR-ESS-2099-01/);
    assert.match(text, /PR-ESS-2099-02/);
    assert.match(text, /PAID/);
    assert.match(text, /POSTED/);
    assert.match(text, /Warehouse/);
    assert.ok(text.includes(formatMoneyPrecise('105000.00')), 'gross must keep two decimals');
    assert.ok(text.includes(formatMoneyPrecise('50400.00')), 'net must keep two decimals');
    assert.match(text, /Payslip 2099-02/, 'the newest payslip detail opens first');
    assert.match(text, /Basic salary/);
    assert.match(text, /Employer SSF/);
    assert.equal(calls.length, 1, 'the screen must read the payslip list exactly once');

    const paidButton = tree.container.querySelector(
      'button[aria-label="View details for 2099-01"]'
    ) as HTMLButtonElement | null;
    assert.ok(paidButton, 'the older payslip needs a detail control');
    inAct(() => paidButton!.click());
    const detailText = tree.container.textContent || '';
    assert.match(detailText, /Payslip 2099-01/);
    assert.ok(detailText.includes(formatMoneyPrecise('89463.33')), 'paid net must keep two decimals');
    assert.match(detailText, /Advance recovery/);
    assert.doesNotMatch(detailText, /Save changes|Submit|Approve|Post payroll|Mark paid/);
  } finally {
    tree.unmount();
    restoreApi();
    restoreEventSource();
    applyEffectivePermissions(null);
  }
});

test('a role without hr-self-service gets the refusal without calling the endpoint', () => {
  applyEffectivePermissions([], 'FRONT_DESK');
  let reads = 0;
  const restoreApi = installApiStubs({
    getMyHrPayslips: async () => {
      reads += 1;
      return { payslips: [paid] };
    },
  });
  const frontDesk = {
    ...bootstrapFixture,
    id: 'u-front-desk',
    role: 'FRONT_DESK',
    branchId: 'WH001',
  } as unknown as User;
  const tree = mountTree(createElement(EmployeePayslips, { currentUser: frontDesk }));
  try {
    assert.match(tree.container.textContent || '', /do not have permission to view your payslips/i);
    assert.equal(reads, 0, 'the refusal must not call the payslip endpoint');
  } finally {
    tree.unmount();
    restoreApi();
    applyEffectivePermissions(null);
  }
});
