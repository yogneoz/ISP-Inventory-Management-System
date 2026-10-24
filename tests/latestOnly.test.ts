/**
 * DF-08 — latest-only sequence guard.
 *
 * Four self-fetching screens (the two party ledgers, opening stock and vendor
 * opening balances) key their fetch by a selection. Without a guard, an older
 * response can settle after a newer one and paint the previous party/fiscal
 * year, clear the current rows with its failure, or settle the loading flag
 * while the current request is still running.
 *
 * PROVES: ticket ordering, independence between screens, and the exact
 * component contract — only the newest request may apply data, raise an error
 * or clear loading.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLatestOnly } from '../client/src/utils/latestOnly';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('latestOnly sequence guard (DF-08)', () => {
  test('begin() hands out increasing tickets and only the newest is current', () => {
    const guard = createLatestOnly();
    const first = guard.begin();
    assert.equal(guard.isCurrent(first), true);
    const second = guard.begin();
    assert.ok(second > first);
    assert.equal(guard.isCurrent(first), false);
    assert.equal(guard.isCurrent(second), true);
    const third = guard.begin();
    assert.equal(guard.isCurrent(second), false);
    assert.equal(guard.isCurrent(third), true);
  });

  test('guards are independent', () => {
    const ledger = createLatestOnly();
    const opening = createLatestOnly();
    const ledgerTicket = ledger.begin();
    opening.begin();
    assert.equal(ledger.isCurrent(ledgerTicket), true);
  });

  test('a never-begun ticket is never current', () => {
    const guard = createLatestOnly();
    guard.begin();
    assert.equal(guard.isCurrent(0), false);
    assert.equal(guard.isCurrent(99), false);
  });

  test('a slow older response cannot paint over the newer selection', async () => {
    const guard = createLatestOnly();
    const painted: string[] = [];
    let loading = false;

    const load = async (label: string, delayMs: number) => {
      const ticket = guard.begin();
      loading = true;
      try {
        await wait(delayMs);
        if (!guard.isCurrent(ticket)) return;
        painted.push(label);
      } finally {
        if (guard.isCurrent(ticket)) loading = false;
      }
    };

    // A is still in flight when B starts; A settles last.
    const first = load('customer-A', 30);
    const second = load('customer-B', 5);
    await second;
    assert.deepEqual(painted, ['customer-B']);
    assert.equal(loading, false);
    await first;
    assert.deepEqual(painted, ['customer-B'], 'the stale response must not paint');
    assert.equal(loading, false, 'the stale response must not settle the newer load');
  });

  test('a stale failure stays silent and keeps the current rows', async () => {
    const guard = createLatestOnly();
    let rows: string[] = ['existing'];
    let error = '';
    let loading = false;

    const load = async (label: string, delayMs: number, fail: boolean) => {
      const ticket = guard.begin();
      loading = true;
      try {
        await wait(delayMs);
        if (!guard.isCurrent(ticket)) return;
        if (fail) throw new Error(label);
        rows = [label];
        error = '';
      } catch {
        if (!guard.isCurrent(ticket)) return;
        rows = [];
        error = label;
      } finally {
        if (guard.isCurrent(ticket)) loading = false;
      }
    };

    const staleFailure = load('customer-A', 30, true);
    const currentSuccess = load('customer-B', 5, false);
    await currentSuccess;
    await staleFailure;

    assert.deepEqual(rows, ['customer-B'], 'the stale failure must not clear the current rows');
    assert.equal(error, '', 'the stale failure must not raise its error');
    assert.equal(loading, false);
  });

  test('loading settles only when the current request finishes', async () => {
    const guard = createLatestOnly();
    let loading = false;
    let painted = '';

    const load = async (label: string, delayMs: number) => {
      const ticket = guard.begin();
      loading = true;
      try {
        await wait(delayMs);
        if (!guard.isCurrent(ticket)) return;
        painted = label;
      } finally {
        if (guard.isCurrent(ticket)) loading = false;
      }
    };

    const staleFast = load('A', 5);
    const currentSlow = load('B', 20);
    await staleFast;
    assert.equal(loading, true, 'the stale response must not clear the newer loading flag');
    await currentSlow;
    assert.equal(loading, false);
    assert.equal(painted, 'B');
  });
});
