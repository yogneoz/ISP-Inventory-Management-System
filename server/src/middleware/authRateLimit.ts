/**
 * Rate-limiting middleware for the authentication endpoints (login,
 * forgot-password) — closes the brute-force gap flagged by the project
 * audit. Uses the dependency-free sliding-window limiter in
 * utils/rateLimiter.ts with two independent bucket dimensions:
 *
 *   - ip (counts ALL attempts):      `scope:<ip>`
 *     Caps attempt rate per client address. Stops one host spraying many
 *     accounts. Accounts rotating do not help the attacker.
 *
 *   - account (GLOBAL, FAILURE-ONLY): `scope:account:<email>`
 *     One bucket per account across all addresses, but only FAILED
 *     attempts accumulate — the middleware records optimistically and
 *     revokes the hit after a successful response. This throttles a
 *     distributed attack targeting ONE account without letting attackers
 *     lock the account out (legitimate successful logins clear their own
 *     hit), and never affects other accounts.
 *
 * A request is rejected when EITHER bucket is exhausted.
 *
 * Configuration (documented in .env.example; defaults are safe without it):
 *   AUTH_RATE_LIMIT_MAX       per-account FAILURES per window (default 4)
 *   AUTH_RATE_LIMIT_IP_MAX    per-IP attempts per window (default 10)
 *   AUTH_RATE_LIMIT_WINDOW_MS window length (default 60000 = 1 minute)
 *   AUTH_RATE_LIMIT_DISABLED  "1"/"true" disables the limiter (tests/dev)
 *
 * Responses: 429 with Retry-After (seconds) and a JSON body; every admission
 * also reports `X-Auth-Attempts-Remaining` (and, on a failure, the same number
 * as `attemptsRemaining` in the body) so the sign-in screen can warn BEFORE
 * the cutoff instead of only after it. The limiter itself leaks nothing about
 * account existence. Limiter failures never take down auth: errors are logged
 * and the request proceeds (fail-open).
 *
 * Manual release: the buckets live in this process's memory, so only the
 * running server can clear them — `releaseAuthRateLimit` is exposed through an
 * admin-only endpoint (`GET`/`POST /api/auth/rate-limit*`) rather than a script.
 */
import type { Request, Response, NextFunction } from 'express';
import { RateLimiter, buildRateLimitKey, buildAccountRateLimitKey } from '../utils/rateLimiter';
import type { RateLimitVerdict } from '../utils/rateLimiter';
import { intFromEnv } from '../utils/envGuard';
import { isRedisSharedState, getSharedStore } from '../state/sharedStore';
import { SharedRateLimiter } from '../state/sharedRateLimiter';

// Strict env parsing (backlog #4): garbage values warn and fall back instead
// of becoming NaN or 0 (a zero window/max would hard-lock or fully disable
// the brute-force guard).
// One-minute window: a throttled operator waits at most a minute before
// retrying, instead of up to the quarter hour the original 900 000 ms window
// imposed.
//
// The two buckets carry SEPARATE budgets because they answer different
// threats, and one number cannot serve both:
//   - per-IP (every attempt, successes included) stays at 10 per minute. It
//     caps a single host spraying many accounts, and it cannot go lower
//     without breaking the project's own auth contract test, which makes six
//     login attempts from one address in a single run
//     (tests/auth.branch.guard.test.ts).
//   - per-account (FAILURES only) is 4 per minute: the budget an operator
//     actually feels, so four bad passwords cost a 60-second wait rather than
//     a 15-minute lockout.
// Neither reproduces the old 40 attempts/hour exactly (that is less than one
// attempt per minute); sustained guessing is now 240/hour per account and
// 600/hour per address.
const WINDOW_MS = intFromEnv('AUTH_RATE_LIMIT_WINDOW_MS', 60_000, { min: 1000, max: 86_400_000 });
const MAX_ATTEMPTS = intFromEnv('AUTH_RATE_LIMIT_MAX', 4, { min: 1, max: 10_000 });
const MAX_IP_ATTEMPTS = intFromEnv('AUTH_RATE_LIMIT_IP_MAX', 10, { min: 1, max: 10_000 });
const DISABLED = process.env.AUTH_RATE_LIMIT_DISABLED === '1' || process.env.AUTH_RATE_LIMIT_DISABLED === 'true';

