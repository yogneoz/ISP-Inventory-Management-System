/**
 * Express application factory (no listen / no Vite).
 * Used by the production entrypoint and by API tests.
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { authenticateUser } from './lib/auth';
import { registerRoutes } from './routes';
import { getSessionStoreStats } from './lib/sessionStore';
import { getDbHealth } from './lib/db';
import { isSseRedisEnabled, getSseClientCount } from './lib/sync';
import { requestContext } from './middleware/requestContext';
import { apiRateLimiter, loginRateLimiter } from './middleware/rateLimit';
import { logger } from './lib/logger';

export function createApp(): Express {
  const app = express();

  // Behind Nginx / load balancers
  if (process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  app.use(requestContext);
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '25mb' }));

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
      sync: {
        sseClients: getSseClientCount(),
        redisPubSub: isSseRedisEnabled(),
      },
    });
  });

  app.get('/__aistudio_internal_control_plane/dev/status', (_req, res) => {
    res.json({ status: 'ok', dev: true });
  });

  app.get('/__aistudio_internal_control_plane/*', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Auth endpoints: brute-force protection
  app.use('/api/auth/login', loginRateLimiter);
  app.use('/api/auth/setup-superadmin', loginRateLimiter);
  app.use('/api/auth/forgot-password', loginRateLimiter);

  // General API throttle
  app.use('/api', apiRateLimiter);

  // Authenticate API traffic (public paths are allow-listed inside middleware).
  app.use(authenticateUser);

  registerRoutes(app);

  // Central error handler
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (req as any).requestId;
    logger.error({
      msg: 'unhandled_error',
      requestId,
      error: err?.message || String(err),
      stack: process.env.NODE_ENV === 'production' ? undefined : err?.stack,
    });
    if (res.headersSent) return;
    res.status(err?.statusCode || 500).json({
      message: err?.message || 'Internal server error',
      code: err?.code || 'INTERNAL_ERROR',
      requestId,
    });
  });

  return app;
}
