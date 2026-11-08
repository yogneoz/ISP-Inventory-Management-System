import React from 'react';
import { AlertTriangle, ArrowUpRight, Loader2, RefreshCw } from 'lucide-react';
import type { BalanceSheetResponse, ProfitAndLossResponse } from '../../services/api/accounting';
import { formatMoney } from '../../utils/nprFormat';

export interface FinanceBranchRow {
  branchId: string;
  code: string;
  name: string;
  pnl: ProfitAndLossResponse | null;
  balance: BalanceSheetResponse | null;
  error?: string;
}

export interface FinanceBranchMetrics {
  revenue: number;
  netProfit: number;
  netMargin: number | null;
  cash: number;
  workingCapital: number;
  currentRatio: number | null;
}

const n = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatPercent = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}%`;

const formatRatio = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(2)}×`;

const sectionAmount = (
  sections: ReadonlyArray<{ statementGroup: string; amount: number }> | undefined,
  key: string
): number => n(sections?.find((section) => section.statementGroup === key)?.amount);

export const metricsForBranch = (
  pnl: ProfitAndLossResponse | null,
  balance: BalanceSheetResponse | null
): FinanceBranchMetrics => {
  const revenue = n(pnl?.revenue);
  const netProfit = n(pnl?.netProfit);
  const currentAssets = sectionAmount(balance?.assets.sections, 'CURRENT_ASSET');
  const currentLiabilities = sectionAmount(balance?.liabilities.sections, 'CURRENT_LIABILITY');
  return {
    revenue,
    netProfit,
    netMargin: revenue !== 0 ? (netProfit / revenue) * 100 : null,
    cash: n(balance?.cashAndBank),
    workingCapital: currentAssets - currentLiabilities,
    currentRatio: currentLiabilities > 0 ? currentAssets / currentLiabilities : null,
  };
};

const BranchAmount: React.FC<{ value: number; negative?: boolean }> = ({ value, negative = false }) => (
  <span
    className={
      negative && value < 0
        ? 'font-mono font-semibold text-rose-600 dark:text-rose-400'
        : 'font-mono text-slate-700 dark:text-slate-200'
    }
  >
    {formatMoney(value)}
  </span>
);

const BranchRow: React.FC<{
  row: FinanceBranchRow;
  selected: boolean;
  company?: boolean;
  onOpenPnlLines: (row: FinanceBranchRow) => void;
  onOpenBalanceLines: (row: FinanceBranchRow) => void;
}> = ({ row, selected, company = false, onOpenPnlLines, onOpenBalanceLines }) => {
  const metrics = metricsForBranch(row.pnl, row.balance);
  return (
    <tr
      className={
        company
          ? 'bg-indigo-50/70 dark:bg-indigo-950/20'
          : selected
            ? 'bg-slate-50 dark:bg-slate-800/40'
            : 'hover:bg-slate-50/60 dark:hover:bg-slate-800/20'
      }
    >
      <td className="px-3 py-2.5">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {row.code}
          </span>
          <div className="min-w-0">
            <span className="block font-semibold text-slate-700 dark:text-slate-200">{row.name}</span>
            {company && (
              <span className="mt-0.5 block text-[10px] text-indigo-600 dark:text-indigo-400">
                Consolidated posted ledger
              </span>
            )}
            {row.error && (
              <span className="mt-0.5 flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" /> {row.error}
              </span>
            )}
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right">
        {row.pnl ? <BranchAmount value={metrics.revenue} /> : '—'}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right">
        {row.pnl ? <BranchAmount value={metrics.netProfit} negative /> : '—'}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-slate-600 dark:text-slate-300">
        {row.pnl ? formatPercent(metrics.netMargin) : '—'}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right">
        {row.balance ? <BranchAmount value={metrics.cash} negative /> : '—'}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right">
        {row.balance ? <BranchAmount value={metrics.workingCapital} negative /> : '—'}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-slate-600 dark:text-slate-300">
        {row.balance ? formatRatio(metrics.currentRatio) : '—'}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right">
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            onClick={() => onOpenPnlLines(row)}
            disabled={!row.pnl}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-500/40 dark:hover:bg-indigo-950/30 dark:hover:text-indigo-300"
            title={row.pnl ? 'Open the posted P&L lines behind this column' : 'P&L lines unavailable'}
          >
            P&L lines <ArrowUpRight className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => onOpenBalanceLines(row)}
            disabled={!row.balance}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-500/40 dark:hover:bg-indigo-950/30 dark:hover:text-indigo-300"
            title={row.balance ? 'Open the posted balance-sheet lines behind this column' : 'Balance-sheet lines unavailable'}
          >
            BS lines <ArrowUpRight className="h-3 w-3" />
          </button>
        </div>
      </td>
    </tr>
  );
};

export const FinanceBranchComparison: React.FC<{
  rows: FinanceBranchRow[];
  company?: FinanceBranchRow | null;
  selectedBranchId: string;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onOpenPnlLines: (row: FinanceBranchRow) => void;
  onOpenBalanceLines: (row: FinanceBranchRow) => void;
  periodLabel: string;
  asOfLabel: string;
}> = ({
  rows,
  company,
  selectedBranchId,
  loading,
  error,
  onRetry,
  onOpenPnlLines,
  onOpenBalanceLines,
  periodLabel,
  asOfLabel,
}) => {
  const allRows = company ? [company, ...rows] : rows;
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-[#0f1218]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div>
          <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">Branch comparison</h3>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            Posted P&amp;L and balance-sheet position by branch for {periodLabel}.{' '}
            {company
              ? 'The company row is the consolidated ledger; branch rows are each branch’s own posted ledger.'
              : 'Each row is a branch’s own posted ledger.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-500 dark:text-slate-400">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold dark:bg-slate-800">
            {periodLabel}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold dark:bg-slate-800">
            As of {asOfLabel}
          </span>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" /> {error}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 rounded-lg border border-amber-300 px-2 py-1 font-bold hover:bg-amber-100 dark:border-amber-600/40 dark:hover:bg-amber-900/30"
          >
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      )}

      {loading ? (
        <div role="status" className="flex items-center gap-2 px-4 py-8 text-xs text-slate-500 dark:text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading branch comparison from the posted ledger…
        </div>
      ) : allRows.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-slate-400">
          No branch scope is available for this comparison.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1050px] text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">Branch</th>
                <th className="px-3 py-2 text-right">Revenue</th>
                <th className="px-3 py-2 text-right">Net profit</th>
                <th className="px-3 py-2 text-right">Net margin</th>
                <th className="px-3 py-2 text-right">Cash &amp; bank</th>
                <th className="px-3 py-2 text-right">Working capital</th>
                <th className="px-3 py-2 text-right">Current ratio</th>
                <th className="px-3 py-2 text-right">Ledger lines</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {allRows.map((row) => (
                <BranchRow
                  key={row.branchId}
                  row={row}
                  company={Boolean(company && row.branchId === 'ALL')}
                  selected={row.branchId === selectedBranchId}
                  onOpenPnlLines={onOpenPnlLines}
                  onOpenBalanceLines={onOpenBalanceLines}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

export default FinanceBranchComparison;
