import pg from 'pg';
import dotenv from 'dotenv';
import { intFromEnv, resolveDeclaredPort, strictIntFromEnv } from './src/utils/envGuard';
import {
  recordDbBreakerEvent,
  recordDbQuery,
  recordDbTimeout,
  recordPoolAcquire,
} from './src/observability/metrics';
import {
  dbBreaker,
  type DbBreakerSnapshot,
  type DbFailureKind,
} from './src/observability/dbBreaker';
import { DbBusyError, DbUnavailableError } from './src/errors/dbErrors';
import {
  createReadRouter,
  isWriteStatement,
  markRequestWrote,
  resolveReadRouting,
} from './src/db/readRouting';
import { setPgConnected } from './src/state/runtimeState';
import { assertTestLedgerPurgeBypass } from './src/db/ledgerPurgeBypass';

// dotenv's contract is "the real environment wins", which is right for every
// knob but PORT: this workstation's shell exports an ambient `PORT=0` ("any
// free port"), and nothing else, so a dev boot warned about an out-of-range
// value and fell back on every start even though `.env` names 3000. PORT is
// resolved explicitly instead: a real ambient port still wins, an unusable one
// defers to the value the project declares, and the deferral is printed rather
// than silently swallowed. Every other variable keeps the usual non-overriding
// merge, so tests that point DATABASE_URL at a throwaway database are safe.
const envFile = dotenv.config({ processEnv: {} }).parsed ?? {};
for (const [key, value] of Object.entries(envFile)) {
  if (process.env[key] === undefined) process.env[key] = value;
}
const declaredPort = resolveDeclaredPort(process.env.PORT, envFile.PORT);
if (declaredPort.port !== null && declaredPort.ambientIgnored !== null) {
  console.log(
    `ℹ️  PORT=${declaredPort.ambientIgnored} from the environment is not a usable listen port; using PORT=${declaredPort.port} from .env.`
  );
  process.env.PORT = String(declaredPort.port);
}

const { Pool: RealPgPool } = pg;

// Keep PostgreSQL DATE columns as plain 'YYYY-MM-DD' strings end-to-end.
// pg's default parser converts DATE to a JS Date at *local* midnight of the
// server process, and the resulting JSON (UTC ISO) makes the AD date shift by
// a day when clients display it (e.g. 2026-08-31 NPT reads back as
// '2026-08-30T18:15:00.000Z'). The app treats AD calendar dates as plain
// strings everywhere (client DateField, BS conversion, SQL ::text casts), so
// the DATE value must pass through untouched.
pg.types.setTypeParser(1082, (value: string) => value);

/**
 * The single database-availability setter (OPS-1).
 *
 * `server/db.ts` and `src/state/runtimeState.ts` each expose a flag because
 * ESM live bindings are consumed in both places. They must never diverge:
 * every write goes through this function, and the breaker's transition
 * listener is the only thing that flips it in response to a request outcome.
 * Boot may set it for its initial state; nothing else may.
 */
export let isPgConnected = false;

export function setDatabaseConnected(status: boolean): void {
  isPgConnected = status;
  setPgConnected(status);
}

/** Backwards-compatible alias for the many existing importers. */
export function setIsPgConnected(status: boolean): void {
  setDatabaseConnected(status);
}

export function getIsPgConnected(): boolean {
  return isPgConnected;
}

// Breaker transitions are the only request-path writer of the flag: opening
// marks the database unavailable, closing marks it usable again. Metrics are
// recorded here so every open/half-open/close is counted exactly once.
dbBreaker.onChange((event) => {
  recordDbBreakerEvent(event);
  if (event === 'opened') setDatabaseConnected(false);
  if (event === 'closed') setDatabaseConnected(true);
});

// A test file run outside scripts/run_tests.mjs has no ledger-purge startup
// option, so its teardown cannot remove the journals it posted and the next run
// fails on balances it never created. Refuse at import, before any query.
assertTestLedgerPurgeBypass();

export let realPoolInstance: any = null;

/**
 * Tunable pool settings, read through the guarded env helpers (backlog #4 /
 * the "PORT=0 trap" class): an empty, garbage, zero or out-of-range value
 * logs a warning and falls back to the documented default instead of
 * producing a pool that can never connect (max=0) or hangs forever (NaN
 * timeout). Kept as a function so tests can assert the wiring without
 * building a second pool.
 */
