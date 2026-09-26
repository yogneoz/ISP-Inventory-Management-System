import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  LayoutDashboard,
  Package,
  Store,
  Bell,
  AlertTriangle,
  DollarSign,
  BookOpen,
  Building,
  Smartphone,
  ShoppingCart,
  FilePlus,
  FileText,
  PlusCircle,
  Receipt,
  Truck,
  Send,
  Inbox,
  Layers,
  ArrowUpRight,
  HeartOff,
  PackageMinus,
  Wrench,
  Settings,
  Building2,
  Users,
  UserCheck,
  ShieldCheck,
  ClipboardList,
  ChevronLeft,
  ChevronDown,
  ChevronsDownUp,
  X,
  Search,
  Scale,
  Calculator,
  SlidersHorizontal,
  Grid,
  Ruler,
  UploadCloud,
  DownloadCloud,
  MapPin,
  UserPlus,
  ClipboardCheck,
  CalendarDays,
  HelpCircle,
  RefreshCw,
  Trash2,
  Wallet,
} from 'lucide-react';
import { User, CompanyProfile } from '../../types';
import { getCompanyLocation } from '../../utils/companyProfile';
import { isOperationAllowed } from '../../utils/permissions';
import { useDarkMode } from '../../contexts/DarkModeContext';

export type NavTab =
  | 'dashboard'
  | 'approvals'
  | 'workflow-approval'
  | 'all-stock'
  | 'branch-stock'
  | 'reorder-stock'
  | 'damaged-stock'
  | 'stock-valuation'
  | 'stock-ledger'
  | 'physical-stock-audit'
  | 'fixed-assets'
  | 'customers'
  | 'customer-devices'
  | 'complete-serial-inventory'
  | 'locations'
  | 'product-master'
  | 'opening-stock'
  | 'category-management'
  | 'uom-management'
  | 'import-stock'
  | 'export-stock'
  | 'create-po'
  | 'po-list'
  | 'create-purchase'
  | 'purchase-list'
  | 'create-shipment'
  | 'create-transfer'
  | 'receive-shipment'
  | 'receive-branch-transfer'
  | 'shipment-list'
  | 'pullout'
  | 'damage'
  | 'pullout-report'
  | 'damage-report'
  | 'stock-out'
  | 'assign-asset'
  | 'consumable-issue'
  | 'consumables-register'
  | 'device-exchange'
  | 'branches'
  | 'suppliers'
  | 'users'
  | 'import-customers'
  | 'permissions'
  | 'financial-statements'
  | 'vendor-ledger'
  | 'vendor-opening-balances'
  | 'vat-register'
  | 'depreciation-register'
  | 'nepali-fiscal'
  | 'bs-calendar'
  | 'fiscal-year-management'
  | 'fiscal-year-closing'
  | 'audit'
  | 'warranty-products'
  | 'company-setup'
  | 'data-recalculation'
  | 'help-documentation'
  | 'clear-demo-data';

/** Every valid NavTab id, used to validate the tab restored from localStorage. */
export const NAV_TABS: NavTab[] = [
  'dashboard',
  'approvals',
  'workflow-approval',
  'all-stock',
  'branch-stock',
  'reorder-stock',
  'damaged-stock',
  'stock-valuation',
  'stock-ledger',
  'physical-stock-audit',
  'fixed-assets',
  'customers',
  'customer-devices',
  'complete-serial-inventory',
  'locations',
  'product-master',
  'opening-stock',
  'category-management',
  'uom-management',
  'import-stock',
  'export-stock',
  'create-po',
  'po-list',
  'create-purchase',
  'purchase-list',
  'create-shipment',
  'create-transfer',
  'receive-shipment',
  'receive-branch-transfer',
  'shipment-list',
  'pullout',
  'damage',
  'pullout-report',
  'damage-report',
  'stock-out',
  'assign-asset',
  'consumable-issue',
  'consumables-register',
  'device-exchange',
  'branches',
  'suppliers',
  'users',
  'import-customers',
  'permissions',
  'financial-statements',
  'vendor-ledger',
  'vendor-opening-balances',
  'vat-register',
  'depreciation-register',
  'nepali-fiscal',
  'bs-calendar',
  'fiscal-year-management',
  'fiscal-year-closing',
  'audit',
  'warranty-products',
  'company-setup',
  'data-recalculation',
  'help-documentation',
  'clear-demo-data',
];

