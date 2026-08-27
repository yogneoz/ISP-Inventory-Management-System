/**
 * Real-time SSE broadcast engine.
 */
import type express from 'express';

export let dataVersion = Date.now();
const sseClients = new Set<express.Response>();

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
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (_err) {
      sseClients.delete(client);
    }
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
