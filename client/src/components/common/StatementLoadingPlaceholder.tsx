import React from 'react';
import { Loader2 } from 'lucide-react';

interface StatementLoadingPlaceholderProps {
  /** What is being read: the placeholder reads "Reading {label}…". */
  label: string;
  /** Layout hook for the caller (e.g. the spacing its siblings use). */
  className?: string;
}

// Spacing is the caller's: a dialog wants a compact line, a full statement
// surface holds its region open. Keeping it out of BASE means a caller can set
// it without fighting a conflicting utility.
const BASE = 'flex items-center justify-center gap-2 text-sm text-slate-400 dark:text-slate-500';

/**
 * Holds a statement region open while its read is in flight.
 *
 * A reload clears the statement — its figures belonged to the query that
 * returned them — so an in-progress read must not read as an empty one. Callers
 * render this only when there is no data and no error, so it can never cover a
 * statement on screen or a failure; `role="status"` announces the read.
 */
export const StatementLoadingPlaceholder: React.FC<StatementLoadingPlaceholderProps> = ({
  label,
  className,
}) => (
  <div role="status" className={className ? `${BASE} ${className}` : BASE}>
    <Loader2 className="h-4 w-4 animate-spin" />
    Reading {label}…
  </div>
);
