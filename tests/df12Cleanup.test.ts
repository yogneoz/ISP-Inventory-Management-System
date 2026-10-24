/**
 * DF-12 cleanup — the leftovers from the data-fetching audit.
 *
 * PROVES:
 *  1. RULE — `useFilterPageReset` snaps a server page back to 1 in the SAME
 *     render as the filter change (one request, not two), never on mount, and
 *     never when the filters did not move.
 *  2. WIRING — the five paged registers use it instead of the mount-era reset
 *     effect; no screen reloads the whole page after a mutation (device
 *     exchange, asset deployment and damage reversal all use the normal
 *     refresh path); the statements screen issues ONE batch request; and the
 *     customer screens no longer carry the dead devicesPage state.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement, useState } from 'react';
import { mountTree, inAct } from './harness/mount';
import { useFilterPageReset } from '../client/src/utils/useFilterPageReset';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(relativePath), 'utf8');

interface PageHandles {
  page: number;
  setPage?: (page: number) => void;
}

/** A server-paged list reduced to the state the hook actually manages. */
function PagedList({ filterKey, handles }: { filterKey: string; handles: PageHandles }) {
  const [page, setPage] = useState(3);
  handles.page = page;
  handles.setPage = setPage;
  useFilterPageReset(filterKey, page, setPage);
  return createElement('span', { 'data-page': String(page) }, `page=${page}`);
}

describe('useFilterPageReset — one request per filter change', () => {
  test('mount is not a filter change: an existing page is left alone', () => {
    const handles: PageHandles = { page: 0 };
    const tree = mountTree(createElement(PagedList, { filterKey: 'branch=ALL', handles }));
    try {
      assert.equal(handles.page, 3, 'mount must not reset the page');
      assert.equal(tree.container.textContent, 'page=3');
    } finally {
      tree.unmount();
    }
  });

  test('a filter change snaps the page to 1 in the same commit', () => {
    const handles: PageHandles = { page: 0 };
    const tree = mountTree(createElement(PagedList, { filterKey: 'branch=ALL', handles }));
    try {
      tree.rerender(createElement(PagedList, { filterKey: 'branch=WH001', handles }));
      assert.equal(
        handles.page,
        1,
        'the filter change and the page reset must land together, so the loader for the old page never runs'
      );
      assert.equal(tree.container.textContent, 'page=1');

      // A later manual page change with the SAME filters must survive: only a
      // filter change resets, otherwise paging would be impossible.
      inAct(() => handles.setPage!(3));
      assert.equal(handles.page, 3);
      assert.equal(tree.container.textContent, 'page=3');
    } finally {
      tree.unmount();
    }
  });
});

describe('DF-12 wiring', () => {
  test('no screen reloads the whole page after a mutation', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const src = fs.readFileSync(full, 'utf8');
          if (src.includes('window.location.reload(')) offenders.push(full);
        }
      }
    };
    walk(path.resolve('client/src'));
    assert.deepEqual(offenders, [], 'panels must call the normal refresh path, not reload the page');
  });

  test('device exchange, asset deployment and damage reversal use the refresh path', () => {
    const exchange = read('client/src/features/inventory/stockops/DeviceExchangePanel.tsx');
    assert.ok(exchange.includes('await onRefreshData?.();'), 'device exchange must refresh in place');
    assert.ok(exchange.includes('retryExchangeDevices();'), 'and still refetch its devices (shared cache, DF-16)');

    const assign = read('client/src/features/inventory/stockops/AssignAssetPanel.tsx');
    assert.ok(assign.includes('await onRefreshData?.();'), 'asset deployment must refresh in place');

    const damaged = read('client/src/features/inventory/DamagedStockTracking.tsx');
    assert.ok(damaged.includes('onReverseStockOperation(op.id'), 'damage reversal must go through App');

    const app = read('client/src/App.tsx');
    assert.ok(
      app.includes('onReverseStockOperation={handleReverseStockOperation}'),
      'App must hand the damage screen its refreshing reverse handler'
    );
    // Every StockOperations host (one per keep-mounted tab) gets the refresh
    // callback: adding a host later without it would silently regress to a
    // stale screen.
    const hosts = app.split('<StockOperations').slice(1);
    assert.equal(hosts.length, 11, 'the App mounts 11 StockOperations hosts');
    hosts.forEach((block, i) => {
      const props = block.slice(0, block.indexOf('/>'));
      assert.ok(props.includes('onRefreshData={refreshAllData}'), `StockOperations host #${i + 1} must refresh`);
    });
  });

  test('the five paged registers snap the page during render instead of in an effect', () => {
    const registers = [
      'client/src/features/procurement/PurchaseOrders.tsx',
      'client/src/features/procurement/PurchaseInvoices.tsx',
      'client/src/features/sales/SalesInvoices.tsx',
      'client/src/features/sales/ReturnsRegister.tsx',
      'client/src/features/inventory/stockops/ConsumablesRegisterPanel.tsx',
    ];
    for (const file of registers) {
      const source = read(file);
      assert.ok(source.includes('useFilterPageReset('), `${file} must use the shared page reset`);
      assert.ok(
        !source.includes('// Filter changes snap the server page back to 1.'),
        `${file} must not keep the two-effect reset that fetched twice per filter change`
      );
    }
  });

  test('statements fetch every branch × FY in one batch request', () => {
    const source = read('client/src/features/finance/FinancialStatements.tsx');
    assert.ok(source.includes('getFinancialSummaries('), 'the batch read must be used');
    assert.ok(
      !/getFinancialSummary\(/.test(source),
      'the per-pair single read must be gone'
    );
    assert.ok(
      !source.includes('Promise.all('),
      'the per-pair fan-out must be gone, not just hidden behind a helper'
    );
    assert.ok(
      source.includes("'Failed to load per-branch financials"),
      'a failed batch must still surface the error line'
    );
    const service = read('server/src/controllers/reports.controller.ts');
    assert.ok(
      service.includes('fetchFinancialSummaryFromDb(pgPool, scope)'),
      'the report path must use the shared aggregate producer'
    );
  });

  test('the dead customer device page state is gone from both screens', () => {
    for (const file of [
      'client/src/features/sales/CustomerMasterDirectory.tsx',
      'client/src/features/sales/CustomersManagement.tsx',
    ]) {
      const source = read(file);
      assert.ok(!source.includes('devicesPage'), `${file} must not keep the constant page state`);
      assert.ok(
        !source.includes('setDevicesLoadError'),
        `${file} must not keep a write-only error flag`
      );
    }
  });
});
