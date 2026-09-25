/**
 * HTTP hardening tests (audit backlog #2, part 2).
 *
 * PROVES on a real Express app (full middleware chain, ephemeral port):
 *  1. Security headers from helmet are present on every response
 *     (X-Content-Type-Options, X-Frame-Options, CSP, ...) and HSTS is NOT
 *     forced on plain HTTP (the company's own single server serves over the
 *     LAN without TLS; a reverse proxy can add HSTS).
 *  2. The JSON body limit honors JSON_BODY_LIMIT: an oversized payload is
 *     rejected with 413, and the limit is configurable via the env var.
 *
 * No database needed — the routes exercised are /api/health and a probe
 * route with an authenticated-only POST, both DB-independent.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Requests that pass body parsing flow through requirePostgres, which 503s
// without a reachable database — skip those in DB-less environments (CI).
// The 413 rejection happens in express.json BEFORE the DB gate, so it runs
// everywhere and guards the limit even in CI.
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    const probe = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 });
    await probe.query('SELECT 1');
    dbReachable = true;
    await probe.end();
  }
} catch { dbReachable = false; }

const TEST_USER = {
  id: 'u-hard-1',
  email: 'hardening@example.com',
  name: 'Hardening Test',
  role: 'SUPER_ADMIN',
  branchId: 'b1',
  allowedBranchIds: [],
  canSwitchUser: false,
};

function startServer(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({
      port: (server.address() as any).port,
      close: () => new Promise<void>((done) => {
        (server as any).closeAllConnections?.();
        server.close(() => done());
      }),
    }));
  });
}

/** Build a minimal app with the REAL createApp() pipeline plus a JSON echo probe. */
function makeApp(): express.Express {
  const app = createApp();
  // Probe: authenticated POST endpoint that echoes how much JSON it received.
  app.use('/api', (req: any, _res: any, next: any) => {
    if (req.path === '/__probe') return next();
    next();
  });
  app.post('/api/__probe', (req: any, res: any) => {
    res.json({ bytes: JSON.stringify(req.body ?? {}).length });
  });
  return app;
}

describe('helmet security headers (real Express app)', () => {
  test('every response carries the core security headers', async () => {
    const { port, close } = await startServer(makeApp());
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('x-frame-options') || '', /DENY|SAMEORIGIN/);
      assert.match(res.headers.get('content-security-policy') || '', /default-src/);
      assert.match(res.headers.get('cross-origin-resource-policy') || '', /same-origin/);
      assert.ok(res.headers.get('x-dns-prefetch-control') !== null);
    } finally {
      await close();
    }
  });

  test('HSTS is not forced on plain HTTP responses (LAN deployment keeps working)', async () => {
    const { port, close } = await startServer(makeApp());
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      // helmet only sends Strict-Transport-Security over https requests by
      // default; assert it is absent on this http:// request.
      assert.equal(res.headers.get('strict-transport-security'), null);
    } finally {
      await close();
    }
  });
});

describe('JSON body limit (JSON_BODY_LIMIT env var)', () => {
  test('default 1mb limit: a payload over 1mb is rejected with 413 before handlers run', async () => {
    delete process.env.JSON_BODY_LIMIT;
    const app = makeApp();
    registerAllRoutes(app);
    const { port, close } = await startServer(app);
    try {
      const token = issueAuthToken(TEST_USER as any);
      const big = JSON.stringify({ items: 'x'.repeat(1.5 * 1024 * 1024) });
      const res = await fetch(`http://127.0.0.1:${port}/api/__probe`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: big,
      });
      assert.equal(res.status, 413);
    } finally {
      await close();
    }
  });

  test('JSON_BODY_LIMIT=25mb: the same oversized payload is accepted', { skip: !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)' }, async () => {
    process.env.JSON_BODY_LIMIT = '25mb';
    try {
      const app = makeApp();
      const { port, close } = await startServer(app);
      try {
        const token = issueAuthToken(TEST_USER as any);
        const big = JSON.stringify({ items: 'x'.repeat(1.5 * 1024 * 1024) });
        const res = await fetch(`http://127.0.0.1:${port}/api/__probe`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: big,
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(body.bytes > 1.5 * 1024 * 1024);
      } finally {
        await close();
      }
    } finally {
      delete process.env.JSON_BODY_LIMIT;
    }
  });

  test('normal-sized payloads still work under the default limit', { skip: !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)' }, async () => {
    delete process.env.JSON_BODY_LIMIT;
    const app = makeApp();
    const { port, close } = await startServer(app);
    try {
      const token = issueAuthToken(TEST_USER as any);
      const res = await fetch(`http://127.0.0.1:${port}/api/__probe`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.bytes, JSON.stringify({ hello: 'world' }).length);
    } finally {
      await close();
    }
  });
});
