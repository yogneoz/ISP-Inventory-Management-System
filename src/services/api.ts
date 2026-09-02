import {
  User,
  Supplier,
  Branch,
  Product,
  CompanyProfile,
  InventoryStock,
  Asset,
  PurchaseOrder,
  PurchaseInvoice,
  Shipment,
  StockOperation,
  FiscalYear,
  FiscalYearOpeningStockResponse,
  AuditLog,
  TransactionLog,
  FinancialSummary,
  CustomerDeviceRecord,
  CustomerRecord,
  ApprovalRequest,
  BootstrapState,
  Category,
  UnitOfMeasure,
  LocationRecord,
  DocumentNumberConfig,
} from '../types';
import { generateNextDocumentNumber } from '../utils/documentNumbering';

const API_BASE = (((import.meta as any).env?.VITE_API_BASE_URL as string) || '').replace(/\/$/, '');

let currentUserContext: User | null = null;
let currentFiscalYearId: string | null = null;

export const setUserContext = (user: User | null) => {
  currentUserContext = user;
};

export const setFiscalYearContext = (fiscalYearId: string | null) => {
  currentFiscalYearId = fiscalYearId;
};

// In-flight promise cache to deduplicate simultaneous duplicate requests
const inFlightRequests = new Map<string, Promise<any>>();

async function fetchJson<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const isGet = !options?.method || options.method === 'GET';
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  const cacheKey = `${isGet ? 'GET' : 'MUT'}:${url}:${currentUserContext?.id || ''}:${currentUserContext?.branchId || ''}`;

  if (isGet && inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey)! as Promise<T>;
  }

  const userHeaders: Record<string, string> = {};
  if (currentUserContext) {
    userHeaders['x-user-email'] = currentUserContext.email;
    userHeaders['x-user-name'] = currentUserContext.name;
    userHeaders['x-user-role'] = currentUserContext.role;
    if (currentUserContext.branchId) {
      userHeaders['x-user-branch'] = currentUserContext.branchId;
    }
  }
  if (currentFiscalYearId) userHeaders['x-fiscal-year-id'] = currentFiscalYearId;

  const promise = (async () => {
    try {
      const res = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...userHeaders,
          ...options?.headers,
        },
        ...options,
      });

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(errorBody.message || `Request failed with status ${res.status}`);
      }
      return await res.json();
    } finally {
      if (isGet) {
        inFlightRequests.delete(cacheKey);
      }
    }
  })();

  if (isGet) {
    inFlightRequests.set(cacheKey, promise);
  }

  return promise;
}

// Real-Time Event Stream Subscription Helper
export function subscribeToSyncStream(onEvent: (data: any) => void): () => void {
  const streamUrl = `${API_BASE}/api/sync/stream`;
  let eventSource: EventSource | null = null;
  let retryTimeout: any = null;

  function connect() {
    try {
      eventSource = new EventSource(streamUrl);
      eventSource.onmessage = (event) => {
        try {
          if (event.data && event.data.startsWith('{')) {
            const parsed = JSON.parse(event.data);
            onEvent(parsed);
          }
        } catch (_err) {}
      };
      eventSource.onerror = () => {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        retryTimeout = setTimeout(connect, 5000);
      };
    } catch (_e) {
      retryTimeout = setTimeout(connect, 5000);
    }
  }

  connect();

  return () => {
    if (retryTimeout) clearTimeout(retryTimeout);
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };
}