export function buildPoolConfig(): {
  connectionTimeoutMillis: number;
  max: number;
  idleTimeoutMillis: number;
  /**
   * Exposed for boot, which applies it to the ROLE (SCALE-3). It is deliberately
   * not a pool/startup parameter: behind a transaction-mode pooler a client's
   * startup parameters are not replayed onto the reused server connection, so a
   * per-connection timeout would be silently lost (or rejected). See
   * `src/db/statementTimeout.ts`.
   */
  statementTimeoutMs: number;
} {
  // OPS-4: a typo in a timeout is a configuration error and must stop the
  // boot with a message naming the variable, not silently become 30s. 0 is
  // the documented "disabled" value; anything 1–999 is ambiguous and rejected.
  const statementTimeoutMs = strictIntFromEnv('PG_STATEMENT_TIMEOUT_MS', 30_000, {
    min: 0,
    max: 600_000,
  });
  if (statementTimeoutMs !== 0 && statementTimeoutMs < 1_000) {
    throw new Error(
      `Invalid PG_STATEMENT_TIMEOUT_MS=${JSON.stringify(process.env.PG_STATEMENT_TIMEOUT_MS)}: ` +
        'must be 0 (disabled) or between 1000 and 600000 milliseconds.'
    );
  }
  const max = intFromEnv('PG_POOL_MAX', 40, { min: 1, max: 500 });
  return {
    connectionTimeoutMillis: intFromEnv('PG_CONNECT_TIMEOUT_MS', 2000, { min: 100, max: 120_000 }),
    // 500 concurrent users is the modelled ceiling. 20 connections made
    // ordinary page reads queue behind long report queries; 40 keeps two
    // connections per available CPU core on a typical 20-core database host
    // without exhausting PostgreSQL's default 100-connection budget.
    max,
    idleTimeoutMillis: 30000,
    statementTimeoutMs,
  };
}

/**
 * SCALE-3 read/write split: the primary is `DATABASE_WRITE_URL` when set and
 * `DATABASE_URL` otherwise, so an existing single-URL install is untouched.
 */
export const DATABASE_WRITE_URL = resolveReadRouting().writeUrl;

if (process.env.DATABASE_URL || process.env.DATABASE_WRITE_URL || process.env.POSTGRES_HOST) {
  const { statementTimeoutMs, ...poolConfig } = buildPoolConfig();
  realPoolInstance = new RealPgPool({
    connectionString: DATABASE_WRITE_URL || undefined,
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'inventory_db',
    user: process.env.POSTGRES_USER || 'inventory_user',
    password: process.env.POSTGRES_PASSWORD || 'securepassword',
    ...poolConfig,
  });
}

/**
 * Optional lag-tolerant read path: a streaming replica, or PgBouncer in front
 * of one. Reads tolerate a little replication lag and must not queue behind
 * write traffic on the primary pool. `DATABASE_READ_URL` is the name; the older
 * `REPORT_DATABASE_URL` / `READ_REPLICA_DATABASE_URL` still work, and when none
 * is set every read stays on the primary, so a single-database install is
 * unchanged.
 */
export const DATABASE_READ_URL = resolveReadRouting().readUrl;
/** Alias kept for importers and for the boot log; same value as the read URL. */
export const REPORT_DATABASE_URL = DATABASE_READ_URL;

export let reportPoolInstance: any = null;
if (DATABASE_READ_URL) {
  const { statementTimeoutMs, ...poolConfig } = buildPoolConfig();
  reportPoolInstance = new RealPgPool({
    connectionString: DATABASE_READ_URL,
    ...poolConfig,
  });
}

/** True when reporting reads are routed away from the primary. */
export function isReportingReplicaConfigured(): boolean {
  return Boolean(reportPoolInstance);
}

/**
 * Classify a database failure (OPS-1).
 *
 * `clientAcquired` decides whether a timeout proves a broken socket (a client
 * existed, so the connection was in use) or merely a saturated/unreachable
 * pool during acquire (no client was handed out). Only `server_unreachable`
 * and `socket_dropped` are allowed to count toward opening the breaker.
 */
export function classifyDbFailure(err: any, clientAcquired = true): DbFailureKind {
  const sqlState: string = typeof err?.code === 'string' ? err.code : '';
  const message: string = String(err?.message || '');

  if (/timeout exceeded when trying to connect/i.test(message)) return 'pool_acquire_timeout';
  if (sqlState === '57014') return 'statement_timeout';
  if (
    sqlState.startsWith('08') ||
    sqlState === '57P01' ||
    sqlState === '57P02' ||
    sqlState === '57P03'
  ) {
    return 'server_unreachable';
  }

  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) return 'server_unreachable';

  if (!clientAcquired) {
    // No client was handed out: ETIMEDOUT is a connect timeout, not a reset.
    return /ETIMEDOUT/i.test(message) ? 'connect_timeout' : 'connect_timeout';
  }

  if (/ECONNRESET|ETIMEDOUT|Connection terminated|connection to server|server closed the connection/i.test(message)) {
    return 'socket_dropped';
  }
  if (sqlState) return 'query_error';

  // Unknown, no SQLSTATE, but a client was in hand: stay conservative and
  // count it — but only as one of N inside the breaker's window.
  return 'socket_dropped';
}

