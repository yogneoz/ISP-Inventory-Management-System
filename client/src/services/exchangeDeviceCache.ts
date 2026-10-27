/**
 * React binding for the shared exchange-device cache (exchangeDeviceStore.ts).
 *
 * `useExchangeDevices` gives the Device Exchange tab (and its host's tab-bar
 * counter) the deployed units for the header's branch from ONE shared,
 * per-branch read. App invalidates it on a full refresh and on the SSE domains
 * that write customer devices; sign-out resets it.
 *
 * EXCH-1: the read is the paged register endpoint, not the bounded legacy
 * array. The term the operator types is searched server-side through the
 * indexed text expression, so a branch above the legacy 2,000-row cap can still
 * reach — and exchange — an older deployed unit. The store keeps the previously
 * loaded page on screen while a new term loads; a term whose read fails is
 * reported, never replaced with another branch's rows.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CustomerDeviceRecord } from '../types';
import { api } from './api';
import {
  createExchangeDevicesStore,
  exchangeQueryScope,
  resolveExchangeView,
  scopeBranch,
  type ExchangeDevicesPage,
  type ExchangeDevicesQuery,
} from './exchangeDeviceStore';

/** Only these statuses are exchangeable: sold units are customer-owned. */
export const EXCHANGE_DEVICE_STATUSES = ['RENTAL', 'ACTIVE'] as const;
/** One screenful of choices; the server search finds the rest by term. */
export const EXCHANGE_DEVICE_PAGE_SIZE = 50;
/** Wait for a pause in typing before asking the server. */
export const EXCHANGE_DEBOUNCE_MS = 250;

export const exchangeDevicesStore = createExchangeDevicesStore(async (request): Promise<ExchangeDevicesPage> => {
  const page = await api.getCustomerDevicePage(
    { branchId: request.branchId || undefined, query: request.query, status: [...EXCHANGE_DEVICE_STATUSES] },
    1,
    EXCHANGE_DEVICE_PAGE_SIZE
  );
  return {
    rows: Array.isArray(page?.data) ? page.data : [],
    totalItems: Number(page?.totalItems) || 0,
  };
});

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
  /** How many rows match this branch + search server-side. */
  totalItems: number;
  loading: boolean;
  /** Failure message for this read; '' once it succeeds. */
  error: string;
  /** Re-read this scope now (the panel's Retry and the post-exchange refresh). */
  retry: () => void;
}

export function useExchangeDevices(
  branchId?: string | null,
  searchTerm?: string
): ExchangeDevicesState {
  const scope = exchangeQueryScope({ branchId, query: searchTerm });
  // The snapshot is a version counter, so any scope's change re-renders the
  // host; the entry itself is read below and is `[]` for an unloaded scope.
  useSyncExternalStore(exchangeDevicesStore.subscribe, exchangeDevicesStore.getSnapshot);

  // Debounced load: typing issues one request after the pause, not one per key,
  // and the previous page stays on screen while the next one loads.
  const [, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The branch last read by THIS host, so a branch switch (and the first mount)
  // reads at once while only a typed term waits for the pause.
  const lastBranch = useRef<{ branch: string | null | undefined } | null>(null);
  useEffect(() => {
    const request: ExchangeDevicesQuery = {
      branchId: branchId || undefined,
      query: String(searchTerm || '').trim() || undefined,
      status: [...EXCHANGE_DEVICE_STATUSES],
    };
    const branchChanged = !lastBranch.current || lastBranch.current.branch !== branchId;
    lastBranch.current = { branch: branchId };
    if (branchChanged) {
      if (timer.current) clearTimeout(timer.current);
      exchangeDevicesStore.ensureLoaded(scope, request);
      setTick((n) => n + 1);
    } else {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        exchangeDevicesStore.ensureLoaded(scope, request);
        setTick((n) => n + 1);
      }, EXCHANGE_DEBOUNCE_MS);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
      exchangeDevicesStore.release(scope);
    };
  }, [scope, branchId, searchTerm]);

  // Keep the previous page of this branch on screen while a typed term loads;
  // a branch switch or a failed read never carries rows (EXCH-1, DF-16).
  const entry = exchangeDevicesStore.getEntry(scope);
  const carried = useRef<{ branch: string; rows: CustomerDeviceRecord[]; totalItems: number } | null>(null);
  if (entry.loaded && !entry.error) {
    carried.current = { branch: scopeBranch(scope), rows: entry.rows, totalItems: entry.totalItems };
  }
  const view = resolveExchangeView(entry, scopeBranch(scope), carried.current);
  return {
    rows: view.rows,
    totalItems: view.totalItems,
    loading: view.loading,
    error: view.error,
    retry: () => exchangeDevicesStore.refresh(scope),
  };
}
