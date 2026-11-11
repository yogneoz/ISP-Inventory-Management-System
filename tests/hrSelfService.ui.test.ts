/**
 * Employee self-service UI.
 *
 * A mounted real-App happy path (route, lazy screen, own-profile read) plus a
 * direct mount proving a role without `hr-self-service` shows the refusal and
 * makes NO read. The static pins cover the route/nav/preload wiring and the
 * absence of any write control.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import type { User } from '../client/src/types';
import type { HrSelfProfile } from '../client/src/services/api/hr';
import { EmployeeSelfService } from '../client/src/features/hr/EmployeeSelfService';
import { formatMoneyPrecise } from '../client/src/utils/nprFormat';
import { applyEffectivePermissions } from '../client/src/utils/permissions';
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

const profile: HrSelfProfile = {
  id: 'emp-ess-1',
  employeeCode: 'ESS-100',
  name: 'Self Service Employee',
  branchId: 'WH001',
  branchName: 'Warehouse',
  department: 'Operations',
  designation: 'Network Technician',
  designationCode: 'NET-TECH',
  employmentType: 'Non-PB',
  workStation: 'Warehouse Bench',
  joiningDateAD: '2024-02-01',
  contractExpiryAD: '2027-01-31',
  dateOfBirthAD: '1993-06-12',
  internalEmail: 'ess.100@internal.example',
  personalEmail: 'ess.100@personal.example',
  personalContact: '9812345678',
  emergencyContactPerson: 'Emergency Contact',
  emergencyContactNumber: '9800000000',
  address: 'Lalitpur, Nepal',
  panNumber: '600123456',
  ssfNumber: 'SSF-ESS-100',
  ssfEligible: true,
  bankName: 'Test Bank',
  bankAccount: '000111222333',
  monthlySalary: '98765.40',
  profilePhoto: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

test('My Profile is route/nav/preload wired, read-only and gated by hr-self-service', () => {
  const screen = readFileSync('client/src/features/hr/EmployeeSelfService.tsx', 'utf8');
  assert.match(screen, /getMyHrProfile/);
  assert.match(screen, /isOperationAllowed\('hr-self-service'/);
  assert.match(screen, /useActivationKey\('hr-self-service'\)/);
  assert.doesNotMatch(
    screen,
    /(createEmployee|updateEmployee|saveHr|uploadEmployeeDocument|deleteEmployeeDocument)/,
    'the self-service screen must not expose a write action'
  );

  const app = readFileSync('client/src/App.tsx', 'utf8');
  assert.match(app, /screenRoute\('hr-self-service'/);
  assert.match(app, /EmployeeSelfService currentUser=\{currentUser\}/);
  const paths = readFileSync('client/src/routes/appPaths.ts', 'utf8');
  assert.match(paths, /'hr-self-service': '\/people\/profile'/);
  const tabs = readFileSync('client/src/routes/tabPermissions.ts', 'utf8');
  assert.match(tabs, /'hr-self-service': 'hr-self-service'/);
  const preload = readFileSync('client/src/screenPreload.ts', 'utf8');
  assert.match(
    preload,
    /'hr-self-service': \(\) => import\('\.\/features\/hr\/EmployeeSelfService'\)/
  );
  const sidebar = readFileSync('client/src/components/layout/Sidebar.tsx', 'utf8');
  assert.match(sidebar, /label: 'My Profile'/);
});

test('the real route renders only the signed-in employee profile', async () => {
  const filled = {
    ...bootstrapFixture,
    userPreferences: { ...bootstrapFixture.userPreferences, activeTab: 'hr-self-service' },
  };
  const calls: unknown[] = [];
  clearRecentBootstrapCache();
  window.history.replaceState({}, '', '/');
  seedSession('hr-self-service');
  const restoreEventSource = installEventSource();
  const restoreApi = installApiStubs({
    getBootstrapState: async () => filled,
    getMyHrProfile: async () => {
      calls.push('profile');
      return profile;
    },
  });
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => (tree.container.textContent || '').includes('Self Service Employee')),
      'the linked employee profile must render'
    );
    const text = tree.container.textContent || '';
    assert.equal(window.location.pathname, '/people/profile');
    assert.match(text, /ESS-100/);
    assert.match(text, /Network Technician/);
    assert.match(text, /Warehouse/);
    assert.match(text, /SSF-ESS-100/);
    assert.ok(text.includes(formatMoneyPrecise('98765.40')), 'salary must keep two decimals');
    assert.equal(calls.length, 1, 'the screen must read the profile exactly once');
    assert.doesNotMatch(text, /Add Employee|Save changes|Delete|Import employees/);
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
    getMyHrProfile: async () => {
      reads += 1;
      return profile;
    },
  });
  const frontDesk = {
    ...bootstrapFixture,
    id: 'u-front-desk',
    role: 'FRONT_DESK',
    branchId: 'WH001',
  } as unknown as User;
  const tree = mountTree(
    createElement(EmployeeSelfService, { currentUser: frontDesk })
  );
  try {
    assert.match(tree.container.textContent || '', /do not have permission to view your employee profile/i);
    assert.equal(reads, 0, 'the refusal must not call the profile endpoint');
  } finally {
    tree.unmount();
    restoreApi();
    applyEffectivePermissions(null);
  }
});
