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

  // Database errors carry a SQLSTATE. Two of them are a client conflict rather
  // than a server fault, and a master-code create that loses a race must not
  // read as a crashed endpoint: a unique violation is the same 409 the
  // controllers' pre-check returns, and a foreign key that disappeared between
  // the read and the write is a 409 too.
  //
  // Their text is never echoed: PostgreSQL's message and DETAIL repeat the
  // offending value (`Key (code)=(SM-AR-KTM) already exists`), which would hand
  // callers data they did not supply through a 500.
  const sqlState = (err as any)?.code;
  if (typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState)) {
    if (sqlState === '23505') {
      console.error('Database unique violation:', (err as any)?.message || err);
      res.status(409).json({ message: 'That value is already in use. Reload the register and try again.' });
      return;
    }
    if (sqlState === '23503') {
      console.error('Database foreign-key violation:', (err as any)?.message || err);
      res.status(409).json({ message: 'This record references something that no longer exists. Reload and try again.' });
      return;
    }
    console.error('Unhandled database error:', err);
    res.status(500).json({ message: 'The database refused this change. The server log has the details.' });
    return;
  }

  const message = err instanceof Error ? err.message : 'Internal error';
  console.error('Unhandled error:', err);
  res.status(500).json({ message });
}
