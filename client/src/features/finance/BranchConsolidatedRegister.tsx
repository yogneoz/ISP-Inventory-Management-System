/**
 * Branch-consolidated statement register. One column per branch in the
 * session's ledger scope and a final Total column. Every column is built by
 * the same per-branch statement services as the standalone screens, so a
 * branch column can never diverge from that branch's own statement.
 */
import React, { useEffect, useState } from 'react';
import { Download, Printer, Table2 } from 'lucide-react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type {
  BranchBalanceSheetMatrixResponse,
  BranchProfitAndLossMatrixResponse,
  BranchProfitAndLossMatrixRow,
} from '../../services/api/accounting';
import {
  AccountingRegisterShell,
  RegisterEmpty,
  useAccountingScope,
} from '../../components/accounting/AccountingRegisterShell';
import type { AccountingScreenProps } from '../../components/accounting/AccountingRegisterShell';
import {
  BalanceSheetViewToggle,
  BranchConsolidatedViewToggle,
} from '../../components/accounting/StatementViewControls';
import type {
  BalanceSheetReportView,
  BranchConsolidatedReportView,
} from '../../components/accounting/StatementViewControls';
import { money } from '../../components/accounting/statementFormat';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { exportToCSV, type CSVColumn } from '../../utils/exportUtils';

type ConsolidatedMatrix = BranchProfitAndLossMatrixResponse | BranchBalanceSheetMatrixResponse;

const amount = (value: number | undefined): number => Number(value) || 0;

const rowClasses = (row: BranchProfitAndLossMatrixRow): string => {
  if (row.kind === 'SECTION') {
    return 'border-b border-slate-200 bg-slate-100 font-bold text-slate-900 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-100';
  }
  if (row.kind === 'SUMMARY') {
    return 'border-b border-slate-200 bg-indigo-50/60 font-bold text-slate-900 dark:border-indigo-900/50 dark:bg-indigo-950/20 dark:text-slate-100';
  }
  if (row.kind === 'GROUP') {
    return 'border-b border-slate-100 bg-slate-50/70 font-semibold text-slate-800 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-200';
  }
  return 'border-b border-slate-100 text-slate-700 dark:border-slate-800/60 dark:text-slate-300';
};

const reportTitle = (
  view: BranchConsolidatedReportView,
  balanceView: BalanceSheetReportView
): string => {
  if (view === 'TRADING') return 'Branch Consolidated Trading Account';
  if (view === 'BALANCE_SHEET') {
    return `Branch Consolidated Balance Sheet ${balanceView === 'MOVEMENT' ? 'Movement' : 'Closing'}`;
  }
  return 'Branch Consolidated Profit and Loss';
};

const reportSlug = (
  view: BranchConsolidatedReportView,
  balanceView: BalanceSheetReportView
): string => {
  if (view === 'TRADING') return 'branch-consolidated-trading';
  if (view === 'BALANCE_SHEET') {
    return `branch-consolidated-balance-sheet-${balanceView.toLowerCase()}`;
  }
  return 'branch-consolidated-profit-and-loss';
};

