import type { NextFunction, Request, Response } from 'express';
import { recordHttpRequest } from './metrics';

/**
 * Record every API request after its response is flushed. The route template
 * (for example `/api/customers/:id`) is used instead of the concrete URL so
 * customer ids never create unbounded metric keys.
 */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith('/api')) {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();
  let recorded = false;

  const record = () => {
    if (recorded) return;
    recorded = true;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const template = req.route?.path
      ? `${req.baseUrl || ''}${req.route.path}`
      : req.path.slice(0, 160);
    recordHttpRequest(req.method, template, res.statusCode, elapsedMs);
  };

  res.once('finish', record);
  res.once('close', record);
  next();
}
