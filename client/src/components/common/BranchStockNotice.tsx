import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * Failed branch-stock read (stock operations + dispatch forms).
 *
 * The form's availability labels and pre-submit check read PostgreSQL rows
 * for whichever branch the form targets. When that read fails, the last rows
 * are kept — they must never collapse to "0 in stock", which is exactly the
 * false refusal this cache was added to remove. This notice says the rows may
 * be stale and offers the retry; a successful reload unmounts it.
 */
export interface BranchStockNoticeProps {
  error: string;
  loading: boolean;
  onRetry: () => void;
}

export const BranchStockNotice: React.FC<BranchStockNoticeProps> = ({
  error,
  loading,
  onRetry,
}) => {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div>
          <p className="text-xs font-bold">Branch stock could not be refreshed</p>
          <p className="mt-1 text-[11px] opacity-90">
            {error} Showing the last loaded rows — availability for a branch
            other than the one in the header may be out of date. Do not treat a
            “0 in stock” as empty until this retry succeeds.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={loading}
        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        {loading ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
};
