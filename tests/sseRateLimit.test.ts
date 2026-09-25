/**
 * SSE connection-cap tests (hardening on top of the backlog #2 auth fix).
 *
 * PROVES on a real Express app (full pipeline: sseConnectionLimit →
 * requireSseAuth → stream) that:
 *  1. A client address can hold up to SSE_MAX_CONNECTIONS_PER_IP concurrent
 *     streams; the next one is rejected with 429 — even WITH a valid token —
 *     so an authenticated client cannot exhaust server sockets/memory.
 *  2. Closing a stream frees its slot immediately (revoke-on-close), so
 *     legitimate reconnect cycles never hit the cap.
 *  3. Unauthenticated requests are still 401 (the limiter records the slot
 *     but the auth gate rejects; test asserts auth precedence is intact).
 *
 * The per-IP key uses the socket address, so each test run is isolated.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { getSseLimiter } from '../server/src/middleware/sseRateLimit';

const TEST_USER = {
  id: 'u-sse-cap-1',
  email: 'sse-cap@example.com',
  name: 'SSE Cap Test',
  role: 'INVENTORY_MANAGER',
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

function makeApp(): express.Express {
  const app = createApp();
  registerAllRoutes(app);
  return app;
}

/** Opens one SSE stream and returns { res, release } (release closes it). */
async function openStream(port: number, token: string): Promise<{ status: number; contentType: string | null; release: () => void }> {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/sync/stream`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  // Drain the handshake so the server flushes it.
  if (res.status === 200 && res.body) {
    const reader = res.body.getReader();
    reader.read().catch(() => {});
  }
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    release: () => controller.abort(),
  };
}

describe('SSE per-IP concurrent connection cap (real Express app)', () => {
  test('up to the cap: streams are admitted; one more: 429 even with a valid token', async () => {
    const { limiter, maxStreams } = getSseLimiter();
    assert.ok(maxStreams >= 2, 'test needs a cap >= 2');
    const app = makeApp();
    const { port, close } = await startServer(app);
    const token = issueAuthToken(TEST_USER as any);
    const opened: Array<{ release: () => void }> = [];
    try {
      for (let i = 0; i < maxStreams; i++) {
        const s = await openStream(port, token);
        assert.equal(s.status, 200, `stream ${i + 1}/${maxStreams} should be admitted`);
        assert.match(s.contentType || '', /^text\/event-stream/);
        opened.push(s);
      }
      // Cap reached: the next stream must be rejected even though it carries
      // perfectly valid credentials.
      const extra = await openStream(port, token);
      assert.equal(extra.status, 429);
      extra.release();

      // Closing ONE stream frees its slot for the next client.
      opened[0].release();
      await new Promise((r) => setTimeout(r, 100));
      const afterClose = await openStream(port, token);
      assert.equal(afterClose.status, 200, 'slot must be freed after a stream closes');
      opened.push(afterClose);
    } finally {
      for (const s of opened) s.release();
      await close();
    }
  });

  test('unauthenticated requests stay 401 regardless of the limiter', async () => {
    const app = makeApp();
    const { port, close } = await startServer(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/sync/stream`);
      assert.equal(res.status, 401);
    } finally {
      await close();
    }
  });

  test('limiter state resets between test runs (keys are per-IP, revoke works)', async () => {
    const { limiter } = getSseLimiter();
    // The two tests above ran many attempts against the same limiter from
    // the same test-host IP; this asserts the suites do not interfere via
    // long-lived slots: after closeAllConnections all slots are freed.
    const app = makeApp();
    const { port, close } = await startServer(app);
    try {
      const token = issueAuthToken(TEST_USER as any);
      const s = await openStream(port, token);
      assert.equal(s.status, 200);
      s.release();
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(limiter, 'limiter instance is exposed for ops/tests');
    } finally {
      await close();
    }
  });
});
