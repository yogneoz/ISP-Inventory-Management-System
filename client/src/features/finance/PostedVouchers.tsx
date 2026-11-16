/**
 * Posted Vouchers register.
 *
 * The journal and cash/bank entry forms used to embed this list below their
 * posting forms. It is a read register, not part of the form, so it now owns a
 * screen: branch/date/search scope, paging, voucher detail and the contra-entry
 * reversal action. The entry screens post; this screen reviews and reverses.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ClipboardList,
  Eye,
  Loader2,
  RefreshCw,
  Search,
  Undo2,
  X,
} from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { SearchSelect, type SearchSelectOption } from '../../components/common/SearchSelect';
import {
  VoucherDetailDialog,
  journalStatus,
  sourceLabel,
  statusBadgeClass,
} from '../../components/accounting/VoucherDetailDialog';
import { btnGhost, btnPrimary, inputClass, labelClass } from '../../components/common/styleConstants';
import { api } from '../../services/api';
import { KeysetLoadMore } from '../../components/common/KeysetLoadMore';
import { useKeysetPager } from '../../hooks/useKeysetPager';
import type { AccountingJournal } from '../../services/api/accounting';
import type { Branch, User } from '../../types';
import { localTodayAD } from '../../utils/localDate';
import { formatMoney } from '../../utils/nprFormat';
import {
  getScopedBranches,
  hasGlobalBranchScope,
  isOperationAllowed,
} from '../../utils/permissions';

export interface PostedVouchersProps {
  branches: Branch[];
  currentUser?: User | null;
  /** App's transactionLog register counter: journal-writing mutations bump it. */
  sseRefreshKey?: number;
}

/** Voucher families the manual entry screens own and may reverse here. */
const REVERSIBLE_SOURCES = new Set(['MANUAL', 'CASH_RECEIPT', 'CASH_PAYMENT', 'CASH_BANK']);
const panel =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const errorBox =
  'flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';

