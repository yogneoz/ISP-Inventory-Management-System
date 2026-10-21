import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AuditLog,
  TransactionLog,
  FinancialSummary,
  Product,
  Branch,
  Asset,
  PurchaseInvoice,
  CompanyProfile,
} from '../../types';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { exportToCSV } from '../../utils/exportUtils';
import { DocumentLetterhead } from '../../components/common/DocumentLetterhead';
import { PageHeader } from '../../components/common/PageHeader';
import {
  History,
  ShieldCheck,
  Download,
  Printer,
  Search,
  X,
  ArrowDownUp,
  AlertTriangle,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { api } from '../../services/api';

interface AuditTrailReportsProps {
  auditLogs: AuditLog[];
  transactionLogs: TransactionLog[];
  financialSummary: FinancialSummary;
  products: Product[];
  branches: Branch[];
  assets: Asset[];
  invoices: PurchaseInvoice[];
  dateMode: 'BS' | 'AD';
  companyProfile?: CompanyProfile | null;
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
  companyProfile,
}) => {
  const [subTab, setSubTab] = useState<
    'AUDIT_TRAIL' | 'STOCK_TRANSACTIONS'
  >('AUDIT_TRAIL');

  // Serial focus: a supervisor picks one unit and reads its whole story —
  // claims, exchanges, refusals — from the server, not just the 200 newest
  // rows the bootstrap slice carries. The draft debounces so typing does not
  // hit the API on every keystroke.
  const [serialDraft, setSerialDraft] = useState('');
  const [serialFilter, setSerialFilter] = useState('');
  const [serialRows, setSerialRows] = useState<AuditLog[]>([]);
  const [serialLoading, setSerialLoading] = useState(false);
  const [serialError, setSerialError] = useState('');
  const [oldestFirst, setOldestFirst] = useState(false);
  const serialSeq = useRef(0);

  const txnPagination = useClientPagination(transactionLogs || [], 15);

  useEffect(() => {
    const timer = setTimeout(() => setSerialFilter(serialDraft.trim()), 300);
    return () => clearTimeout(timer);
  }, [serialDraft]);

  useEffect(() => {
    if (!serialFilter) {
      serialSeq.current++;
      setSerialRows([]);
      setSerialError('');
      setSerialLoading(false);
      return;
    }
    const seq = ++serialSeq.current;
    setSerialLoading(true);
    setSerialError('');
    api.getAuditTrail({ serial: serialFilter, limit: 500 })
      .then((rows) => {
        if (seq !== serialSeq.current) return; // a newer serial superseded this one
        setSerialRows(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (seq !== serialSeq.current) return;
        // Keep the bootstrap slice visible rather than blanking the panel; the
        // note tells the operator this unit's list may be incomplete.
        setSerialRows([]);
        setSerialError(`Could not load the full trail for ${serialFilter} — showing the latest system events instead.`);
      })
      .finally(() => {
        if (seq === serialSeq.current) setSerialLoading(false);
      });
  }, [serialFilter]);

  // A failed serial read falls back to the live bootstrap slice so the screen
  // still shows something useful (with the error note above it).
  const auditSource = useMemo(() => {
    const base = serialFilter && !serialError ? serialRows : (auditLogs || []);
    return oldestFirst ? [...base].reverse() : base;
  }, [serialFilter, serialError, serialRows, auditLogs, oldestFirst]);
  const auditPagination = useClientPagination(auditSource, 15, [serialFilter, oldestFirst]);
  const refusedCount = useMemo(
    () => auditSource.filter((row) => String(row.action || '').includes('REFUSED')).length,
    [auditSource]
  );

  const handlePrintReport = () => {
    window.print();
  };

  return (
    <div className="printable-document space-y-6">
      {/* Official Company Letterhead */}
      <DocumentLetterhead
        companyProfile={companyProfile}
        title="Activities Log (System Audit Trail)"
        subtitle={`Generated: ${formatDualDate(new Date().toISOString().split('T')[0], dateMode)} — Realtime security audit trails, user access activities, role permissions changes, and system mutation records.`}
      />

      {/* Header — shared PageHeader (single h2 per screen rule) */}
      <PageHeader
        title="Activities Log (System Audit Trail)"
        description="Realtime security audit trails, user access activities, role permissions changes, and system mutation records."
        icon={<ShieldCheck className="h-5 w-5 text-indigo-500 dark:text-indigo-400" />}
        actions={
          <button
            onClick={handlePrintReport}
            className="flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-white text-slate-700 hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <Printer className="h-3.5 w-3.5 text-slate-400" />
            <span>Print Log</span>
          </button>
        }
      />

      {/* Navigation Sub-Tabs */}
      <div className={`flex items-center gap-2 border-b pb-2 border-slate-200 dark:border-slate-800`}>
        <button
          onClick={() => setSubTab('AUDIT_TRAIL')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${subTab === 'AUDIT_TRAIL' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-800/60'}`}
        >
          <ShieldCheck className="h-4 w-4" />
          <span>User & Security Activities</span>
        </button>

        <button
          onClick={() => setSubTab('STOCK_TRANSACTIONS')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${subTab === 'STOCK_TRANSACTIONS' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-800/60'}`}
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
                exportToCSV('Inventory_Stock_Transaction_Ledger', transactionLogs, [
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
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800`}
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
                    className={`transition-colors hover:bg-slate-100/80 dark:hover:bg-slate-800/40`}
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
                      className={`p-3 text-right font-mono font-extrabold ${log.quantityChanged > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
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
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className={`font-bold text-sm text-slate-900 dark:text-white`}>
              System Action Audit Log (User & Security Actions)
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {/* Serial focus: one unit's whole claim/refusal story, read from the
                  server (a serial's history can be older than the bootstrap slice). */}
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={serialDraft}
                  onChange={(e) => setSerialDraft(e.target.value)}
                  placeholder="Filter by device serial…"
                  aria-label="Filter audit trail by device serial"
                  spellCheck={false}
                  className="w-52 rounded-xl border border-slate-300 bg-white py-1.5 pl-8 pr-7 font-mono text-xs uppercase text-slate-900 placeholder:font-sans placeholder:normal-case placeholder:text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
                {serialDraft && (
                  <button
                    type="button"
                    onClick={() => setSerialDraft('')}
                    title="Clear serial filter"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => setOldestFirst((v) => !v)}
                title={oldestFirst ? 'Showing oldest first — switch to newest first' : 'Showing newest first — switch to oldest first'}
                className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <ArrowDownUp className="h-3.5 w-3.5 text-indigo-500" />
                <span>{oldestFirst ? 'Oldest first' : 'Newest first'}</span>
              </button>
              <button
                onClick={() =>
                  exportToCSV('Inventory_System_Audit_Log', auditSource, [
                    { key: 'userName', label: 'User Name' },
                    { key: 'userEmail', label: 'User Email' },
                    { key: 'module', label: 'Module' },
                    { key: 'action', label: 'Action' },
                    { key: 'details', label: 'Details' },
                    { key: 'timestampAD', label: 'Timestamp (AD)' },
                    { key: 'timestampBS', label: 'Timestamp (BS)' },
                  ])
                }
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800`}
              >
                <Download className="h-3.5 w-3.5 text-indigo-500" />
                <span>Export Audit Logs CSV</span>
              </button>
            </div>
          </div>
          {serialFilter && (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]" role="status">
              {serialLoading ? (
                <span className="text-slate-500 dark:text-slate-400">
                  Loading every event for <span className="font-mono font-bold">{serialFilter}</span>…
                </span>
              ) : serialError ? (
                <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {serialError}
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-2 text-slate-600 dark:text-slate-400">
                  <span>
                    {auditSource.length} event{auditSource.length === 1 ? '' : 's'} for{' '}
                    <span className="font-mono font-bold text-slate-900 dark:text-white">{serialFilter}</span>{' '}
                    ({oldestFirst ? 'oldest first' : 'newest first'})
                  </span>
                  {refusedCount > 0 && (
                    <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-bold text-amber-700 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-300">
                      {refusedCount} refused attempt{refusedCount === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
              )}
            </div>
          )}
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
                {auditPagination.pagedItems.map((log) => {
                  // A refused claim is the event a supervisor is hunting for:
                  // tint the row and mark the action instead of burying it among
                  // the successful ones.
                  const refused = String(log.action || '').includes('REFUSED');
                  return (
                    <tr
                      key={log.id}
                      className={`transition-colors ${refused ? 'bg-amber-50/70 hover:bg-amber-100/70 dark:bg-amber-950/20 dark:hover:bg-amber-950/30' : 'hover:bg-slate-100/80 dark:hover:bg-slate-800/40'}`}
                    >
                      <td className="p-2.5 font-bold text-slate-900 dark:text-white">{log.userName}</td>
                      <td className="p-2.5">
                        <span className="rounded bg-indigo-50 dark:bg-indigo-950/80 px-2 py-0.5 text-[10px] font-bold text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30">
                          {log.module}
                        </span>
                      </td>
                      <td className="p-2.5 font-semibold text-slate-800 dark:text-slate-200">
                        {refused ? (
                          <span className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:border-amber-500/40 dark:bg-amber-900/40 dark:text-amber-300">
                            <AlertTriangle className="h-3 w-3" />
                            {log.action}
                          </span>
                        ) : (
                          log.action
                        )}
                      </td>
                      <td className="p-2.5 text-slate-600 dark:text-slate-400 text-[11px]">{log.details}</td>
                      <td className="p-2.5 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                        {formatDualDate(log.timestampAD, dateMode)}
                      </td>
                    </tr>
                  );
                })}
                {auditPagination.pagedItems.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-4 text-center text-[11px] text-slate-500 dark:text-slate-400">
                      {serialFilter && !serialLoading && !serialError
                        ? `No audited events mention ${serialFilter}.`
                        : 'No audit events to show.'}
                    </td>
                  </tr>
                )}
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
