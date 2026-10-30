import type React from 'react';

/**
 * Turns a clickable table row into a keyboard-operable one.
 *
 * Rows in this app open details / expand breakdowns on click. They are not
 * buttons, so they need an explicit tab stop, an accessible label and
 * Enter/Space handling. The `role` stays the row's native role: overriding it
 * with `button` would break the table's semantics for screen readers.
 *
 * Events bubbling from a control INSIDE the row (a chevron, a status select)
 * are ignored, so pressing Enter on that control does not also toggle the row.
 */
export function getRowActivationProps(
  onActivate: () => void,
  label: string,
  expanded?: boolean
): React.HTMLAttributes<HTMLElement> {
  return {
    tabIndex: 0,
    'aria-label': label,
    ...(expanded === undefined ? {} : { 'aria-expanded': expanded }),
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onActivate();
    },
  };
}

/** Visible focus ring for a row that is also a tab stop. */
export const ROW_FOCUS_CLASS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500';
