/**
 * Settings → User Access & Exceptions — the per-user exception editor.
 *
 * PROVES
 *   1. The client resolves a grant/deny from the EFFECTIVE set the server
 *      returned, but only for the role that set was resolved for, so one
 *      person's exception cannot leak into a same-tab check for another role.
 *   2. A granted tab becomes accessible for that grant's role and clears again
 *      when the set is cleared (sign-out / profile switch).
 *   3. The tri-state draft keeps only differences, requires a reason, refuses
 *      an impossible/past expiry, and sends a deterministic replace payload
 *      with the expiry at the end of the chosen local day.
 *   4. The screen is reachable only by a Super Admin (tab table + sidebar +
 *      route), names the account it edits, and never asks for a raw
 *      window.confirm.
 *   5. The editor actually renders: selecting a user shows the role's base
 *      answer, Grant reveals the reason field, and Save sends the typed reason.
 *   6. The two access screens state their scope, link to each other, and open
 *      the chosen person from Users (deleted targets are ignored).
 *   7. Two users with the same role stay independent: a grant to A never
 *      appears for B, and the edit modal summarizes A's extra permission.
 *   8. A role-matrix cell opens the accounts whose personal exception changes
 *      that operation's saved role answer.
 */
import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement as h } from 'react';
import { mountTree } from './harness/mount';
import { DialogProvider } from '../client/src/components/common/DialogProvider';
import { UserPermissions } from '../client/src/features/settings/UserPermissions';
import { UsersManagement } from '../client/src/features/settings/UsersManagement';
import { PermissionManagement } from '../client/src/features/settings/PermissionManagement';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';
import {
  applyEffectivePermissions,
  isOperationAllowed,
} from '../client/src/utils/permissions';
import { isTabAccessible } from '../client/src/routes/tabPermissions';
import { api } from '../client/src/services/api';
import type { User } from '../client/src/types';
import {
  countDraftChanges,
  draftEffectFor,
  draftsFingerprint,
  draftsFromOverrides,
  draftsToPayload,
  effectivePreview,
  expiryInstant,
  setDraftEffect,
  updateDraft,
  validateDrafts,
} from '../client/src/utils/userPermissionDraft';

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

const manager = {
  id: 'u-manager',
  name: 'Sita Sharma',
  email: 'sita@example.com',
  role: 'BRANCH_MANAGER',
  branchId: 'branch-1',
  allowedBranchIds: ['branch-1'],
  status: 'active',
  canSwitchUser: false,
} as User;

const superAdmin = {
  id: 'u-root',
  name: 'Root Admin',
  email: 'root@example.com',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  status: 'active',
  canSwitchUser: true,
} as User;

describe('client effective permissions', () => {
  afterEach(() => applyEffectivePermissions(null));

  test('a grant resolves for its own role and not for another role', () => {
    assert.equal(isOperationAllowed('inv-pay', 'BRANCH_MANAGER'), false, 'role default is denied');
    assert.equal(isTabAccessible('vendor-ledger', manager), false);

    applyEffectivePermissions(['inv-pay'], 'BRANCH_MANAGER');
    assert.equal(isOperationAllowed('inv-pay', 'BRANCH_MANAGER'), true);
    assert.equal(isTabAccessible('vendor-ledger', manager), true, 'the granted tab appears');

    // FRONT_DESK also has inv-pay denied in the matrix; the manager's resolved
    // set must not answer for a different role rendered in the same tab.
    assert.equal(isOperationAllowed('inv-pay', 'FRONT_DESK'), false);
  });

  test('a deny closes a normally allowed operation and its tab', () => {
    assert.equal(isTabAccessible('product-master', manager), true);
    applyEffectivePermissions(['inv-pay'], 'BRANCH_MANAGER');
    assert.equal(isOperationAllowed('prod-view', 'BRANCH_MANAGER'), false);
    assert.equal(isTabAccessible('product-master', manager), false);
  });

  test('clearing the set returns every gate to the role matrix', () => {
    applyEffectivePermissions(['inv-pay'], 'BRANCH_MANAGER');
    applyEffectivePermissions(null);
    assert.equal(isOperationAllowed('inv-pay', 'BRANCH_MANAGER'), false);
    assert.equal(isTabAccessible('vendor-ledger', manager), false);
  });

  test('Super Admin stays fully allowed even with an empty resolved set', () => {
    applyEffectivePermissions([], 'SUPER_ADMIN');
    assert.equal(isOperationAllowed('inv-pay', 'SUPER_ADMIN'), true);
    assert.equal(isOperationAllowed('admin-users', 'SUPER_ADMIN'), true);
  });

  test('an operation-level branch/procurement switch still wins over a grant', () => {
    applyEffectivePermissions(['po-create'], 'BRANCH_MANAGER');
    assert.equal(isOperationAllowed('po-create', 'BRANCH_MANAGER', false), false);
    assert.equal(isOperationAllowed('po-create', 'BRANCH_MANAGER', true), true);
  });
});

