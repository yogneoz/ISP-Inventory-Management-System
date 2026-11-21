import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useKeysetPager, type KeysetPager } from '../client/src/hooks/useKeysetPager';
import { useKeysetPageView, type KeysetPageView } from '../client/src/hooks/useKeysetPageView';
import { pageWindow } from '../client/src/utils/pageWindow';
import { sumStatusCounts } from '../client/src/utils/statusCounts';

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
  let hold = false;
  return {
    rows,
    failScope: (value: boolean) => {
      failScope = value;
    },
    /** Keep the next request in flight forever (assert the pending state). */
    holdPage: (value: boolean) => {
      hold = value;
    },
    insertNewer: (row: Row) => {
      rows.push(row);
    },
    page: async (cursor: string | null) => {
      if (hold) return new Promise<never>(() => {});
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
        // The filtered total the endpoint reports alongside the page.
        meta: { statusCounts: { IN_STOCK: rows.length } },
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
  let latest: KeysetPager<Row, { statusCounts: Record<string, number> }> | null = null;
  let view: KeysetPageView<Row> | null = null;
  // What each committed frame painted: (query key, total) must never pair a new
  // key with the previous key's total, not even for one frame.
  const committedPairs: Array<{ key: string; meta: unknown }> = [];

  function Harness({ resetKey }: { resetKey: string }) {
    const pager = useKeysetPager({
      fetchPage: (cursor) => source.page(cursor),
      resetKey,
    });
    view = useKeysetPageView(pager);
    latest = pager;
    useEffect(() => {
      committedPairs.push({ key: resetKey, meta: pager.meta });
    });
    return React.createElement('span', null, String(pager.rows.length));
  }

  const container = dom.window.document.getElementById('root')!;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Harness, { resetKey: 'orders' }));
  });
  await waitFor(() => Boolean(latest && view && !latest.loading && latest.rows.length === 3), 'first page');

  // The append-only registers still call the pager's `loadMore` directly. That
  // must not move the numbered view off the page the operator is reading: the
  // fetched page becomes page 2 *behind* page 1 and the rows on screen stay.
  // (This is a pinned decision, not an accident: nothing in the view may
  // auto-advance on an append.)
  await act(async () => {
    latest!.loadMore();
  });
  await waitFor(() => Boolean(latest && !latest.loadingMore && latest.rows.length === 6), 'direct load');
  assert.equal(view!.page, 1, 'a direct loadMore leaves the numbered view where it is');
  assert.equal(view!.pageCount, 2, 'the fetched page is numbered behind the current one');
  assert.deepEqual(
    view!.pageRows.map((row) => row.id),
    ['g', 'f', 'e'],
    'the rows on screen do not change when a page is appended'
  );

  // A sale posted after page 1. The walk must still start from an anchor and
  // must not emit this newer row.
  source.insertNewer({ id: 'z', ts: 900 });
  source.insertNewer({ id: 'h', ts: 700 });
  // Page 2 is already loaded, so this is the cached slice — no request, and the
  // newer rows still never enter the walk.
  await act(async () => {
    view!.goToPage(2);
  });
  await waitFor(() => Boolean(latest && !latest.loadingMore && latest.rows.length === 6), 'page 2 revisit');
  assert.equal(view!.page, 2, 'the requested page becomes the page on screen');
  assert.deepEqual(view!.pageRows.map((row) => row.id), ['d', 'c', 'b'], 'page 2 holds its own slice');

  // Forward navigation to a page that is NOT loaded yet is the cursor read.
  source.insertNewer({ id: 'y', ts: 800 });
  await act(async () => {
    view!.goToPage(3);
  });
  await waitFor(() => Boolean(latest && !latest.loadingMore && latest.rows.length === 7), 'third page');

  assert.equal(latest!.hasMore, false, 'terminates when the server returns hasMore=false');
  assert.deepEqual(
    latest!.rows.map((row) => row.id),
    ['g', 'f', 'e', 'd', 'c', 'b', 'a'],
    'every pre-existing row appears exactly once and newer inserts never enter the walk'
  );

  // Numbered pagination over the same cursor walk: every fetched page is a
  // real server page, revisiting it is a local slice, and the next page is the
  // only forward step the opaque cursor allows.
  assert.equal(latest!.pageSize, 3, 'page size is fixed by the first page');
  assert.equal(view!.pageCount, 3, 'three fetched pages are numbered 1-3');
  assert.equal(view!.page, 3, 'the newest fetch leaves the view on the page it fetched');
  assert.deepEqual(view!.pageRows.map((row) => row.id), ['a'], 'the last page holds its own slice');

  await act(async () => {
    view!.goToPage(1);
  });
  assert.deepEqual(
    view!.pageRows.map((row) => row.id),
    ['g', 'f', 'e'],
    'revisiting a page slices the cached rows instead of re-reading the server'
  );
  assert.equal(latest!.rows.length, 7, 'no extra request was made to go back');

  await act(async () => {
    view!.goToPage(3);
  });
  assert.equal(view!.page, 3, 'a fetched page can be revisited');
  await act(async () => {
    view!.goToPage(4);
  });
  assert.equal(view!.page, 3, 'a page beyond the cursor frontier cannot be requested');
  await act(async () => {
    view!.goToPage(9);
  });
  assert.equal(view!.page, 3, 'a far page cannot be jumped to without walking the cursor to it');

  // The footer's "of N" must describe the CURRENT query. A filter change clears
  // the previous figure before the new page lands, so the footer can never
  // promise rows the new register does not contain.
  assert.deepEqual(
    latest!.meta,
    { statusCounts: { IN_STOCK: source.rows.length } },
    'the page carries the filtered total reported for the query that fetched it'
  );
  source.failScope(true);
  await act(async () => {
    root.render(React.createElement(Harness, { resetKey: 'orders\u0000DAMAGED' }));
  });
  await waitFor(() => Boolean(latest && !latest.loading), 'refused re-query');
  assert.equal(latest!.rows.length, 0, 'the new query starts with no rows');
  assert.equal(
    latest!.meta,
    null,
    'the previous query\u2019s total is cleared, so the footer cannot overstate the register'
  );
  assert.equal(view!.page, 1, 'the numbered view snaps back to page 1 when the row set empties');
  assert.deepEqual(view!.pageRows, [], 'no slice survives a cleared walk');
  source.failScope(false);

  // While a query is in flight there is no total at all — the header and the
  // footer can never pair the new filter with the previous filter's figures.
  source.holdPage(true);
  await act(async () => {
    root.render(React.createElement(Harness, { resetKey: 'orders\u0000DAMAGED\u0000held' }));
  });
  assert.equal(latest!.loading, true, 'the new query is still in flight');
  assert.equal(latest!.meta, null, 'an in-flight query reports no total');
  assert.equal(view!.page, 1, 'a new query starts the numbered view on page 1');
  assert.deepEqual(
    committedPairs.filter((pair) => pair.key !== 'orders' && pair.meta !== null),
    [],
    'no render may pair a new query key with the previous query\u2019s total'
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
  assert.equal(latest!.meta, null, 'a refused query reports no total');

  await act(async () => root.unmount());
  dom.window.close();
});

