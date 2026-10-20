import React from 'react';
import { AlertTriangle, ArrowRight, RefreshCw, X } from 'lucide-react';
import { requestTabNavigation } from '../../services/api/http';

interface BootstrapBlockedBannerProps {
  /** The server's own message — never re-worded here, so the operator reads the
   *  same reason the API reported (missing fiscal year, bad fiscal-year id, …). */
  message: string;
  /** HTTP status that came back with it, shown small for a support report. */
  status?: number;
  /**
   * The screen that fixes this, when the refusal named a machine-readable cause.
   * The server's message already names it in words; a button is the difference
   * between reading about the remedy and reaching it. Navigation goes through the
   * same `requestTabNavigation` contract the API toasts use, so App validates the
   * target against the signed-in user's permissions before switching.
   */
  action?: { label: string; tab: string };
  onRetry?: () => void;
  onDismiss?: () => void;
}

/**
 * Shown when GET /api/bootstrap was REFUSED by a reachable server.
 *
 * The companion DatabaseSetupBanner answers "is PostgreSQL reachable?" from the
 * bootstrap payload, so anything that stops that payload from arriving used to
 * render as "PostgreSQL Offline — run the setup commands": a connected database
 * blamed for a configuration problem (the 2026-10-15 fiscal-year case, where
 * the API itself said "PostgreSQL is unavailable"). This banner is the other
 * half: when the server answered with a structured refusal, the database is
 * demonstrably up, so the reason shown is the SERVER's, verbatim, with the
 * action that fixes it. Rendered as a banner rather than a toast because the
 * condition persists until it is fixed (retrying is a button, not a wait).
 */
export const BootstrapBlockedBanner: React.FC<BootstrapBlockedBannerProps> = ({
  message,
  status,
  action,
  onRetry,
  onDismiss,
}) => (
  <div
    id="bootstrap-blocked-banner"
    role="alert"
    className="border-b transition-colors bg-rose-50 border-rose-300 text-rose-900 dark:bg-rose-950/40 dark:border-rose-900/60 dark:text-rose-100"
  >
    <div className="max-w-7xl mx-auto px-4 py-2 sm:px-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
        <div className="flex items-start sm:items-center gap-2.5">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 sm:mt-0 text-rose-600 dark:text-rose-400" />
          <div>
            <span className="font-semibold text-xs sm:text-sm tracking-tight">
              Application data is not loading
              {typeof status === 'number' ? (
                <span className="ml-1.5 font-normal opacity-70">(HTTP {status})</span>
              ) : null}
            </span>
            <p className="text-[11px] sm:text-xs opacity-90 mt-0.5">{message}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-end sm:self-auto flex-wrap">
          {action ? (
            <button
              id="btn-bootstrap-blocked-action"
              type="button"
              onClick={() => requestTabNavigation(action.tab)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-white/90 hover:bg-white text-rose-700 border border-rose-300 shadow-xs transition-colors cursor-pointer"
            >
              <span>{action.label}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : null}
          {onRetry ? (
            <button
              id="btn-retry-bootstrap"
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-rose-600 hover:bg-rose-700 text-white shadow-xs transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry</span>
            </button>
          ) : null}
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss application-data notification"
              className="p-1 rounded-lg hover:bg-rose-500/10 transition cursor-pointer text-rose-700 dark:text-rose-300"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  </div>
);
