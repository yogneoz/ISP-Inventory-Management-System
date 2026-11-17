/**
 * Cross-worker reference-cache invalidation (worklist A3).
 *
 * The reference caches (`branches`, `users`, `products`, …) are per-process
 * bindings in `state/runtimeState`, hydrated once at boot. A master-data write
 * updates the binding **of the worker that handled the request** and nothing
 * else, so under `instances: 'max'` a renamed branch or a deactivated product
 * stayed stale on every other worker until it restarted. That is wrong data, not
 * slow data: a different worker serves the old catalogue.
 *
 * Design: the setters announce the write through `cacheWriteHook`; this module
 * publishes `{ name, origin }` on the existing shared bus; every worker's
 * subscriber re-runs that one `CACHE_LOADS` entry against PostgreSQL. The
 * publisher's own worker keeps the binding it already wrote, so its own message
 * is ignored by origin.
 *
 * Failure policy: no Redis means one worker (nothing to coordinate); a publish
 * or reload failure is logged and leaves the local binding correct. Nothing here
 * throws into a request.
 */
import { pgPool } from '../../db';
import { CACHE_LOADS } from './runtimeState';
import { setReferenceCacheWriteHook } from './cacheWriteHook';
import { getSharedStore, isRedisSharedState } from './sharedStore';
import type { SharedStore } from './sharedStore';

export const CACHE_INVALIDATION_CHANNEL = 'isp:cache:invalidated';

export interface CacheInvalidationMessage {
  /** A `CACHE_LOADS` name; anything else is refused, not guessed. */
  name: string;
  /** The worker that wrote it; its own binding is already current. */
  origin: string;
}

export type CacheQueryFn = (sql: string) => Promise<{ rows: any[] }>;

let origin: string | null = null;
let query: CacheQueryFn = (sql) => pgPool.query(sql);

/** The cache names a write can invalidate — the load list, nothing invented. */
export function referenceCacheNames(): string[] {
  return CACHE_LOADS.map((load) => load.name);
}

export function isReferenceCacheName(name: string): boolean {
  return CACHE_LOADS.some((load) => load.name === name);
}

/**
 * Ask every OTHER worker to re-run this cache's `CACHE_LOADS` entry.
 * Returns whether a message went out (false on a single-worker install).
 */
export async function publishReferenceCacheInvalidation(
  name: string,
  options: { origin?: string } = {}
): Promise<boolean> {
  if (!isReferenceCacheName(name)) {
    console.warn(`Reference cache invalidation ignored: "${name}" is not in CACHE_LOADS.`);
    return false;
  }
  if (!isRedisSharedState()) return false;
  const message: CacheInvalidationMessage = { name, origin: options.origin ?? origin ?? 'unknown' };
  try {
    await getSharedStore().publish(CACHE_INVALIDATION_CHANNEL, JSON.stringify(message));
    return true;
  } catch (err: any) {
    console.error('Reference cache invalidation publish failed (local binding is still current):', err?.message || err);
    return false;
  }
}

/**
 * Re-run one `CACHE_LOADS` entry on this worker. The query comes from the same
 * list the boot hydrates with, so the two can never disagree about the shape.
 */
export async function reloadReferenceCache(name: string, runner: CacheQueryFn = query): Promise<boolean> {
  const load = CACHE_LOADS.find((entry) => entry.name === name);
  if (!load) {
    console.warn(`Reference cache reload ignored: "${name}" is not in CACHE_LOADS.`);
    return false;
  }
  try {
    const result = await runner(load.query);
    load.apply(result.rows);
    return true;
  } catch (err: any) {
    console.warn(`Reference cache reload failed for ${name} (keeping the current binding):`, err?.message || err);
    return false;
  }
}

/**
 * Boot-time wiring: subscribe to the channel, then route setter writes into it.
 * A single-worker install (no Redis) skips both — there is nobody to tell.
 */
export async function startReferenceCacheInvalidation(
  options: { store?: SharedStore; origin?: string; query?: CacheQueryFn } = {}
): Promise<boolean> {
  const store = options.store ?? getSharedStore();
  if (store.kind !== 'redis') return false;
  const self = options.origin ?? `worker-${process.pid}`;
  origin = self;
  query = options.query ?? ((sql) => pgPool.query(sql));
  await store.subscribe(CACHE_INVALIDATION_CHANNEL, (raw) => {
    void handleInvalidation(raw, self);
  });
  setReferenceCacheWriteHook((name) => {
    void publishReferenceCacheInvalidation(name, { origin: self });
  });
  console.log('✅ Reference cache invalidation connected: a master-data write refreshes every worker.');
  return true;
}

async function handleInvalidation(raw: string, self: string): Promise<void> {
  let message: CacheInvalidationMessage;
  try {
    message = JSON.parse(raw) as CacheInvalidationMessage;
  } catch {
    return;
  }
  if (!message || typeof message.name !== 'string') return;
  // Our own write: the binding is already the one just stored.
  if (message.origin === self) return;
  await reloadReferenceCache(message.name, query);
}

/**
 * Test/shutdown hook: stop routing setter writes and forget the subscriber.
 * The store owns the connection; this only clears the module's own state.
 */
export function stopReferenceCacheInvalidation(): void {
  setReferenceCacheWriteHook(null);
  origin = null;
  query = (sql) => pgPool.query(sql);
}
