/**
 * Database availability circuit breaker (OPS-1).
 *
 * The pool used to flip a single boolean on the first connection-level error,
 * which turned a brief socket reset into a whole-API outage until a re-probe.
 * This breaker is the only thing allowed to decide that PostgreSQL is down:
 *
 *   - only failures that prove the database did not answer count
 *     (`server_unreachable`, `socket_dropped`); a saturated pool, a statement
 *     timeout or a SQL error never does;
 *   - `failureThreshold` countable failures inside `windowMs` open it;
 *   - while open, requests fail fast with 503 + Retry-After instead of
 *     queueing on a database that is not there;
 *   - after `cooldownMs` exactly one probe is allowed (half-open). Success
 *     closes and resets; failure re-opens and doubles the cooldown up to
 *     `maxCooldownMs`.
 *
 * The state machine is pure and clock-injectable so its transitions are
 * testable without a database or real time. `dbBreaker` is the process
 * singleton wired to the pool.
 */
import { strictIntFromEnv } from '../utils/envGuard';

export type DbFailureKind =
  | 'pool_acquire_timeout'
  | 'connect_timeout'
  | 'statement_timeout'
  | 'query_error'
  | 'server_unreachable'
  | 'socket_dropped';

export type DbBreakerState = 'closed' | 'open' | 'half_open';
export type DbBreakerEvent = 'opened' | 'half_open' | 'closed';

export interface DbBreakerConfig {
  failureThreshold: number;
  windowMs: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
}

export interface DbBreakerSnapshot {
  state: DbBreakerState;
  failuresInWindow: number;
  failureThreshold: number;
  openedAt: number | null;
  cooldownMs: number;
  retryAfterSeconds: number;
  halfOpenInFlight: boolean;
  opens: number;
  halfOpenProbes: number;
  lastFailureKind: DbFailureKind | null;
}

export const DEFAULT_DB_BREAKER_CONFIG: DbBreakerConfig = {
  failureThreshold: 3,
  windowMs: 30_000,
  baseCooldownMs: 5_000,
  maxCooldownMs: 30_000,
};

const COUNTABLE_FAILURES: ReadonlySet<DbFailureKind> = new Set<DbFailureKind>([
  'server_unreachable',
  'socket_dropped',
]);

/** True when a failure means the database itself did not answer. */
export function isCountableDbFailure(kind: DbFailureKind): boolean {
  return COUNTABLE_FAILURES.has(kind);
}

/** Breaker tunables, read once at module load through the guarded parser. */
export function dbBreakerConfigFromEnv(): DbBreakerConfig {
  // OPS-4: these are boot-time configuration, not per-request fallbacks. An
  // invalid threshold or cooldown must name itself and refuse to start.
  const baseCooldownMs = strictIntFromEnv('DB_BREAKER_COOLDOWN_MS', 5_000, {
    min: 10,
    max: 600_000,
  });
  return {
    failureThreshold: strictIntFromEnv('DB_BREAKER_FAILURE_THRESHOLD', 3, {
      min: 1,
      max: 100,
    }),
    windowMs: strictIntFromEnv('DB_BREAKER_WINDOW_MS', 30_000, { min: 100, max: 3_600_000 }),
    baseCooldownMs,
    maxCooldownMs: strictIntFromEnv('DB_BREAKER_MAX_COOLDOWN_MS', Math.max(30_000, baseCooldownMs), {
      min: baseCooldownMs,
      max: 3_600_000,
    }),
  };
}

/** Retry-After for a single failed request; distinct from breaker cooldown. */
const DB_RETRY_AFTER_SECONDS = strictIntFromEnv('DB_RETRY_AFTER_SECONDS', 2, {
  min: 1,
  max: 300,
});
export function dbRetryAfterSeconds(): number {
  return DB_RETRY_AFTER_SECONDS;
}

export class DbBreaker {
  private config: DbBreakerConfig;
  private state: DbBreakerState = 'closed';
  private failureTimes: number[] = [];
  private openedAt: number | null = null;
  private cooldownMs: number;
  private inFlight = false;
  private opens = 0;
  private halfOpenProbes = 0;
  private lastFailureKind: DbFailureKind | null = null;
  private listeners: Array<(event: DbBreakerEvent) => void> = [];

  constructor(config: Partial<DbBreakerConfig> = {}) {
    this.config = { ...DEFAULT_DB_BREAKER_CONFIG, ...config };
    if (this.config.maxCooldownMs < this.config.baseCooldownMs) {
      this.config.maxCooldownMs = this.config.baseCooldownMs;
    }
    this.cooldownMs = this.config.baseCooldownMs;
  }

