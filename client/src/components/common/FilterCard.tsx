import React, { useEffect, useId, useRef, useState } from 'react';
import { Search, X, RotateCcw } from 'lucide-react';

/**
 * Settle window before a preview read is asked for.
 *
 * The table never reacts to a pause: a search reaches it only when committed
 * (Enter or the Filter button), because every new search is a new keyset walk
 * that restarts at page 1 and re-reads the register's totals. So this timer
 * paces the preview read alone — short enough that the box still feels live.
 */
export const FILTER_CARD_DEBOUNCE_MS = 250;

/** Shortest draft worth a preview read. */
const PREVIEW_MIN_CHARS = 2;

/** One live match shown under the box while typing. */
export interface SearchPreviewItem {
  /** Stable row id (the register's own). */
  id: string;
  /** The text the row is known by — what clicking it commits. */
  label: string;
  /** Small context line: product, party, branch, date… */
  detail?: string;
  /** Right-aligned figure/state (status, amount). */
  meta?: string;
}

/** The dropdown's three exclusive states (not four independent flags). */
type PreviewState =
  | { status: 'closed' }
  | { status: 'loading' }
  | { status: 'ready'; items: SearchPreviewItem[] };

interface FilterCardProps {
  /** Placeholder for the search input. */
  searchPlaceholder: string;
  /**
   * The COMMITTED search: Enter, the card's Filter button, or Clear. Never
   * called while typing, so the table keeps its page and its KPIs until the
   * operator says the term is finished. Receives the term trimmed.
   */
  onSearchApply: (query: string) => void;
  /**
   * Matches for the dropdown under the box, asked once typing settles: one
   * SMALL bounded read that renders under the input and touches no register
   * state. Clicking a match commits its `label`. Omit it for no dropdown.
   */
  fetchPreview?: (query: string) => Promise<SearchPreviewItem[]>;
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
  /** Settle window in ms before a preview read is asked for. */
  debounceMs?: number;
  /**
   * Optional sink for the keystroke-level draft. The card owns the input
   * buffer, so an export handler firing before a commit would otherwise only
   * see the last applied value. Reports the draft on mount, on every
   * keystroke, on Clear, and when `searchValue` resets it.
   */
  onSearchDraftChange?: (draft: string) => void;
}

