import React from 'react';
import { KpiStrip, KPI_TONE_TEXT } from '../common/KpiStrip';
import type { ProfitAndLossResponse, StatementGroupBlock } from '../../services/api/accounting';
import { SectionBody } from './StatementPrimitives';
import { TAccountView } from './TAccountView';
import { buildProfitAndLossTAccount, type StatementFormat } from './statementTFormat';
import { ComparativePanel } from './ComparativePanel';
import { profitAndLossComparisonRows } from './comparative';
import { money } from './statementFormat';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { precedingEqualWindow } from '../../utils/comparativePeriod';

export const ProfitAndLossView: React.FC<{
  data: ProfitAndLossResponse;
  /** Normal or two-sided presentation; the figures are identical. */
  format?: StatementFormat;
  comparative?: boolean;
  prior?: ProfitAndLossResponse | null;
  priorLoading?: boolean;
  priorError?: string;
  /** Opens the posted journal lines behind a group subtotal. */
  onOpenGroup?: (group: StatementGroupBlock) => void;
}> = ({
  data,
  format = 'NORMAL',
  comparative = false,
  prior = null,
  priorLoading = false,
  priorError = '',
  onOpenGroup,
}) => {
  const priorWindow = precedingEqualWindow(data.from, data.to);
  const comparison = comparative ? (
    <ComparativePanel
      title="Comparative profit & loss"
      currentLabel={`${data.from ? formatDualDate(data.from) : 'From inception'} → ${formatDualDate(data.to)}`}
      priorLabel={priorWindow ? `${formatDualDate(priorWindow.from)} → ${formatDualDate(priorWindow.to)}` : null}
      rows={profitAndLossComparisonRows(data, prior)}
      note="Prior figures use the equal-length period ending the day before the current period start. Change % is shown only when the prior figure is non-zero."
      loading={priorLoading}
      error={priorError}
    />
  ) : null;

  if (format === 'T_FORMAT') {
    return (
      <div className="space-y-4">
        {comparison}
        <TAccountView
          title="Profit & loss — T format"
          subtitle={`Turnover in the period ${data.from ? formatDualDate(data.from) : 'from inception'} → ${formatDualDate(data.to)}, from posted journal lines.`}
          report={buildProfitAndLossTAccount(data)}
          debitLabel="Expenses"
          creditLabel="Income"
          note="Gross profit is brought down from the trading account; a net profit is carried down on the debit side, and a net loss is carried down on the credit side."
          onOpenGroup={onOpenGroup}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {comparison}
    <KpiStrip
      items={[
        { label: 'TOTAL INCOME', value: money(data.totalIncome), tone: KPI_TONE_TEXT.emerald, hint: 'Revenue and other income' },
        { label: 'COST OF SALES', value: money(data.costOfSales), tone: KPI_TONE_TEXT.rose, hint: 'Inventory consumed by sales' },
        { label: 'OPERATING EXPENSES', value: money(data.operatingExpense), tone: KPI_TONE_TEXT.amber, hint: 'Period operating costs' },
        {
          label: 'NET PROFIT',
          value: money(data.netProfit),
          tone: KPI_TONE_TEXT[data.netProfit >= 0 ? 'indigo' : 'rose'],
          hint: 'Income less all expenses',
        },
      ]}
    />

    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
      <div className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Statement of profit or loss</h3>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          Turnover in the period {data.from ? formatDualDate(data.from) : 'from inception'} →{' '}
          {formatDualDate(data.to)}, from posted journal lines.
        </p>
      </div>
      <SectionBody sections={data.sections} onOpenGroup={onOpenGroup} />
      <div className="border-t border-slate-200 bg-slate-100 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/80">
        <div className="flex items-center justify-between py-0.5 text-slate-600 dark:text-slate-400">
          <span>Gross profit (revenue − cost of sales)</span>
          <span className="font-mono font-bold text-slate-800 dark:text-slate-200">{money(data.grossProfit)}</span>
        </div>
        <div className="flex items-center justify-between py-0.5 text-slate-600 dark:text-slate-400">
          <span>Other income</span>
          <span className="font-mono">{money(data.otherIncome)}</span>
        </div>
        <div className="flex items-center justify-between py-0.5 text-slate-600 dark:text-slate-400">
          <span>Other expenses</span>
          <span className="font-mono">{money(data.otherExpense)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-slate-200 pt-1 text-sm font-bold text-slate-900 dark:border-slate-700 dark:text-white">
          <span>Net profit for the period</span>
          <span className={`font-mono ${data.netProfit < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
            {money(data.netProfit)}
          </span>
        </div>
      </div>
    </div>
    </div>
  );
};
