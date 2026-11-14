import React from 'react';
import type { StatementFormat } from './statementTFormat';

const buttonClass = (active: boolean): string =>
  `rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors ${
    active
      ? 'bg-indigo-600 text-white shadow-sm'
      : 'text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700'
  }`;

/** Current period only vs the equal-length preceding period. */
export const ComparativeToggle: React.FC<{
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}> = ({ enabled, onChange }) => (
  <button
    type="button"
    aria-pressed={enabled}
    aria-label="Compare periods"
    className={`rounded-xl border px-3 py-1.5 text-[11px] font-bold transition-colors ${
      enabled
        ? 'border-indigo-600 bg-indigo-600 text-white'
        : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
    }`}
    onClick={() => onChange(!enabled)}
  >
    Compare
  </button>
);

/** Normal statement vs two-sided T-account presentation. */
export const StatementFormatToggle: React.FC<{
  format: StatementFormat;
  onChange: (format: StatementFormat) => void;
}> = ({ format, onChange }) => (
  <div
    role="group"
    aria-label="Statement format"
    className="inline-flex rounded-xl border border-slate-300 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900"
  >
    <button
      type="button"
      aria-pressed={format === 'NORMAL'}
      className={buttonClass(format === 'NORMAL')}
      onClick={() => onChange('NORMAL')}
    >
      Normal
    </button>
    <button
      type="button"
      aria-pressed={format === 'T_FORMAT'}
      className={buttonClass(format === 'T_FORMAT')}
      onClick={() => onChange('T_FORMAT')}
    >
      T-Format
    </button>
  </div>
);

export type ProfitAndLossReportView = 'PROFIT_AND_LOSS' | 'TRADING';

export type TrialBalanceDetail = 'DETAILED' | 'GROUP_TOTALS';

/** Detailed ledgers vs group/sub-group subtotals for the trial balance. */
export const TrialBalanceDetailToggle: React.FC<{
  detail: TrialBalanceDetail;
  onChange: (detail: TrialBalanceDetail) => void;
}> = ({ detail, onChange }) => (
  <div
    role="group"
    aria-label="Trial balance detail"
    className="inline-flex rounded-xl border border-slate-300 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900"
  >
    <button
      type="button"
      aria-pressed={detail === 'DETAILED'}
      className={buttonClass(detail === 'DETAILED')}
      onClick={() => onChange('DETAILED')}
    >
      Detailed
    </button>
    <button
      type="button"
      aria-pressed={detail === 'GROUP_TOTALS'}
      className={buttonClass(detail === 'GROUP_TOTALS')}
      onClick={() => onChange('GROUP_TOTALS')}
    >
      Groups only
    </button>
  </div>
);

/** Which statement the P&L register is showing. */
export const ProfitAndLossViewToggle: React.FC<{
  view: ProfitAndLossReportView;
  onChange: (view: ProfitAndLossReportView) => void;
}> = ({ view, onChange }) => (
  <div
    role="group"
    aria-label="Profit and loss report"
    className="inline-flex rounded-xl border border-slate-300 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900"
  >
    <button
      type="button"
      aria-pressed={view === 'PROFIT_AND_LOSS'}
      className={buttonClass(view === 'PROFIT_AND_LOSS')}
      onClick={() => onChange('PROFIT_AND_LOSS')}
    >
      P&amp;L
    </button>
    <button
      type="button"
      aria-pressed={view === 'TRADING'}
      className={buttonClass(view === 'TRADING')}
      onClick={() => onChange('TRADING')}
    >
      Trading
    </button>
  </div>
);
