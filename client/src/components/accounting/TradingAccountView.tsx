import React from 'react';
import { StatCard } from '../common/StatCard';
import type { ProfitAndLossResponse, StatementGroupBlock } from '../../services/api/accounting';
import { SectionBody } from './StatementPrimitives';
import { TAccountView } from './TAccountView';
import { buildTradingAccount, type StatementFormat } from './statementTFormat';
import { money } from './statementFormat';
import { formatDualDate } from '../../utils/nepaliCalendar';

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
  onOpenGroup?: (group: StatementGroupBlock) => void;
}> = ({ data, format = 'NORMAL', onOpenGroup }) => {
  const tradingSections = data.sections.filter(
    (section) => section.statementGroup === 'REVENUE' || section.statementGroup === 'COST_OF_SALES'
  );
  const period = `${data.from ? formatDualDate(data.from) : 'From inception'} → ${formatDualDate(data.to)}`;

  if (format === 'T_FORMAT') {
    return (
      <TAccountView
        title="Trading account — T format"
        subtitle={`${period}, from posted journal lines.`}
        report={buildTradingAccount(data)}
        debitLabel="Cost of sales"
        creditLabel="Revenue"
        note={TRADING_NOTE}
        onOpenGroup={onOpenGroup}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="REVENUE" value={money(data.revenue)} tone="emerald" hint="Trading income for the period" />
        <StatCard label="COST OF SALES" value={money(data.costOfSales)} tone="rose" hint="Inventory consumed by sales" />
        <StatCard
          label="GROSS PROFIT"
          value={money(data.grossProfit)}
          tone={data.grossProfit >= 0 ? 'indigo' : 'rose'}
          hint="Revenue less cost of sales"
        />
      </div>

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
