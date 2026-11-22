import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { User, Product, CompanyProfile, PurchaseOrder, FiscalYear } from './types';
import { api, setAuthToken, setFiscalYearContext, setUserContext, setActiveBranchContext, broadcastLogoutToOtherTabs, getAuthToken } from './services/api';
import { seedBSYearCalendar, getBsCalendarCoverage, type BsCalendarCoverageStatus } from './utils/nepaliCalendar';
import { NAVIGATE_TAB_EVENT } from './services/api/http';
import { saveUserSession, clearUserSession, saveRecentBootstrapCache, loadRecentBootstrapCache, clearRecentBootstrapCache, BOOTSTRAP_CACHE_MAX_AGE_MS } from './utils/sessionCache';
import { AppShell } from './components/layout/AppShell';
import { NavTab, NAV_TABS } from './components/layout/Sidebar';
import { resolveBranchSelection } from './utils/permissions';
import { useSyncStream } from './hooks/useSyncStream';
import { useAppRouting } from './hooks/useAppRouting';
import { useInventoryActions } from './hooks/useInventoryActions';
import { useProcurementActions } from './hooks/useProcurementActions';
import { useSalesActions } from './hooks/useSalesActions';
import { useFiscalActions } from './hooks/useFiscalActions';
import { useWorkflowActions } from './hooks/useWorkflowActions';
import { indexStockByProductBranch, stockRowAt } from './utils/stockIndex';
import { invalidateSerialRegister } from './services/serialRegisterCache';
import { invalidateShipmentOverview, useShipmentOverview } from './services/shipmentOverviewCache';
import { mergeShipmentWindow } from './services/shipmentOverviewStore';
import { invalidateAvailableFixedAssets, resetAvailableFixedAssets } from './services/availableAssetsCache';
import { invalidateBranchStock, resetBranchStock } from './services/branchStockCache';
import { invalidateExchangeDevices, resetExchangeDevices } from './services/exchangeDeviceCache';
import { LoginModal } from './components/common/LoginModal';
import { ForcePasswordChange } from './components/auth/ForcePasswordChange';

import { OrderFormLine } from './features/procurement/PurchaseOrders';
// Rarely-used / heavy screens are lazy: their chunks download on first visit.
// Kept eager: Dashboard, ProductManagement, StockOperations (11 render sites),
// PurchaseOrders, modals, and anything referenced in the synchronous render path.
// BUDGET-1 (2026-10-26): Branch Stock, Fixed Assets, the Customer Master
// Directory, the Customer Devices register and the Serial Log moved here from
// the eager graph — 33.8 kB gzip of registers that no first paint renders.
// Asset Deployments register (assigned fixed assets incl. non-serialized items)

// exceljs (≈1 MB) is only needed for the BS calendar utility, so this
// component is lazy: the vendor-excel chunk downloads on first visit.
// BS fiscal-year settings (unlock / carry-forward). Reachable from the Help
// Center's "Unlock / Carry Forward Balances" step. The 'nepali-fiscal' tab
// rendered BsCalendarUtility instead, so this screen was never reachable.

// The two access-management screens are large and are opened from Settings,
// never during boot. Loading them lazily keeps ~2,200 lines out of the startup
// chunk (the entry budget gate measures exactly this) while their preload
// entries keep a deep link's splash covered.
// The API creator is opened from Administration, never during boot: loading it
// lazily keeps its forms out of the entry chunk the budget gate measures.
import { DatabaseSetupBanner } from './components/common/DatabaseSetupBanner';
import { BootstrapBlockedBanner } from './components/common/BootstrapBlockedBanner';
import { setCurrencyConfig } from './utils/nprFormat';
import { setDefaultTaxRate } from './utils/taxConfig';
import { setProductGroups } from './utils/productGroupBehavior';
import { useDarkMode } from './contexts/DarkModeContext';
import { useSession } from './contexts/SessionContext';
import { useScope } from './contexts/ScopeContext';
import { useDialog } from './components/common/DialogProvider';
import { AppRoutes, type AppRoute } from './routes/appRoutes';
import { buildScreenRoutes, type ScreenRouteProps } from './routes/screenRoutes';
import type { UserAccessFocusRequest } from './features/settings/UserPermissions';
import { ACTIVE_TAB_STORAGE_KEY } from './utils/tabStorage';

