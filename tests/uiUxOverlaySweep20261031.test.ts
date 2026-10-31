/**
 * UI/UX overlay sweep — 2026-10-31.
 *
 * The 2026-10-30 sweep measured every routed screen but listed modals and
 * drawers as not covered. The follow-up sweep opened the shell overlays
 * (search, notifications, scanner, profile, confirm dialog) and the record
 * dialogs on the registers at 1440/1067/390 px, measuring clipped text,
 * overflow, unreachable actions, targets and console/HTTP errors.
 *
 * One content-loss finding: the profile switcher's identity line
 * (`email • branch`) was `truncate`d. At 1067 it cut 12 px; at 390 it cut up to
 * 102 px, hiding the branch on six of seven rows. The branch is how an operator
 * tells two same-named users apart, so the line must wrap.
 *
 * PROVES:
 *   - the profile picker renders each user's email and branch in full;
 *   - the identity line wraps and does not use a truncation class.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { mountTree } from './harness/mount';
import { ProfileSwitchModal } from '../client/src/components/common/ProfileSwitchModal';

const branches = [
  { id: 'br-1', code: 'HQ', name: 'Head Office — Kathmandu', location: 'HQ', isHeadquarters: true },
  { id: 'br-2', code: 'B2', name: 'Branch Two — Bharatpur Service Centre', location: 'B2' },
] as any[];

const currentUser = {
  id: 'u-root',
  name: 'Super Admin',
  email: 'superadmin@example.com',
  role: 'SUPER_ADMIN',
  branchId: 'br-1',
  allowedBranchIds: ['br-1', 'br-2'],
} as any;

const longEmail = 'frontdesk.bharatpur.service.centre@example.com';
const users = [
  currentUser,
  {
    id: 'u-front',
    name: 'Front Desk Operator With A Long Name',
    email: longEmail,
    role: 'FRONT_DESK',
    branchId: 'br-2',
    allowedBranchIds: ['br-2'],
  },
] as any[];

describe('2026-10-31 overlay sweep — profile picker identity is never ellipsized', () => {
  test('email and branch render in full and the line wraps', () => {
    const tree = mountTree(
      createElement(ProfileSwitchModal, {
        isOpen: true,
        onClose: () => {},
        currentUser,
        users,
        branches,
        onSwitchProfile: async () => {},
        onUpdateProfile: async () => {},
        onLogout: () => {},
      } as any)
    );

    try {
      const identity = [...tree.container.querySelectorAll('div.font-mono')].find((node) =>
        (node.textContent || '').includes(longEmail)
      ) as HTMLElement | undefined;
      assert.ok(identity, 'the profile row must render the identity line');

      assert.match(identity!.textContent || '', new RegExp(longEmail), 'the email must be complete');
      assert.match(
        identity!.textContent || '',
        /Branch Two — Bharatpur Service Centre/,
        'the branch must be complete'
      );
      assert.doesNotMatch(identity!.className, /\btruncate\b/, 'identity must not ellipsize');
      assert.match(identity!.className, /\bflex-wrap\b/, 'the line must wrap at narrow widths');
      assert.match(identity!.className, /text-\[11px\]/, 'the identity line stays at its 11 px scale');

      const name = [...tree.container.querySelectorAll('span.text-xs.font-bold')].find(
        (node) => node.textContent === 'Front Desk Operator With A Long Name'
      ) as HTMLElement | undefined;
      assert.ok(name, 'the profile row must render the user name');
      assert.doesNotMatch(name!.className, /\btruncate\b/, 'a user name must not ellipsize either');
    } finally {
      tree.unmount();
    }
  });
});
