import React from 'react';
import type { BalanceSheetResponse, StatementGroupBlock } from '../../services/api/accounting';
import { SectionBody, StatusPill } from './StatementPrimitives';
import { money } from './statementFormat';

export const BalanceSheetView: React.FC<{
  data: BalanceSheetResponse;
  /** Opens the posted journal lines behind a group subtotal. */
  onOpenGroup?: (group: StatementGroupBlock) => void;
}> = ({ data, onOpenGroup }) => (
  <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
      <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
        Assets must equal liabilities plus equity as of {data.asOf}.
      </p>
      <StatusPill ok={data.balanced} okLabel="Balance sheet balances" badLabel={`Difference ${money(data.difference)}`} />
    </div>

    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200">Assets</h3>
          <span className="font-mono text-sm font-bold">{money(data.totalAssets)}</span>
        </div>
        <SectionBody sections={data.assets.sections} onOpenGroup={onOpenGroup} />
        <div className="border-t border-slate-200 bg-slate-100 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/80">
          <div className="flex items-center justify-between py-0.5 text-slate-600 dark:text-slate-400">
            <span>Cash &amp; bank (per cash book)</span>
            <span className="font-mono font-bold">{money(data.cashAndBank)}</span>
          </div>
          <div className="flex items-center justify-between py-0.5 text-slate-600 dark:text-slate-400">
            <span>Due from head office</span>
            <span className="font-mono">{money(data.interBranch.dueFromHeadOffice)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between border-t border-slate-200 pt-1 text-sm font-bold dark:border-slate-700">
            <span>Total assets</span>
            <span className="font-mono">{money(data.totalAssets)}</span>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200">
            Liabilities &amp; equity
          </h3>
        </div>
        <SectionBody sections={data.liabilities.sections} onOpenGroup={onOpenGroup} />
        <div className="border-t border-slate-100 px-3 py-2 dark:border-slate-800/60">
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Equity</h4>
          <SectionBody sections={data.equity.sections} onOpenGroup={onOpenGroup} />
          <div className="flex items-center justify-between py-0.5 text-xs text-slate-600 dark:text-slate-400">
            <span>Current earnings (income − expenses)</span>
            <span className="font-mono">{money(data.equity.currentEarnings)}</span>
          </div>
        </div>
        <div className="border-t border-slate-200 bg-slate-100 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/80">
          <div className="flex items-center justify-between py-0.5 text-slate-600 dark:text-slate-400">
            <span>Total liabilities</span>
            <span className="font-mono">{money(data.totalLiabilities)}</span>
          </div>
          <div className="flex items-center justify-between py-0.5 text-slate-600 dark:text-slate-400">
            <span>Total equity</span>
            <span className="font-mono">{money(data.totalEquity)}</span>
          </div>
          <div className="flex items-center justify-between py-0.5 text-slate-600 dark:text-slate-400">
            <span>Due to head office</span>
            <span className="font-mono">{money(data.interBranch.dueToHeadOffice)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between border-t border-slate-200 pt-1 text-sm font-bold dark:border-slate-700">
            <span>Total liabilities &amp; equity</span>
            <span className="font-mono">{money(data.totalLiabilitiesAndEquity)}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
);
