/**
 * Process-local performance metrics.
 *
 * Phase 0A measures the paths the scaling plan calls out before changing them:
 * request latency, pool acquisition wait, slow queries and the full operational
 * cache refresh. The registry is intentionally small and bounded — it is an
 * incident/benchmark signal, not an audit trail, and it never stores request
 * bodies, bind parameters or customer data.
 *
 * Counters and samples reset on restart. The authenticated
 * `GET /api/admin/performance` route exposes the aggregate snapshot.
 */
import { getSchemaVersion } from '../boot/migrations';

const HTTP_SAMPLE_LIMIT = 4_096;
const HTTP_ROUTE_LIMIT = 200;
const HTTP_ROUTE_SAMPLE_LIMIT = 256;
const DB_SAMPLE_LIMIT = 4_096;
const CACHE_SAMPLE_LIMIT = 128;
const SLOW_QUERY_LIMIT = 10;
const SLOW_QUERY_DEFAULT_MS = 500;

type HttpRouteStats = {
  method: string;
  route: string;
  count: number;
  errorCount: number;
  totalMs: number;
  maxMs: number;
  samples: number[];
};

type CacheRefreshSample = {
  at: string;
  totalMs: number;
  loads: number;
  slowest: Array<{ name: string; ms: number }>;
};

type SlowQuery = {
  at: string;
  ms: number;
  sql: string;
};

const httpSamples: number[] = [];
const httpRoutes = new Map<string, HttpRouteStats>();
let httpTotal = 0;
let httpErrors = 0;
let httpMaxMs = 0;

const dbSamples: number[] = [];
let dbTotal = 0;
let dbErrors = 0;
let dbMaxMs = 0;
let slowQueryCount = 0;
const slowQueries: SlowQuery[] = [];

let poolAcquireCount = 0;
let poolAcquireErrors = 0;
const poolWaitSamples: number[] = [];

const cacheSamples: CacheRefreshSample[] = [];
let cachePasses = 0;
let cacheSlowPasses = 0;

let dbBreakerOpens = 0;
let dbBreakerHalfOpenProbes = 0;
let dbBreakerCloses = 0;
let dbAcquireTimeouts = 0;
let dbStatementTimeouts = 0;

function boundedPush<T>(items: T[], value: T, limit: number): void {
  items.push(value);
  if (items.length > limit) items.splice(0, items.length - limit);
}

/** Nearest-rank percentile on a copy; callers may keep their insertion order. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function slowQueryThresholdMs(): number {
  const configured = Number(process.env.SLOW_QUERY_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : SLOW_QUERY_DEFAULT_MS;
}

/** Compact one statement for the diagnostics list; no bind parameters. */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 240);
}

export function recordHttpRequest(
  method: string,
  route: string,
  statusCode: number,
  durationMs: number
): void {
  const ms = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  httpTotal += 1;
  if (statusCode >= 500) httpErrors += 1;
  httpMaxMs = Math.max(httpMaxMs, ms);
  boundedPush(httpSamples, ms, HTTP_SAMPLE_LIMIT);

  const key = `${method.toUpperCase()} ${route}`;
  let entry = httpRoutes.get(key);
  if (!entry) {
    if (httpRoutes.size >= HTTP_ROUTE_LIMIT) {
      entry = httpRoutes.get('OTHER OTHER');
      if (!entry) {
        entry = { method: 'OTHER', route: 'OTHER', count: 0, errorCount: 0, totalMs: 0, maxMs: 0, samples: [] };
        httpRoutes.set('OTHER OTHER', entry);
      }
    } else {
      entry = { method: method.toUpperCase(), route, count: 0, errorCount: 0, totalMs: 0, maxMs: 0, samples: [] };
      httpRoutes.set(key, entry);
    }
  }
  entry.count += 1;
  if (statusCode >= 500) entry.errorCount += 1;
  entry.totalMs += ms;
  entry.maxMs = Math.max(entry.maxMs, ms);
  boundedPush(entry.samples, ms, HTTP_ROUTE_SAMPLE_LIMIT);
}

export function recordDbQuery(durationMs: number, sql: string, failed: boolean): void {
  const ms = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  dbTotal += 1;
  if (failed) dbErrors += 1;
  dbMaxMs = Math.max(dbMaxMs, ms);
  boundedPush(dbSamples, ms, DB_SAMPLE_LIMIT);

  if (ms >= slowQueryThresholdMs()) {
    slowQueryCount += 1;
    boundedPush(
      slowQueries,
      { at: new Date().toISOString(), ms: rounded(ms), sql: normalizeSql(sql) },
      SLOW_QUERY_LIMIT
    );
  }
}

