/**
 * Shipment overview store — the bounded snapshot behind the shell badges, the
 * dashboard KPI, the notification center and the receive lanes.
 *
 * VOL-3: shipments no longer ride the bootstrap payload (a fiscal year of
 * transfers grows without bound). The server answers one small scoped read
 * instead — exact status counts, the actionable (still in flight) rows and a
 * recent window — and every consumer shares that snapshot.
 *
 * The store is deliberately React-free so the scope/dedup/invalidate/late
 * response behavior is unit-testable, exactly like serialRegisterStore.ts.
 */
import type { Shipment } from '../types';
import type { ShipmentOverview } from './api/procurement';

export interface ShipmentOverviewSnapshot extends ShipmentOverview {
  /** The branch scope this snapshot answers ('ALL' or a branch id). */
  scope: string;
  /** A successful load has completed at least once for this scope. */
  loaded: boolean;
  loading: boolean;
  /** Last failure message; rows/counts are kept so badges never read as zero. */
  error: string;
}

export type ShipmentOverviewFetcher = (
  scope: string
) => Promise<ShipmentOverview | null | undefined>;

export interface ShipmentOverviewStore {
  getSnapshot(): ShipmentOverviewSnapshot;
  subscribe(listener: () => void): () => void;
  /** Switch branch scope; a change drops the old snapshot and refetches. */
  setScope(scope: string): void;
  /** Fetch only if nothing is loaded for this scope and nothing is in flight. */
  ensureLoaded(): void;
  /** Force a fetch, discarding any response already in flight. */
  refresh(): void;
  /** The data changed elsewhere: drop `loaded` (keeping rows) and refetch. */
  invalidate(): void;
}

const EMPTY_OVERVIEW: ShipmentOverview = {
  counts: {},
  total: 0,
  pending: [],
  recent: [],
  pendingCapped: false,
};

const INITIAL_SNAPSHOT: ShipmentOverviewSnapshot = {
  ...EMPTY_OVERVIEW,
  scope: 'ALL',
  loaded: false,
  loading: false,
  error: '',
};

/**
 * Pending rows first, then the recent window without duplicates. `pending`
 * contains every still-in-flight row (up to the server cap) so a receive lane
 * never misses an actionable transfer; `recent` supplies the latest history.
 */
export function mergeShipmentWindow(
  pending: readonly Shipment[],
  recent: readonly Shipment[]
): Shipment[] {
  const seen = new Set<string>();
  const merged: Shipment[] = [];
  for (const row of [...pending, ...recent]) {
    const id = String(row?.id || row?.trackingCode || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(row);
  }
  return merged;
}

export function createShipmentOverviewStore(fetchOverview: ShipmentOverviewFetcher): ShipmentOverviewStore {
  let snapshot: ShipmentOverviewSnapshot = { ...INITIAL_SNAPSHOT };
  // Every fetch gets an id; a response whose id is no longer current is a
  // late answer to a superseded request (or another branch scope) and must
  // never overwrite the store.
  let requestId = 0;
  let inFlight: Promise<void> | null = null;
  let subscriberCount = 0;
  const listeners = new Set<() => void>();

  const publish = (next: ShipmentOverviewSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const start = (): void => {
    const request = ++requestId;
    const scope = snapshot.scope;
    inFlight = (async () => {
      publish({ ...snapshot, loading: true, error: '' });
      try {
        const result = await fetchOverview(scope);
        if (request !== requestId) return;
        publish({
          ...EMPTY_OVERVIEW,
          ...(result || {}),
          scope,
          loaded: true,
          loading: false,
          error: '',
        });
      } catch (err: any) {
        if (request !== requestId) return;
        // Keep the previous counts/rows: a failed refresh must not read as
        // "no transfers exist" to the receive lanes or the badges.
        publish({
          ...snapshot,
          loading: false,
          error: err?.message || 'Could not load the shipment overview.',
        });
      } finally {
        if (request === requestId) inFlight = null;
      }
    })();
  };

  const setScope = (scope: string): void => {
    const nextScope = scope || 'ALL';
    if (nextScope === snapshot.scope) return;
    // Supersede anything in flight so the previous branch's answer cannot
    // land in the new scope's snapshot.
    requestId++;
    inFlight = null;
    publish({ ...INITIAL_SNAPSHOT, scope: nextScope });
    if (subscriberCount > 0) start();
  };

  const ensureLoaded = (): void => {
    if (snapshot.loaded || inFlight) return;
    start();
  };

  const refresh = (): void => {
    start();
  };

  const invalidate = (): void => {
    requestId++;
    inFlight = null;
    publish({ ...snapshot, loaded: false });
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
    setScope,
    ensureLoaded,
    refresh,
    invalidate,
  };
}
