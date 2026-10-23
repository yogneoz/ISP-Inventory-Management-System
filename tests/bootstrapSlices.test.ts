/**
 * C1 — per-slice bootstrap hydration status.
 *
 * The reducer is the contract App relies on:
 *   - a failed slice keeps the last good data (App only applies successful
 *     payloads; the entry keeps the version that produced what is on screen),
 *   - the failure is reported ONCE for the whole set, dismissible, and a
 *     successful retry clears it,
 *   - the full bootstrap only clears the keys it actually carried — the three
 *     deferred ledgers are not in that payload, so their errors must survive.
 *
 * Wiring is pinned too (last describe): both hydration paths — the deferred
 * ledgers and the SSE targeted refresh — go through App's one
 * `fetchBootstrapSlice`, so a failure behaves the same wherever it came from.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  beginSliceLoad,
  createBootstrapSliceState,
  dismissSliceErrors,
  failedSliceKeys,
  isAnySliceLoading,
  markSliceError,
  markSliceReady,
  markSlicesReady,
  settleSliceDiscarded,
  sliceLabel,
  sliceScopeKey,
  visibleSliceErrors,
  SliceRequestGate,
  type BootstrapSliceState,
} from '../client/src/services/bootstrapSlices';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

describe('bootstrap slice status (C1)', () => {
  test('idle → loading → ready records the version that produced the data', () => {
    let state: BootstrapSliceState = createBootstrapSliceState();
    assert.deepEqual(visibleSliceErrors(state), []);

    state = beginSliceLoad(state, 'purchaseOrders');
    assert.equal(state.purchaseOrders.status, 'loading');
    assert.equal(isAnySliceLoading(state), true);

    state = markSliceReady(state, 'purchaseOrders', 42);
    assert.deepEqual(state.purchaseOrders, { status: 'ready', dataVersion: 42 });
    assert.equal(isAnySliceLoading(state), false);
  });

  test('a payload without a version keeps the previously recorded one', () => {
    let state = markSliceReady(createBootstrapSliceState(), 'stock', 7);
    state = markSliceReady(state, 'stock');
    assert.equal(state.stock.status, 'ready');
    assert.equal(state.stock.dataVersion, 7);
  });

  test('a failure keeps the last good version and reports the reason', () => {
    let state = markSliceReady(createBootstrapSliceState(), 'purchaseInvoices', 11);
    state = beginSliceLoad(state, 'purchaseInvoices');
    state = markSliceError(state, 'purchaseInvoices', 'Gateway Timeout');

    assert.equal(state.purchaseInvoices.status, 'error');
    // The version of the rows still on screen — the "last good data" marker.
    assert.equal(state.purchaseInvoices.dataVersion, 11);
    assert.equal(state.purchaseInvoices.error, 'Gateway Timeout');
    assert.deepEqual(visibleSliceErrors(state), [
      { key: 'purchaseInvoices', label: 'purchase invoices', message: 'Gateway Timeout' },
    ]);

    // A retry is in flight: the notice (and its reason) stays until the outcome
    // is known, because the rows it describes are still the ones on screen.
    state = beginSliceLoad(state, 'purchaseInvoices');
    assert.equal(isAnySliceLoading(state), true);
    assert.equal(visibleSliceErrors(state).length, 1);
    assert.deepEqual(failedSliceKeys(state), [], 'an in-flight retry is not a failure to retry again');
  });

  test('a successful retry clears the error and the dismissal', () => {
    let state = markSliceError(createBootstrapSliceState(), 'stockOperations', 'Network down');
    state = dismissSliceErrors(state);
    assert.deepEqual(visibleSliceErrors(state), [], 'dismissed errors are not shown');

    state = beginSliceLoad(state, 'stockOperations');
    state = markSliceReady(state, 'stockOperations', 99);

    assert.deepEqual(state.stockOperations, { status: 'ready', dataVersion: 99 });
    assert.deepEqual(visibleSliceErrors(state), []);
    assert.deepEqual(failedSliceKeys(state), []);
  });

  test('one dismissal covers every failed slice, and a new message re-surfaces it', () => {
    let state = createBootstrapSliceState();
    state = markSliceError(state, 'purchaseOrders', 'Timeout');
    state = markSliceError(state, 'purchaseInvoices', 'Timeout');
    assert.equal(visibleSliceErrors(state).length, 2, 'both failures render in ONE notice payload');

    state = dismissSliceErrors(state);
    assert.deepEqual(visibleSliceErrors(state), []);
    assert.deepEqual(failedSliceKeys(state), ['purchaseOrders', 'purchaseInvoices'], 'Retry still knows them');

    // The same failure repeating must not nag the user again — including
    // through the real retry flow, which goes begin (status loading, error
    // retained) → fail with the same message.
    state = beginSliceLoad(state, 'purchaseOrders');
    state = markSliceError(state, 'purchaseOrders', 'Timeout');
    assert.equal(state.purchaseOrders.status, 'error');
    assert.deepEqual(visibleSliceErrors(state), []);

    // …but a DIFFERENT reason is new information.
    state = markSliceError(state, 'purchaseOrders', 'Forbidden');
    assert.deepEqual(
      visibleSliceErrors(state).map((slice) => slice.message),
      ['Forbidden']
    );
  });

  test('a full bootstrap only clears the keys its payload carried', () => {
    let state = createBootstrapSliceState();
    state = markSliceError(state, 'stockOperations', 'Timeout'); // deferred, NOT in bootstrap
    state = markSliceError(state, 'purchaseOrders', 'Timeout'); // also deferred
    state = markSliceError(state, 'stock', 'Timeout'); // part of the full payload

    state = markSlicesReady(state, ['stock', 'products', 'suppliers'], 123);

    assert.equal(state.stock.status, 'ready');
    assert.equal(state.stock.dataVersion, 123);
    assert.deepEqual(
      visibleSliceErrors(state).map((slice) => slice.key),
      ['stockOperations', 'purchaseOrders'],
      'the deferred ledgers were never in that payload, so their errors must survive'
    );
  });

  test('every update is immutable', () => {
    const first = markSliceError(createBootstrapSliceState(), 'stock', 'Timeout');
    const snapshot = JSON.parse(JSON.stringify(first));
    Object.freeze(first);

    beginSliceLoad(first, 'stock');
    markSliceReady(first, 'stock', 5);
    markSlicesReady(first, ['stock', 'products'], 6);
    dismissSliceErrors(first);
    visibleSliceErrors(first);
    failedSliceKeys(first);

    assert.deepEqual(JSON.parse(JSON.stringify(first)), snapshot);
  });

  test('labels are human names with the raw key as a fallback', () => {
    assert.equal(sliceLabel('purchaseOrders'), 'purchase orders');
    assert.equal(sliceLabel('stockOperations'), 'stock operations');
    assert.equal(sliceLabel('somethingNew'), 'somethingNew');
  });
});

describe('slice request gate (C2)', () => {
  const BRANCH_A_FY1 = sliceScopeKey('WH001', 'fy-1');
  const BRANCH_B_FY1 = sliceScopeKey('BRH01', 'fy-1');

  test('a response for the current view is applied', () => {
    const gate = new SliceRequestGate();
    const request = gate.begin('purchaseOrders', BRANCH_A_FY1);
    assert.equal(gate.decide(request, BRANCH_A_FY1, 10), 'apply');
  });

  test('a response for a view the user left is discarded, even with a newer version', () => {
    const gate = new SliceRequestGate();
    const request = gate.begin('purchaseOrders', BRANCH_A_FY1);
    // The user switched branch while this was in flight. The payload is for the
    // OLD branch: applying it would paint the new view with those rows.
    assert.equal(gate.decide(request, BRANCH_B_FY1, 999), 'stale-scope');
  });

  test('a newer request for the same key supersedes an older one', () => {
    const gate = new SliceRequestGate();
    const first = gate.begin('stock', BRANCH_A_FY1);
    const second = gate.begin('stock', BRANCH_A_FY1);
    assert.equal(gate.decide(first, BRANCH_A_FY1, 5), 'superseded');
    assert.equal(gate.decide(second, BRANCH_A_FY1, 5), 'apply');
  });

  test('a payload older than the rows on screen is discarded; equal applies', () => {
    const gate = new SliceRequestGate();
    const first = gate.begin('stock', BRANCH_A_FY1);
    assert.equal(gate.decide(first, BRANCH_A_FY1, 10), 'apply');
    gate.noteApplied(['stock'], 10);

    const late = gate.begin('stock', BRANCH_A_FY1);
    assert.equal(gate.decide(late, BRANCH_A_FY1, 9), 'older-version');
    // Equal is the same data, not a regression.
    assert.equal(gate.decide(late, BRANCH_A_FY1, 10), 'apply');
    assert.equal(gate.decide(late, BRANCH_A_FY1, 11), 'apply');
  });

  test('versions are tracked per key, so one slice cannot block another', () => {
    const gate = new SliceRequestGate();
    gate.noteApplied(['stock'], 50);

    const stock = gate.begin('stock', BRANCH_A_FY1);
    assert.equal(gate.decide(stock, BRANCH_A_FY1, 49), 'older-version');

    const invoices = gate.begin('purchaseInvoices', BRANCH_A_FY1);
    assert.equal(gate.decide(invoices, BRANCH_A_FY1, 40), 'apply');
  });

  test('a full bootstrap version blocks a slower targeted request for the same key', () => {
    const gate = new SliceRequestGate();
    // The bootstrap payload (v100) applied while this slice request was in
    // flight; the slice response (v99) must not overwrite newer rows.
    gate.noteApplied(['stock', 'products'], 100);
    const slow = gate.begin('stock', BRANCH_A_FY1);
    assert.equal(gate.decide(slow, BRANCH_A_FY1, 99), 'older-version');

    const newer = gate.begin('stock', BRANCH_A_FY1);
    assert.equal(gate.decide(newer, BRANCH_A_FY1, 101), 'apply');
  });

  test('the scope stamp treats an absent branch/FY as ALL', () => {
    assert.equal(sliceScopeKey(), 'ALL|ALL');
    assert.equal(sliceScopeKey('', undefined), 'ALL|ALL');
    assert.equal(sliceScopeKey('WH001', 'fy-4'), 'WH001|fy-4');
  });

  test('a discarded request settles its loading flag without touching data', () => {
    // Never loaded: a discarded response must not leave the key spinning.
    let state = beginSliceLoad(createBootstrapSliceState(), 'stockOperations');
    state = settleSliceDiscarded(state, 'stockOperations');
    assert.deepEqual(state.stockOperations, { status: 'idle' });

    // Previously applied: the rows on screen are still that payload.
    state = markSliceReady(createBootstrapSliceState(), 'purchaseOrders', 9);
    state = beginSliceLoad(state, 'purchaseOrders');
    state = settleSliceDiscarded(state, 'purchaseOrders');
    assert.deepEqual(state.purchaseOrders, { status: 'ready', dataVersion: 9 });

    // An error is still an error while its retry is discarded.
    state = markSliceError(createBootstrapSliceState(), 'stock', 'Timeout');
    state = beginSliceLoad(state, 'stock');
    state = settleSliceDiscarded(state, 'stock');
    assert.equal(state.stock.status, 'error');
    assert.equal(state.stock.error, 'Timeout');
  });
});

describe('bootstrap slice wiring (C1)', () => {
  test('both hydration paths go through the one fetchBootstrapSlice helper', () => {
    const app = read('client/src/App.tsx');
    assert.ok(
      app.includes("from './services/bootstrapSlices'"),
      'App must consume the per-slice status module'
    );
    assert.match(
      app,
      /DEFERRED_BOOTSTRAP_SLICES\.map\(\(key\) => fetchBootstrapSlice\(/,
      'the deferred ledgers must report through the shared loader'
    );
    assert.match(
      app,
      /\.map\(\(key\) => fetchBootstrapSlice\(key, branchId, fiscalYearId\)\)/,
      'the SSE targeted refresh must report through the same loader'
    );
    assert.ok(
      !app.includes('single-slice failure must not break the others'),
      'the silent .catch(() => null) both paths used is what C1 replaced'
    );
  });

  test('the notice is rendered with one dismiss and one retry', () => {
    const app = read('client/src/App.tsx');
    const notice = app.slice(app.indexOf('<BootstrapSliceNotice'), app.indexOf('/>', app.indexOf('<BootstrapSliceNotice')));
    assert.ok(notice.includes('slices={failedSliceErrors}'), 'the notice renders the aggregated failures');
    assert.ok(notice.includes('onRetry={retryFailedSlices}'), 'one retry re-fetches the failed slices');
    assert.ok(notice.includes('dismissSliceErrors'), 'dismissal is a state change, not a hidden toast');
    assert.ok(
      notice.includes('isAnySliceLoading(sliceState)'),
      'the retry button must reflect an in-flight retry'
    );
  });

  test('the request gate is consulted before any slice payload paints (C2)', () => {
    const app = read('client/src/App.tsx');
    const loader = app.slice(app.indexOf('const fetchBootstrapSlice'), app.indexOf('const applyCurrencyConfig'));
    assert.ok(
      loader.includes('sliceGateRef.current.begin(key, sliceScopeKey('),
      'each slice request must be stamped with its view'
    );
    assert.ok(
      loader.includes("if (verdict === 'superseded') return;"),
      'a superseded response must not touch the key its newer sibling owns'
    );
    assert.ok(
      loader.includes('settleSliceDiscarded(prev, key)'),
      'a discarded response must settle its loading flag'
    );
    assert.ok(
      loader.indexOf('applyBootstrapData({ [key]: res.slice }') > loader.indexOf('decide(request'),
      'the scope/version decision must run BEFORE the payload is applied'
    );
    assert.ok(
      app.includes('sliceGateRef.current.noteApplied(keys, options.dataVersion)'),
      'a full bootstrap payload must record its version so a slower slice cannot overwrite it'
    );
  });
});
