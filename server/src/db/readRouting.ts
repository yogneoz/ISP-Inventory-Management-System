/**
 * SCALE-3 — deliberate read/write split with a replication lag guard.
 *
 * The application has one write path (the primary, `DATABASE_WRITE_URL`) and an
 * optional lag-tolerant read path (a streaming replica, `DATABASE_READ_URL`).
 * `REPORT_DATABASE_URL` / `READ_REPLICA_DATABASE_URL` stay accepted as aliases so
 * an install configured before this change keeps working, and a deployment with
 * a single URL keeps every read on the primary exactly as before.
 *
 * Two rules make the split safe rather than merely fast:
 *
 *  1. **No read on the replica inside a request that has written.** A request
 *     that inserts or updates must be able to see its own write; PostgreSQL's
 *     streaming replica may not have replayed it yet. The request context below
 *     records the first write and every later replica-eligible read in that
 *     request goes to the primary instead.
 *  2. **No stale read served silently.** Before a reporting read is sent to the
 *     replica, the guard measures its lag. Over `REPLICA_MAX_LAG_MS`, or if the
 *     replica cannot be reached or does not answer the probe, the read goes to
 *     the primary. The user never sees a replication error and never sees a
 *     read older than the threshold.
 *
 * ## The lag signal
 *
 * `lagMs = now() - pg_last_xact_replay_timestamp() *only while WAL is pending*`
 * — i.e. while `pg_last_wal_receive_lsn() > pg_last_wal_replay_lsn()`. The WAL
 * gap is the authoritative part: it is what the replica still has to apply. The
 * timestamp turns that gap into the milliseconds the threshold is expressed in.
 * When nothing is pending the replica is current, so the lag is 0 even if the
 * last transaction it replayed was hours ago — using the bare timestamp there
 * would report a healthy idle replica as stale and disable the read path for no
 * reason. The byte gap is recorded beside it for diagnosis.
 *
 * A read URL that is not in recovery (a single-node install pointed at its own
 * primary, or a misconfigured replica URL) is treated as up to date: there is no
 * lag to guard, and refusing it would break an install that has never had a
 * replica.
 *
 * ## Threshold
 *
 * `REPLICA_MAX_LAG_MS` defaults to 5000 ms. Reporting reads are month- and
 * year-scoped statements over posted data; a five-second gap is invisible in
 * them, while a replica that is seconds behind after a checkpoint burst or an
 * analytics import is exactly the case that must fall back. A tighter default
 * (say 250 ms) would flap between the two databases during ordinary commits; a
 * looser one (30 s) would let a genuinely stalled replica serve stale trial
 * balances. It is configuration, not a constant, because the tolerance differs
 * between a reporting replica and a login replica.
 *
 * ## When the replica cannot be reached
 *
 * The read goes to the primary and the replica is marked down for
 * `REPLICA_COOLDOWN_MS` (default 10 000 ms), so a dead replica costs one
 * connect timeout rather than one per request. Health is exposed on
 * `GET /api/health` (`readRouting`) and counted in the metrics snapshot.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { intFromEnv } from '../utils/envGuard';

/** Where a replica-eligible read was served. */
export type ReadTarget = 'replica' | 'primary';

/** Why the router chose the target it did (stable strings, used in metrics). */
export type ReadRouteReason =
  | 'no-replica'
  | 'request-wrote'
  | 'replica-unreachable'
  | 'replica-lagging'
  | 'replica-not-in-recovery'
  | 'replica-error'
  | 'replica';

/** One probe of the replica. */
export type ReplicaHealth = {
  /** Did the probe query answer at all? */
  reachable: boolean;
  /** True when the probe target is a standby (pg_is_in_recovery()). */
  inRecovery: boolean;
  /** Milliseconds of WAL still to replay, or null when unknown. */
  lagMs: number | null;
  /** Bytes of WAL received but not yet replayed, or null when unknown. */
  lagBytes: number | null;
  /** When the probe was taken, epoch ms. */
  probedAt: number;
  /** The driver error when the probe failed. */
  error?: string;
};

export type ReadRouterStatus = {
  configured: boolean;
  maxLagMs: number;
  served: { replica: number; primary: number };
  lastReason: ReadRouteReason | null;
  lastHealth: ReplicaHealth | null;
};

/** The default: five seconds of replay lag is invisible to a monthly report. */
export const DEFAULT_REPLICA_MAX_LAG_MS = 5000;
/** How long a failed or slow replica is skipped before it is probed again. */
export const DEFAULT_REPLICA_COOLDOWN_MS = 10_000;
/** A healthy replica is probed at most this often (per process). */
export const DEFAULT_REPLICA_PROBE_MS = 1_000;

