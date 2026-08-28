/**
 * Rate limiters — login brute-force protection and general API throttle.
 */
import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const loginMax = Number(process.env.LOGIN_RATE_LIMIT_MAX || 20);
const apiMax = Number(process.env.API_RATE_LIMIT_MAX || 600);

function clientKey(req: Request): string {
  const xf = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return xf || req.ip || req.socket.remoteAddress || 'unknown';
}

/** Strict limiter for authentication endpoints. */
export const loginRateLimiter = rateLimit({
  windowMs,
  max: loginMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
    return `login:${clientKey(req)}:${email}`;
  },
  message: {
    message: 'Too many login attempts. Please try again later.',
    code: 'RATE_LIMITED',
  },
  skip: () => process.env.NODE_ENV === 'test' || process.env.DISABLE_RATE_LIMIT === 'true',
});

/** General API throttle (authenticated traffic). */
export const apiRateLimiter = rateLimit({
  windowMs,
  max: apiMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `api:${clientKey(req)}`,
  message: {
    message: 'Too many requests. Please slow down.',
    code: 'RATE_LIMITED',
  },
  skip: (req) =>
    process.env.NODE_ENV === 'test' ||
    process.env.DISABLE_RATE_LIMIT === 'true' ||
    req.path === '/api/health' ||
    req.path.startsWith('/api/sync/'),
});
