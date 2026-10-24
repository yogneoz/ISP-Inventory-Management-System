import React from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';

/**
 * Loading / failed-to-load notice for a client-fetched setup list (DF-11).
 *
 * Category, UoM, Locations and Document Numbering caught their fetch failure,
 * logged it to the console and rendered an empty list — indistinguishable from
 * "there are none configured". They also discarded their loading flag, so the
 * empty state flashed before the first response.
 *
 * The notice covers both states:
 *  - loading with no rows yet -> a spinner ("Loading categories…") instead of
 *    the empty state;
 *  - a failed read -> the failure, whether cached rows remain on screen, and a
 *    Retry that re-runs the same load.
 *
 * Cached rows are never cleared on failure: the copy says they may be stale.
 * A successful load clears the error in the caller, which unmounts the notice.
 */
export interface LoadStateNoticeProps {
  /** Plural noun for the list, e.g. "categories" or "document numbering configurations". */
  subject: string;
  /** True while a load/retry is in flight. */
  loading: boolean;
  /** The failure message; empty when the last load succeeded. */
  error: string;
  /** True when the list still has rows from an earlier successful load. */
  hasCachedRows?: boolean;
  onRetry: () => void;
}

export const LoadStateNotice: React.FC<LoadStateNoticeProps> = ({
  subject,
  loading,
  error,
  hasCachedRows = false,
  onRetry,
}) => {
  if (error) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2.5 text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="text-xs font-bold">Could not load {subject}</p>
            <p className="text-[11px] leading-5">
              {error}
              {hasCachedRows
                ? ' Showing the last loaded rows — they may be out of date.'
                : ' Nothing is shown below — this is not an empty list.'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRetry}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg border border-rose-300 px-2.5 py-1 text-[11px] font-bold hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-500/40 dark:hover:bg-rose-900/40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    );
  }

  // A re-activation refetch with rows already on screen must not flash a
  // spinner over a usable list; only the first empty load shows it.
  if (loading && !hasCachedRows) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading {subject}…
      </div>
    );
  }

  return null;
};
