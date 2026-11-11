/**
 * Warranty recovery follow-up.
 *
 * Read-only view inside the existing warranty register. It surfaces the claims
 * with an RMA or vendor money in flight, buckets outstanding RMAs by age and
 * reconciles the credits claimed as received to the AP debits actually posted.
 * Every number comes from the recovery endpoint; this panel never derives or
 * writes claim/stock/ledger state itself.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  HandCoins,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import type {
  WarrantyRecoveryAging,
  WarrantyRecoveryPage,
  WarrantyRecoveryRow,
  WarrantyRecoveryState,
  WarrantyRecoverySummary,
  WarrantyRecoveryVendor,
} from '../../../types';
import { api } from '../../../services/api';
import { formatDualDate } from '../../../utils/nepaliCalendar';
import { formatMoney } from '../../../utils/nprFormat';
import { FilterCard } from '../../../components/common/FilterCard';
import { LoadStateNotice } from '../../../components/common/LoadStateNotice';
import { TablePagination, useServerPageClamp } from '../../../components/common/TablePagination';
import { WARRANTY_RECOVERY_STATE_LABELS } from '../../../../../shared/warrantyRecovery';

interface WarrantyRecoveryPanelProps {
  coverageType: 'VENDOR' | 'SELLER';
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  refreshKey?: number;
}

const EMPTY_SUMMARY: WarrantyRecoverySummary = {
  claims: 0,
  openClaims: 0,
  outstandingRmas: 0,
  expectedCredit: 0,
  receivedCredit: 0,
  postedCredit: 0,
  shortfall: 0,
  shortfallClaims: 0,
  postingExceptions: 0,
  reconciled: true,
};

const EMPTY_AGING: WarrantyRecoveryAging[] = [
  { bucket: '0-7', label: '0–7 days', claims: 0, expectedCredit: 0, receivedCredit: 0, shortfall: 0 },
  { bucket: '8-14', label: '8–14 days', claims: 0, expectedCredit: 0, receivedCredit: 0, shortfall: 0 },
  { bucket: '15-30', label: '15–30 days', claims: 0, expectedCredit: 0, receivedCredit: 0, shortfall: 0 },
  { bucket: '31+', label: '31+ days', claims: 0, expectedCredit: 0, receivedCredit: 0, shortfall: 0 },
];

const STATE_TONE: Record<WarrantyRecoveryState, string> = {
  NONE: 'border-slate-300 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
  PENDING: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  PARTIAL: 'border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-300',
  POSTING_MISMATCH: 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
  RECONCILED: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
};

export const WarrantyRecoveryPanel: React.FC<WarrantyRecoveryPanelProps> = ({
  coverageType,
  selectedBranchId,
  dateMode,
  refreshKey = 0,
}) => {
  const [rows, setRows] = useState<WarrantyRecoveryRow[]>([]);
  const [summary, setSummary] = useState<WarrantyRecoverySummary>(EMPTY_SUMMARY);
  const [aging, setAging] = useState<WarrantyRecoveryAging[]>(EMPTY_AGING);
  const [vendors, setVendors] = useState<WarrantyRecoveryVendor[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [query, setQuery] = useState('');
  const [onlyShortfall, setOnlyShortfall] = useState(false);
  const [outstandingRma, setOutstandingRma] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadKey, setLoadKey] = useState(0);

  const safePage = useServerPageClamp(page, pageSize, totalItems, setPage);
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const rangeStart = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const rangeEnd = Math.min(safePage * pageSize, totalItems);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .fetchWarrantyRecovery(
        {
          branchId: selectedBranchId,
          coverageType,
          query: query || undefined,
          onlyShortfall: onlyShortfall || undefined,
          outstandingRma: outstandingRma || undefined,
        },
        page,
        pageSize
      )
      .then((result: WarrantyRecoveryPage) => {
        if (cancelled) return;
        setRows(Array.isArray(result?.data) ? result.data : []);
        setSummary(result?.summary || EMPTY_SUMMARY);
        setAging(Array.isArray(result?.aging) ? result.aging : EMPTY_AGING);
        setVendors(Array.isArray(result?.vendors) ? result.vendors : []);
        setTotalItems(Number(result?.totalItems) || 0);
        setLoadError('');
      })
      .catch((error: any) => {
        if (!cancelled) setLoadError(error?.message || 'The warranty recovery view could not be read.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [coverageType, selectedBranchId, query, onlyShortfall, outstandingRma, page, pageSize, refreshKey, loadKey]);

  const agingRows = useMemo(
    () => (aging.length ? aging : EMPTY_AGING),
    [aging]
  );
  const filtersActive = Boolean(query) || onlyShortfall || outstandingRma;
  const reload = () => setLoadKey((key) => key + 1);

  const clearFilters = () => {
    setQuery('');
    setOnlyShortfall(false);
    setOutstandingRma(false);
    setPage(1);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {[
          ['Expected credit', summary.expectedCredit, 'text-slate-900 dark:text-white'],
          ['Received', summary.receivedCredit, 'text-sky-700 dark:text-sky-300'],
          ['AP credits posted', summary.postedCredit, 'text-indigo-700 dark:text-indigo-300'],
          ['Shortfall', summary.shortfall, summary.shortfall > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-300'],
          ['Outstanding RMAs', summary.outstandingRmas, 'text-amber-700 dark:text-amber-300'],
          ['Posting exceptions', summary.postingExceptions, summary.postingExceptions > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-300'],
        ].map(([label, value, tone]) => (
          <div key={String(label)} className="rounded-2xl border border-slate-200 bg-white p-3 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
            <div className={`mt-1 font-mono text-lg font-bold ${tone}`}>
              {label === 'Outstanding RMAs' || label === 'Posting exceptions'
                ? Number(value).toLocaleString('en-IN')
                : formatMoney(Number(value))}
            </div>
          </div>
        ))}
      </div>

      <div className={`flex flex-wrap items-center gap-2 rounded-xl border p-3 text-xs font-semibold ${
        summary.reconciled
          ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300'
          : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300'
      }`}>
        {summary.reconciled ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        <span>
          {summary.reconciled
            ? 'Recovery reconciles: every received vendor credit has a matching posted AP debit.'
            : `${summary.shortfallClaims} claim(s) still have a credit shortfall and ${summary.postingExceptions} received credit(s) do not match the posted AP debit.`}
        </span>
      </div>

      {loadError && (
        <LoadStateNotice
          subject="the warranty recovery view"
          loading={loading}
          error={loadError}
          hasCachedRows={rows.length > 0}
          cachedNote=" The recovery figures on screen may be out of date."
          onRetry={reload}
        />
      )}

      <FilterCard
        searchPlaceholder="Search claim, serial, customer, vendor or RMA reference…"
        searchValue={query}
        onSearchApply={(value) => { setQuery(value); setPage(1); }}
        hasActiveFilters={filtersActive}
        onClearAll={clearFilters}
        filterChildren={
          <>
            <label className="flex items-center gap-2 pb-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={onlyShortfall}
                onChange={(event) => { setOnlyShortfall(event.target.checked); setPage(1); }}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600"
              />
              Shortfall only
            </label>
            <label className="flex items-center gap-2 pb-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={outstandingRma}
                onChange={(event) => { setOutstandingRma(event.target.checked); setPage(1); }}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600"
              />
              Outstanding RMA only
            </label>
          </>
        }
        rightChildren={
          <>
            <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
              <strong className="font-mono text-slate-900 dark:text-white">{totalItems}</strong> recovery claims
            </span>
            <button
              type="button"
              onClick={reload}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
          </>
        }
      />

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,1fr)]">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
            <Clock3 className="h-4 w-4 text-amber-600" /> Outstanding RMA aging
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {agingRows.map((bucket) => (
              <div key={bucket.bucket} className={`rounded-xl border p-3 ${
                bucket.claims > 0 ? 'border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20' : 'border-slate-200 dark:border-slate-800'
              }`}>
                <div className="text-[10px] font-bold uppercase text-slate-500 dark:text-slate-400">{bucket.label}</div>
                <div className="mt-1 font-mono text-xl font-bold text-slate-900 dark:text-white">{bucket.claims}</div>
                <div className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                  Shortfall {formatMoney(bucket.shortfall)}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-600 dark:border-slate-800 dark:text-slate-300">
            <HandCoins className="h-4 w-4 text-indigo-600" /> Vendor recovery
          </div>
          <div className="max-h-56 overflow-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr><th className="px-3 py-1.5">Vendor</th><th className="px-2 py-1.5 text-right">Expected</th><th className="px-2 py-1.5 text-right">Shortfall</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {vendors.length === 0 ? (
                  <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-400">No vendor recovery rows.</td></tr>
                ) : vendors.map((vendor) => (
                  <tr key={vendor.vendorName}>
                    <td className="px-3 py-2">
                      <div className="font-semibold text-slate-800 dark:text-slate-200">{vendor.vendorName}</div>
                      <div className="text-[10px] text-slate-400">{vendor.claims} claim(s) · received {formatMoney(vendor.receivedCredit)}</div>
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-slate-700 dark:text-slate-300">{formatMoney(vendor.expectedCredit)}</td>
                    <td className={`px-2 py-2 text-right font-mono font-bold ${vendor.shortfall > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{formatMoney(vendor.shortfall)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
            <ShieldAlert className="h-4 w-4 text-indigo-600" /> Recovery queue
          </div>
          <div className="text-[10px] text-slate-500 dark:text-slate-400">
            Posted = AP debit on the linked `WARRANTY_RECOVERY` journal
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-100/90 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:bg-slate-800/80 dark:text-slate-300">
              <tr>
                <th className="px-2.5 py-2">Claim</th>
                <th className="px-2.5 py-2">Vendor / serial</th>
                <th className="px-2.5 py-2">Status</th>
                <th className="px-2.5 py-2">RMA age</th>
                <th className="px-2.5 py-2 text-right">Expected</th>
                <th className="px-2.5 py-2 text-right">Received</th>
                <th className="px-2.5 py-2 text-right">Posted</th>
                <th className="px-2.5 py-2 text-right">Shortfall</th>
                <th className="px-2.5 py-2">Recovery</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-slate-500 dark:text-slate-400">
                    {loading ? 'Loading warranty recovery…' : filtersActive ? 'No recovery claims match the applied filters.' : 'No RMAs or vendor credits are in flight for this warranty side.'}
                  </td>
                </tr>
              ) : rows.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-2.5 py-2">
                    <div className="font-mono text-[11px] font-bold text-slate-900 dark:text-white">{row.claimNo}</div>
                    <div className="text-[10px] text-slate-400">{formatDualDate(row.reportedDateAD, dateMode)}</div>
                  </td>
                  <td className="px-2.5 py-2">
                    <div className="font-semibold text-slate-800 dark:text-slate-200">{row.vendorName || 'Unassigned'}</div>
                    <div className="font-mono text-[10px] text-slate-400">{row.serialNumber}</div>
                  </td>
                  <td className="px-2.5 py-2 text-[11px] font-semibold text-slate-600 dark:text-slate-300">{row.status.replaceAll('_', ' ')}</td>
                  <td className="px-2.5 py-2 font-mono text-[11px] text-slate-600 dark:text-slate-300">
                    {row.rmaAgeDays === null ? '—' : `${row.rmaAgeDays}d`}
                  </td>
                  <td className="px-2.5 py-2 text-right font-mono text-[11px]">{formatMoney(row.expectedCredit)}</td>
                  <td className="px-2.5 py-2 text-right font-mono text-[11px]">{formatMoney(row.receivedCredit)}</td>
                  <td className="px-2.5 py-2 text-right font-mono text-[11px]">{formatMoney(row.postedCredit)}</td>
                  <td className={`px-2.5 py-2 text-right font-mono text-[11px] font-bold ${row.shortfall > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}>{formatMoney(row.shortfall)}</td>
                  <td className="px-2.5 py-2">
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${STATE_TONE[row.creditState]}`}>
                      {WARRANTY_RECOVERY_STATE_LABELS[row.creditState]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <TablePagination
          page={safePage}
          pageCount={pageCount}
          totalItems={totalItems}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>
    </div>
  );
};