describe('user permission drafts', () => {
  test('reads stored rows as date-only drafts and no row means inherit', () => {
    const drafts = draftsFromOverrides([
      {
        operationId: 'inv-pay',
        effect: 'grant',
        reason: 'settles vendor bills',
        expiresAt: '2026-12-31T18:15:00.000Z',
      },
    ]);
    assert.deepEqual(drafts, {
      'inv-pay': { effect: 'grant', reason: 'settles vendor bills', expiresAt: '2026-12-31' },
    });
    assert.equal(draftEffectFor(drafts, 'prod-edit'), 'inherit');
  });

  test('tri-state keeps only differences and preserves a typed reason', () => {
    let drafts = setDraftEffect({}, 'inv-pay', 'grant');
    drafts = updateDraft(drafts, 'inv-pay', { reason: 'vendor desk' });
    drafts = setDraftEffect(drafts, 'inv-pay', 'deny');
    assert.deepEqual(drafts['inv-pay'], { effect: 'deny', reason: 'vendor desk', expiresAt: null });

    drafts = setDraftEffect(drafts, 'inv-pay', 'inherit');
    assert.deepEqual(drafts, {}, 'Inherit removes the row rather than storing a third effect');
  });

  test('every exception needs a reason and an expiry must be a real future date', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const validation = validateDrafts({
      'inv-pay': { effect: 'grant', reason: '   ', expiresAt: null },
      'fin-statements': { effect: 'deny', reason: 'sod', expiresAt: past },
      'prod-edit': { effect: 'grant', reason: 'returns desk', expiresAt: '2999-02-31' },
    });
    assert.equal(validation.ok, false);
    assert.equal(validation.errors['inv-pay'], 'A reason is required for an exception.');
    assert.equal(validation.errors['fin-statements'], 'Expiry must be a future date.');
    assert.equal(validation.errors['prod-edit'], 'Expiry must be a future date.');

    assert.equal(expiryInstant('2026-02-31'), null, 'normalised impossible dates are refused');
    assert.equal(
      validateDrafts({ 'inv-pay': { effect: 'grant', reason: 'ok', expiresAt: '2999-12-31' } }).ok,
      true
    );
  });

  test('the replace payload is sorted, trimmed and expires at end of the local day', () => {
    const payload = draftsToPayload({
      'prod-edit': { effect: 'grant', reason: '  returns desk  ', expiresAt: null },
      'inv-pay': { effect: 'deny', reason: 'segregation', expiresAt: '2999-12-31' },
    });
    assert.deepEqual(
      payload.map((entry) => entry.operationId),
      ['inv-pay', 'prod-edit']
    );
    assert.equal(payload[0].reason, 'segregation');
    assert.equal(payload[1].reason, 'returns desk');
    assert.equal(payload[0].expiresAt, expiryInstant('2999-12-31')!.toISOString());
    assert.equal(payload[1].expiresAt, null);
  });

  test('counts and the effective preview agree with the drafts', () => {
    const base = { 'inv-pay': false, 'prod-view': true, 'fin-statements': true };
    const drafts = {
      'inv-pay': { effect: 'grant' as const, reason: 'vendor', expiresAt: null },
      'fin-statements': { effect: 'deny' as const, reason: 'sod', expiresAt: null },
    };
    assert.deepEqual(countDraftChanges(drafts), { grants: 1, denies: 1, total: 2 });
    assert.deepEqual(effectivePreview(base, drafts), { allowed: 2, total: 3 });
    // A set grant counts as allowed in the preview; a deny still wins.
    assert.deepEqual(
      effectivePreview(base, drafts, new Set(['prod-view'])),
      { allowed: 2, total: 3 }
    );
    assert.deepEqual(
      effectivePreview(base, {}, new Set(['prod-view'])),
      { allowed: 2, total: 3 },
      'the set-granted role-denied operation joins the effective total'
    );
    assert.equal(draftsFingerprint(drafts), draftsFingerprint({ ...drafts }));
    assert.notEqual(
      draftsFingerprint(drafts),
      draftsFingerprint({ ...drafts, 'inv-pay': { ...drafts['inv-pay'], reason: 'changed' } })
    );
  });
});

