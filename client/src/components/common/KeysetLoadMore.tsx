import React from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';

interface KeysetLoadMoreProps {
  loaded: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Clear, non-crashing SCOPE_REQUIRED explanation. */
  scopeError?: string;
  className?: string;
}

/**
 * Footer for a cursor-paged register. It never requests an offset page: the
 * only forward action is "Load more", which advances the signed nextCursor.
 */
export const KeysetLoadMore: React.FC<KeysetLoadMoreProps> = ({
  loaded,
  hasMore,
  loadingMore,
  onLoadMore,
  scopeError = '',
  className = '',
}) => {
  if (scopeError) {
    return (
      <div
        role="status"
        className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-300 ${className}`}
      >
        <span>{scopeError}</span>
        <span className="text-[10px] font-bold uppercase tracking-wide">Scope required</span>
      </div>
    );
  }
  if (loaded === 0 && !hasMore) return null;
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400 ${className}`}
    >
      <span>
        Showing <strong className="text-slate-700 dark:text-slate-200">{loaded.toLocaleString('en-IN')}</strong>{' '}
        loaded row{loaded === 1 ? '' : 's'}
      </span>
      {hasMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      ) : (
        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
          End of register
        </span>
      )}
    </div>
  );
};
