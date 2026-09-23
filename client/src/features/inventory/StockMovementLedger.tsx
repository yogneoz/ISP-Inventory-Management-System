import React, { useEffect, useState } from 'react';
import { TransactionLog, Product, Branch, InventoryStock, StockOperation, Shipment, PurchaseOrder, DamageRecord } from '../../types';
import { exportToCSV } from '../../utils/exportUtils';
import { formatNPR } from '../../utils/nprFormat';
import { formatDualDate, formatBSDate } from '../../utils/nepaliCalendar';
import { DateField } from '../../components/DateField';
import {
  BookOpen,
  Filter,
  Download,
  Search
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';

interface StockMovementLedgerProps {
  transactionLogs: TransactionLog[];
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  damageRecords?: DamageRecord[];
  stockOperations?: StockOperation[];
  shipments?: Shipment[];
  purchaseOrders?: PurchaseOrder[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
}

export const StockMovementLedger: React.FC<StockMovementLedgerProps> = ({
  transactionLogs,
  products,
  branches,
  stock,
  damageRecords = [],
  stockOperations = [],
  shipments = [],
  purchaseOrders = [],
  selectedBranchId,
  dateMode,
}) => {
  const [activeBranchId, setActiveBranchId] = useState<string>(selectedBranchId);
  const [startDateAD, setStartDateAD] = useState<string>('');
  const [endDateAD, setEndDateAD] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [viewTab, setViewTab] = useState<'SUMMARY_MATRIX' | 'TRANSACTION_LOGS'>('SUMMARY_MATRIX');

  // Keep the ledger branch filter aligned with the global branch context.
  useEffect(() => {
    setActiveBranchId(selectedBranchId);
  }, [selectedBranchId]);

  const categories = Array.from(new Set(products.map((p) => p.category)));

  // Older stock-operation records may predate transaction-log creation. Add
  // them as ledger movements unless a persisted transaction already exists
  // for the operation, so historical cards and current live events reconcile.
  const operationLedgerLogs: TransactionLog[] = stockOperations.flatMap((operation) => {
    if (!['DAMAGE', 'PULLOUT', 'STOCK_OUT', 'CONSUMABLE_ISSUE', 'DISPOSAL', 'MANUAL_ADJUSTMENT'].includes(operation.type)) return [];
    const items = operation.items?.length
      ? operation.items
      : operation.productId
      ? [{
          productId: operation.productId,
          productName: operation.productName || '',
          sku: '',
          quantity: Math.abs(Number(operation.quantityChanged) || 0),
          unitCost: Number(operation.costPerUnit) || 0,
          totalValue: operation.totalValue,
        }]
      : [];
    return items
      .filter((item) => !(operation.type === 'PULLOUT' && (item as { condition?: string }).condition === 'DAMAGED_STOCK'))
      .map((item, index) => {
        const product = products.find((candidate) => candidate.id === item.productId);
        const quantity = Number(item.quantity) || 0;
        const isOutbound = operation.type === 'DAMAGE' || operation.type === 'DISPOSAL'
          || (operation.type === 'MANUAL_ADJUSTMENT' && (Number(item.quantity) || 0) < 0);
        const changeType = operation.type === 'MANUAL_ADJUSTMENT'
          ? 'MANUAL_ADJUSTMENT' as TransactionLog['changeType']
          : (operation.type as TransactionLog['changeType']);
        return {
          id: `operation-ledger-${operation.id}-${item.productId}-${index}`,
          transactionNumber: `${operation.referenceNumber}-${index + 1}`,
          productId: item.productId,
          productSku: product?.sku || item.sku || '',
          productName: product?.name || item.productName || 'Product',
          branchId: operation.branchId,
          changeType,
          quantityBefore: 0,
          quantityChanged: isOutbound ? -quantity : quantity,
          quantityAfter: 0,
          unitCost: Number(item.unitCost) || Number(operation.costPerUnit) || product?.costPrice || 0,
          referenceDocId: operation.referenceNumber,
          timestampAD: operation.dateAD,
          timestampBS: operation.dateBS,
        };
      });
  }).filter((operationLog) => !transactionLogs.some((log) => log.referenceDocId === operationLog.referenceDocId));

  // Damage lifecycle ledger: damage_records that were NOT created through a
  // stock operation (e.g. physical audit tagging, demo data, or manual stock
  // PATCH with changeType=DAMAGE) are reconciled as DAMAGE movements, so the
  // ledger always reflects damaged stock even when a matching transaction log
  // was never persisted.
  const damageRecordLedgerLogs: TransactionLog[] = damageRecords.flatMap((damageRec) => {
    const product = products.find((candidate) => candidate.id === damageRec.productId);
    const quantity = Number(damageRec.quantityDamaged) || 0;
    if (quantity <= 0) return [];
    // Skip when a stock operation or transaction log already covers this
    // damage record (avoids double counting).
    const alreadyCovered =
      stockOperations.some((op) =>
        op.type === 'DAMAGE' &&
        op.branchId === damageRec.branchId &&
        op.items?.some((item) =>
          item.productId === damageRec.productId &&
          Math.abs(Number(item.quantity) || 0) >= quantity &&
          (op.dateAD ? String(op.dateAD).slice(0, 10) === damageRec.damageDateAD : true)
        )
      ) ||
      transactionLogs.some((log) =>
        log.changeType === 'DAMAGE' &&
        log.productId === damageRec.productId &&
        log.branchId === damageRec.branchId &&
        String(log.timestampAD || '').slice(0, 10) === damageRec.damageDateAD &&
        Math.abs(Number(log.quantityChanged) || 0) >= quantity
      );
    if (alreadyCovered) return [];

    return [{
      id: `damage-record-ledger-${damageRec.id}`,
      transactionNumber: `DAMAGE-${damageRec.damageReference}`,
      productId: damageRec.productId,
      productSku: product?.sku || '',
      productName: product?.name || (damageRec as any).productName || 'Product',
      branchId: damageRec.branchId,
      changeType: 'DAMAGE' as TransactionLog['changeType'],
      quantityBefore: 0,
      quantityChanged: -quantity,
      quantityAfter: 0,
      unitCost: Number(damageRec.unitCost) || product?.costPrice || 0,
      referenceDocId: damageRec.damageReference || damageRec.id,
      timestampAD: damageRec.damageDateAD,
      timestampBS: damageRec.damageDateBS || '',
    }];
  });

  const effectiveTransactionLogs = [...transactionLogs, ...operationLedgerLogs, ...damageRecordLedgerLogs];

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
  const filteredLogs = effectiveTransactionLogs.filter((log) => {
    if (activeBranchId !== 'ALL' && log.branchId !== activeBranchId) return false;

    // Extract date YYYY-MM-DD
    const logDate = String(log.timestampAD || '').split('T')[0];
    if (startDateAD && logDate < startDateAD) return false;
    if (endDateAD && logDate > endDateAD) return false;

    if (searchQuery.trim()) {
      const q = (searchQuery || '').toLowerCase().trim();
      const matchName = (log?.productName || '').toLowerCase().includes(q);
      const matchSku = (log?.productSku || '').toLowerCase().includes(q);
      const matchedProd = products.find((p) => p.id === log.productId || p.sku === log.productSku);
      if (selectedCategory !== 'ALL' && matchedProd?.category !== selectedCategory) return false;
      const matchBarcode = matchedProd?.barcode ? (matchedProd?.barcode || '').toLowerCase().includes(q) : false;
      const matchTx = (log?.transactionNumber || '').toLowerCase().includes(q);
      const matchType = (log?.changeType || '').toLowerCase().includes(q);
      if (!matchName && !matchSku && !matchBarcode && !matchTx && !matchType) return false;
    } else if (selectedCategory !== 'ALL') {
      const matchedProd = products.find((p) => p.id === log.productId || p.sku === log.productSku);
      if (matchedProd?.category !== selectedCategory) return false;
    }

    return true;
  });

  // Calculate product-level ledger metrics (Opening, Received, Delivered, Damaged, Closing)
  const productLedgerMatrix = products.map((prod) => {
    let currentOnHand = 0;
    const branchScope = activeBranchId === 'ALL' ? branches : branches.filter((b) => b.id === activeBranchId);

    branchScope.forEach((b) => {
      const st = stock.find((s) => s.productId === prod.id && s.branchId === b.id);
      if (st) {
        currentOnHand += st.quantityOnHand;
      }
    });

    // Get logs for this product in current branch scope
    const prodLogs = effectiveTransactionLogs.filter((l) => {
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
      const logDate = String(l.timestampAD || '').split('T')[0];

      if (startDateAD && logDate < startDateAD) {
        // Log is BEFORE start date
      } else if (endDateAD && logDate > endDateAD) {
        // Log occurred AFTER period end
        totalAfterPeriodQtyChanges += l.quantityChanged;
      } else {
        // Log is WITHIN period
        if (l.changeType === 'INBOUND_PO' || l.changeType === 'PURCHASE_INVOICE' || l.changeType === 'DAMAGE_REVERSED' || (l.changeType === 'SHIPMENT_TRANSFER' && l.quantityChanged > 0)) {
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

  const productLedgerPagination = useClientPagination(filteredProductLedger, 20, [
    activeBranchId,
    selectedCategory,
    searchQuery,
  ]);
  const transactionLogsPagination = useClientPagination(filteredLogs, 25, [
    activeBranchId,
    startDateAD,
    endDateAD,
    selectedCategory,
    searchQuery,
  ]);

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
      branchName: activeBranchId && activeBranchId !== 'ALL' ? branches.find((b) => b.id === activeBranchId)?.name || `Branch ${activeBranchId}` : 'All Branches (Consolidated)',
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
      branchName: activeBranchId && activeBranchId !== 'ALL' ? branches.find((b) => b.id === activeBranchId)?.name || `Branch ${activeBranchId}` : 'All Branches (Consolidated)',
      data: filteredLogs,
      columns,
    });
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white`}>
            <BookOpen className="h-5 w-5 text-indigo-500" />
            <span>Stock Movement Ledger</span>
          </h2>
          <p className={`truncate text-[11px] mt-0.5 text-slate-500 dark:text-slate-400`}>
            Track opening stock balances, inbound receipts, dispatches, damaged stock, and closing valuations.
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2">
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
        <div className={`p-2.5 rounded-xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Opening Value</div>
          <div className={`text-base font-bold font-mono mt-0.5 text-slate-800 dark:text-slate-200`}>
            {formatNPR(totalOpeningVal ?? 0)}
          </div>
          <div className="text-[10px] text-slate-400 font-mono">{totalOpeningQty} Units</div>
        </div>

        {/* Received Value */}
        <div className={`p-2.5 rounded-xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Inbound Received</div>
          <div className={`text-base font-bold font-mono mt-0.5 text-emerald-500 dark:text-emerald-400`}>
            +{formatNPR(totalReceivedVal ?? 0)}
          </div>
          <div className={`text-[10px] font-mono text-emerald-600/80 dark:text-emerald-400/80`}>+{totalReceivedQty} Units</div>
        </div>

        {/* Delivered Value */}
        <div className={`p-2.5 rounded-xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Outbound Delivered</div>
          <div className={`text-base font-bold font-mono mt-0.5 text-sky-500 dark:text-sky-400`}>
            -{formatNPR(totalDeliveredVal ?? 0)}
          </div>
          <div className={`text-[10px] font-mono text-sky-600/80 dark:text-sky-400/80`}>-{totalDeliveredQty} Units</div>
        </div>

        {/* Damaged Value */}
        <div className={`p-2.5 rounded-xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Damaged Loss</div>
          <div className={`text-base font-bold font-mono mt-0.5 text-rose-500 dark:text-rose-400`}>
            -{formatNPR(totalDamagedVal ?? 0)}
          </div>
          <div className={`text-[10px] font-mono text-rose-600/80 dark:text-rose-400/80`}>-{totalDamagedQty} Units</div>
        </div>

        {/* Closing Value */}
        <div className={`p-2.5 rounded-xl border col-span-2 sm:col-span-1 bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Closing Value</div>
          <div className={`text-base font-bold font-mono mt-0.5 text-indigo-600 dark:text-indigo-400`}>
            {formatNPR(totalClosingVal ?? 0)}
          </div>
          <div className={`text-[10px] font-mono text-indigo-500 dark:text-indigo-400`}>{totalClosingQty} Units</div>
        </div>
      </div>

      {/* Date Filter & Control Bar - Compact layout */}
      <div className={`p-2.5 rounded-xl border space-y-2 bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5 text-indigo-500" />
            <span className={`text-[11px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300`}>
              Ledger Filters
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-[11px]">
            <button onClick={() => applyPreset('THIS_MONTH')} className={`font-semibold hover:underline cursor-pointer text-indigo-500 dark:text-indigo-400`}>
              This Month
            </button>
            <span className="text-slate-400">•</span>
            <button onClick={() => applyPreset('LAST_30_DAYS')} className={`font-semibold hover:underline cursor-pointer text-indigo-500 dark:text-indigo-400`}>
              Last 30 Days
            </button>
            <span className="text-slate-400">•</span>
            <button onClick={() => applyPreset('THIS_YEAR')} className={`font-semibold hover:underline cursor-pointer text-indigo-500 dark:text-indigo-400`}>
              This Year
            </button>
            <span className="text-slate-400">•</span>
            <button onClick={() => applyPreset('ALL_TIME')} className={`font-semibold hover:underline cursor-pointer text-rose-500 dark:text-rose-400`}>
              All Time
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {/* Start Date */}
          <div>
            <DateField
              label="From Date"
              mode={dateMode}
              value={startDateAD}
              onChange={setStartDateAD}
              compact
              showHint={false}
              max={endDateAD || undefined}
            />
          </div>

          {/* End Date */}
          <div>
            <DateField
              label="To Date"
              mode={dateMode}
              value={endDateAD}
              onChange={setEndDateAD}
              compact
              showHint={false}
              min={startDateAD || undefined}
            />
          </div>

          {/* Branch Filter */}
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-0.5">Branch Location</label>
            <select
              value={activeBranchId}
              onChange={(e) => setActiveBranchId(e.target.value)}
              className={`w-full rounded-lg border px-2 py-1 text-xs font-medium bg-slate-50 border-slate-200 text-slate-900 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
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
              className={`w-full rounded-lg border px-2 py-1 text-xs font-medium bg-slate-50 border-slate-200 text-slate-900 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
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
 <div className="relative w-full md:w-80 lg:w-96 shrink-0 ">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by Product Name, SKU or Barcode..."
              className={`w-full rounded-lg border pl-8 pr-3 py-1 text-xs font-medium bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 dark:bg-slate-900 dark:border-slate-800 dark:text-white dark:placeholder-slate-500`}
            />
          </div>

          <div className={`p-0.5 rounded-lg border flex items-center gap-1 bg-slate-100 border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
            <button
              onClick={() => setViewTab('SUMMARY_MATRIX')}
              className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-all cursor-pointer ${viewTab === 'SUMMARY_MATRIX' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}
            >
              Summary Matrix
            </button>
            <button
              onClick={() => setViewTab('TRANSACTION_LOGS')}
              className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-all cursor-pointer ${viewTab === 'TRANSACTION_LOGS' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}
            >
              Event Logs ({filteredLogs.length})
            </button>
          </div>
        </div>
      </div>

      {/* VIEW 1: Summary Matrix Table - Maximize height */}
      {viewTab === 'SUMMARY_MATRIX' && (
        <div className={`rounded-xl border shadow-md overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="overflow-x-auto max-h-[calc(100vh-16rem)] overflow-y-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}>
                <tr>
                  <th className="px-2.5 py-1.5 sticky left-0 z-30 bg-inherit border-r min-w-[180px]">Product SKU & Name</th>
                  <th className="px-2.5 py-1.5 text-center">Unit Cost</th>
                  <th className="px-2.5 py-1.5 text-center border-l bg-slate-500/5">Opening Qty</th>
                  <th className="px-2.5 py-1.5 text-right border-r bg-slate-500/5">Opening Value</th>
                  <th className={`px-2.5 py-1.5 text-center bg-emerald-500/5 text-emerald-600 dark:text-emerald-400`}>Received Qty</th>
                  <th className={`px-2.5 py-1.5 text-right border-r bg-emerald-500/5 text-emerald-600 dark:text-emerald-400`}>Received Value</th>
                  <th className={`px-2.5 py-1.5 text-center bg-sky-500/5 text-sky-600 dark:text-sky-400`}>Delivered Qty</th>
                  <th className={`px-2.5 py-1.5 text-right border-r bg-sky-500/5 text-sky-600 dark:text-sky-400`}>Delivered Value</th>
                  <th className={`px-2.5 py-1.5 text-center bg-rose-500/5 text-rose-500 dark:text-rose-400`}>Damaged Qty</th>
                  <th className={`px-2.5 py-1.5 text-center border-l border-r bg-indigo-500/10 text-indigo-500 dark:text-indigo-400`}>Closing Qty</th>
                  <th className={`px-2.5 py-1.5 text-right bg-indigo-500/10 text-indigo-500 dark:text-indigo-400`}>Closing Value (NPR)</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {filteredProductLedger.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="p-8 text-center text-slate-500">
                      No stock items found in movement ledger.
                    </td>
                  </tr>
                ) : (
                  productLedgerPagination.pagedItems.map(({ prod, unitCost, openingQty, openingValue, receivedQty, receivedValue, deliveredQty, deliveredValue, damagedQty, damagedValue, closingQty, closingValue }) => (
                    <tr key={prod.id} className="group transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40">
                      <td className={`p-2.5 sticky left-0 z-10 border-r font-medium bg-white dark:bg-[#0f1218] transition-colors group-hover:bg-slate-200 dark:group-hover:bg-slate-800/40`}>
                        <div className={`font-bold text-slate-900 dark:text-white`}>{prod.name}</div>
                        <div className={`text-[10px] font-mono text-indigo-500 dark:text-indigo-400`}>SKU: {prod.sku} • {prod.category}</div>
                      </td>

                      <td className="p-2.5 text-center font-mono text-slate-500">
                        {formatNPR(unitCost ?? 0)}
                      </td>

                      {/* Opening */}
                      <td className="p-2.5 text-center font-mono font-bold border-l bg-slate-500/5">
                        {openingQty} {prod.unit}
                      </td>
                      <td className="p-2.5 text-right font-mono border-r bg-slate-500/5 text-slate-500">
                        {formatNPR(openingValue ?? 0)}
                      </td>

                      {/* Received */}
                      <td className={`p-2.5 text-center font-mono font-bold bg-emerald-500/5 text-emerald-500 dark:text-emerald-400`}>
                        +{receivedQty}
                      </td>
                      <td className={`p-2.5 text-right font-mono border-r bg-emerald-500/5 font-semibold text-emerald-500 dark:text-emerald-400`}>
                        +{formatNPR(receivedValue ?? 0)}
                      </td>

                      {/* Delivered */}
                      <td className={`p-2.5 text-center font-mono font-bold bg-sky-500/5 text-sky-500 dark:text-sky-400`}>
                        -{deliveredQty}
                      </td>
                      <td className={`p-2.5 text-right font-mono border-r bg-sky-500/5 font-semibold text-sky-500 dark:text-sky-400`}>
                        -{formatNPR(deliveredValue ?? 0)}
                      </td>

                      {/* Damaged */}
                      <td className={`p-2.5 text-center font-mono font-bold bg-rose-500/5 text-rose-500 dark:text-rose-400`}>
                        {damagedQty > 0 ? `-${damagedQty}` : '0'}
                      </td>

                      {/* Closing */}
                      <td className={`p-2.5 text-center font-mono font-bold border-l border-r bg-indigo-500/10 text-xs text-indigo-500 dark:text-indigo-400`}>
                        {closingQty} {prod.unit}
                      </td>
                      <td className={`p-2.5 text-right font-mono font-bold bg-indigo-500/10 text-indigo-600 dark:text-indigo-400`}>
                        {formatNPR(closingValue ?? 0)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {/* Grand Total Footer Row */}
              <tfoot className={`sticky bottom-0 z-20 font-bold uppercase text-[10px] tracking-wider border-t bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:border-slate-800`}>
                <tr>
                  <td className={`p-2.5 sticky left-0 z-30 border-r font-bold bg-slate-100 dark:bg-slate-900`}>
                    Grand Total ({filteredProductLedger.length} SKUs)
                  </td>
                  <td className="p-2.5 text-center font-mono text-slate-400">-</td>
                  <td className="p-2.5 text-center font-mono font-bold border-l bg-slate-500/10">
                    {totalOpeningQty}
                  </td>
                  <td className="p-2.5 text-right font-mono border-r bg-slate-500/10">
                    {formatNPR(totalOpeningVal ?? 0)}
                  </td>
                  <td className={`p-2.5 text-center font-mono font-bold bg-emerald-500/10 text-emerald-500 dark:text-emerald-400`}>
                    +{totalReceivedQty}
                  </td>
                  <td className={`p-2.5 text-right font-mono border-r bg-emerald-500/10 text-emerald-500 dark:text-emerald-400`}>
                    +{formatNPR(totalReceivedVal ?? 0)}
                  </td>
                  <td className={`p-2.5 text-center font-mono font-bold bg-sky-500/10 text-sky-500 dark:text-sky-400`}>
                    -{totalDeliveredQty}
                  </td>
                  <td className={`p-2.5 text-right font-mono border-r bg-sky-500/10 text-sky-500 dark:text-sky-400`}>
                    -{formatNPR(totalDeliveredVal ?? 0)}
                  </td>
                  <td className={`p-2.5 text-center font-mono font-bold bg-rose-500/10 text-rose-500 dark:text-rose-400`}>
                    -{totalDamagedQty}
                  </td>
                  <td className={`p-2.5 text-center font-mono font-bold border-l border-r bg-indigo-500/20 text-indigo-500 dark:text-indigo-400`}>
                    {totalClosingQty}
                  </td>
                  <td className={`p-2.5 text-right font-mono font-extrabold bg-indigo-500/20 text-indigo-500 dark:text-indigo-400`}>
                    {formatNPR(totalClosingVal ?? 0)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <TablePagination
            page={productLedgerPagination.page}
            pageCount={productLedgerPagination.pageCount}
            totalItems={productLedgerPagination.totalItems}
            rangeStart={productLedgerPagination.rangeStart}
            rangeEnd={productLedgerPagination.rangeEnd}
            pageSize={productLedgerPagination.pageSize}
            onPageChange={productLedgerPagination.setPage}
            onPageSizeChange={productLedgerPagination.setPageSize}
            className="mt-1"
          />
        </div>
      )}

      {/* VIEW 2: Detailed Transaction Logs Table - Maximize height */}
      {viewTab === 'TRANSACTION_LOGS' && (
        <div className={`rounded-xl border shadow-md overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="overflow-x-auto max-h-[calc(100vh-16rem)] overflow-y-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}>
                <tr>
                  <th className="px-2.5 py-1.5">Tx Reference</th>
                  <th className="px-2.5 py-1.5">Timestamp</th>
                  <th className="px-2.5 py-1.5">Product Name & SKU</th>
                  <th className="px-2.5 py-1.5">Branch Location</th>
                  <th className="px-2.5 py-1.5 text-center">Event Type</th>
                  <th className="px-2.5 py-1.5 text-center">Qty Before</th>
                  <th className="px-2.5 py-1.5 text-center">Qty Change</th>
                  <th className="px-2.5 py-1.5 text-center">Qty After</th>
                  <th className="px-2.5 py-1.5 text-right">Unit Cost</th>
                  <th className="px-2.5 py-1.5 text-right">Movement Value</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="p-8 text-center text-slate-500">
                      No transaction movement logs match criteria.
                    </td>
                  </tr>
                ) : (
                  transactionLogsPagination.pagedItems.map((log) => {
                    const branchName = branches.find((b) => b.id === log.branchId)?.name || log.branchId;
                    const formattedDate = formatDualDate(log.timestampAD.split('T')[0], dateMode);
                    const isPositive = log.quantityChanged > 0;
                    const movementVal = Math.abs(log.quantityChanged) * log.unitCost;

                    return (
                      <tr key={log.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                        <td className={`p-2.5 font-bold font-mono text-indigo-500 dark:text-indigo-400`}>{log.transactionNumber}</td>
                        <td className="p-2.5 text-slate-500">{formattedDate}</td>
                        <td className="p-2.5">
                          <div className={`font-bold text-slate-900 dark:text-white`}>{log.productName}</div>
                          <div className="text-[10px] text-slate-400 font-mono">SKU: {log.productSku}</div>
                        </td>
                        <td className="p-2.5 text-slate-500">{branchName}</td>
                        <td className="p-2.5 text-center">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            log.changeType === 'INBOUND_PO'
                              ? `bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 dark:text-emerald-400`
                              : log.changeType === 'SHIPMENT_TRANSFER'
                              ? `bg-amber-500/10 border border-amber-500/20 text-amber-500 dark:text-amber-400`
                              : log.changeType === 'DAMAGE'
                              ? `bg-rose-500/10 border border-rose-500/20 text-rose-500 dark:text-rose-400`
                              : log.changeType === 'DAMAGE_REVERSED'
                              ? `bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 dark:text-emerald-400`
                              : log.changeType === 'CONSUMABLE_ISSUE'
                              ? `bg-amber-600/10 border border-amber-600/20 text-amber-600 dark:text-amber-400`
                              : `bg-sky-500/10 border border-sky-500/20 text-sky-500 dark:text-sky-400`
                          }`}>
                            {log.changeType}
                          </span>
                        </td>
                        <td className="p-2.5 text-center font-mono text-slate-400">{log.quantityBefore}</td>
                        <td className={`p-2.5 text-center font-mono font-bold ${isPositive ? 'text-emerald-500 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                          {isPositive ? `+${log.quantityChanged}` : log.quantityChanged}
                        </td>
                        <td className="p-2.5 text-center font-mono font-bold">{log.quantityAfter}</td>
                        <td className="p-2.5 text-right font-mono text-slate-500">{formatNPR(log.unitCost ?? 0)}</td>
                        <td className={`p-2.5 text-right font-mono font-bold ${isPositive ? 'text-emerald-500 dark:text-emerald-400' : 'text-sky-500 dark:text-sky-400'}`}>
                          {formatNPR(movementVal ?? 0)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
              {/* Grand Total Footer Row */}
              <tfoot className={`sticky bottom-0 z-20 font-bold uppercase text-[10px] tracking-wider border-t bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:border-slate-800`}>
                <tr>
                  <td colSpan={5} className="p-2.5 text-right font-bold">
                    Total Movement Logs ({filteredLogs.length} Events):
                  </td>
                  <td className="p-2.5 text-center font-mono text-slate-400">-</td>
                        <td className={`p-2.5 text-center font-mono font-bold ${totalLogQtyChanged >= 0 ? 'text-emerald-500 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                    {totalLogQtyChanged > 0 ? `+${totalLogQtyChanged}` : totalLogQtyChanged}
                  </td>
                  <td className="p-2.5 text-center font-mono text-slate-400">-</td>
                  <td className="p-2.5 text-center font-mono text-slate-400">-</td>
                  <td className={`p-2.5 text-right font-mono font-extrabold text-indigo-500 dark:text-indigo-400`}>
                    {formatNPR(totalLogVal ?? 0)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <TablePagination
            page={transactionLogsPagination.page}
            pageCount={transactionLogsPagination.pageCount}
            totalItems={transactionLogsPagination.totalItems}
            rangeStart={transactionLogsPagination.rangeStart}
            rangeEnd={transactionLogsPagination.rangeEnd}
            pageSize={transactionLogsPagination.pageSize}
            onPageChange={transactionLogsPagination.setPage}
            onPageSizeChange={transactionLogsPagination.setPageSize}
            className="mt-1"
          />
        </div>
      )}
    </div>
  );
};
