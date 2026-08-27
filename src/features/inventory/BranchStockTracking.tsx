import React, { useState } from 'react';
import { Product, Branch, InventoryStock, User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';
import { exportToCSV } from '../../utils/exportUtils';
import {
  Layers,
  Building2,
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Plus,
  RefreshCw,
  X,
  Search,
  Filter,
  Download,
  FileSpreadsheet,
} from 'lucide-react';

interface BranchStockTrackingProps {
  currentUser?: User | null;
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  selectedBranchId: string;
  onUpdateStockLevel?: (stockId: string, newQty: number, reason: string) => Promise<void>;
  onCreateStockTransfer: (
    sourceBranchId: string,
    destBranchId: string,
    productId: string,
    qty: number
  ) => Promise<void>;
  isDarkMode?: boolean;
}

export const BranchStockTracking: React.FC<BranchStockTrackingProps> = ({
  currentUser,
  products,
  branches,
  stock,
  selectedBranchId,
  onCreateStockTransfer,
  isDarkMode = false,
}) => {
  // Transfer state
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [transferSource, setTransferSource] = useState(
    currentUser?.branchId && currentUser.branchId !== 'ALL' ? currentUser.branchId : branches[0]?.id || ''
  );
  const [transferDest, setTransferDest] = useState(
    branches.find((b) => !b.isHeadquarters && b.id !== currentUser?.branchId)?.id || branches[1]?.id || ''
  );
  const [transferProduct, setTransferProduct] = useState(products[0]?.id || '');
  const [transferQty, setTransferQty] = useState(1);
  const [transferError, setTransferError] = useState('');

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
      return sum + (item ? item.quantityOnHand : 0);
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

  const handleExportBranchStockCSV = () => {
    // Dynamic columns including per-branch quantities
    const dynamicBranchCols = activeBranches.map((b) => ({
      key: `branch_${b.id}`,
      label: `${b.name} (On-Hand)`,
      formatter: (_: any, prod: Product) => {
        const item = stock.find((st) => st.productId === prod.id && st.branchId === b.id);
        return item ? item.quantityOnHand : 0;
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
            return sum + (item ? item.quantityOnHand : 0);
          }, 0);
        },
      },
      {
        key: 'totalCostValuation',
        label: 'Total Cost Valuation (NPR)',
        formatter: (_: any, prod: Product) => {
          const qty = activeBranches.reduce((sum, b) => {
            const item = stock.find((st) => st.productId === prod.id && st.branchId === b.id);
            return sum + (item ? item.quantityOnHand : 0);
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

  const handleTransferSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTransferError('');

    if (transferSource === transferDest) {
      setTransferError('Source and destination branches must be different.');
      return;
    }

    const destBranch = branches.find((b) => b.id === transferDest);
    if (destBranch?.isHeadquarters && currentUser?.role !== 'SUPER_ADMIN') {
      setTransferError('Restricted: Direct stock transfers to Central Warehouse are not allowed for branch staff. Please log a Pullout or Damage in Stock Operations instead.');
      return;
    }

    await onCreateStockTransfer(transferSource, transferDest, transferProduct, Number(transferQty));
    setIsTransferModalOpen(false);
  };

  return (
    <div className="space-y-6">
      {/* Header & Actions */}
      <div className="flex-none flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className={`text-xl font-serif font-bold tracking-tight flex items-center gap-2 ${
            isDarkMode ? 'text-white' : 'text-slate-900'
          }`}>
            <Layers className="h-5 w-5 text-indigo-500" />
            <span>Branch Stock Matrix & Location Tracking</span>
          </h2>
          <p className={`text-xs mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Realtime stock balances across branches with reorder status alerts and direct transfer dispatches.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={handleExportBranchStockCSV}
            className="flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:hover:bg-emerald-900/80 border border-emerald-300 dark:border-emerald-700/60 cursor-pointer shadow-xs transition-all"
            title="Export full Branch Stock Matrix with uniform BS Date (YYYY-MM-DD)"
          >
            <Download className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            <FileSpreadsheet className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            <span>Export Matrix CSV (BS Date)</span>
          </button>

          <button
            onClick={() => setShowZeroStock(!showZeroStock)}
            className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold border transition-all cursor-pointer ${
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

          {(() => {
            const canTransfer = isOperationAllowed('branch-transfer-create', currentUser?.role);
            if (!canTransfer) return null;
            return (
              <button
                type="button"
                onClick={() => setIsTransferModalOpen(true)}
                className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 shadow-md transition-all cursor-pointer"
              >
                <ArrowLeftRight className="h-4 w-4" />
                <span>Dispatch Stock Transfer</span>
              </button>
            );
          })()}
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className={`flex-none flex flex-col md:flex-row items-center justify-between gap-3 p-3.5 rounded-2xl border shadow-sm ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
      }`}>
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            placeholder="Scan Barcode or Search & Enter Product Name / SKU:"
            className={`w-full rounded-xl border pl-9 pr-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500 ${
              isDarkMode
                ? 'bg-slate-900 border-slate-800 text-slate-200 placeholder-slate-500'
                : 'bg-slate-50 border-slate-200 text-slate-800 placeholder-slate-400'
            }`}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          <Filter className="h-4 w-4 text-slate-400 ml-1" />
          <span className={`text-xs font-semibold ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Category:</span>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className={`rounded-xl border px-3 py-1.5 text-xs font-medium focus:outline-none focus:border-indigo-500 cursor-pointer ${
              isDarkMode
                ? 'bg-slate-900 border-slate-800 text-slate-200'
                : 'bg-slate-50 border-slate-200 text-slate-800'
            }`}
          >
            <option value="ALL" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">All Categories ({products.length})</option>
            {categories.map((cat) => (
              <option key={cat} value={cat} className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">
                {cat}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Stock Matrix Table with Sticky Frozen Headers and Column */}
      <div className={`rounded-2xl border shadow-lg overflow-hidden ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
      }`}>
        <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-15rem)] relative">
          <table className="w-full text-left text-xs border-collapse">
            <thead className={`sticky top-0 z-20 font-bold uppercase text-[10px] tracking-wider border-b shadow-xs ${
              isDarkMode ? 'bg-[#12161f] text-slate-400 border-slate-800' : 'bg-slate-100 text-slate-700 border-slate-200'
            }`}>
              <tr>
                <th className={`p-3.5 sticky top-0 left-0 z-30 w-64 border-r ${
                  isDarkMode ? 'bg-[#12161f] border-slate-800' : 'bg-slate-100 border-slate-200'
                }`}>
                  Product SKU & Name
                </th>
                <th className="p-3.5 text-center sticky top-0 bg-inherit">Category</th>
                <th className="p-3.5 text-right sticky top-0 bg-inherit">Min Reorder</th>
                <th className={`p-3.5 text-center sticky top-0 border-l border-r font-extrabold ${
                  isDarkMode ? 'bg-indigo-950/40 text-indigo-300 border-slate-800' : 'bg-indigo-50/80 text-indigo-900 border-slate-200'
                }`}>
                  Total Stock
                </th>
                {activeBranches.map((b) => (
                  <th key={b.id} className={`p-3.5 text-center border-l sticky top-0 bg-inherit min-w-[130px] ${
                    isDarkMode ? 'border-slate-800' : 'border-slate-200'
                  }`}>
                    <div className={`font-bold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>{b.name}</div>
                    <div className="text-[9px] font-normal text-slate-500 font-mono">
                      {b.code} {b.isHeadquarters && '⭐ HQ'}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-slate-200'}`}>
              {visibleProducts.length === 0 ? (
                <tr>
                  <td colSpan={4 + activeBranches.length} className="p-8 text-center text-slate-500 text-xs">
                    No available stock items found. Click "Showing Available Stock Only" to toggle and view zero-stock items.
                  </td>
                </tr>
              ) : (
                visibleProducts.map((prod) => {
                  const systemTotalUsable = branches.reduce((sum, b) => {
                    const st = stock.find((item) => item.productId === prod.id && item.branchId === b.id);
                    return sum + (st ? st.quantityOnHand : 0);
                  }, 0);

                  const systemTotalDamaged = branches.reduce((sum, b) => {
                    const st = stock.find((item) => item.productId === prod.id && item.branchId === b.id);
                    return sum + (st ? st.damagedQty || 0 : 0);
                  }, 0);

                  return (
                    <tr key={prod.id} className={`transition-colors ${
                      isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'
                    }`}>
                      <td className={`p-3.5 sticky left-0 z-10 border-r font-medium ${
                        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
                      }`}>
                        <div className={`font-bold text-xs ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>{prod.name}</div>
                        <div className="text-[10px] text-indigo-600 dark:text-indigo-400 font-mono mt-0.5">
                          SKU: {prod.sku}
                        </div>
                      </td>
                      <td className="p-3.5 text-center">
                        <span className={`rounded px-2 py-0.5 text-[10px] font-semibold border ${
                          isDarkMode
                            ? 'bg-slate-900 text-slate-300 border-slate-800'
                            : 'bg-slate-100 text-slate-700 border-slate-200'
                        }`}>
                          {prod.category}
                        </span>
                      </td>
                      <td className={`p-3.5 text-right font-mono font-semibold ${
                        isDarkMode ? 'text-slate-400' : 'text-slate-600'
                      }`}>
                        {prod.minReorderLevel} {prod.unit}
                      </td>

                      {/* Total Stock Column */}
                      <td className={`p-3.5 text-center border-l border-r font-mono font-bold ${
                        isDarkMode ? 'bg-indigo-950/20 border-slate-800 text-indigo-300' : 'bg-indigo-50/50 border-slate-200 text-indigo-900'
                      }`}>
                        <div className="flex flex-col items-center">
                          <span className="text-xs">
                            {systemTotalUsable} <span className="text-[10px] font-normal opacity-75">{prod.unit}</span>
                          </span>
                          {systemTotalDamaged > 0 && (
                            <span className="text-[9px] text-amber-600 dark:text-amber-400 font-semibold mt-0.5">
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
                          className={`p-3 text-center border-l font-medium ${
                            isDarkMode ? 'border-slate-800' : 'border-slate-200'
                          } ${
                            isLow ? (isDarkMode ? 'bg-rose-950/20' : 'bg-rose-50/60') : ''
                          }`}
                        >
                          <div className="flex flex-col items-center justify-center">
                            <span
                              className={`font-mono font-bold text-xs ${
                                isLow
                                  ? 'text-rose-600 dark:text-rose-400'
                                  : isDarkMode ? 'text-slate-200' : 'text-slate-800'
                              }`}
                            >
                              {s.quantityOnHand} <span className="text-[10px] text-slate-400 font-normal">{prod.unit} usable</span>
                            </span>
                            {(s.damagedQty || 0) > 0 && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/60 px-1.5 py-0.2 rounded border border-amber-200 dark:border-amber-800/50 mt-0.5">
                                <AlertTriangle className="h-2.5 w-2.5" />
                                <span>{s.damagedQty} damaged</span>
                              </span>
                            )}
                          </div>
                          {isLow && (
                            <div className="flex items-center justify-center gap-1 text-[9px] text-rose-600 dark:text-rose-400 font-semibold mt-0.5">
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
      </div>

      {/* Inter-Branch Transfer Modal */}
      {isTransferModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className={`w-full max-w-md rounded-2xl shadow-2xl border overflow-hidden ${
            isDarkMode ? 'bg-[#0f1218] border-slate-800 text-slate-300' : 'bg-white border-slate-200 text-slate-700'
          }`}>
            <div className={`flex items-center justify-between border-b p-4 ${
              isDarkMode ? 'border-slate-800 bg-slate-900/50' : 'border-slate-200 bg-slate-50'
            }`}>
              <h3 className={`font-bold text-sm flex items-center gap-2 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                <ArrowLeftRight className="h-4 w-4 text-indigo-500" />
                <span>Inter-Branch Stock Transfer</span>
              </h3>
              <button
                onClick={() => setIsTransferModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleTransferSubmit} className="p-4 space-y-3">
              {transferError && (
                <div className="flex items-start gap-2 rounded-lg bg-rose-50 dark:bg-rose-950/80 p-3 text-xs text-rose-700 dark:text-rose-200 border border-rose-200 dark:border-rose-800">
                  <AlertTriangle className="h-4 w-4 text-rose-500 flex-shrink-0 mt-0.5" />
                  <span>{transferError}</span>
                </div>
              )}
              <div>
                <label className="block text-[11px] font-semibold opacity-80 mb-1">
                  Select Product to Transfer
                </label>
                <select
                  value={transferProduct}
                  onChange={(e) => setTransferProduct(e.target.value)}
                  className={`w-full rounded-lg border px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500 ${
                    isDarkMode ? 'border-slate-700 bg-slate-900 text-slate-200' : 'border-slate-300 bg-slate-50 text-slate-900'
                  }`}
                >
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.sku})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold opacity-80 mb-1">
                    Source Branch
                  </label>
                  <select
                    value={transferSource}
                    onChange={(e) => setTransferSource(e.target.value)}
                    className={`w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 ${
                      isDarkMode ? 'border-slate-700 bg-slate-900 text-slate-200' : 'border-slate-300 bg-slate-50 text-slate-900'
                    }`}
                  >
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold opacity-80 mb-1">
                    Destination Branch
                  </label>
                  <select
                    value={transferDest}
                    onChange={(e) => setTransferDest(e.target.value)}
                    className={`w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 ${
                      isDarkMode ? 'border-slate-700 bg-slate-900 text-slate-200' : 'border-slate-300 bg-slate-50 text-slate-900'
                    }`}
                  >
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold opacity-80 mb-1">
                  Quantity to Dispatch
                </label>
                <input
                  type="number"
                  required
                  min={1}
                  value={transferQty}
                  onChange={(e) => setTransferQty(Number(e.target.value))}
                  className={`w-full rounded-lg border px-3 py-1.5 text-xs font-mono font-bold focus:outline-none focus:border-indigo-500 ${
                    isDarkMode ? 'border-slate-700 bg-slate-900 text-slate-200' : 'border-slate-300 bg-slate-50 text-slate-900'
                  }`}
                />
              </div>

              <div className={`pt-3 border-t flex items-center justify-end gap-2 ${
                isDarkMode ? 'border-slate-800' : 'border-slate-200'
              }`}>
                <button
                  type="button"
                  onClick={() => setIsTransferModalOpen(false)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                    isDarkMode ? 'border-slate-700 text-slate-400 hover:bg-slate-800' : 'border-slate-300 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 shadow-md cursor-pointer"
                >
                  Create Shipment Transfer
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
