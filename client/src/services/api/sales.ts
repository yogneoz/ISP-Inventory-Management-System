/**
 * Sales API — sales invoices (INV-…) and sales returns (CN-…).
 * Mirrors the procurement module's fetchJson patterns.
 */
import { fetchJson } from './http';
import { fetchBlob } from './blob';
import type { SalesInvoice, SalesReturn, CustomerPayment } from '../../types';

// Paged mode (params.page set): returns a { data, page, pageSize,
// totalItems } envelope so the register never loads the whole ledger.
// params.all: every filtered row (CSV export). Without page/all the
// legacy full-array shape is returned.
export async function getSalesInvoices(params?: {
  branchId?: string; status?: string; query?: string;
  customerId?: string;
  dateFromAD?: string; dateToAD?: string;
  /** Posted invoices with an open balance — the Receive Payment list. */
  openOnly?: boolean;
  page?: number; pageSize?: number; all?: boolean;
  /** SCALE-2 keyset read: opaque cursor + bounded limit. */
  cursor?: string | null; limit?: number;
}): Promise<SalesInvoice[] | { data: SalesInvoice[]; items?: SalesInvoice[]; page: number; pageSize: number; totalItems?: number; nextCursor?: string | null; hasMore?: boolean }> {
  const search = new URLSearchParams();
  if (params?.branchId && params.branchId !== 'ALL') search.append('branchId', params.branchId);
  if (params?.customerId) search.append('customerId', params.customerId);
  if (params?.status && params.status !== 'ALL') search.append('status', params.status);
  if (params?.query) search.append('query', params.query);
  if (params?.dateFromAD) search.append('dateFromAD', params.dateFromAD);
  if (params?.dateToAD) search.append('dateToAD', params.dateToAD);
  if (params?.openOnly) search.append('openOnly', '1');
  if (params?.cursor) search.append('cursor', params.cursor);
  if (params?.limit !== undefined) search.append('limit', String(params.limit));
  if (params?.all) search.append('all', '1');
  if (params?.page !== undefined) {
    search.append('page', String(params.page));
    if (params.pageSize) search.append('pageSize', String(params.pageSize));
  }
  const query = search.toString() ? `?${search.toString()}` : '';
  return fetchJson(`/api/sales-invoices${query}`);
}

export async function createSalesInvoice(inv: Partial<SalesInvoice>): Promise<SalesInvoice> {
  // The server issues the invoice number via issueNextDocNumber.
  return fetchJson('/api/sales-invoices', {
    method: 'POST',
    body: JSON.stringify(inv),
  });
}

// Paged mode (params.page set): { data, page, pageSize, totalItems }
// envelope; without page/all the legacy full-array shape.
/**
 * Voids a posted sales invoice: restores stock, releases the claimed serials
 * and appends a compensating ledger row — atomically, server-side.
 */
