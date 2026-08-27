/**
 * Session store with Redis primary backend and in-memory fallback.
 *
 * When REDIS_URL (or REDIS_HOST) is reachable, sessions are shared across
 * PM2/cluster workers and survive process restarts. Otherwise the process
 * keeps a local Map so single-node demos keep working offline.
 */
import crypto from 'crypto';
import Redis from 'ioredis';

export interface SessionRecord {
  token: string;
  userId: string;
  email: string;
  name: string;
  role: string;
  branchId?: string;
  allowedBranchIds?: string[];
  canSwitchUser?: boolean;
  createdAt: number;
  expiresAt: number;
  rootUserId?: string;
}

export const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const SESSION_TTL_SEC = Math.floor(SESSION_TTL_MS / 1000);
const KEY_PREFIX = 'izone:sess:';
const USER_IDX_PREFIX = 'izone:sessuser:';

type SessionBackend = 'redis' | 'memory';

let backend: SessionBackend = 'memory';
let redis: Redis | null = null;
let initPromise: Promise<void> | null = null;

/** Process-local fallback used when Redis is offline. */
const memorySessions = new Map<string, SessionRecord>();
/** userId -> set of tokens (memory mode only; Redis uses a SET index). */
const memoryUserIndex = new Map<string, Set<string>>();

function sessionKey(token: string) {
  return `${KEY_PREFIX}${token}`;
}

function userIndexKey(userId: string) {
  return `${USER_IDX_PREFIX}${userId}`;
}

function pruneMemory() {
  const now = Date.now();
  for (const [token, session] of memorySessions.entries()) {
    if (session.expiresAt <= now) {
      memorySessions.delete(token);
      removeFromMemoryUserIndex(session.userId, token);
      if (session.rootUserId && session.rootUserId !== session.userId) {
        removeFromMemoryUserIndex(session.rootUserId, token);
      }
    }
  }
}

function addToMemoryUserIndex(userId: string | undefined, token: string) {
  if (!userId) return;
  let set = memoryUserIndex.get(userId);
  if (!set) {
    set = new Set();
    memoryUserIndex.set(userId, set);
  }
  set.add(token);
}

function removeFromMemoryUserIndex(userId: string | undefined, token: string) {
  if (!userId) return;
  const set = memoryUserIndex.get(userId);
  if (!set) return;
  set.delete(token);
  if (set.size === 0) memoryUserIndex.delete(userId);
}

function resolveRedisUrl(): string | null {
  if (process.env.REDIS_URL && process.env.REDIS_URL.trim()) {
    return process.env.REDIS_URL.trim();
  }
  const host = process.env.REDIS_HOST;
  if (!host) return null;
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD;
  const db = process.env.REDIS_DB || '0';
  if (password) {
    return `redis://:${encodeURIComponent(password)}@${host}:${port}/${db}`;
  }
  return `redis://${host}:${port}/${db}`;
}

/**
 * Connect to Redis if configured. Safe to call multiple times.
 * Never throws — falls back to memory on any failure.
 */
export async function initSessionStore(): Promise<SessionBackend> {
  if (initPromise) {
    await initPromise;
    return backend;
  }

  initPromise = (async () => {
    const url = resolveRedisUrl();
    if (!url) {
      backend = 'memory';
      console.log('ℹ️  Session store: in-memory (set REDIS_URL to enable shared Redis sessions).');
      return;
    }

    try {
      const client = new Redis(url, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        enableOfflineQueue: false,
        connectTimeout: 3000,
        lazyConnect: true,
        // Stop retrying quickly when Redis is down (demo / first-boot)
        retryStrategy: (times) => {
          if (times > 2) return null;
          return Math.min(times * 150, 500);
        },
      });

      client.on('error', (err) => {
        if (backend === 'redis') {
          console.warn('Redis session store warning:', err?.message || err);
        }
      });

      await client.connect();
      const pong = await Promise.race([
        client.ping(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Redis PING timeout')), 3000)
        ),
      ]);
      if (pong !== 'PONG') {
        throw new Error(`Unexpected Redis PING response: ${String(pong)}`);
      }

      redis = client;
      backend = 'redis';
      console.log('✅ Session store: Redis connected (shared multi-instance sessions enabled).');
    } catch (err: any) {
      backend = 'memory';
      try {
        // Best-effort cleanup of a half-open client
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        redis?.quit().catch(() => {});
      } catch (_e) {}
      redis = null;
      console.warn(
        '⚠️  Redis unavailable — using in-memory sessions.',
        err?.message || err
      );
    }
  })();

  await initPromise;
  return backend;
}

export function getSessionBackend(): SessionBackend {
  return backend;
}

export function isRedisSessionsEnabled(): boolean {
  return backend === 'redis' && !!redis;
}

function buildRecord(
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    branchId?: string;
    allowedBranchIds?: string[];
    canSwitchUser?: boolean;
  },
  rootUserId?: string
): SessionRecord {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  return {
    token,
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    branchId: user.branchId,
    allowedBranchIds: user.allowedBranchIds,
    canSwitchUser: user.canSwitchUser,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    rootUserId: rootUserId || user.id,
  };
}

