/**
 * Deployed customer devices for the Device Exchange tab — one shared cache,
 * scoped per branch.
 *
 * The StockOperations host read `GET /api/customer-devices` itself, once per
 * mounted host (the app keeps up to 11 of them alive), and on a failed branch
 * switch it only logged: `exchangeCustomerDevices` was replaced on success, so
 * a failed switch kept the PREVIOUS branch's units on screen under the new
 * branch's name. The exchange picker then presented another branch's devices
 * as current.
 *
 * This module is the single fetch cache for that read:
 *  - one request per branch, shared by every host (and by every remount);
 *  - rows are keyed by branch, so switching the header branch can never show
 *    the old branch's units — the new scope is empty until its own read lands;
 *  - a failed read clears that scope (never keeps units from another branch)
 *    and reports the message, which the panel renders with a Retry;
 *  - a superseded response is discarded.
 *
 * It imports neither React nor the API, so the dedupe/failure/retry behaviour
 * is unit-testable. It never writes: rows are read-only snapshots, and the
 * server stays the authority.
 */
import type { CustomerDeviceRecord } from '../types';

export interface ExchangeDevicesEntry {
  /** Rows for THIS scope only. Cleared when that scope's read fails. */
  rows: CustomerDeviceRecord[];
  loading: boolean;
  /** Last failure message for this scope; '' once a read succeeds. */
  error: string;
  loaded: boolean;
}

export type ExchangeDevicesFetcher = (
  branchId?: string
) => Promise<CustomerDeviceRecord[] | null | undefined>;

export interface ExchangeDevicesSnapshot {
  /** Bumps whenever any scope changes; the value useSyncExternalStore watches. */
  version: number;
}

export interface ExchangeDevicesStore {
  getSnapshot(): ExchangeDevicesSnapshot;
  subscribe(listener: () => void): () => void;
  /** This scope's rows (`[]` until its first successful read). */
  getEntry(scope: string): ExchangeDevicesEntry;
  /** Read this scope once, shared by every mounted host. */
  ensureLoaded(scope: string): void;
  /** Retry/refresh one scope (or every requested scope) now. */
  refresh(scope?: string): void;
  /** A mutation elsewhere: refetch the requested scopes in the background. */
  invalidate(): void;
  /** Sign-out: drop every branch's rows (the next user may see less). */
  reset(): void;
}

/** `'ALL'` (no branch filter) and a concrete branch are different scopes. */
export const exchangeScope = (branchId?: string | null): string =>
  branchId && branchId !== 'ALL' ? branchId : 'ALL';

const EMPTY: ExchangeDevicesEntry = { rows: [], loading: false, error: '', loaded: false };

const messageOf = (reason: unknown): string => {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  return 'Could not load the deployed customer devices.';
};

export function createExchangeDevicesStore(
  fetchDevices: ExchangeDevicesFetcher
): ExchangeDevicesStore {
  const entries = new Map<string, ExchangeDevicesEntry>();
  const requested = new Set<string>();
  // Every fetch gets an id per scope; a response whose id is no longer current
  // belongs to a superseded request and must never overwrite newer rows.
  const tokens = new Map<string, number>();
  let version = 0;
  let snapshot: ExchangeDevicesSnapshot = { version: 0 };
  const listeners = new Set<() => void>();
  let subscriberCount = 0;
  let invalidateQueued = false;

  const publish = (): void => {
    version += 1;
    snapshot = { version };
    for (const listener of listeners) listener();
  };

  const start = (scope: string, force: boolean): void => {
    const current = entries.get(scope);
    if (!force && (current?.loaded || current?.loading)) return;
    const token = (tokens.get(scope) || 0) + 1;
    tokens.set(scope, token);
    // A refresh keeps the rows it already has on screen; a first read starts
    // empty. Either way the previous request is superseded below.
    entries.set(scope, {
      rows: force ? current?.rows || [] : [],
      loading: true,
      error: '',
      loaded: false,
    });
    publish();
    fetchDevices(scope === 'ALL' ? undefined : scope)
      .then((rows) => {
        if (tokens.get(scope) !== token) return;
        entries.set(scope, {
          rows: Array.isArray(rows) ? rows : [],
          loading: false,
          error: '',
          loaded: true,
        });
        publish();
      })
      .catch((reason) => {
        if (tokens.get(scope) !== token) return;
        // Never keep another (or an older) branch's units: a failed read is an
        // empty, clearly-failed list until the Retry succeeds.
        entries.set(scope, { rows: [], loading: false, error: messageOf(reason), loaded: false });
        publish();
      });
  };

  return {
    getSnapshot: () => snapshot,

    subscribe: (listener) => {
      subscriberCount += 1;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        subscriberCount -= 1;
      };
    },

    getEntry: (scope) => entries.get(scope) || EMPTY,

    ensureLoaded: (scope) => {
      requested.add(scope);
      start(scope, false);
    },

    refresh: (scope) => {
      const scopes = scope ? [scope] : [...requested];
      for (const s of scopes) {
        requested.add(s);
        start(s, true);
      }
    },

    invalidate: () => {
      // Several hosts (and a multi-domain SSE burst) invalidate in the same
      // tick; coalesce them into one refetch per requested scope.
      if (invalidateQueued) return;
      invalidateQueued = true;
      queueMicrotask(() => {
        invalidateQueued = false;
        // Subscriber count is checked late: hosts that subscribe during the
        // same commit still get the refetch.
        if (subscriberCount === 0) return;
        for (const scope of requested) start(scope, true);
      });
    },

    reset: () => {
      for (const scope of requested) tokens.set(scope, (tokens.get(scope) || 0) + 1);
      entries.clear();
      requested.clear();
      publish();
    },
  };
}
