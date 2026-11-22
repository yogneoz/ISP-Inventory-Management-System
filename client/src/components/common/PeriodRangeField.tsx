/**
 * The one period field every report screen uses.
 *
 * Both ends of a range live in a single bordered control, so a screen shows one
 * date field instead of a "from" box and a "to" box. Editing either end never
 * loads anything by itself: the field only reports the new range upward. What
 * turns that range into a request depends on whether `onApply` is supplied —
 * two shapes, one control:
 *
 *   - WITH `onApply`: the field renders its own Query button and honours Enter
 *     the same way, so a half-typed range launches nothing and Query twice
 *     cannot produce two different scopes. This is the sales and inventory
 *     register shape, where the period field is the whole filter.
 *   - WITHOUT `onApply`: no Query button and no Enter gate — the field is only
 *     the editor, and the screen's own Apply / Load Ledger / Reload button is
 *     the single path from the range to a request, so it never shows two
 *     buttons doing the same job. This is the finance shape (employee ledger,
 *     posted vouchers, book ledger, lender statement, TDS worklist, payroll
 *     postings, customer/vendor ledger).
 *
 * `usePeriodRangeFilter` keeps the draft/applied pair for screens that own
 * their own filters (the inventory and sales registers). The accounting
 * registers build their scope on the same hook through `useAccountingScope`.
 */
import React, { useCallback, useState } from 'react';
import { CalendarRange, Search } from 'lucide-react';
import { DateField } from '../DateField';

export interface PeriodRange {
  from: string;
  to: string;
}

export interface PeriodRangeFilter {
  /** The range on screen — what the current figures were read for. */
  from: string;
  to: string;
  /** The range being edited. */
  draft: PeriodRange;
  setFrom: (date: string) => void;
  setTo: (date: string) => void;
  /** Adopt the draft. The only path from a date edit to a request. */
  apply: () => void;
  /** Adopt a range immediately, for an explicit action such as a preset. */
  applyNow: (next: PeriodRange) => void;
  /** Clear both ends, for a register's Clear button. */
  reset: () => void;
  /** The draft differs from the range the screen shows. */
  pending: boolean;
  /** Seed an opening date that arrives asynchronously (e.g. a fiscal year). */
  seedFrom: (date: string) => void;
}

const clamp = (draft: PeriodRange): PeriodRange =>
  draft.from && draft.to && draft.from > draft.to ? { from: draft.to, to: draft.to } : draft;