export function recordDbBreakerEvent(event: 'opened' | 'half_open' | 'closed'): void {
  if (event === 'opened') dbBreakerOpens += 1;
  else if (event === 'half_open') dbBreakerHalfOpenProbes += 1;
  else dbBreakerCloses += 1;
}

export function recordDbTimeout(kind: 'acquire' | 'statement'): void {
  if (kind === 'acquire') dbAcquireTimeouts += 1;
  else dbStatementTimeouts += 1;
}

export function recordPoolAcquire(durationMs: number, failed = false): void {
  poolAcquireCount += 1;
  if (failed) poolAcquireErrors += 1;
  boundedPush(
    poolWaitSamples,
    Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
    DB_SAMPLE_LIMIT
  );
}

export function recordCacheRefresh(
  totalMs: number,
  loads: number,
  timings: Array<{ name: string; ms: number }>
): void {
  const ms = Number.isFinite(totalMs) ? Math.max(0, totalMs) : 0;
  cachePasses += 1;
  if (ms >= 250) cacheSlowPasses += 1;
  const slowest = [...timings]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3)
    .map((entry) => ({ name: entry.name, ms: entry.ms }));
  boundedPush(
    cacheSamples,
    { at: new Date().toISOString(), totalMs: rounded(ms), loads, slowest },
    CACHE_SAMPLE_LIMIT
  );
}

export function resetPerformanceMetrics(): void {
  httpSamples.length = 0;
  httpRoutes.clear();
  httpTotal = 0;
  httpErrors = 0;
  httpMaxMs = 0;
  dbSamples.length = 0;
  dbTotal = 0;
  dbErrors = 0;
  dbMaxMs = 0;
  slowQueryCount = 0;
  slowQueries.length = 0;
  poolAcquireCount = 0;
  poolAcquireErrors = 0;
  poolWaitSamples.length = 0;
  cacheSamples.length = 0;
  cachePasses = 0;
  cacheSlowPasses = 0;
  dbBreakerOpens = 0;
  dbBreakerHalfOpenProbes = 0;
  dbBreakerCloses = 0;
  dbAcquireTimeouts = 0;
  dbStatementTimeouts = 0;
}

export function performanceSnapshot() {
  const routes = [...httpRoutes.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map((entry) => ({
      method: entry.method,
      route: entry.route,
      count: entry.count,
      errorCount: entry.errorCount,
      avgMs: rounded(entry.totalMs / entry.count),
      p50Ms: rounded(percentile(entry.samples, 50)),
      p95Ms: rounded(percentile(entry.samples, 95)),
      p99Ms: rounded(percentile(entry.samples, 99)),
      maxMs: rounded(entry.maxMs),
    }));

  const lastCache = cacheSamples[cacheSamples.length - 1] || null;
  const cacheTotals = cacheSamples.map((sample) => sample.totalMs);

  return {
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    schema: { currentVersion: getSchemaVersion() },
    requests: {
      total: httpTotal,
      errors: httpErrors,
      p50Ms: rounded(percentile(httpSamples, 50)),
      p95Ms: rounded(percentile(httpSamples, 95)),
      p99Ms: rounded(percentile(httpSamples, 99)),
      maxMs: rounded(httpMaxMs),
      routes,
    },
    database: {
      queries: dbTotal,
      errors: dbErrors,
      p50Ms: rounded(percentile(dbSamples, 50)),
      p95Ms: rounded(percentile(dbSamples, 95)),
      p99Ms: rounded(percentile(dbSamples, 99)),
      maxMs: rounded(dbMaxMs),
      poolAcquires: poolAcquireCount,
      poolAcquireErrors,
      poolWaitP95Ms: rounded(percentile(poolWaitSamples, 95)),
      poolWaitMaxMs: rounded(poolWaitSamples.length ? Math.max(...poolWaitSamples) : 0),
      slowQueryThresholdMs: slowQueryThresholdMs(),
      slowQueryCount,
      recentSlowQueries: [...slowQueries],
      availability: {
        breakerOpens: dbBreakerOpens,
        halfOpenProbes: dbBreakerHalfOpenProbes,
        breakerCloses: dbBreakerCloses,
        acquireTimeouts: dbAcquireTimeouts,
        statementTimeouts: dbStatementTimeouts,
      },
    },
    cacheRefresh: {
      passes: cachePasses,
      slowPasses: cacheSlowPasses,
      p50Ms: rounded(percentile(cacheTotals, 50)),
      p95Ms: rounded(percentile(cacheTotals, 95)),
      maxMs: rounded(cacheTotals.length ? Math.max(...cacheTotals) : 0),
      last: lastCache,
      recent: [...cacheSamples].slice(-10),
    },
  };
}
