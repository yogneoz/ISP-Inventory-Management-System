import React, { useState } from 'react';
import { Product, Branch, InventoryStock } from '../../types';
import { exportToCSV } from '../../utils/exportUtils';
import { formatNPR, formatNPRInteger } from '../../utils/nprFormat';
import {
  Coins,
  TrendingUp,
  Filter,
  Download,
  AlertTriangle,
  ArrowUpRight
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { DateField } from '../../components/DateField';
import { FilterCard } from '../../components/common/FilterCard';

interface StockValuationProps {
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  selectedBranchId: string;
  /** Global calendar mode from the header toggle (BS Nepali picker / AD native picker). */
  dateMode?: 'BS' | 'AD';
}

export const StockValuation: React.FC<StockValuationProps> = ({
  products,
  branches,
  stock,
  selectedBranchId,
  dateMode = 'BS',
}) => {
  const [activeBranchId, setActiveBranchId] = useState<string>(selectedBranchId);
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [stockStatusFilter, setStockStatusFilter] = useState<'ALL' | 'LOW' | 'NORMAL' | 'OUT_OF_STOCK'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  // Stock-activity date range (canonical AD values; DateField converts BS
  // picks). Narrows rows by the latest stock movement date (lastUpdated);
  // an empty bound is open-ended.
  const [activityFromAD, setActivityFromAD] = useState('');
  const [activityToAD, setActivityToAD] = useState('');
  const [subView, setSubView] = useState<'ITEMIZED' | 'CATEGORY' | 'BRANCH'>('ITEMIZED');

  React.useEffect(() => {
    setActiveBranchId(selectedBranchId);
  }, [selectedBranchId]);

  const categories = Array.from(new Set(products.map((p) => p.category)));
  const visibleBranches = activeBranchId === 'ALL'
    ? branches
    : branches.filter((b) => b.id === activeBranchId);

  // Compute itemized stock valuation data
  const itemizedValuationData = products.map((prod) => {
    let totalOnHand = 0;
    let totalDamaged = 0;

    visibleBranches.forEach((b) => {
      const item = stock.find((s) => s.productId === prod.id && s.branchId === b.id);
      if (item) {
        totalOnHand += Number(item.quantityOnHand);
        totalDamaged += Number(item.damagedQty) || 0;
      }
    });

    const costValuation = totalOnHand * prod.costPrice;
    const retailValuation = totalOnHand * prod.sellingPrice;
    const potentialMargin = retailValuation - costValuation;
    const marginPercent = retailValuation > 0 ? (potentialMargin / retailValuation) * 100 : 0;
    const damagedLoss = totalDamaged * prod.costPrice;

    const isLow = visibleBranches.some((b) => {
      const item = stock.find((s) => s.productId === prod.id && s.branchId === b.id);
      const onHand = item ? item.quantityOnHand : 0;
      const threshold = item?.minReorderLevel ?? prod.minReorderLevel;
      return threshold > 0 ? onHand <= threshold : onHand <= 0;
    });

    const isOutOfStock = totalOnHand <= 0;

    return {
      prod,
      totalOnHand,
      totalDamaged,
      costValuation,
      retailValuation,
      potentialMargin,
      marginPercent,
      damagedLoss,
      isLow,
      isOutOfStock,
    };
  });

  // Filtered Itemized Data
  const filteredItemized = itemizedValuationData.filter(({ prod, totalOnHand, isLow, isOutOfStock }) => {
    if (selectedCategory !== 'ALL' && prod.category !== selectedCategory) return false;

    // Latest stock movement for this product across the visible branches.
    if (activityFromAD || activityToAD) {
      const latestDay = visibleBranches.reduce((latest: string, b) => {
        const item = stock.find((s) => s.productId === prod.id && s.branchId === b.id);
        const day = String(item?.lastUpdated || '').split('T')[0];
        return day && day > latest ? day : latest;
      }, '');
      if (!latestDay) return false;
      if (activityFromAD && latestDay < activityFromAD) return false;
      if (activityToAD && latestDay > activityToAD) return false;
    }

    if (stockStatusFilter === 'LOW' && !isLow) return false;
    if (stockStatusFilter === 'OUT_OF_STOCK' && !isOutOfStock) return false;
    if (stockStatusFilter === 'NORMAL' && (isLow || isOutOfStock)) return false;

    if (searchQuery.trim()) {
      const q = (searchQuery || '').toLowerCase().trim();
      const matchName = (prod?.name || '').toLowerCase().includes(q);
      const matchSKU = (prod?.sku || '').toLowerCase().includes(q);
      const matchBarcode = prod.barcode ? (prod?.barcode || '').toLowerCase().includes(q) : false;
      const matchCat = (prod?.category || '').toLowerCase().includes(q);
      if (!matchName && !matchSKU && !matchBarcode && !matchCat) return false;
    }
    return true;
  });

  // Overall KPI Aggregations across visible scope
  const grandTotalUnits = filteredItemized.reduce((sum, i) => sum + i.totalOnHand, 0);
  const grandCostValuation = filteredItemized.reduce((sum, i) => sum + i.costValuation, 0);
  const grandRetailValuation = filteredItemized.reduce((sum, i) => sum + i.retailValuation, 0);
  const grandPotentialMargin = grandRetailValuation - grandCostValuation;
  const grandMarginPercent = grandRetailValuation > 0 ? (grandPotentialMargin / grandRetailValuation) * 100 : 0;
  const grandDamagedLoss = filteredItemized.reduce((sum, i) => sum + i.damagedLoss, 0);

  const itemizedPagination = useClientPagination(filteredItemized, 20, [
    selectedCategory,
    stockStatusFilter,
    searchQuery,
    activityFromAD,
    activityToAD,
  ]);

  // Category Breakdown Data
  const categoryBreakdown = categories.map((cat) => {
    const catItems = itemizedValuationData.filter(({ prod }) => prod.category === cat);
    const catSkus = catItems.length;
    const catUnits = catItems.reduce((sum, i) => sum + i.totalOnHand, 0);
    const catCostVal = catItems.reduce((sum, i) => sum + i.costValuation, 0);
    const catRetailVal = catItems.reduce((sum, i) => sum + i.retailValuation, 0);
    const catMargin = catRetailVal - catCostVal;
    const catSharePercent = grandCostValuation > 0 ? (catCostVal / grandCostValuation) * 100 : 0;

    return {
      category: cat,
      skusCount: catSkus,
      totalUnits: catUnits,
      costValuation: catCostVal,
      retailValuation: catRetailVal,
      margin: catMargin,
      sharePercent: catSharePercent,
    };
  });

  // Branch Breakdown Data
  const branchBreakdown = branches.map((b) => {
    let bUnits = 0;
    let bDamaged = 0;
    let bCostVal = 0;
    let bRetailVal = 0;
    let bDamagedLoss = 0;

    products.forEach((prod) => {
      const item = stock.find((s) => s.productId === prod.id && s.branchId === b.id);
      if (item) {
        bUnits += Number(item.quantityOnHand);
        bDamaged += Number(item.damagedQty) || 0;
        bCostVal += Number(item.quantityOnHand) * (prod.costPrice || 0);
        bRetailVal += Number(item.quantityOnHand) * (prod.sellingPrice || 0);
        bDamagedLoss += (Number(item.damagedQty) || 0) * (prod.costPrice || 0);
      }
    });

    const bMargin = bRetailVal - bCostVal;

    return {
      branch: b,
      totalUnits: bUnits,
      damagedUnits: bDamaged,
      costValuation: bCostVal,
      retailValuation: bRetailVal,
      margin: bMargin,
    };
  });

  // Export CSV Handler
  const exportValuationCSV = () => {
    const columns = [
      { key: 'sku', label: 'SKU Code', formatter: (_: any, row: any) => row.prod.sku },
      { key: 'name', label: 'Product Name', formatter: (_: any, row: any) => row.prod.name },
      { key: 'category', label: 'Category', formatter: (_: any, row: any) => row.prod.category },
      { key: 'unit', label: 'Unit', formatter: (_: any, row: any) => row.prod.unit },
      { key: 'costPrice', label: 'Cost Price', formatter: (_: any, row: any) => row.prod.costPrice },
      { key: 'sellingPrice', label: 'Selling Price', formatter: (_: any, row: any) => row.prod.sellingPrice },
      { key: 'totalOnHand', label: 'On Hand Units' },
      { key: 'costValuation', label: 'Total Cost Valuation' },
      { key: 'retailValuation', label: 'Total Retail Valuation' },
      { key: 'potentialMargin', label: 'Potential Gross Margin' },
      { key: 'marginPercent', label: 'Margin %', formatter: (val: number) => `${val.toFixed(1)}%` },
      { key: 'totalDamaged', label: 'Damaged Units' },
      { key: 'damagedLoss', label: 'Damaged Stock Loss Value' },
    ];
    exportToCSV('Stock_Valuation_Report', filteredItemized, columns);
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white dark:text-white`}>
            <Coins className="h-5 w-5 text-emerald-500" />
            <span>Stock Valuation & Profit Margin Analysis</span>
          </h2>
          <p className={`truncate text-xs mt-0.5 text-slate-500 dark:text-slate-400`}>
            Real-time calculation of total asset value at cost price, estimated retail value, gross profit potential, and category shares.
          </p>
        </div>

        <button
          onClick={exportValuationCSV}
          className="flex items-center gap-2 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-500 shadow-md shadow-emerald-950/30 transition-all cursor-pointer"
        >
          <Download className="h-4 w-4 text-white" />
          <span>Export Stock Valuation CSV</span>
        </button>
      </div>

      {/* Financial KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
        {/* Cost Valuation */}
        <div className={`p-4 rounded-2xl border shadow-xs bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Total Inventory Cost Value
            </span>
            <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-500">
              <Coins className="h-4 w-4" />
            </div>
          </div>
          <div className={`text-xl font-bold font-mono mt-1 text-indigo-600 dark:text-indigo-400`}>
            {formatNPRInteger(grandCostValuation)}
          </div>
          <div className="text-[11px] text-slate-400 mt-1 font-medium">
            At purchase cost across {(grandTotalUnits ?? 0).toLocaleString('en-IN')} units
          </div>
        </div>

        {/* Retail Valuation */}
        <div className={`p-4 rounded-2xl border shadow-xs bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Estimated Retail Value
            </span>
            <div className="p-2 rounded-lg bg-sky-500/10 text-sky-500">
              <TrendingUp className="h-4 w-4" />
            </div>
          </div>
          <div className={`text-xl font-bold font-mono mt-1 text-sky-600 dark:text-sky-400`}>
            {formatNPRInteger(grandRetailValuation)}
          </div>
          <div className="text-[11px] text-slate-400 mt-1 font-medium">
            At selling price market value
          </div>
        </div>

        {/* Potential Profit Margin */}
        <div className={`p-4 rounded-2xl border shadow-xs bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Potential Gross Profit
            </span>
            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500">
              <ArrowUpRight className="h-4 w-4" />
            </div>
          </div>
          <div className={`text-xl font-bold font-mono mt-1 text-emerald-600 dark:text-emerald-400`}>
            {formatNPRInteger(grandPotentialMargin)}
          </div>
          <div className="text-[11px] text-slate-400 mt-1 font-medium flex items-center gap-1">
            <span className="font-bold text-emerald-500 font-mono">{grandMarginPercent.toFixed(1)}%</span> average margin
          </div>
        </div>

        {/* Damaged Stock Loss */}
        <div className={`p-4 rounded-2xl border shadow-xs bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Damaged Stock Loss Value
            </span>
            <div className="p-2 rounded-lg bg-rose-500/10 text-rose-500">
              <AlertTriangle className="h-4 w-4" />
            </div>
          </div>
          <div className={`text-xl font-bold font-mono mt-1 text-rose-600 dark:text-rose-400`}>
            {formatNPRInteger(grandDamagedLoss)}
          </div>
          <div className="text-[11px] text-slate-400 mt-1 font-medium">
            Unusable damaged stock write-off
          </div>
        </div>
      </div>

      {/* Controls & Sub-view Switcher */}
      <div className={`p-3 rounded-2xl border flex flex-col md:flex-row items-center justify-start gap-3 bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
        {/* View Switcher Buttons */}
        <div className={`p-1 rounded-xl border flex items-center gap-1 bg-slate-100 border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
          <button
            onClick={() => setSubView('ITEMIZED')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${subView === 'ITEMIZED' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}
          >
            Itemized Stock
          </button>
          <button
            onClick={() => setSubView('CATEGORY')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${subView === 'CATEGORY' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}
          >
            Category Share
          </button>
          <button
            onClick={() => setSubView('BRANCH')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${subView === 'BRANCH' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}
          >
            Branch Matrix
          </button>
        </div>

        {/* Search & Filter Card — shared inline card */}
        <div className="w-full md:w-auto md:ml-auto">
          <FilterCard
            searchPlaceholder="Scan Barcode or Search & Enter Product Name / SKU:"
            searchValue={searchQuery}
            onSearchApply={setSearchQuery}
            hasActiveFilters={
              Boolean(searchQuery) || activeBranchId !== 'ALL' || selectedCategory !== 'ALL' || stockStatusFilter !== 'ALL' ||
              Boolean(activityFromAD) || Boolean(activityToAD)
            }
            onClearAll={() => {
              setSearchQuery('');
              setActiveBranchId('ALL');
              setSelectedCategory('ALL');
              setStockStatusFilter('ALL');
              setActivityFromAD('');
              setActivityToAD('');
            }}
            filterChildren={
              <>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Branch</label>
                  <select
                    value={activeBranchId}
                    onChange={(e) => setActiveBranchId(e.target.value)}
                    className={`w-44 rounded-xl border px-3 py-2 text-xs font-medium cursor-pointer bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                  >
                    <option value="ALL">All Branch Locations</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.code})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Category</label>
                  <select
                    value={selectedCategory}
                    onChange={(e) => setSelectedCategory(e.target.value)}
                    className={`w-40 rounded-xl border px-3 py-2 text-xs font-medium cursor-pointer bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                  >
                    <option value="ALL">All Categories</option>
                    {categories.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Stock Status</label>
                  <select
                    value={stockStatusFilter}
                    onChange={(e) => setStockStatusFilter(e.target.value as any)}
                    className={`w-36 rounded-xl border px-3 py-2 text-xs font-medium cursor-pointer bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                  >
                    <option value="ALL">All</option>
                    <option value="LOW">Low Stock</option>
                    <option value="NORMAL">Normal</option>
                    <option value="OUT_OF_STOCK">Out of Stock</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Activity From</label>
                  <div className="w-40">
                    <DateField
                      mode={dateMode}
                      value={activityFromAD}
                      onChange={setActivityFromAD}
                      compact
                      showHint={false}
                      max={activityToAD || undefined}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Activity To</label>
                  <div className="w-40">
                    <DateField
                      mode={dateMode}
                      value={activityToAD}
                      onChange={setActivityToAD}
                      compact
                      showHint={false}
                      min={activityFromAD || undefined}
                    />
                  </div>
                </div>
              </>
            }
          />
        </div>
      </div>

      {/* SUBVIEW 1: Itemized Stock Table */}
      {subView === 'ITEMIZED' && (
        <div className={`rounded-2xl border shadow-lg overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="overflow-x-auto max-h-[calc(100vh-20rem)] overflow-y-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}>
                <tr>
                  <th className="px-2.5 py-1.5">Product Name & SKU</th>
                  <th className="px-2.5 py-1.5 text-center">Category</th>
                  <th className="px-2.5 py-1.5 text-right">Cost Price (NPR)</th>
                  <th className="px-2.5 py-1.5 text-right">Selling Price (NPR)</th>
                  <th className="px-2.5 py-1.5 text-center">On Hand</th>
                  <th className="px-2.5 py-1.5 text-right">Cost Valuation (NPR)</th>
                  <th className="px-2.5 py-1.5 text-right">Retail Valuation</th>
                  <th className="px-2.5 py-1.5 text-right">Potential Margin</th>
                  <th className="px-2.5 py-1.5 text-center">Damaged Loss</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {filteredItemized.length === 0 ? (
                  <tr>
                    <td colSpan={9} className={`p-8 text-center text-slate-500 dark:text-slate-400`}>
                      No stock valuation records match criteria.
                    </td>
                  </tr>
                ) : (
                  itemizedPagination.pagedItems.map(({ prod, totalOnHand, costValuation, retailValuation, potentialMargin, marginPercent, damagedLoss, totalDamaged }) => (
                    <tr key={prod.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                      <td className="p-2.5">
                        <div className={`font-bold text-slate-900 dark:text-white dark:text-white`}>{prod.name}</div>
                        <div className={`text-[10px] font-mono text-indigo-500 dark:text-indigo-400`}>SKU: {prod.sku}</div>
                      </td>

                      <td className="p-2.5 text-center">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800`}>
                          {prod.category}
                        </span>
                      </td>

                      <td className={`p-2.5 text-right font-mono text-slate-600 dark:text-slate-400`}>
                        {formatNPR(prod.costPrice)}
                      </td>

                      <td className={`p-2.5 text-right font-mono text-slate-600 dark:text-slate-400`}>
                        {formatNPR(prod.sellingPrice)}
                      </td>

                      <td className={`p-2.5 text-center font-mono font-bold text-slate-900 dark:text-white dark:text-white`}>
                        {totalOnHand} <span className={`text-[10px] font-normal text-slate-400 dark:text-slate-500`}>{prod.unit}</span>
                      </td>

                      <td className={`p-2.5 text-right font-mono font-bold text-indigo-600 dark:text-indigo-400`}>
                        {formatNPR(costValuation)}
                      </td>

                      <td className={`p-2.5 text-right font-mono font-bold text-sky-600 dark:text-sky-400`}>
                        {formatNPR(retailValuation)}
                      </td>

                      <td className="p-2.5 text-right font-mono">
                        <div className={`font-bold text-emerald-500 dark:text-emerald-400`}>
                          +{formatNPR(potentialMargin)}
                        </div>
                        <div className={`text-[10px] font-semibold text-slate-400 dark:text-slate-500 dark:text-slate-500`}>
                          {marginPercent.toFixed(1)}% margin
                        </div>
                      </td>

                      <td className="p-2.5 text-center font-mono">
                        {totalDamaged > 0 ? (
                          <span className={`text-rose-500 font-bold text-rose-500 dark:text-rose-400`}>
                            {totalDamaged} Pcs ({formatNPR(damagedLoss)})
                          </span>
                        ) : (
                          <span className="text-slate-400">0</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <TablePagination
            page={itemizedPagination.page}
            pageCount={itemizedPagination.pageCount}
            totalItems={itemizedPagination.totalItems}
            rangeStart={itemizedPagination.rangeStart}
            rangeEnd={itemizedPagination.rangeEnd}
            pageSize={itemizedPagination.pageSize}
            onPageChange={itemizedPagination.setPage}
            onPageSizeChange={itemizedPagination.setPageSize}
            className="mt-1"
          />
        </div>
      )}

      {/* SUBVIEW 2: Category Share Table */}
      {subView === 'CATEGORY' && (
        <div className={`rounded-2xl border shadow-lg overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`font-bold text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}>
                <tr>
                  <th className="px-2.5 py-1.5">Category Name</th>
                  <th className="px-2.5 py-1.5 text-center">SKUs Count</th>
                  <th className="px-2.5 py-1.5 text-center">Total Units</th>
                  <th className="px-2.5 py-1.5 text-right">Cost Valuation (NPR)</th>
                  <th className="px-2.5 py-1.5 text-right">Retail Valuation (NPR)</th>
                  <th className="px-2.5 py-1.5 text-right">Potential Margin</th>
                  <th className="px-2.5 py-1.5 text-right">% Share of Total Valuation</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {categoryBreakdown.map((catRow) => (
                  <tr key={catRow.category} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className={`p-2.5 font-bold text-slate-900 dark:text-white dark:text-white`}>
                      {catRow.category}
                    </td>
                    <td className={`p-2.5 text-center font-mono text-slate-700 dark:text-slate-300 dark:text-slate-300`}>{catRow.skusCount} SKUs</td>
                    <td className={`p-2.5 text-center font-mono font-bold text-slate-900 dark:text-white dark:text-white`}>{(catRow.totalUnits ?? 0).toLocaleString('en-IN')} Pcs</td>
                    <td className={`p-2.5 text-right font-mono font-bold text-indigo-500 dark:text-indigo-400 dark:text-indigo-400`}>
                      {formatNPR(catRow.costValuation)}
                    </td>
                    <td className={`p-2.5 text-right font-mono font-bold text-sky-500 dark:text-sky-400 dark:text-sky-400`}>
                      {formatNPR(catRow.retailValuation)}
                    </td>
                    <td className={`p-2.5 text-right font-mono font-bold text-emerald-500 dark:text-emerald-400 dark:text-emerald-400`}>
                      +{formatNPR(catRow.margin)}
                    </td>
                    <td className="p-2.5 text-right font-mono">
                      <div className="flex items-center justify-end gap-2">
                        <div className={`w-16 rounded-full h-2 overflow-hidden bg-slate-200 dark:bg-slate-700 dark:bg-slate-800`}>
                          <div
                            className={`h-full rounded-full bg-indigo-500 dark:bg-indigo-500 dark:bg-indigo-400`}
                            style={{ width: `${Math.min(100, catRow.sharePercent)}%` }}
                          />
                        </div>
                        <span className={`font-bold text-slate-900 dark:text-white dark:text-white`}>{catRow.sharePercent.toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUBVIEW 3: Branch Matrix Table */}
      {subView === 'BRANCH' && (
        <div className={`rounded-2xl border shadow-lg overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`font-bold text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}>
                <tr>
                  <th className="px-2.5 py-1.5">Branch Location</th>
                  <th className="px-2.5 py-1.5 text-center">On Hand Units</th>
                  <th className="px-2.5 py-1.5 text-center">Damaged Units</th>
                  <th className="px-2.5 py-1.5 text-right">Cost Valuation</th>
                  <th className="px-2.5 py-1.5 text-right">Retail Valuation</th>
                  <th className="px-2.5 py-1.5 text-right">Profit Potential</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {branchBreakdown.map((bRow) => (
                  <tr key={bRow.branch.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className="p-2.5">
                      <div className={`font-bold text-slate-900 dark:text-white dark:text-white`}>
                        {bRow.branch.name}
                      </div>
                      <div className={`text-[10px] font-mono text-slate-400 dark:text-slate-500`}>
                        Code: {bRow.branch.code} {bRow.branch.isHeadquarters ? '• Central HQ' : ''}
                      </div>
                    </td>
                    <td className={`p-2.5 text-center font-mono font-bold text-slate-900 dark:text-white dark:text-white`}>{(bRow.totalUnits ?? 0).toLocaleString('en-IN')} Pcs</td>
                    <td className={`p-2.5 text-center font-mono font-bold text-rose-500 dark:text-rose-400`}>
                      {bRow.damagedUnits} Pcs
                    </td>
                    <td className={`p-2.5 text-right font-mono font-bold text-indigo-500 dark:text-indigo-400`}>
                      {formatNPR(bRow.costValuation)}
                    </td>
                    <td className={`p-2.5 text-right font-mono font-bold text-sky-500 dark:text-sky-400`}>
                      {formatNPR(bRow.retailValuation)}
                    </td>
                    <td className={`p-2.5 text-right font-mono font-bold text-emerald-500 dark:text-emerald-400`}>
                      +{formatNPR(bRow.margin)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
