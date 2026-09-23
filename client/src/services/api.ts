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
  VendorOpeningBalanceResponse,
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
  VendorPayment,
  SerialLog,
  SerialLookupResult,
  SerialEditPayload,
} from '../types';

function safeParseHistory(v: unknown): SerialLog['history'] {
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

const API_BASE = (((import.meta as any).env?.VITE_API_BASE_URL as string) || '').replace(/\/$/, '');

let currentUserContext: User | null = null;
let currentFiscalYearId: string | null = null;
let authToken: string | null = typeof localStorage !== 'undefined' ? localStorage.getItem('inventory_auth_token') : null;

export const setAuthToken = (token: string | null) => {
  authToken = token;
};

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
  if (authToken) userHeaders.Authorization = `Bearer ${authToken}`;
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
        const error = new Error(errorBody.message || `Request failed with status ${res.status}`);
        // Attach status code for 401 detection
        (error as any).status = res.status;
        // Dispatch auth expiration event on 401 so App can force logout
        if (res.status === 401) {
          window.dispatchEvent(new CustomEvent('inventory_auth_expired', { detail: { message: error.message } }));
        }
        throw error;
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

  async switchProfile(
    targetUserId: string,
    options?: { targetEmail?: string }
  ): Promise<{ user: User; token: string }> {
    return fetchJson('/api/auth/switch-profile', {
      method: 'POST',
      body: JSON.stringify({ targetUserId, ...(options?.targetEmail ? { targetEmail: options.targetEmail } : {}) }),
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

  async recalculateFixedAssets(): Promise<{ message: string; updated: number }> {
    return fetchJson('/api/admin/recalculate/fixed-assets', { method: 'POST' });
  },

  async recalculateLiveStock(): Promise<{ message: string; updated: number }> {
    return fetchJson('/api/admin/recalculate/live-stock', { method: 'POST' });
  },

  async rebuildBsDayRecords(): Promise<{ success: boolean; pgSynced: boolean; years: number; regeneratedRecords: number; message: string }> {
    return fetchJson('/api/admin/recalculate/bs-day-records', { method: 'POST' });
  },

  async repairFiscalYearLinks(): Promise<{ success: boolean; totalFixed: number; perTable: Record<string, number>; message: string }> {
    return fetchJson('/api/admin/repair/fiscal-year-links', { method: 'POST' });
  },

  // Purchase Orders
  async getPurchaseOrders(branchId?: string): Promise<PurchaseOrder[]> {
    const query = branchId && branchId !== 'ALL' ? `?branchId=${branchId}` : '';
    return fetchJson(`/api/purchase-orders${query}`);
  },

  async createPurchaseOrder(po: Omit<PurchaseOrder, 'id' | 'poNumber' | 'subtotalAmount' | 'taxAmount' | 'totalAmount'> & { poNumber?: string }): Promise<PurchaseOrder> {
    // The server issues the PO number via issueNextDocNumber (per-branch daily
    // atomic counter). Only pass one through when the caller explicitly set it.
    return fetchJson('/api/purchase-orders', {
      method: 'POST',
      body: JSON.stringify(po),
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
    // The server issues the invoice number via issueNextDocNumber.
    return fetchJson('/api/purchase-invoices', {
      method: 'POST',
      body: JSON.stringify(inv),
    });
  },

  async recordInvoicePayment(id: string, amount: number, paymentMethod?: string): Promise<PurchaseInvoice> {
    return fetchJson(`/api/purchase-invoices/${id}/pay`, {
      method: 'POST',
      body: JSON.stringify({ amount, paymentMethod }),
    });
  },

  async deletePurchaseInvoice(id: string): Promise<{ success: boolean }> {
    return fetchJson(`/api/purchase-invoices/${id}`, { method: 'DELETE' });
  },

  async getInvoicePayments(id: string): Promise<VendorPayment[]> {
    return fetchJson(`/api/purchase-invoices/${id}/payments`);
  },

  // Vendor Payments Sub-ledger
  async getVendorPayments(params?: {
    supplierId?: string;
    invoiceId?: string;
    branchId?: string;
    status?: string;
    fromAd?: string;
    toAd?: string;
    fiscalYearId?: string;
  }): Promise<VendorPayment[]> {
    const queryParams = new URLSearchParams();
    if (params?.supplierId) queryParams.set('supplierId', params.supplierId);
    if (params?.invoiceId) queryParams.set('invoiceId', params.invoiceId);
    if (params?.branchId) queryParams.set('branchId', params.branchId);
    if (params?.status) queryParams.set('status', params.status);
    if (params?.fromAd) queryParams.set('fromAd', params.fromAd);
    if (params?.toAd) queryParams.set('toAd', params.toAd);
    if (params?.fiscalYearId) queryParams.set('fiscalYearId', params.fiscalYearId);
    const qs = queryParams.toString();
    return fetchJson(`/api/vendor-payments${qs ? `?${qs}` : ''}`);
  },

  async createVendorPayment(payload: {
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
  },

  async reverseVendorPayment(id: string, reason: string): Promise<{ success: boolean; message: string; paymentId: string }> {
    return fetchJson(`/api/vendor-payments/${id}/reverse`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  // Reverse ALL posted payments for a fully paid invoice (restores it to UNPAID)
  async reverseInvoicePayments(
    id: string,
    reason: string
  ): Promise<{ success: boolean; message: string; reversedCount: number; invoiceId: string }> {
    return fetchJson(`/api/purchase-invoices/${id}/reverse-payments`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  async getVendorLedger(
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
  },

  // Shipments
  async getShipments(branchId?: string): Promise<Shipment[]> {
    const query = branchId && branchId !== 'ALL' ? `?branchId=${branchId}` : '';
    return fetchJson(`/api/shipments${query}`);
  },

  async createShipment(shipment: Partial<Shipment>): Promise<Shipment> {
    // The server issues the tracking code via issueNextDocNumber (ST).
    return fetchJson('/api/shipments', {
      method: 'POST',
      body: JSON.stringify(shipment),
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
  //
  // Paged mode (params.page set): returns a { data, page, pageSize,
  // totalItems, statusCounts } envelope so the Consumables Register never
  // loads the whole ledger. params.all: every filtered row (CSV export).
  // Without page/all the legacy full-array shape is returned.
  async getStockOperations(params?: {
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

  // Reverse a DAMAGE stock operation: restores units to available stock and
  // marks the damage record CANCELLED. Guarded to Super Admin / Inventory Manager.
  async reverseStockOperation(
    id: string,
    reason?: string,
    user?: User | null
  ): Promise<{ message: string; operation: StockOperation }> {
    return fetchJson(`/api/stock-operations/${id}/reverse`, {
      method: 'POST',
      body: JSON.stringify({ reason, user }),
    });
  },

  // Reverse a CONSUMABLE_ISSUE stock operation: returns issued units to
  // branch stock, marks the record CANCELLED, and writes a reversal ledger
  // entry. Guarded by the 'consumable-issue-reverse' permission server-side.
  async reverseConsumableIssue(
    id: string,
    reason?: string,
    user?: User | null
  ): Promise<{ message: string; operation: StockOperation }> {
    return fetchJson(`/api/stock-operations/${id}/reverse-consumable`, {
      method: 'POST',
      body: JSON.stringify({ reason, user }),
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

  async createFiscalYear(input: {
    code: string;
    startDateAD: string;
    endDateAD: string;
    startDateBS: string;
    endDateBS: string;
  }): Promise<FiscalYear> {
    return fetchJson('/api/fiscal-years', {
      method: 'POST',
      body: JSON.stringify(input),
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

  // Fiscal-Year Vendor Opening Balances (Vendor Ledger roll-forward)
  async getVendorOpeningBalances(id: string): Promise<VendorOpeningBalanceResponse> {
    return fetchJson(`/api/fiscal-years/${id}/vendor-opening-balances`);
  },

  async adjustVendorOpeningBalances(
    id: string,
    rows: Array<{
      supplierId: string;
      branchId: string;
      openingBalance: number;
    }>
  ): Promise<{ applied: number; created: number; message: string }> {
    return fetchJson(`/api/fiscal-years/${id}/vendor-opening-balances`, {
      method: 'PUT',
      body: JSON.stringify({ rows }),
    });
  },

  async rollForwardVendorOpenings(
    id: string
  ): Promise<{ targetFiscalYear: FiscalYear; recordsCreated: number; manualRowsPreserved?: number }> {
    return fetchJson(`/api/fiscal-years/${id}/roll-forward-vendor-openings`, { method: 'POST' });
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

  async updateDeviceSerials(payload: {
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
  },

  // Resolve a typed serial value (device serial / PON / MAC) to the device
  // that already holds it — powers live duplicate detection in the edit modal.
  async lookupSerial(value: string, exclude?: string[]): Promise<SerialLookupResult> {
    const search = new URLSearchParams();
    search.append('value', value);
    (exclude || []).forEach((v) => v && search.append('exclude', v));
    return fetchJson<SerialLookupResult>(`/api/inventory/serials/lookup?${search.toString()}`);
  },

  // Apply two serial corrections in one operation (supports swaps).
  async updateDeviceSerialsDual(
    a: SerialEditPayload,
    b: SerialEditPayload
  ): Promise<any> {
    return fetchJson('/api/inventory/serials/dual', {
      method: 'POST',
      body: JSON.stringify({ a, b }),
    });
  },

  // Serial Log Register (one row per unique serial)
  //
  // Paged mode (params.page set): returns a { data, page, pageSize, totalItems,
  // statusCounts } envelope so the register never loads the whole ledger.
  // params.all: fetch every filtered row (CSV export). Without page/all the
  // legacy full-array shape is returned.
  async getSerialLogs(params?: {
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
  },

  async createSerialLogEntry(data: {
    deviceSerial: string; ponSerial?: string; macAddress?: string;
    productId?: string; productName?: string; branchId?: string;
    customerId?: string; customerName?: string;
    status?: string; sourceType?: string; sourceId?: string; notes?: string;
  }): Promise<{ success: boolean; id: string }> {
    return fetchJson('/api/serial-log', {
      method: 'POST',
      body: JSON.stringify(data),
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

  // Batch (multi-year) seed of the BS calendar month arrays. Seeds every
  // provided year in one request, expanding the day-by-day bs_day_records
  // lookup table for all of them. Accepts an array of { yearBS, daysInMonths,
  // customStartAD? } objects.
  async seedBsCalendarYearsBulk(years: { yearBS: number; daysInMonths: number[]; customStartAD?: string }[], onlyIfNew?: boolean): Promise<{
    success: boolean;
    pgSynced?: boolean;
    seededCount?: number;
    skippedYears?: number[];
    message: string;
  }> {
    return fetchJson('/api/bs-calendar/seed-bulk', {
      method: 'POST',
      body: JSON.stringify({ years, onlyIfNew }),
    });
  },

  async syncBsDayRange(dayRecords: any[]): Promise<{ success: boolean; pgSynced?: boolean; count: number; message: string }> {
    return fetchJson('/api/bs-calendar/sync-range', {
      method: 'POST',
      body: JSON.stringify({ dayRecords }),
    });
  },

  // Update an existing BS year's month-length config / AD start date, then
  // regenerate its day-by-day records (and those of subsequent years whose
  // start date shifts) in bs_day_records.
  async updateBsCalendarYear(
    yearBS: number,
    payload: { daysInMonths?: number[]; startAD?: string; recalculateNextStartAD?: boolean }
  ): Promise<{ success: boolean; pgSynced?: boolean; affectedYears?: number[]; regeneratedRecords?: number; message: string }> {
    return fetchJson(`/api/bs-calendar/years/${yearBS}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
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

  async getPermissionsMatrix(): Promise<Record<string, Record<string, boolean>>> {
    return fetchJson('/api/permissions');
  },

  async savePermissionsMatrix(
    matrix: Record<string, Record<string, boolean>>
  ): Promise<void> {
    return fetchJson('/api/permissions', {
      method: 'PUT',
      body: JSON.stringify({ matrix }),
    });
  },
};
