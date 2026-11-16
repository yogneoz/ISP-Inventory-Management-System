import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useKeysetPager, type KeysetPager } from '../client/src/hooks/useKeysetPager';

interface Row {
  id: string;
  ts: number;
}

/**
 * A small keyset source: newest first by (ts, id), strictly after the cursor.
 * Inserting a newer row between pages must never change an older page because
 * the cursor is an anchor, not an offset.
 */
function makeSource(initial: Row[], pageSize = 3) {
  const rows = initial.slice();
  let failScope = false;
  return {
    rows,
    failScope: (value: boolean) => {
      failScope = value;
    },
    insertNewer: (row: Row) => {
      rows.push(row);
    },
    page: async (cursor: string | null) => {
      if (failScope) {
        const err: any = new Error('This request needs a branch_id or a bounded date range.');
        err.body = { code: 'SCOPE_REQUIRED' };
        throw err;
      }
      const [ts, id] = cursor ? cursor.split('|') : ['', ''];
      const after = cursor
        ? rows.filter((row) => row.ts < Number(ts) || (row.ts === Number(ts) && row.id < id))
        : rows;
      const sorted = after.slice().sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id));
      const items = sorted.slice(0, pageSize);
      const hasMore = sorted.length > pageSize;
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: hasMore && last ? `${last.ts}|${last.id}` : null,
        hasMore,
      };
    },
  };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('the register pager appends across page boundaries while newer rows are inserted', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const g = globalThis as any;
  g.window = dom.window;
  g.document = dom.window.document;
  Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true });
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  g.Event = dom.window.Event;
  g.MouseEvent = dom.window.MouseEvent;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const source = makeSource([
    { id: 'g', ts: 700 },
    { id: 'f', ts: 600 },
    { id: 'e', ts: 500 },
    { id: 'd', ts: 400 },
    { id: 'c', ts: 300 },
    { id: 'b', ts: 200 },
    { id: 'a', ts: 100 },
  ]);
  let latest: KeysetPager<Row> | null = null;

  function Harness() {
    const pager = useKeysetPager({
      fetchPage: (cursor) => source.page(cursor),
      resetKey: 'orders',
    });
    latest = pager;
    return React.createElement('span', null, String(pager.rows.length));
  }

  const container = dom.window.document.getElementById('root')!;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Harness));
  });
  await waitFor(() => Boolean(latest && !latest.loading && latest.rows.length === 3), 'first page');

  // A sale posted after page 1. The next request must still start after the
  // page-1 anchor and must not emit this newer row.
  source.insertNewer({ id: 'z', ts: 900 });
  source.insertNewer({ id: 'h', ts: 700 });
  await act(async () => {
    latest!.loadMore();
  });
  await waitFor(() => Boolean(latest && !latest.loadingMore && latest.rows.length === 6), 'second page');

  source.insertNewer({ id: 'y', ts: 800 });
  await act(async () => {
    latest!.loadMore();
  });
  await waitFor(() => Boolean(latest && !latest.loadingMore && latest.rows.length === 7), 'third page');

  assert.equal(latest!.hasMore, false, 'terminates when the server returns hasMore=false');
  assert.deepEqual(
    latest!.rows.map((row) => row.id),
    ['g', 'f', 'e', 'd', 'c', 'b', 'a'],
    'every pre-existing row appears exactly once and newer inserts never enter the walk'
  );

  await act(async () => root.unmount());
  dom.window.close();
});

test('the register pager surfaces SCOPE_REQUIRED instead of an empty success', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const g = globalThis as any;
  g.window = dom.window;
  g.document = dom.window.document;
  Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true });
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  g.Event = dom.window.Event;
  g.MouseEvent = dom.window.MouseEvent;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const source = makeSource([{ id: 'a', ts: 100 }]);
  source.failScope(true);
  let latest: KeysetPager<Row> | null = null;
  function Harness() {
    latest = useKeysetPager({ fetchPage: (cursor) => source.page(cursor), resetKey: 'scope' });
    return null;
  }

  const container = dom.window.document.getElementById('root')!;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Harness));
  });
  await waitFor(() => Boolean(latest && !latest.loading && latest.scopeError), 'scope refusal');

  assert.match(latest!.error, /branch_id|bounded date range/);
  assert.equal(latest!.rows.length, 0);
  assert.equal(latest!.hasMore, false);

  await act(async () => root.unmount());
  dom.window.close();
});

test('every converted register uses the shared cursor pager and load-more footer', () => {
  const screens = [
    'client/src/features/sales/CustomerMasterDirectory.tsx',
    'client/src/features/sales/SalesInvoices.tsx',
    'client/src/features/inventory/stockops/ConsumablesRegisterPanel.tsx',
    'client/src/features/inventory/SerialLogRegister.tsx',
    'client/src/features/finance/PostedVouchers.tsx',
    'client/src/features/finance/SubledgersManagement.tsx',
    'client/src/features/finance/AuditTrailReports.tsx',
  ];
  for (const screen of screens) {
    const source = fs.readFileSync(path.resolve(screen), 'utf8');
    assert.match(source, /useKeysetPager/, `${screen} must use the shared cursor pager`);
    assert.match(source, /KeysetLoadMore/, `${screen} must render the load-more footer`);
    assert.match(source, /scopeError=/, `${screen} must render the SCOPE_REQUIRED state`);
    assert.match(source, /cursor/, `${screen} must send an opaque cursor`);
    assert.match(source, /limit:\s*\d+/, `${screen} must send a bounded limit`);
    if (!screen.endsWith('AuditTrailReports.tsx')) {
      assert.doesNotMatch(source, /TablePagination\b/, `${screen} must not keep an offset pager`);
    } else {
      assert.match(source, /<KeysetLoadMore/, 'the audit register must page through the cursor footer');
    }
  }
});
