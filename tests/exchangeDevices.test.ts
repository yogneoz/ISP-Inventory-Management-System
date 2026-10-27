/**
 * DF-16 + EXCH-1 — the Device Exchange device list is branch-safe, searchable
 * server-side, retryable and shared.
 *
 * DF-16: the StockOperations host read `GET /api/customer-devices` itself, once
 * per mounted host (up to 11), and on failure only logged: the previous
 * branch's units stayed on screen under the new branch's name, with no notice
 * and no Retry. EXCH-1: that read was also the bounded legacy array (2,000
 * newest rows), so an older deployed unit could not be exchanged at all.
 *
 * These tests pin the replacement cache and its wiring:
 *
 *  - one request per scope (branch + eligibility + search), shared by hosts;
 *  - a branch that has not been read is EMPTY — never the previous branch's
 *    rows — and a failed read clears the scope and reports it;
 *  - Retry re-reads; invalidation coalesces; superseded answers are discarded;
 *  - a typed term becomes its own scope and reaches the server as `query`;
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
  exchangeQueryScope,
  exchangeScope,
  resolveExchangeView,
  type ExchangeDevicesEntry,
  type ExchangeDevicesPage,
  type ExchangeDevicesQuery,
} from '../client/src/services/exchangeDeviceStore';
import type { CustomerDeviceRecord } from '../client/src/types';

const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8');

const device = (id: string): CustomerDeviceRecord =>
  ({ id, deviceSerial: `SN-${id}`, customerName: `Customer ${id}` }) as unknown as CustomerDeviceRecord;

const page = (rows: CustomerDeviceRecord[], totalItems = rows.length): ExchangeDevicesPage => ({
  rows,
  totalItems,
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('exchange device cache', () => {
  test('every host and remount shares one read per scope', async () => {
    const calls: ExchangeDevicesQuery[] = [];
    const store = createExchangeDevicesStore(async (request) => {
      calls.push(request);
      return page([device('a')]);
    });
    // Two mounted StockOperations hosts.
    store.subscribe(() => undefined);
    store.subscribe(() => undefined);

    store.ensureLoaded('WH001', { branchId: 'WH001' });
    store.ensureLoaded('WH001', { branchId: 'WH001' });
    store.ensureLoaded('WH001', { branchId: 'WH001' });
    await flush();

    assert.equal(calls.length, 1, 'one request per scope, not one per host');
    assert.equal(calls[0].branchId, 'WH001');
    assert.equal(store.getEntry('WH001').rows.length, 1);
    assert.equal(store.getEntry('WH001').totalItems, 1);
    assert.equal(store.getEntry('WH001').loaded, true);
    assert.equal(store.getEntry('WH001').error, '');
  });

  test('a branch switch never shows the previous branch’s units', async () => {
    const store = createExchangeDevicesStore(async (request) => page([device(String(request.branchId))]));
    store.subscribe(() => undefined);

    store.ensureLoaded('WH001', { branchId: 'WH001' });
    await flush();
    assert.equal(store.getEntry('WH001').rows.length, 1);

    // The header moves to another branch before its read has been issued.
    assert.deepEqual(
      store.getEntry('BRH02').rows,
      [],
      'an unread branch is empty — never the rows of the branch just left'
    );

    store.ensureLoaded('BRH02', { branchId: 'BRH02' });
    await flush();
    assert.deepEqual(
      store.getEntry('BRH02').rows.map((row) => row.id),
      ['BRH02']
    );
  });

  test('a failed read clears the scope, reports it, and Retry re-reads', async () => {
    let fail = true;
    const store = createExchangeDevicesStore(async (request) => {
      if (fail) throw new Error('customer devices read failed');
      return page([device(String(request.branchId))]);
    });
    store.subscribe(() => undefined);

    store.ensureLoaded('BRH02', { branchId: 'BRH02' });
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
    const store = createExchangeDevicesStore(async (request) => {
      if (fail) throw new Error('server unavailable');
      return page([device(String(request.branchId))]);
    });
    store.subscribe(() => undefined);

    store.ensureLoaded('WH001', { branchId: 'WH001' });
    await flush();
    assert.equal(store.getEntry('WH001').rows.length, 1);

    fail = true;
    store.refresh('WH001');
    await flush();
    assert.deepEqual(store.getEntry('WH001').rows, []);
    assert.equal(store.getEntry('WH001').error, 'server unavailable');
  });

  test('invalidation coalesces across hosts and refetches each live scope once', async () => {
    const calls: ExchangeDevicesQuery[] = [];
    const store = createExchangeDevicesStore(async (request) => {
      calls.push(request);
      return page([device(String(request.branchId))]);
    });
    store.subscribe(() => undefined);
    store.subscribe(() => undefined);

    store.ensureLoaded('WH001', { branchId: 'WH001' });
    await flush();
    assert.equal(calls.length, 1);

    store.invalidate();
    store.invalidate();
    assert.equal(store.getEntry('WH001').rows.length, 1, 'rows stay until the refetch answers');
    await flush();

    assert.equal(calls.length, 2, 'one refetch for the burst, not one per host');
    assert.equal(store.getEntry('WH001').loaded, true);
  });

  test('only scopes a mounted host still holds are refetched', async () => {
    const calls: ExchangeDevicesQuery[] = [];
    const store = createExchangeDevicesStore(async (request) => {
      calls.push(request);
      return page([device(String(request.query || 'x'))]);
    });
    store.subscribe(() => undefined);

    // A term was typed (its own scope) and then the operator cleared it.
    store.ensureLoaded('WH001|RENTAL,ACTIVE|onu', { branchId: 'WH001', query: 'onu' });
    await flush();
    store.release('WH001|RENTAL,ACTIVE|onu');

    store.ensureLoaded('WH001', { branchId: 'WH001' });
    await flush();
    calls.length = 0;
    store.invalidate();
    await flush();
    assert.deepEqual(
      calls.map((c) => c.query),
      [undefined],
      'an abandoned search term must not be refetched on every SSE burst'
    );
  });

  test('a late answer to a superseded request never overwrites newer rows', async () => {
    const pending: ((rows: ExchangeDevicesPage) => void)[] = [];
    const store = createExchangeDevicesStore(
      () =>
        new Promise<ExchangeDevicesPage>((resolve) => {
          pending.push(resolve);
        })
    );
    store.subscribe(() => undefined);

    store.ensureLoaded('WH001', { branchId: 'WH001' });
    store.refresh('WH001');
    assert.equal(pending.length, 2);

    pending[0](page([device('old')]));
    await flush();
    assert.deepEqual(store.getEntry('WH001').rows, [], 'the superseded answer is discarded');

    pending[1](page([device('new')]));
    await flush();
    assert.deepEqual(
      store.getEntry('WH001').rows.map((row) => row.id),
      ['new']
    );
  });

  test('reset (sign-out) drops every branch and refetches on the next host', async () => {
    const calls: ExchangeDevicesQuery[] = [];
    const store = createExchangeDevicesStore(async (request) => {
      calls.push(request);
      return page([device(String(request.branchId))]);
    });
    store.subscribe(() => undefined);

    store.ensureLoaded('WH001', { branchId: 'WH001' });
    await flush();
    assert.equal(store.getEntry('WH001').rows.length, 1);

    store.reset();
    assert.deepEqual(store.getEntry('WH001').rows, [], 'a new user must not inherit the previous branch rows');

    store.ensureLoaded('BRH02', { branchId: 'BRH02' });
    await flush();
    assert.deepEqual(
      calls.map((c) => c.branchId),
      ['WH001', 'BRH02']
    );
  });

  test('scope keys keep ALL and a branch apart', () => {
    assert.equal(exchangeScope(undefined), 'ALL');
    assert.equal(exchangeScope(null), 'ALL');
    assert.equal(exchangeScope('ALL'), 'ALL');
    assert.equal(exchangeScope('WH001'), 'WH001');
  });
});

describe('EXCH-1 — the search reaches the server, page by page', () => {
  test('a typed term is its own scope and is sent as `query`', async () => {
    const calls: ExchangeDevicesQuery[] = [];
    const store = createExchangeDevicesStore(async (request) => {
      calls.push(request);
      // The server found an older unit that the legacy 2,000-row array lost.
      return request.query ? page([device('older')], 4700) : page([device('newest')], 4700);
    });
    store.subscribe(() => undefined);

    const unfiltered = exchangeQueryScope({ branchId: 'WH001' });
    const searched = exchangeQueryScope({ branchId: 'WH001', query: '  SN-OLDER ' });
    assert.notEqual(unfiltered, searched, 'each term is its own cache entry');
    assert.equal(searched, 'WH001|sn-older', 'the term is normalized, so whitespace and case never split a scope');

    store.ensureLoaded(unfiltered, { branchId: 'WH001' });
    await flush();
    store.ensureLoaded(searched, { branchId: 'WH001', query: 'sn-older' });
    await flush();

    assert.deepEqual(
      calls.map((c) => c.query),
      [undefined, 'sn-older'],
      'the term is searched by the server, not filtered in the browser'
    );
    assert.deepEqual(
      store.getEntry(searched).rows.map((row) => row.id),
      ['older'],
      'a unit outside the first page of the branch is reachable by search'
    );
    assert.equal(store.getEntry(searched).totalItems, 4700, 'the matching total is the server count');
  });

  test('the previous page stays on screen while a typed term loads', () => {
    const loaded: ExchangeDevicesEntry = {
      rows: [device('page1')],
      totalItems: 4700,
      loading: false,
      error: '',
      loaded: true,
    };
    const carried = { branch: 'WH001', rows: loaded.rows, totalItems: loaded.totalItems };

    // A new term (its own scope) is loading: the branch's last page stays up.
    const loadingTerm: ExchangeDevicesEntry = { rows: [], totalItems: 0, loading: true, error: '', loaded: false };
    const view = resolveExchangeView(loadingTerm, 'WH001', carried);
    assert.deepEqual(view.rows.map((r) => r.id), ['page1']);
    assert.equal(view.loading, true);

    // A branch switch must not carry the old branch's page (DF-16).
    const otherBranch = resolveExchangeView(loadingTerm, 'BRH02', carried);
    assert.deepEqual(otherBranch.rows, []);

    // A failed search never shows the carried page as if it were the result.
    const failed: ExchangeDevicesEntry = { rows: [], totalItems: 0, loading: false, error: 'boom', loaded: false };
    assert.deepEqual(resolveExchangeView(failed, 'WH001', carried).rows, []);
  });

  test('the eligibility filter and the branch both reach the server', async () => {
    const calls: ExchangeDevicesQuery[] = [];
    const store = createExchangeDevicesStore(async (request) => {
      calls.push(request);
      return page([]);
    });
    store.subscribe(() => undefined);
    store.ensureLoaded(exchangeQueryScope({ branchId: 'ALL', status: ['RENTAL', 'ACTIVE'] }), {
      branchId: undefined,
      status: ['RENTAL', 'ACTIVE'],
    });
    await flush();
    assert.deepEqual(calls[0].status, ['RENTAL', 'ACTIVE']);
    assert.equal(calls[0].branchId, undefined, 'a global scope sends no branch filter');
  });
});

describe('DF-16 + EXCH-1 — wiring', () => {
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
    assert.ok(
      host.includes('useExchangeDevices(selectedBranchId, exchangeSearchTerm)'),
      'the host must use the shared cache, scoped by branch AND the typed term'
    );
    assert.ok(!host.includes('api.getCustomerDevices('), 'the per-host read must not come back');
    assert.ok(host.includes('exchangeDevicesError: exchangeDevices.error'));
    assert.ok(host.includes('retryExchangeDevices: exchangeDevices.retry'));
    assert.ok(host.includes('exchangeCustomerDevices: exchangeDevices.rows'));
    assert.ok(host.includes('exchangeDevicesTotal: exchangeDevices.totalItems'));
    assert.ok(host.includes('isLoadingExchangeDevices: exchangeDevices.loading'));
    assert.ok(host.includes('setExchangeSearchTerm,'), 'the host shares the typed term with its panels');
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
    assert.ok(
      !panel.includes('.filter((d) =>'),
      'the panel must not filter a device array in the browser (EXCH-1)'
    );
    assert.ok(
      panel.includes('value={exchangeSearchTerm}'),
      'the search box must drive the host-owned, server-searched term'
    );
  });

  test('the cache reads the paged device endpoint, never the legacy array', () => {
    const cache = read('client/src/services/exchangeDeviceCache.ts');
    assert.ok(cache.includes('createExchangeDevicesStore('));
    assert.ok(cache.includes('api.getCustomerDevicePage('), 'EXCH-1: the read is the paged register');
    assert.ok(!cache.includes('api.getCustomerDevices('), 'the bounded legacy array must not come back');
    assert.ok(cache.includes('EXCHANGE_DEVICE_STATUSES'), 'only RENTAL/ACTIVE units are exchangeable');
    assert.ok(cache.includes('EXCHANGE_DEBOUNCE_MS'), 'typing is debounced before it reaches the server');
    assert.ok(cache.includes('useSyncExternalStore(exchangeDevicesStore.subscribe'));
    assert.ok(cache.includes('exchangeDevicesStore.ensureLoaded(scope, request)'));
    assert.ok(cache.includes('exchangeDevicesStore.release(scope)'), 'an abandoned term is released');
    assert.ok(cache.includes('resolveExchangeView(entry'), 'the previous page is carried across a term');
  });

  test('no client screen calls the legacy bare-array read', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const source = fs.readFileSync(full, 'utf8');
          if (source.includes('api.getCustomerDevices(')) offenders.push(full);
        }
      }
    };
    walk(path.resolve('client/src'));
    assert.deepEqual(offenders, [], 'the bare endpoint stays only for an older bundle / the local slice');
  });
});
