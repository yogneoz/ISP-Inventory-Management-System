/**
 * C3 — hydration flow, end to end at the module boundary.
 *
 * C1's tests check the status reducer one call at a time; C2's check the gate
 * one decision at a time. Neither proves the two compose into the behaviour the
 * user sees. These scenarios drive BOTH, in the same order App's
 * `fetchBootstrapSlice` / `applyBootstrapData` do, with responses resolving out
 * of order — the failure mode that produced the original bugs.
 *
 * The tiny harness below mirrors App's contract (its ordering is pinned by the
 * wiring assertions in bootstrapSlices.test.ts):
 *
 *   begin   → beginSliceLoad            (loading, keeps last version + error)
 *   resolve → decide → apply            (data + version recorded, status ready)
 *                    → superseded       (newer request owns the key; untouched)
 *                    → stale-scope /
 *                      older-version    (payload dropped, loading settled)
 *   fail    → decide → apply            (error + notice) / dropped as above
 *   bootstrap(payload)                  (only carried keys ready; versions noted)
 *
 * They are pure: no server, no DOM, no timers — arrival order is expressed by
 * the order the test resolves the stamped requests.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginSliceLoad,
  createBootstrapSliceState,
  dismissSliceErrors,
  isAnySliceLoading,
  markSliceError,
  markSliceReady,
  markSlicesReady,
  settleSliceDiscarded,
  visibleSliceErrors,
  SliceRequestGate,
  type BootstrapSliceState,
  type SliceDecision,
  type SliceRequest,
} from '../client/src/services/bootstrapSlices';

interface SlicePayload {
  slice?: unknown;
  dataVersion?: number;
}

class HydrationHarness {
  state: BootstrapSliceState = createBootstrapSliceState();
  gate = new SliceRequestGate();
  scope = 'ALL|ALL';
  /** What would now be painted on screen, in application order. */
  applied: Array<{ key: string; value: unknown; version?: number }> = [];

  /** Start a slice request for the current view (App: fetchBootstrapSlice). */
  begin(key: string): SliceRequest {
    const request = this.gate.begin(key, this.scope);
    this.state = beginSliceLoad(this.state, key);
    return request;
  }

  /** A successful response for a stamped request. */
  resolve(request: SliceRequest, res: SlicePayload): SliceDecision {
    const verdict = this.gate.decide(request, this.scope, res.dataVersion);
    if (verdict === 'superseded') return verdict; // newer request owns the key
    if (verdict !== 'apply') {
      this.state = settleSliceDiscarded(this.state, request.key);
      return verdict;
    }
    if (res.slice === undefined) {
      this.state = markSliceError(this.state, request.key, `No ${request.key} data`);
      return verdict;
    }
    this.applied.push({ key: request.key, value: res.slice, version: res.dataVersion });
    this.state = markSliceReady(this.state, request.key, res.dataVersion);
    this.gate.noteApplied([request.key], res.dataVersion);
    return verdict;
  }

  /** A failed response for a stamped request. */
  fail(request: SliceRequest, message: string): SliceDecision {
    const verdict = this.gate.decide(request, this.scope);
    if (verdict === 'superseded') return verdict;
    if (verdict !== 'apply') {
      this.state = settleSliceDiscarded(this.state, request.key);
      return verdict;
    }
    this.state = markSliceError(this.state, request.key, message);
    return verdict;
  }

  /** A full bootstrap payload for the current view. */
  bootstrap(payload: Record<string, unknown>, version: number): void {
    const keys = Object.keys(payload);
    this.state = markSlicesReady(this.state, keys, version);
    this.gate.noteApplied(keys, version);
    for (const [key, value] of Object.entries(payload)) {
      this.applied.push({ key, value, version });
    }
  }

  switchScope(scope: string): void {
    this.scope = scope;
  }

  noticeText(): string[] {
    return visibleSliceErrors(this.state).map((slice) => `${slice.key}: ${slice.message}`);
  }
}

