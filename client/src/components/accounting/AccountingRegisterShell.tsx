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
import {
  PeriodRangeField,
  usePeriodRangeFilter,
  type PeriodRange,
} from '../common/PeriodRangeField';

export interface AccountingScope {
  allowed: boolean;
  canSeeAllBranches: boolean;
  scopedBranches: Branch[];
  /** The branch the figures on screen were read for. */
  branchId: string;
  setBranchId: (id: string) => void;
  /**
   * The period the figures on screen were read for. `fromDate` is empty for a
   * from-inception read; `asOfDate` is the range end.
   */
  asOfDate: string;
  fromDate: string;
  /** The range being edited. Choosing dates never loads anything by itself. */
  draft: PeriodRange;
  setDraftFrom: (date: string) => void;
  setDraftTo: (date: string) => void;
  /** Adopt the draft range: the only path from a date edit to a request. */
  applyPeriod: () => void;
  /** The draft differs from the range the screen shows. */
  periodPending: boolean;
  /** Applied query for reads that take only an as-of date. */
  query: { branchId?: string; to: string };
  /** Applied query for reads that take an optional period start. */
  rangeQuery: { branchId?: string; from?: string; to: string };
}

export interface AccountingScreenProps {
  dateMode: 'BS' | 'AD';
  fiscalYearStartAD?: string;
  /** The signed-in account; the ledger read is gated by `gl-view`. */
  currentUser?: User | null;
}

/**
 * Branch/period scope for one accounting register. Branch changes apply at
 * once; a date change waits for `applyPeriod`, so the screens that render the
 * range cannot fetch a half-selected one.
 */
export function useAccountingScope(
  branches: Branch[],
  currentUser?: User | null,
  options: { defaultFrom?: string } = {}
): AccountingScope {
  const defaultFrom = options.defaultFrom || '';
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
  const range = usePeriodRangeFilter(
    { from: defaultFrom, to: localTodayAD() },
    { requireEnd: true }
  );

  useEffect(() => {
    const allowed = canSeeAllBranches
      ? ['ALL', ...scopedBranches.map((branch) => branch.id)]
      : scopedBranches.map((branch) => branch.id);
    if (!allowed.includes(branchId)) setBranchId(allowed[0] || '');
  }, [branchId, canSeeAllBranches, scopedBranches]);

  // The fiscal-year start arrives with the bootstrap payload. Seed it as the
  // opening point when the caller asks for one, without overwriting a range the
  // operator has already chosen or cleared.
  useEffect(() => {
    if (defaultFrom) range.seedFrom(defaultFrom);
  }, [defaultFrom, range.seedFrom]);

  const query = useMemo(
    () => ({ branchId: branchId === 'ALL' ? undefined : branchId, to: range.to }),
    [branchId, range.to]
  );
  const rangeQuery = useMemo(
    () => ({
      branchId: branchId === 'ALL' ? undefined : branchId,
      ...(range.from ? { from: range.from } : {}),
      to: range.to,
    }),
    [branchId, range.from, range.to]
  );

  return {
    allowed: isOperationAllowed('gl-view', currentUser?.role),
    canSeeAllBranches,
    scopedBranches,
    branchId,
    setBranchId,
    asOfDate: range.to,
    fromDate: range.from,
    draft: range.draft,
    setDraftFrom: range.setFrom,
    setDraftTo: range.setTo,
    applyPeriod: range.apply,
    periodPending: range.pending,
    query,
    rangeQuery,
  };
}

export const RegisterEmpty: React.FC<{ message: string }> = ({ message }) => (
  <div className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-xs text-slate-400 dark:border-slate-800 dark:bg-slate-900/40">
    {message}
  </div>
);

/**
 * Page chrome shared by the accounting registers: permission refusal, header
 * with refresh, one branch + period filter, and the body.
 *
 * The filter row and the status row keep a fixed height whether a request is
 * running, finished or failed. Nothing is inserted above the body while
 * loading, so refreshing a register never pushes its figures down, and the body
 * keeps a minimum height so the first load does not collapse the page.
 */
