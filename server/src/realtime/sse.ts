/**
 * SSE broadcast engine (SCALE-1: cross-worker fan-out).
 *
 * Each worker keeps only its own response handles. `broadcastChange` writes to
 * those handles immediately, then publishes the same event to Redis; every
 * worker's subscriber writes it to its own clients. A client connected to
 * worker B therefore sees a write handled by worker A. If Redis is absent the
 * process still serves local clients (single-worker development/tests).
 *
 * The per-client `dataVersion` contract is unchanged: the event carries the
 * version, the handshake carries the local current version, and a reconnect
 * resyncs from the client's last version.
 */
import type express from 'express';
import { randomUUID } from 'node:crypto';
import { resolveDomain } from '../syncDomains';
import { getSharedStore, isRedisSharedState, type SharedStore } from '../state/sharedStore';

export const SSE_CHANNEL = 'isp:sse:changes';
const INSTANCE_ID = randomUUID();

export interface SseEvent {
  type: string;
  entity?: string;
  branchId?: string;
  domain?: string;
  dataVersion?: number;
  timestamp?: string;
}

export interface SseHub {
  readonly clients: Set<express.Response>;
  deliver(payload: string): void;
}

export function createSseHub(): SseHub {
  const clients = new Set<express.Response>();
  return {
    clients,
    deliver(payload: string) {
      for (const client of clients) {
        try {
          client.write(`data: ${payload}\n\n`);
        } catch {
          clients.delete(client);
        }
      }
    },
  };
}

const defaultHub = createSseHub();
export const sseClients = defaultHub.clients;
/** Wall-clock seed so the handshake version stays comparable with the bootstrap's. */
let dataVersion = Date.now();

/**
 * H4 (audit 2026-11-28): the change version must be STRICTLY increasing.
 *
 * It used to be `Date.now()` on every broadcast, so two events in the same
 * millisecond carried the same number - and the client only refreshes when
 * `event.dataVersion > serverDataVersionRef.current`, so the second event was
 * silently dropped. `Math.max(now, previous + 1)` keeps the value on the
 * wall-clock scale the bootstrap version uses while guaranteeing a new number
 * per event.
 */
function advanceDataVersion(preferred: number = Date.now()): number {
  const candidate = Math.floor(preferred);
  dataVersion = Number.isFinite(candidate) ? Math.max(candidate, dataVersion + 1) : dataVersion + 1;
  return dataVersion;
}

export interface SseBus {
  broadcastChange(event: { type: string; entity?: string; branchId?: string }): void;
  startSubscriber(): Promise<void>;
}

/**
 * Builds an independent bus around a hub. The production module uses one
 * default hub; tests use two buses with the same memory store to prove that a
 * write on one reaches a client on the other.
 */
export function createSseBus(hub: SseHub, store: SharedStore = getSharedStore(), origin: string = INSTANCE_ID): SseBus {
  async function publishRemote(payload: string): Promise<void> {
    try {
      await store.publish(SSE_CHANNEL, JSON.stringify({ origin, payload: JSON.parse(payload) }));
    } catch (err: any) {
      console.error('SSE fan-out publish failed (local clients still served):', err?.message || err);
    }
  }

  return {
    broadcastChange(event) {
      dataVersion = advanceDataVersion();
      const domain = resolveDomain(event.type, event.entity);
      const payload = JSON.stringify({
        ...event,
        domain,
        dataVersion,
        timestamp: new Date().toISOString(),
      });
      hub.deliver(payload);
      if (store.kind === 'redis') void publishRemote(payload);
    },
    async startSubscriber() {
      if (store.kind !== 'redis') return;
      await store.subscribe(SSE_CHANNEL, (raw) => {
        try {
          const message = JSON.parse(raw);
          if (!message || message.origin === origin) return;
          dataVersion = advanceDataVersion(Number(message.payload?.dataVersion));
          hub.deliver(JSON.stringify(message.payload));
        } catch (err: any) {
          console.error('Ignoring malformed SSE fan-out message:', err?.message || err);
        }
      });
    },
  };
}

const defaultBus = createSseBus(defaultHub);

export function broadcastChange(event: { type: string; entity?: string; branchId?: string }): void {
  defaultBus.broadcastChange(event);
}

export function getDataVersion(): number {
  return dataVersion;
}

/** Boot-time subscriber; a Redis outage is logged and only local fan-out remains. */
export async function startSseSubscriber(): Promise<void> {
  if (!isRedisSharedState()) return;
  await defaultBus.startSubscriber();
  console.log('✅ SSE subscriber connected: writes fan out across workers.');
}

/** Shutdown hook: the shared store closes the subscriber before the pool closes. */
export async function stopSseSubscriber(): Promise<void> {
  // SharedStore.close() owns the Redis subscriber connection. This function is
  // kept explicit so lifecycle ordering is visible and future fan-out backends
  // have one shutdown point.
}
