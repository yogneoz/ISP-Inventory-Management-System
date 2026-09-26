/**
 * Auth + branch-scoping HTTP-layer integration tests (audit backlog #5).
 *
 * PROVES at the HTTP layer, on a real Express app with the middleware chain
 * wired exactly as production (createApp + registerAllRoutes):
 *
 *  1. LOGIN (POST /api/auth/login — a public route behind the rate limiter)
 *     - wrong password → 401 (scrypt-verified against the real user row)
 *     - unknown email → 401
 *     - malformed body → 401 (never 500)
 *     - valid credentials → 200 with a user object + usable HMAC token
 *  2. AUTH GATE (requireAuth)
 *     - missing/garbage Bearer token on a protected route → 401
 *     - the token issued by a real login grants access to GET /api/auth/me
 *  3. BRANCH SCOPING (enforceBranchAccess)
 *     - a branch user fetching a branch-scoped read WITHOUT ?branchId → 403
 *     - with their OWN branchId → passes the gate (request proceeds)
 *     - with another branch's branchId (not in allowedBranchIds) → 403
 *     - with ?branchId=ALL → 403
 *     - a SUPER_ADMIN bypasses branch scoping entirely
 *
 * Negative paths need no database; positive paths hit real PostgreSQL via
 * requirePostgres and follow the skip-without-DB convention (see the CI
 * lesson block in SESSION_NOTES.md).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';

import { createApp, registerAllRoutes } from '../server/src/app';
import { hashPassword, issueAuthToken } from '../server/src/middleware/auth';

dotenv.config();

let dbReachable = false;
let probe: pg.Pool | null = null;
try {
  if (process.env.DATABASE_URL) {
    probe = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
    await probe.query('SELECT 1');
    dbReachable = true;
  }
} catch { dbReachable = false; }

const skipPositive = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

function startServer(app: import('express').Express): Promise<{ port: number; close: () => Promise<void> }> {
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

async function login(port: number, body: unknown): Promise<{ status: number; json: any; token?: string; user?: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
  return { status: res.status, json, token: json?.token, user: json?.user };
}

describe('login (POST /api/auth/login, HTTP layer)', () => {
  test('wrong password for an existing account: 401 with a structured message', { skip: skipPositive }, async () => {
    const app = createApp();
    registerAllRoutes(app);
    const { port, close } = await startServer(app);
    try {
      // Find a real account to aim the wrong-password attempt at.
      const { rows } = await probe!.query(`SELECT email FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1`);
      assert.ok(rows[0], 'test requires at least one user in the database');
      const { status, json } = await login(port, { email: rows[0].email, password: 'definitely-wrong-password' });
      assert.equal(status, 401);
      assert.match(String(json?.message), /invalid email or password/i);
    } finally {
      await close();
    }
  });

  test('unknown email: 401 (never leaks account existence)', { skip: skipPositive }, async () => {
    const app = createApp();
    registerAllRoutes(app);
    const { port, close } = await startServer(app);
    try {
      const { status, json } = await login(port, { email: 'no-such-account@example.com', password: 'whatever' });
      assert.equal(status, 401);
      assert.match(String(json?.message), /invalid email or password/i);
    } finally {
      await close();
    }
  });

  test('missing body fields: 401 (never 500)', { skip: skipPositive }, async () => {
    const app = createApp();
    registerAllRoutes(app);
    const { port, close } = await startServer(app);
    try {
      for (const body of [{}, { email: 'x@y.z' }, { password: 'p' }]) {
        const { status } = await login(port, body);
        assert.equal(status, 401, `body ${JSON.stringify(body)} must not 500`);
      }
      // Garbage JSON body must also be handled gracefully (400 from the
      // body parser or 401 — never 500).
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      });
      assert.ok(res.status === 400 || res.status === 401, `garbage JSON returned ${res.status}`);
    } finally {
      await close();
    }
  });

  test('valid credentials: 200 with user object + token that authenticates subsequent requests', { skip: skipPositive }, async () => {
    const app = createApp();
    registerAllRoutes(app);
    const { port, close } = await startServer(app);
    try {
      // Provision a dedicated test account (idempotent) so the test does not
      // depend on seeded data and never mutates a real user's password.
      const email = 'auth-guard-test@example.com';
      const password = 'AuthGuard@Test1';
      await probe!.query(
        `INSERT INTO users (id, name, email, password, role, branch_id)
         VALUES ('u-auth-guard-test', 'Auth Guard Test', $1, $2, 'INVENTORY_MANAGER', 'WH001')
         ON CONFLICT (email) DO NOTHING`,
        [email, hashPassword(password)]
      );
      const { status, json, token, user } = await login(port, { email, password });
      assert.equal(status, 200);
      assert.ok(token, 'login must issue a token');
      assert.equal(user?.email, email);
      assert.equal(user?.password, undefined, 'login response must never include the password hash');

      // The issued token must authenticate a protected route.
      const me = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(me.status, 200);
      const meBody = await me.json();
      assert.equal(meBody.email, email);
    } finally {
      await close();
    }
  });
});

describe('auth gate (requireAuth via the global /api middleware, HTTP layer)', () => {
  const app = createApp();
  registerAllRoutes(app);
  let port = 0;
  let closer: (() => Promise<void>) | null = null;

  test('setup', async () => {
    const s = await startServer(app);
    port = s.port;
    closer = s.close;
  });

  test('protected route without a token: 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    assert.equal(res.status, 401);
  });

  test('protected route with a garbage Bearer token: 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { authorization: 'Bearer not.a.real.token' },
    });
    assert.equal(res.status, 401);
  });

  test('public route stays reachable without a token (setup-status)', async () => {
    // setup-status is public wrt AUTH (no 401), but still sits behind the
    // requirePostgres gate: without PostgreSQL it 503s with the availability
    // message, with PostgreSQL it 200s. Either proves the auth bypass works;
    // a 401 would mean the public-route exemption broke.
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/setup-status`);
    assert.ok(res.status === 200 || res.status === 503, `expected 200 or 503, got ${res.status}`);
    if (res.status === 200) {
      const body = await res.json();
      assert.ok('isFirstLaunch' in body);
    }
  });

  test('teardown', async () => { await closer?.(); });
});

describe('branch scoping (enforceBranchAccess, HTTP layer)', () => {
  const BRANCH_USER = {
    id: 'u-branch-guard',
    email: 'branch-guard@example.com',
    name: 'Branch Guard',
    role: 'INVENTORY_MANAGER',
    branchId: 'WH001',
    allowedBranchIds: [],
    canSwitchUser: false,
  };

  function makeBranchUserToken(overrides: Partial<typeof BRANCH_USER> = {}) {
    // Tokens are self-contained HMAC payloads; enforceBranchAccess acts purely
    // on req.user, so a token for a synthetic user exercises the real
    // middleware chain without database user rows. Positive paths past
    // enforceBranchAccess still flow through requirePostgres (skipped without
    // a DB) — but the branch gate itself fires BEFORE the controller.
    return issueAuthToken({ ...BRANCH_USER, ...overrides } as any);
  }

  test('GET /api/stock without ?branchId (branch-scoped read path): 403', { skip: skipPositive }, async () => {
    const app = createApp();
    registerAllRoutes(app);
    const { port, close } = await startServer(app);
    try {
      const token = makeBranchUserToken();
      const res = await fetch(`http://127.0.0.1:${port}/api/stock`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.match(String(body?.message), /branch-scoped read/i);
    } finally {
      await close();
    }
  });

  test('GET /api/stock with another branch\u2019s branchId: 403', { skip: skipPositive }, async () => {
    const app = createApp();
    registerAllRoutes(app);
    const { port, close } = await startServer(app);
    try {
      const token = makeBranchUserToken({ branchId: 'WH001', allowedBranchIds: [] });
      const res = await fetch(`http://127.0.0.1:${port}/api/stock?branchId=BRH01`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });

  test('GET /api/stock?branchId=ALL: 403 (branch users cannot read all branches)', { skip: skipPositive }, async () => {
    const app = createApp();
    registerAllRoutes(app);
    const { port, close } = await startServer(app);
    try {
      const token = makeBranchUserToken();
      const res = await fetch(`http://127.0.0.1:${port}/api/stock?branchId=ALL`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });

  test('GET /api/stock with the user\u2019s own branchId: passes the gate (proceeds past scoping)', { skip: skipPositive }, async () => {
    const app = createApp();
    registerAllRoutes(app);
    const { port, close } = await startServer(app);
    try {
      const token = makeBranchUserToken();
      const res = await fetch(`http://127.0.0.1:${port}/api/stock?branchId=WH001`, {
        headers: { authorization: `Bearer ${token}` },
      });
      // The branch gate MUST have passed — anything other than 403 means the
      // request proceeded to the controller/requirePostgres (200 or an
      // application-level response). A 403 here would be the gate wrongly
      // rejecting the user's OWN branch.
      assert.notEqual(res.status, 403, 'own branchId must pass enforceBranchAccess');
    } finally {
      await close();
    }
  });

  test('branch user with allowedBranchIds may read the additionally-allowed branch', { skip: skipPositive }, async () => {
    const app = createApp();
    registerAllRoutes(app);
    const { port, close } = await startServer(app);
    try {
      const token = makeBranchUserToken({ allowedBranchIds: ['BRH01'] });
      const res = await fetch(`http://127.0.0.1:${port}/api/stock?branchId=BRH01`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.notEqual(res.status, 403, 'allowedBranchIds entry must pass enforceBranchAccess');
    } finally {
      await close();
    }
  });

  test('SUPER_ADMIN bypasses branch scoping (no branchId required)', { skip: skipPositive }, async () => {
    const app = createApp();
    registerAllRoutes(app);
    const { port, close } = await startServer(app);
    try {
      const token = makeBranchUserToken({ role: 'SUPER_ADMIN', branchId: 'WH001' });
      const res = await fetch(`http://127.0.0.1:${port}/api/stock`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.notEqual(res.status, 403, 'SUPER_ADMIN must bypass enforceBranchAccess');
    } finally {
      await close();
    }
  });

  test('POST with a foreign sourceBranchId in the body: 403', { skip: skipPositive }, async () => {
    const app = createApp();
    registerAllRoutes(app);
    const { port, close } = await startServer(app);
    try {
      const token = makeBranchUserToken({ branchId: 'WH001' });
      const res = await fetch(`http://127.0.0.1:${port}/api/stock-operations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ sourceBranchId: 'BRH01', items: [] }),
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.match(String(body?.message), /not authorized for the requested branch/i);
    } finally {
      await close();
    }
  });
});

test.after(async () => { await probe?.end(); });
