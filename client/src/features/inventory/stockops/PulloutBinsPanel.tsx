import React from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import { formatNPR } from '../../../utils/nprFormat';
import { isOperationAllowed } from '../../../utils/permissions';
import { api } from '../../../services/api';
import {
  Truck,
} from 'lucide-react';

/**
 * PulloutBinsPanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (FRONTEND-AUDIT.md Section G: commit 1 moved the JSX verbatim; commit 2
 * relocated this panel's state, effects and handlers here as well). The
 * panel renders the exact conditional block the host used to render inline;
 * everything it does not own comes from the StockOperations context.
 */
export const PulloutBinsPanel: React.FC = () => {
  const { activeTab, confirmDialog, currentUser, filteredOperations, onReceiveOperation, onRefreshData, promptDialog, showToast } =
    useStockOperationsCtx();

  // SER-1/D2: reverse a dispatch before it is received. The server returns the
  // operation's IN_TRANSIT units to IN_STOCK at the source branch.
  const handleReversePullout = async (op: any) => {
    const reason = await promptDialog(
      `You are about to reverse pullout dispatch ${op.referenceNumber}.\n\n` +
        `● Source: ${op.branchName || op.branchId}\n` +
        `● Destination: ${op.destinationWarehouseName || 'Central Hub'}\n` +
        `● Lines: ${(op.items || []).length}\n\n` +
        `Reversing returns this dispatch's units (and their serials) to the source branch and marks the record CANCELLED.`,
      {
        title: 'Reverse Pullout Dispatch — Safeguard',
        confirmLabel: 'Reverse & Return Stock',
        cancelLabel: 'Keep Dispatch',
        placeholder: 'Required: reason for reversal (audit trail)',
      }
    );
    if (reason === null) return;
    if (!reason.trim()) {
      showToast('Reversal aborted — a reason is required as a safeguard.');
      return;
    }
    try {
      await api.reversePulloutOperation(op.id, reason.trim(), currentUser);
      showToast(`Pullout ${op.referenceNumber} reversed. Units returned to ${op.branchName || op.branchId}.`);
      await onRefreshData?.();
    } catch (err: any) {
      showToast(`Reversal failed: ${err.message || 'Unknown error'}`);
    }
  };

  return (
    <>
      {activeTab === 'PULLOUT_BINS' && (
        <div className="space-y-3">
          <div className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className={`font-bold text-sm flex items-center gap-2 text-slate-900 dark:text-white`}>
                <Truck className={`h-4 w-4 text-indigo-500 dark:text-indigo-400`} />
                <span>Overstock & Damaged Stock Warehouse Pullout Dispatches</span>
              </h3>
              <span className="text-xs text-slate-400 font-mono">
                Showing {filteredOperations.length} dispatches
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredOperations.map((op) => (
                <div
                  key={op.id}
                  className={`p-4 rounded-xl border flex flex-col justify-between space-y-3 bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className={`font-mono text-xs font-bold text-indigo-600 dark:text-indigo-400`}>
                        {op.referenceNumber}
                      </span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30`}>
                        {op.status || 'DISPATCHED'}
                      </span>
                    </div>

                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      Source: {op.branchName || op.branchId} → Warehouse: {op.destinationWarehouseName || 'Central Hub'}
                    </div>

                    <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">{op.reason}</p>

                    {op.items && op.items.length > 0 && (
                      <div className="mt-2 text-[11px] font-medium text-slate-600 dark:text-slate-400 bg-white/50 dark:bg-slate-800/50 p-2 rounded-lg border border-slate-200/50 dark:border-slate-700/50">
                        <span className="font-bold">Contents: </span>
                        {op.items.map((i) => `${i.productName} (${i.quantity} ${i.unit || 'pcs'} - ${i.condition})`).join(', ')}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-200 dark:border-slate-800">
                    <span className="text-slate-400 font-mono text-[11px]">{op.dateAD}</span>
                    <div className="flex items-center gap-2">
                      <span className={`font-bold font-mono text-indigo-600 dark:text-indigo-400`}>
                        {formatNPR(op.totalValue)}
                      </span>
                      {op.status !== 'RECEIVED' && op.status !== 'CANCELLED' && isOperationAllowed('branch-pullout-dispatch', currentUser?.role) && (
                        <button
                          onClick={() => handleReversePullout(op)}
                          className="px-2.5 py-1 rounded-lg bg-rose-600 text-white font-bold text-[10px] hover:bg-rose-500 shadow-xs cursor-pointer"
                          title="Reverse the dispatch and return its units and serials to the source branch"
                        >
                          Reverse
                        </button>
                      )}
                      {op.status !== 'RECEIVED' && isOperationAllowed('wh-receive-pullouts', currentUser?.role) && onReceiveOperation && (
                        <button
                          onClick={async () => {
                            if (await confirmDialog(`Confirm receipt of Pullout Bin ${op.referenceNumber} into Warehouse Stock?`)) {
                              await onReceiveOperation(op.id);
                            }
                          }}
                          className="px-2.5 py-1 rounded-lg bg-indigo-600 text-white font-bold text-[10px] hover:bg-indigo-500 shadow-xs cursor-pointer"
                        >
                          Receive at WH001
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
