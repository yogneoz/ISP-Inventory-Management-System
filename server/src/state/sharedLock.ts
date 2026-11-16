/**
 * Distributed process-wide locks and fencing tokens (SCALE-1).
 *
 * Document numbers and ledger writes keep their PostgreSQL row locks — those
 * are per-row and already correct. This lock is for jobs that must run once
 * across workers (boot schema/seed, partition provisioning, retention, cache
 * rebuild). The value is a random owner token, released only by the owner;
 * every acquisition also takes a monotonic fencing token so a late owner can
 * be rejected by a downstream resource that checks it.
 */
import { getSharedStore, newRateMember, SharedStateUnavailableError } from './sharedStore';

export interface SharedLease {
  key: string;
  owner: string;
  fencingToken: number;
}

export interface SharedLock {
  acquire(key: string, ttlMs: number): Promise<SharedLease | null>;
  release(lease: SharedLease): Promise<boolean>;
  withLock<T>(key: string, ttlMs: number, fn: (lease: SharedLease) => Promise<T>): Promise<{ acquired: boolean; value?: T }>;
}

export function createSharedLock(): SharedLock {
  const store = getSharedStore();
  return {
    async acquire(key, ttlMs) {
      if (store.kind !== 'redis') return null;
      const owner = newRateMember();
      const ok = await store.setNxPx(`isp:lock:${key}`, owner, ttlMs);
      if (!ok) return null;
      const fencingToken = await store.incr(`isp:fence:${key}`);
      return { key, owner, fencingToken };
    },
    async release(lease) {
      return store.compareAndDelete(`isp:lock:${lease.key}`, lease.owner);
    },
    async withLock(key, ttlMs, fn) {
      const lease = await this.acquire(key, ttlMs);
      if (!lease) return { acquired: false };
      try {
        return { acquired: true, value: await fn(lease) };
      } finally {
        await this.release(lease).catch(() => {});
      }
    },
  };
}

/**
 * Boot jobs run in every worker but only the leader may execute them. Followers
 * wait for the leader's lock to disappear (or for the TTL to expire) and then
 * continue; they do not run a second migration/seed pass. Without Redis this
 * is a single worker, so it runs locally.
 */
export async function withStartupLeadership<T>(
  key: string,
  fn: () => Promise<T>,
  options: { ttlMs?: number; waitMs?: number } = {}
): Promise<{ leader: boolean; value?: T }> {
  const store = getSharedStore();
  if (store.kind !== 'redis') {
    return { leader: true, value: await fn() };
  }
  const lock = createSharedLock();
  const ttlMs = options.ttlMs ?? 15 * 60_000;
  const doneKey = `isp:startup:done:${key}`;

  const lease = await lock.acquire(key, ttlMs);
  if (lease) {
    try {
      const value = await fn();
      await store.set(doneKey, '1', 60_000).catch(() => {});
      return { leader: true, value };
    } finally {
      await lock.release(lease).catch(() => {});
    }
  }

  const deadline = Date.now() + (options.waitMs ?? 120_000);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  while (Date.now() < deadline) {
    if (await store.get(doneKey)) return { leader: false };
    const exists = await store.get(`isp:lock:${key}`);
    if (!exists) {
      // The leader crashed before writing the completion marker and its TTL
      // expired. One follower takes over; the others see the new lock or the
      // marker and skip.
      const retry = await lock.acquire(key, ttlMs);
      if (retry) {
        try {
          const value = await fn();
          await store.set(doneKey, '1', 60_000).catch(() => {});
          return { leader: true, value };
        } finally {
          await lock.release(retry).catch(() => {});
        }
      }
    }
    await sleep(100);
  }
  throw new SharedStateUnavailableError(`Timed out waiting for startup leader '${key}'`);
}
