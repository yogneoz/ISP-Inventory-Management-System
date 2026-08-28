/**
 * IZone Enterprise ERP — application entrypoint.
 * Domain state, auth, DB, and HTTP routes live under ./server/
 */
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { initializeStore } from './server/store';
import { createApp } from './server/createApp';
import { syncDatabaseAndIndexes } from './server/lib/dbBootstrap';
import { initSessionStore } from './server/lib/sessionStore';
import { initSyncBus } from './server/lib/sync';
import { runMigrations } from './server/lib/migrations';
import { logger } from './server/lib/logger';
import {
  getDbMode,
  isPostgresRequired,
  isDurableSqlBackend,
} from './server/lib/db';

dotenv.config();

const app = createApp();
const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  const requirePg = isPostgresRequired();
  logger.info({
    msg: 'server_boot',
    nodeEnv: process.env.NODE_ENV || 'development',
    requirePostgres: requirePg,
    allowDbFallback: process.env.ALLOW_DB_FALLBACK === 'true',
  });

  await initializeStore();
  await initSessionStore();

  // DB connect + schema — throws if REQUIRE_POSTGRES / production and PG is down
  await syncDatabaseAndIndexes();

  if (requirePg && !isDurableSqlBackend()) {
    throw new Error(
      `Startup aborted: PostgreSQL is required but database mode is "${getDbMode()}".`
    );
  }

  try {
    const migrationResult = await runMigrations();
    logger.info({ msg: 'migrations_result', ...migrationResult });
  } catch (err: any) {
    logger.error({ msg: 'startup_migrations_failed', error: err?.message || String(err) });
    // In production / require-postgres, migration failure is fatal
    if (requirePg || process.env.REQUIRE_MIGRATIONS === 'true') {
      throw err;
    }
  }

  await initSyncBus();

  logger.info({
    msg: 'backend_ready',
    databaseMode: getDbMode(),
    durable: isDurableSqlBackend(),
  });

  // IMPORTANT: register Vite/static AFTER API routes so /api is never swallowed
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        host: '0.0.0.0',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    logger.info({ msg: 'server_listen', port: PORT, url: `http://localhost:${PORT}` });
    console.log(`IZone Inventory System server running on http://localhost:${PORT}`);
    console.log(
      `Database: mode=${getDbMode()} durable=${isDurableSqlBackend()} requirePostgres=${requirePg}`
    );
  });
}

startServer().catch((err) => {
  logger.error({ msg: 'server_start_failed', error: err?.message || String(err) });
  console.error('Failed to start server:', err?.message || err);
  process.exit(1);
});
