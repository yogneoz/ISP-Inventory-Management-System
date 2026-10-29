import React, { useState, useEffect, useRef } from 'react';
import {
  User,
  Supplier,
  Branch,
  Product,
  CompanyProfile,
  InventoryStock,
  Asset,
  SerialLog,
  PurchaseOrder,
  PurchaseInvoice,
  SalesInvoice,
  PurchaseReturn,
  SalesReturn,
  CustomerPayment,
  Shipment,
  StockOperation,
  FiscalYear,
  AuditLog,
  FinancialSummary,
  ApprovalRequest,
  Category,
  DamageRecord,
  LocationRecord,
} from './types';
import { api, setAuthToken, setFiscalYearContext, setUserContext, setActiveBranchContext, subscribeToSyncStream, getSyncVersion, broadcastLogoutToOtherTabs } from './services/api';
import { seedBSYearCalendar, getBsCalendarCoverage, type BsCalendarCoverageStatus } from './utils/nepaliCalendar';
import { NAVIGATE_TAB_EVENT } from './services/api/http';
import {
  saveUserSession,
  clearUserSession,
  saveRecentBootstrapCache,
  loadRecentBootstrapCache,
  clearRecentBootstrapCache,
  BOOTSTRAP_CACHE_MAX_AGE_MS,
} from './utils/sessionCache';
import { AppShell } from './components/layout/AppShell';
import { NavTab, NAV_TABS } from './components/layout/Sidebar';
import { isOperationAllowed } from './utils/permissions';
import { indexStockByProductBranch, stockRowAt } from './utils/stockIndex';
import {
  DOMAIN_REGISTER_KEYS,
  bumpAllRegisterRefresh,
  domainsTouchSerialRegister,
  SseDomainBurst,
  type RegisterRefreshKey,
} from './utils/registerRefreshDomains';
import { invalidateSerialRegister } from './services/serialRegisterCache';
import {
  invalidateShipmentOverview,
  useShipmentOverview,
} from './services/shipmentOverviewCache';
import { mergeShipmentWindow } from './services/shipmentOverviewStore';
import { invalidateAvailableFixedAssets, resetAvailableFixedAssets } from './services/availableAssetsCache';
import { invalidateBranchStock, resetBranchStock } from './services/branchStockCache';
import { invalidateExchangeDevices, resetExchangeDevices } from './services/exchangeDeviceCache';
import { LoginModal } from './components/common/LoginModal';
import { Dashboard } from './features/dashboard/Dashboard';
import { ProductManagement } from './features/inventory/ProductManagement';
import { PurchaseOrders, OrderFormLine } from './features/procurement/PurchaseOrders';
// Rarely-used / heavy screens are lazy: their chunks download on first visit.
// Kept eager: Dashboard, ProductManagement, StockOperations (11 render sites),
// PurchaseOrders, modals, and anything referenced in the synchronous render path.
// BUDGET-1 (2026-10-26): Branch Stock, Fixed Assets, the Customer Master
// Directory, the Customer Devices register and the Serial Log moved here from
// the eager graph — 33.8 kB gzip of registers that no first paint renders.
const BranchStockTracking = React.lazy(() =>
  import('./features/inventory/BranchStockTracking').then((m) => ({ default: m.BranchStockTracking }))
);
const FixedAssetRegister = React.lazy(() =>
  import('./features/finance/FixedAssetRegister').then((m) => ({ default: m.FixedAssetRegister }))
);
const CustomersManagement = React.lazy(() =>
  import('./features/sales/CustomersManagement').then((m) => ({ default: m.CustomersManagement }))
);
const CustomerMasterDirectory = React.lazy(() =>
  import('./features/sales/CustomerMasterDirectory').then((m) => ({ default: m.CustomerMasterDirectory }))
);
const SerialLogRegister = React.lazy(() =>
  import('./features/inventory/SerialLogRegister').then((m) => ({ default: m.SerialLogRegister }))
);
const PurchaseInvoices = React.lazy(() =>
  import('./features/procurement/PurchaseInvoices').then((m) => ({ default: m.PurchaseInvoices }))
);
const SalesInvoices = React.lazy(() =>
  import('./features/sales/SalesInvoices').then((m) => ({ default: m.SalesInvoices }))
);
const ReturnsRegister = React.lazy(() =>
  import('./features/sales/ReturnsRegister').then((m) => ({ default: m.ReturnsRegister }))
);
const Shipments = React.lazy(() =>
  import('./features/procurement/Shipments').then((m) => ({ default: m.Shipments }))
);
const PhysicalStockAudit = React.lazy(() =>
  import('./features/inventory/PhysicalStockAudit').then((m) => ({ default: m.PhysicalStockAudit }))
);
const DamagedStockTracking = React.lazy(() =>
  import('./features/inventory/DamagedStockTracking').then((m) => ({ default: m.DamagedStockTracking }))
);
const ReorderStockTracking = React.lazy(() =>
  import('./features/inventory/ReorderStockTracking').then((m) => ({ default: m.ReorderStockTracking }))
);
const StockValuation = React.lazy(() =>
  import('./features/inventory/StockValuation').then((m) => ({ default: m.StockValuation }))
);
const StockMovementLedger = React.lazy(() =>
  import('./features/inventory/StockMovementLedger').then((m) => ({ default: m.StockMovementLedger }))
);
// Asset Deployments register (assigned fixed assets incl. non-serialized items)
const AssetDeployments = React.lazy(() =>
  import('./features/inventory/AssetDeployments').then((m) => ({ default: m.AssetDeployments }))
);
// DEV-ONLY: StatCard design-review gallery (hidden dev-statcard tab).
// Gated behind import.meta.env.DEV so the chunk is tree-shaken out of
// production builds entirely; the sidebar entry is gated the same way.
// `?.` because `import.meta.env` only exists under Vite: the A6 route-tree
// test loads this module under node:test (same guard as Sidebar).
const StatCardShowcase = import.meta.env?.DEV
  ? React.lazy(() => import('./features/dev/StatCardShowcase').then((m) => ({ default: m.StatCardShowcase })))
  : () => null;
const SupplierWarrantyRegister = React.lazy(() =>
  import('./features/inventory/SupplierWarrantyRegister').then((m) => ({
    default: m.SupplierWarrantyRegister,
  }))
);
const SellerWarrantyRegister = React.lazy(() =>
  import('./features/inventory/SellerWarrantyRegister').then((m) => ({
    default: m.SellerWarrantyRegister,
  }))
);
const CategoryManagement = React.lazy(() =>
  import('./features/inventory/CategoryManagement').then((m) => ({ default: m.CategoryManagement }))
);
const ProductGroupManagement = React.lazy(() =>
  import('./features/inventory/ProductGroupManagement').then((m) => ({ default: m.ProductGroupManagement }))
);
const UomManagement = React.lazy(() =>
  import('./features/inventory/UomManagement').then((m) => ({ default: m.UomManagement }))
);
const ImportStock = React.lazy(() =>
  import('./features/inventory/ImportStock').then((m) => ({ default: m.ImportStock }))
);
const ExportStock = React.lazy(() =>
  import('./features/inventory/ExportStock').then((m) => ({ default: m.ExportStock }))
);
const FinancialStatements = React.lazy(() =>
  import('./features/finance/FinancialStatements').then((m) => ({ default: m.FinancialStatements }))
);
const VatRegister = React.lazy(() =>
  import('./features/finance/VatRegister').then((m) => ({ default: m.VatRegister }))
);
const DepreciationRegister = React.lazy(() =>
  import('./features/finance/DepreciationRegister').then((m) => ({ default: m.DepreciationRegister }))
);
const AuditTrailReports = React.lazy(() =>
  import('./features/finance/AuditTrailReports').then((m) => ({ default: m.AuditTrailReports }))
);
const DocumentNumbering = React.lazy(() =>
  import('./features/finance/DocumentNumbering').then((m) => ({ default: m.DocumentNumbering }))
);
const OpeningStockManager = React.lazy(() =>
  import('./features/finance/OpeningStockManager').then((m) => ({ default: m.OpeningStockManager }))
);
const VendorOpeningBalances = React.lazy(() =>
  import('./features/finance/VendorOpeningBalances').then((m) => ({ default: m.VendorOpeningBalances }))
);
const VendorLedger = React.lazy(() =>
  import('./features/finance/VendorLedger').then((m) => ({ default: m.VendorLedger }))
);
const CustomerLedger = React.lazy(() =>
  import('./features/finance/CustomerLedger').then((m) => ({ default: m.CustomerLedger }))
);
const FiscalYearClosingWizard = React.lazy(() =>
  import('./features/finance/FiscalYearClosingWizard').then((m) => ({ default: m.FiscalYearClosingWizard }))
);
const LocationsManagement = React.lazy(() =>
  import('./features/settings/LocationsManagement').then((m) => ({ default: m.LocationsManagement }))
);
const ImportCustomers = React.lazy(() =>
  import('./features/sales/ImportCustomers').then((m) => ({ default: m.ImportCustomers }))
);
const ClearDemoDataView = React.lazy(() =>
  import('./components/common/ClearDemoDataView').then((m) => ({ default: m.ClearDemoDataView }))
);
const DataRecalculationMaintenance = React.lazy(() =>
  import('./features/settings/DataRecalculationMaintenance').then((m) => ({ default: m.DataRecalculationMaintenance }))
);
import { StockOperations } from './features/inventory/StockOperations';
import { ReceiveInboundWarehouse } from './features/procurement/ReceiveInboundWarehouse';
// exceljs (≈1 MB) is only needed for the BS calendar utility, so this
// component is lazy: the vendor-excel chunk downloads on first visit.
const BsCalendarUtility = React.lazy(() =>
  import('./features/finance/BsCalendarUtility').then((m) => ({
    default: m.BsCalendarUtility,
  }))
);
// BS fiscal-year settings (unlock / carry-forward). Reachable from the Help
// Center's "Unlock / Carry Forward Balances" step. The 'nepali-fiscal' tab
// rendered BsCalendarUtility instead, so this screen was never reachable.
const NepaliFiscalManagement = React.lazy(() =>
  import('./features/finance/NepaliFiscalManagement').then((m) => ({
    default: m.NepaliFiscalManagement,
  }))
);
import { BranchesManagement } from './features/settings/BranchesManagement';
import { CompanySetupManagement } from './features/settings/CompanySetupManagement';

const ACTIVE_TAB_STORAGE_KEY = 'inventory_active_tab';
import { SuppliersManagement } from './features/procurement/SuppliersManagement';
import { UsersManagement } from './features/settings/UsersManagement';
import { PermissionManagement } from './features/settings/PermissionManagement';
const ApprovalWorkflowCenter = React.lazy(() =>
  import('./features/settings/ApprovalWorkflowCenter').then((m) => ({ default: m.ApprovalWorkflowCenter }))
);
const HelpDocumentationLazy = React.lazy(() =>
  import('./components/common/HelpDocumentation').then((m) => ({ default: m.HelpDocumentation }))
);
import { DatabaseSetupBanner } from './components/common/DatabaseSetupBanner';
import { BootstrapBlockedBanner } from './components/common/BootstrapBlockedBanner';
import { setCurrencyConfig } from './utils/nprFormat';
import { setDefaultTaxRate } from './utils/taxConfig';
import { setProductGroups } from './utils/productGroupBehavior';
import { useDarkMode } from './contexts/DarkModeContext';
import { useSession } from './contexts/SessionContext';
import { useScope } from './contexts/ScopeContext';
import { useDialog } from './components/common/DialogProvider';
import { AppRoutes, screenRoute, type AppRoute } from './routes/appRoutes';
import { isTabAccessible } from './routes/tabPermissions';
import { broadcastBsCalendarUpdated } from './utils/bsCalendarRefresh';
import { Loader2 } from 'lucide-react';

