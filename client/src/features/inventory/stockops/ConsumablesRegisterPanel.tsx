import React from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import {
  ConsumableIssueItem,
  StockOperation,
} from '../../../types';
import { TablePagination } from '../../../components/common/TablePagination';
import { DateField } from '../../../components/DateField';
import { FilterCard } from '../../../components/common/FilterCard';
import { formatNPR } from '../../../utils/nprFormat';
import { exportToCSV } from '../../../utils/exportUtils';
import { isOperationAllowed } from '../../../utils/permissions';
import { api } from '../../../services/api';
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  RotateCcw,
  Download,
} from 'lucide-react';

/**
 * ConsumablesRegisterPanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (decomposition audit, FRONTEND-AUDIT.md Section G, "pure move" step).
 * The host owns ALL state and handlers; this panel destructures them from
 * the StockOperations context and renders the exact conditional block the
 * host used to render inline. No logic changes.
 */
export const ConsumablesRegisterPanel: React.FC = () => {
  const { activeTab, branches, consumableRegisterBranch, consumableRegisterCount, consumableRegisterDateFrom, consumableRegisterDateTo, consumableRegisterError, consumableRegisterExpandedId, consumableRegisterLoading, consumableRegisterOps, consumableRegisterPage, consumableRegisterPageSize, consumableRegisterQuery, consumableRegisterStatus, currentUser, dateMode, handleReverseConsumableIssue, setConsumableRegisterBranch, setConsumableRegisterDateFrom, setConsumableRegisterDateTo, setConsumableRegisterExpandedId, setConsumableRegisterPage, setConsumableRegisterPageSize, setConsumableRegisterQuery, setConsumableRegisterStatus } = useStockOperationsCtx();
  return (
    <>
      {activeTab === 'CONSUMABLES_REGISTER' && (
        <div className="rounded-2xl border p-4 shadow-sm bg-white border-slate-200 text-slate-900 dark:bg-[#0f1218] dark:border-slate-800 dark:text-white">
          {/* Slim count chip instead of a serif banner header (the tab bar already
              names this register). */}
          <div className="flex items-center justify-end pb-2 mb-3 border-b border-slate-200 dark:border-slate-800">
            <span className="px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-800">
              {consumableRegisterLoading ? '…' : consumableRegisterCount} Record(s)
            </span>
          </div>

          {/* Toolbar: shared inline FilterCard (search + branch/status/dates) */}
          <div className="mb-2">
            <FilterCard
              searchPlaceholder="Search reference, technician, work order, product, POP location or customer..."
              searchValue={consumableRegisterQuery}
              onSearchApply={setConsumableRegisterQuery}
              hasActiveFilters={
                Boolean(consumableRegisterQuery) || consumableRegisterBranch !== 'ALL' || consumableRegisterStatus !== 'ALL' ||
                Boolean(consumableRegisterDateFrom) || Boolean(consumableRegisterDateTo)
              }
              onClearAll={() => {
                setConsumableRegisterQuery('');
                setConsumableRegisterBranch('ALL');
                setConsumableRegisterStatus('ALL');
                setConsumableRegisterDateFrom('');
                setConsumableRegisterDateTo('');
              }}
              filterChildren={
                <>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Branch</label>
                    <select
                      value={consumableRegisterBranch}
                      onChange={(e) => setConsumableRegisterBranch(e.target.value)}
                      className={`w-44 rounded-xl border px-3 py-2 text-xs font-semibold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white cursor-pointer`}
                    >
                      <option value="ALL">All Branches</option>
                      {branches.map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Status</label>
                    <select
                      value={consumableRegisterStatus}
                      onChange={(e) => setConsumableRegisterStatus(e.target.value)}
                      className={`w-36 rounded-xl border px-3 py-2 text-xs font-semibold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white cursor-pointer`}
                    >
                      <option value="ALL">All Statuses</option>
                      <option value="LOGGED">Logged</option>
                      <option value="CANCELLED">Reversed</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Issue Date From</label>
                    <div className="w-40">
                      <DateField
                        mode={dateMode}
                        value={consumableRegisterDateFrom}
                        onChange={setConsumableRegisterDateFrom}
                        compact
                        showHint={false}
                        max={consumableRegisterDateTo || undefined}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Issue Date To</label>
                    <div className="w-40">
                      <DateField
                        mode={dateMode}
                        value={consumableRegisterDateTo}
                        onChange={setConsumableRegisterDateTo}
                        compact
                        showHint={false}
                        min={consumableRegisterDateFrom || undefined}
                      />
                    </div>
                  </div>
                </>
              }
              rightChildren={
                <button
                  type="button"
                  onClick={async () => {
                    // Export every filtered row, not just the current page.
                    let exportOps = consumableRegisterOps;
                    if (!consumableRegisterError) {
                      try {
                        const envelope = await api.getStockOperations({
                          type: 'CONSUMABLE_ISSUE',
                          branchId: consumableRegisterBranch !== 'ALL' ? consumableRegisterBranch : undefined,
                          status: consumableRegisterStatus,
                          query: consumableRegisterQuery.trim() || undefined,
                          dateFromAD: consumableRegisterDateFrom || undefined,
                          dateToAD: consumableRegisterDateTo || undefined,
                          all: true,
                        }) as { data: StockOperation[] };
                        exportOps = envelope.data || [];
                      } catch {
                        // Fall back to the rows already on screen.
                      }
                    }
                    exportToCSV(
                  'Consumables_Issue_Register',
                  exportOps.map((op) => ({
                    referenceNumber: op.referenceNumber,
                    dateAD: op.dateAD,
                    dateBS: op.dateBS,
                    branchId: op.branchId,
                    technician: op.technicianName || '',
                    workOrder: op.workOrderRef || '',
                    itemCount: (op.items || []).length,
                    totalValue: op.totalValue,
                    status: op.status || 'LOGGED',
                    reason: op.reason,
                  })),
                  [
                    { key: 'referenceNumber', label: 'Reference #' },
                    { key: 'dateAD', label: 'Date (AD)' },
                    { key: 'dateBS', label: 'Date (BS)' },
                    { key: 'branchId', label: 'Branch' },
                    { key: 'technician', label: 'Field Technician' },
                    { key: 'workOrder', label: 'Work Order' },
                    { key: 'itemCount', label: 'Line Items' },
                    { key: 'totalValue', label: 'Total Value (NPR)' },
                    { key: 'status', label: 'Status' },
                    { key: 'reason', label: 'Remarks / Reason' },
                  ]
                  );
                  }}
                className="px-3 py-2 rounded-xl border text-xs font-bold bg-white border-slate-300 text-slate-600 hover:bg-slate-100 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5"
              >
                <Download className="h-4 w-4" />
                <span>Export CSV</span>
              </button>
              }
            />
          </div>

          {consumableRegisterOps.length === 0 ? (
            <div className="p-8 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-slate-400">
              <ClipboardList className="h-8 w-8 mx-auto mb-2 text-slate-300 dark:text-slate-700" />
              <p>No consumable issue records match the current filters.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className={`font-bold text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}>
                  <tr>
                    <th className="px-2.5 py-2 w-8"></th>
                    <th className="px-2.5 py-2">Date</th>
                    <th className="px-2.5 py-2">Reference #</th>
                    <th className="px-2.5 py-2">Product(s) / Used Location / Customer</th>
                    <th className="px-2.5 py-2 text-center">Quantity</th>
                    <th className="px-2.5 py-2">Field Technician</th>
                    <th className="px-2.5 py-2">Remarks</th>
                    <th className="px-2.5 py-2 text-right">Value (NPR)</th>
                    <th className="px-2.5 py-2 text-center">Status</th>
                    <th className="px-2.5 py-2 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                  {consumableRegisterOps.map((op) => {
                    const items = (op.items || []) as ConsumableIssueItem[];
                    const isReversed = op.status === 'CANCELLED';
                    const canReverseHere =
                      isOperationAllowed('consumable-issue-reverse', currentUser?.role) &&
                      !isReversed &&
                      !op.id.startsWith('syn-');
                    const isExpanded = consumableRegisterExpandedId === op.id;

                    return (
                      <React.Fragment key={op.id}>
                        <tr className={`hover:bg-slate-200 dark:hover:bg-slate-800/40 ${isReversed ? 'opacity-60' : ''}`}>
                          <td className="p-2.5 text-center">
                            <button
                              type="button"
                              onClick={() => setConsumableRegisterExpandedId(isExpanded ? null : op.id)}
                              className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                              title={isExpanded ? 'Collapse line items' : 'Expand line items'}
                            >
                              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </button>
                          </td>
                          <td className="p-2.5 font-mono text-slate-400 text-[11px] whitespace-nowrap">
                            {dateMode === 'BS' ? op.dateBS : op.dateAD}
                          </td>
                          <td className="p-2.5 font-mono font-bold text-amber-600 dark:text-amber-400 whitespace-nowrap">{op.referenceNumber}</td>
                          <td className="p-2.5 font-medium text-slate-900 dark:text-white">
                            {items.length === 1
                              ? items[0].productName
                              : `${items.length} line items — ${items[0]?.productName || 'Multiple'}${items.length > 1 ? ' + more' : ''}`}
                          </td>
                          <td className="p-2.5 text-center font-mono font-bold text-rose-600 dark:text-rose-400">
                            -{items.reduce((s, i) => s + (Number(i.quantity) || 0), 0)}
                          </td>
                          <td className="p-2.5 font-medium text-slate-700 dark:text-slate-300">{op.technicianName || 'N/A'}</td>
                          <td className="p-2.5 text-slate-500 dark:text-slate-400 max-w-[220px] truncate" title={op.reason}>{op.workOrderRef || op.reason}</td>
                          <td className="p-2.5 text-right font-mono font-bold text-slate-900 dark:text-white">{formatNPR(op.totalValue)}</td>
                          <td className="p-2.5 text-center">
                            {isReversed ? (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400" title={`Reversed by ${op.reversedBy || '—'}: ${op.reversalReason || ''}`}>
                                Reversed
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                                Logged
                              </span>
                            )}
                          </td>
                          <td className="p-2.5 text-center">
                            {canReverseHere ? (
                              <button
                                type="button"
                                onClick={() => handleReverseConsumableIssue(op)}
                                className="px-2.5 py-1 rounded-lg border border-rose-300 dark:border-rose-800 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 font-bold text-[10px] cursor-pointer flex items-center gap-1 mx-auto"
                                title="Reverse this consumable issue — return units to branch stock"
                              >
                                <RotateCcw className="h-3 w-3" />
                                <span>Reverse</span>
                              </button>
                            ) : (
                              <span className="text-[10px] text-slate-400">—</span>
                            )}
                          </td>
                        </tr>

                        {/* Expanded per-line detail: product / used-at / remarks */}
                        {isExpanded && (
                          <tr className="bg-slate-50 dark:bg-slate-900/60">
                            <td colSpan={10} className="px-6 py-3">
                              <div className="space-y-1.5">
                                {items.map((item) => (
                                  <div key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] border-b border-dashed border-slate-200 dark:border-slate-800 pb-1.5 last:border-0">
                                    <span className="font-bold text-slate-800 dark:text-slate-200">[{item.sku}] {item.productName}</span>
                                    <span className="font-mono text-slate-500">× {item.quantity} {item.unit || ''}</span>
                                    <span className="font-mono">{formatNPR(item.totalValue)}</span>
                                    {item.usedAtType === 'POP' && item.usedAtLocationName && (
                                      <span className="px-1.5 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 font-semibold">
                                        POP: {item.usedAtLocationName}
                                      </span>
                                    )}
                                    {item.usedAtType === 'CUSTOMER' && item.usedAtCustomerName && (
                                      <span className="px-1.5 py-0.5 rounded-md bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800 font-semibold">
                                        Customer: {item.usedAtCustomerName}
                                      </span>
                                    )}
                                    {item.usedAtType === 'FIELD' && (
                                      <span className="px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 font-semibold">
                                        Field / Work Order
                                      </span>
                                    )}
                                    {item.remarks && <span className="text-slate-400 italic">“{item.remarks}”</span>}
                                  </div>
                                ))}
                                {isReversed && op.reversalReason && (
                                  <p className="text-[11px] text-rose-500 pt-1">
                                    Reversed by {op.reversedBy || '—'} on {op.reversedAtAD || '—'}: {op.reversalReason}
                                  </p>
                                )}
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

          <TablePagination
            page={consumableRegisterPage}
            pageCount={Math.max(1, Math.ceil(consumableRegisterCount / consumableRegisterPageSize))}
            totalItems={consumableRegisterCount}
            rangeStart={consumableRegisterCount === 0 ? 0 : (consumableRegisterPage - 1) * consumableRegisterPageSize + 1}
            rangeEnd={Math.min(consumableRegisterPage * consumableRegisterPageSize, consumableRegisterCount)}
            pageSize={consumableRegisterPageSize}
            onPageChange={(p) => setConsumableRegisterPage(Math.max(1, p))}
            onPageSizeChange={(s) => {
              setConsumableRegisterPageSize(s);
              setConsumableRegisterPage(1);
            }}
          />
        </div>
      )}
    </>
  );
};
