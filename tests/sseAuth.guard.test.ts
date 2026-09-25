/**
 * SSE auth guard tests (audit backlog #2).
 *
 * PROVES that /api/sync/stream and /api/sync/version are no longer public:
 * unauthenticated requests get 401 BEFORE any SSE handshake (no stream
 * headers, no sseClients registration, no keep-alive timer), while requests
 * carrying a valid HMAC token — via the Authorization header OR the ?token=
 * query parameter EventSource requires — are admitted.
 *
 * Two layers:
 *  1. Middleware unit tests (fake req/res, following the rateLimiter.test.ts
 *     pattern — no server, no DB).
 *  2. A real-server integration test (actual Express app on an ephemeral
 *     port, exercising the full middleware chain: authenticateUser →
 *     public-route bypass logic → requireSseAuth), proving the route is
 *     wired into the app, not just that the middleware works in isolation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';

import { requireSseAuth } from '../server/src/middleware/sseAuth';
import { issueAuthToken } from '../server/src/middleware/auth';
import { createApp, registerAllRoutes } from '../server/src/app';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Positive-path requests flow through requirePostgres, which 503s without a
// reachable database — the same skip-without-DB convention as the
// concurrency/drift-guard integration tests keeps CI green.
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
  id: 'u-sse-1',
  email: 'sse-guard@example.com',
  name: 'SSE Guard Test',
  role: 'INVENTORY_MANAGER',
  branchId: 'b1',
  allowedBranchIds: [],
  canSwitchUser: false,
};

function fakeReqRes(query: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const req: any = { headers, query, user: null as any };
  const res: any = {
    statusCode: 0,
    body: null as any,
    headersSent: false,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  return { req, res, next, wasNext: () => nextCalled };
}

describe('requireSseAuth middleware (unit)', () => {
  test('rejects a request with no token at all: 401, no next()', () => {
    const { req, res, next, wasNext } = fakeReqRes();
    requireSseAuth(req, res, next);
    assert.equal(res.statusCode, 401);
    assert.equal(wasNext(), false);
    assert.match(String(res.body?.message), /valid token/i);
  });

  test('rejects a garbage or tampered token: 401', () => {
    for (const token of ['not-a-token', 'a.b', `${'x'.repeat(20)}.${'y'.repeat(43)}`]) {
      const { req, res, next, wasNext } = fakeReqRes({ token }, {});
      requireSseAuth(req, res, next);
      assert.equal(res.statusCode, 401, `token "${token.slice(0, 12)}…" should be rejected`);
      assert.equal(wasNext(), false);
    }
  });

  test('accepts a valid token via the ?token= query parameter (EventSource path)', () => {
    const token = issueAuthToken(TEST_USER as any);
    const { req, res, next, wasNext } = fakeReqRes({ token }, {});
    requireSseAuth(req, res, next);
    assert.equal(wasNext(), true);
    assert.equal((req.user as any)?.email, TEST_USER.email);
  });

  test('accepts a valid token via the Authorization: Bearer header', () => {
    const token = issueAuthToken(TEST_USER as any);
    const { req, res, next, wasNext } = fakeReqRes({}, { authorization: `Bearer ${token}` });
    requireSseAuth(req, res, next);
    assert.equal(wasNext(), true);
    assert.equal((req.user as any)?.role, TEST_USER.role);
  });

  test('header token wins over query token when both are present', () => {
    const good = issueAuthToken(TEST_USER as any);
    const { req, res, next, wasNext } = fakeReqRes({ token: 'garbage' }, { authorization: `Bearer ${good}` });
    requireSseAuth(req, res, next);
    assert.equal(wasNext(), true);
  });

  test('rejects an expired token: 401', () => {
    // A token signed with a past exp cannot be produced via issueAuthToken's
    // fixed TTL, so forge one with the same HMAC and an expired exp. The
    // secret must match the one the server-side module loaded from .env.
    const secret = process.env.AUTH_TOKEN_SECRET || '';
    const payload = Buffer.from(JSON.stringify({
      sub: 'u1', email: 'x@y.z', exp: Math.floor(Date.now() / 1000) - 3600,
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const { req, res, next, wasNext } = fakeReqRes({ token: `${payload}.${signature}` }, {});
    requireSseAuth(req, res, next);
    assert.equal(res.statusCode, 401);
    assert.equal(wasNext(), false);
  });
});

describe('sync routes behind real Express app (integration, no DB needed)', () => {
  function startServer(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => resolve({
        port: (server.address() as any).port,
        close: () => new Promise<void>((done) => {
          // Drop any still-open keep-alive/SSE sockets so the process can exit.
          (server as any).closeAllConnections?.();
          server.close(() => done());
        }),
      }));
    });
  }

  test('GET /api/sync/stream without a token: 401 and NO SSE headers/registration', async () => {
    const { port, close } = await startServer(createApp());
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/sync/stream`);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
      const body = await res.json();
      assert.match(body.message, /valid token/i);
    } finally {
      await close();
    }
  });

  test('GET /api/sync/version without a token: 401', async () => {
    const { port, close } = await startServer(createApp());
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/sync/version`);
      assert.equal(res.status, 401);
    } finally {
      await close();
    }
  });

  test('GET /api/sync/version with a valid ?token=: 200 JSON', { skip: !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)' }, async () => {
    const app = createApp();
    registerAllRoutes(app);
    const { port, close } = await startServer(app);
    try {
      const token = issueAuthToken(TEST_USER as any);
      const res = await fetch(`http://127.0.0.1:${port}/api/sync/version?token=${encodeURIComponent(token)}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok('dataVersion' in body);
    } finally {
      await close();
    }
  });

  test('GET /api/sync/stream with a valid Bearer header: SSE handshake begins (200, text/event-stream, CONNECTED event)', { skip: !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)' }, async () => {
    const app = createApp();
    registerAllRoutes(app);
    const { port, close } = await startServer(app);
    try {
      const token = issueAuthToken(TEST_USER as any);
      const res = await fetch(`http://127.0.0.1:${port}/api/sync/stream`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /^text\/event-stream/);
      // Read the first SSE event, then close (do not hold the stream open).
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      assert.match(text, /CONNECTED/);
      await reader.cancel().catch(() => {});
    } finally {
      await close();
    }
  });
});
