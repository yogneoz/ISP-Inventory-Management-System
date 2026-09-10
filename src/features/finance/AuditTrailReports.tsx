import React, { useState } from 'react';
import {
  AuditLog,
  TransactionLog,
  FinancialSummary,
  Product,
  Branch,
  Asset,
  PurchaseInvoice,
} from '../../types';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { exportToCSV } from '../../utils/exportUtils';
import {
  FileSpreadsheet,
  History,
  ShieldCheck,
  TrendingUp,
  Scale,
  Receipt,
  Download,
  Printer,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';

interface AuditTrailReportsProps {
  auditLogs: AuditLog[];
  transactionLogs: TransactionLog[];
  financialSummary: FinancialSummary;
  products: Product[];
  branches: Branch[];
  assets: Asset[];
  invoices: PurchaseInvoice[];
  dateMode: 'BS' | 'AD';}

export const AuditTrailReports: React.FC<AuditTrailReportsProps> = ({
  auditLogs,
  transactionLogs,
  financialSummary,
  products,
  branches,
  assets,
  invoices,
  dateMode,}) => {
  const [subTab, setSubTab] = useState<
    'AUDIT_TRAIL' | 'STOCK_TRANSACTIONS'
  >('AUDIT_TRAIL');

  const txnPagination = useClientPagination(transactionLogs || [], 15);
  const auditPagination = useClientPagination(auditLogs || [], 15);

  // Compute Balance Sheet numbers
  // PostgreSQL NUMERIC columns arrive as strings; coerce before arithmetic.
  const toNumber = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const inventoryAssetVal = toNumber(financialSummary?.totalInventoryAssetValue);
  const fixedAssetNBV = (assets || []).reduce((sum, a) => sum + toNumber(a.netBookValue), 0);
  const totalAssets = inventoryAssetVal + fixedAssetNBV;

  const accountsPayable = (invoices || []).reduce(
    (sum, inv) => sum + (toNumber(inv.grandTotal) - toNumber(inv.amountPaid)),
    0
  );
  const netEquity = totalAssets - accountsPayable;

  const handlePrintReport = () => {
    window.print();
  };

  return (
    <div className="printable-document space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-serif font-bold tracking-tight flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-indigo-500 dark:text-indigo-400" />
            <span className="text-slate-900 dark:text-white">
              Activities Log (System Audit Trail)
            </span>
          </h2>
          <p className="truncate text-slate-500 dark:text-slate-400 text-xs mt-0.5">
            Realtime security audit trails, user access activities, role permissions changes, and system mutation records.
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2">
          <button
            onClick={handlePrintReport}
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800`}
          >
            <Printer className="h-3.5 w-3.5 text-slate-400" />
            <span>Print Log</span>
          </button>
        </div>
      </div>

      {/* Navigation Sub-Tabs */}
      <div className={`flex items-center gap-2 border-b pb-2 border-slate-200 dark:border-slate-800`}>
        <button
          onClick={() => setSubTab('AUDIT_TRAIL')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer 'subTab === 'AUDIT_TRAIL ? bg-indigo-600 text-white shadow-md : text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/60`}
        >
          <ShieldCheck className="h-4 w-4" />
          <span>User & Security Activities</span>
        </button>

        <button
          onClick={() => setSubTab('STOCK_TRANSACTIONS')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer 'subTab === 'STOCK_TRANSACTIONS ? bg-indigo-600 text-white shadow-md : text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/60`}
        >
          <History className="h-4 w-4" />
          <span>Stock Audit Events</span>
        </button>
      </div>

      {/* Sub-Tab 3: Stock Transactions Ledger */}
      {subTab === 'STOCK_TRANSACTIONS' && (
        <div
          className={`rounded-2xl border p-4 transition-colors bg-white border-slate-200 shadow-sm dark:bg-[#0f1218] dark:border-slate-800 dark:shadow-xl`}
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className={`font-bold text-sm text-slate-900 dark:text-white`}>
              Realtime Stock Movement Transaction Logs
            </h3>
            <button
              onClick={() =>
                exportToCSV('IZone_Stock_Transaction_Ledger', transactionLogs, [
                  { key: 'transactionNumber', label: 'Txn #' },
                  { key: 'productName', label: 'Product' },
                  { key: 'productSku', label: 'SKU' },
                  { key: 'changeType', label: 'Type' },
                  { key: 'quantityBefore', label: 'Qty Before' },
                  { key: 'quantityChanged', label: 'Change' },
                  { key: 'quantityAfter', label: 'Qty After' },
                  { key: 'timestampAD', label: 'Timestamp (AD)' },
                  { key: 'timestampBS', label: 'Timestamp (BS)' },
                ])
              }
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800`}
            >
              <Download className="h-3.5 w-3.5 text-indigo-500" />
              <span>Export Stock Ledger CSV</span>
            </button>
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
            <table className="w-full text-left text-xs border-collapse">
              <thead
                className={`font-bold uppercase text-[10px] tracking-wider border-b bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-900/80 dark:text-slate-400 dark:border-slate-800`}
              >
                <tr>
                  <th className="px-2.5 py-1.5">Txn #</th>
                  <th className="px-2.5 py-1.5">Product Name</th>
                  <th className="px-2.5 py-1.5">Change Type</th>
                  <th className="px-2.5 py-1.5 text-right">Qty Before</th>
                  <th className="px-2.5 py-1.5 text-right">Change</th>
                  <th className="px-2.5 py-1.5 text-right">Qty After</th>
                  <th className="px-2.5 py-1.5">Timestamp</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {txnPagination.pagedItems.map((log) => (
                  <tr
                    key={log.id}
                    className={`transition-colors hover:bg-slate-50/80 dark:hover:bg-slate-800/40`}
                  >
                    <td className="p-2.5 font-mono font-bold text-slate-500 dark:text-slate-400">
                      {log.transactionNumber}
                    </td>
                    <td className="p-2.5 font-bold text-slate-900 dark:text-white">{log.productName}</td>
                    <td className="p-2.5">
                      <span className="rounded bg-slate-100 dark:bg-slate-900 px-2 py-0.5 text-[10px] font-bold text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800">
                        {log.changeType.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="p-2.5 text-right font-mono text-slate-500 dark:text-slate-400">{log.quantityBefore}</td>
                    <td
                      className={`p-3 text-right font-mono font-extrabold log.quantityChanged > 0 ? text-emerald-600 dark:text-emerald-400 : text-rose-600 dark:text-rose-400`}
                    >
                      {log.quantityChanged > 0 ? `+${log.quantityChanged}` : log.quantityChanged}
                    </td>
                    <td className="p-2.5 text-right font-mono font-bold text-slate-900 dark:text-white">
                      {log.quantityAfter}
                    </td>
                    <td className="p-2.5 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                      {formatDualDate(log.timestampAD, dateMode)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination
            page={txnPagination.page}
            pageCount={txnPagination.pageCount}
            totalItems={txnPagination.totalItems}
            rangeStart={txnPagination.rangeStart}
            rangeEnd={txnPagination.rangeEnd}
            pageSize={txnPagination.pageSize}
            onPageChange={txnPagination.setPage}
            onPageSizeChange={txnPagination.setPageSize}
            className="mt-2"
          />
        </div>
      )}

      {/* Sub-Tab 4: System User Audit Log */}
      {subTab === 'AUDIT_TRAIL' && (
        <div
          className={`rounded-2xl border p-4 transition-colors bg-white border-slate-200 shadow-sm dark:bg-[#0f1218] dark:border-slate-800 dark:shadow-xl`}
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className={`font-bold text-sm text-slate-900 dark:text-white`}>
              System Action Audit Log (User & Security Actions)
            </h3>
            <button
              onClick={() =>
                exportToCSV('IZone_System_Audit_Log', auditLogs, [
                  { key: 'userName', label: 'User Name' },
                  { key: 'userEmail', label: 'User Email' },
                  { key: 'module', label: 'Module' },
                  { key: 'action', label: 'Action' },
                  { key: 'details', label: 'Details' },
                  { key: 'timestampAD', label: 'Timestamp (AD)' },
                  { key: 'timestampBS', label: 'Timestamp (BS)' },
                ])
              }
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800`}
            >
              <Download className="h-3.5 w-3.5 text-indigo-500" />
              <span>Export Audit Logs CSV</span>
            </button>
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
            <table className="w-full text-left text-xs border-collapse">
              <thead
                className={`font-bold uppercase text-[10px] tracking-wider border-b bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-900/80 dark:text-slate-400 dark:border-slate-800`}
              >
                <tr>
                  <th className="px-2.5 py-1.5">User</th>
                  <th className="px-2.5 py-1.5">Module</th>
                  <th className="px-2.5 py-1.5">Action</th>
                  <th className="px-2.5 py-1.5">Details</th>
                  <th className="px-2.5 py-1.5">Timestamp</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {auditPagination.pagedItems.map((log) => (
                  <tr
                    key={log.id}
                    className={`transition-colors hover:bg-slate-50/80 dark:hover:bg-slate-800/40`}
                  >
                    <td className="p-2.5 font-bold text-slate-900 dark:text-white">{log.userName}</td>
                    <td className="p-2.5">
                      <span className="rounded bg-indigo-50 dark:bg-indigo-950/80 px-2 py-0.5 text-[10px] font-bold text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30">
                        {log.module}
                      </span>
                    </td>
                    <td className="p-2.5 font-semibold text-slate-800 dark:text-slate-200">{log.action}</td>
                    <td className="p-2.5 text-slate-600 dark:text-slate-400 text-[11px]">{log.details}</td>
                    <td className="p-2.5 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                      {formatDualDate(log.timestampAD, dateMode)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination
            page={auditPagination.page}
            pageCount={auditPagination.pageCount}
            totalItems={auditPagination.totalItems}
            rangeStart={auditPagination.rangeStart}
            rangeEnd={auditPagination.rangeEnd}
            pageSize={auditPagination.pageSize}
            onPageChange={auditPagination.setPage}
            onPageSizeChange={auditPagination.setPageSize}
            className="mt-2"
          />
        </div>
      )}
    </div>
  );
};
