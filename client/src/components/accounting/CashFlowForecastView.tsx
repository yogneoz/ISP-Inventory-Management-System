/**
 * Forward cash-flow forecast panel.
 *
 * The server owns every figure. This view shows the weekly buckets, the
 * opening/net/closing cash, the AR/AP tie-out the forecast was built from, and
 * the minimum-cash warning. Export requests the same forecast as CSV rather
 * than rebuilding it in the browser.
 */
import React from 'react';
import {
  AlertTriangle,
  CalendarRange,
  CheckCircle2,
  Download,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { KpiStrip, KPI_TONE_TEXT } from '../common/KpiStrip';
import type { CashFlowForecastResponse } from '../../services/api/accounting';
import { money } from './statementFormat';

interface CashFlowForecastViewProps {
  data: CashFlowForecastResponse | null;
  loading: boolean;
  error: string;
  weeks: number;
  minCash: string;
  onWeeksChange: (weeks: number) => void;
  onMinCashChange: (value: string) => void;
  onExport: () => void;
  onRetry: () => void;
  exporting: boolean;
}

function signedTone(value: number): string {
  return value < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-200';
}

function breachLabel(data: CashFlowForecastResponse): string {
  if (!data.firstBreach) return '';
  if (data.firstBreach.bucketKey === 'OPENING') return 'at the opening balance';
  const bucket = data.buckets.find((candidate) => candidate.key === data.firstBreach?.bucketKey);
  return bucket ? `in ${bucket.key} (${bucket.label})` : `in ${data.firstBreach.bucketKey}`;
}

export const CashFlowForecastView: React.FC<CashFlowForecastViewProps> = ({
  data,
  loading,
  error,
  weeks,
  minCash,
  onWeeksChange,
  onMinCashChange,
  onExport,
  onRetry,
  exporting,
}) => {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 px-3 py-3 dark:border-slate-800">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CalendarRange className="h-4 w-4 text-indigo-500" />
            <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">
              Forward cash-flow forecast
            </h3>
            {loading && data && (
              <span className="text-[10px] font-medium text-slate-400">Refreshing…</span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            Weekly buckets from open AR/AP due dates, recurring journals, unpaid payroll and
            manual inputs, opening at the posted cash/bank balance. A forecast, not posted cash.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            <span className="mb-1 block">Weeks</span>
            <select
              aria-label="Forecast horizon in weeks"
              value={weeks}
              onChange={(event) => onWeeksChange(Number(event.target.value))}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              {[4, 8, 13, 26].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            <span className="mb-1 block">Minimum cash</span>
            <input
              aria-label="Forecast minimum cash"
              type="number"
              min={0}
              step={1000}
              value={minCash}
              onChange={(event) => onMinCashChange(event.target.value)}
              className="w-28 rounded-lg border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            />
          </label>
          <button
            type="button"
            onClick={onExport}
            disabled={exporting || !data}
            className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <Download className={`h-3.5 w-3.5 text-slate-400 ${exporting ? 'animate-pulse' : ''}`} />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300"
        >
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg border border-rose-300 px-2 py-1 text-[11px] font-semibold hover:bg-rose-100 dark:border-rose-500/40 dark:hover:bg-rose-900/30"
          >
            Retry forecast
          </button>
        </div>
      )}

      {!data ? (
        <p className="px-3 py-5 text-xs text-slate-500 dark:text-slate-400">
          {loading ? 'Loading the forward forecast…' : 'No forecast has been loaded yet.'}
        </p>
      ) : (
        <div className="space-y-3 p-3">
          {data.warning ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-bold">Minimum cash breached</p>
                <p>
                  Closing cash falls below {money(data.minCash)} {breachLabel(data)}. Lowest
                  closing cash is {money(data.minimumClosingCash)}.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                Every week closes at or above {money(data.minCash)}. Lowest closing cash is{' '}
                {money(data.minimumClosingCash)}.
              </p>
            </div>
          )}

          <KpiStrip
            items={[
              {
                label: 'OPENING CASH',
                value: money(data.openingCash),
                tone: KPI_TONE_TEXT.slate,
                hint: `Posted cash/bank at ${data.asOf}`,
                icon: <Wallet className="h-3.5 w-3.5" />,
              },
              {
                label: 'EXPECTED IN',
                value: money(data.totalInflows),
                tone: KPI_TONE_TEXT.emerald,
                hint: 'AR due in the horizon, net of credits',
                icon: <TrendingUp className="h-3.5 w-3.5" />,
              },
              {
                label: 'EXPECTED OUT',
                value: money(data.totalOutflows),
                tone: KPI_TONE_TEXT.rose,
                hint: 'AP due in the horizon, net of credits',
                icon: <TrendingDown className="h-3.5 w-3.5" />,
              },
              {
                label: 'NET CASH FLOW',
                value: money(data.netCashFlow),
                tone: KPI_TONE_TEXT[data.netCashFlow >= 0 ? 'indigo' : 'rose'],
                hint: 'Expected receipts less payments',
                icon: <CalendarRange className="h-3.5 w-3.5" />,
              },
              {
                label: 'CLOSING CASH',
                value: money(data.closingCash),
                tone: KPI_TONE_TEXT.amber,
                hint: `After ${data.weeks} weeks`,
                icon: <CheckCircle2 className="h-3.5 w-3.5" />,
              },
            ]}
          />

          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
            <table className="w-full min-w-[680px] text-left text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 dark:bg-slate-900/80 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-semibold">Week</th>
                  <th className="px-3 py-2 text-right font-semibold">Expected in</th>
                  <th className="px-3 py-2 text-right font-semibold">Expected out</th>
                  <th className="px-3 py-2 text-right font-semibold">Net cash flow</th>
                  <th className="px-3 py-2 text-right font-semibold">Closing cash</th>
                  <th className="px-3 py-2 text-right font-semibold">Minimum</th>
                </tr>
              </thead>
              <tbody>
                {data.buckets.map((bucket) => (
                  <tr
                    key={bucket.key}
                    className={`border-t border-slate-100 dark:border-slate-800/60 ${
                      bucket.belowMinimum ? 'bg-amber-50/70 dark:bg-amber-950/20' : ''
                    }`}
                  >
                    <td className="px-3 py-2">
                      <div className="font-semibold text-slate-700 dark:text-slate-200">
                        {bucket.key}
                      </div>
                      <div className="text-[10px] text-slate-400">{bucket.label}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      <div className={signedTone(bucket.inflows)}>{money(bucket.inflows)}</div>
                      {bucket.customerCredits > 0 && (
                        <div className="text-[10px] font-sans text-slate-400">
                          after {money(bucket.customerCredits)} credits
                        </div>
                      )}
                      {bucket.recurringInflows > 0 && (
                        <div className="text-[10px] font-sans text-indigo-500">
                          + {money(bucket.recurringInflows)} recurring
                        </div>
                      )}
                      {bucket.manualInflows > 0 && (
                        <div className="text-[10px] font-sans text-emerald-500">
                          + {money(bucket.manualInflows)} manual
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      <div className={signedTone(-bucket.outflows)}>{money(bucket.outflows)}</div>
                      {bucket.supplierCredits > 0 && (
                        <div className="text-[10px] font-sans text-slate-400">
                          after {money(bucket.supplierCredits)} credits
                        </div>
                      )}
                      {bucket.recurringOutflows > 0 && (
                        <div className="text-[10px] font-sans text-indigo-500">
                          + {money(bucket.recurringOutflows)} recurring
                        </div>
                      )}
                      {bucket.payrollOutflows > 0 && (
                        <div className="text-[10px] font-sans text-rose-500">
                          + {money(bucket.payrollOutflows)} payroll
                        </div>
                      )}
                      {bucket.manualOutflows > 0 && (
                        <div className="text-[10px] font-sans text-emerald-500">
                          + {money(bucket.manualOutflows)} manual
                        </div>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${signedTone(bucket.netCashFlow)}`}>
                      {money(bucket.netCashFlow)}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono font-semibold ${signedTone(bucket.closingCash)}`}>
                      {money(bucket.closingCash)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          bucket.belowMinimum
                            ? 'bg-amber-200 text-amber-900 dark:bg-amber-500/25 dark:text-amber-200'
                            : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
                        }`}
                      >
                        {bucket.belowMinimum ? 'Below' : 'OK'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-[11px] text-slate-600 md:grid-cols-2 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-300">
            <div>
              <p className="font-semibold text-slate-700 dark:text-slate-200">
                AR open items {money(data.ar.total)}
                <span className="ml-2 font-normal text-slate-400">
                  ({data.ar.openItemCount} items, {money(data.ar.overdueAmount)} overdue)
                </span>
              </p>
              <p>
                Gross {money(data.ar.grossTotal)} less {money(data.ar.unappliedCredit)} unapplied
                credits · Control {money(data.ar.controlBalance)} ·{' '}
                {data.ar.reconciled ? 'Ties to control' : `Difference ${money(data.ar.difference)}`}
              </p>
            </div>
            <div>
              <p className="font-semibold text-slate-700 dark:text-slate-200">
                AP open items {money(data.ap.total)}
                <span className="ml-2 font-normal text-slate-400">
                  ({data.ap.openItemCount} items, {money(data.ap.overdueAmount)} overdue)
                </span>
              </p>
              <p>
                Gross {money(data.ap.grossTotal)} less {money(data.ap.unappliedCredit)} unapplied
                credits · Control {money(data.ap.controlBalance)} ·{' '}
                {data.ap.reconciled ? 'Ties to control' : `Difference ${money(data.ap.difference)}`}
              </p>
            </div>
            {(data.beyondHorizon.ar.count > 0 || data.beyondHorizon.ap.count > 0) && (
              <p className="md:col-span-2 text-amber-700 dark:text-amber-300">
                Beyond the {data.weeks}-week horizon: AR{' '}
                {money(data.beyondHorizon.ar.amount)} ({data.beyondHorizon.ar.count} items), AP{' '}
                {money(data.beyondHorizon.ap.amount)} ({data.beyondHorizon.ap.count} items). These
                are excluded from the weekly buckets, not ignored in the total.
              </p>
            )}
          </div>

          <details className="rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-800">
            <summary className="cursor-pointer text-[11px] font-semibold text-slate-600 dark:text-slate-300">
              Open items behind the forecast ({data.items.length})
            </summary>
            <div className="mt-2 max-h-64 overflow-auto">
              <table className="w-full min-w-[640px] text-left text-[11px]">
                <thead className="text-[10px] uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="py-1 pr-3 font-semibold">Source</th>
                    <th className="py-1 pr-3 font-semibold">Party</th>
                    <th className="py-1 pr-3 font-semibold">Document</th>
                    <th className="py-1 pr-3 font-semibold">Due</th>
                    <th className="py-1 pr-3 text-right font-semibold">Amount</th>
                    <th className="py-1 pr-3 font-semibold">Bucket</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item, index) => (
                    <tr
                      key={`${item.source}-${item.documentId || item.partyId}-${index}`}
                      className="border-t border-slate-100 dark:border-slate-800/60"
                    >
                      <td className="py-1 pr-3 text-slate-500">{item.source}</td>
                      <td className="py-1 pr-3 text-slate-700 dark:text-slate-300">{item.partyName}</td>
                      <td className="py-1 pr-3 font-mono text-slate-500">
                        {item.documentNo || item.kind}
                      </td>
                      <td className="py-1 pr-3 text-slate-500">
                        {item.dueDateAD}
                        {item.overdue && <span className="ml-1 text-amber-600">overdue</span>}
                      </td>
                      <td className="py-1 pr-3 text-right font-mono text-slate-700 dark:text-slate-300">
                        {money(item.amount)}
                      </td>
                      <td className="py-1 pr-3 text-slate-500">
                        {item.bucketKey || 'Beyond horizon'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
    </section>
  );
};

export default CashFlowForecastView;
