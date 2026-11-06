/**
 * Customer directory KPI cache.
 *
 * `GET /api/customers` returns one page of rows plus three totals over the
 * whole filtered directory (`totalItems`, `activeItems`, `totalCreditLimit`).
 * The rows are paged and cheap, but the totals are a full-table aggregate: at
 * 100k customers it costs ~80 ms of database CPU per call, so a 500-user burst
 * asks the same question 500 times and the pool queues behind it.
 *
 * This module caches only the totals. Deliberate properties:
 *
 *  - Key = the aggregate SQL plus its bound params, so branch scope and the
 *    directory's search/status filters each get their own entry and can never
 *    observe another filter's numbers.
 *  - An entry lives for KPI_TTL_MS. Every customer write calls
 *    invalidateCustomerKpis(), so in this process a mutation is never hidden
 *    behind the TTL.
 *  - Concurrent misses share one in-flight query instead of running the
 *    aggregate once per request.
 *  - A generation counter drops a result that was already in flight when a
 *    write invalidated the map, so a slow aggregate cannot repopulate stale
 *    totals after the commit.
 *  - Failures are not cached: the rejection reaches the caller and the next
 *    request retries.
 *  - Process-local. A write made by a second app instance is not seen until
 *    the TTL lapses (at most KPI_TTL_MS of skew); the documented deployment is
 *    single-instance (handoff.md), where invalidation is exact.
 */

/** How long a totals row may be served without refreshing it from the DB. */
export const KPI_TTL_MS = 15_000;

/** Upper bound on distinct filter combinations kept in memory. */
export const KPI_MAX_ENTRIES = 256;

export interface CustomerKpiTotals {
  totalItems: number;
  activeItems: number;
  totalCreditLimit: number;
}

interface CacheEntry {
  value: CustomerKpiTotals;
  expiresAt: number;
}

const entries = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CustomerKpiTotals>>();

/** Bumped by every invalidation so pre-write in-flight results are discarded. */
let generation = 0;

/**
 * Drops every cached totals row. Called from each customer write path
 * (create, bulk import, update, delete, and the CPE auto-provision upsert).
 * Cheap: the map only ever holds filter combinations, not customer rows.
 */
export function invalidateCustomerKpis(): void {
  generation += 1;
  entries.clear();
  inFlight.clear();
}

/** Evicts expired rows, then the oldest insertions while over the cap. */
function prune(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
  while (entries.size >= KPI_MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/**
 * Returns the cached totals for `key`, or runs `loader` (at most once per key
 * at a time) and caches its result.
 */
export function getCustomerKpis(
  key: string,
  loader: () => Promise<CustomerKpiTotals>
): Promise<CustomerKpiTotals> {
  const now = Date.now();
  const cached = entries.get(key);
  if (cached && cached.expiresAt > now) return Promise.resolve(cached.value);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const startedAt = generation;
  const promise = loader()
    .then((value) => {
      // A write landed while this query ran: the row it read may predate the
      // commit, so serve this caller but do not publish the value.
      if (startedAt === generation) {
        prune(now);
        entries.set(key, { value, expiresAt: Date.now() + KPI_TTL_MS });
      }
      return value;
    })
    .finally(() => {
      // Only clear our own slot; an invalidation may already have replaced it.
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

/** The cache key for one aggregate query and its bound params. */
export function customerKpiCacheKey(sql: string, params: readonly unknown[]): string {
  return `${sql}\u0000${JSON.stringify(params)}`;
}
