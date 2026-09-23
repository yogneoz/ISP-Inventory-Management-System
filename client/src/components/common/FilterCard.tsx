import React, { useEffect, useRef, useState } from 'react';
import { Search, X, RotateCcw } from 'lucide-react';

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
  /** Filter controls shown inline in the card (selects, DateFields...). Each register passes its own — vendor for POs, product name for stock ledgers, customer for sales, etc. */
  filterChildren?: React.ReactNode;
  /** Called by the Clear button to reset every filter (search + inline filters). */
  onClearAll: () => void;
  /** True when at least one filter (search or inline) is active. */
  hasActiveFilters: boolean;
  /** Optional right-side content (e.g. result count, Export CSV button). */
  rightChildren?: React.ReactNode;
  /** Debounce in ms before onSearchApply fires while typing. */
  debounceMs?: number;
}

/**
 * Shared register search/filter card.
 *
 * A realistic fixed-width card containing: a compact debounced search box
 * (the table does not re-filter on every keystroke), the register's filter
 * controls laid out INLINE (no popup — everything is visible at once), and a
 * Clear button that resets everything.
 *
 * Search semantics: typing updates the input instantly; `onSearchApply` is
 * called only after the user pauses for `debounceMs` or presses Enter. The
 * Clear button wipes the input immediately (no debounce).
 *
 * The filter controls are provided per register via `filterChildren`, so each
 * register decides which fields appear (vendor, product, customer, status,
 * date range...). The card only supplies layout + search behaviour.
 */
export function FilterCard({
  searchPlaceholder,
  onSearchApply,
  searchValue,
  filterChildren,
  onClearAll,
  hasActiveFilters,
  rightChildren,
  debounceMs = 400,
}: FilterCardProps) {
  // Local typing buffer — instant feedback for the user, debounced for the table.
  const [draft, setDraft] = useState(searchValue);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    <div className={`rounded-2xl border shadow-xs p-3 bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
      <div className="flex flex-wrap items-end gap-2.5">
        {/* Compact search box — does not stretch to page width. */}
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Search</label>
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
        </div>

        {/* Inline filter fields — each register passes its own controls. */}
        {filterChildren}

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

        {/* Right-side slot: result count / export button (pushed right) */}
        {rightChildren && (
          <div className="flex items-center gap-2 shrink-0 ml-auto">{rightChildren}</div>
        )}
      </div>
    </div>
  );
}

export default FilterCard;
