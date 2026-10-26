import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NAVIGATE_TAB_EVENT } from '../../services/api/http';
import type {
  ApprovalRequest,
  Asset,
  Branch,
  CompanyProfile,
  FiscalYear,
  InventoryStock,
  Product,
  PurchaseInvoice,
  PurchaseOrder,
  Shipment,
  StockOperation,
  Supplier,
  User,
} from '../../types';
import { getBsCalendarCoverage, type BsCalendarCoverageStatus } from '../../utils/nepaliCalendar';
import {
  ShellOverlayProvider,
  type ShellOverlayActions,
} from '../../contexts/ShellOverlayContext';
import { Header } from './Header';
import { Sidebar, type NavTab } from './Sidebar';
import { BarcodeScannerModal } from '../common/BarcodeScannerModal';
import { GlobalSearchModal } from '../common/GlobalSearchModal';
import { NotificationCenter } from '../common/NotificationCenter';
import { ProfileSwitchModal } from '../common/ProfileSwitchModal';
import { ToastHost } from '../common/ToastHost';

/**
 * A2 — the application chrome owns its own UI state.
 *
 * Before this component, the sidebar/modal/notification flags lived in `App`, so
 * toggling the sidebar or opening a modal re-rendered the root and with it the
 * whole tab tree. They now live here, next to the chrome that uses them, and
 * `App` renders this component with the workspace (`children`) and the bootstrap
 * banners (`banners`) as **elements**. A shell state change re-renders only this
 * component; React sees the same `children` element object and skips the tab
 * tree entirely (the A1 element cache then skips the screens themselves).
 *
 * Nothing about data freshness changes: every array, the selected branch/fiscal
 * year, the active tab and the shared search text still arrive as props from
 * App, and the badge counts are derived from those same props here — the
 * dismissed-notification ids and the badges that read them simply moved
 * together.
 */
export interface AppShellProps {
  // Session & profile
  companyProfile: CompanyProfile | null;
  currentUser: User;
  rootUser: User | null;
  users: User[];
  onSwitchBackToRoot: () => Promise<void>;
  onSwitchProfile: (targetUserId: string) => Promise<void>;
  onUpdateProfile: (data: Partial<User> & { newPassword?: string }) => Promise<void>;
  onLogout: () => void;
  onLogin: (email: string, pass: string) => Promise<void>;
  refreshAllData: () => void;
  permissionsVersion: number;
  onToggleTheme: () => void;

  // View scope
  branches: Branch[];
  selectedBranchId: string;
  onSelectBranch: (branchId: string) => void;
  dateMode: 'BS' | 'AD';
  onToggleDateMode: () => void;
  currentFiscalYear: string;
  fiscalYears: FiscalYear[];
  selectedFiscalYearId: string;
  onSelectFiscalYear: (fiscalYearId: string) => void;

  // Navigation + the shared search text (tab screens consume it as a prop)
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;

  // Data the chrome reads (badges, search modal, notifications, barcode labels)
  products: Product[];
  stock: InventoryStock[];
  /** Full PO slice — the global search modal searches every document. */
  purchaseOrders: PurchaseOrder[];
  /** Full invoice slice — the global search modal searches every document. */
  purchaseInvoices: PurchaseInvoice[];
  /** Scoped open POs for badges + the notification panel (KPI read). */
  pendingPurchaseOrders: PurchaseOrder[];
  /** Unpaid vendor-bill count for the sidebar badge (server-filtered). */
  unpaidBillCount: number;
  shipments: Shipment[];
  stockOperations: StockOperation[];
  approvalRequests: ApprovalRequest[];
  assets: Asset[];
  suppliers: Supplier[];
  bsCalendarCoverage: BsCalendarCoverageStatus | null;
  bsCalendarSeedTab: NavTab;

  /** Bootstrap / database banners shown between the header and the workspace. */
  banners: React.ReactNode;
  /** The workspace viewport (App's `<main>`, tab tree included), passed as an element. */
  children: React.ReactNode;
}

/** Every overlay AppShell owns — the set Escape may close (topmost first out). */
type ShellOverlayId = 'barcode' | 'search' | 'notifications' | 'profile';

const SHELL_OVERLAY_IDS: readonly ShellOverlayId[] = [
  'barcode',
  'search',
  'notifications',
  'profile',
];

