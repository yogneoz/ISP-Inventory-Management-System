/**
 * Deployed customer devices for the Device Exchange tab — one shared cache,
 * scoped per branch and per search.
 *
 * The StockOperations host read `GET /api/customer-devices` itself, once per
 * mounted host (the app keeps up to 11 of them alive), and on a failed branch
 * switch it only logged: `exchangeCustomerDevices` was replaced on success, so
 * a failed switch kept the PREVIOUS branch's units on screen under the new
 * branch's name. The exchange picker then presented another branch's devices
 * as current.
 *
 * This module is the single fetch cache for that read:
 *  - one request per scope (branch + status + search), shared by every host;
 *  - rows are keyed by branch, so switching the header branch can never show
 *    the old branch's units — the new scope is empty until its own read lands;
 *  - a failed read clears that scope (never keeps units from another branch)
 *    and reports the message, which the panel renders with a Retry;
 *  - a superseded response is discarded.
 *
 * EXCH-1: the scope now carries the typed search too. The legacy bare-array
 * read stopped at the 2,000 newest rows for a branch, so an older deployed
 * unit could not be exchanged at all; the paged read below searches the whole
 * branch server-side through the indexed expression (`CDR_SEARCH_TEXT_SQL`).
 *
 * It imports neither React nor the API, so the dedupe/failure/retry behaviour
 * is unit-testable. It never writes: rows are read-only snapshots, and the
 * server stays the authority.
 */
import type { CustomerDeviceRecord } from '../types';

/** What one scope asks the server for (branch + eligibility + typed search). */
export interface ExchangeDevicesQuery {
  branchId?: string | null;
  /** The typed term; the server searches the indexed text expression. */
  query?: string;
  /** One status or a list; only RENTAL/ACTIVE units are exchangeable. */
  status?: string | string[];
}

/** One server page plus the size of the whole matching set. */
export interface ExchangeDevicesPage {
  rows: CustomerDeviceRecord[];
  totalItems: number;
}

export interface ExchangeDevicesEntry {
  /** Rows for THIS scope only. Cleared when that scope's read fails. */
  rows: CustomerDeviceRecord[];
  /** How many rows match this scope server-side (not just the page). */
  totalItems: number;
  loading: boolean;
  /** Last failure message for this scope; '' once a read succeeds. */
  error: string;
  loaded: boolean;
}

export type ExchangeDevicesFetcher = (
  request: ExchangeDevicesQuery
) => Promise<ExchangeDevicesPage | null | undefined>;

export interface ExchangeDevicesSnapshot {
  /** Bumps whenever any scope changes; the value useSyncExternalStore watches. */
  version: number;
}

export interface ExchangeDevicesStore {
  getSnapshot(): ExchangeDevicesSnapshot;
  subscribe(listener: () => void): () => void;
  /** This scope's rows (`[]` until its first successful read). */
  getEntry(scope: string): ExchangeDevicesEntry;
  /** Read this scope once, shared by every mounted host; retried on release. */
  ensureLoaded(scope: string, query?: ExchangeDevicesQuery): void;
  /** A subscriber left this scope: stop refetching it on invalidation. */
  release(scope: string): void;
  /** Retry/refresh one scope (or every live scope) now. */
  refresh(scope?: string): void;
  /** A mutation elsewhere: refetch the live scopes in the background. */
  invalidate(): void;
  /** Sign-out: drop every branch's rows (the next user may see less). */
  reset(): void;
}

/**
 * `'ALL'` (no branch filter) and a concrete branch are different scopes.
 *
 * `scopeOf` extends the key with the eligibility filter and the typed term, so
 * each search is its own cache entry: a term typed in one host never paints
 * over another host's unfiltered list. Branches always lead the key, which is
 * what lets the store drop every other branch's rows on a switch.
 */
export const exchangeScope = (branchId?: string | null): string =>
  branchId && branchId !== 'ALL' ? branchId : 'ALL';

/** The cache key for one branch + eligibility + search combination. */
export function exchangeQueryScope(query: ExchangeDevicesQuery = {}): string {
  const branch = exchangeScope(query.branchId);
  const status = (Array.isArray(query.status) ? query.status.join(',') : query.status || '')
    .trim()
    .toUpperCase();
  const term = String(query.query || '').trim().toLowerCase();
  return [branch, status, term].filter((part, index) => index === 0 || part).join('|');
}

/** A scope's branch, used to drop stale rows from another branch. */
export const scopeBranch = (scope: string): string => scope.split('|')[0] || 'ALL';

/** The page the picker shows right now. */
export interface ExchangeDevicesView {
  rows: CustomerDeviceRecord[];
  totalItems: number;
  loading: boolean;
  error: string;
}

