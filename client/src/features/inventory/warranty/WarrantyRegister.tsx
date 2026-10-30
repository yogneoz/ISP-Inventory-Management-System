/**
 * WTY-6: the shared body of the Suppliers Warranty and Sellers Warranty
 * registers.
 *
 * One coverage table has two contractual sides, so the two screens share the
 * fetch, the KPI population, paging and the correction dialog, and differ only
 * in wording, columns and the category/type filter. Both read the server's
 * stored expiry and computed state — nothing here re-derives a warranty end
 * date from a term, which is what made the retired directory disagree with its
 * own filter.
 *
 * Default status is ALL. The old screen defaulted to VALID, which presented an
 * empty table as if no unit carried a warranty.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Edit2,
  ShieldAlert,
  ShieldCheck,
  Timer,
  Undo2,
} from 'lucide-react';
import type { User, WarrantyCoverageRow } from '../../../types';
import { api } from '../../../services/api';
import { formatDualDate } from '../../../utils/nepaliCalendar';
import { isOperationAllowed } from '../../../utils/permissions';
import { useFilterPageReset } from '../../../utils/useFilterPageReset';
import { useServerPageClamp, TablePagination } from '../../../components/common/TablePagination';
import { FilterCard } from '../../../components/common/FilterCard';
import { LoadStateNotice } from '../../../components/common/LoadStateNotice';
import { PageHeader } from '../../../components/common/PageHeader';
import { DateField } from '../../../components/DateField';
import { WarrantyEditModal } from './WarrantyEditModal';

export type WarrantyCoverageSide = 'VENDOR' | 'SELLER';

interface WarrantyRegisterProps {
  coverageType: WarrantyCoverageSide;
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  currentUser?: User | null;
  /** The paged-register refresh counter (CUSTOMER_DEVICES / ASSETS / capture events). */
  refreshKey?: number;
}

const EMPTY_COUNTS = { total: 0, valid: 0, expiring: 0, expired: 0 };

const STATUS_OPTIONS = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'VALID', label: 'Valid' },
  { value: 'EXPIRING_SOON', label: 'Expiring within 30 days' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'RETURNED', label: 'Returned (retired)' },
];

const SOURCE_LABELS: Record<string, string> = {
  PURCHASE_INVOICE: 'Purchase invoice',
  FIXED_ASSET: 'Fixed asset',
  CUSTOMER_ASSIGNMENT: 'Asset assignment',
  CUSTOMER_DEVICE: 'Device issue',
  CUSTOMER_EXCHANGE: 'Device exchange',
  SALES_INVOICE: 'Sales invoice',
  SALES_RETURN: 'Sales return',
};

function sourceLabel(row: WarrantyCoverageRow): string {
  return SOURCE_LABELS[String(row.sourceType || '').toUpperCase()] || row.sourceType || '—';
}

const RETIRED_REASON_LABELS: Record<string, string> = {
  SALES_RETURN: 'Returned by customer',
  PURCHASE_RETURN: 'Returned to supplier',
};

function stateLabel(row: WarrantyCoverageRow): string {
  if (row.warrantyState === 'RETURNED') {
    const reason = RETIRED_REASON_LABELS[String(row.retiredReason || '').toUpperCase()] || 'Retired';
    return row.retiredRef ? `${reason} · ${row.retiredRef}` : reason;
  }
  const days = Number.isFinite(row.daysRemaining) ? row.daysRemaining : 0;
  if (row.warrantyState === 'EXPIRED') {
    const late = Math.max(0, -days);
    return `Expired (${late} ${late === 1 ? 'day' : 'days'} ago)`;
  }
  const left = Math.max(0, days);
  return row.warrantyState === 'EXPIRING_SOON'
    ? `Expiring (${left} ${left === 1 ? 'day' : 'days'} left)`
    : `Valid (${left} ${left === 1 ? 'day' : 'days'} left)`;
}

const STATE_PILL: Record<WarrantyCoverageRow['warrantyState'], string> = {
  VALID:
    'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800',
  EXPIRING_SOON:
    'bg-amber-50 dark:bg-amber-950/50 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-800',
  EXPIRED:
    'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-800',
  RETURNED:
    'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700',
};

function stateIcon(state: WarrantyCoverageRow['warrantyState']) {
  if (state === 'VALID') return <ShieldCheck className="h-3.5 w-3.5 shrink-0" />;
  if (state === 'EXPIRING_SOON') return <Timer className="h-3.5 w-3.5 shrink-0" />;
  if (state === 'RETURNED') return <Undo2 className="h-3.5 w-3.5 shrink-0" />;
  return <ShieldAlert className="h-3.5 w-3.5 shrink-0" />;
}

