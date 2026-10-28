/**
 * Profile editor — the edit form follows the signed-in identity.
 *
 * AppShell keeps ProfileSwitchModal mounted and toggles `isOpen`, so its
 * `useState` initializers run once. After switching from account A to B the
 * edit tab still held A's name and email: editing only the name would submit
 * A's email as B's profile update, and the untouched field on screen belonged
 * to someone else. The form now re-seeds when the modal opens or the active
 * identity changes.
 *
 * PROVES:
 *   1. Re-rendering the modal with a different current user (a profile switch)
 *      shows that user's name and email in the edit tab.
 *   2. A save from that form sends the new identity, not the previous one.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement } from 'react';
import { mountTree, inAct } from './harness/mount';
import { ProfileSwitchModal } from '../client/src/components/common/ProfileSwitchModal';

const branches = [
  { id: 'br-1', code: 'HQ', name: 'Head Office', location: 'HQ', isHeadquarters: true },
  { id: 'br-2', code: 'B2', name: 'Branch Two', location: 'B2' },
] as any[];

const alice = {
  id: 'u-a',
  name: 'Alice Admin',
  email: 'alice@example.com',
  role: 'SUPER_ADMIN',
  branchId: 'br-1',
  allowedBranchIds: ['br-1', 'br-2'],
} as any;

const bob = {
  id: 'u-b',
  name: 'Bob Branch',
  email: 'bob@example.com',
  role: 'BRANCH_MANAGER',
  branchId: 'br-2',
  allowedBranchIds: ['br-2'],
} as any;

function modal(user: any, onUpdateProfile: (data: any) => Promise<void>) {
  return createElement(ProfileSwitchModal, {
    isOpen: true,
    onClose: () => {},
    currentUser: user,
    users: [alice, bob],
    branches,
    onSwitchProfile: async () => {},
    onUpdateProfile,
    onLogout: () => {},
  } as any);
}

function findButton(container: HTMLElement, pattern: RegExp): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((b) =>
    pattern.test((b.textContent || '').trim())
  ) as HTMLButtonElement | undefined;
  assert.ok(button, `expected a button matching ${pattern}`);
  return button;
}

/** The edit tab's full name and email inputs, in DOM order. */
function editInputs(container: HTMLElement): { name: HTMLInputElement; email: HTMLInputElement } {
  const name = container.querySelector('input[type="text"]') as HTMLInputElement | null;
  const email = container.querySelector('input[type="email"]') as HTMLInputElement | null;
  assert.ok(name, 'the edit tab renders the name input');
  assert.ok(email, 'the edit tab renders the email input');
  return { name: name!, email: email! };
}

describe('profile edit re-seeds after a profile switch', () => {
  test('the edit tab shows the current identity, not the one the modal mounted with', () => {
    const tree = mountTree(modal(alice, async () => {}));
    try {
      tree.rerender(modal(bob, async () => {}));

      inAct(() => findButton(tree.container, /^Edit My Profile$/).click());

      const inputs = editInputs(tree.container);
      assert.equal(inputs.name.value, 'Bob Branch', 'name must follow the new profile');
      assert.equal(inputs.email.value, 'bob@example.com', 'email must follow the new profile');
    } finally {
      tree.unmount();
    }
  });

  test('saving from a switched profile submits the new identity', async () => {
    const updates: any[] = [];
    const update = async (data: any) => {
      updates.push(data);
    };
    const tree = mountTree(modal(alice, update));
    try {
      tree.rerender(modal(bob, update));

      inAct(() => findButton(tree.container, /^Edit My Profile$/).click());
      await act(async () => {
        findButton(tree.container, /^Update Profile Info$/).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      assert.deepEqual(updates, [{ name: 'Bob Branch', email: 'bob@example.com' }]);
    } finally {
      tree.unmount();
    }
  });
});
