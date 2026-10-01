/**
 * Sales API — sales invoices (INV-…) and sales returns (CN-…).
 * Mirrors the procurement module's fetchJson patterns.
 */
import { fetchJson } from './http';
import type { SalesInvoice, SalesReturn } from '../../types';

export async function getSalesInvoices(params?: { branchId?: string }): Promise<SalesInvoice[]> {
  const qs = params?.branchId ? `?branchId=${encodeURIComponent(params.branchId)}` : '';
  return fetchJson(`/api/sales-invoices${qs}`);
}

export async function createSalesInvoice(inv: Partial<SalesInvoice>): Promise<SalesInvoice> {
  // The server issues the invoice number via issueNextDocNumber.
  return fetchJson('/api/sales-invoices', {
    method: 'POST',
    body: JSON.stringify(inv),
  });
}

export async function getPurchaseReturns(params?: { branchId?: string }): Promise<SalesReturn[]> {
  const qs = params?.branchId ? `?branchId=${encodeURIComponent(params.branchId)}` : '';
  return fetchJson(`/api/purchase-returns${qs}`) as unknown as Promise<SalesReturn[]>;
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

export async function getSalesReturns(params?: { branchId?: string }): Promise<SalesReturn[]> {
  const qs = params?.branchId ? `?branchId=${encodeURIComponent(params.branchId)}` : '';
  return fetchJson(`/api/sales-returns${qs}`);
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
