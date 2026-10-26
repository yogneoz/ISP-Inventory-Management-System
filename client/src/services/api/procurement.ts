import type {
  Product,
  Supplier,
  PurchaseOrder,
  PurchaseInvoice,
  Shipment,
  VendorPayment,
  User,
} from '../../types';
import { fetchJson } from './http';

// Branches
export async function createBranch(branch: Omit<import('../../types').Branch, 'id'>): Promise<import('../../types').Branch> {
  return fetchJson('/api/branches', {
    method: 'POST',
    body: JSON.stringify(branch),
  });
}

export async function updateBranch(id: string, branch: Partial<import('../../types').Branch>): Promise<import('../../types').Branch> {
  return fetchJson(`/api/branches/${id}`, {
    method: 'PUT',
    body: JSON.stringify(branch),
  });
}

export async function deleteBranch(id: string): Promise<{ success: boolean }> {
  return fetchJson(`/api/branches/${id}`, {
    method: 'DELETE',
  });
}

// Suppliers
export async function createSupplier(supplier: Omit<Supplier, 'id' | 'rating'>): Promise<Supplier> {
  return fetchJson('/api/suppliers', {
    method: 'POST',
    body: JSON.stringify(supplier),
  });
}

export async function updateSupplier(id: string, supplier: Partial<Supplier>): Promise<Supplier> {
  return fetchJson(`/api/suppliers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(supplier),
  });
}

export async function deleteSupplier(id: string): Promise<{ success: boolean }> {
  return fetchJson(`/api/suppliers/${id}`, {
    method: 'DELETE',
  });
}

// Users
export async function createUser(user: Omit<User, 'id'> & { password?: string }): Promise<User> {
  return fetchJson('/api/users', {
    method: 'POST',
    body: JSON.stringify(user),
  });
}

export async function updateUser(id: string, user: Partial<User>): Promise<User> {
  return fetchJson(`/api/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify(user),
  });
}

export async function deleteUser(id: string): Promise<{ success: boolean }> {
  return fetchJson(`/api/users/${id}`, {
    method: 'DELETE',
  });
}

