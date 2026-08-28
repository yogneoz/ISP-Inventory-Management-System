/**
 * Express application factory (no listen / no Vite).
 * Used by the production entrypoint and by API tests.
 */
import express, { type Express } from 'express';
import { authenticateUser } from './lib/auth';
import { registerRoutes } from './routes';
import { getSessionStoreStats } from './lib/sessionStore';
import { getDbHealth } from './lib/db';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // Health & control-plane endpoints BEFORE auth middleware
  app.get('/api/health', async (_req, res) => {
    const [sessions, database] = await Promise.all([
      getSessionStoreStats(),
      getDbHealth(),
    ]);
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      sessions: {
        backend: sessions.backend,
        memoryCount: sessions.memoryCount,
        redis: sessions.redisPing || null,
      },
      database: {
        mode: database.mode,
        durable: database.durable,
        ping: database.ping || null,
      },
    });
  });

  app.get('/__aistudio_internal_control_plane/dev/status', (_req, res) => {
    res.json({ status: 'ok', dev: true });
  });

  app.get('/__aistudio_internal_control_plane/*', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Authenticate API traffic (public paths are allow-listed inside middleware).
  app.use(authenticateUser);

  registerRoutes(app);

  return app;
}
