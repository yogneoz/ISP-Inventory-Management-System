/**
 * In-memory sliding-window rate limiter (login brute-force mitigation —
 * audit backlog item #1).
 *
 * Design constraints:
 *  - Dependency-free: the project has no rate-limit package and the audit
 *    decision was to implement the smallest correct thing rather than add
 *    express-rate-limit.
 *  - Per-key buckets: keys are `scope:ip` (+ account when the caller
 *    supplies one), so an attacker throttling one account never locks out
 *    other users behind the same NAT, and vice versa.
 *  - Sliding window: recent hits within `windowMs` count against the limit;
 *    hits age out individually instead of resetting at a fixed boundary.
 *  - In-memory state: resets on server restart. That is acceptable for this
 *    deployment (single-process Express); a multi-instance deployment would
 *    need a shared store (the Redis pub/sub task unblocks that).
 *  - The Map is pruned lazily on each check so memory stays bounded even
 *    under distributed spoofed-IP floods (each distinct key costs one entry
 *    that expires with the window).
 */

export interface RateLimiterOptions {
  /** Maximum attempts allowed per window per key. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitVerdict {
  /** true when the attempt is allowed. */
  allowed: boolean;
  /** Attempts recorded in the current window (including this one). */
  count: number;
  /** Configured maximum. */
  limit: number;
  /** ms until the oldest hit leaves the window (0 when allowed). */
  retryAfterMs: number;
}

interface Bucket {
  /** Timestamps (ms) of hits still inside the window, ascending. */
  hits: number[];
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly max: number;
  private readonly windowMs: number;
  /** Monotonic-ish clock injection point (tests). */
  private readonly now: () => number;

  constructor(options: RateLimiterOptions, now: () => number = () => Date.now()) {
    if (!Number.isFinite(options.max) || options.max < 1) throw new Error('RateLimiter.max must be >= 1');
    if (!Number.isFinite(options.windowMs) || options.windowMs < 1) throw new Error('RateLimiter.windowMs must be >= 1');
    this.max = Math.floor(options.max);
    this.windowMs = Math.floor(options.windowMs);
    this.now = now;
  }

  /**
   * Records one attempt for `key` and returns the verdict. When the window
   * is full the attempt is NOT recorded (rejected calls do not extend the
   * block; the retry time only depends on already-recorded hits).
   */
  attempt(key: string): RateLimitVerdict {
    const nowMs = this.now();
    const windowStart = nowMs - this.windowMs;

    // Lazy prune: drop expired buckets and expired hits.
    for (const [k, bucket] of this.buckets) {
      while (bucket.hits.length > 0 && bucket.hits[0] <= windowStart) bucket.hits.shift();
      if (bucket.hits.length === 0) this.buckets.delete(k);
    }

    const bucket = this.buckets.get(key) || { hits: [] };

    if (bucket.hits.length >= this.max) {
      const oldest = bucket.hits[0];
      return {
        allowed: false,
        count: bucket.hits.length,
        limit: this.max,
        retryAfterMs: oldest + this.windowMs - nowMs,
      };
    }

    bucket.hits.push(nowMs);
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      count: bucket.hits.length,
      limit: this.max,
      retryAfterMs: 0,
    };
  }

  /**
   * Removes the most recent recorded hit for `key` (no-op when absent).
   * Used by failure-only accounting: the middleware records an attempt
   * optimistically and revokes it when the response turns out successful,
   * so per-account buckets only accumulate FAILED attempts.
   */
  revoke(key: string): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    bucket.hits.pop();
    if (bucket.hits.length === 0) this.buckets.delete(key);
  }

  /** Number of live buckets (observable for tests/ops). */
  get size(): number {
    return this.buckets.size;
  }

  /** Clears all state (tests, admin reset). */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Builds a bucket key from a request scope, client IP and optional account
 * identifier. IP extraction prefers Express' req.ip (honors trust proxy),
 * falling back to the socket address; x-forwarded-for is only consulted when
 * no direct address is available, and only its FIRST entry (the client) is
 * used so spoofed chains cannot rotate keys.
 */
export function buildRateLimitKey(scope: string, req: any, account?: string): string {
  const ip =
    (typeof req?.ip === 'string' && req.ip) ||
    (typeof req?.socket?.remoteAddress === 'string' && req.socket.remoteAddress) ||
    'unknown';
  const normalizedAccount = typeof account === 'string' ? account.trim().toLowerCase() : '';
  return normalizedAccount ? `${scope}:${ip}:${normalizedAccount}` : `${scope}:${ip}`;
}

/**
 * Key for the GLOBAL per-account bucket (no IP component). Used for
 * failure-only accounting: it throttles a targeted brute force against one
 * account even when the attacker rotates source addresses. Only failed
 * attempts accumulate here (successful ones are revoked), so legitimate
 * users are never locked out by their own successful logins.
 */
export function buildAccountRateLimitKey(scope: string, account: string): string {
  return `${scope}:account:${String(account).trim().toLowerCase()}`;
}
