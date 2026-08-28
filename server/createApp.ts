/**
 * Express application factory (no listen / no Vite).
 * Used by the production entrypoint and by API tests.
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { authenticateUser } from './lib/auth';
import { registerRoutes } from './routes';
import { getSessionStoreStats } from './lib/sessionStore';
import { getDbHealth, isPostgresRequired, pingPostgres } from './lib/db';
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

  /**
   * Liveness: process is up (always 200 if we can answer).
   * Use for orchestrator "is the process alive?" checks.
   */
  app.get('/api/health/live', (_req, res) => {
    res.status(200).json({ status: 'live', timestamp: new Date().toISOString() });
  });

  /**
   * Readiness: dependencies required for serving traffic.
   * Returns 503 when Postgres is required but not durable/ready.
   */
  app.get('/api/health/ready', async (_req, res) => {
    const database = await getDbHealth();
    const required = isPostgresRequired();
    let pgPingOk = database.mode === 'postgres' ? await pingPostgres() : !required;

    const ready = required ? database.durable && pgPingOk : true;
    const body = {
      status: ready ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      requirePostgres: required,
      database: {
        mode: database.mode,
        durable: database.durable,
        ready: database.ready && pgPingOk,
        ping: database.ping || null,
      },
    };

    res.status(ready ? 200 : 503).json(body);
  });

  /**
   * Full health snapshot (auth not required).
   * In production fail-closed mode, returns 503 if DB is not durable so load balancers can drain.
   */
  app.get('/api/health', async (_req, res) => {
    const [sessions, database] = await Promise.all([getSessionStoreStats(), getDbHealth()]);
    const required = isPostgresRequired();
    const ready = required ? database.durable && database.ready : true;

    const body = {
      status: ready ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      requirePostgres: required,
      ready,
      sessions: {
        backend: sessions.backend,
        memoryCount: sessions.memoryCount,
        redis: sessions.redisPing || null,
      },
      database: {
        mode: database.mode,
        durable: database.durable,
        required: database.required,
        ready: database.ready,
        ping: database.ping || null,
      },
      sync: {
        sseClients: getSseClientCount(),
        redisPubSub: isSseRedisEnabled(),
      },
    };

    res.status(ready ? 200 : 503).json(body);
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