/**
 * Backwards-compatible predicate for existing importers/tests. A failure is
 * connection-level only when it is one of the two countable breaker kinds.
 * (The breaker itself uses the categories; this wrapper is deliberately thin.)
 */
export function isConnectionLevelFailure(err: any): boolean {
  const kind = classifyDbFailure(err);
  return kind === 'server_unreachable' || kind === 'socket_dropped';
}

/** Record a classified failure and sync the flag if it opens the breaker. */
export function noteDbFailure(kind: DbFailureKind): DbBreakerSnapshot {
  if (kind === 'pool_acquire_timeout') recordDbTimeout('acquire');
  else if (kind === 'statement_timeout') recordDbTimeout('statement');
  dbBreaker.recordFailure(kind);
  return dbBreaker.snapshot();
}

/** Record an answered database operation; closes a half-open breaker. */
export function noteDbSuccess(): void {
  dbBreaker.recordSuccess();
}

function databaseErrorFor(kind: DbFailureKind, original: any): any {
  // The HTTP body must stay generic, but the boot log and incident logs still
  // need the driver's own message (ECONNREFUSED, socket reset, …). Attach the
  // original as `cause`; the central handler never serializes it.
  const withCause = (error: Error): Error => {
    (error as any).cause = original;
    return error;
  };
  if (kind === 'pool_acquire_timeout' || kind === 'statement_timeout') {
    return withCause(new DbBusyError());
  }
  if (
    kind === 'connect_timeout' ||
    kind === 'server_unreachable' ||
    kind === 'socket_dropped'
  ) {
    return withCause(new DbUnavailableError());
  }
  // A SQL/query error keeps its SQLSTATE so the central handler can map
  // unique/foreign-key violations to 409 and everything else to 500.
  return original;
}

let probePromise: Promise<boolean> | null = null;

/**
 * Rechecks a previously unavailable pool. Single-flight: every queued caller
 * shares one probe, and only its result may close the breaker. While the
 * breaker is open and the cooldown has not elapsed this returns false without
 * touching PostgreSQL, so a burst of requests cannot become a burst of probes.
 */
export function ensurePostgresConnection(): Promise<boolean> {
  if (!realPoolInstance) return Promise.resolve(false);
  if (probePromise) return probePromise;

  const attempt = dbBreaker.beginAttempt();
  if (!attempt.allowed) return Promise.resolve(false);

  probePromise = (async () => {
    try {
      await realPoolInstance.query('SELECT 1');
      noteDbSuccess();
      setDatabaseConnected(true);
      return true;
    } catch (err: any) {
      const kind = classifyDbFailure(err, false);
      console.error('PostgreSQL availability probe failed:', err?.message || err);
      noteDbFailure(kind);
      return false;
    } finally {
      probePromise = null;
    }
  })();

  return probePromise;
}

/**
 * The read router (SCALE-3). `reportingPool` runs a reporting read on the
 * replica only when the request has not written and the replica's measured lag
 * is within `REPLICA_MAX_LAG_MS`; otherwise — stale, unreachable, or after a
 * write — the read is served by the primary. A replica failure never surfaces as
 * an error to the user, and never opens the primary breaker: the replica has its
 * own failure domain.
 */
export const readRouter = createReadRouter({
  writePool: {
    async query(text: string, params?: any[]) {
      if (!isPgConnected) throw new DbUnavailableError();
      return pgPool.query(text, params);
    },
  },
  readPool: reportPoolInstance
    ? {
        async query(text: string, params?: any[]) {
          const startedAt = performance.now();
          let failed = false;
          try {
            return await reportPoolInstance.query(text, params);
          } catch (err) {
            failed = true;
            throw err;
          } finally {
            recordDbQuery(performance.now() - startedAt, text, failed);
          }
        },
      }
    : null,
});

/**
 * Reporting pool. The primary is the default; a configured replica is used
 * only by read-only reporting endpoints, never by the write/ledger path, and
 * only while the lag guard says it is safe — see `readRouter`.
 */
export const reportingPool: { query: (text: string, params?: any[]) => Promise<any> } = {
  async query(text: string, params?: any[]) {
    if (!isPgConnected) throw new DbUnavailableError();
    return readRouter.query(text, params);
  },
};

/** What the router has served and the last lag it measured, for /api/health. */
export function readRouterStatus() {
  return readRouter.status();
}

let poolWarmPromise: Promise<number> | null = null;

