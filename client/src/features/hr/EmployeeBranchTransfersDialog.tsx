/**
 * Directory-wide employee branch-transfer requests and history.
 *
 * Opened from the Employee Directory header. The branch and date filters are
 * applied by the server, which also enforces the caller's branch scope. A
 * branch filter matches either side of a move, so selecting Pokhara shows both
 * arrivals and departures. Managers with the right role decide pending requests
 * here; approval moves the employee, rejection leaves the branch untouched.
 */
import React, { useEffect, useState } from 'react';
import {
  Building2,
  CalendarDays,
  CheckCircle2,
  Clock3,
  History,
  RotateCcw,
  X,
  XCircle,
} from 'lucide-react';
import { ModalPanel } from '../../components/common/ModalPanel';
import { useDialog } from '../../components/common/DialogProvider';
import { api } from '../../services/api';
import type { HrEmployeeBranchTransferLogRow } from '../../services/api';
import type { Branch } from '../../types';

interface EmployeeBranchTransfersDialogProps {
  branches: Branch[];
  initialBranchId?: string;
  canApprove: boolean;
  currentUserEmail?: string | null;
  onEmployeeTransferred?: () => void | Promise<void>;
  onClose: () => void;
}

const inputClass =
  'h-9 w-full rounded-lg border border-slate-300 bg-transparent px-2.5 text-xs dark:border-slate-700';
const labelClass =
  'mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400';

