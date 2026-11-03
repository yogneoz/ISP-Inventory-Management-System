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
  Wrench,
  Settings,
  Building2,
  Users,
  UserCheck,
  ShieldAlert,
  ShieldCheck,
  ClipboardList,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  X,
  Search,
  Scale,
  TrendingUp,
  Landmark,
  Clock,
  ListTree,
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
  Palette,
  Wallet,
  Undo2,
} from 'lucide-react';
import { User, CompanyProfile, Branch, FiscalYear } from '../../types';
import { getCompanyLocation } from '../../utils/companyProfile';
import { isOperationAllowed } from '../../utils/permissions';
import { ViewScopeControls } from '../common/ViewScopeControls';

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
  | 'product-group-management'
  | 'uom-management'
  | 'import-stock'
  | 'export-stock'
  | 'create-po'
  | 'po-list'
  | 'create-purchase'
  | 'purchase-list'
  | 'create-sale'
  | 'sales-list'
  | 'purchase-returns'
  | 'create-purchase-return'
  | 'sales-returns'
  | 'create-sales-return'
  | 'create-shipment'
  | 'create-transfer'
  | 'receive-shipment'
  | 'receive-branch-transfer'
  | 'shipment-list'
  | 'pullout'
  | 'damage'
  | 'pullout-report'
  | 'damage-report'
  | 'assign-asset'
  | 'asset-deployments'
  | 'consumable-issue'
  | 'consumables-register'
  | 'device-exchange'
  | 'branches'
  | 'suppliers'
  | 'users'
  | 'import-customers'
  | 'permissions'
  | 'user-permissions'
  | 'accounting'
  | 'accounting-profit-loss'
  | 'accounting-balance-sheet'
  | 'accounting-cash-book'
  | 'accounting-aging'
  | 'accounting-chart'
  | 'cash-position'
  | 'financial-statements'
  | 'vendor-ledger'
  | 'customer-ledger'
  | 'vendor-opening-balances'
  | 'vat-register'
  | 'depreciation-register'
  | 'nepali-fiscal'
  | 'bs-calendar'
  | 'fiscal-year-management'
  | 'fiscal-year-closing'
  | 'audit'
  | 'supplier-warranty'
  | 'seller-warranty'
  | 'company-setup'
  | 'data-recalculation'
  | 'help-documentation'
  | 'clear-demo-data'
  | /** DEV-ONLY: StatCard design-review gallery, hidden from normal nav. */
    'dev-statcard';

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
  'product-group-management',
  'uom-management',
  'import-stock',
  'export-stock',
  'create-po',
  'po-list',
  'create-purchase',
  'purchase-list',
  'create-sale',
  'sales-list',
  'purchase-returns',
  'create-purchase-return',
  'sales-returns',
  'create-sales-return',
  'create-shipment',
  'create-transfer',
  'receive-shipment',
  'receive-branch-transfer',
  'shipment-list',
  'pullout',
  'damage',
  'pullout-report',
  'damage-report',
  'assign-asset',
  'asset-deployments',
  'consumable-issue',
  'consumables-register',
  'device-exchange',
  'branches',
  'suppliers',
  'users',
  'import-customers',
  'permissions',
  'user-permissions',
  'accounting',
  'accounting-profit-loss',
  'accounting-balance-sheet',
  'accounting-cash-book',
  'accounting-aging',
  'accounting-chart',
  'cash-position',
  'financial-statements',
  'vendor-ledger',
  'customer-ledger',
  'vendor-opening-balances',
  'vat-register',
  'depreciation-register',
  'nepali-fiscal',
  'bs-calendar',
  'fiscal-year-management',
  'fiscal-year-closing',
  'audit',
  'supplier-warranty',
  'seller-warranty',
  'company-setup',
  'data-recalculation',
  'help-documentation',
  'clear-demo-data',
  'dev-statcard',
];

export const SIDEBAR_WIDTH_STORAGE_KEY = 'inventory_sidebar_width_px';
export const SIDEBAR_OPEN_GROUPS_STORAGE_KEY = 'inventory_sidebar_open_groups';
export const SIDEBAR_DEFAULT_WIDTH = 288;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 520;

export const clampSidebarWidth = (width: number): number => {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
};

function readStoredSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    return raw ? clampSidebarWidth(Number(raw)) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function persistSidebarWidth(width: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Private mode / storage full: resizing still works for this session.
  }
}

/**
 * The expanded group ids survive a reload, like the rail width. A missing key
 * means "first visit" and opens the active page's group; a stored empty array
 * is a deliberate Collapse all and stays collapsed. Malformed storage falls
 * back to the first-visit default rather than hiding the whole menu.
 *
 * Stored ids are intersected with the groups this render can actually show.
 * A group removed or renamed in a later release — or hidden from this role —
 * must not occupy the set: the effect that persists the initial read then
 * rewrites storage, so stale ids heal on the next mount instead of lingering.
 * If every stored id is stale, the rail falls back to the active page's group
 * rather than opening nothing.
 */
function readStoredOpenGroups(
  fallbackGroupId: string,
  validGroupIds: readonly string[]
): Set<string> {
  const valid = new Set(validGroupIds);
  const fallback = valid.has(fallbackGroupId) ? new Set([fallbackGroupId]) : new Set<string>();
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_OPEN_GROUPS_STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const restored = parsed.filter(
      (id): id is string => typeof id === 'string' && valid.has(id)
    );
    if (restored.length === 0 && parsed.length > 0) return fallback;
    return new Set(restored);
  } catch {
    return fallback;
  }
}

