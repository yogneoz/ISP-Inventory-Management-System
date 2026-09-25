/**
 * SSE broadcast engine extracted from app.ts (backlog item #6 — app.ts
 * extraction). Holds the live client set and the change broadcaster.
 *
 * Connection handles are the ONLY state here — by design, and the single
 * permitted piece of in-memory realtime state. Multi-instance fan-out
 * (Redis pub/sub) plugs in by replacing the write loop inside
 * broadcastChange; the import surface below stays identical.
 */
import type express from 'express';
import { resolveDomain } from '../syncDomains';

export const sseClients = new Set<express.Response>();
let dataVersion = Date.now();

export function broadcastChange(event: { type: string; entity?: string; branchId?: string }) {
  dataVersion = Date.now();
  const domain = resolveDomain(event.type, event.entity);
  const payload = JSON.stringify({ ...event, domain, dataVersion, timestamp: new Date().toISOString() });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (_err) {
      sseClients.delete(client);
    }
  }
}