const ipLimiter = new RateLimiter({ max: MAX_IP_ATTEMPTS, windowMs: WINDOW_MS });
const accountLimiter = new RateLimiter({ max: MAX_ATTEMPTS, windowMs: WINDOW_MS });

let sharedStoreRef: any = null;
let sharedIpLimiter: SharedRateLimiter | null = null;
let sharedAccountLimiter: SharedRateLimiter | null = null;
function sharedLimiters(): { ip: SharedRateLimiter; account: SharedRateLimiter } | null {
  if (!isRedisSharedState()) return null;
  const store = getSharedStore();
  if (sharedStoreRef !== store) {
    sharedStoreRef = store;
    sharedIpLimiter = new SharedRateLimiter(store, { max: MAX_IP_ATTEMPTS, windowMs: WINDOW_MS });
    sharedAccountLimiter = new SharedRateLimiter(store, { max: MAX_ATTEMPTS, windowMs: WINDOW_MS });
  }
  return { ip: sharedIpLimiter!, account: sharedAccountLimiter! };
}

/** Every scope the auth limiter guards. Release/report cover all of them. */
export const AUTH_RATE_LIMIT_SCOPES = ['auth-login', 'auth-forgot'] as const;

export interface AuthRateLimitBlock {
  scope: string;
  kind: 'account' | 'ip';
  /** Account email, or client address for an ip bucket. */
  target: string;
  attempts: number;
  limit: number;
  retryAfterSec: number;
}

/**
 * Splits a bucket key back into its parts. Keys are built as
 * `${scope}:account:${email}` or `${scope}:${ip}` (an IPv6 address keeps its
 * colons because only the scope prefix and the `account:` marker are parsed).
 */
function parseBucketKey(key: string): { scope: string; kind: 'account' | 'ip'; target: string } | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;
  const scope = key.slice(0, separator);
  const rest = key.slice(separator + 1);
  if (!rest) return null;
  const accountPrefix = 'account:';
  // Only the `account:` marker distinguishes the dimensions; an address keeps
  // its own colons (IPv6), which is why this is not a naive split.
  return rest.startsWith(accountPrefix)
    ? { scope, kind: 'account', target: rest.slice(accountPrefix.length) }
    : { scope, kind: 'ip', target: rest };
}

function blocksFromEntries(entries: Array<{ key: string; count: number; limit: number; retryAfterMs: number }>): AuthRateLimitBlock[] {
  const blocks: AuthRateLimitBlock[] = [];
  for (const entry of entries) {
    const parsed = parseBucketKey(entry.key);
    if (!parsed) continue;
    blocks.push({
      ...parsed,
      attempts: entry.count,
      limit: entry.limit,
      retryAfterSec: Math.max(1, Math.ceil(entry.retryAfterMs / 1000)),
    });
  }
  return blocks.sort((a, b) => b.retryAfterSec - a.retryAfterSec);
}

/** Who the local limiter is blocking (single-worker mode). */
export function listAuthRateLimitBlocks(): AuthRateLimitBlock[] {
  return blocksFromEntries([...accountLimiter.snapshot(), ...ipLimiter.snapshot()]);
}

/** Who the shared limiter is blocking (Redis mode). */
export async function listAuthRateLimitBlocksShared(): Promise<AuthRateLimitBlock[]> {
  const shared = sharedLimiters();
  if (!shared) return listAuthRateLimitBlocks();
  const [account, ip] = await Promise.all([shared.account.snapshot(), shared.ip.snapshot()]);
  return blocksFromEntries([...account, ...ip]);
}

export interface ReleaseAuthRateLimitInput {
  email?: string;
  ip?: string;
  all?: boolean;
}

