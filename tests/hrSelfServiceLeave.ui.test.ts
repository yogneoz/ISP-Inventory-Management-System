/**
 * Employee self-service leave UI.
 *
 * A mounted real-App happy path (route, lazy screen, own leave read) plus a
 * direct mount proving a role without `hr-self-service` shows the refusal and
 * makes NO read. Static pins cover route/nav/preload wiring and the absence of
 * any request write action.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import type { User } from '../client/src/types';
import type {
  HrSelfLeaveBalance,
  HrSelfLeaveRequest,
} from '../client/src/services/api/hr';
import { EmployeeLeave } from '../client/src/features/hr/EmployeeLeave';
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

const annual: HrSelfLeaveBalance = {
  id: 'ess-leave-bal-a-annual',
  leaveTypeId: 'ess-leave-type-annual',
  leaveTypeCode: 'EL-ANNUAL',
  leaveTypeName: 'Annual Leave',
  leaveTypePaid: true,
  balanceYear: 2099,
  entitlementDays: 20,
  adjustmentDays: 2,
  usedDays: 3,
  remainingDays: 19,
  notes: null,
  updatedAt: '2099-01-01T00:00:00.000Z',
};

const sick: HrSelfLeaveBalance = {
  ...annual,
  id: 'ess-leave-bal-a-sick',
  leaveTypeId: 'ess-leave-type-sick',
  leaveTypeCode: 'EL-SICK',
  leaveTypeName: 'Sick Leave',
  leaveTypePaid: false,
  usedDays: 0,
  remainingDays: 10,
};

const request: HrSelfLeaveRequest = {
  id: 'ess-leave-req-a-approved',
  requestNo: 'ESS-LR-A-1',
  leaveTypeId: 'ess-leave-type-annual',
  leaveTypeCode: 'EL-ANNUAL',
  leaveTypeName: 'Annual Leave',
  startDateAD: '2099-03-01',
  endDateAD: '2099-03-03',
  startDateBS: '2099-03-01 BS',
  endDateBS: '2099-03-03 BS',
  daysCount: 3,
  reason: 'Family event',
  status: 'APPROVED',
  decidedBy: 'HR Lead',
  decidedAt: '2099-02-20T00:00:00.000Z',
  decisionNote: 'Approved',
  createdAt: '2099-02-18T00:00:00.000Z',
  updatedAt: '2099-02-20T00:00:00.000Z',
};

const pending: HrSelfLeaveRequest = {
  ...request,
  id: 'ess-leave-req-a-pending',
  requestNo: 'ESS-LR-A-2',
  startDateAD: '2099-05-01',
  endDateAD: '2099-05-01',
  startDateBS: '2099-05-01 BS',
  endDateBS: '2099-05-01 BS',
  daysCount: 1,
  reason: 'Personal',
  status: 'PENDING',
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
};

test('My Leave is route/nav/preload wired, read-only and gated by hr-self-service', () => {
  const screen = readFileSync('client/src/features/hr/EmployeeLeave.tsx', 'utf8');
  assert.match(screen, /getMyHrLeave/);
  assert.match(screen, /isOperationAllowed\('hr-self-service'/);
  assert.match(screen, /useActivationKey\('hr-self-leave'\)/);
  assert.doesNotMatch(
    screen,
    /(createHrLeave|approveHrLeave|rejectHrLeave|cancelHrLeave|post_hrLeave|saveHrAttendance|createHrLeaveRequest)/,
    'the self-service leave screen must not expose a write action'
  );

  const app = readFileSync('client/src/App.tsx', 'utf8');
  assert.match(app, /screenRoute\('hr-self-leave'/);
  assert.match(app, /EmployeeLeave currentUser=\{currentUser\}/);
  const paths = readFileSync('client/src/routes/appPaths.ts', 'utf8');
  assert.match(paths, /'hr-self-leave': '\/people\/leave'/);
  const tabs = readFileSync('client/src/routes/tabPermissions.ts', 'utf8');
  assert.match(tabs, /'hr-self-leave': 'hr-self-service'/);
  const preload = readFileSync('client/src/screenPreload.ts', 'utf8');
  assert.match(
    preload,
    /'hr-self-leave': \(\) => import\('\.\/features\/hr\/EmployeeLeave'\)/
  );
  const sidebar = readFileSync('client/src/components/layout/Sidebar.tsx', 'utf8');
  assert.match(sidebar, /label: 'My Leave'/);
});

test('the real route renders only the signed-in employee leave records', async () => {
  const filled = {
    ...bootstrapFixture,
    userPreferences: { ...bootstrapFixture.userPreferences, activeTab: 'hr-self-leave' },
  };
  const calls: unknown[] = [];
  clearRecentBootstrapCache();
  window.history.replaceState({}, '', '/');
  seedSession('hr-self-leave');
  const restoreEventSource = installEventSource();
  const restoreApi = installApiStubs({
    getBootstrapState: async () => filled,
    getMyHrLeave: async () => {
      calls.push('leave');
      return { balances: [annual, sick], requests: [pending, request] };
    },
  });
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => (tree.container.textContent || '').includes('ESS-LR-A-2')),
      'the own leave records must render'
    );
    const text = tree.container.textContent || '';
    assert.equal(window.location.pathname, '/people/leave');
    assert.match(text, /My Leave/);
    assert.match(text, /Annual Leave/);
    assert.match(text, /Sick Leave/);
    assert.match(text, /EL-ANNUAL/);
    assert.match(text, /19\s*days left/);
    assert.match(text, /10\s*days left/);
    assert.match(text, /ESS-LR-A-1/);
    assert.match(text, /APPROVED/);
    assert.match(text, /PENDING/);
    assert.match(text, /Team coverage|Approved/);
    assert.match(text, /2099-03-01/);
    assert.equal(calls.length, 1, 'the screen must read the leave list exactly once');

    const button = tree.container.querySelector('button[aria-label*="refresh" i]');
    if (button) {
      inAct(() => (button as HTMLButtonElement).click());
      assert.ok(await settleUntil(() => calls.length === 2), 'Refresh must re-read the list');
    }

    assert.doesNotMatch(text, /Apply for leave|Submit request|Approve request|Cancel request/);
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
    getMyHrLeave: async () => {
      reads += 1;
      return { balances: [annual], requests: [request] };
    },
  });
  const frontDesk = {
    ...bootstrapFixture,
    id: 'u-front-desk',
    role: 'FRONT_DESK',
    branchId: 'WH001',
  } as unknown as User;
  const tree = mountTree(createElement(EmployeeLeave, { currentUser: frontDesk }));
  try {
    assert.match(tree.container.textContent || '', /do not have permission to view your leave records/i);
    assert.equal(reads, 0, 'the refusal must not call the leave endpoint');
  } finally {
    tree.unmount();
    restoreApi();
    applyEffectivePermissions(null);
  }
});
