/**
 * Redis read-through for catalog bindings (SCALE-3).
 *
 * PROVES, with the in-memory store standing in for Redis (the repository's
 * documented convention — no daemon is required for the suite):
 *   1. a second read is served from the cache and does not reach PostgreSQL;
 *   2. the entry carries the declared staleness bound as its TTL, so a lost
 *      invalidation still cannot serve data older than `CATALOG_CACHE_TTL_MS`;
 *   3. an invalidation (the version bump a write performs before it responds)
 *      makes the very next read miss and reload from the source of truth.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemorySharedStore,
  configureSharedStore,
  getSharedStore,
} from '../server/src/state/sharedStore';
import { CATALOG_CACHE_TTL_MS, invalidateCatalog, readCatalog } from '../server/src/state/catalogCache';

class RecordingStore extends MemorySharedStore {
  readonly ttlWrites: Array<{ key: string; ttlMs: number | undefined }> = [];
  constructor() {
    super('redis');
  }
  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.ttlWrites.push({ key, ttlMs });
    return super.set(key, value, ttlMs);
  }
}

let store: RecordingStore;

describe('catalog read-through', () => {
  before(() => {
    store = new RecordingStore();
    configureSharedStore(store);
  });
  after(() => {
    configureSharedStore(new MemorySharedStore());
  });

  test('a repeated read is served from the cache, not from PostgreSQL', async () => {
    await invalidateCatalog('locations');
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [{ id: 'L1', name: 'First' }];
    };
    const first = await readCatalog('locations', 'ALL', load);
    const second = await readCatalog('locations', 'ALL', load);
    assert.equal(first.source, 'postgres');
    assert.equal(second.source, 'shared-cache');
    assert.equal(loads, 1, 'the second read did not reach the loader');
    assert.deepEqual(second.value, [{ id: 'L1', name: 'First' }]);
  });

  test('the cached payload carries the declared staleness bound', async () => {
    await invalidateCatalog('locations');
    await readCatalog('locations', 'ALL', async () => [{ id: 'L2' }]);
    const write = store.ttlWrites.at(-1);
    assert.ok(write, 'the read stored a payload');
    assert.equal(write!.ttlMs, CATALOG_CACHE_TTL_MS);
    assert.ok(CATALOG_CACHE_TTL_MS > 0 && CATALOG_CACHE_TTL_MS <= 60_000);
  });

  test('an invalidation makes the very next read reload the committed row', async () => {
    await invalidateCatalog('locations');
    let rows = [{ id: 'L3', name: 'before' }];
    const load = async () => rows;
    assert.deepEqual((await readCatalog('locations', 'ALL', load)).value, rows);
    // The write commits, then bumps the version before it responds.
    rows = [{ id: 'L3', name: 'after' }];
    await invalidateCatalog('locations');
    const next = await readCatalog('locations', 'ALL', load);
    assert.equal(next.source, 'postgres', 'the invalidated read missed the cache');
    assert.deepEqual(next.value, rows, 'the reader saw the committed row');
  });

  test('a namespace is isolated from another one', async () => {
    await invalidateCatalog('locations');
    await invalidateCatalog('suppliers');
    await readCatalog('locations', 'ALL', async () => ['loc']);
    await invalidateCatalog('suppliers');
    const afterSupplierBump = await readCatalog('locations', 'ALL', async () => ['reloaded']);
    assert.equal(getSharedStore().kind, 'redis');
    assert.deepEqual(afterSupplierBump.value, ['loc'], 'another namespace stays cached');
  });
});
