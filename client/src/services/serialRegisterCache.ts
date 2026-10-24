/**
 * Serial register cache — the app-wide consumer surface (DF-03).
 *
 * One singleton store (serialRegisterStore.ts) backs every stock gate:
 * the 11 mounted StockOperations hosts, their panels through context, and
 * the shipment dispatch form. The first consumer fetches; the rest share
 * the in-flight request and the resulting snapshot. App invalidates it on
 * every SSE burst that writes `serial_log` and on every full refresh.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { SerialLog } from '../types';
import { api } from './api';
import { createSerialRegisterStore, type SerialRegisterSnapshot } from './serialRegisterStore';

export const serialRegisterStore = createSerialRegisterStore(() =>
  api.getSerialLogs({ all: true })
);

/** The current rows (empty until the first successful load). */
export function getSerialRegister(): SerialLog[] {
  return serialRegisterStore.getSnapshot().rows;
}

/** Drop the snapshot's freshness and refetch when anyone is listening. */
export function invalidateSerialRegister(): void {
  serialRegisterStore.invalidate();
}

/** Force a refetch (the error banner's Retry). */
export function refreshSerialRegister(): void {
  serialRegisterStore.refresh();
}

export function getSerialRegisterSnapshot(): SerialRegisterSnapshot {
  return serialRegisterStore.getSnapshot();
}

/**
 * Subscribe a component to the shared register and ensure it loads once.
 * Returns the snapshot plus a stable retry callback.
 */
export function useSerialRegister(): SerialRegisterSnapshot & { refresh: () => void } {
  const snapshot = useSyncExternalStore(
    serialRegisterStore.subscribe,
    serialRegisterStore.getSnapshot
  );
  useEffect(() => {
    serialRegisterStore.ensureLoaded();
  }, []);
  return { ...snapshot, refresh: refreshSerialRegister };
}