/**
 * Clears login buckets for one account, one client address, or everything.
 * Releasing an address frees every account behind it — that is inherent to the
 * per-IP bucket, and the admin panel says so.
 */
export function releaseAuthRateLimit(input: ReleaseAuthRateLimitInput): { released: number } {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const ip = typeof input.ip === 'string' ? input.ip.trim() : '';
  const all = input.all === true;
  if (!all && !email && !ip) {
    throw new Error('releaseAuthRateLimit needs an email, an ip, or all=true');
  }
  const matches = (key: string): boolean => {
    if (all) return true;
    const parsed = parseBucketKey(key);
    if (!parsed) return false;
    if (email && parsed.kind === 'account' && parsed.target === email) return true;
    if (ip && parsed.kind === 'ip' && parsed.target === ip) return true;
    return false;
  };
  const accountKeys = accountLimiter.clearMatching(matches);
  const ipKeys = ipLimiter.clearMatching(matches);
  return { released: accountKeys.length + ipKeys.length };
}

export async function releaseAuthRateLimitShared(input: ReleaseAuthRateLimitInput): Promise<{ released: number }> {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const ip = typeof input.ip === 'string' ? input.ip.trim() : '';
  const all = input.all === true;
  if (!all && !email && !ip) throw new Error('releaseAuthRateLimit needs an email, an ip, or all=true');
  const matches = (key: string): boolean => {
    if (all) return true;
    const parsed = parseBucketKey(key);
    if (!parsed) return false;
    if (email && parsed.kind === 'account' && parsed.target === email) return true;
    if (ip && parsed.kind === 'ip' && parsed.target === ip) return true;
    return false;
  };
  const shared = sharedLimiters();
  if (!shared) return releaseAuthRateLimit(input);
  const [accountKeys, ipKeys] = await Promise.all([
    shared.account.clearMatching(matches),
    shared.ip.clearMatching(matches),
  ]);
  return { released: accountKeys.length + ipKeys.length };
}

export interface AuthRateLimitOptions {
  /** Bucket scope, e.g. 'auth-login' or 'auth-forgot'. */
  scope: string;
  /**
   * Extracts the account dimension (email) from the request when present.
   * Returning undefined makes the request ip-only (no account bucket).
   */
  accountFrom?: (req: Request) => string | undefined;
}

async function sharedAuthRateLimit(
  shared: { ip: SharedRateLimiter; account: SharedRateLimiter },
  options: AuthRateLimitOptions,
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const account = options.accountFrom ? options.accountFrom(req) : undefined;
    const ipKey = buildRateLimitKey(options.scope, req);
    const ipVerdict = await shared.ip.attempt(ipKey);

    let accountKey: string | null = null;
    let accountVerdict: RateLimitVerdict | null = null;
    if (account) {
      accountKey = buildAccountRateLimitKey(options.scope, account);
      accountVerdict = await shared.account.attempt(accountKey);
    }

    const blocking = !ipVerdict.allowed ? ipVerdict : accountVerdict && !accountVerdict.allowed ? accountVerdict : null;
    if (blocking) {
      if (accountKey && accountVerdict!.allowed) await shared.account.revoke(accountKey);
      const retryAfterSec = Math.max(1, Math.ceil(blocking.retryAfterMs / 1000));
      res.set('Retry-After', String(retryAfterSec));
      res.set('X-Auth-Attempts-Remaining', '0');
      res.status(429).json({
        message: `Too many attempts. Please try again in ${retryAfterSec} second${retryAfterSec === 1 ? '' : 's'}.`,
        retryAfterSec,
        attemptsRemaining: 0,
      });
      return;
    }

    const ipRemaining = Math.max(0, ipVerdict.limit - ipVerdict.count);
    const accountRemaining = accountVerdict
      ? Math.max(0, accountVerdict.limit - accountVerdict.count)
      : Number.POSITIVE_INFINITY;
    const originalJson = res.json.bind(res);
    res.json = (payload: any) => {
      const failed = res.statusCode >= 400;
      if (accountKey && !failed) {
        void shared.account.revoke(accountKey).catch((err: any) =>
          console.error('Shared rate-limit revoke failed:', err?.message || err)
        );
      }
      const remaining = failed ? Math.max(0, Math.min(ipRemaining, accountRemaining)) : ipRemaining;
      res.set('X-Auth-Attempts-Remaining', String(remaining));
      if (failed && payload && typeof payload === 'object') {
        return originalJson({ ...payload, attemptsRemaining: remaining });
      }
      return originalJson(payload);
    };
    next();
  } catch (err: any) {
    // Security controls fail closed when their shared store is unavailable.
    console.error('shared auth rate limiter unavailable (failing closed):', err?.message || err);
    res.status(503).json({
      message: 'Sign-in protection is temporarily unavailable. Retry shortly.',
      code: 'SHARED_STATE_UNAVAILABLE',
    });
  }
}

