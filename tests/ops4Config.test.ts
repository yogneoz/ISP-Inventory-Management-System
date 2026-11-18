/**
 * OPS-4 — statement_timeout and breaker configuration.
 *
 * PROVES, against the real modules:
 *   1. PG_STATEMENT_TIMEOUT_MS=1000 cuts a real SELECT pg_sleep(5) short with
 *      SQLSTATE 57014, surfaced as the typed DB_BUSY 503 (and the driver cause
 *      is kept for logs, never in the HTTP body);
 *   2. the same cancellation over real HTTP through createApp, auth,
 *      requirePostgres and the central error handler;
 *   3. the breaker reads its configured threshold/cooldown and trips and
 *      recovers at those values (injected clock, no sleeps);
 *   4. invalid configuration fails at boot with a message naming the variable,
 *      instead of silently using 30s.
 *
 * The env assignments must happen before the first server import: dotenv does
 * not overwrite existing variables, and db.ts/dbBreaker read them at load.
 *
 * SCALE-3 (PgBouncer transaction pooling): the timeout no longer rides in the
 * client's startup packet, so it is applied to the database ROLE before this
 * file's pool opens a connection — exactly what boot does — and restored in
 * `after()`. A startup parameter would be lost by a transaction-mode pooler.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

process.env.PG_STATEMENT_TIMEOUT_MS = '1000';
process.env.DB_BREAKER_FAILURE_THRESHOLD = '2';
process.env.DB_BREAKER_WINDOW_MS = '30000';
process.env.DB_BREAKER_COOLDOWN_MS = '100';
process.env.DB_BREAKER_MAX_COOLDOWN_MS = '200';
process.env.DB_RETRY_AFTER_SECONDS = '2';
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || 'ops4-regression-secret';

const pgModule = (await import('pg')).default;
const dotenv = (await import('dotenv')).default;
// server/db.ts loads .env on import; the role must be prepared before that import
// and before any pool connection exists, so load it here explicitly.
dotenv.config();
const { ensureRoleStatementTimeout, readRoleStatementTimeout } = await import('../server/src/db/statementTimeout');

let originalRoleTimeout: string | null = null;
let rolePrepared = false;
if (process.env.DATABASE_URL) {
  const prep = new pgModule.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await prep.connect();
    originalRoleTimeout = await readRoleStatementTimeout(prep);
    await ensureRoleStatementTimeout(prep, 1_000, () => undefined);
    rolePrepared = true;
  } catch {
    rolePrepared = false;
  } finally {
    await prep.end().catch(() => undefined);
  }
}

const db = await import('../server/db');
const { DbBreaker, dbBreaker, dbBreakerConfigFromEnv, dbRetryAfterSeconds } = await import(
  '../server/src/observability/dbBreaker'
);
const { strictIntFromEnv } = await import('../server/src/utils/envGuard');
const { createApp, registerAllRoutes } = await import('../server/src/app');
const { issueAuthToken } = await import('../server/src/middleware/auth');

let dbReachable = false;
try {
  // ensurePostgresConnection is the boot/probe path: it talks to the real pool
  // and sets the availability flag that pgPool.query and requirePostgres read.
  dbReachable = await db.ensurePostgresConnection();
} catch {
  dbReachable = false;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (real statement timeout)';

const ROOT = path.resolve('.');

function runChild(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('OPS-4 strict config', () => {
  test('invalid or out-of-range values throw with the variable name', () => {
    const name = 'OPS4_STRICT_TEST_VALUE';
    const saved = process.env[name];
    try {
      for (const bad of ['abc', '1.5', '', '11']) {
        if (bad === '') delete process.env[name];
        else process.env[name] = bad;
        if (bad === '') {
          assert.equal(strictIntFromEnv(name, 5, { min: 1, max: 10 }), 5, 'unset uses fallback');
          continue;
        }
        assert.throws(
          () => strictIntFromEnv(name, 5, { min: 1, max: 10 }),
          new RegExp(name),
          `${JSON.stringify(bad)} must name the variable`
        );
      }
      process.env[name] = '10';
      assert.equal(strictIntFromEnv(name, 5, { min: 1, max: 10 }), 10);
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });

  test('an invalid statement timeout kills the boot before a pool is built', async () => {
    const result = await runChild(
      ['--import', 'tsx', '-e', "import('./server/db.ts')"],
      {
        ...process.env,
        DATABASE_URL:
          process.env.DATABASE_URL ||
          'postgres://inventory_user:securepassword@127.0.0.1:5432/inventory_db',
        PG_STATEMENT_TIMEOUT_MS: 'not-a-number',
      }
    );
    assert.notEqual(result.code, 0, 'an invalid timeout must not be accepted');
    assert.match(result.output, /PG_STATEMENT_TIMEOUT_MS/);
    assert.match(result.output, /expected an integer/i);

    const breaker = await runChild(
      ['--import', 'tsx', '-e', "import('./server/src/observability/dbBreaker.ts')"],
      { ...process.env, DB_BREAKER_FAILURE_THRESHOLD: '0' }
    );
    assert.notEqual(breaker.code, 0, 'an invalid breaker threshold must not be accepted');
    assert.match(breaker.output, /DB_BREAKER_FAILURE_THRESHOLD/);
  });
});

describe('OPS-4 breaker configuration', () => {
  test('reads the configured threshold, window, cooldown and Retry-After', () => {
    const config = dbBreakerConfigFromEnv();
    assert.deepEqual(config, {
      failureThreshold: 2,
      windowMs: 30_000,
      baseCooldownMs: 100,
      maxCooldownMs: 200,
    });
    assert.equal(dbRetryAfterSeconds(), 2, 'DB_RETRY_AFTER_SECONDS reaches the 503');
    assert.equal(dbBreaker.snapshot(0).failureThreshold, 2);
    assert.equal(dbBreaker.snapshot(0).cooldownMs, 100);
  });

  test('trips at the configured threshold and recovers after the configured cooldown', () => {
    const breaker = new DbBreaker(dbBreakerConfigFromEnv());
    breaker.recordFailure('socket_dropped', 1_000);
    assert.equal(breaker.snapshot(1_000).state, 'closed', 'one failure is below the configured 2');
    breaker.recordFailure('socket_dropped', 1_001);
    const open = breaker.snapshot(1_001);
    assert.equal(open.state, 'open');
    assert.equal(open.cooldownMs, 100, 'the configured cooldown is used');
    assert.equal(open.retryAfterSeconds, 1);
    assert.equal(breaker.beginAttempt(1_050).allowed, false, 'still inside the 100ms cooldown');

    const probe = breaker.beginAttempt(1_101);
    assert.equal(probe.allowed, true);
    assert.equal(probe.probe, true);
    breaker.recordSuccess(1_102);
    assert.equal(breaker.snapshot(1_102).state, 'closed', 'a successful probe restores service');
  });
});

describe('OPS-4 real statement timeout', () => {
  before(() => {
    dbBreaker.reset();
  });

  test('a real 5s sleep is cut at the configured 1s and becomes typed DB_BUSY', { skip: skipNoDb }, async () => {
    const startedAt = Date.now();
    await assert.rejects(
      db.pgPool.query('SELECT pg_sleep(5)'),
      (err: any) => {
        assert.equal(err.status, 503);
        assert.equal(err.code, 'DB_BUSY');
        assert.match(err.message, /database is busy/i);
        assert.equal(err.retryAfterSec, 2);
        assert.equal(err.cause?.code, '57014', 'the driver cancellation is preserved for logs');
        return true;
      }
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 800, `the timeout must actually wait for PostgreSQL (${elapsed}ms)`);
    assert.ok(elapsed < 4_000, `the 5s sleep must be cancelled near 1s (${elapsed}ms)`);

    const show = await db.pgPool.query('SHOW statement_timeout');
    assert.equal(show.rows[0].statement_timeout, '1s', 'the session actually received the setting');
    const next = await db.pgPool.query('SELECT 1 AS ok');
    assert.equal(next.rows[0].ok, 1, 'the next ordinary query succeeds');
    assert.equal(dbBreaker.snapshot().state, 'closed', 'a statement timeout must not open the breaker');
  });

  test('unset applies the documented 30s default to the role, so a new connection inherits it', { skip: skipNoDb }, async () => {
    const env = { ...process.env };
    delete env.PG_STATEMENT_TIMEOUT_MS;
    const result = await runChild(
      [
        '--import',
        'tsx',
        '-e',
        "import('./server/db.ts').then(async ({ buildPoolConfig }) => {" +
          " const pg = (await import('pg')).default;" +
          " const { ensureRoleStatementTimeout } = await import('./server/src/db/statementTimeout.ts');" +
          " const c = new pg.Client({ connectionString: process.env.DATABASE_URL });" +
          ' await c.connect();' +
          ' const ms = buildPoolConfig().statementTimeoutMs;' +
          ' await ensureRoleStatementTimeout(c, ms, () => {});' +
          ' const fresh = new pg.Client({ connectionString: process.env.DATABASE_URL });' +
          ' await fresh.connect();' +
          " const r = await fresh.query('SHOW statement_timeout');" +
          " console.log('STATEMENT_TIMEOUT=' + r.rows[0].statement_timeout);" +
          ' await fresh.end(); await c.end(); })',
      ],
      env
    );
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /STATEMENT_TIMEOUT=30s/);

    // Leave the role at this file's 1s setting for the HTTP test that follows.
    const restore = new pgModule.Client({ connectionString: process.env.DATABASE_URL });
    await restore.connect();
    try {
      await ensureRoleStatementTimeout(restore, 1_000, () => undefined);
    } finally {
      await restore.end();
    }
  });

  test('the timeout also reaches HTTP as a generic 503', { skip: skipNoDb }, async () => {
    const app = createApp();
    app.get('/api/__ops4_slow', async (_req: any, res: any, next: any) => {
      try {
        await db.pgPool.query('SELECT pg_sleep(5)');
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    });
    registerAllRoutes(app);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    const token = issueAuthToken({
      id: 'usr-ops4',
      email: 'ops4@example.com',
      role: 'SUPER_ADMIN',
      branchId: 'WH001',
    } as any);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/__ops4_slow`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '2');
      const body = (await response.json()) as any;
      assert.equal(body.code, 'DB_BUSY');
      assert.match(body.message, /database is busy/i);
      assert.ok(!/pg_sleep|57014|timeout/i.test(body.message), 'the HTTP body stays generic');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  after(async () => {
    dbBreaker.reset();
    if (rolePrepared && process.env.DATABASE_URL) {
      const restore = new pgModule.Client({ connectionString: process.env.DATABASE_URL });
      try {
        await restore.connect();
        const ddl = originalRoleTimeout
          ? await restore.query(
              `SELECT format('ALTER ROLE %I SET statement_timeout = %L', current_user, $1::text) AS ddl`,
              [originalRoleTimeout]
            )
          : await restore.query(`SELECT format('ALTER ROLE %I RESET statement_timeout', current_user) AS ddl`);
        await restore.query(ddl.rows[0].ddl);
      } finally {
        await restore.end();
      }
    }
  });
});
