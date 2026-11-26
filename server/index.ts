import path from 'path';
import express from 'express';
import type { Server } from 'http';
import { createServer as createViteServer } from 'vite';
import { PORT, syncDatabaseAndIndexes, createApp, registerAllRoutes } from './src/app';
import { realPoolInstance, warmDatabasePool } from './db';
import { createLifecycle } from './src/boot/lifecycle';
import { validateAuthSecret } from './src/boot/authSecret';
import { resolveSetupToken } from './src/boot/setupToken';
import { initializeSharedState, assertSharedStateForWorkers, closeSharedState } from './src/state/sharedStore';
import { withStartupLeadership } from './src/state/sharedLock';
import { startSseSubscriber, stopSseSubscriber } from './src/realtime/sse';
import { startReferenceCacheInvalidation } from './src/state/cacheInvalidation';

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
  // SSE clients are ended first inside lifecycle.shutdown; the subscriber then
  // stops before the PostgreSQL pool closes (SCALE-1 shutdown order).
  closeShared: async () => {
    await stopSseSubscriber();
    await closeSharedState();
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

// Production must not run on the ephemeral secret middleware/auth.ts falls back
// to: that would silently invalidate every session on each restart and make a
// second instance unable to verify the first's tokens. Checked before the
// database connects or the port opens, through the same fatal path as any other
// failed boot (D1/D2).
const authSecretCheck = validateAuthSecret({
  NODE_ENV: process.env.NODE_ENV,
  AUTH_TOKEN_SECRET: process.env.AUTH_TOKEN_SECRET,
});
if (!authSecretCheck.ok) failBoot(new Error(authSecretCheck.message));

// First-launch gate (audit finding C1). The setup endpoint has to be reachable
// before anyone can sign in, so the proof that a caller is not anonymous is a
// one-time token only someone with server access can read: SETUP_TOKEN when the
// deployment sets one, otherwise a value generated and printed here. It is
// consumed by the first successful claim and never re-armed.
const setupTokenCheck = (() => {
  try {
    return resolveSetupToken({ SETUP_TOKEN: process.env.SETUP_TOKEN });
  } catch (err) {
    return failBoot(err);
  }
})();
if (setupTokenCheck.source === 'generated') {
  console.log('');
  console.log('=================================================================');
  console.log(' Super Admin setup token (first launch only)');
  console.log(`   ${setupTokenCheck.token}`);
  console.log(' Enter it on the first-launch screen. It is consumed as soon as');
  console.log(' the Super Admin account is created; set SETUP_TOKEN in .env to');
  console.log(' choose it yourself instead.');
  console.log('=================================================================');
  console.log('');
}

async function startServer() {
  // Shared state is a boot precondition in a clustered production process: a
  // missing Redis would silently give every worker its own security limits.
  assertSharedStateForWorkers(process.env);
  await initializeSharedState(process.env);

  const app = createApp();

  // Register every domain router (plus the terminal error handler) BEFORE the
  // listener accepts requests — the original module-level registration ran
  // synchronously at startup, which is the same effective order.
  registerAllRoutes(app);

  // Only the elected worker runs schema migration/seed; every other worker
  // waits for the lock and then serves against the same database.
  const startup = await withStartupLeadership('boot:schema-and-seed', () => syncDatabaseAndIndexes());
  if (!startup.leader) console.log('Boot schema/seed already completed by another worker; skipping the duplicate job.');
  try {
    await startSseSubscriber();
    // A3: a master-data write on one worker must refresh the reference caches on
    // every other worker. Single-worker installs skip it (nothing to tell).
    await startReferenceCacheInvalidation();
  } catch (err: any) {
    // SSE fan-out is a read-side convenience, not a security control: keep
    // serving local clients and alert if the subscriber cannot attach.
    console.error('SSE subscriber failed to start (local fan-out only):', err?.message || err);
  }

  // SCALE-3: move connection setup out of the first concurrent burst. Behind a
  // transaction-mode pooler the client connections are cheap, so a boot can
  // afford to hold the whole pool open.
  // `PG_WARM_POOL=0` boots a deliberately cold pool. The benchmark's `before`
  // arm needs that: it reproduces the pre-change behaviour (first burst pays
  // connection setup) so both columns of the report come from the same harness.
  try {
    const warmed = process.env.PG_WARM_POOL === '0' ? 0 : await warmDatabasePool();
    if (warmed > 0) console.log(`Database pool warmed: ${warmed} connection(s) ready.`);
    else console.log('Database pool warm-up skipped (PG_WARM_POOL=0): cold-pool measurement arm.');
  } catch (err: any) {
    console.error('Database pool warm-up failed (the pool will connect on demand):', err?.message || err);
  }

  const server: Server = app.listen(PORT, '0.0.0.0', () => {
    // Report the port the socket is actually bound to, not the configured
    // constant: if those ever disagree (a stray PORT=0, a platform rewrite) the
    // log has to say where the server really is.
    const bound = server.address();
    const boundPort = bound && typeof bound === 'object' ? bound.port : PORT;
    console.log(`Inventory Management System server running on http://localhost:${boundPort}`);
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
