/**
 * React binding for the scoped pending-procurement store.
 *
 * The shell, dashboard and vendor-bill picker all read the same answer, so
 * they share one store and one in-flight request per branch + fiscal year.
 * App invalidates it from `refreshAllData` and from procurement/shipment SSE
 * bursts; an invalidate keeps the previous rows on screen while it refetches,
 * and a failure surfaces through the consumers' Retry notice.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import {
  createProcurementPendingStore,
  isOpenPurchaseOrder,
  OPEN_PURCHASE_ORDER_STATUSES,
  unpaidInvoiceCountFrom,
  type ProcurementPendingPayload,
  type ProcurementPendingScope,
} from './procurementPendingStore';

const PO_PAGE_SIZE = 200;
const PO_MAX_PAGES = 50;

function scopeParams(scope: ProcurementPendingScope) {
  return {
    branchId: scope.branchId,
    dateFromAD: scope.fiscalYearStartAD,
    dateToAD: scope.fiscalYearEndAD,
  };
}

async function loadOpenPurchaseOrders(
  scope: ProcurementPendingScope
): Promise<ProcurementPendingPayload['pendingPurchaseOrders']> {
  const rows: ProcurementPendingPayload['pendingPurchaseOrders'] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  while (page <= PO_MAX_PAGES && rows.length < total) {
    const response = await api.getPurchaseOrders({
      ...scopeParams(scope),
      status: OPEN_PURCHASE_ORDER_STATUSES.join(','),
      page,
      pageSize: PO_PAGE_SIZE,
    });
    if (Array.isArray(response)) {
      return response.filter(isOpenPurchaseOrder);
    }
    rows.push(...response.data.filter(isOpenPurchaseOrder));
    total = Number(response.totalItems || 0);
    if (!response.data.length) break;
    page += 1;
  }
  return rows;
}

async function fetchPendingProcurement(
  scope: ProcurementPendingScope
): Promise<ProcurementPendingPayload> {
  const loadUnpaidInvoiceCount = async (): Promise<number> => {
    // One row is enough: the envelope's statusCounts aggregate the whole
    // filtered set.
    const response = await api.getPurchaseInvoices({ ...scopeParams(scope), page: 1, pageSize: 1 });
    return unpaidInvoiceCountFrom(response);
  };

  const [pendingPurchaseOrders, unpaidInvoiceCount] = await Promise.all([
    loadOpenPurchaseOrders(scope),
    loadUnpaidInvoiceCount(),
  ]);
  return { pendingPurchaseOrders, unpaidInvoiceCount };
}

async function fetchOpenPurchaseOrders(
  scope: ProcurementPendingScope
): Promise<ProcurementPendingPayload> {
  return { pendingPurchaseOrders: await loadOpenPurchaseOrders(scope), unpaidInvoiceCount: 0 };
}

/** The shell/dashboard KPI read: header branch + selected fiscal year. */
export const procurementPendingStore = createProcurementPendingStore(fetchPendingProcurement);

/**
 * Vendor-bill PO picker: a SEPARATE instance because the bill's destination
 * branch can differ from the header. Reusing the KPI store would make choosing
 * a destination branch in the form rewrite the shell's badge scope.
 */
export const purchaseOrderPickerStore = createProcurementPendingStore(fetchOpenPurchaseOrders);

/** App calls this on every full refresh and on procurement/shipment bursts. */
export function invalidateProcurementPending(): void {
  procurementPendingStore.invalidate();
  purchaseOrderPickerStore.invalidate();
}

/** Sign-out: the next user on this tab may see different branches. */
export function resetProcurementPending(): void {
  procurementPendingStore.reset();
  purchaseOrderPickerStore.reset();
}

function usePendingProcurement(
  store: ReturnType<typeof createProcurementPendingStore>,
  scope: ProcurementPendingScope
) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const branchId = scope.branchId || '';
  const fiscalYearStartAD = scope.fiscalYearStartAD || '';
  const fiscalYearEndAD = scope.fiscalYearEndAD || '';

  useEffect(() => {
    store.ensureLoaded({
      branchId: branchId || undefined,
      fiscalYearStartAD: fiscalYearStartAD || undefined,
      fiscalYearEndAD: fiscalYearEndAD || undefined,
    });
  }, [store, branchId, fiscalYearStartAD, fiscalYearEndAD]);

  return {
    pendingPurchaseOrders: snapshot.pendingPurchaseOrders,
    unpaidInvoiceCount: snapshot.unpaidInvoiceCount,
    loading: snapshot.loading,
    error: snapshot.error,
    loaded: snapshot.loaded,
    retry: store.refresh,
  };
}

export function useProcurementPending(scope: ProcurementPendingScope) {
  return usePendingProcurement(procurementPendingStore, scope);
}

/**
 * Open POs for the branch/FY the vendor bill is being written in. Separate
 * from the KPI store so the form's destination-branch switch never changes
 * the shell's header-scoped counts.
 */
export function useOpenPurchaseOrders(scope: ProcurementPendingScope) {
  return usePendingProcurement(purchaseOrderPickerStore, scope);
}
