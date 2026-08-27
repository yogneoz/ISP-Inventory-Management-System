/**
 * IZone Enterprise ERP — application entrypoint.
 * Domain state, auth, DB, and HTTP routes live under ./server/
 */
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { initializeStore } from './server/store';
import { authenticateUser } from './server/lib/auth';
import { registerRoutes } from './server/routes';
import { syncDatabaseAndIndexes } from './server/lib/dbBootstrap';
import { initSessionStore, getSessionStoreStats } from './server/lib/sessionStore';
import { getDbHealth } from './server/lib/db';

dotenv.config();

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
// Mounted at '/' so req.path stays as full '/api/...' matching route modules.
app.use(authenticateUser);

const PORT = Number(process.env.PORT) || 3000;

registerRoutes(app);

async function startServer() {
  await initializeStore();
  await initSessionStore();
  await syncDatabaseAndIndexes();

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
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`IZone Inventory System server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
