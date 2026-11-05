/**
 * Voucher detail dialog.
 *
 * Opens one posted journal together with the voucher linked to it: the contra
 * for an original, or the original for a reversal. Both sides are rendered
 * side by side so an auditor can compare mirrored lines without leaving the
 * register they were reading.
 */
import React, { useEffect, useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';
import { api } from '../../services/api';
import type { AccountingJournal } from '../../services/api/accounting';
import { formatMoney } from '../../utils/nprFormat';

export function sourceLabel(sourceType: string): string {
  switch (sourceType) {
    case 'CASH_RECEIPT':
      return 'Cash receipt';
    case 'CASH_PAYMENT':
      return 'Cash payment';
    case 'CASH_BANK':
      return 'Cash / bank';
    default:
      return sourceType.endsWith('_REVERSAL') ? 'Reversal' : 'Journal';
  }
}

export function journalStatus(journal: AccountingJournal): 'Posted' | 'Reversed' | 'Reversal' {
  if (journal.reversalOfId) return 'Reversal';
  if (journal.reversalJournalNo || journal.status === 'REVERSED') return 'Reversed';
  return 'Posted';
}

export function statusBadgeClass(status: string): string {
  if (status === 'Posted') {
    return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300';
  }
  if (status === 'Reversal') {
    return 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300';
  }
  return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
}

/** A journal number that opens the shared detail dialog. */
export const JournalLink: React.FC<{
  journalId: string;
  journalNo: string;
  onOpen: (journalId: string) => void;
  className?: string;
}> = ({ journalId, journalNo, onOpen, className = '' }) => (
  <button
    type="button"
    onClick={() => onOpen(journalId)}
    className={`rounded font-mono text-[11px] font-bold text-indigo-600 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-400 ${className}`}
    title={`Open voucher ${journalNo}`}
  >
    {journalNo}
  </button>
);

/** One voucher side of the detail dialog: header metadata, lines and totals. */
const VoucherDetailPanel: React.FC<{
  label: string;
  journal: AccountingJournal | null;
  emptyMessage: string;
  accent?: boolean;
}> = ({ label, journal, emptyMessage, accent = false }) => {
  if (!journal) {
    return (
      <div className="flex min-h-[260px] flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center dark:border-slate-700 dark:bg-slate-800/30">
        <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">{label}</p>
        <p className="mt-1 max-w-[240px] text-[11px] text-slate-400">{emptyMessage}</p>
      </div>
    );
  }

  const subledgerByLine = new Map(
    (journal.subledgerEntries || []).map((entry) => [entry.journalLineId, entry])
  );
  const status = journalStatus(journal);
  const postedAt = journal.postedAt
    ? new Date(journal.postedAt).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

  return (
    <div
      className={`rounded-xl border bg-white dark:bg-slate-900/60 ${
        accent
          ? 'border-amber-300 dark:border-amber-500/40'
          : 'border-slate-200 dark:border-slate-700'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-slate-700">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
          <p className="font-mono text-sm font-semibold text-slate-800 dark:text-slate-100">
            {journal.journalNo}
          </p>
        </div>
        <div className="text-right">
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusBadgeClass(status)}`}
            title={journal.reversalJournalNo ? `Reversed by ${journal.reversalJournalNo}` : undefined}
          >
            {status}
          </span>
          {journal.reversalOfNo && (
            <p className="mt-0.5 text-[10px] text-slate-400">of {journal.reversalOfNo}</p>
          )}
          {journal.reversalJournalNo && (
            <p className="mt-0.5 font-mono text-[10px] text-slate-400">by {journal.reversalJournalNo}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-3 py-2.5 text-[11px]">
        <span className="text-slate-400">Date</span>
        <span className="text-right font-medium text-slate-700 dark:text-slate-200">{journal.journalDateAD}</span>
        <span className="text-slate-400">Branch</span>
        <span className="text-right font-medium text-slate-700 dark:text-slate-200">
          {journal.branchName || journal.branchId}
        </span>
        <span className="text-slate-400">Source</span>
        <span className="text-right font-medium text-slate-700 dark:text-slate-200">
          {sourceLabel(journal.sourceType)}
        </span>
        <span className="text-slate-400">Voucher type</span>
        <span className="text-right font-medium text-slate-700 dark:text-slate-200">
          {journal.voucherType.replaceAll('_', ' ')}
        </span>
        {journal.voucherClass && (
          <>
            <span className="text-slate-400">Class</span>
            <span className="text-right font-medium text-slate-700 dark:text-slate-200">{journal.voucherClass}</span>
          </>
        )}
        <span className="text-slate-400">Currency</span>
        <span className="text-right font-medium text-slate-700 dark:text-slate-200">
          {journal.currency}{journal.currency !== 'NPR' ? ` × ${journal.exchangeRate}` : ''}
        </span>
        {journal.referenceNo && (
          <>
            <span className="text-slate-400">Reference</span>
            <span className="text-right font-medium text-slate-700 dark:text-slate-200">
              {journal.referenceNo}{journal.referenceDateAD ? ` · ${journal.referenceDateAD}` : ''}
            </span>
          </>
        )}
        {journal.chequeNo && (
          <>
            <span className="text-slate-400">Cheque</span>
            <span className="text-right font-medium text-slate-700 dark:text-slate-200">
              {journal.chequeNo}{journal.chequeDateAD ? ` · ${journal.chequeDateAD}` : ''}
            </span>
          </>
        )}
        <span className="text-slate-400">Posted</span>
        <span className="text-right font-medium text-slate-700 dark:text-slate-200">{postedAt}</span>
        <span className="text-slate-400">Posted by</span>
        <span className="text-right font-medium text-slate-700 dark:text-slate-200">{journal.postedBy || '—'}</span>
      </div>

      {journal.memo && (
        <p className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {journal.memo}
        </p>
      )}

      <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-700">
        <table className="w-full min-w-[430px] text-left text-[11px]">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/60">
            <tr>
              <th className="px-2 py-1.5">Account</th>
              <th className="px-2 py-1.5">Party / CC</th>
              <th className="px-2 py-1.5 text-right">Debit</th>
              <th className="px-2 py-1.5 text-right">Credit</th>
              <th className="px-2 py-1.5">Narration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {(journal.lines || []).map((line) => {
              const subledger = subledgerByLine.get(line.id);
              const party = subledger?.partyName || line.partyName || '—';
              const costCenter = line.costCenterCode || line.costCenterName;
              return (
                <tr key={line.id} className="align-top">
                  <td className="px-2 py-1.5">
                    <span className="font-mono text-[10px] text-slate-400">{line.accountCode}</span>
                    <span className="block text-slate-700 dark:text-slate-200">{line.accountName}</span>
                  </td>
                  <td className="px-2 py-1.5 text-slate-500">
                    {party}
                    {costCenter && (
                      <span className="block text-[10px] text-slate-400">CC {costCenter}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-slate-700 dark:text-slate-200">
                    {Number(line.debit) ? formatMoney(Number(line.debit)) : '—'}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-slate-700 dark:text-slate-200">
                    {Number(line.credit) ? formatMoney(Number(line.credit)) : '—'}
                  </td>
                  <td className="max-w-[160px] px-2 py-1.5 text-slate-500">{line.memo || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-1 border-t border-slate-200 px-3 py-2 text-[11px] dark:border-slate-700">
        <span className="font-semibold text-slate-500">Totals</span>
        <span className="tabular-nums text-slate-600 dark:text-slate-300">
          Dr {formatMoney(journal.totalDebit)} · Cr {formatMoney(journal.totalCredit)}
        </span>
      </div>
    </div>
  );
};

export const VoucherDetailDialog: React.FC<{
  journalId: string;
  onClose: () => void;
}> = ({ journalId, onClose }) => {
  const [journal, setJournal] = useState<AccountingJournal | null>(null);
  const [counterpart, setCounterpart] = useState<AccountingJournal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setJournal(null);
    setCounterpart(null);
    setError('');
    setLoading(true);
    (async () => {
      try {
        const loaded = await api.getAccountingJournal(journalId);
        if (!alive) return;
        setJournal(loaded);
        const linkedId = loaded.reversalJournalId || loaded.reversalOfId;
        if (linkedId) {
          try {
            const linked = await api.getAccountingJournal(linkedId);
            if (alive) setCounterpart(linked);
          } catch {
            if (alive) setError('The linked voucher could not be loaded.');
          }
        }
      } catch (err: any) {
        if (alive) {
          setError(err?.message || 'The voucher detail could not be loaded.');
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [journalId]);

  const isReversal = Boolean(journal?.reversalOfId);
  const original = journal
    ? isReversal
      ? counterpart
      : journal
    : null;
  const reversal = journal
    ? isReversal
      ? journal
      : counterpart
    : null;
  const combinedDebit = (original?.totalDebit || 0) + (reversal?.totalDebit || 0);
  const combinedCredit = (original?.totalCredit || 0) + (reversal?.totalCredit || 0);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/50 p-4">
      <div
        className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
        role="dialog"
        aria-modal="true"
        aria-label="Voucher detail"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-700">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Voucher detail</h3>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              {journal
                ? `${journal.journalNo} · ${journal.journalDateAD} · ${journal.branchName || journal.branchId}`
                : 'Loading voucher…'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
            aria-label="Close voucher detail"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-[220px] overflow-y-auto p-4">
          {error && (
            <div
              className="mb-3 flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {loading && !journal ? (
            <div className="flex items-center justify-center gap-2 py-16 text-xs text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading voucher…
            </div>
          ) : journal ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <VoucherDetailPanel
                  label={isReversal ? 'Original voucher' : 'Voucher'}
                  journal={original}
                  emptyMessage={
                    isReversal
                      ? loading
                        ? 'Loading original voucher…'
                        : 'The original voucher could not be loaded.'
                      : 'No original voucher.'
                  }
                />
                <VoucherDetailPanel
                  label="Reversal voucher"
                  journal={reversal}
                  emptyMessage="No reversal has been posted for this voucher."
                  accent
                />
              </div>
              {original && reversal && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300">
                  <span className="font-semibold">Original + reversal</span>
                  <span className="tabular-nums">
                    Dr {formatMoney(combinedDebit)} · Cr {formatMoney(combinedCredit)} · Net{' '}
                    {formatMoney(combinedDebit - combinedCredit)}
                  </span>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default VoucherDetailDialog;
