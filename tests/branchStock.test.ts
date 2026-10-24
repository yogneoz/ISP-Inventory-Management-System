/**
 * Branch stock for the operation forms — pure cache tests, no React or DB.
 *
 * The forms used to compute availability from the bootstrap `stock` array,
 * which the server scopes to the HEADER's branch. Selecting another source
 * branch therefore compared against rows that were never in the payload:
 * Branch 2 showed "0 in stock" while the serial register said the unit was
 * IN_STOCK at BRH01, and the pre-submit check refused a valid deployment.
 *
 * These tests pin the two behaviours the fix relies on:
 *  - the fetch cache reads each selectable branch once, shared by every
 *    mounted form, and refetches on App's invalidation;
 *  - a failed read keeps the last rows and is reportable, so availability
 *    never silently collapses to zero.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBranchStockStore,
  mergeBranchStock,
} from '../client/src/services/branchStockStore';
import type { InventoryStock } from '../client/src/types';

const stockRow = (
  productId: string,
  branchId: string,
  quantityOnHand: number
): InventoryStock =>
  ({
    id: `stk-${branchId}-${productId}`,
    productId,
    branchId,
    quantityOnHand,
    damagedQty: 0,
    reservedQty: 0,
    incomingQty: 0,
    minReorderLevel: 0,
  }) as InventoryStock;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('branch stock cache', () => {
  test('merge keeps the header snapshot authoritative and adds the other branches', () => {
    const fallback = [stockRow('onu', 'WH001', 3)];
    const fetched = [
      // Same (product, branch) as the header snapshot: the bootstrap row wins
      // (it carries the fiscal-year view), and it must not appear twice.
      stockRow('onu', 'WH001', 99),
      stockRow('onu', 'BRH01', 2),
      stockRow('onu', 'BRH01', 2),
    ];
    const merged = mergeBranchStock(fallback, fetched);
    assert.deepEqual(
      merged.map((r) => `${r.branchId}:${r.productId}:${r.quantityOnHand}`),
      ['WH001:onu:3', 'BRH01:onu:2']
    );
  });

  test('every form shares one read per branch, and only once', async () => {
    const calls: string[] = [];
    const store = createBranchStockStore(async (branchId) => {
      calls.push(branchId);
      return [stockRow('onu', branchId, 2)];
    });
    store.subscribe(() => undefined);

    store.ensureLoaded(['WH001', 'BRH01']);
    store.ensureLoaded(['WH001', 'BRH01']);
    store.ensureLoaded(['BRH01']);
    await flush();

    assert.deepEqual(calls.sort(), ['BRH01', 'WH001']);
    assert.equal(store.getSnapshot().rows.length, 2);
    assert.equal(store.getSnapshot().loaded, true);
    assert.equal(store.getSnapshot().error, '');
  });

  test('a failed refresh keeps the last rows, reports the error, and a retry clears it', async () => {
    let fail = false;
    const store = createBranchStockStore(async (branchId) => {
      if (fail) throw new Error('branch stock read failed');
      return [stockRow('onu', branchId, 2)];
    });
    store.subscribe(() => undefined);

    store.ensureLoaded(['BRH01']);
    await flush();
    assert.equal(store.getSnapshot().rows.length, 1);

    fail = true;
    store.refresh();
    await flush();
    assert.equal(store.getSnapshot().error, 'branch stock read failed');
    assert.deepEqual(
      store.getSnapshot().rows.map((r) => r.quantityOnHand),
      [2],
      'a failed refresh must not blank availability to 0'
    );
    assert.equal(store.getSnapshot().loaded, false);

    fail = false;
    store.refresh();
    await flush();
    assert.equal(store.getSnapshot().error, '');
    assert.equal(store.getSnapshot().loaded, true);
  });

  test('invalidation coalesces across hosts and refetches every form branch', async () => {
    let calls = 0;
    const store = createBranchStockStore(async (branchId) => {
      calls++;
      return [stockRow('onu', branchId, 2)];
    });
    // Two mounted hosts (Stock Operations + Shipments).
    store.subscribe(() => undefined);
    store.subscribe(() => undefined);

    store.ensureLoaded(['WH001', 'BRH01']);
    await flush();
    assert.equal(calls, 2);

    // One SSE burst invalidates both hosts in the same tick.
    store.invalidate();
    store.invalidate();
    // Rows stay on screen while the refetch is in flight.
    assert.equal(store.getSnapshot().rows.length, 2);
    await flush();

    assert.equal(calls, 4, 'one refetch per branch, not one per host');
    assert.equal(store.getSnapshot().loaded, true);
  });

  test('reset (sign-out) drops cached rows and refetches on the next consumer', async () => {
    const calls: string[] = [];
    const store = createBranchStockStore(async (branchId) => {
      calls.push(branchId);
      return [stockRow('onu', branchId, 2)];
    });
    store.subscribe(() => undefined);

    store.ensureLoaded(['WH001', 'BRH01']);
    await flush();
    assert.equal(store.getSnapshot().rows.length, 2);

    store.reset();
    assert.equal(store.getSnapshot().rows.length, 0, 'a new user must not inherit the previous branch rows');
    assert.equal(store.getSnapshot().loaded, false);

    store.ensureLoaded(['BRH01']);
    await flush();
    assert.deepEqual(calls, ['WH001', 'BRH01', 'BRH01']);
    assert.deepEqual(
      store.getSnapshot().rows.map((r) => r.branchId),
      ['BRH01']
    );
  });

  test('a late answer to a superseded request never overwrites newer rows', async () => {
    const pending: ((rows: InventoryStock[]) => void)[] = [];
    const store = createBranchStockStore(
      () =>
        new Promise<InventoryStock[]>((resolve) => {
          pending.push(resolve);
        })
    );
    store.subscribe(() => undefined);

    store.ensureLoaded(['BRH01']);
    store.refresh();
    assert.equal(pending.length, 2);

    pending[0]([stockRow('onu', 'BRH01', 9)]);
    await flush();
    assert.equal(store.getSnapshot().rows.length, 0, 'stale response discarded');

    pending[1]([stockRow('onu', 'BRH01', 2)]);
    await flush();
    assert.deepEqual(
      store.getSnapshot().rows.map((r) => r.quantityOnHand),
      [2]
    );
  });
});