test('every converted register uses the shared cursor pager and a cursor footer', () => {
  // One page-number window, not two copies: both footers read the same helper.
  assert.deepEqual(
    pageWindow(5, 12),
    [1, 'gap-l', 4, 5, 6, 'gap-r', 12],
    'the window keeps the first/last page and the current page ±1'
  );
  // One helper computes the "of N" total, so the numbered registers cannot
  // drift apart on how they sum a page's per-status counts.
  assert.equal(
    sumStatusCounts({ IN_STOCK: 3, DAMAGED: 2 }),
    5,
    'the filtered total is the sum of the page counts'
  );
  assert.equal(sumStatusCounts(undefined), 0, 'no page meta claims no total');
  assert.equal(sumStatusCounts(null), 0, 'a null count map claims no total');
  for (const file of [
    'client/src/components/common/TablePagination.tsx',
    'client/src/components/common/KeysetPagerFooter.tsx',
  ]) {
    const source = fs.readFileSync(path.resolve(file), 'utf8');
    assert.match(source, /from '\.\.\/\.\.\/utils\/pageWindow'/, `${file} shares the page-number window`);
    assert.doesNotMatch(source, /function pageWindow/, `${file} must not carry its own copy`);
  }

  const screens = [
    'client/src/features/sales/CustomerMasterDirectory.tsx',
    'client/src/features/sales/SalesInvoices.tsx',
    'client/src/features/inventory/stockops/ConsumablesRegisterPanel.tsx',
    'client/src/features/inventory/SerialLogRegister.tsx',
    'client/src/features/finance/PostedVouchers.tsx',
    'client/src/features/finance/SubledgersManagement.tsx',
    'client/src/features/finance/AuditTrailReports.tsx',
    'client/src/features/sales/ReturnsRegister.tsx',
    'client/src/features/finance/CustomerLedger.tsx',
    'client/src/features/inventory/stockops/PulloutBinsPanel.tsx',
    'client/src/features/inventory/stockops/DamageTrackingPanel.tsx',
    'client/src/features/inventory/stockops/LogsPanel.tsx',
    'client/src/features/finance/FixedAssetRegister.tsx',
    'client/src/features/finance/DepreciationRegister.tsx',
    'client/src/features/inventory/AssetDeployments.tsx',
    'client/src/features/inventory/warranty/WarrantyRegister.tsx',
    'client/src/features/procurement/ShipmentRegister.tsx',
    'client/src/features/procurement/PurchaseOrders.tsx',
    'client/src/features/procurement/PurchaseInvoices.tsx',
  ];
  for (const screen of screens) {
    const source = fs.readFileSync(path.resolve(screen), 'utf8');
    assert.match(source, /useKeysetPager/, `${screen} must use the shared cursor pager`);
    // Registers converted to the numbered footer (the pattern: useKeysetPageView
    // over the same cursor walk + KeysetPagerFooter).
    const NUMBERED_REGISTERS = [
      'SerialLogRegister.tsx',
      'ConsumablesRegisterPanel.tsx',
      'PulloutBinsPanel.tsx',
      'DamageTrackingPanel.tsx',
    ];
    const numbered = NUMBERED_REGISTERS.some((name) => screen.endsWith(name));
    if (numbered) {
      // The numbered-pagination pattern: same cursor contract, but the footer
      // offers page numbers instead of an append-only "Load more" button.
      assert.match(source, /<KeysetPagerFooter/, `${screen} pages through numbered cursor pages`);
      assert.doesNotMatch(source, /KeysetLoadMore/, `${screen} no longer ends in Load more`);
      // The numbered view is a separate hook over the cursor walk, so the
      // append-only registers never carry page bookkeeping.
      assert.match(source, /useKeysetPageView\(/, `${screen} must use the numbered view`);
      // One shared sum for "of N", never a local reduce that can drift.
      assert.match(source, /sumStatusCounts\(/, `${screen} must use the shared count sum`);
      assert.doesNotMatch(source, /Object\.values\([^)]*statusCounts/, `${screen} must not sum counts inline`);
      // The "of N" figure must be the filtered total of the current query, not
      // a total carried in component state across filter changes.
      assert.match(source, /[Pp]ager\.meta\?\./, `${screen} reads its total from the current page's meta`);
      assert.doesNotMatch(
        source,
        /setTotalItems|setConsumableRegisterTotal/,
        `${screen} keeps no cross-query total of its own`
      );
      if (screen.endsWith('SerialLogRegister.tsx')) {
        assert.match(
          source,
          /serialPager\.meta\?\.statusCounts/,
          'the serial total is its filtered status counts'
        );
      }
      if (screen.endsWith('DamageTrackingPanel.tsx')) {
        // Damage rows that have no stock_operations row (the synthetic prefix)
        // cannot be paged, so they ride page 1 only and the total counts them
        // once — never on every page, and never twice.
        assert.match(source, /damageView\.page === 1/, 'the synthetic prefix stays on page 1');
        assert.match(
          source,
          /syntheticDamageOps\.length \+ damageTotal/,
          'the footer total counts the synthetic prefix once'
        );
      }
      assert.match(source, /totalRows=\{[^}]*\}/, `${screen} must pass the filtered total to the footer`);
    } else {
      assert.match(source, /KeysetLoadMore/, `${screen} must render the load-more footer`);
    }
    assert.match(source, /scopeError=/, `${screen} must render the SCOPE_REQUIRED state`);
    assert.match(source, /cursor/, `${screen} must send an opaque cursor`);
    assert.match(
      source,
      /limit:\s*\d+|getFixedAssetCursorPage|getShipmentCursorPage|fetchWarrantyCursorPage/,
      `${screen} must send a bounded limit`
    );
    if (!screen.endsWith('AuditTrailReports.tsx')) {
      assert.doesNotMatch(source, /TablePagination\b/, `${screen} must not keep an offset pager`);
    } else {
      assert.match(source, /<KeysetLoadMore/, 'the audit register must page through the cursor footer');
    }
  }

  // Aggregates over the filtered set (record counts, status counts, money sums)
  // must be read from the pager's `meta`, which is cleared the moment a new
  // query starts. A component-state copy filled by `onPage` survived the filter
  // change and could show the previous filter's total over the new rows.
  const aggregateScreens = [
    'client/src/features/inventory/stockops/ConsumablesRegisterPanel.tsx',
    'client/src/features/procurement/PurchaseOrders.tsx',
    'client/src/features/procurement/PurchaseInvoices.tsx',
    'client/src/features/inventory/warranty/WarrantyRegister.tsx',
    'client/src/features/sales/CustomerMasterDirectory.tsx',
    'client/src/features/finance/DepreciationRegister.tsx',
    'client/src/features/inventory/AssetDeployments.tsx',
    'client/src/features/procurement/ShipmentRegister.tsx',
  ];
  for (const screen of aggregateScreens) {
    const source = fs.readFileSync(path.resolve(screen), 'utf8');
    assert.doesNotMatch(
      source,
      /onPage\s*:/,
      `${screen} must not copy page aggregates into state via an onPage callback`
    );
    assert.match(source, /[Pp]ager\.meta\?\./, `${screen} must read its aggregates from the current page's meta`);
  }
  // Statement headers are the same query-scoped shape: the header (party,
  // opening/totals/closing, ledger parties) comes from the page's `meta`, and
  // the state copy the `onPage` callback used to fill is gone.
  const statementScreens = [
    'client/src/features/finance/CustomerLedger.tsx',
    'client/src/features/finance/SubledgersManagement.tsx',
  ];
  for (const screen of statementScreens) {
    const source = fs.readFileSync(path.resolve(screen), 'utf8');
    assert.match(
      source,
      /[Pp]ager\.meta\b/,
      `${screen} must take its statement header from the current page's meta`
    );
    assert.doesNotMatch(source, /setLedgerData|setLedger\(/, `${screen} keeps no statement header in state`);
    if (screen.endsWith('SubledgersManagement.tsx')) {
      // It renders its own statement block instead of going through LedgerView,
      // so it carries the same placeholder contract: in-progress and empty must
      // not look alike, and the placeholder may never cover a loaded statement.
      assert.match(
        source,
        /ledgerLoading && !ledger && !ledgerError/,
        'a subledger read without a ledger shows a placeholder, not an empty block'
      );
      assert.match(
        source,
        /StatementLoadingPlaceholder label="subledger"/,
        'the subledger renders the shared placeholder, not its own copy'
      );
    }
  }
  // Both statements render through LedgerView. A refetch clears the figures (they
  // belong to the query that produced them), so the region must read as
  // in-progress instead of collapsing — and the placeholder may never stand in
  // for data that is actually on screen.
  const ledgerView = fs.readFileSync(
    path.resolve('client/src/components/common/LedgerView.tsx'),
    'utf8'
  );
  assert.match(
    ledgerView,
    /loading && !data && !error/,
    'a refetch without figures shows a placeholder, not an empty statement'
  );
  assert.match(
    ledgerView,
    /StatementLoadingPlaceholder label="statement"/,
    'LedgerView renders the shared placeholder, not its own copy'
  );
  assert.match(
    ledgerView,
    /emptyPrompt && !data && !error && !loading/,
    'the empty prompt never doubles as the loading state'
  );
  // One placeholder for every statement surface: the announcement and the copy
  // live in the component, so the two screens cannot drift apart.
  const placeholder = fs.readFileSync(
    path.resolve('client/src/components/common/StatementLoadingPlaceholder.tsx'),
    'utf8'
  );
  assert.match(placeholder, /role="status"/, 'the shared placeholder announces the read');
  assert.match(placeholder, /Reading \{label\}/, 'the label is a prop, not inline copy');
  const placeholderCallers = [...statementScreens, 'client/src/components/common/LedgerView.tsx'];
  for (const caller of placeholderCallers) {
    const callerSource = fs.readFileSync(path.resolve(caller), 'utf8');
    assert.doesNotMatch(
      callerSource,
      /Reading (statement|subledger)…/,
      `${caller} keeps no inline copy of the placeholder text`
    );
    // The announcement lives in one place, so a hand-rolled copy cannot slip
    // past this by choosing different wording.
    assert.doesNotMatch(
      callerSource,
      /role="status"/,
      `${caller} leaves the status announcement to the shared placeholder`
    );
  }
  // The fixed-asset register showed no aggregate, so it simply lost the state
  // copy it never rendered.
  assert.doesNotMatch(
    fs.readFileSync(path.resolve('client/src/features/finance/FixedAssetRegister.tsx'), 'utf8'),
    /onPage\s*:/,
    'the fixed-asset register keeps no unused aggregate state'
  );
});
