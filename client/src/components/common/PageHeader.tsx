import React from 'react';

interface PageHeaderProps {
  /** Page title — always rendered as the single h2 for the screen. */
  title: string;
  /** One-line description under the title. Keep register facts here instead
   *  of in fake-metric cards (see UoM/Category). */
  description?: React.ReactNode;
  /** Optional icon, typically a lucide icon sized h-5 w-5. Rendered as-is. */
  icon?: React.ReactNode;
  /** Right-side action buttons (Export, New, Back...). Wrap each in the
   *  standard button classes the screen already uses. */
  actions?: React.ReactNode;
  /** Optional extra classes for the actions wrapper (alignment tweaks). */
  actionsClassName?: string;
  /** Set false when the title should not be truncated (rare). */
  truncate?: boolean;
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
 */
export function PageHeader({
  title,
  description,
  icon,
  actions,
  actionsClassName = '',
  truncate = true,
}: PageHeaderProps) {
  return (
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
          {icon}
          <span className={truncate ? 'truncate' : undefined}>{title}</span>
        </h2>
        {description != null && (
          <p
            className={`text-xs mt-0.5 text-slate-500 dark:text-slate-400 ${
              truncate ? 'truncate' : ''
            }`}
          >
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
