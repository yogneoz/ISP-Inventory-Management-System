/**
 * Budget vs actual — a self-contained Finance Dashboard view.
 *
 * The variance figures come from the server; this panel never derives an
 * actual from operational data. A branch-scoped user with `gl-chart-manage`
 * can add monthly account amounts and save them in one request. A consolidated
 * ALL view is read-only because a budget belongs to one branch.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  Lock,
  Plus,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import { api } from '../../services/api';
import type {
  BudgetBranchUtilisationResponse,
  BudgetImportError,
  BudgetLine,
  BudgetResponse,
  BudgetVarianceResponse,
  BudgetVarianceRow,
} from '../../services/api/accounting';
import { RegisterEmpty } from './AccountingRegisterShell';
import { BudgetHistoryPanel } from './BudgetHistoryPanel';
import { BudgetAllocationPanel } from './BudgetAllocationPanel';
import { LedgerDrilldownDialog } from './LedgerDrilldownDialog';
import { formatMoney } from '../../utils/nprFormat';

export interface BudgetVariancePanelProps {
  fiscalYearId: string;
  fiscalYearCode: string;
  from: string;
  to: string;
  /** `ALL` is the consolidated read; every other value is a concrete branch. */
  branchId: string;
  canManage: boolean;
  reloadToken?: number;
}

const panelClass =
  'rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60';