async function persistRedis(record: SessionRecord): Promise<void> {
  if (!redis) throw new Error('Redis not connected');
  const pipeline = redis.pipeline();
  pipeline.set(sessionKey(record.token), JSON.stringify(record), 'EX', SESSION_TTL_SEC);
  pipeline.sadd(userIndexKey(record.userId), record.token);
  pipeline.expire(userIndexKey(record.userId), SESSION_TTL_SEC);
  if (record.rootUserId && record.rootUserId !== record.userId) {
    pipeline.sadd(userIndexKey(record.rootUserId), record.token);
    pipeline.expire(userIndexKey(record.rootUserId), SESSION_TTL_SEC);
  }
  await pipeline.exec();
}

function persistMemory(record: SessionRecord): void {
  pruneMemory();
  memorySessions.set(record.token, record);
  addToMemoryUserIndex(record.userId, record.token);
  if (record.rootUserId && record.rootUserId !== record.userId) {
    addToMemoryUserIndex(record.rootUserId, record.token);
  }
}

export async function createSession(
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    branchId?: string;
    allowedBranchIds?: string[];
    canSwitchUser?: boolean;
  },
  rootUserId?: string
): Promise<SessionRecord> {
  const record = buildRecord(user, rootUserId);

  if (backend === 'redis' && redis) {
    try {
      await persistRedis(record);
      return record;
    } catch (err: any) {
      console.warn('Redis createSession failed, falling back to memory:', err?.message || err);
      backend = 'memory';
    }
  }

  persistMemory(record);
  return record;
}

export async function getSession(token: string | undefined | null): Promise<SessionRecord | null> {
  if (!token) return null;

  if (backend === 'redis' && redis) {
    try {
      const raw = await redis.get(sessionKey(token));
      if (!raw) return null;
      const session = JSON.parse(raw) as SessionRecord;
      if (!session || session.expiresAt <= Date.now()) {
        await redis.del(sessionKey(token)).catch(() => {});
        return null;
      }
      // Sliding expiry
      session.expiresAt = Date.now() + SESSION_TTL_MS;
      await redis.set(sessionKey(token), JSON.stringify(session), 'EX', SESSION_TTL_SEC);
      return session;
    } catch (err: any) {
      console.warn('Redis getSession failed, trying memory:', err?.message || err);
    }
  }

  pruneMemory();
  const session = memorySessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    memorySessions.delete(token);
    removeFromMemoryUserIndex(session.userId, token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

export async function destroySession(token: string | undefined | null): Promise<void> {
  if (!token) return;

  if (backend === 'redis' && redis) {
    try {
      const raw = await redis.get(sessionKey(token));
      if (raw) {
        const session = JSON.parse(raw) as SessionRecord;
        const pipeline = redis.pipeline();
        pipeline.del(sessionKey(token));
        if (session?.userId) pipeline.srem(userIndexKey(session.userId), token);
        if (session?.rootUserId) pipeline.srem(userIndexKey(session.rootUserId), token);
        await pipeline.exec();
      } else {
        await redis.del(sessionKey(token));
      }
      return;
    } catch (err: any) {
      console.warn('Redis destroySession failed:', err?.message || err);
    }
  }

  const existing = memorySessions.get(token);
  memorySessions.delete(token);
  if (existing) {
    removeFromMemoryUserIndex(existing.userId, token);
    if (existing.rootUserId) removeFromMemoryUserIndex(existing.rootUserId, token);
  }
}

export async function destroyUserSessions(userId: string): Promise<void> {
  if (!userId) return;

  if (backend === 'redis' && redis) {
    try {
      const tokens = await redis.smembers(userIndexKey(userId));
      if (tokens.length > 0) {
        const pipeline = redis.pipeline();
        for (const token of tokens) {
          pipeline.del(sessionKey(token));
        }
        pipeline.del(userIndexKey(userId));
        await pipeline.exec();
      }
      return;
    } catch (err: any) {
      console.warn('Redis destroyUserSessions failed:', err?.message || err);
    }
  }

  pruneMemory();
  const tokens = memoryUserIndex.get(userId);
  if (!tokens) return;
  for (const token of [...tokens]) {
    const session = memorySessions.get(token);
    memorySessions.delete(token);
    if (session) {
      removeFromMemoryUserIndex(session.userId, token);
      if (session.rootUserId) removeFromMemoryUserIndex(session.rootUserId, token);
    }
  }
  memoryUserIndex.delete(userId);
}

/** Best-effort stats for health/diagnostics. */
export async function getSessionStoreStats(): Promise<{
  backend: SessionBackend;
  memoryCount: number;
  redisPing?: string;
}> {
  const stats: { backend: SessionBackend; memoryCount: number; redisPing?: string } = {
    backend,
    memoryCount: memorySessions.size,
  };
  if (backend === 'redis' && redis) {
    try {
      stats.redisPing = await redis.ping();
    } catch {
      stats.redisPing = 'error';
    }
  }
  return stats;
}
