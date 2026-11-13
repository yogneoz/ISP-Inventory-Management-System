/**
 * ACC-5 — branch master default cost centre, rendered.
 *
 * The branch directory is where the fallback lives. This mounts the real
 * screen, opens the edit panel and proves the select is branch-filtered and the
 * chosen value reaches the update callback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { DialogProvider } from '../client/src/components/common/DialogProvider';
import { BranchesManagement } from '../client/src/features/settings/BranchesManagement';
import type { Branch, CostCenter, User } from '../client/src/types';
import { mountTree } from './harness/mount';
import { installApiStubs } from './harness/appRouteTreeProbe';

const admin = { id: 'u-1', name: 'Admin', role: 'SUPER_ADMIN', branchId: 'ALL' } as unknown as User;
const branch = {
  id: 'br-1',
  code: 'BR-1',
  name: 'Rendered Branch',
  location: 'Kathmandu',
  phone: '+977-1-4200000',
  isHeadquarters: false,
  active: true,
  allowProcurement: true,
  allowWarehouseTransfer: true,
  defaultCostCenterId: 'cc-own',
} as Branch;

const centers: CostCenter[] = [
  { id: 'cc-own', code: 'CC-1', name: 'Branch centre', branchId: 'br-1', active: true },
  { id: 'cc-other', code: 'CC-2', name: 'Other centre', branchId: 'br-2', active: true },
  { id: 'cc-shared', code: 'CC-S', name: 'Shared centre', branchId: null, active: true },
];

const settle = async (rounds = 3): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

test('the branch edit panel filters centres to the branch and saves the default', async () => {
  const captured: { id?: string; patch?: Partial<Branch> } = {};
  const restore = installApiStubs({
    getCostCenters: async () => centers,
  });
  const tree = mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(BranchesManagement, {
        branches: [branch],
        currentUser: admin,
        onUpdateBranch: async (id: string, patch: Partial<Branch>) => {
          captured.id = id;
          captured.patch = patch;
        },
      })
    )
  );
  try {
    await settle();
    const edit = document.querySelector('button[title="Edit Branch"]') as HTMLElement | null;
    assert.ok(edit, 'the editable branch exposes its edit action');
    await act(async () => {
      edit!.click();
      await Promise.resolve();
    });

    const select = document.querySelector(
      'select[aria-label="Branch default cost centre"]'
    ) as HTMLSelectElement | null;
    assert.ok(select, 'the branch default centre is editable');
    const values = Array.from(select!.options).map((option) => option.value);
    assert.ok(values.includes('cc-own'));
    assert.ok(values.includes('cc-shared'));
    assert.equal(values.includes('cc-other'), false, 'another branch centre is excluded');

    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')?.set;
    await act(async () => {
      setter?.call(select!, 'cc-shared');
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => (button.textContent || '').trim() === 'Update Branch'
    ) as HTMLButtonElement | undefined;
    assert.ok(save);
    await act(async () => {
      save!.click();
      await Promise.resolve();
    });
    await settle();

    assert.equal(captured.id, 'br-1');
    assert.equal(captured.patch?.defaultCostCenterId, 'cc-shared');
  } finally {
    tree.unmount();
    restore();
  }
});
