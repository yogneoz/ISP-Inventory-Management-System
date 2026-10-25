/**
 * Unit tests for the scoped pending-procurement store (node:test).
 *
 * These cover the rules the KPI surfaces rely on: one request per scope,
 * stale scopes never paint, a failed read keeps the last good rows, Retry and
 * the SSE invalidate both re-read, and the unpaid count comes from the paged
 * envelope's status counts instead of the invoice rows.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProcurementPendingStore,
  isOpenPurchaseOrder,
  pendingPurchaseOrderRows,
  pendingScopeKey,
  unpaidInvoiceCountFrom,
  type ProcurementPendingPayload,
  type ProcurementPendingScope,
} from '../client/src/services/procurementPendingStore';
import type { PurchaseInvoice, PurchaseOrder } from '../client/src/types';

const scope = (branchId: string, start = '2026-07-17', end = '2027-07-16'): ProcurementPendingScope => ({
  branchId,
  fiscalYearStartAD: start,
  fiscalYearEndAD: end,
});

const po = (id: string, status = 'SENT'): PurchaseOrder =>
  ({ id, status, poNumber: `PO-${id}` }) as PurchaseOrder;

const payload = (ids: string[], unpaid = 0): ProcurementPendingPayload => ({
  pendingPurchaseOrders: ids.map((id) => po(id)),
  unpaidInvoiceCount: unpaid,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('pending procurement helpers', () => {
  test('scope key distinguishes branch and fiscal year', () => {
    assert.notEqual(pendingScopeKey(scope('WH001')), pendingScopeKey(scope('BRH01')));
    assert.notEqual(pendingScopeKey(scope('WH001')), pendingScopeKey(scope('WH001', '2025-07-17', '2026-07-16')));
    assert.equal(pendingScopeKey(scope('WH001')), pendingScopeKey(scope('WH001')));
  });

  test('open POs exclude received and cancelled rows from either response shape', () => {
    assert.equal(isOpenPurchaseOrder(po('a', 'DRAFT')), true);
    assert.equal(isOpenPurchaseOrder(po('a', 'PURCHASED')), true);
    assert.equal(isOpenPurchaseOrder(po('a', 'RECEIVED')), false);
    assert.equal(isOpenPurchaseOrder(po('a', 'CANCELLED')), false);
    assert.deepEqual(
      pendingPurchaseOrderRows([po('a'), po('b', 'RECEIVED')]).map((row) => row.id),
      ['a']
    );
    assert.deepEqual(
      pendingPurchaseOrderRows({ data: [po('c', 'APPROVED'), po('d', 'CANCELLED')] }).map((row) => row.id),
      ['c']
    );
  });

  test('unpaid invoices are every payment status except PAID', () => {
    assert.equal(
      unpaidInvoiceCountFrom({ totalItems: 10, statusCounts: { PAID: 6, PARTIAL: 2, UNPAID: 2 } }),
      4
    );
    assert.equal(unpaidInvoiceCountFrom({ totalItems: 7 }), 7);
    assert.equal(
      unpaidInvoiceCountFrom([
        { paymentStatus: 'PAID' } as PurchaseInvoice,
        { paymentStatus: 'UNPAID' } as PurchaseInvoice,
      ]),
      1
    );
    assert.equal(unpaidInvoiceCountFrom({ totalItems: 3, statusCounts: { paid: 3 } }), 0);
  });
});

describe('createProcurementPendingStore', () => {
  test('one request per scope even when several hosts ask in the same tick', async () => {
    let calls = 0;
    const first = deferred<ProcurementPendingPayload>();
    const store = createProcurementPendingStore(() => {
      calls++;
      return first.promise;
    });

    store.ensureLoaded(scope('WH001'));
    store.ensureLoaded(scope('WH001'));
    store.ensureLoaded(scope('WH001'));
    assert.equal(calls, 1);
    assert.equal(store.getSnapshot().loading, true);

    first.resolve(payload(['po-1'], 3));
    await flush();
    assert.equal(calls, 1);
    assert.equal(store.getSnapshot().loaded, true);
    assert.equal(store.getSnapshot().pendingPurchaseOrders.length, 1);
    assert.equal(store.getSnapshot().unpaidInvoiceCount, 3);
  });

  test('switching branch clears the old rows and discards its late response', async () => {
    const warehouse = deferred<ProcurementPendingPayload>();
    const branch = deferred<ProcurementPendingPayload>();
    const queue = [warehouse, branch];
    const store = createProcurementPendingStore(() => queue.shift()!.promise);

    store.ensureLoaded(scope('WH001'));
    store.ensureLoaded(scope('BRH01'));
    const afterSwitch = store.getSnapshot();
    assert.equal(afterSwitch.scopeKey, pendingScopeKey(scope('BRH01')));
    assert.deepEqual(afterSwitch.pendingPurchaseOrders, []);
    assert.equal(afterSwitch.unpaidInvoiceCount, 0);

    warehouse.resolve(payload(['warehouse-po'], 9));
    await flush();
    assert.deepEqual(
      store.getSnapshot().pendingPurchaseOrders,
      [],
      'the abandoned branch response must never paint'
    );

    branch.resolve(payload(['branch-po'], 1));
    await flush();
    assert.deepEqual(
      store.getSnapshot().pendingPurchaseOrders.map((row) => row.id),
      ['branch-po']
    );
    assert.equal(store.getSnapshot().unpaidInvoiceCount, 1);
  });

  test('a failed read keeps the last good rows and Retry clears the error', async () => {
    const first = deferred<ProcurementPendingPayload>();
    const second = deferred<ProcurementPendingPayload>();
    const third = deferred<ProcurementPendingPayload>();
    const calls = [first, second, third];
    let index = 0;
    const clean = createProcurementPendingStore(() => calls[index++].promise);

    clean.ensureLoaded(scope('WH001'));
    first.resolve(payload(['last-good'], 2));
    await flush();
    assert.deepEqual(clean.getSnapshot().pendingPurchaseOrders.map((row) => row.id), ['last-good']);

    clean.refresh();
    second.reject(new Error('database unavailable'));
    await flush();
    assert.deepEqual(
      clean.getSnapshot().pendingPurchaseOrders.map((row) => row.id),
      ['last-good'],
      'the last good KPI rows must survive a failed refresh'
    );
    assert.equal(clean.getSnapshot().error, 'database unavailable');
    assert.equal(clean.getSnapshot().loaded, false);

    clean.refresh();
    third.resolve(payload(['fresh'], 4));
    await flush();
    assert.equal(clean.getSnapshot().error, '');
    assert.equal(clean.getSnapshot().loaded, true);
    assert.deepEqual(clean.getSnapshot().pendingPurchaseOrders.map((row) => row.id), ['fresh']);
    assert.equal(clean.getSnapshot().unpaidInvoiceCount, 4);
  });

  test('invalidate refetches only while a host is subscribed', async () => {
    const reads = [deferred<ProcurementPendingPayload>(), deferred<ProcurementPendingPayload>()];
    let index = 0;
    const store = createProcurementPendingStore(() => reads[index++].promise);

    store.invalidate();
    assert.equal(index, 0, 'no scope yet — nothing to refetch');

    store.ensureLoaded(scope('WH001'));
    reads[0].resolve(payload(['first']));
    await flush();

    const unsubscribe = store.subscribe(() => {});
    store.invalidate();
    await flush();
    assert.equal(index, 2, 'an SSE invalidation re-reads the current scope');
    assert.deepEqual(store.getSnapshot().pendingPurchaseOrders.map((row) => row.id), ['first']);
    assert.equal(store.getSnapshot().loading, true);

    reads[1].resolve(payload(['after-sse'], 1));
    await flush();
    assert.deepEqual(store.getSnapshot().pendingPurchaseOrders.map((row) => row.id), ['after-sse']);
    unsubscribe();
  });

  test('no fiscal-year range means no request (the caller cannot scope the answer)', () => {
    let calls = 0;
    const store = createProcurementPendingStore(async () => {
      calls++;
      return payload([]);
    });
    store.ensureLoaded({ branchId: 'WH001' });
    assert.equal(calls, 0);
    assert.equal(store.getSnapshot().loading, false);
  });
});
