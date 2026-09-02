import React, { useState, useEffect, useRef } from 'react';
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
  AuditLog,
  TransactionLog,
  FinancialSummary,
  CustomerDeviceRecord,
  CustomerRecord,
  ApprovalRequest,
  Category,
} from './types';
import { api, setFiscalYearContext, setUserContext, subscribeToSyncStream } from './services/api';
import { seedBSYearCalendar } from './utils/nepaliCalendar';
import {
  saveUserSession,
  loadUserSession,
  clearUserSession,
  saveRecentBootstrapCache,
  loadRecentBootstrapCache,
  clearRecentBootstrapCache,
} from './utils/sessionCache';
import { Header } from './components/layout/Header';
import { Sidebar, NavTab, NAV_TABS } from './components/layout/Sidebar';
import { LoginModal } from './components/common/LoginModal';
import { ProfileSwitchModal } from './components/common/ProfileSwitchModal';
import { Dashboard } from './features/dashboard/Dashboard';
import { ProductManagement } from './features/inventory/ProductManagement';
import { BranchStockTracking } from './features/inventory/BranchStockTracking';
import { ReorderStockTracking } from './features/inventory/ReorderStockTracking';
import { DamagedStockTracking } from './features/inventory/DamagedStockTracking';
import { FixedAssetRegister } from './features/finance/FixedAssetRegister';
import { CustomersManagement } from './features/sales/CustomersManagement';
import { CustomerMasterDirectory } from './features/sales/CustomerMasterDirectory';
import { PurchaseOrders, OrderFormLine } from './features/procurement/PurchaseOrders';
import { PurchaseInvoices } from './features/procurement/PurchaseInvoices';
import { Shipments } from './features/procurement/Shipments';
import { StockOperations } from './features/inventory/StockOperations';
import { ReceiveInboundWarehouse } from './features/procurement/ReceiveInboundWarehouse';
import { BsCalendarUtility } from './features/finance/BsCalendarUtility';
import { FiscalYearManagement } from './features/finance/FiscalYearManagement';
import { NepaliFiscalManagement } from './features/finance/NepaliFiscalManagement';
import { AuditTrailReports } from './features/finance/AuditTrailReports';
import { BranchesManagement } from './features/settings/BranchesManagement';
import { CompanySetupManagement } from './features/settings/CompanySetupManagement';

const ACTIVE_TAB_STORAGE_KEY = 'izone_active_tab';
import { SuppliersManagement } from './features/procurement/SuppliersManagement';
import { UsersManagement } from './features/settings/UsersManagement';
import { PermissionManagement } from './features/settings/PermissionManagement';
import { FinancialStatements } from './features/finance/FinancialStatements';
import { VatRegister } from './features/finance/VatRegister';
import { DepreciationRegister } from './features/finance/DepreciationRegister';
import { StockValuation } from './features/inventory/StockValuation';
import { NotificationCenter } from './components/common/NotificationCenter';
import { ApprovalWorkflowCenter } from './features/settings/ApprovalWorkflowCenter';
import { StockMovementLedger } from './features/inventory/StockMovementLedger';
import { PhysicalStockAudit } from './features/inventory/PhysicalStockAudit';
import { FiscalYearClosingWizard } from './features/finance/FiscalYearClosingWizard';
import { OpeningStockManager } from './features/finance/OpeningStockManager';
import { WarrantyProducts } from './features/inventory/WarrantyProducts';
import { CategoryManagement } from './features/inventory/CategoryManagement';
import { UomManagement } from './features/inventory/UomManagement';
import { ClearDemoDataView } from './components/common/ClearDemoDataView';
import { ImportStock } from './features/inventory/ImportStock';
import { ExportStock } from './features/inventory/ExportStock';
import { LocationsManagement } from './features/settings/LocationsManagement';
import { ImportCustomers } from './features/sales/ImportCustomers';
import { HelpDocumentation } from './components/common/HelpDocumentation';
import { BarcodeScannerModal } from './components/common/BarcodeScannerModal';
import { GlobalSearchModal } from './components/common/GlobalSearchModal';
import { DatabaseSetupBanner } from './components/common/DatabaseSetupBanner';
import { Loader2 } from 'lucide-react';

