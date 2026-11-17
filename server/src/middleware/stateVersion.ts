/**
 * The single post-write bump point for the bootstrap payload version (OPS-2).
 *
 * The old `cacheRefreshHook` is gone; there is no longer a generic post-write
 * cache refresh to hang the bump on. This middleware is the replacement: any
 * successful non-GET through /api advances `stateVersion` once, after the
 * response has actually finished with a 2xx/3xx status. That is what makes a
 * write invalidate every cached bootstrap ETag without touching each
 * controller.
 *
 * Deliberately excluded:
 *   - GET/HEAD/OPTIONS are reads;
 *   - the sign-in/setup/forgot-password calls are not data writes and would
 *     invalidate every user's ETag on every login.
 *
 * A write that fails (4xx/5xx) does not bump: the payload did not change.
 * An out-of-band SQL edit bypasses this hook; a restart (fresh stateVersion)
 * or any subsequent write revalidates.
 *
 * The counter is bumped through `state/bootstrapVersion.ts`, which keeps it in
 * Redis when the cluster shares a store: otherwise a write handled by worker A
 * left worker B's counter — and therefore its ETag — untouched, so B could
 * answer 304 for a payload that had already changed.
 */
import type { Request, Response, NextFunction } from 'express';
import { recordWriteStateVersion } from '../state/bootstrapVersion';

const NON_DATA_WRITES = new Set([
  '/auth/login',
  '/auth/setup-status',
  '/auth/setup-superadmin',
  '/auth/forgot-password',
]);

export function bumpStateVersionOnWrite(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  if (NON_DATA_WRITES.has(req.path)) {
    next();
    return;
  }

  res.on('finish', () => {
    // Fire-and-forget: the response is already sent, and a shared-store failure
    // falls back to the local bump instead of failing the write.
    if (res.statusCode >= 200 && res.statusCode < 400) void recordWriteStateVersion();
  });
  next();
}
