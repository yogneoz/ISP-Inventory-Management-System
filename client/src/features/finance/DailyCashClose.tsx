/**
 * Daily Cash Close — the branch cash position for one business day and the
 * counted close/reopen actions.
 *
 * Every figure comes from the server's daily-cash endpoint, which derives it
 * from posted cash/bank journal lines (the same rows the cash book and balance
 * sheet read). The screen never re-sums a payment document, so its closing
 * figure cannot quietly disagree with the ledger.
 *
 * A global account sees every branch and the company total; a branch account
 * sees only its assigned branches, matching the server's branch scope. Close
 * and reopen need `gl-cash-close`; `gl-view` alone is a read-only view of the same
 * figures.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import { PageHeader } from '../../components/common/PageHeader';
import { StatCard } from '../../components/common/StatCard';
import { api } from '../../services/api';
import type {
  CashCloseBranch,
  CashCloseBranchResponse,
  CashPositionResponse,
  CashPositionTotals,
} from '../../services/api/accounting';
import type { Branch, User } from '../../types';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { formatNPR } from '../../utils/nprFormat';
import {
  getScopedBranches,
  hasGlobalBranchScope,
  isOperationAllowed,
} from '../../utils/permissions';
import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  RefreshCw,
  Unlock,
  Wallet,
} from 'lucide-react';

interface DailyCashCloseProps {
  branches: Branch[];
  dateMode: 'BS' | 'AD';
  currentUser?: User | null;
}

function todayAD(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
}

function money(value: number | string | null | undefined): string {
  return formatNPR(typeof value === 'string' ? Number(value) : value);
}

function amountCell(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value === 0 ? '—' : money(value);
}

const StatusPill: React.FC<{ status: 'CLOSED' | 'OPEN' }> = ({ status }) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${
      status === 'CLOSED'
        ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-400'
        : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-400'
    }`}
  >
    {status === 'CLOSED' ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
    {status === 'CLOSED' ? 'Closed' : 'Open'}
  </span>
);

const TotalsRow: React.FC<{ totals: CashPositionTotals; label: string }> = ({ totals, label }) => (
  <tr className="border-t border-slate-200 bg-slate-100 text-xs font-bold text-slate-800 dark:border-slate-800 dark:bg-slate-900/80 dark:text-slate-200">
    <td className="px-2.5 py-1.5 uppercase tracking-wider">{label}</td>
    <td className="px-2.5 py-1.5 text-right font-mono">{money(totals.opening)}</td>
    <td className="px-2.5 py-1.5 text-right font-mono text-emerald-700 dark:text-emerald-400">{money(totals.cashIn)}</td>
    <td className="px-2.5 py-1.5 text-right font-mono text-rose-700 dark:text-rose-400">{money(totals.cashOut)}</td>
    <td className="px-2.5 py-1.5 text-right font-mono">{money(totals.expectedClosing)}</td>
    <td className="px-2.5 py-1.5 text-right font-mono">{money(totals.countedClosing)}</td>
    <td className={`px-2.5 py-1.5 text-right font-mono ${Math.abs(totals.variance) >= 0.005 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
      {money(totals.variance)}
    </td>
    <td className="px-2.5 py-1.5 text-center text-[10px] font-semibold text-slate-500 dark:text-slate-400">
      {totals.closedBranches}/{totals.closedBranches + totals.openBranches} closed
    </td>
  </tr>
);

export const DailyCashClose: React.FC<DailyCashCloseProps> = ({
  branches,
  dateMode,
  currentUser,
}) => {
  const allowed = isOperationAllowed('gl-view', currentUser?.role);
  const canClose = isOperationAllowed('gl-cash-close', currentUser?.role);
  const isVisible = useTabActive('cash-position') && allowed;
  const activationKey = useActivationKey('cash-position');
  const scopedBranches = useMemo(
    () => getScopedBranches(currentUser, branches),
    [branches, currentUser]
  );
  const canSeeAllBranches = hasGlobalBranchScope(currentUser);

  const [branchId, setBranchId] = useState(() => {
    if (canSeeAllBranches) return 'ALL';
    if (currentUser?.branchId && currentUser.branchId !== 'ALL') return currentUser.branchId;
    return scopedBranches[0]?.id || '';
  });
  const [dateAD, setDateAD] = useState(todayAD);
  const [rollup, setRollup] = useState<CashPositionResponse | null>(null);
  const [branchView, setBranchView] = useState<CashCloseBranchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [countedInput, setCountedInput] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [saving, setSaving] = useState(false);

  // A stale scope (user loaded late, branch removed) must fall back to an
  // allowed choice instead of asking for a branch the server will refuse.
  useEffect(() => {
    const options = canSeeAllBranches
      ? ['ALL', ...scopedBranches.map((branch) => branch.id)]
      : scopedBranches.map((branch) => branch.id);
    if (!options.includes(branchId)) setBranchId(options[0] || '');
  }, [branchId, canSeeAllBranches, scopedBranches]);

  const load = async () => {
    if (!allowed || !dateAD) return;
    if (branchId !== 'ALL' && !branchId) return;
    setLoading(true);
    setError('');
    try {
      if (branchId === 'ALL') {
        setRollup(await api.getDailyCashCloseConsolidated(dateAD));
        setBranchView(null);
      } else {
        setBranchView(await api.getDailyCashClose(branchId, dateAD));
        setRollup(null);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load the daily cash position.');
      setRollup(null);
      setBranchView(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isVisible) return;
    setActionError('');
    setActionMessage('');
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, branchId, dateAD, activationKey, reloadKey]);

  const branch: CashCloseBranch | null = branchView?.branch ?? null;
  const rows = branchView ? [branchView.branch] : rollup?.branches ?? [];
  const totals = branchView?.totals ?? rollup?.totals ?? null;
  const selectedBranch = scopedBranches.find((entry) => entry.id === branchId);

  const counted = countedInput.trim() === '' ? null : Number(countedInput);
  const variancePreview =
    counted !== null && Number.isFinite(counted) && branch
      ? Math.round((counted - branch.expectedClosing) * 100) / 100
      : null;

  const refresh = async (message: string) => {
    setActionMessage(message);
    setActionError('');
    setReloadKey((key) => key + 1);
  };

  const handleClose = async () => {
    if (!branch || branchId === 'ALL') return;
    if (counted === null || !Number.isFinite(counted) || counted < 0) {
      setActionError('Enter the cash counted at close as a non-negative amount.');
      return;
    }
    setSaving(true);
    setActionError('');
    try {
      const record = await api.closeDailyCash(branchId, dateAD, counted);
      setCountedInput('');
      await refresh(
        `Closed ${selectedBranch?.code || branchId} for ${dateAD}: counted ${money(record.countedClosing)}, variance ${money(record.variance)}.`
      );
    } catch (err: any) {
      setActionError(err?.message || 'The day could not be closed.');
    } finally {
      setSaving(false);
    }
  };

  const handleReopen = async () => {
    if (!branch?.close) return;
    setSaving(true);
    setActionError('');
    try {
      await api.reopenDailyCashClose(branch.close.id);
      await refresh(`Reopened ${selectedBranch?.code || branchId} for ${dateAD}. Count it again and close.`);
    } catch (err: any) {
      setActionError(err?.message || 'The day could not be reopened.');
    } finally {
      setSaving(false);
    }
  };

  if (!allowed) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Daily Cash Close"
          description="Today's cash in, cash out and per-branch closing cash from the posted ledger."
          icon={<Wallet className="h-5 w-5 text-indigo-500" />}
        />
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-bold">Access refused</p>
            <p className="text-xs leading-5">
              Your account does not have the <span className="font-mono">gl-view</span> permission,
              so the daily cash position cannot be opened. Ask an administrator for access.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Daily Cash Close"
        description="Cash in, cash out and closing cash per branch for one business day, plus the counted close and its variance. Figures are posted journal lines, not payment documents."
        icon={<Wallet className="h-5 w-5 text-indigo-500" />}
        actions={
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 text-slate-400 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      />

      <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40 md:grid-cols-3">
        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">
          Branch
          <select
            aria-label="Cash close branch"
            value={branchId}
            onChange={(event) => {
              setBranchId(event.target.value);
              setActionError('');
              setActionMessage('');
              setCountedInput('');
            }}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
          >
            {canSeeAllBranches && (
              <option value="ALL">All Branches (company total)</option>
            )}
            {scopedBranches.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.code} · {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">
          Business date (AD)
          <input
            aria-label="Cash close business date"
            type="date"
            value={dateAD}
            onChange={(event) => {
              setDateAD(event.target.value);
              setActionError('');
              setActionMessage('');
              setCountedInput('');
            }}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
          />
        </label>
        <div className="flex items-end">
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-snug text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
            {branchId === 'ALL'
              ? 'Company roll-up of every branch this account may see'
              : selectedBranch?.name || branchId}{' '}
            on <span className="font-semibold text-slate-700 dark:text-slate-200">{formatDualDate(dateAD, dateMode)}</span>.
            Closing cash ties to the cash book and balance sheet.
          </p>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </span>
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            className="rounded-lg border border-rose-300 px-2 py-1 font-bold hover:bg-rose-100 dark:border-rose-500/40 dark:hover:bg-rose-900/40"
          >
            Retry
          </button>
        </div>
      )}

      {loading && !error && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          Loading the cash position…
        </div>
      )}

      {!loading && !error && totals && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="CASH IN"
              value={money(totals.cashIn)}
              tone="emerald"
              hint="Debits to cash and bank on the day"
            />
            <StatCard
              label="CASH OUT"
              value={money(totals.cashOut)}
              tone="rose"
              hint="Credits to cash and bank on the day"
            />
            <StatCard
              label={branchId === 'ALL' ? 'COMPANY CLOSING CASH' : 'EXPECTED CLOSING'}
              value={money(totals.expectedClosing)}
              tone="indigo"
              hint="Posted lines through the day; ties to the cash book"
            />
            <StatCard
              label={branchId === 'ALL' ? 'BRANCHES CLOSED' : 'COUNTED / VARIANCE'}
              value={
                branchId === 'ALL'
                  ? `${totals.closedBranches}/${totals.closedBranches + totals.openBranches}`
                  : branch?.status === 'CLOSED'
                    ? `${money(branch.countedClosing)} / ${money(branch.variance)}`
                    : 'Not closed'
              }
              tone={branchId === 'ALL' || branch?.status === 'CLOSED' ? 'amber' : 'slate'}
              hint={branchId === 'ALL' ? 'Branches with a counted close' : 'Counted cash and counted − expected'}
            />
          </div>

          {branch && (
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
                <div>
                  <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Close this day</h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Opening {money(branch.opening)} + cash in {money(branch.cashIn)} − cash out {money(branch.cashOut)} = {money(branch.expectedClosing)} expected closing.
                  </p>
                </div>
                <StatusPill status={branch.status} />
              </div>

              {branch.stale && (
                <div role="alert" className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  A journal posted after this count, so the closing figure moved. Reopen the day and count again.
                </div>
              )}

              {branch.status === 'CLOSED' && branch.close ? (
                <div className="flex flex-wrap items-end justify-between gap-3 px-3 py-3">
                  <div className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Counted</p>
                      <p className="font-mono font-bold text-slate-800 dark:text-slate-200">{money(branch.countedClosing)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Expected</p>
                      <p className="font-mono font-bold text-slate-800 dark:text-slate-200">{money(branch.close.expectedClosing)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Variance</p>
                      <p className={`font-mono font-bold ${Math.abs(branch.variance || 0) >= 0.005 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
                        {money(branch.variance)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Closed by</p>
                      <p className="font-semibold text-slate-700 dark:text-slate-300">{branch.close.closedBy || '—'}</p>
                    </div>
                  </div>
                  {canClose && (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={handleReopen}
                      className="flex items-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-900/40"
                    >
                      <Unlock className="h-3.5 w-3.5" />
                      Reopen day
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap items-end gap-3 px-3 py-3">
                  <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">
                    Counted closing cash
                    <input
                      aria-label="Counted closing cash"
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      value={countedInput}
                      onChange={(event) => setCountedInput(event.target.value)}
                      disabled={!canClose || saving}
                      className="mt-1 w-44 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-800 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                    />
                  </label>
                  <div className="pb-1 text-xs text-slate-500 dark:text-slate-400">
                    Variance{' '}
                    <span className={`font-mono font-bold ${variancePreview !== null && Math.abs(variancePreview) >= 0.005 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-200'}`}>
                      {variancePreview === null ? '—' : money(variancePreview)}
                    </span>
                  </div>
                  {canClose ? (
                    <button
                      type="button"
                      disabled={saving || counted === null}
                      onClick={handleClose}
                      className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                    >
                      <Lock className="h-3.5 w-3.5" />
                      {saving ? 'Closing…' : 'Close day'}
                    </button>
                  ) : (
                    <p className="pb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                      Your role can read the cash position but not close it (`gl-cash-close` required).
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {(actionError || actionMessage) && (
            <div
              role={actionError ? 'alert' : 'status'}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${
                actionError
                  ? 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300'
                  : 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300'
              }`}
            >
              {actionError ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <CheckCircle2 className="h-4 w-4 shrink-0" />}
              {actionError || actionMessage}
            </div>
          )}

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
              <div>
                <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Per-branch closing cash</h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {branchId === 'ALL' ? 'Every branch this account may see, with the company total.' : 'The selected branch and its day total.'}
                </p>
              </div>
              <span className="font-mono text-xs font-bold text-slate-900 dark:text-white">
                Company total {money(totals.expectedClosing)}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
                  <tr>
                    <th className="px-2.5 py-1.5">Branch</th>
                    <th className="px-2.5 py-1.5 text-right">Opening</th>
                    <th className="px-2.5 py-1.5 text-right">Cash in</th>
                    <th className="px-2.5 py-1.5 text-right">Cash out</th>
                    <th className="px-2.5 py-1.5 text-right">Closing</th>
                    <th className="px-2.5 py-1.5 text-right">Counted</th>
                    <th className="px-2.5 py-1.5 text-right">Variance</th>
                    <th className="px-2.5 py-1.5 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium dark:divide-slate-800/60">
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                        No branch is in this account's scope, so there is no cash position to show.
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr key={row.branchId} className="text-slate-800 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/40">
                        <td className="px-2.5 py-1.5 font-bold">
                          <span className="mr-2 font-mono text-[11px] text-indigo-600 dark:text-indigo-400">{row.code}</span>
                          {row.name}
                          {row.stale && (
                            <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5                              text-[10px] font-bold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                              STALE
                            </span>
                          )}
                        </td>
                        <td className="px-2.5 py-1.5 text-right font-mono">{amountCell(row.opening)}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono text-emerald-700 dark:text-emerald-400">{amountCell(row.cashIn)}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono text-rose-700 dark:text-rose-400">{amountCell(row.cashOut)}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono font-bold">{money(row.expectedClosing)}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono">{amountCell(row.countedClosing)}</td>
                        <td className={`px-2.5 py-1.5 text-right font-mono ${row.variance !== null && Math.abs(row.variance) >= 0.005 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                          {amountCell(row.variance)}
                        </td>
                        <td className="px-2.5 py-1.5 text-center">
                          <StatusPill status={row.status} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot>
                  <TotalsRow totals={totals} label={branchId === 'ALL' ? 'Company total' : 'Day total'} />
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default DailyCashClose;
