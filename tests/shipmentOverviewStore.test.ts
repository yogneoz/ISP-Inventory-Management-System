/**
 * Shipment overview store (VOL-3) — the shared bounded snapshot behind the
 * shell badges, dashboard KPI, notification center and receive lanes.
 *
 * PROVES:
 *   1. The merge puts every actionable row first and never duplicates the
 *      recent window against it.
 *   2. The store fetches once for concurrent consumers (shared in-flight).
 *   3. A branch-scope switch drops the old snapshot and discards the late
 *      answer for the previous scope — one branch can never paint another's
 *      counts.
 *   4. Invalidate keeps the previous counts/rows on screen while refetching,
 *      and a failed refetch reports the error without zeroing the badges.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createShipmentOverviewStore,
  mergeShipmentWindow,
  type ShipmentOverviewSnapshot,
} from '../client/src/services/shipmentOverviewStore';
import type { Shipment } from '../client/src/types';

const ship = (id: string): Shipment => ({ id, trackingCode: `ST-${id}`, status: 'IN_TRANSIT' } as Shipment);

const overview = (overrides: Partial<ShipmentOverviewSnapshot> = {}) => ({
  counts: { IN_TRANSIT: 2 },
  total: 2,
  pending: [ship('a'), ship('b')],
  recent: [ship('b'), ship('c')],
  pendingCapped: false,
  ...overrides,
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('mergeShipmentWindow', () => {
  test('pending rows come first and the recent window never duplicates them', () => {
    assert.deepEqual(
      mergeShipmentWindow([ship('a'), ship('b')], [ship('b'), ship('c')]).map((row) => row.id),
      ['a', 'b', 'c']
    );
  });

  test('falls back to the tracking code as the merge key', () => {
    const legacy = { trackingCode: 'ST-X', status: 'IN_TRANSIT' } as Shipment;
    const merged = mergeShipmentWindow([legacy, ship('a')], [legacy]);
    assert.equal(merged.length, 2, 'the same legacy row appears once even when both windows carry it');
    // A row with neither id nor tracking code cannot be addressed: dropped.
    assert.equal(mergeShipmentWindow([{} as Shipment], []).length, 0);
    assert.equal(mergeShipmentWindow([], []).length, 0);
  });
});

describe('createShipmentOverviewStore', () => {
  test('concurrent consumers share one in-flight request', async () => {
    let calls = 0;
    const pending: Array<ReturnType<typeof deferred<any>>> = [];
    const store = createShipmentOverviewStore(() => {
      calls++;
      const d = deferred<any>();
      pending.push(d);
      return d.promise;
    });
    const unsubscribe = store.subscribe(() => {});
    store.setScope('BR01');
    store.ensureLoaded();
    store.ensureLoaded();
    assert.equal(calls, 1);
    assert.equal(store.getSnapshot().loading, true);
    assert.equal(store.getSnapshot().scope, 'BR01');

    pending[0].resolve(overview());
    await tick();
    assert.deepEqual(store.getSnapshot().counts, { IN_TRANSIT: 2 });
    assert.equal(store.getSnapshot().loaded, true);
    assert.equal(store.getSnapshot().loading, false);
    unsubscribe();
  });

  test('switching branch scope discards the previous branch answer', async () => {
    const pending: Array<ReturnType<typeof deferred<any>>> = [];
    const store = createShipmentOverviewStore(() => {
      const d = deferred<any>();
      pending.push(d);
      return d.promise;
    });
    const unsubscribe = store.subscribe(() => {});
    store.setScope('BR01');
    store.setScope('BR02');
    assert.equal(pending.length, 2, 'a scope change fetches for the new branch');

    pending[0].resolve(overview({ counts: { IN_TRANSIT: 99 }, total: 99 }));
    await tick();
    assert.deepEqual(store.getSnapshot().counts, {}, 'the stale branch must not paint the new scope');

    pending[1].resolve(overview({ counts: { IN_TRANSIT: 3 }, total: 3 }));
    await tick();
    assert.equal(store.getSnapshot().scope, 'BR02');
    assert.deepEqual(store.getSnapshot().counts, { IN_TRANSIT: 3 });
    unsubscribe();
  });

  test('invalidate keeps the previous rows while refetching, and a failure keeps the counts', async () => {
    const pending: Array<ReturnType<typeof deferred<any>>> = [];
    const store = createShipmentOverviewStore(() => {
      const d = deferred<any>();
      pending.push(d);
      return d.promise;
    });
    const unsubscribe = store.subscribe(() => {});
    // The store starts on 'ALL', so a same-scope setScope is a no-op; switch
    // to a branch to start the first load.
    store.setScope('BR01');
    pending[0].resolve(overview());
    await tick();
    assert.equal(store.getSnapshot().loaded, true);

    store.invalidate();
    // `loaded` drops so a late-arriving bootstrap cannot claim freshness, but
    // the badge data stays on screen until the new answer lands.
    assert.equal(store.getSnapshot().loaded, false);
    assert.deepEqual(store.getSnapshot().counts, { IN_TRANSIT: 2 });
    assert.equal(store.getSnapshot().loading, true);

    pending[1].reject(new Error('Database offline'));
    await tick();
    assert.equal(store.getSnapshot().error, 'Database offline');
    assert.deepEqual(store.getSnapshot().counts, { IN_TRANSIT: 2 }, 'a failed refresh must not zero the KPIs');
    assert.equal(store.getSnapshot().loaded, false);
    unsubscribe();
  });

  test('a late answer from a superseded refresh is ignored', async () => {
    const pending: Array<ReturnType<typeof deferred<any>>> = [];
    const store = createShipmentOverviewStore(() => {
      const d = deferred<any>();
      pending.push(d);
      return d.promise;
    });
    const unsubscribe = store.subscribe(() => {});
    store.setScope('BR01');
    store.refresh();
    pending[1].resolve(overview({ counts: { IN_TRANSIT: 7 }, total: 7 }));
    await tick();
    pending[0].resolve(overview({ counts: { IN_TRANSIT: 1 }, total: 1 }));
    await tick();
    assert.deepEqual(store.getSnapshot().counts, { IN_TRANSIT: 7 });
    unsubscribe();
  });

  test('setScope to the same branch is a no-op', async () => {
    let calls = 0;
    const store = createShipmentOverviewStore(async () => {
      calls++;
      return overview();
    });
    const unsubscribe = store.subscribe(() => {});
    store.setScope('BR01');
    store.setScope('BR01');
    await tick();
    assert.equal(calls, 1);
    unsubscribe();
  });
});
