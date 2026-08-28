/**
 * Route module: sync
 */
import { Router } from 'express';
import * as store from '../store';

import { dataVersion, addSseClient, removeSseClient } from '../lib/sync';

const router = Router();

router.get('/api/sync/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  addSseClient(res);

  // Send initial handshake with current server state version
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', dataVersion, timestamp: new Date().toISOString() })}\n\n`);

  const keepAliveTimer = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_e) {
      clearInterval(keepAliveTimer);
      removeSseClient(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAliveTimer);
    removeSseClient(res);
  });
});

router.get('/api/sync/version', (req, res) => {
  res.json({ dataVersion, timestamp: new Date().toISOString() });
});

export default router;
