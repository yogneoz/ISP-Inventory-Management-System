/**
 * Bank reconciliation workspace, mounted as the second view of Cash & Bank
 * Book. The account master is the chart's BANK ledgers; the statement and
 * session facts come from the bank-reconciliation API.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  Landmark,
  Link2,
  Lock,
  RefreshCw,
  Unlink,
  Unlock,
  Upload,
} from 'lucide-react';
import { KpiStrip, KPI_TONE_TEXT } from '../common/KpiStrip';
import { useActivationKey, useTabActive } from '../common/KeepMounted';
import { api } from '../../services/api';
import type {
  BankReconciliationResponse,
  BankReconciliationSession,
} from '../../services/api/accounting';
import type { User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { exportToCSV } from '../../utils/exportUtils';
import { money } from './statementFormat';
import { DateField } from '../DateField';

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function amountCell(value: number, dateMode: 'BS' | 'AD'): string {
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${money(value)}`;
}

function sessionStatusLabel(session: BankReconciliationSession | null): string {
  if (!session) return 'UNSAVED';
  return session.status;
}

export interface BankReconciliationPanelProps {
  branchId: string;
  to: string;
  dateMode: 'BS' | 'AD';
  currentUser?: User | null;
}

export const BankReconciliationPanel: React.FC<BankReconciliationPanelProps> = ({
  branchId,
  to,
  dateMode,
  currentUser,
}) => {
  const [data, setData] = useState<BankReconciliationResponse | null>(null);
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState(() => monthStart(to));
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [importContent, setImportContent] = useState('');
  const [importName, setImportName] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const [importErrors, setImportErrors] = useState<Array<{ row: number; message: string }>>([]);
  const [openingBalance, setOpeningBalance] = useState('0');
  const [closingBalance, setClosingBalance] = useState('0');
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [reopenReason, setReopenReason] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const activationKey = useActivationKey('accounting-cash-book');
  const isVisible = useTabActive('accounting-cash-book');
  const canWrite = isOperationAllowed('gl-cash-close', currentUser?.role);

  useEffect(() => {
    if (!to) return;
    setFrom((current) => (current && current <= to ? current : monthStart(to)));
  }, [to]);

  useEffect(() => {
    if (!isVisible || branchId !== 'ALL' || !to || from > to) return;
    let live = true;
    setLoading(true);
    setError('');
    void api
      .getBankReconciliation({
        accountId: accountId || undefined,
        from,
        to,
      })
      .then((next) => {
        if (!live) return;
        setData(next);
        if (!accountId && next.account?.accountId) setAccountId(next.account.accountId);
      })
      .catch((err: any) => {
        if (!live) return;
        setError(err?.message || 'Failed to load the bank reconciliation workspace.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [isVisible, branchId, accountId, from, to, activationKey, reloadKey]);

  useEffect(() => {
    if (!data) return;
    setOpeningBalance(String(data.statement.openingBalance));
    setClosingBalance(String(data.statement.closingBalance));
    setSelection({});
  }, [data?.account?.accountId, data?.from, data?.to, data?.session?.id, data?.statement.openingBalance, data?.statement.closingBalance]);

  const locked = data?.session?.status === 'LOCKED';
  const unmatchedLines = data?.lines.filter((line) => !line.matchedJournalLineId) || [];
  const unmatchedBookEntries = data?.book.entries.filter((entry) => !entry.matchedStatementLineId) || [];
  const accountLabel = data?.account
    ? `${data.account.code} · ${data.account.name}`
    : 'No BANK ledger selected';
  const branchName = 'All branches (company)';

  const actionContext = useMemo(
    () => ({
      accountId: data?.account?.accountId || accountId,
      from: data?.from || from,
      to: data?.to || to,
    }),
    [data?.account?.accountId, data?.from, data?.to, accountId, from, to]
  );

  async function runAction<T extends { workspace: BankReconciliationResponse }>(
    action: () => Promise<T>,
    successMessage = ''
  ): Promise<void> {
    setBusy(true);
    setError('');
    setImportMessage('');
    setImportErrors([]);
    try {
      const result = await action();
      setData(result.workspace);
      if (successMessage) setImportMessage(successMessage);
    } catch (err: any) {
      setError(err?.message || 'The bank reconciliation action failed.');
    } finally {
      setBusy(false);
    }
  }

  async function importStatement(): Promise<void> {
    if (!data?.account || !importContent.trim()) return;
    const format = /\.(ofx|qfx)$/i.test(importName) ? 'OFX' : 'CSV';
    setBusy(true);
    setError('');
    setImportErrors([]);
    try {
      const result = await api.importBankStatement({
        ...actionContext,
        content: importContent,
        format,
        fileName: importName || undefined,
      });
      setData(result.workspace);
      setImportErrors(result.errors || []);
      setImportMessage(
        `${result.imported} line(s) imported${result.duplicates ? ` · ${result.duplicates} duplicate(s) skipped` : ''}.`
      );
    } catch (err: any) {
      setError(err?.message || 'The statement could not be imported.');
    } finally {
      setBusy(false);
    }
  }

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) {
      setError('A statement may be at most 2 MB.');
      return;
    }
    setImportName(file.name);
    setImportContent(await file.text());
    setImportErrors([]);
    setImportMessage('');
  }

  async function saveSession(): Promise<void> {
    if (!data?.account) return;
    const opening = Number(openingBalance);
    const closing = Number(closingBalance);
    if (!Number.isFinite(opening) || !Number.isFinite(closing)) {
      setError('Enter numeric statement opening and closing balances.');
      return;
    }
    await runAction(
      () =>
        api.saveBankReconciliationSession({
          ...actionContext,
          openingStatementBalance: opening,
          closingStatementBalance: closing,
        }),
      'Reconciliation period saved.'
    );
  }

  async function lockSession(): Promise<void> {
    if (!data?.session) return;
    await runAction(
      () => api.lockBankReconciliationSession(data.session!.id, actionContext),
      'Reconciliation period locked.'
    );
  }

  async function reopenSession(): Promise<void> {
    if (!data?.session) return;
    await runAction(
      () => api.reopenBankReconciliationSession(data.session!.id, reopenReason, actionContext),
      'Reconciliation period reopened.'
    );
    setReopenReason('');
  }

  async function matchLine(lineId: string): Promise<void> {
    const journalLineId = selection[lineId];
    if (!journalLineId) return;
    await runAction(
      () => api.matchBankStatementLine(lineId, journalLineId, actionContext),
      'Statement line matched.'
    );
  }

  async function unmatchLine(lineId: string): Promise<void> {
    await runAction(
      () => api.unmatchBankStatementLine(lineId, actionContext),
      'Statement line unmatched.'
    );
  }

  function exportUnmatched(): void {
    if (!data?.account) return;
    exportToCSV({
      filename: `Bank_Unmatched_${data.account.code}_${data.from}_${data.to}`,
      reportTitle: 'Bank Reconciliation Unmatched Statement Lines',
      branchName,
      data: unmatchedLines.map((line) => ({
        dateAD: line.statementDate,
        dateBS: line.statementDateBS,
        description: line.description,
        reference: line.reference || '',
        amount: line.amount,
        importSource: line.importSource,
        importBatchId: line.importBatchId,
      })),
      columns: [
        { key: 'dateAD', label: 'Statement Date (AD)' },
        { key: 'dateBS', label: 'Statement Date (BS)' },
        { key: 'description', label: 'Description' },
        { key: 'reference', label: 'Reference' },
        {
          key: 'amount',
          label: 'Amount (NPR; positive = deposit)',
          formatter: (value: number) => Number(value).toFixed(2),
        },
        { key: 'importSource', label: 'Source' },
        { key: 'importBatchId', label: 'Import Batch' },
      ],
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40">
        <label className="min-w-[15rem] flex-1 text-xs font-semibold text-slate-500 dark:text-slate-400">
          Bank ledger
          <select
            aria-label="Bank reconciliation account"
            value={data?.account?.accountId || accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
              setData(null);
            }}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
          >
            {(data?.accounts || []).map((account) => (
              <option key={account.accountId} value={account.accountId}>
                {account.code} · {account.name}
                {account.accountNumber ? ` · ${account.accountNumber}` : ''}
                {!account.isActive ? ' (inactive)' : ''}
              </option>
            ))}
          </select>
        </label>
        {/* Compact so both calendars render the same height; the value stays
            AD for the read. */}
        <div className="w-64 shrink-0">
          <DateField
            compact
            mode={dateMode}
            label="Period start"
            ariaLabel="Bank reconciliation period start"
            value={from}
            max={to}
            onChange={setFrom}
          />
        </div>
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-snug text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
          Period end <span className="font-semibold text-slate-700 dark:text-slate-200">{formatDualDate(to, dateMode)}</span>
          <br />
          Company-wide · {accountLabel}
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((key) => key + 1)}
          disabled={loading || busy}
          className="ml-auto flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-200 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && !data && (
        <div role="status" className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
          Loading bank reconciliation…
        </div>
      )}

      {branchId !== 'ALL' && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-6 text-center text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-300">
          Bank reconciliation is company-wide because every branch posts to the same bank account and the bank issues one statement. Switch the branch selector to All Branches.
        </div>
      )}

      {!loading && data && data.accounts.length === 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-8 text-center text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
          <Landmark className="mx-auto mb-2 h-7 w-7 text-slate-300 dark:text-slate-600" />
          No BANK ledger is available. Create a bank ledger in the chart of accounts first.
        </div>
      )}

      {data?.account && (
        <>
          <KpiStrip
            items={[
              { label: 'BOOK CLOSING', value: money(data.book.closingBalance), tone: KPI_TONE_TEXT.indigo, hint: 'Posted bank-ledger balance at period end' },
              { label: 'STATEMENT CLOSING', value: money(data.statement.closingBalance), tone: KPI_TONE_TEXT.amber, hint: 'Entered statement closing balance' },
              {
                label: 'DIFFERENCE',
                value: money(data.difference),
                tone: KPI_TONE_TEXT[data.reconciled ? 'emerald' : 'rose'],
                hint: 'Statement closing minus book closing',
              },
              {
                label: 'UNMATCHED',
                value: String(data.statement.unmatchedCount),
                tone: KPI_TONE_TEXT[data.statement.unmatchedCount ? 'rose' : 'emerald'],
                hint: `${money(data.statement.unmatchedAmount)} statement value still unmatched`,
              },
            ]}
          />

          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/40">
            <span
              className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${
                locked
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                  : data.session
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                    : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
              }`}
            >
              {sessionStatusLabel(data.session)}
            </span>
            <span className="text-slate-500 dark:text-slate-400">
              {data.session
                ? `${data.session.periodStart} → ${data.session.periodEnd}${data.session.lockedBy ? ` · locked by ${data.session.lockedBy}` : ''}`
                : 'Save the statement opening and closing balances to create a period.'}
            </span>
            {data.reconciled ? (
              <span className="font-semibold text-emerald-700 dark:text-emerald-400">Statement ties to the bank book</span>
            ) : (
              <span className="font-semibold text-rose-700 dark:text-rose-400">
                Difference explained by {data.statement.unmatchedCount} unmatched statement line(s)
              </span>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.75fr)]">
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
                <div>
                  <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Statement lines</h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {data.statement.lineCount} line(s) · {data.statement.matchedCount} matched · {data.statement.unmatchedCount} unmatched
                  </p>
                </div>
                <button
                  type="button"
                  onClick={exportUnmatched}
                  disabled={unmatchedLines.length === 0}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <Download className="h-3.5 w-3.5" />
                  Export unmatched CSV
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
                    <tr>
                      <th className="px-2.5 py-1.5">Date</th>
                      <th className="px-2.5 py-1.5">Description</th>
                      <th className="px-2.5 py-1.5">Reference</th>
                      <th className="px-2.5 py-1.5">Branch</th>
                      <th className="px-2.5 py-1.5 text-right">Amount</th>
                      <th className="px-2.5 py-1.5">Match</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                    {data.lines.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-5 text-center text-slate-400">
                          No statement lines in this period. Import a CSV or OFX statement below.
                        </td>
                      </tr>
                    ) : (
                      data.lines.map((line) => {
                        const options = unmatchedBookEntries;
                        const chosen = selection[line.id] || line.suggestedJournalLineId || '';
                        return (
                          <tr key={line.id} className="align-top text-slate-800 dark:text-slate-300">
                            <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[11px]">
                              {formatDualDate(line.statementDate, dateMode)}
                            </td>
                            <td className="max-w-[16rem] px-2.5 py-1.5">
                              <div className="truncate font-medium">{line.description}</div>
                              <div className="text-[10px] text-slate-400">{line.importSource} · {line.importBatchId}</div>
                            </td>
                            <td className="max-w-[9rem] truncate px-2.5 py-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                              {line.reference || '—'}
                            </td>
                            <td className="whitespace-nowrap px-2.5 py-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                              {line.matchedBranchCode || '—'}
                            </td>
                            <td className={`whitespace-nowrap px-2.5 py-1.5 text-right font-mono ${line.amount > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                              {amountCell(line.amount, dateMode)}
                            </td>
                            <td className="min-w-[15rem] px-2.5 py-1.5">
                              {line.matchedJournalLineId ? (
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                                    {line.matchedJournalNo || 'matched'}
                                  </span>
                                  <button
                                    type="button"
                                    aria-label={`Unmatch statement line ${line.id}`}
                                    onClick={() => void unmatchLine(line.id)}
                                    disabled={!canWrite || locked || busy}
                                    className="inline-flex items-center gap-1 rounded border border-slate-300 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                                  >
                                    <Unlink className="h-3 w-3" /> Unmatch
                                  </button>
                                </div>
                              ) : (
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <select
                                    aria-label={`Match candidate for statement line ${line.id}`}
                                    value={chosen}
                                    onChange={(event) =>
                                      setSelection((current) => ({ ...current, [line.id]: event.target.value }))
                                    }
                                    disabled={!canWrite || locked || busy || options.length === 0}
                                    className="max-w-[14rem] rounded border border-slate-300 bg-white px-1.5 py-1 text-[11px] text-slate-800 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                                  >
                                    <option value="">Select a bank-book line</option>
                                    {options.map((entry) => (
                                      <option key={entry.journalLineId} value={entry.journalLineId}>
                                        {entry.journalDateAD} · {entry.branchCode} · {entry.journalNo} · {money(entry.amount)}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    aria-label={`Match statement line ${line.id}`}
                                    onClick={() => void matchLine(line.id)}
                                    disabled={!canWrite || locked || busy || !chosen}
                                    className="inline-flex items-center gap-1 rounded border border-indigo-300 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-500/40 dark:bg-indigo-950/30 dark:text-indigo-300"
                                  >
                                    <Link2 className="h-3 w-3" /> Match
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              {data.linesTruncated && (
                <p className="border-t border-slate-200 px-3 py-2 text-[10px] text-amber-700 dark:border-slate-800 dark:text-amber-400">
                  Showing the first 1,000 statement lines. Narrow the period to match the remainder.
                </p>
              )}
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40">
                <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Period balances</h3>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  Enter the opening and closing balances printed on the bank statement.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                    Opening
                    <input
                      aria-label="Statement opening balance"
                      type="number"
                      step="0.01"
                      value={openingBalance}
                      onChange={(event) => setOpeningBalance(event.target.value)}
                      disabled={!canWrite || locked || busy}
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                    />
                  </label>
                  <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                    Closing
                    <input
                      aria-label="Statement closing balance"
                      type="number"
                      step="0.01"
                      value={closingBalance}
                      onChange={(event) => setClosingBalance(event.target.value)}
                      disabled={!canWrite || locked || busy}
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                    />
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void saveSession()}
                    disabled={!canWrite || locked || busy || !data.account}
                    className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    Save period
                  </button>
                  <button
                    type="button"
                    onClick={() => void lockSession()}
                    disabled={!canWrite || !data.session || locked || busy}
                    className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-300"
                  >
                    <Lock className="h-3.5 w-3.5" /> Lock period
                  </button>
                </div>
                {!canWrite && (
                  <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400">
                    You can read the reconciliation; changing it requires `gl-cash-close`.
                  </p>
                )}
                {locked && (
                  <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-800">
                    <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                      Reopen reason
                      <input
                        aria-label="Reconciliation reopen reason"
                        value={reopenReason}
                        onChange={(event) => setReopenReason(event.target.value)}
                        placeholder="Why is this period being reopened?"
                        disabled={!canWrite || busy}
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void reopenSession()}
                      disabled={!canWrite || busy || reopenReason.trim().length < 3}
                      className="mt-2 inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-[11px] font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      <Unlock className="h-3.5 w-3.5" /> Reopen period
                    </button>
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40">
                <h3 className="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-200">
                  <Upload className="h-3.5 w-3.5" /> Import statement
                </h3>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  CSV columns: date, description, reference, amount (positive deposit / negative withdrawal), or debit/credit.
                  OFX/QFX is parsed as-is. Re-importing the same line is harmless.
                </p>
                <input
                  ref={fileRef}
                  aria-label="Bank statement file"
                  type="file"
                  accept=".csv,.ofx,.qfx,text/csv,application/x-ofx"
                  onChange={(event) => void onFileChange(event)}
                  disabled={!canWrite || busy}
                  className="mt-2 block w-full text-[11px] text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-[11px] file:font-semibold file:text-slate-700 dark:text-slate-300 dark:file:bg-slate-800 dark:file:text-slate-200"
                />
                <textarea
                  aria-label="Bank statement content"
                  value={importContent}
                  onChange={(event) => setImportContent(event.target.value)}
                  placeholder={'date,description,reference,amount\n2026-10-05,Customer deposit,BANK-1,5000'}
                  disabled={!canWrite || busy}
                  rows={4}
                  className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 font-mono text-[11px] dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                />
                <button
                  type="button"
                  onClick={() => void importStatement()}
                  disabled={!canWrite || busy || !importContent.trim() || !data.account}
                  className="mt-2 inline-flex items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-indigo-600 dark:hover:bg-indigo-700"
                >
                  <Upload className="h-3.5 w-3.5" /> Import statement
                </button>
                {importMessage && <p className="mt-2 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">{importMessage}</p>}
                {importErrors.length > 0 && (
                  <div className="mt-2 space-y-1 text-[10px] text-rose-700 dark:text-rose-400">
                    {importErrors.slice(0, 5).map((issue) => (
                      <p key={`${issue.row}-${issue.message}`}>Row {issue.row}: {issue.message}</p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
            <div className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
              <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Book entries in period</h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Posted bank-ledger lines available for matching; the balance includes everything before the period.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
                  <tr>
                    <th className="px-2.5 py-1.5">Date</th>
                    <th className="px-2.5 py-1.5">Journal</th>
                    <th className="px-2.5 py-1.5">Branch</th>
                    <th className="px-2.5 py-1.5">Memo</th>
                    <th className="px-2.5 py-1.5 text-right">Amount</th>
                    <th className="px-2.5 py-1.5">Match</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {data.book.entries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-5 text-center text-slate-400">
                        No posted bank-ledger movement in this period.
                      </td>
                    </tr>
                  ) : (
                    data.book.entries.map((entry) => (
                      <tr key={entry.journalLineId} className="text-slate-800 dark:text-slate-300">
                        <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[11px]">{formatDualDate(entry.journalDateAD, dateMode)}</td>
                        <td className="px-2.5 py-1.5 font-mono text-[11px] text-indigo-600 dark:text-indigo-400">{entry.journalNo}</td>
                        <td className="whitespace-nowrap px-2.5 py-1.5 text-[11px] text-slate-500 dark:text-slate-400">{entry.branchCode}</td>
                        <td className="max-w-[20rem] truncate px-2.5 py-1.5 text-slate-500 dark:text-slate-400">{entry.memo || entry.journalMemo || '—'}</td>
                        <td className={`px-2.5 py-1.5 text-right font-mono ${entry.amount > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{amountCell(entry.amount, dateMode)}</td>
                        <td className="px-2.5 py-1.5 text-[11px]">
                          {entry.matchedStatementLineId ? (
                            <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-semibold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">Matched</span>
                          ) : (
                            <span className="text-slate-400">Unmatched</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {data.book.truncated && (
              <p className="border-t border-slate-200 px-3 py-2 text-[10px] text-amber-700 dark:border-slate-800 dark:text-amber-400">
                Showing the first 1,000 book entries. Narrow the period to review the remainder.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default BankReconciliationPanel;
