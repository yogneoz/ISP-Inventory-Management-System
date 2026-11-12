/**
 * Dedicated employee-transfer process.
 *
 * A transfer is a named event, not a side effect of editing the employee
 * profile: the operator picks the Branch Management destination, the effective
 * date and a reason, and the server records a pending request. An authorized
 * manager then approves or rejects it before the employee's branch changes.
 */
import React, { useState } from 'react';
import { ArrowRightLeft, Building2, Clock3, X } from 'lucide-react';
import { ModalPanel } from '../../components/common/ModalPanel';
import { api } from '../../services/api';
import type { EmployeeRecord } from '../../services/api';
import type { Branch } from '../../types';
import { localTodayAD } from '../../utils/localDate';

interface EmployeeTransferDialogProps {
  employee: EmployeeRecord;
  branches: Branch[];
  onClose: () => void;
  onTransferred: () => void | Promise<void>;
}

const inputClass =
  'h-9 w-full rounded-lg border border-slate-300 bg-transparent px-2.5 text-xs dark:border-slate-700 disabled:opacity-60';
const labelClass =
  'mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400';

export const EmployeeTransferDialog: React.FC<EmployeeTransferDialogProps> = ({
  employee,
  branches,
  onClose,
  onTransferred,
}) => {
  const currentBranch = branches.find((branch) => branch.id === employee.branchId);
  const destinations = branches.filter((branch) => branch.id !== employee.branchId);
  const today = localTodayAD();
  const [branchId, setBranchId] = useState('');
  const [effectiveDateAD, setEffectiveDateAD] = useState(today);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    const target = destinations.find((branch) => branch.id === branchId);
    if (!target) {
      setError('Choose the destination branch.');
      return;
    }
    if (!effectiveDateAD) {
      setError('Choose the effective date.');
      return;
    }
    if (effectiveDateAD > today) {
      setError('The effective date cannot be in the future.');
      return;
    }
    if (reason.trim().length < 3) {
      setError('Enter a reason for the transfer.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.transferEmployee(employee.id, {
        branchId: target.id,
        effectiveDateAD,
        reason: reason.trim(),
      });
      await onTransferred();
      setSubmitted(true);
    } catch (err: any) {
      setError(err?.message || 'The transfer request could not be submitted.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <ModalPanel
        label={`Transfer ${employee.name}`}
        onClose={onClose}
        className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span className="rounded-xl bg-indigo-50 p-2 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300">
              <ArrowRightLeft className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-base font-bold">Transfer employee</h3>
              <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                {employee.name} · <span className="font-mono">{employee.employeeCode}</span>
              </p>
              <p className="mt-1 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                Manager approval is required before the branch changes.
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

        <div className="mb-4 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-xs dark:border-slate-800 dark:bg-slate-900/40">
          <Building2 className="h-4 w-4 text-slate-400" />
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Current branch
            </p>
            <p className="font-semibold">{currentBranch?.name || employee.branchId}</p>
          </div>
        </div>

        {submitted ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-200">
            <p className="flex items-center gap-2 text-xs font-bold">
              <Clock3 className="h-4 w-4" />
              Transfer request submitted for approval
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed">
              {employee.name} remains in {currentBranch?.name || employee.branchId} until an
              authorized manager approves the move. Track the decision under Branch transfers.
            </p>
          </div>
        ) : destinations.length === 0 ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
            Branch Management has no other branch to transfer this employee to.
          </p>
        ) : (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Destination branch *</label>
              <select
                value={branchId}
                onChange={(event) => setBranchId(event.target.value)}
                className={inputClass}
                autoFocus
              >
                <option value="">Select destination</option>
                {destinations.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Effective date *</label>
              <input
                type="date"
                value={effectiveDateAD}
                max={today}
                min={employee.joiningDateAD || undefined}
                onChange={(event) => setEffectiveDateAD(event.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Reason *</label>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                rows={3}
                placeholder="e.g. Staffing requirement at the receiving branch"
                className="w-full rounded-lg border border-slate-300 bg-transparent px-2.5 py-2 text-xs dark:border-slate-700"
              />
              <p className="mt-1 text-[10px] text-slate-400">{reason.length}/500</p>
            </div>
          </div>
        )}

        {error ? (
          <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
          {submitted ? (
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={saving || destinations.length === 0}
                className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
                {saving ? 'Submitting…' : 'Submit for approval'}
              </button>
            </>
          )}
        </div>
      </ModalPanel>
    </div>
  );
};

export default EmployeeTransferDialog;
