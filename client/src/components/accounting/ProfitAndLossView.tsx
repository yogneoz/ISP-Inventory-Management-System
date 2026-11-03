import React from 'react';
import { StatCard } from '../common/StatCard';
import type { ProfitAndLossResponse, StatementGroupBlock } from '../../services/api/accounting';
import { SectionBody } from './StatementPrimitives';
import { money } from './statementFormat';

export const ProfitAndLossView: React.FC<{
  data: ProfitAndLossResponse;
  /** Opens the posted journal lines behind a group subtotal. */
  onOpenGroup?: (group: StatementGroupBlock) => void;
}> = ({ data, onOpenGroup }) => (
  <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="TOTAL INCOME" value={money(data.totalIncome)} tone="emerald" hint="Revenue and other income" />
      <StatCard label="COST OF SALES" value={money(data.costOfSales)} tone="rose" hint="Inventory consumed by sales" />
      <StatCard label="OPERATING EXPENSES" value={money(data.operatingExpense)} tone="amber" hint="Period operating costs" />
      <StatCard label="NET PROFIT" value={money(data.netProfit)} tone={data.netProfit >= 0 ? 'indigo' : 'rose'} hint="Income less all expenses" />
    </div>

    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
      <div className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Statement of profit or loss</h3>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          Turnover in the period {data.from || 'from inception'} → {data.to}, from posted journal lines.
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
