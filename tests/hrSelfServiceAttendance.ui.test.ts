/**
 * Employee self-service attendance UI.
 *
 * A mounted real-App happy path (route, lazy screen, own attendance read) plus
 * a direct mount proving a role without `hr-self-service` shows the refusal and
 * makes NO read. Static pins cover route/nav/preload wiring, the moved HR
 * register path and the absence of any clock/edit/approval action.
 */
import { test } from 'node:test';
import { readScreenRoutes } from './harness/screenRouteSource';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import type { User } from '../client/src/types';
import type {
  HrSelfAttendanceRecord,
  HrSelfAttendanceSummary,
} from '../client/src/services/api/hr';
import { EmployeeAttendance } from '../client/src/features/hr/EmployeeAttendance';
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

const summary: HrSelfAttendanceSummary = {
  totalDays: 3,
  presentDays: 1,
  absentDays: 1,
  leaveDays: 0,
  halfDays: 1,
  holidayDays: 0,
  weekendDays: 0,
  overtimeHours: 3.5,
};

const present: HrSelfAttendanceRecord = {
  id: 'ess-att-row-a-today',
  attendanceDateAD: '2099-03-30',
  attendanceDateBS: '2083-01-01 BS',
  shiftId: null,
  shiftCode: null,
  shiftName: null,
  status: 'PRESENT',
  checkInTime: '09:05',
  checkOutTime: '18:10',
  overtimeHours: 1.25,
  notes: 'Today shift',
  source: 'IMPORT',
  updatedAt: '2099-03-30T12:00:00.000Z',
};

const absent: HrSelfAttendanceRecord = {
  ...present,
  id: 'ess-att-row-a-yesterday',
  attendanceDateAD: '2099-03-29',
  attendanceDateBS: null,
  status: 'ABSENT',
  checkInTime: null,
  checkOutTime: null,
  overtimeHours: 0,
  notes: null,
  source: 'MANUAL',
};

const half: HrSelfAttendanceRecord = {
  ...present,
  id: 'ess-att-row-a-half',
  attendanceDateAD: '2099-03-28',
  attendanceDateBS: null,
  status: 'HALF_DAY',
  checkInTime: '09:00',
  checkOutTime: '13:00',
  overtimeHours: 2.25,
  notes: null,
};

test('My Attendance is route/nav/preload wired, read-only and gated by hr-self-service', () => {
  const screen = readFileSync('client/src/features/hr/EmployeeAttendance.tsx', 'utf8');
  assert.match(screen, /getMyHrAttendance/);
  assert.match(screen, /isOperationAllowed\('hr-self-service'/);
  assert.match(screen, /useActivationKey\('hr-self-attendance'\)/);
  assert.doesNotMatch(
    screen,
    /(postHrAttendance|deleteHrAttendance|saveHrAttendance|createHrAttendance|importHrAttendance|clockIn|clockOut|approveHrLeave)/,
    'the self-service attendance screen must not expose a clock/edit/approval action'
  );
  assert.doesNotMatch(screen, /text-\[9px\]/, 'micro-labels must use the design-system scale');

  const app = readScreenRoutes();
  assert.match(app, /screenRoute\('hr-self-attendance'/);
  assert.match(app, /EmployeeAttendance currentUser=\{currentUser\}/);
  const paths = readFileSync('client/src/routes/appPaths.ts', 'utf8');
  assert.match(paths, /'hr-self-attendance': '\/people\/attendance'/);
  assert.match(
    paths,
    /'hr-attendance': '\/people\/attendance-register'/,
    'the HR management register must no longer own the ESS URL'
  );
  const tabs = readFileSync('client/src/routes/tabPermissions.ts', 'utf8');
  assert.match(tabs, /'hr-self-attendance': 'hr-self-service'/);
  const preload = readFileSync('client/src/screenPreload.ts', 'utf8');
  assert.match(
    preload,
    /'hr-self-attendance': \(\) => import\('\.\/features\/hr\/EmployeeAttendance'\)/
  );
  const sidebar = readFileSync('client/src/components/layout/Sidebar.tsx', 'utf8');
  assert.match(sidebar, /label: 'My Attendance'/);
});

test('the real route renders only the signed-in employee attendance', async () => {
  const filled = {
    ...bootstrapFixture,
    userPreferences: { ...bootstrapFixture.userPreferences, activeTab: 'hr-self-attendance' },
  };
  const calls: unknown[] = [];
  clearRecentBootstrapCache();
  window.history.replaceState({}, '', '/');
  seedSession('hr-self-attendance');
  const restoreEventSource = installEventSource();
  const restoreApi = installApiStubs({
    getBootstrapState: async () => filled,
    getMyHrAttendance: async () => {
      calls.push('attendance');
      return {
        windowStartAD: '2099-01-01',
        windowEndAD: '2099-03-31',
        windowDays: 90,
        summary,
        records: [present, absent, half],
      };
    },
  });
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => (tree.container.textContent || '').includes('Today shift')),
      'the own attendance records must render'
    );
    const text = tree.container.textContent || '';
    assert.equal(window.location.pathname, '/people/attendance');
    assert.match(text, /My Attendance/);
    assert.match(text, /Last 90 days/);
    assert.match(text, /2099-01-01/);
    assert.match(text, /2099-03-31/);
    assert.match(text, /2099-03-30/);
    assert.match(text, /PRESENT/);
    assert.match(text, /ABSENT/);
    assert.match(text, /HALF DAY/);
    assert.match(text, /Today shift/);
    assert.match(text, /3\.5\s*h/);
    assert.match(text, /Imported/);
    assert.match(text, /Manual/);
    assert.equal(calls.length, 1, 'the screen must read the attendance list exactly once');

    const button = tree.container.querySelector('button[aria-label*="refresh" i]');
    assert.ok(button, 'the screen needs its refresh control');
    inAct(() => (button as HTMLButtonElement).click());
    assert.ok(await settleUntil(() => calls.length === 2), 'Refresh must re-read the list');

    assert.doesNotMatch(text, /Clock in|Clock out|Submit|Approve|Edit attendance|Delete attendance/);
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
    getMyHrAttendance: async () => {
      reads += 1;
      return {
        windowStartAD: '2099-01-01',
        windowEndAD: '2099-03-31',
        windowDays: 90,
        summary,
        records: [present],
      };
    },
  });
  const frontDesk = {
    ...bootstrapFixture,
    id: 'u-front-desk',
    role: 'FRONT_DESK',
    branchId: 'WH001',
  } as unknown as User;
  const tree = mountTree(createElement(EmployeeAttendance, { currentUser: frontDesk }));
  try {
    assert.match(
      tree.container.textContent || '',
      /do not have permission to view your attendance records/i
    );
    assert.equal(reads, 0, 'the refusal must not call the attendance endpoint');
  } finally {
    tree.unmount();
    restoreApi();
    applyEffectivePermissions(null);
  }
});