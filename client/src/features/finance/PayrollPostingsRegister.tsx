/**
 * Finance & Accounting → Payroll Postings.
 *
 * A read-only register of POSTED and PAID payroll runs. Every figure comes from
 * the immutable run and run-line snapshots, and the linked posting/payment
 * journals are shown alongside it. DRAFT and APPROVED runs are deliberately
 * excluded; posting and payment remain on the People & HR payroll screen and
 * the `gl-payroll-post` routes.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, RefreshCw, Wallet } from 'lucide-react';
import { FilterCard } from '../../components/common/FilterCard';
import { PageHeader } from '../../components/common/PageHeader';
import { SearchSelect, type SearchSelectOption } from '../../components/common/SearchSelect';
import { TablePagination, useClientPagination } from '../../components/common/TablePagination';
import { inputClass, labelClass } from '../../components/common/styleConstants';
import { useActivationKey } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type { HrPayrollPostingRow } from '../../services/api';
import type { Branch, User } from '../../types';
import { formatMoneyPrecise } from '../../utils/nprFormat';
import {
  getScopedBranches,
  hasGlobalBranchScope,
  isOperationAllowed,
} from '../../utils/permissions';
import { useBootstrapData } from '../../contexts/AppProviders';

interface PayrollPostingsRegisterProps {
  currentUser?: User | null;
}

const PAGE_SIZE = 15;

const panel =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const errorBox =
  'flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';

const amount = (value: number | string): string => formatMoneyPrecise(value);

const statusBadgeClass = (status: string): string =>
  status === 'PAID'
    ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
    : 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300';

export const PayrollPostingsRegister: React.FC<PayrollPostingsRegisterProps> = ({
  currentUser,
}) => {
  // Workspace data: owned by BootstrapDataProvider (step 6 of the App split).
  const { branches } = useBootstrapData();
  const allowed = isOperationAllowed('gl-view', currentUser?.role);
  const canSeeAll = hasGlobalBranchScope(currentUser);
  const scopedBranches = useMemo(
    () => getScopedBranches(currentUser, branches).filter((branch) => branch.active),
    [branches, currentUser]
  );
  const activationKey = useActivationKey('finance-payroll-postings');

  const branchOptions = useMemo<SearchSelectOption[]>(() => {
    const options: SearchSelectOption[] = canSeeAll
      ? [{ value: 'ALL', label: 'All branches' }]
      : [];
    for (const branch of scopedBranches) {
      options.push({ value: branch.id, label: `${branch.code} · ${branch.name}` });
    }
    return options;
  }, [canSeeAll, scopedBranches]);

  const initialBranch = () => {
    if (canSeeAll) return 'ALL';
    if (currentUser?.branchId && currentUser.branchId !== 'ALL') return currentUser.branchId;
    return scopedBranches[0]?.id || '';
  };

  const [branchId, setBranchId] = useState(initialBranch);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [rows, setRows] = useState<HrPayrollPostingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (branchId && branchOptions.some((option) => option.value === branchId)) return;
    setBranchId(branchOptions[0]?.value || '');
  }, [branchId, branchOptions]);

  const load = useCallback(async () => {
    if (!allowed || !branchId) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const next = await api.getHrPayrollPostings({
        branchId: branchId === 'ALL' ? undefined : branchId,
        from: fromDate || undefined,
        to: toDate || undefined,
        query: searchTerm || undefined,
      });
      setRows(Array.isArray(next) ? next : []);
    } catch (err: any) {
      setError(err?.message || 'The payroll-postings register could not be loaded.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [allowed, branchId, fromDate, searchTerm, toDate]);

  useEffect(() => {
    if (!allowed) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, load, activationKey]);

  const pagination = useClientPagination(rows, PAGE_SIZE, [
    branchId,
    fromDate,
    toDate,
    searchTerm,
  ]);

  const clearFilters = () => {
    setFromDate('');
    setToDate('');
    setSearchTerm('');
  };

  if (!allowed) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Payroll Postings"
          description="Read-only register of posted and paid payroll runs."
          icon={<Wallet className="h-5 w-5 text-indigo-500" />}
        />
        <div className={errorBox}>
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>You do not have permission to view accounting ledgers.</span>
        </div>
      </div>
    );
  }

  const filterActive = Boolean(fromDate || toDate || searchTerm);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Payroll Postings"
        description="Read-only register of posted and paid payroll runs, their immutable salary snapshots and linked journals. DRAFT and APPROVED runs are excluded."
        icon={<Wallet className="h-5 w-5 text-indigo-500" />}
        actions={
          <button type="button" onClick={() => void load()} disabled={loading} className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">
            <RefreshCw className={`h-3.5 w-3.5 text-slate-400 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      />

      <section className={panel}>
        <FilterCard
          searchPlaceholder="Run no., period or branch"
          searchValue={searchTerm}
          onSearchApply={setSearchTerm}
          onClearAll={clearFilters}
          hasActiveFilters={filterActive}
          rightChildren={
            <span className="text-[11px] font-medium text-slate-400">
              {rows.length} posted run{rows.length === 1 ? '' : 's'}
            </span>
          }
          filterChildren={
            <>
              <div>
                <label className={labelClass}>Branch</label>
                <SearchSelect
                  value={branchId}
                  options={branchOptions}
                  onChange={(next) => {
                    if (!next) return;
                    setBranchId(next);
                  }}
                  allowClear={false}
                  placeholder="Search branches…"
                  ariaLabel="Payroll postings branch"
                  emptyLabel="No branch matches this search."
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="payroll-postings-from">
                  From (AD)
                </label>
                <input
                  id="payroll-postings-from"
                  type="date"
                  className={inputClass}
                  value={fromDate}
                  max={toDate || undefined}
                  onChange={(event) => setFromDate(event.target.value)}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="payroll-postings-to">
                  To (AD)
                </label>
                <input
                  id="payroll-postings-to"
                  type="date"
                  className={inputClass}
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(event) => setToDate(event.target.value)}
                />
              </div>
            </>
          }
        />
      </section>

      {error && (
        <div className={errorBox} role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <section className={panel}>
        {loading && rows.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-slate-400">Loading payroll postings…</p>
        ) : rows.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-slate-400">
            {filterActive
              ? 'No posted payroll run matches these filters.'
              : 'No payroll run has been posted in this branch yet.'}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1240px] text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-2 py-1.5">Run date</th>
                    <th className="px-2 py-1.5">Run / branch</th>
                    <th className="px-2 py-1.5">Period</th>
                    <th className="px-2 py-1.5">Status</th>
                    <th className="px-2 py-1.5 text-right">Employees</th>
                    <th className="px-2 py-1.5 text-right">Gross</th>
                    <th className="px-2 py-1.5 text-right">Incentive</th>
                    <th className="px-2 py-1.5 text-right">Arrears</th>
                    <th className="px-2 py-1.5 text-right">TDS</th>
                    <th className="px-2 py-1.5 text-right">SSF</th>
                    <th className="px-2 py-1.5 text-right">Advances</th>
                    <th className="px-2 py-1.5 text-right">Loans</th>
                    <th className="px-2 py-1.5 text-right">Net pay</th>
                    <th className="px-2 py-1.5">Posting journal</th>
                    <th className="px-2 py-1.5">Payment journal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {pagination.pagedItems.map((row) => (
                    <tr key={row.id}>
                      <td className="whitespace-nowrap px-2 py-2 text-slate-500">
                        <span className="block font-medium text-slate-700 dark:text-slate-200">
                          {row.runDateAD}
                        </span>
                        {row.runDateBS && <span className="block text-[10px]">{row.runDateBS} BS</span>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">
                        <span className="block font-mono font-semibold text-slate-700 dark:text-slate-200">
                          {row.runNo}
                        </span>
                        <span className="block text-[10px] text-slate-400">
                          {row.branchName || row.branchId}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono text-slate-500">
                        {row.periodKey}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusBadgeClass(row.status)}`}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-slate-500">
                        {row.employeeCount}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                        {amount(row.grossTotal)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                        {amount(row.incentiveTotal)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                        {amount(row.arrearsTotal)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                        {amount(row.tdsTotal)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                        {amount(row.ssfTotal)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                        {amount(row.advanceTotal)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                        {amount(row.loanTotal)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                        {amount(row.netTotal)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-slate-500">
                        <span className="block font-mono font-semibold text-slate-700 dark:text-slate-200">
                          {row.journalNo || '—'}
                        </span>
                        <span className="block text-[10px]">
                          {row.journalDateAD || '—'} · {amount(row.journalDebit)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-slate-500">
                        <span className="block font-mono font-semibold text-slate-700 dark:text-slate-200">
                          {row.paymentJournalNo || '—'}
                        </span>
                        <span className="block text-[10px]">
                          {row.paidDateAD || '—'}
                          {row.paymentMethod ? ` · ${row.paymentMethod}` : ''} ·{' '}
                          {amount(row.paymentDebit)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePagination
              page={pagination.page}
              pageCount={pagination.pageCount}
              totalItems={pagination.totalItems}
              rangeStart={pagination.rangeStart}
              rangeEnd={pagination.rangeEnd}
              pageSize={pagination.pageSize}
              onPageChange={pagination.setPage}
              onPageSizeChange={pagination.setPageSize}
            />
          </>
        )}
      </section>
    </div>
  );
};

export default PayrollPostingsRegister;
