/**
 * People & HR → Onboarding & Offboarding UI.
 *
 * Direct mounts cover the real workspace with a branch-scoped offboarding
 * checklist: summary counts, generated asset/account items, the item-completion
 * confirmation and API call, the create dialog, empty states, Refresh and the
 * no-permission refusal without any read. Static checks pin sidebar, route,
 * path, permission and preload wiring.
 */
import { test } from 'node:test';
import { readScreenRoutes } from './harness/screenRouteSource';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { DialogProvider } from '../client/src/components/common/DialogProvider';
import { Lifecycle } from '../client/src/features/hr/Lifecycle';
import type {
  EmployeeRecord,
  HrLifecycleChecklistDetail,
  HrLifecycleChecklistRecord,
} from '../client/src/services/api/hr';
import { applyEffectivePermissions } from '../client/src/utils/permissions';
import { inAct, mountTree } from './harness/mount';
import {
  bootstrapFixture,
  installApiStubs,
  settleUntil,
  smokeUser,
} from './harness/appRouteTreeProbe';

const checklist: HrLifecycleChecklistRecord = {
  id: 'hr-life-checklist-ui-1',
  checklistNo: 'OFF-2026-UI1',
  employeeId: 'hr-life-emp-ui-1',
  branchId: 'WH001',
  branchName: 'Warehouse',
  employeeCode: 'LIFE-201',
  employeeName: 'Lifecycle UI Employee',
  department: 'Operations',
  designation: 'Technician',
  checklistType: 'OFFBOARDING',
  status: 'OPEN',
  effectiveDateAD: '2026-11-15',
  effectiveDateBS: '2083-07-29 BS',
  notes: 'Return branch equipment before the exit date.',
  completedBy: null,
  completedAt: null,
  isDemo: false,
  createdBy: 'hr@example.com',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  userId: 'hr-life-account-ui-1',
  accountEmail: 'life-ui@example.com',
  accountName: 'Lifecycle UI Account',
  accountStatus: 'active',
  accountRole: 'FRONT_DESK',
  itemCount: 3,
  doneCount: 0,
  requiredPendingCount: 3,
  assetCount: 1,
  pendingAssetCount: 1,
};

const items: HrLifecycleChecklistDetail['items'] = [
  {
    id: 'hr-life-item-ui-1',
    checklistId: checklist.id,
    category: 'OTHER',
    title: 'Exit interview and knowledge transfer',
    description: 'Complete the exit conversation.',
    required: true,
    status: 'PENDING',
    action: 'NONE',
    assetId: null,
    assetTagNumber: null,
    assetName: null,
    assetCategory: null,
    assetStatus: null,
    assetBranchId: null,
    assetAssignedEmployeeId: null,
    sortOrder: 10,
    completedBy: null,
    completedAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  },
  {
    id: 'hr-life-item-ui-2',
    checklistId: checklist.id,
    category: 'ASSET',
    title: 'Return LIFE-ASSET-201 — Field laptop',
    description: 'Return this assigned fixed asset.',
    required: true,
    status: 'PENDING',
    action: 'RETURN_ASSET',
    assetId: 'hr-life-asset-ui-1',
    assetTagNumber: 'LIFE-ASSET-201',
    assetName: 'Field laptop',
    assetCategory: 'Equipment',
    assetStatus: 'IN_USE',
    assetBranchId: 'WH001',
    assetAssignedEmployeeId: checklist.employeeId,
    sortOrder: 20,
    completedBy: null,
    completedAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  },
  {
    id: 'hr-life-item-ui-3',
    checklistId: checklist.id,
    category: 'ACCOUNT',
    title: 'Deactivate linked user account',
    description: 'Set the linked sign-in account inactive.',
    required: true,
    status: 'PENDING',
    action: 'DEACTIVATE_ACCOUNT',
    assetId: null,
    assetTagNumber: null,
    assetName: null,
    assetCategory: null,
    assetStatus: null,
    assetBranchId: null,
    assetAssignedEmployeeId: null,
    sortOrder: 30,
    completedBy: null,
    completedAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  },
];

const detail: HrLifecycleChecklistDetail = {
  ...checklist,
  account: {
    userId: 'hr-life-account-ui-1',
    email: 'life-ui@example.com',
    name: 'Lifecycle UI Account',
    status: 'active',
    role: 'FRONT_DESK',
  },
  items,
  custody: null,
  availableAssets: [
    {
      id: 'hr-life-asset-ui-2',
      tagNumber: 'LIFE-ASSET-202',
      name: 'Spare handset',
      category: 'Equipment',
      status: 'ACTIVE',
      branchId: 'WH001',
      assignedEmployeeId: null,
    },
  ],
};

const employees = [
  {
    id: checklist.employeeId,
    employeeCode: checklist.employeeCode,
    name: checklist.employeeName,
    branchId: 'WH001',
    isActive: true,
  },
] as EmployeeRecord[];

