import React, { useState } from 'react';
import { Product, Branch, InventoryStock, User } from '../../types';
import { exportToCSV } from '../../utils/exportUtils';
import {
  Layers,
  Building2,
  AlertTriangle,
  CheckCircle2,
  Plus,
  RefreshCw,
  Search,
  Filter,
  Download,
  FileSpreadsheet,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { useDarkMode } from '../../contexts/DarkModeContext';

interface BranchStockTrackingProps {
  currentUser?: User | null;
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  selectedBranchId: string;
  onUpdateStockLevel?: (stockId: string, newQty: number, reason: string) => Promise<void>;
}

export const BranchStockTracking: React.FC<BranchStockTrackingProps> = ({
  currentUser,
  products,
  branches,
  stock,
  selectedBranchId,
}) => {
  const { isDarkMode } = useDarkMode();
  const [showZeroStock, setShowZeroStock] = useState(false);
  const [localSearch, setLocalSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('ALL');

  const categories = Array.from(new Set(products.map((p) => p.category)));

  const activeBranches =
    selectedBranchId === 'ALL'
      ? branches
      : branches.filter((b) => b.id === selectedBranchId);

  // Compute total stock quantity per product across visible branches
  const productsWithStock = products.map((prod) => {
    const totalQty = activeBranches.reduce((sum, b) => {
      const item = stock.find((st) => st.productId === prod.id && st.branchId === b.id);
      return sum + (item ? Number(item.quantityOnHand) : 0);
    }, 0);
    return { prod, totalQty };
  });

  const visibleProducts = productsWithStock
    .filter(({ prod, totalQty }) => {
      const matchesStockFilter = showZeroStock || totalQty > 0;
      const matchesCat = filterCategory === 'ALL' || prod.category === filterCategory;
      const query = localSearch.trim().toLowerCase();
      const matchesSearch =
        !query ||
        (prod?.name || '').toLowerCase().includes(query) ||
        (prod?.sku || '').toLowerCase().includes(query) ||
        (prod?.barcode || '').toLowerCase().includes(query) ||
        (prod?.category || '').toLowerCase().includes(query);

      return matchesStockFilter && matchesCat && matchesSearch;
    })
    .map(({ prod }) => prod);

  const hiddenZeroStockCount = productsWithStock.filter(({ totalQty }) => totalQty === 0).length;

  const branchStockPagination = useClientPagination(visibleProducts, 20, [filterCategory, localSearch]);

  const handleExportBranchStockCSV = () => {
    // Dynamic columns including per-branch quantities
    const dynamicBranchCols = activeBranches.map((b) => ({
      key: `branch_${b.id}`,
      label: `${b.name} (On-Hand)`,
      formatter: (_: any, prod: Product) => {
        const item = stock.find((st) => st.productId === prod.id && st.branchId === b.id);
        return item ? Number(item.quantityOnHand) : 0;
      },
    }));

    const columns = [
      { key: 'sku', label: 'SKU Code' },
      { key: 'barcode', label: 'Barcode' },
      { key: 'name', label: 'Product Name' },
      { key: 'productGroup', label: 'Product Group', formatter: (val: string) => val || 'Product Item' },
      { key: 'category', label: 'Category' },
      { key: 'unit', label: 'Unit (UoM)' },
      { key: 'costPrice', label: 'Cost Price (NPR)', formatter: (val: number) => val || 0 },
      { key: 'sellingPrice', label: 'Selling Price (NPR)', formatter: (val: number) => val || 0 },
      ...dynamicBranchCols,
      {
        key: 'totalOnHand',
        label: 'Total On-Hand (Visible Branches)',
        formatter: (_: any, prod: Product) => {
          return activeBranches.reduce((sum, b) => {
            const item = stock.find((st) => st.productId === prod.id && st.branchId === b.id);
            return sum + (item ? Number(item.quantityOnHand) : 0);
          }, 0);
        },
      },
      {
        key: 'totalCostValuation',
        label: 'Total Cost Valuation (NPR)',
        formatter: (_: any, prod: Product) => {
          const qty = activeBranches.reduce((sum, b) => {
            const item = stock.find((st) => st.productId === prod.id && st.branchId === b.id);
            return sum + (item ? Number(item.quantityOnHand) : 0);
          }, 0);
          return qty * (prod.costPrice || 0);
        },
      },
      { key: 'minReorderLevel', label: 'Reorder Level' },
    ];

    const branchName =
      selectedBranchId === 'ALL'
        ? 'All Branches Matrix'
        : branches.find((b) => b.id === selectedBranchId)?.name || `Branch ${selectedBranchId}`;

    exportToCSV({
      filename: 'Branch_Stock_Matrix_Report',
      reportTitle: 'Branch Stock Matrix & Multi-Location Inventory Report',
      branchName,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: visibleProducts,
      columns,
    });
  };

  return (
    <div className="space-y-3">
      {/* Header & Actions */}
      <div className="flex-none flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white`}>
            <Layers className="h-5 w-5 text-indigo-500" />
            <span>Branch Stock Matrix & Location Tracking</span>
          </h2>
          <p className={`truncate text-xs mt-0.5 text-slate-500 dark:text-slate-400`}>
            Realtime stock balances across branches with reorder status alerts and direct transfer dispatches.
          </p>
        </div>

        <div className="shrink-0 flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={handleExportBranchStockCSV}
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:hover:bg-emerald-900/80 border border-emerald-300 dark:border-emerald-700/60 cursor-pointer shadow-xs transition-all"
            title="Export full Branch Stock Matrix with uniform BS Date (YYYY-MM-DD)"
          >
            <Download className={`h-4 w-4 text-emerald-600 dark:text-emerald-400`} />
            <FileSpreadsheet className={`h-4 w-4 text-emerald-600 dark:text-emerald-400`} />
            <span>Export Matrix CSV (BS Date)</span>
          </button>

          <button
            onClick={() => setShowZeroStock(!showZeroStock)}
            className={`flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-semibold border transition-all cursor-pointer ${
              showZeroStock
                ? 'bg-amber-50 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-600/40 hover:bg-amber-100'
                : 'bg-emerald-50 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-600/40 hover:bg-emerald-100'
            }`}
          >
            <CheckCircle2 className="h-4 w-4" />
            <span>
              {showZeroStock
                ? 'Showing All Stock (Inc. 0 Stock)'
                : `Showing Available Stock Only (>0)`}
            </span>
            {!showZeroStock && hiddenZeroStockCount > 0 && (
              <span className="rounded-full bg-emerald-200 dark:bg-emerald-900/90 text-emerald-800 dark:text-emerald-200 px-2 py-0.5 text-[10px] font-bold">
                {hiddenZeroStockCount} Zero-Stock Items Hidden
              </span>
            )}
          </button>

        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className={`flex-none flex flex-col md:flex-row items-center justify-between gap-3 p-3.5 rounded-2xl border shadow-sm bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
 <div className="relative md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            placeholder="Scan Barcode or Search & Enter Product Name / SKU:"
            className={`w-full rounded-xl border pl-9 pr-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500 bg-slate-50 border-slate-200 text-slate-800 placeholder-slate-400 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200 dark:placeholder-slate-500`}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          <Filter className="h-4 w-4 text-slate-400 ml-1" />
          <span className={`text-xs font-semibold text-slate-500 dark:text-slate-400`}>Category:</span>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className={`rounded-xl border px-3 py-1.5 text-xs font-medium focus:outline-none focus:border-indigo-500 cursor-pointer bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
          >
            <option value="ALL" className={`bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100`}>All Categories ({products.length})</option>
            {categories.map((cat) => (
              <option key={cat} value={cat} className={`bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100`}>
                {cat}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Stock Matrix Table with Sticky Frozen Headers and Column */}
      <div className={`rounded-2xl border shadow-lg overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
        <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-15rem)] relative">
          <table className="w-full text-left text-xs border-collapse">
            <thead className={`sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b shadow-xs bg-slate-100 text-slate-700 border-slate-200 dark:bg-[#12161f] dark:text-slate-400 dark:border-slate-800`}>
              <tr>
                <th className={`px-2.5 py-1.5 sticky top-0 left-0 z-30 w-64 border-r bg-slate-100 border-slate-200 dark:bg-[#12161f] dark:border-slate-800`}>
                  Product SKU & Name
                </th>
                <th className="px-2.5 py-1.5 text-center sticky top-0 bg-inherit">Category</th>
                <th className="px-2.5 py-1.5 text-right sticky top-0 bg-inherit">Min Reorder</th>
                <th className={`px-2.5 py-1.5 text-center sticky top-0 border-l border-r font-extrabold bg-indigo-50/80 text-indigo-900 border-slate-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-slate-800`}>
                  Total Stock
                </th>
                {activeBranches.map((b) => (
                  <th key={b.id} className={`px-2.5 py-1.5 text-center border-l sticky top-0 bg-inherit min-w-[130px] border-slate-200 dark:border-slate-800`}>
                    <div className={`font-bold text-slate-900 dark:text-white`}>{b.name}</div>
                    <div className="text-[9px] font-normal text-slate-500 font-mono">
                      {b.code} {b.isHeadquarters && '⭐ HQ'}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
              {visibleProducts.length === 0 ? (
                <tr>
                  <td colSpan={4 + activeBranches.length} className="p-8 text-center text-slate-500 text-xs">
                    No available stock items found. Click "Showing Available Stock Only" to toggle and view zero-stock items.
                  </td>
                </tr>
              ) : (
                branchStockPagination.pagedItems.map((prod) => {
                  const systemTotalUsable = branches.reduce((sum, b) => {
                    const st = stock.find((item) => item.productId === prod.id && item.branchId === b.id);
                    return sum + (st ? Number(st.quantityOnHand) : 0);
                  }, 0);

                  const systemTotalDamaged = branches.reduce((sum, b) => {
                    const st = stock.find((item) => item.productId === prod.id && item.branchId === b.id);
                    return sum + (st ? Number(st.damagedQty) || 0 : 0);
                  }, 0);

                  return (
                    <tr key={prod.id} className={`group transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40`}>
                      <td className={`p-2.5 sticky left-0 z-10 border-r font-medium bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800 transition-colors group-hover:bg-slate-200 dark:group-hover:bg-slate-800/40`}>
                        <div className={`font-bold text-xs text-slate-900 dark:text-white`}>{prod.name}</div>
                        <div className={`text-[10px] text-indigo-600 dark:text-indigo-400 font-mono mt-0.5`}>
                          SKU: {prod.sku}
                        </div>
                      </td>
                      <td className="p-2.5 text-center">
                        <span className={`rounded px-2 py-0.5 text-[10px] font-semibold border bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800`}>
                          {prod.category}
                        </span>
                      </td>
                      <td className={`p-2.5 text-right font-mono font-semibold text-slate-600 dark:text-slate-400`}>
                        {prod.minReorderLevel} {prod.unit}
                      </td>

                      {/* Total Stock Column */}
                      <td className={`p-2.5 text-center border-l border-r font-mono font-bold bg-indigo-50/50 border-slate-200 text-indigo-900 dark:bg-indigo-950/20 dark:border-slate-800 dark:text-indigo-300`}>
                        <div className="flex flex-col items-center">
                          <span className="text-xs">
                            {systemTotalUsable} <span className="text-[10px] font-normal opacity-75">{prod.unit}</span>
                          </span>
                          {systemTotalDamaged > 0 && (
                            <span className={`text-[9px] text-amber-600 dark:text-amber-400 font-semibold mt-0.5`}>
                              ({systemTotalDamaged} damaged)
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Branch Stock cells */}
                    {activeBranches.map((b) => {
                      const s = stock.find(
                        (st) => st.productId === prod.id && st.branchId === b.id
                      ) || {
                        id: `temp-${prod.id}-${b.id}`,
                        productId: prod.id,
                        branchId: b.id,
                        quantityOnHand: 0,
                        reservedQty: 0,
                        incomingQty: 0,
                        lastUpdated: new Date().toISOString(),
                      };

                      const isLow = s.quantityOnHand <= prod.minReorderLevel;

                      return (
                        <td
                          key={b.id}
                          className={`p-3 text-center border-l font-medium border-slate-200 dark:border-slate-800 ${isLow ? 'bg-rose-50/60 dark:bg-rose-950/20' : ''}`}
                        >
                          <div className="flex flex-col items-center justify-center">
                            <span
                              className={`font-mono font-bold text-xs ${
                                isLow
                                  ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-200'
                              }`}
                            >
                              {s.quantityOnHand} <span className="text-[10px] text-slate-400 font-normal">{prod.unit} usable</span>
                            </span>
                            {(s.damagedQty || 0) > 0 && (
                              <span className={`inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-600 bg-amber-50 border-amber-200 dark:text-amber-400 dark:bg-amber-950/60 dark:border-amber-800/50 px-1.5 py-0.2 rounded border mt-0.5`}>
                                <AlertTriangle className="h-2.5 w-2.5" />
                                <span>{s.damagedQty} damaged</span>
                              </span>
                            )}
                          </div>
                          {isLow && (
                            <div className={`flex items-center justify-center gap-1 text-[9px] text-rose-600 dark:text-rose-400 font-semibold mt-0.5`}>
                              <AlertTriangle className="h-2.5 w-2.5" />
                              <span>Low Stock</span>
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
          </table>
        </div>
        <TablePagination
          page={branchStockPagination.page}
          pageCount={branchStockPagination.pageCount}
          totalItems={branchStockPagination.totalItems}
          rangeStart={branchStockPagination.rangeStart}
          rangeEnd={branchStockPagination.rangeEnd}
          pageSize={branchStockPagination.pageSize}
          onPageChange={branchStockPagination.setPage}
          onPageSizeChange={branchStockPagination.setPageSize}
          className="mt-1"
        />
      </div>

    </div>
  );
};