export const WarrantyRegister: React.FC<WarrantyRegisterProps> = ({
  coverageType,
  selectedBranchId,
  dateMode,
  currentUser,
  refreshKey = 0,
}) => {
  const isVendor = coverageType === 'VENDOR';
  const canEdit = isOperationAllowed('warranty-edit', currentUser?.role);

  const [searchQuery, setSearchQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const [category, setCategory] = useState('ALL');
  const [startFrom, setStartFrom] = useState('');
  const [startTo, setStartTo] = useState('');

  const [rows, setRows] = useState<WarrantyCoverageRow[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [editing, setEditing] = useState<WarrantyCoverageRow | null>(null);

  useFilterPageReset(
    `${coverageType}|${selectedBranchId}|${searchQuery}|${status}|${category}|${startFrom}|${startTo}`,
    page,
    setPage
  );

  const safePage = useServerPageClamp(page, pageSize, totalItems, setPage);
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const rangeStart = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const rangeEnd = Math.min(safePage * pageSize, totalItems);

  const categoryOptions = useMemo(
    () =>
      isVendor
        ? [
            { value: 'ALL', label: 'All categories' },
            { value: 'CPE', label: 'Customer CPE' },
            { value: 'FIXED_ASSET', label: 'Fixed asset' },
          ]
        : [
            { value: 'ALL', label: 'All types' },
            { value: 'CPE', label: 'Rental CPE' },
            { value: 'SOLD_PRODUCT', label: 'Sold product' },
          ],
    [isVendor]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const fetchPage = isVendor ? api.fetchVendorWarranties : api.fetchSellerWarranties;
    fetchPage(
      {
        branchId: selectedBranchId,
        query: searchQuery || undefined,
        status: status !== 'ALL' ? status : undefined,
        category: category !== 'ALL' ? category : undefined,
        startFrom: startFrom || undefined,
        startTo: startTo || undefined,
      },
      page,
      pageSize
    )
      .then((result) => {
        if (cancelled) return;
        setRows(Array.isArray(result?.data) ? result.data : []);
        setTotalItems(Number(result?.totalItems) || 0);
        setCounts(result?.counts || EMPTY_COUNTS);
        setLoadError('');
      })
      .catch((err: any) => {
        if (!cancelled) {
          setLoadError(err?.message || 'The warranty register could not be read.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    coverageType,
    isVendor,
    selectedBranchId,
    searchQuery,
    status,
    category,
    startFrom,
    startTo,
    page,
    pageSize,
    refreshKey,
    retryKey,
  ]);

  const filtersActive =
    Boolean(searchQuery) ||
    status !== 'ALL' ||
    category !== 'ALL' ||
    Boolean(startFrom) ||
    Boolean(startTo);

  const appliedFilters = [
    `Search: ${searchQuery || 'none'}`,
    `Status: ${STATUS_OPTIONS.find((option) => option.value === status)?.label || status}`,
    `${isVendor ? 'Category' : 'Type'}: ${
      categoryOptions.find((option) => option.value === category)?.label || category
    }`,
    `Start: ${startFrom || 'any'}${startTo ? ` → ${startTo}` : ''}`,
  ].join(' · ');

  const retry = () => setRetryKey((key) => key + 1);
  const closeEdit = () => setEditing(null);
  const afterSaved = () => {
    setEditing(null);
    retry();
  };

  // The coverage row stores one canonical start (the invoice, acquisition or
  // issue/sale date it was captured against), so the seller side shows that
  // one date rather than a duplicated "issue date" column.
  const columns = isVendor
    ? ['Product & Category', 'Serial / Tag', 'Supplier', 'Source', 'Start', 'Warranty Expiry', 'Status', 'Branch']
    : ['Customer', 'Product', 'Serial', 'Source', 'Start (issue / sale)', 'Warranty Expiry', 'Status', 'Branch'];
  const columnCount = columns.length + 1;

  return (
    <div className="space-y-3">
      <PageHeader
        title={isVendor ? 'Suppliers Warranty' : 'Sellers Warranty'}
        description={
          isVendor
            ? 'Coverage our suppliers owe on every purchased serial and fixed asset, captured with the purchase invoice or asset and corrected only by audited supersede.'
            : 'The warranty promise we make to each customer or assignee on every device issued, sold or exchanged — and its exact expiry date.'
        }
        icon={
          isVendor ? (
            <ShieldCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          ) : (
            <ShieldAlert className="h-5 w-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
          )
        }
      />

      {loadError && (
        <LoadStateNotice
          subject={isVendor ? 'the suppliers warranty register' : 'the sellers warranty register'}
          loading={loading}
          error={loadError}
          hasCachedRows={rows.length > 0}
          cachedNote=" The rows on screen may be out of date."
          onRetry={retry}
        />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="rounded-2xl p-4 border shadow-xs bg-white border-slate-200 text-slate-900 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100">
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 break-words">
            {isVendor ? 'Covered units' : 'Issued units'}
          </div>
          <div className="text-xl font-mono font-bold text-slate-900 dark:text-white mt-1">
            {counts.total.toLocaleString('en-IN')}
          </div>
          <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">Whole filtered population</div>
        </div>

        <div className="rounded-2xl p-4 border shadow-xs bg-emerald-50/50 border-emerald-200 dark:bg-slate-900 dark:border-slate-800">
          <div className="text-xs font-bold text-emerald-800 dark:text-emerald-400 break-words flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            <span>Valid</span>
          </div>
          <div className="text-xl font-mono font-extrabold text-emerald-700 dark:text-emerald-400 mt-1">
            {counts.valid.toLocaleString('en-IN')}
          </div>
        </div>

        <div className="rounded-2xl p-4 border shadow-xs bg-amber-50/50 border-amber-200 dark:bg-slate-900 dark:border-slate-800">
          <div className="text-xs font-bold text-amber-800 dark:text-amber-400 break-words flex items-center gap-1.5">
            <Timer className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <span>Expiring ≤ 30 days</span>
          </div>
          <div className="text-xl font-mono font-extrabold text-amber-700 dark:text-amber-400 mt-1">
            {counts.expiring.toLocaleString('en-IN')}
          </div>
        </div>

        <div className="rounded-2xl p-4 border shadow-xs bg-rose-50/50 border-rose-200 dark:bg-slate-900 dark:border-slate-800">
          <div className="text-xs font-bold text-rose-800 dark:text-rose-400 break-words flex items-center gap-1.5">
            <ShieldAlert className="h-4 w-4 text-rose-600 dark:text-rose-400" />
            <span>Expired</span>
          </div>
          <div className="text-xl font-mono font-extrabold text-rose-700 dark:text-rose-400 mt-1">
            {counts.expired.toLocaleString('en-IN')}
          </div>
        </div>
      </div>

      <FilterCard
        searchPlaceholder={
          isVendor
            ? 'Search serial, product, supplier or source document…'
            : 'Search customer, serial, product or source document…'
        }
        searchValue={searchQuery}
        onSearchApply={setSearchQuery}
        hasActiveFilters={filtersActive}
        onClearAll={() => {
          setSearchQuery('');
          setStatus('ALL');
          setCategory('ALL');
          setStartFrom('');
          setStartTo('');
        }}
        filterChildren={
          <>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Status
              </label>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                aria-label="Warranty status"
                className="w-48 rounded-xl border px-3 py-2 text-xs font-semibold focus:outline-none cursor-pointer border-slate-300 bg-white text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                {isVendor ? 'Category' : 'Type'}
              </label>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                aria-label={isVendor ? 'Warranty category' : 'Warranty type'}
                className="w-44 rounded-xl border px-3 py-2 text-xs font-semibold focus:outline-none cursor-pointer border-slate-300 bg-white text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
              >
                {categoryOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            {/* The two ends of the coverage-start range are ONE filter: wrap
                them as a single unit so a narrow card cannot push “Start to”
                onto another row away from “Start from” (UIX-11). */}
            <div
              role="group"
              aria-label="Warranty start date range"
              className="flex items-end gap-2"
            >
              <div>
                <label
                  htmlFor="warranty-filter-from"
                  className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1"
                >
                  Start from
                </label>
                <div className="w-40">
                  <DateField
                    id="warranty-filter-from"
                    mode={dateMode}
                    value={startFrom}
                    onChange={setStartFrom}
                    compact
                    showHint={false}
                    max={startTo || undefined}
                  />
                </div>
              </div>
              <div>
                <label
                  htmlFor="warranty-filter-to"
                  className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1"
                >
                  Start to
                </label>
                <div className="w-40">
                  <DateField
                    id="warranty-filter-to"
                    mode={dateMode}
                    value={startTo}
                    onChange={setStartTo}
                    compact
                    showHint={false}
                    min={startFrom || undefined}
                  />
                </div>
              </div>
            </div>
          </>
        }
        rightChildren={
          <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
            <strong className="text-slate-900 dark:text-white font-mono">{totalItems}</strong> of{' '}
            <strong className="text-slate-900 dark:text-white font-mono">{counts.total}</strong> coverage
            records
          </span>
        }
      />

      <div className="rounded-2xl border shadow-xs overflow-hidden bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-100/90 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 font-bold text-[10px] tracking-wider border-b border-slate-200 dark:border-slate-700">
              <tr>
                {columns.map((column) => (
                  <th key={column} className="px-2.5 py-1.5 break-words">
                    {column}
                  </th>
                ))}
                <th className="px-2.5 py-1.5 text-center">Edit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={columnCount} className="p-8 text-center text-slate-500 dark:text-slate-400 text-xs">
                    {loading ? (
                      <span>Loading {isVendor ? 'supplier' : 'seller'} warranty coverage…</span>
                    ) : filtersActive ? (
                      <div className="space-y-1">
                        <div className="font-bold text-slate-700 dark:text-slate-200">
                          No coverage matches the applied filters.
                        </div>
                        <div className="text-[11px]">{appliedFilters}</div>
                        <div className="text-[11px] text-slate-400">Clear some filters to widen the register.</div>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="font-bold text-slate-700 dark:text-slate-200">
                          {isVendor
                            ? 'No supplier warranty coverage has been captured yet.'
                            : 'No seller warranty coverage has been captured yet.'}
                        </div>
                        <div className="text-[11px]">
                          {isVendor
                            ? 'Coverage is captured automatically when a purchase invoice line or a fixed asset is received with its warranty switch on.'
                            : 'Coverage is captured when a device is assigned, sold or exchanged with its warranty switch on. Units left uncovered have no row.'}
                        </div>
                        <div className="text-[11px] text-slate-400">{appliedFilters}</div>
                      </div>
                    )}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr
                    key={row.id}
                    className="hover:bg-slate-100/80 dark:hover:bg-slate-800/50 transition-colors"
                  >
                    {isVendor ? (
                      <>
                        <td className="p-2.5">
                          <div className="font-bold text-slate-900 dark:text-slate-100 text-sm break-words leading-snug">
                            {row.productName || '—'}
                          </div>
                          <span
                            className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-md mt-1 ${
                              row.itemCategory === 'FIXED_ASSET'
                                ? 'bg-purple-50 dark:bg-purple-950/50 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                                : 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800'
                            }`}
                          >
                            {row.itemCategory === 'FIXED_ASSET' ? 'Fixed asset' : 'Customer CPE'}
                          </span>
                        </td>
                        <td className="p-2.5 font-mono font-bold text-slate-800 dark:text-slate-200">
                          {row.serialNumber || '—'}
                        </td>
                        <td className="p-2.5 font-semibold text-slate-800 dark:text-slate-200 break-words">
                          {row.partyName || '—'}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="p-2.5 font-semibold text-slate-800 dark:text-slate-200 break-words">
                          {row.partyName || '—'}
                        </td>
                        <td className="p-2.5">
                          <div className="font-bold text-slate-900 dark:text-slate-100 text-sm break-words leading-snug">
                            {row.productName || '—'}
                          </div>
                          <span
                            className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-md mt-1 ${
                              row.itemCategory === 'SOLD_PRODUCT'
                                ? 'bg-teal-50 dark:bg-teal-950/50 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-800'
                                : 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800'
                            }`}
                          >
                            {row.itemCategory === 'SOLD_PRODUCT' ? 'Sold product' : 'Rental CPE'}
                          </span>
                        </td>
                        <td className="p-2.5 font-mono font-bold text-slate-800 dark:text-slate-200">
                          {row.serialNumber || '—'}
                        </td>
                      </>
                    )}

                    <td className="p-2.5 text-slate-600 dark:text-slate-400 break-words">
                      <div className="font-semibold">{sourceLabel(row)}</div>
                      {row.sourceNumber && (
                        <div className="text-[10px] font-mono text-slate-400">{row.sourceNumber}</div>
                      )}
                    </td>

                    <td className="p-2.5 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                      {formatDualDate(row.startDateAD, dateMode)}
                    </td>

                    <td className="p-2.5 font-mono text-[11px] font-bold text-slate-900 dark:text-slate-100">
                      {formatDualDate(row.endDateAD, dateMode)}
                    </td>

                    <td className="p-2.5">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase border whitespace-normal break-words max-w-[170px] ${
                          STATE_PILL[row.warrantyState]
                        }`}
                      >
                        {stateIcon(row.warrantyState)}
                        <span>{stateLabel(row)}</span>
                      </span>
                    </td>

                    <td className="p-2.5 font-bold text-slate-800 dark:text-slate-200 break-words">
                      {row.branchName || row.branchId || '—'}
                    </td>

                    <td className="p-2.5 text-center">
                      {canEdit && row.warrantyState !== 'RETURNED' ? (
                        <button
                          type="button"
                          onClick={() => setEditing(row)}
                          title="Correct warranty dates"
                          aria-label={`Correct warranty dates for ${row.serialNumber}`}
                          className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-200 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded transition-colors cursor-pointer"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <span className="text-[10px] text-slate-400 italic">Read only</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
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
          className="mt-1"
        />
      </div>

      {editing && (
        <WarrantyEditModal
          key={editing.id}
          row={editing}
          dateMode={dateMode}
          onClose={closeEdit}
          onSaved={afterSaved}
        />
      )}
    </div>
  );
};
