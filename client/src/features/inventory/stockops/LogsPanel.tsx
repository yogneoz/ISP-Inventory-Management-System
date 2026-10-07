import React from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import {
  Branch,
  Product,
} from '../../../types';
import { formatNPR } from '../../../utils/nprFormat';

/**
 * LogsPanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (decomposition audit, FRONTEND-AUDIT.md Section G, "pure move" step).
 * The host owns ALL state and handlers; this panel destructures them from
 * the StockOperations context and renders the exact conditional block the
 * host used to render inline. No logic changes.
 */
export const LogsPanel: React.FC = () => {
  const { activeTab, operations } = useStockOperationsCtx();
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