export async function resetUserPassword(id: string, newPassword: string): Promise<{ success: boolean; message: string; user: User }> {
  return fetchJson(`/api/users/${id}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ newPassword }),
  });
}

// Products
export async function createProduct(product: Omit<Product, 'id'>): Promise<Product> {
  return fetchJson('/api/products', {
    method: 'POST',
    body: JSON.stringify(product),
  });
}

export async function updateProduct(id: string, product: Partial<Product>): Promise<Product> {
  return fetchJson(`/api/products/${id}`, {
    method: 'PUT',
    body: JSON.stringify(product),
  });
}

export async function deleteProduct(id: string): Promise<{ success: boolean }> {
  return fetchJson(`/api/products/${id}`, {
    method: 'DELETE',
  });
}

// Purchase Orders
//
// Paged mode (params.page set): returns a { data, page, pageSize,
// totalItems, statusCounts, pendingValue, receivedValue } envelope so the
// register never loads the whole ledger. params.all: every filtered row
// (CSV export). Without page/all the legacy full-array shape is returned.
export async function getPurchaseOrders(params?: {
  branchId?: string; status?: string; supplier?: string; query?: string;
  dateFromAD?: string; dateToAD?: string;
  page?: number; pageSize?: number; all?: boolean;
}): Promise<PurchaseOrder[] | { data: PurchaseOrder[]; page: number; pageSize: number; totalItems: number; statusCounts: Record<string, number>; pendingValue: number; receivedValue: number }> {
  const search = new URLSearchParams();
  if (params?.branchId && params.branchId !== 'ALL') search.append('branchId', params.branchId);
  if (params?.status && params.status !== 'ALL') search.append('status', params.status);
  if (params?.supplier && params.supplier !== 'ALL') search.append('supplier', params.supplier);
  if (params?.query) search.append('query', params.query);
  if (params?.dateFromAD) search.append('dateFromAD', params.dateFromAD);
  if (params?.dateToAD) search.append('dateToAD', params.dateToAD);
  if (params?.all) search.append('all', '1');
  if (params?.page !== undefined) {
    search.append('page', String(params.page));
    if (params.pageSize) search.append('pageSize', String(params.pageSize));
  }
  const query = search.toString() ? `?${search.toString()}` : '';
  return fetchJson(`/api/purchase-orders${query}`);
}

export async function createPurchaseOrder(po: Omit<PurchaseOrder, 'id' | 'poNumber' | 'subtotalAmount' | 'taxAmount' | 'totalAmount'> & { poNumber?: string }): Promise<PurchaseOrder> {
  // The server issues the PO number via issueNextDocNumber (per-branch daily
  // atomic counter). Only pass one through when the caller explicitly set it.
  return fetchJson('/api/purchase-orders', {
    method: 'POST',
    body: JSON.stringify(po),
  });
}

export async function updatePurchaseOrder(id: string, poData: Partial<PurchaseOrder>): Promise<PurchaseOrder> {
  return fetchJson(`/api/purchase-orders/${id}`, {
    method: 'PUT',
    body: JSON.stringify(poData),
  });
}

export async function updatePurchaseOrderStatus(id: string, status: string): Promise<PurchaseOrder> {
  return fetchJson(`/api/purchase-orders/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export async function deletePurchaseOrder(id: string): Promise<{ success: boolean }> {
  return fetchJson(`/api/purchase-orders/${id}`, { method: 'DELETE' });
}

// Purchase Invoices
//
// Paged mode (params.page set): returns a { data, page, pageSize,
// totalItems, statusCounts, sums } envelope so the register never loads the
// whole ledger. params.all: every filtered row (CSV export). Without
// page/all the legacy full-array shape is returned.
export async function getPurchaseInvoices(params?: {
  branchId?: string; paymentStatus?: string; supplier?: string; query?: string;
  dateFromAD?: string; dateToAD?: string;
  page?: number; pageSize?: number; all?: boolean;
}): Promise<PurchaseInvoice[] | { data: PurchaseInvoice[]; page: number; pageSize: number; totalItems: number; statusCounts: Record<string, number>; sums: { taxable: number; vat: number; grand: number; unpaid: number } }> {
  const search = new URLSearchParams();
  if (params?.branchId && params.branchId !== 'ALL') search.append('branchId', params.branchId);
  if (params?.paymentStatus && params.paymentStatus !== 'ALL') search.append('paymentStatus', params.paymentStatus);
  if (params?.supplier && params.supplier !== 'ALL') search.append('supplier', params.supplier);
  if (params?.query) search.append('query', params.query);
  if (params?.dateFromAD) search.append('dateFromAD', params.dateFromAD);
  if (params?.dateToAD) search.append('dateToAD', params.dateToAD);
  if (params?.all) search.append('all', '1');
  if (params?.page !== undefined) {
    search.append('page', String(params.page));
    if (params.pageSize) search.append('pageSize', String(params.pageSize));
  }
  const query = search.toString() ? `?${search.toString()}` : '';
  return fetchJson(`/api/purchase-invoices${query}`);
}

export async function createPurchaseInvoice(inv: Partial<PurchaseInvoice>): Promise<PurchaseInvoice> {
  // The server issues the invoice number via issueNextDocNumber.
  return fetchJson('/api/purchase-invoices', {
    method: 'POST',
    body: JSON.stringify(inv),
  });
}

export async function recordInvoicePayment(id: string, amount: number, paymentMethod?: string): Promise<PurchaseInvoice> {
  return fetchJson(`/api/purchase-invoices/${id}/pay`, {
    method: 'POST',
    body: JSON.stringify({ amount, paymentMethod }),
  });
}

export async function deletePurchaseInvoice(id: string): Promise<{ success: boolean }> {
  return fetchJson(`/api/purchase-invoices/${id}`, { method: 'DELETE' });
}

export async function getInvoicePayments(id: string): Promise<VendorPayment[]> {
  return fetchJson(`/api/purchase-invoices/${id}/payments`);
}

// Vendor Payments Sub-ledger
export async function createVendorPayment(payload: {
  supplierId?: string;
  supplierName?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  amount: number;
  paymentDateAD?: string;
  paymentDateBS?: string;
  paymentMethod?: string;
  paymentNumber?: string;
  bankName?: string;
  bankBranch?: string;
  accountNumber?: string;
  chequeNumber?: string;
  chequeDateAD?: string;
  chequeDateBS?: string;
  transactionReference?: string;
  branchId?: string;
}): Promise<VendorPayment> {
  // The server issues the payment number via issueNextDocNumber
  // (CP = Cash Payment, BP = Bank Payment, both per-branch daily counters).
  return fetchJson('/api/vendor-payments', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function reverseVendorPayment(id: string, reason: string): Promise<{ success: boolean; message: string; paymentId: string }> {
  return fetchJson(`/api/vendor-payments/${id}/reverse`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

// Reverse ALL posted payments for a fully paid invoice (restores it to UNPAID)
export async function reverseInvoicePayments(
  id: string,
  reason: string
): Promise<{ success: boolean; message: string; reversedCount: number; invoiceId: string }> {
  return fetchJson(`/api/purchase-invoices/${id}/reverse-payments`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function getVendorLedger(
  supplierId: string,
  params?: {
    fromAd?: string;
    toAd?: string;
    fiscalYearId?: string;
    branchId?: string;
  }
): Promise<{
  supplier: { id: string; name: string };
  openingBalance: number;
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
  ledger: Array<{
    id: string;
    documentNumber: string;
    dateAD: string;
    dateBS: string;
    amount: number;
    type: 'INVOICE' | 'PAYMENT';
    notes?: string | null;
    vatAmount?: number;
    paymentMethod?: string;
    debit: number;
    credit: number;
    balance: number;
  }>;
}> {
  const queryParams = new URLSearchParams();
  if (params?.fromAd) queryParams.set('fromAd', params.fromAd);
  if (params?.toAd) queryParams.set('toAd', params.toAd);
  if (params?.fiscalYearId) queryParams.set('fiscalYearId', params.fiscalYearId);
  if (params?.branchId) queryParams.set('branchId', params.branchId);
  const qs = queryParams.toString();
  return fetchJson(`/api/vendors/${supplierId}/ledger${qs ? `?${qs}` : ''}`);
}

// Shipments
/**
 * Filters shared by every shipment read. Branch scope is a server decision:
 * a branch-bound account is pinned to its own branches whatever it sends.
 */
export interface ShipmentQuery {
  branchId?: string;
  dateFromAD?: string;
  dateToAD?: string;
  /** One status or a comma list (e.g. 'IN_TRANSIT,DISCREPANCY'). */
  status?: string;
  /** Register direction relative to the branch (CREATED = source end). */
  direction?: 'CREATED' | 'RECEIVED';
  search?: string;
  /** Warehouse receiving lane: only shipments destined for these branches. */
  destinationBranchIds?: string[];
}

function shipmentQueryString(params: ShipmentQuery & { page?: number; pageSize?: number } = {}): string {
  const search = new URLSearchParams();
  if (params.branchId && params.branchId !== 'ALL') search.append('branchId', params.branchId);
  if (params.dateFromAD) search.append('dateFromAD', params.dateFromAD);
  if (params.dateToAD) search.append('dateToAD', params.dateToAD);
  if (params.status && params.status !== 'ALL') search.append('status', params.status);
  if (params.direction) search.append('direction', params.direction);
  if (params.search) search.append('search', params.search);
  if (params.destinationBranchIds && params.destinationBranchIds.length > 0) {
    search.append('destinationBranchIds', params.destinationBranchIds.join(','));
  }
  if (params.page !== undefined) search.append('page', String(params.page));
  if (params.pageSize !== undefined) search.append('pageSize', String(params.pageSize));
  return search.toString() ? `?${search.toString()}` : '';
}

/**
 * Bare-array shipment read (legacy contract, server-bounded). The FY closing
 * wizard uses the year scope; every register/receive screen uses the paged or
 * overview reads below — the array never enters the bootstrap payload.
 */
export async function getShipments(params?: ShipmentQuery): Promise<Shipment[]> {
  return fetchJson(`/api/shipments${shipmentQueryString(params)}`);
}

/** One server-paged slice of the transfer register. */
export interface ShipmentPage {
  data: Shipment[];
  page: number;
  pageSize: number;
  totalItems: number;
}

export async function getShipmentPage(
  params: ShipmentQuery & { page?: number; pageSize?: number } = {}
): Promise<ShipmentPage> {
  return fetchJson(`/api/shipments/page${shipmentQueryString(params)}`);
}

/**
 * Small scoped snapshot behind the shell badges, dashboard KPI and
 * notification center: exact status counts plus the actionable (still in
 * flight) rows and a bounded recent window.
 */
export interface ShipmentOverview {
  counts: Record<string, number>;
  total: number;
  pending: Shipment[];
  recent: Shipment[];
  pendingCapped: boolean;
}

export async function getShipmentOverview(branchId?: string): Promise<ShipmentOverview> {
  return fetchJson(`/api/shipments/overview${shipmentQueryString({ branchId })}`);
}

export async function createShipment(shipment: Partial<Shipment>): Promise<Shipment> {
  // The server issues the tracking code via issueNextDocNumber (ST).
  return fetchJson('/api/shipments', {
    method: 'POST',
    body: JSON.stringify(shipment),
  });
}

export async function receiveShipment(
  id: string,
  verificationData?: {
    receivedItems?: {
      itemId: string;
      quantityReceived: number;
      receivedSerials?: { deviceSerial: string; ponSerial?: string }[];
      itemDiscrepancyNotes?: string;
    }[];
    receivedByNotes?: string;
  }
): Promise<Shipment> {
  return fetchJson(`/api/shipments/${id}/receive`, {
    method: 'POST',
    body: JSON.stringify(verificationData || {}),
  });
}

export async function cancelShipment(
  id: string,
  user?: User | null,
  reason?: string
): Promise<{ shipment: Shipment; message: string }> {
  return fetchJson(`/api/shipments/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ user, reason }),
  });
}

export async function cancelReceiveShipment(
  id: string,
  user?: User | null,
  reason?: string
): Promise<{ shipment: Shipment; message: string }> {
  return fetchJson(`/api/shipments/${id}/cancel-receive`, {
    method: 'POST',
    body: JSON.stringify({ user, reason }),
  });
}
