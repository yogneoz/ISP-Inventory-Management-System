/**
 * People & HR → Performance & Appraisals UI.
 *
 * Direct mounts cover the real screen with a cycle, a weighted goal, 360
 * feedback and the employee picker: summary counts, the selected cycle, the
 * weighted score, empty states, the no-permission refusal without any read and
 * the Refresh path. Static checks pin route/nav/path/permission/preload and
 * saved-tab wiring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { DialogProvider } from '../client/src/components/common/DialogProvider';
import { Performance } from '../client/src/features/hr/Performance';
import type {
  EmployeeRecord,
  HrGoalRecord,
  HrPerformanceFeedbackRecord,
  HrReviewCycleRecord,
} from '../client/src/services/api/hr';
import { applyEffectivePermissions } from '../client/src/utils/permissions';
import { inAct, mountTree } from './harness/mount';
import {
  bootstrapFixture,
  installApiStubs,
  settleUntil,
  smokeUser,
} from './harness/appRouteTreeProbe';
import { BootstrapDataProvider } from '../client/src/contexts/AppProviders';

const branches = bootstrapFixture.branches as any;

const cycle: HrReviewCycleRecord = {
  id: 'hr-perf-cycle-ui-1',
  cycleNo: 'CYCLE-2026-UI1',
  branchId: 'WH001',
  branchName: 'Warehouse',
  name: 'Annual Performance Review',
  periodStartAD: '2026-04-01',
  periodStartBS: '2083-01-18 BS',
  periodEndAD: '2027-03-31',
  periodEndBS: '2084-01-18 BS',
  status: 'OPEN',
  instructions: 'Complete before the review meeting.',
  signedOffBy: null,
  signedOffAt: null,
  isDemo: false,
  createdBy: 'hr@example.com',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  goalCount: 1,
  employeeCount: 1,
  feedbackCount: 1,
};

const goal: HrGoalRecord = {
  id: 'hr-perf-goal-ui-1',
  goalNo: 'GOAL-2026-UI1',
  cycleId: cycle.id,
  cycleNo: cycle.cycleNo,
  cycleName: cycle.name,
  cycleStatus: 'OPEN',
  branchId: 'WH001',
  branchName: 'Warehouse',
  employeeId: 'hr-perf-emp-1',
  employeeCode: 'PERF-101',
  employeeName: 'Performance UI One',
  title: 'Reduce branch downtime',
  description: 'Keep availability above target.',
  weight: 60,
  targetValue: '99.5% uptime',
  achievement: null,
  status: 'COMPLETED',
  selfRating: 4,
  managerRating: 4.5,
  finalRating: 4.5,
  createdBy: 'hr@example.com',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};

const feedback: HrPerformanceFeedbackRecord = {
  id: 'hr-perf-fb-ui-1',
  cycleId: cycle.id,
  cycleNo: cycle.cycleNo,
  cycleName: cycle.name,
  cycleStatus: 'OPEN',
  branchId: 'WH001',
  branchName: 'Warehouse',
  employeeId: goal.employeeId,
  employeeCode: goal.employeeCode,
  employeeName: goal.employeeName,
  reviewerEmployeeId: 'hr-perf-emp-2',
  reviewerEmployeeCode: 'PERF-102',
  reviewerEmployeeName: 'Performance UI Two',
  relationship: 'PEER',
  rating: 4,
  strengths: 'Reliable incident response',
  improvements: 'Document the runbook',
  comments: 'Strong technical partner.',
  submittedBy: 'hr@example.com',
  submittedAt: '2026-11-02T00:00:00Z',
};

const employees = [
  {
    id: goal.employeeId,
    employeeCode: goal.employeeCode,
    name: goal.employeeName,
    branchId: 'WH001',
    isActive: true,
  },
  {
    id: feedback.reviewerEmployeeId,
    employeeCode: feedback.reviewerEmployeeCode,
    name: feedback.reviewerEmployeeName,
    branchId: 'WH001',
    isActive: true,
  },
] as EmployeeRecord[];

test('performance is route, nav, path, permission and preload wired', () => {
  const screen = readFileSync('client/src/features/hr/Performance.tsx', 'utf8');
  assert.match(screen, /useActivationKey\('hr-performance'\)/);
  assert.match(screen, /getHrReviewCycles/);
  assert.match(screen, /signOffHrReviewCycle/);
  assert.match(screen, /createHrPerformanceFeedback/);
  assert.match(screen, /isOperationAllowed\('hr-employee-view'/);

  const app = readFileSync('client/src/App.tsx', 'utf8');
  assert.match(app, /screenRoute\('hr-performance'/);
  assert.match(app, /<Performance\s+currentUser=\{currentUser\}/);
  const paths = readFileSync('client/src/routes/appPaths.ts', 'utf8');
  assert.match(paths, /'hr-performance': '\/people\/performance'/);
  const tabs = readFileSync('client/src/routes/tabPermissions.ts', 'utf8');
  assert.match(tabs, /const HR_VIEW = \['hr-employee-view', 'gl-payroll-manage'\]/);
  assert.match(tabs, /'hr-performance': HR_VIEW/);
  const preload = readFileSync('client/src/screenPreload.ts', 'utf8');
  assert.match(
    preload,
    /'hr-performance': \(\) => import\('\.\/features\/hr\/Performance'\)/
  );
  const sidebar = readFileSync('client/src/components/layout/Sidebar.tsx', 'utf8');
  assert.match(sidebar, /label: 'Performance'/);
});

test('the screen renders cycles, goals, feedback and summary counts and refetches on Refresh', async () => {
  const calls = { cycles: 0, goals: 0, feedback: 0, employees: 0 };
  const scopes: any[] = [];
  const restore = installApiStubs({
    getHrReviewCycles: async (options: any) => {
      calls.cycles += 1;
      scopes.push(options);
      return [cycle];
    },
    getHrGoals: async () => {
      calls.goals += 1;
      return [goal];
    },
    getHrPerformanceFeedback: async () => {
      calls.feedback += 1;
      return [feedback];
    },
    getEmployees: async () => {
      calls.employees += 1;
      return employees;
    },
  });
  const tree = mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(BootstrapDataProvider, { initial: { branches } }, createElement(Performance, {
        currentUser: smokeUser,
        selectedBranchId: 'WH001',
      }))
    )
  );
  try {
    assert.ok(
      await settleUntil(() => (tree.container.textContent || '').includes('Annual Performance Review')),
      'the cycle and its selected details must render'
    );
    const text = tree.container.textContent || '';
    assert.match(text, /Performance & Appraisals/);
    assert.match(text, /Appraisal cycles/);
    assert.match(text, /Goals & KPIs/);
    assert.match(text, /360 feedback/);
    assert.match(text, /Reduce branch downtime/);
    assert.match(text, /Performance UI Two/);
    assert.match(text, /Annual Performance Review/);
    assert.match(text, /Weighted score/);
    assert.match(text, /4\.50/);
    assert.equal(
      tree.container.querySelector('[data-testid="performance-summary-open"]')?.textContent,
      '1'
    );
    assert.equal(
      tree.container.querySelector('[data-testid="performance-summary-goals"]')?.textContent,
      '1'
    );
    assert.equal(
      tree.container.querySelector('[data-testid="performance-summary-completion"]')?.textContent,
      '100%'
    );
    assert.equal(
      tree.container.querySelector('[data-testid="performance-summary-feedback"]')?.textContent,
      '1'
    );
    assert.deepEqual(scopes, [{ branchId: 'WH001' }]);

    const refresh = tree.container.querySelector(
      'button[data-testid="performance-refresh"]'
    ) as HTMLButtonElement | null;
    assert.ok(refresh, 'the screen must expose Refresh');
    inAct(() => refresh!.click());
    assert.ok(
      await settleUntil(
        () =>
          calls.cycles === 2 &&
          calls.goals === 2 &&
          calls.feedback === 2 &&
          calls.employees === 2
      ),
      'Refresh must re-read all four performance collections'
    );
  } finally {
    tree.unmount();
    restore();
  }
});

test('an empty branch scope renders an explicit empty state for cycles, goals and feedback', async () => {
  const restore = installApiStubs({
    getHrReviewCycles: async () => [],
    getHrGoals: async () => [],
    getHrPerformanceFeedback: async () => [],
    getEmployees: async () => [],
  });
  const tree = mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(BootstrapDataProvider, { initial: { branches } }, createElement(Performance, {
        currentUser: smokeUser,
        selectedBranchId: 'WH001',
      }))
    )
  );
  try {
    assert.ok(
      await settleUntil(() =>
        (tree.container.textContent || '').includes('No appraisal cycles in this branch scope yet')
      ),
      'the empty cycle state must render'
    );
    const text = tree.container.textContent || '';
    assert.match(text, /No appraisal cycles in this branch scope yet/);
    assert.match(text, /Select a cycle to see its goals/);
    assert.match(text, /No 360 feedback submitted for this cycle/);
  } finally {
    tree.unmount();
    restore();
  }
});

test('a role without the HR read grant is refused without calling any endpoint', async () => {
  applyEffectivePermissions([], 'FRONT_DESK');
  let reads = 0;
  const restore = installApiStubs({
    getHrReviewCycles: async () => {
      reads += 1;
      return [];
    },
    getHrGoals: async () => {
      reads += 1;
      return [];
    },
    getHrPerformanceFeedback: async () => {
      reads += 1;
      return [];
    },
    getEmployees: async () => {
      reads += 1;
      return [];
    },
  });
  const frontDesk = {
    ...bootstrapFixture,
    id: 'u-performance-front-desk',
    role: 'FRONT_DESK',
    branchId: 'WH001',
  } as any;
  const tree = mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(BootstrapDataProvider, { initial: { branches } }, createElement(Performance, {
        currentUser: frontDesk,
        selectedBranchId: 'WH001',
      }))
    )
  );
  try {
    assert.match(
      tree.container.textContent || '',
      /Performance records are available to accounts with the HR employee-view permission/i
    );
    assert.equal(reads, 0, 'the refusal must not call any performance endpoint');
  } finally {
    tree.unmount();
    restore();
    applyEffectivePermissions(null);
  }
});