function persistOpenGroups(groups: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDEBAR_OPEN_GROUPS_STORAGE_KEY, JSON.stringify([...groups]));
  } catch {
    // Private mode / storage full: expansion still works for this session.
  }
}

interface SidebarProps {
  companyProfile?: CompanyProfile | null;
  currentUser?: User | null;
  /** Company-wide view scope. The mobile drawer renders these because the
   *  header controls are hidden below `md`. */
  branches?: Branch[];
  selectedBranchId?: string;
  onSelectBranch?: (branchId: string) => void;
  fiscalYears?: FiscalYear[];
  selectedFiscalYearId?: string;
  onSelectFiscalYear?: (fiscalYearId: string) => void;
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  lowStockCount: number;
  pendingPoCount: number;
  pendingBillCount: number;
  inTransitShipmentCount: number;
  /** Pending shipments destined for the central warehouse (receive-station badge). */
  warehouseInboundCount?: number;
  /** Pending transfers destined for the active branch (branch receive badge). */
  branchInboundCount?: number;
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
  /**
   * In-group heading ("Forms", "Registers", …). The label renders before the
   * first VISIBLE item of the section, so a permission-filtered section leaves
   * no empty heading behind.
   */
  section?: string;
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
  branches = [],
  selectedBranchId = 'ALL',
  onSelectBranch = () => {},
  fiscalYears = [],
  selectedFiscalYearId = '',
  onSelectFiscalYear = () => {},
  activeTab,
  onSelectTab,
  lowStockCount,
  pendingPoCount,
  pendingBillCount,
  inTransitShipmentCount,
  warehouseInboundCount,
  branchInboundCount,
  pendingApprovalCount,
  onCloseMobile,
  permissionsVersion,
}) => {
  const isSuperAdmin = currentUser?.role === 'SUPER_ADMIN';
  const isBranchUser = Boolean(currentUser?.branchId && currentUser.branchId !== 'ALL' && !isSuperAdmin);

  // Build filtered navigation groups based on role permissions.
  //
  // Eight domain groups, ordered by the work an operator does:
  //   Overview -> Inventory -> Procurement -> Sales -> Warehouse ->
  //   Finance -> Master Data -> Administration.
  //
  // Layout rules (keep them when adding a screen):
  //   1. One home per tab. A tab in two groups would mark two rows as current.
  //   2. Group by domain, not by physical place. Branch Operations used to be a
  //      top-level group, but its sale belongs to Sales and its consumables,
  //      damage and fixed assets are inventory states; a location-shaped group
  //      becomes a dumping ground as the app grows.
  //   3. Daily work first; setup and governance last.
  //   4. Inside a group, split the list into sections ("Forms", "Registers",
  //      "Reports & exports"). Registers come first where "what do I have?" is
  //      the daily question; forms come first where creating precedes review.
  //   5. Every item keeps its own permission gate, badge and screen.
  const groups: NavGroupDef[] = [];

  // 1. Overview — the landing page and the one cross-module inbox.
  const canApproveWorkflow =
    isOperationAllowed('workflow-approval', currentUser?.role) ||
    isOperationAllowed('workflow-approval-cancel', currentUser?.role);
  const dashboardChildren: NavChildDef[] = [
    { id: 'dashboard' as NavTab, label: 'Executive Dashboard', icon: LayoutDashboard },
    ...(canApproveWorkflow
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
    icon: LayoutDashboard,
    children: dashboardChildren,
  });

  // 2. Inventory & Stock — every on-hand register and every stock action,
  //    including consumables, damage labelling and fixed-asset assignment
  //    that used to live in Branch Operations.
  const canViewProducts = isOperationAllowed('prod-view', currentUser?.role);
  const canAssignAssets = isOperationAllowed('branch-asset-assign', currentUser?.role);
  const inventoryChildren: NavChildDef[] = [
    ...(!isBranchUser
      ? [{ id: 'all-stock' as NavTab, label: 'All Available Stock', icon: Package, section: 'Registers' }]
      : []),
    {
      id: 'branch-stock' as NavTab,
      label: isBranchUser ? 'My Branch Stock' : 'Branch Stock Matrix',
      icon: Store,
      section: 'Registers',
    },
    { id: 'stock-ledger' as NavTab, label: 'Stock Movement Ledger', icon: BookOpen, section: 'Registers' },
    ...(canViewProducts
      ? [{ id: 'complete-serial-inventory' as NavTab, label: 'Serial Log Register', icon: Package, section: 'Registers' }]
      : []),
    {
      id: 'damaged-stock' as NavTab,
      label: 'Damaged Stock Matrix',
      icon: AlertTriangle,
      section: 'Registers',
    },
    { id: 'consumables-register' as NavTab, label: 'Consumables Register', icon: ClipboardList, section: 'Registers' },
    { id: 'damage-report' as NavTab, label: 'Damaged Stock Report', icon: ClipboardList, section: 'Registers' },
    ...(canAssignAssets
      ? [{ id: 'asset-deployments' as NavTab, label: 'Asset Deployments', icon: MapPin, section: 'Registers' }]
      : []),
    { id: 'consumable-issue' as NavTab, label: 'Issue Consumables', icon: Wrench, section: 'Forms' },
    ...(isOperationAllowed('branch-damage-mark', currentUser?.role)
      ? [{ id: 'damage' as NavTab, label: 'Label Local Damaged Stock', icon: HeartOff, section: 'Forms' }]
      : []),
    ...(canAssignAssets
      ? [{ id: 'assign-asset' as NavTab, label: 'Assign Fixed Asset', icon: Wrench, section: 'Forms' }]
      : []),
    {
      id: 'physical-stock-audit' as NavTab,
      label: 'Physical Stock Count Audit',
      icon: ClipboardCheck,
      section: 'Forms',
    },
    {
      id: 'reorder-stock' as NavTab,
      label: 'Reorder Level Manager',
      icon: Bell,
      badge: lowStockCount,
      badgeColor: 'bg-rose-500 text-white',
      section: 'Forms',
    },
    ...(isOperationAllowed('stock-import-export', currentUser?.role)
      ? [{ id: 'import-stock' as NavTab, label: 'Import Stock Data', icon: UploadCloud, section: 'Forms' }]
      : []),
    ...(isOperationAllowed('stock-valuation', currentUser?.role)
      ? [{ id: 'stock-valuation' as NavTab, label: 'Stock Valuation & Insights', icon: DollarSign, section: 'Reports & exports' }]
      : []),
    ...(isOperationAllowed('stock-import-export', currentUser?.role)
      ? [{ id: 'export-stock' as NavTab, label: 'Export Stock Data & Reports', icon: DownloadCloud, section: 'Reports & exports' }]
      : []),
  ];
  groups.push({
    id: 'inventory',
    title: 'Inventory & Stock',
    icon: Package,
    badgeCount: lowStockCount,
    children: inventoryChildren,
  });

  // 3. Procurement & Purchasing — buy, book, return, supplier warranty.
  const canCreatePoAtRole = isOperationAllowed('po-create', currentUser?.role);
  const canCreateInvoiceAtRole = isOperationAllowed('inv-create', currentUser?.role);
  const canCreatePurchaseReturn = isOperationAllowed('purchase-return-create', currentUser?.role);
  const canViewWarranty = isOperationAllowed('warranty-view', currentUser?.role);
  const procurementChildren: NavChildDef[] = [
    ...(canCreatePoAtRole
      ? [{ id: 'create-po' as NavTab, label: 'Create Purchase Order', icon: FilePlus, section: 'Forms' }]
      : []),
    ...(canCreateInvoiceAtRole
      ? [{ id: 'create-purchase' as NavTab, label: 'Create Purchase Bill', icon: PlusCircle, section: 'Forms' }]
      : []),
    ...(canCreatePurchaseReturn
      ? [{ id: 'create-purchase-return' as NavTab, label: 'Create Purchase Return', icon: PlusCircle, section: 'Forms' }]
      : []),
    {
      id: 'po-list' as NavTab,
      label: 'Purchase Orders Register',
      icon: FileText,
      badge: pendingPoCount,
      badgeColor: 'bg-indigo-600 text-white',
      section: 'Registers',
    },
    {
      id: 'purchase-list' as NavTab,
      label: 'Purchase Bills Register',
      icon: Receipt,
      badge: pendingBillCount,
      badgeColor: 'bg-amber-500 text-white',
      section: 'Registers',
    },
    ...(canCreatePurchaseReturn
      ? [{ id: 'purchase-returns' as NavTab, label: 'Purchase Returns Register', icon: Undo2, section: 'Registers' }]
      : []),
    ...(canViewWarranty
      ? [{ id: 'supplier-warranty' as NavTab, label: 'Suppliers Warranty', icon: ShieldCheck, section: 'Registers' }]
      : []),
  ];
  groups.push({
    id: 'procurement',
    title: 'Procurement & Purchasing',
    icon: ShoppingCart,
    badgeCount: pendingPoCount + pendingBillCount,
    children: procurementChildren,
  });

  // 4. Sales & Customers — invoices, returns, device exchange and the
  //    customer-side warranty register. Create Sales Invoice is the only
  //    counter-sale form: the retired Product Sale screen posted a stock
  //    operation with no invoice, VAT or receivable.
  const salesChildren: NavChildDef[] = [
    ...(isOperationAllowed('sales-invoice-create', currentUser?.role)
      ? [{ id: 'create-sale' as NavTab, label: 'Create Sales Invoice', icon: PlusCircle, section: 'Forms' }]
      : []),
    ...(isOperationAllowed('sales-return-create', currentUser?.role)
      ? [{ id: 'create-sales-return' as NavTab, label: 'Create Sales Return', icon: PlusCircle, section: 'Forms' }]
      : []),
    { id: 'device-exchange' as NavTab, label: 'Device Exchange & Replacement', icon: RefreshCw, section: 'Forms' },
    {
      id: 'sales-list' as NavTab,
      label: 'Sales Invoices Register',
      icon: Receipt,
      section: 'Registers',
    },
    ...(isOperationAllowed('sales-return-create', currentUser?.role)
      ? [{ id: 'sales-returns' as NavTab, label: 'Sales Returns Register', icon: Undo2, section: 'Registers' }]
      : []),
    { id: 'customer-devices' as NavTab, label: 'Customer Device Serials', icon: Smartphone, section: 'Registers' },
    ...(canViewWarranty
      ? [{ id: 'seller-warranty' as NavTab, label: 'Sellers Warranty', icon: ShieldAlert, section: 'Registers' }]
      : []),
  ];
  groups.push({
    id: 'sales',
    title: 'Sales & Customers',
    icon: Receipt,
    children: salesChildren,
  });

  // 5. Warehouse & Transfers — outbound dispatch first, then inbound/reporting.
  const warehouseChildren: NavChildDef[] = [];
  if (isOperationAllowed('shipment-create', currentUser?.role)) {
    warehouseChildren.push({
      id: 'create-shipment' as NavTab,
      label: 'Warehouse Shipment Dispatch',
      icon: Send,
      section: 'Dispatch & transfers',
    });
  }
  if (isOperationAllowed('branch-transfer-create', currentUser?.role)) {
    warehouseChildren.push({
      id: 'create-transfer' as NavTab,
      label: 'Create Inter-Branch Transfer',
      icon: Send,
      section: 'Dispatch & transfers',
    });
  }
  if (isOperationAllowed('branch-pullout-dispatch', currentUser?.role)) {
    warehouseChildren.push({
      id: 'pullout' as NavTab,
      label: 'Create Warehouse Pullout Bin',
      icon: ArrowUpRight,
      section: 'Dispatch & transfers',
    });
  }
  if (isOperationAllowed('wh-receive-pullouts', currentUser?.role)) {
    warehouseChildren.push({
      id: 'receive-shipment' as NavTab,
      label: 'Receive Inbound Stock & Pullouts',
      icon: Inbox,
      badge: warehouseInboundCount ?? inTransitShipmentCount,
      badgeColor: 'bg-amber-500 text-white',
      section: 'Receiving & reports',
    });
  }
  if (isOperationAllowed('branch-transfer-receive', currentUser?.role)) {
    warehouseChildren.push({
      id: 'receive-branch-transfer' as NavTab,
      label: 'Receive Branch Stock Transfer',
      icon: Inbox,
      badge: branchInboundCount ?? inTransitShipmentCount,
      badgeColor: 'bg-amber-500 text-white',
      section: 'Receiving & reports',
    });
  }
  if (isOperationAllowed('shipment-history', currentUser?.role)) {
    warehouseChildren.push({
      id: 'shipment-list' as NavTab,
      label: 'Shipment & Transfer Register',
      icon: ClipboardList,
      section: 'Receiving & reports',
    });
  }
  if (isOperationAllowed('pullout-report-view', currentUser?.role)) {
    warehouseChildren.push({
      id: 'pullout-report' as NavTab,
      label: 'Warehouse Pullout Report',
      icon: ClipboardList,
      section: 'Receiving & reports',
    });
  }
  if (warehouseChildren.length > 0) {
    groups.push({
      id: 'logistics',
      title: 'Warehouse & Transfers',
      icon: Truck,
      badgeCount:
        warehouseInboundCount !== undefined && branchInboundCount !== undefined
          ? warehouseInboundCount + branchInboundCount
          : inTransitShipmentCount,
      children: warehouseChildren,
    });
  }

  // 6. Finance & Accounting — the accounting registers first (each statement
  //    is its own register since the workspace split), then the management
  //    overview, ledgers, tax and the asset register.
  const financeChildren: NavChildDef[] = [];
  if (isOperationAllowed('gl-view', currentUser?.role)) {
    financeChildren.push(
      { id: 'accounting' as NavTab, label: 'Trial Balance', icon: Scale, section: 'Statements & ledgers' },
      { id: 'accounting-profit-loss' as NavTab, label: 'Profit & Loss', icon: TrendingUp, section: 'Statements & ledgers' },
      { id: 'accounting-balance-sheet' as NavTab, label: 'Balance Sheet', icon: Landmark, section: 'Statements & ledgers' },
      { id: 'accounting-cash-book' as NavTab, label: 'Cash & Bank Book', icon: Wallet, section: 'Statements & ledgers' },
      { id: 'accounting-aging' as NavTab, label: 'AR / AP Aging', icon: Clock, section: 'Statements & ledgers' },
      { id: 'accounting-chart' as NavTab, label: 'Chart & Defaults', icon: ListTree, section: 'Statements & ledgers' }
    );
  }
  if (isOperationAllowed('gl-view', currentUser?.role)) {
    financeChildren.push({
      id: 'cash-position' as NavTab,
      label: 'Daily Cash Close',
      icon: Wallet,
      section: 'Statements & ledgers',
    });
  }
  if (isOperationAllowed('fin-statements', currentUser?.role)) {
    financeChildren.push({
      id: 'financial-statements' as NavTab,
      label: 'Financial Overview',
      icon: Scale,
      section: 'Statements & ledgers',
    });
  }
  if (isOperationAllowed('inv-pay', currentUser?.role)) {
    financeChildren.push({
      id: 'vendor-ledger' as NavTab,
      label: 'Vendor Ledger & Payments',
      icon: Wallet,
      section: 'Statements & ledgers',
    });
  }
  if (isOperationAllowed('fin-statements', currentUser?.role)) {
    financeChildren.push({
      id: 'customer-ledger' as NavTab,
      label: 'Customer Ledger & Receivables',
      icon: Wallet,
      section: 'Statements & ledgers',
    });
  }
  if (isOperationAllowed('opening-stock-view', currentUser?.role)) {
    financeChildren.push({
      id: 'vendor-opening-balances' as NavTab,
      label: 'Vendor Opening Balances',
      icon: Wallet,
      section: 'Statements & ledgers',
    });
  }
  if (isOperationAllowed('vat-register', currentUser?.role)) {
    financeChildren.push({
      id: 'vat-register' as NavTab,
      label: 'VAT Sales & Purchase Register',
      icon: Receipt,
      section: 'Tax & assets',
    });
  }
  if (isOperationAllowed('assets-manage', currentUser?.role)) {
    financeChildren.push(
      { id: 'fixed-assets' as NavTab, label: 'Fixed Asset Register', icon: Building, section: 'Tax & assets' },
      { id: 'depreciation-register' as NavTab, label: 'Tax Depreciation Schedule', icon: Calculator, section: 'Tax & assets' }
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

  // 7. Master Data & Setup — products, parties, and the organisation tree.
  const inventorySetupChildren: NavChildDef[] = [
    ...(canViewProducts
      ? [{ id: 'product-master' as NavTab, label: 'Product Master Catalog', icon: Package, section: 'Products' }]
      : []),
    ...(isOperationAllowed('category-manage', currentUser?.role)
      ? [{ id: 'category-management' as NavTab, label: 'Category Management', icon: Grid, section: 'Products' }]
      : []),
    ...(isOperationAllowed('product-group-manage', currentUser?.role)
      ? [{ id: 'product-group-management' as NavTab, label: 'Product Group Management', icon: Layers, section: 'Products' }]
      : []),
    ...(isOperationAllowed('uom-manage', currentUser?.role)
      ? [{ id: 'uom-management' as NavTab, label: 'UoM Management', icon: Ruler, section: 'Products' }]
      : []),
    ...(isOperationAllowed('customers-manage', currentUser?.role)
      ? [{ id: 'customers' as NavTab, label: 'Customer Master Directory', icon: Users, section: 'Parties' }]
      : []),
    ...(isSuperAdmin
      ? [{ id: 'import-customers' as NavTab, label: 'Import Customers (CSV)', icon: UserPlus, section: 'Parties' }]
      : []),
    ...(isOperationAllowed('suppliers-manage', currentUser?.role)
      ? [{ id: 'suppliers' as NavTab, label: 'Suppliers Directory', icon: Users, section: 'Parties' }]
      : []),
    { id: 'locations' as NavTab, label: 'Location Management (POP/GPS)', icon: MapPin, section: 'Organisation' },
    ...(isOperationAllowed('admin-branches', currentUser?.role)
      ? [{ id: 'branches' as NavTab, label: 'Branch Management', icon: Building2, section: 'Organisation' }]
      : []),
  ];
  groups.push({
    id: 'inventory-setup',
    title: 'Master Data & Setup',
    icon: SlidersHorizontal,
    children: inventorySetupChildren,
  });

  // 8. Administration & Governance — configuration first, then the audit trail
  //    and destructive maintenance tools.
  const adminChildren: NavChildDef[] = [];
  if (isSuperAdmin) {
    adminChildren.push({ id: 'company-setup' as NavTab, label: 'Company Profile & Setup', icon: Building2, section: 'Setup' });
  }
  if (isOperationAllowed('admin-users', currentUser?.role)) {
    adminChildren.push({ id: 'users' as NavTab, label: 'Users & Staff Management', icon: UserCheck, section: 'Setup' });
  }
  if (isSuperAdmin) {
    adminChildren.push(
      { id: 'permissions' as NavTab, label: 'Role Permission Defaults', icon: ShieldCheck, section: 'Setup' },
      // The role matrix above sets role-wide defaults; this screen edits one
      // person's grants and denies, so the two must sit side by side.
      { id: 'user-permissions' as NavTab, label: 'User Access & Exceptions', icon: UserCheck, section: 'Setup' }
    );
  }
  if (isOperationAllowed('admin-fiscal', currentUser?.role)) {
    adminChildren.push(
      { id: 'fiscal-year-management' as NavTab, label: 'Document Numbering Setup', icon: CalendarDays, section: 'Setup' },
      { id: 'fiscal-year-closing' as NavTab, label: 'Fiscal Year Closing Wizard', icon: CalendarDays, section: 'Setup' }
    );
  }
  if (isSuperAdmin) {
    adminChildren.push({ id: 'bs-calendar' as NavTab, label: 'BS Calendar Utility', icon: CalendarDays, section: 'Setup' });
  } else if (currentUser?.role === 'HEAD_OFFICE_ADMIN') {
    // The BS Calendar Utility is Super-Admin-only, but a Head Office Admin may
    // seed the same calendar (see BS_SEEDING_TAB_BY_ROLE in services/api/http).
    // Without this entry the only way to reach the seeder was the action button
    // on a failure toast — a screen you can be sent to but can never find.
    adminChildren.push({
      id: 'nepali-fiscal' as NavTab,
      label: 'Nepali Fiscal & BS Calendar',
      icon: CalendarDays,
      section: 'Setup',
    });
  }
  if (isOperationAllowed('admin-audit', currentUser?.role)) {
    adminChildren.push({ id: 'audit' as NavTab, label: 'Audit Activities Log', icon: ClipboardList, section: 'Governance' });
  }
  if (isSuperAdmin) {
    adminChildren.push(
      { id: 'data-recalculation' as NavTab, label: 'Data Recalculation & Repair', icon: RefreshCw, section: 'Governance' },
      { id: 'clear-demo-data' as NavTab, label: 'Clear Demo / Dummy Data', icon: Trash2, section: 'Governance' }
    );
  }
  // `?.` because `import.meta.env` only exists under Vite: the A2/A6 render
  // tests mount this component in Node, where it is undefined.
  if (isSuperAdmin && import.meta.env?.DEV) {
    // DEV-ONLY: design-review gallery. Also gated at build time so it never
    // appears in production builds (render block is inert there too).
    adminChildren.push({
      id: 'dev-statcard' as NavTab,
      label: 'Dev: StatCard Gallery',
      icon: Palette,
      section: 'Governance',
    });
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

  // Group expansion is multi-open: the header offers Expand all / Collapse all,
  // and each group header toggles only itself. The group containing the active
  // tab opens on arrival so the current page is never hidden, but navigating
  // never closes groups the user opened deliberately.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() =>
    readStoredOpenGroups(
      getParentGroupId(activeTab),
      groups.map((group) => group.id)
    )
  );
  const [globalSearch, setGlobalSearch] = useState<string>('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Resizable rail. The width is px, not rem: the density tiers already shrink
  // the type, and a rem width would shrink with it exactly when the labels
  // need more room. 288 px is the old w-72 at the 100% tier.
  const [sidebarWidth, setSidebarWidth] = useState<number>(readStoredSidebarWidth);
  const sidebarWidthRef = useRef<number>(sidebarWidth);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  // Scroll container of the nav column + registered group header buttons.
  // Used to reveal a newly expanded group inside the VISIBLE area: expanding
  // a group near the bottom of the rail opens its sub-items below the fold,
  // so after the expansion we scroll the group header up toward the top of
  // the visible region (only when its content would overflow — expanding a
  // group that already fits never yanks the list around).
  const navScrollRef = useRef<HTMLElement>(null);
  const groupButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Opening a different page opens its group but leaves the others as they
  // were: replacing the set here would turn navigation into collapse-all.
  // The previous-value guard makes the mount run a no-op (a stored set, even
  // an empty Collapse-all one, wins) and is StrictMode-safe: the double-invoked
  // mount effect sees the same values and returns instead of opening the group.
  const lastActiveTabRef = useRef<NavTab | null>(null);
  useEffect(() => {
    const previous = lastActiveTabRef.current;
    lastActiveTabRef.current = activeTab;
    // Mount (including StrictMode's second invocation) is not navigation.
    // A permission-matrix refresh is not navigation either: forcing the active
    // group open there would undo a persisted Collapse all after every reload.
    if (previous === null || previous === activeTab) return;
    const parent = getParentGroupId(activeTab);
    setExpandedGroups((prev) => (prev.has(parent) ? prev : new Set([...prev, parent])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Persist the open set after every change, including the initial read.
  useEffect(() => {
    persistOpenGroups(expandedGroups);
  }, [expandedGroups]);

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

  // Scroll the given group's header into the visible area of the nav column
  // if any of its expanded content currently sits below the fold. Runs in a
  // rAF so the expanded children are rendered and measurable first.
  const revealGroup = (groupId: string) => {
    requestAnimationFrame(() => {
      const container = navScrollRef.current;
      const btn = groupButtonRefs.current.get(groupId);
      if (!container || !btn) return;
      const containerTop = container.getBoundingClientRect().top;
      const btnTopInClient = btn.getBoundingClientRect().top - containerTop;
      // The expanded sub-item list is the button's next sibling.
      const content = btn.nextElementSibling as HTMLElement | null;
      const contentBottomInClient = content
        ? content.getBoundingClientRect().bottom - containerTop
        : btnTopInClient + btn.offsetHeight;
      if (contentBottomInClient > container.clientHeight) {
        // Bring the group header to the top of the visible area (minus a
        // small breathing gap), clamped to the scrollable range.
        const target = container.scrollTop + (btnTopInClient - 8);
        const maxScroll = container.scrollHeight - container.clientHeight;
        container.scrollTo({ top: Math.max(0, Math.min(target, maxScroll)), behavior: 'smooth' });
      }
    });
  };

  // Toggling one group leaves every other group exactly as it was.
  const toggleGroup = (groupId: string) => {
    const willExpand = !expandedGroups.has(groupId);
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (willExpand) next.add(groupId);
      else next.delete(groupId);
      return next;
    });
    if (willExpand) revealGroup(groupId);
  };

  const visibleGroupIds = groups.map((group) => group.id);
  const allGroupsExpanded =
    visibleGroupIds.length > 0 && visibleGroupIds.every((id) => expandedGroups.has(id));
  const anyGroupExpanded = visibleGroupIds.some((id) => expandedGroups.has(id));
  const expandAllGroups = () => setExpandedGroups(new Set(visibleGroupIds));
  const collapseAllGroups = () => setExpandedGroups(new Set());

  const handleSubItemClick = (tab: NavTab) => {
    onSelectTab(tab);
    if (onCloseMobile) {
      onCloseMobile();
    }
  };

  // ----- Resizable rail --------------------------------------------------
  // Pointer capture keeps the drag alive when the cursor leaves the 10 px
  // handle; keyboard support makes the same width reachable without a mouse.
  const commitSidebarWidth = (next: number): number => {
    const clamped = clampSidebarWidth(next);
    sidebarWidthRef.current = clamped;
    setSidebarWidth(clamped);
    return clamped;
  };

  const handleSidebarResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    resizeStartRef.current = { x: event.clientX, width: sidebarWidthRef.current };
    setIsResizingSidebar(true);
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* jsdom / unsupported */ }
    event.preventDefault();
  };

  const handleSidebarResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    commitSidebarWidth(start.width + (event.clientX - start.x));
  };

  const handleSidebarResizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeStartRef.current) return;
    resizeStartRef.current = null;
    setIsResizingSidebar(false);
    persistSidebarWidth(sidebarWidthRef.current);
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* jsdom / unsupported */ }
  };

  const handleSidebarResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = sidebarWidthRef.current - 16;
    else if (event.key === 'ArrowRight') next = sidebarWidthRef.current + 16;
    else if (event.key === 'Home') next = SIDEBAR_MIN_WIDTH;
    else if (event.key === 'End') next = SIDEBAR_MAX_WIDTH;
    if (next === null) return;
    event.preventDefault();
    persistSidebarWidth(commitSidebarWidth(next));
  };

  const resetSidebarWidth = () => {
    persistSidebarWidth(commitSidebarWidth(SIDEBAR_DEFAULT_WIDTH));
  };

  useEffect(() => {
    if (!isResizingSidebar) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isResizingSidebar]);


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
    opts: { showGroupLabel?: boolean; groupTitle?: string; query?: string; sectionLabel?: string } = {}
  ) => {
    const isActive = activeTab === child.id;
    const ItemIcon = child.icon;
    return (
      <React.Fragment key={child.id}>
        {opts.sectionLabel && (
          <h3
            data-nav-section={opts.sectionLabel}
            className="sticky top-0 z-10 px-3 pt-2.5 pb-1 text-[0.5625rem] font-bold uppercase tracking-[0.14em] text-slate-400/90 bg-white dark:bg-[#0f1218] dark:text-slate-500"
          >
            {opts.sectionLabel}
          </h3>
        )}
        <button
          data-nav-item={child.id}
          onClick={() => handleSubItemClick(child.id)}
          aria-current={isActive ? 'page' : undefined}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-[0.8125rem] transition-all cursor-pointer font-medium ${
            isActive
              ? 'bg-indigo-50 text-indigo-900 font-semibold border-l-3 border-indigo-700 shadow-xs dark:bg-indigo-600/20 dark:text-indigo-300 dark:font-semibold dark:border-l-3 dark:border-indigo-500 dark:shadow-xs'
              : 'border-l-3 border-transparent text-slate-600 hover:text-indigo-900 hover:bg-slate-100 dark:border-l-3 dark:border-transparent dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/50'
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <ItemIcon className={`h-4 w-4 flex-shrink-0 ${isActive ? 'text-indigo-500' : 'text-slate-400'}`} />
            <span className="text-left leading-snug break-words" title={child.label}>
              {highlightMatch(child.label, opts.query || '')}
            </span>
          </div>

          {child.badge !== undefined && child.badge > 0 && (
            <span
              className={`ml-1.5 px-2 py-0.5 rounded-full text-[0.625rem] font-bold flex-shrink-0 ${
                child.badgeColor ||
                'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
              }`}
            >
              {child.badge}
            </span>
          )}
        </button>
        {opts.showGroupLabel && opts.groupTitle && (
          <p className="px-3 pb-1 -mt-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 truncate text-left">
            {opts.groupTitle}
          </p>
        )}
      </React.Fragment>
    );
  };

  return (
    <aside
      data-sidebar-width={sidebarWidth}
      style={{ width: `${sidebarWidth}px`, maxWidth: '85vw' }}
      className={`responsive-sidebar w-72 h-full flex flex-col flex-shrink-0 select-none relative bg-white text-slate-800 border-r border-slate-200 dark:bg-[#0f1218] dark:text-slate-300 dark:border-slate-800/80`}
    >
      {/* Drag the rail wider when a menu label needs more room. Hidden on the
          mobile drawer, where the drawer is already 85vw at most. */}
      <div
        data-sidebar-resize-handle
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize navigation sidebar"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        title="Drag to resize the menu. Double-click to reset."
        onPointerDown={handleSidebarResizeStart}
        onPointerMove={handleSidebarResizeMove}
        onPointerUp={handleSidebarResizeEnd}
        onPointerCancel={handleSidebarResizeEnd}
        onKeyDown={handleSidebarResizeKeyDown}
        onDoubleClick={resetSidebarWidth}
        className="group hidden md:flex absolute inset-y-0 -right-1 z-30 w-2.5 cursor-col-resize touch-none items-center justify-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70"
      >
        <span
          className={`h-10 w-1 rounded-full transition-colors ${
            isResizingSidebar
              ? 'bg-indigo-500'
              : 'bg-slate-400/70 group-hover:bg-indigo-500/80 dark:bg-slate-500/70 dark:group-hover:bg-indigo-400/80'
          }`}
        />
      </div>
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

      {/* Mobile view scope: the header hides branch/FY below md, so the drawer
          owns the same company-wide controls instead of leaving phones with no
          way to change what the whole app is showing. */}
      {onCloseMobile && branches.length > 0 && (
        <div className="md:hidden px-3 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40">
          <ViewScopeControls
            currentUser={currentUser || null}
            branches={branches}
            selectedBranchId={selectedBranchId}
            onSelectBranch={onSelectBranch}
            fiscalYears={fiscalYears}
            selectedFiscalYearId={selectedFiscalYearId}
            onSelectFiscalYear={onSelectFiscalYear}
            variant="drawer"
          />
        </div>
      )}

      {/* MENU CONTROLS: expand or collapse every group at once. Individual
          group headers still toggle only themselves. */}
      <div
        className={`px-2.5 py-1.5 border-b flex items-center gap-1 border-slate-100 bg-slate-50/80 dark:border-slate-800/80 dark:bg-slate-900/50`}
      >
        <button
          type="button"
          onClick={expandAllGroups}
          disabled={allGroupsExpanded}
          title="Expand every menu group"
          aria-label="Expand all menu groups"
          className="flex-1 min-w-0 flex items-center justify-center gap-1 px-1.5 py-1 rounded-lg text-[0.625rem] font-semibold uppercase tracking-wide text-slate-500 hover:text-indigo-700 hover:bg-indigo-50 dark:text-slate-400 dark:hover:text-indigo-300 dark:hover:bg-indigo-600/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-slate-500 dark:disabled:hover:text-slate-400"
        >
          <ChevronsDown className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="whitespace-nowrap">Expand all</span>
        </button>
        <button
          type="button"
          onClick={collapseAllGroups}
          disabled={!anyGroupExpanded}
          title="Collapse every menu group"
          aria-label="Collapse all menu groups"
          className="flex-1 min-w-0 flex items-center justify-center gap-1 px-1.5 py-1 rounded-lg text-[0.625rem] font-semibold uppercase tracking-wide text-slate-500 hover:text-indigo-700 hover:bg-indigo-50 dark:text-slate-400 dark:hover:text-indigo-300 dark:hover:bg-indigo-600/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-slate-500 dark:disabled:hover:text-slate-400"
        >
          <ChevronsUp className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="whitespace-nowrap">Collapse all</span>
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
              className="text-[0.625rem] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
              title="Clear"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* NAV CONTENT: groups expand inline below their header, independently */}
      <nav
        ref={navScrollRef}
        aria-label="Main navigation"
        className="py-2 px-2 flex-1 overflow-y-auto custom-scrollbar sidebar-hover-scrollbar"
      >
        {globalSearch.trim() ? (
          globalSearchResults.length > 0 ? (
            globalSearchResults.map(({ child, group }) => (
              <div key={`${group.id}-${child.id}`}>
                {renderItemButton(child, { query: globalSearch })}
                <p className="pl-10 pr-3 pb-1 -mt-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 truncate text-left">
                  {child.section ? `${group.title} · ${child.section}` : group.title}
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
              <div key={group.id} data-nav-group={group.id} className="mb-0.5">
                <button
                  ref={(el) => {
                    if (el) groupButtonRefs.current.set(group.id, el);
                    else groupButtonRefs.current.delete(group.id);
                  }}
                  id={`nav-group-button-${group.id}`}
                  onClick={() => toggleGroup(group.id)}
                  title={group.title}
                  aria-expanded={isExpanded}
                  aria-controls={isExpanded ? `nav-group-${group.id}` : undefined}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-[0.8125rem] font-semibold transition-all cursor-pointer ${
                    containsActive
                      ? 'text-indigo-900 bg-indigo-50/60 dark:text-indigo-300 dark:bg-indigo-600/10'
                      : 'text-slate-700 hover:text-indigo-900 hover:bg-slate-100 dark:text-slate-300 dark:hover:text-slate-100 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <GroupIcon className={`h-5 w-5 flex-shrink-0 ${containsActive ? 'text-indigo-500' : 'text-slate-400'}`} />
                    <span className="text-left leading-snug break-words" title={group.title}>
                      {group.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {group.badgeCount !== undefined && group.badgeCount > 0 && (
                      <span className="flex h-4.5 min-w-4.5 px-1.5 items-center justify-center rounded-full bg-rose-500 text-[0.625rem] font-bold text-white shadow-xs">
                        {group.badgeCount > 99 ? '99+' : group.badgeCount}
                      </span>
                    )}
                    <ChevronDown
                      className={`h-4 w-4 text-slate-400 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                    />
                  </div>
                </button>

                {isExpanded && (
                  <div id={`nav-group-${group.id}`} className="mt-0.5 mb-1.5 ml-4 pl-2.5 border-l-2 border-slate-200 dark:border-slate-800 space-y-0.5">
                    {group.children.map((child, idx) => {
                      const previousSection = group.children[idx - 1]?.section;
                      const sectionLabel =
                        child.section && child.section !== previousSection
                          ? child.section
                          : undefined;
                      return renderItemButton(child, { query: globalSearch, sectionLabel });
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </nav>
          {/* FOOTER: Help link + Company card */}
          <div className="px-2 pb-2 space-y-1">
            <button
              onClick={() => handleSubItemClick('help-documentation')}
              aria-current={activeTab === 'help-documentation' ? 'page' : undefined}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[0.8125rem] font-medium transition-all cursor-pointer ${
                activeTab === 'help-documentation'
                  ? 'bg-indigo-50 text-indigo-900 dark:bg-indigo-600/20 dark:text-indigo-300'
                  : 'text-slate-600 hover:text-indigo-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/50'
              }`}
            >
              <HelpCircle className={`h-4 w-4 ${activeTab === 'help-documentation' ? 'text-indigo-500' : 'text-slate-400'}`} />
              <span className="text-left leading-snug truncate" title="Help Center & Manual">
                Help Center & Manual
              </span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => onSelectTab('company-setup')}
            aria-current={activeTab === 'company-setup' ? 'page' : undefined}
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
                <p className="text-[0.6875rem] font-extrabold truncate text-slate-900 dark:text-slate-100 font-serif leading-tight group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                  {companyProfile?.name || 'Inventory'}
                </p>
                <span className="text-[0.5625rem] font-bold px-1.5 py-0.2 rounded-md bg-indigo-100 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800" title="PostgreSQL Database Connected">
                  DB
                </span>
              </div>
              <p className="text-[0.5625rem] font-medium text-slate-500 dark:text-slate-400 truncate leading-tight mt-0.5">
                {getCompanyLocation(companyProfile) || 'Enterprise Multi-Branch Ed.'}
              </p>
            </div>
          </button>
    </aside>
  );
};
