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
  Download,
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
} from 'lucide-react';
import { User } from '../types';

export type NavTab =
  | 'dashboard'
  | 'approvals'
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
  | 'locations'
  | 'product-master'
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
  | 'vat-register'
  | 'depreciation-register'
  | 'nepali-fiscal'
  | 'fiscal-year-closing'
  | 'audit'
  | 'warranty-products'
  | 'export-reports'
  | 'company-setup'
  | 'help-documentation'
  | 'clear-demo-data';

interface SidebarProps {
  currentUser?: User | null;
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  lowStockCount: number;
  pendingPoCount: number;
  inTransitShipmentCount: number;
  pendingApprovalCount?: number;
  isDarkMode?: boolean;
  onCloseMobile?: () => void;
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
  currentUser,
  activeTab,
  onSelectTab,
  lowStockCount,
  pendingPoCount,
  inTransitShipmentCount,
  pendingApprovalCount,
  isDarkMode = false,
  onCloseMobile,
}) => {
  const isSuperAdmin = currentUser?.role === 'SUPER_ADMIN';
  const isFrontDesk = currentUser?.role === 'FRONT_DESK';
  const isAccountant = currentUser?.role === 'ACCOUNTANT';
  const isRestrictedRole = isFrontDesk;
  const isBranchUser = Boolean(currentUser?.branchId && currentUser.branchId !== 'ALL' && !isSuperAdmin);

  // Build filtered navigation groups based on role permissions
  const groups: NavGroupDef[] = [];

  // 1. Overview & Analytics Group
  const dashboardChildren = [
    { id: 'dashboard' as NavTab, label: 'Executive Dashboard', icon: LayoutDashboard },
    {
      id: 'approvals' as NavTab,
      label: 'Workflow Approval Center',
      icon: ShieldCheck,
      badge: pendingApprovalCount,
      badgeColor: 'bg-amber-500 text-white',
    },
    { id: 'stock-valuation' as NavTab, label: 'Stock Valuation & Insights', icon: DollarSign },
    { id: 'customer-devices' as NavTab, label: 'Customer Device Serials', icon: Smartphone },
  ];
  groups.push({
    id: 'dashboard',
    title: 'Overview & Analytics',
    shortLabel: 'Overview',
    icon: LayoutDashboard,
    children: dashboardChildren,
  });

  // 2. Inventory & Stock Matrix Group
  const inventoryChildren = [
    { id: 'stock-ledger' as NavTab, label: 'Stock Movement Ledger', icon: BookOpen },
    ...(!isBranchUser ? [{ id: 'all-stock' as NavTab, label: 'All Available Stock', icon: Package }] : []),
    {
      id: 'branch-stock' as NavTab,
      label: isBranchUser ? 'My Branch Stock' : 'Branch Stock Matrix',
      icon: Store,
    },
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
    {
      id: 'export-stock' as NavTab,
      label: 'Export Stock Data & Reports',
      icon: DownloadCloud,
      hasSeparatorAbove: true,
    },
  ];
  groups.push({
    id: 'inventory',
    title: 'Inventory & Stock Matrix',
    shortLabel: 'Inventory',
    icon: Package,
    badgeCount: lowStockCount,
    children: inventoryChildren,
  });

  // 3. Procurement Group
  const procurementChildren: NavChildDef[] = [
    ...(!isFrontDesk
      ? [
          {
            id: 'create-po' as NavTab,
            label: 'Create Purchase Order',
            icon: FilePlus,
            badge: pendingPoCount,
            badgeColor: 'bg-indigo-600 text-white',
          },
          {
            id: 'create-purchase' as NavTab,
            label: 'Create Purchase Invoice',
            icon: PlusCircle,
          },
        ]
      : []),
    {
      id: 'po-list' as NavTab,
      label: 'Purchase Order View',
      icon: FileText,
      hasSeparatorAbove: true,
    },
    {
      id: 'purchase-list' as NavTab,
      label: 'Purchase Invoice View',
      icon: Receipt,
    },
    {
      id: 'export-reports' as NavTab,
      label: 'Procurement & Purchase Reports',
      icon: Download,
      hasSeparatorAbove: true,
    },
  ];
  groups.push({
    id: 'procurement',
    title: 'Procurement & Purchasing',
    shortLabel: 'Purchases',
    icon: ShoppingCart,
    badgeCount: pendingPoCount,
    children: procurementChildren,
  });

  // 4. Warehouse Logistics Group (Exclusively for HQ / Warehouse / Admin)
  const isWarehouseStaffOrAdmin =
    isSuperAdmin ||
    currentUser?.role === 'INVENTORY_MANAGER' ||
    currentUser?.branchId === 'BR-KTM' ||
    currentUser?.branchId === 'WH001' ||
    !currentUser?.branchId ||
    currentUser?.branchId === 'ALL';

  if (isWarehouseStaffOrAdmin) {
    const warehouseLogisticsChildren = [
      { id: 'create-shipment' as NavTab, label: 'Warehouse Shipment Dispatch', icon: Send },
      {
        id: 'receive-shipment' as NavTab,
        label: 'Receive Inbound Stock & Pullouts',
        icon: Inbox,
        badge: inTransitShipmentCount,
        badgeColor: 'bg-amber-500 text-white',
      },
      { id: 'shipment-list' as NavTab, label: 'Shipment & Transfer History', icon: History },
    ];
    groups.push({
      id: 'logistics',
      title: 'Warehouse Logistics',
      shortLabel: 'Warehouse',
      icon: Truck,
      badgeCount: inTransitShipmentCount,
      children: warehouseLogisticsChildren,
    });
  }

  // 5. Branch Operations & Transfers Group
  const branchOpsChildren = [
    { id: 'pullout' as NavTab, label: 'Dispatch Stock Pullout to HQ', icon: ArrowUpRight },
    { id: 'damage' as NavTab, label: 'Label Damaged Stock', icon: HeartOff },
    {
      id: 'receive-branch-transfer' as NavTab,
      label: 'Receive Branch Stock Transfer',
      icon: Inbox,
      badge: inTransitShipmentCount,
      badgeColor: 'bg-amber-500 text-white',
    },
    { id: 'create-transfer' as NavTab, label: 'Create Inter-Branch Transfer', icon: Send },
    ...(!isRestrictedRole && !isAccountant ? [{ id: 'assign-asset' as NavTab, label: 'Assign Fixed Asset', icon: Wrench }] : []),
    { id: 'consumable-issue' as NavTab, label: 'Issue Consumables', icon: Wrench },
    { id: 'stock-out' as NavTab, label: 'Product Sale to Customer', icon: PackageMinus },
    { id: 'device-exchange' as NavTab, label: 'Device Exchange & Replacement', icon: RefreshCw },
    { id: 'warranty-products' as NavTab, label: 'View Warranty Products', icon: ShieldCheck },
  ];
  groups.push({
    id: 'stockops',
    title: 'Branch Operations & Transfers',
    shortLabel: 'Branch Ops',
    icon: Layers,
    children: branchOpsChildren,
  });

  // 6. Fixed Assets Group
  if (!isRestrictedRole) {
    groups.push({
      id: 'fixed-assets-group',
      title: 'Fixed Assets & Tax',
      shortLabel: 'Assets',
      icon: Building,
      children: [
        { id: 'fixed-assets' as NavTab, label: 'Fixed Asset Register', icon: Building },
        { id: 'depreciation-register' as NavTab, label: 'Tax Depreciation Schedule', icon: Calculator },
      ],
    });
  }

  // 7. Inventory Setup Group
  const isStockMasterAdmin = currentUser?.role === 'SUPER_ADMIN' || currentUser?.role === 'INVENTORY_MANAGER';
  const inventorySetupChildren = [
    { id: 'customers' as NavTab, label: 'Customer Master Directory', icon: Users },
    { id: 'locations' as NavTab, label: 'Location Management (POP/GPS)', icon: MapPin },
    { id: 'product-master' as NavTab, label: 'Product Master Catalog', icon: Package },
    ...(isStockMasterAdmin ? [{ id: 'category-management' as NavTab, label: 'Category Management', icon: Grid }] : []),
    ...(isStockMasterAdmin ? [{ id: 'uom-management' as NavTab, label: 'UoM Management', icon: Ruler }] : []),
    ...(isStockMasterAdmin ? [{ id: 'branches' as NavTab, label: 'Branch Management', icon: Building2 }] : []),
    ...(isStockMasterAdmin ? [{ id: 'suppliers' as NavTab, label: 'Suppliers Directory', icon: Users }] : []),
    ...(isStockMasterAdmin ? [{ id: 'import-stock' as NavTab, label: 'Import Stock Data', icon: UploadCloud }] : []),
    ...(isStockMasterAdmin ? [{ id: 'export-stock' as NavTab, label: 'Export Stock Data', icon: DownloadCloud }] : []),
  ];
  groups.push({
    id: 'inventory-setup',
    title: 'Master Setup & Data',
    shortLabel: 'Setup',
    icon: SlidersHorizontal,
    children: inventorySetupChildren,
  });

  // 8. Administration Group
  if (isSuperAdmin) {
    groups.push({
      id: 'admin',
      title: 'Administration & Governance',
      shortLabel: 'Admin',
      icon: Settings,
      children: [
        { id: 'company-setup' as NavTab, label: 'Company Profile & Setup', icon: Building2 },
        { id: 'fiscal-year-closing' as NavTab, label: 'Fiscal Year Closing Wizard', icon: CalendarDays },
        { id: 'nepali-fiscal' as NavTab, label: 'BS Calendar & Fiscal Years', icon: CalendarDays },
        { id: 'users' as NavTab, label: 'Users & Staff Management', icon: UserCheck },
        { id: 'import-customers' as NavTab, label: 'Import Customers (CSV)', icon: UserPlus },
        { id: 'financial-statements' as NavTab, label: 'Financial Statements', icon: Scale },
        { id: 'vat-register' as NavTab, label: 'VAT Sales & Purchase Register', icon: Receipt },
        { id: 'permissions' as NavTab, label: 'Permission Management', icon: ShieldCheck },
        { id: 'audit' as NavTab, label: 'Audit Activities Log', icon: ClipboardList },
        { id: 'clear-demo-data' as NavTab, label: 'Clear Demo / Dummy Data', icon: Trash2, hasSeparatorAbove: true },
      ],
    });
  }

  // 9. Help & Documentation Group (Accessible to all users)
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
  }, [activeTab]);

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
      className={`h-full flex flex-row flex-shrink-0 select-none relative ${
        isDarkMode ? 'bg-[#0f1218] text-slate-300' : 'bg-white text-slate-800'
      }`}
    >
      {/* PRIMARY NARROW RAIL (76px wide) */}
      <div
        className={`w-[76px] flex-shrink-0 border-r flex flex-col justify-between items-center py-3.5 z-20 ${
          isDarkMode ? 'border-slate-800/80 bg-[#0f1218]' : 'border-slate-200 bg-slate-50/90'
        }`}
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
                className={`w-full flex flex-col items-center justify-center py-2.5 px-1 rounded-xl transition-all cursor-pointer relative group ${
                  isActive
                    ? isDarkMode
                      ? 'bg-indigo-600/25 text-indigo-300 font-bold border border-indigo-500/50 shadow-xs'
                      : 'bg-indigo-100/90 text-indigo-900 font-bold border border-indigo-300/80 shadow-xs'
                    : isDarkMode
                    ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                    : 'text-slate-600 hover:text-indigo-900 hover:bg-slate-200/60'
                }`}
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
            className={`p-2 rounded-xl transition-all cursor-pointer ${
              isDarkMode
                ? 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-200'
            }`}
          >
            {isSubPanelExpanded ? (
              <PanelLeftClose className="h-4 w-4" />
            ) : (
              <PanelLeftOpen className="h-4 w-4 text-indigo-500 animate-pulse" />
            )}
          </button>
        </div>
      </div>

      {/* SECONDARY SUBMENU FLYOUT PANEL (OVERLAY - 288px wide) */}
      {isSubPanelExpanded && (
        <div
          className={`absolute left-[76px] top-0 bottom-0 z-30 w-72 border-r shadow-2xl flex flex-col justify-between transition-all duration-200 animate-in fade-in slide-in-from-left-1 ${
            isDarkMode ? 'border-slate-800/90 bg-[#0c0e13]/98' : 'border-slate-200/90 bg-white/98 backdrop-blur-md'
          }`}
        >
          {/* Mobile Header bar with close button */}
          {onCloseMobile && (
            <div className="flex md:hidden items-center justify-between px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900/80">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Navigation</span>
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
            className={`px-4 py-3.5 border-b flex items-center justify-between ${
              isDarkMode ? 'border-slate-800/80 bg-slate-900/50' : 'border-slate-100 bg-slate-50/80'
            }`}
          >
            <div className="flex items-center gap-2.5 overflow-hidden">
              {currentGroupDef && (
                <>
                  <currentGroupDef.icon className="h-4.5 w-4.5 text-indigo-500 flex-shrink-0" />
                  <span className="text-xs font-bold uppercase tracking-wider truncate text-slate-800 dark:text-slate-100">
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
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs ${
                  isDarkMode
                    ? 'bg-slate-900/60 border-slate-800 text-slate-300'
                    : 'bg-slate-100/80 border-slate-200 text-slate-700'
                }`}
              >
                <Search className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
                <input
                  type="text"
                  placeholder="Filter menu options..."
                  value={menuFilter}
                  onChange={(e) => setMenuFilter(e.target.value)}
                  className="w-full bg-transparent text-[11px] focus:outline-none placeholder:text-slate-400"
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
                        ? isDarkMode
                          ? 'bg-indigo-600/20 text-indigo-300 font-semibold border-l-3 border-indigo-500 shadow-xs'
                          : 'bg-indigo-50 text-indigo-900 font-semibold border-l-3 border-indigo-700 shadow-xs'
                        : isDarkMode
                        ? 'border-l-3 border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                        : 'border-l-3 border-transparent text-slate-600 hover:text-indigo-900 hover:bg-slate-100'
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
                          (isDarkMode
                            ? 'bg-slate-800 text-slate-300 border border-slate-700'
                            : 'bg-slate-200 text-slate-700')
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
          <div
            className={`p-3 m-2 rounded-2xl border flex items-center gap-2.5 ${
              isDarkMode
                ? 'bg-slate-900/90 border-slate-800/80 text-slate-300'
                : 'bg-slate-50 border-slate-200/80 text-slate-700'
            }`}
          >
            <div className="flex-shrink-0 w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-600 via-indigo-700 to-blue-700 text-white font-serif font-black flex items-center justify-center text-xs shadow-xs border border-white/20">
              iZ
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-1">
                <p className="text-[11px] font-extrabold truncate text-slate-900 dark:text-slate-100 font-serif leading-tight">
                  IZone Inventory
                </p>
                <span className="text-[9px] font-bold px-1.5 py-0.2 rounded-md bg-indigo-100 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                  v2.5.0
                </span>
              </div>
              <p className="text-[9px] font-medium text-slate-500 dark:text-slate-400 truncate leading-tight mt-0.5">
                Enterprise Multi-Branch Ed.
              </p>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
