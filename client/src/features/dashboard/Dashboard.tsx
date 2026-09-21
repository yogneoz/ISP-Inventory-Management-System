import React, { useState } from 'react';
import {
  Branch,
  Product,
  InventoryStock,
  Asset,
  PurchaseOrder,
  Shipment,
  TransactionLog,
  FinancialSummary,
  User,
  ApprovalRequest,
  Category,
} from '../../types';
import { ApprovalWorkflowCenter } from '../settings/ApprovalWorkflowCenter';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { isOperationAllowed, getAllowedBranches, getAllowedBranchIds, canUserSeeAllBranches } from '../../utils/permissions';
import { calculateFixedAssetValues } from '../../utils/depreciation';
import { useDarkMode } from '../../contexts/DarkModeContext';
import { formatNPR, formatNPRInteger } from '../../utils/nprFormat';
import {
  TrendingUp,
  AlertTriangle,
  Package,
  Landmark,
  ShoppingCart,
  Truck,
  ArrowUpRight,
  Plus,
  Layers,
  ArrowDownRight,
  CheckCircle2,
  FileSpreadsheet,
  Eye,
  ChevronDown,
  ChevronUp,
  Search,
  ArrowRight,
  SlidersHorizontal,
  Tag,
  Lock,
  ShieldCheck,
} from 'lucide-react';

interface DashboardProps {
  currentUser?: User | null;
  products: Product[];
  stock: InventoryStock[];
  branches: Branch[];
  assets: Asset[];
  purchaseOrders: PurchaseOrder[];
  shipments: Shipment[];
  transactionLogs: TransactionLog[];
  financialSummary: FinancialSummary;
  categories: Category[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  asOfDateAD?: string;
  approvalRequests?: ApprovalRequest[];
  onProcessApproval?: (
    id: string,
    status: 'APPROVED' | 'REJECTED',
    rejectionReason?: string
  ) => Promise<void>;
  onNavigateTab: (tab: any) => void;
  onSelectBranch?: (branchId: string) => void;
  onGroupLowStockPO?: () => void;
  onUpdateStockLevel?: (stockId: string, newQty: number, reason: string) => Promise<void>;
}

export const Dashboard: React.FC<DashboardProps> = ({
  currentUser,
  products,
  stock,
  branches,
  assets,
  purchaseOrders,
  shipments,
  transactionLogs,
  financialSummary,
  categories,
  selectedBranchId,
  dateMode,
  asOfDateAD,
  approvalRequests = [],
  onProcessApproval,
  onNavigateTab,
  onSelectBranch,
  onGroupLowStockPO,
  onUpdateStockLevel,
}) => {
  // Quick Stock Adjustment Modal State
  const [isAdjustModalOpen, setIsAdjustModalOpen] = useState(false);
  const [selectedStockId, setSelectedStockId] = useState('');
  const [adjustQty, setAdjustQty] = useState<number>(1);
  const [adjustAction, setAdjustAction] = useState<'ADD' | 'REMOVE'>('ADD');
  const [adjustReason, setAdjustReason] = useState('Physical Stock Audit');

  // Special Hardware Table State — dynamic tabs derived from categories with isSpecialTracked
  const specialTrackedCategories = categories.filter((c) => c.isSpecialTracked);
  const [specialCategoryTab, setSpecialCategoryTab] = useState<string>('ALL');
  const [specialSearchQuery, setSpecialSearchQuery] = useState('');
  const [expandedSpecialProductIds, setExpandedSpecialProductIds] = useState<Set<string>>(
    new Set()
  );

  // Low Stock Table Expandable State
  const [expandedLowStockIds, setExpandedLowStockIds] = useState<Set<string>>(new Set());

  const toggleSpecialExpand = (productId: string) => {
    setExpandedSpecialProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const toggleLowStockExpand = (itemId: string) => {
    setExpandedLowStockIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const handleApplyAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStockId || !onUpdateStockLevel) return;

    const currentItem = stock.find((s) => s.id === selectedStockId);
    if (!currentItem) return;

    const newQty =
      adjustAction === 'ADD'
        ? currentItem.quantityOnHand + Number(adjustQty)
        : Math.max(0, currentItem.quantityOnHand - Number(adjustQty));

    await onUpdateStockLevel(
      selectedStockId,
      newQty,
      `Quick ${adjustAction === 'ADD' ? 'Stock Entry (+)' : 'Stock Removal (-)'}: ${adjustReason}`
    );
    setIsAdjustModalOpen(false);
  };

  const allowedBranches = getAllowedBranches(currentUser, branches);
  const allowedBranchIds = getAllowedBranchIds(currentUser, branches);
  const canSeeAll = canUserSeeAllBranches(currentUser);

  const activeBranches =
    selectedBranchId === 'ALL'
      ? allowedBranches
      : allowedBranches.filter((b) => b.id === selectedBranchId);

  // Filter stock by branch if selected
  const filteredStock =
    selectedBranchId === 'ALL'
      ? stock.filter((s) => canSeeAll || allowedBranchIds.includes(s.branchId))
      : stock.filter((s) => s.branchId === selectedBranchId);

  // Compute total inventory value
  const totalStockValuation = filteredStock.reduce((sum, item) => {
    const prod = products.find((p) => p.id === item.productId);
    return sum + (prod ? prod.costPrice * item.quantityOnHand : 0);
  }, 0);

  // Low stock items for filtered stock
  const lowStockItems = filteredStock.filter((s) => {
    const prod = products.find((p) => p.id === s.productId);
    if (!prod) return false;
    const thresh = s.minReorderLevel ?? prod.minReorderLevel;
    return thresh > 0 ? s.quantityOnHand <= thresh : s.quantityOnHand <= 0;
  });

  // Consolidated Low Stock Products across active branches (per-branch reorder threshold evaluation)
  const consolidatedLowStockProducts = products.filter((prod) => {
    let totalOnHand = 0;
    let totalConsolidatedReorder = 0;
    let isAnyBranchLow = false;

    activeBranches.forEach((b) => {
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
      } else if (threshold === 0 && onHand <= 0) {
        isAnyBranchLow = true;
      }
    });

    return isAnyBranchLow || (totalConsolidatedReorder > 0 && totalOnHand <= totalConsolidatedReorder);
  });

