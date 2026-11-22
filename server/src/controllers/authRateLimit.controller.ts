/**
 * Admin release for the sign-in limiter.
 *
 * Why an endpoint instead of a script: the limiter's buckets are in this
 * process's memory. A script in another process starts with its own empty Map
 * and can clear nothing, so the only thing that can lift a block is the running
 * server. Gated on `admin-users` — the same permission that already governs
 * accounts — so a Super Admin, a Head Office Admin, or any account granted that
 * operation through its role, a permission set or a personal grant can do it.
 *
 * The audit trail records who released which target; values are never echoed
 * back beyond the count.
 */
import type { Request, Response } from 'express';
import { logAuditEvent } from '../app';
import {
  AUTH_RATE_LIMIT_SCOPES,
  listAuthRateLimitBlocks,
  listAuthRateLimitBlocksShared,
  releaseAuthRateLimit,
  releaseAuthRateLimitShared,
} from '../middleware/authRateLimit';
import { isRedisSharedState } from '../state/sharedStore';

/** GET /api/auth/rate-limit — who is currently throttled, and for how long. */
export async function get_authRateLimitBlocks(_req: Request, res: Response): Promise<void> {
  try {
    const blocks = isRedisSharedState()
      ? await listAuthRateLimitBlocksShared()
      : listAuthRateLimitBlocks();
    res.json({ blocks, scopes: [...AUTH_RATE_LIMIT_SCOPES] });
  } catch (err: any) {
    console.error('Cannot read shared login locks:', err?.message || err);
    res.status(503).json({ message: 'Login-lock state is temporarily unavailable. Retry shortly.', code: 'SHARED_STATE_UNAVAILABLE' });
  }
}

/** POST /api/auth/rate-limit/release — lift a block immediately. */
export async function post_releaseAuthRateLimit(req: Request, res: Response): Promise<void> {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const ip = typeof req.body?.ip === 'string' ? req.body.ip.trim() : '';
  const all = req.body?.all === true;

  if (!all && !email && !ip) {
    res.status(400).json({ message: 'Name an account email, a client address, or all:true.' });
    return;
  }

  let released = 0;
  try {
    ({ released } = isRedisSharedState()
      ? await releaseAuthRateLimitShared({ email, ip, all })
      : releaseAuthRateLimit({ email, ip, all }));
  } catch (err: any) {
    console.error('Cannot release shared login locks:', err?.message || err);
    res.status(503).json({ message: 'Login-lock state is temporarily unavailable. Retry shortly.', code: 'SHARED_STATE_UNAVAILABLE' });
    return;
  }
  const actor = (req as any).user?.email || 'unknown';
  const target = all
    ? 'every bucket'
    : [email && `account ${email}`, ip && `address ${ip}`].filter(Boolean).join(' + ');
  await logAuditEvent(
    req,
    'RELEASE_LOGIN_LOCK',
    'AUTH',
    `Login lock released by ${actor}: ${target} (${released} bucket${released === 1 ? '' : 's'})`
  );
  res.json({ released });
}
