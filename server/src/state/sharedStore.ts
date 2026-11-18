/**
 * Shared state for horizontal workers (SCALE-1).
 *
 * PostgreSQL remains the source of truth. This module holds only the small,
 * coordination-shaped state a second worker must see: rate-limit buckets,
 * session fingerprints, distributed locks/fencing tokens and SSE pub/sub.
 *
 * REDIS_URL / REDIS_TLS_URL select the Redis backend. With neither set the
 * server runs the same code against an in-memory store, which is correct only
 * for one worker; `assertSharedStateForWorkers` refuses a clustered production
 * boot without Redis, so the fallback cannot silently multiply security limits.
 *
 * Fail modes are explicit at the call sites:
 *   - auth / API-key limits and session revocation fail closed (503);
 *   - SSE fan-out and other read-side notifications fail open with a log alert.
 */
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import type { RateLimitVerdict } from '../utils/rateLimiter';

export class SharedStateUnavailableError extends Error {
  constructor(message = 'Shared state store is unavailable') {
    super(message);
    this.name = 'SharedStateUnavailableError';
  }
}

export interface SharedStore {
  readonly kind: 'redis' | 'memory';
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  setNxPx(key: string, value: string, ttlMs: number): Promise<boolean>;
  compareAndDelete(key: string, value: string): Promise<boolean>;
  rateAttempt(key: string, now: number, windowMs: number, max: number, member: string): Promise<RateLimitVerdict>;
  rateRevoke(key: string, member?: string): Promise<void>;
  rateList(now: number, windowMs: number, limit: number): Promise<Array<{ key: string; count: number; limit: number; retryAfterMs: number }>>;
  rateClear(match: (key: string) => boolean): Promise<string[]>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  close(): Promise<void>;
}

type MemoryBucket = Map<string, number>;
const RATE_REGISTRY = 'isp:rate:registry';

function rateKeySet(key: string): string {
  return `isp:rate:${key}`;
}

function normalizeVerdict(raw: any, max: number): RateLimitVerdict {
  const vals = Array.isArray(raw) ? raw : [raw];
  const allowed = Number(vals[0]) === 1;
  const count = Number(vals[1]) || 0;
  const retryAfterMs = Math.max(0, Number(vals[2]) || 0);
  return { allowed, count, limit: max, retryAfterMs };
}

export class MemorySharedStore implements SharedStore {
  readonly kind: 'redis' | 'memory';

  constructor(kind: 'redis' | 'memory' = 'memory') {
    this.kind = kind;
  }
  private values = new Map<string, { value: string; expiresAt: number | null }>();
  private buckets = new Map<string, MemoryBucket>();
  private locks = new Map<string, { value: string; expiresAt: number }>();
  private listeners = new Map<string, Set<(message: string) => void>>();
  private seq = 0;

