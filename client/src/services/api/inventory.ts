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
  TransactionLog,
  User,
  CustomerDeviceOverview,
  CustomerDevicePage,
  WarrantyDirectoryPage,
  FixedAssetPage,
  FixedAssetOverview,
} from '../../types';
import { fetchJson, getActiveBranchId } from './http';

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
    /** WTY-4: exact supplier warranty expiry captured with the asset. */
    supplierWarrantyEndDateAD?: string;
    /** WTY-5: false declares "no supplier warranty" for this asset. */
    supplierWarrantyCovered?: boolean;
    /** WTY-5: the customer promise captured when a rental CPE is deployed. */
    sellerWarrantyEndDateAD?: string;
    sellerWarrantyCovered?: boolean;
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

/**
 * ASSET-1: `fixed_assets` is no longer on the bootstrap. These reads are
 * branch-scoped from the session; the shell's active branch is the default so a
 * branch role always names a branch the route guard accepts, and a global scope
 * sends nothing.
 */
export interface FixedAssetQueryParams {
  branchId?: string;
  query?: string;
  /** One status or a list; the server whitelists them. */
  status?: string | string[];
  category?: string;
  /** Asset Deployments: only rows assigned to a customer or location. */
  assigned?: boolean;
  assignedType?: 'CUSTOMER' | 'LOCATION';
  assignedLocationId?: string;
  acquisitionFrom?: string;
  acquisitionTo?: string;
  /** Page order: register (default) or the date-wise depreciation view. */
  sort?: 'invoiceDate';
}

/** The statement/closing/dashboard aggregate options. */
export interface FixedAssetOverviewParams extends FixedAssetQueryParams {
  /** The as-of date the totals are computed for (defaults to today, server). */
  asOf?: string;
  byBranch?: boolean;
  /** The Depreciation Register's grouped summary. */
  groupBy?: 'master';
  /** Include every category in the branch+search scope (filter dropdown). */
  categories?: boolean;
}

function fixedAssetQueryString(
  params: FixedAssetQueryParams,
  extra: Record<string, string | number | undefined> = {}
): string {
  const search = new URLSearchParams();
  // 'ALL' means no branch filter; the server still applies the session scope.
  if (params.branchId && params.branchId !== 'ALL') search.append('branchId', params.branchId);
  if (params.query) search.append('query', params.query);
  const statuses = Array.isArray(params.status) ? params.status.join(',') : params.status;
  if (statuses) search.append('status', statuses);
  if (params.category && params.category !== 'ALL') search.append('category', params.category);
  if (params.assigned) search.append('assigned', '1');
  if (params.assignedType) search.append('assignedType', params.assignedType);
  if (params.assignedLocationId && params.assignedLocationId !== 'ALL') {
    search.append('assignedLocationId', params.assignedLocationId);
  }
  if (params.acquisitionFrom) search.append('acquisitionFrom', params.acquisitionFrom);
  if (params.acquisitionTo) search.append('acquisitionTo', params.acquisitionTo);
  if (params.sort) search.append('sort', params.sort);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') search.append(key, String(value));
  }
  const queryString = search.toString();
  return queryString ? `?${queryString}` : '';
}

/** One server-paged slice of the fixed-asset register. */
export async function getFixedAssetPage(
  params: FixedAssetQueryParams = {},
  page = 1,
  pageSize = 15
): Promise<FixedAssetPage> {
  return fetchJson(`/api/fixed-assets/page${fixedAssetQueryString(params, { page, pageSize })}`);
}

/** CSV/report export: every matching row, capped server-side with `truncated`. */
export async function getFixedAssetExport(params: FixedAssetQueryParams = {}): Promise<FixedAssetPage> {
  return fetchJson(`/api/fixed-assets/page${fixedAssetQueryString(params, { all: 1 })}`);
}