/**
 * Shared register search/filter card.
 *
 * A realistic fixed-width card containing: a compact search box, the register's
 * filter controls laid out INLINE (no popup — everything is visible at once),
 * and a Clear button that resets everything.
 *
 * Search semantics: typing updates the input instantly and touches nothing
 * else — no re-render of the table, the KPI strip or the header. The search is
 * applied only when it is COMMITTED: Enter, the always-visible Filter button, or
 * Clear (which applies at once). The settle timer feeds `fetchPreview` instead,
 * so live matches cost one small read, never a walk reset. Committing the term
 * the table already uses re-queries nothing.
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
  debounceMs = FILTER_CARD_DEBOUNCE_MS,
  onSearchDraftChange,
  fetchPreview,
}: FilterCardProps) {
  // Local typing buffer — instant feedback for the user, committed to the table
  // only on Enter / the Filter button.
  const [draft, setDraft] = useState(searchValue);
  const searchId = useId();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `fetchPreview` is typically an inline function: ref it so a new identity
  // never re-arms the settle timer on every render.
  const fetchPreviewRef = useRef(fetchPreview);
  useEffect(() => {
    fetchPreviewRef.current = fetchPreview;
  }, [fetchPreview]);

  const [preview, setPreview] = useState<PreviewState>({ status: 'closed' });
  // Every answer is tagged with the read that asked for it, so a late response
  // can never reopen the list after a commit or a clear.
  const previewSeq = useRef(0);
  const previewAnchorRef = useRef<HTMLDivElement | null>(null);
  const previewOpen = preview.status !== 'closed';

  const closePreview = () => {
    previewSeq.current++;
    setPreview((current) => (current.status === 'closed' ? current : { status: 'closed' }));
  };

  // Report the live draft so callers (CSV exports) can use text typed after
  // the last commit. The callback lives in a ref so a caller passing an inline
  // function does not re-run the report effect on every render.
  const onDraftChangeRef = useRef(onSearchDraftChange);
  useEffect(() => {
    onDraftChangeRef.current = onSearchDraftChange;
  }, [onSearchDraftChange]);
  useEffect(() => {
    onDraftChangeRef.current?.(draft);
  }, [draft]);

  // Keep the draft in sync when the applied value changes from outside
  // (e.g. the Clear button or the register's own search box). Adjusted
  // DURING RENDER (React's "adjusting state when a prop changes" pattern)
  // so the sync lands in the SAME commit as the searchValue update.
  const [prevSearchValue, setPrevSearchValue] = useState(searchValue);
  if (!Object.is(searchValue, prevSearchValue)) {
    setPrevSearchValue(searchValue);
    if (!Object.is(draft, searchValue)) setDraft(searchValue);
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Clicking anywhere else dismisses the dropdown (the anchor holds the input
  // and the list, so a click on a match is not an outside click).
  useEffect(() => {
    if (!previewOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (previewAnchorRef.current?.contains(event.target as Node)) return;
      closePreview();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [previewOpen]);

  // Registers store the applied term trimmed and key their walk on that string,
  // so a same-term commit — a second Enter, a match that is already the search,
  // a trailing space — must not re-fetch the page the table is already on.
  const committed = draft.trim();
  const pendingApply = committed !== searchValue.trim();

  const cancelPending = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
  };

  /** Commit the search — the only path that touches the register's query. */
  const commitSearch = (next: string) => {
    cancelPending();
    closePreview();
    const term = next.trim();
    if (term === searchValue.trim()) return;
    onSearchApply(term);
  };

  /** One bounded preview read once typing settles; the table is untouched. */
  const runPreview = (next: string) => {
    const term = next.trim();
    if (!fetchPreviewRef.current || term.length < PREVIEW_MIN_CHARS) {
      closePreview();
      return;
    }
    const mine = ++previewSeq.current;
    setPreview({ status: 'loading' });
    fetchPreviewRef.current(term)
      .then((items) => {
        if (mine === previewSeq.current) setPreview({ status: 'ready', items });
      })
      .catch(() => {
        // A failed preview is not a register error: Enter still filters.
        if (mine === previewSeq.current) closePreview();
      });
  };

  /** Pick a match: it becomes the box's text and the committed search. */
  const pickPreview = (item: SearchPreviewItem) => {
    setDraft(item.label);
    commitSearch(item.label);
  };

  const handleChange = (next: string) => {
    setDraft(next);
    cancelPending();
    // One small preview read once typing settles; a commit cancels this timer,
    // so the preview never lands after the fact.
    debounceRef.current = setTimeout(() => runPreview(next), debounceMs);
  };

  const handleClearSearch = () => {
    setDraft('');
    cancelPending();
    closePreview();
    // The X always clears: it also resets the register's applied search, even
    // when the box already read as empty.
    onSearchApply('');
  };

  return (
    <div className={`rounded-lg border shadow-xs p-2 bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
      <div className="flex flex-wrap items-end gap-1.5">
        {/* Compact search box — does not stretch to page width, and carries no
            label of its own: the placeholder names it, the aria-label reads it
            to screen readers, and the row keeps one baseline. */}
        <div className="min-w-fit">
          {/* Same label recipe as the register's own fields (Branch, Status,
              Category...), so the search box is named like its neighbours. */}
          <label
            htmlFor={searchId}
            className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1"
          >
            Search
          </label>
          <div className="relative w-52 sm:w-60" ref={previewAnchorRef}>
            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id={searchId}
              type="text"
              value={draft}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSearch(draft);
                if (e.key === 'Escape') closePreview();
              }}
              aria-expanded={previewOpen}
              autoComplete="off"
              title="Type to search, then press Enter or Filter — the table only filters when you commit"
              placeholder={searchPlaceholder}
              className={`h-8 w-full rounded-lg border pl-8 pr-8 text-xs bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40`}
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

            {/* Live matches, debounced. Absolutely positioned, so opening it
                moves nothing on the page — the card, the header and the table
                stay exactly where they are until a match is committed. */}
            {previewOpen && (
              <div
                role="listbox"
                aria-label="Search matches"
                className="absolute left-0 top-full z-40 mt-1 w-[22rem] max-w-[min(22rem,90vw)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-[#12161f]"
              >
                <div className="max-h-64 overflow-y-auto">
                  {preview.status === 'loading' && (
                    <p className="px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400">Searching…</p>
                  )}
                  {preview.status === 'ready' && preview.items.length === 0 && (
                    <p className="px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400">
                      No matches. Press Enter or Filter to search the whole register.
                    </p>
                  )}
                  {preview.status === 'ready' &&
                    preview.items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={false}
                        onClick={() => pickPreview(item)}
                        className="flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-bold text-slate-800 dark:text-slate-100">
                            {item.label}
                          </span>
                          {item.detail && (
                            <span className="block truncate text-[10px] text-slate-500 dark:text-slate-400">
                              {item.detail}
                            </span>
                          )}
                        </span>
                        {item.meta && (
                          <span className="shrink-0 text-[10px] font-bold text-slate-500 dark:text-slate-400">
                            {item.meta}
                          </span>
                        )}
                      </button>
                    ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Always visible so committing never reflows the row; disabled while
            the table already uses the typed term (a commit would re-query it). */}
        <button
          type="button"
          onClick={() => commitSearch(draft)}
          disabled={!pendingApply}
          title={
            pendingApply
              ? 'Filter the table with this search (Enter)'
              : 'The table already uses this search'
          }
          className={`flex h-8 items-center rounded-lg border px-2.5 text-xs font-bold transition-colors ${
            pendingApply
              ? 'cursor-pointer border-indigo-300 text-indigo-600 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950/30'
              : 'cursor-default border-slate-200 text-slate-400 dark:border-slate-800 dark:text-slate-600'
          }`}
        >
          <span>Filter</span>
        </button>

        {/* Inline filter fields — each register passes its own controls. */}
        {filterChildren}

        {/* Clear all filters */}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={onClearAll}
            title="Clear all filters"
            className="flex h-8 items-center gap-1.5 px-2.5 rounded-lg border text-xs font-bold cursor-pointer border-rose-300 text-rose-600 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950/30"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Clear</span>
          </button>
        )}

        {/* Right-side slot: result count / export button (pushed right) */}
        {rightChildren && (
          <div className="flex items-center gap-1.5 shrink-0 ml-auto">{rightChildren}</div>
        )}
      </div>
    </div>
  );
}

export default FilterCard;
