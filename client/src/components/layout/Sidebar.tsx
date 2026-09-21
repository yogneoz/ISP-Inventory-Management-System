import React, { useState, useEffect, useRef } from 'react';
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
  History,
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
  PanelLeftClose,
  PanelLeftOpen,
  Zap,
  X,
  Search,
  Scale,
  Calculator,
  SlidersHorizontal,
  Grid,
  Ruler,
  UploadCloud,
  DownloadCloud,
  Boxes,
  FolderTree,
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
  shortLabel: string;
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

  // Build filtered navigation groups based on role permissions
  // 10 functional groups: Overview / Inventory / Serial Tracking / Procurement /
  // Warehouse & Transfers / Branch Operations / Finance / Fixed Assets /
  // Master Data / Administration. Every item keeps its own permission gating,
  // badges, and separators — only the group placement changed.
  const groups: NavGroupDef[] = [];

  // 1. Overview Group
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
  ];
  groups.push({
    id: 'dashboard',
    title: 'Overview',
    shortLabel: 'Overview',
    icon: LayoutDashboard,
    children: dashboardChildren,
  });

  // 2. Inventory & Stock Group
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
  ];
  groups.push({
    id: 'inventory',
    title: 'Inventory & Stock',
    shortLabel: 'Inventory',
    icon: Package,
    badgeCount: lowStockCount,
    children: inventoryChildren,
  });

  // 3. Serial & Device Tracking Group
  const serialTrackingChildren: NavChildDef[] = [
    ...(isOperationAllowed('prod-view', currentUser?.role)
      ? [{ id: 'complete-serial-inventory' as NavTab, label: 'Serial Log Register', icon: Package }]
      : []),
    { id: 'customer-devices' as NavTab, label: 'Customer Device Serials', icon: Smartphone },
    { id: 'warranty-products' as NavTab, label: 'View Warranty Products', icon: ShieldCheck },
    { id: 'device-exchange' as NavTab, label: 'Device Exchange & Replacement', icon: RefreshCw },
  ];
  if (serialTrackingChildren.length > 0) {
    groups.push({
      id: 'serial-tracking',
      title: 'Serial & Device Tracking',
      shortLabel: 'Serials',
      icon: Smartphone,
      children: serialTrackingChildren,
    });
  }

  // 4. Procurement Group
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
    shortLabel: 'Purchases',
    icon: ShoppingCart,
    badgeCount: pendingPoCount + pendingBillCount,
    children: procurementChildren,
  });

  // 5. Warehouse & Transfers Group (warehouse dispatch/receive + inter-branch transfers + pullouts)
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
      shortLabel: 'Warehouse',
      icon: Truck,
      badgeCount: inTransitShipmentCount,
      children: warehouseChildren,
    });
  }

  // 6. Branch Operations Group (sales, consumables, damages, asset assignment)
  const branchOpsChildren: NavChildDef[] = [
    ...(isOperationAllowed('stock-out', currentUser?.role)
      ? [{ id: 'stock-out' as NavTab, label: 'Product Sale to Customer', icon: PackageMinus }]
      : []),
    { id: 'consumable-issue' as NavTab, label: 'Issue Consumables', icon: Wrench },
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
      shortLabel: 'Branch Ops',
      icon: Layers,
      children: branchOpsChildren,
    });
  }

  // 7. Fixed Assets Group
  if (isOperationAllowed('assets-manage', currentUser?.role)) {
    groups.push({
      id: 'fixed-assets-group',
      title: 'Fixed Assets',
      shortLabel: 'Assets',
      icon: Building,
      children: [
        { id: 'fixed-assets' as NavTab, label: 'Fixed Asset Register', icon: Building },
        { id: 'depreciation-register' as NavTab, label: 'Tax Depreciation Schedule', icon: Calculator },
      ],
    });
  }

  // 8. Finance Group
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
  if (financeChildren.length > 0) {
    groups.push({
      id: 'finance',
      title: 'Finance & Accounting',
      shortLabel: 'Finance',
      icon: DollarSign,
      children: financeChildren,
    });
  }

  // 9. Master Data Group
  const canViewProducts = isOperationAllowed('prod-view', currentUser?.role);
  const canViewOpeningStock = isOperationAllowed('opening-stock-view', currentUser?.role);
  const canImportExportStock = isOperationAllowed('stock-import-export', currentUser?.role);
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
    ...(canViewOpeningStock
      ? [{ id: 'opening-stock' as NavTab, label: 'Fiscal Year Opening Register', icon: Scale }]
      : []),
  ];
  groups.push({
    id: 'inventory-setup',
    title: 'Master Data & Directories',
    shortLabel: 'Master Data',
    icon: SlidersHorizontal,
    children: inventorySetupChildren,
  });

  // 10. Administration Group
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
  if (canImportExportStock) {
    adminChildren.push({ id: 'import-stock' as NavTab, label: 'Import Stock Data', icon: UploadCloud });
    adminChildren.push({ id: 'export-stock' as NavTab, label: 'Export Stock Data & Reports', icon: DownloadCloud });
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
      shortLabel: 'Admin',
      icon: Settings,
      children: adminChildren,
    });
  }

  // 11. Help & Documentation Group (Accessible to all users)
  groups.push({
    id: 'help-documentation-group',
    title: 'Help & Documentation',
    shortLabel: 'Help',
    icon: HelpCircle,
    children: [
      { id: 'help-documentation' as NavTab, label: 'Help Center & Manual', icon: BookOpen },
    ],
  });

  // Helper to find parent group of active tab
  const getParentGroupId = (tab: NavTab): string => {
    for (const g of groups) {
      if (g.children.some((c) => c.id === tab)) {
        return g.id;
      }
    }
    return 'dashboard';
  };

  const [activeGroup, setActiveGroup] = useState<string>(() => getParentGroupId(activeTab));
  const [isSubPanelExpanded, setIsSubPanelExpanded] = useState<boolean>(true);
  const [menuFilter, setMenuFilter] = useState<string>('');

  const sidebarRef = useRef<HTMLElement>(null);

  // Keep activeGroup in sync when activeTab changes
  useEffect(() => {
    const parent = getParentGroupId(activeTab);
    setActiveGroup(parent);
  }, [activeTab, permissionsVersion]);

  // Hide sub-menu panel if click is detected outside the sidebar area
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        isSubPanelExpanded &&
        sidebarRef.current &&
        !sidebarRef.current.contains(event.target as Node)
      ) {
        setIsSubPanelExpanded(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isSubPanelExpanded]);

  const handlePrimaryGroupClick = (groupId: string) => {
    if (activeGroup === groupId) {
      // Toggle secondary sub-panel expansion if clicking the same active group
      setIsSubPanelExpanded((prev) => !prev);
    } else {
      setActiveGroup(groupId);
      setIsSubPanelExpanded(true);
    }
  };

  const handleSubItemClick = (tab: NavTab) => {
    onSelectTab(tab);
    if (onCloseMobile) {
      onCloseMobile();
    }
  };

  const currentGroupDef = groups.find((g) => g.id === activeGroup) || groups[0];

  const filteredSubItems = currentGroupDef
    ? currentGroupDef.children.filter((child) =>
        (child?.label || '').toLowerCase().includes(menuFilter.trim().toLowerCase())
      )
    : [];

  return (
    <aside
      ref={sidebarRef}
      className={`h-full flex flex-row flex-shrink-0 select-none relative bg-white text-slate-800 dark:bg-[#0f1218] dark:text-slate-300`}
    >
      {/* PRIMARY NARROW RAIL (responsive: 76px standard, 64px compact desktop) */}
      <div
        className={`responsive-sidebar-rail w-[76px] flex-shrink-0 border-r flex flex-col justify-between items-center py-3.5 z-20 border-slate-200 bg-slate-50/90 dark:border-slate-800/80 dark:bg-[#0f1218]`}
      >
        {/* Primary Main Menu Header Stack */}
        <div className="flex-1 w-full space-y-1 overflow-y-auto custom-scrollbar px-1.5 py-2">
          {groups.map((group) => {
            const isActive = activeGroup === group.id;
            const GroupIcon = group.icon;

            return (
              <button
                key={group.id}
                onClick={() => handlePrimaryGroupClick(group.id)}
                title={group.title}
                className={`w-full flex flex-col items-center justify-center py-2.5 px-1 rounded-xl transition-all cursor-pointer relative group ${isActive ? 'bg-indigo-100/90 text-indigo-900 font-bold border border-indigo-300/80 shadow-xs dark:bg-indigo-600/25 dark:text-indigo-300 dark:font-bold dark:border dark:border-indigo-500/50 dark:shadow-xs' : 'text-slate-600 hover:text-indigo-900 hover:bg-slate-200/60 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800/60'}`}
              >
                <div className="relative">
                  <GroupIcon className={`h-5 w-5 ${isActive ? 'scale-110 text-indigo-500' : ''}`} />
                  {group.badgeCount !== undefined && group.badgeCount > 0 && (
                    <span className="absolute -top-1.5 -right-2.5 flex h-4 min-w-4 px-1 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white shadow-xs">
                      {group.badgeCount > 99 ? '99+' : group.badgeCount}
                    </span>
                  )}
                </div>
                {/* MENU LABEL DIRECTLY BELOW ICON */}
                <span
                  className={`text-[10px] font-semibold leading-tight tracking-tight mt-1.5 text-center truncate w-full px-0.5 ${
                    isActive ? 'text-indigo-600 dark:text-indigo-400 font-bold' : ''
                  }`}
                >
                  {group.shortLabel}
                </span>
              </button>
            );
          })}
        </div>

        {/* Bottom Rail Collapse / Expand Toggle Button */}
        <div className="pt-2 w-full px-2 border-t border-slate-200 dark:border-slate-800/80 flex flex-col items-center">
          <button
            onClick={() => setIsSubPanelExpanded((prev) => !prev)}
            title={isSubPanelExpanded ? 'Collapse Submenu Panel' : 'Expand Submenu Panel'}
            className={`p-2 rounded-xl transition-all cursor-pointer text-slate-500 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800`}
          >
            {isSubPanelExpanded ? (
              <PanelLeftClose className="h-4 w-4" />
            ) : (
              <PanelLeftOpen className="h-4 w-4 text-indigo-500 animate-pulse" />
            )}
          </button>
        </div>
      </div>

      {/* SECONDARY SUBMENU FLYOUT PANEL (responsive overlay) */}
      {isSubPanelExpanded && (
        <div
          className={`responsive-sidebar-panel absolute left-[76px] top-0 bottom-0 z-30 w-72 border-r shadow-2xl flex flex-col justify-between transition-all duration-200 animate-in fade-in slide-in-from-left-1 border-slate-200/90 bg-white/98 backdrop-blur-md dark:border-slate-800/90 dark:bg-[#0c0e13]/98`}
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

          {/* Submenu Title & Collapse Header */}
          <div
            className={`px-4 py-3.5 border-b flex items-center justify-between border-slate-100 bg-slate-50/80 dark:border-slate-800/80 dark:bg-slate-900/50`}
          >
            <div className="flex items-center gap-2.5 overflow-hidden">
              {currentGroupDef && (
                <>
                  <currentGroupDef.icon className="h-4.5 w-4.5 text-indigo-500 flex-shrink-0" />
                  <span className={`text-xs font-bold uppercase tracking-wider truncate text-slate-800 dark:text-indigo-400`}>
                    {currentGroupDef.title}
                  </span>
                </>
              )}
            </div>
            <button
              onClick={() => setIsSubPanelExpanded(false)}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              title="Collapse sub-menu"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </div>

          {/* Quick Submenu Search/Filter (renders if group has > 4 sub-items) */}
          {currentGroupDef && currentGroupDef.children.length > 4 && (
            <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800/60">
              <div
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs bg-slate-100/80 border-slate-200 text-slate-700 dark:bg-slate-900/60 dark:border-slate-800 dark:text-slate-300`}
              >
                <Search className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
                <input
                  type="text"
                  placeholder="Filter menu options..."
                  value={menuFilter}
                  onChange={(e) => setMenuFilter(e.target.value)}
                  className="w-full bg-transparent text-[11px] focus:outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500"
                />
                {menuFilter && (
                  <button onClick={() => setMenuFilter('')} className="text-[10px] text-slate-400 hover:text-slate-200">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Sub-menu Nav Items List */}
          <div className="py-2.5 px-2.5 flex-1 overflow-y-auto space-y-1 custom-scrollbar">
            {filteredSubItems.map((child, idx) => {
              const isActive = activeTab === child.id;
              const ItemIcon = child.icon;

              return (
                <React.Fragment key={child.id}>
                  {child.hasSeparatorAbove && idx > 0 && (
                    <div className="my-2 px-1 flex items-center">
                      <div className="h-[1px] w-full bg-slate-200 dark:bg-slate-800/80" />
                    </div>
                  )}
                  <button
                    onClick={() => handleSubItemClick(child.id)}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs transition-all cursor-pointer font-medium ${
                      isActive
                        ? 'bg-indigo-50 text-indigo-900 font-semibold border-l-3 border-indigo-700 shadow-xs dark:bg-indigo-600/20 dark:text-indigo-300 dark:font-semibold dark:border-l-3 dark:border-indigo-500 dark:shadow-xs'
                        : 'border-l-3 border-transparent text-slate-600 hover:text-indigo-900 hover:bg-slate-200 dark:border-l-3 dark:border-transparent dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <ItemIcon className={`h-4 w-4 flex-shrink-0 ${isActive ? 'text-indigo-500' : 'text-slate-400'}`} />
                      <span className="truncate text-left text-[12px]">{child.label}</span>
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
                </React.Fragment>
              );
            })}
          </div>

          {/* Bottom Inventory Name & System Version */}
          <button
            type="button"
            onClick={() => onSelectTab('company-setup')}
            title={`Company Setup Database: ${companyProfile?.name || 'Inventory'} - Click to manage setup`}
            className={`p-3 m-2 rounded-2xl border flex items-center gap-2.5 transition-all text-left cursor-pointer group hover:shadow-sm bg-slate-50 border-slate-200/80 text-slate-700 hover:border-indigo-300 dark:bg-slate-900/90 dark:border-slate-800/80 dark:text-slate-300 dark:hover:border-indigo-500/50`}
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
        </div>
      )}
    </aside>
  );
};