export function usePeriodRangeFilter(
  initial: PeriodRange,
  options: { requireEnd?: boolean } = {}
): PeriodRangeFilter {
  const requireEnd = options.requireEnd === true;
  const [applied, setApplied] = useState<PeriodRange>(initial);
  const [draft, setDraft] = useState<PeriodRange>(initial);

  const setFrom = useCallback((from: string) => setDraft((current) => ({ ...current, from })), []);
  const setTo = useCallback((to: string) => setDraft((current) => ({ ...current, to })), []);

  const applyNow = useCallback((next: PeriodRange) => {
    const range = clamp(next);
    setDraft(range);
    setApplied(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = useCallback(() => {
    const range = clamp(draft);
    if (requireEnd && !range.to) return;
    setDraft(range);
    setApplied(range);
  }, [draft, requireEnd]);

  const reset = useCallback(() => {
    setDraft({ from: '', to: '' });
    setApplied({ from: '', to: '' });
  }, []);

  const seedFrom = useCallback((date: string) => {
    if (!date) return;
    setApplied((current) => (current.from ? current : { ...current, from: date }));
    setDraft((current) => (current.from ? current : { ...current, from: date }));
  }, []);

  return {
    from: applied.from,
    to: applied.to,
    draft,
    setFrom,
    setTo,
    apply,
    applyNow,
    reset,
    pending: draft.from !== applied.from || draft.to !== applied.to,
    seedFrom,
  };
}

// A native date input needs room for "dd/mm/yyyy" plus the picker glyph. Two
// flex-1 inputs inside one control squeezed each other and rendered the date as
// "dd /mm/ y"; a fixed width that cannot shrink keeps the full value visible.
// The BS ends use it too — each carries its mapped AD day as a "BS" suffix, so
// the width has to clear that longer pair, not just a BS day — which keeps the
// row the same measure in either calendar.
const DATE_WIDTH = 'w-[8.5rem]';
const INPUT_CLASS = `h-7 ${DATE_WIDTH} shrink-0 rounded-md border-0 bg-transparent px-1 text-xs tabular-nums text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-slate-100`;

export const PeriodRangeField: React.FC<{
  from: string;
  to: string;
  onChange: (next: PeriodRange) => void;
  /**
   * Applies the range. Omit it when the screen already owns its apply action
   * (Load Ledger, Apply, Reload): the control then only edits the range and no
   * second button appears beside the one the screen already shows.
   */
  onApply?: () => void;
  /** The screen's figures came from a different range than the one shown. */
  pending?: boolean;
  label?: string;
  startAriaLabel?: string;
  endAriaLabel?: string;
  /** A report filter may leave both ends empty; an as-of register may not. */
  requireEnd?: boolean;
  /**
   * Calendar the end dates are edited in. `AD` keeps the native date inputs;
   * `BS` opens the seeded Nepali grid for each end. The value in and out is
   * still the canonical AD ISO date, so registers keep sending AD bounds.
   */
  mode?: 'BS' | 'AD';
}> = ({
  from,
  to,
  onChange,
  onApply,
  pending = false,
  label = 'Period (AD)',
  startAriaLabel = 'Accounting period start',
  endAriaLabel = 'Accounting period end',
  requireEnd = true,
  mode = 'AD',
}) => {
  const invalid = (requireEnd && !to) || Boolean(from && to && from > to);

  // The caption names the calendar the ends are edited in, so a BS range does
  // not keep saying "(AD)" after the header switch. Every card labels its field
  // in AD today; that suffix is the only one that needs replacing.
  const caption = mode === 'BS' ? `${label.replace(/\s*\(AD\)$/i, '')} (BS)` : label;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!onApply || event.key !== 'Enter') return;
    event.preventDefault();
    if (!invalid) onApply();
  };

  const queryButton = onApply ? (
    <button
      type="button"
      onClick={onApply}
      disabled={invalid}
      title={
        invalid
          ? 'Choose a valid range before querying.'
          : 'Load the figures for this period (or press Enter)'
      }
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-600 px-2.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-400"
    >
      <Search className="h-3.5 w-3.5" aria-hidden />
      Query
      {pending && (
        <span
          aria-hidden
          className="ml-0.5 h-1.5 w-1.5 rounded-full bg-amber-300 ring-2 ring-amber-300/30"
        />
      )}
    </button>
  ) : null;

  // BS mode: each end is the shared DateField on the seeded Nepali grid, so the
  // operator picks BS days while the field still reports the canonical AD
  // date. Both ends sit inside the SAME one-line range control as AD mode, so
  // the filter row measures the same whichever calendar the header is on.
  // Picking a day edits the draft only — Query is still the gate.
  if (mode === 'BS') {
    return (
      <div className="flex items-end gap-2" role="group" aria-label={`${label} date range`}>
        <div className="shrink-0">
          <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            {caption}
          </span>
          <div
            data-range-shell="shared"
            className={`mt-1 flex h-8 w-max items-center gap-1 rounded-lg border bg-white px-1.5 dark:bg-slate-900 ${
              invalid
                ? 'border-rose-400 dark:border-rose-700'
                : 'border-slate-300 dark:border-slate-700'
            }`}
          >
            <CalendarRange className="ml-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            <div className={`${DATE_WIDTH} shrink-0`}>
              <DateField
                inline
                mode="BS"
                ariaLabel={startAriaLabel}
                value={from}
                max={to || undefined}
                onChange={(next) => onChange({ from: next, to })}
              />
            </div>
            <span aria-hidden className="px-0.5 text-[11px] text-slate-400">
              →
            </span>
            <div className={`${DATE_WIDTH} shrink-0`}>
              <DateField
                inline
                mode="BS"
                ariaLabel={endAriaLabel}
                value={to}
                min={from || undefined}
                onChange={(next) => onChange({ from, to: next })}
              />
            </div>
          </div>
        </div>
        {queryButton}
      </div>
    );
  }

  return (
    <div className="flex items-end gap-2" role="group" aria-label={`${label} date range`}>
      <label className="block shrink-0 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
        <span
          data-range-shell="shared"
          className="mt-1 flex h-8 w-max items-center gap-1 rounded-lg border border-slate-300 bg-white px-1.5 dark:border-slate-700 dark:bg-slate-900"
        >
          <CalendarRange className="ml-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
          <input
            aria-label={startAriaLabel}
            type="date"
            value={from}
            max={to || undefined}
            onChange={(event) => onChange({ from: event.target.value, to })}
            onKeyDown={handleKeyDown}
            className={INPUT_CLASS}
          />
          <span aria-hidden className="px-0.5 text-[11px] text-slate-400">
            →
          </span>
          <input
            aria-label={endAriaLabel}
            type="date"
            value={to}
            min={from || undefined}
            aria-invalid={invalid || undefined}
            onChange={(event) => onChange({ from, to: event.target.value })}
            onKeyDown={handleKeyDown}
            className={INPUT_CLASS}
          />
        </span>
      </label>
      {queryButton}
    </div>
  );
};

export default PeriodRangeField;
