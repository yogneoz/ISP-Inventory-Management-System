import React from 'react';
import type { StatementGroupBlock } from '../../services/api/accounting';
import { SectionBody, StatusPill } from './StatementPrimitives';
import { money } from './statementFormat';
import type { TAccountEntry, TAccountReport, TAccountSide } from './statementTFormat';

const Side: React.FC<{
  side: TAccountSide;
  marker: 'Dr' | 'Cr';
  label: string;
  onOpenGroup?: (group: StatementGroupBlock) => void;
}> = ({ side, marker, label, onOpenGroup }) => (
  <div className="min-w-0">
    <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-700">
      <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200">
        <span className="mr-2 font-mono text-indigo-600 dark:text-indigo-400">{marker}</span>
        {label}
      </h4>
      <span className="font-mono text-sm font-bold text-slate-800 dark:text-slate-200">
        {money(side.total)}
      </span>
    </div>
    <div className="min-h-24">
      {side.sections.length > 0 ? (
        <SectionBody sections={side.sections} onOpenGroup={onOpenGroup} />
      ) : (
        <p className="px-3 py-3 text-xs text-slate-400">No posted amounts on this side.</p>
      )}
      {side.entries.length > 0 && (
        <div className="border-t border-slate-100 px-3 py-1 dark:border-slate-800/60">
          {side.entries.map((entry: TAccountEntry) => (
            <div key={entry.key} className="flex items-center justify-between gap-3 py-1 text-xs font-semibold text-slate-700 dark:text-slate-300">
              <span>{entry.label}</span>
              <span className="shrink-0 font-mono">{money(entry.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
    <div className="flex items-center justify-between border-t border-slate-200 bg-slate-100 px-3 py-2 text-xs font-bold text-slate-800 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-200">
      <span>Total {label.toLowerCase()}</span>
      <span className="font-mono">{money(side.total)}</span>
    </div>
  </div>
);

/**
 * A two-sided statement layout. The figures are supplied by the existing
 * statement response (via `statementTFormat`), so this component only changes
 * presentation and keeps the same group drill-down controls as the normal view.
 */
export const TAccountView: React.FC<{
  title: string;
  subtitle: string;
  report: TAccountReport;
  debitLabel?: string;
  creditLabel?: string;
  note?: string;
  onOpenGroup?: (group: StatementGroupBlock) => void;
}> = ({
  title,
  subtitle,
  report,
  debitLabel = 'Debit',
  creditLabel = 'Credit',
  note,
  onOpenGroup,
}) => (
  <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
      <div>
        <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">{title}</h3>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">{subtitle}</p>
      </div>
      <StatusPill
        ok={report.balanced}
        okLabel="Both sides agree"
        badLabel={`Difference ${money(report.difference)}`}
      />
    </div>

    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
      <div className="grid grid-cols-1 divide-y divide-slate-200 xl:grid-cols-2 xl:divide-x xl:divide-y-0 dark:divide-slate-700">
        <Side side={report.debit} marker="Dr" label={debitLabel} onOpenGroup={onOpenGroup} />
        <Side side={report.credit} marker="Cr" label={creditLabel} onOpenGroup={onOpenGroup} />
      </div>
    </div>

    {note && (
      <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-snug text-slate-500 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
        {note}
      </p>
    )}
  </div>
);
