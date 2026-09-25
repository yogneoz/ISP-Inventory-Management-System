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
 *   AUTH_RATE_LIMIT_MAX       attempts per window (default 10)
 *   AUTH_RATE_LIMIT_WINDOW_MS window length (default 900000 = 15 minutes)
 *   AUTH_RATE_LIMIT_DISABLED  "1"/"true" disables the limiter (tests/dev)
 *
 * Responses: 429 with Retry-After (seconds) and a JSON body; the limiter
 * itself leaks nothing about account existence. Limiter failures never take
 * down auth: errors are logged and the request proceeds (fail-open).
 */
import type { Request, Response, NextFunction } from 'express';
import { RateLimiter, buildRateLimitKey, buildAccountRateLimitKey } from '../utils/rateLimiter';
import { intFromEnv } from '../utils/envGuard';

// Strict env parsing (backlog #4): garbage values warn and fall back instead
// of becoming NaN or 0 (a zero window/max would hard-lock or fully disable
// the brute-force guard).
const WINDOW_MS = intFromEnv('AUTH_RATE_LIMIT_WINDOW_MS', 900_000, { min: 1000, max: 86_400_000 });
const MAX_ATTEMPTS = intFromEnv('AUTH_RATE_LIMIT_MAX', 10, { min: 1, max: 10_000 });
const DISABLED = process.env.AUTH_RATE_LIMIT_DISABLED === '1' || process.env.AUTH_RATE_LIMIT_DISABLED === 'true';

const ipLimiter = new RateLimiter({ max: MAX_ATTEMPTS, windowMs: WINDOW_MS });
const accountLimiter = new RateLimiter({ max: MAX_ATTEMPTS, windowMs: WINDOW_MS });

export interface AuthRateLimitOptions {
  /** Bucket scope, e.g. 'auth-login' or 'auth-forgot'. */
  scope: string;
  /**
   * Extracts the account dimension (email) from the request when present.
   * Returning undefined makes the request ip-only (no account bucket).
   */
  accountFrom?: (req: Request) => string | undefined;
}

export function createAuthRateLimit(options: AuthRateLimitOptions) {
  return function authRateLimit(req: Request, res: Response, next: NextFunction): void {
    if (DISABLED) {
      next();
      return;
    }
    try {
      const account = options.accountFrom ? options.accountFrom(req) : undefined;
      const ipKey = buildRateLimitKey(options.scope, req);
      const ipVerdict = ipLimiter.attempt(ipKey);

      let accountKey: string | null = null;
      let accountVerdict: { allowed: boolean; retryAfterMs: number } | null = null;
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
        res.status(429).json({
          message: `Too many attempts. Please try again in ${retryAfterSec} second${retryAfterSec === 1 ? '' : 's'}.`,
          retryAfterSec,
        });
        return;
      }

      // Failure-only accounting on the account dimension: intercept the
      // response — success revokes the recorded attempt, failure keeps it.
      if (accountKey) {
        const originalJson = res.json.bind(res);
        res.json = (payload: any) => {
          const failed = res.statusCode >= 400;
          if (!failed) accountLimiter.revoke(accountKey!);
          return originalJson(payload);
        };
      }
      next();
    } catch (err: any) {
      // Fail-open: a limiter bug must not make the login endpoint unusable.
      console.error('auth rate limiter error (fail-open):', err?.message || err);
      next();
    }
  };
}

/** Test/ops access to the live limiters. */
export function getAuthLimiters(): { ipLimiter: RateLimiter; accountLimiter: RateLimiter; windowMs: number; maxAttempts: number } {
  return { ipLimiter, accountLimiter, windowMs: WINDOW_MS, maxAttempts: MAX_ATTEMPTS };
}
