import React from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import type { VisibleSliceError } from '../../services/bootstrapSlices';

interface BootstrapSliceNoticeProps {
  /** Failed, not-yet-dismissed slices — the whole payload for this ONE notice. */
  slices: VisibleSliceError[];
  /** A retry is in flight; the button is disabled and spins. */
  retrying?: boolean;
  onRetry?: () => void;
  onDismiss?: () => void;
}

/**
 * One non-blocking notice for failed bootstrap slices (architecture backlog C1).
 *
 * A targeted SSE refresh or a deferred ledger load that fails used to be
 * swallowed: the screen kept its previous rows (correct) but gave no hint that
 * they were no longer current, so an edited invoice could look unsaved. GETs
 * are deliberately not toasted (services/api/http.ts), so this is the one
 * place those failures become visible — as a dismissible banner, not a toast
 * per slice, and never as an alarm that suggests the whole app is down.
 *
 * The rows are NOT cleared on failure; the copy says explicitly that the last
 * loaded data is still on screen.
 */
export const BootstrapSliceNotice: React.FC<BootstrapSliceNoticeProps> = ({
  slices,
  retrying = false,
  onRetry,
  onDismiss,
}) => {
  if (slices.length === 0) return null;

  const labels = slices.map((slice) => slice.label);
  const labelList =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;

  return (
    <div
      id="bootstrap-slice-notice"
      role="status"
      aria-live="polite"
      className="border-b transition-colors bg-amber-50 border-amber-300 text-amber-900 dark:bg-amber-950/40 dark:border-amber-900/60 dark:text-amber-100"
    >
      <div className="max-w-7xl mx-auto px-4 py-2 sm:px-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
          <div className="flex items-start sm:items-center gap-2.5">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 sm:mt-0 text-amber-600 dark:text-amber-400" />
            <div>
              <span className="font-semibold text-xs sm:text-sm tracking-tight">
                Some data did not refresh
              </span>
              <p className="text-[11px] sm:text-xs opacity-90 mt-0.5">
                {labelList} could not be refreshed.{' '}
                {slices.length === 1
                  ? slices[0].message
                  : `${slices.length} refreshes failed.`}{' '}
                Whatever loaded last stays on screen — nothing was cleared.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-auto flex-wrap">
            {onRetry ? (
              <button
                id="btn-retry-slices"
                type="button"
                onClick={onRetry}
                disabled={retrying}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <RefreshCw className={`w-3.5 h-3.5${retrying ? ' animate-spin' : ''}`} />
                <span>{retrying ? 'Retrying…' : 'Retry'}</span>
              </button>
            ) : null}
            {onDismiss ? (
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss data-refresh notification"
                className="p-1 rounded-lg hover:bg-amber-500/10 transition cursor-pointer text-amber-700 dark:text-amber-300"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
