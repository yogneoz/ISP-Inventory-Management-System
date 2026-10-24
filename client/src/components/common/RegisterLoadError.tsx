import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * Inline failure notice for a server-paged register.
 *
 * A paged register renders a client-filtered fallback when its page request
 * fails, so without this notice the screen silently shows a different row set
 * than the query (and from which KPIs and exports would be computed). The
 * notice names the failure, says whether cached rows are on screen, and offers
 * a Retry that re-runs exactly the page fetch that failed.
 */
export interface RegisterLoadErrorProps {
  /** What could not be loaded, e.g. "this page of purchase orders". */
  subject: string;
  /** The error message from the failed fetch. */
  message: string;
  /** Whether the fallback is showing cached rows (vs. nothing at all). */
  hasCachedRows: boolean;
  /** True while a retry is in flight; disables the button and spins its icon. */
  loading: boolean;
  onRetry: () => void;
  /** Extra sentence about the fallback rows (defaults to the generic warning). */
  cachedNote?: string;
}

export const RegisterLoadError: React.FC<RegisterLoadErrorProps> = ({
  subject,
  message,
  hasCachedRows,
  loading,
  onRetry,
  cachedNote = ' Showing cached rows instead of this page — they may be out of date or filtered differently.',
}) => (
  <div
    role="alert"
    className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2.5 text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300"
  >
    <div className="flex items-start gap-2">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="text-xs font-bold">Could not load {subject}</p>
        <p className="text-[11px] leading-5">
          {message}
          {hasCachedRows ? cachedNote : ' No rows are available to show.'}
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
      Retry
    </button>
  </div>
);
