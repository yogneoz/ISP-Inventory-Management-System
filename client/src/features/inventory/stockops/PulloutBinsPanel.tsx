import React from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import { formatNPR } from '../../../utils/nprFormat';
import { isOperationAllowed } from '../../../utils/permissions';
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
  const { activeTab, confirmDialog, currentUser, filteredOperations, onReceiveOperation } = useStockOperationsCtx();
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
