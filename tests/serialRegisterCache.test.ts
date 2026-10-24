/**
 * Shared serial-register cache (DF-03) — pure store tests, no React or DB.
 *
 * Every stock gate used to fetch GET /api/serial-log?all=1 once per mounted
 * StockOperations host and never invalidate it, so a transfer received or a
 * serial sold elsewhere left 11 open gates trusting a session-old snapshot.
 * The store now dedupes that fetch and invalidates on App's SSE/refresh
 * signal; these tests pin the behaviour the gates rely on.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSerialRegisterStore } from '../client/src/services/serialRegisterStore';
import type { SerialLog } from '../client/src/types';

const row = (serial: string): SerialLog => ({
  id: `sl-${serial}`,
  deviceSerial: serial,
  productName: 'ONU ROUTER',
  branchId: 'WH001',
  status: 'IN_STOCK',
  sourceType: 'PURCHASE',
  history: [],
  createdAt: '2026-01-01T00:00:00.000Z',
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('serial register cache', () => {
  test('eleven consumers share ONE in-flight fetch, and the envelope shape is accepted', async () => {
    let calls = 0;
    let release: (value: any) => void = () => undefined;
    const store = createSerialRegisterStore(() => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    store.subscribe(() => undefined);

    for (let i = 0; i < 11; i++) store.ensureLoaded();
    assert.equal(calls, 1, '11 mounted stock hosts must not produce 11 register GETs');

    release({ data: [row('A')], page: 1, pageSize: 1, totalItems: 1, statusCounts: {} });
    await flush();

    assert.deepEqual(store.getSnapshot().rows.map((r) => r.deviceSerial), ['A']);
    assert.equal(store.getSnapshot().loaded, true);
    assert.equal(store.getSnapshot().loading, false);
  });

  test('invalidate refetches for subscribers and discards the superseded response', async () => {
    let calls = 0;
    const pending: ((value: any) => void)[] = [];
    const store = createSerialRegisterStore(() => {
      calls++;
      return new Promise((resolve) => pending.push(resolve));
    });
    store.subscribe(() => undefined);

    store.ensureLoaded();
    assert.equal(calls, 1);

    store.invalidate();
    assert.equal(calls, 2, 'with a subscriber, invalidation starts a fresh fetch immediately');

    pending[0]([row('OLD')]);
    await flush();
    assert.equal(store.getSnapshot().rows.length, 0, 'a late answer to the invalidated request is discarded');

    pending[1]([row('NEW')]);
    await flush();
    assert.deepEqual(store.getSnapshot().rows.map((r) => r.deviceSerial), ['NEW']);
    assert.equal(store.getSnapshot().loaded, true);
  });

  test('a failed refresh keeps the last rows and surfaces the error until a retry succeeds', async () => {
    let fail = false;
    let calls = 0;
    const store = createSerialRegisterStore(async () => {
      calls++;
      if (fail) throw new Error('offline');
      return [row('KEEP')];
    });

    store.ensureLoaded();
    await flush();
    assert.deepEqual(store.getSnapshot().rows.map((r) => r.deviceSerial), ['KEEP']);

    fail = true;
    store.refresh();
    await flush();
    assert.deepEqual(
      store.getSnapshot().rows.map((r) => r.deviceSerial),
      ['KEEP'],
      'a failed refresh must not look like an empty register'
    );
    assert.equal(store.getSnapshot().error, 'offline');
    assert.equal(store.getSnapshot().loading, false);

    fail = false;
    store.refresh();
    await flush();
    assert.equal(store.getSnapshot().error, '');
    assert.equal(store.getSnapshot().loaded, true);
  });

  test('invalidate without subscribers marks the snapshot stale without fetching', async () => {
    let calls = 0;
    const store = createSerialRegisterStore(async () => {
      calls++;
      return [row('A')];
    });

    store.invalidate();
    assert.equal(calls, 0, 'no mounted consumer means no fetch for an invalidated cache');

    store.ensureLoaded();
    await flush();
    assert.equal(calls, 1);
    assert.equal(store.getSnapshot().rows[0].deviceSerial, 'A');
  });

  test('a first-load failure is reported, and ensureLoaded retries once the failure clears', async () => {
    let fail = true;
    const store = createSerialRegisterStore(async () => {
      if (fail) throw new Error('register down');
      return [row('LATE')];
    });

    store.ensureLoaded();
    await flush();
    assert.equal(store.getSnapshot().rows.length, 0);
    assert.equal(store.getSnapshot().error, 'register down');
    assert.equal(store.getSnapshot().loaded, false);

    fail = false;
    store.ensureLoaded();
    await flush();
    assert.deepEqual(store.getSnapshot().rows.map((r) => r.deviceSerial), ['LATE']);
    assert.equal(store.getSnapshot().error, '');
  });
});
