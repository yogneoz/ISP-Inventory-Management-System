import React, { useEffect, useRef, useState } from 'react';
import { Search, SlidersHorizontal, X, RotateCcw } from 'lucide-react';

interface FilterCardProps {
  /** Placeholder for the search input. */
  searchPlaceholder: string;
  /**
   * Called with the debounced search text whenever the user pauses typing.
   * The table should NOT filter live on each keystroke — pass this through to
   * an "applied" search value instead.
   */
  onSearchApply: (query: string) => void;
  /** Current applied search value (controlled, for the input's display). */
  searchValue: string;
  /** Number of active filters inside the collapsible panel (badge count). */
  activeFilterCount?: number;
  /** Filter controls revealed by the Filter button (selects, DateFields...). */
  filterChildren?: React.ReactNode;
  /** Called by the Clear button to reset every filter (search + panel). */
  onClearAll: () => void;
  /** True when at least one filter (search or panel) is active. */
  hasActiveFilters: boolean;
  /** Optional right-side content (e.g. result count, Export CSV button). */
  rightChildren?: React.ReactNode;
  /** Debounce in ms before onSearchApply fires while typing. */
  debounceMs?: number;
}

/**
 * Shared register search/filter card.
 *
 * Replaces full-width stretched search bars with a realistic fixed-width
 * card: a compact search box (debounced — the table does not re-filter on
 * every keystroke), a Filter button that toggles a collapsible filter panel
 * (selects, date ranges), and a Clear button that resets everything.
 *
 * Search semantics: typing updates the input instantly; `onSearchApply` is
 * called only after the user pauses for `debounceMs` or presses Enter. The
 * Clear button wipes the input immediately (no debounce).
 */
export function FilterCard({
  searchPlaceholder,
  onSearchApply,
  searchValue,
  activeFilterCount = 0,
  filterChildren,
  onClearAll,
  hasActiveFilters,
  rightChildren,
  debounceMs = 400,
}: FilterCardProps) {
  // Local typing buffer — instant feedback for the user, debounced for the table.
  const [draft, setDraft] = useState(searchValue);
  const [filterOpen, setFilterOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Keep the draft in sync when the applied value changes from outside
  // (e.g. the Clear button).
  useEffect(() => {
    setDraft(searchValue);
  }, [searchValue]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Close the filter panel on outside click or Escape.
  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setFilterOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFilterOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [filterOpen]);

  const handleChange = (next: string) => {
    setDraft(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSearchApply(next), debounceMs);
  };

  const handleClearSearch = () => {
    setDraft('');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    onSearchApply('');
  };

  return (
    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {/* Compact search box — does not stretch to page width. */}
        <div className="relative w-64 sm:w-72">
          <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={draft}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (debounceRef.current) clearTimeout(debounceRef.current);
                onSearchApply(draft);
              }
            }}
            placeholder={searchPlaceholder}
            className={`w-full rounded-xl border py-2 pl-9 pr-8 text-xs bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40`}
          />
          {draft && (
            <button
              type="button"
              onClick={handleClearSearch}
              title="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Filter button + collapsible panel */}
        {filterChildren && (
          <div ref={panelRef} className="relative">
            <button
              type="button"
              onClick={() => setFilterOpen((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold cursor-pointer transition-colors ${
                filterOpen || activeFilterCount > 0
                  ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                  : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-100 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span>Filter</span>
              {activeFilterCount > 0 && (
                <span className="px-1.5 rounded-full text-[10px] font-mono font-black bg-white/25">
                  {activeFilterCount}
                </span>
              )}
            </button>

            {filterOpen && (
              <div className="absolute left-0 top-full z-30 mt-1.5 w-[min(92vw,640px)] rounded-2xl border shadow-xl p-3.5 bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-700">
                <div className="flex items-center justify-between pb-2 mb-2.5 border-b border-slate-200 dark:border-slate-800">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Filters
                  </span>
                  <button
                    type="button"
                    onClick={() => setFilterOpen(false)}
                    title="Close filters"
                    className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex flex-wrap items-end gap-3">{filterChildren}</div>
              </div>
            )}
          </div>
        )}

        {/* Clear all filters */}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={onClearAll}
            title="Clear all filters"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold cursor-pointer border-rose-300 text-rose-600 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950/30"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Clear</span>
          </button>
        )}
      </div>

      {/* Right-side slot: result count / export button */}
      {rightChildren && <div className="flex items-center gap-2 shrink-0">{rightChildren}</div>}
    </div>
  );
}

export default FilterCard;
