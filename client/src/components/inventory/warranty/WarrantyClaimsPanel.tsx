/**
 * Claims / RMA register and detail panel, mounted inside the two existing
 * warranty registers. The server owns the state machine and every stock/ledger
 * effect; this panel only offers the transitions the shared table permits.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  Wrench,
} from 'lucide-react';
import type {
  User,
  WarrantyClaimCounts,
  WarrantyClaimDetail,
  WarrantyClaimRow,
  WarrantyClaimStatus,
} from '../../../types';
import { api } from '../../../services/api';
import { isOperationAllowed } from '../../../utils/permissions';
import { formatDualDate } from '../../../utils/nepaliCalendar';
import { localTodayAD } from '../../../utils/localDate';
import { DateField } from '../../../components/DateField';
import { FilterCard } from '../../../components/common/FilterCard';
import { LoadStateNotice } from '../../../components/common/LoadStateNotice';
import { TablePagination, useServerPageClamp } from '../../../components/common/TablePagination';
import {
  nextWarrantyClaimStatuses,
  WARRANTY_CLAIM_STATUS_LABELS,
  type WarrantyClaimStatus as SharedStatus,
} from '../../../../../shared/warrantyClaim';

interface WarrantyClaimsPanelProps {
  coverageType: 'VENDOR' | 'SELLER';
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  currentUser?: User | null;
  refreshKey?: number;
}

const EMPTY_COUNTS: WarrantyClaimCounts = {
  total: 0,
  open: 0,
  reported: 0,
  withVendor: 0,
  resolved: 0,
  closed: 0,
  rejected: 0,
};

const STATUS_TONE: Record<WarrantyClaimStatus, string> = {
  REPORTED: 'bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800',
  APPROVED: 'bg-sky-50 text-sky-800 border-sky-300 dark:bg-sky-950/50 dark:text-sky-300 dark:border-sky-800',
  REJECTED: 'bg-rose-50 text-rose-700 border-rose-300 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800',
  SENT_TO_VENDOR: 'bg-violet-50 text-violet-800 border-violet-300 dark:bg-violet-950/50 dark:text-violet-300 dark:border-violet-800',
  REPLACED: 'bg-emerald-50 text-emerald-800 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800',
  REPAIRED: 'bg-emerald-50 text-emerald-800 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800',
  CREDITED: 'bg-emerald-50 text-emerald-800 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800',
  CLOSED: 'bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
};

function statusLabel(status: WarrantyClaimStatus): string {
  return WARRANTY_CLAIM_STATUS_LABELS[status] || status;
}

function actionLabel(status: WarrantyClaimStatus): string {
  if (status === 'SENT_TO_VENDOR') return 'Send to vendor';
  if (status === 'CLOSED') return 'Close claim';
  return statusLabel(status);
}

function today(): string {
  return localTodayAD();
}

export const WarrantyClaimsPanel: React.FC<WarrantyClaimsPanelProps> = ({
  coverageType,
  selectedBranchId,
  dateMode,
  currentUser,
  refreshKey = 0,
}) => {
  const canEdit = isOperationAllowed('warranty-edit', currentUser?.role);
  const [rows, setRows] = useState<WarrantyClaimRow[]>([]);
  const [counts, setCounts] = useState<WarrantyClaimCounts>(EMPTY_COUNTS);
  const [totalItems, setTotalItems] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const [openOnly, setOpenOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadKey, setLoadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WarrantyClaimDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [action, setAction] = useState<WarrantyClaimStatus | null>(null);
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const [serialNumber, setSerialNumber] = useState('');
  const [reportedDateAD, setReportedDateAD] = useState(today());
  const [symptom, setSymptom] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [expectedCredit, setExpectedCredit] = useState('');
  const [replacementSerial, setReplacementSerial] = useState('');
  const [rmaReference, setRmaReference] = useState('');
  const [receivedCredit, setReceivedCredit] = useState('');
  const [creditNoteNo, setCreditNoteNo] = useState('');
  const [postCreditJournal, setPostCreditJournal] = useState(true);
  const [note, setNote] = useState('');

  const safePage = useServerPageClamp(page, pageSize, totalItems, setPage);
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const rangeStart = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const rangeEnd = Math.min(safePage * pageSize, totalItems);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .fetchWarrantyClaims(
        {
          branchId: selectedBranchId,
          query: query || undefined,
          status: status !== 'ALL' ? status : undefined,
          open: openOnly || undefined,
          coverageType,
        },
        page,
        pageSize
      )
      .then((result) => {
        if (cancelled) return;
        setRows(Array.isArray(result?.data) ? result.data : []);
        setCounts(result?.counts || EMPTY_COUNTS);
        setTotalItems(Number(result?.totalItems) || 0);
        setLoadError('');
      })
      .catch((error: any) => {
        if (!cancelled) setLoadError(error?.message || 'The warranty claim register could not be read.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [coverageType, selectedBranchId, query, status, openOnly, page, pageSize, refreshKey, loadKey]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError('');
    api
      .fetchWarrantyClaim(selectedId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((error: any) => {
        if (!cancelled) setDetailError(error?.message || 'The claim detail could not be read.');
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, loadKey]);

  const filtersActive = Boolean(query) || status !== 'ALL' || openOnly;
  const transitions = useMemo(
    () => (detail ? nextWarrantyClaimStatuses(detail.status as SharedStatus) : []),
    [detail]
  );

  const reload = () => setLoadKey((key) => key + 1);

  const resetCreate = () => {
    setSerialNumber('');
    setReportedDateAD(today());
    setSymptom('');
    setVendorName('');
    setExpectedCredit('');
    setActionError('');
  };

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setActionError('');
    try {
      const created = await api.createWarrantyClaim({
        coverageType,
        serialNumber: serialNumber.trim(),
        reportedDateAD,
        symptom: symptom.trim(),
        vendorName: vendorName.trim() || undefined,
        expectedCredit: expectedCredit === '' ? 0 : Number(expectedCredit),
      });
      setShowCreate(false);
      resetCreate();
      setSelectedId(created.id);
      reload();
    } catch (error: any) {
      setActionError(error?.message || 'The claim could not be opened.');
    } finally {
      setSaving(false);
    }
  };

  const beginAction = (next: WarrantyClaimStatus) => {
    setAction(next);
    setActionError('');
    setNote('');
    setReplacementSerial('');
    setRmaReference(detail?.rmaReference || '');
    setReceivedCredit(detail ? String(detail.expectedCredit || '') : '');
    setCreditNoteNo(detail?.creditNoteNo || '');
    setPostCreditJournal(true);
  };

  const submitAction = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!detail || !action) return;
    setSaving(true);
    setActionError('');
    try {
      const updated = await api.transitionWarrantyClaim(detail.id, {
        status: action,
        dateAD: today(),
        note: note.trim() || undefined,
        replacementSerial: action === 'REPLACED' ? replacementSerial.trim() : undefined,
        rmaReference: action === 'SENT_TO_VENDOR' ? rmaReference.trim() || undefined : undefined,
        receivedCredit: action === 'CREDITED' ? Number(receivedCredit) : undefined,
        creditNoteNo: action === 'CREDITED' ? creditNoteNo.trim() || undefined : undefined,
        postCreditJournal: action === 'CREDITED' ? postCreditJournal : undefined,
      });
      setDetail(updated);
      setAction(null);
      reload();
    } catch (error: any) {
      setActionError(error?.message || 'The claim transition was refused.');
    } finally {
      setSaving(false);
    }
  };

  const clearFilters = () => {
    setQuery('');
    setStatus('ALL');
    setOpenOnly(false);
    setPage(1);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          ['Open claims', counts.open, 'bg-amber-50/60 border-amber-200 dark:bg-slate-900 dark:border-slate-800'],
          ['Reported', counts.reported, 'bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800'],
          ['With vendor', counts.withVendor, 'bg-violet-50/50 border-violet-200 dark:bg-slate-900 dark:border-slate-800'],
          ['Resolved / closed', counts.resolved + counts.closed, 'bg-emerald-50/50 border-emerald-200 dark:bg-slate-900 dark:border-slate-800'],
        ].map(([label, value, tone]) => (
          <div key={String(label)} className={`rounded-2xl border p-3 shadow-xs ${tone}`}>
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
            <div className="mt-1 font-mono text-xl font-bold text-slate-900 dark:text-white">{Number(value).toLocaleString('en-IN')}</div>
          </div>
        ))}
      </div>

      {loadError && (
        <LoadStateNotice
          subject="the warranty claim register"
          loading={loading}
          error={loadError}
          hasCachedRows={rows.length > 0}
          cachedNote=" The claims on screen may be out of date."
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
            <div>
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Status</label>
              <select
                aria-label="Claim status"
                value={status}
                onChange={(event) => { setStatus(event.target.value); setPage(1); }}
                className="h-8 w-44 rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
              >
                <option value="ALL">All statuses</option>
                {(Object.entries(WARRANTY_CLAIM_STATUS_LABELS) as Array<[WarrantyClaimStatus, string]>).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <label className="flex h-8 items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={openOnly}
                onChange={(event) => { setOpenOnly(event.target.checked); setPage(1); }}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600"
              />
              Open only
            </label>
          </>
        }
        rightChildren={
          <>
            <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
              <strong className="font-mono text-slate-900 dark:text-white">{totalItems}</strong> matching claims
            </span>
            <button
              type="button"
              onClick={reload}
              disabled={loading}
              className="flex h-8 items-center gap-1.5 rounded-xl border border-slate-300 px-3 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
            {canEdit && (
              <button
                type="button"
                onClick={() => { setShowCreate((value) => !value); setActionError(''); }}
                className="flex h-8 items-center gap-1.5 rounded-xl bg-indigo-600 px-3 text-xs font-bold text-white hover:bg-indigo-700"
              >
                <Plus className="h-3.5 w-3.5" /> New claim
              </button>
            )}
          </>
        }
      />

      {showCreate && canEdit && (
        <form onSubmit={submitCreate} className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-4 dark:border-indigo-900 dark:bg-slate-900">
          <div className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
            <ClipboardList className="h-4 w-4 text-indigo-600" /> Open a {coverageType === 'VENDOR' ? 'supplier' : 'customer'} claim
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Device serial
              <input
                value={serialNumber}
                onChange={(event) => setSerialNumber(event.target.value)}
                required
                placeholder="Serial with current coverage"
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              />
            </label>
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Reported date
              <div className="mt-1">
                <DateField mode={dateMode} value={reportedDateAD} onChange={setReportedDateAD} compact />
              </div>
            </div>
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Vendor (optional)
              <input
                value={vendorName}
                onChange={(event) => setVendorName(event.target.value)}
                placeholder="Supplier / recovery party"
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              />
            </label>
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Expected credit
              <input
                type="number"
                min="0"
                step="0.01"
                value={expectedCredit}
                onChange={(event) => setExpectedCredit(event.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              />
            </label>
            <label className="sm:col-span-2 lg:col-span-4 text-xs font-semibold text-slate-700 dark:text-slate-300">
              Reported fault
              <textarea
                value={symptom}
                onChange={(event) => setSymptom(event.target.value)}
                required
                rows={2}
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              />
            </label>
          </div>
          {actionError && <div role="alert" className="mt-3 rounded-xl border border-rose-300 bg-rose-50 p-2 text-xs font-semibold text-rose-700">{actionError}</div>}
          <div className="mt-3 flex gap-2">
            <button disabled={saving} className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{saving ? 'Opening…' : 'Open claim'}</button>
            <button type="button" onClick={() => setShowCreate(false)} className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300">Cancel</button>
          </div>
        </form>
      )}

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-100/90 text-[10px] font-bold tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-300">
                <tr>
                  <th className="px-2.5 py-2">Claim</th>
                  <th className="px-2.5 py-2">Customer / serial</th>
                  <th className="px-2.5 py-2">Status</th>
                  <th className="px-2.5 py-2">SLA</th>
                  <th className="px-2.5 py-2">Vendor / recovery</th>
                  <th className="px-2.5 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                      {loading ? 'Loading warranty claims…' : filtersActive ? 'No claims match the applied filters.' : 'No claims opened for this warranty side yet.'}
                    </td>
                  </tr>
                ) : rows.map((row) => (
                  <tr key={row.id} className={`hover:bg-slate-100/80 dark:hover:bg-slate-800/50 ${selectedId === row.id ? 'bg-indigo-50/70 dark:bg-indigo-950/20' : ''}`}>
                    <td className="p-2.5">
                      <div className="font-mono text-[11px] font-bold text-slate-900 dark:text-white">{row.claimNo}</div>
                      <div className="text-[10px] text-slate-400">{formatDualDate(row.reportedDateAD, dateMode)}</div>
                    </td>
                    <td className="p-2.5">
                      <div className="font-semibold text-slate-800 dark:text-slate-200">{row.customerName || '—'}</div>
                      <div className="font-mono text-[10px] text-slate-400">{row.serialNumber} · {row.productName}</div>
                    </td>
                    <td className="p-2.5">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${STATUS_TONE[row.status]}`}>{statusLabel(row.status)}</span>
                      {row.resolution && <div className="mt-1 text-[10px] text-slate-400">{row.resolution}</div>}
                    </td>
                    <td className={`p-2.5 font-mono text-[11px] font-bold ${row.slaDays > 7 && row.open ? 'text-rose-600' : 'text-slate-600 dark:text-slate-300'}`}>{row.slaDays}d</td>
                    <td className="p-2.5 text-[11px] text-slate-600 dark:text-slate-300">
                      <div>{row.vendorName || '—'}</div>
                      {row.expectedCredit > 0 && <div className="font-mono text-[10px] text-slate-400">Exp. {row.expectedCredit.toFixed(2)}</div>}
                    </td>
                    <td className="p-2.5 text-right">
                      <button type="button" onClick={() => { setSelectedId(row.id); setAction(null); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200 hover:text-indigo-600 dark:hover:bg-slate-800" aria-label={`Open claim ${row.claimNo}`}>
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination page={safePage} pageCount={pageCount} totalItems={totalItems} rangeStart={rangeStart} rangeEnd={rangeEnd} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          {!selectedId ? (
            <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 text-center text-slate-400">
              <ShieldAlert className="h-8 w-8" />
              <div className="text-xs font-semibold">Choose a claim to see its timeline, vendor recovery and next step.</div>
            </div>
          ) : detailLoading ? (
            <div className="text-xs text-slate-500">Loading claim detail…</div>
          ) : detailError ? (
            <div role="alert" className="text-xs font-semibold text-rose-600">{detailError}</div>
          ) : detail ? (
            <div className="space-y-4">
              <div>
                <div className="font-mono text-xs font-bold text-slate-500">{detail.claimNo}</div>
                <div className="mt-1 text-lg font-bold text-slate-900 dark:text-white">{detail.productName}</div>
                <div className="font-mono text-[11px] text-slate-500">{detail.serialNumber}</div>
                <span className={`mt-2 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${STATUS_TONE[detail.status]}`}>{statusLabel(detail.status)}</span>
                <span className="ml-2 text-[10px] font-semibold text-slate-400">SLA {detail.slaDays} days</span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded-lg bg-slate-50 p-2 dark:bg-slate-800/60"><div className="text-slate-400">Reported</div><div className="font-semibold">{formatDualDate(detail.reportedDateAD, dateMode)}</div></div>
                <div className="rounded-lg bg-slate-50 p-2 dark:bg-slate-800/60"><div className="text-slate-400">Branch</div><div className="font-semibold">{detail.branchName || detail.branchId}</div></div>
                <div className="rounded-lg bg-slate-50 p-2 dark:bg-slate-800/60"><div className="text-slate-400">Customer</div><div className="font-semibold">{detail.customerName || '—'}</div></div>
                <div className="rounded-lg bg-slate-50 p-2 dark:bg-slate-800/60"><div className="text-slate-400">Vendor / ref</div><div className="font-semibold">{detail.vendorName || '—'}{detail.vendorClaimRef ? ` · ${detail.vendorClaimRef}` : ''}</div></div>
              </div>

              <div className="rounded-xl border border-slate-200 p-3 text-xs dark:border-slate-800">
                <div className="font-bold text-slate-700 dark:text-slate-200">Reported fault</div>
                <div className="mt-1 whitespace-pre-wrap text-slate-600 dark:text-slate-300">{detail.symptom}</div>
              </div>

              {detail.vendorCredit && (
                <div className={`rounded-xl border p-3 text-xs ${detail.vendorCredit.reconciled ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50'}`}>
                  <div className="flex items-center gap-1.5 font-bold text-slate-800"><CheckCircle2 className="h-4 w-4 text-emerald-600" /> Vendor credit {detail.vendorCredit.journalNo}</div>
                  <div className="mt-1 text-slate-600">Posted {detail.vendorCredit.amount.toFixed(2)} · received {detail.receivedCredit.toFixed(2)} {detail.vendorCredit.reconciled ? '· reconciled' : '· difference needs review'}</div>
                </div>
              )}

              <div>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">Timeline</div>
                <div className="space-y-2">
                  {detail.events.map((event) => (
                    <div key={event.id} className="border-l-2 border-indigo-200 pl-3 dark:border-indigo-800">
                      <div className="text-[11px] font-bold text-slate-700 dark:text-slate-200">{statusLabel(event.status)}</div>
                      <div className="text-[10px] text-slate-500">{event.note || '—'}</div>
                      <div className="text-[10px] text-slate-400">{event.actor || 'system'}</div>
                    </div>
                  ))}
                </div>
              </div>

              {canEdit && transitions.length > 0 && !action && (
                <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
                  {transitions.map((next) => (
                    <button key={next} type="button" onClick={() => beginAction(next)} className="flex items-center gap-1 rounded-xl border border-indigo-300 bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300">
                      {next === 'REPLACED' ? <Wrench className="h-3.5 w-3.5" /> : next === 'SENT_TO_VENDOR' ? <Send className="h-3.5 w-3.5" /> : next === 'REJECTED' ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      {actionLabel(next)}
                    </button>
                  ))}
                </div>
              )}

              {action && (
                <form onSubmit={submitAction} className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-200">{actionLabel(action)}</div>
                  {action === 'REPLACED' && (
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300">Replacement serial (must be IN_STOCK in this branch)
                      <input value={replacementSerial} onChange={(event) => setReplacementSerial(event.target.value)} required className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-white" />
                    </label>
                  )}
                  {action === 'SENT_TO_VENDOR' && (
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300">RMA reference
                      <input value={rmaReference} onChange={(event) => setRmaReference(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-white" />
                    </label>
                  )}
                  {action === 'CREDITED' && (
                    <>
                      <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300">Received credit
                        <input type="number" min="0" step="0.01" value={receivedCredit} onChange={(event) => setReceivedCredit(event.target.value)} required className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-white" />
                      </label>
                      <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300">Vendor credit note
                        <input value={creditNoteNo} onChange={(event) => setCreditNoteNo(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-white" />
                      </label>
                      <label className="flex items-center gap-2 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                        <input type="checkbox" checked={postCreditJournal} onChange={(event) => setPostCreditJournal(event.target.checked)} className="h-3.5 w-3.5 rounded" />
                        Post the AP / stock-expense journal
                      </label>
                    </>
                  )}
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300">Note
                    <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} required={action === 'REJECTED'} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-white" />
                  </label>
                  {actionError && <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-2 text-[11px] font-semibold text-rose-700">{actionError}</div>}
                  <div className="flex gap-2">
                    <button disabled={saving} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Confirm'}</button>
                    <button type="button" onClick={() => setAction(null)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-[11px] font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300">Cancel</button>
                  </div>
                </form>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