describe('user permissions screen wiring', () => {
  test('the tab is Super Admin only and is reachable from the sidebar and route table', () => {
    const tabs = read('client/src/routes/tabPermissions.ts');
    assert.match(tabs, /SUPER_ADMIN_ONLY_TABS[^=]*= \[[\s\S]*'permissions',\s*'user-permissions',/);
    assert.equal(isTabAccessible('user-permissions', manager), false);
    assert.equal(isTabAccessible('user-permissions', superAdmin), true);

    const sidebar = read('client/src/components/layout/Sidebar.tsx');
    assert.match(sidebar, /id: 'user-permissions' as NavTab/);
    assert.match(sidebar, /if \(isSuperAdmin\) \{\s*adminChildren\.push\([\s\S]*'user-permissions'/);

    const app = read('client/src/App.tsx');
    assert.match(app, /screenRoute\(\s*'user-permissions'/);
    assert.match(app, /<UserPermissions[\s\S]*users=\{users\}/);
  });

  test('the two access screens state their scope and link to each other', () => {
    const sidebar = read('client/src/components/layout/Sidebar.tsx');
    assert.match(sidebar, /label: 'Role Permission Defaults'/);
    assert.match(sidebar, /label: 'User Access & Exceptions'/);

    const matrix = read('client/src/features/settings/PermissionManagement.tsx');
    assert.match(matrix, /The baseline every user with a role inherits/);
    assert.match(matrix, /onOpenUserAccess/);

    const screen = read('client/src/features/settings/UserPermissions.tsx');
    assert.match(screen, /One person.s effective access/);
    assert.match(screen, /To add an extra permission/);
    assert.match(screen, /onOpenRoleDefaults/);

    const app = read('client/src/App.tsx');
    assert.match(app, /onOpenUserAccess=\{\(target\) => \{/);
    assert.match(app, /openUserAccess\(target\.userId, target\.operationId\)/);
    assert.match(app, /onOpenRoleDefaults=\{\(\) => setActiveTab\('permissions'\)\}/);
  });

  test('App resolves the effective set on identity changes and clears it on exit', () => {
    const app = read('client/src/App.tsx');
    assert.match(app, /api\.getMyPermissions\(\)/);
    assert.match(app, /applyEffectivePermissions\(resolved\.operations, resolved\.role \|\| user\.role\)/);
    assert.match(
      app,
      /applyEffectivePermissions\(null\)/,
      'sign-out, sign-in and profile switches all clear the previous set'
    );
    const clears = (app.match(/applyEffectivePermissions\(null\)/g) || []).length;
    assert.ok(clears >= 4, `expected every session boundary to clear, found ${clears}`);
  });

  test('the editor requires a reason, supports expiry, and never uses a raw dialog', () => {
    const screen = read('client/src/features/settings/UserPermissions.tsx');
    assert.match(screen, /validateDrafts\(drafts\)/);
    assert.match(screen, /placeholder="Why does this exception exist\?"/);
    assert.match(screen, /<DateField[\s\S]*label="Expiry \(optional\)"/);
    assert.match(screen, /Role: \{baseAllowed \? 'allowed' : 'denied'\}/);
    assert.match(screen, /Super Admin always has every operation; overrides do not apply\./);
    assert.match(screen, /Grants widen what this person can do, not which branches or rows they can see\./);
    assert.match(screen, /Assigned permission sets/);
    assert.match(screen, /PermissionSetsPanel/);
    assert.doesNotMatch(screen, /window\.confirm|window\.alert|window\.prompt/);
  });
});

// ---------------------------------------------------------------------------
// Rendered editor: one real interaction, not just source text
// ---------------------------------------------------------------------------

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const click = (element: Element) => {
  act(() => {
    (element as HTMLElement).click();
  });
};

const setInputValue = (input: HTMLInputElement, value: string) => {
  const InputCtor = (globalThis as any).window.HTMLInputElement as typeof HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(InputCtor.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const setSelectValue = (select: HTMLSelectElement, value: string) => {
  const SelectCtor = (globalThis as any).window.HTMLSelectElement as typeof HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(SelectCtor.prototype, 'value')!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

describe('user permissions editor render', () => {
  // UsersManagement reads one bulk summary on mount. Every mount in this suite
  // gets an empty, deterministic answer unless the test overrides it.
  const originalGetUserAccessSummaries = api.getUserAccessSummaries;
  beforeEach(() => {
    api.getUserAccessSummaries = async () => ({ users: [], total: 46, version: 1 });
  });
  afterEach(() => {
    api.getUserAccessSummaries = originalGetUserAccessSummaries;
  });

  test('selecting a user shows the role answer; Grant asks for a reason and Save sends it', async () => {
    const base: Record<string, boolean> = {};
    for (const [operationId, roles] of Object.entries(DEFAULT_PERMISSIONS_MATRIX)) {
      base[operationId] = Boolean((roles as Record<string, boolean>).BRANCH_MANAGER);
    }
    const emptyResponse = {
      userId: manager.id,
      role: 'BRANCH_MANAGER',
      base,
      overrides: [],
      setIds: [],
      operations: Object.keys(base).filter((operationId) => base[operationId]),
      version: 3,
    };
    let savedPayload: unknown = null;
    const originalGet = api.getUserPermissionOverrides;
    const originalSave = api.saveUserPermissionOverrides;
    const originalGetSets = api.getPermissionSets;
    api.getUserPermissionOverrides = async () => emptyResponse;
    api.getPermissionSets = async () => [];
    api.saveUserPermissionOverrides = async (_userId: string, overrides: any) => {
      savedPayload = overrides;
      return {
        ...emptyResponse,
        overrides: overrides.map((entry: any) => ({ ...entry, expired: false })),
      };
    };

    const tree = mountTree(
      h(DialogProvider, null, h(UserPermissions, {
        currentUser: superAdmin,
        users: [manager],
        branches: [],
        dateMode: 'AD',
      }))
    );
    try {
      await flush();
      await flush();

      assert.match(tree.container.textContent || '', /Sita Sharma/);
      assert.match(tree.container.textContent || '', /Process Vendor Payment Settlements/);
      assert.match(tree.container.textContent || '', /Role: denied/);

      const operationLabel = [...tree.container.querySelectorAll('p')].find(
        (node) => node.textContent?.trim() === 'Process Vendor Payment Settlements'
      );
      assert.ok(operationLabel, 'the inv-pay operation must render');
      const row = operationLabel!.closest('div.p-3') as HTMLElement;
      assert.ok(row, 'the operation row must be addressable');
      const grant = [...row.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Grant'
      );
      assert.ok(grant, 'each operation must offer a Grant state');
      click(grant!);
      await flush();

      const reason = row.querySelector(
        'input[placeholder="Why does this exception exist?"]'
      ) as HTMLInputElement | null;
      assert.ok(reason, 'Grant must reveal the required reason field');
      setInputValue(reason!, 'settles vendor bills');
      await flush();
      assert.equal(reason!.value, 'settles vendor bills');

      const save = [...tree.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Save 1 exception')
      );
      assert.ok(save, 'Save must name the staged exception count');
      click(save!);
      await flush();
      await flush();

      assert.deepEqual(savedPayload, [
        {
          operationId: 'inv-pay',
          effect: 'grant',
          reason: 'settles vendor bills',
          expiresAt: null,
        },
      ]);
      assert.match(tree.container.textContent || '', /Saved\./);
    } finally {
      tree.unmount();
      api.getUserPermissionOverrides = originalGet;
      api.saveUserPermissionOverrides = originalSave;
      api.getPermissionSets = originalGetSets;
    }
  });

  test('ticking a permission set sends setIds and marks the grant as set-sourced', async () => {
    const base: Record<string, boolean> = {};
    for (const [operationId, roles] of Object.entries(DEFAULT_PERMISSIONS_MATRIX)) {
      base[operationId] = Boolean((roles as Record<string, boolean>).BRANCH_MANAGER);
    }
    const emptyResponse = {
      userId: manager.id,
      role: 'BRANCH_MANAGER',
      base,
      overrides: [],
      setIds: [],
      operations: Object.keys(base).filter((operationId) => base[operationId]),
      version: 4,
    };
    const set = {
      id: 'set-vendor-desk',
      name: 'Vendor desk',
      description: 'shared vendor desk grants',
      grants: ['inv-pay'],
      members: [],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    let savedSetIds: string[] | null = null;
    const originalGet = api.getUserPermissionOverrides;
    const originalSave = api.saveUserPermissionOverrides;
    const originalGetSets = api.getPermissionSets;
    const originalSaveSets = api.saveUserPermissionSets;
    api.getUserPermissionOverrides = async () => emptyResponse;
    api.getPermissionSets = async () => [set];
    api.saveUserPermissionOverrides = originalSave;
    api.saveUserPermissionSets = async (_userId: string, setIds: string[]) => {
      savedSetIds = setIds;
      return {
        ...emptyResponse,
        setIds,
        operations: [...emptyResponse.operations, 'inv-pay'],
      };
    };

    const tree = mountTree(
      h(DialogProvider, null, h(UserPermissions, {
        currentUser: superAdmin,
        users: [manager],
        branches: [],
        dateMode: 'AD',
      }))
    );
    try {
      await flush();
      await flush();

      assert.match(tree.container.textContent || '', /Vendor desk/);
      assert.match(tree.container.textContent || '', /Assigned permission sets/);

      const checkbox = tree.container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      assert.ok(checkbox, 'the assigned-set card must render a checkbox per set');
      click(checkbox!);
      await flush();

      assert.match(
        tree.container.textContent || '',
        /Granted by a set/,
        'the granted operation must name the set as its source'
      );

      const save = [...tree.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Save set assignments')
      );
      assert.ok(save, 'the card must offer Save set assignments');
      click(save!);
      await flush();
      await flush();

      assert.deepEqual(savedSetIds, ['set-vendor-desk']);
      assert.match(tree.container.textContent || '', /Saved\. The new set grants apply immediately\./);
    } finally {
      tree.unmount();
      api.getUserPermissionOverrides = originalGet;
      api.saveUserPermissionOverrides = originalSave;
      api.getPermissionSets = originalGetSets;
      api.saveUserPermissionSets = originalSaveSets;
    }
  });

  test('a focus request opens the requested account and ignores a missing one', async () => {
    const secondUser = {
      ...manager,
      id: 'u-second',
      name: 'Ram Thapa',
      email: 'ram@example.com',
      role: 'FRONT_DESK',
    } as User;
    const base = { 'inv-pay': false, 'prod-view': true };
    const seen: string[] = [];
    const originalGet = api.getUserPermissionOverrides;
    const originalGetSets = api.getPermissionSets;
    api.getUserPermissionOverrides = async (userId) => {
      seen.push(userId);
      return {
        userId,
        role: 'FRONT_DESK',
        base,
        overrides: [],
        setIds: [],
        operations: ['prod-view'],
        version: 1,
      };
    };
    api.getPermissionSets = async () => [];

    const tree = mountTree(
      h(DialogProvider, null, h(UserPermissions, {
        currentUser: superAdmin,
        users: [manager, secondUser],
        branches: [],
        dateMode: 'AD',
        focusRequest: { userId: secondUser.id, requestId: 7, operationId: 'inv-pay' },
      }))
    );
    try {
      await flush();
      await flush();
      const active = tree.container.querySelector('[aria-current="true"]');
      assert.ok(active, 'the user list must expose the active account');
      assert.match(active!.textContent || '', /Ram Thapa/);
      assert.ok(seen.includes(secondUser.id), 'the focus request must load that account');

      const focusedRow = tree.container.querySelector('[data-focused-operation="inv-pay"]');
      assert.ok(focusedRow, 'the requested operation must be revealed');
      assert.match(focusedRow!.textContent || '', /Process Vendor Payment Settlements/);
      assert.match(focusedRow!.textContent || '', /Opened from role matrix/);

      // An active filter must not hide the operation a new request names.
      const differencesOnly = [...tree.container.querySelectorAll('label')]
        .find((node) => node.textContent?.includes('Show only differences'))
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      assert.ok(differencesOnly);
      click(differencesOnly!);
      await flush();
      assert.equal(tree.container.querySelector('[data-focused-operation="inv-pay"]'), null);

      tree.rerender(
        h(DialogProvider, null, h(UserPermissions, {
          currentUser: superAdmin,
          users: [manager, secondUser],
          branches: [],
          dateMode: 'AD',
          focusRequest: { userId: secondUser.id, requestId: 9, operationId: 'inv-pay' },
        }))
      );
      await flush();
      await flush();
      assert.ok(
        tree.container.querySelector('[data-focused-operation="inv-pay"]'),
        'a new request must reveal the row again through an active filter'
      );
    } finally {
      tree.unmount();
    }

    const missingTree = mountTree(
      h(DialogProvider, null, h(UserPermissions, {
        currentUser: superAdmin,
        users: [manager, secondUser],
        branches: [],
        dateMode: 'AD',
        focusRequest: { userId: 'deleted-user', requestId: 8 },
      }))
    );
    try {
      await flush();
      await flush();
      const active = missingTree.container.querySelector('[aria-current="true"]');
      assert.ok(active);
      assert.match(active!.textContent || '', /Sita Sharma/, 'a stale target must not blank the editor');
    } finally {
      missingTree.unmount();
      api.getUserPermissionOverrides = originalGet;
      api.getPermissionSets = originalGetSets;
    }
  });

  test('Users offers Access to a Super Admin, shows the bulk access summary and routes the clicked account', async () => {
    const originalOverrides = api.getUserPermissionOverrides;
    const originalSummaries = api.getUserAccessSummaries;
    api.getUserAccessSummaries = async () => ({
      users: [{
        userId: manager.id,
        role: 'BRANCH_MANAGER',
        effective: 20,
        total: 46,
        grants: 1,
        denies: 0,
        setCount: 2,
        nextExpiry: null,
        operations: ['inv-delete', 'prod-view'],
      }],
      total: 46,
      version: 6,
    });
    api.getUserPermissionOverrides = async () => ({
      userId: manager.id,
      role: 'BRANCH_MANAGER',
      base: { 'inv-delete': false },
      overrides: [{
        operationId: 'inv-delete',
        effect: 'grant',
        reason: 'deletes voided bills',
        expiresAt: null,
        expired: false,
      }],
      setIds: [],
      operations: ['inv-delete'],
      version: 6,
    });

    let target = '';
    const tree = mountTree(
      h(DialogProvider, null, h(UsersManagement, {
        currentUser: superAdmin,
        users: [manager],
        branches: [],
        onManageAccess: (userId) => {
          target = userId;
        },
      }))
    );
    try {
      await flush();
      const text = tree.container.textContent || '';
      assert.match(text, /Effective 20 of 46 operations/);
      assert.match(text, /1 grant/);
      assert.match(text, /0 denies/);
      assert.match(text, /2 sets/);

      const details = [...tree.container.querySelectorAll('button')].find(
        (node) => node.textContent?.trim() === 'Details'
      );
      assert.ok(details, 'each card must offer the read-only details expander');
      click(details!);
      await flush();
      await flush();
      assert.match(tree.container.textContent || '', /Delete Purchase Invoices \(PI\)/);
      assert.match(tree.container.textContent || '', /deletes voided bills/);
      assert.match(tree.container.textContent || '', /Role: denied/);

      const button = [...tree.container.querySelectorAll('button')].find((node) =>
        node.textContent?.includes('Access & permissions')
      );
      assert.ok(button, 'a Super Admin must see the per-user access entry point');
      click(button!);
      assert.equal(target, manager.id);
    } finally {
      tree.unmount();
      api.getUserAccessSummaries = originalSummaries;
      api.getUserPermissionOverrides = originalOverrides;
    }

    const headOfficeAdmin = { ...superAdmin, id: 'u-head', role: 'HEAD_OFFICE_ADMIN' } as User;
    const headOfficeTree = mountTree(
      h(DialogProvider, null, h(UsersManagement, {
        currentUser: headOfficeAdmin,
        users: [manager],
        branches: [],
        onManageAccess: () => undefined,
      }))
    );
    try {
      assert.doesNotMatch(
        headOfficeTree.container.textContent || '',
        /Access & permissions/,
        'a non-Super-Admin must not be offered the access editor'
      );
    } finally {
      headOfficeTree.unmount();
    }

    const superTargetTree = mountTree(
      h(DialogProvider, null, h(UsersManagement, {
        currentUser: superAdmin,
        users: [superAdmin],
        branches: [],
        onManageAccess: () => undefined,
      }))
    );
    try {
      await flush();
      assert.doesNotMatch(
        superTargetTree.container.textContent || '',
        /Access & permissions/,
        'a Super Admin target has no editable access'
      );
      assert.match(
        superTargetTree.container.textContent || '',
        /Full access by role/,
        'the card must state that exceptions do not apply to a Super Admin'
      );
    } finally {
      superTargetTree.unmount();
    }
  });

  test('the register filters by personal exceptions and by effective operation', async () => {
    const accountant = {
      ...manager,
      id: 'u-accountant',
      name: 'Hari K.C.',
      email: 'hari@example.com',
      role: 'ACCOUNTANT',
    } as User;
    const originalSummaries = api.getUserAccessSummaries;
    const originalUrl = window.location.href;
    // A shared link: the tab and both filters must be restored on a fresh mount.
    window.history.replaceState(
      null,
      '',
      '/?tab=users&access=exceptions&operation=inv-delete'
    );
    api.getUserAccessSummaries = async () => ({
      users: [
        {
          userId: manager.id,
          role: 'BRANCH_MANAGER',
          effective: 20,
          total: 46,
          grants: 1,
          denies: 0,
          setCount: 0,
          nextExpiry: null,
          operations: ['inv-delete', 'prod-view'],
        },
        {
          userId: accountant.id,
          role: 'ACCOUNTANT',
          effective: 30,
          total: 46,
          grants: 0,
          denies: 0,
          setCount: 0,
          nextExpiry: null,
          operations: ['fin-statements', 'prod-view'],
        },
      ],
      total: 46,
      version: 7,
    });

    const tree = mountTree(
      h(DialogProvider, null, h(UsersManagement, {
        currentUser: superAdmin,
        users: [manager, accountant],
        branches: [],
      }))
    );
    try {
      await flush();
      await flush();

      const access = tree.container.querySelector(
        'select[aria-label="Access filter"]'
      ) as HTMLSelectElement | null;
      const operation = tree.container.querySelector(
        'select[aria-label="Effective operation filter"]'
      ) as HTMLSelectElement | null;
      assert.ok(access, 'a Super Admin must get the access-scope filter');
      assert.ok(operation, 'a Super Admin must get the operation filter');
      assert.equal(access!.value, 'exceptions', 'the shared link restores the access scope');
      assert.equal(operation!.value, 'inv-delete', 'the shared link restores the operation');
      assert.match(tree.container.textContent || '', /Sita Sharma/);
      assert.doesNotMatch(
        tree.container.textContent || '',
        /Hari K\.C\./,
        'the restored filters must be applied before the first paint settles'
      );

      const operationValues = [...operation!.querySelectorAll('option')].map(
        (option) => (option as HTMLOptionElement).value
      );
      assert.equal(
        operationValues.length,
        Object.keys(DEFAULT_PERMISSIONS_MATRIX).length + 1,
        'the picker must offer every catalogue operation plus Any operation'
      );
      for (const operationId of Object.keys(DEFAULT_PERMISSIONS_MATRIX)) {
        assert.ok(operationValues.includes(operationId), `${operationId} must be filterable`);
      }

      setSelectValue(access!, 'exceptions');
      await flush();
      assert.match(tree.container.textContent || '', /Sita Sharma/);
      assert.doesNotMatch(
        tree.container.textContent || '',
        /Hari K\.C\./,
        'an account with only role defaults must drop out'
      );
      assert.match(tree.container.textContent || '', /Showing 1 of 2 staff accounts/);

      setSelectValue(access!, 'all');
      setSelectValue(operation!, 'inv-delete');
      await flush();
      assert.match(tree.container.textContent || '', /Sita Sharma/);
      assert.doesNotMatch(tree.container.textContent || '', /Hari K\.C\./);
      let params = new URLSearchParams(window.location.search);
      assert.equal(window.location.pathname, '/settings/users', 'the link must name the Users screen');
      assert.equal(params.get('tab'), null, 'the canonical URL must not carry ?tab=');
      assert.equal(params.get('access'), null, 'the default scope must not clutter the URL');
      assert.equal(params.get('operation'), 'inv-delete');

      setSelectValue(operation!, 'prod-view');
      await flush();
      assert.match(tree.container.textContent || '', /Sita Sharma/);
      assert.match(tree.container.textContent || '', /Hari K\.C\./);
      assert.match(tree.container.textContent || '', /Showing 2 of 2 staff accounts/);
      params = new URLSearchParams(window.location.search);
      assert.equal(params.get('operation'), 'prod-view');

      setSelectValue(operation!, 'fin-statements');
      await flush();
      assert.doesNotMatch(tree.container.textContent || '', /Sita Sharma/);
      assert.match(tree.container.textContent || '', /Hari K\.C\./);

      setSelectValue(access!, 'exceptions');
      await flush();
      assert.match(
        tree.container.textContent || '',
        /No staff accounts match the current search and access filters/
      );
      assert.match(tree.container.textContent || '', /Showing 0 of 2 staff accounts/);
      params = new URLSearchParams(window.location.search);
      assert.equal(params.get('access'), 'exceptions');
      assert.equal(params.get('operation'), 'fin-statements');

      // Copy link reads the live controls and hands the exact filtered URL to
      // the clipboard, not a stale value from the last render.
      const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      let copiedUrl = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            copiedUrl = value;
          },
        },
      });
      try {
        const copyLink = [...tree.container.querySelectorAll('button')].find((node) =>
          node.textContent?.includes('Copy link')
        );
        assert.ok(copyLink, 'the filter row must offer a copy-link action');
        click(copyLink!);
        await flush();
        assert.match(copiedUrl, /\/settings\/users(?:\?|$)/, 'the copy must use the canonical path');
        assert.doesNotMatch(copiedUrl, /[?&]tab=/, 'the copy must not revive the legacy tab parameter');
        assert.match(copiedUrl, /[?&]access=exceptions(?:&|$)/);
        assert.match(copiedUrl, /[?&]operation=fin-statements(?:&|$)/);
        assert.match(tree.container.textContent || '', /Copied/);
      } finally {
        if (clipboardDescriptor) {
          Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
        } else {
          delete (navigator as any).clipboard;
        }
      }

      const clear = [...tree.container.querySelectorAll('button')].find((node) =>
        node.textContent?.includes('Clear access filters')
      );
      assert.ok(clear, 'an active access filter must offer a one-click reset');
      click(clear!);
      await flush();
      assert.equal(access!.value, 'all');
      assert.equal(operation!.value, '');
      assert.match(tree.container.textContent || '', /Sita Sharma/);
      assert.match(tree.container.textContent || '', /Hari K\.C\./);
      params = new URLSearchParams(window.location.search);
      assert.equal(window.location.pathname, '/settings/users', 'clearing filters must not hide the screen');
      assert.equal(params.get('tab'), null);
      assert.equal(params.get('access'), null);
      assert.equal(params.get('operation'), null);
    } finally {
      tree.unmount();
      api.getUserAccessSummaries = originalSummaries;
      window.history.replaceState(null, '', originalUrl);
    }
  });

  test('the edit modal summarizes extra access and opens the editor', async () => {
    const response = {
      userId: manager.id,
      role: 'BRANCH_MANAGER',
      base: { 'inv-pay': false, 'fin-statements': false, 'prod-view': true },
      overrides: [
        { operationId: 'inv-pay', effect: 'grant' as const, reason: 'vendor desk', expiresAt: null, expired: false },
        { operationId: 'fin-statements', effect: 'deny' as const, reason: 'sod', expiresAt: null, expired: false },
      ],
      setIds: ['set-vendor-desk'],
      operations: ['inv-pay', 'prod-view'],
      version: 2,
    };
    const modalUser = { ...manager, allowedBranchIds: [] } as User;
    let target = '';
    const originalGet = api.getUserPermissionOverrides;
    api.getUserPermissionOverrides = async () => response;

    const tree = mountTree(
      h(DialogProvider, null, h(UsersManagement, {
        currentUser: superAdmin,
        users: [modalUser],
        branches: [],
        onManageAccess: (userId) => {
          target = userId;
        },
      }))
    );
    const findButton = (label: string) =>
      [...tree.container.querySelectorAll('button')].find((node) =>
        node.textContent?.includes(label)
      ) as HTMLButtonElement | undefined;

    try {
      await flush();
      const edit = tree.container.querySelector('button[title="Edit User"]');
      assert.ok(edit, 'the user card must offer Edit');
      click(edit!);
      await flush();
      await flush();

      let text = tree.container.textContent || '';
      assert.match(text, /Access & permissions/);
      assert.match(text, /1 extra permission/);
      assert.match(text, /1 personal deny/);
      assert.match(text, /1 permission set/);
      assert.match(text, /Effective: 2 of 3 operations/);

      const manage = findButton('Manage access');
      assert.ok(manage, 'the summary must offer Manage access');
      assert.equal(manage!.disabled, false);

      const nameInput = tree.container.querySelector(
        'input[placeholder="e.g., Full Name"]'
      ) as HTMLInputElement | null;
      assert.ok(nameInput);
      setInputValue(nameInput!, 'Sita Sharma Changed');
      await flush();
      assert.equal(findButton('Manage access')!.disabled, true);
      assert.match(tree.container.textContent || '', /Save or cancel your changes to manage access/);

      setInputValue(nameInput!, manager.name);
      await flush();
      click(findButton('Manage access')!);
      assert.equal(target, manager.id);
    } finally {
      tree.unmount();
      api.getUserPermissionOverrides = originalGet;
    }
  });

  test('a failed access summary still leaves the user form saveable', async () => {
    const originalGet = api.getUserPermissionOverrides;
    api.getUserPermissionOverrides = async () => {
      throw new Error('summary offline');
    };

    const tree = mountTree(
      h(DialogProvider, null, h(UsersManagement, {
        currentUser: superAdmin,
        users: [manager],
        branches: [],
        onManageAccess: () => undefined,
      }))
    );
    try {
      await flush();
      const edit = tree.container.querySelector('button[title="Edit User"]');
      assert.ok(edit);
      click(edit!);
      await flush();
      await flush();

      assert.match(tree.container.textContent || '', /summary offline/);
      const update = [...tree.container.querySelectorAll('button')].find((node) =>
        node.textContent?.includes('Update User')
      ) as HTMLButtonElement | undefined;
      assert.ok(update);
      assert.equal(update!.disabled, false, 'a summary failure must not block identity saving');
    } finally {
      tree.unmount();
      api.getUserPermissionOverrides = originalGet;
    }
  });

  test('a role matrix cell opens the users whose personal access differs', async () => {
    const calls: Array<{ operationId: string; role: string }> = [];
    let accessTarget: { userId: string; operationId?: string } | undefined;
    const originalGet = api.getOperationPermissionOverrides;
    api.getOperationPermissionOverrides = async (operationId, role) => {
      calls.push({ operationId, role });
      return {
        operationId,
        role,
        roleAllowed: false,
        users: [
          {
            userId: 'u-fd-a',
            operationId,
            name: 'Front Desk A',
            email: 'fd-a@example.com',
            role,
            effect: 'grant',
            reason: 'covers vendor settlement',
            expiresAt: null,
          },
        ],
      };
    };

    const tree = mountTree(
      h(PermissionManagement, {
        currentUser: superAdmin,
        permissionsMatrix: DEFAULT_PERMISSIONS_MATRIX,
        onOpenUserAccess: (target) => {
          accessTarget = target;
        },
      })
    );
    try {
      await flush();
      const opener = tree.container.querySelector(
        'button[aria-label="Show personal exceptions for Process Vendor Payment Settlements and Front Desk"]'
      );
      assert.ok(opener, 'each role cell must offer the drill-down');
      click(opener!);
      await flush();
      await flush();

      assert.deepEqual(calls, [{ operationId: 'inv-pay', role: 'FRONT_DESK' }]);
      assert.match(tree.container.textContent || '', /Personal exceptions/);
      assert.match(tree.container.textContent || '', /Front Desk A/);
      assert.match(tree.container.textContent || '', /Personal grant/);
      assert.match(tree.container.textContent || '', /covers vendor settlement/);
      assert.match(tree.container.textContent || '', /Role default: denied/);

      const close = [...tree.container.querySelectorAll('button')].find(
        (node) => node.textContent?.trim() === 'Close'
      );
      assert.ok(close);
      click(close!);
      assert.doesNotMatch(tree.container.textContent || '', /Personal exceptions/);

      click(opener!);
      await flush();
      await flush();
      const edit = tree.container.querySelector(
        'button[aria-label="Edit access for Front Desk A at Process Vendor Payment Settlements"]'
      );
      assert.ok(edit, 'each drill-down row must open that account\'s editor');
      click(edit!);
      assert.deepEqual(accessTarget, { userId: 'u-fd-a', operationId: 'inv-pay' });
      assert.doesNotMatch(tree.container.textContent || '', /Personal exceptions/);
    } finally {
      tree.unmount();
      api.getOperationPermissionOverrides = originalGet;
    }
  });

  test('a grant to Front Desk A never appears for Front Desk B', async () => {
    const frontDeskA = {
      ...manager,
      id: 'u-fd-a',
      name: 'Front Desk A',
      email: 'fd-a@example.com',
      role: 'FRONT_DESK',
    } as User;
    const frontDeskB = {
      ...manager,
      id: 'u-fd-b',
      name: 'Front Desk B',
      email: 'fd-b@example.com',
      role: 'FRONT_DESK',
    } as User;
    const base = { 'inv-pay': false, 'sales-invoice-create': true };
    const responseFor = (userId: string, overrides: any[] = []) => ({
      userId,
      role: 'FRONT_DESK',
      base,
      overrides,
      setIds: [],
      operations: [
        'sales-invoice-create',
        ...(overrides.some((row) => row.operationId === 'inv-pay' && row.effect === 'grant')
          ? ['inv-pay']
          : []),
      ],
      version: 1,
    });
    let savedPayload: unknown = null;
    const originalGet = api.getUserPermissionOverrides;
    const originalSave = api.saveUserPermissionOverrides;
    const originalGetSets = api.getPermissionSets;
    api.getUserPermissionOverrides = async (userId) => responseFor(userId);
    api.getPermissionSets = async () => [];
    api.saveUserPermissionOverrides = async (userId, overrides: any) => {
      savedPayload = overrides;
      return responseFor(
        userId,
        overrides.map((row: any) => ({ ...row, expired: false }))
      );
    };

    const tree = mountTree(
      h(DialogProvider, null, h(UserPermissions, {
        currentUser: superAdmin,
        users: [frontDeskA, frontDeskB],
        branches: [],
        dateMode: 'AD',
      }))
    );
    try {
      await flush();
      await flush();

      const operationLabel = [...tree.container.querySelectorAll('p')].find(
        (node) => node.textContent?.trim() === 'Process Vendor Payment Settlements'
      );
      assert.ok(operationLabel);
      const row = operationLabel!.closest('div.p-3') as HTMLElement;
      const grant = [...row.querySelectorAll('button')].find((button) =>
        button.textContent?.trim() === 'Grant'
      );
      assert.ok(grant);
      click(grant!);
      await flush();

      const reason = row.querySelector(
        'input[placeholder="Why does this exception exist?"]'
      ) as HTMLInputElement | null;
      assert.ok(reason);
      setInputValue(reason!, 'covers vendor settlement');
      await flush();

      const save = [...tree.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Save 1 exception')
      );
      assert.ok(save);
      click(save!);
      await flush();
      await flush();

      assert.deepEqual(savedPayload, [
        {
          operationId: 'inv-pay',
          effect: 'grant',
          reason: 'covers vendor settlement',
          expiresAt: null,
        },
      ]);

      const userB = [...tree.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Front Desk B')
      );
      assert.ok(userB, 'the second Front Desk user must be selectable');
      click(userB!);
      await flush();
      await flush();

      assert.match(tree.container.textContent || '', /Front Desk B/);
      const bLabel = [...tree.container.querySelectorAll('p')].find(
        (node) => node.textContent?.trim() === 'Process Vendor Payment Settlements'
      );
      assert.ok(bLabel);
      const bRow = bLabel!.closest('div.p-3') as HTMLElement;
      assert.match(bRow.textContent || '', /Role: denied/);
      const inherit = [...bRow.querySelectorAll('button')].find((button) =>
        button.textContent?.trim() === 'Inherit'
      );
      assert.ok(inherit);
      assert.equal(inherit!.getAttribute('aria-pressed'), 'true');
      const saveB = [...tree.container.querySelectorAll('button')].find((button) =>
        button.textContent?.trim() === 'Save exceptions'
      ) as HTMLButtonElement | undefined;
      assert.ok(saveB);
      assert.equal(saveB!.disabled, true, 'B has no exception to save');
    } finally {
      tree.unmount();
      api.getUserPermissionOverrides = originalGet;
      api.saveUserPermissionOverrides = originalSave;
      api.getPermissionSets = originalGetSets;
    }
  });
});
