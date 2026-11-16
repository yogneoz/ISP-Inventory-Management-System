import React, { useCallback, useMemo } from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import { KeysetLoadMore } from '../../../components/common/KeysetLoadMore';
import { useKeysetPager } from '../../../hooks/useKeysetPager';
import { formatNPR } from '../../../utils/nprFormat';
import { isOperationAllowed } from '../../../utils/permissions';
import { api } from '../../../services/api';

/**
 * LogsPanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (StockOperations decomposition: commit 1 moved the JSX verbatim; commit 2
 * relocated this panel's state, effects and handlers here as well). The
 * panel renders the exact conditional block the host used to render inline;
 * everything it does not own comes from the StockOperations context.
 */
export const LogsPanel: React.FC = () => {
  const { activeTab, allCombinedOps, branchFilter, currentUser, filteredOperations, onRefreshData, promptDialog, showToast, sseRefreshKey } = useStockOperationsCtx();

  const fetchLogsPage = useCallback(async (cursor: string | null) => {
    const envelope = await api.getStockOperations({
      branchId: branchFilter !== 'ALL' ? branchFilter : undefined,
      cursor,
      limit: 25,
    }) as { data?: any[]; items?: any[]; nextCursor?: string | null; hasMore?: boolean };
    return {
      items: envelope.items || envelope.data || [],
      nextCursor: envelope.nextCursor ?? null,
      hasMore: Boolean(envelope.hasMore),
    };
  }, [branchFilter]);

  const logsPager = useKeysetPager({
    fetchPage: fetchLogsPage,
    resetKey: [branchFilter, activeTab, sseRefreshKey ?? 0].join('\u0000'),
    enabled: activeTab === 'LOGS',
  });
  const syntheticLogs = useMemo(
    () => allCombinedOps.filter((op) =>
      op.id.startsWith('syn-') && (branchFilter === 'ALL' || op.branchId === branchFilter)
    ),
    [allCombinedOps, branchFilter]
  );
  const logRows = logsPager.error && !logsPager.scopeError
    ? filteredOperations
    : [...syntheticLogs, ...logsPager.rows];

  // SER-1/D2: a product-sale stock-out issued its serials as SOLD. Reversing
  // returns this operation's units and serials to IN_STOCK at its branch.
  const handleReverseStockOut = async (op: any) => {
    const reason = await promptDialog(
      `You are about to reverse product sale ${op.referenceNumber}.\n\n` +
        `● Branch: ${op.branchId}\n` +
        `● Lines: ${(op.items || []).length}\n` +
        `● Value: ${formatNPR(op.totalValue)}\n\n` +
        `Reversing returns this sale's units (and their serials) to available stock and marks the record CANCELLED.`,
      {
        title: 'Reverse Stock-Out — Safeguard',
        confirmLabel: 'Reverse & Return Stock',
        cancelLabel: 'Keep Sale',
        placeholder: 'Required: reason for reversal (audit trail)',
      }
    );
    if (reason === null) return;
    if (!reason.trim()) {
      showToast('Reversal aborted — a reason is required as a safeguard.');
      return;
    }
    try {
      await api.reverseStockOutOperation(op.id, reason.trim(), currentUser);
      showToast(`Product sale ${op.referenceNumber} reversed. Units returned to available stock.`);
      await onRefreshData?.();
      logsPager.reload();
    } catch (err: any) {
      showToast(`Reversal failed: ${err.message || 'Unknown error'}`);
    }
  };

  return (
    <>
      {activeTab === 'LOGS' && (
        <div className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <h3 className={`font-bold text-sm mb-3 text-slate-900 dark:text-white`}>
            Audit Log of All Stock Operations ({logRows.length} loaded)
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className={`font-bold text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/80 dark:text-slate-400 dark:border-slate-800`}>
                <tr>
                  <th className="px-2.5 py-1.5">Ref #</th>
                  <th className="px-2.5 py-1.5">Type</th>
                  <th className="px-2.5 py-1.5">Branch</th>
                  <th className="px-2.5 py-1.5">Product / Details</th>
                  <th className="px-2.5 py-1.5">Value</th>
                  <th className="px-2.5 py-1.5">Inspector / Officer</th>
                  <th className="px-2.5 py-1.5">Date</th>
                  <th className="px-2.5 py-1.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {logRows.map((op) => (
                  <tr key={op.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className={`p-2.5 font-mono font-bold text-indigo-600 dark:text-indigo-400`}>{op.referenceNumber}</td>
                    <td className="p-2.5 font-bold">{op.type}</td>
                    <td className="p-2.5">{op.branchId}</td>
                    <td className="p-2.5">{op.productName || op.reason}</td>
                    <td className="p-2.5 font-mono font-bold">{formatNPR(op.totalValue)}</td>
                    <td className="p-2.5">{op.inspectorName}</td>
                    <td className="p-2.5 font-mono text-slate-400">{op.dateAD}</td>
                    <td className="p-2.5 text-right">
                      {op.type === 'STOCK_OUT' && op.status !== 'CANCELLED' && isOperationAllowed('stock-out', currentUser?.role) ? (
                        <button
                          onClick={() => handleReverseStockOut(op)}
                          className="px-2 py-1 rounded-lg bg-rose-600 text-white font-bold text-[10px] hover:bg-rose-500 cursor-pointer"
                          title="Reverse this product sale and return its units and serials to stock"
                        >
                          Reverse
                        </button>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <KeysetLoadMore
            loaded={logRows.length}
            hasMore={logsPager.hasMore}
            loadingMore={logsPager.loadingMore}
            onLoadMore={logsPager.loadMore}
            scopeError={logsPager.scopeError ? logsPager.error : ''}
          />
        </div>
      )}
    </>
  );
};
