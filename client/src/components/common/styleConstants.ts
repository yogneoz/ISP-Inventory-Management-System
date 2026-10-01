/**
 * Shared Tailwind class constants for form controls and buttons.
 *
 * Single source of truth so screens stop re-declaring identical class
 * strings. Import what you need:
 *
 *   import { inputClass, labelClass, btnPrimary, btnGhost } from '<rel>/styleConstants';
 */

/** Standard text/select/number input styling (light + dark). */
export const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-[#0f1218] dark:text-white';

/** Standard form label styling (light + dark). */
export const labelClass = 'mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400';

/** Standard primary action button (indigo). */
export const btnPrimary =
  'inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50';

/** Standard secondary/ghost button (bordered, theme-aware). */
export const btnGhost =
  'inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800';