  private live(key: string): { value: string; expiresAt: number | null } | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.values.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) if (this.values.delete(key)) n++;
    return n;
  }

  async incr(key: string): Promise<number> {
    const next = Number(this.live(key)?.value || 0) + 1;
    this.values.set(key, { value: String(next), expiresAt: null });
    return next;
  }

  async setNxPx(key: string, value: string, ttlMs: number): Promise<boolean> {
    const current = this.locks.get(key);
    if (current && current.expiresAt > Date.now()) return false;
    const expiresAt = Date.now() + ttlMs;
    this.locks.set(key, { value, expiresAt });
    this.values.set(key, { value, expiresAt });
    return true;
  }

  async compareAndDelete(key: string, value: string): Promise<boolean> {
    const current = this.locks.get(key);
    if (!current || current.expiresAt <= Date.now() || current.value !== value) return false;
    this.locks.delete(key);
    this.values.delete(key);
    return true;
  }

  async rateAttempt(key: string, now: number, windowMs: number, max: number, member: string): Promise<RateLimitVerdict> {
    const bucket = this.buckets.get(key) ?? new Map<string, number>();
    for (const [m, at] of bucket) if (at <= now - windowMs) bucket.delete(m);
    if (bucket.size >= max) {
      const oldest = Math.min(...bucket.values());
      return { allowed: false, count: bucket.size, limit: max, retryAfterMs: Math.max(0, oldest + windowMs - now) };
    }
    bucket.set(member, now);
    this.buckets.set(key, bucket);
    return { allowed: true, count: bucket.size, limit: max, retryAfterMs: 0 };
  }

  async rateRevoke(key: string, member?: string): Promise<void> {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    if (member) bucket.delete(member);
    else {
      let latest: string | null = null;
      let latestAt = -Infinity;
      for (const [m, at] of bucket) if (at >= latestAt) { latest = m; latestAt = at; }
      if (latest) bucket.delete(latest);
    }
    if (bucket.size === 0) this.buckets.delete(key);
  }

  async rateList(now: number, windowMs: number, limit: number): Promise<Array<{ key: string; count: number; limit: number; retryAfterMs: number }>> {
    const out: Array<{ key: string; count: number; limit: number; retryAfterMs: number }> = [];
    for (const [key, bucket] of this.buckets) {
      for (const [m, at] of bucket) if (at <= now - windowMs) bucket.delete(m);
      if (bucket.size === 0) { this.buckets.delete(key); continue; }
      if (bucket.size < limit) continue;
      const oldest = Math.min(...bucket.values());
      out.push({ key, count: bucket.size, limit, retryAfterMs: Math.max(0, oldest + windowMs - now) });
    }
    return out;
  }

  async rateClear(match: (key: string) => boolean): Promise<string[]> {
    const cleared: string[] = [];
    for (const key of [...this.buckets.keys()]) {
      if (match(key)) { this.buckets.delete(key); cleared.push(key); }
    }
    return cleared;
  }

  async publish(channel: string, message: string): Promise<void> {
    for (const handler of this.listeners.get(channel) ?? []) handler(message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
    this.listeners.get(channel)!.add(handler);
  }

  async close(): Promise<void> {
    this.listeners.clear();
    this.buckets.clear();
    this.values.clear();
    this.locks.clear();
  }

  /** Test-only: a missing member id for local attempts. */
  nextMember(): string { return `mem-${++this.seq}`; }
}

const ATTEMPT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= max then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = 0
  if oldest[2] then retry = tonumber(oldest[2]) + window - now end
  if retry < 0 then retry = 0 end
  return {0, count, retry}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
