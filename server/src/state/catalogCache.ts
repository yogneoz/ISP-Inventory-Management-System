/**
 * Redis read-through for the small catalog bindings (SCALE-3).
 *
 * A catalog read (locations today) used to cost one PostgreSQL round trip on
 * every request even though the rows change only on a master-data write. On a
 * pooled configuration the read is now served from Redis:
 *
 *   version = GET isp:catalog:version:<ns>        (one Redis GET)
 *   payload = GET isp:catalog:<ns>:v<version>:<suffix>
 *
 * A miss loads from PostgreSQL and stores the payload with a TTL. The TTL is the
 * declared staleness bound and it is enforced here, in code: a read can never be
 * served data older than `CATALOG_CACHE_TTL_MS` even if an invalidation is lost.
 *
 * Freshness in the normal path is immediate, not eventual: a write bumps the
 * namespace version (INCR) before it responds, so every worker — the one that
 * took the write and every other one sharing the Redis server — misses the old
 * keys on its very next read. Old payloads become unreachable at once and are
 * reclaimed by their TTL.
 *
 * Without a Redis store (single-process dev, unit tests) this degrades to the
 * direct load: no cache, no staleness, no extra round trip.
 */
import { intFromEnv } from '../utils/envGuard';
import { getSharedStore } from './sharedStore';

/** The staleness bound: no catalog read may be served data older than this. */
export const CATALOG_CACHE_TTL_MS = intFromEnv('CATALOG_CACHE_TTL_MS', 5000, {
  min: 100,
  max: 60_000,
});

export interface CatalogRead<T> {
  value: T;
  source: 'shared-cache' | 'postgres';
}

function versionKey(namespace: string): string {
  return `isp:catalog:version:${namespace}`;
}

function payloadKey(namespace: string, version: string, suffix: string): string {
  return `isp:catalog:${namespace}:v${version}:${suffix}`;
}

/** Read one catalog binding through Redis, falling back to PostgreSQL. */
export async function readCatalog<T>(
  namespace: string,
  suffix: string,
  load: () => Promise<T>
): Promise<CatalogRead<T>> {
  const store = getSharedStore();
  if (!store || store.kind !== 'redis') {
    return { value: await load(), source: 'postgres' };
  }
  let version = '0';
  try {
    version = (await store.get(versionKey(namespace))) ?? '0';
    const hit = await store.get(payloadKey(namespace, version, suffix));
    if (hit !== null) return { value: JSON.parse(hit) as T, source: 'shared-cache' };
  } catch {
    // A cache that cannot be read is not an error: read the source of truth.
    return { value: await load(), source: 'postgres' };
  }
  const value = await load();
  try {
    await store.set(payloadKey(namespace, version, suffix), JSON.stringify(value), CATALOG_CACHE_TTL_MS);
  } catch {
    /* storing is best effort; the next reader simply loads again */
  }
  return { value, source: 'postgres' };
}

/**
 * Make every cached payload for this namespace unreachable. Called after the
 * write commits and before the response goes out, so the writer's own next read
 * is fresh, and shared through Redis so every other worker's is too.
 */
export async function invalidateCatalog(namespace: string): Promise<void> {
  const store = getSharedStore();
  if (!store || store.kind !== 'redis') return;
  try {
    await store.incr(versionKey(namespace));
  } catch {
    /* best effort: the TTL bound still applies */
  }
}
