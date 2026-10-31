import React from 'react';

interface PageHeaderProps {
  /** Page title — always rendered as the single h2 for the screen. */
  title: string;
  /** Description under the title. It wraps rather than truncating. Keep
   *  register facts here instead of in fake-metric cards (see UoM/Category). */
  description?: React.ReactNode;
  /** Optional icon, typically a lucide icon sized h-5 w-5. Rendered as-is. */
  icon?: React.ReactNode;
  /** Right-side action buttons (Export, New, Back...). Wrap each in the
   *  standard button classes the screen already uses. */
  actions?: React.ReactNode;
  /** Optional extra classes for the actions wrapper (alignment tweaks). */
  actionsClassName?: string;
}

/**
 * Shared single page header — the ONE h2 a screen is allowed to have.
 *
 * Why this exists (design-audit finding E / A):
 *  - Titles drifted between text-lg and text-xl across screens; icon chips
 *    and spacing differed per file.
 *  - Several screens (PurchaseOrders, PurchaseInvoices, StockOperations tabs)
 *    rendered a second "form banner" header inside a tab/form view, stacking
 *    two or three page titles on 1366x768 displays. The rule now is: the
 *    page header states WHERE you are; tab bars, form cards and registers
 *    must not repeat a page-level title.
 *
 * Every register screen should render exactly one <PageHeader> at the top.
 *
 * Nothing in the header truncates. The 2026-10-30 sweep of all 68 screens found
 * titles and descriptions ending in "…" at 1440 ("Damaged Stock Matri…"),
 * because the action row can claim almost all of the width. Wrapping costs a
 * line; an ellipsis costs the user the name of the screen and the sentence that
 * explains it. Below xl the header stacks so the title gets the full width.
 */
export function PageHeader({
  title,
  description,
  icon,
  actions,
  actionsClassName = '',
}: PageHeaderProps) {
  return (
    <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
          {icon}
          <span className="min-w-0 break-words">{title}</span>
        </h2>
        {description != null && (
          <p className="text-xs mt-0.5 leading-snug break-words text-slate-500 dark:text-slate-400">
            {description}
          </p>
        )}
      </div>

      {actions != null && (
        <div className={`shrink-0 flex flex-wrap items-center gap-2 ${actionsClassName}`}>
          {actions}
        </div>
      )}
    </div>
  );
}

export default PageHeader;
