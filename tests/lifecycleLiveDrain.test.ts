/**
 * Live graceful-drain proof against the REAL booted server entry (CI check).
 *
 * The other lifecycle tests prove the drain logic hermetically (bare http
 * servers + injected seams) and one of them proves real process exit codes with
 * delivery through `process.emit`, because Windows cannot deliver a POSIX
 * signal to a child at all. None of them can show what this one shows, and only
 * on a platform that can deliver a signal (Linux CI):
 *
 *   1. `server/index.ts` — the entry pm2 and Docker actually run — boots against
 *      a real PostgreSQL and answers GET /api/health 200.
 *   2. The request is GENUINELY IN FLIGHT when the signal lands. A sleep would
 *      only guess at that: instead the login POST declares its Content-Length
 *      and withholds the last bytes, so express's body parser is still waiting
 *      for the body and the handler has not run. The child's own shutdown line
 *      must therefore read `draining 1 in-flight request(s)` — that count, not
 *      a timer, is the proof of the overlap.
 *   3. The signal is a REAL OS SIGTERM (`child.kill`), so the handler is reached
 *      exactly the way `pm2 reload` and `docker stop` reach it.
 *   4. The in-flight response COMPLETES — 200 with a usable token from a real
 *      PostgreSQL round trip performed while shutting down, which also proves
 *      the pool is still usable during the drain rather than torn down early —
 *      and the process then exits 0 by itself: not by signal, not by this test's
 *      fail-safe.
 *
 * Isolation: the boot runs against a throwaway database this test creates and
 * drops (`inventory_drain_test`), never the application database — the rule the
 * CI service-container comment states for the whole suite. The app's own boot
 * then applies schema.sql and seeds that throwaway, which doubles as the proof
 * that the child really did boot against it: an app database would leave the
 * throwaway without a `users` table at all.
 *
 * Skip rules, deliberately asymmetric:
 *   - Windows: skipped, because the OS cannot deliver the signal (see above).
 *   - No reachable PostgreSQL: skipped, following the repo's integration-test
 *     convention (tests/docnumber.concurrency.test.ts).
 *   - A reachable PostgreSQL where CREATE DATABASE fails: FAILS. Skipping there
 *     would let the one check that proves the CI behaviour disappear silently.
 *   - LIVE_DRAIN_REQUIRE_REAL_SIGNAL=1 (set by CI, where the positive proof is
 *     promised): every one of the skips above becomes a FAILURE. A skip is only
 *     honest when it describes an environment that was never asked to prove
 *     this; in the job that IS asked, a runner-image change (Windows) or a
 *     missing service container must break the build loudly instead of turning
 *     the only real-signal proof into a green no-op.
 *
 * Env: DATABASE_URL (CI points it at the postgres service container), and
 * LIVE_DRAIN_REQUIRE_REAL_SIGNAL=1 to demand that this check really runs. The
 * throwaway URL is derived by swapping its database name and CREATE/DROP happen
 * over the `postgres` database, exactly like scripts/verify_fresh_install.mjs.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

import { hashPassword } from '../server/src/middleware/auth';

dotenv.config();

const ROOT = process.cwd();
/** Dedicated name: the concurrency tests run in parallel and own their own. */
const TEST_DB = 'inventory_drain_test';
const LOGIN_EMAIL = 'drain-check@example.com';
const LOGIN_PASSWORD = 'DrainCheck@Test1';
/** Generous: the entry imports express + vite + pg, and dbBoot applies schema.sql. */
const HEALTH_TIMEOUT_MS = 120_000;
/** Fail-safe: a hung child is killed so an assertion reports SIGKILL instead of hanging. */
const EXIT_TIMEOUT_MS = 60_000;
/** Handed to the child as SHUTDOWN_TIMEOUT_MS, so a slow machine cannot force-close the response. */
const DRAIN_BUDGET_MS = 30_000;

/** Whether this platform can deliver a POSIX signal to a child process. */
const POSIX_SIGNALS = process.platform !== 'win32';

/**
 * CI sets this: "this environment is supposed to run the real-signal proof".
 * With it, every precondition that would otherwise skip becomes a failure —
 * see the header note. Local runs leave it unset and keep skipping normally.
 */
