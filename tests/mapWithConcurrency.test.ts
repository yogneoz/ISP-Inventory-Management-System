/**
 * Bounded-concurrency map for the reports batch (close-out residual #3).
 *
 * The batch summary endpoint computed one branch × fiscal year after another.
 * Running every pair at once would be faster but would put `pairs × 9` queries
 * on a pool that defaults to 20 connections, so the endpoint now uses this
 * helper: parallel, bounded, order-preserving.
 *
 * PROVES: input order is kept regardless of completion order, no more than
 * `limit` workers are ever in flight, an empty list is a no-op, a rejection
 * propagates, and an invalid limit is refused loudly.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from '../server/src/utils/mapWithConcurrency';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  test('keeps results in input order even when later items finish first', async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async (delay, index) => {
      await wait(delay);
      return index;
    });
    assert.deepEqual(results, [0, 1, 2]);
  });

  test('never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await wait(5);
      inFlight -= 1;
      return item;
    });
    assert.equal(peak, 3, 'the pool must never see more than `limit` workers');
  });

  test('an empty list resolves without calling the worker', async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 2, async () => {
      calls += 1;
      return 1;
    });
    assert.deepEqual(results, []);
    assert.equal(calls, 0);
  });

  test('a worker rejection propagates instead of returning partial results', async () => {
    await assert.rejects(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('summary read failed');
        return item;
      }),
      /summary read failed/
    );
  });

  test('refuses a nonsensical limit instead of silently serialising', async () => {
    await assert.rejects(mapWithConcurrency([1], 0, async () => 1), /positive integer/);
    await assert.rejects(mapWithConcurrency([1], 1.5, async () => 1), /positive integer/);
  });
});
