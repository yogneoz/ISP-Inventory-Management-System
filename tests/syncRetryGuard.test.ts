/**
 * AUD-4: one pending SSE reconnect at a time.
 *
 * `scheduleRetry` used to assign the retry timer unconditionally. Today's only
 * caller cannot reach it twice (onerror fires once per source, and the source
 * is closed and nulled first), so this is a hardening fix, not a live defect.
 * The test drives the failure path the way a future handler change would —
 * two `onerror` invocations from one failed source — and asserts that only one
 * reconnect is scheduled, while the ladder still reconnects and can fail
 * again afterwards.
 *
 * The module reads `localStorage` at import time, so the stubs must exist
 * before the dynamic import; timers are Node's mocked timers, not hand-rolled
 * globals, so the runner itself is untouched.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

const store = new Map<string, string>([['inventory_auth_token', 'test-token']]);

(globalThis as any).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
(globalThis as any).EventSource = FakeEventSource;
// No relay channel: this suite exercises the reconnect ladder only.
(globalThis as any).BroadcastChannel = undefined;
(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
};
(globalThis as any).document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  visibilityState: 'visible',
};

const { subscribeToSyncStream } = await import('../client/src/services/api/sync');

// One backoff step is capped at 30 s; ticking past the cap fires it.
const RETRY_TICK_MS = 31_000;

describe('AUD-4: one pending SSE reconnect at a time', () => {
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    dispose?.();
    dispose = null;
    FakeEventSource.instances = [];
  });

  test('two onerror callbacks from one failed source open one retry, not two', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    dispose = subscribeToSyncStream(() => {}, () => {});
    assert.equal(FakeEventSource.instances.length, 1, 'subscribing connects immediately');

    const failed = FakeEventSource.instances[0];
    failed.onerror?.();
    failed.onerror?.();

    t.mock.timers.tick(RETRY_TICK_MS);
    assert.equal(
      FakeEventSource.instances.length,
      2,
      'a stacked second timer would open a second EventSource in the same tick'
    );
  });

  test('the guard does not wedge the ladder: a later failure schedules the next retry', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    dispose = subscribeToSyncStream(() => {}, () => {});

    FakeEventSource.instances[0].onerror?.();
    t.mock.timers.tick(RETRY_TICK_MS);
    assert.equal(FakeEventSource.instances.length, 2, 'the scheduled retry connects');

    FakeEventSource.instances[1].onerror?.();
    t.mock.timers.tick(RETRY_TICK_MS);
    assert.equal(FakeEventSource.instances.length, 3, 'a later failure still retries');
  });

  test('unsubscribing clears the pending retry', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stop = subscribeToSyncStream(() => {}, () => {});
    FakeEventSource.instances[0].onerror?.();

    stop();
    t.mock.timers.tick(RETRY_TICK_MS);
    assert.equal(FakeEventSource.instances.length, 1, 'a disposed subscription must not reconnect');
    assert.equal(FakeEventSource.instances[0].closed, true);
  });
});