export const PostedVouchers: React.FC<PostedVouchersProps> = ({
  branches,
  currentUser,
  sseRefreshKey = 0,
}) => {
  const allowed = isOperationAllowed('gl-view', currentUser?.role);
  const canReverse = isOperationAllowed('gl-reverse', currentUser?.role);
  const canSeeAll = hasGlobalBranchScope(currentUser);
  const scopedBranches = useMemo(
    () => getScopedBranches(currentUser, branches).filter((branch) => branch.active),
    [branches, currentUser]
  );

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
    if (canSeeAll) return scopedBranches[0]?.id || 'ALL';
    if (currentUser?.branchId && currentUser.branchId !== 'ALL') return currentUser.branchId;
    return scopedBranches[0]?.id || '';
  };

  const [branchId, setBranchId] = useState(initialBranch);
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [reversalTarget, setReversalTarget] = useState<AccountingJournal | null>(null);
  const [reversalDate, setReversalDate] = useState(localTodayAD());
  const [reversalReason, setReversalReason] = useState('');
  const [reversalError, setReversalError] = useState('');
  const [reversing, setReversing] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (branchId && branchOptions.some((option) => option.value === branchId)) return;
    setBranchId(branchOptions[0]?.value || '');
  }, [branchId, branchOptions]);

  const fetchJournalsPage = useCallback(async (cursor: string | null) => {
    const result = await api.getAccountingJournals({
      branchId: branchId === 'ALL' ? undefined : branchId,
      from: fromDate || undefined,
      to: toDate || undefined,
      query: searchTerm || undefined,
      cursor,
      limit: 25,
    });
    return {
      items: result.items || result.data || [],
      nextCursor: result.nextCursor ?? null,
      hasMore: Boolean(result.hasMore),
    };
  }, [branchId, fromDate, searchTerm, toDate]);

  const journalPager = useKeysetPager({
    fetchPage: fetchJournalsPage,
    resetKey: [branchId, fromDate, toDate, searchTerm, sseRefreshKey].join('\u0000'),
    enabled: allowed && Boolean(branchId),
  });
  const rows = journalPager.rows;
  const loading = journalPager.loading;
  const error = journalPager.error;

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const term = searchInput.trim();
    setSearchTerm(term);
    if (term === searchTerm) journalPager.reload();
  };

  const clearFilters = () => {
    setSearchInput('');
    setSearchTerm('');
    setFromDate('');
    setToDate('');
  };

  const openReversal = (journal: AccountingJournal) => {
    setReversalTarget(journal);
    setReversalDate(localTodayAD());
    setReversalReason('');
    setReversalError('');
    setNotice('');
  };

  const submitReversal = async () => {
    if (!reversalTarget) return;
    if (!canReverse) {
      setReversalError('You do not have permission to reverse vouchers.');
      return;
    }
    if (!reversalDate) {
      setReversalError('Choose the reversal date.');
      return;
    }
    if (!reversalReason.trim()) {
      setReversalError('Enter the reason for reversing this voucher.');
      return;
    }
    setReversing(true);
    setReversalError('');
    try {
      const reversal = await api.reverseAccountingJournal(reversalTarget.id, {
        journalDateAD: reversalDate,
        reason: reversalReason.trim(),
      });
      setNotice(`${reversalTarget.journalNo} reversed by ${reversal.journalNo}.`);
      setReversalTarget(null);
      journalPager.reload();
    } catch (err: any) {
      setReversalError(err?.message || 'The voucher could not be reversed.');
    } finally {
      setReversing(false);
    }
  };

  if (!allowed) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Posted Vouchers"
          description="Review posted journals and cash/bank vouchers."
          icon={<ClipboardList className="h-5 w-5 text-indigo-500" />}
        />
        <div className={errorBox}>
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>You do not have permission to view accounting ledgers.</span>
        </div>
      </div>
    );
  }

  const filterActive = Boolean(searchTerm || searchInput || fromDate || toDate);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Posted Vouchers"
        description="Review posted journals and cash/bank vouchers, open their lines, and reverse an eligible manual voucher with a contra entry."
        icon={<ClipboardList className="h-5 w-5 text-indigo-500" />}
        actions={
          <button type="button" onClick={journalPager.reload} disabled={loading} className={btnGhost}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        }
      />

      {error && (
        <div className={errorBox} role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300"
        >
          <span>{notice}</span>
        </div>
      )}

      <section className={panel}>
        <form onSubmit={submitSearch} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
                ariaLabel="Posted voucher branch"
                emptyLabel="No branch matches this search."
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="posted-vouchers-from">From (AD)</label>
              <input
                id="posted-vouchers-from"
                type="date"
                className={inputClass}
                value={fromDate}
                max={toDate || undefined}
                onChange={(event) => {
                  setFromDate(event.target.value);
                }}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="posted-vouchers-to">To (AD)</label>
              <input
                id="posted-vouchers-to"
                type="date"
                className={inputClass}
                value={toDate}
                min={fromDate || undefined}
                onChange={(event) => {
                  setToDate(event.target.value);
                }}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="posted-vouchers-search">Search</label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  id="posted-vouchers-search"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Voucher no., remarks or source reference"
                  className={`${inputClass} pl-8`}
                />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-slate-400">
              {rows.length} voucher{rows.length === 1 ? '' : 's'} loaded
            </span>
            <div className="flex gap-2">
              {filterActive && (
                <button type="button" className={btnGhost} onClick={clearFilters} disabled={loading}>
                  <X className="h-4 w-4" /> Clear filters
                </button>
              )}
              <button type="submit" className={btnPrimary} disabled={loading}>
                <Search className="h-4 w-4" /> Search
              </button>
            </div>
          </div>
        </form>
      </section>

      <section className={panel}>
        {loading && rows.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-slate-400">Loading vouchers…</p>
        ) : rows.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-slate-400">
            {filterActive
              ? 'No voucher matches these filters.'
              : 'No vouchers posted in this branch yet.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-2 py-1.5">Date</th>
                  <th className="px-2 py-1.5">Voucher No.</th>
                  <th className="px-2 py-1.5">Type</th>
                  <th className="px-2 py-1.5">Remarks</th>
                  <th className="px-2 py-1.5 text-right">Debit</th>
                  <th className="px-2 py-1.5 text-right">Credit</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((journal) => {
                  const reversalNo = journal.reversalJournalNo;
                  const status = journalStatus(journal);
                  const eligible =
                    canReverse &&
                    !journal.reversalOfId &&
                    !reversalNo &&
                    journal.status === 'POSTED' &&
                    REVERSIBLE_SOURCES.has(journal.sourceType);
                  return (
                    <tr key={journal.id}>
                      <td className="whitespace-nowrap px-2 py-2 text-slate-500">{journal.journalDateAD}</td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono font-semibold text-slate-700 dark:text-slate-200">
                        {journal.journalNo}
                        {journal.reversalOfNo && (
                          <span className="block font-sans text-[10px] font-normal text-slate-400">
                            of {journal.reversalOfNo}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-slate-500">{sourceLabel(journal.sourceType)}</td>
                      <td className="max-w-[240px] truncate px-2 py-2 text-slate-500" title={journal.memo || ''}>
                        {journal.memo || '—'}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                        {formatMoney(journal.totalDebit)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                        {formatMoney(journal.totalCredit)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusBadgeClass(status)}`}
                          title={reversalNo ? `Reversed by ${reversalNo}` : undefined}
                        >
                          {status}
                        </span>
                        {reversalNo && (
                          <span className="mt-0.5 block font-mono text-[10px] text-slate-400">{reversalNo}</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right">
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setDetailId(journal.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                            title="View voucher lines and any linked reversal"
                          >
                            <Eye className="h-3.5 w-3.5" /> View
                          </button>
                          {canReverse && (
                            <button
                              type="button"
                              onClick={() => openReversal(journal)}
                              disabled={!eligible}
                              className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300 dark:border-rose-500/30 dark:text-rose-300 dark:hover:bg-rose-950/30 dark:disabled:border-slate-800 dark:disabled:text-slate-600"
                              title={
                                eligible
                                  ? 'Reverse this voucher with a contra entry'
                                  : 'This voucher is not eligible for reversal'
                              }
                            >
                              <Undo2 className="h-3.5 w-3.5" /> Reverse
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <KeysetLoadMore
          loaded={rows.length}
          hasMore={journalPager.hasMore}
          loadingMore={journalPager.loadingMore}
          onLoadMore={journalPager.loadMore}
          scopeError={journalPager.scopeError ? journalPager.error : ''}
          className="mt-3"
        />
      </section>

      {detailId && <VoucherDetailDialog journalId={detailId} onClose={() => setDetailId(null)} />}

      {reversalTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Reverse voucher</h3>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  {reversalTarget.journalNo} · {formatMoney(reversalTarget.totalDebit)} ·{' '}
                  {reversalTarget.journalDateAD}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReversalTarget(null)}
                disabled={reversing}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40 dark:hover:bg-slate-800"
                aria-label="Close reversal dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              A contra voucher will be posted for the same amount with debits and credits swapped. The original
              stays posted and auditable; this action cannot be undone.
            </p>
            <label className={labelClass} htmlFor="posted-vouchers-reversal-date">
              Reversal date
            </label>
            <input
              id="posted-vouchers-reversal-date"
              type="date"
              value={reversalDate}
              onChange={(event) => setReversalDate(event.target.value)}
              className={inputClass}
            />
            <label className={`${labelClass} mt-3`} htmlFor="posted-vouchers-reversal-reason">
              Reason
            </label>
            <textarea
              id="posted-vouchers-reversal-reason"
              value={reversalReason}
              onChange={(event) => setReversalReason(event.target.value)}
              className={`${inputClass} min-h-[80px]`}
              placeholder="Why is this voucher being reversed?"
            />
            {reversalError && <div className={`${errorBox} mt-3`}>{reversalError}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className={btnGhost}
                onClick={() => setReversalTarget(null)}
                disabled={reversing}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitReversal()}
                disabled={reversing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
              >
                {reversing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
                {reversing ? 'Reversing…' : 'Post reversal'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
