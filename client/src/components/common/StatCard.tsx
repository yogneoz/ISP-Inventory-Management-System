import React from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * Tone presets for StatCard. A tone tints ONLY the icon chip and the value
 * text — the card surface itself is always the same neutral white/dark so
 * score-card rows stay visually uniform across every screen.
 */
const TONES = {
  indigo: {
    iconChip: 'bg-indigo-500/10 text-indigo-500 dark:text-indigo-400',
    value: 'text-indigo-600 dark:text-indigo-400',
  },
  sky: {
    iconChip: 'bg-sky-500/10 text-sky-500 dark:text-sky-400',
    value: 'text-sky-600 dark:text-sky-400',
  },
  emerald: {
    iconChip: 'bg-emerald-500/10 text-emerald-500 dark:text-emerald-400',
    value: 'text-emerald-600 dark:text-emerald-400',
  },
  rose: {
    iconChip: 'bg-rose-500/10 text-rose-500 dark:text-rose-400',
    value: 'text-rose-600 dark:text-rose-400',
  },
  amber: {
    iconChip: 'bg-amber-500/10 text-amber-500 dark:text-amber-400',
    value: 'text-amber-600 dark:text-amber-400',
  },
  violet: {
    iconChip: 'bg-violet-500/10 text-violet-500 dark:text-violet-400',
    value: 'text-violet-600 dark:text-violet-400',
  },
  slate: {
    iconChip: 'bg-slate-500/10 text-slate-500 dark:text-slate-400',
    value: 'text-slate-700 dark:text-slate-200',
  },
} as const;

export type StatCardTone = keyof typeof TONES;

interface StatCardProps {
  /** Uppercase micro-label shown above the value. */
  label: string;
  /** The headline figure (pre-formatted string or node). */
  value: React.ReactNode;
  /** Small helper line under the value (e.g. "20.6% average margin"). */
  hint?: React.ReactNode;
  /** Icon rendered in the tone-tinted chip at the top-right. Omit for a
   *  denser text-only card (e.g. numeric ledgers). */
  icon?: React.ReactNode;
  /** Color family for the icon chip and value text. Default: slate. */
  tone?: StatCardTone;
  /**
   * When provided, the whole card becomes a real button: clicking focuses /
   * navigates to the section this card summarizes. Clickable cards get a
   * hover ring + arrow affordance so they are distinguishable from inert
   * stat cards.
   */
  onClick?: () => void;
  /** Accessible description for clickable cards. */
  title?: string;
  /**
   * For clickable cards acting as filter toggles: true while the linked
   * filter is applied. Renders an indigo ring + filled arrow so the user
   * can see which card is driving the current table state.
   */
  active?: boolean;
  /** Optional extra classes merged onto the card surface (e.g. col-span). */
  className?: string;
  /**
   * Visual variant. 'default' renders the compact mono numeral used in
   * register/tool screens. 'hero' renders a larger serif display numeral —
   * the intentional dashboard style — while sharing the same surface,
   * tones and layout so score-card rows still read as one family.
   */
  variant?: 'default' | 'hero';
}

/**
 * Shared compact KPI / score card — the single source of truth for the
 * metric cards that sit above register tables and dashboards.
 *
 * Design rules (why it looks the way it does):
 *  - COMPACT: p-3 / rounded-xl / text-lg numeral. The old hand-rolled cards
 *    (p-4 / rounded-2xl / text-xl) were ~30% taller and pushed register
 *    tables below the fold on 1366x768 laptops. All sizes are rem-based, so
 *    the global responsive zoom tiers (<=1366px -> 88%, <=1024px -> 78%)
 *    shrink the card proportionally with the rest of the UI.
 *  - UNIFORM SURFACE: every card uses the same white / dark background and
 *    border. Color only enters via the tone (icon chip + value), never as a
 *    full-card tint or gradient, so mixed-tone rows still read as one band.
 *  - OPTIONAL NAVIGATION: pass `onClick` to make the card a button that
 *    jumps to the table/section it summarizes. Hover affordance (ring +
 *    arrow) appears only on clickable cards.
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'slate',
  onClick,
  title,
  active = false,
  className = '',
  variant = 'default',
}: StatCardProps) {
  const t = TONES[tone] ?? TONES.slate;

  const surface =
    'rounded-xl border shadow-xs bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800';
  const interactive =
    'group text-left transition-all cursor-pointer hover:border-indigo-300 hover:shadow-md dark:hover:border-indigo-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60';
  const activeRing =
    'ring-2 ring-indigo-500/50 border-indigo-400 dark:border-indigo-500/60';
  const arrow = (
    <ChevronRight
      className={`h-3.5 w-3.5 transition-all group-hover:translate-x-0.5 ${
        active
          ? 'text-indigo-500 dark:text-indigo-400'
          : 'text-slate-300 group-hover:text-indigo-500 dark:text-slate-600 dark:group-hover:text-indigo-400'
      }`}
    />
  );

  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider truncate">
          {label}
        </span>
        {icon != null && (
          <div className={`p-1.5 rounded-lg flex-shrink-0 ${t.iconChip}`}>{icon}</div>
        )}
      </div>
      <div
        className={`mt-1 leading-tight ${
          variant === 'hero' ? 'text-xl font-serif font-bold' : 'text-lg font-bold font-mono'
        } ${t.value}`}
      >
        {value}
      </div>
      {hint != null && (
        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 font-medium truncate">
          {hint}
        </div>
      )}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-pressed={active}
        className={`${surface} ${interactive} ${active ? activeRing : ''} p-3 w-full ${className}`}
      >
        <div className="flex items-start justify-between gap-1">
          <div className="min-w-0">{inner}</div>
          <div className="mt-5 flex-shrink-0">{arrow}</div>
        </div>
      </button>
    );
  }

  return <div className={`${surface} p-3 ${className}`}>{inner}</div>;
}

/** Standard responsive grid for a row of StatCards. */
export function StatCardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
      {children}
    </div>
  );
}

export default StatCard;
