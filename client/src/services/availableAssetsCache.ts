/**
 * The assignable fixed-asset list — one shared, app-wide read.
 *
 * The Assign Fixed Asset picker (inside StockOperations) needs every ACTIVE,
 * unassigned asset it can act on. ASSET-1 moved that list off the bootstrap and
 * onto the bounded server read (`/api/fixed-assets/available`). StockOperations
 * keeps up to 11 hosts mounted at once, so fetching per host would issue 11
 * identical requests; this module keeps one shared entry instead.
 *
 * It never writes and never widens the scope: the server applies the session's
 * branch permissions. A failed read reports the message so the picker can say
 * the list is unavailable rather than presenting an empty "no assets" state.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { Asset } from '../types';
import { api } from './api';

export interface AvailableAssetsEntry {
  rows: Asset[];
  /** True when the server cap was hit and the list is a prefix. */
  truncated: boolean;
  loading: boolean;
  error: string;
  loaded: boolean;
}

const EMPTY: AvailableAssetsEntry = {
  rows: [],
  truncated: false,
  loading: false,
  error: '',
  loaded: false,
};

let entry: AvailableAssetsEntry = EMPTY;
let version = 0;
const listeners = new Set<() => void>();
let token = 0;

const messageOf = (reason: unknown): string => {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  return 'Could not load the assignable fixed assets.';
};

function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function load(): void {
  const current = ++token;
  const hadRows = entry.loaded;
  entry = { ...entry, loading: true, error: '', loaded: hadRows };
  publish();
  api
    .getAvailableFixedAssets()
    .then((result) => {
      if (current !== token) return;
      entry = {
        rows: Array.isArray(result?.data) ? result.data : [],
        truncated: Boolean(result?.truncated),
        loading: false,
        error: '',
        loaded: true,
      };
      publish();
    })
    .catch((reason) => {
      if (current !== token) return;
      entry = { rows: [], truncated: false, loading: false, error: messageOf(reason), loaded: false };
      publish();
    });
}

/** Drop the cached list and re-read it now (asset mutations / full refresh). */
export function invalidateAvailableFixedAssets(): void {
  load();
}

/** Sign-out: the next user may see a narrower scope. */
export function resetAvailableFixedAssets(): void {
  token += 1;
  entry = EMPTY;
  publish();
}

export function useAvailableFixedAssets(refreshToken = 0): AvailableAssetsEntry {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version
  );
  useEffect(() => {
    if (!entry.loaded && !entry.loading) load();
  }, []);
  useEffect(() => {
    if (refreshToken > 0) load();
  }, [refreshToken]);
  return entry;
}
