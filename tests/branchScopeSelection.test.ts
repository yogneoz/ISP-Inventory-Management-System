/**
 * Multi-branch assignment — the view scope follows the assigned branches.
 *
 * The user form has always stored `allowedBranchIds`, and the server's
 * collection guard accepts those branches. The main view scope did not: App
 * forced every non-Super-Admin back to `currentUser.branchId`, and
 * `/api/bootstrap` only accepted the primary branch. A Branch Manager assigned
 * Branch 1 + Branch 2 could therefore read Branch 2 in a form but never switch
 * the header to it.
 *
 * PROVES:
 *   1. resolveBranchSelection accepts an assigned secondary branch, rejects an
 *      unassigned one, and keeps ALL for global accounts only.
 *   2. The header offers exactly the assigned branches (no dead ALL option),
 *      and a single-branch account still sees the locked "Assigned" badge.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { mountTree, inAct } from './harness/mount';
import { ViewScopeControls } from '../client/src/components/common/ViewScopeControls';
import { resolveBranchSelection } from '../client/src/utils/permissions';

const branches = [
  { id: 'WH001', code: 'WH01', name: 'Branch 1 (Head Office)', isHeadquarters: true },
  { id: 'BRH01', code: 'BRH01', name: 'Branch 2' },
] as any[];

const branchManager = {
  id: 'u-bm',
  name: 'Branch Manager',
  email: 'bm@example.com',
  role: 'BRANCH_MANAGER',
  branchId: 'WH001',
  allowedBranchIds: ['WH001', 'BRH01'],
} as any;

const singleBranchUser = {
  ...branchManager,
  id: 'u-single',
  allowedBranchIds: ['BRH01'],
  branchId: 'BRH01',
} as any;

const superAdmin = {
  id: 'u-sa',
  name: 'Super Admin',
  email: 'sa@example.com',
  role: 'SUPER_ADMIN',
  branchId: 'WH001',
  allowedBranchIds: ['WH001', 'BRH01'],
} as any;

const scope = (user: any, requested: string) => resolveBranchSelection(user, branches, requested);

describe('multi-branch view scope', () => {
  test('an assigned secondary branch is accepted', () => {
    assert.equal(scope(branchManager, 'BRH01'), 'BRH01');
    assert.equal(scope(branchManager, 'WH001'), 'WH001');
  });

  test('an unassigned branch and ALL fall back to the primary branch', () => {
    assert.equal(scope(branchManager, 'BRH02'), 'WH001');
    assert.equal(scope(branchManager, 'ALL'), 'WH001');
    assert.equal(scope(singleBranchUser, 'WH001'), 'BRH01');
  });

  test('global accounts keep ALL and any branch', () => {
    assert.equal(scope(superAdmin, 'ALL'), 'ALL');
    assert.equal(scope(superAdmin, 'BRH01'), 'BRH01');
    assert.equal(scope({ ...branchManager, role: 'HEAD_OFFICE_ADMIN' }, 'ALL'), 'ALL');
    assert.equal(scope({ ...branchManager, branchId: 'ALL' }, 'ALL'), 'ALL');
  });

  test('the header offers the assigned branches and no dead ALL option', () => {
    let picked = '';
    const tree = mountTree(
      createElement(ViewScopeControls, {
        currentUser: branchManager,
        branches,
        selectedBranchId: 'WH001',
        onSelectBranch: (id: string) => {
          picked = id;
        },
        fiscalYears: [],
        selectedFiscalYearId: '',
        onSelectFiscalYear: () => {},
        variant: 'header',
      } as any)
    );
    try {
      const select = tree.container.querySelector('#header-branch-scope') as HTMLSelectElement | null;
      assert.ok(select, 'a multi-branch account gets a branch selector');
      assert.deepEqual(
        [...select!.options].map((option) => option.value),
        ['WH001', 'BRH01'],
        'only the assigned branches are offered; ALL would be refused by the server'
      );

      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value'
      )!.set!;
      inAct(() => {
        setter.call(select, 'BRH01');
        select!.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
      assert.equal(picked, 'BRH01', 'selecting an assigned branch reaches the shell');
    } finally {
      tree.unmount();
    }
  });

  test('a single-branch account keeps the locked assigned badge', () => {
    const tree = mountTree(
      createElement(ViewScopeControls, {
        currentUser: singleBranchUser,
        branches,
        selectedBranchId: 'BRH01',
        onSelectBranch: () => {},
        fiscalYears: [],
        selectedFiscalYearId: '',
        onSelectFiscalYear: () => {},
        variant: 'header',
      } as any)
    );
    try {
      assert.equal(tree.container.querySelector('#header-branch-scope'), null);
      assert.match(tree.container.textContent || '', /Branch 2/);
      assert.match(tree.container.textContent || '', /Assigned/);
    } finally {
      tree.unmount();
    }
  });
});
