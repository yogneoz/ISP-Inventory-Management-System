/**
 * Real-time SSE broadcast engine with optional Redis pub/sub fan-out
 * so multiple PM2/cluster workers share live events.
 */
import type express from 'express';
import Redis from 'ioredis';
import { logger } from './logger';

export let dataVersion = Date.now();
const sseClients = new Set<express.Response>();

const CHANNEL = process.env.SSE_REDIS_CHANNEL || 'izone:sse';

let pub: Redis | null = null;
let sub: Redis | null = null;
let redisSyncReady = false;

function resolveRedisUrl(): string | null {
  if (process.env.REDIS_URL?.trim()) return process.env.REDIS_URL.trim();
  const host = process.env.REDIS_HOST;
  if (!host) return null;
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD;
  const db = process.env.REDIS_DB || '0';
  if (password) return `redis://:${encodeURIComponent(password)}@${host}:${port}/${db}`;
  return `redis://${host}:${port}/${db}`;
}

function writeLocal(payload: string) {
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (_err) {
      sseClients.delete(client);
    }
  }
}

/**
 * Initialize Redis pub/sub for cross-process SSE. Safe no-op without Redis.
 */
export async function initSyncBus(): Promise<'redis' | 'local'> {
  if (process.env.NODE_ENV === 'test' || process.env.DISABLE_SSE_REDIS === 'true') {
    return 'local';
  }
  const url = resolveRedisUrl();
  if (!url) return 'local';

  try {
    pub = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 3000,
      retryStrategy: (t) => (t > 2 ? null : 200),
    });
    sub = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 3000,
      retryStrategy: (t) => (t > 2 ? null : 200),
    });
    pub.on('error', () => {});
    sub.on('error', () => {});
    await pub.connect();
    await sub.connect();
    await sub.subscribe(CHANNEL);
    sub.on('message', (channel, message) => {
      if (channel !== CHANNEL) return;
      try {
        const parsed = JSON.parse(message);
        if (parsed?.dataVersion) dataVersion = parsed.dataVersion;
        writeLocal(message);
      } catch (_e) {
        writeLocal(message);
      }
    });
    redisSyncReady = true;
    logger.info({ msg: 'sse_redis_ready', channel: CHANNEL });
    return 'redis';
  } catch (err: any) {
    logger.warn({ msg: 'sse_redis_unavailable', error: err?.message || String(err) });
    try {
      pub?.disconnect();
      sub?.disconnect();
    } catch (_e) {}
    pub = null;
    sub = null;
    redisSyncReady = false;
    return 'local';
  }
}

export function setDataVersion(v: number) {
  dataVersion = v;
}

export function bumpDataVersion() {
  dataVersion = Date.now();
  return dataVersion;
}

export function broadcastChange(event: { type: string; entity?: string; branchId?: string }) {
  dataVersion = Date.now();
  const payload = JSON.stringify({ ...event, dataVersion, timestamp: new Date().toISOString() });

  // Always deliver to local SSE clients
  writeLocal(payload);

  // Fan-out to other workers when Redis pub/sub is up
  if (redisSyncReady && pub) {
    pub.publish(CHANNEL, payload).catch((err) => {
      logger.warn({ msg: 'sse_publish_failed', error: err?.message || String(err) });
    });
  }
}

export function addSseClient(res: express.Response) {
  sseClients.add(res);
}

export function removeSseClient(res: express.Response) {
  sseClients.delete(res);
}

export function forEachSseClient(fn: (client: express.Response) => void) {
  for (const client of sseClients) {
    try {
      fn(client);
    } catch (_e) {
      sseClients.delete(client);
    }
  }
}

export function getSseClientCount() {
  return sseClients.size;
}

export function isSseRedisEnabled() {
  return redisSyncReady;
}