interface SidebarProps {
  companyProfile?: CompanyProfile | null;
  currentUser?: User | null;
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  lowStockCount: number;
  pendingPoCount: number;
  pendingBillCount: number;
  inTransitShipmentCount: number;
  pendingApprovalCount?: number;
  onCloseMobile?: () => void;
  /**
   * Opional revision counter bumped whenever the permission matrix is
   * saved/imported. Forces the Sidebar to recompute visible nav groups so
   * granted/revoked permissions apply immediately without a reload.
   */
  permissionsVersion?: number;
}

interface NavChildDef {
  id: NavTab;
  label: string;
  icon: React.ElementType;
  badge?: number;
  badgeColor?: string;
  hasSeparatorAbove?: boolean;
}

interface NavGroupDef {
  id: string;
  title: string;
  icon: React.ElementType;
  badgeCount?: number;
  children: NavChildDef[];
}

export const Sidebar: React.FC<SidebarProps> = ({
  companyProfile,
  currentUser,
  activeTab,
  onSelectTab,
  lowStockCount,
  pendingPoCount,
  pendingBillCount,
  inTransitShipmentCount,
  pendingApprovalCount,
  onCloseMobile,
  permissionsVersion,
}) => {
  const { isDarkMode } = useDarkMode();
  const isSuperAdmin = currentUser?.role === 'SUPER_ADMIN';
  const isBranchUser = Boolean(currentUser?.branchId && currentUser.branchId !== 'ALL' && !isSuperAdmin);

  // Build filtered navigation groups based on role permissions.
  // 8 consolidated groups (was 11): Serial & Device Tracking merged into
  // Overview; Fixed Assets + Fiscal Year Opening Register merged into Finance;
  // Import/Export Stock moved from Administration into Inventory & Stock.
  // Help & Documentation became a footer link. Every item keeps its own
  // permission gating, badges, and separators — only group placement changed.
  const groups: NavGroupDef[] = [];

  // 1. Overview Group (dashboard + approvals + serial/device tracking)
  const dashboardChildren: NavChildDef[] = [
    { id: 'dashboard' as NavTab, label: 'Executive Dashboard', icon: LayoutDashboard },
    ...(isOperationAllowed('workflow-approval', currentUser?.role) || isOperationAllowed('workflow-approval-cancel', currentUser?.role)
      ? [
          {
            id: 'approvals' as NavTab,
            label: 'Workflow Approval Center',
            icon: ShieldCheck,
            badge: pendingApprovalCount,
            badgeColor: 'bg-amber-500 text-white',
          },
        ]
      : []),
    ...(isOperationAllowed('prod-view', currentUser?.role)
      ? [{ id: 'complete-serial-inventory' as NavTab, label: 'Serial Log Register', icon: Package, hasSeparatorAbove: true }]
      : []),
    { id: 'customer-devices' as NavTab, label: 'Customer Device Serials', icon: Smartphone },
    { id: 'warranty-products' as NavTab, label: 'View Warranty Products', icon: ShieldCheck },
    { id: 'device-exchange' as NavTab, label: 'Device Exchange & Replacement', icon: RefreshCw },
  ];
  groups.push({
    id: 'dashboard',
    title: 'Overview',
    icon: LayoutDashboard,
    children: dashboardChildren,
  });

  // 2. Inventory & Stock Group (incl. Import/Export moved from Administration)
  const inventoryChildren = [
    ...(!isBranchUser ? [{ id: 'all-stock' as NavTab, label: 'All Available Stock', icon: Package }] : []),
    {
      id: 'branch-stock' as NavTab,
      label: isBranchUser ? 'My Branch Stock' : 'Branch Stock Matrix',
      icon: Store,
    },
    { id: 'stock-ledger' as NavTab, label: 'Stock Movement Ledger', icon: BookOpen },
    {
      id: 'physical-stock-audit' as NavTab,
      label: 'Physical Stock Count Audit',
      icon: ClipboardCheck,
    },
    {
      id: 'reorder-stock' as NavTab,
      label: 'Reorder Level Manager',
      icon: Bell,
      badge: lowStockCount,
      badgeColor: 'bg-rose-500 text-white',
    },
    {
      id: 'damaged-stock' as NavTab,
      label: 'Damaged Stock Matrix',
      icon: AlertTriangle,
    },
    ...(isOperationAllowed('stock-valuation', currentUser?.role)
      ? [{ id: 'stock-valuation' as NavTab, label: 'Stock Valuation & Insights', icon: DollarSign }]
      : []),
    ...(isOperationAllowed('stock-import-export', currentUser?.role)
      ? [
          { id: 'import-stock' as NavTab, label: 'Import Stock Data', icon: UploadCloud, hasSeparatorAbove: true },
          { id: 'export-stock' as NavTab, label: 'Export Stock Data & Reports', icon: DownloadCloud },
        ]
      : []),
  ];
  groups.push({
    id: 'inventory',
    title: 'Inventory & Stock',
    icon: Package,
    badgeCount: lowStockCount,
    children: inventoryChildren,
  });

  // 3. Procurement Group
  // Each former in-page tab header is exposed as its own menu item;
  // clicking a menu renders only that page (in-page tab bars are hidden).
  const canCreatePoAtRole = isOperationAllowed('po-create', currentUser?.role);
  const canCreateInvoiceAtRole = isOperationAllowed('inv-create', currentUser?.role);
  // Create pages stay together, then the register pages stay together.
  // Register pages include their own CSV export actions (no separate report menus).
  const procurementChildren: NavChildDef[] = [
    ...(canCreatePoAtRole
      ? [
          {
            id: 'create-po' as NavTab,
            label: 'Create Purchase Order',
            icon: FilePlus,
          },
        ]
      : []),
    ...(canCreateInvoiceAtRole
      ? [
          {
            id: 'create-purchase' as NavTab,
            label: 'Create Purchase Bill',
            icon: PlusCircle,
          },
        ]
      : []),
    {
      id: 'po-list' as NavTab,
      label: 'Purchase Orders Register',
      icon: FileText,
      badge: pendingPoCount,
      badgeColor: 'bg-indigo-600 text-white',
      hasSeparatorAbove: true,
    },
    {
      id: 'purchase-list' as NavTab,
      label: 'Purchase Bills Register',
      icon: Receipt,
      badge: pendingBillCount,
      badgeColor: 'bg-amber-500 text-white',
    },
  ];
  groups.push({
    id: 'procurement',
    title: 'Procurement & Purchasing',
    icon: ShoppingCart,
    badgeCount: pendingPoCount + pendingBillCount,
    children: procurementChildren,
  });

  // 4. Warehouse & Transfers Group (warehouse dispatch/receive + inter-branch transfers + pullouts)
  const warehouseChildren: NavChildDef[] = [];
  if (isOperationAllowed('shipment-create', currentUser?.role)) {
    warehouseChildren.push({ id: 'create-shipment' as NavTab, label: 'Warehouse Shipment Dispatch', icon: Send });
  }
  if (isOperationAllowed('wh-receive-pullouts', currentUser?.role)) {
    warehouseChildren.push({
      id: 'receive-shipment' as NavTab,
      label: 'Receive Inbound Stock & Pullouts',
      icon: Inbox,
      badge: inTransitShipmentCount,
      badgeColor: 'bg-amber-500 text-white',
    });
  }
  if (isOperationAllowed('branch-transfer-create', currentUser?.role)) {
    warehouseChildren.push({ id: 'create-transfer' as NavTab, label: 'Create Inter-Branch Transfer', icon: Send });
  }
  if (isOperationAllowed('branch-transfer-receive', currentUser?.role)) {
    warehouseChildren.push({
      id: 'receive-branch-transfer' as NavTab,
      label: 'Receive Branch Stock Transfer',
      icon: Inbox,
      badge: inTransitShipmentCount,
      badgeColor: 'bg-amber-500 text-white',
    });
  }
  if (isOperationAllowed('branch-pullout-dispatch', currentUser?.role)) {
    warehouseChildren.push({ id: 'pullout' as NavTab, label: 'Create Warehouse Pullout Bin', icon: ArrowUpRight });
  }
  if (warehouseChildren.length > 0) {
    warehouseChildren.push({
      id: 'pullout-report' as NavTab,
      label: 'Warehouse Pullout Report',
      icon: ClipboardList,
      hasSeparatorAbove: true,
    });
    groups.push({
      id: 'logistics',
      title: 'Warehouse & Transfers',
      icon: Truck,
      badgeCount: inTransitShipmentCount,
      children: warehouseChildren,
    });
  }

  // 5. Branch Operations Group (sales, consumables, damages, asset assignment)
  const branchOpsChildren: NavChildDef[] = [
    ...(isOperationAllowed('stock-out', currentUser?.role)
      ? [{ id: 'stock-out' as NavTab, label: 'Product Sale to Customer', icon: PackageMinus }]
      : []),
    { id: 'consumable-issue' as NavTab, label: 'Issue Consumables', icon: Wrench },
    { id: 'consumables-register' as NavTab, label: 'Consumables Register', icon: ClipboardList },
    ...(isOperationAllowed('branch-damage-mark', currentUser?.role)
      ? [{ id: 'damage' as NavTab, label: 'Label Local Damaged Stock', icon: HeartOff }]
      : []),
    ...(isOperationAllowed('branch-asset-assign', currentUser?.role)
      ? [{ id: 'assign-asset' as NavTab, label: 'Assign Fixed Asset', icon: Wrench }]
      : []),
  ];
  if (branchOpsChildren.length > 0) {
    branchOpsChildren.push({
      id: 'damage-report' as NavTab,
      label: 'Damaged Stock Report',
      icon: ClipboardList,
      hasSeparatorAbove: true,
    });
    groups.push({
      id: 'stockops',
      title: 'Branch Operations',
      icon: Layers,
      children: branchOpsChildren,
    });
  }

  // 6. Finance & Accounting Group (incl. Fixed Assets + Fiscal Year Opening Register)
  const financeChildren: NavChildDef[] = [];
  if (isOperationAllowed('fin-statements', currentUser?.role)) {
    financeChildren.push({ id: 'financial-statements' as NavTab, label: 'Financial Statements', icon: Scale });
  }
  if (isOperationAllowed('inv-pay', currentUser?.role)) {
    financeChildren.push({ id: 'vendor-ledger' as NavTab, label: 'Vendor Ledger & Payments', icon: Wallet });
  }
  if (isOperationAllowed('opening-stock-view', currentUser?.role)) {
    financeChildren.push({ id: 'vendor-opening-balances' as NavTab, label: 'Vendor Opening Balances', icon: Wallet });
  }
  if (isOperationAllowed('vat-register', currentUser?.role)) {
    financeChildren.push({ id: 'vat-register' as NavTab, label: 'VAT Sales & Purchase Register', icon: Receipt });
  }
  if (isOperationAllowed('assets-manage', currentUser?.role)) {
    financeChildren.push(
      { id: 'fixed-assets' as NavTab, label: 'Fixed Asset Register', icon: Building, hasSeparatorAbove: true },
      { id: 'depreciation-register' as NavTab, label: 'Tax Depreciation Schedule', icon: Calculator }
    );
  }
  if (financeChildren.length > 0) {
    groups.push({
      id: 'finance',
      title: 'Finance & Accounting',
      icon: DollarSign,
      children: financeChildren,
    });
  }

  // 7. Master Data Group (Fiscal Year Opening Register moved to Finance)
  const canViewProducts = isOperationAllowed('prod-view', currentUser?.role);
  const inventorySetupChildren: NavChildDef[] = [
    ...(canViewProducts
      ? [{ id: 'product-master' as NavTab, label: 'Product Master Catalog', icon: Package }]
      : []),
    ...(isOperationAllowed('category-manage', currentUser?.role)
      ? [{ id: 'category-management' as NavTab, label: 'Category Management', icon: Grid }]
      : []),
    ...(isOperationAllowed('uom-manage', currentUser?.role)
      ? [{ id: 'uom-management' as NavTab, label: 'UoM Management', icon: Ruler }]
      : []),
    ...(isOperationAllowed('customers-manage', currentUser?.role)
      ? [{ id: 'customers' as NavTab, label: 'Customer Master Directory', icon: Users }]
      : []),
    ...(isSuperAdmin ? [{ id: 'import-customers' as NavTab, label: 'Import Customers (CSV)', icon: UserPlus }] : []),
    ...(isOperationAllowed('suppliers-manage', currentUser?.role)
      ? [{ id: 'suppliers' as NavTab, label: 'Suppliers Directory', icon: Users }]
      : []),
    { id: 'locations' as NavTab, label: 'Location Management (POP/GPS)', icon: MapPin },
    ...(isOperationAllowed('admin-branches', currentUser?.role)
      ? [{ id: 'branches' as NavTab, label: 'Branch Management', icon: Building2 }]
      : []),
  ];
  groups.push({
    id: 'inventory-setup',
    title: 'Master Data & Directories',
    icon: SlidersHorizontal,
    children: inventorySetupChildren,
  });

  // 8. Administration Group (Import/Export Stock moved to Inventory & Stock)
  const adminChildren: NavChildDef[] = [];
  if (isSuperAdmin) {
    adminChildren.push({ id: 'company-setup' as NavTab, label: 'Company Profile & Setup', icon: Building2 });
  }
  if (isOperationAllowed('admin-users', currentUser?.role)) {
    adminChildren.push({ id: 'users' as NavTab, label: 'Users & Staff Management', icon: UserCheck });
  }
  if (isSuperAdmin) {
    adminChildren.push({ id: 'permissions' as NavTab, label: 'Permission Management', icon: ShieldCheck });
  }
  if (isOperationAllowed('admin-fiscal', currentUser?.role)) {
    adminChildren.push(
      { id: 'fiscal-year-management' as NavTab, label: 'Document Numbering Setup', icon: CalendarDays },
      { id: 'fiscal-year-closing' as NavTab, label: 'Fiscal Year Closing Wizard', icon: CalendarDays }
    );
  }
  if (isSuperAdmin) {
    adminChildren.push({ id: 'bs-calendar' as NavTab, label: 'BS Calendar Utility', icon: CalendarDays });
  }
  if (isOperationAllowed('admin-audit', currentUser?.role)) {
    adminChildren.push({ id: 'audit' as NavTab, label: 'Audit Activities Log', icon: ClipboardList });
  }
  if (isSuperAdmin) {
    adminChildren.push(
      { id: 'data-recalculation' as NavTab, label: 'Data Recalculation & Repair', icon: RefreshCw },
      { id: 'clear-demo-data' as NavTab, label: 'Clear Demo / Dummy Data', icon: Trash2, hasSeparatorAbove: true }
    );
  }
  if (adminChildren.length > 0) {
    groups.push({
      id: 'admin',
      title: 'Administration & Governance',
      icon: Settings,
      children: adminChildren,
    });
  }

  // Helper to find parent group of active tab
  const getParentGroupId = (tab: NavTab): string => {
    for (const g of groups) {
      if (g.children.some((c) => c.id === tab)) {
        return g.id;
      }
    }
    return 'dashboard';
  };

  // Accordion state: which groups have their sub-items expanded inline.
  // Multiple groups can be open at once; the group containing the active tab
  // auto-expands so context is preserved on load and after navigation.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    const parent = getParentGroupId(activeTab);
    return new Set(parent === 'dashboard' ? [] : [parent]);
  });
  const [globalSearch, setGlobalSearch] = useState<string>('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Keep the accordion in sync when the active tab changes from outside
  // (e.g. Global Search modal, workflow navigation, search jump).
  useEffect(() => {
    const parent = getParentGroupId(activeTab);
    setExpandedGroups((prev) => {
      if (prev.has(parent)) return prev;
      const next = new Set(prev);
      next.add(parent);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, permissionsVersion]);

  // Escape clears the global search. '/' focuses it.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement) && globalSearch) {
        setGlobalSearch('');
      }
      if (event.key === '/' && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [globalSearch]);

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const allGroupIds = useMemo(() => groups.map((g) => g.id), [groups]);

  // Smart expand/collapse-all: if any group is closed, expand all;
  // otherwise collapse all.
  const allExpanded = expandedGroups.size >= allGroupIds.length;
  const toggleAllGroups = () => {
    setExpandedGroups(allExpanded ? new Set() : new Set(allGroupIds));
  };

  const handleSubItemClick = (tab: NavTab) => {
    onSelectTab(tab);
    if (onCloseMobile) {
      onCloseMobile();
    }
  };


  // Global search: flatten every group's items and match on label + group
  // title so "finance vat" or just "vat" both find the VAT register.
  const globalSearchResults = useMemo(() => {
    const q = globalSearch.trim().toLowerCase();
    if (!q) return [];
    const results: Array<{ child: NavChildDef; group: NavGroupDef }> = [];
    for (const group of groups) {
      for (const child of group.children) {
        if (
          (child.label || '').toLowerCase().includes(q) ||
          group.title.toLowerCase().includes(q)
        ) {
          results.push({ child, group });
        }
      }
    }
    return results;
  }, [globalSearch, groups]);

  const highlightMatch = (text: string, query: string): React.ReactNode => {
    const q = query.trim();
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-indigo-200/70 text-indigo-900 rounded-sm px-0.5 dark:bg-indigo-500/40 dark:text-indigo-100">
          {text.slice(idx, idx + q.length)}
        </mark>
        {text.slice(idx + q.length)}
      </>
    );
  };

  // Shared item-row renderer (used by group view and global search results).
  const renderItemButton = (
    child: NavChildDef,
    opts: { showGroupLabel?: boolean; groupTitle?: string; query?: string; separator?: boolean; idx?: number } = {}
  ) => {
    const isActive = activeTab === child.id;
    const ItemIcon = child.icon;
    return (
      <React.Fragment key={child.id}>
        {opts.separator && (opts.idx ?? 0) > 0 && (
          <div className="my-2 px-1 flex items-center">
            <div className="h-[1px] w-full bg-slate-200 dark:bg-slate-800/80" />
          </div>
        )}
        <button
          onClick={() => handleSubItemClick(child.id)}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-[13px] transition-all cursor-pointer font-medium ${
            isActive
              ? 'bg-indigo-50 text-indigo-900 font-semibold border-l-3 border-indigo-700 shadow-xs dark:bg-indigo-600/20 dark:text-indigo-300 dark:font-semibold dark:border-l-3 dark:border-indigo-500 dark:shadow-xs'
              : 'border-l-3 border-transparent text-slate-600 hover:text-indigo-900 hover:bg-slate-100 dark:border-l-3 dark:border-transparent dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/50'
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <ItemIcon className={`h-4 w-4 flex-shrink-0 ${isActive ? 'text-indigo-500' : 'text-slate-400'}`} />
            <span className="text-left leading-snug">{highlightMatch(child.label, opts.query || '')}</span>
          </div>

          {child.badge !== undefined && child.badge > 0 && (
            <span
              className={`ml-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold flex-shrink-0 ${
                child.badgeColor ||
                'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
              }`}
            >
              {child.badge}
            </span>
          )}
        </button>
        {opts.showGroupLabel && opts.groupTitle && (
          <p className="px-3 pb-1 -mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 truncate text-left">
            {opts.groupTitle}
          </p>
        )}
      </React.Fragment>
    );
  };

  return (
    <aside
      className={`responsive-sidebar w-72 h-full flex flex-col flex-shrink-0 select-none relative bg-white text-slate-800 border-r border-slate-200 dark:bg-[#0f1218] dark:text-slate-300 dark:border-slate-800/80`}
    >
      {/* Mobile Header bar with close button */}
      {onCloseMobile && (
        <div className="flex md:hidden items-center justify-between px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900/80">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-300">Navigation</span>
          <button
            onClick={onCloseMobile}
            className="rounded-lg p-1 text-slate-400 hover:text-slate-800 dark:hover:text-white"
            title="Close drawer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* HEADER: title row with expand/collapse-all control */}
      <div
        className={`px-2.5 py-1.5 border-b flex items-center border-slate-100 bg-slate-50/80 dark:border-slate-800/80 dark:bg-slate-900/50`}
      >
        <button
          onClick={toggleAllGroups}
          className="flex-1 flex items-center justify-between gap-2 px-2 py-1 rounded-lg text-[10px] font-semibold uppercase tracking-wide text-slate-500 hover:text-indigo-700 hover:bg-indigo-50 dark:text-slate-400 dark:hover:text-indigo-300 dark:hover:bg-indigo-600/20 transition-colors cursor-pointer min-w-0"
          title={allExpanded ? 'Collapse all menu groups' : 'Expand all menu groups'}
        >
          <span className="truncate">Expand / Collapse Menu</span>
          <ChevronsDownUp className={`h-3.5 w-3.5 flex-shrink-0 transition-transform duration-200 ${allExpanded ? '' : 'rotate-180'}`} />
        </button>
      </div>

      {/* GLOBAL MENU SEARCH */}
      <div className="px-3 py-2.5 border-b border-slate-100 dark:border-slate-800/60">
        <div
          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs bg-slate-100/80 border-slate-200 text-slate-700 dark:bg-slate-900/60 dark:border-slate-800 dark:text-slate-300`}
        >
          <Search className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search menu… ( / )"
            value={globalSearch}
            onChange={(e) => setGlobalSearch(e.target.value)}
            className="w-full bg-transparent text-xs focus:outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500"
          />
          {globalSearch && (
            <button
              onClick={() => setGlobalSearch('')}
              className="text-[10px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
              title="Clear"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* NAV CONTENT: accordion — groups expand inline below their header */}
      <div className="py-2 px-2 flex-1 overflow-y-auto custom-scrollbar sidebar-hover-scrollbar">
        {globalSearch.trim() ? (
          globalSearchResults.length > 0 ? (
            globalSearchResults.map(({ child, group }) => (
              <div key={`${group.id}-${child.id}`}>
                {renderItemButton(child, { query: globalSearch })}
                <p className="pl-10 pr-3 pb-1 -mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 truncate text-left">
                  {group.title}
                </p>
              </div>
            ))
          ) : (
            <p className="px-3 py-6 text-xs text-slate-400 text-center">
              No menu items match "{globalSearch.trim()}".
            </p>
          )
        ) : (
          groups.map((group) => {
            const isExpanded = expandedGroups.has(group.id);
            const containsActive = group.children.some((c) => c.id === activeTab);
            const GroupIcon = group.icon;
            return (
              <div key={group.id} className="mb-0.5">
                <button
                  onClick={() => toggleGroup(group.id)}
                  title={group.title}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-[13px] font-semibold transition-all cursor-pointer ${
                    containsActive
                      ? 'text-indigo-900 bg-indigo-50/60 dark:text-indigo-300 dark:bg-indigo-600/10'
                      : 'text-slate-700 hover:text-indigo-900 hover:bg-slate-100 dark:text-slate-300 dark:hover:text-slate-100 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <GroupIcon className={`h-5 w-5 flex-shrink-0 ${containsActive ? 'text-indigo-500' : 'text-slate-400'}`} />
                    <span className="text-left leading-snug">{group.title}</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {group.badgeCount !== undefined && group.badgeCount > 0 && (
                      <span className="flex h-4.5 min-w-4.5 px-1.5 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white shadow-xs">
                        {group.badgeCount > 99 ? '99+' : group.badgeCount}
                      </span>
                    )}
                    <ChevronDown
                      className={`h-4 w-4 text-slate-400 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                    />
                  </div>
                </button>

                {isExpanded && (
                  <div className="mt-0.5 mb-1.5 ml-4 pl-2.5 border-l-2 border-slate-200 dark:border-slate-800 space-y-0.5">
                    {group.children.map((child, idx) =>
                      renderItemButton(child, {
                        query: globalSearch,
                        separator: child.hasSeparatorAbove,
                        idx,
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
          {/* FOOTER: Help link + Company card */}
          <div className="px-2 pb-2 space-y-1">
            <button
              onClick={() => handleSubItemClick('help-documentation')}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium transition-all cursor-pointer ${
                activeTab === 'help-documentation'
                  ? 'bg-indigo-50 text-indigo-900 dark:bg-indigo-600/20 dark:text-indigo-300'
                  : 'text-slate-600 hover:text-indigo-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/50'
              }`}
            >
              <HelpCircle className={`h-4 w-4 ${activeTab === 'help-documentation' ? 'text-indigo-500' : 'text-slate-400'}`} />
              <span className="text-left leading-snug">Help Center & Manual</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => onSelectTab('company-setup')}
            title={`Company Setup Database: ${companyProfile?.name || 'Inventory'} - Click to manage setup`}
            className={`p-3 m-2 mt-0 rounded-2xl border flex items-center gap-2.5 transition-all text-left cursor-pointer group hover:shadow-sm bg-slate-50 border-slate-200/80 text-slate-700 hover:border-indigo-300 dark:bg-slate-900/90 dark:border-slate-800/80 dark:text-slate-300 dark:hover:border-indigo-500/50`}
          >
            {companyProfile?.logoUrl ? (
              <img
                src={companyProfile.logoUrl}
                alt={companyProfile.name || 'Company Logo'}
                referrerPolicy="no-referrer"
                className={`flex-shrink-0 w-8 h-8 rounded-xl object-contain p-0.5 shadow-xs group-hover:scale-105 transition-transform bg-white/10 border border-slate-300/30 dark:bg-slate-800/50 dark:border dark:border-slate-700/50`}
                onError={(e) => {
                  (e.target as HTMLElement).style.display = 'none';
                }}
              />
            ) : (
              <div className="flex-shrink-0 w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-600 via-indigo-700 to-blue-700 text-white font-serif font-black flex items-center justify-center text-xs shadow-xs border border-white/20 group-hover:scale-105 transition-transform">
                {companyProfile?.name
                  ? companyProfile.name
                      .split(' ')
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((w) => w[0].toUpperCase())
                      .join('') || 'IN'
                  : 'IN'}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-1">
                <p className="text-[11px] font-extrabold truncate text-slate-900 dark:text-slate-100 font-serif leading-tight group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                  {companyProfile?.name || 'Inventory'}
                </p>
                <span className="text-[9px] font-bold px-1.5 py-0.2 rounded-md bg-indigo-100 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800" title="PostgreSQL Database Connected">
                  DB
                </span>
              </div>
              <p className="text-[9px] font-medium text-slate-500 dark:text-slate-400 truncate leading-tight mt-0.5">
                {getCompanyLocation(companyProfile) || 'Enterprise Multi-Branch Ed.'}
              </p>
            </div>
          </button>
    </aside>
  );
};