/** Read `REPLICA_MAX_LAG_MS` through the guarded env helper (never NaN). */
export function maxReplicaLagMs(): number {
  return intFromEnv('REPLICA_MAX_LAG_MS', DEFAULT_REPLICA_MAX_LAG_MS, {
    min: 0,
    max: 3_600_000,
  });
}

export function replicaCooldownMs(): number {
  return intFromEnv('REPLICA_COOLDOWN_MS', DEFAULT_REPLICA_COOLDOWN_MS, {
    min: 0,
    max: 3_600_000,
  });
}

export type ResolvedReadRouting = {
  /** Primary connection: every write, and every read that must see one. */
  writeUrl: string;
  /** Replica connection, or '' when this install has no replica. */
  readUrl: string;
  /** Which variable (or nothing) supplied the replica URL, for the boot log. */
  readUrlSource: 'DATABASE_READ_URL' | 'REPORT_DATABASE_URL' | 'READ_REPLICA_DATABASE_URL' | null;
};

/**
 * Resolve the two URLs. `DATABASE_WRITE_URL` wins over `DATABASE_URL`; the
 * replica URL keeps its historical aliases, in precedence order, so an existing
 * install does not have to rename anything to keep its current behaviour.
 */
export function resolveReadRouting(env: NodeJS.ProcessEnv = process.env): ResolvedReadRouting {
  const writeUrl = (env.DATABASE_WRITE_URL || env.DATABASE_URL || '').trim();
  const candidates: Array<[ResolvedReadRouting['readUrlSource'], string]> = [
    ['DATABASE_READ_URL', env.DATABASE_READ_URL || ''],
    ['REPORT_DATABASE_URL', env.REPORT_DATABASE_URL || ''],
    ['READ_REPLICA_DATABASE_URL', env.READ_REPLICA_DATABASE_URL || ''],
  ];
  for (const [source, value] of candidates) {
    const trimmed = value.trim();
    if (trimmed) return { writeUrl, readUrl: trimmed, readUrlSource: source };
  }
  return { writeUrl, readUrl: '', readUrlSource: null };
}

/**
 * Per-request record of whether this request has written. Populated by the
 * middleware in `server/src/app.ts` and by every non-read statement the primary
 * pool runs, so a reporting read that follows a write in the same request cannot
 * be served from the replica.
 */
type ReadContextStore = { wrote: boolean };
const readContextStorage = new AsyncLocalStorage<ReadContextStore>();

/** Run `fn` with a fresh request context (wrote = false). */
export function runWithReadContext<T>(fn: () => T): T {
  return readContextStorage.run({ wrote: false }, fn);
}

/** Record that this request has written; later replica reads go to the primary. */
export function markRequestWrote(): void {
  const store = readContextStorage.getStore();
  if (store) store.wrote = true;
}

/** Has the current request written? False outside a request context. */
export function requestWrote(): boolean {
  return readContextStorage.getStore()?.wrote === true;
}

/** Statement kinds that only read. Anything else marks the request as a writer. */
const READ_ONLY_LEADING = /^(select|show|explain|values|table|fetch)\b/i;

/**
 * Does this statement write? Deliberately conservative: `WITH` is treated as a
 * write (it can wrap an INSERT/UPDATE/DELETE), and so is anything unfamiliar.
 * A false positive only costs the replica's use for one request; a false
 * negative could serve a stale read after a write.
 */
export function isWriteStatement(sql: string): boolean {
  const withoutComments = sql
    .replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)/g, '')
    .trim();
  if (!withoutComments) return false;
  return !READ_ONLY_LEADING.test(withoutComments);
}

/**
 * The routing decision, as a pure function of facts.
 *
 * This is where the guard lives: the tests invert each input and assert the
 * target follows, so removing the guard cannot pass silently.
 */
export function decideReadTarget(input: {
  replicaConfigured: boolean;
  requestWrote: boolean;
  health: ReplicaHealth | null;
  maxLagMs: number;
}): { target: ReadTarget; reason: ReadRouteReason } {
  if (!input.replicaConfigured) return { target: 'primary', reason: 'no-replica' };
  if (input.requestWrote) return { target: 'primary', reason: 'request-wrote' };
  const health = input.health;
  if (!health || !health.reachable) return { target: 'primary', reason: 'replica-unreachable' };
  // A primary behind the read URL has no lag to guard: it is the source of truth.
  if (!health.inRecovery) return { target: 'replica', reason: 'replica-not-in-recovery' };
  const lagMs = health.lagMs ?? 0;
  if (lagMs > input.maxLagMs) return { target: 'primary', reason: 'replica-lagging' };
  return { target: 'replica', reason: 'replica' };
}

type Queryable = { query: (text: string, params?: any[]) => Promise<any> };

export type ReadRouterOptions = {
  writePool: Queryable;
  readPool: Queryable | null;
  maxLagMs?: number;
  cooldownMs?: number;
  probeIntervalMs?: number;
  now?: () => number;
  log?: (message: string) => void;
};