// Chooses the fiscal year to show by default: the year flagged current whose
// AD range contains today's date (guards against multiple years being flagged
// current), falling back to the first flagged-current year, then the first
// available year. Switching fiscal years in the header filters data to that
// fiscal year on refresh.
function resolveDefaultFiscalYear(fiscalYears: FiscalYear[]): FiscalYear | undefined {
  if (!fiscalYears.length) return undefined;
  const currentCandidates = fiscalYears.filter((f) => f.isCurrent);
  if (!currentCandidates.length) return fiscalYears[0];
  const now = new Date();
  const todayAD = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const containsToday = (f: FiscalYear) => {
    const start = String(f.startDateAD || '').slice(0, 10);
    const end = String(f.endDateAD || '').slice(0, 10);
    return Boolean(start && end && todayAD >= start && todayAD <= end);
  };
  return currentCandidates.find(containsToday) || currentCandidates[0];
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    return loadUserSession().currentUser;
  });

  const [rootUser, setRootUser] = useState<User | null>(() => {
    return loadUserSession().rootUser;
  });

  const [activeTab, setActiveTab] = useState<NavTab>(() => {
    const savedTab = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    // Only restore the saved tab if it is still a valid menu id (guards against removed/renamed tabs)
    return savedTab && (NAV_TABS as string[]).includes(savedTab) ? (savedTab as NavTab) : 'dashboard';
  });
  const [selectedBranchId, setSelectedBranchId] = useState<string>('ALL');
  const [selectedFiscalYearId, setSelectedFiscalYearId] = useState<string>('');
  const [dateMode, setDateMode] = useState<'BS' | 'AD'>(() => {
    const saved = localStorage.getItem('izone_date_mode');
    return saved === 'AD' ? 'AD' : 'BS';
  });

  // Toggles the global date display between Bikram Sambat (BS) and AD.
  // The choice is persisted so every client remembers the user's preference.
  const handleToggleDateMode = () => {
    setDateMode((prev) => {
      const next = prev === 'BS' ? 'AD' : 'BS';
      localStorage.setItem('izone_date_mode', next);
      return next;
    });
  };
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isBarcodeModalOpen, setIsBarcodeModalOpen] = useState<boolean>(false);
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState<boolean>(false);
  const [isNotificationOpen, setIsNotificationOpen] = useState<boolean>(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [permissionsVersion, setPermissionsVersion] = useState<number>(0);

  // Synchronize permissions live across components
  useEffect(() => {
    setUserContext(currentUser);
  }, [currentUser]);

  useEffect(() => {
    setFiscalYearContext(selectedFiscalYearId || null);
  }, [selectedFiscalYearId]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, activeTab);
  }, [activeTab]);

  useEffect(() => {
    const handlePermissionsUpdated = () => {
      setPermissionsVersion((v) => v + 1);
    };
    window.addEventListener('izone_permissions_updated', handlePermissionsUpdated);
    return () => window.removeEventListener('izone_permissions_updated', handlePermissionsUpdated);
  }, []);

  // Theme State: default to light mode (false) as requested, with localStorage persistence
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('izone_theme');
    return saved === 'dark';
  });

  const handleToggleTheme = () => {
    setIsDarkMode((prev) => {
      const next = !prev;
      localStorage.setItem('izone_theme', next ? 'dark' : 'light');
      return next;
    });
  };

  // App Data State
  const [prepopulatedPOLines, setPrepopulatedPOLines] = useState<OrderFormLine[]>([]);
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [stock, setStock] = useState<InventoryStock[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [customerDevices, setCustomerDevices] = useState<CustomerDeviceRecord[]>([]);
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [purchaseInvoices, setPurchaseInvoices] = useState<PurchaseInvoice[]>([]);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [stockOperations, setStockOperations] = useState<StockOperation[]>([]);
  const [fiscalYears, setFiscalYears] = useState<FiscalYear[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [transactionLogs, setTransactionLogs] = useState<TransactionLog[]>([]);
  const [financialSummary, setFinancialSummary] = useState<FinancialSummary>({
    totalInventoryAssetValue: 0,
    totalFixedAssetValue: 0,
    totalAccountsPayable: 0,
    totalCostOfGoodsSold: 0,
    totalDamageLossValue: 0,
    totalVatInputTax: 0,
    currentFiscalYear: '2082/83',
  });
  const [postgresStatus, setPostgresStatus] = useState<{
    isConnected: boolean;
    host: string;
    port: number;
    database: string;
    user: string;
    engine?: string;
    errorDetails?: string;
  }>({
    isConnected: false,
    host: 'localhost',
    port: 5432,
    database: 'inventory_db',
    user: 'inventory_user',
  });

  // Hydrate state from recent cache for instant 0ms load speed
  const applyBootstrapData = (data: any) => {
    if (data.branches) setBranches(data.branches);
    if (data.products) setProducts(data.products);
    if (data.stock) setStock(data.stock);
    if (data.assets) setAssets(data.assets);
    if (data.customerDevices) setCustomerDevices(data.customerDevices);
    if (data.customers) setCustomers(data.customers);
    if (data.purchaseOrders) setPurchaseOrders(data.purchaseOrders);
    if (data.purchaseInvoices) setPurchaseInvoices(data.purchaseInvoices);
    if (data.shipments) setShipments(data.shipments);
    if (data.stockOperations) setStockOperations(data.stockOperations);
    if (data.fiscalYears) setFiscalYears(data.fiscalYears);
    if (data.auditLogs) setAuditLogs(data.auditLogs);
    if (data.transactionLogs) setTransactionLogs(data.transactionLogs);
    if (data.financialSummary) setFinancialSummary(data.financialSummary);
    if (data.suppliers) setSuppliers(data.suppliers);
    if (data.users) setUsers(data.users as User[]);
    if (data.approvalRequests) setApprovalRequests(data.approvalRequests);
    if (data.categories) setCategories(data.categories);
    if (data.companyProfile) setCompanyProfile(data.companyProfile);
    if (data.postgresDatabaseStatus) setPostgresStatus(data.postgresDatabaseStatus);
  };

  // Instant pre-hydration from recent cache
  useEffect(() => {
    const cached = loadRecentBootstrapCache();
    if (cached) {
      applyBootstrapData(cached);
      setLoading(false);
    }
  }, []);

  // Load state from API via atomic unified bootstrap (1 roundtrip)
  // A monotonic sequence guard ensures that a stale, slow response (e.g. from a
  // fiscal year or branch the user has already switched away from) can never
  // overwrite the data of the freshly selected view.
  const refreshSequenceRef = useRef(0);
  const refreshAllData = async () => {
    const requestBranchId = selectedBranchId;
    const requestFiscalYearId = selectedFiscalYearId;
    const requestSeq = ++refreshSequenceRef.current;
    try {
      const data = await api.getBootstrapState(requestBranchId, requestFiscalYearId || undefined);
      // Discard stale results if the user switched branch/fiscal year in the meantime
      if (requestSeq !== refreshSequenceRef.current) return;
      if (data) {
        applyBootstrapData(data);
        if (!requestFiscalYearId && data.fiscalYears?.length) {
          const defaultFy = resolveDefaultFiscalYear(data.fiscalYears);
          if (defaultFy) setSelectedFiscalYearId(defaultFy.id);
        }
        saveRecentBootstrapCache(data);
      }
    } catch (err) {
      console.error('Error fetching data from backend:', err);
    } finally {
      if (requestSeq === refreshSequenceRef.current) setLoading(false);
    }
  };

  // Always expose the freshest refresh closure to stable listeners. The SSE sync
  // stream below captures this ref, so background refreshes always use the
  // currently selected branch/fiscal year instead of a stale captured value.
  const refreshAllDataRef = useRef(refreshAllData);
  useEffect(() => {
    refreshAllDataRef.current = refreshAllData;
  });

  const handleCreateApprovalRequest = async (
    requestData: Omit<ApprovalRequest, 'id' | 'requestNumber' | 'status' | 'requestedAtAD' | 'requestedAtBS'>
  ) => {
    await api.createApprovalRequest(requestData);
    await refreshAllData();
  };

  const handleProcessApprovalRequest = async (
    id: string,
    status: 'APPROVED' | 'REJECTED',
    rejectionReason?: string
  ) => {
    await api.processApprovalRequest(id, status, currentUser, rejectionReason);
    await refreshAllData();
  };

  const handleCancelApprovalRequest = async (id: string, reason?: string) => {
    await api.cancelApprovalRequest(id, currentUser, reason);
    await refreshAllData();
  };

  // Fetch data on initial mount and whenever branch/fiscal view changes.
  useEffect(() => {
    refreshAllData();
  }, [selectedBranchId, selectedFiscalYearId]);

  // Bootstrap the client-side BS calendar from the server so every AD -> BS
  // conversion in the UI is driven by the authoritative bs_calendar_years /
  // bs_day_records tables. Seeds made in the BS Calendar Utility (Admin) are
  // picked up on any client, even browsers with a fresh local storage.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const years = await api.getBsCalendarYears();
        if (cancelled || !Array.isArray(years)) return;
        for (const y of years) {
          if (y && y.yearBS && Array.isArray(y.daysInMonths) && y.daysInMonths.length === 12 && y.startAD) {
            seedBSYearCalendar(y.yearBS, y.daysInMonths, y.startAD);
          }
        }
      } catch (err) {
        console.error('Failed to sync BS calendar years from server:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Real-time synchronization stream: listen for background changes from any user/branch
  useEffect(() => {
    let debounceTimer: any = null;
    const unsubscribe = subscribeToSyncStream((event) => {
      // Debounce slightly to coalesce rapid bursts
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        refreshAllDataRef.current();
      }, 250);
    });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      unsubscribe();
    };
  }, [selectedBranchId]);

  // React to currentUser state changes & enforce branch/tab restrictions
  useEffect(() => {
    if (currentUser) {
      if (currentUser.branchId && currentUser.branchId !== 'ALL' && currentUser.role !== 'SUPER_ADMIN') {
        setSelectedBranchId(currentUser.branchId);
      } else if (currentUser.branchId === 'ALL' || currentUser.role === 'SUPER_ADMIN') {
        // Keep or allow branch selection
      }

      // Check for restricted tabs
      const adminOnlyTabs = ['branches', 'suppliers', 'users', 'permissions', 'audit', 'create-shipment', 'clear-demo-data'];
      if (adminOnlyTabs.includes(activeTab) && currentUser.role !== 'SUPER_ADMIN') {
        setActiveTab('dashboard');
      }
    }
  }, [currentUser]);

  // Global Keyboard Shortcuts (Alt+H for Help, Alt+B for Barcode, Alt+S/Ctrl+K for Search, Alt+D for Date Mode)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditingField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName || '');
      if (isEditingField) return;
      // While inside the Fiscal Year Closing Wizard, global search & barcode
      // overlays must not be able to open on top of it (focus-hijack guard).
      const closingWizardActive = activeTab === 'fiscal-year-closing';

      // Alt + H -> In-App Help & Documentation Center
      if (e.altKey && (e?.key || '').toLowerCase() === 'h') {
        e.preventDefault();
        setActiveTab('help-documentation');
      }
      // Alt + B -> Barcode Scanner (suppressed while closing wizard is open)
      if (e.altKey && (e?.key || '').toLowerCase() === 'b') {
        e.preventDefault();
        if (!closingWizardActive) setIsBarcodeModalOpen((prev) => !prev);
      }
      // Alt + S or Ctrl + K -> Global Search (suppressed while closing wizard is open)
      if ((e.altKey && (e?.key || '').toLowerCase() === 's') || ((e.ctrlKey || e.metaKey) && (e?.key || '').toLowerCase() === 'k')) {
        e.preventDefault();
        if (!closingWizardActive) setIsGlobalSearchOpen((prev) => !prev);
      }
      // Alt + D -> Date Mode Toggle (BS / AD)
      if (e.altKey && (e?.key || '').toLowerCase() === 'd') {
        e.preventDefault();
        handleToggleDateMode();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab]);

  // Handle Branch Selection with restriction for branch users
  const handleSelectBranch = (bId: string) => {
    if (currentUser?.branchId && currentUser.branchId !== 'ALL' && currentUser.role !== 'SUPER_ADMIN') {
      setSelectedBranchId(currentUser.branchId);
    } else {
      setSelectedBranchId(bId);
    }
  };

  // Auth actions
  const handleLogin = async (e: string, p: string) => {
    const res = await api.login(e, p);
    setCurrentUser(res.user);
    setRootUser(res.user);
    saveUserSession(res.user, res.user);
    refreshAllData();
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setRootUser(null);
    setUserContext(null);
    clearUserSession();
    clearRecentBootstrapCache();
    localStorage.removeItem(ACTIVE_TAB_STORAGE_KEY);
  };

  const handleSwitchProfile = async (targetUserId: string) => {
    const nextRoot = rootUser || currentUser;
    if (!rootUser && currentUser) {
      setRootUser(currentUser);
    }
    try {
      const res = await api.switchProfile(targetUserId);
      setCurrentUser(res.user);
      saveUserSession(res.user, nextRoot);
      await refreshAllData();
    } catch (err: any) {
      // Never fail silently. If the server session is gone (e.g. after a
      // server restart) drop the stale local session so the user can log
      // back in cleanly instead of being stuck on a dead profile.
      const message = err?.message || 'Unknown error';
      const isAuthError = /not authenticated|log in again|unauthorized|authentication required/i.test(message);
      if (isAuthError) {
        handleLogout();
      }
      alert(
        isAuthError
          ? 'Your session expired on the server. Please log in again, then switch profiles.'
          : `Could not switch profile: ${message}`
      );
      throw err;
    }
  };

  const handleSwitchBackToRoot = async () => {
    if (!rootUser) return;
    const rootName = rootUser.name;
    try {
      const res = await api.switchProfile(rootUser.id);
      setCurrentUser(res.user);
      saveUserSession(res.user, rootUser);
      await refreshAllData();
    } catch (err: any) {
      // If the root profile can no longer be reached (server restart, data
      // reset, or profile deleted), reset the local session so the user can
      // log straight back in instead of being stranded on a switched account.
      handleLogout();
      alert(
        `Could not switch back to ${rootName}: ${err?.message || 'Unknown error'}. Please log in again.`
      );
    }
  };

  const handleUpdateProfile = async (data: Partial<User> & { newPassword?: string }) => {
    const updatedUser = await api.updateProfile(data);
    setCurrentUser(updatedUser);
    const nextRoot = rootUser && rootUser.id === updatedUser.id ? updatedUser : rootUser;
    if (rootUser && rootUser.id === updatedUser.id) {
      setRootUser(updatedUser);
    }
    saveUserSession(updatedUser, nextRoot);
    await refreshAllData();
  };

  // Product Actions
  const handleCreateProduct = async (prod: Omit<Product, 'id'>) => {
    await api.createProduct(prod);
    refreshAllData();
  };

  const handleUpdateProduct = async (id: string, prod: Partial<Product>) => {
    await api.updateProduct(id, prod);
    refreshAllData();
  };

  const handleDeleteProduct = async (id: string) => {
    await api.deleteProduct(id);
    refreshAllData();
  };

  // Stock Actions
  const handleUpdateStockLevel = async (
    stockId: string,
    newQty: number,
    reason: string,
    damagedQty?: number,
    changeType?: string
  ) => {
    await api.updateStockLevel(stockId, newQty, reason, damagedQty, changeType);
    refreshAllData();
  };

  const handleUpdateStockReorderLevel = async (
    stockId: string,
    minReorderLevel: number
  ) => {
    await api.updateStockReorderLevel(stockId, minReorderLevel);
    refreshAllData();
  };

  const handleBulkUpdateStockReorderLevels = async (
    updates: { stockId: string; minReorderLevel: number }[]
  ) => {
    await api.bulkUpdateStockReorderLevels(updates);
    refreshAllData();
  };

  // Asset Actions
  const handleCreateAsset = async (
    asset: Omit<Asset, 'id' | 'netBookValue' | 'accumulatedDepreciation'>
  ) => {
    await api.createAsset(asset);

    // Stock-Out Integration: If asset has a productId associated, decrement branch inventory stock
    if (asset.productId) {
      await api.createStockOperation({
        type: 'STOCK_OUT',
        branchId: asset.branchId,
        productId: asset.productId,
        productName: asset.name,
        quantityChanged: -1,
        costPerUnit: asset.acquisitionCost,
        totalValue: asset.acquisitionCost,
        reason: `Fixed Asset Issued / Assigned: Tag ${asset.tagNumber} (${asset.name})`,
        inspectorName: currentUser?.name || 'Asset Manager',
        dateAD: asset.acquisitionDateAD,
        dateBS: asset.acquisitionDateBS,
        fiscalYear: financialSummary?.currentFiscalYear || '2081/82',
        status: 'LOGGED',
      });
    }

    refreshAllData();
  };

  const handleUpdateAssetStatus = async (id: string, updates: Asset['status'] | Partial<Asset>) => {
    await api.updateAssetStatus(id, updates);
    refreshAllData();
  };

  // PO Actions
  const handleCreatePO = async (
    po: Omit<
      PurchaseOrder,
      'id' | 'poNumber' | 'subtotalAmount' | 'taxAmount' | 'totalAmount'
    >
  ) => {
    await api.createPurchaseOrder(po);
    refreshAllData();
  };

  const handleUpdatePO = async (poId: string, poData: Partial<PurchaseOrder>) => {
    await api.updatePurchaseOrder(poId, poData);
    refreshAllData();
  };

  const handleUpdatePOStatus = async (poId: string, status: string) => {
    await api.updatePurchaseOrderStatus(poId, status);
    refreshAllData();
  };

  const handleDeletePO = async (poId: string) => {
    await api.deletePurchaseOrder(poId);
    await refreshAllData();
  };

  // Invoice Actions
  const handleCreateInvoice = async (
    inv: Omit<PurchaseInvoice, 'id' | 'invoiceNumber'>
  ) => {
    const created = await api.createPurchaseInvoice(inv);
    
    // Automatically provision device serial inventory records for hardware assets purchased
    if (inv.items) {
      for (const item of inv.items) {
        if (item.deviceSerials && item.deviceSerials.length > 0) {
          for (const sPair of item.deviceSerials) {
            await api.createCustomerDevice({
              customerId: `CUST-STOCK-${Date.now()}`,
              customerName: 'Unassigned Stock',
              customerCode: 'STOCK-INV',
              contactPhone: '-',
              installationAddress: 'Warehouse / Branch Stock',
              branchId: inv.branchId,
              productName: item.productName,
              deviceSerial: sPair.deviceSerial,
              ponSerial: sPair.ponSerial || '-',
              macAddress: sPair.macAddress || '-',
              status: 'IN_STOCK',
              issuedDateAD: inv.invoiceDateAD,
              issuedDateBS: inv.invoiceDateBS,
              purchaseBillRef: created.vendorBillNumber || created.invoiceNumber,
            });
          }
        }
      }
    }

    refreshAllData();
  };

  const handleDeleteInvoice = async (invoiceId: string) => {
    await api.deletePurchaseInvoice(invoiceId);
    await refreshAllData();
  };

  const handleRecordPayment = async (id: string, amount: number) => {
    await api.recordInvoicePayment(id, amount);
    refreshAllData();
  };

  // Shipment Actions
  const handleReceiveShipment = async (
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
  ) => {
    await api.receiveShipment(id, verificationData);
    refreshAllData();
  };

  const handleCancelReceiveShipment = async (id: string, reason?: string) => {
    await api.cancelReceiveShipment(id, currentUser, reason);
    refreshAllData();
  };

  // Stock Operations Actions
  const handleCreateOperation = async (op: Partial<StockOperation>) => {
    await api.createStockOperation(op);
    refreshAllData();
  };

  const handleReceiveOperation = async (id: string) => {
    await api.receiveStockOperation(id);
    refreshAllData();
  };

  // Fiscal Year Actions
  const handleSetCurrentFiscalYear = async (id: string) => {
    await api.setCurrentFiscalYear(id);
    refreshAllData();
  };

  const handleUpdateFiscalYear = async (fiscalYear: FiscalYear) => {
    await api.updateFiscalYear(fiscalYear);
    refreshAllData();
  };

  const handleCloseFiscalYear = async (
    id: string,
    credentials?: { adminEmail: string; adminPassword: string }
  ) => {
    await api.closeFiscalYear(id, credentials);
    await refreshAllData();
  };

  const handleReopenFiscalYear = async (
    id: string,
    credentials?: { adminEmail: string; adminPassword: string }
  ) => {
    await api.reopenFiscalYear(id, credentials);
    await refreshAllData();
  };

  const handleInitializeFiscalYearOpeningStock = async (id: string) => {
    const result = await api.initializeFiscalYearOpeningStock(id);
    await refreshAllData();
    return result;
  };

  const handleDeleteFiscalYear = async (id: string) => {
    await api.deleteFiscalYear(id);
    refreshAllData();
  };

  // Badge calculations (Consolidated Low Stock SKU Count respecting selected branch context & per-branch thresholds)
  const lowStockCount = products.filter((prod) => {
    const activeBr =
      selectedBranchId === 'ALL'
        ? branches
        : branches.filter((b) => b.id === selectedBranchId);

    let totalOnHand = 0;
    let totalConsolidatedReorder = 0;
    let isAnyBranchLow = false;

    activeBr.forEach((b) => {
      const item = stock.find((st) => st.productId === prod.id && st.branchId === b.id);
      const onHand = item ? item.quantityOnHand : 0;
      totalOnHand += onHand;

      const threshold =
        item?.minReorderLevel !== undefined && item?.minReorderLevel !== null
          ? item.minReorderLevel
          : prod.minReorderLevel;
      totalConsolidatedReorder += threshold;

      if (threshold > 0 && onHand <= threshold) {
        isAnyBranchLow = true;
      } else if (threshold === 0 && onHand < 0) {
        isAnyBranchLow = true;
      }
    });

    return isAnyBranchLow || (totalConsolidatedReorder > 0 && totalOnHand <= totalConsolidatedReorder);
  }).length;

  const pendingPoCount = purchaseOrders.filter(
    (po) => po.status === 'SENT' || po.status === 'APPROVED'
  ).length;

  const pendingBillCount = purchaseInvoices.filter(
    (inv) => inv.paymentStatus !== 'PAID'
  ).length;

  const activeBranchContext =
    selectedBranchId && selectedBranchId !== 'ALL'
      ? selectedBranchId
      : currentUser?.branchId && currentUser.branchId !== 'ALL'
      ? currentUser.branchId
      : 'ALL';

  const pendingPulloutsCount = stockOperations.filter(
    (op) =>
      op.type === 'PULLOUT' &&
      op.status !== 'RECEIVED' &&
      (activeBranchContext === 'ALL' || op.branchId === activeBranchContext)
  ).length;

  const inTransitShipmentCount =
    shipments.filter(
      (sh) =>
        (sh.status === 'IN_TRANSIT' || sh.status === 'DISPATCHED') &&
        (activeBranchContext === 'ALL' ||
          sh.destinationBranchId === activeBranchContext ||
          sh.sourceBranchId === activeBranchContext)
    ).length + pendingPulloutsCount;

  const activeFy =
    resolveDefaultFiscalYear(fiscalYears)?.code || financialSummary.currentFiscalYear;

  const handleGroupLowStockPO = () => {
    const activeBr =
      selectedBranchId === 'ALL'
        ? branches
        : branches.filter((b) => b.id === selectedBranchId);

    const lowStockProductMap = new Map<string, { product: Product; qty: number }>();

    products.forEach((prod) => {
      let productTotalDeficit = 0;

      activeBr.forEach((b) => {
        const item = stock.find((st) => st.productId === prod.id && st.branchId === b.id);
        const onHand = item ? item.quantityOnHand : 0;
        const threshold =
          item?.minReorderLevel !== undefined && item?.minReorderLevel !== null
            ? item.minReorderLevel
            : prod.minReorderLevel;

        if (threshold > 0 && onHand <= threshold) {
          const deficit = Math.max(1, threshold - onHand);
          productTotalDeficit += deficit;
        } else if (threshold === 0 && onHand < 0) {
          const deficit = Math.abs(onHand);
          productTotalDeficit += deficit;
        }
      });

      if (productTotalDeficit > 0) {
        lowStockProductMap.set(prod.id, { product: prod, qty: productTotalDeficit });
      }
    });

    const lines: OrderFormLine[] = Array.from(lowStockProductMap.values()).map(
      ({ product, qty }) => ({
        productId: product.id,
        quantity: Math.max(1, qty),
        unitPrice: product.costPrice,
        discount: 0,
        isTaxExempt: product.taxRate === 0,
      })
    );

    setPrepopulatedPOLines(lines);
    setActiveTab('create-po');
  };

  if (!currentUser) {
    return (
      <div
        className={`h-screen w-screen overflow-hidden font-sans flex flex-col antialiased transition-colors duration-200 ${
          isDarkMode ? 'bg-[#0a0c10] text-slate-300' : 'bg-[#f0f2f5] text-slate-800'
        }`}
      >
        <LoginModal
          onLoginSuccess={handleLogin}
          branches={branches}
          onSetupSuperAdmin={async (data) => {
            const res = await api.setupSuperAdmin(data);
            setCurrentUser(res.user);
            setRootUser(res.user);
            saveUserSession(res.user, res.user);
            refreshAllData();
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={`h-screen w-screen overflow-hidden font-sans flex flex-col antialiased transition-colors duration-200 ${
        isDarkMode ? 'bg-[#0a0c10] text-slate-300' : 'bg-[#f0f2f5] text-slate-800'
      }`}
    >
      {/* Top App Header (Fixed at top) */}
      <Header
        companyProfile={companyProfile}
        currentUser={currentUser}
        rootUser={rootUser}
        onSwitchBackToRoot={handleSwitchBackToRoot}
        users={users}
        onSwitchProfile={handleSwitchProfile}
        branches={branches}
        selectedBranchId={selectedBranchId}
        onSelectBranch={handleSelectBranch}
        dateMode={dateMode}
        onToggleDateMode={handleToggleDateMode}
        currentFiscalYear={activeFy}
        fiscalYears={fiscalYears}
        selectedFiscalYearId={selectedFiscalYearId}
        onSelectFiscalYear={setSelectedFiscalYearId}
        onOpenBarcodeModal={() => setIsBarcodeModalOpen(true)}
        onOpenSearchModal={
          activeTab === 'fiscal-year-closing' ? undefined : () => setIsGlobalSearchOpen(true)
        }
        onLogout={handleLogout}
        onSwitchUser={handleLogin}
        onRefreshData={refreshAllData}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        lowStockCount={lowStockCount}
        isDarkMode={isDarkMode}
        onToggleTheme={handleToggleTheme}
        onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
        isSidebarOpen={isSidebarOpen}
        products={products}
        stock={stock}
        approvalRequests={approvalRequests}
        purchaseOrders={purchaseOrders}
        shipments={shipments}
        onSelectTab={setActiveTab}
        onOpenNotification={() => setIsNotificationOpen((prev) => !prev)}
        onOpenProfileModal={() => setIsProfileModalOpen(true)}
      />

      {/* Direct PostgreSQL Database Setup Notification Banner */}
      <DatabaseSetupBanner
        isDarkMode={isDarkMode}
        onRefresh={refreshAllData}
        loading={loading}
        postgresConfig={{
          host: postgresStatus.host,
          port: postgresStatus.port,
          database: postgresStatus.database,
          user: postgresStatus.user,
          isConnected: postgresStatus.isConnected,
          errorDetails: postgresStatus.errorDetails,
        }}
      />

      {/* Main Workspace Layout */}
      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        {/* Mobile Backdrop */}
        {isSidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/60 backdrop-blur-xs md:hidden"
            onClick={() => setIsSidebarOpen(false)}
          />
        )}

        {/* Navigation Sidebar (Drawer on Mobile, Static on Desktop) */}
        <div
          className={`fixed inset-y-0 left-0 z-40 transform transition-transform duration-300 ease-in-out md:static md:translate-x-0 ${
            isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <Sidebar
            companyProfile={companyProfile}
            currentUser={currentUser}
            activeTab={activeTab}
            onSelectTab={(tab) => {
              setActiveTab(tab);
              setIsSidebarOpen(false); // Auto close sidebar on mobile selection
            }}
            lowStockCount={lowStockCount}
            pendingPoCount={pendingPoCount}
            pendingBillCount={pendingBillCount}
            inTransitShipmentCount={inTransitShipmentCount}
            pendingApprovalCount={approvalRequests.filter((r) => r.status === 'PENDING').length}
            isDarkMode={isDarkMode}
            onCloseMobile={() => setIsSidebarOpen(false)}
          />
        </div>

        {/* Main Content Viewport */}
        <main
          className={`flex-1 overflow-y-auto p-2.5 sm:p-3.5 transition-colors duration-200 ${
            isDarkMode ? 'bg-[#0a0c10]' : 'bg-[#f8fafc]'
          }`}
        >
          {loading ? (
            <div className="flex flex-col items-center justify-center h-64 space-y-3">
              <Loader2 className="h-8 w-8 text-indigo-500 animate-spin" />
              <p className="text-xs font-semibold text-slate-400">
                Synchronizing multi-branch inventory database...
              </p>
            </div>
          ) : (
            <>
              {activeTab === 'dashboard' && (
                <Dashboard
                  currentUser={currentUser}
                  products={products}
                  stock={stock}
                  branches={branches}
                  assets={assets}
                  purchaseOrders={purchaseOrders}
                  shipments={shipments}
                  transactionLogs={transactionLogs}
                  financialSummary={financialSummary}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  approvalRequests={approvalRequests}
                  onProcessApproval={handleProcessApprovalRequest}
                  onNavigateTab={setActiveTab}
                  onSelectBranch={handleSelectBranch}
                  onGroupLowStockPO={handleGroupLowStockPO}
                  onUpdateStockLevel={handleUpdateStockLevel}
                  isDarkMode={isDarkMode}
                />
              )}

              {(activeTab === 'approvals' || activeTab === 'workflow-approval') && (
                <ApprovalWorkflowCenter
                  approvalRequests={approvalRequests}
                  branches={branches}
                  currentUser={currentUser}
                  dateMode={dateMode}
                  isDarkMode={isDarkMode}
                  onProcessApproval={handleProcessApprovalRequest}
                  onCancelApproval={handleCancelApprovalRequest}
                  onNavigateToStockAudit={(branchId) => {
                    if (branchId && branchId !== 'ALL') {
                      setSelectedBranchId(branchId);
                    }
                    setActiveTab('physical-stock-audit');
                  }}
                />
              )}

              {activeTab === 'all-stock' && (
                <ProductManagement
                  currentUser={currentUser}
                  products={products}
                  stock={stock}
                  selectedBranchId={selectedBranchId}
                  onCreateProduct={handleCreateProduct}
                  onUpdateProduct={handleUpdateProduct}
                  onDeleteProduct={handleDeleteProduct}
                  searchQuery={searchQuery}
                  isDarkMode={isDarkMode}
                  mode="all-stock"
                  dbCategories={categories}
                />
              )}

              {activeTab === 'product-master' && (
                <ProductManagement
                  currentUser={currentUser}
                  products={products}
                  stock={stock}
                  selectedBranchId={selectedBranchId}
                  onCreateProduct={handleCreateProduct}
                  onUpdateProduct={handleUpdateProduct}
                  onDeleteProduct={handleDeleteProduct}
                  searchQuery={searchQuery}
                  isDarkMode={isDarkMode}
                  mode="product-master"
                  dbCategories={categories}
                />
              )}

              {activeTab === 'opening-stock' && (
                <OpeningStockManager
                  currentUser={currentUser}
                  fiscalYears={fiscalYears}
                  branches={branches}
                  products={products}
                  isDarkMode={isDarkMode}
                  onRefreshData={refreshAllData}
                />
              )}

              {activeTab === 'category-management' && (
                <CategoryManagement
                  currentUser={currentUser}
                  products={products}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'uom-management' && (
                <UomManagement
                  currentUser={currentUser}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'import-stock' && (
                <ImportStock
                  branches={branches}
                  products={products}
                  onCreateProduct={handleCreateProduct}
                  onRefreshData={refreshAllData}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'export-stock' && (
                <ExportStock
                  currentUser={currentUser}
                  products={products}
                  branches={branches}
                  stock={stock}
                  customerDevices={customerDevices}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'branch-stock' && (
                <BranchStockTracking
                  currentUser={currentUser}
                  products={products}
                  branches={branches}
                  stock={stock}
                  selectedBranchId={selectedBranchId}
                  onUpdateStockLevel={handleUpdateStockLevel}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'reorder-stock' && (
                <ReorderStockTracking
                  currentUser={currentUser}
                  products={products}
                  branches={branches}
                  stock={stock}
                  selectedBranchId={selectedBranchId}
                  onUpdateStockLevel={handleUpdateStockLevel}
                  onUpdateStockReorderLevel={handleUpdateStockReorderLevel}
                  onBulkUpdateStockReorderLevels={handleBulkUpdateStockReorderLevels}
                  onGroupLowStockPO={handleGroupLowStockPO}
                  onNavigateTab={setActiveTab}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'damaged-stock' && (
                <DamagedStockTracking
                  currentUser={currentUser}
                  products={products}
                  branches={branches}
                  stock={stock}
                  selectedBranchId={selectedBranchId}
                  onUpdateStockLevel={handleUpdateStockLevel}
                  onCreateOperation={handleCreateOperation}
                  onNavigateTab={setActiveTab}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'stock-valuation' && (
                <StockValuation
                  products={products}
                  branches={branches}
                  stock={stock}
                  selectedBranchId={selectedBranchId}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'stock-ledger' && (
                <StockMovementLedger
                  transactionLogs={transactionLogs}
                  products={products}
                  branches={branches}
                  stock={stock}
                  stockOperations={stockOperations}
                  shipments={shipments}
                  purchaseOrders={purchaseOrders}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'physical-stock-audit' && (
                <PhysicalStockAudit
                  currentUser={currentUser}
                  products={products}
                  branches={branches}
                  stock={stock}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  isDarkMode={isDarkMode}
                  approvalRequests={approvalRequests}
                  onUpdateStockLevel={handleUpdateStockLevel}
                  onReconcileStockAudit={async (payload) => {
                    await api.reconcileStockAudit(payload);
                    await refreshAllData();
                  }}
                  onRequestApproval={handleCreateApprovalRequest}
                  onCancelApproval={handleCancelApprovalRequest}
                  onProcessApproval={handleProcessApprovalRequest}
                  onNavigateTab={setActiveTab}
                />
              )}

              {activeTab === 'fixed-assets' && (
                <FixedAssetRegister
                  currentUser={currentUser}
                  assets={assets}
                  branches={branches}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  onCreateAsset={handleCreateAsset}
                  onUpdateAssetStatus={handleUpdateAssetStatus}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'customers' && (
                <CustomerMasterDirectory
                  customers={customers}
                  customerDevices={customerDevices}
                  branches={branches}
                  currentUser={currentUser}
                  onAddCustomer={async (customer) => {
                    await api.createCustomer(customer);
                    await refreshAllData();
                  }}
                  onUpdateCustomer={async (id, updates) => {
                    await api.updateCustomer(id, updates);
                    await refreshAllData();
                  }}
                  onDeleteCustomer={async (id) => {
                    await api.deleteCustomer(id);
                    await refreshAllData();
                  }}
                  onNavigateToImport={() => setActiveTab('import-customers')}
                  onSelectTab={(tab, filter) => {
                    setActiveTab(tab as any);
                    if (filter) setSearchQuery(filter);
                  }}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'customer-devices' && (
                <CustomersManagement
                  currentUser={currentUser}
                  customerDevices={customerDevices}
                  customers={customers}
                  branches={branches}
                  products={products}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  approvalRequests={approvalRequests}
                  onCreateCustomerDevice={async (newRecord) => {
                    await api.createCustomerDevice(newRecord);
                    await refreshAllData();
                  }}
                  onUpdateStatus={async (id, status) => {
                    await api.updateCustomerDeviceStatus(id, status);
                    await refreshAllData();
                  }}
                  onExchangeSuccess={refreshAllData}
                  onRequestApproval={handleCreateApprovalRequest}
                  onCancelApproval={handleCancelApprovalRequest}
                  onNavigateToMaster={() => setActiveTab('customers')}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'locations' && (
                <LocationsManagement
                  branches={branches}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'import-customers' && (
                <ImportCustomers
                  branches={branches}
                  onImportCustomersSuccess={async (newCustomers) => {
                    await api.bulkImportCustomers(newCustomers);
                    await refreshAllData();
                  }}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'create-po' && (
                <PurchaseOrders
                  companyProfile={companyProfile}
                  purchaseInvoices={purchaseInvoices}
                  currentUser={currentUser}
                  purchaseOrders={purchaseOrders}
                  products={products}
                  branches={branches}
                  suppliers={suppliers}
                  stock={stock}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  activeTab="create-po"
                  prepopulatedLines={prepopulatedPOLines}
                  onCreatePO={handleCreatePO}
                  onUpdatePO={handleUpdatePO}
                  onUpdatePOStatus={handleUpdatePOStatus}
                  onDeletePO={handleDeletePO}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'po-list' && (
                <PurchaseOrders
                  companyProfile={companyProfile}
                  purchaseInvoices={purchaseInvoices}
                  currentUser={currentUser}
                  purchaseOrders={purchaseOrders}
                  products={products}
                  branches={branches}
                  suppliers={suppliers}
                  stock={stock}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  activeTab="po-list"
                  prepopulatedLines={prepopulatedPOLines}
                  onCreatePO={handleCreatePO}
                  onUpdatePO={handleUpdatePO}
                  onUpdatePOStatus={handleUpdatePOStatus}
                  onDeletePO={handleDeletePO}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'create-purchase' && (
                <PurchaseInvoices
                  companyProfile={companyProfile}
                  currentUser={currentUser}
                  invoices={purchaseInvoices}
                  products={products}
                  branches={branches}
                  suppliers={suppliers}
                  stock={stock}
                  purchaseOrders={purchaseOrders}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  activeTab="create-purchase"
                  onCreateInvoice={handleCreateInvoice}
                  onRecordPayment={handleRecordPayment}
                  onDeleteInvoice={handleDeleteInvoice}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'purchase-list' && (
                <PurchaseInvoices
                  companyProfile={companyProfile}
                  currentUser={currentUser}
                  invoices={purchaseInvoices}
                  products={products}
                  branches={branches}
                  suppliers={suppliers}
                  stock={stock}
                  purchaseOrders={purchaseOrders}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  activeTab="purchase-list"
                  onCreateInvoice={handleCreateInvoice}
                  onRecordPayment={handleRecordPayment}
                  onDeleteInvoice={handleDeleteInvoice}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'create-shipment' && (
                <Shipments
                  currentUser={currentUser}
                  activeTab="create-shipment"
                  shipments={shipments}
                  products={products}
                  branches={branches}
                  stock={stock}
                  customerDevices={customerDevices}
                  approvalRequests={approvalRequests}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  onCreateShipment={async (sh) => {
                    await api.createShipment(sh);
                    refreshAllData();
                  }}
                  onReceiveShipment={handleReceiveShipment}
                  onCancelReceiveShipment={handleCancelReceiveShipment}
                  onRequestApproval={handleCreateApprovalRequest}
                  onCancelApproval={handleCancelApprovalRequest}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'create-transfer' && (
                <StockOperations
                  operations={stockOperations}
                  products={products}
                  branches={branches}
                  stock={stock}
                  customerDevices={customerDevices}
                  customers={customers}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  initialType="CREATE_TRANSFER"
                  autoOpenModal={false}
                  isDarkMode={isDarkMode}
                  currentUser={currentUser}
                  shipments={shipments}
                  assets={assets}
                  approvalRequests={approvalRequests}
                  onCreateOperation={handleCreateOperation}
                  onReceiveOperation={handleReceiveOperation}
                  onCreateShipment={async (sh) => {
                    await api.createShipment(sh);
                    refreshAllData();
                  }}
                  onReceiveShipment={handleReceiveShipment}
                  onCancelReceiveShipment={handleCancelReceiveShipment}
                  onRequestApproval={handleCreateApprovalRequest}
                  onCancelApproval={handleCancelApprovalRequest}
                  onUpdateAssetStatus={handleUpdateAssetStatus}
                />
              )}

              {activeTab === 'receive-shipment' && (
                <ReceiveInboundWarehouse
                  currentUser={currentUser}
                  operations={stockOperations}
                  shipments={shipments}
                  products={products}
                  branches={branches}
                  stock={stock}
                  approvalRequests={approvalRequests}
                  isDarkMode={isDarkMode}
                  dateMode={dateMode}
                  onReceiveOperation={handleReceiveOperation}
                  onReceiveShipment={handleReceiveShipment}
                  onCancelReceiveShipment={handleCancelReceiveShipment}
                />
              )}

              {activeTab === 'receive-branch-transfer' && (
                <StockOperations
                  operations={stockOperations}
                  products={products}
                  branches={branches}
                  stock={stock}
                  customerDevices={customerDevices}
                  customers={customers}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  initialType="RECEIVE_TRANSFER"
                  autoOpenModal={false}
                  isDarkMode={isDarkMode}
                  currentUser={currentUser}
                  shipments={shipments}
                  assets={assets}
                  approvalRequests={approvalRequests}
                  onCreateOperation={handleCreateOperation}
                  onReceiveOperation={handleReceiveOperation}
                  onCreateShipment={async (sh) => {
                    await api.createShipment(sh);
                    refreshAllData();
                  }}
                  onReceiveShipment={handleReceiveShipment}
                  onCancelReceiveShipment={handleCancelReceiveShipment}
                  onRequestApproval={handleCreateApprovalRequest}
                  onCancelApproval={handleCancelApprovalRequest}
                  onUpdateAssetStatus={handleUpdateAssetStatus}
                />
              )}

              {activeTab === 'shipment-list' && (
                <Shipments
                  currentUser={currentUser}
                  activeTab={activeTab}
                  shipments={shipments}
                  products={products}
                  branches={branches}
                  stock={stock}
                  customerDevices={customerDevices}
                  approvalRequests={approvalRequests}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  onCreateShipment={async (sh) => {
                    await api.createShipment(sh);
                    refreshAllData();
                  }}
                  onReceiveShipment={handleReceiveShipment}
                  onCancelReceiveShipment={handleCancelReceiveShipment}
                  onRequestApproval={handleCreateApprovalRequest}
                  onCancelApproval={handleCancelApprovalRequest}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'pullout' && (
                <StockOperations
                  operations={stockOperations}
                  products={products}
                  branches={branches}
                  stock={stock}
                  customerDevices={customerDevices}
                  customers={customers}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  initialType="PULLOUT"
                  autoOpenModal={false}
                  isDarkMode={isDarkMode}
                  currentUser={currentUser}
                  shipments={shipments}
                  assets={assets}
                  approvalRequests={approvalRequests}
                  onCreateOperation={handleCreateOperation}
                  onReceiveOperation={handleReceiveOperation}
                  onCreateShipment={async (sh) => {
                    await api.createShipment(sh);
                    refreshAllData();
                  }}
                  onReceiveShipment={handleReceiveShipment}
                  onCancelReceiveShipment={handleCancelReceiveShipment}
                  onRequestApproval={handleCreateApprovalRequest}
                  onCancelApproval={handleCancelApprovalRequest}
                  onUpdateAssetStatus={handleUpdateAssetStatus}
                />
              )}

              {activeTab === 'damage' && (
                <StockOperations
                  operations={stockOperations}
                  products={products}
                  branches={branches}
                  stock={stock}
                  customerDevices={customerDevices}
                  customers={customers}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  initialType="DAMAGE"
                  autoOpenModal={false}
                  isDarkMode={isDarkMode}
                  currentUser={currentUser}
                  shipments={shipments}
                  assets={assets}
                  approvalRequests={approvalRequests}
                  onCreateOperation={handleCreateOperation}
                  onReceiveOperation={handleReceiveOperation}
                  onCreateShipment={async (sh) => {
                    await api.createShipment(sh);
                    refreshAllData();
                  }}
                  onReceiveShipment={handleReceiveShipment}
                  onCancelReceiveShipment={handleCancelReceiveShipment}
                  onRequestApproval={handleCreateApprovalRequest}
                  onCancelApproval={handleCancelApprovalRequest}
                  onUpdateAssetStatus={handleUpdateAssetStatus}
                />
              )}

              {activeTab === 'pullout-report' && (
                <StockOperations
                  operations={stockOperations}
                  products={products}
                  branches={branches}
                  stock={stock}
                  customerDevices={customerDevices}
                  customers={customers}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  initialType="PULLOUT_REPORT"
                  autoOpenModal={false}
                  isDarkMode={isDarkMode}
                  currentUser={currentUser}
                  shipments={shipments}
                  assets={assets}
                  approvalRequests={approvalRequests}
                  onCreateOperation={handleCreateOperation}
                  onReceiveOperation={handleReceiveOperation}
                />
              )}

              {activeTab === 'damage-report' && (
                <StockOperations
                  operations={stockOperations}
                  products={products}
                  branches={branches}
                  stock={stock}
                  customerDevices={customerDevices}
                  customers={customers}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  initialType="DAMAGE_REPORT"
                  autoOpenModal={false}
                  isDarkMode={isDarkMode}
                  currentUser={currentUser}
                  shipments={shipments}
                  assets={assets}
                  approvalRequests={approvalRequests}
                  onCreateOperation={handleCreateOperation}
                />
              )}

              {activeTab === 'stock-out' && (
                <StockOperations
                  operations={stockOperations}
                  products={products}
                  branches={branches}
                  stock={stock}
                  customerDevices={customerDevices}
                  customers={customers}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  initialType="STOCK_OUT"
                  autoOpenModal={false}
                  isDarkMode={isDarkMode}
                  currentUser={currentUser}
                  shipments={shipments}
                  assets={assets}
                  approvalRequests={approvalRequests}
                  onCreateOperation={handleCreateOperation}
                  onReceiveOperation={handleReceiveOperation}
                  onCreateShipment={async (sh) => {
                    await api.createShipment(sh);
                    refreshAllData();
                  }}
                  onReceiveShipment={handleReceiveShipment}
                  onCancelReceiveShipment={handleCancelReceiveShipment}
                  onRequestApproval={handleCreateApprovalRequest}
                  onCancelApproval={handleCancelApprovalRequest}
                  onUpdateAssetStatus={handleUpdateAssetStatus}
                />
              )}

              {activeTab === 'assign-asset' && (
                <StockOperations
                  operations={stockOperations}
                  products={products}
                  branches={branches}
                  stock={stock}
                  customerDevices={customerDevices}
                  customers={customers}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  initialType="ASSIGN_ASSET"
                  autoOpenModal={false}
                  isDarkMode={isDarkMode}
                  currentUser={currentUser}
                  shipments={shipments}
                  assets={assets}
                  approvalRequests={approvalRequests}
                  onCreateOperation={handleCreateOperation}
                  onReceiveOperation={handleReceiveOperation}
                  onCreateShipment={async (sh) => {
                    await api.createShipment(sh);
                    refreshAllData();
                  }}
                  onReceiveShipment={handleReceiveShipment}
                  onCancelReceiveShipment={handleCancelReceiveShipment}
                  onRequestApproval={handleCreateApprovalRequest}
                  onCancelApproval={handleCancelApprovalRequest}
                  onUpdateAssetStatus={handleUpdateAssetStatus}
                />
              )}

              {activeTab === 'consumable-issue' && (
                <StockOperations
                  operations={stockOperations}
                  products={products}
                  branches={branches}
                  stock={stock}
                  customerDevices={customerDevices}
                  customers={customers}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  initialType="CONSUMABLE_ISSUE"
                  autoOpenModal={false}
                  isDarkMode={isDarkMode}
                  currentUser={currentUser}
                  shipments={shipments}
                  assets={assets}
                  approvalRequests={approvalRequests}
                  onCreateOperation={handleCreateOperation}
                  onReceiveOperation={handleReceiveOperation}
                  onCreateShipment={async (sh) => {
                    await api.createShipment(sh);
                    refreshAllData();
                  }}
                  onReceiveShipment={handleReceiveShipment}
                  onCancelReceiveShipment={handleCancelReceiveShipment}
                  onRequestApproval={handleCreateApprovalRequest}
                  onCancelApproval={handleCancelApprovalRequest}
                  onUpdateAssetStatus={handleUpdateAssetStatus}
                />
              )}

              {activeTab === 'device-exchange' && (
                <StockOperations
                  operations={stockOperations}
                  products={products}
                  branches={branches}
                  stock={stock}
                  customerDevices={customerDevices}
                  customers={customers}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  initialType="DEVICE_EXCHANGE"
                  autoOpenModal={false}
                  isDarkMode={isDarkMode}
                  currentUser={currentUser}
                  shipments={shipments}
                  assets={assets}
                  approvalRequests={approvalRequests}
                  onCreateOperation={handleCreateOperation}
                  onReceiveOperation={handleReceiveOperation}
                  onCreateShipment={async (sh) => {
                    await api.createShipment(sh);
                    refreshAllData();
                  }}
                  onReceiveShipment={handleReceiveShipment}
                  onCancelReceiveShipment={handleCancelReceiveShipment}
                  onRequestApproval={handleCreateApprovalRequest}
                  onCancelApproval={handleCancelApprovalRequest}
                  onUpdateAssetStatus={handleUpdateAssetStatus}
                />
              )}

              {activeTab === 'warranty-products' && (
                <WarrantyProducts
                  customerDevices={customerDevices}
                  assets={assets}
                  branches={branches}
                  products={products}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'branches' && (
                <BranchesManagement
                  currentUser={currentUser}
                  branches={branches}
                  onCreateBranch={async (b) => {
                    await api.createBranch(b);
                    refreshAllData();
                  }}
                  onUpdateBranch={async (id, b) => {
                    await api.updateBranch(id, b);
                    refreshAllData();
                  }}
                  onDeleteBranch={async (id) => {
                    await api.deleteBranch(id);
                    refreshAllData();
                  }}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'suppliers' && (
                <SuppliersManagement
                  currentUser={currentUser}
                  suppliers={suppliers}
                  onCreateSupplier={async (s) => {
                    await api.createSupplier(s);
                    refreshAllData();
                  }}
                  onUpdateSupplier={async (id, s) => {
                    await api.updateSupplier(id, s);
                    refreshAllData();
                  }}
                  onDeleteSupplier={async (id) => {
                    await api.deleteSupplier(id);
                    refreshAllData();
                  }}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'users' && (
                <UsersManagement
                  currentUser={currentUser}
                  users={users}
                  branches={branches}
                  onCreateUser={async (u) => {
                    await api.createUser(u);
                    refreshAllData();
                  }}
                  onUpdateUser={async (id, u) => {
                    await api.updateUser(id, u);
                    refreshAllData();
                  }}
                  onResetPassword={async (id, newPass) => {
                    await api.resetUserPassword(id, newPass);
                    refreshAllData();
                  }}
                  onDeleteUser={async (id) => {
                    await api.deleteUser(id);
                    refreshAllData();
                  }}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'permissions' && (
                <PermissionManagement currentUser={currentUser} isDarkMode={isDarkMode} />
              )}

              {activeTab === 'company-setup' && (
                <CompanySetupManagement
                  currentUser={currentUser}
                  companyProfile={companyProfile}
                  initialProfile={companyProfile}
                  onUpdateCompanyProfile={async (updatedProfile) => {
                    await api.updateCompanyProfile(updatedProfile);
                    await refreshAllData();
                    return true;
                  }}
                  onSave={async (updatedProfile) => {
                    await api.updateCompanyProfile(updatedProfile);
                    await refreshAllData();
                    return true;
                  }}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'clear-demo-data' && (
                <ClearDemoDataView
                  currentUser={currentUser}
                  productCount={products.length}
                  stockCount={stock.length}
                  assetCount={assets.length}
                  deviceCount={customerDevices.length}
                  customerCount={customers.length}
                  poCount={purchaseOrders.length}
                  invoiceCount={purchaseInvoices.length}
                  onClearDemoData={async () => {
                    await api.clearDemoData();
                    await refreshAllData();
                  }}
                  onNavigateDashboard={() => setActiveTab('dashboard')}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'financial-statements' && (
                <FinancialStatements
                  financialSummary={financialSummary}
                  assets={assets}
                  invoices={purchaseInvoices}
                  purchaseOrders={purchaseOrders}
                  dateMode={dateMode}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'vat-register' && (
                <VatRegister
                  invoices={purchaseInvoices}
                  dateMode={dateMode}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'depreciation-register' && (
                <DepreciationRegister
                  assets={assets}
                  branches={branches}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'audit' && (
                <AuditTrailReports
                  auditLogs={auditLogs}
                  transactionLogs={transactionLogs}
                  financialSummary={financialSummary}
                  products={products}
                  branches={branches}
                  assets={assets}
                  invoices={purchaseInvoices}
                  dateMode={dateMode}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'fiscal-year-closing' && (
                <FiscalYearClosingWizard
                  fiscalYears={fiscalYears}
                  onSetCurrentFiscalYear={handleSetCurrentFiscalYear}
                  onCloseFiscalYear={handleCloseFiscalYear}
                  onReopenFiscalYear={handleReopenFiscalYear}
                  onInitializeOpeningStock={handleInitializeFiscalYearOpeningStock}
                  dateMode={dateMode}
                  isDarkMode={isDarkMode}
                  financialSummary={financialSummary}
                  products={products}
                  stock={stock}
                  assets={assets}
                  purchaseInvoices={purchaseInvoices}
                  currentUser={currentUser}
                  onRefreshData={refreshAllData}
                />
              )}

              {activeTab === 'bs-calendar' && (
                <BsCalendarUtility
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'fiscal-year-management' && (
                <FiscalYearManagement
                  fiscalYears={fiscalYears}
                  onSetCurrentFiscalYear={handleSetCurrentFiscalYear}
                  onUpdateFiscalYear={handleUpdateFiscalYear}
                  onDeleteFiscalYear={handleDeleteFiscalYear}
                  currentUser={currentUser}
                  dateMode={dateMode}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'nepali-fiscal' && (
                <BsCalendarUtility
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'help-documentation' && (
                <HelpDocumentation
                  currentUser={currentUser}
                  isDarkMode={isDarkMode}
                  onOpenBarcodeModal={() => setIsBarcodeModalOpen(true)}
                  onOpenSearchModal={() => setIsGlobalSearchOpen(true)}
                  onNavigateTab={(tab) => {
                    if (tab === 'barcode-scanner') {
                      setIsBarcodeModalOpen(true);
                    } else if (tab === 'users-management' || tab === 'login') {
                      setActiveTab('users');
                    } else {
                      setActiveTab(tab as NavTab);
                    }
                  }}
                />
              )}
            </>
          )}
        </main>
      </div>

      {/* Barcode & Serial Scanner / Printable Label Modal */}
      <BarcodeScannerModal
        isOpen={isBarcodeModalOpen}
        onClose={() => setIsBarcodeModalOpen(false)}
        products={products}
      />

      {/* Global Quick Search Modal */}
      <GlobalSearchModal
        isOpen={isGlobalSearchOpen}
        onClose={() => setIsGlobalSearchOpen(false)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        products={products}
        purchaseOrders={purchaseOrders}
        invoices={purchaseInvoices}
        shipments={shipments}
        assets={assets}
        customerDevices={customerDevices}
        suppliers={suppliers}
        branches={branches}
        stock={stock}
        selectedBranchId={selectedBranchId}
        onSelectResult={(tab, filterText) => {
          setActiveTab(tab);
          if (filterText !== undefined) {
            setSearchQuery(filterText);
          }
          setIsGlobalSearchOpen(false);
        }}
        isDarkMode={isDarkMode}
      />

      {/* Realtime Notification & Action Center Modal */}
      <NotificationCenter
        isOpen={isNotificationOpen}
        onClose={() => setIsNotificationOpen(false)}
        products={products}
        stock={stock}
        approvalRequests={approvalRequests}
        purchaseOrders={purchaseOrders}
        shipments={shipments}
        branches={branches}
        selectedBranchId={selectedBranchId}
        isDarkMode={isDarkMode}
        onSelectTab={(tab) => {
          setActiveTab(tab as NavTab);
          setIsNotificationOpen(false);
        }}
      />

      {/* User Profile Info & Profile Switching Modal */}
      <ProfileSwitchModal
        isOpen={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
        currentUser={currentUser}
        rootUser={rootUser}
        onSwitchBackToRoot={handleSwitchBackToRoot}
        users={users}
        branches={branches}
        onSwitchProfile={handleSwitchProfile}
        onUpdateProfile={handleUpdateProfile}
        onLogout={handleLogout}
        isDarkMode={isDarkMode}
      />
    </div>
  );
}
