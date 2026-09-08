import React, { useState } from 'react';
import { Product, Branch, InventoryStock, User } from '../../types';
import { NavTab } from '../../components/layout/Sidebar';
import { isOperationAllowed } from '../../utils/permissions';
import { exportToCSV } from '../../utils/exportUtils';
import {
  AlertTriangle,
  Building2,
  Edit,
  CheckCircle2,
  X,
  Search,
  Filter,
  ShoppingCart,
  Plus,
  RefreshCw,
  BellRing,
  Sliders,
  SlidersHorizontal,
  Info,
  Check,
  Lock,
  Download,
  FileSpreadsheet,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';

interface ReorderStockTrackingProps {
  currentUser?: User | null;
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  selectedBranchId: string;
  onUpdateStockLevel?: (stockId: string, newQty: number, reason: string) => Promise<void>;
  onUpdateStockReorderLevel?: (stockId: string, minReorderLevel: number) => Promise<void>;
  onBulkUpdateStockReorderLevels?: (updates: { stockId: string; minReorderLevel: number }[]) => Promise<void>;
  onGroupLowStockPO?: () => void;
  onNavigateTab?: (tab: NavTab) => void;
  isDarkMode?: boolean;
}

export const ReorderStockTracking: React.FC<ReorderStockTrackingProps> = ({
  currentUser,
  products,
  branches,
  stock,
  selectedBranchId,
  onUpdateStockLevel,
  onUpdateStockReorderLevel,
  onBulkUpdateStockReorderLevels,
  onGroupLowStockPO,
  onNavigateTab,
  isDarkMode = false,
}) => {
  const [editingStock, setEditingStock] = useState<{
    stockItem: InventoryStock;
    product: Product;
    branch: Branch;
    mode: 'stock' | 'reorder';
  } | null>(null);

  const [newQty, setNewQty] = useState<number>(0);
  const [newReorderLevel, setNewReorderLevel] = useState<number>(0);
  const [reason, setReason] = useState<string>('Stock Level Reorder Adjustment');

  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkStrategy, setBulkStrategy] = useState<'EQUAL_PRODUCT' | 'HQ_WEIGHTED'>('EQUAL_PRODUCT');
  const [isSyncingBulk, setIsSyncingBulk] = useState(false);

  const [showOnlyReorder, setShowOnlyReorder] = useState(true);
  const [localSearch, setLocalSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('ALL');

  const categories = Array.from(new Set(products.map((p) => p.category)));

  const activeBranches =
    selectedBranchId === 'ALL'
      ? branches
      : branches.filter((b) => b.id === selectedBranchId);

  // Helper function to resolve effective branch reorder level
  const getBranchReorderThreshold = (prod: Product, branchStock?: InventoryStock) => {
    if (branchStock && branchStock.minReorderLevel !== undefined && branchStock.minReorderLevel !== null) {
      return branchStock.minReorderLevel;
    }
    return prod.minReorderLevel;
  };

  // Calculate reorder deficit per product across visible branches using PER-BRANCH thresholds & consolidated reorder calculations
  const productsReorderData = products.map((prod) => {
    let totalOnHand = 0;
    let totalConsolidatedReorderLevel = 0;
    let totalDeficit = 0;
    let lowBranchesCount = 0;
    const branchData: {
      branch: Branch;
      qty: number;
      minReorder: number;
      deficit: number;
      isLow: boolean;
      stockItem?: InventoryStock;
    }[] = [];

    activeBranches.forEach((b) => {
      const item = stock.find((st) => st.productId === prod.id && st.branchId === b.id);
      const onHand = item ? Number(item.quantityOnHand) : 0;
      totalOnHand += onHand;

      const branchMinReorder = getBranchReorderThreshold(prod, item);
      totalConsolidatedReorderLevel += branchMinReorder;

      let deficit = 0;
      let isLow = false;
      if (branchMinReorder > 0 && onHand <= branchMinReorder) {
        lowBranchesCount++;
        deficit = Math.max(1, branchMinReorder - onHand);
        totalDeficit += deficit;
        isLow = true;
      } else if (branchMinReorder === 0 && onHand < 0) {
        lowBranchesCount++;
        deficit = Math.abs(onHand);
        totalDeficit += deficit;
        isLow = true;
      }

      branchData.push({
        branch: b,
        qty: onHand,
        minReorder: branchMinReorder,
        deficit,
        isLow,
        stockItem: item,
      });
    });

    if (totalDeficit === 0 && totalConsolidatedReorderLevel > 0 && totalOnHand <= totalConsolidatedReorderLevel) {
      totalDeficit = Math.max(1, totalConsolidatedReorderLevel - totalOnHand);
    }

    const totalReorderValuation = totalDeficit * (prod.costPrice || 0);
    const isBelowMinOverall = lowBranchesCount > 0 || (totalConsolidatedReorderLevel > 0 && totalOnHand <= totalConsolidatedReorderLevel);

    return {
      prod,
      totalOnHand,
      totalStockOnHand: totalOnHand,
      totalConsolidatedReorderLevel,
      totalDeficit,
      lowBranchesCount,
      lowStockBranchCount: lowBranchesCount,
      totalReorderValuation,
      isBelowMinOverall,
      branchData,
    };
  });

  const visibleProducts = productsReorderData.filter(
    ({ prod, isBelowMinOverall }) => {
      const matchesReorderFilter = !showOnlyReorder || isBelowMinOverall;
      const matchesCat = filterCategory === 'ALL' || prod.category === filterCategory;
      const query = localSearch.trim().toLowerCase();
      const matchesSearch =
        !query ||
        (prod?.name || '').toLowerCase().includes(query) ||
        (prod?.sku || '').toLowerCase().includes(query) ||
        (prod?.barcode || '').toLowerCase().includes(query) ||
        (prod?.category || '').toLowerCase().includes(query);

      return matchesReorderFilter && matchesCat && matchesSearch;
    }
  );

  // Summary Metrics
  const lowStockSKUCount = productsReorderData.filter((p) => p.isBelowMinOverall).length;

  const reorderPagination = useClientPagination(visibleProducts, 20, [filterCategory, localSearch]);
  const grandTotalDeficitUnits = productsReorderData.reduce((sum, p) => sum + p.totalDeficit, 0);
  const grandTotalReorderCost = productsReorderData.reduce((sum, p) => sum + p.totalReorderValuation, 0);

  const handleExportReorderReport = () => {
    // Dynamic branch threshold & deficit columns
    const dynamicCols = activeBranches.flatMap((b) => [
      {
        key: `branch_stock_${b.id}`,
        label: `${b.name} (Stock / Min)`,
        formatter: (_: any, item: (typeof visibleProducts)[0]) => {
          const bd = item.branchData.find((x) => x.branch.id === b.id);
          return bd ? `${bd.qty} / ${bd.minReorder}` : '0 / 0';
        },
      },
      {
        key: `branch_deficit_${b.id}`,
        label: `${b.name} (Deficit)`,
        formatter: (_: any, item: (typeof visibleProducts)[0]) => {
          const bd = item.branchData.find((x) => x.branch.id === b.id);
          return bd ? bd.deficit : 0;
        },
      },
    ]);

    const columns = [
      { key: 'sku', label: 'SKU Code', formatter: (_: any, item: (typeof visibleProducts)[0]) => item.prod.sku },
      { key: 'barcode', label: 'Barcode', formatter: (_: any, item: (typeof visibleProducts)[0]) => item.prod.barcode },
      { key: 'name', label: 'Product Name', formatter: (_: any, item: (typeof visibleProducts)[0]) => item.prod.name },
      { key: 'category', label: 'Category', formatter: (_: any, item: (typeof visibleProducts)[0]) => item.prod.category },
      { key: 'unit', label: 'Unit', formatter: (_: any, item: (typeof visibleProducts)[0]) => item.prod.unit },
      { key: 'costPrice', label: 'Unit Cost Price (NPR)', formatter: (_: any, item: (typeof visibleProducts)[0]) => item.prod.costPrice || 0 },
      { key: 'totalStockOnHand', label: 'Total Stock On-Hand', formatter: (_: any, item: (typeof visibleProducts)[0]) => item.totalStockOnHand },
      { key: 'lowStockBranchCount', label: 'Low Stock Branches Count', formatter: (_: any, item: (typeof visibleProducts)[0]) => item.lowStockBranchCount },
      { key: 'totalDeficit', label: 'Total Reorder Deficit Qty', formatter: (_: any, item: (typeof visibleProducts)[0]) => item.totalDeficit },
      { key: 'totalReorderValuation', label: 'Total Reorder Deficit Valuation (NPR)', formatter: (_: any, item: (typeof visibleProducts)[0]) => item.totalReorderValuation },
      {
        key: 'status',
        label: 'Reorder Health Status',
        formatter: (_: any, item: (typeof visibleProducts)[0]) => (item.isBelowMinOverall ? 'CRITICAL DEFICIT (Action Required)' : 'OPTIMAL STOCK'),
      },
      ...dynamicCols,
    ];

    const branchName =
      selectedBranchId === 'ALL'
        ? 'All Branches (Consolidated)'
        : branches.find((b) => b.id === selectedBranchId)?.name || `Branch ${selectedBranchId}`;

    exportToCSV({
      filename: 'Reorder_Level_Manager_Report',
      reportTitle: 'Inventory Reorder Level & Deficit Manager Report',
      branchName,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: visibleProducts,
      columns,
    });
  };

  // Permission Check: Stock Manager and Super Admin only
  const isStockManager = currentUser?.role === 'SUPER_ADMIN' || currentUser?.role === 'INVENTORY_MANAGER';

  const openEditModal = (s: InventoryStock | undefined, p: Product, b: Branch, mode: 'stock' | 'reorder') => {
    if (!isStockManager) {
      alert('Permission Denied: Only Stock Manager / Super Admin can edit branch reorder thresholds and adjust stock balances.');
      return;
    }
    const safeStockItem: InventoryStock = s || {
      id: `stk-${b.id.toLowerCase()}-${p.id}`,
      productId: p.id,
      branchId: b.id,
      quantityOnHand: 0,
      damagedQty: 0,
      reservedQty: 0,
      incomingQty: 0,
      minReorderLevel: p.minReorderLevel || 5,
      lastUpdated: new Date().toISOString(),
    };
    setEditingStock({ stockItem: safeStockItem, product: p, branch: b, mode });
    setNewQty(Number(safeStockItem.quantityOnHand));
    setNewReorderLevel(safeStockItem.minReorderLevel ?? p.minReorderLevel ?? 5);
    setReason('Reorder threshold adjustment');
  };

  const handleStockSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStock || !isStockManager) return;

    if (editingStock.mode === 'stock' && onUpdateStockLevel) {
      await onUpdateStockLevel(editingStock.stockItem.id, Number(newQty), reason);
    } else if (editingStock.mode === 'reorder' && onUpdateStockReorderLevel) {
      await onUpdateStockReorderLevel(editingStock.stockItem.id, Number(newReorderLevel));
    }
    setEditingStock(null);
  };

  const handleBulkSyncDefaults = async () => {
    if (!onBulkUpdateStockReorderLevels || !isStockManager) return;
    setIsSyncingBulk(true);

    try {
      const updates: { stockId: string; minReorderLevel: number }[] = [];

      products.forEach((prod) => {
        branches.forEach((b) => {
          const item = stock.find((st) => st.productId === prod.id && st.branchId === b.id);
          if (item) {
            let targetMin = prod.minReorderLevel;
            if (bulkStrategy === 'HQ_WEIGHTED') {
              targetMin = b.isHeadquarters ? prod.minReorderLevel * 2 : prod.minReorderLevel;
            }
            updates.push({ stockId: item.id, minReorderLevel: targetMin });
          }
        });
      });

      await onBulkUpdateStockReorderLevels(updates);
      setShowBulkModal(false);
    } catch (err) {
      console.error('Failed bulk reorder level update', err);
    } finally {
      setIsSyncingBulk(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Header & Main Actions */}
      <div className="flex-none flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 ${
            isDarkMode ? 'text-white' : 'text-slate-900'
          }`}>
            <BellRing className="h-5 w-5 text-rose-500 animate-pulse" />
            <span>Per-Branch Reorder Level Matrix & Sync</span>
          </h2>
          <p className={`truncate text-xs mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Each branch maintains individual min reorder thresholds based on localized demand & sales velocity. Easily configure or bulk-sync per-branch levels.
          </p>
        </div>

        <div className="shrink-0 flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={handleExportReorderReport}
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:hover:bg-emerald-900/80 border border-emerald-300 dark:border-emerald-700/60 cursor-pointer shadow-xs transition-all"
            title="Export Reorder Levels & Deficits report with uniform BS Date (YYYY-MM-DD)"
          >
            <Download className={`h-4 w-4 ${isDarkMode ? 'text-emerald-400' : 'text-emerald-600'}`} />
            <FileSpreadsheet className={`h-4 w-4 ${isDarkMode ? 'text-emerald-400' : 'text-emerald-600'}`} />
            <span>Export Reorder CSV (BS Date)</span>
          </button>

          {isStockManager && onBulkUpdateStockReorderLevels && (
            <button
              type="button"
              title="Bulk sync thresholds across branches"
              onClick={() => setShowBulkModal(true)}
              className={`flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-semibold border transition-all cursor-pointer ${
                isDarkMode
                  ? 'bg-slate-900 text-indigo-400 border-slate-800 hover:bg-slate-800'
                  : 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100'
              }`}
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span>Bulk Sync Thresholds</span>
            </button>
          )}

          {isStockManager && onGroupLowStockPO && (
            <button
              type="button"
              title="Group low stock products and generate PO (Stock Manager Decision)"
              onClick={onGroupLowStockPO}
              className="flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 shadow-md shadow-indigo-200 dark:shadow-none cursor-pointer transition-all"
            >
              <ShoppingCart className="h-4 w-4" />
              <span>Group Low-Stock Items & Create PO</span>
            </button>
          )}
        </div>
      </div>

      {/* KPI Cards Banner */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className={`p-3.5 rounded-2xl border shadow-2xs ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Low Stock Branch Items</span>
            <div className="p-1.5 rounded-lg bg-rose-500/10 text-rose-500">
              <AlertTriangle className="h-4 w-4" />
            </div>
          </div>
          <div className={`text-xl font-bold font-mono mt-1 ${isDarkMode ? 'text-rose-400' : 'text-rose-600'}`}>
            {lowStockSKUCount} SKUs Below Min
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5 font-medium">
            At or below branch specific threshold
          </div>
        </div>

        <div className={`p-3.5 rounded-2xl border shadow-2xs ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Total Required Stock (Deficit)</span>
            <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-500">
              <ShoppingCart className="h-4 w-4" />
            </div>
          </div>
          <div className={`text-xl font-bold font-mono mt-1 ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`}>
            {(grandTotalDeficitUnits ?? 0).toLocaleString('en-IN')} Units
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5 font-medium">
            Calculated against branch minimum levels
          </div>
        </div>

        <div className={`p-3.5 rounded-2xl border shadow-2xs ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Est. Reorder Budget</span>
            <div className="p-1.5 rounded-lg bg-amber-500/10 text-amber-500">
              <RefreshCw className="h-4 w-4" />
            </div>
          </div>
          <div className={`text-xl font-bold font-mono mt-1 ${isDarkMode ? 'text-amber-400' : 'text-amber-600'}`}>
            रु {(grandTotalReorderCost ?? 0).toLocaleString('en-IN')}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5 font-medium">
            Procurement cost to achieve min levels
          </div>
        </div>
      </div>

      {/* Filter and Search controls */}
      <div className={`p-3 rounded-2xl border flex flex-col sm:flex-row items-center justify-between gap-3 ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
      }`}>
 <div className="relative w-full md:w-80 lg:w-96 shrink-0">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            placeholder="Search SKU, Product Name, Category..."
            className={`w-full rounded-xl border pl-9 pr-4 py-1.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
              isDarkMode
                ? 'bg-slate-900 border-slate-800 text-white placeholder-slate-500'
                : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400'
            }`}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto justify-end">
          {/* Category Filter */}
          <div className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5 text-slate-400" />
            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className={`rounded-xl border px-3 py-1.5 text-xs font-medium cursor-pointer ${
                isDarkMode
                  ? 'bg-slate-900 border-slate-800 text-slate-200'
                  : 'bg-white border-slate-200 text-slate-800'
              }`}
            >
              <option value="ALL">All Categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          {/* Toggle Reorder Filter */}
          <button
            onClick={() => setShowOnlyReorder(!showOnlyReorder)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all cursor-pointer ${
              showOnlyReorder
                ? 'bg-rose-600 text-white border-rose-600'
                : isDarkMode
                ? 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                : 'bg-slate-100 border-slate-200 text-slate-600 hover:text-slate-900'
            }`}
          >
            {showOnlyReorder ? 'Reorder Alerts Only' : 'Show All Items'}
          </button>
        </div>
      </div>

      {/* Main Reorder Table Matrix */}
      <div className={`rounded-2xl border shadow-lg overflow-hidden ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
      }`}>
        <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-16rem)] relative">
          <table className="w-full text-left text-xs border-collapse">
            <thead className={`sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b shadow-2xs ${
              isDarkMode ? 'bg-[#12161f] text-slate-400 border-slate-800' : 'bg-slate-100 text-slate-700 border-slate-200'
            }`}>
              <tr>
                <th className="px-2.5 py-1.5 sticky left-0 z-30 bg-inherit border-r min-w-[190px]">
                  Product Name & SKU
                </th>
                <th className="px-2.5 py-1.5 text-center sticky top-0 bg-inherit">Cat</th>
                <th className="px-2.5 py-1.5 text-right sticky top-0 bg-inherit">Catalog Default</th>
                <th className={`px-2.5 py-1.5 text-right sticky top-0 bg-inherit font-bold ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`}>
                  Consolidated Min
                </th>
                <th className="px-2.5 py-1.5 text-right sticky top-0 bg-inherit font-bold">
                  Total On-Hand
                </th>
                <th className={`px-2.5 py-1.5 text-center sticky top-0 border-l border-r font-extrabold ${
                  isDarkMode ? 'bg-rose-950/60 text-rose-300 border-slate-800' : 'bg-rose-100/90 text-rose-900 border-slate-200'
                }`}>
                  Total Deficit
                </th>

                {/* Columns per Branch */}
                {activeBranches.map((b) => (
                  <th key={b.id} className={`px-2.5 py-1.5 text-center border-l sticky top-0 bg-inherit min-w-[140px] ${
                    isDarkMode ? 'border-slate-800' : 'border-slate-200'
                  }`}>
                    <div className="flex flex-col items-center justify-center">
                      <div className="flex items-center gap-1 font-bold">
                        <Building2 className="h-3 w-3 text-indigo-500" />
                        <span className="truncate">{b.name}</span>
                      </div>
                      <span className="text-[9px] font-mono text-slate-400 font-normal">
                        {b.isHeadquarters ? 'HQ Main' : 'Branch'}
                      </span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>

            <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-slate-200'}`}>
              {visibleProducts.length === 0 ? (
                <tr>
                  <td colSpan={6 + activeBranches.length} className="p-12 text-center text-slate-500 text-xs">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <CheckCircle2 className="h-8 w-8 text-emerald-500 opacity-80" />
                      <span className="font-semibold text-slate-700 dark:text-slate-300">All branch stock levels meet or exceed reorder thresholds!</span>
                      <span className="text-[11px] text-slate-400">Click "Show All Items" to view complete inventory matrix.</span>
                    </div>
                  </td>
                </tr>
              ) : (
                reorderPagination.pagedItems.map(({ prod, totalOnHand, totalConsolidatedReorderLevel, totalDeficit, isBelowMinOverall }) => (
                  <tr key={prod.id} className={`transition-colors ${
                    isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'
                  }`}>
                    <td className={`px-2.5 py-1.5 sticky left-0 z-10 border-r font-medium ${
                      isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
                    }`}>
                      <div className={`font-bold text-xs ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>{prod.name}</div>
                      <div className={`text-[10px] ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'} font-mono`}>
                        SKU: {prod.sku}
                      </div>
                    </td>

                    <td className="px-2.5 py-1.5 text-center">
                      <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold border ${
                        isDarkMode
                          ? 'bg-slate-900 text-slate-300 border-slate-800'
                          : 'bg-slate-100 text-slate-700 border-slate-200'
                      }`}>
                        {prod.category}
                      </span>
                    </td>

                    <td className={`px-2.5 py-1.5 text-right font-mono font-semibold ${
                      isDarkMode ? 'text-slate-400' : 'text-slate-600'
                    }`}>
                      {prod.minReorderLevel} {prod.unit}
                    </td>

                    <td className={`px-2.5 py-1.5 text-right font-mono font-bold ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`}>
                      {totalConsolidatedReorderLevel} {prod.unit}
                    </td>

                    <td className={`px-2.5 py-1.5 text-right font-mono font-bold ${
                      totalOnHand <= totalConsolidatedReorderLevel
                        ? (isDarkMode ? 'text-rose-400' : 'text-rose-600')
                        : (isDarkMode ? 'text-emerald-400' : 'text-emerald-600')
                    }`}>
                      {totalOnHand} {prod.unit}
                    </td>

                    {/* Total Required Deficit Column */}
                    <td className={`px-2.5 py-1.5 text-center border-l border-r font-mono font-bold ${
                      totalDeficit > 0
                        ? (isDarkMode ? 'bg-rose-950/30 text-rose-400 border-slate-800' : 'bg-rose-50 text-rose-600 border-slate-200')
                        : isDarkMode ? 'bg-slate-900/20 text-slate-500 border-slate-800' : 'bg-slate-50 text-slate-400 border-slate-200'
                    }`}>
                      <div className="flex flex-col items-center">
                        <span className="text-xs font-extrabold">
                          {totalDeficit > 0 ? `+${totalDeficit}` : '0'} <span className="text-[10px] font-normal">{prod.unit}</span>
                        </span>
                        {totalDeficit > 0 && (
                          <span className="text-[9px] text-rose-500 font-semibold">
                            Deficit
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Branch Cells */}
                    {activeBranches.map((b) => {
                      const s = stock.find(
                        (st) => st.productId === prod.id && st.branchId === b.id
                      ) || {
                        id: `stk-${prod.id}-${b.id}`,
                        productId: prod.id,
                        branchId: b.id,
                        quantityOnHand: 0,
                        damagedQty: 0,
                        reservedQty: 0,
                        incomingQty: 0,
                        lastUpdated: new Date().toISOString(),
                      };

                      const onHand = Number(s.quantityOnHand);
                      const branchMin = getBranchReorderThreshold(prod, s);
                      const isLow = branchMin > 0 ? onHand <= branchMin : onHand < 0;
                      const branchDeficit = branchMin > 0 ? Math.max(0, branchMin - onHand) : (onHand < 0 ? Math.abs(onHand) : 0);

                      return (
                        <td
                          key={b.id}
                          className={`px-2.5 py-1.5 text-center border-l font-medium ${
                            isDarkMode ? 'border-slate-800' : 'border-slate-200'
                          } ${
                            isLow ? (isDarkMode ? 'bg-rose-950/20' : 'bg-rose-50/60') : ''
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <div className="flex flex-col items-start text-left">
                              <div className="flex items-center gap-1 font-mono text-xs">
                                <span className={`font-bold ${
                                  isLow ? (isDarkMode ? 'text-rose-400' : 'text-rose-600') : (isDarkMode ? 'text-slate-200' : 'text-slate-800')
                                }`}>
                                  {onHand}
                                </span>
                                <span className="text-[10px] text-slate-400">{prod.unit}</span>
                              </div>

                              <div className="flex items-center gap-1 mt-0.5">
                                <span className="text-[9px] font-mono font-medium text-slate-400">
                                  Min: <span className={`${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'} font-bold`}>{branchMin}</span>
                                </span>

                                {branchDeficit > 0 ? (
                                  <span className={`text-[9px] ${isDarkMode ? 'text-rose-400' : 'text-rose-500'} font-bold font-mono`}>
                                    (-{branchDeficit})
                                  </span>
                                ) : (
                                  <span className={`text-[9px] ${isDarkMode ? 'text-emerald-400' : 'text-emerald-600'} font-medium`}>
                                    OK
                                  </span>
                                )}
                              </div>
                            </div>

                            {isStockManager && (
                              <div className="flex flex-col gap-0.5">
                                {onUpdateStockReorderLevel && (
                                  <button
                                    onClick={() => openEditModal(s, prod, b, 'reorder')}
                                    title="Edit branch min reorder threshold"
                                    className="p-1 rounded text-indigo-500 hover:bg-indigo-100 dark:hover:bg-indigo-950/80 transition-colors cursor-pointer"
                                  >
                                    <Sliders className="h-3 w-3" />
                                  </button>
                                )}

                                {onUpdateStockLevel && (
                                  <button
                                    onClick={() => openEditModal(s, prod, b, 'stock')}
                                    title="Adjust physical stock count"
                                    className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors cursor-pointer"
                                  >
                                    <Edit className="h-3 w-3" />
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <TablePagination
          page={reorderPagination.page}
          pageCount={reorderPagination.pageCount}
          totalItems={reorderPagination.totalItems}
          rangeStart={reorderPagination.rangeStart}
          rangeEnd={reorderPagination.rangeEnd}
          pageSize={reorderPagination.pageSize}
          onPageChange={reorderPagination.setPage}
          onPageSizeChange={reorderPagination.setPageSize}
          isDarkMode={isDarkMode}
          className="mt-1"
        />
      </div>

      {/* EDIT MODAL */}
      {editingStock && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className={`w-full max-w-md rounded-2xl shadow-2xl border p-5 ${
            isDarkMode ? 'bg-[#0f1218] border-slate-800 text-slate-200' : 'bg-white border-slate-200 text-slate-800'
          }`}>
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2">
                {editingStock.mode === 'reorder' ? (
                  <Sliders className="h-5 w-5 text-indigo-500" />
                ) : (
                  <Edit className="h-5 w-5 text-indigo-500" />
                )}
                <h3 className={`font-bold text-base ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                  {editingStock.mode === 'reorder' ? 'Set Branch Min Reorder Level' : 'Adjust Branch Stock Count'}
                </h3>
              </div>
              <button
                onClick={() => setEditingStock(null)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleStockSave} className="mt-4 space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-500">Product SKU & Name</label>
                <div className={`font-bold text-sm ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                  {editingStock.product.name}
                </div>
                <div className="text-xs text-indigo-500 font-mono mt-0.5">
                  SKU: {editingStock.product.sku} • Location: <span className="font-bold">{editingStock.branch.name}</span>
                </div>
              </div>

              {editingStock.mode === 'reorder' ? (
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">
                    Branch Minimum Reorder Level Threshold ({editingStock.product.unit})
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={newReorderLevel}
                    onChange={(e) => setNewReorderLevel(Math.max(0, Number(e.target.value)))}
                    className={`w-full rounded-xl border px-3 py-2 text-sm font-mono font-bold ${
                      isDarkMode
                        ? 'bg-slate-900 border-slate-700 text-white'
                        : 'bg-white border-slate-300 text-slate-900'
                    }`}
                    required
                  />
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Catalog default for this SKU is <strong className="text-indigo-500">{editingStock.product.minReorderLevel} {editingStock.product.unit}</strong>.
                  </p>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">
                      On Hand Units Count ({editingStock.product.unit})
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={newQty}
                      onChange={(e) => setNewQty(Math.max(0, Number(e.target.value)))}
                      className={`w-full rounded-xl border px-3 py-2 text-sm font-mono font-bold ${
                        isDarkMode
                          ? 'bg-slate-900 border-slate-700 text-white'
                          : 'bg-white border-slate-300 text-slate-900'
                      }`}
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">
                      Reason for Adjustment
                    </label>
                    <input
                      type="text"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      className={`w-full rounded-xl border px-3 py-2 text-xs ${
                        isDarkMode
                          ? 'bg-slate-900 border-slate-700 text-white'
                          : 'bg-white border-slate-300 text-slate-900'
                      }`}
                      required
                    />
                  </div>
                </>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingStock(null)}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold border ${
                    isDarkMode
                      ? 'border-slate-800 text-slate-400 hover:bg-slate-800'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-500 shadow-md transition-all cursor-pointer"
                >
                  Save Configuration
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* BULK SYNC MODAL */}
      {showBulkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className={`w-full max-w-lg rounded-2xl shadow-2xl border p-6 ${
            isDarkMode ? 'bg-[#0f1218] border-slate-800 text-slate-200' : 'bg-white border-slate-200 text-slate-800'
          }`}>
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="h-5 w-5 text-indigo-500" />
                <h3 className={`font-bold text-base ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                  Bulk Reorder Level Synchronization
                </h3>
              </div>
              <button
                onClick={() => setShowBulkModal(false)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div className="p-3 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-900 text-xs text-indigo-700 dark:text-indigo-300 flex items-start gap-2">
                <Info className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <div>
                  This action will populate or sync minimum reorder level thresholds across all <strong>{branches.length} branches</strong> and <strong>{products.length} products</strong> in the system.
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-400">
                  Select Synchronization Pattern:
                </label>

                <label className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                  bulkStrategy === 'EQUAL_PRODUCT'
                    ? 'border-indigo-600 bg-indigo-50/50 dark:bg-indigo-950/30'
                    : isDarkMode ? 'border-slate-800 hover:bg-slate-900' : 'border-slate-200 hover:bg-slate-50'
                }`}>
                  <input
                    type="radio"
                    name="strategy"
                    checked={bulkStrategy === 'EQUAL_PRODUCT'}
                    onChange={() => setBulkStrategy('EQUAL_PRODUCT')}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="text-xs font-bold text-slate-900 dark:text-white">
                      Equal Default Threshold (Product Master Min Level)
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Sets each branch's minimum reorder level equal to the master catalog product minReorderLevel.
                    </div>
                  </div>
                </label>

                <label className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                  bulkStrategy === 'HQ_WEIGHTED'
                    ? 'border-indigo-600 bg-indigo-50/50 dark:bg-indigo-950/30'
                    : isDarkMode ? 'border-slate-800 hover:bg-slate-900' : 'border-slate-200 hover:bg-slate-50'
                }`}>
                  <input
                    type="radio"
                    name="strategy"
                    checked={bulkStrategy === 'HQ_WEIGHTED'}
                    onChange={() => setBulkStrategy('HQ_WEIGHTED')}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="text-xs font-bold text-slate-900 dark:text-white">
                      Headquarters Weighted Threshold (HQ 2x, Regional 1x)
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Sets Headquarters (Head Office) to 2x master threshold, and regional branches to 1x master threshold.
                    </div>
                  </div>
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setShowBulkModal(false)}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold border ${
                    isDarkMode
                      ? 'border-slate-800 text-slate-400 hover:bg-slate-800'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleBulkSyncDefaults}
                  disabled={isSyncingBulk}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-500 shadow-md transition-all cursor-pointer disabled:opacity-50"
                >
                  {isSyncingBulk && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                  <span>{isSyncingBulk ? 'Syncing...' : 'Apply Bulk Sync'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
