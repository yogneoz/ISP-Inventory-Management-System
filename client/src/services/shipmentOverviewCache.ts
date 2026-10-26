/**
 * Shipment overview cache — the app-wide consumer surface (VOL-3).
 *
 * One singleton store (shipmentOverviewStore.ts) backs the shell badges, the
 * dashboard KPI, the notification center and the receive lanes. The first
 * consumer for a branch scope fetches; the rest share the in-flight request
 * and the snapshot. App invalidates it on every SSE burst that writes
 * shipments and on every full refresh.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { Shipment } from '../types';
import { api } from './api';
import {
  createShipmentOverviewStore,
  mergeShipmentWindow,
  type ShipmentOverviewSnapshot,
} from './shipmentOverviewStore';

export const shipmentOverviewStore = createShipmentOverviewStore((scope) =>
  api.getShipmentOverview(scope)
);

/** The current snapshot (empty until the first successful load). */
export function getShipmentOverviewSnapshot(): ShipmentOverviewSnapshot {
  return shipmentOverviewStore.getSnapshot();
}

/** Every shipment the bounded window currently holds (pending first). */
export function getShipmentWindow(): Shipment[] {
  const snapshot = shipmentOverviewStore.getSnapshot();
  return mergeShipmentWindow(snapshot.pending, snapshot.recent);
}

/** Drop the snapshot's freshness and refetch when anyone is listening. */
export function invalidateShipmentOverview(): void {
  shipmentOverviewStore.invalidate();
}

/** Force a refetch (the error banner's Retry). */
export function refreshShipmentOverview(): void {
  shipmentOverviewStore.refresh();
}

/**
 * Subscribe a component to the shared overview for `scope` and ensure it
 * loads. The scope change is applied in an effect so a render never publishes
 * to the store; the snapshot returned on the first render for a new branch may
 * still belong to the previous one until that effect runs.
 */
export function useShipmentOverview(scope: string): ShipmentOverviewSnapshot & { refresh: () => void } {
  const snapshot = useSyncExternalStore(
    shipmentOverviewStore.subscribe,
    shipmentOverviewStore.getSnapshot
  );
  useEffect(() => {
    shipmentOverviewStore.setScope(scope);
    shipmentOverviewStore.ensureLoaded();
  }, [scope]);
  // One render after a branch switch the store still holds the previous
  // scope's snapshot. Never show another branch's counts while the new scope
  // loads; the effect above refetches immediately.
  const current = snapshot.scope === (scope || 'ALL') ? snapshot : null;
  return {
    ...(current || {
      counts: {},
      total: 0,
      pending: [],
      recent: [],
      pendingCapped: false,
      scope: scope || 'ALL',
      loaded: false,
      loading: true,
      error: '',
    }),
    refresh: refreshShipmentOverview,
  };
}