/** Counts, formula totals and the closing diagnostics, from one row set. */
export async function getFixedAssetOverview(params: FixedAssetOverviewParams = {}): Promise<FixedAssetOverview> {
  const search = new URLSearchParams();
  if (params.branchId && params.branchId !== 'ALL') search.append('branchId', params.branchId);
  if (params.query) search.append('query', params.query);
  if (params.category && params.category !== 'ALL') search.append('category', params.category);
  if (params.acquisitionFrom) search.append('acquisitionFrom', params.acquisitionFrom);
  if (params.acquisitionTo) search.append('acquisitionTo', params.acquisitionTo);
  if (params.asOf) search.append('asOf', params.asOf);
  if (params.byBranch) search.append('byBranch', '1');
  if (params.groupBy) search.append('groupBy', params.groupBy);
  if (params.categories) search.append('categories', '1');
  const queryString = search.toString();
  return fetchJson(`/api/fixed-assets/overview${queryString ? `?${queryString}` : ''}`);
}

/** The deployment pickers' bounded ACTIVE/unassigned read. */
export async function getAvailableFixedAssets(
  params: FixedAssetQueryParams = {}
): Promise<{ data: Asset[]; truncated: boolean }> {
  return fetchJson(`/api/fixed-assets/available${fixedAssetQueryString(params)}`);
}

