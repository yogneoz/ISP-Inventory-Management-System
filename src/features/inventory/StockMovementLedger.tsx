import React, { useState } from 'react';
import { TransactionLog, Product, Branch, InventoryStock, StockOperation, Shipment, PurchaseOrder } from '../../types';
import { exportToCSV } from '../../utils/exportUtils';
import { formatDualDate, formatBSDate } from '../../utils/nepaliCalendar';
import {
  BookOpen,
  Calendar,
  Filter,
  Download,
  Search,
  ArrowUpRight,
  ArrowDownLeft,
  Building2,
  RefreshCw,
  PackageCheck,
  AlertTriangle,
  History,
  Layers,
  ArrowRight
} from 'lucide-react';

interface StockMovementLedgerProps {
  transactionLogs: TransactionLog[];
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  stockOperations?: StockOperation[];
  shipments?: Shipment[];
  purchaseOrders?: PurchaseOrder[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  isDarkMode?: boolean;
}

export const StockMovementLedger: React.FC<StockMovementLedgerProps> = ({
  transactionLogs,
  products,
  branches,
  stock,
  stockOperations = [],
  shipments = [],
  purchaseOrders = [],
  selectedBranchId,
  dateMode,
  isDarkMode = false,
}) => {
  const [activeBranchId, setActiveBranchId] = useState<string>(selectedBranchId);
  const [startDateAD, setStartDateAD] = useState<string>('');
  const [endDateAD, setEndDateAD] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [viewTab, setViewTab] = useState<'SUMMARY_MATRIX' | 'TRANSACTION_LOGS'>('SUMMARY_MATRIX');

  const categories = Array.from(new Set(products.map((p) => p.category)));

  // Date Presets
  const applyPreset = (preset: 'THIS_MONTH' | 'LAST_30_DAYS' | 'THIS_YEAR' | 'ALL_TIME') => {
    const today = new Date();
    if (preset === 'ALL_TIME') {
      setStartDateAD('');
      setEndDateAD('');
      return;
    }
    if (preset === 'THIS_MONTH') {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      setStartDateAD(first.toISOString().split('T')[0]);
      setEndDateAD(today.toISOString().split('T')[0]);
      return;
    }
    if (preset === 'LAST_30_DAYS') {
      const past30 = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      setStartDateAD(past30.toISOString().split('T')[0]);
      setEndDateAD(today.toISOString().split('T')[0]);
      return;
    }
    if (preset === 'THIS_YEAR') {
      const startYear = new Date(today.getFullYear(), 0, 1);
      setStartDateAD(startYear.toISOString().split('T')[0]);
      setEndDateAD(today.toISOString().split('T')[0]);
      return;
    }
  };

  // Filter logs based on branch, date, search
  const filteredLogs = transactionLogs.filter((log) => {
    if (activeBranchId !== 'ALL' && log.branchId !== activeBranchId) return false;

    // Extract date YYYY-MM-DD
    const logDate = log.timestampAD.split('T')[0];
    if (startDateAD && logDate < startDateAD) return false;
    if (endDateAD && logDate > endDateAD) return false;

    if (searchQuery.trim()) {
      const q = (searchQuery || '').toLowerCase().trim();
      const matchName = (log?.productName || '').toLowerCase().includes(q);
      const matchSku = (log?.productSku || '').toLowerCase().includes(q);
      const matchedProd = products.find((p) => p.id === log.productId || p.sku === log.productSku);
      const matchBarcode = matchedProd?.barcode ? (matchedProd?.barcode || '').toLowerCase().includes(q) : false;
      const matchTx = (log?.transactionNumber || '').toLowerCase().includes(q);
      const matchType = (log?.changeType || '').toLowerCase().includes(q);
      if (!matchName && !matchSku && !matchBarcode && !matchTx && !matchType) return false;
    }

    return true;
  });

  // Calculate product-level ledger metrics (Opening, Received, Delivered, Damaged, Closing)
  const productLedgerMatrix = products.map((prod) => {
    let currentOnHand = 0;
    let currentBranchDamagedQty = 0;
    const branchScope = activeBranchId === 'ALL' ? branches : branches.filter((b) => b.id === activeBranchId);

    branchScope.forEach((b) => {
      const st = stock.find((s) => s.productId === prod.id && s.branchId === b.id);
      if (st) {
        currentOnHand += st.quantityOnHand;
        currentBranchDamagedQty += st.damagedQty || 0;
      }
    });

    // Get logs for this product in current branch scope
    const prodLogs = transactionLogs.filter((l) => {
      if (l.productId !== prod.id) return false;
      if (activeBranchId !== 'ALL' && l.branchId !== activeBranchId) return false;
      return true;
    });

    // Split logs: Before startDateAD (to find opening balance) vs Within Period
    let receivedQty = 0;
    let deliveredQty = 0;
    let damagedQty = 0;
    let totalAfterPeriodQtyChanges = 0;

    prodLogs.forEach((l) => {
      const logDate = l.timestampAD.split('T')[0];

      if (startDateAD && logDate < startDateAD) {
        // Log is BEFORE start date
      } else if (endDateAD && logDate > endDateAD) {
        // Log occurred AFTER period end
        totalAfterPeriodQtyChanges += l.quantityChanged;
      } else {
        // Log is WITHIN period
        if (l.changeType === 'INBOUND_PO' || l.changeType === 'PURCHASE_INVOICE' || (l.changeType === 'SHIPMENT_TRANSFER' && l.quantityChanged > 0)) {
          receivedQty += Math.abs(l.quantityChanged);
        } else if (l.changeType === 'DAMAGE') {
          damagedQty += Math.abs(l.quantityChanged);
        } else if (
          l.changeType === 'PULLOUT' ||
          l.changeType === 'STOCK_OUT' ||
          l.changeType === 'CONSUMABLE_ISSUE' ||
          (l.changeType === 'SHIPMENT_TRANSFER' && l.quantityChanged < 0)
        ) {
          deliveredQty += Math.abs(l.quantityChanged);
        } else if (l.changeType === 'MANUAL_ADJUSTMENT') {
          if (l.quantityChanged > 0) receivedQty += l.quantityChanged;
          else deliveredQty += Math.abs(l.quantityChanged);
        }
      }
    });

    // Fallback: If no explicit damage logs recorded in period, but current stock holds recorded damagedQty, use currentBranchDamagedQty so damage is populated
    if (damagedQty === 0 && currentBranchDamagedQty > 0) {
      damagedQty = currentBranchDamagedQty;
    }

    // Opening Qty = CurrentOnHand - (net movement in period) - (net movement after period)
    const netPeriodMovement = receivedQty - deliveredQty - damagedQty;
    const openingQty = currentOnHand - totalAfterPeriodQtyChanges - netPeriodMovement;
    const closingQty = openingQty + netPeriodMovement;

    // Financial Values
    const unitCost = prod.costPrice;
    const openingValue = openingQty * unitCost;
    const receivedValue = receivedQty * unitCost;
    const deliveredValue = deliveredQty * unitCost;
    const damagedValue = damagedQty * unitCost;
    const closingValue = closingQty * unitCost;

    return {
      prod,
      unitCost,
      openingQty,
      openingValue,
      receivedQty,
      receivedValue,
      deliveredQty,
      deliveredValue,
      damagedQty,
      damagedValue,
      closingQty,
      closingValue,
    };
  });

  // Filter Product Ledger Matrix by Category and Search
  const filteredProductLedger = productLedgerMatrix.filter(({ prod }) => {
    if (selectedCategory !== 'ALL' && prod.category !== selectedCategory) return false;
    if (searchQuery.trim()) {
      const q = (searchQuery || '').toLowerCase().trim();
      const matchName = (prod?.name || '').toLowerCase().includes(q);
      const matchSku = (prod?.sku || '').toLowerCase().includes(q);
      const matchBarcode = prod.barcode ? (prod?.barcode || '').toLowerCase().includes(q) : false;
      if (!matchName && !matchSku && !matchBarcode) return false;
    }
    return true;
  });

  // Quantity Totals for Summary Matrix
  const totalOpeningQty = filteredProductLedger.reduce((sum, p) => sum + p.openingQty, 0);
  const totalReceivedQty = filteredProductLedger.reduce((sum, p) => sum + p.receivedQty, 0);
  const totalDeliveredQty = filteredProductLedger.reduce((sum, p) => sum + p.deliveredQty, 0);
  const totalDamagedQty = filteredProductLedger.reduce((sum, p) => sum + p.damagedQty, 0);
  const totalClosingQty = filteredProductLedger.reduce((sum, p) => sum + p.closingQty, 0);

  // KPI & Financial Summary Card Totals
  const totalOpeningVal = filteredProductLedger.reduce((sum, p) => sum + p.openingValue, 0);
  const totalReceivedVal = filteredProductLedger.reduce((sum, p) => sum + p.receivedValue, 0);
  const totalDeliveredVal = filteredProductLedger.reduce((sum, p) => sum + p.deliveredValue, 0);
  const totalDamagedVal = filteredProductLedger.reduce((sum, p) => sum + p.damagedValue, 0);
  const totalClosingVal = filteredProductLedger.reduce((sum, p) => sum + p.closingValue, 0);

  // Totals for Detailed Transaction Logs
  const totalLogQtyChanged = filteredLogs.reduce((sum, l) => sum + l.quantityChanged, 0);
  const totalLogVal = filteredLogs.reduce((sum, l) => sum + (Math.abs(l.quantityChanged) * l.unitCost), 0);

  // Export Product Ledger CSV with Total Summary Row
  const exportLedgerCSV = () => {
    const rows = filteredProductLedger.map((r) => ({
      sku: r.prod.sku,
      name: r.prod.name,
      category: r.prod.category,
      unitCost: r.unitCost,
      openingQty: r.openingQty,
      openingValue: r.openingValue,
      receivedQty: r.receivedQty,
      receivedValue: r.receivedValue,
      deliveredQty: r.deliveredQty,
      deliveredValue: r.deliveredValue,
      damagedQty: r.damagedQty,
      damagedValue: r.damagedValue,
      closingQty: r.closingQty,
      closingValue: r.closingValue,
    }));

    // Append Summary Total Row
    rows.push({
      sku: 'TOTAL_SUMMARY',
      name: `Grand Total (${filteredProductLedger.length} SKUs)`,
      category: 'ALL',
      unitCost: 0,
      openingQty: totalOpeningQty,
      openingValue: totalOpeningVal,
      receivedQty: totalReceivedQty,
      receivedValue: totalReceivedVal,
      deliveredQty: totalDeliveredQty,
      deliveredValue: totalDeliveredVal,
      damagedQty: totalDamagedQty,
      damagedValue: totalDamagedVal,
      closingQty: totalClosingQty,
      closingValue: totalClosingVal,
    });

    const columns = [
      { key: 'sku', label: 'SKU Code' },
      { key: 'name', label: 'Product Name' },
      { key: 'category', label: 'Category' },
      { key: 'unitCost', label: 'Unit Cost Price (NPR)' },
      { key: 'openingQty', label: 'Opening Qty' },
      { key: 'openingValue', label: 'Opening Cost Value (NPR)' },
      { key: 'receivedQty', label: 'Received Qty' },
      { key: 'receivedValue', label: 'Received Value (NPR)' },
      { key: 'deliveredQty', label: 'Delivered Qty' },
      { key: 'deliveredValue', label: 'Delivered Value (NPR)' },
      { key: 'damagedQty', label: 'Damaged Qty' },
      { key: 'damagedValue', label: 'Damaged Loss Value (NPR)' },
      { key: 'closingQty', label: 'Closing Qty' },
      { key: 'closingValue', label: 'Closing Cost Value (NPR)' },
    ];
    exportToCSV({
      filename: 'Stock_Movement_Ledger_Report',
      reportTitle: 'Stock Movement Ledger Summary Matrix',
      branchName: selectedBranchId && selectedBranchId !== 'ALL' ? branches.find((b) => b.id === selectedBranchId)?.name || `Branch ${selectedBranchId}` : 'All Branches (Consolidated)',
      data: rows,
      columns,
    });
  };

  // Export Transaction Logs CSV
  const exportLogsCSV = () => {
    const columns = [
      { key: 'transactionNumber', label: 'Transaction #' },
      { key: 'timestampAD', label: 'Timestamp (AD)' },
      {
        key: 'timestampBS',
        label: 'Timestamp (BS)',
        formatter: (_: any, r: any) => formatBSDate(r.timestampAD || r.timestampBS),
      },
      { key: 'productSku', label: 'SKU' },
      { key: 'productName', label: 'Product Name' },
      {
        key: 'branchId',
        label: 'Branch Location',
        formatter: (val: string) => branches.find((b) => b.id === val)?.name || val,
      },
      { key: 'changeType', label: 'Movement Event Type' },
      { key: 'quantityBefore', label: 'Qty Before' },
      { key: 'quantityChanged', label: 'Qty Changed (+/-)' },
      { key: 'quantityAfter', label: 'Qty After' },
      { key: 'unitCost', label: 'Unit Cost (NPR)' },
      {
        key: 'totalValue',
        label: 'Total Movement Value (NPR)',
        formatter: (_: any, r: any) => String(Math.abs(r.quantityChanged) * r.unitCost),
      },
      { key: 'referenceDocId', label: 'Ref Document ID' },
    ];
    exportToCSV({
      filename: 'Stock_Movement_Logs_Detail',
      reportTitle: 'Stock Movement Event & Transaction Logs Report',
      branchName: selectedBranchId && selectedBranchId !== 'ALL' ? branches.find((b) => b.id === selectedBranchId)?.name || `Branch ${selectedBranchId}` : 'All Branches (Consolidated)',
      data: filteredLogs,
      columns,
    });
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 ${
            isDarkMode ? 'text-white' : 'text-slate-900'
          }`}>
            <BookOpen className="h-5 w-5 text-indigo-500" />
            <span>Stock Movement Ledger</span>
          </h2>
          <p className={`text-[11px] mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Track opening stock balances, inbound receipts, dispatches, damaged stock, and closing valuations.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {viewTab === 'SUMMARY_MATRIX' ? (
            <button
              onClick={exportLedgerCSV}
              className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-500 shadow-xs transition-all cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export Ledger Summary</span>
            </button>
          ) : (
            <button
              onClick={exportLogsCSV}
              className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-500 shadow-xs transition-all cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export Detailed Logs</span>
            </button>
          )}
        </div>
      </div>

      {/* KPI Cards Banner - Compact horizontal bar */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
        {/* Opening Value */}
        <div className={`p-2.5 rounded-xl border ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Opening Value</div>
          <div className={`text-base font-bold font-mono mt-0.5 ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>
            रु {(totalOpeningVal ?? 0).toLocaleString('en-IN')}
          </div>
          <div className="text-[10px] text-slate-400 font-mono">{totalOpeningQty} Units</div>
        </div>

        {/* Received Value */}
        <div className={`p-2.5 rounded-xl border ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Inbound Received</div>
          <div className="text-base font-bold font-mono mt-0.5 text-emerald-500">
            +रु {(totalReceivedVal ?? 0).toLocaleString('en-IN')}
          </div>
          <div className="text-[10px] text-emerald-600/80 dark:text-emerald-400/80 font-mono">+{totalReceivedQty} Units</div>
        </div>

        {/* Delivered Value */}
        <div className={`p-2.5 rounded-xl border ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Outbound Delivered</div>
          <div className="text-base font-bold font-mono mt-0.5 text-sky-500">
            -रु {(totalDeliveredVal ?? 0).toLocaleString('en-IN')}
          </div>
          <div className="text-[10px] text-sky-600/80 dark:text-sky-400/80 font-mono">-{totalDeliveredQty} Units</div>
        </div>

        {/* Damaged Value */}
        <div className={`p-2.5 rounded-xl border ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Damaged Loss</div>
          <div className="text-base font-bold font-mono mt-0.5 text-rose-500">
            -रु {(totalDamagedVal ?? 0).toLocaleString('en-IN')}
          </div>
          <div className="text-[10px] text-rose-600/80 dark:text-rose-400/80 font-mono">-{totalDamagedQty} Units</div>
        </div>

        {/* Closing Value */}
        <div className={`p-2.5 rounded-xl border col-span-2 sm:col-span-1 ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Closing Value</div>
          <div className={`text-base font-bold font-mono mt-0.5 ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`}>
            रु {(totalClosingVal ?? 0).toLocaleString('en-IN')}
          </div>
          <div className="text-[10px] text-indigo-500 font-mono">{totalClosingQty} Units</div>
        </div>
      </div>

      {/* Date Filter & Control Bar - Compact layout */}
      <div className={`p-2.5 rounded-xl border space-y-2 ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
      }`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5 text-indigo-500" />
            <span className={`text-[11px] font-bold uppercase tracking-wider ${
              isDarkMode ? 'text-slate-300' : 'text-slate-700'
            }`}>
              Ledger Filters
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-[11px]">
            <button onClick={() => applyPreset('THIS_MONTH')} className="text-indigo-500 font-semibold hover:underline cursor-pointer">
              This Month
            </button>
            <span className="text-slate-400">•</span>
            <button onClick={() => applyPreset('LAST_30_DAYS')} className="text-indigo-500 font-semibold hover:underline cursor-pointer">
              Last 30 Days
            </button>
            <span className="text-slate-400">•</span>
            <button onClick={() => applyPreset('THIS_YEAR')} className="text-indigo-500 font-semibold hover:underline cursor-pointer">
              This Year
            </button>
            <span className="text-slate-400">•</span>
            <button onClick={() => applyPreset('ALL_TIME')} className="text-rose-500 font-semibold hover:underline cursor-pointer">
              All Time
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {/* Start Date */}
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-0.5">From Date (AD)</label>
            <input
              type="date"
              value={startDateAD}
              onChange={(e) => setStartDateAD(e.target.value)}
              className={`w-full rounded-lg border px-2 py-1 text-xs font-mono ${
                isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'
              }`}
            />
          </div>

          {/* End Date */}
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-0.5">To Date (AD)</label>
            <input
              type="date"
              value={endDateAD}
              onChange={(e) => setEndDateAD(e.target.value)}
              className={`w-full rounded-lg border px-2 py-1 text-xs font-mono ${
                isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'
              }`}
            />
          </div>

          {/* Branch Filter */}
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-0.5">Branch Location</label>
            <select
              value={activeBranchId}
              onChange={(e) => setActiveBranchId(e.target.value)}
              className={`w-full rounded-lg border px-2 py-1 text-xs font-medium ${
                isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'
              }`}
            >
              <option value="ALL">All Branch Locations</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </select>
          </div>

          {/* Category Filter */}
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-0.5">Category</label>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className={`w-full rounded-lg border px-2 py-1 text-xs font-medium ${
                isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'
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
        </div>

        {/* Search Bar & Subview Switcher */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-0.5">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by Product Name, SKU or Barcode..."
              className={`w-full rounded-lg border pl-8 pr-3 py-1 text-xs font-medium ${
                isDarkMode
                  ? 'bg-slate-900 border-slate-800 text-white placeholder-slate-500'
                  : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400'
              }`}
            />
          </div>

          <div className={`p-0.5 rounded-lg border flex items-center gap-1 ${
            isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-100 border-slate-200'
          }`}>
            <button
              onClick={() => setViewTab('SUMMARY_MATRIX')}
              className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-all cursor-pointer ${
                viewTab === 'SUMMARY_MATRIX'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : isDarkMode ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Summary Matrix
            </button>
            <button
              onClick={() => setViewTab('TRANSACTION_LOGS')}
              className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-all cursor-pointer ${
                viewTab === 'TRANSACTION_LOGS'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : isDarkMode ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Event Logs ({filteredLogs.length})
            </button>
          </div>
        </div>
      </div>

      {/* VIEW 1: Summary Matrix Table - Maximize height */}
      {viewTab === 'SUMMARY_MATRIX' && (
        <div className={`rounded-xl border shadow-md overflow-hidden ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="overflow-x-auto max-h-[calc(100vh-16rem)] overflow-y-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`sticky top-0 z-20 font-bold uppercase text-[10px] tracking-wider border-b ${
                isDarkMode ? 'bg-slate-900 text-slate-400 border-slate-800' : 'bg-slate-100 text-slate-700 border-slate-200'
              }`}>
                <tr>
                  <th className="p-2.5 sticky left-0 z-30 bg-inherit border-r min-w-[180px]">Product SKU & Name</th>
                  <th className="p-2.5 text-center">Unit Cost</th>
                  <th className="p-2.5 text-center border-l bg-slate-500/5">Opening Qty</th>
                  <th className="p-2.5 text-right border-r bg-slate-500/5">Opening Value</th>
                  <th className="p-2.5 text-center bg-emerald-500/5 text-emerald-600 dark:text-emerald-400">Received Qty</th>
                  <th className="p-2.5 text-right border-r bg-emerald-500/5 text-emerald-600 dark:text-emerald-400">Received Value</th>
                  <th className="p-2.5 text-center bg-sky-500/5 text-sky-600 dark:text-sky-400">Delivered Qty</th>
                  <th className="p-2.5 text-right border-r bg-sky-500/5 text-sky-600 dark:text-sky-400">Delivered Value</th>
                  <th className="p-2.5 text-center bg-rose-500/5 text-rose-500">Damaged Qty</th>
                  <th className="p-2.5 text-center border-l border-r bg-indigo-500/10 text-indigo-500">Closing Qty</th>
                  <th className="p-2.5 text-right bg-indigo-500/10 text-indigo-500">Closing Value</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-slate-200'}`}>
                {filteredProductLedger.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="p-8 text-center text-slate-500">
                      No stock items found in movement ledger.
                    </td>
                  </tr>
                ) : (
                  filteredProductLedger.map(({ prod, unitCost, openingQty, openingValue, receivedQty, receivedValue, deliveredQty, deliveredValue, damagedQty, damagedValue, closingQty, closingValue }) => (
                    <tr key={prod.id} className={isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'}>
                      <td className={`p-2.5 sticky left-0 z-10 border-r font-medium ${
                        isDarkMode ? 'bg-[#0f1218]' : 'bg-white'
                      }`}>
                        <div className={`font-bold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>{prod.name}</div>
                        <div className="text-[10px] text-indigo-500 font-mono">SKU: {prod.sku} • {prod.category}</div>
                      </td>

                      <td className="p-2.5 text-center font-mono text-slate-500">
                        रु {(unitCost ?? 0).toLocaleString('en-IN')}
                      </td>

                      {/* Opening */}
                      <td className="p-2.5 text-center font-mono font-bold border-l bg-slate-500/5">
                        {openingQty} {prod.unit}
                      </td>
                      <td className="p-2.5 text-right font-mono border-r bg-slate-500/5 text-slate-500">
                        रु {(openingValue ?? 0).toLocaleString('en-IN')}
                      </td>

                      {/* Received */}
                      <td className="p-2.5 text-center font-mono font-bold bg-emerald-500/5 text-emerald-500">
                        +{receivedQty}
                      </td>
                      <td className="p-2.5 text-right font-mono border-r bg-emerald-500/5 text-emerald-500 font-semibold">
                        +रु {(receivedValue ?? 0).toLocaleString('en-IN')}
                      </td>

                      {/* Delivered */}
                      <td className="p-2.5 text-center font-mono font-bold bg-sky-500/5 text-sky-500">
                        -{deliveredQty}
                      </td>
                      <td className="p-2.5 text-right font-mono border-r bg-sky-500/5 text-sky-500 font-semibold">
                        -रु {(deliveredValue ?? 0).toLocaleString('en-IN')}
                      </td>

                      {/* Damaged */}
                      <td className="p-2.5 text-center font-mono font-bold bg-rose-500/5 text-rose-500">
                        {damagedQty > 0 ? `-${damagedQty}` : '0'}
                      </td>

                      {/* Closing */}
                      <td className="p-2.5 text-center font-mono font-bold border-l border-r bg-indigo-500/10 text-indigo-500 text-xs">
                        {closingQty} {prod.unit}
                      </td>
                      <td className={`p-2.5 text-right font-mono font-bold bg-indigo-500/10 ${
                        isDarkMode ? 'text-indigo-400' : 'text-indigo-600'
                      }`}>
                        रु {(closingValue ?? 0).toLocaleString('en-IN')}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {/* Grand Total Footer Row */}
              <tfoot className={`sticky bottom-0 z-20 font-bold uppercase text-[10px] tracking-wider border-t ${
                isDarkMode ? 'bg-slate-900 text-slate-200 border-slate-800' : 'bg-slate-100 text-slate-800 border-slate-200'
              }`}>
                <tr>
                  <td className={`p-2.5 sticky left-0 z-30 border-r font-bold ${
                    isDarkMode ? 'bg-slate-900' : 'bg-slate-100'
                  }`}>
                    Grand Total ({filteredProductLedger.length} SKUs)
                  </td>
                  <td className="p-2.5 text-center font-mono text-slate-400">-</td>
                  <td className="p-2.5 text-center font-mono font-bold border-l bg-slate-500/10">
                    {totalOpeningQty}
                  </td>
                  <td className="p-2.5 text-right font-mono border-r bg-slate-500/10">
                    रु {(totalOpeningVal ?? 0).toLocaleString('en-IN')}
                  </td>
                  <td className="p-2.5 text-center font-mono font-bold bg-emerald-500/10 text-emerald-500">
                    +{totalReceivedQty}
                  </td>
                  <td className="p-2.5 text-right font-mono border-r bg-emerald-500/10 text-emerald-500">
                    +रु {(totalReceivedVal ?? 0).toLocaleString('en-IN')}
                  </td>
                  <td className="p-2.5 text-center font-mono font-bold bg-sky-500/10 text-sky-500">
                    -{totalDeliveredQty}
                  </td>
                  <td className="p-2.5 text-right font-mono border-r bg-sky-500/10 text-sky-500">
                    -रु {(totalDeliveredVal ?? 0).toLocaleString('en-IN')}
                  </td>
                  <td className="p-2.5 text-center font-mono font-bold bg-rose-500/10 text-rose-500">
                    -{totalDamagedQty}
                  </td>
                  <td className="p-2.5 text-center font-mono font-bold border-l border-r bg-indigo-500/20 text-indigo-500">
                    {totalClosingQty}
                  </td>
                  <td className="p-2.5 text-right font-mono font-extrabold bg-indigo-500/20 text-indigo-500">
                    रु {(totalClosingVal ?? 0).toLocaleString('en-IN')}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* VIEW 2: Detailed Transaction Logs Table - Maximize height */}
      {viewTab === 'TRANSACTION_LOGS' && (
        <div className={`rounded-xl border shadow-md overflow-hidden ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="overflow-x-auto max-h-[calc(100vh-16rem)] overflow-y-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`sticky top-0 z-20 font-bold uppercase text-[10px] tracking-wider border-b ${
                isDarkMode ? 'bg-slate-900 text-slate-400 border-slate-800' : 'bg-slate-100 text-slate-700 border-slate-200'
              }`}>
                <tr>
                  <th className="p-2.5">Tx Reference</th>
                  <th className="p-2.5">Timestamp</th>
                  <th className="p-2.5">Product Name & SKU</th>
                  <th className="p-2.5">Branch Location</th>
                  <th className="p-2.5 text-center">Event Type</th>
                  <th className="p-2.5 text-center">Qty Before</th>
                  <th className="p-2.5 text-center">Qty Change</th>
                  <th className="p-2.5 text-center">Qty After</th>
                  <th className="p-2.5 text-right">Unit Cost</th>
                  <th className="p-2.5 text-right">Movement Value</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-slate-200'}`}>
                {filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="p-8 text-center text-slate-500">
                      No transaction movement logs match criteria.
                    </td>
                  </tr>
                ) : (
                  filteredLogs.map((log) => {
                    const branchName = branches.find((b) => b.id === log.branchId)?.name || log.branchId;
                    const formattedDate = formatDualDate(log.timestampAD.split('T')[0], dateMode);
                    const isPositive = log.quantityChanged > 0;
                    const movementVal = Math.abs(log.quantityChanged) * log.unitCost;

                    return (
                      <tr key={log.id} className={isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'}>
                        <td className="p-2.5 font-bold font-mono text-indigo-500">{log.transactionNumber}</td>
                        <td className="p-2.5 text-slate-500">{formattedDate}</td>
                        <td className="p-2.5">
                          <div className={`font-bold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>{log.productName}</div>
                          <div className="text-[10px] text-slate-400 font-mono">SKU: {log.productSku}</div>
                        </td>
                        <td className="p-2.5 text-slate-500">{branchName}</td>
                        <td className="p-2.5 text-center">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            log.changeType === 'INBOUND_PO'
                              ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                              : log.changeType === 'SHIPMENT_TRANSFER'
                              ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                              : log.changeType === 'DAMAGE'
                              ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
                              : log.changeType === 'CONSUMABLE_ISSUE'
                              ? 'bg-amber-600/10 text-amber-600 dark:text-amber-400 border border-amber-600/20'
                              : 'bg-sky-500/10 text-sky-500 border border-sky-500/20'
                          }`}>
                            {log.changeType}
                          </span>
                        </td>
                        <td className="p-2.5 text-center font-mono text-slate-400">{log.quantityBefore}</td>
                        <td className={`p-2.5 text-center font-mono font-bold ${
                          isPositive ? 'text-emerald-500' : 'text-rose-500'
                        }`}>
                          {isPositive ? `+${log.quantityChanged}` : log.quantityChanged}
                        </td>
                        <td className="p-2.5 text-center font-mono font-bold">{log.quantityAfter}</td>
                        <td className="p-2.5 text-right font-mono text-slate-500">रु {(log.unitCost ?? 0).toLocaleString('en-IN')}</td>
                        <td className={`p-2.5 text-right font-mono font-bold ${
                          isPositive ? 'text-emerald-500' : 'text-sky-500'
                        }`}>
                          रु {(movementVal ?? 0).toLocaleString('en-IN')}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
              {/* Grand Total Footer Row */}
              <tfoot className={`sticky bottom-0 z-20 font-bold uppercase text-[10px] tracking-wider border-t ${
                isDarkMode ? 'bg-slate-900 text-slate-200 border-slate-800' : 'bg-slate-100 text-slate-800 border-slate-200'
              }`}>
                <tr>
                  <td colSpan={5} className="p-2.5 text-right font-bold">
                    Total Movement Logs ({filteredLogs.length} Events):
                  </td>
                  <td className="p-2.5 text-center font-mono text-slate-400">-</td>
                  <td className={`p-2.5 text-center font-mono font-bold ${totalLogQtyChanged >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {totalLogQtyChanged > 0 ? `+${totalLogQtyChanged}` : totalLogQtyChanged}
                  </td>
                  <td className="p-2.5 text-center font-mono text-slate-400">-</td>
                  <td className="p-2.5 text-center font-mono text-slate-400">-</td>
                  <td className="p-2.5 text-right font-mono font-extrabold text-indigo-500">
                    रु {(totalLogVal ?? 0).toLocaleString('en-IN')}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
