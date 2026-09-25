import type { Request, Response, NextFunction } from 'express';
import { ApiError } from './ApiError';

/**
 * Central error-handling middleware. Mounted LAST in registerAllRoutes so any
 * thrown ApiError from any route is converted to the standard JSON body.
 * Non-ApiError throws fall back to 500 without leaking internals.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  if (err instanceof ApiError) {
    res.status(err.status).json({ message: err.message });
    return;
  }
  // Body-parser errors (oversized JSON etc.) carry a status — pass it through
  // so a too-large payload is a 413 Payload Too Large, not a 500.
  const status = (err as any)?.status ?? (err as any)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500 && err instanceof Error) {
    res.status(status).json({ message: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal error';
  console.error('Unhandled error:', err);
  res.status(500).json({ message });
}