export async function cancelSalesInvoice(id: string, reason?: string): Promise<SalesInvoice> {
  return fetchJson(`/api/sales-invoices/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function getPurchaseReturns(params?: {
  branchId?: string; status?: string; query?: string;
  dateFromAD?: string; dateToAD?: string;
  page?: number; pageSize?: number; all?: boolean;
  cursor?: string | null; limit?: number;
}): Promise<SalesReturn[] | { data: SalesReturn[]; items?: SalesReturn[]; page?: number; pageSize?: number; totalItems?: number; nextCursor?: string | null; hasMore?: boolean }> {
  const search = new URLSearchParams();
  if (params?.branchId && params.branchId !== 'ALL') search.append('branchId', params.branchId);
  if (params?.status && params.status !== 'ALL') search.append('status', params.status);
  if (params?.query) search.append('query', params.query);
  if (params?.dateFromAD) search.append('dateFromAD', params.dateFromAD);
  if (params?.dateToAD) search.append('dateToAD', params.dateToAD);
  if (params?.all) search.append('all', '1');
  if (params?.cursor) search.append('cursor', params.cursor);
  if (params?.limit !== undefined) search.append('limit', String(params.limit));
  if (params?.page !== undefined) {
    search.append('page', String(params.page));
    if (params.pageSize) search.append('pageSize', String(params.pageSize));
  }
  const query = search.toString() ? `?${search.toString()}` : '';
  return fetchJson(`/api/purchase-returns${query}`);
}

export async function createPurchaseReturn(ret: any): Promise<any> {
  return fetchJson('/api/purchase-returns', {
    method: 'POST',
    body: JSON.stringify(ret),
  });
}

export async function cancelPurchaseReturn(id: string, reason?: string): Promise<any> {
  return fetchJson(`/api/purchase-returns/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

/** Approves a DRAFT purchase return (above-threshold gating). */
export async function postPurchaseReturn(id: string): Promise<any> {
  return fetchJson(`/api/purchase-returns/${encodeURIComponent(id)}/post`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// Paged mode (params.page set): { data, page, pageSize, totalItems }
// envelope; without page/all the legacy full-array shape.
export async function getSalesReturns(params?: {
  branchId?: string; status?: string; query?: string;
  dateFromAD?: string; dateToAD?: string;
  page?: number; pageSize?: number; all?: boolean;
  cursor?: string | null; limit?: number;
}): Promise<SalesReturn[] | { data: SalesReturn[]; items?: SalesReturn[]; page?: number; pageSize?: number; totalItems?: number; nextCursor?: string | null; hasMore?: boolean }> {
  const search = new URLSearchParams();
  if (params?.branchId && params.branchId !== 'ALL') search.append('branchId', params.branchId);
  if (params?.status && params.status !== 'ALL') search.append('status', params.status);
  if (params?.query) search.append('query', params.query);
  if (params?.dateFromAD) search.append('dateFromAD', params.dateFromAD);
  if (params?.dateToAD) search.append('dateToAD', params.dateToAD);
  if (params?.all) search.append('all', '1');
  if (params?.cursor) search.append('cursor', params.cursor);
  if (params?.limit !== undefined) search.append('limit', String(params.limit));
  if (params?.page !== undefined) {
    search.append('page', String(params.page));
    if (params.pageSize) search.append('pageSize', String(params.pageSize));
  }
  const query = search.toString() ? `?${search.toString()}` : '';
  return fetchJson(`/api/sales-returns${query}`);
}

export async function createSalesReturn(ret: Partial<SalesReturn>): Promise<SalesReturn> {
  return fetchJson('/api/sales-returns', {
    method: 'POST',
    body: JSON.stringify(ret),
  });
}

export async function cancelSalesReturn(id: string, reason?: string): Promise<SalesReturn> {
  return fetchJson(`/api/sales-returns/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

/** Approves a DRAFT sales return (above-threshold gating). */
export async function postSalesReturn(id: string): Promise<SalesReturn> {
  return fetchJson(`/api/sales-returns/${encodeURIComponent(id)}/post`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function createCustomerPayment(p: Partial<CustomerPayment>): Promise<CustomerPayment> {
  // The server issues the receipt number via issueNextDocNumber (CR/BR).
  return fetchJson('/api/customer-payments', {
    method: 'POST',
    body: JSON.stringify(p),
  });
}

export async function reverseCustomerPayment(id: string, reason: string): Promise<CustomerPayment> {
  return fetchJson(`/api/customer-payments/${encodeURIComponent(id)}/reverse`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function refundCustomerPayment(id: string, reason: string): Promise<CustomerPayment> {
  return fetchJson(`/api/customer-payments/${encodeURIComponent(id)}/refund`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function chargebackCustomerPayment(id: string, reason: string): Promise<CustomerPayment> {
  return fetchJson(`/api/customer-payments/${encodeURIComponent(id)}/chargeback`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export interface LedgerLineDTO {
  id: string;
  createdAt?: string;
  documentNumber: string;
  dateAD: string;
  dateBS: string;
  amount: number;
  type: 'INVOICE' | 'PAYMENT' | 'RETURN' | 'OPENING' | 'ADJUSTMENT';
  notes?: string | null;
  paymentMethod?: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface PartyLedgerTieOut {
  partyBalance: number;
  controlBalance: number;
  subledgerBalance: number;
  difference: number;
  status: 'RECONCILED' | 'DIFFERENCE';
  controlAccountCode: string;
  controlAccountName: string;
}

export interface CustomerLedgerResponse {
  customer: { id: string; customerId?: string; name: string };
  openingBalance: number;
  openingSource: string;
  fiscalYearStartAD: string | null;
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
  ledger: LedgerLineDTO[];
  items?: LedgerLineDTO[];
  nextCursor?: string | null;
  hasMore?: boolean;
  totalEntries?: number;
  tieOut: PartyLedgerTieOut;
}

export async function getCustomerLedger(
  customerId: string,
  params?: { fromAd?: string; toAd?: string; branchId?: string; cursor?: string | null; limit?: number; all?: boolean }
): Promise<CustomerLedgerResponse> {
  const queryParams = new URLSearchParams();
  if (params?.fromAd) queryParams.set('fromAd', params.fromAd);
  if (params?.toAd) queryParams.set('toAd', params.toAd);
  if (params?.branchId) queryParams.set('branchId', params.branchId);
  if (params?.cursor) queryParams.set('cursor', params.cursor);
  if (params?.limit) queryParams.set('limit', String(params.limit));
  if (params?.all) queryParams.set('all', '1');
  const qs = queryParams.toString();
  return fetchJson(`/api/customers/${encodeURIComponent(customerId)}/ledger${qs ? `?${qs}` : ''}`);
}

/** Explicit full-statement read for the CSV export; never used by the pager. */
export async function exportCustomerLedger(
  customerId: string,
  params?: { fromAd?: string; toAd?: string; branchId?: string }
): Promise<CustomerLedgerResponse> {
  return getCustomerLedger(customerId, { ...params, all: true });
}

export async function getFieldWorkOrders(params: { branchId?: string; status?: string; customerId?: string } = {}): Promise<any[]> {
  const query = new URLSearchParams();
  if (params.branchId) query.set('branchId', params.branchId);
  if (params.status) query.set('status', params.status);
  if (params.customerId) query.set('customerId', params.customerId);
  const suffix = query.toString();
  return fetchJson(`/api/field-work-orders${suffix ? `?${suffix}` : ''}`);
}

export async function createFieldWorkOrder(input: Record<string, any>): Promise<any> {
  return fetchJson('/api/field-work-orders', { method: 'POST', body: JSON.stringify(input) });
}

export async function assignFieldWorkOrder(id: string, input: Record<string, any>): Promise<any> {
  return fetchJson(`/api/field-work-orders/${id}/assign`, { method: 'PATCH', body: JSON.stringify(input) });
}

export async function completeFieldWorkOrder(id: string, input: Record<string, any>): Promise<any> {
  return fetchJson(`/api/field-work-orders/${id}/complete`, { method: 'POST', body: JSON.stringify(input) });
}

// ---------------------------------------------------------------------------
// Proof of work — the photo or signature captured on site
// ---------------------------------------------------------------------------

export interface WorkOrderEvidence {
  id: string;
  work_order_id: string;
  branch_id: string;
  kind: 'PHOTO' | 'SIGNATURE';
  content_type: string;
  byte_size: number;
  sha256: string;
  caption: string | null;
  captured_at: string;
  captured_by: string;
  latitude: string | null;
  longitude: string | null;
  accuracy_meters: string | null;
  created_at: string;
}

export interface WorkOrderEvidenceUpload {
  kind: 'PHOTO' | 'SIGNATURE';
  contentType: string;
  dataBase64: string;
  caption?: string | null;
  capturedAtEpochMs?: number;
}

export interface WorkOrderEvidenceSaved {
  id: string;
  kind: 'PHOTO' | 'SIGNATURE';
  contentType: string;
  byteSize: number;
  sha256: string;
  capturedAt: string;
  /** False when this exact capture was already stored (a replayed upload). */
  inserted: boolean;
  count: number;
}

export async function getFieldWorkOrderEvidence(
  workOrderId: string
): Promise<{ evidence: WorkOrderEvidence[]; count: number }> {
  return fetchJson(`/api/field-work-orders/${workOrderId}/evidence`);
}

export async function postFieldWorkOrderEvidence(
  workOrderId: string,
  input: WorkOrderEvidenceUpload
): Promise<WorkOrderEvidenceSaved> {
  return fetchJson(`/api/field-work-orders/${workOrderId}/evidence`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** The bytes of one stored capture, for the read-back preview. */
export async function fetchFieldWorkOrderEvidenceContent(
  workOrderId: string,
  evidenceId: string
): Promise<Blob> {
  return fetchBlob(`/api/field-work-orders/${workOrderId}/evidence/${evidenceId}/content`);
}

// ---------------------------------------------------------------------------
// Employee stock custody (the My Stock panel / employee profile Equipment)
// ---------------------------------------------------------------------------

export type EmployeeStockMovementType = 'ISSUE' | 'RETURN' | 'CONSUME' | 'TRANSFER' | 'LOSS';

export interface EmployeeStockHolding {
  employee_id: string;
  employee_code: string;
  employee_name: string;
  product_id: string;
  product_code: string;
  product_name: string;
  branch_id: string;
  branch_name: string;
  quantity: number;
  updated_at: string;
}

export interface EmployeeStockMovement {
  id: string;
  employee_id: string;
  employee_code: string;
  employee_name: string;
  product_id: string;
  product_code: string;
  product_name: string;
  branch_id: string;
  branch_name: string;
  movement_type: EmployeeStockMovementType;
  quantity: number;
  work_order_id: string | null;
  work_order_no: string | null;
  reason: string | null;
  actor: string;
  created_at: string;
}

export interface EmployeeStockMovementInput {
  employeeId: string;
  productId: string;
  quantity: number;
  workOrderId?: string | null;
  reason?: string | null;
}

export async function getEmployeeStockHoldings(
  params: { employeeId?: string; productId?: string } = {}
): Promise<EmployeeStockHolding[]> {
  const query = new URLSearchParams();
  if (params.employeeId) query.set('employeeId', params.employeeId);
  if (params.productId) query.set('productId', params.productId);
  const suffix = query.toString();
  return fetchJson(`/api/employee-stock${suffix ? `?${suffix}` : ''}`);
}

export async function getEmployeeStockMovements(employeeId: string, limit = 100): Promise<EmployeeStockMovement[]> {
  const query = new URLSearchParams({ employeeId, limit: String(limit) });
  return fetchJson(`/api/employee-stock/movements?${query.toString()}`);
}

/** Issue, return, consume or write off units; the action names the endpoint. */
export async function recordEmployeeStockMovement(
  action: 'issue' | 'return' | 'consume' | 'loss',
  input: EmployeeStockMovementInput
): Promise<EmployeeStockMovement> {
  return fetchJson(`/api/employee-stock/${action}`, { method: 'POST', body: JSON.stringify(input) });
}

/** The branch roster custody actions pick a person from (`employee-stock-view`). */
export interface CustodyEmployee {
  id: string;
  employee_code: string;
  name: string;
  department: string | null;
  branch_id: string;
}

export async function getCustodyEmployees(): Promise<CustodyEmployee[]> {
  return fetchJson('/api/employee-stock/employees');
}

export interface EmployeeStockTransferInput {
  fromEmployeeId: string;
  toEmployeeId: string;
  productId: string;
  quantity: number;
  reason: string;
}

export interface EmployeeStockTransferResult {
  transferGroupId: string;
  from: EmployeeStockMovement;
  to: EmployeeStockMovement;
}

/** Custody person to person inside one branch; crossing branches is a 409. */
export async function transferEmployeeStock(
  input: EmployeeStockTransferInput
): Promise<EmployeeStockTransferResult> {
  return fetchJson('/api/employee-stock/transfer', { method: 'POST', body: JSON.stringify(input) });
}
