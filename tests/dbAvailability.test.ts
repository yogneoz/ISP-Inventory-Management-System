/**
 * OPS-1 — database availability circuit breaker.
 *
 * The contract from worklist/2026-11-16-backup-and-db-availability:
 *
 *   - a pool acquire timeout is a busy pool, NOT a disconnect: one request
 *     gets 503 + Retry-After, the database stays marked connected;
 *   - three countable socket failures open the breaker, and the next request
 *     gets 503 + Retry-After without touching PostgreSQL;
 *   - exactly one half-open probe is allowed after the cooldown; its success
 *     closes the breaker and normal requests recover.
 *
 * The integration cases run the REAL Express stack (createApp → auth →
 * requirePostgres → route → central error handler), not a unit call. The
 * query route exists only to make the pool fail inside a request. The breaker
 * cases are pure and need no database.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Must be set before the first server import: one connection so holding it
// starves the next query, and a short acquire timeout so the test is quick.
// dotenv does not overwrite existing variables, so these win over .env.
process.env.PG_POOL_MAX = '1';
process.env.PG_CONNECT_TIMEOUT_MS = '1000';
process.env.DB_BREAKER_FAILURE_THRESHOLD = '3';
process.env.DB_BREAKER_WINDOW_MS = '30000';
process.env.DB_BREAKER_COOLDOWN_MS = '1000';
process.env.DB_BREAKER_MAX_COOLDOWN_MS = '4000';
process.env.DB_RETRY_AFTER_SECONDS = '2';
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || 'ops1-regression-secret';

const db = await import('../server/db');
const { DbBreaker, dbBreaker } = await import('../server/src/observability/dbBreaker');
const { createApp, registerAllRoutes } = await import('../server/src/app');
const { issueAuthToken } = await import('../server/src/middleware/auth');
const { errorHandler } = await import('../server/src/errors/errorHandler');

// Resolved at module load: node:test evaluates the skip option at registration.
let skipNoDb: false | string = false;
if (!db.realPoolInstance) {
  skipNoDb = 'needs a reachable PostgreSQL (real pool acquire timeout)';
} else {
  try {
    const client = await db.realPoolInstance.connect();
    client.release();
  } catch {
    skipNoDb = 'needs a reachable PostgreSQL (real pool acquire timeout)';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('classifyDbFailure — what may open the breaker', () => {
  test('a pg-pool acquire timeout is a busy pool, not a lost database', () => {
    assert.equal(
      db.classifyDbFailure(new Error('timeout exceeded when trying to connect'), false),
      'pool_acquire_timeout'
    );
    assert.equal(
      db.isConnectionLevelFailure(new Error('timeout exceeded when trying to connect')),
      false
    );
  });

  test('class 08 and shutdown codes are server-unreachable', () => {
    assert.equal(db.classifyDbFailure({ code: '08006' }, true), 'server_unreachable');
    assert.equal(db.classifyDbFailure({ code: '08001' }, true), 'server_unreachable');
    assert.equal(db.classifyDbFailure({ code: '57P01' }, true), 'server_unreachable');
    assert.equal(db.classifyDbFailure({ code: '57P03' }, true), 'server_unreachable');
  });

  test('statement timeouts and SQL errors never count toward an outage', () => {
    assert.equal(db.classifyDbFailure({ code: '57014' }, true), 'statement_timeout');
    assert.equal(db.classifyDbFailure({ code: '23503' }, true), 'query_error');
    assert.equal(db.isConnectionLevelFailure({ code: '57014' }), false);
    assert.equal(db.isConnectionLevelFailure({ code: '23503' }), false);
  });

  test('socket errors count only when a client was acquired', () => {
    assert.equal(db.classifyDbFailure(new Error('read ECONNRESET'), true), 'socket_dropped');
    assert.equal(
      db.classifyDbFailure(new Error('Connection terminated unexpectedly'), true),
      'socket_dropped'
    );
    assert.equal(db.classifyDbFailure(new Error('connect ETIMEDOUT'), false), 'connect_timeout');
    assert.equal(db.classifyDbFailure(new Error('read ETIMEDOUT'), true), 'socket_dropped');
    assert.equal(db.classifyDbFailure(new Error('connect ECONNREFUSED'), false), 'server_unreachable');
  });

  test('an unknown failure with a client in hand stays conservative', () => {
    assert.equal(db.classifyDbFailure(new Error('something else entirely'), true), 'socket_dropped');
    assert.equal(db.isConnectionLevelFailure(new Error('something else entirely')), true);
  });
});

describe('DbBreaker — state machine', () => {
  test('opens only after the threshold inside the window', () => {
    const breaker = new DbBreaker({
      failureThreshold: 3,
      windowMs: 30_000,
      baseCooldownMs: 1_000,
      maxCooldownMs: 4_000,
    });
    breaker.recordFailure('socket_dropped', 0);
    breaker.recordFailure('socket_dropped', 1_000);
    assert.equal(breaker.snapshot(1_000).state, 'closed');

    breaker.recordFailure('socket_dropped', 2_000);
    const snapshot = breaker.snapshot(2_000);
    assert.equal(snapshot.state, 'open');
    assert.equal(snapshot.cooldownMs, 1_000);
    assert.equal(snapshot.opens, 1);
  });

  test('failures outside the window do not accumulate', () => {
    const breaker = new DbBreaker({
      failureThreshold: 3,
      windowMs: 10_000,
      baseCooldownMs: 1_000,
      maxCooldownMs: 4_000,
    });
    breaker.recordFailure('socket_dropped', 0);
    breaker.recordFailure('socket_dropped', 20_000);
    breaker.recordFailure('socket_dropped', 20_001);
    assert.equal(breaker.snapshot(20_001).state, 'closed');
  });

  test('non-countable failures never open it', () => {
    const breaker = new DbBreaker({ failureThreshold: 3, windowMs: 30_000, baseCooldownMs: 1_000 });
    for (let i = 0; i < 10; i++) breaker.recordFailure('query_error', i);
    for (let i = 0; i < 10; i++) breaker.recordFailure('pool_acquire_timeout', i);
    assert.equal(breaker.snapshot(10).state, 'closed');
    assert.equal(breaker.beginAttempt(10).allowed, true);
  });

  test('half-open allows one probe, closes on success, doubles on failure', () => {
    const breaker = new DbBreaker({
      failureThreshold: 3,
      windowMs: 30_000,
      baseCooldownMs: 1_000,
      maxCooldownMs: 4_000,
    });
    for (let i = 0; i < 3; i++) breaker.recordFailure('socket_dropped', i);
    assert.equal(breaker.beginAttempt(500).allowed, false, 'cooldown has not elapsed');

    const probe = breaker.beginAttempt(1_500);
    assert.equal(probe.allowed, true);
    assert.equal(probe.probe, true);
    assert.equal(breaker.snapshot(1_500).state, 'half_open');
    assert.equal(breaker.beginAttempt(1_501).allowed, false, 'only one probe in flight');

    breaker.recordFailure('socket_dropped', 1_502);
    const reopened = breaker.snapshot(1_502);
    assert.equal(reopened.state, 'open');
    assert.equal(reopened.cooldownMs, 2_000, 'a failed probe doubles the cooldown');

    // Reopened at 1,502 with a 2,000 ms cooldown: probe at 3,600.
    assert.equal(breaker.beginAttempt(3_400).allowed, false);
    assert.equal(breaker.beginAttempt(3_600).allowed, true);
    breaker.recordSuccess(3_601);
    assert.equal(breaker.snapshot(3_602).state, 'closed');
    assert.equal(breaker.snapshot(3_602).cooldownMs, 1_000, 'success resets the backoff');
  });
});

describe('real request path — 503, short-circuit and recovery', () => {
  let server: http.Server;
  let port = 0;
  let token = '';

  before(async () => {
    const app = createApp();
    // A request whose handler really uses the pool, so pool exhaustion becomes
    // a real failing dependency inside the real middleware/error chain.
    app.get('/api/__ops1_query', async (_req: any, res: any, next: any) => {
      try {
        await db.pgPool.query('SELECT 1');
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    });
    // A handler that does no database work: after requirePostgres lets it
    // through, a 200 means the gate recovered.
    app.get('/api/__ops1_ping', (_req: any, res: any) => res.json({ ok: true }));
    registerAllRoutes(app);

    token = issueAuthToken({
      id: 'usr-ops1',
      email: 'ops1@example.com',
      role: 'SUPER_ADMIN',
      branchId: 'WH001',
    } as any);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  after(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function call(method: string, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => {
            let body: any = raw;
            try {
              body = JSON.parse(raw);
            } catch {
              // keep the raw body for the assertion message
            }
            resolve({ status: res.statusCode || 0, headers: res.headers, body });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  test('a real pool acquire timeout is a retryable 503 and leaves the flag up', { skip: skipNoDb }, async () => {
    dbBreaker.reset();
    db.setDatabaseConnected(true);
    const held = await db.realPoolInstance.connect();
    try {
      const res = await call('GET', '/api/__ops1_query');
      assert.equal(res.status, 503, `expected 503, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body?.code, 'DB_BUSY');
      assert.match(String(res.body?.message || ''), /busy/i);
      assert.ok(Number(res.headers['retry-after']) >= 1, 'Retry-After must be present');
      assert.doesNotMatch(JSON.stringify(res.body), /timeout exceeded|ECONN|127\.0\.0\.1/i);
      assert.equal(db.getIsPgConnected(), true, 'one acquire timeout must not mark the database down');
      assert.equal(dbBreaker.snapshot().state, 'closed', 'a busy pool must not open the breaker');
    } finally {
      held.release();
    }
  });

  test('three socket failures open the breaker and the next request 503s without a DB call', { skip: skipNoDb }, async () => {
    dbBreaker.reset();
    db.setDatabaseConnected(true);
    db.noteDbFailure('socket_dropped');
    db.noteDbFailure('socket_dropped');
    db.noteDbFailure('socket_dropped');
    assert.equal(dbBreaker.snapshot().state, 'open');
    assert.equal(db.getIsPgConnected(), false, 'opening the breaker is what marks it down');

    const real = db.realPoolInstance;
    const originalConnect = real.connect;
    let connects = 0;
    real.connect = function (...args: any[]) {
      connects += 1;
      return originalConnect.apply(real, args);
    };
    try {
      const res = await call('GET', '/api/__ops1_ping');
      assert.equal(res.status, 503, `expected 503, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body?.code, 'DB_UNAVAILABLE');
      assert.ok(Number(res.headers['retry-after']) >= 1, 'Retry-After must be present');
      assert.equal(connects, 0, 'the open breaker must short-circuit before acquiring a connection');
    } finally {
      real.connect = originalConnect;
    }
  });

  test('one successful half-open probe closes the breaker and requests recover', { skip: skipNoDb }, async () => {
    assert.equal(dbBreaker.snapshot().state, 'open');
    await sleep(1_050); // cooldown is 1 s in this suite

    const res = await call('GET', '/api/__ops1_ping');
    assert.equal(res.status, 200, `expected recovery 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(dbBreaker.snapshot().state, 'closed');
    assert.equal(db.getIsPgConnected(), true);
  });
});

/**
 * A statement timeout can reach the central handler as a RAW SQLSTATE: the pool
 * wrapper in db.ts converts 57014 to DbBusyError, but a `client.query` inside
 * withConnection/withTransaction never passes through that wrapper. A slow
 * trial-balance read therefore answered 500 "the database refused this change"
 * — which reads like a permanent rejection of a valid request. These cases pin
 * the mapping so a timeout is the same retryable 503 the bootstrap path emits.
 */
