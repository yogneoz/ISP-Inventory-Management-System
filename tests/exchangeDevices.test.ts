/**
 * DF-16 — the Device Exchange device list is branch-safe, retryable and shared.
 *
 * The StockOperations host read `GET /api/customer-devices` itself, once per
 * mounted host (up to 11), and on failure only logged: the previous branch's
 * units stayed on screen under the new branch's name, with no notice and no
 * Retry. These tests pin the replacement cache and its wiring:
 *
 *  - one request per branch, shared by every host and remount;
 *  - a branch that has not been read is EMPTY — never the previous branch's
 *    rows — and a failed read clears the scope and reports it;
 *  - Retry re-reads; invalidation coalesces; superseded answers are discarded;
 *  - App invalidates on the CPE/asset SSE domains and full refresh, and resets
 *    on sign-out;
 *  - the panel renders the retryable notice and refreshes the cache after an
 *    exchange instead of fetching the list itself.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createExchangeDevicesStore,
  exchangeScope,
} from '../client/src/services/exchangeDeviceStore';
import type { CustomerDeviceRecord } from '../client/src/types';

const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8');

const device = (id: string): CustomerDeviceRecord =>
  ({ id, deviceSerial: `SN-${id}`, customerName: `Customer ${id}` }) as unknown as CustomerDeviceRecord;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('exchange device cache', () => {
  test('every host and remount shares one read per branch', async () => {
    const calls: (string | undefined)[] = [];
    const store = createExchangeDevicesStore(async (branchId) => {
      calls.push(branchId);
      return [device('a')];
    });
    // Two mounted StockOperations hosts.
    store.subscribe(() => undefined);
    store.subscribe(() => undefined);

    store.ensureLoaded('WH001');
    store.ensureLoaded('WH001');
    store.ensureLoaded('WH001');
    await flush();

    assert.deepEqual(calls, ['WH001'], 'one request for the branch, not one per host');
    assert.equal(store.getEntry('WH001').rows.length, 1);
    assert.equal(store.getEntry('WH001').loaded, true);
    assert.equal(store.getEntry('WH001').error, '');
  });

  test('a branch switch never shows the previous branch’s units', async () => {
    const store = createExchangeDevicesStore(async (branchId) => [device(String(branchId))]);
    store.subscribe(() => undefined);

    store.ensureLoaded('WH001');
    await flush();
    assert.equal(store.getEntry('WH001').rows.length, 1);

    // The header moves to another branch before its read has been issued.
    assert.deepEqual(
      store.getEntry('BRH02').rows,
      [],
      'an unread branch is empty — never the rows of the branch just left'
    );

    store.ensureLoaded('BRH02');
    await flush();
    assert.deepEqual(
      store.getEntry('BRH02').rows.map((row) => row.id),
      ['BRH02']
    );
  });

  test('a failed read clears the scope, reports it, and Retry re-reads', async () => {
    let fail = true;
    const store = createExchangeDevicesStore(async (branchId) => {
      if (fail) throw new Error('customer devices read failed');
      return [device(String(branchId))];
    });
    store.subscribe(() => undefined);

    store.ensureLoaded('BRH02');
    await flush();
    assert.deepEqual(store.getEntry('BRH02').rows, [], 'a failure must not leave stale units on screen');
    assert.equal(store.getEntry('BRH02').error, 'customer devices read failed');
    assert.equal(store.getEntry('BRH02').loaded, false);

    fail = false;
    store.refresh('BRH02');
    await flush();
    assert.equal(store.getEntry('BRH02').error, '');
    assert.equal(store.getEntry('BRH02').rows.length, 1);
    assert.equal(store.getEntry('BRH02').loaded, true);
  });

  test('a failed refresh of a loaded branch also empties the list', async () => {
    let fail = false;
    const store = createExchangeDevicesStore(async (branchId) => {
      if (fail) throw new Error('server unavailable');
      return [device(String(branchId))];
    });
    store.subscribe(() => undefined);

    store.ensureLoaded('WH001');
    await flush();
    assert.equal(store.getEntry('WH001').rows.length, 1);

    fail = true;
    store.refresh('WH001');
    await flush();
    assert.deepEqual(store.getEntry('WH001').rows, []);
    assert.equal(store.getEntry('WH001').error, 'server unavailable');
  });

  test('invalidation coalesces across hosts and refetches each requested branch once', async () => {
    const calls: (string | undefined)[] = [];
    const store = createExchangeDevicesStore(async (branchId) => {
      calls.push(branchId);
      return [device(String(branchId))];
    });
    store.subscribe(() => undefined);
    store.subscribe(() => undefined);

    store.ensureLoaded('WH001');
    await flush();
    assert.equal(calls.length, 1);

    store.invalidate();
    store.invalidate();
    assert.equal(store.getEntry('WH001').rows.length, 1, 'rows stay until the refetch answers');
    await flush();

    assert.equal(calls.length, 2, 'one refetch for the burst, not one per host');
    assert.equal(store.getEntry('WH001').loaded, true);
  });

  test('a late answer to a superseded request never overwrites newer rows', async () => {
    const pending: ((rows: CustomerDeviceRecord[]) => void)[] = [];
    const store = createExchangeDevicesStore(
      () =>
        new Promise<CustomerDeviceRecord[]>((resolve) => {
          pending.push(resolve);
        })
    );
    store.subscribe(() => undefined);

    store.ensureLoaded('WH001');
    store.refresh('WH001');
    assert.equal(pending.length, 2);

    pending[0]([device('old')]);
    await flush();
    assert.deepEqual(store.getEntry('WH001').rows, [], 'the superseded answer is discarded');

    pending[1]([device('new')]);
    await flush();
    assert.deepEqual(
      store.getEntry('WH001').rows.map((row) => row.id),
      ['new']
    );
  });

  test('reset (sign-out) drops every branch and refetches on the next host', async () => {
    const calls: (string | undefined)[] = [];
    const store = createExchangeDevicesStore(async (branchId) => {
      calls.push(branchId);
      return [device(String(branchId))];
    });
    store.subscribe(() => undefined);

    store.ensureLoaded('WH001');
    await flush();
    assert.equal(store.getEntry('WH001').rows.length, 1);

    store.reset();
    assert.deepEqual(store.getEntry('WH001').rows, [], 'a new user must not inherit the previous branch rows');

    store.ensureLoaded('BRH02');
    await flush();
    assert.deepEqual(calls, ['WH001', 'BRH02']);
  });

  test('scope keys keep ALL and a branch apart', () => {
    assert.equal(exchangeScope(undefined), 'ALL');
    assert.equal(exchangeScope(null), 'ALL');
    assert.equal(exchangeScope('ALL'), 'ALL');
    assert.equal(exchangeScope('WH001'), 'WH001');
  });
});

describe('DF-16 — wiring', () => {
  const app = read('client/src/App.tsx');

  test('App invalidates on CPE/asset events and full refresh, and resets on sign-out', () => {
    assert.ok(
      app.includes('invalidateExchangeDevices'),
      'App must invalidate the shared exchange cache'
    );
    assert.ok(
      app.includes("domains.includes('CUSTOMER_DEVICES') || domains.includes('ASSETS')"),
      'CPE flows and asset moves create/close the deployed-device rows'
    );
    assert.match(
      app,
      /invalidateBranchStock\(\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*invalidateExchangeDevices\(\);/,
      'a full refresh must re-read the exchange list too'
    );
    assert.ok(app.includes('resetExchangeDevices();'), 'sign-out must drop the cached branches');
  });

  test('the host reads the cache and no longer fetches the device list itself', () => {
    const host = read('client/src/features/inventory/StockOperations.tsx');
    assert.ok(host.includes('useExchangeDevices(selectedBranchId)'), 'the host must use the shared cache');
    assert.ok(!host.includes('api.getCustomerDevices('), 'the per-host read must not come back');
    assert.ok(host.includes('exchangeDevicesError: exchangeDevices.error'));
    assert.ok(host.includes('retryExchangeDevices: exchangeDevices.retry'));
    assert.ok(host.includes('exchangeCustomerDevices: exchangeDevices.rows'));
    assert.ok(host.includes('isLoadingExchangeDevices: exchangeDevices.loading'));
  });

  test('the panel surfaces the retryable notice and refreshes after an exchange', () => {
    const panel = read('client/src/features/inventory/stockops/DeviceExchangePanel.tsx');
    assert.match(
      panel,
      /<LoadStateNotice\s+subject="exchange devices"\s+loading=\{isLoadingExchangeDevices\}\s+error=\{exchangeDevicesError\}\s+onRetry=\{retryExchangeDevices\}/,
      'a failed read must be visible, with a Retry, in the exchange panel'
    );
    assert.ok(
      panel.includes('retryExchangeDevices();'),
      'a successful exchange must refresh the shared list'
    );
    assert.ok(!panel.includes('getCustomerDevices('), 'the panel must not fetch the list itself');
    assert.ok(
      panel.includes('The deployed-device list is unavailable until the read above succeeds.'),
      'the empty state must not claim "no devices match" when the read failed'
    );
  });

  test('the cache is one shared instance behind useSyncExternalStore', () => {
    const cache = read('client/src/services/exchangeDeviceCache.ts');
    assert.ok(cache.includes('createExchangeDevicesStore((branchId) =>'));
    assert.ok(cache.includes('api.getCustomerDevices(branchId)'));
    assert.ok(cache.includes('useSyncExternalStore(exchangeDevicesStore.subscribe'));
    assert.ok(cache.includes('exchangeDevicesStore.ensureLoaded(scope)'));
  });
});
