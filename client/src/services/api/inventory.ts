import type {
  InventoryStock,
  Asset,
  StockOperation,
  CustomerDeviceRecord,
  CustomerRecord,
  Product,
  ApprovalRequest,
  DocumentNumberConfig,
  SerialLog,
  SerialLookupResult,
  SerialEditPayload,
  AuditLog,
  User,
} from '../../types';
import { fetchJson } from './http';

// Re-used by getSerialLogs for the history JSON column
export function safeParseHistory(v: unknown): SerialLog['history'] {
  if (Array.isArray(v)) return v as SerialLog['history'];
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Stock
/**
 * One branch's stock rows (or every branch when the caller may read all).
 *
 * The bootstrap payload's `stock` array is scoped to the branch selected in
 * the header, but the stock-operation and dispatch forms let the operator
 * pick a DIFFERENT source branch. Availability for that branch must come
 * from its own rows, or the form compares against a snapshot that never
 * contained it and reports "0 in stock" beside a serial the register says
 * is held there.
 */
export async function getStock(branchId?: string): Promise<InventoryStock[]> {
  const query = branchId && branchId !== 'ALL' ? `?branchId=${encodeURIComponent(branchId)}` : '';
  return fetchJson<InventoryStock[]>(`/api/stock${query}`);
}

export async function updateStockLevel(stockId: string, quantityOnHand: number, reason: string, damagedQty?: number, changeType?: string): Promise<InventoryStock> {
  return fetchJson(`/api/stock/${stockId}`, {
    method: 'PATCH',
    body: JSON.stringify({ quantityOnHand, reason, damagedQty, changeType }),
  });
}

export async function updateStockReorderLevel(stockId: string, minReorderLevel: number): Promise<InventoryStock> {
  return fetchJson(`/api/stock/${stockId}/reorder-level`, {
    method: 'PATCH',
    body: JSON.stringify({ minReorderLevel }),
  });
}

export async function bulkUpdateStockReorderLevels(updates: { stockId: string; minReorderLevel: number }[]): Promise<{ success: boolean; count: number }> {
  return fetchJson('/api/stock/bulk-reorder-levels', {
    method: 'POST',
    body: JSON.stringify({ updates }),
  });
}

export async function reconcileStockAudit(payload: {
  branchId: string;
  auditRefNumber: string;
  varianceItems: any[];
  auditorName?: string;
  userEmail?: string;
  notes?: string;
}): Promise<{ success: boolean; totalAdjusted: number; netFinancialImpact: number; message: string }> {
  return fetchJson('/api/stock/reconcile-audit', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// Assets
export async function createAsset(
  asset: Omit<Asset, 'id' | 'netBookValue' | 'accumulatedDepreciation'> & {
    /** Server-side stock deduction for assets created straight into deployment. */
    deployFromStock?: boolean;
    /** Serial of the IN_STOCK unit this asset consumes (serial_log flip). */
    deviceSerial?: string;
    /** PON serial / MAC of that unit — the deploy transaction writes them onto
     *  the rental-CPE customer_device_records row it creates. */
    devicePonSerial?: string;
    deviceMacAddress?: string;
  }
): Promise<Asset> {
  return fetchJson('/api/assets', {
    method: 'POST',
    body: JSON.stringify(asset),
  });
}

export async function updateAssetStatus(id: string, updates: Asset['status'] | Partial<Asset>): Promise<Asset> {
  const body = typeof updates === 'string' ? { status: updates } : updates;
  return fetchJson(`/api/assets/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

// Stock Operations (Pullout, Damage, Stock Out)
//
// Paged mode (params.page set): returns a { data, page, pageSize,
// totalItems, statusCounts } envelope so the Consumables Register never
// loads the whole ledger. params.all: every filtered row (CSV export).
// Without page/all the legacy full-array shape is returned.
export async function getStockOperations(params?: {
  branchId?: string; type?: string; status?: string; query?: string;
  dateFromAD?: string; dateToAD?: string;
  page?: number; pageSize?: number; all?: boolean;
}): Promise<StockOperation[] | { data: StockOperation[]; page: number; pageSize: number; totalItems: number; statusCounts: Record<string, number> }> {
  const search = new URLSearchParams();
  if (params?.branchId && params.branchId !== 'ALL') search.append('branchId', params.branchId);
  if (params?.type) search.append('type', params.type);
  // status filter is applied server-side via POST body, not as a query param
  if (params?.query) search.append('query', params.query);
  if (params?.dateFromAD) search.append('dateFromAD', params.dateFromAD);
  if (params?.dateToAD) search.append('dateToAD', params.dateToAD);
  if (params?.all) search.append('all', '1');
  if (params?.page !== undefined) {
    search.append('page', String(params.page));
    if (params.pageSize) search.append('pageSize', String(params.pageSize));
  }
  const query = search.toString() ? `?${search.toString()}` : '';
  return fetchJson(`/api/stock-operations${query}`);
}

export async function createStockOperation(op: Partial<StockOperation>): Promise<StockOperation> {
  return fetchJson('/api/stock-operations', {
    method: 'POST',
    body: JSON.stringify(op),
  });
}

export async function receiveStockOperation(id: string): Promise<StockOperation> {
  return fetchJson(`/api/stock-operations/${id}/receive`, {
    method: 'POST',
  });
}

// Reverse a DAMAGE stock operation: restores units to available stock and
// marks the damage record CANCELLED. Guarded to Super Admin / Inventory Manager.
export async function reverseStockOperation(
  id: string,
  reason?: string,
  user?: User | null
): Promise<{ message: string; operation: StockOperation }> {
  return fetchJson(`/api/stock-operations/${id}/reverse`, {
    method: 'POST',
    body: JSON.stringify({ reason, user }),
  });
}

// Reverse a CONSUMABLE_ISSUE stock operation: returns issued units to
// branch stock, marks the record CANCELLED, and writes a reversal ledger
// entry. Guarded by the 'consumable-issue-reverse' permission server-side.
export async function reverseConsumableIssue(
  id: string,
  reason?: string,
  user?: User | null
): Promise<{ message: string; operation: StockOperation }> {
  return fetchJson(`/api/stock-operations/${id}/reverse-consumable`, {
    method: 'POST',
    body: JSON.stringify({ reason, user }),
  });
}

// Document Numbering Configurations
export async function getDocumentNumberConfigs(): Promise<DocumentNumberConfig[]> {
  return fetchJson('/api/document-number-configs');
}

export async function updateDocumentNumberConfigs(configs: DocumentNumberConfig[]): Promise<DocumentNumberConfig[]> {
  return fetchJson('/api/document-number-configs', {
    method: 'PUT',
    body: JSON.stringify(configs),
  });
}

// Audit Logs & Transaction Logs
//
// The Audit Trail screen bootstraps the 200 newest audit rows. A serial's
// history can be older than that slice, so a serial-focused read asks the
// server for every matching row (newest first) instead of filtering locally.
export async function getAuditTrail(params: { serial?: string; branchId?: string; limit?: number } = {}): Promise<AuditLog[]> {
  const search = new URLSearchParams();
  if (params.serial) search.append('serial', params.serial);
  if (params.branchId && params.branchId !== 'ALL') search.append('branchId', params.branchId);
  if (params.limit) search.append('limit', String(params.limit));
  const queryString = search.toString() ? `?${search.toString()}` : '';
  return fetchJson(`/api/audit-trail${queryString}`);
}

// Customer Devices & Serial Numbers
export async function getCustomerDevices(branchId?: string, query?: string): Promise<CustomerDeviceRecord[]> {
  const params = new URLSearchParams();
  if (branchId && branchId !== 'ALL') params.append('branchId', branchId);
  if (query) params.append('query', query);
  const queryString = params.toString() ? `?${params.toString()}` : '';
  return fetchJson(`/api/customer-devices${queryString}`);
}

export async function createCustomerDevice(record: Omit<CustomerDeviceRecord, 'id'>): Promise<CustomerDeviceRecord> {
  return fetchJson('/api/customer-devices', {
    method: 'POST',
    body: JSON.stringify(record),
  });
}

export async function updateCustomerDeviceStatus(id: string, status: CustomerDeviceRecord['status']): Promise<CustomerDeviceRecord> {
  return fetchJson(`/api/customer-devices/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export async function exchangeCustomerDevice(payload: {
  oldDeviceId: string;
  exchangeReason: string;
  oldDeviceAction: 'DAMAGE' | 'RESTOCK' | 'DISPOSED';
  newProductId?: string;
  newProductName?: string;
  newDeviceSerial: string;
  newPonSerial: string;
  newMacAddress?: string;
  notes?: string;
  branchId?: string;
}, options?: { silentErrorToast?: boolean }): Promise<{ oldRecord: CustomerDeviceRecord; newRecord: CustomerDeviceRecord; message: string }> {
  // Both exchange dialogs show the server's refusal in their own dialog, so the
  // global toast is suppressed there: one refusal, one place, no duplicate that
  // auto-dismisses while the dialog stays open.
  return fetchJson('/api/customer-devices/exchange', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, { silent: options?.silentErrorToast });
}

// The dialogs refuse a known-bad replacement locally (fast, specific wording), so
// the attempt never reaches the exchange endpoint. Report it for the audit trail;
// a failed report must never add a second error to a refusal the operator has
// already read, hence the silent flag.
export async function reportExchangeRefusal(payload: {
  serial: string;
  reason?: string;
  branchId?: string;
}): Promise<void> {
  await fetchJson('/api/customer-devices/exchange/refusal', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, { silent: true });
}

export async function updateDeviceSerials(payload: {
  id?: string;
  sourceType?: string;
  sourceId?: string;
  oldDeviceSerial?: string;
  oldPonSerial?: string;
  oldMacAddress?: string;
  deviceSerial: string;
  ponSerial: string;
  macAddress?: string;
  branchId?: string;
}): Promise<any> {
  return fetchJson('/api/inventory/serials', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

// Resolve a typed serial value (device serial / PON / MAC) to the device
// that already holds it — powers live duplicate detection in the edit modal.
export async function lookupSerial(value: string, exclude?: string[]): Promise<SerialLookupResult> {
  const search = new URLSearchParams();
  search.append('value', value);
  (exclude || []).forEach((v) => v && search.append('exclude', v));
  return fetchJson<SerialLookupResult>(`/api/inventory/serials/lookup?${search.toString()}`);
}

// Exchange dialogs resolve a replacement serial before submitting, so a refusal
// can name the unit's actual state (assigned / damaged / other branch) instead of
// trusting a register copy loaded when the screen mounted. Its own endpoint keeps
// the edit-modal lookup's 'edit-device-serials' permission off the exchange
// audience, which includes FIELD_TECHNICIAN and BRANCH_MANAGER.
export async function lookupExchangeSerial(value: string, branchId?: string | null): Promise<SerialLookupResult> {
  // branchId is the exchange's branch: the server's branch-scoped read guard
  // requires branch-bound roles (FIELD_TECHNICIAN, BRANCH_MANAGER) to name it.
  const search = new URLSearchParams({ value: value.trim() });
  if (branchId) search.append('branchId', branchId);
  return fetchJson<SerialLookupResult>(`/api/customer-devices/exchange/lookup?${search.toString()}`);
}

// Apply two serial corrections in one operation (supports swaps).
export async function updateDeviceSerialsDual(
  a: SerialEditPayload,
  b: SerialEditPayload
): Promise<any> {
  return fetchJson('/api/inventory/serials/dual', {
    method: 'POST',
    body: JSON.stringify({ a, b }),
  });
}

// Serial Log Register (one row per unique serial)
//
// Paged mode (params.page set): returns a { data, page, pageSize, totalItems,
// statusCounts } envelope so the register never loads the whole ledger.
// params.all: fetch every filtered row (CSV export). Without page/all the
// legacy full-array shape is returned.
export async function getSerialLogs(params?: {
  branchId?: string; status?: string; query?: string;
  dateFromAD?: string; dateToAD?: string;
  page?: number; pageSize?: number; all?: boolean;
}): Promise<SerialLog[] | { data: SerialLog[]; page: number; pageSize: number; totalItems: number; statusCounts: Record<string, number> }> {
  const search = new URLSearchParams();
  if (params?.branchId && params.branchId !== 'ALL') search.append('branchId', params.branchId);
  if (params?.status) search.append('status', params.status);
  if (params?.query) search.append('query', params.query);
  if (params?.dateFromAD) search.append('dateFromAD', params.dateFromAD);
  if (params?.dateToAD) search.append('dateToAD', params.dateToAD);
  if (params?.all) search.append('all', '1');
  if (params?.page !== undefined) {
    search.append('page', String(params.page));
    if (params.pageSize) search.append('pageSize', String(params.pageSize));
  }
  const queryString = search.toString() ? `?${search.toString()}` : '';
  const parseRow = (r: any) => ({
    ...r,
    history: typeof r.history === 'string' ? safeParseHistory(r.history) : (r.historyJson ? safeParseHistory(r.historyJson) : (r.history || [])),
  });
  if (params?.page !== undefined || params?.all) {
    const envelope = await fetchJson<any>(`/api/serial-log${queryString}`);
    return { ...envelope, data: (envelope.data || []).map(parseRow) };
  }
  const rows = await fetchJson<any[]>(`/api/serial-log${queryString}`);
  return (rows || []).map(parseRow);
}

// Customer Master Database (paged server-side queries)

/** The one shape `GET /api/customers` returns (never a bare array). */
export interface CustomerListEnvelope {
  data: CustomerRecord[];
  page: number;
  pageSize: number;
  totalItems: number;
  /** ACTIVE rows under the same filters (directory KPI cards). */
  activeItems: number;
  /** Sum of credit_limit under the same filters. */
  totalCreditLimit: number;
}

export async function getCustomers(params?: {
  branchId?: string;
  query?: string;
  status?: 'ACTIVE' | 'INACTIVE';
  page?: number;
  pageSize?: number;
  /** CSV export: one envelope containing every filtered row. */
  all?: boolean;
}): Promise<CustomerListEnvelope> {
  const search = new URLSearchParams();
  if (params?.branchId && params.branchId !== 'ALL') search.append('branchId', params.branchId);
  if (params?.query) search.append('query', params.query);
  if (params?.status) search.append('status', params.status);
  if (params?.page !== undefined) {
    search.append('page', String(params.page));
    if (params.pageSize) search.append('pageSize', String(params.pageSize));
  }
  if (params?.all) search.append('all', '1');
  const queryString = search.toString() ? `?${search.toString()}` : '';
  return fetchJson<CustomerListEnvelope>(`/api/customers${queryString}`);
}

/**
 * Customer-directory search for the shared picker. Deliberately a small,
 * fixed page: the picker shows a handful of matches, never the whole 12k-row
 * directory. Screens pass this straight to <CustomerPicker search={...}> so
 * the screen-surface guards still see the read.
 */
export async function searchCustomers(query: string, limit = 20): Promise<CustomerRecord[]> {
  const q = query.trim();
  if (!q) return [];
  const envelope = await getCustomers({
    query: q,
    page: 1,
    pageSize: Math.max(1, Math.min(50, limit)),
  });
  return envelope.data;
}

// Customer Master Database
export async function createCustomer(record: Omit<CustomerRecord, 'id'> | CustomerRecord): Promise<CustomerRecord> {
  return fetchJson('/api/customers', {
    method: 'POST',
    body: JSON.stringify(record),
  });
}

export async function bulkImportCustomers(customers: CustomerRecord[]): Promise<{ success: boolean; count: number }> {
  return fetchJson('/api/customers/bulk', {
    method: 'POST',
    body: JSON.stringify({ customers }),
  });
}

export async function updateCustomer(id: string, updates: Partial<CustomerRecord>): Promise<CustomerRecord> {
  return fetchJson(`/api/customers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export async function getProducts(params?: {
  branchId?: string;
  query?: string;
  page?: number;
  pageSize?: number;
}):
  Promise<Product[] | { data: Product[]; page: number; pageSize: number; totalItems: number }> {
  const search = new URLSearchParams();
  if (params?.branchId && params.branchId !== 'ALL') search.append('branchId', params.branchId);
  if (params?.query) search.append('query', params.query);
  if (params?.page !== undefined) {
    search.append('page', String(params.page));
    if (params.pageSize) search.append('pageSize', String(params.pageSize));
  }
  const queryString = search.toString() ? `?${search.toString()}` : '';
  return fetchJson(`/api/products${queryString}`);
}

export async function deleteCustomer(id: string): Promise<void> {
  return fetchJson(`/api/customers/${id}`, {
    method: 'DELETE',
  });
}

// Workflow Approval Requests
export async function createApprovalRequest(request: Omit<ApprovalRequest, 'id' | 'requestNumber' | 'status' | 'requestedAtAD' | 'requestedAtBS'>): Promise<ApprovalRequest> {
  return fetchJson('/api/approval-requests', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export async function processApprovalRequest(id: string, status: 'APPROVED' | 'REJECTED', approverUser?: User | null, rejectionReason?: string): Promise<{ request: ApprovalRequest; message: string }> {
  return fetchJson(`/api/approval-requests/${id}/process`, {
    method: 'POST',
    body: JSON.stringify({ status, approverUser, rejectionReason }),
  });
}

export async function cancelApprovalRequest(id: string, user?: User | null, reason?: string): Promise<{ request: ApprovalRequest; message: string }> {
  return fetchJson(`/api/approval-requests/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ user, reason }),
  });
}
