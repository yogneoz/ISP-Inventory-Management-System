/**
 * Assignable fixed assets — a profile switch is a new session.
 *
 * `useAvailableFixedAssets` is mounted with StockOperations and kept alive by
 * the shell. Its first version loaded only on mount, so `reset()` (sign-out or
 * a profile switch) cleared the shared entry and the still-mounted picker never
 * asked again: the assignable list stayed empty until a full reload. The hook
 * now watches the store version, so a reset re-reads the list for the new
 * user's scope.
 *
 * PROVES:
 *   1. A mounted picker loads the list once on mount.
 *   2. resetAvailableFixedAssets() makes it reload without a remount.
 *   3. A failed read is not retried automatically. Watching the store version
 *      re-armed the mount effect on every publish, and a failure publishes
 *      loaded:false — so the picker re-requested forever. That request storm
 *      wedged every test that renders the real route tree (140 s hang).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement as h } from 'react';
import { mountTree } from './harness/mount';
import { api } from '../client/src/services/api';
import {
  resetAvailableFixedAssets,
  useAvailableFixedAssets,
} from '../client/src/services/availableAssetsCache';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const Probe = () => {
  const state = useAvailableFixedAssets();
  return h(
    'div',
    null,
    `rows:${state.rows.length} loaded:${String(state.loaded)} error:${state.error}`
  );
};

describe('available assets — reset on profile switch', () => {
  const original = api.getAvailableFixedAssets;
  let calls = 0;

  before(() => {
    resetAvailableFixedAssets();
    api.getAvailableFixedAssets = (async () => {
      calls += 1;
      return {
        data: [{ id: `asset-${calls}` }],
        truncated: false,
      } as any;
    }) as any;
  });

  after(() => {
    api.getAvailableFixedAssets = original;
    resetAvailableFixedAssets();
  });

  test('a failed read waits for an explicit refresh instead of retrying', async () => {
    calls = 0;
    api.getAvailableFixedAssets = (async () => {
      calls += 1;
      throw new Error('network down');
    }) as any;
    resetAvailableFixedAssets();
    const tree = mountTree(h(Probe));
    try {
      await act(async () => {
        await sleep(0);
        await sleep(10);
        await sleep(10);
      });
      assert.equal(calls, 1, 'a failed read must not arm an automatic retry loop');
      assert.match(
        tree.container.textContent || '',
        /error:network down/,
        'the failure stays visible so the picker can report it'
      );
    } finally {
      tree.unmount();
      api.getAvailableFixedAssets = (async () => {
        calls += 1;
        return { data: [{ id: `asset-${calls}` }], truncated: false } as any;
      }) as any;
    }
  });

  test('a reset while the picker stays mounted reloads the list', async () => {
    calls = 0;
    resetAvailableFixedAssets();
    const tree = mountTree(h(Probe));
    try {
      await act(async () => {
        await sleep(0);
        await sleep(0);
      });
      assert.equal(calls, 1, 'the mounted picker reads once on mount');
      assert.match(tree.container.textContent || '', /rows:1 loaded:true/);

      await act(async () => {
        resetAvailableFixedAssets();
        await sleep(0);
        await sleep(0);
      });

      assert.equal(calls, 2, 'a reset must re-read for the new profile');
      assert.match(
        tree.container.textContent || '',
        /rows:1 loaded:true/,
        'the reloaded rows replace the reset entry'
      );
    } finally {
      tree.unmount();
    }
  });
});