/**
 * What the picker renders for the current scope.
 *
 * A new search term is a new scope, so its first read would otherwise blank the
 * list between keystrokes. While it loads, keep the previous page of the SAME
 * branch on screen (marked loading); a different branch, or a failed read, must
 * show nothing rather than another branch's — or an older, failed — page.
 */
export function resolveExchangeView(
  entry: ExchangeDevicesEntry,
  branch: string,
  carried: { branch: string; rows: CustomerDeviceRecord[]; totalItems: number } | null
): ExchangeDevicesView {
  if (entry.error) return { rows: [], totalItems: 0, loading: false, error: entry.error };
  if (entry.loaded) {
    return { rows: entry.rows, totalItems: entry.totalItems, loading: false, error: '' };
  }
  if (carried && carried.branch === branch && carried.rows.length > 0) {
    return { rows: carried.rows, totalItems: carried.totalItems, loading: true, error: '' };
  }
  return { rows: entry.rows, totalItems: entry.totalItems, loading: entry.loading, error: '' };
}

/** Search scopes kept per branch; older terms are dropped as the operator types. */
const MAX_SCOPES = 6;

const EMPTY: ExchangeDevicesEntry = {
  rows: [],
  totalItems: 0,
  loading: false,
  error: '',
  loaded: false,
};

const messageOf = (reason: unknown): string => {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  return 'Could not load the deployed customer devices.';
};

export function createExchangeDevicesStore(
  fetchDevices: ExchangeDevicesFetcher
): ExchangeDevicesStore {
  const entries = new Map<string, ExchangeDevicesEntry>();
  const queries = new Map<string, ExchangeDevicesQuery>();
  /** Scopes with a live subscriber; only these are refetched. */
  const requested = new Map<string, number>();
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

  /** Keep only this scope's branch, and only the newest few search terms. */
  const prune = (scope: string): void => {
    const branch = scopeBranch(scope);
    for (const key of [...entries.keys()]) {
      if (scopeBranch(key) !== branch) {
        entries.delete(key);
        queries.delete(key);
      }
    }
    while (entries.size > MAX_SCOPES) {
      const oldest = entries.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === scope) break;
      entries.delete(oldest);
      queries.delete(oldest);
    }
  };

  const start = (scope: string, force: boolean): void => {
    const current = entries.get(scope);
    if (!force && (current?.loaded || current?.loading)) return;
    const token = (tokens.get(scope) || 0) + 1;
    tokens.set(scope, token);
    prune(scope);
    const query: ExchangeDevicesQuery = { ...(queries.get(scope) || {}) };
    // A refresh keeps the rows it already has on screen — for the SAME branch
    // that is also what makes typing not blank the list between keystrokes; a
    // first read starts empty. Either way the previous request is superseded.
    entries.set(scope, {
      rows: force ? current?.rows || [] : [],
      totalItems: force ? current?.totalItems || 0 : 0,
      loading: true,
      error: '',
      loaded: false,
    });
    publish();
    fetchDevices(query)
      .then((result) => {
        if (tokens.get(scope) !== token) return;
        entries.set(scope, {
          rows: Array.isArray(result?.rows) ? result.rows : [],
          totalItems: Number(result?.totalItems) || 0,
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
        entries.set(scope, {
          rows: [],
          totalItems: 0,
          loading: false,
          error: messageOf(reason),
          loaded: false,
        });
        publish();
      });
  };

  const liveScopes = (): string[] => [...requested.keys()];

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

    ensureLoaded: (scope, query) => {
      requested.set(scope, (requested.get(scope) || 0) + 1);
      if (query) queries.set(scope, { ...query });
      start(scope, false);
    },

    release: (scope) => {
      const count = (requested.get(scope) || 0) - 1;
      if (count > 0) requested.set(scope, count);
      else requested.delete(scope);
    },

    refresh: (scope) => {
      const scopes = scope ? [scope] : liveScopes();
      for (const key of scopes) {
        requested.set(key, Math.max(1, requested.get(key) || 0));
        start(key, true);
      }
    },

    invalidate: () => {
      // Several hosts (and a multi-domain SSE burst) invalidate in the same
      // tick; coalesce them into one refetch per live scope.
      if (invalidateQueued) return;
      invalidateQueued = true;
      queueMicrotask(() => {
        invalidateQueued = false;
        // Subscriber count is checked late: hosts that subscribe during the
        // same commit still get the refetch.
        if (subscriberCount === 0) return;
        for (const scope of liveScopes()) start(scope, true);
      });
    },

    reset: () => {
      for (const scope of new Set([...requested.keys(), ...entries.keys()])) {
        tokens.set(scope, (tokens.get(scope) || 0) + 1);
      }
      entries.clear();
      queries.clear();
      requested.clear();
      publish();
    },
  };
}
