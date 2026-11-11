/**
 * The posted payroll output surface must offer both views, print and copy, and
 * stay on the repository's 10px typography floor. This is a static source pin;
 * the API suite exercises the data and the browser check exercises the modal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import type { Branch, User } from '../client/src/types';
import type { HrPayrollPostingRow } from '../client/src/services/api/hr';
import { PayrollPostingsRegister } from '../client/src/features/finance/PayrollPostingsRegister';
import { formatMoneyPrecise } from '../client/src/utils/nprFormat';
import { clearRecentBootstrapCache } from '../client/src/utils/sessionCache';
import { mountTree } from './harness/mount';
import {
  bootstrapFixture,
  installApiStubs,
  installEventSource,
  mountAppRouteTree,
  seedSession,
  settleUntil,
} from './harness/appRouteTreeProbe';

test('payroll adjustments are editable inputs and visible run snapshots', () => {
  const inputs = readFileSync('client/src/features/hr/AttendanceLeave.tsx', 'utf8');
  assert.match(inputs, /saveHrPayrollInput/);
  assert.match(inputs, /Incentive \(NPR\)/);
  assert.match(inputs, /Arrears \(NPR\)/);
  assert.match(inputs, /Advance recovery \(NPR\)/);
  assert.match(inputs, /Loan installment \(NPR\)/);
  assert.match(inputs, /A generated run keeps the values it snapshotted/);

  const run = readFileSync('client/src/features/hr/Payroll.tsx', 'utf8');
  assert.match(run, /line\.incentive/);
  assert.match(run, /line\.arrears/);

  const outputs = readFileSync(
    'client/src/features/hr/PayrollOutputsModal.tsx',
    'utf8'
  );
  assert.match(outputs, /payslip\.incentive/);
  assert.match(outputs, /payslip\.arrears/);
  assert.match(outputs, /row\.incentive/);
  assert.match(outputs, /row\.arrears/);
});

test('Finance payroll-postings register is read-only, gl-view gated and snapshot-complete', () => {
  const source = readFileSync(
    'client/src/features/finance/PayrollPostingsRegister.tsx',
    'utf8'
  );
  assert.match(source, /getHrPayrollPostings/);
  assert.match(source, /isOperationAllowed\('gl-view'/);
  assert.match(source, /formatMoneyPrecise/);
  assert.match(source, /DRAFT and APPROVED runs are excluded/);
  for (const field of [
    'grossTotal',
    'incentiveTotal',
    'arrearsTotal',
    'tdsTotal',
    'ssfTotal',
    'advanceTotal',
    'loanTotal',
    'netTotal',
    'journalNo',
    'paymentJournalNo',
  ]) {
    assert.match(source, new RegExp(field));
  }
  assert.doesNotMatch(
    source,
    /(createHrPayroll|approveHrPayroll|postHrPayroll|payHrPayroll|discardHrPayroll|saveHrPayrollInput)/,
    'the Finance postings register must not expose a payroll write action'
  );

  const app = readFileSync('client/src/App.tsx', 'utf8');
  assert.match(app, /screenRoute\('finance-payroll-postings'/);
  const paths = readFileSync('client/src/routes/appPaths.ts', 'utf8');
  assert.match(paths, /finance-payroll-postings': '\/finance\/payroll-postings'/);
  const preload = readFileSync('client/src/screenPreload.ts', 'utf8');
  assert.match(preload, /'finance-payroll-postings': \(\) => import\('\.\/features\/finance\/PayrollPostingsRegister'\)/);
});

const postedRun: HrPayrollPostingRow = {
  id: 'run-posted',
  runNo: 'PAY-2083-0007',
  branchId: 'WH001',
  branchName: 'Warehouse',
  periodKey: '2083-07',
  runDateAD: '2026-08-01',
  runDateBS: '2083-04-17',
  grossTotal: '100000.00',
  tdsTotal: '1840.00',
  ssfTotal: '6600.00',
  advanceTotal: '2500.00',
  loanTotal: '1500.00',
  incentiveTotal: '5000.00',
  arrearsTotal: '2000.00',
  netTotal: '94560.00',
  status: 'PAID',
  journalId: 'journal-posted',
  journalNo: 'JV-PAY-0007',
  journalDateAD: '2026-08-01',
  journalStatus: 'POSTED',
  journalDebit: '100000.00',
  journalCredit: '100000.00',
  paidJournalId: 'journal-paid',
  paymentJournalNo: 'JV-PMT-0007',
  paymentJournalDateAD: '2026-08-02',
  paymentJournalStatus: 'POSTED',
  paymentDebit: '94560.00',
  paymentCredit: '94560.00',
  paidDateAD: '2026-08-02',
  paidDateBS: '2083-04-18',
  paymentMethod: 'BANK',
  postedBy: 'u-poster',
  approvedBy: 'u-approver',
  paidAt: '2026-08-02T10:00:00.000Z',
  employeeCount: 4,
};

test('Finance payroll postings renders the posted snapshot and refuses without gl-view', async () => {
  const filled = { ...bootstrapFixture, userPreferences: { ...bootstrapFixture.userPreferences, activeTab: 'finance-payroll-postings' } };
  const calls: unknown[] = [];
  clearRecentBootstrapCache();
  window.history.replaceState({}, '', '/');
  seedSession('finance-payroll-postings');
  const restoreEventSource = installEventSource();
  const restoreApi = installApiStubs({
    getBootstrapState: async () => filled,
    getHrPayrollPostings: async (query: unknown) => {
      calls.push(query);
      return [postedRun];
    },
  });
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => (tree.container.textContent || '').includes('PAY-2083-0007')),
      'the posted run must render from the read-only endpoint'
    );
    const text = tree.container.textContent || '';
    assert.equal(window.location.pathname, '/finance/payroll-postings');
    assert.match(text, /PAID/);
    assert.match(text, /1 posted run/);
    assert.ok(text.includes(formatMoneyPrecise('100000.00')), 'gross must keep two decimals');
    assert.ok(text.includes(formatMoneyPrecise('94560.00')), 'net must keep two decimals');
    assert.match(text, /JV-PAY-0007/);
    assert.match(text, /JV-PMT-0007/);
    assert.match(text, /BANK/);
    assert.deepEqual(
      calls,
      [{ branchId: undefined, from: undefined, to: undefined, query: undefined }],
      'the screen must read the all-branch register without accidental filters'
    );
    assert.doesNotMatch(text, /Discard|Approve|Post payroll|Mark paid/);
  } finally {
    tree.unmount();
    restoreApi();
    restoreEventSource();
  }

  let refusalReads = 0;
  const restoreRefusalApi = installApiStubs({
    getHrPayrollPostings: async () => {
      refusalReads += 1;
      return [];
    },
  });
  const branchManager = {
    ...bootstrapFixture,
    id: 'u-branch-manager',
    role: 'BRANCH_MANAGER',
    branchId: 'WH001',
  } as unknown as User;
  const branches = [{ id: 'WH001', code: 'WH001', name: 'Warehouse', active: true }] as unknown as Branch[];
  const refused = mountTree(
    createElement(PayrollPostingsRegister, { branches, currentUser: branchManager })
  );
  try {
    assert.match(refused.container.textContent || '', /do not have permission to view accounting ledgers/);
    assert.equal(refusalReads, 0, 'a role without gl-view must not call the register endpoint');
  } finally {
    refused.unmount();
    restoreRefusalApi();
  }
});

test('payroll outputs expose register/payslip print and copy actions at the 10px floor', () => {
  const source = readFileSync(
    'client/src/features/hr/PayrollOutputsModal.tsx',
    'utf8'
  );
  assert.match(source, /getHrPayrollPayslips/);
  assert.match(source, /getHrPayrollRegister/);
  assert.match(source, /downloadHrPayrollBankFile/);
  assert.match(source, /Bank file/);
  assert.match(source, /navigator\.clipboard\.writeText/);
  assert.match(source, /printDocument/);
  assert.ok(!/text-\[9px\]/.test(source), 'payroll outputs must not use 9px labels');
});