test('lifecycle is route, nav, path, permission and preload wired', () => {
  const screen = readFileSync('client/src/features/hr/Lifecycle.tsx', 'utf8');
  assert.match(screen, /useActivationKey\('hr-lifecycle'\)/);
  assert.match(screen, /getHrLifecycleChecklists/);
  assert.match(screen, /completeHrLifecycleChecklistItem/);
  assert.match(screen, /addHrLifecycleChecklistItem/);
  assert.match(screen, /isOperationAllowed\('hr-employee-view'/);

  const app = readScreenRoutes();
  assert.match(app, /screenRoute\('hr-lifecycle'/);
  assert.match(app, /<Lifecycle user=\{currentUser\} branchId=\{selectedBranchId\} \/>/);
  const paths = readFileSync('client/src/routes/appPaths.ts', 'utf8');
  assert.ok(paths.includes("'hr-lifecycle': '/people/lifecycle'"));
  const tabs = readFileSync('client/src/routes/tabPermissions.ts', 'utf8');
  assert.match(tabs, /const HR_VIEW = \['hr-employee-view', 'gl-payroll-manage'\]/);
  assert.ok(tabs.includes("'hr-lifecycle': HR_VIEW"));
  const preload = readFileSync('client/src/screenPreload.ts', 'utf8');
  assert.ok(preload.includes("'hr-lifecycle': () => import('./features/hr/Lifecycle')"));
  const sidebar = readFileSync('client/src/components/layout/Sidebar.tsx', 'utf8');
  assert.match(sidebar, /label: 'Onboarding'/);
});

test('the screen renders summaries, generated asset/account items, completion confirmation and Refresh', async () => {
  const calls = { list: 0, detail: 0, employees: 0, completed: 0 };
  const scopes: any[] = [];
  const completedItems: Array<[string, string]> = [];
  const restore = installApiStubs({
    getHrLifecycleChecklists: async (options: any) => {
      calls.list += 1;
      scopes.push(options);
      return [checklist];
    },
    getHrLifecycleChecklist: async () => {
      calls.detail += 1;
      return detail;
    },
    getEmployees: async () => {
      calls.employees += 1;
      return employees;
    },
    completeHrLifecycleChecklistItem: async (...args: any[]) => {
      calls.completed += 1;
      completedItems.push([String(args[0]), String(args[1])]);
      return items[2];
    },
  });
  const tree = mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(Lifecycle, {
        user: smokeUser,
        branchId: 'WH001',
      })
    )
  );
  try {
    assert.ok(
      await settleUntil(() => (tree.container.textContent || '').includes('Lifecycle UI Employee')),
      'the selected checklist must render'
    );
    const text = tree.container.textContent || '';
    assert.match(text, /Onboarding & Offboarding/);
    assert.match(text, /Lifecycle checklists/);
    assert.match(text, /Deactivate linked user account/);
    assert.match(text, /Return LIFE-ASSET-201/);
    assert.match(text, /Lifecycle UI Account/);
    assert.match(text, /Asset custody/);
    assert.match(text, /Complete checklist/);
    assert.equal(
      tree.container.querySelector('[data-testid="lifecycle-summary-active"]')?.textContent,
      '1'
    );
    assert.equal(
      tree.container.querySelector('[data-testid="lifecycle-summary-pending"]')?.textContent,
      '3'
    );
    assert.equal(
      tree.container.querySelector('[data-testid="lifecycle-summary-assets"]')?.textContent,
      '1'
    );
    assert.deepEqual(scopes, [{ branchId: 'WH001' }]);

    const accountRow = [...tree.container.querySelectorAll('tr')].find((row) =>
      (row.textContent || '').includes('Deactivate linked user account')
    );
    assert.ok(accountRow, 'the account item must be in the items table');
    const complete = [...accountRow!.querySelectorAll('button')].find(
      (button) => (button.textContent || '').trim() === 'Complete'
    ) as HTMLButtonElement | undefined;
    assert.ok(complete, 'a pending item must offer Complete');
    inAct(() => complete!.click());
    assert.ok(
      await settleUntil(() => Boolean(document.querySelector('[role="dialog"]'))),
      'completing an account item must ask for confirmation'
    );
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    assert.match(dialog.textContent || '', /Deactivate life-ui@example.com/);
    const confirm = [...dialog.querySelectorAll('button')].find((button) =>
      (button.textContent || '').includes('Complete item')
    ) as HTMLButtonElement | undefined;
    assert.ok(confirm, 'the dialog must name the item action');
    inAct(() => confirm!.click());
    assert.ok(
      await settleUntil(() => calls.completed === 1),
      'the confirmation must call the item-completion endpoint'
    );
    assert.deepEqual(completedItems, [[checklist.id, 'hr-life-item-ui-3']]);

    const beforeRefresh = { ...calls };
    const refresh = tree.container.querySelector(
      'button[data-testid="lifecycle-refresh"]'
    ) as HTMLButtonElement | null;
    assert.ok(refresh);
    inAct(() => refresh!.click());
    assert.ok(
      await settleUntil(
        () =>
          calls.list === beforeRefresh.list + 1 &&
          calls.detail === beforeRefresh.detail + 1 &&
          calls.employees === beforeRefresh.employees + 1
      ),
      'Refresh must re-read the checklist list, selected detail and employee picker'
    );

    const create = tree.container.querySelector(
      'button[data-testid="lifecycle-new"]'
    ) as HTMLButtonElement | null;
    assert.ok(create);
    inAct(() => create!.click());
    assert.match(tree.container.textContent || '', /New lifecycle checklist/);
  } finally {
    tree.unmount();
    restore();
  }
});

