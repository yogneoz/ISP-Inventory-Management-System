import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { ModalPanel } from '../common/ModalPanel';
import { useDialog } from '../common/DialogProvider';
import { money } from './statementFormat';
import {
  getLenderTdsWorklist,
  recordLenderTdsEvidence,
  type LenderTdsWorklist as LenderTdsWorklistData,
  type LenderTdsWorklistEntry,
  type TdsExemptionReason,
} from '../../services/api/lenders';
import type { User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';
import { TDS_REASON_LABEL, TDS_REFERENCE_REQUIRED } from '../../utils/tdsExemption';

interface LenderTdsWorklistProps {
  currentUser?: User | null;
}

const inputClass =
  'h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:text-white';
const labelClass = 'mb-1 block text-[11px] font-semibold text-slate-600 dark:text-slate-300';

export const LenderTdsWorklist: React.FC<LenderTdsWorklistProps> = ({ currentUser }) => {
  const { alert: alertDialog } = useDialog();
  const canManage = isOperationAllowed('gl-subledger-manage', currentUser?.role);
  const [draft, setDraft] = useState({ from: '', to: '' });
  const [applied, setApplied] = useState({ from: '', to: '' });
  const [data, setData] = useState<LenderTdsWorklistData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<LenderTdsWorklistEntry | null>(null);
  const [reason, setReason] = useState<'' | TdsExemptionReason>('');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (range: { from: string; to: string }) => {
    setLoading(true);
    setError('');
    try {
      const result = await getLenderTdsWorklist({
        from: range.from || undefined,
        to: range.to || undefined,
      });
      setData(result);
    } catch (err: any) {
      setError(err?.message || 'The TDS cleanup worklist could not be read.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(applied);
  }, [applied, load]);

  const openEvidence = (row: LenderTdsWorklistEntry) => {
    setSelected(row);
    setReason('');
    setReference('');
  };

  const submitEvidence = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    if (!reason) {
      alertDialog('Choose the reason this repayment carried no TDS.');
      return;
    }
    if (reason === 'NO_INTEREST') {
      alertDialog('NO_INTEREST is only for a repayment that paid no interest.');
      return;
    }
    if (TDS_REFERENCE_REQUIRED[reason] && !reference.trim()) {
      alertDialog('Record the certificate, agreement clause or notification relied on.');
      return;
    }
    setSaving(true);
    try {
      await recordLenderTdsEvidence(selected.id, {
        tdsExemptionReason: reason,
        tdsExemptionReference: reference.trim(),
      });
      setSelected(null);
      await load(applied);
    } catch (err: any) {
      alertDialog(`Failed to record the TDS evidence: ${err?.message || 'Database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const entries = data?.entries || [];
  const totals = data?.totals || { count: 0, principal: 0, interest: 0, cash: 0 };
  const reasonOptions = (Object.keys(TDS_REASON_LABEL) as TdsExemptionReason[]).filter(
    (value) => value !== 'NO_INTEREST'
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-md dark:border-slate-800 dark:bg-[#0f1218]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
        <div>
          <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-700 dark:text-slate-200">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            Legacy zero-TDS cleanup
          </h2>
          <p className="mt-0.5 text-[10px] text-slate-500">
            Posted repayments with interest and no TDS withheld, but no recorded reason.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className={labelClass}>From</label>
            <input
              type="date"
              value={draft.from}
              onChange={(event) => setDraft({ ...draft, from: event.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>To</label>
            <input
              type="date"
              value={draft.to}
              onChange={(event) => setDraft({ ...draft, to: event.target.value })}
              className={inputClass}
            />
          </div>
          <button
            type="button"
            onClick={() => setApplied({ ...draft })}
            className="flex h-9 cursor-pointer items-center gap-1 rounded-lg bg-indigo-600 px-2.5 text-[11px] font-semibold text-white hover:bg-indigo-500"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft({ from: '', to: '' });
              setApplied({ from: '', to: '' });
            }}
            className="h-9 cursor-pointer rounded-lg border border-slate-300 px-2.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => void load(applied)}
            disabled={loading}
            className="flex h-9 cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 border-b border-slate-200 px-3 py-2 sm:grid-cols-4 dark:border-slate-800">
        {[
          ['Unexplained repayments', String(totals.count)],
          ['Principal', money(totals.principal)],
          ['Interest without withholding', money(totals.interest)],
          ['Cash paid', money(totals.cash)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg bg-slate-50 px-2.5 py-2 dark:bg-slate-800/60">
            <p className="text-[10px] font-bold uppercase text-slate-500">{label}</p>
            <p className="mt-0.5 font-mono text-xs font-bold text-slate-900 dark:text-white">
              {value}
            </p>
          </div>
        ))}
      </div>

      <div className="mx-3 mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-[10px] text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-300">
        Recording evidence changes only the explanation attached to the repayment. The posted journal,
        cash paid and tax withheld are not rewritten.
      </div>

      {error ? (
        <div className="m-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      <div className="mt-2 min-h-0 flex-1 overflow-auto px-3 pb-3">
        {loading && !data ? (
          <div className="flex items-center justify-center p-8 text-xs text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading cleanup worklist…
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="w-full min-w-[1000px] border-collapse text-left text-[11px]">
              <thead className="bg-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:bg-[#12161f] dark:text-slate-400">
                <tr>
                  <th className="px-2 py-1.5">Date</th>
                  <th className="px-2 py-1.5">Lender</th>
                  <th className="px-2 py-1.5">Loan / repayment</th>
                  <th className="px-2 py-1.5">Branch</th>
                  <th className="px-2 py-1.5 text-right">Principal</th>
                  <th className="px-2 py-1.5 text-right">Interest</th>
                  <th className="px-2 py-1.5 text-right">Cash</th>
                  <th className="px-2 py-1.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-6 text-center text-slate-500">
                      <ShieldCheck className="mx-auto mb-1.5 h-6 w-6 text-emerald-500" />
                      {loading
                        ? 'Refreshing the cleanup worklist…'
                        : 'No unexplained legacy zero-TDS repayments in this period.'}
                    </td>
                  </tr>
                ) : (
                  entries.map((row) => (
                    <tr key={row.id}>
                      <td className="px-2 py-1.5">
                        <div>{row.dateAD}</div>
                        <div className="text-[10px] text-slate-500">{row.dateBS}</div>
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="font-mono text-[10px] font-bold text-indigo-600 dark:text-indigo-400">
                          {row.lenderCode}
                        </div>
                        <div className="font-semibold text-slate-800 dark:text-slate-200">
                          {row.lenderName}
                        </div>
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="font-mono text-[10px]">{row.loanNumber}</div>
                        <div className="text-[10px] text-slate-500">
                          {row.txnNumber} · {row.journalNo}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-slate-600 dark:text-slate-400">
                        {row.branchCode}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {money(row.principalAmount)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono font-bold">
                        {money(row.interestAmount)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">{money(row.cashAmount)}</td>
                      <td className="px-2 py-1.5 text-right">
                        {canManage ? (
                          <button
                            type="button"
                            onClick={() => openEvidence(row)}
                            className="cursor-pointer rounded-lg border border-amber-300 px-2 py-1 text-[10px] font-bold text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-950/30"
                          >
                            Record evidence
                          </button>
                        ) : (
                          <span className="text-[10px] text-slate-400">View only</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label="Record TDS exemption evidence"
            onClose={() => setSelected(null)}
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold">Record TDS exemption evidence</h3>
                <p className="mt-0.5 text-[10px] text-slate-500">
                  {selected.lenderName} · {selected.txnNumber} · {selected.dateAD}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-2.5 text-[11px] dark:bg-slate-800/60">
              <div>
                <span className="text-slate-500">Loan</span>
                <div className="font-mono font-bold">{selected.loanNumber}</div>
              </div>
              <div>
                <span className="text-slate-500">Interest</span>
                <div className="font-mono font-bold">{money(selected.interestAmount)}</div>
              </div>
            </div>

            <form onSubmit={submitEvidence} className="space-y-3">
              <div>
                <label className={labelClass}>Exemption reason *</label>
                <select
                  value={reason}
                  onChange={(event) => setReason(event.target.value as '' | TdsExemptionReason)}
                  className={inputClass}
                  required
                >
                  <option value="">Choose reason</option>
                  {reasonOptions.map((value) => (
                    <option key={value} value={value}>
                      {TDS_REASON_LABEL[value]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Evidence / reference *</label>
                <input
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  placeholder="Certificate, agreement clause or notification"
                  className={inputClass}
                  required
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="cursor-pointer rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Record evidence'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      ) : null}
    </section>
  );
};
