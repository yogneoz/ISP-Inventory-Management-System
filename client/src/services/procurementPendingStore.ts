/**
 * Pending procurement documents — one scoped read for the KPI surfaces.
 *
 * The shell badges, the dashboard KPI and the notification panel used to scan
 * the whole `purchaseOrders` / `purchaseInvoices` bootstrap slices. Those
 * slices are already fiscal-year and branch scoped by the bootstrap endpoint,
 * but they are still whole-ledger reads. This store loads only the rows those
 * surfaces actually need:
 *
 *   - POs in an open status (everything except RECEIVED / CANCELLED), with the
 *     full row so the vendor-bill PO picker can still validate item lines.
 *   - The unpaid vendor-bill count, taken from a one-row page request whose
 *     aggregate status counts cover the whole filter.
 *
 * Scoping is explicit: callers pass the header branch and the selected fiscal
 * year's AD range. Switching either clears the previous view's rows before the
 * new read starts, and a response from an abandoned scope can never paint.
 * A failure keeps the last good rows (a KPI must not silently read 0) and
 * exposes a retryable error. This module imports no React and performs no
 * fetching of its own, so the ordering rules are unit-testable.
 */
import type { PurchaseInvoice, PurchaseOrder } from '../types';

/** Statuses a PO can still be linked to a vendor bill from. */
export const OPEN_PURCHASE_ORDER_STATUSES: readonly string[] = [
  'DRAFT',
  'APPROVED',
  'SENT',
  'IN_PROGRESS',
  'PURCHASED',
];

const OPEN_STATUS_SET = new Set(OPEN_PURCHASE_ORDER_STATUSES);

export interface ProcurementPendingScope {
  branchId?: string;
  fiscalYearStartAD?: string;
  fiscalYearEndAD?: string;
}

export interface ProcurementPendingPayload {
  pendingPurchaseOrders: PurchaseOrder[];
  unpaidInvoiceCount: number;
}

export interface ProcurementPendingSnapshot extends ProcurementPendingPayload {
  loading: boolean;
  /** Last failure for the current scope; '' once a read succeeds. */
  error: string;
  /** True only after a successful read of the current scope. */
  loaded: boolean;
  scopeKey: string;
}

export type ProcurementPendingFetcher = (
  scope: ProcurementPendingScope
) => Promise<ProcurementPendingPayload>;

export interface ProcurementPendingStore {
  getSnapshot(): ProcurementPendingSnapshot;
  subscribe(listener: () => void): () => void;
  ensureLoaded(scope: ProcurementPendingScope): void;
  /** Retry button: keep the rows, re-read the current scope. */
  refresh(): void;
  /** Data changed elsewhere: keep the rows, refetch in the background. */
  invalidate(): void;
  /** Sign-out / profile switch: the next user may see different branches. */
  reset(): void;
}

/** A stable identity for one branch + fiscal-year view. */
export function pendingScopeKey(scope: ProcurementPendingScope): string {
  return [scope.branchId || 'ALL', scope.fiscalYearStartAD || '', scope.fiscalYearEndAD || ''].join('|');
}

export function isOpenPurchaseOrder(po: Pick<PurchaseOrder, 'status'>): boolean {
  return OPEN_STATUS_SET.has(String(po.status || '').toUpperCase());
}

/** Accepts both the paged envelope and the legacy full-array shape. */
export function pendingPurchaseOrderRows(
  response:
    | PurchaseOrder[]
    | { data?: PurchaseOrder[] }
    | null
    | undefined
): PurchaseOrder[] {
  const rows = Array.isArray(response) ? response : response?.data || [];
  return rows.filter(isOpenPurchaseOrder);
}

/**
 * `PAID` is the only closed payment status; everything else (UNPAID, PARTIAL,
 * and any future partial state) is still owed. The paged envelope carries one
 * row plus status counts for the entire filtered set, so the count is exact
 * without loading the invoices themselves.
 */
