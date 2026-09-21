/**
 * Sync controller — HTTP orchestration for the sync domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { sseClients, getDataVersion } from '../app';
/** Forwarded from sync.routes.ts (get_stream). */
export async function get_stream(req: any, res: Response): Promise<any> {
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

}

/** Forwarded from sync.routes.ts (get_version). */
export async function get_version(req: any, res: Response): Promise<any> {
res.json({ dataVersion: getDataVersion(), timestamp: new Date().toISOString() });

}

