/**
 * Supplemental forecast inputs: recurring journals, payroll commitments and
 * manual planning rows. The server owns every projected amount; this panel
 * only edits the dated manual rows and explains what each source contributed.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Pencil, Plus, Trash2, X } from 'lucide-react';
import { api } from '../../services/api';
import type {
  CashFlowForecastDirection,
  CashFlowForecastResponse,
  CashFlowManualInput,
} from '../../services/api/accounting';
import type { Branch } from '../../types';
import { localTodayAD } from '../../utils/localDate';
import { isOperationAllowed } from '../../utils/permissions';
import { money } from './statementFormat';

interface CashFlowForecastSourcesProps {
  forecast: CashFlowForecastResponse | null;
  branches: Branch[];
  scopeBranchId: string;
  dateMode: 'BS' | 'AD';
  currentUser?: { role?: string } | null;
  onChanged: () => void;
}

interface ManualForm {
  branchId: string;
  expectedDateAD: string;
  direction: CashFlowForecastDirection;
  amountFormula: string;
  description: string;
}

function blankForm(branchId: string): ManualForm {
  return {
    branchId,
    expectedDateAD: localTodayAD(),
    direction: 'OUTFLOW',
    amountFormula: '',
    description: '',
  };
}

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white';
const labelClass =
  'mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400';

export const CashFlowForecastSources: React.FC<CashFlowForecastSourcesProps> = ({
  forecast,
  branches,
  scopeBranchId,
  dateMode,
  currentUser,
  onChanged,
}) => {
  const canPost = isOperationAllowed('gl-post', currentUser?.role);
  const scopedBranches = useMemo(
    () => branches.filter((branch) => branch.active && branch.id !== 'ALL'),
    [branches]
  );
  const initialBranch = useMemo(() => {
    if (scopeBranchId && scopeBranchId !== 'ALL' && scopedBranches.some((b) => b.id === scopeBranchId)) {
      return scopeBranchId;
    }
    return scopedBranches[0]?.id || '';
  }, [scopeBranchId, scopedBranches]);
  const [branchId, setBranchId] = useState(initialBranch);
  const [form, setForm] = useState<ManualForm>(() => blankForm(initialBranch));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setBranchId(initialBranch);
    setForm((current) =>
      editingId ? current : { ...current, branchId: initialBranch }
    );
  }, [initialBranch, editingId]);

  if (!forecast) return null;

  const beginCreate = () => {
    setEditingId(null);
    setError('');
    setNotice('');
    setForm(blankForm(branchId || initialBranch));
  };

  const beginEdit = (input: CashFlowManualInput) => {
    setEditingId(input.id);
    setError('');
    setNotice('');
    setForm({
      branchId: input.branchId,
      expectedDateAD: input.expectedDateAD,
      direction: input.direction,
      amountFormula: input.amountFormula,
      description: input.description,
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (!form.amountFormula.trim()) throw new Error('Enter an amount formula.');
      if (!form.description.trim()) throw new Error('Enter a description.');
      if (editingId) {
        await api.updateCashFlowManualInput(editingId, {
          expectedDateAD: form.expectedDateAD,
          direction: form.direction,
          amountFormula: form.amountFormula,
          description: form.description,
        });
        setNotice('Manual forecast input updated.');
      } else {
        await api.createCashFlowManualInput({
          branchId: form.branchId,
          expectedDateAD: form.expectedDateAD,
          direction: form.direction,
          amountFormula: form.amountFormula,
          description: form.description,
        });
        setNotice('Manual forecast input saved.');
      }
      setEditingId(null);
      setForm(blankForm(branchId || initialBranch));
      onChanged();
    } catch (err: any) {
      setError(err?.message || 'The manual forecast input could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (input: CashFlowManualInput) => {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (!window.confirm(`Delete "${input.description}" from the forecast?`)) return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.deleteCashFlowManualInput(input.id);
      if (editingId === input.id) {
        setEditingId(null);
        setForm(blankForm(branchId || initialBranch));
      }
      setNotice('Manual forecast input deleted.');
      onChanged();
    } catch (err: any) {
      setError(err?.message || 'The manual forecast input could not be deleted.');
    } finally {
      setSaving(false);
    }
  };

  const sources = [
    { key: 'recurring' as const, label: 'Recurring journals', tone: 'indigo' },
    { key: 'payroll' as const, label: 'Payroll commitments', tone: 'rose' },
    { key: 'manual' as const, label: 'Manual inputs', tone: 'emerald' },
  ];

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
      <div className="border-b border-slate-200 px-3 py-3 dark:border-slate-800">
        <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Forecast inputs</h3>
        <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
          Recurring journals come from active templates, payroll from unpaid approved/posted runs,
          and manual rows from this register. Closed-period rows are excluded from the buckets.
        </p>
      </div>

      <div className="grid gap-2 p-3 md:grid-cols-3">
        {sources.map((source) => {
          const summary = forecast.sources[source.key];
          return (
            <div
              key={source.key}
              className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-[11px] dark:border-slate-800 dark:bg-slate-900/40"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-slate-700 dark:text-slate-200">{source.label}</p>
                <span className="font-mono text-xs font-semibold text-slate-800 dark:text-slate-200">
                  {money(summary.includedAmount)}
                </span>
              </div>
              <p className="mt-1 text-slate-500 dark:text-slate-400">
                {summary.includedCount} of {summary.scheduledCount} included · {money(summary.overdueAmount)} overdue
              </p>
              {summary.beyondHorizon.count > 0 && (
                <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                  {money(summary.beyondHorizon.amount)} beyond horizon ({summary.beyondHorizon.count})
                </p>
              )}
              {summary.closedPeriodExcluded.count > 0 && (
                <p className="mt-0.5 text-rose-700 dark:text-rose-300">
                  {money(summary.closedPeriodExcluded.amount)} closed-period excluded ({summary.closedPeriodExcluded.count})
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-slate-200 px-3 py-3 dark:border-slate-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
              Manual inputs
            </h4>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Dated planning adjustments only. They never post to the ledger.
            </p>
          </div>
          {canPost && (
            <button
              type="button"
              onClick={beginCreate}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Plus className="h-3.5 w-3.5" /> New input
            </button>
          )}
        </div>

        {(error || notice) && (
          <div
            role={error ? 'alert' : 'status'}
            className={`mt-2 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] ${
              error
                ? 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300'
                : 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300'
            }`}
          >
            {error && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span className="flex-1">{error || notice}</span>
            <button type="button" onClick={() => { setError(''); setNotice(''); }} aria-label="Dismiss message">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {canPost && (
          <form onSubmit={submit} className="mt-2 grid gap-2 rounded-xl border border-slate-200 p-2.5 md:grid-cols-12 dark:border-slate-800">
            <label className="md:col-span-2">
              <span className={labelClass}>Branch</span>
              <select
                aria-label="Manual forecast branch"
                className={inputClass}
                value={form.branchId}
                onChange={(event) => setForm({ ...form, branchId: event.target.value })}
                disabled={Boolean(editingId)}
              >
                {scopedBranches.map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.name}</option>
                ))}
              </select>
            </label>
            <label className="md:col-span-2">
              <span className={labelClass}>Date ({dateMode})</span>
              <input
                aria-label="Manual forecast date"
                type="date"
                className={inputClass}
                value={form.expectedDateAD}
                onChange={(event) => setForm({ ...form, expectedDateAD: event.target.value })}
              />
            </label>
            <label className="md:col-span-2">
              <span className={labelClass}>Direction</span>
              <select
                aria-label="Manual forecast direction"
                className={inputClass}
                value={form.direction}
                onChange={(event) =>
                  setForm({ ...form, direction: event.target.value as CashFlowForecastDirection })
                }
              >
                <option value="INFLOW">Inflow</option>
                <option value="OUTFLOW">Outflow</option>
              </select>
            </label>
            <label className="md:col-span-2">
              <span className={labelClass}>Amount formula</span>
              <input
                aria-label="Manual forecast amount formula"
                className={inputClass}
                placeholder="e.g. 25000*1.13"
                value={form.amountFormula}
                onChange={(event) => setForm({ ...form, amountFormula: event.target.value })}
              />
            </label>
            <label className="md:col-span-4">
              <span className={labelClass}>Description</span>
              <input
                aria-label="Manual forecast description"
                className={inputClass}
                placeholder="VAT payment, equipment purchase…"
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>
            <div className="flex items-end gap-2 md:col-span-12">
              <button
                type="submit"
                disabled={saving || !scopedBranches.length}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {saving ? 'Saving…' : editingId ? 'Update input' : 'Add input'}
              </button>
              {editingId && (
                <button
                  type="button"
                  onClick={beginCreate}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Cancel edit
                </button>
              )}
              <span className="text-[10px] text-slate-400">
                Safe arithmetic only: numbers, + − × ÷ and parentheses.
              </span>
            </div>
          </form>
        )}

        {forecast.manualInputs.length === 0 ? (
          <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
            No manual forecast inputs in this scope.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-[11px]">
              <thead className="text-[10px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="py-1 pr-3 font-semibold">Date</th>
                  <th className="py-1 pr-3 font-semibold">Branch</th>
                  <th className="py-1 pr-3 font-semibold">Description</th>
                  <th className="py-1 pr-3 font-semibold">Direction</th>
                  <th className="py-1 pr-3 text-right font-semibold">Amount</th>
                  <th className="py-1 pr-3 font-semibold">Period</th>
                  {canPost && <th className="py-1 pr-3 text-right font-semibold">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {forecast.manualInputs.map((input) => (
                  <tr key={input.id} className="border-t border-slate-100 dark:border-slate-800/60">
                    <td className="py-1.5 pr-3 font-mono text-slate-600 dark:text-slate-300">
                      {input.expectedDateAD}
                      <div className="text-[10px] text-slate-400">{input.expectedDateBS}</div>
                    </td>
                    <td className="py-1.5 pr-3 text-slate-500">{input.branchCode}</td>
                    <td className="py-1.5 pr-3 text-slate-700 dark:text-slate-300">
                      {input.description}
                      <div className="font-mono text-[10px] text-slate-400">{input.amountFormula}</div>
                    </td>
                    <td className="py-1.5 pr-3 text-slate-500">{input.direction}</td>
                    <td className={`py-1.5 pr-3 text-right font-mono ${input.direction === 'INFLOW' ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {money(input.amount)}
                    </td>
                    <td className="py-1.5 pr-3">
                      {input.closedPeriod ? (
                        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">
                          Closed · excluded
                        </span>
                      ) : (
                        <span className="text-slate-400">Open</span>
                      )}
                    </td>
                    {canPost && (
                      <td className="py-1.5 pr-3 text-right">
                        <button
                          type="button"
                          onClick={() => beginEdit(input)}
                          className="mr-2 text-slate-500 hover:text-indigo-600"
                          aria-label={`Edit ${input.description}`}
                        >
                          <Pencil className="inline h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(input)}
                          className="text-slate-500 hover:text-rose-600"
                          aria-label={`Delete ${input.description}`}
                        >
                          <Trash2 className="inline h-3.5 w-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
};

export default CashFlowForecastSources;
