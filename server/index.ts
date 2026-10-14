import path from 'path';
import express from 'express';
import type { Server } from 'http';
import { createServer as createViteServer } from 'vite';
import { PORT, syncDatabaseAndIndexes, createApp, registerAllRoutes } from './src/app';
import { realPoolInstance } from './db';
import { createLifecycle } from './src/boot/lifecycle';

/**
 * Every terminal exit of this process goes through ONE lifecycle:
 *
 *   - a failed boot exits 1 (see failBoot below for why `process.exitCode` was
 *     not enough: the pg Pool keeps handles open, the event loop never drains,
 *     and pm2/Docker keep calling the corpse healthy);
 *   - an uncaught exception / unhandled rejection exits 1 with the reason
 *     written synchronously, in production (development logs and keeps
 *     serving — `tsx watch` does not restart a crashed child);
 *   - SIGTERM/SIGINT stop accepting, drain in-flight requests, close the pool
 *     and exit 0 instead of cutting responses mid-flight.
 *
 * The mechanics live in src/boot/lifecycle.ts so they are testable without a
 * database or a real process exit; this file only wires them up.
 */
const lifecycle = createLifecycle({
  closePool: async () => {
    await realPoolInstance?.end();
  },
});

/**
 * A boot that failed means there is NO server, so the process must exit — and
 * exit non-zero.
 *
 * Setting `process.exitCode = 1` alone was not enough: the pg Pool built at
 * import time holds open sockets/handles, so the event loop never drained and
 * the process simply stayed alive with a pending exit code. pm2 reported that
 * instance as "online" and `docker run --restart always` kept the container
 * "Up" while every request failed — a corpse that looked healthy to both
 * supervisors, so neither ever restarted it. Exiting 1 turns the same failure
 * into a visible crash-loop (pm2 restart, Docker restart) that also surfaces
 * in `pm2 status` / `docker ps` instead of hiding until someone reads logs.
 */
function failBoot(err: unknown): never {
  return lifecycle.fatal('server failed to start', err);
}

// Registered before the boot starts, so a signal that arrives while
// syncDatabaseAndIndexes() is still running is not a silent hard kill.
lifecycle.install();

async function startServer() {
  const app = createApp();

  // Register every domain router (plus the terminal error handler) BEFORE the
  // listener accepts requests — the original module-level registration ran
  // synchronously at startup, which is the same effective order.
  registerAllRoutes(app);

  await syncDatabaseAndIndexes();

  const server: Server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Inventory Management System server running on http://localhost:${PORT}`);
  });
  // From here on the process has something to drain. Attaching now (not at
  // shutdown) is what lets the drain distinguish a request that was already in
  // flight when the signal arrived from an idle keep-alive socket.
  lifecycle.attachServer(server);
  // A listen failure (EADDRINUSE from a half-dead previous instance, EACCES on
  // a privileged port in a non-root container) is a boot failure too: report it
  // through the same path instead of as a bare uncaught 'error' event.
  server.on('error', failBoot);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
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
}

startServer().catch(failBoot);
