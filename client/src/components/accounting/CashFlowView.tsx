import React from 'react';
import { StatCard } from '../common/StatCard';
import type { CashFlowResponse } from '../../services/api/accounting';
import { StatusPill } from './StatementPrimitives';
import { money } from './statementFormat';

export const CashFlowView: React.FC<{ data: CashFlowResponse }> = ({ data }) => {
  const operating = data.sections.find((section) => section.key === 'OPERATING')?.amount ?? 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
        <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
          Direct method: posted cash and bank movements, classified by their counterpart account.
        </p>
        <StatusPill
          ok={data.reconciled}
          okLabel="Ties to cash book"
          badLabel={`Cash-book difference ${money(data.cashBookClosing - data.closingCash)}`}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="OPENING CASH" value={money(data.openingCash)} tone="slate" hint="Before the period" />
        <StatCard label="OPERATING CASH" value={money(operating)} tone={operating >= 0 ? 'emerald' : 'rose'} hint="Trading and working capital" />
        <StatCard label="NET CASH FLOW" value={money(data.netCashFlow)} tone={data.netCashFlow >= 0 ? 'indigo' : 'rose'} hint="Receipts less payments" />
        <StatCard label="CLOSING CASH" value={money(data.closingCash)} tone="amber" hint="Per the cash book" />
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
          <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Statement of cash flows</h3>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {data.from || 'From inception'} → {data.to}, from posted journal lines.
          </p>
        </div>

        {data.sections.map((section) => (
          <div key={section.key} className="border-b border-slate-100 last:border-b-0 dark:border-slate-800/60">
            <div className="flex items-center justify-between gap-3 bg-slate-50 px-3 py-2 dark:bg-slate-900/80">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                {section.label}
              </h4>
              <span className={`font-mono text-xs font-bold ${section.amount < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-200'}`}>
                {money(section.amount)}
              </span>
            </div>
            {section.lines.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-slate-400">No cash movement in this section.</p>
            ) : (
              section.lines.map((line) => (
                <div
                  key={line.accountId}
                  className="flex items-center justify-between gap-3 border-b border-dashed border-slate-100 px-3 py-1.5 last:border-b-0 dark:border-slate-800/60"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs text-slate-700 dark:text-slate-300">
                      <span className="mr-2 font-mono text-[10px] text-slate-400">{line.accountCode}</span>
                      {line.accountName}
                    </p>
                    <p className="text-[10px] text-slate-400">
                      {line.groupCode} · {line.groupName} · {line.journalCount} {line.journalCount === 1 ? 'journal' : 'journals'}
                    </p>
                  </div>
                  <span className={`shrink-0 font-mono text-xs ${line.amount < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300'}`}>
                    {money(line.amount)}
                  </span>
                </div>
              ))
            )}
          </div>
        ))}

        <div className="border-t border-slate-200 bg-slate-100 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/80">
          <div className="flex items-center justify-between py-0.5 text-slate-600 dark:text-slate-400">
            <span>Opening cash and bank</span>
            <span className="font-mono">{money(data.openingCash)}</span>
          </div>
          <div className="flex items-center justify-between py-0.5 text-slate-600 dark:text-slate-400">
            <span>Net movement in cash and bank</span>
            <span className="font-mono">{money(data.netCashFlow)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between border-t border-slate-200 pt-1 text-sm font-bold text-slate-900 dark:border-slate-700 dark:text-white">
            <span>Closing cash and bank</span>
            <span className="font-mono">{money(data.closingCash)}</span>
          </div>
          <p className="mt-1 text-[10px] text-slate-400">
            Cash book closing: {money(data.cashBookClosing)} · Classified total: {money(data.classifiedCashFlow)}
          </p>
        </div>
      </div>
    </div>
  );
};

export default CashFlowView;
