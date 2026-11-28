/**
 * Cross-worker cache invalidation (worklist A3, extended by audit 2026-11-28 C2).
 *
 * The reference caches (`branches`, `users`, `products`, …) are per-process
 * bindings in `state/runtimeState`, hydrated once at boot. A master-data write
 * updates the binding **of the worker that handled the request** and nothing
 * else, so under `instances: 'max'` a renamed branch or a deactivated product
 * stayed stale on every other worker until it restarted. That is wrong data, not
 * slow data: a different worker serves the old catalogue.
 *
 * The permission caches (`permissionMatrix`, `userPermissionOverrides`,
 * `userPermissionSetGrants`) are the same problem with a worse consequence:
 * they are what `requirePermission` ENFORCES. A committed grant or deny used to
 * reach only the worker that served the write, so every other worker kept
 * enforcing the previous RBAC answer — a revoked operation stayed usable and a
 * granted one kept answering 403, depending on which worker the load balancer
 * picked. They ride the same bus under the reserved name `permissions`
 * (`cacheWriteHook.PERMISSIONS_CACHE_NAME`) and are re-read from their three
 * tables.
 *
 * Design: the setters announce the write through `cacheWriteHook`; this module
 * publishes `{ name, origin }` on the existing shared bus; every worker's
 * subscriber re-runs that one load against PostgreSQL. The publisher's own
 * worker keeps the binding it already wrote, so its own message is ignored by
 * origin.
 *
 * Failure policy: no Redis means one worker (nothing to coordinate); a publish
 * or reload failure is logged and leaves the local binding correct. Nothing here
 * throws into a request.
 *
 * No echo: applying a remote message writes the same setters, which announce
 * again. `applyingRemote` suppresses that announcement for the duration of the
 * apply, so two workers cannot ping-pong invalidations forever.
 */
import { pgPool } from '../../db';
import {
  CACHE_LOADS,
  setPermissionMatrix,
  setUserPermissionOverrides,
  setUserPermissionSetGrants,
} from './runtimeState';
import { setReferenceCacheWriteHook, PERMISSIONS_CACHE_NAME } from './cacheWriteHook';
import { getSharedStore, isRedisSharedState } from './sharedStore';
import type { SharedStore } from './sharedStore';
import {
  PERMISSION_MATRIX_SELECT_SQL,
  PERMISSION_SET_USER_GRANTS_SELECT_SQL,
  USER_PERMISSION_OVERRIDES_SELECT_SQL,
  rowsToPermissionMatrix,
  rowsToUserPermissionOverrideMap,
  rowsToUserPermissionSetGrantMap,
} from '../models/permissions.repo';
import { bumpPermissionsVersion } from '../services/permissionOverrides.service';

export const CACHE_INVALIDATION_CHANNEL = 'isp:cache:invalidated';

export interface CacheInvalidationMessage {
  /** A `CACHE_LOADS` name, or the reserved `permissions`; anything else is refused, not guessed. */
  name: string;
  /** The worker that wrote it; its own binding is already current. */
  origin: string;
}

export type CacheQueryFn = (sql: string) => Promise<{ rows: any[] }>;

let origin: string | null = null;
let query: CacheQueryFn = (sql) => pgPool.query(sql);
/** True while a remote message is being applied, so the apply does not re-publish. */
let applyingRemote = false;

/** The cache names a write can invalidate — the load list plus the permission caches. */
export function referenceCacheNames(): string[] {
  return [...CACHE_LOADS.map((load) => load.name), PERMISSIONS_CACHE_NAME];
}

export function isReferenceCacheName(name: string): boolean {
  return name === PERMISSIONS_CACHE_NAME || CACHE_LOADS.some((load) => load.name === name);
}

/**
 * Re-reads the three RBAC tables and publishes them to the enforcement path in
 * one step, so a worker can never enforce a matrix from one commit beside
 * overrides from another.
 */
async function reloadPermissionCaches(runner: CacheQueryFn): Promise<boolean> {
  try {
    const [matrixRes, overrideRes, grantRes] = await Promise.all([
      runner(PERMISSION_MATRIX_SELECT_SQL),
      runner(USER_PERMISSION_OVERRIDES_SELECT_SQL),
      runner(PERMISSION_SET_USER_GRANTS_SELECT_SQL),
    ]);
    applyingRemote = true;
    try {
      setPermissionMatrix(rowsToPermissionMatrix(matrixRes.rows));
      setUserPermissionOverrides(rowsToUserPermissionOverrideMap(overrideRes.rows));
      setUserPermissionSetGrants(rowsToUserPermissionSetGrantMap(grantRes.rows));
      bumpPermissionsVersion();
    } finally {
      applyingRemote = false;
    }
    return true;
  } catch (err: any) {
    // Keep the grants this worker already holds rather than publishing a
    // half-read answer; the next write or a restart retries. Logged, never
    // thrown into the request that received the message.
    console.warn(
      'Permission cache reload failed on this worker (keeping the current grants):',
      err?.message || err
    );
    return false;
  }
}

/**
 * Ask every OTHER worker to re-run this cache's load. Returns whether a message
 * went out (false on a single-worker install).
 */
export async function publishReferenceCacheInvalidation(
  name: string,
  options: { origin?: string } = {}
): Promise<boolean> {
  if (!isReferenceCacheName(name)) {
    console.warn(`Cache invalidation ignored: "${name}" is not a known cache.`);
    return false;
  }
  if (!isRedisSharedState()) return false;
  const message: CacheInvalidationMessage = { name, origin: options.origin ?? origin ?? 'unknown' };
  try {
    await getSharedStore().publish(CACHE_INVALIDATION_CHANNEL, JSON.stringify(message));
    return true;
  } catch (err: any) {
    console.error('Cache invalidation publish failed (local binding is still current):', err?.message || err);
    return false;
  }
}

/**
 * Re-run one load on this worker. The query comes from the same list the boot
 * hydrates with, so the two can never disagree about the shape.
 */
export async function reloadReferenceCache(name: string, runner: CacheQueryFn = query): Promise<boolean> {
  if (name === PERMISSIONS_CACHE_NAME) return reloadPermissionCaches(runner);
  const load = CACHE_LOADS.find((entry) => entry.name === name);
  if (!load) {
    console.warn(`Reference cache reload ignored: "${name}" is not a known cache.`);
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
    // An apply must not announce itself, or two workers echo each other until
    // the bus gives up.
    if (applyingRemote) return;
    void publishReferenceCacheInvalidation(name, { origin: self });
  });
  console.log('✅ Cache invalidation connected: a master-data or permission write refreshes every worker.');
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
  applyingRemote = false;
  query = (sql) => pgPool.query(sql);
}
