import React from 'react';

/**
 * Master form-card pattern — the single source of truth for all page-level
 * inline form cards (create/edit/entry forms).
 *
 * Usage:
 *   <FormCard>…</FormCard>
 *   — or, when a component needs the raw classes (e.g. to append extra
 *   classes like `printable-document` or a transition), spread the constant:
 *
 *   <div id="po-inline-form-container" className={`${formCardClass} space-y-6`}>
 *
 * NEVER hand-write these classes on a new form card — import them here so
 * width, padding, shadow, border and backgrounds can't drift per-page.
 */

/** Raw master class string for a page-level form card. */
export const formCardClass = [
  'max-w-4xl mx-auto rounded-2xl border p-4 shadow-sm',
  'bg-white border-slate-200 text-slate-900',
  'dark:bg-[#0f1218] dark:border-slate-800 dark:text-white',
].join(' ');

interface FormCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

/**
 * Page-level form card container following the master pattern:
 * centered, capped at 56rem (896px), white card, subtle shadow,
 * theme-aware dark mode. Extra classes/props merge after the
 * master classes so callers can extend (e.g. add `space-y-6`,
 * `animate-fadeIn`, or an `id`), not override the core layout.
 */
export const FormCard: React.FC<FormCardProps> = ({ className, children, ...rest }) => (
  <div className={`${formCardClass}${className ? ` ${className}` : ''}`} {...rest}>
    {children}
  </div>
);