  /** Subscribe to transitions. Returns an unsubscribe function. */
  onChange(listener: (event: DbBreakerEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  private emit(event: DbBreakerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A metrics/flag listener must never break the availability decision.
      }
    }
  }

  private reopen(now: number): void {
    this.opens += 1;
    this.cooldownMs = Math.min(
      this.config.baseCooldownMs * 2 ** (this.opens - 1),
      this.config.maxCooldownMs
    );
    this.state = 'open';
    this.openedAt = now;
    this.failureTimes = [];
    this.inFlight = false;
    this.emit('opened');
  }

  /**
   * Record the outcome of an attempt. Non-countable kinds never open the
   * breaker from closed, but a failed half-open probe always re-opens it —
   * the probe is the one chance to prove the database is back.
   */
  recordFailure(kind: DbFailureKind, now = Date.now()): void {
    this.lastFailureKind = kind;

    if (this.state === 'half_open') {
      // A stray failure with no probe outstanding is not the probe result.
      if (!this.inFlight) return;
      this.reopen(now);
      return;
    }

    // Already open: nothing new to decide until the cooldown probe. A failure
    // recorded here is a late result from a request admitted before the open.
    if (this.state === 'open') return;
    if (!isCountableDbFailure(kind)) return;

    this.failureTimes.push(now);
    const cutoff = now - this.config.windowMs;
    this.failureTimes = this.failureTimes.filter((at) => at > cutoff);
    if (this.failureTimes.length >= this.config.failureThreshold) {
      this.reopen(now);
    }
  }

  /** Any answered query (including a SQL error) proves the database is back. */
  recordSuccess(_now = Date.now()): void {
    const wasDown = this.state !== 'closed';
    const hadProbe = this.inFlight;
    this.state = 'closed';
    this.openedAt = null;
    this.failureTimes = [];
    this.inFlight = false;
    this.opens = 0;
    this.cooldownMs = this.config.baseCooldownMs;
    if (wasDown || hadProbe) this.emit('closed');
  }

  /**
   * Ask permission to touch the database. While open this returns false until
   * the cooldown elapses; the first allowed call becomes the single half-open
   * probe, and every other caller is refused until that probe settles.
   */
  beginAttempt(now = Date.now()): { allowed: boolean; probe: boolean; retryAfterSec: number } {
    if (this.state === 'closed') return { allowed: true, probe: false, retryAfterSec: 0 };

    if (this.state === 'half_open') {
      if (this.inFlight) {
        return { allowed: false, probe: true, retryAfterSec: this.retryAfterSeconds(now) };
      }
      this.inFlight = true;
      this.halfOpenProbes += 1;
      this.emit('half_open');
      return { allowed: true, probe: true, retryAfterSec: 0 };
    }

    if (this.openedAt !== null && now - this.openedAt >= this.cooldownMs) {
      this.state = 'half_open';
      this.inFlight = true;
      this.halfOpenProbes += 1;
      this.emit('half_open');
      return { allowed: true, probe: true, retryAfterSec: 0 };
    }

    return { allowed: false, probe: true, retryAfterSec: this.retryAfterSeconds(now) };
  }

  isOpen(): boolean {
    return this.state !== 'closed';
  }

  retryAfterSeconds(now = Date.now()): number {
    if (this.state === 'open' && this.openedAt !== null) {
      return Math.max(1, Math.ceil((this.openedAt + this.cooldownMs - now) / 1000));
    }
    return this.state === 'half_open' ? 1 : 0;
  }

  snapshot(now = Date.now()): DbBreakerSnapshot {
    const cutoff = now - this.config.windowMs;
    return {
      state: this.state,
      failuresInWindow: this.failureTimes.filter((at) => at > cutoff).length,
      failureThreshold: this.config.failureThreshold,
      openedAt: this.openedAt,
      cooldownMs: this.cooldownMs,
      retryAfterSeconds: this.retryAfterSeconds(now),
      halfOpenInFlight: this.inFlight,
      opens: this.opens,
      halfOpenProbes: this.halfOpenProbes,
      lastFailureKind: this.lastFailureKind,
    };
  }

  /**
   * Test/operator reset: forget every failure and close immediately. It does
   * not emit `closed`, because that event also marks the database connected;
   * a reset must not claim connectivity without a successful probe.
   */
  reset(): void {
    this.state = 'closed';
    this.openedAt = null;
    this.failureTimes = [];
    this.cooldownMs = this.config.baseCooldownMs;
    this.inFlight = false;
    this.opens = 0;
    this.halfOpenProbes = 0;
    this.lastFailureKind = null;
  }
}

/** Process singleton — the only breaker the pool and middleware consult. */
export const dbBreaker = new DbBreaker(dbBreakerConfigFromEnv());