export const AccountingRegisterShell: React.FC<{
  title: string;
  description: string;
  icon: React.ReactNode;
  /** Lower-case register name used in the loading line. */
  registerName: string;
  scope: AccountingScope;
  dateMode: 'BS' | 'AD';
  /** Consolidated screens show every branch as a table column. */
  hideBranchSelector?: boolean;
  /** Replaces the default showing-branch/period sentence. */
  scopeNote?: React.ReactNode;
  /** Optional screen-specific actions rendered beside Refresh. */
  headerActions?: React.ReactNode;
  /** Marks the whole register as the print document and hides screen chrome. */
  printable?: boolean;
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
  hideBranchSelector = false,
  scopeNote,
  headerActions,
  printable = false,
  loading,
  error,
  onRefresh,
  onRetry,
  children,
}) => {
  const {
    allowed,
    canSeeAllBranches,
    scopedBranches,
    branchId,
    setBranchId,
    asOfDate,
    fromDate,
    draft,
    setDraftFrom,
    setDraftTo,
    applyPeriod,
    periodPending,
  } = scope;

  const branchLabel =
    branchId === 'ALL'
      ? 'all branches (company level)'
      : scopedBranches.find((branch) => branch.id === branchId)?.name || branchId;

  if (!allowed) {
    return (
      <div className="space-y-4">
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
    <div className={`space-y-3 ${printable ? 'printable-document' : ''}`}>
      <PageHeader
        title={title}
        description={description}
        icon={icon}
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            {headerActions}
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <RefreshCw className={`h-3.5 w-3.5 text-slate-400 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        }
      />

      <div
        className={`rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900/40 ${printable ? 'print:hidden' : ''}`}
      >
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          {!hideBranchSelector && (
            <label className="block w-full text-xs font-semibold text-slate-500 md:w-64 dark:text-slate-400">
              Branch
              <select
                aria-label="Accounting branch"
                value={branchId}
                onChange={(event) => setBranchId(event.target.value)}
                className="mt-1 h-8 w-full rounded-lg border border-slate-300 bg-white px-2 text-xs text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
              >
                {canSeeAllBranches && <option value="ALL">All Branches (company level)</option>}
                {scopedBranches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.code} · {branch.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="min-w-0 flex-1 md:max-w-md">
            <PeriodRangeField
              from={draft.from}
              to={draft.to}
              onChange={(next) => {
                setDraftFrom(next.from);
                setDraftTo(next.to);
              }}
              onApply={applyPeriod}
              pending={periodPending}
            />
          </div>
        </div>
      </div>

      <div
        role="status"
        aria-live="polite"
        className={`flex h-8 items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-[11px] text-slate-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400 ${printable ? 'print:hidden' : ''}`}
      >
        <span className="truncate">
          {scopeNote || (
            <>
              Showing {branchLabel}{' '}
              {fromDate ? (
                <>
                  from{' '}
                  <span className="font-semibold text-slate-700 dark:text-slate-200">
                    {formatDualDate(fromDate, dateMode)}
                  </span>{' '}
                  to{' '}
                </>
              ) : (
                <>as of </>
              )}
              <span className="font-semibold text-slate-700 dark:text-slate-200">
                {formatDualDate(asOfDate, dateMode)}
              </span>
              .
            </>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {error ? (
            <>
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" aria-hidden />
              <span className="max-w-[26rem] truncate text-rose-700 dark:text-rose-300" title={error}>
                {error}
              </span>
              <button
                type="button"
                onClick={onRetry}
                className="rounded-md border border-rose-300 px-1.5 py-0.5 text-[11px] font-bold text-rose-700 hover:bg-rose-100 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-900/40"
              >
                Retry
              </button>
            </>
          ) : loading ? (
            <>
              <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Loading {registerName}…
            </>
          ) : null}
        </span>
      </div>

      <div className={`min-h-[16rem] ${printable ? 'print:min-h-0' : ''}`}>{children}</div>
    </div>
  );
};