export function unpaidInvoiceCountFrom(
  response:
    | PurchaseInvoice[]
    | {
        totalItems?: number;
        statusCounts?: Record<string, number>;
      }
    | null
    | undefined
): number {
  if (Array.isArray(response)) {
    return response.filter((invoice) => String(invoice.paymentStatus || '').toUpperCase() !== 'PAID').length;
  }
  const statusCounts = response?.statusCounts;
  if (statusCounts) {
    return Object.entries(statusCounts).reduce(
      (count, [status, value]) =>
        String(status).toUpperCase() === 'PAID' ? count : count + Number(value || 0),
      0
    );
  }
  return Number(response?.totalItems || 0);
}

const EMPTY_PAYLOAD: ProcurementPendingPayload = {
  pendingPurchaseOrders: [],
  unpaidInvoiceCount: 0,
};

export function createProcurementPendingStore(
  fetcher: ProcurementPendingFetcher
): ProcurementPendingStore {
  let scope: ProcurementPendingScope = {};
  let snapshot: ProcurementPendingSnapshot = {
    ...EMPTY_PAYLOAD,
    loading: false,
    error: '',
    loaded: false,
    scopeKey: '',
  };
  const listeners = new Set<() => void>();
  let subscriberCount = 0;
  let requestId = 0;
  let running = false;
  let queued = false;

  const publish = (next: ProcurementPendingSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const hasScope = (): boolean =>
    Boolean(scope.fiscalYearStartAD && scope.fiscalYearEndAD);

  const start = (): void => {
    if (!hasScope()) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    const request = ++requestId;
    const requestKey = pendingScopeKey(scope);
    const requestScope = { ...scope };
    publish({ ...snapshot, scopeKey: requestKey, loading: true, error: '' });
    fetcher(requestScope)
      .then((payload) => {
        if (request !== requestId) return;
        publish({
          pendingPurchaseOrders: Array.isArray(payload.pendingPurchaseOrders)
            ? payload.pendingPurchaseOrders
            : [],
          unpaidInvoiceCount: Number(payload.unpaidInvoiceCount || 0),
          loading: false,
          error: '',
          loaded: true,
          scopeKey: requestKey,
        });
      })
      .catch((err: unknown) => {
        if (request !== requestId) return;
        // Keep the last good rows for this scope: a failed KPI read must not
        // read as "nothing pending".
        publish({
          ...snapshot,
          scopeKey: requestKey,
          loading: false,
          loaded: false,
          error:
            err instanceof Error
              ? err.message
              : typeof err === 'string'
                ? err
                : 'Could not load pending procurement documents.',
        });
      })
      .finally(() => {
        if (request !== requestId) return;
        running = false;
        if (queued) {
          queued = false;
          start();
        }
      });
  };

  const supersede = (): void => {
    requestId++; // discard any in-flight response
    running = false;
    queued = false;
  };

  // Several hosts invalidate in the same tick (one SSE burst → shell, badge
  // and an open form). Coalesce them into one refetch.
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

    ensureLoaded: (nextScope) => {
      const nextKey = pendingScopeKey(nextScope);
      if (nextKey === snapshot.scopeKey) {
        if (!hasScope()) return;
        if (snapshot.loaded || snapshot.loading) return;
        start();
        return;
      }
      supersede();
      scope = { ...nextScope };
      // A different branch / fiscal year is a different answer: never paint
      // the previous view's rows or count while the new read is in flight.
      publish({
        ...EMPTY_PAYLOAD,
        loading: false,
        error: '',
        loaded: false,
        scopeKey: nextKey,
      });
      start();
    },

    refresh: () => {
      if (!hasScope()) return;
      supersede();
      publish({ ...snapshot, loading: false, error: '' });
      start();
    },

    invalidate: () => {
      if (!hasScope()) return;
      supersede();
      publish({ ...snapshot, loaded: false, error: '' });
      if (invalidateQueued) return;
      invalidateQueued = true;
      queueMicrotask(() => {
        invalidateQueued = false;
        // Subscriber count is checked late so a host that subscribes in the
        // same commit still gets the refetch.
        if (subscriberCount > 0) start();
      });
    },

    reset: () => {
      supersede();
      scope = {};
      publish({
        ...EMPTY_PAYLOAD,
        loading: false,
        error: '',
        loaded: false,
        scopeKey: '',
      });
    },
  };
}