export const EmployeeBranchTransfersDialog: React.FC<EmployeeBranchTransfersDialogProps> = ({
  branches,
  initialBranchId = 'ALL',
  canApprove,
  currentUserEmail,
  onEmployeeTransferred,
  onClose,
}) => {
  const { confirm: confirmDialog, prompt: promptDialog } = useDialog();
  const [branchId, setBranchId] = useState(initialBranchId || 'ALL');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [rows, setRows] = useState<HrEmployeeBranchTransferLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [decidingId, setDecidingId] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const transfers = await api.getHrBranchTransfers({
        branchId,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
      });
      setRows(Array.isArray(transfers) ? transfers : []);
      setError('');
    } catch (err: any) {
      setError(err?.message || 'The branch transfer history could not be read.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Filters are server-side: every change is a fresh scoped read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, dateFrom, dateTo]);

  const hasFilters = branchId !== 'ALL' || Boolean(dateFrom) || Boolean(dateTo);
  const clearFilters = () => {
    setBranchId('ALL');
    setDateFrom('');
    setDateTo('');
  };

  const decide = async (
    transfer: HrEmployeeBranchTransferLogRow,
    decision: 'approve' | 'reject'
  ) => {
    let note: string | null = null;
    if (decision === 'approve') {
      const ok = await confirmDialog(
        `Move ${transfer.employeeName} from ${transfer.fromBranchName} to ${transfer.toBranchName}, effective ${transfer.effectiveDateAD || 'the recorded date'}?`,
        { title: 'Approve transfer', confirmLabel: 'Approve transfer' }
      );
      if (!ok) return;
    } else {
      const reason = await promptDialog(
        `Why are you rejecting ${transfer.employeeName}'s transfer to ${transfer.toBranchName}?`,
        { title: 'Reject transfer' }
      );
      if (reason === null) return;
      if (!reason.trim()) {
        setError('Enter a reason for rejecting the transfer.');
        return;
      }
      note = reason.trim();
    }

    setDecidingId(transfer.id);
    setError('');
    try {
      if (decision === 'approve') {
        await api.approveHrBranchTransfer(transfer.id, null);
        await onEmployeeTransferred?.();
      } else {
        await api.rejectHrBranchTransfer(transfer.id, note);
      }
      await load();
    } catch (err: any) {
      setError(err?.message || `The transfer could not be ${decision === 'approve' ? 'approved' : 'rejected'}.`);
    } finally {
      setDecidingId('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <ModalPanel
        label="Branch transfer history"
        onClose={onClose}
        className="max-h-[88vh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span className="rounded-xl bg-indigo-50 p-2 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300">
              <History className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-base font-bold">Transfers & approvals</h3>
              <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                Pending requests and recorded employee moves. Approval changes the branch;
                rejection leaves it untouched. Filters match either side of the move.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 flex flex-wrap items-end gap-2.5 rounded-xl border border-slate-200 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-900/40">
          <label className="block">
            <span className={labelClass}>Branch</span>
            <select
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
              className={`${inputClass} min-w-[210px]`}
            >
              <option value="ALL">All branches in my scope</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelClass}>From date</span>
            <input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(event) => setDateFrom(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>To date</span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(event) => setDateTo(event.target.value)}
              className={inputClass}
            />
          </label>
          {hasFilters ? (
            <button
              type="button"
              onClick={clearFilters}
              className="flex h-9 cursor-pointer items-center gap-1.5 rounded-xl border border-rose-300 px-3 text-xs font-bold text-rose-600 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950/30"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Clear
            </button>
          ) : null}
          <span className="ml-auto text-[10px] font-semibold text-slate-500 dark:text-slate-400">
            {loading ? 'Loading…' : `${rows.length} request${rows.length === 1 ? '' : 's'}`}
          </span>
        </div>

        {error ? (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-200">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => void load()}
              className="cursor-pointer rounded-lg border border-rose-300 px-2 py-1 font-semibold dark:border-rose-800"
            >
              Retry
            </button>
          </div>
        ) : null}

        <div className="max-h-[52vh] overflow-auto rounded-xl border border-slate-200 dark:border-slate-800">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
              <tr>
                <th className="px-2.5 py-1.5">Effective</th>
                <th className="px-2.5 py-1.5">Employee</th>
                <th className="px-2.5 py-1.5">Status</th>
                <th className="px-2.5 py-1.5">From</th>
                <th className="px-2.5 py-1.5">To</th>
                <th className="px-2.5 py-1.5">Reason</th>
                <th className="px-2.5 py-1.5">Requested by</th>
                <th className="px-2.5 py-1.5">Decision</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-slate-500">
                    {loading
                      ? 'Loading transfer requests…'
                      : error
                        ? 'The transfer history could not be loaded — use Retry above.'
                        : hasFilters
                          ? 'No transfer requests match these filters.'
                          : 'No transfer requests have been recorded yet.'}
                  </td>
                </tr>
              ) : (
                rows.map((transfer) => (
                  <tr
                    key={transfer.id}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/40"
                  >
                    <td className="whitespace-nowrap px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays className="h-3 w-3 text-slate-400" />
                        {transfer.effectiveDateAD ||
                          new Date(transfer.createdAt).toLocaleDateString()}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <p className="font-bold text-slate-900 dark:text-white">
                        {transfer.employeeName}
                      </p>
                      <p className="font-mono text-[10px] text-indigo-600 dark:text-indigo-400">
                        {transfer.employeeCode}
                      </p>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                          transfer.status === 'PENDING'
                            ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300'
                            : transfer.status === 'APPROVED'
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300'
                              : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300'
                        }`}
                      >
                        {transfer.status === 'PENDING' ? (
                          <Clock3 className="h-3 w-3" />
                        ) : transfer.status === 'APPROVED' ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <XCircle className="h-3 w-3" />
                        )}
                        {transfer.status}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        <Building2 className="h-3 w-3 text-slate-400" />
                        {transfer.fromBranchName}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        <Building2 className="h-3 w-3 text-slate-400" />
                        {transfer.toBranchName}
                      </span>
                    </td>
                    <td className="max-w-[220px] px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      {transfer.reason || <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-2.5 py-1.5 text-[10px] text-slate-500 dark:text-slate-400">
                      {transfer.transferredBy || 'System'}
                    </td>
                    <td className="min-w-[170px] px-2.5 py-1.5 text-[10px] text-slate-500 dark:text-slate-400">
                      {transfer.status === 'PENDING' ? (
                        canApprove &&
                        (!currentUserEmail ||
                          currentUserEmail.toLowerCase() !==
                            (transfer.transferredBy || '').toLowerCase()) ? (
                          <div className="flex flex-wrap gap-1">
                            <button
                              type="button"
                              disabled={decidingId === transfer.id}
                              onClick={() => void decide(transfer, 'approve')}
                              className="cursor-pointer rounded-lg bg-emerald-600 px-2 py-1 font-bold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {decidingId === transfer.id ? 'Saving…' : 'Approve'}
                            </button>
                            <button
                              type="button"
                              disabled={decidingId === transfer.id}
                              onClick={() => void decide(transfer, 'reject')}
                              className="cursor-pointer rounded-lg border border-rose-300 px-2 py-1 font-bold text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30"
                            >
                              Reject
                            </button>
                          </div>
                        ) : (
                          <span className="italic">
                            {canApprove ? 'Awaiting another manager' : 'Awaiting manager'}
                          </span>
                        )
                      ) : (
                        <div>
                          <p className="font-semibold text-slate-600 dark:text-slate-300">
                            {transfer.approvedBy
                              ? `${transfer.status === 'APPROVED' ? 'Approved' : 'Rejected'} by ${transfer.approvedBy}`
                              : 'Recorded before the approval workflow'}
                          </p>
                          {transfer.approvedAt ? (
                            <p>{new Date(transfer.approvedAt).toLocaleString()}</p>
                          ) : null}
                          {transfer.decisionNote ? (
                            <p className="mt-0.5 text-slate-500 dark:text-slate-400">
                              {transfer.decisionNote}
                            </p>
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </ModalPanel>
    </div>
  );
};

export default EmployeeBranchTransfersDialog;
