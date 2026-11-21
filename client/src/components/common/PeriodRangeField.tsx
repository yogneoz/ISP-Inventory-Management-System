/**
 * The one period field every report screen uses.
 *
 * Both ends of a range live in a single bordered control, so a screen shows one
 * date field instead of a "from" box and a "to" box. Editing a date never loads
 * anything: `PeriodRangeField` only edits a draft, and `apply` is called by the
 * Query button (or Enter). A half-typed range therefore cannot launch a
 * request, and pressing Query twice cannot produce two different scopes.
 *
 * `usePeriodRangeFilter` keeps the draft/applied pair for screens that own
 * their own filters (the inventory and sales registers). The accounting
 * registers build their scope on the same hook through `useAccountingScope`.
 */
import React, { useCallback, useState } from 'react';
import { CalendarRange, Search } from 'lucide-react';

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
const INPUT_CLASS =
  'h-7 w-[7.75rem] shrink-0 rounded-md border-0 bg-transparent px-1 text-xs tabular-nums text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-slate-100';

export const PeriodRangeField: React.FC<{
  from: string;
  to: string;
  onChange: (next: PeriodRange) => void;
  onApply: () => void;
  /** The screen's figures came from a different range than the one shown. */
  pending?: boolean;
  label?: string;
  startAriaLabel?: string;
  endAriaLabel?: string;
  /** A report filter may leave both ends empty; an as-of register may not. */
  requireEnd?: boolean;
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
}) => {
  const invalid = (requireEnd && !to) || Boolean(from && to && from > to);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!invalid) onApply();
  };

  return (
    <div className="flex items-end gap-2" role="group" aria-label={`${label} date range`}>
      <label className="block shrink-0 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
        <span className="mt-1 flex h-8 w-max items-center gap-1 rounded-lg border border-slate-300 bg-white px-1.5 dark:border-slate-700 dark:bg-slate-900">
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
    </div>
  );
};

export default PeriodRangeField;
