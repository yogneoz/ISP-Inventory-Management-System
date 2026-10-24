/**
 * Serial register (`serial_log`) — one shared client snapshot.
 *
 * Stock operations, the dispatch form and the stock panels all gate on the
 * same question: "is this serial an IN_STOCK unit of this branch?". Each of
 * the 11 mounted StockOperations hosts used to fetch its own copy once and
 * never invalidate it, so a transfer received (or a serial sold) elsewhere
 * left every open gate trusting a session-old snapshot.
 *
 * This store keeps ONE snapshot and at most ONE in-flight fetch; consumers
 * subscribe through serialRegisterCache.ts. It imports neither React nor the
 * API so the dedup/invalidate/late-response behaviour is unit-testable.
 */
import type { SerialLog } from '../types';

export interface SerialRegisterSnapshot {
  rows: SerialLog[];
  /** A successful load has completed at least once for this snapshot. */
  loaded: boolean;
  loading: boolean;
  /** Last failure message; rows are kept so a gate never silently becomes []. */
  error: string;
}

/** Accepts both shapes GET /api/serial-log can return (bare array or envelope). */
export type SerialRegisterFetcher = () => Promise<
  SerialLog[] | { data?: SerialLog[] } | null | undefined
>;

export interface SerialRegisterStore {
  getSnapshot(): SerialRegisterSnapshot;
  subscribe(listener: () => void): () => void;
  /** Fetch only if nothing is loaded and nothing is in flight. */
  ensureLoaded(): void;
  /** Force a fetch, discarding any response already in flight. */
  refresh(): void;
  /** The data changed elsewhere: drop `loaded` (keeping rows) and refetch. */
  invalidate(): void;
}

export function createSerialRegisterStore(fetchRows: SerialRegisterFetcher): SerialRegisterStore {
  let snapshot: SerialRegisterSnapshot = {
    rows: [],
    loaded: false,
    loading: false,
    error: '',
  };
  // Every fetch gets an id; a response whose id is no longer current is a
  // late answer to a superseded request and must never overwrite the store.
  let requestId = 0;
  let inFlight: Promise<void> | null = null;
  let subscriberCount = 0;
  const listeners = new Set<() => void>();

  const publish = (next: SerialRegisterSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const start = (): void => {
    const request = ++requestId;
    inFlight = (async () => {
      publish({ ...snapshot, loading: true, error: '' });
      try {
        const result = await fetchRows();
        if (request !== requestId) return;
        const rows = Array.isArray(result) ? result : result?.data || [];
        publish({ rows, loaded: true, loading: false, error: '' });
      } catch (err: any) {
        if (request !== requestId) return;
        // Keep the previous rows: a failed refresh must not read as
        // "no serials exist" to the gates that consume this snapshot.
        publish({
          ...snapshot,
          loading: false,
          error: err?.message || 'Could not load the serial register.',
        });
      } finally {
        if (request === requestId) inFlight = null;
      }
    })();
  };

  const ensureLoaded = (): void => {
    if (snapshot.loaded || inFlight) return;
    start();
  };

  const refresh = (): void => {
    // Supersede anything in flight so a slow failure cannot clear the retry.
    start();
  };

  const invalidate = (): void => {
    requestId++; // discard a response from before the invalidation
    inFlight = null;
    publish({ ...snapshot, loaded: false });
    // Hidden tabs keep their subscriptions; refetch immediately so panels
    // re-gate on fresh rows without waiting for a remount.
    if (subscriberCount > 0) start();
  };

  const subscribe = (listener: () => void): (() => void) => {
    subscriberCount++;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      subscriberCount--;
    };
  };

  return {
    getSnapshot: () => snapshot,
    subscribe,
    ensureLoaded,
    refresh,
    invalidate,
  };
}
