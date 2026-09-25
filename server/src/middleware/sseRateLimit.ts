/**
 * SSE rate limiting (hardening on top of the backlog #2 auth fix).
 *
 * /api/sync/stream is now auth-protected, but it is still an expensive
 * endpoint: each admitted request holds a connection, an sseClients entry
 * and a 25-second keep-alive timer for as long as the client stays
 * connected. An attacker with VALID credentials (or a buggy client) could
 * still open hundreds of streams and exhaust sockets/memory. This middleware
 * caps concurrent SSE connections per client address using the same
 * dependency-free sliding-window RateLimiter as the auth limiter.
 *
 * Why "concurrent" via a sliding window: the SSE connection is long-lived,
 * so a simple attempt-per-window is wrong (one legitimate page load would
 * burn the whole budget over a long session). Instead:
 *   - attempt() on connect — if the bucket is full, the handshake is
 *     rejected with 429 + Retry-Before-style guidance;
 *   - revoke() when the stream closes ('close' event) — the slot frees
 *     immediately, so the window only ever holds CURRENTLY-OPEN streams.
 * The bucket therefore behaves as "at most N simultaneous streams per IP".
 *
 * Configuration (safe defaults without any env var):
 *   SSE_MAX_CONNECTIONS_PER_IP  simultaneous streams per client (default 6)
 *   SSE_RATE_LIMIT_DISABLED     "1"/"true" disables the cap (tests/dev)
 *
 * Fail-open: limiter errors never block a legitimate client.
 */
import type { Request, Response, NextFunction } from 'express';
import { RateLimiter, buildRateLimitKey } from '../utils/rateLimiter';
import { intFromEnv } from '../utils/envGuard';

// Strict env parsing (backlog #4): garbage values warn and fall back instead
// of becoming NaN or 0 (which would either disable the cap or block everyone).
const MAX_STREAMS_PER_IP = intFromEnv('SSE_MAX_CONNECTIONS_PER_IP', 6, { min: 1, max: 1000 });
const DISABLED = process.env.SSE_RATE_LIMIT_DISABLED === '1' || process.env.SSE_RATE_LIMIT_DISABLED === 'true';

// Long window: slots are revoked on close, so the window never needs to
// expire them; it only bounds memory if a client vanishes WITHOUT a close
// event (hard socket drop) — those entries age out after 1 hour.
const WINDOW_MS = 3_600_000;

const streamLimiter = new RateLimiter({ max: MAX_STREAMS_PER_IP, windowMs: WINDOW_MS });

export function sseConnectionLimit(req: Request, res: Response, next: NextFunction): void {
  if (DISABLED) {
    next();
    return;
  }
  try {
    const key = buildRateLimitKey('sse-stream', req);
    const verdict = streamLimiter.attempt(key);
    if (!verdict.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
      res.set('Retry-After', String(Math.min(retryAfterSec, 60)));
      res.status(429).json({
        message: `Too many sync streams open from this address. Close some tabs or wait before reconnecting.`,
      });
      return;
    }
    // Free the slot when the stream ends (client disconnect, server
    // shutdown, or the controller's req.on('close') cleanup).
    const release = () => streamLimiter.revoke(key);
    res.on('close', release);
    res.on('finish', release);
    next();
  } catch (err: any) {
    console.error('sse connection limiter error (fail-open):', err?.message || err);
    next();
  }
}

/** Test/ops access to the live limiter. */
export function getSseLimiter(): { limiter: RateLimiter; maxStreams: number } {
  return { limiter: streamLimiter, maxStreams: MAX_STREAMS_PER_IP };
}