export const api = {
  // Unified Bootstrap for zero-lag instant UI loading & sync
  async getBootstrapState(branchId?: string, fiscalYearId?: string): Promise<BootstrapState> {
    const params = new URLSearchParams();
    if (branchId && branchId !== 'ALL') params.append('branchId', branchId);
    if (fiscalYearId) params.append('fiscalYearId', fiscalYearId);
    const queryString = params.toString() ? `?${params.toString()}` : '';
    return fetchJson<BootstrapState>(`/api/bootstrap${queryString}`);
  },

  // Auth
  async getSetupStatus(): Promise<{ isFirstLaunch: boolean; userCount: number; hasSuperAdmin: boolean }> {
    return fetchJson('/api/auth/setup-status');
  },

  async setupSuperAdmin(data: {
    name: string;
    email: string;
    password: string;
    branchId?: string;
  }): Promise<{ user: User; token: string }> {
    return fetchJson('/api/auth/setup-superadmin', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async forgotPassword(email: string): Promise<{ success: boolean; userName: string; adminEmail: string; message: string }> {
    return fetchJson('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },

  async login(email: string, password: string): Promise<{ user: User; token: string }> {
    return fetchJson('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  async getCurrentUser(): Promise<User> {
    return fetchJson('/api/auth/me');
  },

  async switchProfile(targetUserId: string): Promise<{ user: User; token: string }> {
    return fetchJson('/api/auth/switch-profile', {
      method: 'POST',
      body: JSON.stringify({ targetUserId }),
    });
  },

  async updateProfile(data: Partial<User> & { newPassword?: string }): Promise<User> {
    return fetchJson('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  // Branches
  async getBranches(): Promise<Branch[]> {
    return fetchJson('/api/branches');
  },

  async createBranch(branch: Omit<Branch, 'id'>): Promise<Branch> {
    return fetchJson('/api/branches', {
      method: 'POST',
      body: JSON.stringify(branch),
    });
  },

  async updateBranch(id: string, branch: Partial<Branch>): Promise<Branch> {
    return fetchJson(`/api/branches/${id}`, {
      method: 'PUT',
      body: JSON.stringify(branch),
    });
  },

  async deleteBranch(id: string): Promise<{ success: boolean }> {
    return fetchJson(`/api/branches/${id}`, {
      method: 'DELETE',
    });
  },

  // Suppliers
  async getSuppliers(): Promise<Supplier[]> {
    return fetchJson('/api/suppliers');
  },

  async createSupplier(supplier: Omit<Supplier, 'id' | 'rating'>): Promise<Supplier> {
    return fetchJson('/api/suppliers', {
      method: 'POST',
      body: JSON.stringify(supplier),
    });
  },

  async updateSupplier(id: string, supplier: Partial<Supplier>): Promise<Supplier> {
    return fetchJson(`/api/suppliers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(supplier),
    });
  },

  async deleteSupplier(id: string): Promise<{ success: boolean }> {
    return fetchJson(`/api/suppliers/${id}`, {
      method: 'DELETE',
    });
  },

  // Users
  async getUsers(): Promise<User[]> {
    return fetchJson('/api/users');
  },

  async createUser(user: Omit<User, 'id'> & { password?: string }): Promise<User> {
    return fetchJson('/api/users', {
      method: 'POST',
      body: JSON.stringify(user),
    });
  },

  async updateUser(id: string, user: Partial<User>): Promise<User> {
    return fetchJson(`/api/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(user),
    });
  },

  async deleteUser(id: string): Promise<{ success: boolean }> {
    return fetchJson(`/api/users/${id}`, {
      method: 'DELETE',
    });
  },

  async resetUserPassword(id: string, newPassword: string): Promise<{ success: boolean; message: string; user: User }> {
    return fetchJson(`/api/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    });
  },

  // Products
  async getProducts(): Promise<Product[]> {
    return fetchJson('/api/products');
  },

  async createProduct(product: Omit<Product, 'id'>): Promise<Product> {
    return fetchJson('/api/products', {
      method: 'POST',
      body: JSON.stringify(product),
    });
  },

  async updateProduct(id: string, product: Partial<Product>): Promise<Product> {
    return fetchJson(`/api/products/${id}`, {
      method: 'PUT',
      body: JSON.stringify(product),
    });
  },

  async deleteProduct(id: string): Promise<{ success: boolean }> {
    return fetchJson(`/api/products/${id}`, {
      method: 'DELETE',
    });
  },

  // Stock
  async getStock(branchId?: string): Promise<InventoryStock[]> {
    const query = branchId && branchId !== 'ALL' ? `?branchId=${branchId}` : '';
    return fetchJson(`/api/stock${query}`);
  },

  async updateStockLevel(stockId: string, quantityOnHand: number, reason: string, damagedQty?: number, changeType?: string): Promise<InventoryStock> {
    return fetchJson(`/api/stock/${stockId}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantityOnHand, reason, damagedQty, changeType }),
    });
  },

  async updateStockReorderLevel(stockId: string, minReorderLevel: number): Promise<InventoryStock> {
    return fetchJson(`/api/stock/${stockId}/reorder-level`, {
      method: 'PATCH',
      body: JSON.stringify({ minReorderLevel }),
    });
  },

  async bulkUpdateStockReorderLevels(updates: { stockId: string; minReorderLevel: number }[]): Promise<{ success: boolean; count: number }> {
    return fetchJson('/api/stock/bulk-reorder-levels', {
      method: 'POST',
      body: JSON.stringify({ updates }),
    });
  },

  async reconcileStockAudit(payload: {
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
  },

  // Assets
  async getAssets(branchId?: string): Promise<Asset[]> {
    const query = branchId && branchId !== 'ALL' ? `?branchId=${branchId}` : '';
    return fetchJson(`/api/assets${query}`);
  },

  async createAsset(asset: Omit<Asset, 'id' | 'netBookValue' | 'accumulatedDepreciation'>): Promise<Asset> {
    return fetchJson('/api/assets', {
      method: 'POST',
      body: JSON.stringify(asset),
    });
  },

  async updateAssetStatus(id: string, updates: Asset['status'] | Partial<Asset>): Promise<Asset> {
    const body = typeof updates === 'string' ? { status: updates } : updates;
    return fetchJson(`/api/assets/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },

  // Purchase Orders
  async getPurchaseOrders(branchId?: string): Promise<PurchaseOrder[]> {
    const query = branchId && branchId !== 'ALL' ? `?branchId=${branchId}` : '';
    return fetchJson(`/api/purchase-orders${query}`);
  },

  async createPurchaseOrder(po: Omit<PurchaseOrder, 'id' | 'poNumber' | 'subtotalAmount' | 'taxAmount' | 'totalAmount'> & { poNumber?: string }): Promise<PurchaseOrder> {
    const poNumber = po.poNumber || generateNextDocumentNumber('PO', true);
    return fetchJson('/api/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({ ...po, poNumber }),
    });
  },

  async updatePurchaseOrder(id: string, poData: Partial<PurchaseOrder>): Promise<PurchaseOrder> {
    return fetchJson(`/api/purchase-orders/${id}`, {
      method: 'PUT',
      body: JSON.stringify(poData),
    });
  },

  async updatePurchaseOrderStatus(id: string, status: string): Promise<PurchaseOrder> {
    return fetchJson(`/api/purchase-orders/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  },

  async deletePurchaseOrder(id: string): Promise<{ success: boolean }> {
    return fetchJson(`/api/purchase-orders/${id}`, { method: 'DELETE' });
  },

  // Purchase Invoices
  async getPurchaseInvoices(branchId?: string): Promise<PurchaseInvoice[]> {
    const query = branchId && branchId !== 'ALL' ? `?branchId=${branchId}` : '';
    return fetchJson(`/api/purchase-invoices${query}`);
  },

  async createPurchaseInvoice(inv: Partial<PurchaseInvoice>): Promise<PurchaseInvoice> {
    const invoiceNumber = inv.invoiceNumber || generateNextDocumentNumber('PI', true);
    return fetchJson('/api/purchase-invoices', {
      method: 'POST',
      body: JSON.stringify({ ...inv, invoiceNumber }),
    });
  },

  async recordInvoicePayment(id: string, amount: number): Promise<PurchaseInvoice> {
    return fetchJson(`/api/purchase-invoices/${id}/pay`, {
      method: 'POST',
      body: JSON.stringify({ amount }),
    });
  },

  async deletePurchaseInvoice(id: string): Promise<{ success: boolean }> {
    return fetchJson(`/api/purchase-invoices/${id}`, { method: 'DELETE' });
  },

  // Shipments
  async getShipments(branchId?: string): Promise<Shipment[]> {
    const query = branchId && branchId !== 'ALL' ? `?branchId=${branchId}` : '';
    return fetchJson(`/api/shipments${query}`);
  },

  async createShipment(shipment: Partial<Shipment>): Promise<Shipment> {
    const trackingCode = shipment.trackingCode || generateNextDocumentNumber('ST', true);
    return fetchJson('/api/shipments', {
      method: 'POST',
      body: JSON.stringify({ ...shipment, trackingCode }),
    });
  },

  async receiveShipment(
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
  },

  async cancelShipment(
    id: string,
    user?: User | null,
    reason?: string
  ): Promise<{ shipment: Shipment; message: string }> {
    return fetchJson(`/api/shipments/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ user, reason }),
    });
  },

  async cancelReceiveShipment(
    id: string,
    user?: User | null,
    reason?: string
  ): Promise<{ shipment: Shipment; message: string }> {
    return fetchJson(`/api/shipments/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ user, reason }),
    });
  },

  // Stock Operations (Pullout, Damage, Stock Out)
  async getStockOperations(branchId?: string): Promise<StockOperation[]> {
    const query = branchId && branchId !== 'ALL' ? `?branchId=${branchId}` : '';
    return fetchJson(`/api/stock-operations${query}`);
  },

  async createStockOperation(op: Partial<StockOperation>): Promise<StockOperation> {
    return fetchJson('/api/stock-operations', {
      method: 'POST',
      body: JSON.stringify(op),
    });
  },

  async receiveStockOperation(id: string): Promise<StockOperation> {
    return fetchJson(`/api/stock-operations/${id}/receive`, {
      method: 'POST',
    });
  },

  // Fiscal Years
  async getFiscalYears(): Promise<FiscalYear[]> {
    return fetchJson('/api/fiscal-years');
  },

  async setCurrentFiscalYear(id: string): Promise<FiscalYear[]> {
    return fetchJson(`/api/fiscal-years/${id}/set-current`, {
      method: 'POST',
    });
  },

  async updateFiscalYear(fiscalYear: FiscalYear): Promise<FiscalYear> {
    return fetchJson(`/api/fiscal-years/${fiscalYear.id}`, {
      method: 'PUT',
      body: JSON.stringify(fiscalYear),
    });
  },

  async closeFiscalYear(
    id: string,
    credentials?: { adminEmail: string; adminPassword: string }
  ): Promise<FiscalYear> {
    return fetchJson(`/api/fiscal-years/${id}/close`, {
      method: 'POST',
      body: JSON.stringify(credentials || {}),
    });
  },

  async reopenFiscalYear(
    id: string,
    credentials?: { adminEmail: string; adminPassword: string }
  ): Promise<FiscalYear> {
    return fetchJson(`/api/fiscal-years/${id}/reopen`, {
      method: 'POST',
      body: JSON.stringify(credentials || {}),
    });
  },

  async initializeFiscalYearOpeningStock(
    id: string
  ): Promise<{ targetFiscalYear: FiscalYear; recordsCreated: number; manualRowsPreserved?: number }> {
    return fetchJson(`/api/fiscal-years/${id}/initialize-opening-stock`, { method: 'POST' });
  },

  // Opening-Stock Register (Fiscal Year)
  async getFiscalYearOpeningStock(id: string): Promise<FiscalYearOpeningStockResponse> {
    return fetchJson(`/api/fiscal-years/${id}/opening-stock`);
  },

  async adjustFiscalYearOpeningStock(
    id: string,
    rows: Array<{
      productId: string;
      branchId: string;
      quantityOnHand: number;
      damagedQty: number;
      unitCost: number;
    }>
  ): Promise<{ applied: number; created: number; message: string }> {
    return fetchJson(`/api/fiscal-years/${id}/opening-stock`, {
      method: 'PUT',
      body: JSON.stringify({ rows }),
    });
  },

  async deleteFiscalYear(id: string): Promise<{ message: string; id: string }> {
    return fetchJson(`/api/fiscal-years/${id}`, {
      method: 'DELETE',
    });
  },

  // Document Numbering Configurations
  async getDocumentNumberConfigs(): Promise<DocumentNumberConfig[]> {
    return fetchJson('/api/document-number-configs');
  },

  async updateDocumentNumberConfig(config: DocumentNumberConfig): Promise<DocumentNumberConfig> {
    return fetchJson(`/api/document-number-configs/${config.id}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },

  async updateDocumentNumberConfigs(configs: DocumentNumberConfig[]): Promise<DocumentNumberConfig[]> {
    return fetchJson('/api/document-number-configs', {
      method: 'PUT',
      body: JSON.stringify(configs),
    });
  },

  async generateNextDocumentNumber(docTypeId: string, autoIncrement = true): Promise<{ documentNumber: string; seqNum: number }> {
    return fetchJson('/api/document-number-configs/generate-next', {
      method: 'POST',
      body: JSON.stringify({ docTypeId, autoIncrement }),
    });
  },

  async resetDocumentSequence(docTypeId: string, newStartNumber?: number): Promise<{ status: string; docTypeId: string; nextNumber: number }> {
    return fetchJson('/api/document-number-configs/reset-counter', {
      method: 'POST',
      body: JSON.stringify({ docTypeId, newStartNumber }),
    });
  },

  // Audit Logs & Transaction Logs
  async getAuditLogs(): Promise<AuditLog[]> {
    return fetchJson('/api/audit-trail');
  },

  async getTransactionLogs(): Promise<TransactionLog[]> {
    return fetchJson('/api/transaction-logs');
  },

  // Financial Summary
  async getFinancialSummary(branchId?: string, fiscalYearId?: string): Promise<FinancialSummary> {
    const params = new URLSearchParams();
    if (branchId && branchId !== 'ALL') params.set('branchId', branchId);
    if (fiscalYearId) params.set('fiscalYearId', fiscalYearId);
    const query = params.toString() ? `?${params.toString()}` : '';
    return fetchJson(`/api/reports/financial-summary${query}`);
  },

  // Customer Devices & Serial Numbers
  async getCustomerDevices(branchId?: string, query?: string): Promise<CustomerDeviceRecord[]> {
    const params = new URLSearchParams();
    if (branchId && branchId !== 'ALL') params.append('branchId', branchId);
    if (query) params.append('query', query);
    const queryString = params.toString() ? `?${params.toString()}` : '';
    return fetchJson(`/api/customer-devices${queryString}`);
  },

  async createCustomerDevice(record: Omit<CustomerDeviceRecord, 'id'>): Promise<CustomerDeviceRecord> {
    return fetchJson('/api/customer-devices', {
      method: 'POST',
      body: JSON.stringify(record),
    });
  },

  async updateCustomerDeviceStatus(id: string, status: CustomerDeviceRecord['status']): Promise<CustomerDeviceRecord> {
    return fetchJson(`/api/customer-devices/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  },

  async exchangeCustomerDevice(payload: {
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
  },

  // Customer Master Database
  async getCustomers(branchId?: string, query?: string): Promise<CustomerRecord[]> {
    const params = new URLSearchParams();
    if (branchId && branchId !== 'ALL') params.append('branchId', branchId);
    if (query) params.append('query', query);
    const queryString = params.toString() ? `?${params.toString()}` : '';
    return fetchJson(`/api/customers${queryString}`);
  },

  async createCustomer(record: Omit<CustomerRecord, 'id'> | CustomerRecord): Promise<CustomerRecord> {
    return fetchJson('/api/customers', {
      method: 'POST',
      body: JSON.stringify(record),
    });
  },

  async bulkImportCustomers(customers: CustomerRecord[]): Promise<{ success: boolean; count: number }> {
    return fetchJson('/api/customers/bulk', {
      method: 'POST',
      body: JSON.stringify({ customers }),
    });
  },

  async updateCustomer(id: string, updates: Partial<CustomerRecord>): Promise<CustomerRecord> {
    return fetchJson(`/api/customers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async deleteCustomer(id: string): Promise<void> {
    return fetchJson(`/api/customers/${id}`, {
      method: 'DELETE',
    });
  },

  // Workflow Approval Requests
  async getApprovalRequests(branchId?: string, status?: string): Promise<ApprovalRequest[]> {
    const params = new URLSearchParams();
    if (branchId && branchId !== 'ALL') params.append('branchId', branchId);
    if (status && status !== 'ALL') params.append('status', status);
    const queryString = params.toString() ? `?${params.toString()}` : '';
    return fetchJson(`/api/approval-requests${queryString}`);
  },

  async createApprovalRequest(request: Omit<ApprovalRequest, 'id' | 'requestNumber' | 'status' | 'requestedAtAD' | 'requestedAtBS'>): Promise<ApprovalRequest> {
    return fetchJson('/api/approval-requests', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  async processApprovalRequest(id: string, status: 'APPROVED' | 'REJECTED', approverUser?: User | null, rejectionReason?: string): Promise<{ request: ApprovalRequest; message: string }> {
    return fetchJson(`/api/approval-requests/${id}/process`, {
      method: 'POST',
      body: JSON.stringify({ status, approverUser, rejectionReason }),
    });
  },

  async cancelApprovalRequest(id: string, user?: User | null, reason?: string): Promise<{ request: ApprovalRequest; message: string }> {
    return fetchJson(`/api/approval-requests/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ user, reason }),
    });
  },

  // Bikram Sambat (BS) Calendar PostgreSQL API
  async getBsCalendarYears(): Promise<{ yearBS: number; daysInMonths: number[]; startAD: string }[]> {
    return fetchJson('/api/bs-calendar/years');
  },

  async getBsDayRecords(yearBS?: number | string, monthBS?: number | string, search?: string): Promise<any[]> {
    const params = new URLSearchParams();
    if (yearBS && yearBS !== 'ALL') params.append('yearBS', String(yearBS));
    if (monthBS && monthBS !== 'ALL') params.append('monthBS', String(monthBS));
    if (search && search.trim()) params.append('search', search.trim());
    const queryString = params.toString() ? `?${params.toString()}` : '';
    return fetchJson(`/api/bs-calendar/days${queryString}`);
  },

  // Single-day lookup against the bs_day_records table (PostgreSQL authoritative,
  // in-memory fallback). Returns found=false when the AD date has no seeded BS record.
  async getBsDayRecordByAdDate(adDateStr: string): Promise<{
    found: boolean;
    source?: string;
    adDate?: string | null;
    record?: any;
    message?: string;
  }> {
    const params = new URLSearchParams({ adDate: adDateStr });
    return fetchJson(`/api/bs-calendar/day?${params.toString()}`);
  },

  async seedBsCalendarYear(yearBS: number, daysInMonths: number[], customStartAD?: string, onlyIfNew?: boolean): Promise<{ success: boolean; skipped?: boolean; pgSynced?: boolean; message: string }> {
    return fetchJson('/api/bs-calendar/seed', {
      method: 'POST',
      body: JSON.stringify({ yearBS, daysInMonths, customStartAD, onlyIfNew }),
    });
  },

  async syncBsDayRange(dayRecords: any[]): Promise<{ success: boolean; pgSynced?: boolean; count: number; message: string }> {
    return fetchJson('/api/bs-calendar/sync-range', {
      method: 'POST',
      body: JSON.stringify({ dayRecords }),
    });
  },

  // Clear Demo Data
  async clearDemoData(): Promise<{ message: string }> {
    return fetchJson('/api/admin/clear-demo-data', {
      method: 'POST',
    });
  },

  // Categories API
  async getCategories(): Promise<Category[]> {
    return fetchJson('/api/categories');
  },

  async createCategory(category: Partial<Category>): Promise<Category> {
    return fetchJson('/api/categories', {
      method: 'POST',
      body: JSON.stringify(category),
    });
  },

  async updateCategory(id: string, category: Partial<Category>): Promise<Category> {
    return fetchJson(`/api/categories/${id}`, {
      method: 'PUT',
      body: JSON.stringify(category),
    });
  },

  async deleteCategory(id: string): Promise<{ success: boolean }> {
    return fetchJson(`/api/categories/${id}`, {
      method: 'DELETE',
    });
  },

  // UoM API
  async getUoms(): Promise<UnitOfMeasure[]> {
    return fetchJson('/api/uom');
  },

  async createUom(uom: Partial<UnitOfMeasure>): Promise<UnitOfMeasure> {
    return fetchJson('/api/uom', {
      method: 'POST',
      body: JSON.stringify(uom),
    });
  },

  async updateUom(id: string, uom: Partial<UnitOfMeasure>): Promise<UnitOfMeasure> {
    return fetchJson(`/api/uom/${id}`, {
      method: 'PUT',
      body: JSON.stringify(uom),
    });
  },

  async deleteUom(id: string): Promise<{ success: boolean }> {
    return fetchJson(`/api/uom/${id}`, {
      method: 'DELETE',
    });
  },

  // Locations API
  async getLocations(branchId?: string): Promise<LocationRecord[]> {
    const query = branchId && branchId !== 'ALL' ? `?branchId=${encodeURIComponent(branchId)}` : '';
    return fetchJson(`/api/locations${query}`);
  },

  async createLocation(location: Partial<LocationRecord>): Promise<LocationRecord> {
    return fetchJson('/api/locations', {
      method: 'POST',
      body: JSON.stringify(location),
    });
  },

  async updateLocation(id: string, location: Partial<LocationRecord>): Promise<LocationRecord> {
    return fetchJson(`/api/locations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(location),
    });
  },

  async deleteLocation(id: string): Promise<{ success: boolean }> {
    return fetchJson(`/api/locations/${id}`, {
      method: 'DELETE',
    });
  },

  // Company Profile API
  async getCompanyProfile(): Promise<CompanyProfile> {
    return fetchJson('/api/company-profile');
  },

  async updateCompanyProfile(profile: Partial<CompanyProfile>): Promise<CompanyProfile> {
    return fetchJson('/api/company-profile', {
      method: 'PUT',
      body: JSON.stringify(profile),
    });
  },
};
