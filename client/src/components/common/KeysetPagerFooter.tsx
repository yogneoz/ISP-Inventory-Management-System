import React from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { pageWindow } from '../../utils/pageWindow';

interface KeysetPagerFooterProps {
  /**
   * The numbered view over the cursor walk (`useKeysetPageView`): which page is
   * on screen, how many pages are fetched, and how to move between them.
   */
  view: {
    page: number;
    pageCount: number;
    /** 1-based index of the first row on this page (0 when empty). */
    rowStart: number;
    /** 1-based index of the last row on this page (0 when empty). */
    rowEnd: number;
    goToPage: (page: number) => void;
  };
  /**
   * Filtered total for exactly the query being paged (for "of N records").
   * The caller must pass the total reported for the current filter set — never
   * a carried-over figure from an earlier one — or the footer overstates.
   */
  totalRows?: number;
  /** True while a further cursor page exists on the server. */
  hasMore: boolean;
  /** A page fetch is in flight. */
  loading: boolean;
  /** Clear, non-crashing SCOPE_REQUIRED explanation. */
  scopeError?: string;
}

const BTN_BASE =
  'border-slate-200 text-slate-600 hover:bg-slate-200 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700/60';
const BTN_DISABLED =
  'border-slate-100 text-slate-300 cursor-not-allowed dark:border-slate-800 dark:text-slate-600 dark:cursor-not-allowed';
const BTN_ACTIVE = 'bg-indigo-600 border-indigo-600 text-white hover:bg-indigo-600';

/**
 * Numbered footer for a cursor-paged register — the numbered replacement for
 * the old "Load more" button, fed by `useKeysetPageView`.
 *
 * Forward navigation is one cursor page at a time because the pagination is a
 * signed keyset (LIMIT/OFFSET would reintroduce the duplicate/skip failures it
 * exists to prevent). Pages already read stay numbered and cost no request.
 */
export const KeysetPagerFooter: React.FC<KeysetPagerFooterProps> = ({
  view,
  totalRows,
  hasMore,
  loading,
  scopeError = '',
}) => {
  if (scopeError) {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-300"
      >
        <span>{scopeError}</span>
        <span className="text-[10px] font-bold uppercase tracking-wide">Scope required</span>
      </div>
    );
  }
  if (view.rowStart === 0 && !hasMore && !loading) return null;

  // Never claim fewer records than the rows already on screen: `rowEnd` is the
  // highest index the walk has reached, so it backstops a missing total.
  const total = Math.max(Number(totalRows) || 0, view.rowEnd);

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400">
      <span className="inline-flex items-center gap-1.5">
        {loading && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
        {view.rowStart === 0 ? (
          <>No rows loaded</>
        ) : (
          <>
            Showing{' '}
            <strong className="text-slate-700 dark:text-slate-200">{view.rowStart.toLocaleString('en-IN')}</strong>–
            <strong className="text-slate-700 dark:text-slate-200">{view.rowEnd.toLocaleString('en-IN')}</strong> of{' '}
            <strong className="text-slate-700 dark:text-slate-200">{total.toLocaleString('en-IN')}</strong>{' '}
            {total === 1 ? 'record' : 'records'}
          </>
        )}
      </span>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => view.goToPage(view.page - 1)}
          disabled={view.page <= 1 || loading}
          aria-label="Previous page"
          className={`h-6 w-6 inline-flex items-center justify-center rounded-md border transition-colors ${
            view.page <= 1 || loading ? BTN_DISABLED : BTN_BASE
          }`}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>

        {pageWindow(view.page, view.pageCount).map((p, i) =>
          typeof p === 'number' ? (
            <button
              key={`${p}-${i}`}
              type="button"
              onClick={() => view.goToPage(p)}
              aria-current={p === view.page ? 'page' : undefined}
              disabled={loading}
              title={p === view.page ? `Page ${p}` : `Show page ${p} (already loaded)`}
              className={`h-6 min-w-[1.5rem] px-1 inline-flex items-center justify-center rounded-md border text-[11px] font-semibold transition-colors ${
                p === view.page ? BTN_ACTIVE : loading ? BTN_DISABLED : BTN_BASE
              }`}
            >
              {p}
            </button>
          ) : (
            <span key={`gap-${i}`} className="px-0.5 text-slate-400">
              …
            </span>
          )
        )}

        {hasMore ? (
          <button
            type="button"
            onClick={() => view.goToPage(view.page + 1)}
            disabled={loading}
            aria-label="Next page"
            title="Fetch the next page from the cursor anchor"
            className={`h-6 min-w-[1.5rem] px-1 inline-flex items-center justify-center rounded-md border text-[11px] font-semibold transition-colors ${
              loading ? BTN_DISABLED : BTN_BASE
            }`}
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="ml-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
            End of register
          </span>
        )}
      </div>
    </div>
  );
};
