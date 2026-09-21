/**
 * Sync routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerSyncRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import {
  getDataVersion,
  sseClients,
} from '../app';

export function registerSyncRoutes(app: Express) {
app.get('/api/sync/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseClients.add(res);

  // Send initial handshake with current server state version
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', dataVersion: getDataVersion(), timestamp: new Date().toISOString() })}\n\n`);

  const keepAliveTimer = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_e) {
      clearInterval(keepAliveTimer);
      sseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAliveTimer);
    sseClients.delete(res);
  });
});

app.get('/api/sync/version', (req, res) => {
  res.json({ dataVersion: getDataVersion(), timestamp: new Date().toISOString() });
});

}