  // Pending POs filtered by branch context
  const filteredPOs =
    selectedBranchId === 'ALL'
      ? purchaseOrders.filter((po) => canSeeAll || allowedBranchIds.includes(po.branchId))
      : purchaseOrders.filter((po) => po.branchId === selectedBranchId);

  const pendingPOs = filteredPOs.filter(
    (po) =>
      po.status === 'SENT' || po.status === 'APPROVED' || po.status === 'DRAFT'
  );

  // Active Shipments filtered by branch context
  const filteredShipments =
    selectedBranchId === 'ALL'
      ? shipments.filter((sh) => canSeeAll || allowedBranchIds.includes(sh.destinationBranchId) || (sh.sourceBranchId ? allowedBranchIds.includes(sh.sourceBranchId) : false))
      : shipments.filter(
          (sh) =>
            sh.destinationBranchId === selectedBranchId ||
            sh.sourceBranchId === selectedBranchId
        );

  const activeShipments = filteredShipments.filter(
    (sh) => sh.status === 'DISPATCHED' || sh.status === 'IN_TRANSIT'
  );

  // Total Fixed Assets Net Book Value filtered by branch context
  const filteredAssets =
    selectedBranchId === 'ALL'
      ? assets.filter((a) => canSeeAll || allowedBranchIds.includes(a.branchId))
      : assets.filter((a) => a.branchId === selectedBranchId);

  // Recalculate NBV using depreciation formula to match Fixed Asset Register
  const totalAssetNBV = filteredAssets.reduce((sum, a) => {
    const computed = calculateFixedAssetValues({
      ...a,
      acquisitionDateAD: a.placedInServiceDateAD || a.acquisitionDateAD,
      asOfDateAD: asOfDateAD || new Date().toISOString().slice(0, 10),
    });
    return sum + Number(computed.netBookValue ?? 0);
  }, 0);

  // Filter products for Special Hardware table — dynamic, driven by categories
  // where isSpecialTracked=true. Only serial / MAC / PON tracked products
  // (i.e. requiresSerialTracking !== false and trackingType !== QUANTITY_ONLY)
  // are shown in the table.
  const specialTrackedCatNames = new Set(
    specialTrackedCategories.map((c) => c.name.toLowerCase().trim())
  );

  const specialProducts = products.filter((p) => {
    const prodCat = (p.category || '').toLowerCase().trim();
    const isSpecial = specialTrackedCatNames.has(prodCat);
    if (!isSpecial) return false;
    // Serial Track enable check — the table only lists serial-tracked hardware
    const isSerialized =
      p.requiresSerialTracking !== false && p.trackingType !== 'QUANTITY_ONLY';
    if (!isSerialized) return false;
    if (specialCategoryTab !== 'ALL') {
      // Match the selected tab's category id to the product's category name
      const tabCat = specialTrackedCategories.find((c) => c.id === specialCategoryTab);
      if (!tabCat) return false;
      if (prodCat !== tabCat.name.toLowerCase().trim()) return false;
    }
    if (specialSearchQuery.trim()) {
      const q = specialSearchQuery.toLowerCase();
      return (
        (p?.name || '').toLowerCase().includes(q) ||
        (p?.sku || '').toLowerCase().includes(q) ||
        prodCat.includes(q)
      );
    }
    return true;
  });

  // Card container class helper
  const cardBg = 'bg-white border-slate-200 text-slate-800 shadow-xs dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-300';
  const cardTitleText = 'text-slate-900 dark:text-white';
  const cardSubText = 'text-slate-600 dark:text-slate-400';

  return (
    <div className="space-y-3">
      {/* Top Welcome Banner */}
      <div
        className={`rounded-xl p-3.5 text-white shadow-md border relative overflow-hidden transition-colors duration-200 bg-gradient-to-r from-[#1a237e] via-[#283593] to-[#0d47a1] border-indigo-900 dark:bg-gradient-to-r dark:from-[#0f1218] dark:via-indigo-950/40 dark:to-[#0f1218] dark:border-slate-800`}
      >
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-2.5">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="rounded-full bg-emerald-500/20 text-emerald-300 text-[9px] font-bold px-2 py-0.2 border border-emerald-400/30">
                ● Live Realtime Sync
              </span>
              <span className="text-indigo-100/80 text-[11px] font-medium">
                {selectedBranchId === 'ALL'
                  ? 'Consolidated - All Branches'
                  : branches.find((b) => b.id === selectedBranchId)?.name}
              </span>
            </div>
            <h2 className="text-lg font-serif font-bold tracking-tight text-white">
              Executive Inventory & Financial Dashboard
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => onNavigateTab('financial-statements')}
              className="flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/20 px-3 py-1.5 text-xs font-semibold text-white border border-white/20 backdrop-blur-xs transition-all cursor-pointer"
            >
              <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-300" />
              <span>Financial Statements</span>
            </button>
          </div>
        </div>
      </div>

