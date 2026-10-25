import React from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import { formatNPR } from '../../../utils/nprFormat';
import { isOperationAllowed } from '../../../utils/permissions';
import { api } from '../../../services/api';

/**
 * LogsPanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (FRONTEND-AUDIT.md Section G: commit 1 moved the JSX verbatim; commit 2
 * relocated this panel's state, effects and handlers here as well). The
 * panel renders the exact conditional block the host used to render inline;
 * everything it does not own comes from the StockOperations context.
 */
export const LogsPanel: React.FC = () => {
  const { activeTab, currentUser, operations, onRefreshData, promptDialog, showToast } = useStockOperationsCtx();

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
        title: 'Reverse Product Sale — Safeguard',
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
    } catch (err: any) {
      showToast(`Reversal failed: ${err.message || 'Unknown error'}`);
    }
  };

  return (
    <>
      {activeTab === 'LOGS' && (
        <div className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <h3 className={`font-bold text-sm mb-3 text-slate-900 dark:text-white`}>
            Audit Log of All Stock Operations ({operations.length})
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className={`font-bold text-[9px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/80 dark:text-slate-400 dark:border-slate-800`}>
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
                {operations.map((op) => (
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
        </div>
      )}
    </>
  );
};