redis.call('SADD', '${RATE_REGISTRY}', key)
return {1, count + 1, 0}
`;

const COMPARE_DELETE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

class RedisSharedStore implements SharedStore {
  readonly kind = 'redis' as const;
  private command: any;
  private subscriber: any;
  private connected = false;

  constructor(private readonly url: string) {
    this.command = createClient({ url });
    this.subscriber = this.command.duplicate();
    this.command.on('error', (err: any) => console.error('Redis command client error:', err?.message || err));
    this.subscriber.on('error', (err: any) => console.error('Redis subscriber error:', err?.message || err));
  }

  async connect(): Promise<void> {
    await Promise.all([this.command.connect(), this.subscriber.connect()]);
    await this.command.ping();
    this.connected = true;
  }

  private client(): any {
    if (!this.connected || !this.command?.isReady) throw new SharedStateUnavailableError();
    return this.command;
  }

  async get(key: string): Promise<string | null> {
    return this.client().get(key);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (ttlMs) await this.client().set(key, value, { PX: ttlMs });
    else await this.client().set(key, value);
  }

  async del(...keys: string[]): Promise<number> {
    if (!keys.length) return 0;
    return this.client().del(keys);
  }

  async incr(key: string): Promise<number> {
    return Number(await this.client().incr(key));
  }

  async setNxPx(key: string, value: string, ttlMs: number): Promise<boolean> {
    const result = await this.client().set(key, value, { NX: true, PX: ttlMs });
    return result === 'OK';
  }

  async compareAndDelete(key: string, value: string): Promise<boolean> {
    return Number(await this.client().eval(COMPARE_DELETE_SCRIPT, { keys: [key], arguments: [value] })) === 1;
  }

  async rateAttempt(key: string, now: number, windowMs: number, max: number, member: string): Promise<RateLimitVerdict> {
    const raw = await this.client().eval(ATTEMPT_SCRIPT, {
      keys: [rateKeySet(key)],
      arguments: [String(now), String(windowMs), String(max), member],
    });
    return normalizeVerdict(raw, max);
  }

  async rateRevoke(key: string, member?: string): Promise<void> {
    const bucketed = rateKeySet(key);
    if (member) {
      await this.client().zRem(bucketed, member);
      return;
    }
    try {
      await this.client().zPopMax(bucketed);
    } catch (err: any) {
      // ZPOPMAX arrived in Redis 5; older servers (the Windows 3.x port is one)
      // answer "unknown command". Popping the newest member is exactly
      // ZREVRANGE 0 0 followed by ZREM, so the revoke stays correct there
      // instead of failing on every attempt.
      if (!/unknown command/i.test(String(err?.message || err))) throw err;
      const newest = await this.client().zRange(bucketed, -1, -1);
      if (newest.length > 0) await this.client().zRem(bucketed, newest[0]);
    }
  }

  async rateList(now: number, windowMs: number, limit: number): Promise<Array<{ key: string; count: number; limit: number; retryAfterMs: number }>> {
    const keys: string[] = await this.client().sMembers(RATE_REGISTRY);
    const out: Array<{ key: string; count: number; limit: number; retryAfterMs: number }> = [];
    for (const fullKey of keys) {
      await this.client().zRemRangeByScore(fullKey, 0, now - windowMs);
      const count = Number(await this.client().zCard(fullKey));
      if (count === 0) {
        await this.client().del(fullKey);
        await this.client().sRem(RATE_REGISTRY, fullKey);
        continue;
      }
      if (count < limit) continue;
      const oldest = await this.client().zRangeWithScores(fullKey, 0, 0);
      const at = Number(oldest?.[0]?.score ?? now);
      out.push({
        key: fullKey.slice(rateKeySet('').length),
        count,
        limit,
        retryAfterMs: Math.max(0, at + windowMs - now),
      });
    }
    return out;
  }

  async rateClear(match: (key: string) => boolean): Promise<string[]> {
    const keys: string[] = await this.client().sMembers(RATE_REGISTRY);
    const cleared: string[] = [];
    for (const fullKey of keys) {
      const key = fullKey.slice(rateKeySet('').length);
      if (!match(key)) continue;
      await this.client().del(fullKey);
      await this.client().sRem(RATE_REGISTRY, fullKey);
      cleared.push(key);
    }
    return cleared;
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.client().publish(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    if (!this.connected) throw new SharedStateUnavailableError();
    await this.subscriber.subscribe(channel, (message: string) => handler(message));
  }

  async close(): Promise<void> {
    this.connected = false;
    await Promise.allSettled([this.subscriber?.quit(), this.command?.quit()]);
  }
}

let activeStore: SharedStore = new MemorySharedStore();
let configuredUrl: string | null = null;

export function getSharedStore(): SharedStore { return activeStore; }
export function isRedisSharedState(): boolean { return activeStore.kind === 'redis'; }
export function sharedStateMode(): 'redis' | 'memory' { return activeStore.kind; }

/** Test seam: replace the process store (used by the multi-worker tests). */
export function configureSharedStore(store: SharedStore): void {
  activeStore = store;
}

export async function initializeSharedState(env: NodeJS.ProcessEnv = process.env): Promise<SharedStore> {
  const url = env.REDIS_TLS_URL || env.REDIS_URL || '';
  if (!url) {
    activeStore = new MemorySharedStore();
    configuredUrl = null;
    return activeStore;
  }
  if (configuredUrl === url && activeStore.kind === 'redis') return activeStore;
  const store = new RedisSharedStore(url);
  try {
    await store.connect();
  } catch (err) {
    await store.close().catch(() => {});
    throw new SharedStateUnavailableError(
      `Redis is required but ${url.replace(/\/\/[^@]*@/, '//***@')} could not be reached: ${(err as Error)?.message || err}`
    );
  }
  activeStore = store;
  configuredUrl = url;
  console.log('✅ Shared state connected (Redis): rate limits, sessions, locks and SSE fan-out are worker-safe.');
  return store;
}

/**
 * A clustered production process without Redis would silently multiply every
 * security limit and diverge session revocation. Refuse to boot instead.
 */
export function assertSharedStateForWorkers(env: NodeJS.ProcessEnv = process.env): void {
  const clustered = env.NODE_APP_INSTANCE !== undefined || Number(env.WEB_CONCURRENCY || 0) > 1;
  const hasUrl = Boolean(env.REDIS_URL || env.REDIS_TLS_URL);
  if (clustered && !hasUrl) {
    throw new Error(
      'This process is running as one of several workers but REDIS_URL/REDIS_TLS_URL is not set. ' +
        'Auth rate limits, session revocation and SSE fan-out would be per-worker. Set REDIS_URL or run one worker.'
    );
  }
}

export async function closeSharedState(): Promise<void> {
  await activeStore.close().catch((err) => {
    console.error('Shared state close failed:', err?.message || err);
  });
}

export function newRateMember(): string {
  return `${process.pid}-${randomUUID()}`;
}
