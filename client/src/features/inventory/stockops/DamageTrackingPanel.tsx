import React, { useMemo, useState } from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import {
  StockOperation,
} from '../../../types';
import { api } from '../../../services/api';
import { TablePagination } from '../../../components/common/TablePagination';
import { formatNPR } from '../../../utils/nprFormat';
import {
  AlertTriangle,
  ShieldAlert,
  Undo2,
} from 'lucide-react';

/**
 * DamageTrackingPanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (FRONTEND-AUDIT.md Section G: commit 1 moved the JSX verbatim; commit 2
 * relocated this panel's state, effects and handlers here as well). The
 * panel renders the exact conditional block the host used to render inline;
 * everything it does not own comes from the StockOperations context.
 */
export const DamageTrackingPanel: React.FC = () => {
  const { activeTab, allCombinedOps, currentUser, filteredOperations, isSuperOrInventory, onReverseOperation, promptDialog, showToast } = useStockOperationsCtx();

  // 2b. Reverse a recorded damage entry (Safe-guarded; Super Admin / Inventory Manager only).
  const canReverseDamage =
    currentUser?.role === 'SUPER_ADMIN' || currentUser?.role === 'INVENTORY_MANAGER';

  const isReversibleDamageOp = (op: StockOperation): boolean =>
    op.type === 'DAMAGE' && op.status !== 'CANCELLED' && !op.id.startsWith('syn-');

  const handleReverseDamageRecord = async (op: StockOperation) => {
    if (!canReverseDamage) {
      showToast('Only Super Admin and Inventory Manager can reverse damage records.');
      return;
    }
    const reason = await promptDialog(
      `You are about to reverse damage record ${op.referenceNumber}.\n\n` +
        `● Product: ${op.productName || op.productId}\n` +
        `● Units: ${Math.abs(op.quantityChanged || 0)} Pcs\n` +
        `● Valuation: ${formatNPR(op.totalValue)}\n` +
        `● Branch: ${op.branchId}\n\n` +
        `Reversing restores the units back to available stock and marks this record CANCELLED. ` +
        `This action is irreversible and is logged to the audit trail under your credentials.`,
      {
        title: 'Reverse Damage Entry — Safeguard',
        confirmLabel: 'Reverse & Restore Stock',
        cancelLabel: 'Keep Record',
        placeholder: 'Required: reason for reversal (audit trail)',
      }
    );
    if (reason === null) return;
    if (!reason.trim()) {
      showToast('Reversal aborted — a reason is required as a safeguard.');
      return;
    }
    try {
      if (onReverseOperation) {
        await onReverseOperation(op.id, reason.trim());
      } else {
        await api.reverseStockOperation(op.id, reason.trim(), currentUser);
      }
      showToast(`Damage record ${op.referenceNumber} reversed. Units restored to available stock.`);
    } catch (err: any) {
      showToast(`Reversal failed: ${err.message || 'Unknown error'}`);
    }
  };


  // Damage-log register pagination: the DAMAGE_TRACKING tab renders this list
  // without any server-side window, so cap the DOM with client pagination
  // (same pattern as DamagedStockTracking).
  const [damageLogPage, setDamageLogPage] = useState(1);
  const [damageLogPageSize, setDamageLogPageSize] = useState(20);
  const damageLogOps = useMemo(() => {
    if (activeTab !== 'DAMAGE_TRACKING') return [];
    return allCombinedOps.filter((op) => op.type === 'DAMAGE' || op.type === 'DISPOSAL');
  }, [allCombinedOps, activeTab]);
  const damageLogPageCount = Math.max(1, Math.ceil(damageLogOps.length / damageLogPageSize));
  const safeDamageLogPage = Math.min(damageLogPage, damageLogPageCount);
  const pagedDamageLogOps = useMemo(
    () => damageLogOps.slice((safeDamageLogPage - 1) * damageLogPageSize, safeDamageLogPage * damageLogPageSize),
    [damageLogOps, safeDamageLogPage, damageLogPageSize]
  );

  return (
    <>
      {activeTab === 'DAMAGE_TRACKING' && (
        <div className="space-y-3">
          {!isSuperOrInventory && (
            <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-300 flex items-center gap-2.5 text-xs font-medium">
              <ShieldAlert className={`h-5 w-5 flex-shrink-0 text-amber-500 dark:text-amber-400`} />
              <span>
                <strong>Branch Role Restriction Active:</strong> As a branch user, you can label damaged stock exclusively for your assigned branch stock. Super Admins and Inventory Controllers can manage damage across all branches.
              </span>
            </div>
          )}

          {/* Damage aggregate strip — deliberately NOT StatCards here: the
              damage log renders below on the same screen, so a full KPI row
              pushed it below the fold. One slim line in the table toolbar
              keeps the aggregates visible at zero vertical cost. */}
          <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 rounded-xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800 text-xs`}>
            <span className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300">
              <AlertTriangle className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400" />
              {filteredOperations.length} Records
            </span>
            <span className="font-mono font-bold text-amber-600 dark:text-amber-400">
              {filteredOperations.reduce((sum, op) => sum + Math.abs(op.quantityChanged || 1), 0)} Pcs
            </span>
            <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
              {formatNPR(filteredOperations.reduce((sum, op) => sum + (op.totalValue || 0), 0))} Est. Loss
            </span>
          </div>

          <div className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className={`font-bold text-sm flex items-center gap-2 text-slate-900 dark:text-white`}>
                <AlertTriangle className={`h-4 w-4 text-rose-500 dark:text-rose-400`} />
                <span>Locally Tagged Damaged Stock Logs</span>
              </h3>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className={`font-bold text-[9px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/80 dark:text-slate-400 dark:border-slate-800`}>
                  <tr>
                    <th className="px-2.5 py-1.5">Reference #</th>
                    <th className="px-2.5 py-1.5">Op Type</th>
                    <th className="px-2.5 py-1.5">Branch</th>
                    <th className="px-2.5 py-1.5">Product Name</th>
                    <th className="px-2.5 py-1.5">Qty</th>
                    <th className="px-2.5 py-1.5">Valuation</th>
                    <th className="px-2.5 py-1.5">Reason & Method</th>
                    <th className="px-2.5 py-1.5">Inspector / Officer</th>
                    <th className="px-2.5 py-1.5">Actions</th>
                  </tr>
                </thead>
                <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                  {pagedDamageLogOps.map((op) => (
                    <tr key={op.id} className={`hover:bg-slate-200 dark:hover:bg-slate-800/40 ${op.status === 'CANCELLED' ? 'opacity-60' : ''}`}>
                      <td className={`p-2.5 font-mono font-bold text-rose-600 dark:text-rose-400`}>{op.referenceNumber}</td>
                      <td className="p-2.5">
                        {op.type === 'DISPOSAL' ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-rose-600 text-white shadow-xs">
                            🔥 DISPOSAL
                          </span>
                        ) : op.status === 'CANCELLED' ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-slate-600 text-white shadow-xs">
                            <Undo2 className="h-3 w-3" />
                            REVERSED
                          </span>
                        ) : (
                          <span className={`inline-flex items-center gap-1 text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30`}>
                            ⚠️ DAMAGED
                          </span>
                        )}
                      </td>
                      <td className="p-2.5 font-semibold text-slate-800 dark:text-slate-200">{op.branchId}</td>
                      <td className="p-2.5 font-medium text-slate-900 dark:text-white">{op.productName}</td>
                      <td className={`p-2.5 font-mono font-bold text-rose-600 dark:text-rose-400`}>{Math.abs(op.quantityChanged || 1)} Pcs</td>
                      <td className="p-2.5 font-mono font-bold text-slate-800 dark:text-slate-200">
                        <div>{formatNPR(op.totalValue)}</div>
                        {op.netWriteOffLoss !== undefined && (
                          <div className={`text-[10px] font-normal text-rose-500 dark:text-rose-400`}>
                            Net Loss: {formatNPR(op.netWriteOffLoss)}
                          </div>
                        )}
                      </td>
                      <td className="p-2.5 text-slate-500 text-[11px]">{op.reason}</td>
                      <td className="p-2.5 font-medium text-slate-600 dark:text-slate-400">{op.inspectorName}</td>
                      <td className="p-2.5">
                        {op.status === 'CANCELLED' ? (
                          <div className="text-[9px] font-semibold text-slate-400 leading-tight">
                            <div>Reversed by {op.reversedBy || 'Admin'}</div>
                            {op.reversedAtAD && <div>{op.reversedAtAD}</div>}
                          </div>
                        ) : isReversibleDamageOp(op) && canReverseDamage ? (
                          <button
                            type="button"
                            title="Reverse this damage entry (restores units to available stock)"
                            onClick={() => handleReverseDamageRecord(op)}
                            className="inline-flex items-center gap-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/40 text-amber-700 dark:text-amber-300 px-2 py-1 text-[10px] font-bold transition-colors cursor-pointer"
                          >
                            <Undo2 className="h-3.5 w-3.5" />
                            Reverse
                          </button>
                        ) : (
                          <span className="text-[10px] italic text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <TablePagination
            page={safeDamageLogPage}
            pageCount={damageLogPageCount}
            totalItems={damageLogOps.length}
            rangeStart={damageLogOps.length === 0 ? 0 : (safeDamageLogPage - 1) * damageLogPageSize + 1}
            rangeEnd={Math.min(safeDamageLogPage * damageLogPageSize, damageLogOps.length)}
            pageSize={damageLogPageSize}
            onPageChange={(p) => setDamageLogPage(Math.max(1, p))}
            onPageSizeChange={(s) => {
              setDamageLogPageSize(s);
              setDamageLogPage(1);
            }}
          />
        </div>
      )}
    </>
  );
};
