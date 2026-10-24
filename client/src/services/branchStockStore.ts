/**
 * Branch stock snapshots — one shared client cache for the forms that can
 * pick a source branch other than the header's selection.
 *
 * GET /api/bootstrap is scoped to the branch in the header (`branchId`), so
 * its `stock` array contains ONLY that branch's rows. The stock-operation
 * forms and the dispatch form let the operator target any allowed branch,
 * yet they computed availability from that scoped array — so a product with
 * units at Branch 2 read "0 in stock" and the client-side pre-check refused a
 * deployment the register said was valid. The fix is not a calculation
 * change: it is reading the stock rows for the branch the form actually
 * targets, straight from PostgreSQL through GET /api/stock?branchId=….
 *
 * This module is the single fetch cache for that: one in-flight request per
 * branch, shared by every mounted form (the app keeps several
 * StockOperations hosts and the shipments form mounted at once). It imports
 * neither React nor the API, so the dedupe/refresh/failure behaviour is
 * unit-testable, and it never writes: rows are read-only snapshots.
 */
import type { InventoryStock } from '../types';

export interface BranchStockSnapshot {
  /** Fetched rows, all requested branches. Last good rows survive a failure. */
  rows: InventoryStock[];
  loading: boolean;
  /** Last failure message; rows are kept so availability never collapses to 0. */
  error: string;
  /** Every requested branch was fetched successfully since the last invalidation. */
  loaded: boolean;
}

export type BranchStockFetcher = (
  branchId: string
) => Promise<InventoryStock[] | null | undefined>;

export interface BranchStockStore {
  getSnapshot(): BranchStockSnapshot;
  subscribe(listener: () => void): () => void;
  /** Fetch any of these branches this snapshot does not hold yet. */
  ensureLoaded(branchIds: readonly string[]): void;
  /** Drop freshness and refetch (Retry). Supersedes anything in flight. */
  refresh(): void;
  /** Data changed elsewhere: keep the rows on screen, refetch in the background. */
  invalidate(): void;
  /** Drop everything (sign-out / profile switch: the next user may see less). */
  reset(): void;
}

const rowKey = (row: InventoryStock): string => `${row.productId}|${row.branchId}`;

/**
 * Merge the header-scoped bootstrap rows with the fetched all-branch rows.
 *
 * The fallback wins for any (product, branch) it already carries: that array
 * is the one the server scoped to the current fiscal-year view (a past year
 * is served from its opening snapshot, not live stock), so it stays
 * authoritative for its own branch. The fetched rows only ADD the branches
 * the bootstrap payload never contained, and duplicates are dropped.
 */
export function mergeBranchStock(
  fallback: readonly InventoryStock[],
  fetched: readonly InventoryStock[]
): InventoryStock[] {
  const seen = new Set(fallback.map(rowKey));
  const merged = [...fallback];
  for (const row of fetched) {
    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
}

export function createBranchStockStore(fetchStock: BranchStockFetcher): BranchStockStore {
  let snapshot: BranchStockSnapshot = {
    rows: [],
    loading: false,
    error: '',
    loaded: false,
  };
  const rowsByBranch = new Map<string, InventoryStock[]>();
  const requested = new Set<string>();
  // Branches that must be re-read even though rows exist (invalidate/refresh).
  // A failed read stays dirty, so the next attempt tries it again.
  const dirty = new Set<string>();
  // Every fetch gets an id; a response whose id is no longer current belongs
  // to a superseded request and must never overwrite newer rows.
  let requestId = 0;
  let running = false;
  let queued = false;
  let subscriberCount = 0;
  const listeners = new Set<() => void>();

  const publish = (next: BranchStockSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const currentRows = (): InventoryStock[] => [...rowsByBranch.values()].flat();

  const start = (): void => {
    if (running) {
      queued = true;
      return;
    }
    const missing = [...requested].filter(
      (id) => dirty.has(id) || !rowsByBranch.has(id)
    );
    if (missing.length === 0) return;
    running = true;
    const request = ++requestId;
    publish({ ...snapshot, loading: true });
    Promise.allSettled(
      missing.map(async (branchId) => {
        const rows = await fetchStock(branchId);
        rowsByBranch.set(branchId, Array.isArray(rows) ? rows : []);
        dirty.delete(branchId);
      })
    )
      .then((results) => {
        if (request !== requestId) return;
        const failed = results.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        const reason = failed[0]?.reason;
        // currentRows() still holds the last successful rows for any branch
        // that failed — a failed refresh must never read as "0 in stock".
        publish({
          rows: currentRows(),
          loading: false,
          loaded: failed.length === 0,
          error:
            failed.length === 0
              ? ''
              : reason instanceof Error
                ? reason.message
                : typeof reason === 'string'
                  ? reason
                  : 'Could not load branch stock.',
        });
      })
      .finally(() => {
        if (request !== requestId) return;
        running = false;
        // Branches requested while this fetch was running are fetched next.
        if (queued) {
          queued = false;
          start();
        }
      });
  };

  const supersede = (): void => {
    requestId++; // discard any response from before this point
    running = false;
    queued = false;
    for (const id of requested) dirty.add(id);
  };

  // Several hosts invalidate in the same tick (one SSE burst → every mounted
  // form). Coalesce them into a single refetch instead of one per host.
  let invalidateQueued = false;

  return {
    getSnapshot: () => snapshot,

    subscribe: (listener) => {
      subscriberCount++;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        subscriberCount--;
      };
    },

    ensureLoaded: (branchIds) => {
      let added = false;
      for (const id of branchIds) {
        if (!id || id === 'ALL') continue;
        requested.add(id);
        if (dirty.has(id) || !rowsByBranch.has(id)) added = true;
      }
      if (!added && snapshot.loaded) return;
      start();
    },

    refresh: () => {
      supersede();
      publish({ ...snapshot, loaded: false, error: '' });
      start();
    },

    invalidate: () => {
      supersede();
      publish({ ...snapshot, loaded: false });
      if (invalidateQueued) return;
      invalidateQueued = true;
      queueMicrotask(() => {
        invalidateQueued = false;
        // Subscriber count is checked late: hosts that subscribe during the
        // same commit still get the refetch.
        if (subscriberCount > 0 && requested.size > 0) start();
      });
    },

    reset: () => {
      supersede();
      rowsByBranch.clear();
      requested.clear();
      dirty.clear();
      publish({ rows: [], loading: false, error: '', loaded: false });
    },
  };
}