/**
 * Open the pool's connections up front, at boot (SCALE-3 write path).
 *
 * Establishing a PostgreSQL connection costs TCP + SCRAM + session setup, and
 * `pg` does it lazily: the first C concurrent writes each create a client, so
 * the burst pays the setup serially inside its own measured window. Warming at
 * boot moves that cost out of the request path, and `min` in the pool config
 * keeps the connections afterwards. Best effort: a failed warm never blocks
 * boot, because the pool still connects on demand.
 *
 * Single-flight, so a second boot step cannot open a second set of connections.
 */
export function warmDatabasePool(target?: number): Promise<number> {
  if (poolWarmPromise) return poolWarmPromise;
  if (!realPoolInstance) return Promise.resolve(0);
  const max = buildPoolConfig().max;
  const want = Math.max(0, Math.min(target ?? max, max));
  poolWarmPromise = (async () => {
    const held: any[] = [];
    try {
      await Promise.all(
        Array.from({ length: want }, async () => {
          try {
            held.push(await realPoolInstance.connect());
          } catch {
            /* best effort — the pool connects on demand */
          }
        })
      );
    } finally {
      for (const client of held) {
        try {
          client.release();
        } catch (_e) {}
      }
    }
    return held.length;
  })();
  return poolWarmPromise;
}

export const pgPool = {
  async query(text: string, params?: any[]) {
    if (!realPoolInstance) throw new DbUnavailableError();

    // A request must not become the half-open probe while the flag is down:
    // requirePostgres owns the probe (single-flight). Once it succeeds the
    // flag is back and normal queries resume.
    if (!isPgConnected) throw new DbUnavailableError(dbBreaker.retryAfterSeconds());

    // The breaker decides whether this request may touch PostgreSQL at all.
    // While open (and before the cooldown) this fails fast without acquiring;
    // after the cooldown exactly one request becomes the half-open probe.
    const attempt = dbBreaker.beginAttempt();
    if (!attempt.allowed) throw new DbUnavailableError(attempt.retryAfterSec);

    const startedAt = performance.now();
    let client: any = null;
    let queryStarted = false;
    let failed = false;
    let releaseError: any = null;

    const acquireStartedAt = performance.now();
    try {
      client = await realPoolInstance.connect();
      recordPoolAcquire(performance.now() - acquireStartedAt);
    } catch (err: any) {
      failed = true;
      recordPoolAcquire(performance.now() - acquireStartedAt, true);
      const kind = classifyDbFailure(err, false);
      noteDbFailure(kind);
      console.error('PostgreSQL acquire failed:', err?.message || err);
      throw databaseErrorFor(kind, err);
    }

    queryStarted = true;
    // SCALE-3: a write in this request makes later replica reads unsafe (they
    // may not see it yet), so record it before the statement runs.
    if (isWriteStatement(text)) markRequestWrote();
    try {
      return await client.query(text, params);
    } catch (err: any) {
      failed = true;
      const kind = classifyDbFailure(err, true);

      if (kind === 'statement_timeout') {
        // PostgreSQL answered (with a cancellation): the server is alive.
        recordDbTimeout('statement');
        noteDbSuccess();
        console.error('PostgreSQL statement timed out:', err?.message || err);
        throw databaseErrorFor('statement_timeout', err);
      }

      if (kind === 'server_unreachable' || kind === 'socket_dropped') {
        releaseError = err;
        noteDbFailure(kind);
        console.error('PostgreSQL connection failed:', err?.message || err);
        throw databaseErrorFor(kind, err);
      }

      // A SQL error (constraint, syntax, ...) proves the connection works;
      // it must never accumulate toward an outage.
      noteDbSuccess();
      console.error('PostgreSQL query failed:', err?.message || err);
      throw err;
    } finally {
      if (client && typeof client.release === 'function') {
        try {
          client.release(releaseError);
        } catch (_e) {}
      }
      if (queryStarted) recordDbQuery(performance.now() - startedAt, text, failed);
    }
  },

  async connect() {
    if (!realPoolInstance) {
      throw new Error('PostgreSQL connection is not configured.');
    }
    const attempt = dbBreaker.beginAttempt();
    if (!attempt.allowed) throw new DbUnavailableError(attempt.retryAfterSec);

    const startedAt = performance.now();
    try {
      const client = await realPoolInstance.connect();
      recordPoolAcquire(performance.now() - startedAt);
      noteDbSuccess();
      return client;
    } catch (err: any) {
      recordPoolAcquire(performance.now() - startedAt, true);
      const kind = classifyDbFailure(err, false);
      noteDbFailure(kind);
      throw databaseErrorFor(kind, err);
    }
  },
};
