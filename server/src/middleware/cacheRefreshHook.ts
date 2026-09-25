/**
 * Cache-refresh hook extracted from app.ts (backlog item #6 — app.ts
 * extraction). On ANY successful mutating API call, re-reads every cache
 * table from PostgreSQL (via CACHE_LOADS) BEFORE the response is sent.
 * This replaces all hand-maintained mirror writes — the arrays can never
 * drift from the database because they are re-derived from it after each
 * write, and the caller's very next read already sees the committed state.
 */
import type { Request, Response, NextFunction } from 'express';
import { getPgConnected } from '../state/runtimeState';
import { refreshOperationalCache } from '../state/runtimeState';

export function cacheRefreshHook(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || !getPgConnected()) return next();
  const originalJson = res.json.bind(res);
  res.json = (body: any) => {
    if (res.statusCode >= 400) return originalJson(body);
    // Serialized through refreshChain so overlapping writes never run
    // concurrent fan-outs; failures are swallowed inside the refresh.
    const refreshStartedAt = Date.now();
    return refreshOperationalCache().then(() => {
      // Expose the refresh cost to clients/proxies (visible in DevTools and
      // consumed by scripts/smoke_test.mjs-style benchmarks).
      res.setHeader('Server-Timing', `cache-refresh;dur=${Date.now() - refreshStartedAt}`);
      return originalJson(body);
    });
  };
  next();
}
