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

dotenv.config();

const app = createApp();
const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  await initializeStore();
  await initSessionStore();
  await syncDatabaseAndIndexes();
  try {
    await runMigrations();
  } catch (err: any) {
    logger.error({ msg: 'startup_migrations_failed', error: err?.message || String(err) });
    if (process.env.REQUIRE_MIGRATIONS === 'true') {
      throw err;
    }
  }
  await initSyncBus();

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
  });
}

startServer().catch((err) => {
  logger.error({ msg: 'server_start_failed', error: err?.message || String(err) });
  console.error('Failed to start server:', err);
  process.exit(1);
});
