/**
 * WTY-6: the one correction dialog both warranty registers share.
 *
 * A correction never edits the current row in place — the API supersedes it,
 * writes a replacement and audits the change — so the modal returns control to
 * the parent, which refetches the page and the KPIs instead of patching its
 * local copy with a row whose id has just changed.
 *
 * The term displayed beside the dates is the catalogue snapshot the coverage
 * was captured with; it is deliberately read-only. The exact dates are the
 * contract, and an operator correcting them must not silently re-derive them
 * from a product default.
 */
import React, { useState } from 'react';
import { CalendarCheck, ShieldAlert, X } from 'lucide-react';
import type { WarrantyCoverageRow } from '../../../types';
import { api } from '../../../services/api';
import { DateField } from '../../../components/DateField';
import { isAdDate, isValidWarrantyRange } from '../../../../../shared/warrantyTerm';

interface WarrantyEditModalProps {
  row: WarrantyCoverageRow;
  dateMode: 'BS' | 'AD';
  onClose: () => void;
  /** The parent refetches the page and the KPI counts after a successful save. */
  onSaved: () => void;
}

function dateFieldError(startDateAD: string, endDateAD: string): string | null {
  if (!isAdDate(startDateAD)) return 'Warranty start must be a real calendar date.';
  if (!isAdDate(endDateAD)) return 'Warranty expiry must be a real calendar date.';
  if (!isValidWarrantyRange(startDateAD, endDateAD)) {
    return 'Warranty expiry cannot be before the start date.';
  }
  return null;
}

export const WarrantyEditModal: React.FC<WarrantyEditModalProps> = ({
  row,
  dateMode,
  onClose,
  onSaved,
}) => {
  const [startDateAD, setStartDateAD] = useState(row.startDateAD);
  const [endDateAD, setEndDateAD] = useState(row.endDateAD);
  const [notes, setNotes] = useState(row.notes || '');
  const [fieldError, setFieldError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  const rangeError = dateFieldError(startDateAD, endDateAD);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const error = dateFieldError(startDateAD, endDateAD);
    setFieldError(error || '');
    setSaveError('');
    if (error) return;
    setSaving(true);
    try {
      await api.updateWarrantyCoverage(row.id, {
        startDateAD,
        endDateAD,
        termMonths: row.termMonths ?? null,
        notes: notes.trim() || null,
      });
      onSaved();
    } catch (err: any) {
      const status = Number(err?.status);
      setSaveError(
        status === 403
          ? `Your account may not correct warranty dates (warranty-edit). ${err?.message || ''}`.trim()
          : err?.message || 'The warranty correction could not be saved.'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Correct warranty coverage"
      data-testid="warranty-edit-modal"
    >
      <div className="w-full max-w-lg rounded-2xl shadow-2xl border overflow-hidden bg-white border-slate-200 text-slate-700 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-300">
        <div className="flex items-start justify-between gap-3 border-b p-4 border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50">
          <div>
            <h3 className="font-bold text-sm text-slate-900 dark:text-white">Correct Warranty Coverage</h3>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              {row.coverageType === 'VENDOR' ? 'Suppliers warranty' : 'Sellers warranty'} ·{' '}
              <span className="font-mono font-semibold">{row.serialNumber}</span>
              {row.productName ? ` · ${row.productName}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-lg cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3">
          <div className="flex items-start gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40 px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400">
            <CalendarCheck className="h-4 w-4 shrink-0 text-indigo-500" />
            <span>
              A correction supersedes the stored period and is audited — the previous dates stay in the
              history. Term snapshot:{' '}
              <strong className="text-slate-700 dark:text-slate-200">
                {row.termMonths === null || row.termMonths === undefined ? 'typed contract' : `${row.termMonths} months`}
              </strong>
              .
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <DateField
                id="warranty-start-date"
                label="Warranty start"
                mode={dateMode}
                value={startDateAD}
                onChange={setStartDateAD}
                max={endDateAD || undefined}
                controlClassName={fieldError ? 'border-rose-400 dark:border-rose-700' : ''}
              />
            </div>
            <div>
              <DateField
                id="warranty-end-date"
                label="Warranty expiry"
                mode={dateMode}
                value={endDateAD}
                onChange={setEndDateAD}
                min={startDateAD || undefined}
                controlClassName={fieldError ? 'border-rose-400 dark:border-rose-700' : ''}
              />
            </div>
          </div>

          {(fieldError || rangeError) && (
            <p className="text-[11px] font-semibold text-rose-600 dark:text-rose-400" role="alert">
              {fieldError || rangeError}
            </p>
          )}

          <div>
            <label
              htmlFor="warranty-notes"
              className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1"
            >
              Correction note
            </label>
            <textarea
              id="warranty-notes"
              rows={2}
              maxLength={500}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Why is the period being corrected? (optional)"
              className="w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            />
          </div>

          {saveError && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-[11px] font-semibold text-rose-700 dark:text-rose-300">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              <span>{saveError}</span>
            </div>
          )}

          <div className="pt-3 border-t flex items-center justify-end gap-2 border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border px-3 py-1.5 text-xs font-medium border-slate-300 text-slate-600 hover:bg-slate-200 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 shadow-md cursor-pointer disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save correction'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
