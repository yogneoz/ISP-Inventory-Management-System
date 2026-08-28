import React, { useState, useEffect } from 'react';
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
import { api, setUserContext, setAuthToken, subscribeToSyncStream } from './services/api';
import {
  saveUserSession,
  loadUserSession,
  loadAuthToken,
  clearUserSession,
  saveRecentBootstrapCache,
  loadRecentBootstrapCache,
  clearRecentBootstrapCache,
} from './utils/sessionCache';
import { Header } from './components/Header';
import { Sidebar, NavTab } from './components/Sidebar';
import { LoginModal } from './components/LoginModal';
import { ProfileSwitchModal } from './components/ProfileSwitchModal';
import { Dashboard } from './components/Dashboard';
import { ProductManagement } from './components/ProductManagement';
import { BranchStockTracking } from './components/BranchStockTracking';
import { ReorderStockTracking } from './components/ReorderStockTracking';
import { DamagedStockTracking } from './components/DamagedStockTracking';
import { FixedAssetRegister } from './components/FixedAssetRegister';
import { CustomersManagement } from './components/CustomersManagement';
import { CustomerMasterDirectory } from './components/CustomerMasterDirectory';
import { PurchaseOrders, OrderFormLine } from './components/PurchaseOrders';
import { PurchaseInvoices } from './components/PurchaseInvoices';
import { Shipments } from './components/Shipments';
import { StockOperations } from './components/StockOperations';
import { ReceiveInboundWarehouse } from './components/ReceiveInboundWarehouse';
import { NepaliFiscalManagement } from './components/NepaliFiscalManagement';
import { AuditTrailReports } from './components/AuditTrailReports';
import { BranchesManagement } from './components/BranchesManagement';
import { CompanySetupManagement } from './components/CompanySetupManagement';
import { SuppliersManagement } from './components/SuppliersManagement';
import { UsersManagement } from './components/UsersManagement';
import { PermissionManagement } from './components/PermissionManagement';
import { ExportReports } from './components/ExportReports';
import { FinancialStatements } from './components/FinancialStatements';
import { VatRegister } from './components/VatRegister';
import { DepreciationRegister } from './components/DepreciationRegister';
import { StockValuation } from './components/StockValuation';
import { NotificationCenter } from './components/NotificationCenter';
import { ApprovalWorkflowCenter } from './components/ApprovalWorkflowCenter';
import { StockMovementLedger } from './components/StockMovementLedger';
import { PhysicalStockAudit } from './components/PhysicalStockAudit';
import { FiscalYearClosingWizard } from './components/FiscalYearClosingWizard';
import { WarrantyProducts } from './components/WarrantyProducts';
import { CategoryManagement } from './components/CategoryManagement';
import { UomManagement } from './components/UomManagement';
import { ClearDemoDataView } from './components/ClearDemoDataView';
import { ImportStock } from './components/ImportStock';
import { ExportStock } from './components/ExportStock';
import { LocationsManagement } from './components/LocationsManagement';
import { ImportCustomers } from './components/ImportCustomers';
import { HelpDocumentation } from './components/HelpDocumentation';
import { AiAssistantModal } from './components/AiAssistantModal';
import { BarcodeScannerModal } from './components/BarcodeScannerModal';
import { GlobalSearchModal } from './components/GlobalSearchModal';
import { Loader2 } from 'lucide-react';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    return loadUserSession().currentUser;
  });

  const [rootUser, setRootUser] = useState<User | null>(() => {
    return loadUserSession().rootUser;
  });

  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [selectedBranchId, setSelectedBranchId] = useState<string>('ALL');
  const [dateMode, setDateMode] = useState<'BS' | 'AD'>('BS');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isAiModalOpen, setIsAiModalOpen] = useState<boolean>(false);
  const [isBarcodeModalOpen, setIsBarcodeModalOpen] = useState<boolean>(false);
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState<boolean>(false);
  const [isNotificationOpen, setIsNotificationOpen] = useState<boolean>(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [permissionsVersion, setPermissionsVersion] = useState<number>(0);

  // Restore bearer token from storage on first mount
  useEffect(() => {
    const token = loadAuthToken();
    if (token) {
      setAuthToken(token);
    } else if (currentUser) {
      // Stale user without token — force re-login
      setCurrentUser(null);
      setRootUser(null);
      clearUserSession();
    }
  }, []);

  // Synchronize permissions live across components
  useEffect(() => {
    setUserContext(currentUser);
  }, [currentUser]);

  useEffect(() => {
    const handlePermissionsUpdated = () => {
      setPermissionsVersion((v) => v + 1);
    };
    window.addEventListener('izone_permissions_updated', handlePermissionsUpdated);
    return () => window.removeEventListener('izone_permissions_updated', handlePermissionsUpdated);
  }, []);

  // Global search keyboard shortcut (Ctrl+K or Cmd+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e?.key || '').toLowerCase() === 'k') {
        e.preventDefault();
        setIsGlobalSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
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
  const refreshAllData = async () => {
    try {
      const data = await api.getBootstrapState(selectedBranchId);
      if (data) {
        applyBootstrapData(data);
        saveRecentBootstrapCache(data);
      }
    } catch (err) {
      console.error('Error fetching data from backend:', err);
    } finally {
      setLoading(false);
    }
  };

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

  // Fetch data on initial mount and whenever selectedBranchId changes
  useEffect(() => {
    refreshAllData();
  }, [selectedBranchId]);

  // Real-time synchronization stream: listen for background changes from any user/branch
  useEffect(() => {
    let debounceTimer: any = null;
    const unsubscribe = subscribeToSyncStream((event) => {
      // Debounce slightly to coalesce rapid bursts
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        refreshAllData();
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
      // Alt + H -> In-App Help & Documentation Center
      if (e.altKey && (e?.key || '').toLowerCase() === 'h') {
        e.preventDefault();
        setActiveTab('help-documentation');
      }
      // Alt + B -> Barcode Scanner
      if (e.altKey && (e?.key || '').toLowerCase() === 'b') {
        e.preventDefault();
        setIsBarcodeModalOpen((prev) => !prev);
      }
      // Alt + S or Ctrl + K -> Global Search
      if ((e.altKey && (e?.key || '').toLowerCase() === 's') || ((e.ctrlKey || e.metaKey) && (e?.key || '').toLowerCase() === 'k')) {
        e.preventDefault();
        setIsGlobalSearchOpen((prev) => !prev);
      }
      // Alt + D -> Date Mode Toggle (BS / AD)
      if (e.altKey && (e?.key || '').toLowerCase() === 'd') {
        e.preventDefault();
        setDateMode((prev) => (prev === 'BS' ? 'AD' : 'BS'));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
    setAuthToken(res.token);
    setCurrentUser(res.user);
    setRootUser(res.user);
    saveUserSession(res.user, res.user, res.token);
    refreshAllData();
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch (_e) {}
    setCurrentUser(null);
    setRootUser(null);
    setUserContext(null);
    setAuthToken(null);
    clearUserSession();
    clearRecentBootstrapCache();
  };

  const handleSwitchProfile = async (targetUserId: string) => {
    const nextRoot = rootUser || currentUser;
    if (!rootUser && currentUser) {
      setRootUser(currentUser);
    }
    const res = await api.switchProfile(targetUserId);
    if (res.token) setAuthToken(res.token);
    setCurrentUser(res.user);
    saveUserSession(res.user, nextRoot, res.token);
    await refreshAllData();
  };

  const handleSwitchBackToRoot = async () => {
    if (!rootUser) return;
    const res = await api.switchProfile(rootUser.id);
    if (res.token) setAuthToken(res.token);
    setCurrentUser(res.user);
    saveUserSession(res.user, rootUser, res.token);
    await refreshAllData();
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

  const handleUpdateAssetStatus = async (id: string, status: Asset['status']) => {
    await api.updateAssetStatus(id, status);
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

  const handleReceivePO = async (poId: string) => {
    await api.receivePurchaseOrder(poId);
    refreshAllData();
  };

  const handleUpdatePOStatus = async (poId: string, status: string) => {
    await api.updatePurchaseOrderStatus(poId, status);
    refreshAllData();
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
    fiscalYears.find((f) => f.isCurrent)?.code || financialSummary.currentFiscalYear;

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
            if (res.token) setAuthToken(res.token);
            setCurrentUser(res.user);
            setRootUser(res.user);
            saveUserSession(res.user, res.user, res.token);
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
        currentUser={currentUser}
        rootUser={rootUser}
        onSwitchBackToRoot={handleSwitchBackToRoot}
        users={users}
        onSwitchProfile={handleSwitchProfile}
        branches={branches}
        selectedBranchId={selectedBranchId}
        onSelectBranch={handleSelectBranch}
        dateMode={dateMode}
        onToggleDateMode={() => setDateMode(dateMode === 'BS' ? 'AD' : 'BS')}
        currentFiscalYear={activeFy}
        onOpenAiModal={() => setIsAiModalOpen(true)}
        onOpenBarcodeModal={() => setIsBarcodeModalOpen(true)}
        onOpenSearchModal={() => setIsGlobalSearchOpen(true)}
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

      {/* Main Workspace Layout */}
      <div className="flex flex-1 overflow-hidden h-[calc(100vh-4rem)] relative">
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
            currentUser={currentUser}
            activeTab={activeTab}
            onSelectTab={(tab) => {
              setActiveTab(tab);
              setIsSidebarOpen(false); // Auto close sidebar on mobile selection
            }}
            lowStockCount={lowStockCount}
            pendingPoCount={pendingPoCount}
            inTransitShipmentCount={inTransitShipmentCount}
            pendingApprovalCount={approvalRequests.filter((r) => r.status === 'PENDING').length}
            isDarkMode={isDarkMode}
            onCloseMobile={() => setIsSidebarOpen(false)}
            onSwitchUser={handleLogin}
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
                  onOpenAiModal={() => setIsAiModalOpen(true)}
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
                  currentUser={currentUser}
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
                  currentUser={currentUser}
                  purchaseOrders={purchaseOrders}
                  products={products}
                  branches={branches}
                  suppliers={suppliers}
                  stock={stock}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  autoOpenModal={true}
                  prepopulatedLines={prepopulatedPOLines}
                  onCreatePO={handleCreatePO}
                  onUpdatePO={handleUpdatePO}
                  onReceivePO={handleReceivePO}
                  onUpdatePOStatus={handleUpdatePOStatus}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'po-list' && (
                <PurchaseOrders
                  currentUser={currentUser}
                  purchaseOrders={purchaseOrders}
                  products={products}
                  branches={branches}
                  suppliers={suppliers}
                  stock={stock}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  autoOpenModal={false}
                  prepopulatedLines={prepopulatedPOLines}
                  onCreatePO={handleCreatePO}
                  onUpdatePO={handleUpdatePO}
                  onReceivePO={handleReceivePO}
                  onUpdatePOStatus={handleUpdatePOStatus}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'create-purchase' && (
                <PurchaseInvoices
                  currentUser={currentUser}
                  invoices={purchaseInvoices}
                  products={products}
                  branches={branches}
                  suppliers={suppliers}
                  stock={stock}
                  purchaseOrders={purchaseOrders}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  autoOpenModal={true}
                  onCreateInvoice={handleCreateInvoice}
                  onRecordPayment={handleRecordPayment}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'purchase-list' && (
                <PurchaseInvoices
                  currentUser={currentUser}
                  invoices={purchaseInvoices}
                  products={products}
                  branches={branches}
                  suppliers={suppliers}
                  stock={stock}
                  purchaseOrders={purchaseOrders}
                  selectedBranchId={selectedBranchId}
                  dateMode={dateMode}
                  autoOpenModal={false}
                  onCreateInvoice={handleCreateInvoice}
                  onRecordPayment={handleRecordPayment}
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
                  autoOpenModal={true}
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
                  onOpenAiModal={() => setIsAiModalOpen(true)}
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
                  onOpenAiModal={() => setIsAiModalOpen(true)}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'fiscal-year-closing' && (
                <FiscalYearClosingWizard
                  fiscalYears={fiscalYears}
                  onSetCurrentFiscalYear={handleSetCurrentFiscalYear}
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

              {activeTab === 'nepali-fiscal' && (
                <NepaliFiscalManagement
                  fiscalYears={fiscalYears}
                  onSetCurrentFiscalYear={handleSetCurrentFiscalYear}
                  dateMode={dateMode}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'export-reports' && (
                <ExportReports
                  currentUser={currentUser}
                  purchaseOrders={purchaseOrders}
                  invoices={purchaseInvoices}
                  shipments={shipments}
                  customerDevices={customerDevices}
                  products={products}
                  branches={branches}
                  suppliers={suppliers}
                  dateMode={dateMode}
                  isDarkMode={isDarkMode}
                />
              )}

              {activeTab === 'help-documentation' && (
                <HelpDocumentation
                  currentUser={currentUser}
                  isDarkMode={isDarkMode}
                  onOpenAiAssistant={() => setIsAiModalOpen(true)}
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

      {/* AI Strategist Modal */}
      <AiAssistantModal
        isOpen={isAiModalOpen}
        onClose={() => setIsAiModalOpen(false)}
        systemContext={{
          branchCount: branches.length,
          productCount: products.length,
          lowStockCount,
          pendingPoCount,
          activeFy,
        }}
      />

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
          setActiveTab(tab);
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