/** The probe: how far behind the replica is, in the terms the guard decides on. */
export const REPLICA_HEALTH_SQL = `
SELECT pg_is_in_recovery() AS in_recovery,
       pg_last_wal_receive_lsn() AS receive_lsn,
       pg_last_wal_replay_lsn() AS replay_lsn,
       pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) AS lag_bytes,
       CASE
         WHEN pg_is_in_recovery()
          AND pg_last_xact_replay_timestamp() IS NOT NULL
          AND pg_last_wal_receive_lsn() IS DISTINCT FROM pg_last_wal_replay_lsn()
         THEN EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000
         ELSE 0
       END AS lag_ms`;

/** Parse the probe row (exported so the test can pin the mapping). */
export function parseReplicaHealth(row: any, probedAt: number): ReplicaHealth {
  const inRecovery = row?.in_recovery === true;
  const lagBytes = row?.lag_bytes === null || row?.lag_bytes === undefined ? null : Number(row.lag_bytes);
  const lagMs = row?.lag_ms === null || row?.lag_ms === undefined ? null : Number(row.lag_ms);
  return { reachable: true, inRecovery, lagMs, lagBytes, probedAt };
}

/**
 * Build a router over two pools. `server/db.ts` wires the real pools into one;
 * `scripts/verify_read_routing.ts` wires a live standby into an identical one,
 * which is why the routing that is demonstrated is the routing that ships.
 */
export function createReadRouter(options: ReadRouterOptions) {
  const maxLagMs = options.maxLagMs ?? maxReplicaLagMs();
  const cooldownMs = options.cooldownMs ?? replicaCooldownMs();
  const probeIntervalMs = options.probeIntervalMs ?? DEFAULT_REPLICA_PROBE_MS;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((message: string) => console.warn(message));

  let lastHealth: ReplicaHealth | null = null;
  let downUntil = 0;
  const served = { replica: 0, primary: 0 };
  let lastReason: ReadRouteReason | null = null;

  async function probe(): Promise<ReplicaHealth> {
    const probedAt = now();
    if (!options.readPool) return { reachable: false, inRecovery: false, lagMs: null, lagBytes: null, probedAt, error: 'not configured' };
    try {
      const result = await options.readPool.query(REPLICA_HEALTH_SQL);
      const health = parseReplicaHealth(result.rows[0], now());
      lastHealth = health;
      return health;
    } catch (error: any) {
      const health: ReplicaHealth = {
        reachable: false,
        inRecovery: false,
        lagMs: null,
        lagBytes: null,
        probedAt,
        error: String(error?.message || error),
      };
      lastHealth = health;
      downUntil = now() + cooldownMs;
      log(`Read replica probe failed; reads go to the primary for ${cooldownMs} ms: ${health.error}`);
      return health;
    }
  }

  /** Probe, reusing the last answer while it is fresh and the replica is healthy. */
  async function health(): Promise<ReplicaHealth> {
    const at = now();
    if (lastHealth && lastHealth.reachable && at - lastHealth.probedAt < probeIntervalMs) return lastHealth;
    if (lastHealth && !lastHealth.reachable && at < downUntil) return lastHealth;
    return probe();
  }

  return {
    async query(text: string, params?: any[]) {
      if (!options.readPool) {
        lastReason = 'no-replica';
        served.primary += 1;
        return options.writePool.query(text, params);
      }
      if (requestWrote()) {
        lastReason = 'request-wrote';
        served.primary += 1;
        return options.writePool.query(text, params);
      }
      const state = await health();
      const decision = decideReadTarget({
        replicaConfigured: true,
        requestWrote: false,
        health: state,
        maxLagMs,
      });
      lastReason = decision.reason;
      if (decision.target === 'primary') {
        served.primary += 1;
        return options.writePool.query(text, params);
      }
      try {
        const result = await options.readPool.query(text, params);
        served.replica += 1;
        return result;
      } catch (error: any) {
        // The replica answered the probe but not the read: it is not usable now.
        served.primary += 1;
        lastReason = 'replica-error';
        downUntil = now() + cooldownMs;
        lastHealth = { ...(lastHealth as ReplicaHealth), reachable: false, probedAt: now(), error: String(error?.message || error) };
        log(`Read replica query failed; serving this read from the primary: ${error?.message || error}`);
        return options.writePool.query(text, params);
      }
    },

    status(): ReadRouterStatus {
      return {
        configured: Boolean(options.readPool),
        maxLagMs,
        served: { ...served },
        lastReason,
        lastHealth,
      };
    },

    /** Test/diagnostic hook: drop the cached probe so the next read measures again. */
    invalidate(): void {
      lastHealth = null;
      downUntil = 0;
    },
  };
}

export type ReadRouter = ReturnType<typeof createReadRouter>;