const REQUIRE_REAL_RUN = process.env.LIVE_DRAIN_REQUIRE_REAL_SIGNAL === '1';

/**
 * Raised when the environment PROMISED to run this check and then could not.
 * Deliberately an assertion-style failure, never a skip: the whole point of
 * this check is that it cannot silently disappear from CI.
 */
function unmetPrecondition(what: string, detail: string): never {
  throw new Error(
    `LIVE_DRAIN_REQUIRE_REAL_SIGNAL=1 (this environment must run the real-signal drain proof), but ` +
      `${what}: ${detail}.\nWhile that env var is set a skip would mean CI reports green without ever ` +
      'exercising a drained shutdown of the real entry, so it fails instead. The value is set by ' +
      '.github/workflows/ci.yml — check the runner image (a POSIX signal must be deliverable), the ' +
      'PostgreSQL service container, DATABASE_URL, and CREATEDB for the service user.'
  );
}

const tsxCli = (() => {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli');
  } catch {
    return path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  }
})();

/** Parse a PostgreSQL URL and swap in another database name. */
function withDbName(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A port nothing is bound to right now (the child needs a fixed PORT to be reachable). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

/** True while something is accepting connections on `port`. */
function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(2_000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

interface BootedChild {
  child: ChildProcess;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  hasExited: () => boolean;
}

/** Boots the real entry against the throwaway database, in the deployment's own shape. */
function bootEntry(drainUrl: string, port: number): BootedChild {
  const url = new URL(drainUrl);
  const child = spawn(process.execPath, [tsxCli, path.join('server', 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: drainUrl,
      // db.ts also passes the discrete POSTGRES_* options, whose DEFAULTS (host
      // localhost, database inventory_db) name the APPLICATION database.
      // Measured on pg 8.23: connectionString wins over the discrete fields, so
      // DATABASE_URL alone is already decisive — these are pinned to the same
      // throwaway values anyway, so no precedence question (or a future change
      // in either direction) can aim this boot at the application database.
      POSTGRES_HOST: url.hostname,
      POSTGRES_PORT: url.port || '5432',
      POSTGRES_DB: decodeURIComponent(url.pathname.replace(/^\//, '')),
      POSTGRES_USER: decodeURIComponent(url.username),
      POSTGRES_PASSWORD: decodeURIComponent(url.password),
      PORT: String(port),
      // The deployment's exact policy: no Vite middleware, exit-on-fatal on.
      NODE_ENV: 'production',
      SHUTDOWN_TIMEOUT_MS: String(DRAIN_BUDGET_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  let exited = false;
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));

  const exitedPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const failSafe = setTimeout(() => child.kill('SIGKILL'), EXIT_TIMEOUT_MS);
      child.on('exit', (code, signal) => {
        clearTimeout(failSafe);
        exited = true;
        resolve({ code, signal });
      });
      child.on('error', (err) => {
        clearTimeout(failSafe);
        reject(err);
      });
    }
  );

  return { child, output: () => output, exited: exitedPromise, hasExited: () => exited };
}

async function waitForOutput(booted: BootedChild, pattern: RegExp, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (pattern.test(booted.output())) return;
    if (booted.hasExited()) break;
    await delay(20);
  }
  throw new Error(
    `timed out waiting for ${label} (${pattern})${booted.hasExited() ? ' — the server exited' : ''}\n` +
      booted.output().slice(-4_000)
  );
}

async function waitForHealthy(booted: BootedChild, port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (booted.hasExited()) {
      const exit = await booted.exited;
      throw new Error(
        `the server entry exited on its own (code ${exit.code}, signal ${exit.signal}) before ` +
          `answering /api/health\n${booted.output().slice(-4_000)}`
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await delay(250);
  }
  throw new Error(
    `the server entry did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s\n` +
      booted.output().slice(-4_000)
  );
}

interface HeldRequest {
  response: Promise<{ status: number; json: any }>;
  /** Sends the withheld tail of the body — call it only AFTER the signal. */
  complete: () => void;
}

/**
 * Starts a login POST whose body is deliberately incomplete. express.json()
 * waits for the declared Content-Length, so the request is inside the server
 * (counted by the lifecycle's in-flight listener) while the route handler has
 * not run yet — the window the signal has to land in.
 */
function startHeldLogin(port: number, body: string): HeldRequest {
  const sent = 8;
  const request = http.request({
    host: '127.0.0.1',
    port,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  });

  const response = new Promise<{ status: number; json: any }>((resolve, reject) => {
    request.on('response', (res) => {
      const chunks: string[] = [];
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => chunks.push(chunk));
      res.on('end', () => {
        let json: any = null;
        try {
          json = JSON.parse(chunks.join(''));
        } catch {
          // The caller asserts on the status; a non-JSON body is still a finding.
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
      res.on('error', reject);
    });
    request.on('error', reject);
  });

  request.write(body.slice(0, sent));
  return { response, complete: () => request.end(body.slice(sent)) };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * CREATE DATABASE, retried. Several test files create their own throwaway
 * databases in parallel, so a transient failure must not be read as "this
 * environment cannot do it" — that is precisely the case that has to FAIL
 * rather than skip (see the header note).
 */
async function createDatabase(admin: pg.Pool, dbName: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      return;
    } catch (err) {
      lastError = err;
      await delay(250 * attempt);
    }
  }
  throw new Error(
    `could not create the throwaway database "${dbName}" on a REACHABLE PostgreSQL after 3 attempts: ` +
      `${describeError(lastError)}. This check needs CREATEDB (the CI service superuser has it) and ` +
      'fails instead of skipping, so the CI proof cannot silently disappear.'
  );
}

/** Drops a database, terminating any backend still attached to it first. */
async function dropDatabase(admin: pg.Pool, dbName: string): Promise<void> {
  await admin
    .query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    )
    .catch(() => {});
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  }
}

describe('live drain on the real server entry', () => {
  let adminPool: pg.Pool | null = null; // connects to 'postgres' for CREATE/DROP
  let dbPool: pg.Pool | null = null;
  let drainUrl: string | null = null;
  let dbReachable = false;
  let booted: BootedChild | null = null;

  before(async () => {
    // Nothing to prepare for a test that will not run (the platform skip) — the
    // test body is what reports the platform precondition when CI demands it.
    if (!POSIX_SIGNALS) return;
    const base = process.env.DATABASE_URL;
    if (!base) {
      if (REQUIRE_REAL_RUN) {
        unmetPrecondition('DATABASE_URL is not set', 'the real boot has no database to connect to');
      }
      return;
    }
    drainUrl = withDbName(base, TEST_DB);
    try {
      adminPool = new pg.Pool({
        connectionString: withDbName(base, 'postgres'),
        max: 2,
        connectionTimeoutMillis: 2_000,
      });
      await adminPool.query('SELECT 1');
      dbReachable = true;
    } catch (err) {
      dbReachable = false;
      // A promised run that cannot reach PostgreSQL is a failure here, before
      // anything else, so the message names the connection problem.
      if (REQUIRE_REAL_RUN) {
        unmetPrecondition(
          'the PostgreSQL in DATABASE_URL is not reachable',
          describeError(err)
        );
      }
      return;
    }
    // Reachable means CREATE/DROP are supposed to work here: a failure now is a
    // failure, not a skip (see the header note on disappearing checks).
    await dropDatabase(adminPool, TEST_DB);
    await createDatabase(adminPool, TEST_DB);
  });

  after(async () => {
    try {
      if (booted && !booted.hasExited()) booted.child.kill('SIGKILL');
      if (booted) await booted.exited.catch(() => {});
      if (dbPool) {
        await dbPool.end().catch(() => {});
        dbPool = null;
      }
      if (adminPool && dbReachable && drainUrl) await dropDatabase(adminPool, TEST_DB);
    } finally {
      if (adminPool) await adminPool.end().catch(() => {});
    }
  });

  test(
    'a real SIGTERM lets an in-flight request complete, then the process exits 0',
    {
      // Only a platform that cannot deliver the signal AND was not promised a
      // real run may skip; with the CI env var set the body runs and fails.
      skip:
        POSIX_SIGNALS || REQUIRE_REAL_RUN
          ? false
          : 'Windows cannot deliver a POSIX signal to a child — Node terminates it instead of running ' +
            'its handlers, so this real-signal check is proven in Linux CI only ' +
            '(the drain semantics themselves are covered cross-platform by lifecycleProcess.test.ts)',
    },
    async (t) => {
      if (!POSIX_SIGNALS) {
        // Reached only when REQUIRE_REAL_RUN is set (the skip above swallows it
        // otherwise), i.e. exactly the case that must not pass as a green skip.
        unmetPrecondition(
          'this platform cannot deliver a POSIX signal to a child process',
          `process.platform is "${process.platform}"`
        );
      }
      if (!dbReachable || !drainUrl) {
        if (REQUIRE_REAL_RUN) {
          unmetPrecondition(
            'no live PostgreSQL is available to boot the real entry against',
            'the before() hook could not prepare a throwaway database'
          );
        }
        t.skip('PostgreSQL not reachable — the real boot needs a live database');
        return;
      }

      const port = await freePort();
      const server = bootEntry(drainUrl, port);
      booted = server;
      await waitForHealthy(server, port);

      const pool = new pg.Pool({ connectionString: drainUrl, max: 2, connectionTimeoutMillis: 5_000 });
      dbPool = pool;

      // Isolation proof: the child's own boot created and seeded the schema in
      // THIS database. Had it booted against the application database (a
      // precedence trap db.ts invites — DATABASE_URL and the discrete
      // POSTGRES_* options are both passed), this query would hit a missing
      // table or an unseeded one instead.
      const assertedDb = await pool.query('SELECT current_database() AS db');
      assert.equal(assertedDb.rows[0].db, TEST_DB, 'this test must assert against its own throwaway');
      const seeded = await pool.query('SELECT count(*)::int AS users FROM users');
      assert.ok(
        seeded.rows[0].users > 0,
        'the boot must have applied schema.sql and seeded the throwaway database — an empty (or ' +
          'schemeless) throwaway means the child booted against some other database'
      );

      // Credentials are provisioned here rather than assumed: CI's databases are
      // FRESH, so no test may rely on seeded users (the lesson recorded in
      // tests/auth.branch.guard.test.ts).
      await pool.query(
        `INSERT INTO branches (id, code, name, location)
         VALUES ('DRN01', 'DRN01', 'Drain Check Branch', 'Test Location')
         ON CONFLICT (id) DO NOTHING`
      );
      await pool.query(
        `INSERT INTO users (id, name, email, password, role, branch_id)
         VALUES ('u-drain-check', 'Drain Check', $1, $2, 'INVENTORY_MANAGER', 'DRN01')
         ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password`,
        [LOGIN_EMAIL, hashPassword(LOGIN_PASSWORD)]
      );

      const request = startHeldLogin(port, JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }));
      request.response.catch(() => {}); // observed below, not a node:test unhandled rejection
      await delay(500); // the partial body has reached the server

      const signalledAt = Date.now();
      server.child.kill('SIGTERM');

      // The overlap proof: the child counted the held request as in flight when
      // the signal arrived. `draining 0` would mean the request was not really
      // in flight here and the rest of this test would prove nothing.
      await waitForOutput(
        server,
        /Received SIGTERM — draining 1 in-flight request\(s\)/,
        'the drain to start with exactly one in-flight request'
      );

      // Complete the body only now, after the signal: the login handler runs
      // (scrypt verify + a users query) during the drain and must answer.
      request.complete();
      const response = await request.response;
      assert.equal(
        response.status,
        200,
        `the in-flight request must complete with a real response, got ${response.status}: ` +
          `${JSON.stringify(response.json)}`
      );
      assert.ok(
        response.json?.token,
        'a 200 login carries a token, so a real PostgreSQL round trip succeeded mid-drain'
      );

      const exit = await server.exited;
      assert.equal(exit.signal, null, 'the SIGTERM handler must win over the default kill');
      assert.equal(
        exit.code,
        0,
        `a drained shutdown exits 0 by itself, got ${exit.code}\n${server.output().slice(-2_000)}`
      );
      assert.match(server.output(), /Shutdown complete — exiting 0/);
      assert.ok(
        Date.now() - signalledAt < DRAIN_BUDGET_MS,
        'the drain must have finished inside its bound, not by force-closing the response'
      );
      assert.equal(
        await portAcceptsConnections(port),
        false,
        'the listener must be released once the process has exited'
      );
    }
  );
});