/** Suspense fallback matching the boot-loading spinner (used by all lazy tabs). */
function TabLoadingFallback() {
  return (
    <div className="flex flex-col items-center justify-center h-64 space-y-3">
      <Loader2 className="h-8 w-8 text-indigo-500 animate-spin" />
      <p className="text-xs font-semibold text-slate-400">Loading module…</p>
    </div>
  );
}
import {
  beginSliceLoad,
  dismissSliceErrors,
  failedSliceKeys,
  isAnySliceLoading,
  markSliceError,
  markSlicesReady,
  settleSliceDiscarded,
  sliceScopeKey,
  visibleSliceErrors,
  SliceRequestGate,
  type BootstrapSliceState,
} from './services/bootstrapSlices';
import { BootstrapSliceNotice } from './components/common/BootstrapSliceNotice';
import { LoadStateNotice } from './components/common/LoadStateNotice';
import { applyServerMatrix, getPermissionsMatrix } from './utils/permissions';
import { setExportCompanyProfile } from './utils/exportUtils';

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
  const { alert: alertDialog } = useDialog();
  // A3: session and scope values are owned by their providers (contexts/
  // SessionContext.tsx and ScopeContext.tsx), so the root reads them instead
  // of holding the state that every route refactor had to thread through.
  const {
    currentUser,
    setCurrentUser,
    rootUser,
    setRootUser,
    permissionsMatrix,
    setPermissionsMatrix,
    appSettings,
    setAppSettings,
    dateMode,
    setDateMode,
  } = useSession();
  const {
    selectedBranchId,
    setSelectedBranchId,
    selectedFiscalYearId,
    setSelectedFiscalYearId,
    fiscalYears,
    setFiscalYears,
  } = useScope();

  const [activeTab, setActiveTab] = useState<NavTab>(() => {
    const savedTab = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    // Only restore the saved tab if it is still a valid menu id (guards against removed/renamed tabs)
    return savedTab && (NAV_TABS as string[]).includes(savedTab) ? (savedTab as NavTab) : 'dashboard';
  });
  // Server-backed user preferences. `prefsHydratedRef` gates every write so a
  // default rendered during start-up can never overwrite the real saved
  // preference, and `persistedPrefsRef` de-duplicates writes against the last
  // value the server returned.
  const prefsHydratedRef = useRef(false);
  const persistedPrefsRef = useRef<Record<string, string>>({});

  // Patches one preference on the server (PATCH semantics: only this key).
  const persistPreference = (key: 'theme' | 'dateMode' | 'activeTab', value: string) => {
    if (!prefsHydratedRef.current) return;
    if (persistedPrefsRef.current[key] === value) return;
    persistedPrefsRef.current[key] = value;
    void api.savePreferences({ [key]: value }).catch((err) => {
      // Let a later change retry this key.
      delete persistedPrefsRef.current[key];
      console.error('Failed to save user preference:', err);
    });
  };

  // Toggles the global date display between Bikram Sambat (BS) and AD.
  // Persisted server-side (user_preferences.dateMode) so the choice follows
  // the user to any machine; localStorage keeps only a first-paint mirror.
  const handleToggleDateMode = () => {
    setDateMode((prev) => {
      const next = prev === 'BS' ? 'AD' : 'BS';
      localStorage.setItem('inventory_date_mode', next);
      persistPreference('dateMode', next);
      return next;
    });
  };

  // Centralized navigation access control. The permission table and the rule
  // live in routes/tabPermissions.ts, which the route registry reads too, so a
  // tab's declaration and its permission cannot drift apart (A4).
  const canAccessTab = (tab: NavTab): boolean => isTabAccessible(tab, currentUser);

  // Bumped once the server-seeded calendar lands in the client mirror, so the
  // coverage memo below recomputes against the authoritative data instead of
  // the bundled defaults.
  const [bsCalendarSyncVersion, setBsCalendarSyncVersion] = useState(0);

  // BS calendar coverage — how long the seeded Nepali calendar lasts. Only the
  // roles that can seed it (Super Admin on the BS Calendar Utility, Head Office
  // Admin on Nepali Fiscal Management) get the countdown, because a warning
  // nobody can act on is just noise.
  const canManageBsCalendar = canAccessTab('bs-calendar') || canAccessTab('nepali-fiscal');
  // Which screen actually seeds for this user: the BS Calendar Utility is
  // Super-Admin-only in the sidebar, while Nepali Fiscal Management carries the
  // same seeder and is the one a Head Office Admin can reach by navigation.
  const bsCalendarSeedTab: NavTab = currentUser?.role === 'SUPER_ADMIN' ? 'bs-calendar' : 'nepali-fiscal';
  const bsCalendarCoverage: BsCalendarCoverageStatus | null = React.useMemo(
    () => (canManageBsCalendar ? getBsCalendarCoverage() : null),
    [canManageBsCalendar, bsCalendarSyncVersion]
  );

  const [searchQuery, setSearchQuery] = useState<string>('');

  const [loading, setLoading] = useState<boolean>(true);
  const [permissionsVersion, setPermissionsVersion] = useState<number>(0);
  /** One-line context shown on the login screen (e.g. the session was ended by
   *  a demo-data clear because the signed-in account was demo data). */
  const [loginNotice, setLoginNotice] = useState<string | null>(null);

  // Synchronize permissions live across components
  useEffect(() => {
    setUserContext(currentUser);
  }, [currentUser]);

  // The directory pickers search with the shell's branch rather than a prop
  // (VOL-4a). Mirror the scope into the request layer so a branch account
  // always names a branch the server guard accepts.
  useEffect(() => {
    setActiveBranchContext(selectedBranchId);
  }, [selectedBranchId]);

  // Force logout when token expires (401 from any API call)
  useEffect(() => {
    const handleAuthExpired = (e: Event) => {
      const customEvent = e as CustomEvent<{ message: string }>;
      console.warn('Session expired:', customEvent.detail?.message);
      handleLogout();
    };
    window.addEventListener('inventory_auth_expired', handleAuthExpired);
    return () => window.removeEventListener('inventory_auth_expired', handleAuthExpired);
  }, []);

  // Tab-navigation requests from non-React surfaces (the API-failure toast's
  // "Open BS Calendar Utility" button). Read through a ref so the listener can
  // stay subscription-stable while always seeing the current permissions, and
  // validate the target: a toast must never land a user on a screen their role
  // cannot open.
  const canAccessTabRef = React.useRef(canAccessTab);
  canAccessTabRef.current = canAccessTab;
  useEffect(() => {
    const handleNavigateTab = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: string }>).detail?.tab;
      if (!tab || !canAccessTabRef.current(tab as NavTab)) return;
      setActiveTab(tab as NavTab);
    };
    window.addEventListener(NAVIGATE_TAB_EVENT, handleNavigateTab);
    return () => window.removeEventListener(NAVIGATE_TAB_EVENT, handleNavigateTab);
  }, []);

  useEffect(() => {
    setFiscalYearContext(selectedFiscalYearId || null);
  }, [selectedFiscalYearId]);

  // One-time purge of the browser-storage copies this build replaced with
  // server-backed storage. Older builds kept a permission matrix, the
  // company-wide blind-count flag and a BS-calendar snapshot in localStorage;
  // all three are now PostgreSQL tables, so anything still sitting in the
  // browser is stale dead weight — for the matrix, a tamperable copy of
  // server data — and is removed on start-up.
  useEffect(() => {
    try {
      [
        'inventory_permissions_matrix',
        'inventory_company_wide_blind_count',
        'inventory_bs_calendar_data',
      ].forEach((key) => localStorage.removeItem(key));
    } catch {
      // Storage unavailable (private mode / disabled): nothing to purge.
    }
  }, []);

  useEffect(() => {
    // Mirror for the next first-paint only — the authority is the server-side
    // activeTab preference hydrated by hydrateUserPreferences().
    localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, activeTab);
    persistPreference('activeTab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    const handlePermissionsUpdated = () => {
      // The matrix is server data: re-read it from the module cache that only
      // applyServerMatrix() (bootstrap / successful PUT) is allowed to fill.
      setPermissionsMatrix(getPermissionsMatrix());
      setPermissionsVersion((v) => v + 1);
    };
    window.addEventListener('inventory_permissions_updated', handlePermissionsUpdated);
    return () => window.removeEventListener('inventory_permissions_updated', handlePermissionsUpdated);
  }, []);

  // Theme: managed by DarkModeContext (adds/removes `dark` class on <html>)
  const { isDarkMode, toggleTheme: handleToggleTheme, applyServerTheme } = useDarkMode();

  // Persist theme changes server-side (DarkModeContext's localStorage copy is
  // only a first-paint mirror).
  useEffect(() => {
    persistPreference('theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  // One-shot hydration of the server-held user preferences. The FIRST
  // bootstrap wins: later refreshes must never yank the tab, theme or date
  // mode out from under a user who changed them during this session.
  const hydrateUserPreferences = (prefs?: Record<string, string>) => {
    if (prefsHydratedRef.current) return;
    prefsHydratedRef.current = true;
    persistedPrefsRef.current = { ...(prefs || {}) };
    if (prefs?.dateMode === 'BS' || prefs?.dateMode === 'AD') setDateMode(prefs.dateMode);
    if (prefs?.activeTab && (NAV_TABS as string[]).includes(prefs.activeTab)) {
      setActiveTab(prefs.activeTab as NavTab);
    }
    if (prefs?.theme === 'dark' || prefs?.theme === 'light') applyServerTheme(prefs.theme === 'dark');
  };

  /**
   * Cached-payload settings backfill (DF-17). A payload cached before the
   * settings slices shipped falls back to GET /api/settings; a failure used to
   * be dropped, leaving the app on `{}` defaults (e.g. the company-wide blind
   * count read as false) with nothing saying the configuration was unknown.
   */
  const loadSettingsFromServer = async () => {
    setSettingsBackfillLoading(true);
    try {
      const bundle = await api.getSettings();
      setAppSettings(bundle.appSettings || {});
      hydrateUserPreferences(bundle.preferences);
      setSettingsBackfillError('');
    } catch (err: any) {
      setSettingsBackfillError(err?.message || 'The company settings could not be read.');
    } finally {
      setSettingsBackfillLoading(false);
    }
  };

  // Sellable-serial list for the Sell-to-Customer serial gate (DF-17). The
  // rows are branch-scoped: on a branch change the old list is cleared at
  // once, and a failure is reported (the form offers a Retry) instead of
  // keeping the previous branch's units, which the server would refuse.
  const sellableSerialsSeqRef = useRef(0);
  const sellableSerialsScopeRef = useRef<string | null>(null);
  const loadSellableSerials = async (branchId?: string) => {
    const scope = branchId && branchId !== 'ALL' ? branchId : 'ALL';
    const seq = ++sellableSerialsSeqRef.current;
    if (sellableSerialsScopeRef.current !== scope) {
      sellableSerialsScopeRef.current = scope;
      setInventorySerials([]);
    }
    setSellableSerialsLoading(true);
    setSellableSerialsError('');
    try {
      const sellable = await api.getSerialLogs({
        branchId: scope === 'ALL' ? undefined : scope,
        status: 'IN_STOCK',
      });
      if (seq !== sellableSerialsSeqRef.current) return;
      setInventorySerials(Array.isArray(sellable) ? sellable : (sellable as any)?.data || []);
    } catch (err: any) {
      if (seq !== sellableSerialsSeqRef.current) return;
      setSellableSerialsError(err?.message || 'The sellable serial list could not be read.');
    } finally {
      if (seq === sellableSerialsSeqRef.current) setSellableSerialsLoading(false);
    }
  };

  // Writes a company-wide setting to the server (app_settings table) and
  // reverts the local mirror if the server rejects it (e.g. the toggle is
  // SUPER_ADMIN-only server-side).
  const handleAppSettingChange = (key: string, value: string) => {
    const previous = appSettings[key];
    setAppSettings((prev) => ({ ...prev, [key]: value }));
    void api.saveAppSettings({ [key]: value }).catch((err) => {
      setAppSettings((prev) => {
        const next = { ...prev };
        if (previous === undefined) delete next[key];
        else next[key] = previous;
        return next;
      });
      console.error('Failed to save application setting:', err);
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
  // Sellable (IN_STOCK) serials for the Sell to Customer form's serial gate.
  // serial_log is a paged ledger and was deliberately dropped from bootstrap,
  // so this is one narrow status-filtered fetch per refresh instead of the
  // whole register (StockOperations hosts its own mount-once copy).
  const [inventorySerials, setInventorySerials] = useState<SerialLog[]>([]);
  // DF-17: surfaced failures for the two App-owned reads whose errors used to
  // be console-only — the cached-payload settings backfill and the
  // sellable-serial list. Both have a Retry; the sellable list also clears on
  // a branch change so the Sell-to-Customer form never sees another branch's
  // units.
  const [sellableSerialsError, setSellableSerialsError] = useState('');
  const [sellableSerialsLoading, setSellableSerialsLoading] = useState(false);
  const [settingsBackfillError, setSettingsBackfillError] = useState('');
  const [settingsBackfillLoading, setSettingsBackfillLoading] = useState(false);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [purchaseInvoices, setPurchaseInvoices] = useState<PurchaseInvoice[]>([]);
  const [purchaseReturns, setPurchaseReturns] = useState<PurchaseReturn[]>([]);
  const [salesReturns, setSalesReturns] = useState<SalesReturn[]>([]);
  // VOL-3: shipments left the bootstrap payload. The shell, dashboard KPI,
  // notification center and receive lanes share one bounded scoped snapshot
  // (exact counts + every in-flight row + a recent window); the transfer
  // register pages its own reads through GET /api/shipments/page.
  const shipmentOverview = useShipmentOverview(selectedBranchId);
  const shipments = React.useMemo(
    () => mergeShipmentWindow(shipmentOverview.pending, shipmentOverview.recent),
    [shipmentOverview.pending, shipmentOverview.recent]
  );
  const [stockOperations, setStockOperations] = useState<StockOperation[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [damageRecords, setDamageRecords] = useState<DamageRecord[]>([]);
  const [locations, setLocations] = useState<LocationRecord[]>([]);
  const [financialSummary, setFinancialSummary] = useState<FinancialSummary>({
    totalInventoryAssetValue: 0,
    totalFixedAssetValue: 0,
    totalAccountsPayable: 0,
    totalSalesRevenue: 0,
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

  const selectedFiscalYear = fiscalYears.find((fiscalYear) => fiscalYear.id === selectedFiscalYearId);

  // Scoped read for the procurement KPI surfaces (shell badges, dashboard
  // tile, notification alerts and the vendor-bill PO picker): open POs and
  // the unpaid bill count for the header branch + selected fiscal year, not
  // the whole deferred purchase slices. The store is imported dynamically so
  // its cache/retry code stays out of the startup chunk — the badges load
  // right after first paint instead of growing the main bundle.
  const [procurementPending, setProcurementPending] = useState<{
    pendingPurchaseOrders: PurchaseOrder[];
    unpaidInvoiceCount: number;
    loading: boolean;
    error: string;
  }>({ pendingPurchaseOrders: [], unpaidInvoiceCount: 0, loading: false, error: '' });
  const invalidateProcurementPending = () => {
    void import('./services/procurementPendingCache').then((mod) => mod.invalidateProcurementPending());
  };
  const resetProcurementPending = () => {
    void import('./services/procurementPendingCache').then((mod) => mod.resetProcurementPending());
  };

  useEffect(() => {
    if (!selectedFiscalYear?.startDateAD || !selectedFiscalYear?.endDateAD) return;
    // The store is loaded asynchronously; clear the old branch/FY's counts
    // immediately so a switch never shows the previous view's KPIs.
    setProcurementPending({ pendingPurchaseOrders: [], unpaidInvoiceCount: 0, loading: false, error: '' });
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void import('./services/procurementPendingCache').then((mod) => {
      if (cancelled) return;
      const publish = () => {
        const snapshot = mod.procurementPendingStore.getSnapshot();
        setProcurementPending({
          pendingPurchaseOrders: snapshot.pendingPurchaseOrders,
          unpaidInvoiceCount: snapshot.unpaidInvoiceCount,
          loading: snapshot.loading,
          error: snapshot.error,
        });
      };
      unsubscribe = mod.procurementPendingStore.subscribe(publish);
      mod.procurementPendingStore.ensureLoaded({
        branchId: selectedBranchId,
        fiscalYearStartAD: selectedFiscalYear.startDateAD,
        fiscalYearEndAD: selectedFiscalYear.endDateAD,
      });
      publish();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [
    selectedBranchId,
    selectedFiscalYear?.id,
    selectedFiscalYear?.startDateAD,
    selectedFiscalYear?.endDateAD,
  ]);

  // Set when the server REFUSED the bootstrap payload (see the catch in
  // refreshAllData): the API's own reason and status, shown verbatim so a
  // configuration problem is not retold as "PostgreSQL Offline" by
  // DatabaseSetupBanner — which infers reachability from the very payload the
  // refusal blocked. Null while the last load succeeded, so fixing the cause
  // and retrying clears it without a reload.
  const [bootstrapBlocked, setBootstrapBlocked] = useState<{
    message: string;
    status?: number;
    /** Machine-readable cause from the server's body (see http.ts): a refused
     *  bootstrap can name the screen that fixes it instead of only describing it. */
    noCurrentFiscalYear?: boolean;
  } | null>(null);

  // C1/C2 hydration bookkeeping: the per-slice status table and the request
  // gate that stamps every slice fetch with its view (branch|FY) and sequence.
  const [sliceState, setSliceState] = useState<BootstrapSliceState>({});
  const sliceGateRef = useRef(new SliceRequestGate());

  // Hydrate state from recent cache for instant 0ms load speed.
  //
  // C1: a payload proves only what it CARRIED -- a full bootstrap marks ready the
  // keys it contains (the three deferred ledgers are not in it, so their error
  // state survives until their own fetch succeeds), while the instant cache
  // pre-hydration passes `fromCache` and marks nothing: a snapshot is display
  // data, never proof of freshness. C2: the payload's version is recorded per
  // key too, so a targeted slice request that started before this payload and
  // returns after it cannot overwrite newer rows.
  const applyBootstrapData = (
    data: any,
    options: { fromCache?: boolean; dataVersion?: number } = {}
  ) => {
    if (data.branches) setBranches(data.branches);
    if (data.products) setProducts(data.products);
    if (data.stock) setStock(data.stock);
    if (data.purchaseOrders) setPurchaseOrders(data.purchaseOrders);
    if (data.purchaseInvoices) setPurchaseInvoices(data.purchaseInvoices);
    if (data.purchaseReturns) setPurchaseReturns(data.purchaseReturns);
    if (data.salesReturns) setSalesReturns(data.salesReturns);
    if (data.stockOperations) setStockOperations(data.stockOperations);
    if (data.fiscalYears) setFiscalYears(data.fiscalYears);
    if (data.auditLogs) setAuditLogs(data.auditLogs);
    if (data.damageRecords) setDamageRecords(data.damageRecords);
    if (data.locations) setLocations(data.locations);
    if (data.financialSummary) setFinancialSummary(data.financialSummary);
    if (data.suppliers) setSuppliers(data.suppliers);
    if (data.users) setUsers(data.users as User[]);
    if (data.approvalRequests) setApprovalRequests(data.approvalRequests);
    if (data.categories) setCategories(data.categories);
    // Product groups ride the login payload: the name → behaviour lookup must
    // be authoritative before any sales/asset screen paints, so it is applied
    // here rather than fetched lazily by each consumer.
    if (data.productGroups) setProductGroups(data.productGroups);
    if (data.companyProfile) {
      setCompanyProfile(data.companyProfile);
      applyCurrencyConfig(data.companyProfile);
    }
    if (data.postgresDatabaseStatus) setPostgresStatus(data.postgresDatabaseStatus);
    if (data.permissionsMatrix) {
      applyServerMatrix(data.permissionsMatrix);
      setPermissionsMatrix(data.permissionsMatrix);
    }
    if (data.appSettings) setAppSettings(data.appSettings);
    hydrateUserPreferences(data.userPreferences);
    // Backfill for payloads cached before the settings slices shipped (or a
    // partially-applied cache entry): fall back to the dedicated endpoint so
    // the app still reads its configuration from the server, never storage.
    // A failure is now reported with a Retry (DF-17), not swallowed.
    if (!data.appSettings || !data.userPreferences) {
      void loadSettingsFromServer();
    } else if (settingsBackfillError) {
      setSettingsBackfillError('');
    }
    if (!options.fromCache) {
      const keys = Object.keys(data).filter(
        (key) => key !== 'dataVersion' && key !== 'serverTime' && key !== 'postgresDatabaseStatus'
      );
      setSliceState((prev) => markSlicesReady(prev, keys, options.dataVersion));
      sliceGateRef.current.noteApplied(keys, options.dataVersion);
    }
  };

  // Apply the active currency configuration from the company profile so every
  // formatMoney/formatNPR call site renders in the configured currency.
  // Deferred ledger hydration (bootstrap trim): the three big ledgers no
  // longer ship in the bootstrap payload — stockOperations, purchaseOrders
  // and purchaseInvoices are fetched as dedicated slices from
  // GET /api/bootstrap/local right after every full bootstrap (the same
  // endpoint the SSE targeted refresh uses), so wholesale consumers — the
  // dashboard/notification KPIs, the FY closing wizard, the PI PO dropdown,
  // the movement ledger, StockOperations' panels and global search — keep
  // their data with identical freshness while first paint gets a lighter
  // payload. The self-fetching registers don't need these slices at all.
  const DEFERRED_BOOTSTRAP_SLICES = ['stockOperations', 'purchaseOrders', 'purchaseInvoices'];
  /**
   * One loader for both hydration paths (C1): the deferred ledgers below and the
   * SSE targeted refresh both report through here, so a failure behaves
   * identically wherever the refetch came from. Before any payload paints, the
   * C2 gate decides whether it still belongs to the current view and whether it
   * is older than what that key already shows.
   */
  const fetchBootstrapSlice = async (key: string, branchId?: string, fiscalYearId?: string) => {
    const currentScope = () =>
      sliceScopeKey(syncScopeRef.current.branchId, syncScopeRef.current.fiscalYearId);
    const request = sliceGateRef.current.begin(key, sliceScopeKey(branchId, fiscalYearId));
    setSliceState((prev) => beginSliceLoad(prev, key));
    try {
      const res = await api.getLocalFor(key, branchId, fiscalYearId);
      const verdict = sliceGateRef.current.decide(request, currentScope(), res.dataVersion);
      if (verdict === 'superseded') return; // a newer request owns this key's status
      if (verdict !== 'apply') {
        // The user left this view, or the response is older than the rows on
        // screen: discard it, but settle the `loading` flag it set.
        setSliceState((prev) => settleSliceDiscarded(prev, key));
        return;
      }
      if (res.slice !== undefined) {
        applyBootstrapData({ [key]: res.slice });
        setSliceState((prev) => markSlicesReady(prev, [key], res.dataVersion));
        if (typeof res.dataVersion === 'number') serverDataVersionRef.current = res.dataVersion;
      } else {
        // The server does not serve this key: nothing was proven, nothing failed.
        setSliceState((prev) => settleSliceDiscarded(prev, key));
      }
    } catch (err: any) {
      const verdict = sliceGateRef.current.decide(request, currentScope());
      if (verdict === 'superseded') return;
      if (verdict !== 'apply') {
        // A failure from a view the user already left is not news about the
        // current view: settle it and never raise the notice.
        setSliceState((prev) => settleSliceDiscarded(prev, key));
        return;
      }
      setSliceState((prev) =>
        markSliceError(prev, key, err?.message || 'Could not refresh this data.')
      );
    }
  };

  const hydrateDeferredSlices = (branchId?: string, fiscalYearId?: string) => {
    Promise.all(
      DEFERRED_BOOTSTRAP_SLICES.map((key) => fetchBootstrapSlice(key, branchId, fiscalYearId))
    ).catch(() => undefined);
  };

  // One Retry for every failed slice, for the CURRENT branch/FY (never a stale
  // captured scope).
  const retryFailedSlices = () => {
    const { branchId, fiscalYearId } = syncScopeRef.current;
    for (const key of failedSliceKeys(sliceState)) {
      void fetchBootstrapSlice(key, branchId, fiscalYearId);
    }
  };

  const applyCurrencyConfig = (profile: CompanyProfile) => {
    setCurrencyConfig({
      code: profile.currencyCode || profile.currencySymbol || 'NPR',
      symbol: profile.currencySymbol || 'NPR',
      locale: profile.currencyLocale || 'en-IN',
      position: profile.currencyPosition || 'before',
      decimals: profile.currencyDecimals ?? 2,
    });
    // The VAT default is company configuration too: forms and "% VAT" labels
    // read it from here instead of hard-coding 13.
    setDefaultTaxRate(profile.defaultTaxRate);
  };

  // Keep the CSV/Excel exporter's app-wide company identity in sync so every
  // export metadata header embeds the configured Company Profile.
  useEffect(() => {
    setExportCompanyProfile(companyProfile);
  }, [companyProfile]);

  // Instant pre-hydration from recent cache (scoped per user+branch+FY, TTL-guarded)
  const cacheScopeRef = useRef<{ userId?: string; branchId?: string; fiscalYearId?: string }>({
    userId: currentUser?.id || rootUser?.id,
    branchId: selectedBranchId,
    fiscalYearId: selectedFiscalYearId || undefined,
  });
  const serverDataVersionRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const cached = loadRecentBootstrapCache(cacheScopeRef.current, {
      // Only trust snapshots saved within the last 2 minutes. Older snapshots
      // are ignored so the UI never flashes stale operational data.
      maxAgeMs: BOOTSTRAP_CACHE_MAX_AGE_MS,
      // If the SSE stream already reported a server dataVersion newer than the
      // cache's, do not hydrate from it.
      mustHaveDataVersion: serverDataVersionRef.current,
    });
    if (cached) {
      applyBootstrapData(cached, { fromCache: true });
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
    // A full refresh must also cover the self-fetching paged
    // registers (Serial Log, Purchase Orders, Purchase Invoices,
    // consumable register): the bootstrap slices don't include
    // their server-paged data, so bump every counter to re-run
    // their current paged fetch. Done before the fetch so the
    // registers refresh even if the bootstrap call fails.
    setRegisterRefresh(bumpAllRegisterRefresh);
    // The shared serial-register cache is the other self-fetching surface:
    // a manual refresh must re-read it too, or the stock gates keep their
    // pre-refresh availability snapshot.
    invalidateSerialRegister();
    // Stock-operation forms read every selectable branch's rows through
    // GET /api/stock; a refresh must re-read those too. This also covers a
    // fiscal-year switch, where the bootstrap stock becomes that year's
    // opening snapshot.
    invalidateBranchStock();
    // The exchange tab's deployed-device list is another self-fetching cache;
    // a manual refresh must re-read it too (DF-16).
    invalidateExchangeDevices();
    // ASSET-1: the deployment picker's assignable assets are their own bounded
    // shared read; a manual refresh re-reads them with everything else.
    invalidateAvailableFixedAssets();
    // The KPI surfaces read the scoped pending-procurement cache rather than
    // the purchase slices, so a manual refresh re-reads it too.
    invalidateProcurementPending();
    // Shipments are a separate bounded read now (VOL-3); a full refresh must
    // re-read the overview alongside the bootstrap slices.
    invalidateShipmentOverview();
    try {
      const data = await api.getBootstrapState(requestBranchId, requestFiscalYearId || undefined);
      // Discard stale results if the user switched branch/fiscal year in the meantime
      if (requestSeq !== refreshSequenceRef.current) return;
      if (data) {
        applyBootstrapData(data, { dataVersion: data.dataVersion });
        // The refusal is cleared only by a payload that actually arrived.
        setBootstrapBlocked(null);
        // The three ledgers trimmed from the payload load in parallel with
        // the sellable-serials fetch below — see hydrateDeferredSlices.
        hydrateDeferredSlices(requestBranchId, requestFiscalYearId || undefined);
        if (data.dataVersion) serverDataVersionRef.current = data.dataVersion;
        if (!requestFiscalYearId && data.fiscalYears?.length) {
          const defaultFy = resolveDefaultFiscalYear(data.fiscalYears);
          if (defaultFy) setSelectedFiscalYearId(defaultFy.id);
        }
        // Scope the cache snapshot to the exact user + branch + FY view so a
        // switch of any of those never leaks another view's data.
        cacheScopeRef.current = {
          userId: currentUser?.id || rootUser?.id,
          branchId: requestBranchId,
          fiscalYearId: requestFiscalYearId || undefined,
        };
        saveRecentBootstrapCache(data, cacheScopeRef.current);
        // Sell to Customer can only post serials that exist in inventory, so
        // the form needs the sellable rows before the user starts typing.
        // Nested so a serial-log hiccup never looks like a bootstrap failure;
        // the list loader owns its own sequence guard, branch clearing and
        // retryable failure state (DF-17).
        void loadSellableSerials(requestBranchId);
      }
    } catch (err: any) {
      console.error('Error fetching data from backend:', err);
      // Ignore a refusal that belongs to a view the user has already left. The
      // server's message is shown as-is: re-wording it here is how the cause
      // gets lost (a 409 "no fiscal year is flagged current" became "PostgreSQL
      // Offline" on screen while the database was up the whole time).
      if (requestSeq === refreshSequenceRef.current) {
        const status = typeof err?.status === 'number' ? err.status : undefined;
        // 401 belongs to the expired-session flow (http.ts dispatches
        // inventory_auth_expired for it), including the bootstrap attempt the
        // login screen makes with no token — not a data-load failure to report.
        if (status !== 401) {
          setBootstrapBlocked({
            message: err?.message || 'The server could not load application data.',
            status,
            noCurrentFiscalYear: err?.body?.noCurrentFiscalYear === true,
          });
        }
        // A structured 4xx came FROM the application, so PostgreSQL is
        // reachable and the setup banner must stop claiming otherwise. A 503
        // is the opposite case and keeps it: that one really is the database.
        if (status === 400 || status === 409) {
          setPostgresStatus((prev) => (prev.isConnected ? prev : { ...prev, isConnected: true }));
        }
        // DF-17 residual (close-out review): the successful path loads the
        // sellable serials after the payload applies, so a FAILED bootstrap on
        // a branch switch would skip that call and leave the previous branch's
        // units in the Sell-to-Customer form. Re-read the new scope here: the
        // loader clears the old rows first, then either fills them from the
        // server or reports its own retryable failure.
        const sellableScope =
          requestBranchId && requestBranchId !== 'ALL' ? requestBranchId : 'ALL';
        // Only when a previous scope's rows could still be on screen: a failed
        // first load has nothing to clear and must not add a second notice.
        if (
          status !== 401 &&
          sellableSerialsScopeRef.current !== null &&
          sellableSerialsScopeRef.current !== sellableScope
        ) {
          void loadSellableSerials(requestBranchId);
        }
      }
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

  // Always-fresh logout closure for stable listeners: the SSE effect's
  // multi-tab relay (#6) calls this when a sibling tab broadcasts LOGOUT,
  // and handleLogout below broadcasts this tab's sign-out to the others.
  const handleLogoutRef = useRef<() => void>(() => {});

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
  //
  // Held in a ref so the SSE handler below can re-run it when the server
  // broadcasts a calendar change: it used to happen ONLY on mount, so a tab left
  // open kept a stale mirror after another admin seeded or repaired a year and
  // could block dates the server would have accepted.
  const syncBsCalendarMirrorRef = React.useRef<() => Promise<void>>(async () => undefined);
  syncBsCalendarMirrorRef.current = async () => {
    try {
      const years = await api.getBsCalendarYears();
      if (!Array.isArray(years)) return;
      for (const y of years) {
        if (y && y.yearBS && Array.isArray(y.daysInMonths) && y.daysInMonths.length === 12 && y.startAD) {
          seedBSYearCalendar(y.yearBS, y.daysInMonths, y.startAD, {
            startAdSource: y.startAdSource,
            isProvisional: y.isProvisional,
          });
        }
      }
      // The mirror now reflects the server, so the coverage countdown must be
      // re-derived from it (the memo above holds the pre-sync value).
      setBsCalendarSyncVersion((v) => v + 1);
    } catch (err) {
      console.error('Failed to sync BS calendar years from server:', err);
    }
  };

  useEffect(() => {
    syncBsCalendarMirrorRef.current();
  }, []);

  // ---------------------------------------------------------------------------
  // Targeted real-time refresh: map SSE event domains to the single bootstrap
  // slice they invalidate. A mutation anywhere used to trigger a full app-wide
  // re-bootstrap; now a known domain re-fetches ONLY its slice (one small
  // query), and anything unrecognized falls back to the full bootstrap so
  // unknown server events can never leave the UI stale.
  // ---------------------------------------------------------------------------
  const DOMAIN_STATE_KEYS: Record<string, string[]> = {
    // financialSummary is computed server-side from every domain below, so
    // each mutation that moves inventory value, AP, VAT, damage or trading
    // totals re-fetches the one aggregate slice (DF-05) instead of waiting
    // for the next full bootstrap.
    STOCK: ['stock', 'damageRecords', 'financialSummary'],
    STOCK_OPERATIONS: ['stockOperations', 'stock', 'damageRecords', 'financialSummary'],
    // Serial edits can rewrite customer_device_records.device_serial (the edit
    // capture mirrors into the CPE table), so that paged register re-reads via
    // its counter rather than a bootstrap slice (VOL-4b).
    SERIALS: [],
    // PROCUREMENT also covers purchase returns: posting one deducts
    // stock, writes transaction-log rows and flips serial_log rows.
    PROCUREMENT: ['purchaseOrders', 'purchaseInvoices', 'suppliers', 'purchaseReturns', 'stock', 'financialSummary'],
    // Sales mutations deduct/restock stock, write transaction-log rows,
    // route non-restockable returns into the damage register and flip
    // serial_log rows (paged — covered by the register mapping below).
    SALES: ['salesReturns', 'stock', 'damageRecords', 'financialSummary'],
    // A receipt credits the destination's stock, flips serial_log rows (paged
    // register mapping below) and writes TRANSFER_IN transaction_log rows, so
    // the Stock Movement Ledger must re-read along with the transfer register.
    // Shipments themselves are no longer a bootstrap slice (VOL-3): the SSE
    // handler refreshes the bounded shipment overview explicitly below.
    SHIPMENTS: ['stock', 'financialSummary'],
    // VOL-4a: customers is no longer a bootstrap slice — the directory pages and
    // the pickers search GET /api/customers directly, so a MASTER_DATA burst has
    // no customer array to refresh.
    // VOL-4b: customer devices are no longer a bootstrap slice either — the
    // register pages and the warranty directory reads its own union, so the
    // MASTER_DATA burst has no device array to refresh.
    MASTER_DATA: ['branches', 'suppliers', 'locations', 'companyProfile', 'productGroups'],
    CATEGORIES: ['categories'],
    PRODUCTS: ['products', 'stock'],
    FISCAL: ['fiscalYears', 'financialSummary'],
    USERS: ['users'],
    // The device register re-reads through registerRefresh.customerDevices
    // (DOMAIN_REGISTER_KEYS); stock still moves on an assignment/exchange.
    CUSTOMER_DEVICES: ['stock'],
    // ASSET-1: fixed assets left the bootstrap — every asset consumer re-reads
    // through registerRefresh.fixedAssets (DOMAIN_REGISTER_KEYS).
    ASSETS: [],
    APPROVALS: ['approvalRequests'],
    // The admin recalculation jobs rebuild live stock and fixed assets, and the
    // ledger backfill rewrites transaction_logs' before/after balances — the
    // movement ledger must re-read or it keeps the placeholders it had at mount.
    RECALC: ['stock', 'financialSummary'],
    COMPANY_PROFILE: ['companyProfile'],
    AUDIT: ['auditLogs'],
    // Sync-audit improvements #2/#3: first-class slice domains so the
    // saved permission matrix, company-wide settings and the live audit
    // trail re-fetch ONLY their own slice instead of full bootstrapping.
    PERMISSIONS: ['permissionsMatrix'],
    SETTINGS: ['appSettings'],
    // BS_CALENDAR has no bootstrap slice — its data is GET /api/bs-calendar/years,
    // refreshed explicitly in the handler below. It is listed so a calendar event
    // counts as a KNOWN domain (an unknown one forces a full bootstrap).
    BS_CALENDAR: [],
  };

  // Paged-register refresh counters, bumped by the SSE handler below.
  // The domain → register mapping lives in utils/registerRefreshDomains
  // (imported above, shared with the tests so the wiring stays pinned).
  const [registerRefresh, setRegisterRefresh] = useState<Record<RegisterRefreshKey, number>>({
    serialLog: 0,
    purchaseOrders: 0,
    purchaseInvoices: 0,
    consumableRegister: 0,
    returnsRegister: 0,
    salesInvoices: 0,
    shipments: 0,
    customerDevices: 0,
    fixedAssets: 0,
    transactionLog: 0,
  });

  // Always-fresh scope for the SSE listener below (it must not re-subscribe
  // — and capture stale values — when only the fiscal year changes).
  const syncScopeRef = useRef({ branchId: selectedBranchId, fiscalYearId: selectedFiscalYearId || undefined });
  useEffect(() => {
    syncScopeRef.current = { branchId: selectedBranchId, fiscalYearId: selectedFiscalYearId || undefined };
  }, [selectedBranchId, selectedFiscalYearId]);

  // Real-time synchronization stream: listen for background changes from
  // any user/branch. Reliability net (sync-audit improvements #1/#5):
  //  - while the stream is down, poll /api/sync/version on an interval and
  //    refresh everything once reconnected if the server moved on, and
  //  - on reconnect (CONNECTED), refresh when the server's dataVersion is
  //    newer than the last one this tab applied — mutations that happened
  //    during the gap are never silently missed.
  useEffect(() => {
    let debounceTimer: any = null;
    let versionPollTimer: any = null;
    // Coalesces the burst's domains across the debounce window
    // and resolves it to a targeted or full-bootstrap plan
    // (see utils/registerRefreshDomains).
    const burst = new SseDomainBurst();
    const handleSyncEvent = (event: any) => {
      // CONNECTED is the stream's handshake, not a mutation: it carries no
      // domain (observing it would force a full bootstrap) and its
      // dataVersion is a reconnect signal, handled below.
      if (event?.type === 'CONNECTED') {
        // Reconnect gap-fill (#1): a dataVersion newer than the last one
        // this tab applied means mutations happened while the stream was
        // down — re-bootstrap to catch up. On the FIRST connect after page
        // load this ref already holds the bootstrap's version (or is
        // undefined pre-bootstrap), so no redundant refresh fires.
        if (
          typeof event.dataVersion === 'number' &&
          typeof serverDataVersionRef.current === 'number' &&
          event.dataVersion > serverDataVersionRef.current
        ) {
          serverDataVersionRef.current = event.dataVersion;
          refreshAllDataRef.current();
        }
        return;
      }
      // Track the latest server dataVersion so the instant pre-hydration on
      // the next page load can refuse an outdated cached snapshot.
      if (event && typeof event.dataVersion === 'number') {
        serverDataVersionRef.current = event.dataVersion;
      }
      burst.observe(event?.domain);
      // Debounce slightly to coalesce rapid bursts
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const plan = burst.flush((d) => Boolean(DOMAIN_STATE_KEYS[d]));
        if (plan.mode === 'targeted') {
          const domains = plan.domains;
          // A calendar seed/repair changes the AD<->BS mapping every screen
          // converts with, so re-read the mirror immediately instead of waiting
          // for the next mount. RECALC covers *Rebuild BS Calendar Days*, which
          // regenerates the server's day-by-day lookup rows; the mirror is the
          // client's copy of the same authority, so it is re-read too.
          if (domains.includes('BS_CALENDAR') || domains.includes('RECALC')) {
            syncBsCalendarMirrorRef.current();
            // Gates and BS screens re-read the calendar from this signal; without
            // it they only refreshed on tab re-activation (DF-10).
            broadcastBsCalendarUpdated();
          }
          // Any serial_log writer makes the shared register snapshot stale
          // for every open stock/dispatch gate, not just the paged register.
          if (domainsTouchSerialRegister(domains)) invalidateSerialRegister();
          // The same domains are the ones that write inventory_stock (serial
          // edits aside, which cost one harmless extra read), so the
          // all-branch stock snapshots the forms validate against are stale
          // for every branch the operator could select, not just the header's.
          if (domainsTouchSerialRegister(domains)) invalidateBranchStock();
          // CPE flows and asset deployments/restocks create or close the rows
          // the Device Exchange tab lists, and that list is its own cache.
          if (domains.includes('CUSTOMER_DEVICES') || domains.includes('ASSETS')) {
            invalidateExchangeDevices();
          }
          // Asset creation/deployment and the recalculation job change which
          // units are assignable, so the picker's shared list re-reads.
          if (domains.includes('ASSETS') || domains.includes('RECALC')) {
            invalidateAvailableFixedAssets();
          }
          // Procurement and shipment events change the open-PO set and the
          // unpaid-bill total the shell/dashboard/vendor-bill picker read.
          if (domains.includes('PROCUREMENT') || domains.includes('SHIPMENTS')) {
            invalidateProcurementPending();
          }
          // Shipments are served by their own bounded overview/register reads,
          // not a bootstrap slice (VOL-3). Approval processing also moves a
          // transfer's status (cancel requests), so it counts as a writer.
          if (domains.includes('SHIPMENTS') || domains.includes('APPROVALS')) {
            invalidateShipmentOverview();
          }
          // Bump any paged registers these domains mutate so they re-fetch
          // their own current page (bootstrap slices alone don't cover them).
          setRegisterRefresh((prev) => {
            const next = { ...prev };
            let changed = false;
            for (const d of domains) {
              for (const reg of DOMAIN_REGISTER_KEYS[d] || []) {
                next[reg] = prev[reg] + 1;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
          // Targeted: re-fetch only the affected bootstrap slice(s).
          const { branchId, fiscalYearId } = syncScopeRef.current;
          Promise.all(
            domains
              .flatMap((d) => DOMAIN_STATE_KEYS[d])
              .filter((key, idx, all) => all.indexOf(key) === idx)
              .map((key) => fetchBootstrapSlice(key, branchId, fiscalYearId))
          ).catch(() => refreshAllDataRef.current());
        } else {
          // Unknown domain or mixed burst: full bootstrap (previous
          // behavior). refreshAllData bumps every paged-register
          // counter itself, so none of the self-fetching registers
          // can stay stale.
          refreshAllDataRef.current();
        }
      }, 250);
    };

    // Stream-gap polling (#1): while the SSE stream is down, poll the
    // server's dataVersion every 30s. A version newer than the last one
    // this tab applied means the UI is stale — full catch-up refresh.
    const startVersionPolling = () => {
      if (versionPollTimer || !currentUser) return;
      versionPollTimer = setInterval(async () => {
        try {
          const serverVersion = await getSyncVersion();
          if (
            typeof serverVersion === 'number' &&
            typeof serverDataVersionRef.current === 'number' &&
            serverVersion > serverDataVersionRef.current
          ) {
            serverDataVersionRef.current = serverVersion;
            refreshAllDataRef.current();
          }
        } catch (_err) {
          // Server unreachable — the SSE backoff loop will keep trying.
        }
      }, 30000);
    };
    const stopVersionPolling = () => {
      if (versionPollTimer) {
        clearInterval(versionPollTimer);
        versionPollTimer = null;
      }
    };

    // Multi-tab relay (#6): another tab may have received the event first.
    const onRelayedLogout = () => handleLogoutRef.current();
    window.addEventListener('inventory_sync_logout', onRelayedLogout);

    const unsubscribe = subscribeToSyncStream(handleSyncEvent, (connected) => {
      if (connected) stopVersionPolling();
      else if (currentUser) startVersionPolling();
    });

    return () => {
      stopVersionPolling();
      if (debounceTimer) clearTimeout(debounceTimer);
      window.removeEventListener('inventory_sync_logout', onRelayedLogout);
      unsubscribe();
    };
  }, [selectedBranchId, currentUser]);

  // React to currentUser state changes & enforce branch/tab restrictions
  useEffect(() => {
    if (currentUser) {
      if (currentUser.branchId && currentUser.branchId !== 'ALL' && currentUser.role !== 'SUPER_ADMIN') {
        setSelectedBranchId(currentUser.branchId);
      } else if (currentUser.branchId === 'ALL' || currentUser.role === 'SUPER_ADMIN') {
        // Keep or allow branch selection
      }

      // Check for restricted tabs (permission matrix + super-admin-only tabs).
      // Re-check on every tab change and after the matrix is edited/saved.
      if (!canAccessTab(activeTab)) {
        setActiveTab('dashboard');
      }
    }
  }, [currentUser, activeTab, permissionsVersion]);

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

  const handleLogout = () => {
    // Multi-tab relay (#6): sign sibling tabs out in step.
    broadcastLogoutToOtherTabs();
    setCurrentUser(null);
    setRootUser(null);
    setAuthToken(null);
    setUserContext(null);
    clearUserSession();
    clearRecentBootstrapCache();
    // Branch stock rows are cached per branch, not per user: the next sign-in
    // may be allowed fewer branches, so drop them with the session.
    resetBranchStock();
    // Same for the exchange list: it is cached per branch and shared by hosts.
    resetExchangeDevices();
    // The assignable-asset list is session-scoped too.
    resetAvailableFixedAssets();
    // Pending-PO/unpaid-bill counts are per branch + fiscal year: the next
    // sign-in may see different figures.
    resetProcurementPending();
    localStorage.removeItem(ACTIVE_TAB_STORAGE_KEY);
  };
  handleLogoutRef.current = handleLogout;

  const handleSwitchProfile = async (targetUserId: string) => {
    const nextRoot = rootUser || currentUser;
    if (!rootUser && currentUser) {
      setRootUser(currentUser);
    }
    try {
      const res = await api.switchProfile(targetUserId);
      setAuthToken(res.token);
      setCurrentUser(res.user);
      saveUserSession(res.user, nextRoot, res.token);
      await refreshAllData();
    } catch (err: any) {
      // Never fail silently. If the server session is gone (e.g. after a
      // server restart) drop the stale local session so the user can log
      // back in cleanly instead of being stuck on a dead profile.
      const message = err?.message || 'Unknown error';
      const isAuthError = /not authenticated|log in again|unauthorized|authentication required/i.test(message);
      if (isAuthError) {
        handleLogout();
      } else {
        console.error('Could not switch profile:', message);
      }
      throw err;
    }
  };

  const handleSwitchBackToRoot = async () => {
    if (!rootUser) return;
    const rootName = rootUser.name;
    try {
      // Send the root email alongside the id: after a demo data reset the
      // account may have been re-created with a new id, and the stale id
      // stored in localStorage would otherwise fail to resolve server-side.
      const res = await api.switchProfile(rootUser.id, { targetEmail: rootUser.email });
      setAuthToken(res.token);
      setCurrentUser(res.user);
      // Re-sync the root profile from the server response (freshest data,
      // including the current id) so future switch-backs are always valid.
      setRootUser(res.user);
      saveUserSession(res.user, res.user, res.token);
      await refreshAllData();
    } catch (err: any) {
      // Only force a re-login when the server explicitly rejects the session
      // (expired/stale token). For any other failure (e.g. the root profile
      // was deleted or the DB is down) keep the user logged in on the current
      // profile and surface the reason instead of stranding them.
      const message = err?.message || 'Unknown error';
      const isAuthError = /not authenticated|log in again|unauthorized|authentication required/i.test(message);
      if (isAuthError) {
        handleLogout();
      }
      alertDialog(`Could not switch back to ${rootName}: ${message}`);
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
    asset: Omit<Asset, 'id' | 'netBookValue' | 'accumulatedDepreciation'> & {
      /** WTY-4: exact supplier warranty expiry captured with the asset. */
      supplierWarrantyEndDateAD?: string;
      /** WTY-5: false declares "no supplier warranty" for this asset. */
      supplierWarrantyCovered?: boolean;
    }
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
    // The server registers every received serial in the serial register inside
    // the invoice's own transaction (serial-register audit, Slice 1). The old
    // client-side loop that wrote "Unassigned Stock" customer-device rows is
    // gone: it was a SECOND writer of the same units, and its rows made stock
    // operations validate against the customer table instead of the register.
    await api.createPurchaseInvoice(inv);
    refreshAllData();
  };

  const handleCreateSalesInvoice = async (
    inv: Omit<SalesInvoice, 'id' | 'invoiceNumber'>
  ) => {
    await api.createSalesInvoice(inv);
    refreshAllData();
  };

  const handleRecordCustomerPayment = async (
    invoice: SalesInvoice,
    amount: number,
    paymentMethod: string
  ) => {
    await api.createCustomerPayment({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      branchId: invoice.branchId,
      amount,
      paymentMethod: paymentMethod as CustomerPayment['paymentMethod'],
      paymentDateAD: new Date().toISOString().split('T')[0],
    });
    refreshAllData();
  };

  // Voids a posted sales invoice. The server reverses it atomically (stock +
  // claimed serials + ledger) and refuses invoices that still carry payments
  // or credit notes; its message is surfaced by the screen.
  const handleCancelSalesInvoice = async (id: string, reason?: string) => {
    await api.cancelSalesInvoice(id, reason);
    refreshAllData();
  };

  const handleCreatePurchaseReturn = async (payload: any) => {
    const created = await api.createPurchaseReturn(payload);
    refreshAllData();
    return created;
  };

  const handleCancelPurchaseReturn = async (id: string, reason: string) => {
    await api.cancelPurchaseReturn(id, reason);
    refreshAllData();
  };

  const handleApprovePurchaseReturn = async (id: string) => {
    await api.postPurchaseReturn(id);
    refreshAllData();
  };

  const handleCreateSalesReturn = async (payload: any) => {
    const created = await api.createSalesReturn(payload);
    refreshAllData();
    return created;
  };

  const handleCancelSalesReturn = async (id: string, reason: string) => {
    await api.cancelSalesReturn(id, reason);
    refreshAllData();
  };

  const handleApproveSalesReturn = async (id: string) => {
    await api.postSalesReturn(id);
    refreshAllData();
  };

  const handleDeleteInvoice = async (invoiceId: string) => {
    await api.deletePurchaseInvoice(invoiceId);
    await refreshAllData();
  };

  const handleRecordPayment = async (
    id: string,
    amount: number,
    paymentMethod?: string,
    details?: {
      bankName?: string;
      bankBranch?: string;
      accountNumber?: string;
      chequeNumber?: string;
      transactionReference?: string;
      paymentDateAD?: string;
    }
  ) => {
    await api.recordInvoicePayment(id, amount, paymentMethod);
    // Also write the sub-ledger row (bank details, dated, full history) so the
    // Vendor Ledger report and the invoice payment history stay authoritative.
    try {
      const linkedInv = purchaseInvoices.find((inv) => inv.id === id);
      await api.createVendorPayment({
        supplierId: linkedInv?.supplierId,
        supplierName: linkedInv?.supplierName || '',
        invoiceId: id,
        invoiceNumber: linkedInv?.invoiceNumber,
        amount,
        paymentMethod: paymentMethod || 'CASH',
        paymentDateAD: details?.paymentDateAD || new Date().toISOString().split('T')[0],
        bankName: details?.bankName,
        bankBranch: details?.bankBranch,
        accountNumber: details?.accountNumber,
        chequeNumber: details?.chequeNumber,
        transactionReference: details?.transactionReference,
      });
    } catch (err: any) {
      console.warn('Sub-ledger sync notice:', err?.message || err);
    }
    refreshAllData();
  };

  const handleReversePayment = async (paymentId: string, reason: string) => {
    await api.reverseVendorPayment(paymentId, reason);
    refreshAllData();
  };

  // Reverse all posted payments on a fully paid invoice (restores it to UNPAID)
  const handleReverseInvoicePayments = async (invoiceId: string, reason: string) => {
    await api.reverseInvoicePayments(invoiceId, reason);
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

  // Reverse a damage record (Super Admin / Inventory Manager only) — restores
  // the units back to available stock and marks the record CANCELLED.
  const handleReverseStockOperation = async (id: string, reason?: string) => {
    await api.reverseStockOperation(id, reason, currentUser);
    refreshAllData();
  };

  // Fiscal Year Actions
  const handleSetCurrentFiscalYear = async (id: string) => {
    await api.setCurrentFiscalYear(id);
    refreshAllData();
  };

  const handleCreateFiscalYear = async (input: {
    code: string;
    startDateAD: string;
    endDateAD: string;
    startDateBS: string;
    endDateBS: string;
  }) => {
    const created = await api.createFiscalYear(input);
    await refreshAllData();
    return created;
  };

  const handleDeleteFiscalYear = async (id: string) => {
    const result = await api.deleteFiscalYear(id);
    await refreshAllData();
    return result;
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

  const handleRollForwardVendorOpenings = async (id: string) => {
    const result = await api.rollForwardVendorOpenings(id);
    await refreshAllData();
    return result;
  };

  const activeFy =
    resolveDefaultFiscalYear(fiscalYears)?.code || financialSummary.currentFiscalYear;

  const handleGroupLowStockPO = () => {
    const activeBr =
      selectedBranchId === 'ALL'
        ? branches
        : branches.filter((b) => b.id === selectedBranchId);

    const lowStockProductMap = new Map<string, { product: Product; qty: number }>();
    // STOCK-1: index once for the whole pass; the per-pair scan was
    // products × branches × stock on every click of "group low stock PO".
    const stockIndex = indexStockByProductBranch(stock);

    products.forEach((prod) => {
      let productTotalDeficit = 0;

      activeBr.forEach((b) => {
        const item = stockRowAt(stockIndex, prod.id, b.id);
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

  // ONE aggregated notice for every slice whose last refresh failed (C1).
  const failedSliceErrors = visibleSliceErrors(sliceState);

  if (!currentUser) {
    return (
      <div
        className={`h-screen w-screen overflow-hidden font-sans flex flex-col antialiased transition-colors duration-200 bg-[#f0f2f5] text-slate-800 dark:bg-[#0a0c10] dark:text-slate-300`}
      >
        <LoginModal
          onLoginSuccess={async (email, pass) => {
            setLoginNotice(null);
            await handleLogin(email, pass);
          }}
          branches={branches}
          notice={loginNotice || undefined}
          onSetupSuperAdmin={async (data) => {
            const res = await api.setupSuperAdmin(data);
            setLoginNotice(null);
            setAuthToken(res.token);
            setCurrentUser(res.user);
            setRootUser(res.user);
            saveUserSession(res.user, res.user, res.token);
            refreshAllData();
          }}
        />
      </div>
    );
  }

  const todayAD = new Date().toISOString().slice(0, 10);
  const assetReportAsOfDateAD = selectedFiscalYear?.isCurrent
    ? (todayAD < selectedFiscalYear.startDateAD ? selectedFiscalYear.startDateAD : todayAD)
    : (selectedFiscalYear?.endDateAD || todayAD);

  // Help Documentation links to tabs by their legacy names; the screen no
  // longer opens the overlays itself — it asks the shell (A2).
  const handleHelpNavigateTab = (tab: string) => {
    if (tab === 'users-management' || tab === 'login') {
      setActiveTab('users');
    } else {
      setActiveTab(tab as NavTab);
    }
  };

  // A4: the route table — every tab declared once, in render order. The
  // element is built from the root's data props; AppRoutes owns the
  // keep-mounted wiring and the permission metadata rides on each entry.
  const screenRoutes: AppRoute[] = [
    screenRoute('dashboard', (
      <Dashboard
        currentUser={currentUser}
        products={products}
        stock={stock}
        branches={branches}
        pendingPurchaseOrders={procurementPending.pendingPurchaseOrders}
        financialSummary={financialSummary}
        categories={categories}
        selectedBranchId={selectedBranchId}
        fiscalYearStartAD={selectedFiscalYear?.startDateAD}
        fiscalYearEndAD={selectedFiscalYear?.endDateAD}
        sseRefreshKey={registerRefresh.transactionLog}
        dateMode={dateMode}
        asOfDateAD={assetReportAsOfDateAD}
        approvalRequests={approvalRequests}
        onProcessApproval={handleProcessApprovalRequest}
        onNavigateTab={setActiveTab}
        onSelectBranch={handleSelectBranch}
        onGroupLowStockPO={handleGroupLowStockPO}
        onUpdateStockLevel={handleUpdateStockLevel}
        bsCalendarCoverage={bsCalendarCoverage}
        bsCalendarSeedTab={bsCalendarSeedTab}
      />
    )),
    screenRoute('approvals', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <ApprovalWorkflowCenter
          approvalRequests={approvalRequests}
          branches={branches}
          currentUser={currentUser}
          dateMode={dateMode}
          onProcessApproval={handleProcessApprovalRequest}
          onCancelApproval={handleCancelApprovalRequest}
          onNavigateToStockAudit={(branchId) => {
            if (branchId && branchId !== 'ALL') {
              setSelectedBranchId(branchId);
            }
            setActiveTab('physical-stock-audit');
          }}
        />
      </React.Suspense>
    )),
    screenRoute('all-stock', (
      <ProductManagement
        currentUser={currentUser}
        stock={stock}
        selectedBranchId={selectedBranchId}
        onCreateProduct={handleCreateProduct}
        onUpdateProduct={handleUpdateProduct}
        onDeleteProduct={handleDeleteProduct}
        searchQuery={searchQuery}
        mode="all-stock"
      />
    )),
    screenRoute('product-master', (
      <ProductManagement
        currentUser={currentUser}
        stock={stock}
        selectedBranchId={selectedBranchId}
        onCreateProduct={handleCreateProduct}
        onUpdateProduct={handleUpdateProduct}
        onDeleteProduct={handleDeleteProduct}
        searchQuery={searchQuery}
        mode="product-master"
      />
    )),
    screenRoute('opening-stock', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <OpeningStockManager
          currentUser={currentUser}
          fiscalYears={fiscalYears}
          branches={branches}
          products={products}
          onRefreshData={refreshAllData}
          selectedFiscalYearId={selectedFiscalYearId}
          onSelectFiscalYear={setSelectedFiscalYearId}
        />
      </React.Suspense>
    )),
    screenRoute('category-management', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <CategoryManagement
          currentUser={currentUser}
          products={products}
        />
      </React.Suspense>
    )),
    screenRoute('product-group-management', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <ProductGroupManagement
          currentUser={currentUser}
          products={products}
        />
      </React.Suspense>
    )),
    screenRoute('uom-management', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <UomManagement
          currentUser={currentUser}
        />
      </React.Suspense>
    )),
    screenRoute('import-stock', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <ImportStock
          branches={branches}
          products={products}
          onCreateProduct={handleCreateProduct}
          onUpdateProduct={handleUpdateProduct}
          onRefreshData={refreshAllData}
        />
      </React.Suspense>
    )),
    screenRoute('export-stock', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <ExportStock
          currentUser={currentUser}
          products={products}
          branches={branches}
          stock={stock}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
        />
      </React.Suspense>
    )),
    screenRoute('branch-stock', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <BranchStockTracking
          currentUser={currentUser}
          products={products}
          branches={branches}
          stock={stock}
          selectedBranchId={selectedBranchId}
          onUpdateStockLevel={handleUpdateStockLevel}
        />
      </React.Suspense>
    )),
    screenRoute('reorder-stock', (
      <React.Suspense fallback={<TabLoadingFallback />}>
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
        />
      </React.Suspense>
    )),
    screenRoute('damaged-stock', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <DamagedStockTracking
          currentUser={currentUser}
          products={products}
          branches={branches}
          stock={stock}
          damageRecords={damageRecords}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          onUpdateStockLevel={handleUpdateStockLevel}
          onCreateOperation={handleCreateOperation}
          onReverseStockOperation={handleReverseStockOperation}
          onNavigateTab={setActiveTab}
        />
      </React.Suspense>
    )),
    screenRoute('stock-valuation', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <StockValuation
          products={products}
          branches={branches}
          stock={stock}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
        />
      </React.Suspense>
    )),
    screenRoute('stock-ledger', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <StockMovementLedger
          products={products}
          branches={branches}
          stock={stock}
          damageRecords={damageRecords}
          stockOperations={stockOperations}
          shipments={shipments}
          purchaseOrders={purchaseOrders}
          selectedBranchId={selectedBranchId}
          fiscalYearStartAD={selectedFiscalYear?.startDateAD}
          fiscalYearEndAD={selectedFiscalYear?.endDateAD}
          sseRefreshKey={registerRefresh.transactionLog}
          dateMode={dateMode}
        />
      </React.Suspense>
    )),
    screenRoute('physical-stock-audit', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <PhysicalStockAudit
          currentUser={currentUser}
          products={products}
          branches={branches}
          stock={stock}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
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
          companyWideBlindCount={appSettings.companyWideBlindCount === 'true'}
          // Unknown settings must not present the toggle as a known
          // "off": disable it until the read above succeeds (DF-17).
          settingsUnknown={Boolean(settingsBackfillError) || settingsBackfillLoading}
          onCompanyWideBlindCountChange={(next) =>
            handleAppSettingChange('companyWideBlindCount', next ? 'true' : 'false')
          }
        />
      </React.Suspense>
    )),
    screenRoute('fixed-assets', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <FixedAssetRegister
          currentUser={currentUser}
          refreshToken={registerRefresh.fixedAssets}
          branches={branches}
          selectedBranchId={selectedBranchId}
          asOfDateAD={assetReportAsOfDateAD}
          dateMode={dateMode}
          onCreateAsset={handleCreateAsset}
          onUpdateAssetStatus={handleUpdateAssetStatus}
        />
      </React.Suspense>
    )),
    screenRoute('dev-statcard', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <StatCardShowcase />
      </React.Suspense>
    ), { enabled: Boolean(import.meta.env?.DEV) }),
    screenRoute('customers', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <CustomerMasterDirectory
          branches={branches}
          currentUser={currentUser}
          refreshKey={registerRefresh.customerDevices}
          onCustomersChanged={refreshAllData}
          onNavigateToImport={() => setActiveTab('import-customers')}
          onSelectTab={(tab, filter) => {
            setActiveTab(tab as any);
            if (filter) setSearchQuery(filter);
          }}
        />
      </React.Suspense>
    )),
    screenRoute('customer-devices', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <CustomersManagement
          currentUser={currentUser}
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
          sseRefreshKey={registerRefresh.customerDevices}
        />
      </React.Suspense>
    )),
    screenRoute('complete-serial-inventory', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <SerialLogRegister
          branches={branches}
          selectedBranchId={selectedBranchId}
          currentUser={currentUser}
          dateMode={dateMode}
          onRefreshData={refreshAllData}
          refreshKey={registerRefresh.serialLog}
        />
      </React.Suspense>
    )),
    screenRoute('locations', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <LocationsManagement
          branches={branches}
          currentUser={currentUser}
        />
      </React.Suspense>
    )),
    screenRoute('import-customers', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <ImportCustomers
          branches={branches}
          onImportCustomersSuccess={async (newCustomers) => {
            await api.bulkImportCustomers(newCustomers);
            await refreshAllData();
          }}
        />
      </React.Suspense>
    )),
    screenRoute('create-po', (
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
        sseRefreshKey={registerRefresh.purchaseOrders}
      />
    )),
    screenRoute('po-list', (
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
        sseRefreshKey={registerRefresh.purchaseOrders}
      />
    )),
    screenRoute('create-purchase', (
      <React.Suspense fallback={<TabLoadingFallback />}>
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
          fiscalYearStartAD={selectedFiscalYear?.startDateAD}
          fiscalYearEndAD={selectedFiscalYear?.endDateAD}
          dateMode={dateMode}
          activeTab="create-purchase"
          onCreateInvoice={handleCreateInvoice}
          onRecordPayment={handleRecordPayment}
          onReversePayment={handleReversePayment}
          onReverseInvoicePayments={handleReverseInvoicePayments}
          onDeleteInvoice={handleDeleteInvoice}
          sseRefreshKey={registerRefresh.purchaseInvoices}
        />
      </React.Suspense>
    )),
    screenRoute('purchase-list', (
      <React.Suspense fallback={<TabLoadingFallback />}>
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
          fiscalYearStartAD={selectedFiscalYear?.startDateAD}
          fiscalYearEndAD={selectedFiscalYear?.endDateAD}
          dateMode={dateMode}
          activeTab="purchase-list"
          onCreateInvoice={handleCreateInvoice}
          onRecordPayment={handleRecordPayment}
          onReversePayment={handleReversePayment}
          onReverseInvoicePayments={handleReverseInvoicePayments}
          onDeleteInvoice={handleDeleteInvoice}
          sseRefreshKey={registerRefresh.purchaseInvoices}
        />
      </React.Suspense>
    )),
    screenRoute('create-sale', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <SalesInvoices
          companyProfile={companyProfile}
          currentUser={currentUser}
          products={products}
          branches={branches}
          stock={stock}
          inventorySerials={inventorySerials}
          inventorySerialsError={sellableSerialsError}
          inventorySerialsLoading={sellableSerialsLoading}
          onRetryInventorySerials={() => void loadSellableSerials(selectedBranchId)}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          sseRefreshKey={registerRefresh.salesInvoices}
          activeTab="create-sale"
          onCreateInvoice={handleCreateSalesInvoice}
          onRecordPayment={handleRecordCustomerPayment}
          onCancelInvoice={handleCancelSalesInvoice}
        />
      </React.Suspense>
    )),
    screenRoute('sales-list', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <SalesInvoices
          companyProfile={companyProfile}
          currentUser={currentUser}
          products={products}
          branches={branches}
          stock={stock}
          inventorySerials={inventorySerials}
          inventorySerialsError={sellableSerialsError}
          inventorySerialsLoading={sellableSerialsLoading}
          onRetryInventorySerials={() => void loadSellableSerials(selectedBranchId)}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          sseRefreshKey={registerRefresh.salesInvoices}
          activeTab="sales-list"
          onCreateInvoice={handleCreateSalesInvoice}
          onRecordPayment={handleRecordCustomerPayment}
          onCancelInvoice={handleCancelSalesInvoice}
        />
      </React.Suspense>
    )),
    screenRoute('purchase-returns', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <ReturnsRegister
          kind="PURCHASE"
          companyProfile={companyProfile}
          currentUser={currentUser}
          purchaseInvoices={purchaseInvoices}
          returns={purchaseReturns}
          products={products}
          branches={branches}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          sseRefreshKey={registerRefresh.returnsRegister}
          onCreateReturn={handleCreatePurchaseReturn}
          onCancelReturn={handleCancelPurchaseReturn}
          onApproveReturn={handleApprovePurchaseReturn}
        />
      </React.Suspense>
    )),
    screenRoute('create-purchase-return', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <ReturnsRegister
          kind="PURCHASE"
          companyProfile={companyProfile}
          currentUser={currentUser}
          purchaseInvoices={purchaseInvoices}
          returns={purchaseReturns}
          products={products}
          branches={branches}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          autoOpenCreate
          sseRefreshKey={registerRefresh.returnsRegister}
          onCreateReturn={handleCreatePurchaseReturn}
          onCancelReturn={handleCancelPurchaseReturn}
          onApproveReturn={handleApprovePurchaseReturn}
        />
      </React.Suspense>
    )),
    screenRoute('sales-returns', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <ReturnsRegister
          kind="SALES"
          companyProfile={companyProfile}
          currentUser={currentUser}
          purchaseInvoices={purchaseInvoices}
          returns={salesReturns}
          products={products}
          branches={branches}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          sseRefreshKey={registerRefresh.returnsRegister}
          onCreateReturn={handleCreateSalesReturn}
          onCancelReturn={handleCancelSalesReturn}
          onApproveReturn={handleApproveSalesReturn}
        />
      </React.Suspense>
    )),
    screenRoute('create-sales-return', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <ReturnsRegister
          kind="SALES"
          companyProfile={companyProfile}
          currentUser={currentUser}
          purchaseInvoices={purchaseInvoices}
          returns={salesReturns}
          products={products}
          branches={branches}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          autoOpenCreate
          sseRefreshKey={registerRefresh.returnsRegister}
          onCreateReturn={handleCreateSalesReturn}
          onCancelReturn={handleCancelSalesReturn}
          onApproveReturn={handleApproveSalesReturn}
        />
      </React.Suspense>
    )),
    screenRoute('create-shipment', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <Shipments
          currentUser={currentUser}
          activeTab="create-shipment"
          products={products}
          branches={branches}
          stock={stock}
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
          shipmentsRefresh={registerRefresh.shipments}
        />
      </React.Suspense>
    )),
    screenRoute('create-transfer', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        products={products}
        branches={branches}
        stock={stock}
        locations={locations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="CREATE_TRANSFER"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        approvalRequests={approvalRequests}
        sseRefreshKey={registerRefresh.consumableRegister}
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
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('receive-shipment', (
      <ReceiveInboundWarehouse
        currentUser={currentUser}
        operations={stockOperations}
        shipments={shipments}
        products={products}
        branches={branches}
        stock={stock}
        approvalRequests={approvalRequests}
        dateMode={dateMode}
        onReceiveOperation={handleReceiveOperation}
        onReceiveShipment={handleReceiveShipment}
        onCancelReceiveShipment={handleCancelReceiveShipment}
      />
    )),
    screenRoute('receive-branch-transfer', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        products={products}
        branches={branches}
        stock={stock}
        locations={locations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="RECEIVE_TRANSFER"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        approvalRequests={approvalRequests}
        sseRefreshKey={registerRefresh.consumableRegister}
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
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('shipment-list', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <Shipments
          currentUser={currentUser}
          activeTab={activeTab}
          products={products}
          branches={branches}
          stock={stock}
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
          shipmentsRefresh={registerRefresh.shipments}
        />
      </React.Suspense>
    )),
    screenRoute('pullout', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        products={products}
        branches={branches}
        stock={stock}
        locations={locations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="PULLOUT"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        approvalRequests={approvalRequests}
        sseRefreshKey={registerRefresh.consumableRegister}
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
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('damage', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        products={products}
        branches={branches}
        stock={stock}
        locations={locations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="DAMAGE"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        approvalRequests={approvalRequests}
        sseRefreshKey={registerRefresh.consumableRegister}
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
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('pullout-report', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        products={products}
        branches={branches}
        stock={stock}
        locations={locations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="PULLOUT_REPORT"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        approvalRequests={approvalRequests}
        sseRefreshKey={registerRefresh.consumableRegister}
        onCreateOperation={handleCreateOperation}
        onReceiveOperation={handleReceiveOperation}
        onReverseOperation={handleReverseStockOperation}
      />
    )),
    screenRoute('damage-report', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        products={products}
        branches={branches}
        stock={stock}
        locations={locations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="DAMAGE_REPORT"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        approvalRequests={approvalRequests}
        sseRefreshKey={registerRefresh.consumableRegister}
        onCreateOperation={handleCreateOperation}
        onReverseOperation={handleReverseStockOperation}
      />
    )),
    screenRoute('stock-out', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        products={products}
        branches={branches}
        stock={stock}
        locations={locations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="STOCK_OUT"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        approvalRequests={approvalRequests}
        sseRefreshKey={registerRefresh.consumableRegister}
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
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('assign-asset', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        products={products}
        branches={branches}
        stock={stock}
        locations={locations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="ASSIGN_ASSET"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        approvalRequests={approvalRequests}
        sseRefreshKey={registerRefresh.consumableRegister}
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
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('asset-deployments', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <AssetDeployments
          refreshToken={registerRefresh.fixedAssets}
          branches={branches}
          locations={locations}
          currentUser={currentUser}
          dateMode={dateMode}
          onUnassignAsset={handleUpdateAssetStatus}
        />
      </React.Suspense>
    )),
    screenRoute('consumable-issue', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        products={products}
        branches={branches}
        stock={stock}
        locations={locations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="CONSUMABLE_ISSUE"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        approvalRequests={approvalRequests}
        sseRefreshKey={registerRefresh.consumableRegister}
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
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('consumables-register', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        products={products}
        branches={branches}
        stock={stock}
        locations={locations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="CONSUMABLES_REGISTER"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        approvalRequests={approvalRequests}
        sseRefreshKey={registerRefresh.consumableRegister}
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
        onReverseOperation={handleReverseStockOperation}
        onReverseConsumableIssue={async (id, reason) => {
          await api.reverseConsumableIssue(id, reason, currentUser);
          refreshAllData();
        }}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('device-exchange', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        products={products}
        branches={branches}
        stock={stock}
        locations={locations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="DEVICE_EXCHANGE"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        approvalRequests={approvalRequests}
        sseRefreshKey={registerRefresh.consumableRegister}
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
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('supplier-warranty', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <SupplierWarrantyRegister
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          currentUser={currentUser}
          refreshKey={registerRefresh.customerDevices}
        />
      </React.Suspense>
    )),
    screenRoute('seller-warranty', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <SellerWarrantyRegister
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          currentUser={currentUser}
          refreshKey={registerRefresh.customerDevices}
        />
      </React.Suspense>
    )),
    screenRoute('branches', (
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
      />
    )),
    screenRoute('suppliers', (
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
      />
    )),
    screenRoute('users', (
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
      />
    )),
    screenRoute('permissions', <PermissionManagement currentUser={currentUser} permissionsMatrix={permissionsMatrix} />),
    screenRoute('company-setup', (
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
      />
    )),
    screenRoute('clear-demo-data', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <ClearDemoDataView
          currentUser={currentUser}
          productCount={products.length}
          stockCount={stock.length}
          poCount={purchaseOrders.length}
          invoiceCount={purchaseInvoices.length}
          onClearDemoData={async () => {
            const result = await api.clearDemoData();
            await refreshAllData();
            // The demo Super Admin rows were just deleted — usually
            // including the account this session is signed in as.
            // Authorization is derived from the signed token (8h TTL)
            // with no per-request user lookup, so staying signed in
            // would mean acting as a user that no longer exists; the
            // real next step is the first-launch setup, which
            // LoginModal opens by itself once no Super Admin is left.
            if (result.superAdminCount === 0) {
              setLoginNotice(
                'Demo data was cleared, including the demo Super Admin accounts. Create your own Super Admin account to continue.'
              );
            }
            return result;
          }}
          needsFiscalYear={!fiscalYears.some((fy) => fy.isCurrent)}
          onNavigateFiscalYears={() => setActiveTab('fiscal-year-closing')}
          onSignedOut={handleLogout}
          onNavigateDashboard={() => setActiveTab('dashboard')}
        />
      </React.Suspense>
    )),
    screenRoute('financial-statements', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <FinancialStatements
          financialSummary={financialSummary}
          refreshToken={registerRefresh.fixedAssets}
          invoices={purchaseInvoices}
          dateMode={dateMode}
          asOfDateAD={assetReportAsOfDateAD}
          companyProfile={companyProfile}
          branches={branches}
          fiscalYears={fiscalYears}
          currentFiscalYear={resolveDefaultFiscalYear(fiscalYears) || null}
          fiscalYearId={resolveDefaultFiscalYear(fiscalYears)?.id}
        />
      </React.Suspense>
    )),
    screenRoute('vendor-ledger', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <VendorLedger
          suppliers={suppliers}
          branches={branches}
          dateMode={dateMode}
          sseRefreshKey={registerRefresh.purchaseInvoices}
        />
      </React.Suspense>
    )),
    screenRoute('customer-ledger', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <CustomerLedger
          branches={branches}
          dateMode={dateMode}
          sseRefreshKey={registerRefresh.salesInvoices}
          returnsRefreshKey={registerRefresh.returnsRegister}
        />
      </React.Suspense>
    )),
    screenRoute('vendor-opening-balances', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <VendorOpeningBalances
          currentUser={currentUser}
          fiscalYears={fiscalYears}
          branches={branches}
          onRefreshData={refreshAllData}
          selectedFiscalYearId={selectedFiscalYearId}
          onSelectFiscalYear={setSelectedFiscalYearId}
        />
      </React.Suspense>
    )),
    screenRoute('vat-register', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <VatRegister
          invoices={purchaseInvoices}
          dateMode={dateMode}
          companyProfile={companyProfile}
        />
      </React.Suspense>
    )),
    screenRoute('depreciation-register', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <DepreciationRegister
          refreshToken={registerRefresh.fixedAssets}
          branches={branches}
          selectedBranchId={selectedBranchId}
          asOfDateAD={assetReportAsOfDateAD}
          dateMode={dateMode}
          companyProfile={companyProfile}
        />
      </React.Suspense>
    )),
    screenRoute('audit', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <AuditTrailReports
          auditLogs={auditLogs}
          financialSummary={financialSummary}
          products={products}
          branches={branches}
          invoices={purchaseInvoices}
          selectedBranchId={selectedBranchId}
          fiscalYearStartAD={selectedFiscalYear?.startDateAD}
          fiscalYearEndAD={selectedFiscalYear?.endDateAD}
          sseRefreshKey={registerRefresh.transactionLog}
          dateMode={dateMode}
          companyProfile={companyProfile}
        />
      </React.Suspense>
    )),
    screenRoute('data-recalculation', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <DataRecalculationMaintenance
          currentUser={currentUser}
          fiscalYears={fiscalYears}
          onRefreshData={refreshAllData}
        />
      </React.Suspense>
    )),
    screenRoute('fiscal-year-closing', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <FiscalYearClosingWizard
          fiscalYears={fiscalYears}
          onSetCurrentFiscalYear={handleSetCurrentFiscalYear}
          onCloseFiscalYear={handleCloseFiscalYear}
          onReopenFiscalYear={handleReopenFiscalYear}
          onCreateFiscalYear={handleCreateFiscalYear}
          onDeleteFiscalYear={handleDeleteFiscalYear}
          onInitializeOpeningStock={handleInitializeFiscalYearOpeningStock}
          onRollForwardVendorOpenings={handleRollForwardVendorOpenings}
          dateMode={dateMode}
          financialSummary={financialSummary}
          products={products}
          stock={stock}
          refreshToken={registerRefresh.fixedAssets}
          branchId={selectedBranchId}
          sseRefreshKey={registerRefresh.purchaseOrders + registerRefresh.purchaseInvoices}
          approvalRequests={approvalRequests}
          currentUser={currentUser}
          onRefreshData={refreshAllData}
          companyProfile={companyProfile}
          selectedFiscalYearId={selectedFiscalYearId}
          onSelectFiscalYear={setSelectedFiscalYearId}
          onNavigateTab={setActiveTab}
        />
      </React.Suspense>
    )),
    screenRoute('bs-calendar', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <BsCalendarUtility
          currentUser={currentUser}
        />
      </React.Suspense>
    )),
    screenRoute('fiscal-year-management', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <DocumentNumbering />
      </React.Suspense>
    )),
    screenRoute('nepali-fiscal', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <NepaliFiscalManagement
          fiscalYears={fiscalYears}
          onSetCurrentFiscalYear={handleSetCurrentFiscalYear}
          dateMode={dateMode}
        />
      </React.Suspense>
    )),
    screenRoute('help-documentation', (
      <React.Suspense fallback={<TabLoadingFallback />}>
        <HelpDocumentationLazy
          currentUser={currentUser}
          onNavigateTab={handleHelpNavigateTab}
        />
      </React.Suspense>
    )),
  ];

  return (
    <AppShell
      companyProfile={companyProfile}
      currentUser={currentUser}
      rootUser={rootUser}
      users={users}
      onSwitchBackToRoot={handleSwitchBackToRoot}
      onSwitchProfile={handleSwitchProfile}
      onUpdateProfile={handleUpdateProfile}
      onLogout={handleLogout}
      onLogin={handleLogin}
      refreshAllData={refreshAllData}
      permissionsVersion={permissionsVersion}
      onToggleTheme={handleToggleTheme}
      branches={branches}
      selectedBranchId={selectedBranchId}
      onSelectBranch={handleSelectBranch}
      dateMode={dateMode}
      onToggleDateMode={handleToggleDateMode}
      currentFiscalYear={activeFy}
      fiscalYears={fiscalYears}
      selectedFiscalYearId={selectedFiscalYearId}
      onSelectFiscalYear={setSelectedFiscalYearId}
      activeTab={activeTab}
      onSelectTab={setActiveTab}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      products={products}
      stock={stock}
      purchaseOrders={purchaseOrders}
      purchaseInvoices={purchaseInvoices}
      pendingPurchaseOrders={procurementPending.pendingPurchaseOrders}
      unpaidBillCount={procurementPending.unpaidInvoiceCount}
      shipments={shipments}
      stockOperations={stockOperations}
      approvalRequests={approvalRequests}
      suppliers={suppliers}
      bsCalendarCoverage={bsCalendarCoverage}
      bsCalendarSeedTab={bsCalendarSeedTab}
      banners={
        <>
          {/* Direct PostgreSQL Database Setup Notification Banner */}
          <DatabaseSetupBanner
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

          {/* Refused bootstrap: the server's own reason, not a database alarm. */}
          {bootstrapBlocked && (
            <BootstrapBlockedBanner
              message={bootstrapBlocked.message}
              status={bootstrapBlocked.status}
              // A refused-for-want-of-a-fiscal-year bootstrap names its own remedy in
              // prose; give it the button too, so the block is one click from fixed.
              action={
                bootstrapBlocked.noCurrentFiscalYear
                  ? { label: 'Open Fiscal Year Closing Wizard', tab: 'fiscal-year-closing' }
                  : undefined
              }
              onRetry={refreshAllData}
              onDismiss={() => setBootstrapBlocked(null)}
            />
          )}

          {/* A failed slice refresh keeps the last good rows on screen and says so
              once, with a retry — never a toast per slice. */}
          <BootstrapSliceNotice
            slices={failedSliceErrors}
            retrying={isAnySliceLoading(sliceState)}
            onRetry={retryFailedSlices}
            onDismiss={() => setSliceState((prev) => dismissSliceErrors(prev))}
          />

          {/* DF-17: a cached payload that needed the settings backfill and could
              not get it runs on defaults. Say the configuration is unknown and
              offer the retry rather than silently presenting default values. */}
          <LoadStateNotice
            subject="company settings"
            loading={settingsBackfillLoading}
            error={settingsBackfillError}
            onRetry={() => void loadSettingsFromServer()}
            emptyNote=" The app is using default settings until this succeeds."
            cachedNote=" The app is using default settings until this succeeds."
          />

          {/* The shell badge, dashboard tile and notification panel read the
              scoped pending-procurement count. A failed read keeps the last
              numbers on screen and is retryable here rather than silently
              showing zero. */}
          <LoadStateNotice
            subject="open purchase orders and unpaid bills"
            loading={procurementPending.loading}
            error={procurementPending.error}
            onRetry={() => {
              void import('./services/procurementPendingCache').then((mod) =>
                mod.procurementPendingStore.refresh()
              );
            }}
            emptyNote=" Badges and alerts may be out of date until this succeeds."
            cachedNote=" Showing the last loaded counts until this succeeds."
          />
        </>
      }
    >
      {/* Main Content Viewport — the sidebar is a static flex column, so the
          main area always fills the remaining width at a stable size. */}
      <main
        className={`flex-1 overflow-y-auto p-2.5 sm:p-3.5 transition-colors duration-200 bg-[#e9ebee] dark:bg-[#0a0c10]`}
      >
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64 space-y-3">
            <Loader2 className="h-8 w-8 text-indigo-500 animate-spin" />
            <p className="text-xs font-semibold text-slate-400">
              Synchronizing multi-branch inventory database...
            </p>
          </div>
        ) : (
          <AppRoutes activeTab={activeTab} routes={screenRoutes} />
        )}
      </main>
    </AppShell>
  );
}