import { canonicalTab, isNavTab } from './routes/appPaths';
import { isTabAccessible } from './routes/tabPermissions';
import { broadcastBsCalendarUpdated } from './utils/bsCalendarRefresh';
import { Loader2 } from 'lucide-react';

/** Saved-tab mirror. Storage can be blocked; a deep link must still work then. */
function readSavedTab(): string | null {
  try {
    return localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
  } catch {
    return null;
  }
}

import { beginSliceLoad, dismissSliceErrors, failedSliceKeys, isAnySliceLoading, markSliceError, markSlicesReady, settleSliceDiscarded, sliceScopeKey, visibleSliceErrors, SliceRequestGate } from './services/bootstrapSlices';
import { BootstrapSliceNotice } from './components/common/BootstrapSliceNotice';
import { LoadStateNotice } from './components/common/LoadStateNotice';
import { applyEffectivePermissions, applyServerMatrix, getPermissionsMatrix } from './utils/permissions';
import { setExportCompanyProfile } from './utils/exportUtils';
import { useBootstrapData } from './contexts/AppProviders';

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

  const {
    activeTab,
    setActiveTab,
    activeTabRef,
    recordRoute,
    setRecordRoute,
    recordRouteRef,
    urlHistoryModeRef,
    urlTabPendingRef,
    handleSelectTab,
    handleRecordRouteChange,
  } = useAppRouting();
  // Users → Access & permissions asks this screen to open one person. The
  // incrementing token makes a second click for the same person re-focus it.
  const [userAccessFocus, setUserAccessFocus] = useState<UserAccessFocusRequest | null>(null);
  const userAccessFocusSeq = useRef(0);
  // A customer/supplier directory row can open the matching party ledger with
  // that party already selected. The token makes a second click for the same
  // party focus it again instead of being ignored by React state equality.
  const [ledgerPartyFocus, setLedgerPartyFocus] = useState<{
    tab: 'customer-ledger' | 'vendor-ledger' | 'employee-ledger';
    partyId: string;
    partyLabel?: string;
    token: number;
  } | null>(null);
  const ledgerPartyFocusSeq = useRef(0);
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
  // Always-fresh identity for the stable permission-refresh callback below.
  const currentUserRef = useRef<User | null>(currentUser);
  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);
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
      const detail = (e as CustomEvent<{ tab?: string; partyId?: string; partyLabel?: string }>).detail;
      const tab = detail?.tab;
      if (!tab) return;
      const nextTab = canonicalTab(tab as NavTab);
      if (!canAccessTabRef.current(nextTab)) return;
      if (
        detail?.partyId &&
        (nextTab === 'customer-ledger' ||
          nextTab === 'vendor-ledger' ||
          nextTab === 'employee-ledger')
      ) {
        ledgerPartyFocusSeq.current += 1;
        setLedgerPartyFocus({
          tab: nextTab,
          partyId: detail.partyId,
          partyLabel: detail.partyLabel,
          token: ledgerPartyFocusSeq.current,
        });
      }
      urlHistoryModeRef.current = 'push';
      setRecordRoute(null);
      setActiveTab(nextTab);
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

  /**
   * The signed-in account's resolved operation set. Re-read on sign-in, profile
   * switch, session restore and whenever the server matrix is republished (an
   * SSE PERMISSIONS slice or a successful matrix save): a role change can move
   * the base under an existing exception.
   *
   * A failed read clears the cache and falls back to the role matrix — the
   * display fails closed, and the server still enforces the real answer.
   */
  const refreshEffectivePermissions = React.useCallback(async () => {
    const user = currentUserRef.current;
    if (!user) {
      applyEffectivePermissions(null);
      return;
    }
    try {
      const resolved = await api.getMyPermissions();
      // A slow response for a profile the user already left must never
      // overwrite the new profile's resolved set.
      if (currentUserRef.current?.id !== user.id) return;
      applyEffectivePermissions(resolved.operations, resolved.role || user.role);
    } catch {
      if (currentUserRef.current?.id !== user.id) return;
      applyEffectivePermissions(null);
    } finally {
      if (currentUserRef.current?.id === user.id) {
        setPermissionsVersion((v) => v + 1);
      }
    }
  }, []);
  const refreshEffectivePermissionsRef = useRef(refreshEffectivePermissions);
  refreshEffectivePermissionsRef.current = refreshEffectivePermissions;

  useEffect(() => {
    void refreshEffectivePermissions();
  }, [currentUser?.id, refreshEffectivePermissions]);

  useEffect(() => {
    const handlePermissionsUpdated = () => {
      // The matrix is server data: re-read it from the module cache that only
      // applyServerMatrix() (bootstrap / successful PUT) is allowed to fill.
      setPermissionsMatrix(getPermissionsMatrix());
      setPermissionsVersion((v) => v + 1);
      // The effective set is the matrix plus this account's exceptions; the
      // matrix changing can change it, so resolve it again.
      void refreshEffectivePermissionsRef.current();
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
    if (
      !urlTabPendingRef.current &&
      prefs?.activeTab &&
      NAV_TABS.includes(prefs.activeTab as NavTab)
    ) {
      const nextTab = canonicalTab(prefs.activeTab as NavTab);
      if (nextTab !== activeTabRef.current) {
        // A server preference is restoration, not a click: replace the URL's
        // starting entry instead of inventing a Back destination.
        urlHistoryModeRef.current = 'replace';
        setRecordRoute(null);
        setActiveTab(nextTab);
      }
    }
    urlTabPendingRef.current = false;
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

  // App Data State is owned by BootstrapDataProvider; the root reads it here.
  const {
    companyProfile,
    branches,
    suppliers,
    users,
    products,
    categories,
    stock,
    inventorySerials, setInventorySerials,
    approvalRequests,
    purchaseOrders,
    purchaseInvoices,
    purchaseReturns,
    salesReturns,
    stockOperations,
    auditLogs,
    damageRecords,
    locations,
    financialSummary,
    postgresStatus, setPostgresStatus,
    bootstrapBlocked, setBootstrapBlocked,
    sliceState, setSliceState,
    apply,
  } = useBootstrapData();
  // DF-17: surfaced failures for the two App-owned reads whose errors used to
  // be console-only — the cached-payload settings backfill and the sellable-
  // serial list. Both have a Retry; the sellable list also clears on a branch
  // change so the Sell-to-Customer form never sees another branch's units.
  const [sellableSerialsError, setSellableSerialsError] = useState('');
  const [sellableSerialsLoading, setSellableSerialsLoading] = useState(false);
  const [settingsBackfillError, setSettingsBackfillError] = useState('');
  const [settingsBackfillLoading, setSettingsBackfillLoading] = useState(false);
  const [prepopulatedPOLines, setPrepopulatedPOLines] = useState<OrderFormLine[]>([]);
  // Procurement's draft lines for the purchase-order form (UI state, not bootstrap data).
  // VOL-3: shipments left the bootstrap payload. The shell, dashboard KPI,
  // notification center and receive lanes share one bounded scoped snapshot
  // (exact counts + every in-flight row + a recent window); the transfer
  // register pages its own reads through GET /api/shipments/page.
  const shipmentOverview = useShipmentOverview(selectedBranchId);
  const shipments = React.useMemo(
    () => mergeShipmentWindow(shipmentOverview.pending, shipmentOverview.recent),
    [shipmentOverview.pending, shipmentOverview.recent]
  );

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
  /** Only a KNOWN failure shows the setup banner; a 503 also owns the notice. */
  const databaseUnavailable = postgresStatus.statusKnown && !postgresStatus.isConnected;

  // C1/C2 hydration bookkeeping: the per-slice status table and the request
  // gate that stamps every slice fetch with its view (branch|FY) and sequence.
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
    // Slice replacement belongs to the provider: every key the payload
    // actually carried is applied there, keys it did not carry are untouched.
    apply(data);
    // Not workspace slices: the scope list and the product-group behaviour map
    // are owned by their contexts, so the root still hands them over.
    if (data.fiscalYears) setFiscalYears(data.fiscalYears);
    if (data.productGroups) setProductGroups(data.productGroups);
    // Cached payloads are display data, never proof of reachability: a
    // snapshot saved while the database was down must not paint "PostgreSQL
    // Offline" for the frames before the live bootstrap answers. Only a
    // response received in this session sets the banner's state.
    if (data.postgresDatabaseStatus && !options.fromCache) {
      setPostgresStatus({ ...data.postgresDatabaseStatus, statusKnown: true });
    }
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
  const DEFERRED_BOOTSTRAP_SLICES = [
    // SCALE-2: the master/stock arrays left the login payload. They hydrate
    // from the same targeted-slice endpoint the SSE refresh uses, after first
    // paint, so bootstrap stays bounded as the installation grows.
    'products',
    'stock',
    'suppliers',
    'categories',
    'productGroups',
    'uom',
    'locations',
    'approvalRequests',
    'damageRecords',
    'stockOperations',
    'purchaseOrders',
    'purchaseInvoices',
    // OPS-3: returns and the audit trail left the full payload. The returns
    // sheets still self-fetch their pages; this slice keeps the returnable-qty
    // calculation and the Activities Log fed without a login-sized array.
    'purchaseReturns',
    'salesReturns',
    'auditLogs',
  ];
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

  // useLayoutEffect, not useEffect: the cached payload must be applied in the
  // same commit as the shell's first mount. An effect runs AFTER the browser
  // paints the loading spinner, which is why a reload with a warm cache still
  // flashed "Synchronizing multi-branch inventory database..." for ~190 ms.
  // A layout effect flushes its state updates before paint, so the boot splash
  // hands over straight to the populated screen.
  useLayoutEffect(() => {
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
    bumpAll();
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
        // reachable. A 503 is the opposite case: the server answered, and its
        // reason belongs on the setup banner. Any other failure (no status —
        // the server itself is unreachable) proves nothing about PostgreSQL,
        // so the state stays unknown and the bootstrap notice carries it.
        if (status === 400 || status === 409) {
          setPostgresStatus((prev) => ({ ...prev, isConnected: true, statusKnown: true }));
        } else if (status === 503) {
          setPostgresStatus((prev) => ({
            ...prev,
            isConnected: false,
            statusKnown: true,
            errorDetails: err?.message || prev.errorDetails,
          }));
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

  // Domain mutations live in hooks/actionDeps-backed action hooks; the root only
  // passes the refresh and identity they stamp onto requests.
  const {
    handleCreateProduct,
    handleUpdateProduct,
    handleDeleteProduct,
    handleUpdateStockLevel,
    handleUpdateStockReorderLevel,
    handleBulkUpdateStockReorderLevels,
    handleCreateAsset,
    handleUpdateAssetStatus,
  } = useInventoryActions({ refreshAllData, currentUser, financialSummary });
  const {
    handleCreatePO,
    handleUpdatePO,
    handleUpdatePOStatus,
    handleDeletePO,
    handleCreateInvoice,
    handleCreatePurchaseReturn,
    handleCancelPurchaseReturn,
    handleApprovePurchaseReturn,
    handleDeleteInvoice,
    handleRecordPayment,
    handleReversePayment,
    handleReverseInvoicePayments,
    handleReceiveShipment,
    handleCancelReceiveShipment,
    handleFindShipment,
    handleCreateOperation,
    handleReceiveOperation,
    handleReverseStockOperation,
  } = useProcurementActions({ refreshAllData, currentUser, financialSummary, purchaseInvoices });
  const {
    handleCreateSalesInvoice,
    handleRecordCustomerPayment,
    handleCancelSalesInvoice,
    handleCreateSalesReturn,
    handleCancelSalesReturn,
    handleApproveSalesReturn,
  } = useSalesActions({ refreshAllData, currentUser, financialSummary });
  const {
    handleSetCurrentFiscalYear,
    handleCreateFiscalYear,
    handleDeleteFiscalYear,
    handleCloseFiscalYear,
    handleReopenFiscalYear,
    handleInitializeFiscalYearOpeningStock,
    handleRollForwardVendorOpenings,
  } = useFiscalActions({ refreshAllData, currentUser, financialSummary });
  const {
    handleCreateApprovalRequest,
    handleProcessApprovalRequest,
    handleCancelApprovalRequest,
  } = useWorkflowActions({ refreshAllData, currentUser, financialSummary });

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

  // Always-fresh scope for the SSE listener below (it must not re-subscribe
  // — and capture stale values — when only the fiscal year changes).
  const syncScopeRef = useRef({ branchId: selectedBranchId, fiscalYearId: selectedFiscalYearId || undefined });
  useEffect(() => {
    syncScopeRef.current = { branchId: selectedBranchId, fiscalYearId: selectedFiscalYearId || undefined };
  }, [selectedBranchId, selectedFiscalYearId]);

  const { registerRefresh, bumpAll } = useSyncStream({
    branchId: selectedBranchId,
    currentUser,
    scopeRef: syncScopeRef,
    serverDataVersionRef,
    refreshAllData: () => refreshAllDataRef.current(),
    fetchSlice: fetchBootstrapSlice,
    onBsCalendarChanged: () => {
      syncBsCalendarMirrorRef.current();
      broadcastBsCalendarUpdated();
    },
    onLogout: () => handleLogoutRef.current(),
  });

  // React to currentUser state changes & enforce branch/tab restrictions
  useEffect(() => {
    if (!currentUser) return;
    // Keep whatever valid view scope the user picked — including an assigned
    // secondary branch — and repair only a scope this account cannot read
    // (the previous profile's branch, or ALL for a branch account). Forcing
    // currentUser.branchId here made a multi-branch assignment unusable.
    const nextBranchId = resolveBranchSelection(currentUser, branches, selectedBranchId);
    if (nextBranchId !== selectedBranchId) setSelectedBranchId(nextBranchId);

    // Check for restricted tabs (permission matrix + super-admin-only tabs).
    // Re-check on every tab change and after the matrix is edited/saved. The
    // path is only a request: an unreadable one is replaced by Dashboard, never
    // left in the address bar as if the screen had opened.
    if (!canAccessTab(activeTab)) {
      urlHistoryModeRef.current = 'replace';
      setRecordRoute(null);
      setActiveTab('dashboard');
    }
  }, [currentUser, activeTab, permissionsVersion, branches, selectedBranchId]);

  // Branch selections are validated against the account's real branch scope:
  // assigned secondary branches pass, everything else falls back to the primary.
  const handleSelectBranch = (bId: string) => {
    setSelectedBranchId(resolveBranchSelection(currentUser, branches, bId));
  };

  // Auth actions
  const handleLogin = async (e: string, p: string) => {
    // Never carry the previous session's resolved set into a new sign-in.
    applyEffectivePermissions(null);
    const res = await api.login(e, p);
    setAuthToken(res.token);
    setCurrentUser(res.user);
    setRootUser(res.user);
    saveUserSession(res.user, res.user, res.token);
    refreshAllData();
  };

  const handleLogout = () => {
    // Multi-tab relay (#6): sign sibling tabs out in step — but name the
    // session that is ending, so a tab already on a newer token stays signed in.
    broadcastLogoutToOtherTabs(getAuthToken());
    setCurrentUser(null);
    setRootUser(null);
    setAuthToken(null);
    setUserContext(null);
    applyEffectivePermissions(null);
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
      // The previous profile's grants must not reveal its tabs for even one
      // frame under the new identity; the id-change effect resolves the new set.
      applyEffectivePermissions(null);
      // Branch-scoped caches are shared per branch, not per user. The previous
      // profile may have loaded branches this one cannot read; refetching them
      // with the new token is a 403 (the "branch stock could not be refreshed"
      // banner) and would also leave another profile's rows on screen. The
      // exchange and assignable-asset lists are session-scoped in the same way.
      resetBranchStock();
      resetExchangeDevices();
      resetAvailableFixedAssets();
      saveUserSession(res.user, nextRoot, res.token);
      // A branch-restricted profile cannot read the previous scope (often
      // ALL), but it CAN keep a secondary branch it is assigned. Switch the
      // scope in the SAME batch as the identity: otherwise bootstrap and the
      // shipment overview fire with the old branch filter and the new token,
      // and the server correctly answers 403.
      const nextBranchId = resolveBranchSelection(res.user, branches, selectedBranchId);
      if (nextBranchId !== selectedBranchId) {
        // The selectedBranchId effect performs the refresh with the new scope.
        setSelectedBranchId(nextBranchId);
      } else {
        await refreshAllData();
      }
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
      applyEffectivePermissions(null);
      // These caches are session-scoped: drop the switched profile's rows
      // before the root profile's refresh asks for every branch again.
      resetBranchStock();
      resetExchangeDevices();
      resetAvailableFixedAssets();
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

  const handleUpdateProfile = async (
    data: Partial<User> & { newPassword?: string; currentPassword?: string }
  ) => {
    const { token, ...updatedUser } = await api.updateProfile(data);
    setCurrentUser(updatedUser);
    const nextRoot = rootUser && rootUser.id === updatedUser.id ? updatedUser : rootUser;
    if (rootUser && rootUser.id === updatedUser.id) {
      setRootUser(updatedUser);
    }
    // A profile edit retires every token issued before it (the session
    // fingerprint covers email, branch and password), so the caller continues
    // on the fresh token the server returned instead of being signed out by
    // their own change.
    if (token) setAuthToken(token);
    saveUserSession(updatedUser, nextRoot, token);
    await refreshAllData();
  };

  // Product Actions
  // Stock Actions
  // Asset Actions
  // PO Actions
  // Invoice Actions
  // Voids a posted sales invoice. The server reverses it atomically (stock +
  // claimed serials + ledger) and refuses invoices that still carry payments
  // or credit notes; its message is surfaced by the screen.
  // Reverse all posted payments on a fully paid invoice (restores it to UNPAID)
  // Shipment Actions
  /** Resolve a manifest child path against the transfer register endpoint.
   *  The thin Shipments host and the receive panel stay server-call-free; the
   *  root owns this one bounded lookup for their deep links. */
  // Stock Operations Actions
  // Reverse a damage record (Super Admin / Inventory Manager only) — restores
  // the units back to available stock and marks the record CANCELLED.
  // Fiscal Year Actions
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
        className="app-shell"
      >
        <LoginModal
          onLoginSuccess={async (email, pass) => {
            setLoginNotice(null);
            await handleLogin(email, pass);
          }}
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

  // A login created from the employee record starts on a one-time password; the
  // server refuses every other endpoint, so the only next step is to replace it.
  if (currentUser.mustChangePassword) {
    return (
      <ForcePasswordChange
        user={currentUser}
        onDone={async (user, token) => {
          setAuthToken(token);
          setCurrentUser(user);
          setRootUser(user);
          saveUserSession(user, user, token);
          refreshAllData();
        }}
        onLogout={handleLogout}
      />
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
      handleSelectTab('users');
    } else if (isNavTab(tab)) {
      // A stale help link must not leave the workspace on an unnamed path.
      handleSelectTab(tab);
    }
  };

  const openUserAccess = (userId: string, operationId?: string) => {
    userAccessFocusSeq.current += 1;
    setUserAccessFocus({ userId, requestId: userAccessFocusSeq.current, operationId });
    setActiveTab('user-permissions');
  };

  // A4: the route table — every tab declared once, in render order, built
  // from the bundle below. The table itself lives in routes/screenRoutes.tsx;
  // AppRoutes owns the keep-mounted wiring and the permission metadata rides
  // on each entry.
  const routeProps: ScreenRouteProps = [
    activeTab, appSettings, assetReportAsOfDateAD, bsCalendarCoverage, bsCalendarSeedTab, companyProfile, currentUser, dateMode,
    fiscalYears, handleAppSettingChange, handleApprovePurchaseReturn, handleApproveSalesReturn, handleBulkUpdateStockReorderLevels, handleCancelApprovalRequest, handleCancelPurchaseReturn, handleCancelReceiveShipment,
    handleCancelSalesInvoice, handleCancelSalesReturn, handleCloseFiscalYear, handleCreateApprovalRequest, handleCreateAsset, handleCreateFiscalYear, handleCreateInvoice, handleCreateOperation,
    handleCreatePO, handleCreateProduct, handleCreatePurchaseReturn, handleCreateSalesInvoice, handleCreateSalesReturn, handleDeleteFiscalYear, handleDeleteInvoice, handleDeletePO,
    handleDeleteProduct, handleFindShipment, handleGroupLowStockPO, handleHelpNavigateTab, handleInitializeFiscalYearOpeningStock, handleLogout, handleProcessApprovalRequest, handleReceiveOperation,
    handleReceiveShipment, handleRecordCustomerPayment, handleRecordPayment, handleRecordRouteChange, handleReopenFiscalYear, handleReverseInvoicePayments, handleReversePayment, handleReverseStockOperation,
    handleRollForwardVendorOpenings, handleSelectBranch, handleSelectTab, handleSetCurrentFiscalYear, handleUpdateAssetStatus, handleUpdatePO, handleUpdatePOStatus, handleUpdateProduct,
    handleUpdateStockLevel, handleUpdateStockReorderLevel, ledgerPartyFocus, loadSellableSerials, openUserAccess, permissionsMatrix, prepopulatedPOLines, procurementPending,
    products, purchaseInvoices, purchaseOrders, purchaseReturns, recordRoute, refreshAllData, registerRefresh, resolveDefaultFiscalYear,
    salesReturns, searchQuery, selectedBranchId, selectedFiscalYear, selectedFiscalYearId, sellableSerialsError, sellableSerialsLoading, setActiveTab,
    setAppSettings, setLoginNotice, setSearchQuery, setSelectedBranchId, setSelectedFiscalYearId, settingsBackfillError, settingsBackfillLoading, shipments,
    stock, stockOperations, userAccessFocus,
  ];
  const screenRoutes: AppRoute[] = buildScreenRoutes(routeProps);

  return (
    <AppShell
      currentUser={currentUser}
      rootUser={rootUser}
      onSwitchBackToRoot={handleSwitchBackToRoot}
      onSwitchProfile={handleSwitchProfile}
      onUpdateProfile={handleUpdateProfile}
      onLogout={handleLogout}
      onLogin={handleLogin}
      refreshAllData={refreshAllData}
      permissionsVersion={permissionsVersion}
      onToggleTheme={handleToggleTheme}
      selectedBranchId={selectedBranchId}
      onSelectBranch={handleSelectBranch}
      dateMode={dateMode}
      onToggleDateMode={handleToggleDateMode}
      currentFiscalYear={activeFy}
      fiscalYears={fiscalYears}
      selectedFiscalYearId={selectedFiscalYearId}
      onSelectFiscalYear={setSelectedFiscalYearId}
      activeTab={activeTab}
      onSelectTab={handleSelectTab}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      pendingPurchaseOrders={procurementPending.pendingPurchaseOrders}
      unpaidBillCount={procurementPending.unpaidInvoiceCount}
      shipments={shipments}
      bsCalendarCoverage={bsCalendarCoverage}
      bsCalendarSeedTab={bsCalendarSeedTab}
      banners={
        <>
          {/* Direct PostgreSQL Database Setup Notification Banner */}
          <DatabaseSetupBanner
            onRefresh={refreshAllData}
            statusKnown={postgresStatus.statusKnown}
            postgresConfig={{
              host: postgresStatus.host,
              port: postgresStatus.port,
              database: postgresStatus.database,
              user: postgresStatus.user,
              isConnected: postgresStatus.isConnected,
              errorDetails: postgresStatus.errorDetails,
            }}
          />

          {/* Refused bootstrap: the server's own reason, not a database alarm.
              A 503 is already explained, with the setup steps, by the banner
              above — stacking both was the duplicate notice operators saw. */}
          {bootstrapBlocked && !databaseUnavailable && (
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
            showLoading={false}
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
            showLoading={false}
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
        className={`flex-1 overflow-y-auto [scrollbar-gutter:stable] p-2.5 sm:p-3.5 transition-colors duration-200 bg-[#e9ebee] dark:bg-[#0a0c10]`}
      >
        {loading ? (
          <div
            id="app-sync-spinner"
            className="flex flex-col items-center justify-center h-64 space-y-3"
          >
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
