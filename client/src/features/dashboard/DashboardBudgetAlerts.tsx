/**
 * Dashboard budget overspend alerts.
 *
 * This is deliberately a small, lazy surface: the main dashboard is in the
 * eager entry chunk, so the alert card must not grow that chunk. The API is
 * the same variance service used by Budget vs actual; only budgeted expense
 * accounts with POSTED actual above budget are returned. Totals and the
 * tie-out come from the server before its display limit, so a truncated list
 * still reconciles to the source variance rows.
 */
import React, { useEffect, useState } from 'react';
import type { Branch } from '../../types';
import { api } from '../../services/api';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { formatNPR } from '../../utils/nprFormat';

interface DashboardBudgetAlertsProps {
  branches: Branch[];
  selectedBranchId: string;
  fiscalYearId?: string;
  fiscalYearStartAD?: string;
  fiscalYearEndAD?: string;
  sseRefreshKey: number;
  onNavigateTab: (tab: any) => void;
}

type BudgetAlerts = Awaited<ReturnType<typeof api.getAccountingBudgetAlerts>>;

export const DashboardBudgetAlerts: React.FC<DashboardBudgetAlertsProps> = ({
  branches,
  selectedBranchId,
  fiscalYearId,
  fiscalYearStartAD,
  fiscalYearEndAD,
  sseRefreshKey,
  onNavigateTab,
}) => {
  const [data, setData] = useState<BudgetAlerts | null>(null);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!fiscalYearId || !fiscalYearStartAD || !fiscalYearEndAD || !selectedBranchId) {
      setData(null);
      setError('');
      return;
    }

    let alive = true;
    setData(null);
    setError('');
    api.getAccountingBudgetAlerts({
      fiscalYearId,
      branchId: selectedBranchId,
      from: fiscalYearStartAD,
      to: fiscalYearEndAD,
      limit: 5,
    })
      .then((next) => {
        if (alive) setData(next);
      })
      .catch((err: any) => {
        if (alive) setError(err?.message || 'Budget overspend alerts could not be loaded.');
      });

    return () => {
      alive = false;
    };
  }, [
    fiscalYearId,
    fiscalYearStartAD,
    fiscalYearEndAD,
    selectedBranchId,
    sseRefreshKey,
    retryKey,
  ]);

  const cardBg =
    'bg-white border-rose-200 dark:bg-[#0f1218] dark:border-rose-900/70';
  const cardTitleText = 'text-slate-900 dark:text-white';
  const cardSubText = 'text-slate-600 dark:text-slate-400';

  if (error) {
    return (
      <section
        aria-label="Budget overspend alerts unavailable"
        className="rounded-2xl border border-rose-200 bg-rose-50 p-4 shadow-xs dark:border-rose-900/70 dark:bg-rose-950/30"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
            <div>
              <p className="text-sm font-bold text-rose-800 dark:text-rose-300">
                Budget overspend alerts could not load
              </p>
              <p className="mt-0.5 text-xs text-rose-700/80 dark:text-rose-400/80">{error}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setRetryKey((value) => value + 1)}
            className="shrink-0 rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-bold text-rose-700 transition-colors hover:bg-rose-100 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-950/40"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (!data || data.alerts.length === 0) return null;

  const branchName =
    selectedBranchId === 'ALL'
      ? 'all branches'
      : branches.find((branch) => branch.id === selectedBranchId)?.name || 'the selected branch';
  const alertWord = data.totals.alertCount === 1 ? 'account' : 'accounts';

  return (
    <section
      aria-labelledby="budget-overspend-alerts-title"
      className={`overflow-hidden rounded-2xl border shadow-xs ${cardBg}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rose-200 p-4 dark:border-rose-900/60 sm:p-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-rose-500" />
            <h3 id="budget-overspend-alerts-title" className={`font-bold text-base ${cardTitleText}`}>
              Budget Overspend Alerts
            </h3>
            <span className="rounded-full border border-rose-300 bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-800 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
              {data.totals.alertCount} expense {alertWord}
            </span>
          </div>
          <p className={`mt-0.5 text-xs ${cardSubText}`}>
            Posted expense above budget for {branchName} · FY {data.fiscalYearCode}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigateTab('financial-statements')}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-800 transition-colors hover:bg-rose-100 dark:border-rose-500/40 dark:bg-rose-950/80 dark:text-rose-300 dark:hover:bg-rose-900"
        >
          <span>Open Budget vs Actual</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 border-b border-rose-200 bg-rose-50/50 p-4 dark:border-rose-900/60 dark:bg-rose-950/20 sm:grid-cols-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-rose-600 dark:text-rose-400">
            Over budget
          </p>
          <p className="mt-0.5 font-mono text-sm font-extrabold text-rose-700 dark:text-rose-300">
            {formatNPR(data.totals.overBy)}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Alert budget
          </p>
          <p className={`mt-0.5 font-mono text-sm font-bold ${cardTitleText}`}>
            {formatNPR(data.totals.budget)}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Posted actual
          </p>
          <p className={`mt-0.5 font-mono text-sm font-bold ${cardTitleText}`}>
            {formatNPR(data.totals.actual)}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Reconciliation
          </p>
          <p
            className={`mt-0.5 text-[11px] font-bold ${
              data.tieOut.reconciled
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-rose-700 dark:text-rose-300'
            }`}
          >
            {data.tieOut.reconciled ? 'Ties to variance total' : 'Variance mismatch'}
          </p>
        </div>
      </div>

      <div className="divide-y divide-rose-100 dark:divide-rose-900/40">
        {data.alerts.map((alert) => (
          <div key={alert.accountId} className="p-4 sm:px-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 font-mono text-[10px] font-bold text-rose-700 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-300">
                    {alert.code}
                  </span>
                  <span className={`text-sm font-bold ${cardTitleText}`}>{alert.name}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  {alert.utilisationPercent.toFixed(1)}% of budget ·{' '}
                  {alert.overPercent.toFixed(1)}% over
                </p>
              </div>
              <div className="text-right">
                <p className="font-mono text-sm font-extrabold text-rose-600 dark:text-rose-400">
                  +{formatNPR(alert.overBy)}
                </p>
                <p className="text-[10px] font-medium text-slate-500 dark:text-slate-400">
                  over budget
                </p>
              </div>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-rose-100 dark:bg-rose-950/60">
              <div
                className="h-full rounded-full bg-rose-500"
                style={{ width: `${Math.max(0, Math.min(100, alert.utilisationPercent))}%` }}
              />
            </div>
            <div className="mt-1.5 flex flex-wrap justify-between gap-2 text-[10px] text-slate-500 dark:text-slate-400">
              <span>Budget {formatNPR(alert.budget)}</span>
              <span>Posted actual {formatNPR(alert.actual)}</span>
            </div>
          </div>
        ))}
      </div>

      {data.truncated && (
        <div className="border-t border-rose-200 px-4 py-2 text-[11px] text-slate-600 dark:border-rose-900/60 dark:text-slate-400">
          Showing the {data.alerts.length} largest of {data.totals.alertCount} over-budget accounts.
          Totals cover every alert.
        </div>
      )}
    </section>
  );
};