/** Resolve one asset by id, tag number or device serial (branch-scoped). */
export async function lookupFixedAsset(
  value: { id?: string; tagNumber?: string; serial?: string },
  branchId?: string
): Promise<Asset> {
  const search = new URLSearchParams();
  if (branchId && branchId !== 'ALL') search.append('branchId', branchId);
  if (value.id) search.append('id', value.id);
  if (value.tagNumber) search.append('tag', value.tagNumber);
  if (value.serial) search.append('serial', value.serial);
  return fetchJson(`/api/fixed-assets/lookup?${search.toString()}`);
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

/** SER-1/D2: reverse a pullout dispatch (units return from IN_TRANSIT). */
export async function reversePulloutOperation(
  id: string,
  reason?: string,
  user?: User | null
): Promise<{ message: string; operation: StockOperation }> {
  return fetchJson(`/api/stock-operations/${id}/reverse-pullout`, {
    method: 'POST',
    body: JSON.stringify({ reason, user }),
  });
}

/** SER-1/D2: reverse a product-sale stock-out (units return from SOLD). */
export async function reverseStockOutOperation(
  id: string,
  reason?: string,
  user?: User | null
): Promise<{ message: string; operation: StockOperation }> {
  return fetchJson(`/api/stock-operations/${id}/reverse-stock-out`, {
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

/**
 * One page of the movement ledger. The server pins branch scope from the
 * session for non-global roles; the client cannot widen it by omitting
 * `branchId` or passing `ALL`.
 */
export interface TransactionLogPage {
  data: TransactionLog[];
  page: number;
  pageSize: number;
  totalItems: number;
  /** True when `all: true` hit the server's export/window cap. */
  capped: boolean;
}

export async function getTransactionLogs(params: {
  branchId?: string;
  productId?: string;
  dateFromAD?: string;
  dateToAD?: string;
  page?: number;
  pageSize?: number;
  all?: boolean;
  order?: 'asc' | 'desc';
} = {}): Promise<TransactionLogPage> {
  const search = new URLSearchParams();
  if (params.branchId && params.branchId !== 'ALL') search.append('branchId', params.branchId);
  if (params.productId && params.productId !== 'ALL') search.append('productId', params.productId);
  if (params.dateFromAD) search.append('dateFromAD', params.dateFromAD);
  if (params.dateToAD) search.append('dateToAD', params.dateToAD);
  if (params.order === 'asc') search.append('order', 'asc');
  if (params.all) {
    search.append('all', '1');
  } else {
    search.append('page', String(params.page ?? 1));
    if (params.pageSize) search.append('pageSize', String(params.pageSize));
  }
  const queryString = search.toString() ? `?${search.toString()}` : '';
  return fetchJson<TransactionLogPage>(`/api/transaction-logs${queryString}`);
}

// Customer Devices & Serial Numbers
/**
 * VOL-4b: the device reads are paged and branch-scoped from the session. The
 * shell's active branch is the default so a branch role always names a branch
 * the route guard accepts; a global 'ALL' scope sends nothing.
 */
function deviceBranchParam(branchId?: string): string | undefined {
  return (branchId && branchId !== 'ALL' ? branchId : getActiveBranchId()) || undefined;
}

export interface CustomerDeviceQueryParams {
  branchId?: string;
  query?: string;
  /** Exact customer attribution (the directory's expanded-row read). */
  customerId?: string;
  /** One status or a list; the server whitelists them. */
  status?: string | string[];
  productName?: string;
  issuedFrom?: string;
  issuedTo?: string;
}

function customerDeviceQueryString(params: CustomerDeviceQueryParams, extra: Record<string, string | number | undefined> = {}): string {
  const search = new URLSearchParams();
  const branchId = deviceBranchParam(params.branchId);
  if (branchId) search.append('branchId', branchId);
  if (params.query) search.append('query', params.query);
  if (params.customerId) search.append('customerId', params.customerId);
  const statuses = Array.isArray(params.status) ? params.status.join(',') : params.status;
  if (statuses) search.append('status', statuses);
  if (params.productName) search.append('productName', params.productName);
  if (params.issuedFrom) search.append('issuedFrom', params.issuedFrom);
  if (params.issuedTo) search.append('issuedTo', params.issuedTo);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') search.append(key, String(value));
  }
  const queryString = search.toString();
  return queryString ? `?${queryString}` : '';
}

/** One server-paged slice of the device register. */
export async function getCustomerDevicePage(
  params: CustomerDeviceQueryParams = {},
  page = 1,
  pageSize = 15
): Promise<CustomerDevicePage> {
  return fetchJson(`/api/customer-devices/page${customerDeviceQueryString(params, { page, pageSize })}`);
}

/** CSV export: every matching row, capped server-side with a `truncated` flag. */
export async function getCustomerDeviceExport(params: CustomerDeviceQueryParams = {}): Promise<CustomerDevicePage> {
  return fetchJson(`/api/customer-devices/page${customerDeviceQueryString(params, { all: 1 })}`);
}

/** Exact per-status counts for the register KPIs. */
export async function getCustomerDeviceOverview(params: CustomerDeviceQueryParams = {}): Promise<CustomerDeviceOverview> {
  return fetchJson(`/api/customer-devices/overview${customerDeviceQueryString(params)}`);
}

/** The warranty directory: CPE + fixed assets, paged, with computed states. */
export async function getCustomerDeviceWarranty(
  params: CustomerDeviceQueryParams & { warranty?: string; category?: string } = {},
  page = 1,
  pageSize = 15
): Promise<WarrantyDirectoryPage> {
  return fetchJson(
    `/api/customer-devices/warranty${customerDeviceQueryString(params, {
      page,
      pageSize,
      warranty: params.warranty,
      category: params.category,
    })}`
  );
}

export async function createCustomerDevice(
  record: Omit<CustomerDeviceRecord, 'id'> & {
    /** WTY-5: the seller warranty captured at issue (false = none). */
    sellerWarrantyEndDateAD?: string | null;
    sellerWarrantyCovered?: boolean;
  }
): Promise<CustomerDeviceRecord> {
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
  /** WTY-5: the seller warranty on the replacement (false = none). */
  sellerWarrantyEndDateAD?: string;
  sellerWarrantyCovered?: boolean;
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
 *
 * VOL-4a: the request names the branch the shell is in. `/api/customers` is a
 * branch-scoped read, and the server answers 403 (not "all my branches") when a
 * branch account omits the parameter, so an unscoped search looked like an
 * empty directory to every non-global user.
 */
export async function searchCustomers(query: string, limit = 20): Promise<CustomerRecord[]> {
  const q = query.trim();
  if (!q) return [];
  const envelope = await getCustomers({
    branchId: getActiveBranchId() || undefined,
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
