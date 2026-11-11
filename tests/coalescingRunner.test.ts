/**
 * Coalescing cache-refresh runner (audit finding H4).
 *
 * The old refresh chain queued one full cache fan-out per committed write, so a
 * burst of N writes paid N sequential passes and every response waited for the
 * queue behind it. The runner must keep the correctness property (nobody
 * resolves before a pass that started after they asked) while collapsing a
 * burst into one pass plus at most one trailing pass.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCoalescingRunner } from '../server/src/utils/coalescingRunner';

describe('coalescing runner', () => {
  test('a burst shares one pass and one trailing pass', async () => {
    let passes = 0;
    let releaseFirstPass: (() => void) | null = null;
    const runner = createCoalescingRunner(async () => {
      passes += 1;
      if (passes === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstPass = resolve;
        });
      }
    });

    const calls = [runner(), runner(), runner(), runner()];
    await Promise.resolve();
    assert.equal(runner.stats().running, true, 'the first call starts a pass');

    releaseFirstPass!();
    await Promise.all(calls);

    assert.equal(passes, 2, 'four overlapping writes cost two passes, not four');
    const stats = runner.stats();
    assert.equal(stats.requests, 4);
    assert.equal(stats.coalesced, 3);
    assert.equal(stats.running, false);
  });

  test('sequential calls each get their own pass', async () => {
    let passes = 0;
    const runner = createCoalescingRunner(async () => {
      passes += 1;
    });
    await runner();
    await runner();
    await runner();
    assert.equal(passes, 3);
    assert.equal(runner.stats().coalesced, 0);
  });

  test('does nothing while disabled', async () => {
    let passes = 0;
    let enabled = false;
    const runner = createCoalescingRunner(async () => {
      passes += 1;
    }, () => enabled);
    await runner();
    assert.equal(passes, 0);
    assert.equal(runner.stats().requests, 0, 'a disabled refresh is not a request');
    enabled = true;
    await runner();
    assert.equal(passes, 1);
  });

  test('a failing pass never leaves the runner stuck', async () => {
    let attempts = 0;
    const runner = createCoalescingRunner(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('database went away');
    });
    await assert.rejects(() => runner(), /database went away/);
    assert.equal(runner.stats().running, false, 'the next write must be able to refresh');
    await runner();
    assert.equal(attempts, 2);
  });
});
