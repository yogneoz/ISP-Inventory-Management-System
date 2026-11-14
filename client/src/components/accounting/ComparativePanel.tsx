import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { money } from './statementFormat';
import type { ComparativeRow } from './comparative';
import { comparativeChange } from './comparative';

/**
 * Side-by-side current and prior figures with absolute and percentage change.
 * It deliberately shows an em dash, not a fabricated zero, when the prior
 * response is unavailable; a prior response that exists but has no activity
 * arrives as real zeroes from the statement endpoint.
 */
export const ComparativePanel: React.FC<{
  title: string;
  currentLabel: string;
  priorLabel: string | null;
  rows: ComparativeRow[];
  note?: string;
  loading?: boolean;
  error?: string;
}> = ({ title, currentLabel, priorLabel, rows, note, loading = false, error = '' }) => (
  <section
    aria-label="Comparative period"
    className="overflow-hidden rounded-2xl border border-indigo-200 bg-white dark:border-indigo-900/60 dark:bg-slate-900/40"
  >
    <div className="flex flex-wrap items-start justify-between gap-2 border-b border-indigo-100 bg-indigo-50/70 px-3 py-2 dark:border-indigo-900/50 dark:bg-indigo-950/20">
      <div>
        <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">{title}</h3>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {currentLabel} vs {priorLabel || 'prior period unavailable'}
        </p>
      </div>
      {loading && (
        <span role="status" className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
          <RefreshCw className="h-3 w-3 animate-spin" /> Loading prior period
        </span>
      )}
    </div>

    {error && (
      <div role="alert" className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[10px] font-semibold text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">
        <AlertTriangle className="h-3 w-3 shrink-0" /> {error}
      </div>
    )}

    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="border-b border-slate-200 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-300">
          <tr>
            <th className="px-3 py-1.5">Line</th>
            <th className="px-3 py-1.5 text-right">Current</th>
            <th className="px-3 py-1.5 text-right">Prior</th>
            <th className="px-3 py-1.5 text-right">Change</th>
            <th className="px-3 py-1.5 text-right">Change %</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
          {rows.map((row) => {
            const change = comparativeChange(row);
            return (
              <tr key={row.key} className={row.emphasis ? 'font-bold text-slate-900 dark:text-slate-100' : 'text-slate-700 dark:text-slate-300'}>
                <td className="px-3 py-1.5" style={{ paddingLeft: 12 + (row.level || 0) * 16 }}>
                  {row.label}
                </td>
                <td className="px-3 py-1.5 text-right font-mono">{money(row.current)}</td>
                <td className="px-3 py-1.5 text-right font-mono">
                  {row.prior === null ? '—' : money(row.prior)}
                </td>
                <td className={`px-3 py-1.5 text-right font-mono ${change.change !== null && change.change < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                  {change.change === null
                    ? '—'
                    : `${change.change > 0 ? '+' : ''}${money(change.change)}`}
                </td>
                <td className={`px-3 py-1.5 text-right font-mono ${change.percent !== null && change.percent < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                  {change.percent === null
                    ? '—'
                    : `${change.percent > 0 ? '+' : ''}${change.percent.toFixed(1)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>

    {note && (
      <p className="border-t border-slate-100 px-3 py-2 text-[10px] leading-snug text-slate-500 dark:border-slate-800/60 dark:text-slate-400">
        {note}
      </p>
    )}
  </section>
);
