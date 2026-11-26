import React from 'react';

/**
 * One item in a {@link KpiStrip}.
 *
 * Mirrors the parts of `StatCard` a register actually uses, so a screen can
 * move a tall card row onto a single inline bar without rewriting its maths.
 */
export interface KpiStripItem {
  /** Uppercase micro-label (rendered after the value). */
  label: string;
  /** The headline figure. */
  value: React.ReactNode;
  /** Optional second figure / explanation, shown as a tooltip. */
  hint?: React.ReactNode;
  /**
   * Render the hint as visible text instead of a tooltip only.
   *
   * The compaction this bar exists for assumes a hint is secondary. It is not
   * when the figure cannot be read on its own: a dash for "this server did not
   * report the row" looks like zero until the user hovers. Those items set this
   * so the explanation is in the DOM text, not just in `title`.
   */
  hintVisible?: boolean;
  /** lucide icon rendered at 14 px in the tone colour. */
  icon?: React.ReactNode;
  /** Text-colour classes for the icon only, e.g. "text-rose-500". */
  tone?: string;
  /** When set the item becomes a real button (filter toggle / drill-down). */
  onClick?: () => void;
  /** Filter-toggle state for clickable items. */
  active?: boolean;
  /** Accessible description for clickable items. */
  title?: string;
}

/**
 * Tone -> icon text colour, mirroring StatCard's tone palette so a screen that
 * migrates a card row onto the strip keeps the same colour vocabulary.
 */
export const KPI_TONE_TEXT: Record<string, string> = {
  indigo: 'text-indigo-500 dark:text-indigo-400',
  sky: 'text-sky-500 dark:text-sky-400',
  emerald: 'text-emerald-500 dark:text-emerald-400',
  rose: 'text-rose-500 dark:text-rose-400',
  amber: 'text-amber-500 dark:text-amber-400',
  violet: 'text-violet-500 dark:text-violet-400',
  teal: 'text-teal-500 dark:text-teal-400',
  slate: 'text-slate-500 dark:text-slate-400',
};

interface KpiStripProps {
  items: KpiStripItem[];
  /** Optional extra classes merged onto the bar. */
  className?: string;
}

/**
 * Compact inline KPI bar — the register/report counterpart of the
 * Organizational Chart's stat line.
 *
 * Why this exists: the tall `StatCard` rows cost a three-to-five-card band
 * (roughly 90 px plus gaps) at the top of every register, pushing the table
 * itself below the fold on 1366x768 laptops. The same figures fit in one
 * 34 px bar, so the register keeps maximum vertical space for content.
 *
 * Design rules:
 *  - Same neutral surface and border as the other compact bars, so it reads
 *    as part of the filter/header stack rather than as a card.
 *  - Colour enters only through the icon and the numeral, like `StatCard`.
 *  - Clickable items render a real `<button>` (keyboard focusable, 24 px
 *    target) and get the indigo ring while their filter is applied, so the
 *    drill-down behaviour of the old cards survives the compaction.
 */
export function KpiStrip({ items, className = '' }: KpiStripProps) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400 ${className}`}
    >
      {items.map((item) => {
        const body = (
          <>
            {item.icon != null && (
              <span className={`shrink-0 ${item.tone || 'text-slate-400 dark:text-slate-500'}`} aria-hidden>
                {item.icon}
              </span>
            )}
            <b className="font-mono text-xs text-slate-900 dark:text-white">{item.value}</b>
            <span>{item.label}</span>
            {item.hintVisible && item.hint != null && (
              <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                · {item.hint}
              </span>
            )}
          </>
        );

        const title =
          item.title ?? (item.hint != null ? `${item.label}: ${String(item.hint)}` : undefined);

        if (item.onClick) {
          return (
            <button
              key={item.label}
              type="button"
              onClick={item.onClick}
              title={title}
              aria-pressed={Boolean(item.active)}
              className={`inline-flex min-h-[24px] cursor-pointer items-center gap-1.5 rounded-md px-1 -mx-1 transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 dark:hover:bg-slate-800 ${
                item.active
                  ? 'ring-1 ring-indigo-500/50 text-slate-900 dark:text-slate-100'
                  : ''
              }`}
            >
              {body}
            </button>
          );
        }

        return (
          <span key={item.label} className="inline-flex items-center gap-1.5" title={title}>
            {body}
          </span>
        );
      })}
    </div>
  );
}

export default KpiStrip;
