import React from 'react';
import { KpiStrip, KPI_TONE_TEXT } from '../common/KpiStrip';
import type { ProfitAndLossResponse, StatementGroupBlock } from '../../services/api/accounting';
import { SectionBody } from './StatementPrimitives';
import { TAccountView } from './TAccountView';
import { buildTradingAccount, type StatementFormat } from './statementTFormat';
import { ComparativePanel } from './ComparativePanel';
import { tradingAccountComparisonRows } from './comparative';
import { money } from './statementFormat';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { precedingEqualWindow } from '../../utils/comparativePeriod';

const TRADING_NOTE =
  'Trading account uses the chart’s Revenue and Cost of sales groups. Closing stock is already reflected in cost of sales, so it is not added as a second line.';

/**
 * Trading account from the same posted P&L response. The normal view keeps the
 * familiar statement order; the T view shows the debit (cost of sales) and
 * credit (revenue) sides with gross profit or loss carried down.
 */
export const TradingAccountView: React.FC<{
  data: ProfitAndLossResponse;
  format?: StatementFormat;
  comparative?: boolean;
  prior?: ProfitAndLossResponse | null;
  priorLoading?: boolean;
  priorError?: string;
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
  const tradingSections = data.sections.filter(
    (section) => section.statementGroup === 'REVENUE' || section.statementGroup === 'COST_OF_SALES'
  );
  const period = `${data.from ? formatDualDate(data.from) : 'From inception'} → ${formatDualDate(data.to)}`;
  const priorWindow = precedingEqualWindow(data.from, data.to);
  const comparison = comparative ? (
    <ComparativePanel
      title="Comparative trading account"
      currentLabel={period}
      priorLabel={priorWindow ? `${formatDualDate(priorWindow.from)} → ${formatDualDate(priorWindow.to)}` : null}
      rows={tradingAccountComparisonRows(data, prior)}
      note="Prior figures use the equal-length period ending the day before the current period start. Closing stock is not a separate comparative line because cost of sales already carries the stock movement."
      loading={priorLoading}
      error={priorError}
    />
  ) : null;

  if (format === 'T_FORMAT') {
    return (
      <div className="space-y-4">
        {comparison}
        <TAccountView
          title="Trading account — T format"
          subtitle={`${period}, from posted journal lines.`}
          report={buildTradingAccount(data)}
          debitLabel="Cost of sales"
          creditLabel="Revenue"
          note={TRADING_NOTE}
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
          { label: 'REVENUE', value: money(data.revenue), tone: KPI_TONE_TEXT.emerald, hint: 'Trading income for the period' },
          { label: 'COST OF SALES', value: money(data.costOfSales), tone: KPI_TONE_TEXT.rose, hint: 'Inventory consumed by sales' },
          {
            label: 'GROSS PROFIT',
            value: money(data.grossProfit),
            tone: KPI_TONE_TEXT[data.grossProfit >= 0 ? 'indigo' : 'rose'],
            hint: 'Revenue less cost of sales',
          },
        ]}
      />

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
          <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Trading account</h3>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {period}, from posted journal lines.
          </p>
        </div>
        <SectionBody sections={tradingSections} onOpenGroup={onOpenGroup} />
        <div className="border-t border-slate-200 bg-slate-100 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/80">
          <div className="flex items-center justify-between py-0.5 text-slate-600 dark:text-slate-400">
            <span>Revenue</span>
            <span className="font-mono">{money(data.revenue)}</span>
          </div>
          <div className="flex items-center justify-between py-0.5 text-slate-600 dark:text-slate-400">
            <span>Less: cost of sales</span>
            <span className="font-mono">{money(data.costOfSales)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between border-t border-slate-200 pt-1 text-sm font-bold text-slate-900 dark:border-slate-700 dark:text-white">
            <span>Gross profit</span>
            <span className={`font-mono ${data.grossProfit < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
              {money(data.grossProfit)}
            </span>
          </div>
        </div>
      </div>

      <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-snug text-slate-500 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
        {TRADING_NOTE}
      </p>
    </div>
  );
};