describe('hydration flow (C3)', () => {
  test('a full bootstrap, then a slower targeted response for the same key cannot roll it back', () => {
    const h = new HydrationHarness();
    h.bootstrap({ stock: ['fresh-all'], purchaseOrders: ['po-1'] }, 100);

    // This targeted request was issued BEFORE the bootstrap landed; its payload
    // is version 99, which is older than the rows now on screen.
    const stale = h.begin('stock');
    assert.equal(h.resolve(stale, { slice: ['old-stock'], dataVersion: 99 }), 'older-version');

    assert.deepEqual(
      h.applied.map((entry) => [entry.key, entry.value]),
      [
        ['stock', ['fresh-all']],
        ['purchaseOrders', ['po-1']],
      ],
      'the stale payload must never reach the screen'
    );
    assert.deepEqual(h.state.stock, { status: 'ready', dataVersion: 100 });
    assert.equal(isAnySliceLoading(h.state), false, 'the discarded request must not leave it spinning');
    assert.deepEqual(h.noticeText(), []);
  });

  test('branch switch mid-flight: the old view response is discarded whichever stamp decides it', () => {
    // (a) The old response lands after the switch but BEFORE the new view's
    // request starts: scope alone identifies it, even with a newer version.
    const early = new HydrationHarness();
    early.bootstrap({ stock: ['all-stock'] }, 50);
    const forAll = early.begin('stock');
    early.switchScope('BRH01|ALL');
    assert.equal(early.resolve(forAll, { slice: ['old-all-v200'], dataVersion: 200 }), 'stale-scope');
    assert.deepEqual(early.applied.map((entry) => entry.value), [['all-stock']]);
    assert.deepEqual(
      early.state.stock,
      { status: 'ready', dataVersion: 50 },
      'the payload is dropped and the loading flag settles to the rows still on screen'
    );

    // (b) The new view's request starts first, so the old response is
    // superseded; either way it must not paint.
    const late = new HydrationHarness();
    late.bootstrap({ stock: ['all-stock'] }, 50);
    const lateAll = late.begin('stock');
    late.switchScope('BRH01|ALL');
    const forBranch = late.begin('stock');

    assert.equal(late.resolve(lateAll, { slice: ['old-all-v200'], dataVersion: 200 }), 'superseded');
    assert.equal(late.resolve(forBranch, { slice: ['brh01-stock'], dataVersion: 150 }), 'apply');
    assert.deepEqual(
      late.applied.map((entry) => entry.value),
      [['all-stock'], ['brh01-stock']],
      'only the new scope payload may paint after the switch'
    );
    assert.deepEqual(late.state.stock, { status: 'ready', dataVersion: 150 });
  });

  test('two bursts for one key: the earlier response is superseded, the later one owns the status', () => {
    const h = new HydrationHarness();
    const first = h.begin('purchaseOrders');
    const second = h.begin('purchaseOrders');

    assert.equal(h.resolve(first, { slice: ['burst-1'], dataVersion: 10 }), 'superseded');
    assert.deepEqual(
      h.applied,
      [],
      'a superseded response must not paint, even though its payload is valid'
    );
    assert.equal(h.state.purchaseOrders.status, 'loading', 'the newer request is still in flight');

    assert.equal(h.fail(second, 'Timeout'), 'apply');
    assert.deepEqual(h.state.purchaseOrders, {
      status: 'error',
      error: 'Timeout',
      errorDismissed: false,
    });
    assert.deepEqual(h.noticeText(), ['purchaseOrders: Timeout']);
  });

  test('failure → one notice → dismissal → same failure stays quiet → success clears it', () => {
    const h = new HydrationHarness();

    const failed = h.begin('purchaseInvoices');
    assert.equal(h.fail(failed, 'Gateway Timeout'), 'apply');
    assert.deepEqual(h.noticeText(), ['purchaseInvoices: Gateway Timeout']);

    h.state = dismissSliceErrors(h.state);
    assert.deepEqual(h.noticeText(), []);

    // Retry #1 fails for the same reason: the user already dismissed it.
    const retry1 = h.begin('purchaseInvoices');
    assert.equal(h.fail(retry1, 'Gateway Timeout'), 'apply');
    assert.deepEqual(h.noticeText(), []);

    // Retry #2 succeeds: the retained error, dismissal and loading flag all go.
    const retry2 = h.begin('purchaseInvoices');
    assert.equal(h.resolve(retry2, { slice: ['pi-1'], dataVersion: 12 }), 'apply');
    assert.deepEqual(h.state.purchaseInvoices, { status: 'ready', dataVersion: 12 });
    assert.equal(isAnySliceLoading(h.state), false);
    assert.deepEqual(h.noticeText(), []);
    assert.deepEqual(h.applied, [{ key: 'purchaseInvoices', value: ['pi-1'], version: 12 }]);
  });

  test('a failure from the view the user left never becomes an error in the new view', () => {
    const h = new HydrationHarness();
    const forAll = h.begin('damageRecords');
    h.switchScope('WH001|ALL');

    assert.equal(h.fail(forAll, 'Network down'), 'stale-scope');
    assert.deepEqual(h.noticeText(), [], 'the current view did not fail');
    assert.equal(h.state.damageRecords.status, 'idle', 'never loaded here, so not "ready"');
  });

  test('versions are monotonic per key and independent between keys', () => {
    const h = new HydrationHarness();

    const stock10 = h.begin('stock');
    assert.equal(h.resolve(stock10, { slice: ['s10'], dataVersion: 10 }), 'apply');

    const stock9 = h.begin('stock');
    assert.equal(h.resolve(stock9, { slice: ['s9'], dataVersion: 9 }), 'older-version');

    const invoices5 = h.begin('purchaseInvoices');
    assert.equal(h.resolve(invoices5, { slice: ['i5'], dataVersion: 5 }), 'apply');

    const stock10again = h.begin('stock');
    assert.equal(h.resolve(stock10again, { slice: ['s10b'], dataVersion: 10 }), 'apply');

    assert.deepEqual(
      h.applied.map((entry) => `${entry.key}:${entry.version}`),
      ['stock:10', 'purchaseInvoices:5', 'stock:10']
    );
  });

  test('a deferred ledger error survives a full bootstrap that does not carry it', () => {
    const h = new HydrationHarness();
    const deferred = h.begin('purchaseOrders');
    h.fail(deferred, 'Timeout');
    assert.deepEqual(h.noticeText(), ['purchaseOrders: Timeout']);

    // The full payload excludes the deferred ledgers — it cannot vouch for them.
    h.bootstrap({ stock: ['s1'], fiscalYears: ['fy-4'] }, 77);

    assert.deepEqual(h.noticeText(), ['purchaseOrders: Timeout']);
    assert.equal(h.state.purchaseOrders.status, 'error');

    // Its own successful load is what clears it.
    const ok = h.begin('purchaseOrders');
    h.resolve(ok, { slice: ['po-1'], dataVersion: 78 });
    assert.deepEqual(h.noticeText(), []);
  });

  test('a discarded request settles the loading flag in every prior state', () => {
    const h = new HydrationHarness();

    // Never loaded → idle, not ready (there is nothing to show).
    const first = h.begin('stockOperations');
    h.switchScope('BRH01|ALL');
    h.resolve(first, { slice: ['x'], dataVersion: 1 });
    assert.equal(h.state.stockOperations.status, 'idle');

    // Previously applied → ready with the version still on screen.
    h.switchScope('ALL|ALL');
    const applied = h.begin('stockOperations');
    h.resolve(applied, { slice: ['y'], dataVersion: 2 });
    const inFlight = h.begin('stockOperations');
    h.switchScope('BRH01|ALL');
    h.resolve(inFlight, { slice: ['z'], dataVersion: 3 });
    assert.deepEqual(h.state.stockOperations, { status: 'ready', dataVersion: 2 });

    // An existing error survives a discarded retry.
    h.switchScope('ALL|ALL');
    const failed = h.begin('stockOperations');
    h.fail(failed, 'Timeout');
    const retry = h.begin('stockOperations');
    h.switchScope('BRH01|ALL');
    h.fail(retry, 'Timeout');
    assert.deepEqual(h.state.stockOperations, {
      status: 'error',
      dataVersion: 2,
      error: 'Timeout',
      errorDismissed: false,
    });
    assert.equal(isAnySliceLoading(h.state), false);
  });
});
