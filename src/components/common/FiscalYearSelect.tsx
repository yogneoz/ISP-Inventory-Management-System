import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, CheckCircle2, Lock, AlertCircle } from 'lucide-react';
import { FiscalYear } from '../../types';
import { useClientPagination } from './TablePagination';

export interface FiscalYearSelectProps {
  fiscalYears: FiscalYear[];
  value: string;
  onChange: (fiscalYearId: string) => void;
  /** How many fiscal years to show per page in the dropdown. Defaults to 3. */
  pageSize?: number;
  /** Extra classes for the trigger button. */
  triggerClassName?: string;
  /** Extra classes for the dropdown panel. */
  panelClassName?: string;
  /** Show (Active / Closed) badges next to each option. Default true. */
  showStatus?: boolean;
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  /** Panel alignment relative to the trigger. Default 'left'. */
  align?: 'left' | 'right';
  /** Show the FY prefix label ("FY") in the trigger. Default true. */
  showFyPrefix?: boolean;
}

/**
 * Paginated fiscal-year dropdown.
 *
 * Newest fiscal years always appear first (descending by AD start date). Only
 * `pageSize` (default 3) options are rendered at a time with a compact pager,
 * so long historical lists never overflow the selector.
 */
export const FiscalYearSelect: React.FC<FiscalYearSelectProps> = ({
  fiscalYears,
  value,
  onChange,
  pageSize = 3,
  triggerClassName = '',
  panelClassName = '',
  showStatus = true,
  disabled = false,
  placeholder = 'Select Fiscal Year',
  title,
  align = 'left',
  showFyPrefix = true,
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Newest on top.
  const sorted = useMemo(
    () => [...fiscalYears].sort((a, b) => String(b.startDateAD).localeCompare(String(a.startDateAD))),
    [fiscalYears]
  );

  const pagination = useClientPagination(sorted, pageSize, [sorted.length, pageSize]);

  const selected = sorted.find((f) => f.id === value);

  // Close when clicking outside.
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // When the dropdown opens, ensure the currently-selected year is visible
  // (jump to the page that contains it) unless the user has paged away.
  useEffect(() => {
    if (open && selected && !pagination.pagedItems.some((f) => f.id === selected.id)) {
      // Attach to the page containing the selected year.
      const idx = sorted.findIndex((f) => f.id === selected.id);
      const targetPage = Math.floor(idx / pageSize) + 1;
      pagination.setPage(targetPage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const statusBadge = (fy: FiscalYear) => {
    if (fy.isCurrent) {
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
          <CheckCircle2 className="h-2.5 w-2.5" /> Active
        </span>
      );
    }
    if (fy.isClosed) {
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
          <Lock className="h-2.5 w-2.5" /> Closed
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        Open
      </span>
    );
  };

  return (
    <div ref={containerRef} className="relative inline-block text-left">
      <button
        type="button"
        disabled={disabled}
        title={title}
        onClick={() => setOpen((prev) => !prev)}
        className={`inline-flex items-center gap-1.5 outline-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${triggerClassName}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {showFyPrefix && <span className="opacity-70">FY</span>}
        <span className="font-semibold truncate">
          {selected ? (
            <>
              {selected.code}
              {selected.isCurrent && <span className="ml-1">(Active)</span>}
            </>
          ) : (
            placeholder
          )}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className={`absolute z-40 mt-1 min-w-[230px] rounded-xl border border-slate-200 bg-white text-slate-800 shadow-xl dark:border-slate-700 dark:bg-[#0f1218] dark:text-slate-200 ${panelClassName} ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <ul className="max-h-64 overflow-y-auto py-1">
            {pagination.pagedItems.length === 0 && (
              <li className="px-3 py-2.5 text-xs text-slate-400">
                <AlertCircle className="mr-1 inline h-3.5 w-3.5" /> No fiscal years available.
              </li>
            )}
            {pagination.pagedItems.map((fy) => {
              const isSelected = fy.id === value;
              return (
                <li key={fy.id} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(fy.id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-xs text-left transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-50 font-bold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
                    }`}
                  >
                    <span className="font-mono">{fy.code}</span>
                    {showStatus && statusBadge(fy)}
                  </button>
                </li>
              );
            })}
          </ul>

          {pagination.canPaginate && (
            <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-2 py-1.5 dark:border-slate-700">
              <button
                type="button"
                onClick={() => pagination.setPage(pagination.page - 1)}
                disabled={pagination.page <= 1}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <ChevronLeft className="h-3 w-3" /> Newer
              </button>
              <span className="text-[10px] text-slate-400">
                {pagination.rangeStart}–{pagination.rangeEnd} of {pagination.totalItems}
              </span>
              <button
                type="button"
                onClick={() => pagination.setPage(pagination.page + 1)}
                disabled={pagination.page >= pagination.pageCount}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Older <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default FiscalYearSelect;