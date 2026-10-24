/**
 * React binding for the shared branch-stock cache (branchStockStore.ts).
 *
 * `useBranchStock` merges the freshly fetched rows for the branches a form
 * may target into the header-scoped bootstrap rows. The result is what the
 * stock-operation panels and the dispatch form use for their "N in stock"
 * labels and their pre-submit availability checks, so a form targeting
 * Branch 2 sees Branch 2's PostgreSQL rows even while the header views
 * Branch 1.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { InventoryStock } from '../types';
import { api } from './api';
import { createBranchStockStore, mergeBranchStock } from './branchStockStore';

export const branchStockStore = createBranchStockStore((branchId) => api.getStock(branchId));

/** App calls this on every full refresh and every SSE burst that writes stock. */
export function invalidateBranchStock(): void {
  branchStockStore.invalidate();
}

/** Sign-out: the next user on this tab may be allowed fewer branches. */
export function resetBranchStock(): void {
  branchStockStore.reset();
}

export interface OperationStock {
  /** Header-scoped rows plus the fetched rows for every allowed branch. */
  rows: InventoryStock[];
  loading: boolean;
  /** Failure message for the extra branch reads; '' once they succeed. */
  error: string;
  retry: () => void;
}

export function useBranchStock(
  branchIds: readonly string[],
  fallback: readonly InventoryStock[]
): OperationStock {
  const snapshot = useSyncExternalStore(
    branchStockStore.subscribe,
    branchStockStore.getSnapshot
  );
  // Join into a primitive so a new array literal each render (the callers
  // build one from a selector) does not refetch on every keystroke.
  const key = branchIds.join('|');
  useEffect(() => {
    branchStockStore.ensureLoaded(key ? key.split('|') : []);
  }, [key]);

  const rows = useMemo(
    () => mergeBranchStock(fallback, snapshot.rows),
    [fallback, snapshot.rows]
  );

  return {
    rows,
    loading: snapshot.loading,
    error: snapshot.error,
    retry: branchStockStore.refresh,
  };
}