export const BranchConsolidatedRegister: React.FC<AccountingScreenProps> = ({
  branches,
  dateMode,
  currentUser,
  fiscalYearStartAD,
}) => {
  const scope = useAccountingScope(branches, currentUser);
  const [data, setData] = useState<ConsolidatedMatrix | null>(null);
  const [view, setView] = useState<BranchConsolidatedReportView>('PROFIT_AND_LOSS');
  const [balanceView, setBalanceView] = useState<BalanceSheetReportView>('CLOSING');
  const [periodStart, setPeriodStart] = useState(fiscalYearStartAD || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const activationKey = useActivationKey('accounting-branch-consolidated');
  const isVisible = useTabActive('accounting-branch-consolidated') && scope.allowed;
  const statementKind = view === 'BALANCE_SHEET' ? 'BALANCE_SHEET' : 'PROFIT_AND_LOSS';

  useEffect(() => {
    setPeriodStart((current) => current || fiscalYearStartAD || '');
  }, [fiscalYearStartAD]);

  useEffect(() => {
    if (!isVisible) return;
    let live = true;
    setLoading(true);
    setError('');
    setData(null);
    const request =
      statementKind === 'BALANCE_SHEET'
        ? api.getBranchBalanceSheetMatrix({
            to: scope.asOfDate,
            view: balanceView,
            ...(balanceView === 'MOVEMENT' && periodStart ? { from: periodStart } : {}),
          })
        : api.getBranchProfitAndLossMatrix({
            to: scope.asOfDate,
            ...(periodStart ? { from: periodStart } : {}),
          });
    void request
      .then((next) => {
        if (live) setData(next);
      })
      .catch((err: any) => {
        if (!live) return;
        setData(null);
        setError(err?.message || 'Failed to load the branch-consolidated statement.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isVisible,
    scope.asOfDate,
    periodStart,
    activationKey,
    reloadKey,
    statementKind,
    balanceView,
  ]);

  const activeData: ConsolidatedMatrix | null =
    view === 'BALANCE_SHEET'
      ? data?.statement === 'BRANCH_BALANCE_SHEET'
        ? data
        : null
      : data?.statement === 'BRANCH_PROFIT_AND_LOSS'
        ? data
        : null;

  const visibleRows = activeData
    ? activeData.statement === 'BRANCH_PROFIT_AND_LOSS'
      ? activeData.rows.filter((row) => {
          if (view === 'PROFIT_AND_LOSS') return true;
          if (row.kind === 'SUMMARY') return row.key === 'summary:GROSS_PROFIT';
          return row.statementGroup === 'REVENUE' || row.statementGroup === 'COST_OF_SALES';
        })
      : activeData.rows
    : [];

  const branchColumns = activeData?.branches || [];
  const tableWidth = Math.max(760, 300 + branchColumns.length * 145);
  const isBalanceSheet = view === 'BALANCE_SHEET';
  const isMovement = isBalanceSheet && balanceView === 'MOVEMENT';
  const statementLabel = isBalanceSheet
    ? isMovement
      ? 'Balance sheet movement'
      : 'Balance sheet closing'
    : view === 'TRADING'
      ? 'Trading account'
      : 'Profit & loss';
  const columnLabel = isBalanceSheet ? (isMovement ? 'Movement' : 'Closing') : '';
  const asOf = activeData
    ? activeData.statement === 'BRANCH_BALANCE_SHEET'
      ? activeData.asOf
      : activeData.to
    : '';
  const periodLabel = activeData
    ? isBalanceSheet && balanceView === 'CLOSING'
      ? `As of ${formatDualDate(asOf)}`
      : `${activeData.from ? formatDualDate(activeData.from) : 'From inception'} → ${formatDualDate(asOf)}`
    : '';

  const exportCsv = () => {
    if (!activeData || visibleRows.length === 0) return;
    const columns: CSVColumn<Record<string, any>>[] = [
      { key: 'line', label: 'Line' },
      ...branchColumns.map((branch) => ({
        key: branch.branchId,
        label: `${branch.code} ${branch.name}`,
      })),
      { key: 'total', label: 'Total' },
    ];
    const rows = visibleRows.map((row) => {
      const record: Record<string, any> = {
        line: row.code ? `${row.code} ${row.label}` : row.label,
        total: row.total,
      };
      for (const branch of branchColumns) {
        record[branch.branchId] = amount(row.amounts[branch.branchId]);
      }
      return record;
    });
    exportToCSV({
      filename: `${reportSlug(view, balanceView)}-${scope.asOfDate}`,
      data: rows,
      columns,
      reportTitle: reportTitle(view, balanceView),
      branchName: 'All branches in ledger scope',
      generatedBy: currentUser?.name,
    });
  };

  return (
    <AccountingRegisterShell
      title="Branch Consolidated"
      description="P&L, Trading and Balance Sheet by branch, with every branch in one table and a consolidated total column."
      icon={<Table2 className="h-5 w-5 text-indigo-500" />}
      registerName="branch-consolidated statement"
      scope={scope}
      dateMode={dateMode}
      periodStart={
        isBalanceSheet && balanceView === 'CLOSING'
          ? undefined
          : { value: periodStart, onChange: setPeriodStart }
      }
      hideBranchSelector
      scopeNote={
        <>
          Showing every branch in your ledger scope. Period{' '}
          <span className="font-semibold text-slate-700 dark:text-slate-200">
            {periodLabel || 'selected period'}
          </span>
          .
        </>
      }
      headerActions={
        <>
          <BranchConsolidatedViewToggle view={view} onChange={setView} />
          {isBalanceSheet && <BalanceSheetViewToggle view={balanceView} onChange={setBalanceView} />}
          <button
            type="button"
            onClick={exportCsv}
            disabled={!activeData || visibleRows.length === 0}
            className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <Download className="h-3.5 w-3.5 text-slate-400" />
            CSV
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            disabled={!activeData || visibleRows.length === 0}
            className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <Printer className="h-3.5 w-3.5 text-slate-400" />
            Print
          </button>
        </>
      }
      loading={loading}
      error={error}
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      {activeData ? (
        <div className="printable-document space-y-3">
          <div className="hidden print:block">
            <h2 className="text-base font-bold text-slate-900">
              Branch Consolidated — {statementLabel}
            </h2>
            <p className="text-xs text-slate-600">
              {periodLabel} · {branchColumns.length} branch
              {branchColumns.length === 1 ? '' : 'es'} + total
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 print:hidden dark:border-slate-800 dark:bg-slate-900/40">
            <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
              {statementLabel} · {periodLabel}
            </p>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {branchColumns.length} branch{branchColumns.length === 1 ? '' : 'es'} + total
            </span>
          </div>

          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white print:overflow-visible dark:border-slate-800 dark:bg-slate-900/40">
            <div className="overflow-x-auto print:overflow-visible">
              <table
                className="branch-consolidated-table w-full text-left text-xs"
                style={{ minWidth: tableWidth }}
              >
                <thead className="border-b border-slate-200 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-300">
                  <tr>
                    <th className="sticky left-0 z-20 min-w-[280px] bg-slate-50 px-3 py-2 print:static dark:bg-slate-800">
                      Line item
                    </th>
                    {branchColumns.map((branch) => (
                      <th key={branch.branchId} className="min-w-[135px] px-3 py-2 text-right">
                        <span className="block font-mono text-[10px] text-slate-400">{branch.code}</span>
                        {branch.name}
                        {isBalanceSheet && (
                          <span className="mt-0.5 block text-[10px] font-semibold normal-case text-slate-400">
                            {columnLabel}
                          </span>
                        )}
                      </th>
                    ))}
                    <th className="min-w-[145px] border-l border-slate-200 px-3 py-2 text-right dark:border-slate-700">
                      Total
                      {isBalanceSheet && (
                        <span className="mt-0.5 block text-[10px] font-semibold normal-case text-slate-400">
                          {columnLabel}
                        </span>
                      )}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={branchColumns.length + 2}
                        className="px-3 py-8 text-center text-xs text-slate-400"
                      >
                        No posted {statementLabel.toLowerCase()} activity in this period.
                      </td>
                    </tr>
                  ) : (
                    visibleRows.map((row) => (
                      <tr key={row.key} className={rowClasses(row)}>
                        <td
                          className="sticky left-0 z-10 bg-inherit px-3 py-1.5 print:static"
                          style={{ paddingLeft: 12 + row.level * 16 }}
                        >
                          {row.code && (
                            <span className="mr-2 font-mono text-[10px] text-slate-400">{row.code}</span>
                          )}
                          {row.label}
                        </td>
                        {branchColumns.map((branch) => {
                          const value = amount(row.amounts[branch.branchId]);
                          return (
                            <td
                              key={branch.branchId}
                              className={`px-3 py-1.5 text-right font-mono ${
                                value < 0 ? 'text-rose-600 dark:text-rose-400' : ''
                              }`}
                            >
                              {money(value)}
                            </td>
                          );
                        })}
                        <td
                          className={`border-l border-slate-200 px-3 py-1.5 text-right font-mono font-bold dark:border-slate-700 ${
                            row.total < 0 ? 'text-rose-600 dark:text-rose-400' : ''
                          }`}
                        >
                          {money(row.total)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <p className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[10px] leading-snug text-slate-500 print:hidden dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
            Each branch column is its own posted ledger. The Total column is the sum of the branch
            columns. Branch users see only the branches their account may read; company-level users
            see every active branch.
          </p>
        </div>
      ) : (
        !loading && !error && (
          <RegisterEmpty message="No branch-consolidated statement has been loaded yet." />
        )
      )}
    </AccountingRegisterShell>
  );
};

export default BranchConsolidatedRegister;