export function createAuthRateLimit(options: AuthRateLimitOptions) {
  return function authRateLimit(req: Request, res: Response, next: NextFunction): void {
    if (DISABLED) {
      next();
      return;
    }
    const shared = sharedLimiters();
    if (shared) {
      void sharedAuthRateLimit(shared, options, req, res, next);
      return;
    }
    try {
      const account = options.accountFrom ? options.accountFrom(req) : undefined;
      const ipKey = buildRateLimitKey(options.scope, req);
      const ipVerdict = ipLimiter.attempt(ipKey);

      let accountKey: string | null = null;
      let accountVerdict: RateLimitVerdict | null = null;
      if (account) {
        accountKey = buildAccountRateLimitKey(options.scope, account);
        accountVerdict = accountLimiter.attempt(accountKey);
      }

      const blocking = !ipVerdict.allowed ? ipVerdict : accountVerdict && !accountVerdict.allowed ? accountVerdict : null;
      if (blocking) {
        // Undo the account hit ONLY when it was actually recorded: an
        // ip-blocked request still recorded the account attempt (revoke it —
        // the request never proceeded), but an account-blocked request was
        // NOT recorded (attempt() refuses when full), so revoking there
        // would wrongly shrink an existing block. Either way, rejections
        // never extend a block.
        if (accountKey && accountVerdict!.allowed) accountLimiter.revoke(accountKey);
        const retryAfterSec = Math.max(1, Math.ceil(blocking.retryAfterMs / 1000));
        res.set('Retry-After', String(retryAfterSec));
        res.set('X-Auth-Attempts-Remaining', '0');
        res.status(429).json({
          message: `Too many attempts. Please try again in ${retryAfterSec} second${retryAfterSec === 1 ? '' : 's'}.`,
          retryAfterSec,
          attemptsRemaining: 0,
        });
        return;
      }

      // Admission succeeded. Two jobs in the response wrapper:
      //  1. Failure-only accounting on the account dimension — a success
      //     revokes its optimistic hit, a failure keeps it.
      //  2. Report how many attempts are left, so the sign-in screen can warn
      //     before the cutoff (the 429 path above reports 0).
      const ipRemaining = Math.max(0, ipVerdict.limit - ipVerdict.count);
      const accountRemaining = accountVerdict
        ? Math.max(0, accountVerdict.limit - accountVerdict.count)
        : Number.POSITIVE_INFINITY;
      const originalJson = res.json.bind(res);
      res.json = (payload: any) => {
        const failed = res.statusCode >= 400;
        if (accountKey && !failed) accountLimiter.revoke(accountKey);
        const remaining = failed ? Math.max(0, Math.min(ipRemaining, accountRemaining)) : ipRemaining;
        res.set('X-Auth-Attempts-Remaining', String(remaining));
        if (failed && payload && typeof payload === 'object') {
          return originalJson({ ...payload, attemptsRemaining: remaining });
        }
        return originalJson(payload);
      };
      next();
    } catch (err: any) {
      // Fail-open: a limiter bug must not make the login endpoint unusable.
      console.error('auth rate limiter error (fail-open):', err?.message || err);
      next();
    }
  };
}
