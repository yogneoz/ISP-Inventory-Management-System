/**
 * React binding for the shared exchange-device cache (exchangeDeviceStore.ts).
 *
 * `useExchangeDevices` gives the Device Exchange tab (and its host's tab-bar
 * counter) the deployed units for the header's branch from ONE shared,
 * per-branch read. App invalidates it on a full refresh and on the SSE domains
 * that write customer devices; sign-out resets it.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { CustomerDeviceRecord } from '../types';
import { api } from './api';
import { createExchangeDevicesStore, exchangeScope } from './exchangeDeviceStore';

export const exchangeDevicesStore = createExchangeDevicesStore((branchId) =>
  api.getCustomerDevices(branchId)
);

/** App calls this on every full refresh and every SSE burst that writes CPE rows. */
export function invalidateExchangeDevices(): void {
  exchangeDevicesStore.invalidate();
}

/** Sign-out: the next user on this tab may be allowed fewer branches. */
export function resetExchangeDevices(): void {
  exchangeDevicesStore.reset();
}

export interface ExchangeDevicesState {
  rows: CustomerDeviceRecord[];
  loading: boolean;
  /** Failure message for this branch's read; '' once it succeeds. */
  error: string;
  /** Re-read this branch now (the panel's Retry and the post-exchange refresh). */
  retry: () => void;
}

export function useExchangeDevices(branchId?: string | null): ExchangeDevicesState {
  const scope = exchangeScope(branchId);
  // The snapshot is a version counter, so any scope's change re-renders the
  // host; the entry itself is read below and is `[]` for an unloaded scope.
  useSyncExternalStore(exchangeDevicesStore.subscribe, exchangeDevicesStore.getSnapshot);
  useEffect(() => {
    exchangeDevicesStore.ensureLoaded(scope);
  }, [scope]);

  const entry = exchangeDevicesStore.getEntry(scope);
  return {
    rows: entry.rows,
    loading: entry.loading,
    error: entry.error,
    retry: () => exchangeDevicesStore.refresh(scope),
  };
}
