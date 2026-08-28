/**
 * Attach request id + structured access logging.
 */
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { childLogger, logger } from '../lib/logger';

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incoming = (req.headers['x-request-id'] as string) || randomUUID();
  (req as any).requestId = incoming;
  res.setHeader('x-request-id', incoming);

  const start = Date.now();
  const log = childLogger({ requestId: incoming });

  res.on('finish', () => {
    // Skip noisy health checks in production logs at info level
    if (req.path === '/api/health' && res.statusCode < 400) return;
    log.info({
      msg: 'http_request',
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Date.now() - start,
      user: (req as any).user?.email,
      role: (req as any).user?.role,
    });
  });

  next();
}

export function getRequestId(req: Request): string {
  return (req as any).requestId || 'unknown';
}

export { logger };
