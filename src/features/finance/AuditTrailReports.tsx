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

interface AuditTrailReportsProps {
  auditLogs: AuditLog[];
  transactionLogs: TransactionLog[];
  financialSummary: FinancialSummary;
  products: Product[];
  branches: Branch[];
  assets: Asset[];
  invoices: PurchaseInvoice[];
  dateMode: 'BS' | 'AD';
  isDarkMode?: boolean;
}

export const AuditTrailReports: React.FC<AuditTrailReportsProps> = ({
  auditLogs,
  transactionLogs,
  financialSummary,
  products,
  branches,
  assets,
  invoices,
  dateMode,
  isDarkMode = false,
}) => {
  const [subTab, setSubTab] = useState<
    'AUDIT_TRAIL' | 'STOCK_TRANSACTIONS'
  >('AUDIT_TRAIL');

  // Compute Balance Sheet numbers
  const inventoryAssetVal = financialSummary?.totalInventoryAssetValue ?? 0;
  const fixedAssetNBV = (assets || []).reduce((sum, a) => sum + (a.netBookValue ?? 0), 0);
  const totalAssets = inventoryAssetVal + fixedAssetNBV;

  const accountsPayable = (invoices || []).reduce(
    (sum, inv) => sum + ((inv.grandTotal ?? 0) - (inv.amountPaid ?? 0)),
    0
  );
  const netEquity = totalAssets - accountsPayable;

  const handlePrintReport = () => {
    window.print();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-serif font-bold tracking-tight flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-indigo-500 dark:text-indigo-400" />
            <span className={isDarkMode ? 'text-white' : 'text-slate-900'}>
              Activities Log (System Audit Trail)
            </span>
          </h2>
          <p className="text-slate-500 dark:text-slate-400 text-xs mt-0.5">
            Realtime security audit trails, user access activities, role permissions changes, and system mutation records.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handlePrintReport}
            className={`flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer ${
              isDarkMode
                ? 'border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Printer className="h-3.5 w-3.5 text-slate-400" />
            <span>Print Log</span>
          </button>
        </div>
      </div>

      {/* Navigation Sub-Tabs */}
      <div className={`flex items-center gap-2 border-b pb-2 ${isDarkMode ? 'border-slate-800' : 'border-slate-200'}`}>
        <button
          onClick={() => setSubTab('AUDIT_TRAIL')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            subTab === 'AUDIT_TRAIL'
              ? 'bg-indigo-600 text-white shadow-md'
              : isDarkMode
              ? 'text-slate-400 hover:bg-slate-800/60'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <ShieldCheck className="h-4 w-4" />
          <span>User & Security Activities</span>
        </button>

        <button
          onClick={() => setSubTab('STOCK_TRANSACTIONS')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            subTab === 'STOCK_TRANSACTIONS'
              ? 'bg-indigo-600 text-white shadow-md'
              : isDarkMode
              ? 'text-slate-400 hover:bg-slate-800/60'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <History className="h-4 w-4" />
          <span>Stock Audit Events</span>
        </button>
      </div>

      {/* Sub-Tab 3: Stock Transactions Ledger */}
      {subTab === 'STOCK_TRANSACTIONS' && (
        <div
          className={`rounded-2xl border p-4 transition-colors ${
            isDarkMode ? 'bg-[#0f1218] border-slate-800 shadow-xl' : 'bg-white border-slate-200 shadow-sm'
          }`}
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className={`font-bold text-sm ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
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
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                isDarkMode
                  ? 'border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800'
                  : 'border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100'
              }`}
            >
              <Download className="h-3.5 w-3.5 text-indigo-500" />
              <span>Export Stock Ledger CSV</span>
            </button>
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
            <table className="w-full text-left text-xs border-collapse">
              <thead
                className={`font-bold uppercase text-[10px] tracking-wider border-b ${
                  isDarkMode
                    ? 'bg-slate-900/80 text-slate-400 border-slate-800'
                    : 'bg-slate-100 text-slate-600 border-slate-200'
                }`}
              >
                <tr>
                  <th className="p-3">Txn #</th>
                  <th className="p-3">Product Name</th>
                  <th className="p-3">Change Type</th>
                  <th className="p-3 text-right">Qty Before</th>
                  <th className="p-3 text-right">Change</th>
                  <th className="p-3 text-right">Qty After</th>
                  <th className="p-3">Timestamp</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-slate-200'}`}>
                {transactionLogs.map((log) => (
                  <tr
                    key={log.id}
                    className={`transition-colors ${
                      isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50/80'
                    }`}
                  >
                    <td className="p-3 font-mono font-bold text-slate-500 dark:text-slate-400">
                      {log.transactionNumber}
                    </td>
                    <td className="p-3 font-bold text-slate-900 dark:text-white">{log.productName}</td>
                    <td className="p-3">
                      <span className="rounded bg-slate-100 dark:bg-slate-900 px-2 py-0.5 text-[10px] font-bold text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800">
                        {log.changeType.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="p-3 text-right font-mono text-slate-500 dark:text-slate-400">{log.quantityBefore}</td>
                    <td
                      className={`p-3 text-right font-mono font-extrabold ${
                        log.quantityChanged > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                      }`}
                    >
                      {log.quantityChanged > 0 ? `+${log.quantityChanged}` : log.quantityChanged}
                    </td>
                    <td className="p-3 text-right font-mono font-bold text-slate-900 dark:text-white">
                      {log.quantityAfter}
                    </td>
                    <td className="p-3 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                      {formatDualDate(log.timestampAD, dateMode)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Sub-Tab 4: System User Audit Log */}
      {subTab === 'AUDIT_TRAIL' && (
        <div
          className={`rounded-2xl border p-4 transition-colors ${
            isDarkMode ? 'bg-[#0f1218] border-slate-800 shadow-xl' : 'bg-white border-slate-200 shadow-sm'
          }`}
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className={`font-bold text-sm ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
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
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                isDarkMode
                  ? 'border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800'
                  : 'border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100'
              }`}
            >
              <Download className="h-3.5 w-3.5 text-indigo-500" />
              <span>Export Audit Logs CSV</span>
            </button>
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
            <table className="w-full text-left text-xs border-collapse">
              <thead
                className={`font-bold uppercase text-[10px] tracking-wider border-b ${
                  isDarkMode
                    ? 'bg-slate-900/80 text-slate-400 border-slate-800'
                    : 'bg-slate-100 text-slate-600 border-slate-200'
                }`}
              >
                <tr>
                  <th className="p-3">User</th>
                  <th className="p-3">Module</th>
                  <th className="p-3">Action</th>
                  <th className="p-3">Details</th>
                  <th className="p-3">Timestamp</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-slate-200'}`}>
                {auditLogs.map((log) => (
                  <tr
                    key={log.id}
                    className={`transition-colors ${
                      isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50/80'
                    }`}
                  >
                    <td className="p-3 font-bold text-slate-900 dark:text-white">{log.userName}</td>
                    <td className="p-3">
                      <span className="rounded bg-indigo-50 dark:bg-indigo-950/80 px-2 py-0.5 text-[10px] font-bold text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30">
                        {log.module}
                      </span>
                    </td>
                    <td className="p-3 font-semibold text-slate-800 dark:text-slate-200">{log.action}</td>
                    <td className="p-3 text-slate-600 dark:text-slate-400 text-[11px]">{log.details}</td>
                    <td className="p-3 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                      {formatDualDate(log.timestampAD, dateMode)}
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