test('the offboarding custody item is derived from the holdings and cannot be completed by hand', async () => {
  const withCustody: HrLifecycleChecklistDetail = {
    ...detail,
    custody: {
      items: 1,
      units: 2,
      products: [
        { product_id: 'prd-onu', product_code: 'ONU-100', product_name: 'ONU Router 1-Port GPON', quantity: 2 },
      ],
    },
  };
  const restore = installApiStubs({
    getHrLifecycleChecklists: async () => [checklist],
    getHrLifecycleChecklist: async () => withCustody,
    getEmployees: async () => employees,
  });
  const tree = mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(Lifecycle, { user: smokeUser, branchId: 'WH001' })
    )
  );
  try {
    assert.ok(
      await settleUntil(() => (tree.container.textContent || '').includes('Return issued stock equipment')),
      'the derived custody item must render on an offboarding checklist'
    );
    const text = tree.container.textContent || '';
    assert.match(text, /ONU Router 1-Port GPON × 2/, 'it names the products and quantities held');
    assert.match(text, /Outstanding/);
    assert.match(text, /cannot be checked off by hand/);
    assert.match(text, /still issued/);
    assert.ok(
      tree.container.querySelector('[data-testid="lifecycle-custody-block"]'),
      'the block banner must be shown while units remain'
    );
    assert.ok(
      tree.container.querySelector('[data-testid="lifecycle-custody-item"]'),
      'the custody item must be a row in the checklist table'
    );
    const custodyRow = tree.container.querySelector('[data-testid="lifecycle-custody-item"]') as HTMLElement;
    const custodyButtons = [...custodyRow.querySelectorAll('button')];
    assert.equal(custodyButtons.length, 0, 'the custody item offers no complete action');
  } finally {
    tree.unmount();
    restore();
  }
});

test('a returned custody item reads as satisfied and the banner is gone', async () => {
  const settled: HrLifecycleChecklistDetail = {
    ...detail,
    custody: { items: 0, units: 0, products: [] },
  };
  const restore = installApiStubs({
    getHrLifecycleChecklists: async () => [checklist],
    getHrLifecycleChecklist: async () => settled,
    getEmployees: async () => employees,
  });
  const tree = mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(Lifecycle, { user: smokeUser, branchId: 'WH001' })
    )
  );
  try {
    assert.ok(
      await settleUntil(() => (tree.container.textContent || '').includes('Nothing is issued to this employee')),
      'the satisfied custody item must render'
    );
    const text = tree.container.textContent || '';
    assert.match(text, /Satisfied/);
    assert.doesNotMatch(text, /still issued/);
    assert.equal(tree.container.querySelector('[data-testid="lifecycle-custody-block"]'), null);
  } finally {
    tree.unmount();
    restore();
  }
});

test('an empty branch scope shows explicit empty states', async () => {
  const restore = installApiStubs({
    getHrLifecycleChecklists: async () => [],
    getHrLifecycleChecklist: async () => null,
    getEmployees: async () => [],
  });
  const tree = mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(Lifecycle, {
        user: smokeUser,
        branchId: 'WH001',
      })
    )
  );
  try {
    assert.ok(
      await settleUntil(() =>
        (tree.container.textContent || '').includes(
          'No onboarding or offboarding checklists in this branch scope yet'
        )
      ),
      'the empty checklist state must render'
    );
    const text = tree.container.textContent || '';
    assert.match(text, /No onboarding or offboarding checklists in this branch scope yet/);
    assert.match(text, /Select a checklist to see its items and linked account/);
    assert.equal(
      tree.container.querySelector('[data-testid="lifecycle-summary-active"]')?.textContent,
      '0'
    );
  } finally {
    tree.unmount();
    restore();
  }
});

test('a role without the HR read grant is refused without calling any endpoint', async () => {
  applyEffectivePermissions([], 'FRONT_DESK');
  let reads = 0;
  const restore = installApiStubs({
    getHrLifecycleChecklists: async () => {
      reads += 1;
      return [];
    },
    getHrLifecycleChecklist: async () => {
      reads += 1;
      return null;
    },
    getEmployees: async () => {
      reads += 1;
      return [];
    },
  });
  const frontDesk = {
    ...bootstrapFixture,
    id: 'u-lifecycle-front-desk',
    role: 'FRONT_DESK',
    branchId: 'WH001',
  } as any;
  const tree = mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(Lifecycle, {
        user: frontDesk,
        branchId: 'WH001',
      })
    )
  );
  try {
    assert.match(
      tree.container.textContent || '',
      /Lifecycle checklists are available to accounts with the HR employee-view or payroll permission/i
    );
    assert.equal(reads, 0, 'the refusal must not call any lifecycle endpoint');
  } finally {
    tree.unmount();
    restore();
    applyEffectivePermissions(null);
  }
});
