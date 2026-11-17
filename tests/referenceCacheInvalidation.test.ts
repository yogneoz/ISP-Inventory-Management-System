/**
 * Worklist A3 — a master-data write refreshes every worker's reference cache.
 *
 * The reference caches are per-process bindings hydrated at boot. Before this
 * slice a write updated only the worker that handled the request, so under
 * `instances: 'max'` a renamed branch or a deactivated product was stale on
 * every other worker until restart — wrong data, not slow data.
 *
 * PROVES, with the in-memory store in Redis mode (the same contract the real
 * subscriber uses):
 *   1. a write through a reference-cache setter is announced on the shared bus;
 *   2. another worker's invalidation re-runs that `CACHE_LOADS` entry, so the
 *      binding changes with no restart;
 *   3. the writing worker ignores its own invalidation (its binding is current);
 *   4. a name that is not in `CACHE_LOADS` is refused instead of guessed;
 *   5. without Redis there is nothing to tell, and the write still lands;
 *   6. every reference cache except the stock projection is wired to announce.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CACHE_INVALIDATION_CHANNEL,
  publishReferenceCacheInvalidation,
  startReferenceCacheInvalidation,
  stopReferenceCacheInvalidation,
} from '../server/src/state/cacheInvalidation';
import { CACHE_LOADS, branches, setBranches } from '../server/src/state/runtimeState';
import { MemorySharedStore, configureSharedStore } from '../server/src/state/sharedStore';

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met within the timeout');
};

describe('reference-cache invalidation across workers (A3)', () => {
  let store: MemorySharedStore;
  let published: string[];

  beforeEach(() => {
    stopReferenceCacheInvalidation();
    store = new MemorySharedStore('redis');
    configureSharedStore(store);
    published = [];
  });

  afterEach(() => {
    stopReferenceCacheInvalidation();
    configureSharedStore(new MemorySharedStore());
  });

  async function startWorker(origin: string, query: (sql: string) => Promise<{ rows: any[] }>) {
    await store.subscribe(CACHE_INVALIDATION_CHANNEL, (raw) => published.push(raw));
    await startReferenceCacheInvalidation({ store, origin, query });
  }

  test('a reference-cache write is announced on the shared bus', async () => {
    await startWorker('worker-a', async () => ({ rows: [] }));
    setBranches([{ id: 'BR-ANNOUNCED', name: 'Announced' } as any]);
    await waitFor(() => published.length > 0);
    assert.equal(JSON.parse(published[0]).name, 'branches');
    assert.equal(JSON.parse(published[0]).origin, 'worker-a');
  });

  test("another worker's invalidation reloads that cache without a restart", async () => {
    const queries: string[] = [];
    await startWorker('worker-a', async (sql) => {
      queries.push(sql);
      return { rows: [{ id: 'BR-REFRESHED', name: 'Refreshed elsewhere' }] };
    });
    assert.notEqual(branches[0]?.id, 'BR-REFRESHED');

    await store.publish(
      CACHE_INVALIDATION_CHANNEL,
      JSON.stringify({ name: 'branches', origin: 'worker-b' })
    );

    await waitFor(() => branches[0]?.id === 'BR-REFRESHED');
    assert.equal(queries.length, 1, 'exactly the one cache entry was re-run');
    assert.ok(queries[0].includes('branches'), 'the reload uses the CACHE_LOADS query');
  });

  test('the writing worker ignores its own invalidation', async () => {
    const queries: string[] = [];
    await startWorker('worker-a', async (sql) => {
      queries.push(sql);
      return { rows: [{ id: 'SHOULD-NOT-LAND' }] };
    });
    await store.publish(
      CACHE_INVALIDATION_CHANNEL,
      JSON.stringify({ name: 'branches', origin: 'worker-a' })
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(queries, [], 'no self-reload: the local binding is already the written one');
    assert.notEqual(branches[0]?.id, 'SHOULD-NOT-LAND');
  });

  test('a name that is not in CACHE_LOADS is refused instead of guessed', async () => {
    await startWorker('worker-a', async () => ({ rows: [] }));
    const before = published.length;
    assert.equal(await publishReferenceCacheInvalidation('customers', { origin: 'worker-a' }), false);
    assert.equal(published.length, before, 'nothing was published for an unknown cache');
  });

  test('without Redis nothing is published and the write still lands', async () => {
    configureSharedStore(new MemorySharedStore());
    const started = await startReferenceCacheInvalidation({ origin: 'solo' });
    assert.equal(started, false, 'a single-worker install has nobody to tell');
    setBranches([{ id: 'BR-SOLO', name: 'Solo' } as any]);
    assert.equal(branches[0]?.id, 'BR-SOLO', 'the local binding is still written');
    assert.equal(await publishReferenceCacheInvalidation('branches'), false);
  });

  test('every reference cache except the stock projection announces its writes', () => {
    const source = fs.readFileSync(path.resolve('server/src/state/runtimeState.ts'), 'utf8');
    const announced = [...source.matchAll(/notifyReferenceCacheWrite\('([^']+)'\)/g)].map((m) => m[1]);
    const expected = CACHE_LOADS.map((load) => load.name).filter((name) => name !== 'inventory_stock');
    assert.deepEqual(
      [...new Set(announced)].sort(),
      [...expected].sort(),
      'every hydrated reference cache is wired, and the hot stock projection is deliberately not'
    );
  });
});