function fakeRes() {
  const res: any = { headersSent: false, statusCode: 0, body: null, headers: {} as Record<string, string> };
  res.setHeader = (name: string, value: string) => {
    res.headers[name.toLowerCase()] = value;
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

describe('central handler — a database timeout is retryable, not a refusal', () => {
  test('a statement timeout (57014) becomes the typed DB_BUSY 503 with Retry-After', () => {
    const res = fakeRes();
    errorHandler(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
      {} as any,
      res,
      () => undefined
    );
    assert.equal(res.statusCode, 503);
    assert.equal(res.body?.code, 'DB_BUSY');
    assert.match(String(res.body?.message || ''), /busy/i);
    assert.ok(Number(res.headers['retry-after']) >= 1, 'Retry-After must be present');
    assert.doesNotMatch(
      JSON.stringify(res.body),
      /statement timeout|canceling/i,
      'the driver text stays in the server log'
    );
  });

  test('a lock timeout (55P03) is retryable too', () => {
    const res = fakeRes();
    errorHandler(
      Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
      {} as any,
      res,
      () => undefined
    );
    assert.equal(res.statusCode, 503);
    assert.equal(res.body?.code, 'DB_BUSY');
  });

  test('a non-timeout SQLSTATE keeps the 500 refusal and never echoes the driver text', () => {
    const res = fakeRes();
    errorHandler(
      Object.assign(new Error('relation "nope" does not exist'), { code: '42P01' }),
      {} as any,
      res,
      () => undefined
    );
    assert.equal(res.statusCode, 500);
    assert.match(String(res.body?.message || ''), /refused this change/);
    assert.doesNotMatch(JSON.stringify(res.body), /nope/, 'the driver text stays in the server log');
  });
});
