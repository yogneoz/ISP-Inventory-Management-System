import type {
  InventoryStock,
  Asset,
  StockOperation,
  TransactionLog,
  CustomerDeviceRecord,
  CustomerRecord,
  ApprovalRequest,
  DocumentNumberConfig,
  SerialLog,
  SerialLookupResult,
  SerialEditPayload,
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
export async function getStock(branchId?: string): Promise<InventoryStock[]> {
  const query = branchId && branchId !== 'ALL' ? `?branchId=${branchId}` : '';
  return fetchJson(`/api/stock${query}`);
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
export async function getAssets(branchId?: string): Promise<Asset[]> {
  const query = branchId && branchId !== 'ALL' ? `?branchId=${branchId}` : '';
  return fetchJson(`/api/assets${query}`);
}

export async function createAsset(asset: Omit<Asset, 'id' | 'netBookValue' | 'accumulatedDepreciation'>): Promise<Asset> {
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
  if (params?.status && params.status !== 'ALL') search.append('status', params.status);
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

export async function updateDocumentNumberConfig(config: DocumentNumberConfig): Promise<DocumentNumberConfig> {
  return fetchJson(`/api/document-number-configs/${config.id}`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export async function updateDocumentNumberConfigs(configs: DocumentNumberConfig[]): Promise<DocumentNumberConfig[]> {
  return fetchJson('/api/document-number-configs', {
    method: 'PUT',
    body: JSON.stringify(configs),
  });
}

export async function generateNextDocumentNumber(docTypeId: string, autoIncrement = true): Promise<{ documentNumber: string; seqNum: number }> {
  return fetchJson('/api/document-number-configs/generate-next', {
    method: 'POST',
    body: JSON.stringify({ docTypeId, autoIncrement }),
  });
}

export async function resetDocumentSequence(docTypeId: string, newStartNumber?: number): Promise<{ status: string; docTypeId: string; nextNumber: number }> {
  return fetchJson('/api/document-number-configs/reset-counter', {
    method: 'POST',
    body: JSON.stringify({ docTypeId, newStartNumber }),
  });
}

// Audit Logs & Transaction Logs
export async function getAuditLogs(): Promise<import('../../types').AuditLog[]> {
  return fetchJson('/api/audit-trail');
}

export async function getTransactionLogs(): Promise<TransactionLog[]> {
  return fetchJson('/api/transaction-logs');
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
}): Promise<{ oldRecord: CustomerDeviceRecord; newRecord: CustomerDeviceRecord; message: string }> {
  return fetchJson('/api/customer-devices/exchange', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
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
  if (params?.status && params.status !== 'ALL') search.append('status', params.status);
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

export async function createSerialLogEntry(data: {
  deviceSerial: string; ponSerial?: string; macAddress?: string;
  productId?: string; productName?: string; branchId?: string;
  customerId?: string; customerName?: string;
  status?: string; sourceType?: string; sourceId?: string; notes?: string;
}): Promise<{ success: boolean; id: string }> {
  return fetchJson('/api/serial-log', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// Customer Master Database
export async function getCustomers(branchId?: string, query?: string): Promise<CustomerRecord[]> {
  const params = new URLSearchParams();
  if (branchId && branchId !== 'ALL') params.append('branchId', branchId);
  if (query) params.append('query', query);
  const queryString = params.toString() ? `?${params.toString()}` : '';
  return fetchJson(`/api/customers${queryString}`);
}

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

export async function deleteCustomer(id: string): Promise<void> {
  return fetchJson(`/api/customers/${id}`, {
    method: 'DELETE',
  });
}

// Workflow Approval Requests
export async function getApprovalRequests(branchId?: string, status?: string): Promise<ApprovalRequest[]> {
  const params = new URLSearchParams();
  if (branchId && branchId !== 'ALL') params.append('branchId', branchId);
  if (status && status !== 'ALL') params.append('status', status);
  const queryString = params.toString() ? `?${params.toString()}` : '';
  return fetchJson(`/api/approval-requests${queryString}`);
}

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
