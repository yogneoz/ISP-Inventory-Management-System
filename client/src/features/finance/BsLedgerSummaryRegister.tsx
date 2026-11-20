/**
 * BS Ledger Summary — posted ledger activity reported entirely in the Nepali
 * calendar: BS year, BS month (English and Devanagari names), the BS date range
 * and the fiscal quarter. The AD as-of/from fields only select the ledger
 * slice; every displayed grouping comes from bs_day_records server-side.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2 } from 'lucide-react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type {
  BsLedgerMonth,
  BsLedgerSummaryResponse,
} from '../../services/api/accounting';
import {
  AccountingRegisterShell,
  RegisterEmpty,
  useAccountingScope,
} from '../../components/accounting/AccountingRegisterShell';
import type { AccountingScreenProps } from '../../components/accounting/AccountingRegisterShell';
import { money } from '../../components/accounting/statementFormat';
import { useBootstrapData } from '../../contexts/AppProviders';

const QUARTER_LABELS: Record<string, string> = {
  Q1: 'Q1 · Shrawan–Ashwin',
  Q2: 'Q2 · Kartik–Poush',
  Q3: 'Q3 · Magh–Chaitra',
  Q4: 'Q4 · Baisakh–Ashad',
};

const SummaryCard: React.FC<{ label: string; value: string; hint?: string }> = ({
  label,
  value,
  hint,
}) => (
  <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 dark:border-slate-800 dark:bg-[#0f1218]">
    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
      {label}
    </p>
    <p className="mt-1 text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">
      {value}
    </p>
    {hint && <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{hint}</p>}
  </div>
);

export const BsLedgerSummaryRegister: React.FC<AccountingScreenProps> = ({
  dateMode,
  currentUser,
}) => {
  // Workspace data: owned by BootstrapDataProvider (step 6 of the App split).
  const { branches } = useBootstrapData();
  const scope = useAccountingScope(branches, currentUser);
  const [fromDate, setFromDate] = useState('');
  const [data, setData] = useState<BsLedgerSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const activationKey = useActivationKey('accounting-bs-summary');
  const isVisible = useTabActive('accounting-bs-summary') && scope.allowed;

  useEffect(() => {
    if (!isVisible) return;
    let live = true;
    setLoading(true);
    setError('');
    void api.getBsLedgerSummary({
      branchId: scope.branchId === 'ALL' ? undefined : scope.branchId,
      from: fromDate || undefined,
      to: scope.asOfDate,
    })
      .then((next) => {
        if (live) setData(next);
      })
      .catch((err: any) => {
        if (!live) return;
        setError(err?.message || 'Failed to load the BS ledger summary.');
        setData(null);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, scope.branchId, scope.asOfDate, fromDate, activationKey, reloadKey]);

  const fiscalYears = useMemo(() => {
    const map = new Map<string, { fiscalYear: string; months: BsLedgerMonth[] }>();
    for (const month of data?.months ?? []) {
      const entry = map.get(month.fiscalYear) ?? {
        fiscalYear: month.fiscalYear,
        months: [],
      };
      entry.months.push(month);
      map.set(month.fiscalYear, entry);
    }
    return [...map.values()];
  }, [data]);

  return (
    <AccountingRegisterShell
      title="BS Ledger Summary"
      description="Posted ledger activity by Nepali year, month and fiscal quarter, with the BS date range for every row."
      icon={<CalendarDays className="h-5 w-5 text-indigo-500" />}
      registerName="BS ledger summary"
      scope={scope}
      dateMode={dateMode}
      periodStart={{ value: fromDate, onChange: setFromDate }}
      loading={loading}
      error={error}
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      {data ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              label="BS period total debit"
              value={money(data.totals.debit)}
              hint={`${data.months.length} BS month${data.months.length === 1 ? '' : 's'}`}
            />
            <SummaryCard label="BS period total credit" value={money(data.totals.credit)} />
            <SummaryCard
              label="BS period balance"
              value={money(data.totals.balance)}
              hint={`AD control ${money(data.adTotals.balance)}`}
            />
            <SummaryCard
              label="Reconciliation"
              value={data.reconciled ? 'Matched' : 'Difference'}
              hint={`BS vs AD difference ${money(data.difference)}`}
            />
          </div>

          <div
            className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${
              data.reconciled
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/20 dark:text-emerald-300'
                : 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300'
            }`}
          >
            {data.reconciled ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <p>
              {data.reconciled
                ? 'Every BS month, quarter and fiscal-year total reconciles to the AD ledger range.'
                : 'The BS grouping does not reconcile to the AD ledger range. Check the BS calendar day mapping before relying on this report.'}
            </p>
          </div>

          {fiscalYears.length === 0 ? (
            <RegisterEmpty message="No posted ledger activity falls in this BS period." />
          ) : (
            fiscalYears.map((fiscalYear) => (
              <section
                key={fiscalYear.fiscalYear}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#0f1218]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/60">
                  <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100">
                    Nepali fiscal year {fiscalYear.fiscalYear}
                  </h2>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    Shrawan 1 – Ashad end ·{' '}
                    {(() => {
                      const total = fiscalYear.months.reduce(
                        (sum, month) => ({
                          debit: sum.debit + month.debit,
                          credit: sum.credit + month.credit,
                          balance: sum.balance + month.balance,
                        }),
                        { debit: 0, credit: 0, balance: 0 }
                      );
                      return `Dr ${money(total.debit)} · Cr ${money(total.credit)} · Balance ${money(total.balance)}`;
                    })()}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[840px] text-left text-xs">
                    <thead className="border-b border-slate-200 bg-white text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800 dark:bg-[#0f1218] dark:text-slate-500">
                      <tr>
                        <th className="px-3 py-2">BS year</th>
                        <th className="px-3 py-2">BS month</th>
                        <th className="px-3 py-2">BS date range</th>
                        <th className="px-3 py-2">Quarter</th>
                        <th className="px-3 py-2 text-right">Debit</th>
                        <th className="px-3 py-2 text-right">Credit</th>
                        <th className="px-3 py-2 text-right">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fiscalYear.months.map((month) => (
                        <tr
                          key={`${month.bsYear}-${month.bsMonth}`}
                          className="border-b border-slate-100 last:border-0 dark:border-slate-800/70"
                        >
                          <td className="px-3 py-2 font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                            {month.bsYear}
                          </td>
                          <td className="px-3 py-2">
                            <span className="font-semibold text-slate-800 dark:text-slate-100">
                              {month.bsMonthNameNp}
                            </span>
                            <span className="ml-1 text-[11px] text-slate-500 dark:text-slate-400">
                              {month.bsMonthName}
                            </span>
                          </td>
                          <td className="px-3 py-2 tabular-nums text-slate-600 dark:text-slate-300">
                            {month.startBS} – {month.endBS} BS
                          </td>
                          <td className="px-3 py-2">
                            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
                              {QUARTER_LABELS[month.quarter] || month.quarter}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(month.debit)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(month.credit)}</td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">
                            {money(month.balance)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grid gap-2 border-t border-slate-200 bg-slate-50 p-3 md:grid-cols-2 dark:border-slate-800 dark:bg-slate-900/50">
                  {data.quarters
                    .filter((quarter) => quarter.fiscalYear === fiscalYear.fiscalYear)
                    .map((quarter) => (
                      <div
                        key={`${quarter.bsYear}-${quarter.quarter}`}
                        className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-[#0f1218]"
                      >
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                          {quarter.bsYear} · {QUARTER_LABELS[quarter.quarter] || quarter.quarter}
                        </p>
                        <p className="mt-1 text-xs tabular-nums text-slate-700 dark:text-slate-200">
                          Dr {money(quarter.debit)} · Cr {money(quarter.credit)} · Balance{' '}
                          {money(quarter.balance)}
                        </p>
                      </div>
                    ))}
                </div>
              </section>
            ))
          )}
        </div>
      ) : (
        !loading && !error && <RegisterEmpty message="No BS ledger summary has been loaded yet." />
      )}
    </AccountingRegisterShell>
  );
};

export default BsLedgerSummaryRegister;
