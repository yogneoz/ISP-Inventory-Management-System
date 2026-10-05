/**
 * Sales API — sales invoices (INV-…) and sales returns (CN-…).
 * Mirrors the procurement module's fetchJson patterns.
 */
import { fetchJson } from './http';
import type { SalesInvoice, SalesReturn, CustomerPayment } from '../../types';

// Paged mode (params.page set): returns a { data, page, pageSize,
// totalItems } envelope so the register never loads the whole ledger.
// params.all: every filtered row (CSV export). Without page/all the
// legacy full-array shape is returned.
export async function getSalesInvoices(params?: {
  branchId?: string; status?: string; query?: string;
  dateFromAD?: string; dateToAD?: string;
  page?: number; pageSize?: number; all?: boolean;
}): Promise<SalesInvoice[] | { data: SalesInvoice[]; page: number; pageSize: number; totalItems: number }> {
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
}): Promise<SalesReturn[] | { data: SalesReturn[]; page: number; pageSize: number; totalItems: number }> {
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
}): Promise<SalesReturn[] | { data: SalesReturn[]; page: number; pageSize: number; totalItems: number }> {
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

export interface LedgerLineDTO {
  id: string;
  documentNumber: string;
  dateAD: string;
  dateBS: string;
  amount: number;
  type: 'INVOICE' | 'PAYMENT' | 'RETURN';
  notes?: string | null;
  paymentMethod?: string;
  debit: number;
  credit: number;
  balance: number;
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
}

export async function getCustomerLedger(
  customerId: string,
  params?: { fromAd?: string; toAd?: string; branchId?: string }
): Promise<CustomerLedgerResponse> {
  const queryParams = new URLSearchParams();
  if (params?.fromAd) queryParams.set('fromAd', params.fromAd);
  if (params?.toAd) queryParams.set('toAd', params.toAd);
  if (params?.branchId) queryParams.set('branchId', params.branchId);
  const qs = queryParams.toString();
  return fetchJson(`/api/customers/${encodeURIComponent(customerId)}/ledger${qs ? `?${qs}` : ''}`);
}