function percentText(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

export const BudgetVariancePanel: React.FC<BudgetVariancePanelProps> = ({
  fiscalYearId,
  fiscalYearCode,
  from,
  to,
  branchId,
  canManage,
  reloadToken = 0,
}) => {
  const concrete = branchId !== 'ALL';
  const [variance, setVariance] = useState<BudgetVarianceResponse | null>(null);
  const [utilisation, setUtilisation] = useState<BudgetBranchUtilisationResponse | null>(null);
  const [setup, setSetup] = useState<BudgetResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [draft, setDraft] = useState<BudgetLine[]>([]);
  const [accountId, setAccountId] = useState('');
  const [periodKey, setPeriodKey] = useState('');
  const [amount, setAmount] = useState('');
  const [version, setVersion] = useState(0);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [transferBusy, setTransferBusy] = useState<'' | 'copy' | 'import' | 'export'>('');
  const [transferNotice, setTransferNotice] = useState('');
  const [transferErrors, setTransferErrors] = useState<BudgetImportError[]>([]);
  const [drillAccount, setDrillAccount] = useState<BudgetVarianceRow | null>(null);
  const [lockBusy, setLockBusy] = useState(false);
  const [lockError, setLockError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const locked = Boolean(setup?.locked);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    setUtilisation(null);
    const varianceRequest = api.getAccountingBudgetVariance({
      fiscalYearId,
      branchId,
      from,
      to,
    });
    const utilisationRequest = api.getAccountingBudgetVarianceUtilisation({
      fiscalYearId,
      branchId,
      from,
      to,
    });
    const setupRequest = concrete
      ? api.getAccountingBudget({ fiscalYearId, branchId })
      : Promise.resolve(null);

    Promise.all([varianceRequest, setupRequest, utilisationRequest])
      .then(([varianceResult, setupResult, utilisationResult]) => {
        if (!live) return;
        setVariance(varianceResult);
        setUtilisation(utilisationResult);
        setSetup(setupResult);
        setDraft(
          (setupResult?.lines || []).map((line) => ({
            periodKey: line.periodKey,
            accountId: line.accountId,
            amount: line.amount,
            code: line.code,
            name: line.name,
            accountType: line.accountType,
          }))
        );
        setPeriodKey((current) => current || setupResult?.periods[0]?.periodKey || '');
        setAccountId((current) => current || setupResult?.accounts[0]?.id || '');
      })
      .catch((err: any) => {
        if (!live) return;
        setError(err?.message || 'Could not load the budget comparison.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
    };
  }, [fiscalYearId, branchId, from, to, concrete, version, reloadToken]);

  const overBudget = useMemo(
    () => (variance?.rows || []).filter((row) => row.variance < 0).length,
    [variance]
  );

  const addLine = () => {
    if (!setup) return;
    const account = setup.accounts.find((candidate) => candidate.id === accountId);
    if (!account) {
      setSaveError('Choose a profit-and-loss account.');
      return;
    }
    if (!periodKey) {
      setSaveError('Choose an accounting period.');
      return;
    }
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setSaveError('Enter a non-negative budget amount.');
      return;
    }
    setSaveError('');
    setSavedAt('');
    setDraft((current) => {
      const index = current.findIndex(
        (line) => line.periodKey === periodKey && line.accountId === account.id
      );
      const nextLine: BudgetLine = {
        periodKey,
        accountId: account.id,
        amount: Math.round(parsed * 100) / 100,
        code: account.code,
        name: account.name,
        accountType: account.accountType,
      };
      if (index < 0) return [...current, nextLine];
      const next = [...current];
      next[index] = nextLine;
      return next;
    });
    setAmount('');
  };

  const removeLine = (index: number) => {
    setSavedAt('');
    setDraft((current) => current.filter((_, position) => position !== index));
  };

  const applyBudget = (next: BudgetResponse) => {
    setSetup(next);
    setDraft(
      next.lines.map((line) => ({
        periodKey: line.periodKey,
        accountId: line.accountId,
        amount: line.amount,
        code: line.code,
        name: line.name,
        accountType: line.accountType,
      }))
    );
    setPeriodKey((current) => current || next.periods[0]?.periodKey || '');
    setAccountId((current) => current || next.accounts[0]?.id || '');
  };

  const startTransfer = (kind: 'copy' | 'import' | 'export') => {
    setTransferBusy(kind);
    setTransferNotice('');
    setTransferErrors([]);
    setSaveError('');
    setSavedAt('');
  };

  const copyForward = async () => {
    if (!setup || setup.locked) return;
    startTransfer('copy');
    try {
      const result = await api.copyAccountingBudget({
        targetFiscalYearId: fiscalYearId,
        branchId,
        replace: replaceExisting,
      });
      applyBudget(result.budget);
      const action =
        result.status === 'UNCHANGED'
          ? `No change: FY ${result.targetFiscalYearCode} already matches FY ${result.sourceFiscalYearCode}.`
          : result.status === 'REPLACED'
            ? `Replaced FY ${result.targetFiscalYearCode} with ${result.copiedLines} line${result.copiedLines === 1 ? '' : 's'} from FY ${result.sourceFiscalYearCode}.`
            : `Copied ${result.copiedLines} line${result.copiedLines === 1 ? '' : 's'} from FY ${result.sourceFiscalYearCode} into FY ${result.targetFiscalYearCode}.`;
      const skipped = result.skippedAccounts.length
        ? ` ${result.skippedAccounts.length} account${result.skippedAccounts.length === 1 ? '' : 's'} skipped: no longer profit-and-loss in the chart.`
        : '';
      const unmapped = result.unmappedPeriods.length
        ? ` ${result.unmappedPeriods.length} source period${result.unmappedPeriods.length === 1 ? '' : 's'} had no target month.`
        : '';
      setTransferNotice(`${action}${skipped}${unmapped}`);
      setVersion((current) => current + 1);
    } catch (err: any) {
      setTransferNotice('');
      setSaveError(err?.message || 'The previous budget could not be copied.');
    } finally {
      setTransferBusy('');
    }
  };

  const importCsv = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (setup?.locked) {
      setSaveError('Unlock this budget before importing CSV lines.');
      return;
    }
    startTransfer('import');
    try {
      const csv = await file.text();
      const result = await api.importAccountingBudgetCsv({
        fiscalYearId,
        branchId,
        csv,
        replace: replaceExisting,
      });
      if (result.budget) applyBudget(result.budget);
      setTransferNotice(
        result.status === 'UNCHANGED'
          ? 'No change: the budget already matches this CSV.'
          : `Imported ${result.importedLines} line${result.importedLines === 1 ? '' : 's'} from ${file.name}${result.status === 'REPLACED' ? ' and replaced the open-period budget.' : '.'}`
      );
      setVersion((current) => current + 1);
    } catch (err: any) {
      setTransferNotice('');
      setSaveError(err?.message || 'The budget CSV could not be imported.');
      const rowErrors = err?.body?.errors;
      if (Array.isArray(rowErrors)) setTransferErrors(rowErrors);
    } finally {
      setTransferBusy('');
    }
  };

  const exportCsv = async () => {
    if (!setup) return;
    startTransfer('export');
    try {
      const blob = await api.getAccountingBudgetCsv({ fiscalYearId, branchId });
      if (typeof URL.createObjectURL !== 'function') {
        throw new Error('This browser cannot download the budget CSV.');
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `budget-${setup.fiscalYearCode}-${setup.branchId}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setTransferNotice(`Exported ${setup.lines.length} line${setup.lines.length === 1 ? '' : 's'} for FY ${setup.fiscalYearCode}.`);
    } catch (err: any) {
      setSaveError(err?.message || 'The budget CSV could not be exported.');
    } finally {
      setTransferBusy('');
    }
  };

  const toggleLock = async () => {
    if (!setup?.budgetId) return;
    const nextLocked = !setup.locked;
    setLockBusy(true);
    setLockError('');
    setTransferNotice('');
    setSaveError('');
    try {
      const result = await api.setAccountingBudgetLock({
        fiscalYearId,
        branchId,
        locked: nextLocked,
      });
      applyBudget(result.budget);
      setTransferNotice(
        result.status === 'UNCHANGED'
          ? `No change: the budget is already ${nextLocked ? 'locked' : 'unlocked'}.`
          : `Budget ${nextLocked ? 'locked' : 'unlocked'} for FY ${result.budget.fiscalYearCode}.`
      );
    } catch (err: any) {
      setLockError(err?.message || `The budget could not be ${nextLocked ? 'locked' : 'unlocked'}.`);
    } finally {
      setLockBusy(false);
    }
  };

  const save = async () => {
    if (!setup || setup.locked) return;
    setSaving(true);
    setSaveError('');
    setSavedAt('');
    try {
      const saved = await api.saveAccountingBudget({
        fiscalYearId,
        branchId,
        lines: draft.map((line) => ({
          periodKey: line.periodKey,
          accountId: line.accountId,
          amount: line.amount,
        })),
      });
      setSetup(saved);
      setDraft(
        saved.lines.map((line) => ({
          periodKey: line.periodKey,
          accountId: line.accountId,
          amount: line.amount,
          code: line.code,
          name: line.name,
          accountType: line.accountType,
        }))
      );
      setSavedAt(new Date().toLocaleTimeString());
      setVersion((current) => current + 1);
    } catch (err: any) {
      setSaveError(err?.message || 'The budget could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3.5">
      <section className={panelClass}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">
              Budget vs actual
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              FY {fiscalYearCode} · {concrete ? branchId : 'all branches'} · full-year budget against
              posted journal lines from {from} to {to}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {setup && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  setup.locked
                    ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
                    : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                }`}
              >
                {setup.locked ? 'Locked' : 'Unlocked'}
              </span>
            )}
            {concrete && canManage && setup?.budgetId && (
              <button
                type="button"
                onClick={toggleLock}
                disabled={lockBusy || saving || transferBusy !== ''}
                title={setup.locked ? 'Unlock this budget for edits' : 'Lock this budget against edits'}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <Lock className="h-3.5 w-3.5" />
                {lockBusy ? 'Updating…' : setup.locked ? 'Unlock budget' : 'Lock budget'}
              </button>
            )}
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              Variance = budget − actual
            </span>
          </div>
        </div>

        {!concrete && (
          <p className="mt-3 rounded-lg border border-dashed border-slate-200 px-3 py-2 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
            This is the consolidated read-only view. Choose a branch in the scope bar to edit that
            branch&apos;s budget.
          </p>
        )}

        {setup?.locked && (
          <p
            role="status"
            className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200"
          >
            Locked{setup.lockedBy ? ` by ${setup.lockedBy}` : ''}
            {setup.lockedAt ? ` on ${new Date(setup.lockedAt).toLocaleString()}` : ''}. Budget lines, copy and CSV import are read-only until unlocked.
          </p>
        )}

        {lockError && (
          <div
            role="status"
            className="mt-3 flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-200"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{lockError}</span>
          </div>
        )}

        {error && (
          <div
            role="status"
            className="mt-3 flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-200"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading && !variance ? (
          <p className="mt-4 text-xs text-slate-400">Loading the budget comparison…</p>
        ) : variance ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Budget
                </p>
                <p className="mt-0.5 font-mono text-sm font-bold text-slate-700 dark:text-slate-200">
                  {formatMoney(variance.totals.budget)}
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Posted actual
                </p>
                <p className="mt-0.5 font-mono text-sm font-bold text-slate-700 dark:text-slate-200">
                  {formatMoney(variance.totals.actual)}
                </p>
              </div>
              <div
                className={`rounded-xl px-3 py-2 ${
                  variance.totals.variance < 0
                    ? 'bg-rose-50 dark:bg-rose-950/20'
                    : 'bg-emerald-50 dark:bg-emerald-950/20'
                }`}
              >
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Variance
                </p>
                <p
                  className={`mt-0.5 font-mono text-sm font-bold ${
                    variance.totals.variance < 0
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  {formatMoney(variance.totals.variance)}
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Over budget
                </p>
                <p className="mt-0.5 font-mono text-sm font-bold text-slate-700 dark:text-slate-200">
                  {overBudget} of {variance.rows.length}
                </p>
              </div>
            </div>

            {utilisation && utilisation.branches.length > 0 && (
              <div className="mt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Branch utilisation
                    </h4>
                    <p className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                      Posted actual against budget for each branch with activity. Department
                      utilisation waits for cost-centre budgets.
                    </p>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      utilisation.tieOut.reconciled
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                        : 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300'
                    }`}
                  >
                    {utilisation.tieOut.reconciled ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : (
                      <AlertTriangle className="h-3 w-3" />
                    )}
                    {utilisation.tieOut.reconciled
                      ? 'Ties to variance total'
                      : `Does not tie: ${formatMoney(utilisation.tieOut.budgetDifference)} budget / ${formatMoney(utilisation.tieOut.actualDifference)} actual`}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {utilisation.branches.map((branch) => {
                    const ratio = branch.utilisationPercent;
                    const width = ratio === null ? 0 : Math.max(0, Math.min(100, ratio));
                    return (
                      <article
                        key={branch.branchId}
                        aria-label={`Branch utilisation ${branch.code}`}
                        className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800/30"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-[11px] font-bold text-slate-700 dark:text-slate-200">
                              {branch.name}
                            </p>
                            <p className="font-mono text-[10px] text-slate-400">{branch.code}</p>
                          </div>
                          <span
                            className={`shrink-0 text-[10px] font-semibold ${
                              ratio === null
                                ? 'text-slate-400'
                                : ratio > 100
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-indigo-600 dark:text-indigo-400'
                            }`}
                          >
                            {ratio === null ? 'No budget' : `${ratio.toFixed(1)}% used`}
                          </span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                          <div
                            className={`h-full rounded-full ${
                              ratio !== null && ratio > 100 ? 'bg-amber-500' : 'bg-indigo-500'
                            }`}
                            style={{ width: `${width}%` }}
                          />
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <div>
                            <p className="text-[10px] uppercase tracking-wider text-slate-400">Actual</p>
                            <p className="font-mono text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                              {formatMoney(branch.actual)}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wider text-slate-400">Budget</p>
                            <p className="font-mono text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                              {formatMoney(branch.budget)}
                            </p>
                          </div>
                        </div>
                        <p
                          className={`mt-1.5 text-[10px] font-medium ${
                            branch.variance < 0
                              ? 'text-rose-600 dark:text-rose-400'
                              : 'text-emerald-600 dark:text-emerald-400'
                          }`}
                        >
                          {branch.variance < 0 ? 'Over plan by ' : 'Remaining '}
                          <span className="font-mono">{formatMoney(Math.abs(branch.variance))}</span>
                        </p>
                      </article>
                    );
                  })}
                </div>
              </div>
            )}

            {variance.rows.length === 0 ? (
              <div className="mt-4">
                <RegisterEmpty message="No budget lines or posted income/expense lines for this fiscal year and branch." />
              </div>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full border-collapse text-left text-[11px]">
                  <thead>
                    <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-400 dark:border-slate-700 dark:text-slate-500">
                      <th className="px-2 py-2 font-semibold">Account</th>
                      <th className="px-2 py-2 font-semibold">Type</th>
                      <th className="px-2 py-2 text-right font-semibold">Budget</th>
                      <th className="px-2 py-2 text-right font-semibold">Actual</th>
                      <th className="px-2 py-2 text-right font-semibold">Variance</th>
                      <th className="px-2 py-2 text-right font-semibold">Var %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {variance.rows.map((row) => (
                      <tr
                        key={row.accountId}
                        className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                      >
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            onClick={() => setDrillAccount(row)}
                            aria-label={`View posted journal lines for ${row.code} ${row.name}`}
                            className="text-left transition-colors hover:text-indigo-600 dark:hover:text-indigo-400"
                          >
                            <span className="font-mono text-[10px] text-slate-400">{row.code}</span>{' '}
                            <span className="font-medium text-slate-700 dark:text-slate-200">
                              {row.name}
                            </span>
                          </button>
                        </td>
                        <td className="px-2 py-2">
                          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                            {row.accountType === 'INCOME' ? 'Income' : 'Expense'}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-slate-600 dark:text-slate-300">
                          {formatMoney(row.budget)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-slate-600 dark:text-slate-300">
                          {formatMoney(row.actual)}
                        </td>
                        <td
                          className={`px-2 py-2 text-right font-mono font-semibold ${
                            row.variance < 0
                              ? 'text-rose-600 dark:text-rose-400'
                              : 'text-emerald-600 dark:text-emerald-400'
                          }`}
                        >
                          {formatMoney(row.variance)}
                        </td>
                        <td
                          className={`px-2 py-2 text-right font-mono ${
                            row.variancePercent === null
                              ? 'text-slate-400'
                              : row.variancePercent < 0
                                ? 'text-rose-600 dark:text-rose-400'
                                : 'text-emerald-600 dark:text-emerald-400'
                          }`}
                        >
                          {percentText(row.variancePercent)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-200 font-bold dark:border-slate-700">
                      <td className="px-2 py-2" colSpan={2}>
                        Total
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        {formatMoney(variance.totals.budget)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        {formatMoney(variance.totals.actual)}
                      </td>
                      <td
                        className={`px-2 py-2 text-right font-mono ${
                          variance.totals.variance < 0
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-emerald-600 dark:text-emerald-400'
                        }`}
                      >
                        {formatMoney(variance.totals.variance)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        {percentText(variance.totals.variancePercent)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            <p className="mt-2 text-[10px] leading-snug text-slate-400 dark:text-slate-500">
              Actuals are the same POSTED journal lines the profit-and-loss statement reads. A zero
              budget reports no variance percentage instead of an invented one.
            </p>
          </>
        ) : null}
      </section>

      {concrete && setup && (
        <BudgetAllocationPanel
          fiscalYearId={fiscalYearId}
          fiscalYearCode={fiscalYearCode}
          from={from}
          to={to}
          branchId={branchId}
          canManage={canManage}
          locked={locked}
          reloadToken={version}
        />
      )}

      {concrete && setup && (
        <BudgetHistoryPanel
          fiscalYearId={fiscalYearId}
          branchId={branchId}
          canManage={canManage}
          locked={locked}
          refreshToken={version}
          onRestored={(next) => {
            applyBudget(next);
            setVersion((current) => current + 1);
          }}
        />
      )}

      {concrete && canManage && setup && (
        <section className={panelClass}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">Budget lines</h3>
              <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                Monthly amounts per profit-and-loss account. A closed period keeps its stored line
                and refuses edits until it is reopened.
              </p>
            </div>
            {savedAt && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3" /> Saved {savedAt}
              </span>
            )}
          </div>

          <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800/30">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                  Copy or import
                </p>
                <p className="mt-0.5 text-[10px] leading-snug text-slate-500 dark:text-slate-400">
                  Copy maps the previous budgeted year by month. CSV columns: account_code,
                  period_key, amount. An invalid row rejects the whole file.
                </p>
              </div>
              <label className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  aria-label="Replace existing budget"
                  checked={replaceExisting}
                  disabled={locked}
                  onChange={(event) => setReplaceExisting(event.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 disabled:opacity-50"
                />
                Replace existing budget
              </label>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={copyForward}
                disabled={transferBusy !== '' || locked}
                title={locked ? 'Unlock the budget before copying into it.' : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <Copy className="h-3.5 w-3.5" />
                {transferBusy === 'copy' ? 'Copying…' : 'Copy from previous year'}
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={transferBusy !== '' || locked}
                title={locked ? 'Unlock the budget before importing CSV lines.' : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <Upload className="h-3.5 w-3.5" />
                {transferBusy === 'import' ? 'Importing…' : 'Import CSV'}
              </button>
              <button
                type="button"
                onClick={exportCsv}
                disabled={transferBusy !== ''}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <Download className="h-3.5 w-3.5" />
                {transferBusy === 'export' ? 'Exporting…' : 'Export CSV'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                aria-label="Budget CSV file"
                className="sr-only"
                onChange={importCsv}
              />
            </div>
            {transferNotice && (
              <p role="status" className="mt-2 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                {transferNotice}
              </p>
            )}
            {transferErrors.length > 0 && (
              <ul
                aria-label="Budget CSV errors"
                className="mt-2 space-y-0.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-[10px] text-rose-700 dark:border-rose-800/50 dark:bg-rose-950/30 dark:text-rose-200"
              >
                {transferErrors.map((row) => (
                  <li key={`${row.row}-${row.message}`}>
                    {row.row > 0 ? `Row ${row.row}: ` : 'File: '}
                    {row.message}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Account
              <select
                aria-label="Budget account"
                value={accountId}
                disabled={locked}
                onChange={(event) => setAccountId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                {setup.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} · {account.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Period
              <select
                aria-label="Budget period"
                value={periodKey}
                disabled={locked}
                onChange={(event) => setPeriodKey(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                {setup.periods.map((period) => (
                  <option key={period.periodKey} value={period.periodKey}>
                    {period.periodKey}
                    {period.status === 'CLOSED' ? ' (closed)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Amount
              <input
                aria-label="Budget amount"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                disabled={locked}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              />
            </label>
            <div className="flex items-end">
              <button
                type="button"
                onClick={addLine}
                disabled={locked}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-950/60"
              >
                <Plus className="h-3.5 w-3.5" /> Add line
              </button>
            </div>
          </div>

          {saveError && (
            <div
              role="status"
              className="mt-3 flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-200"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{saveError}</span>
            </div>
          )}

          {draft.length === 0 ? (
            <div className="mt-3">
              <RegisterEmpty message="No budget lines yet. Choose an account, period and amount, then add the line." />
            </div>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-[11px]">
                <thead>
                  <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-400 dark:border-slate-700 dark:text-slate-500">
                    <th className="px-2 py-2 font-semibold">Period</th>
                    <th className="px-2 py-2 font-semibold">Account</th>
                    <th className="px-2 py-2 text-right font-semibold">Amount</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {draft.map((line, index) => (
                    <tr
                      key={`${line.periodKey}-${line.accountId}`}
                      className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                    >
                      <td className="px-2 py-2 font-mono text-slate-600 dark:text-slate-300">
                        {line.periodKey}
                      </td>
                      <td className="px-2 py-2 text-slate-700 dark:text-slate-200">
                        {line.code ? `${line.code} · ` : ''}
                        {line.name || line.accountId}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-slate-600 dark:text-slate-300">
                        {formatMoney(line.amount)}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => removeLine(index)}
                          disabled={locked}
                          aria-label={`Remove budget line ${line.periodKey} ${line.code || line.accountId}`}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 dark:hover:bg-rose-950/30 dark:hover:text-rose-400"
                        >
                          <Trash2 className="h-3 w-3" /> Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving || locked}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" /> {saving ? 'Saving…' : 'Save budget'}
            </button>
          </div>
        </section>
      )}

      {concrete && !canManage && (
        <p className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[11px] text-slate-500 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
          Viewing this branch&apos;s budget. Editing requires the{' '}
          <span className="font-mono">gl-chart-manage</span> permission.
        </p>
      )}

      {drillAccount && (
        <LedgerDrilldownDialog
          request={{
            kind: 'budget-account',
            title: `${drillAccount.code} · ${drillAccount.name}`,
            subtitle: `FY ${variance?.fiscalYearCode || fiscalYearCode} · ${
              branchId === 'ALL' ? 'all branches' : branchId
            } · ${variance?.from || from} to ${variance?.to || to}`,
            fiscalYearId,
            accountId: drillAccount.accountId,
            branchId,
            from: variance?.from || from,
            to: variance?.to || to,
          }}
          onClose={() => setDrillAccount(null)}
        />
      )}
    </div>
  );
};