export function AppShell(props: AppShellProps) {
  // --- shell-only UI state (A2) -------------------------------------------
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isBarcodeModalOpen, setIsBarcodeModalOpen] = useState(false);
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<string[]>([]);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);

  // Escape closes the overlay that was opened LAST (the one on top), not a
  // fixed one: with the search dialog open over the notification drawer, Esc
  // must dismiss the dialog first and the drawer on the next press. The stack
  // is reconciled after every open/close render, so a close by X or backdrop
  // removes its entry too.
  const overlayOrderRef = useRef<ShellOverlayId[]>([]);

  // Focus origin of each overlay, so closing it hands focus BACK to the control
  // that opened it instead of dropping it on <body> (which also resets keyboard
  // users to the top of the page). It is recorded when the overlay OPENS, before
  // its own autofocus can run, so the modal's input cannot become the origin.
  const focusOriginRef = useRef<Record<ShellOverlayId, HTMLElement | null>>({
    barcode: null,
    search: null,
    notifications: null,
    profile: null,
  });

  const rememberFocusOrigin = useCallback((id: ShellOverlayId) => {
    const active = document.activeElement;
    focusOriginRef.current[id] =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }, []);

  const restoreFocusOrigin = useCallback((id: ShellOverlayId) => {
    const origin = focusOriginRef.current[id];
    focusOriginRef.current[id] = null;
    // The origin can be gone by now: the profile modal is opened from a menu
    // item that unmounts when the menu closes. Those fall back to the header
    // control that represents the overlay.
    const target =
      origin && origin.isConnected
        ? origin
        : document.querySelector<HTMLElement>(`[data-shell-trigger="${id}"]`);
    target?.focus();
  }, []);

  useEffect(() => {
    const open: Record<ShellOverlayId, boolean> = {
      barcode: isBarcodeModalOpen,
      search: isGlobalSearchOpen,
      notifications: isNotificationOpen,
      profile: isProfileModalOpen,
    };
    const stillOpen = overlayOrderRef.current.filter((id) => open[id]);
    for (const id of SHELL_OVERLAY_IDS) {
      if (open[id] && !stillOpen.includes(id)) stillOpen.push(id);
    }
    overlayOrderRef.current = stillOpen;
  }, [isBarcodeModalOpen, isGlobalSearchOpen, isNotificationOpen, isProfileModalOpen]);

  // Restore focus on every open→closed transition, whichever path closed it
  // (Escape, the X, the backdrop, picking a result, or a navigation event).
  const previouslyOpenRef = useRef<Record<ShellOverlayId, boolean>>({
    barcode: false,
    search: false,
    notifications: false,
    profile: false,
  });
  useEffect(() => {
    const open: Record<ShellOverlayId, boolean> = {
      barcode: isBarcodeModalOpen,
      search: isGlobalSearchOpen,
      notifications: isNotificationOpen,
      profile: isProfileModalOpen,
    };
    for (const id of SHELL_OVERLAY_IDS) {
      if (previouslyOpenRef.current[id] && !open[id]) restoreFocusOrigin(id);
    }
    previouslyOpenRef.current = open;
  }, [
    isBarcodeModalOpen,
    isGlobalSearchOpen,
    isNotificationOpen,
    isProfileModalOpen,
    restoreFocusOrigin,
  ]);

  // Setters are stable, so this never changes identity — safe for the global
  // key listener's deps and for anything that wants to close an overlay.
  const closeShellOverlay = useCallback((id: ShellOverlayId) => {
    if (id === 'barcode') setIsBarcodeModalOpen(false);
    else if (id === 'search') setIsGlobalSearchOpen(false);
    else if (id === 'notifications') setIsNotificationOpen(false);
    else setIsProfileModalOpen(false);
  }, []);

  // Opening is centralised so the focus origin is recorded exactly once, before
  // the overlay renders (and its input autofocuses).
  const openShellOverlay = useCallback(
    (id: ShellOverlayId) => {
      rememberFocusOrigin(id);
      if (id === 'barcode') setIsBarcodeModalOpen(true);
      else if (id === 'search') setIsGlobalSearchOpen(true);
      else if (id === 'notifications') setIsNotificationOpen(true);
      else setIsProfileModalOpen(true);
    },
    [rememberFocusOrigin]
  );

  const toggleShellOverlay = useCallback(
    (id: ShellOverlayId) => {
      // `previouslyOpenRef` mirrors the committed open state, so a toggle that
      // opens records the origin and one that closes leaves restoration to the
      // transition effect above.
      if (!previouslyOpenRef.current[id]) rememberFocusOrigin(id);
      if (id === 'barcode') setIsBarcodeModalOpen((prev) => !prev);
      else if (id === 'search') setIsGlobalSearchOpen((prev) => !prev);
      else if (id === 'notifications') setIsNotificationOpen((prev) => !prev);
      else setIsProfileModalOpen((prev) => !prev);
    },
    [rememberFocusOrigin]
  );

  const {
    companyProfile,
    currentUser,
    rootUser,
    users,
    onSwitchBackToRoot,
    onSwitchProfile,
    onUpdateProfile,
    onLogout,
    onLogin,
    refreshAllData,
    permissionsVersion,
    onToggleTheme,
    branches,
    selectedBranchId,
    onSelectBranch,
    dateMode,
    onToggleDateMode,
    currentFiscalYear,
    fiscalYears,
    selectedFiscalYearId,
    onSelectFiscalYear,
    activeTab,
    onSelectTab,
    searchQuery,
    onSearchChange,
    products,
    stock,
    purchaseOrders,
    purchaseInvoices,
    pendingPurchaseOrders,
    unpaidBillCount,
    shipments,
    stockOperations,
    approvalRequests,
    assets,
    suppliers,
    bsCalendarCoverage,
    bsCalendarSeedTab,
    banners,
    children,
  } = props;

  // --- badge + notification derivations (moved with the dismissed ids) -----
  // Consolidated low-stock SKU count respecting the selected branch context and
  // per-branch thresholds.
  const lowStockProducts = products.filter((prod) => {
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
  });

  // Dismissed notification ids are shared across the header badge, the sidebar
  // badges and the Notification Center panel, so clearing notifications in the
  // panel also clears the matching badges/menus elsewhere in the app.
  const dismissedSet = new Set(dismissedNotificationIds);

  // KPI counts come from the scoped pending-procurement read, not the whole
  // purchase slices: dismissed PO notifications still subtract by id, while
  // the unpaid bill count is the server-aggregated total for this branch/FY.
  const pendingPoCount = pendingPurchaseOrders.filter(
    (po) => (po.status === 'SENT' || po.status === 'APPROVED') && !dismissedSet.has(`po-${po.id}`)
  ).length;

  const pendingBillCount = unpaidBillCount;

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
          sh.sourceBranchId === activeBranchContext) &&
        !dismissedSet.has(`ship-${sh.id}`)
    ).length + pendingPulloutsCount;

  // Lane-scoped pending counts: each receive station's badge only counts the
  // shipments that station can actually receive (warehouse lane incl. pending
  // pullout bins, vs the active branch's inbound transfer lane) instead of one
  // shared in-transit number shown on every receive nav item.
  const isWarehouseDestination = (branchId: string) => {
    const destBranch = branches.find((x) => x.id === branchId);
    return (
      branchId === 'WH001' ||
      Boolean(destBranch?.isHeadquarters || destBranch?.isWarehouse) ||
      (destBranch?.code || '').toUpperCase().startsWith('WH') ||
      /warehouse|head office/i.test(destBranch?.name || '')
    );
  };
  const isPendingShipment = (sh: (typeof shipments)[number]) =>
    (sh.status === 'IN_TRANSIT' || sh.status === 'DISPATCHED') &&
    !dismissedSet.has(`ship-${sh.id}`);
  const warehouseInboundCount =
    shipments.filter(
      (sh) => isPendingShipment(sh) && isWarehouseDestination(sh.destinationBranchId)
    ).length + pendingPulloutsCount;
  const branchInboundCount = shipments.filter(
    (sh) =>
      isPendingShipment(sh) &&
      !isWarehouseDestination(sh.destinationBranchId) &&
      (activeBranchContext === 'ALL' || sh.destinationBranchId === activeBranchContext)
  ).length;

  const lowStockCount = lowStockProducts.filter(
    (p) => !dismissedSet.has(`lowstock-${p.id}`)
  ).length;
  const pendingApprovalCount = approvalRequests.filter(
    (r) => r.status === 'PENDING' && !dismissedSet.has(`appr-${r.id}`)
  ).length;

  // Stable overlay actions for screens inside the tab tree (A2). Memoised on the
  // setters, which never change, so opening a modal does not re-render the
  // consumers of this context.
  const overlayActions = useMemo<ShellOverlayActions>(
    () => ({
      openBarcodeScanner: () => openShellOverlay('barcode'),
      openGlobalSearch: () => openShellOverlay('search'),
      openNotifications: () => openShellOverlay('notifications'),
      openProfile: () => openShellOverlay('profile'),
    }),
    [openShellOverlay]
  );

  // A shell overlay is a surface ABOVE the header's account menu: the menu's own
  // Escape handler defers to this flag, so one press closes one thing.
  const isShellOverlayOpen =
    isBarcodeModalOpen || isGlobalSearchOpen || isNotificationOpen || isProfileModalOpen;

  // Global keyboard shortcuts (A2 moved them here with the overlays they open):
  // Alt+H help, Alt+B barcode, Alt+S / Ctrl+K search, Alt+D date mode. They used
  // to live in App and re-rendered the whole tab tree on every key.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape closes the overlay on top — handled BEFORE the editing-field
      // guard, because the global search input is exactly where Escape is most
      // likely to be pressed and it must still close the dialog. With no
      // overlay open the key is left alone for the screen underneath.
      if (e.key === 'Escape') {
        const order = overlayOrderRef.current;
        const top = order[order.length - 1];
        if (top) {
          e.preventDefault();
          closeShellOverlay(top);
        }
        return;
      }

      const target = e.target as HTMLElement | null;
      const isEditingField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName || '');
      if (isEditingField) return;
      // While inside the Fiscal Year Closing Wizard, global search & barcode
      // overlays must not be able to open on top of it (focus-hijack guard).
      const closingWizardActive = activeTab === 'fiscal-year-closing';

      // Alt + H -> In-App Help & Documentation Center
      if (e.altKey && (e?.key || '').toLowerCase() === 'h') {
        e.preventDefault();
        onSelectTab('help-documentation');
      }
      // Alt + B -> Barcode Scanner (suppressed while closing wizard is open)
      if (e.altKey && (e?.key || '').toLowerCase() === 'b') {
        e.preventDefault();
        if (!closingWizardActive) toggleShellOverlay('barcode');
      }
      // Alt + S or Ctrl + K -> Global Search (suppressed while closing wizard is open)
      if (
        (e.altKey && (e?.key || '').toLowerCase() === 's') ||
        ((e.ctrlKey || e.metaKey) && (e?.key || '').toLowerCase() === 'k')
      ) {
        e.preventDefault();
        if (!closingWizardActive) toggleShellOverlay('search');
      }
      // Alt + D -> Date Mode Toggle (BS / AD)
      if (e.altKey && (e?.key || '').toLowerCase() === 'd') {
        e.preventDefault();
        onToggleDateMode();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab, onSelectTab, onToggleDateMode, closeShellOverlay, toggleShellOverlay]);

  // Sibling tabs / toasts can request a tab change (App owns the permission
  // check); the notification panel is shell state, so close it here.
  useEffect(() => {
    const closeNotifications = () => setIsNotificationOpen(false);
    window.addEventListener(NAVIGATE_TAB_EVENT, closeNotifications);
    return () => window.removeEventListener(NAVIGATE_TAB_EVENT, closeNotifications);
  }, []);

  const handleDismissNotification = (id: string) => {
    setDismissedNotificationIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  };

  const handleClearAllNotifications = () => {
    // Collect every currently active notification id (same ids the
    // Notification Center generates) and mark them all dismissed.
    const activeIds: string[] = [
      ...lowStockProducts.map((prod) => `lowstock-${prod.id}`),
      ...approvalRequests
        .filter((r) => r.status === 'PENDING')
        .map((r) => `appr-${r.id}`),
      ...shipments
        .filter((sh) => sh.status === 'IN_TRANSIT' || sh.status === 'DISPATCHED')
        .map((sh) => `ship-${sh.id}`),
      ...pendingPurchaseOrders
        .filter((po) => po.status === 'SENT' || po.status === 'APPROVED')
        .map((po) => `po-${po.id}`),
      // The BS calendar coverage warning is a notification too, so "Clear All"
      // must dismiss it (otherwise it reappears on the next render).
      ...(getBsCalendarCoverage().status === 'OK' ? [] : ['bs-calendar-coverage']),
    ];
    setDismissedNotificationIds((prev) => Array.from(new Set([...prev, ...activeIds])));
  };

  return (
    <div
      className={`h-screen w-screen overflow-hidden font-sans flex flex-col antialiased transition-colors duration-200 bg-[#f0f2f5] text-slate-800 dark:bg-[#0a0c10] dark:text-slate-300`}
    >
      {/* Top App Header (Fixed at top) */}
      <Header
        companyProfile={companyProfile}
        currentUser={currentUser}
        rootUser={rootUser}
        onSwitchBackToRoot={onSwitchBackToRoot}
        users={users}
        onSwitchProfile={onSwitchProfile}
        branches={branches}
        selectedBranchId={selectedBranchId}
        onSelectBranch={onSelectBranch}
        dateMode={dateMode}
        onToggleDateMode={onToggleDateMode}
        currentFiscalYear={currentFiscalYear}
        fiscalYears={fiscalYears}
        selectedFiscalYearId={selectedFiscalYearId}
        onSelectFiscalYear={onSelectFiscalYear}
        onOpenBarcodeModal={() => openShellOverlay('barcode')}
        onOpenSearchModal={
          activeTab === 'fiscal-year-closing' ? undefined : () => openShellOverlay('search')
        }
        onLogout={onLogout}
        onSwitchUser={onLogin}
        onRefreshData={refreshAllData}
        searchQuery={searchQuery}
        onSearchChange={onSearchChange}
        lowStockCount={lowStockCount}
        onToggleTheme={onToggleTheme}
        onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
        isSidebarOpen={isSidebarOpen}
        products={products}
        stock={stock}
        approvalRequests={approvalRequests}
        purchaseOrders={purchaseOrders}
        shipments={shipments}
        onSelectTab={onSelectTab}
        onOpenNotification={() => toggleShellOverlay('notifications')}
        onOpenProfileModal={() => openShellOverlay('profile')}
        isShellOverlayOpen={isShellOverlayOpen}
      />

      {banners}

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
              onSelectTab(tab);
              setIsSidebarOpen(false); // Auto close sidebar on mobile selection
            }}
            lowStockCount={lowStockCount}
            pendingPoCount={pendingPoCount}
            pendingBillCount={pendingBillCount}
            inTransitShipmentCount={inTransitShipmentCount}
            warehouseInboundCount={warehouseInboundCount}
            branchInboundCount={branchInboundCount}
            pendingApprovalCount={pendingApprovalCount}
            onCloseMobile={() => setIsSidebarOpen(false)}
            permissionsVersion={permissionsVersion}
          />
        </div>

        {/* The workspace is App's element: a shell re-render hands React the
            same object, so the tab tree below it is skipped (A2 + A1). The
            overlay actions sit beside the tree, not in App. */}
        <ShellOverlayProvider value={overlayActions}>{children}</ShellOverlayProvider>
      </div>

      {/* Barcode & Serial Scanner / Printable Label Modal */}
      <BarcodeScannerModal
        isOpen={isBarcodeModalOpen}
        onClose={() => setIsBarcodeModalOpen(false)}
        products={products}
        companyProfile={companyProfile}
      />

      {/* Global Quick Search Modal */}
      <GlobalSearchModal
        isOpen={isGlobalSearchOpen}
        onClose={() => setIsGlobalSearchOpen(false)}
        searchQuery={searchQuery}
        onSearchChange={onSearchChange}
        // TRIM-1: the growing registers are fetched by the modal from the
        // bounded search endpoint; only the small reference tables stay local.
        suppliers={suppliers}
        branches={branches}
        selectedBranchId={selectedBranchId}
        onSelectResult={(tab, filterText) => {
          onSelectTab(tab);
          if (filterText !== undefined) {
            onSearchChange(filterText);
          }
          setIsGlobalSearchOpen(false);
        }}
      />

      {/* Realtime Notification & Action Center Modal */}
      <NotificationCenter
        isOpen={isNotificationOpen}
        onClose={() => setIsNotificationOpen(false)}
        products={products}
        stock={stock}
        approvalRequests={approvalRequests}
        pendingPurchaseOrders={pendingPurchaseOrders}
        shipments={shipments}
        branches={branches}
        selectedBranchId={selectedBranchId}
        onSelectTab={(tab) => {
          onSelectTab(tab as NavTab);
          setIsNotificationOpen(false);
        }}
        dismissedIds={dismissedNotificationIds}
        onDismiss={handleDismissNotification}
        onClearAll={handleClearAllNotifications}
        bsCalendarCoverage={bsCalendarCoverage}
        bsCalendarSeedTab={bsCalendarSeedTab}
      />

      {/* User Profile Info & Profile Switching Modal */}
      <ProfileSwitchModal
        isOpen={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
        currentUser={currentUser}
        rootUser={rootUser}
        onSwitchBackToRoot={onSwitchBackToRoot}
        users={users}
        branches={branches}
        onSwitchProfile={onSwitchProfile}
        onUpdateProfile={onUpdateProfile}
        onLogout={onLogout}
      />

      {/* Global API-failure toast (fetchJson broadcasts the intent) */}
      <ToastHost />
    </div>
  );
}
