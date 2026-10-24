/**
 * New-location branch default (close-out residual #1).
 *
 * Locations seeded a new location's branch from `branches[0]` when the
 * component mounted. On a slow bootstrap that list was still empty, so the
 * default was the hard-coded 'WH001' even for an operator on another branch —
 * and once the list did load, the first branch won. The form now follows the
 * user's own branch as the bootstrap arrives, without overwriting a branch the
 * operator picked in the open form.
 *
 * PROVES:
 *  1. RULE — the default prefers the user's branch when it exists, falls back
 *     to the first branch, then to the legacy 'WH001' for an empty list.
 *  2. WIRING — App hands the screen the signed-in user, the form syncs while
 *     untouched, an explicit pick stops the sync, and a save resets the pick.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultLocationBranchId } from '../client/src/features/settings/LocationsManagement';
import type { Branch } from '../client/src/types';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(relativePath), 'utf8');

const branch = (id: string): Branch => ({ id, code: id, name: `Branch ${id}` } as Branch);

describe('defaultLocationBranchId', () => {
  test("prefers the user's own branch when it is in the master list", () => {
    assert.equal(defaultLocationBranchId([branch('WH001'), branch('BRH01')], 'BRH01'), 'BRH01');
  });

  test('ignores a user branch the master list does not contain', () => {
    assert.equal(defaultLocationBranchId([branch('WH001')], 'BRH99'), 'WH001');
  });

  test('an empty list still yields the legacy default, so the first save is valid', () => {
    assert.equal(defaultLocationBranchId([], 'BRH01'), 'WH001');
  });

  test('without a user branch the first master branch wins', () => {
    assert.equal(defaultLocationBranchId([branch('WH001'), branch('BRH01')]), 'WH001');
  });
});

describe('Locations branch default — wiring', () => {
  test('App passes the signed-in user so the screen knows which branch is theirs', () => {
    const app = read('client/src/App.tsx');
    const start = app.indexOf('<LocationsManagement');
    assert.ok(start >= 0, 'App must render LocationsManagement');
    const block = app.slice(start, app.indexOf('/>', start));
    assert.match(block, /currentUser=\{currentUser\}/);
  });

  test('the form follows the default until the operator picks a branch', () => {
    const source = read('client/src/features/settings/LocationsManagement.tsx');
    assert.ok(
      source.includes('defaultLocationBranchId(branches, currentUser?.branchId)'),
      'the default must come from the shared rule'
    );
    assert.ok(
      !source.includes('branchId: branches[0]'),
      'the mount-time branches[0] default must be gone from init and reset'
    );
    assert.ok(
      source.includes('if (branchPicked) return;'),
      'the sync must not overwrite an explicit pick'
    );
    assert.ok(
      source.includes('setBranchPicked(true);'),
      'choosing a branch in the select must mark it picked'
    );
    assert.ok(
      source.includes('setBranchPicked(false);'),
      'a successful save must return the form to following the default'
    );
  });
});