      {/* KPI Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* KPI 1: Inventory Asset Value */}
        <div className={`rounded-xl p-3 border shadow-2xs ${cardBg}`}>
          <div className="flex items-center justify-between">
            <span
              className={`text-[10px] font-bold uppercase text-slate-500 dark:text-slate-400`}
            >
              Total Stock Valuation
            </span>
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-lg border bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-400 dark:border-indigo-500/20`}
            >
              <Package className="h-3.5 w-3.5" />
            </div>
          </div>
          <div className={`mt-1 text-xl font-serif font-bold ${cardTitleText}`}>
            {formatNPR(totalStockValuation)}
          </div>
          <div className={`mt-1 flex items-center justify-between text-[10px] ${cardSubText}`}>
            <span>{filteredStock.length} SKU Locations</span>
            <span className={`font-medium text-indigo-600 dark:text-indigo-400`}>Cost Basis</span>
          </div>
        </div>

        {/* KPI 2: Fixed Assets Value */}
        <div className={`rounded-xl p-3 border shadow-2xs ${cardBg}`}>
          <div className="flex items-center justify-between">
            <span
              className={`text-[10px] font-bold uppercase text-slate-500 dark:text-slate-400`}
            >
              Fixed Asset Net Value
            </span>
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-lg border bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-400 dark:border-emerald-500/20`}
            >
              <Landmark className="h-3.5 w-3.5" />
            </div>
          </div>
          <div className={`mt-1 text-xl font-serif font-bold ${cardTitleText}`}>
            {formatNPR(totalAssetNBV)}
          </div>
          <div className={`mt-1 flex items-center justify-between text-[10px] ${cardSubText}`}>
            <span>{assets.length} Active Assets</span>
            <span className={`font-medium text-emerald-600 dark:text-emerald-400`}>Net Book Value</span>
          </div>
        </div>

        {/* KPI 3: Low Stock Warning */}
        <div
          onClick={() => onNavigateTab('reorder-stock')}
          className={`rounded-xl p-3 border shadow-2xs transition-all cursor-pointer group bg-white border-rose-200 hover:border-rose-300 hover:shadow-xs dark:bg-[#0f1218] dark:border-slate-800 dark:hover:border-slate-700`}
        >
          <div className="flex items-center justify-between">
            <span
              className={`text-[10px] font-bold uppercase text-slate-500 dark:text-slate-400`}
            >
              Low Stock Alerts
            </span>
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-lg border group-hover:scale-105 transition-transform bg-rose-50 text-rose-600 border-rose-200 dark:bg-rose-950/60 dark:text-rose-400 dark:border-rose-500/20`}
            >
              <AlertTriangle className="h-3.5 w-3.5" />
            </div>
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className={`text-xl font-serif font-bold text-rose-600 dark:text-rose-400`}>
              {consolidatedLowStockProducts.length} SKUs
            </span>
            <span className={`text-[10px] font-medium text-rose-600 dark:text-rose-400`}>Below Reorder</span>
          </div>
          <div className={`mt-1 flex items-center justify-between text-[10px] ${cardSubText}`}>
            <span>Requires Action</span>
            <span className={`font-medium group-hover:underline flex items-center gap-0.5 text-rose-600 dark:text-rose-400`}>
              <span>View Reorder</span>
              <ArrowRight className="h-3 w-3" />
            </span>
          </div>
        </div>

        {/* KPI 4: Pending POs & In-Transit */}
        <div className={`rounded-xl p-3 border shadow-2xs ${cardBg}`}>
          <div className="flex items-center justify-between">
            <span
              className={`text-[10px] font-bold uppercase text-slate-500 dark:text-slate-400`}
            >
              Procurement & Shipments
            </span>
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-lg border bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-400 dark:border-blue-500/20`}
            >
              <Truck className="h-3.5 w-3.5" />
            </div>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <div>
              <div className={`text-lg font-serif font-bold ${cardTitleText}`}>
                {pendingPOs.length} Pending POs
              </div>
              <div className={`text-[10px] mt-0.5 ${cardSubText}`}>
                {activeShipments.length} Active Shipments
              </div>
            </div>
            <button
              onClick={() => onNavigateTab('po-list')}
              className={`p-1 rounded-lg transition-colors cursor-pointer text-blue-600 hover:bg-slate-200 dark:text-blue-400 dark:hover:bg-slate-800`}
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 1. LOW STOCK & REORDER ALERTS (Consolidated Total - Top Priority) */}
      <div className={`rounded-2xl border shadow-xs overflow-hidden ${cardBg}`}>
        <div
          className={`flex flex-wrap items-center justify-between p-4 sm:p-5 gap-3 border-b border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/30`}
        >
          <div>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-rose-500" />
              <h3 className={`font-bold text-base ${cardTitleText}`}>
                Low Stock & Reorder Alerts (Consolidated Total)
              </h3>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border border-rose-300 dark:border-rose-700">
                {consolidatedLowStockProducts.length} SKUs
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Consolidated stock sum across all branches that are below min reorder thresholds or out of stock. Expand any row to see branch availability.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigateTab('reorder-stock')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold border transition-colors cursor-pointer bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100 dark:bg-amber-950/80 dark:text-amber-300 dark:border-amber-500/40 dark:hover:bg-amber-900`}
            >
              <Eye className="h-3.5 w-3.5 text-amber-500" />
              <span>View Reorder Stocks</span>
            </button>

            {(() => {
              const isSuperOrInventoryManager =
                currentUser?.role === 'SUPER_ADMIN' || currentUser?.role === 'INVENTORY_MANAGER';
              if (!isSuperOrInventoryManager) return null;

              return (
                <>
                  <button
                    type="button"
                    title="Quick Stock Entry or Removal"
                    onClick={() => setIsAdjustModalOpen(true)}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold border transition-colors cursor-pointer bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100 dark:bg-emerald-950/80 dark:text-emerald-300 dark:border-emerald-500/40 dark:hover:bg-emerald-900`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Quick Add / Remove Stock</span>
                  </button>

                  <button
                    type="button"
                    title="Group low stock products and generate PO"
                    onClick={() => {
                      if (onGroupLowStockPO) {
                        onGroupLowStockPO();
                      } else {
                        onNavigateTab('create-po');
                      }
                    }}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold border transition-colors cursor-pointer bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700 shadow-md shadow-indigo-200 dark:bg-indigo-600 dark:text-white dark:border-indigo-500 dark:hover:bg-indigo-500 dark:shadow-md dark:shadow-indigo-950/50`}
                  >
                    <ShoppingCart className="h-3.5 w-3.5" />
                    <span>Group Products & Create Single PO</span>
                  </button>
                </>
              );
            })()}
          </div>
        </div>

        {consolidatedLowStockProducts.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-xs flex flex-col items-center justify-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-500 mb-2" />
            <span>All stock levels across all branches are optimal above reorder thresholds!</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead
                className={`font-bold uppercase text-[10px] tracking-wider border-b bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900/50 dark:text-slate-400 dark:border-slate-800`}
              >
                <tr>
                  <th className="px-2.5 py-1.5 w-8"></th>
                  <th className="px-2.5 py-1.5">Product Name</th>
                  <th className="px-2.5 py-1.5">SKU / Code</th>
                  <th className="px-2.5 py-1.5">Category</th>
                  <th className="px-2.5 py-1.5 text-center">UOM</th>
                  <th className="px-2.5 py-1.5 text-right">Cost Rate (NPR)</th>
                  <th className={`px-2.5 py-1.5 text-right font-extrabold text-rose-600 dark:text-rose-400`}>
                    Total Available Stock
                  </th>
                  <th className="px-2.5 py-1.5 text-right">Min Reorder Level</th>
                  <th className="px-2.5 py-1.5 text-center">Status</th>
                  <th className="px-2.5 py-1.5 text-center w-28">Action</th>
                </tr>
              </thead>
              <tbody
                className={`divide-y divide-slate-100 dark:divide-slate-800`}
              >
                {consolidatedLowStockProducts.map((prod) => {
                  const isExpanded = expandedLowStockIds.has(prod.id);

                  // Branch breakdown for this low stock item, scoped to the
                  // current dashboard branch view (selected branch, or all allowed)
                  const scopeBranches =
                    selectedBranchId === 'ALL'
                      ? activeBranches
                      : activeBranches.filter((b) => b.id === selectedBranchId);

                  const branchBreakdown = scopeBranches.map((b) => {
                    const st = stock.find(
                      (s) => s.productId === prod.id && s.branchId === b.id
                    );
                    const threshold =
                      st?.minReorderLevel !== undefined && st?.minReorderLevel !== null
                        ? st.minReorderLevel
                        : prod.minReorderLevel;
                    return {
                      branchId: b.id,
                      branchName: b.name,
                      branchCode: b.code,
                      quantityOnHand: st ? Number(st.quantityOnHand) : 0,
                      minReorderLevel: threshold,
                    };
                  });

                  const totalAvailableStock = branchBreakdown.reduce(
                    (sum, b) => sum + b.quantityOnHand,
                    0
                  );

                  const totalConsolidatedReorder = branchBreakdown.reduce(
                    (sum, b) => sum + b.minReorderLevel,
                    0
                  );

                  const isOut = totalAvailableStock <= 0;

                  return (
                    <React.Fragment key={prod.id}>
                      <tr
                        onClick={() => toggleLowStockExpand(prod.id)}
                        className={`transition-colors cursor-pointer ${isExpanded ? 'bg-rose-50/50 dark:bg-rose-950/30' : 'hover:bg-slate-200 dark:hover:bg-slate-800/40'}`}
                      >
                        <td className="p-2.5 text-center">
                          <button
                            type="button"
                            className={`p-1 cursor-pointer text-slate-400 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400`}
                          >
                            {isExpanded ? (
                              <ChevronUp className={`h-4 w-4 text-rose-600 dark:text-rose-400`} />
                            ) : (
                              <ChevronDown className="h-4 w-4" />
                            )}
                          </button>
                        </td>

                        <td className={`p-2.5 font-bold ${cardTitleText}`}>
                          {prod.name}
                        </td>

                        <td className="p-2.5 font-mono text-[11px] text-slate-500">
                          {prod.sku}
                        </td>

                        <td className="p-2.5 text-slate-500">{prod.category}</td>

                        <td className="p-2.5 text-center font-semibold text-slate-500 font-mono">
                          {prod.unit}
                        </td>

                        <td className={`p-2.5 text-right font-mono text-slate-600 dark:text-slate-400 dark:text-slate-400`}>
                          {formatNPR(prod.costPrice)}
                        </td>

                        <td className={`p-2.5 text-right font-mono font-extrabold text-sm text-rose-600 dark:text-rose-400`}>
                          {(totalAvailableStock ?? 0).toLocaleString('en-IN')} {prod.unit}
                        </td>

                        <td className={`p-2.5 text-right font-mono text-slate-500 dark:text-slate-400`}>
                          {totalConsolidatedReorder || prod.minReorderLevel} {prod.unit}
                        </td>

                        <td className="p-2.5 text-center">
                          {isOut ? (
                            <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border border-rose-200">
                              Out of Stock
                            </span>
                          ) : (
                            <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-200">
                              Low Stock
                            </span>
                          )}
                        </td>

                        <td className="p-2.5 text-center">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleLowStockExpand(prod.id);
                            }}
                            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-colors cursor-pointer bg-rose-50 hover:bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-950/80 dark:text-rose-300 dark:border-rose-800 dark:hover:bg-rose-900`}
                          >
                            {isExpanded ? 'Hide' : 'Branch Wise'}
                          </button>
                        </td>
                      </tr>

                      {/* Expandable Branch Breakdown for Low Stock Item */}
                      {isExpanded && (
                        <tr className="bg-slate-50 dark:bg-slate-900/80">
                          <td
                            colSpan={10}
                            className="p-4 border-t border-b border-rose-200/50"
                          >
                            <div className="space-y-2 text-xs">
                              <div className="font-bold text-slate-800 dark:text-slate-200 flex items-center justify-between">
                                <span className="flex items-center gap-1.5">
                                  <Layers className={`h-3.5 w-3.5 text-rose-600 dark:text-rose-400`} />
                                  <span>Branch-wise Available Stock Breakdown for {prod.name}:</span>
                                </span>
                                <span className="text-[11px] text-slate-500 font-mono">
                                  Consolidated Threshold: {totalConsolidatedReorder || prod.minReorderLevel} {prod.unit}
                                </span>
                              </div>

                              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                                {branchBreakdown.map((bb) => {
                                  const isBranchLow =
                                    bb.minReorderLevel > 0
                                      ? bb.quantityOnHand <= bb.minReorderLevel
                                      : bb.quantityOnHand <= 0;
                                  return (
                                    <div
                                      key={bb.branchId}
                                      onClick={() => {
                                        if (onSelectBranch) onSelectBranch(bb.branchId);
                                        onNavigateTab('branch-stock');
                                      }}
                                      className={`p-2.5 rounded-xl border text-xs flex flex-col justify-between transition-all cursor-pointer ${isBranchLow ? 'bg-rose-50/60 border-rose-200 hover:border-rose-400 hover:shadow-xs dark:bg-rose-950/40 dark:border-rose-800 dark:hover:border-rose-500' : 'bg-white border-slate-200 hover:border-emerald-400 hover:shadow-xs dark:bg-slate-800/80 dark:border-slate-700 dark:hover:border-emerald-500'}`}
                                      title={`Click to view matrix for ${bb.branchName}`}
                                    >
                                      <div className="flex items-center justify-between text-[11px]">
                                        <span className="font-bold truncate text-slate-800 dark:text-slate-200">
                                          {bb.branchName}
                                        </span>
                                        <span className="text-[9px] font-mono px-1 bg-slate-200 dark:bg-slate-800 rounded font-bold text-slate-600 dark:text-slate-300">
                                          {bb.branchCode}
                                        </span>
                                      </div>

                                      <div className="mt-2 flex items-baseline justify-between">
                                        <span
                                          className={`font-mono font-extrabold text-sm ${
                                            isBranchLow
                                              ? 'text-rose-600 dark:text-rose-400'
                                              : 'text-emerald-600 dark:text-emerald-400'
                                          }`}
                                        >
                                          {bb.quantityOnHand} {prod.unit}
                                        </span>
                                        <span className="text-[9px] text-slate-500 font-mono">
                                          (Min: {bb.minReorderLevel})
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 2. SPECIAL TYPE PRODUCT STOCK TABLE (Consolidated Total) */}
      <div className={`rounded-2xl border shadow-xs overflow-hidden ${cardBg}`}>
        {/* Header & Tab Controls */}
        <div
          className={`p-4 sm:p-5 border-b space-y-3 border-slate-200 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-900/40`}
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Package className={`h-4 w-4 text-indigo-600 dark:text-indigo-400`} />
                <h3 className={`font-bold text-base ${cardTitleText}`}>
                  Special Hardware Stock (Consolidated Total)
                </h3>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 border border-indigo-300 dark:border-indigo-700">
                  {specialProducts.length} Items
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Summed available stock across all branches for critical ISP hardware (Routers, Drop Cables, TV Devices & Fiber). Expand any item row to view branch-wise stock breakdown.
              </p>
            </div>

            {/* Search Box */}
 <div className="relative w-full md:w-80 lg:w-96 shrink-0 min-w-[220px]">
              <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                placeholder="Search Router, Fiber, Cable..."
                value={specialSearchQuery}
                onChange={(e) => setSpecialSearchQuery(e.target.value)}
                className={`w-full rounded-xl border pl-8 pr-3 py-1.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white border-slate-300 text-slate-800 placeholder-slate-400 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200 dark:placeholder-slate-500`}
              />
            </div>
          </div>

          {/* Filter Pills — dynamic from categories with isSpecialTracked=true */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <button
              type="button"
              onClick={() => setSpecialCategoryTab('ALL')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${specialCategoryTab === 'ALL' ? 'bg-indigo-600 text-white shadow-xs' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'}`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span>All Special Types</span>
            </button>

            {specialTrackedCategories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setSpecialCategoryTab(cat.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${specialCategoryTab === cat.id ? 'bg-indigo-600 text-white shadow-xs' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'}`}
              >
                <Tag className="h-3.5 w-3.5 text-indigo-500" />
                <span>{cat.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Table Content */}
        {specialProducts.length === 0 ? (
          <div className="p-10 text-center text-slate-400 text-xs italic">
            No special type hardware items found matching your current filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead
                className={`font-bold uppercase text-[10px] tracking-wider border-b bg-slate-100/70 text-slate-600 border-slate-200 dark:bg-slate-900/60 dark:text-slate-400 dark:border-slate-800`}
              >
                <tr>
                  <th className="px-2.5 py-1.5 w-8"></th>
                  <th className="px-2.5 py-1.5">Product Name</th>
                  <th className="px-2.5 py-1.5">SKU / Code</th>
                  <th className="px-2.5 py-1.5">Type / Category</th>
                  <th className="px-2.5 py-1.5 text-center">UOM</th>
                  <th className="px-2.5 py-1.5 text-right">Cost Rate (NPR)</th>
                  <th className={`px-2.5 py-1.5 text-right font-extrabold text-indigo-600 dark:text-indigo-400`}>
                    Total Stock (All Branches)
                  </th>
                  <th className="px-2.5 py-1.5 text-right">Total Valuation (NPR)</th>
                  <th className="px-2.5 py-1.5 text-center">Status</th>
                  <th className="px-2.5 py-1.5 text-center w-28">Action</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-100 dark:divide-slate-800`}>
                {specialProducts.map((prod) => {
                  const isExpanded = expandedSpecialProductIds.has(prod.id);

                  // Calculate total stock across the branches visible in the current
                  // dashboard scope (selected branch, or all allowed branches for ALL)
                  const scopeBranches =
                    selectedBranchId === 'ALL'
                      ? activeBranches
                      : activeBranches.filter((b) => b.id === selectedBranchId);

                  const branchStockBreakdown = scopeBranches.map((b) => {
                    const stItem = stock.find(
                      (s) => s.productId === prod.id && s.branchId === b.id
                    );
                    return {
                      branchId: b.id,
                      branchName: b.name,
                      branchCode: b.code,
                      quantityOnHand: stItem ? Number(stItem.quantityOnHand) : 0,
                    };
                  });

                  const totalAvailableStock = branchStockBreakdown.reduce(
                    (sum, b) => sum + b.quantityOnHand,
                    0
                  );
                  // PostgreSQL returns NUMERIC columns as strings over JSON — coerce so
                  // qty * cost cannot produce NaN in the total valuation column.
                  const totalValuation = totalAvailableStock * Number(prod.costPrice || 0);

                  const isOut = totalAvailableStock <= 0;
                  const isLow =
                    prod.minReorderLevel > 0 && totalAvailableStock <= prod.minReorderLevel;

                  return (
                    <React.Fragment key={prod.id}>
                      <tr
                        onClick={() => toggleSpecialExpand(prod.id)}
                        className={`transition-colors cursor-pointer ${isExpanded ? 'bg-indigo-50/50 dark:bg-indigo-950/30' : 'hover:bg-slate-200 dark:hover:bg-slate-800/40'}`}
                      >
                        <td className="p-2.5 text-center">
                          <button
                            type="button"
                            className="p-1 text-slate-400 hover:text-indigo-600 cursor-pointer"
                          >
                            {isExpanded ? (
                              <ChevronUp className="h-4 w-4 text-indigo-600" />
                            ) : (
                              <ChevronDown className="h-4 w-4" />
                            )}
                          </button>
                        </td>

                        <td className={`p-2.5 font-bold ${cardTitleText}`}>
                          <div className="flex items-center gap-2">
                            <span>{prod.name}</span>
                          </div>
                        </td>

                        <td className="p-2.5 font-mono text-[11px] text-slate-500">{prod.sku}</td>

                        <td className="p-2.5">
                          <span
                            className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-800`}
                          >
                            {prod.category}
                          </span>
                        </td>

                        <td className="p-2.5 text-center font-semibold text-slate-500 font-mono">
                          {prod.unit}
                        </td>

                        <td className="p-2.5 text-right font-mono text-slate-600 dark:text-slate-400">
                          {formatNPR(prod.costPrice)}
                        </td>

                        <td className={`p-2.5 text-right font-mono font-extrabold text-sm text-indigo-600 dark:text-indigo-400`}>
                          {(totalAvailableStock ?? 0).toLocaleString('en-IN')} {prod.unit}
                        </td>

                        <td className="p-2.5 text-right font-mono font-bold text-slate-800 dark:text-slate-200">
                          {formatNPR(totalValuation)}
                        </td>

                        <td className="p-2.5 text-center">
                          {isOut ? (
                            <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border border-rose-200">
                              Out of Stock
                            </span>
                          ) : isLow ? (
                            <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-200">
                              Low Stock
                            </span>
                          ) : (
                            <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-200">
                              Optimal
                            </span>
                          )}
                        </td>

                        <td className="p-2.5 text-center">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleSpecialExpand(prod.id);
                            }}
                            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-colors cursor-pointer bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-950/80 dark:text-indigo-300 dark:border-indigo-800 dark:hover:bg-indigo-900`}
                          >
                            {isExpanded ? 'Hide' : 'Branch Wise'}
                          </button>
                        </td>
                      </tr>

                      {/* Expandable Sub-Row for Branch Breakdown */}
                      {isExpanded && (
                        <tr className="bg-slate-50/90 dark:bg-slate-900/80">
                          <td colSpan={10} className="p-2.5 border-t border-b border-indigo-200/50">
                            <div className="space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                                  <Layers className={`h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400`} />
                                  <span>Branch-wise Available Stock Breakdown for {prod.name}:</span>
                                </span>
                                <span className="text-[11px] text-slate-500 font-mono">
                                  Reorder Level Threshold: {prod.minReorderLevel} {prod.unit}
                                </span>
                              </div>

                              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                                {branchStockBreakdown.map((b) => {
                                  const hasStock = b.quantityOnHand > 0;
                                  return (
                                    <div
                                      key={b.branchId}
                                      onClick={() => {
                                        if (onSelectBranch) onSelectBranch(b.branchId);
                                        onNavigateTab('branch-stock');
                                      }}
                                      className={`p-2.5 rounded-xl border text-xs flex flex-col justify-between transition-all cursor-pointer ${hasStock ? 'bg-white border-slate-200 hover:border-indigo-400 hover:shadow-xs dark:bg-slate-800/80 dark:border-slate-700 dark:hover:border-indigo-500' : 'bg-slate-100/60 border-slate-200 opacity-60 dark:bg-slate-900/40 dark:border-slate-800/80 dark:opacity-60'}`}
                                      title={`Click to view matrix for ${b.branchName}`}
                                    >
                                      <div className="flex items-center justify-between text-[11px]">
                                        <span className="font-bold truncate text-slate-800 dark:text-slate-200">
                                          {b.branchName}
                                        </span>
                                        <span className="text-[9px] font-mono px-1 bg-slate-200 dark:bg-slate-800 rounded font-bold text-slate-600 dark:text-slate-300">
                                          {b.branchCode}
                                        </span>
                                      </div>

                                      <div className="mt-2 flex items-baseline justify-between">
                                        <span
                                          className={`font-mono font-extrabold text-sm ${
                                            hasStock
                                              ? 'text-emerald-600 dark:text-emerald-400'
                                              : 'text-slate-400'
                                          }`}
                                        >
                                          {b.quantityOnHand} {prod.unit}
                                        </span>
                                        <span className={`text-[10px] font-bold underline text-indigo-600 dark:text-indigo-400`}>
                                          View →
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 3. CLICKABLE BRANCHWISE STOCK SUMMARY CARDS */}
      {(() => {
        const isGlobalUser =
          !currentUser?.branchId ||
          currentUser.branchId === 'ALL' ||
          currentUser.role === 'SUPER_ADMIN' ||
          currentUser.role === 'INVENTORY_MANAGER' ||
          currentUser.role === 'ACCOUNTANT';

        const visibleBranches = isGlobalUser
          ? branches
          : branches.filter((b) => b.id === currentUser.branchId);

        const branchesToDisplay = visibleBranches.length > 0 ? visibleBranches : branches;

        return (
          <div className={`rounded-2xl border shadow-xs p-4 sm:p-5 ${cardBg}`}>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3.5">
              <div>
                <h3 className={`font-bold text-sm flex items-center gap-2 ${cardTitleText}`}>
                  <Layers className="h-4 w-4 text-indigo-600" />
                  <span>Branch Stock Summary Cards</span>
                  <span
                    className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${!isGlobalUser ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-400 dark:border-amber-800/60' : 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-800/60'}`}
                  >
                    {!isGlobalUser
                      ? `Assigned: ${branchesToDisplay[0]?.name || currentUser?.branchId}`
                      : `${branchesToDisplay.length} Branches Active`}
                  </span>
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {!isGlobalUser
                    ? `Displaying stock summary for your assigned branch according to permission management.`
                    : `Click any branch card below to instantly jump to Branch Stock Matrix & Location Tracking filtered by that branch.`}
                </p>
              </div>
              <button
                onClick={() => onNavigateTab('branch-stock')}
                className={`text-xs font-bold hover:underline flex items-center gap-1 cursor-pointer self-start sm:self-auto text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300`}
              >
                <span>Full Matrix View</span>
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
              {branchesToDisplay.map((b) => {
                const branchStock = stock.filter((s) => s.branchId === b.id);
                const totalBranchQty = branchStock.reduce((s, item) => s + item.quantityOnHand, 0);
                const totalBranchVal = branchStock.reduce((sum, item) => {
                  const p = products.find((pr) => pr.id === item.productId);
                  return sum + (p ? p.costPrice * item.quantityOnHand : 0);
                }, 0);

                const isSelected = selectedBranchId === b.id;

                return (
                  <div
                    key={b.id}
                    onClick={() => {
                      if (onSelectBranch) onSelectBranch(b.id);
                      onNavigateTab('branch-stock');
                    }}
                    className={`group p-3 rounded-xl border transition-all cursor-pointer relative overflow-hidden flex flex-col justify-between ${isSelected ? 'border-indigo-500 bg-indigo-50/90 shadow-md ring-1 ring-indigo-500/50 dark:border-indigo-500 dark:bg-indigo-950/50 dark:shadow-md dark:ring-1 dark:ring-indigo-500/50' : 'border-slate-200 bg-slate-50/70 hover:bg-white hover:border-indigo-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-900/40 dark:hover:bg-slate-800/80 dark:hover:border-indigo-500/50 dark:hover:shadow-md'}`}
                    title={`Click to view ${b.name} inventory matrix`}
                  >
                    <div>
                      <div className="flex items-center justify-between text-xs font-bold mb-1">
                        <span className={`truncate pr-1 ${cardTitleText} group-hover:text-indigo-600 transition-colors`}>
                          {b.name}
                        </span>
                        <span
                          className={`text-[9px] px-1.5 py-0.2 rounded border font-mono font-bold shrink-0 text-indigo-700 bg-indigo-100/80 border-indigo-200 dark:text-indigo-300 dark:bg-indigo-950/80 dark:border-indigo-500/30`}
                        >
                          {b.code}
                        </span>
                      </div>
                      <div className={`text-xs font-serif font-extrabold mt-1 ${cardTitleText}`}>
                        {formatNPR(totalBranchVal)}
                      </div>
                      <div className={`text-[10px] font-medium mt-0.5 text-slate-500 dark:text-slate-400`}>
                        {totalBranchQty} Items in Stock
                      </div>
                    </div>

                    <div className={`mt-2.5 pt-1.5 border-t border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between text-[10px] font-bold group-hover:translate-x-0.5 transition-transform text-indigo-600 dark:text-indigo-400`}>
                      <span>View Matrix</span>
                      <ArrowRight className="h-3 w-3" />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* 3.5. WORKFLOW APPROVAL & AUTHORIZATION CARD */}
      {(() => {
        const pendingReqs = approvalRequests.filter((r) => r.status === 'PENDING');
        return (
          <div className={`rounded-2xl border shadow-xs p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 ${cardBg}`}>
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-2xl bg-amber-500/10 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400">
                <ShieldCheck className="h-6 w-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-extrabold text-base">Workflow Approval & Authorization Center</h3>
                  {pendingReqs.length > 0 && (
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500 text-white animate-pulse">
                      {pendingReqs.length} Pending
                    </span>
                  )}
                </div>
                <p className={`text-xs mt-0.5 ${cardSubText}`}>
                  Formal authorization workflow for Customer Device status changes (Suspended, Disconnected, Refund & Restock).
                </p>
              </div>
            </div>

            <button
              onClick={() => onNavigateTab('approvals')}
              className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-md shadow-indigo-600/20 flex items-center justify-center gap-2 cursor-pointer transition-all shrink-0"
            >
              <span>Manage Approvals</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        );
      })()}

      {/* 4. REALTIME STOCK AUDIT STREAM */}
      <div className={`rounded-2xl border shadow-xs p-5 ${cardBg}`}>
        <div
          className={`flex items-center justify-between mb-4 border-b pb-3 border-slate-200 dark:border-slate-800`}
        >
          <h3 className={`font-bold text-sm flex items-center gap-2 ${cardTitleText}`}>
            <TrendingUp className="h-4 w-4 text-emerald-500" />
            <span>Realtime Stock Audit Stream & Transaction Logs</span>
          </h3>
          <button
            onClick={() => onNavigateTab('stock-ledger')}
            className={`text-xs font-medium hover:underline cursor-pointer text-indigo-600 dark:text-indigo-400`}
          >
            View Full Ledger →
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {transactionLogs.length === 0 ? (
            <div className="col-span-full text-center text-slate-500 text-xs py-6">
              No stock transactions recorded yet.
            </div>
          ) : (
            transactionLogs.slice(0, 8).map((log) => {
              const isPositive = log.quantityChanged > 0;
              return (
                <div
                  key={log.id}
                  className={`p-3 rounded-xl border text-xs space-y-1 transition-colors bg-slate-50 border-slate-200 hover:border-slate-300 dark:bg-slate-900/50 dark:border-slate-800 dark:hover:border-slate-700`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`font-semibold truncate max-w-[140px] ${cardTitleText}`}>
                      {log.productName}
                    </span>
                    <span
                      className={`font-mono font-bold flex items-center text-xs ${isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
                    >
                      {isPositive ? (
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      ) : (
                        <ArrowDownRight className="h-3.5 w-3.5" />
                      )}
                      {isPositive ? `+${log.quantityChanged}` : log.quantityChanged}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-slate-500">
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300`}
                    >
                      {log.changeType.replace('_', ' ')}
                    </span>
                    <span>{formatDualDate(log.timestampAD, dateMode)}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Quick Add / Remove Stock Modal */}
      {isAdjustModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-[#0f1218] border border-slate-200 dark:border-slate-800 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Plus className="h-5 w-5 text-emerald-500" />
                <span>Quick Stock Level Adjustment</span>
              </h3>
              <button
                type="button"
                onClick={() => setIsAdjustModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleApplyAdjustment} className="space-y-4 text-xs">
              <div>
                <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Select Product & Branch Stock Item:
                </label>
                <select
                  required
                  value={selectedStockId}
                  onChange={(e) => setSelectedStockId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 p-2.5 text-slate-900 dark:text-slate-200 focus:outline-none"
                >
                  <option value="" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">-- Choose Stock Record --</option>
                  {stock.map((st) => {
                    const prod = products.find((p) => p.id === st.productId);
                    const br = branches.find((b) => b.id === st.branchId);
                    return (
                      <option key={st.id} value={st.id} className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">
                        {prod?.name || 'Item'} [{br?.code || 'Branch'}] — Current Qty:{' '}
                        {st.quantityOnHand} {prod?.unit || 'Pcs'}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Action Type:
                  </label>
                  <select
                    value={adjustAction}
                    onChange={(e) => setAdjustAction(e.target.value as any)}
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 p-2.5 text-slate-900 dark:text-slate-200 font-bold focus:outline-none"
                  >
                    <option value="ADD" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-emerald-400">➕ Add Stock (+)</option>
                    <option value="REMOVE" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-rose-400">➖ Remove Stock (-)</option>
                  </select>
                </div>

                <div>
                  <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Quantity:
                  </label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={adjustQty}
                    onChange={(e) => setAdjustQty(Number(e.target.value))}
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 p-2.5 text-slate-900 dark:text-slate-200 font-bold focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Reason / Adjustment Note:
                </label>
                <select
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 p-2.5 text-slate-900 dark:text-slate-200 focus:outline-none"
                >
                  <option value="Physical Stock Audit" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">Physical Stock Audit Count</option>
                  <option value="Internal Branch Consumption" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">Internal Branch Consumption</option>
                  <option value="Damaged / Write-off" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">Damaged / Write-off</option>
                  <option value="Supplier Return" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">Supplier Return</option>
                  <option value="Initial Opening Stock Entry" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">Initial Opening Stock Entry</option>
                </select>
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsAdjustModalOpen(false)}
                  className="rounded-xl border border-slate-300 dark:border-slate-700 px-4 py-2 font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-4 py-2 shadow-lg cursor-pointer"
                >
                  Confirm & Update Stock
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
