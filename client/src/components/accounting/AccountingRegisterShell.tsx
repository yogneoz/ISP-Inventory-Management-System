import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { PageHeader } from '../common/PageHeader';
import type { Branch, User } from '../../types';
import { localTodayAD } from '../../utils/localDate';
import { formatDualDate } from '../../utils/nepaliCalendar';
import {
  getScopedBranches,
  hasGlobalBranchScope,
  isOperationAllowed,
} from '../../utils/permissions';

export interface AccountingScope {
  allowed: boolean;
  canSeeAllBranches: boolean;
  scopedBranches: Branch[];
  branchId: string;
  setBranchId: (id: string) => void;
  asOfDate: string;
  setAsOfDate: (date: string) => void;
  query: { branchId?: string; to: string };
}

export interface AccountingScreenProps {
  branches: Branch[];
  dateMode: 'BS' | 'AD';
  /** The signed-in account; the ledger read is gated by `gl-view`. */
  currentUser?: User | null;
}

/**
 * Branch/as-of scope for one accounting register. Every register used to share
 * the Accounting Workspace selector; now each register owns the same scope with
 * the same repair rule (a stale or out-of-scope branch falls back to the first
 * branch the account may read).
 */
export function useAccountingScope(
  branches: Branch[],
  currentUser?: User | null
): AccountingScope {
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
  const [asOfDate, setAsOfDate] = useState(localTodayAD());

  useEffect(() => {
    const allowed = canSeeAllBranches
      ? ['ALL', ...scopedBranches.map((branch) => branch.id)]
      : scopedBranches.map((branch) => branch.id);
    if (!allowed.includes(branchId)) setBranchId(allowed[0] || '');
  }, [branchId, canSeeAllBranches, scopedBranches]);

  const query = useMemo(
    () => ({ branchId: branchId === 'ALL' ? undefined : branchId, to: asOfDate }),
    [branchId, asOfDate]
  );

  return {
    allowed: isOperationAllowed('gl-view', currentUser?.role),
    canSeeAllBranches,
    scopedBranches,
    branchId,
    setBranchId,
    asOfDate,
    setAsOfDate,
    query,
  };
}

export const RegisterEmpty: React.FC<{ message: string }> = ({ message }) => (
  <div className="rounded-2xl border border-slate-200 bg-white px-4 py-8 text-center text-xs text-slate-400 dark:border-slate-800 dark:bg-slate-900/40">
    {message}
  </div>
);

/**
 * Page chrome shared by the accounting registers: permission refusal, header
 * with refresh, branch/as-of selector, error/loading banners and the body.
 */
export const AccountingRegisterShell: React.FC<{
  title: string;
  description: string;
  icon: React.ReactNode;
  /** Lower-case register name used in the loading banner. */
  registerName: string;
  scope: AccountingScope;
  dateMode: 'BS' | 'AD';
  /** Optional period start for flow statements such as cash flow. */
  periodStart?: { value: string; onChange: (value: string) => void };
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onRetry: () => void;
  children: React.ReactNode;
}> = ({
  title,
  description,
  icon,
  registerName,
  scope,
  dateMode,
  periodStart,
  loading,
  error,
  onRefresh,
  onRetry,
  children,
}) => {
  const { allowed, canSeeAllBranches, scopedBranches, branchId, setBranchId, asOfDate, setAsOfDate } =
    scope;

  if (!allowed) {
    return (
      <div className="space-y-5">
        <PageHeader title={title} description={description} icon={icon} />
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-bold">Access refused</p>
            <p className="text-xs leading-5">
              Your account does not have the <span className="font-mono">gl-view</span> permission,
              so the ledger registers cannot be opened. Ask an administrator for access.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={title}
        description={description}
        icon={icon}
        actions={
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 text-slate-400 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      />

      <div className={`grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40 ${periodStart ? 'md:grid-cols-4' : 'md:grid-cols-3'}`}>
        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">
          Branch
          <select
            aria-label="Accounting branch"
            value={branchId}
            onChange={(event) => setBranchId(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
          >
            {canSeeAllBranches && (
              <option value="ALL">All Branches (company level)</option>
            )}
            {scopedBranches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.code} · {branch.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">
          As of (AD)
          <input
            aria-label="Accounting as of date"
            type="date"
            value={asOfDate}
            onChange={(event) => setAsOfDate(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
          />
        </label>
        {periodStart && (
          <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">
            From (AD) — optional
            <input
              aria-label="Accounting period start"
              type="date"
              max={asOfDate}
              value={periodStart.value}
              onChange={(event) => periodStart.onChange(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
            />
          </label>
        )}
        <div className="flex items-end">
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-snug text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
            Showing {branchId === 'ALL' ? 'all branches (company level)' : scopedBranches.find((branch) => branch.id === branchId)?.name || branchId} as of{' '}
            <span className="font-semibold text-slate-700 dark:text-slate-200">{formatDualDate(asOfDate, dateMode)}</span>.
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
            onClick={onRetry}
            className="rounded-lg border border-rose-300 px-2 py-1 font-bold hover:bg-rose-100 dark:border-rose-500/40 dark:hover:bg-rose-900/40"
          >
            Retry
          </button>
        </div>
      )}

      {loading && !error && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          Loading {registerName}…
        </div>
      )}

      {children}
    </div>
  );
};
