import React, { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { api } from '../../services/api';
import type {
  TrialBalanceAccount,
  TrialBalanceAccountLine,
  TrialBalanceAccountLinesResponse,
  TrialBalanceGroup,
  TrialBalanceGroupLine,
  TrialBalanceGroupLinesResponse,
} from '../../services/api/accounting';
import { ModalPanel } from '../common/ModalPanel';
import { StatusPill } from './StatementPrimitives';
import { money } from './statementFormat';

export type TrialBalanceDrilldownTarget =
  | { kind: 'GROUP'; group: TrialBalanceGroup }
  | { kind: 'ACCOUNT'; account: TrialBalanceAccount };

interface TrialBalanceDrilldownProps {
  target: TrialBalanceDrilldownTarget;
  branchId: string | null;
  from: string | null;
  to: string;
  onClose: () => void;
}

type FigureKey =
  | 'openingDebit'
  | 'openingCredit'
  | 'periodDebit'
  | 'periodCredit'
  | 'closingDebit'
  | 'closingCredit';

type Figures = Record<FigureKey, number>;
type DrilldownResponse = TrialBalanceGroupLinesResponse | TrialBalanceAccountLinesResponse;
type DrilldownLine = TrialBalanceGroupLine | TrialBalanceAccountLine;

const FIGURE_ROWS: { key: FigureKey; label: string }[] = [
  { key: 'openingDebit', label: 'Opening Dr' },
  { key: 'openingCredit', label: 'Opening Cr' },
  { key: 'periodDebit', label: 'Period Dr' },
  { key: 'periodCredit', label: 'Period Cr' },
  { key: 'closingDebit', label: 'Closing Dr' },
  { key: 'closingCredit', label: 'Closing Cr' },
];

function scopeName(branchId: string | null): string {
  if (branchId === 'ALL') return 'all branches';
  return branchId || 'no branch';
}

function lineDescription(entry: DrilldownLine): string {
  return entry.memo || entry.journalMemo || entry.sourceType.replace(/_/g, ' ');
}

function runningBalanceOf(entry: DrilldownLine): number | null {
  return 'runningBalance' in entry ? entry.runningBalance : null;
}

const LineTable: React.FC<{
  title: string;
  caption: string;
  entries: DrilldownLine[];
  totalCount: number;
  emptyMessage: string;
  showAccount: boolean;
  showRunningBalance: boolean;
  broughtForward?: number;
}> = ({
  title,
  caption,
  entries,
  totalCount,
  emptyMessage,
  showAccount,
  showRunningBalance,
  broughtForward,
}) => {
  const columnCount = 5 + (showAccount ? 1 : 0) + (showRunningBalance ? 1 : 0);

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 dark:border-slate-800 dark:bg-slate-900/60">
        <div>
          <h4 className="text-xs font-bold text-slate-700 dark:text-slate-200">{title}</h4>
          <p className="text-[10px] text-slate-500 dark:text-slate-400">{caption}</p>
        </div>
        <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
          {entries.length} of {totalCount} posted line{totalCount === 1 ? '' : 's'}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Journal</th>
              {showAccount && <th className="px-3 py-2">Account</th>}
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2 text-right">Debit</th>
              <th className="px-3 py-2 text-right">Credit</th>
              {showRunningBalance && (
                <th className="px-3 py-2 text-right">Running balance (Dr − Cr)</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
            {showRunningBalance && broughtForward !== undefined && (
              <tr className="bg-slate-50/70 font-semibold dark:bg-slate-900/50">
                <td colSpan={columnCount - 1} className="px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                  Opening balance b/f
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-700 dark:text-slate-200">
                  {money(broughtForward)}
                </td>
              </tr>
            )}
            {entries.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="px-3 py-4 text-center text-slate-400">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              entries.map((entry) => {
                const running = runningBalanceOf(entry);
                return (
                  <tr key={entry.id} className="align-top">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                      {entry.journalDateAD}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className="font-mono text-[11px] font-bold text-slate-700 dark:text-slate-300">
                        {entry.journalNo}
                      </span>
                      <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-slate-400">
                        {entry.sourceType.replace(/_/g, ' ')}
                      </span>
                    </td>
                    {showAccount && (
                      <td className="px-3 py-2">
                        <span className="mr-2 font-mono text-[10px] text-slate-400">
                          {entry.accountCode}
                        </span>
                        {entry.accountName}
                      </td>
                    )}
                    <td className="max-w-[280px] px-3 py-2 text-slate-600 dark:text-slate-400">
                      <span className="block break-words">{lineDescription(entry)}</span>
                      <span className="mt-0.5 block text-[10px] text-slate-400">{entry.branchId}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-600 dark:text-slate-400">
                      {entry.debit > 0 ? money(entry.debit) : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-600 dark:text-slate-400">
                      {entry.credit > 0 ? money(entry.credit) : '—'}
                    </td>
                    {showRunningBalance && (
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono font-semibold text-slate-700 dark:text-slate-200">
                        {running === null ? '—' : money(running)}
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {totalCount > entries.length && (
        <p className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-[10px] font-semibold text-amber-700 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-400">
          Only the first {entries.length} of {totalCount} lines in this section are listed; the
          subtotal still covers every line, and the running balance continues past this page.
        </p>
      )}
    </section>
  );
};

/**
 * The posted lines behind one trial-balance group subtotal or account row.
 *
 * Opens from a group heading or an account name in the trial-balance register.
 * The request carries the exact branch and window that produced the figures on
 * screen. Opening lines (before `from`) and period lines (`from`..`to`) are
 * listed separately; the footer compares the six trial-balance figures with the
 * independently totalled lines, so a drift between the statement and the ledger
 * is visible rather than silently trusted.
 *
 * Group rows net opening and closing per account before comparing, matching the
 * trial-balance columns. An account drill-down adds a debit-positive running
 * balance: opening lines run from zero, and period lines carry the opening
 * balance forward (the `Opening balance b/f` row) so the last line ties to the
 * closing figure.
 */
export const TrialBalanceDrilldown: React.FC<TrialBalanceDrilldownProps> = ({
  target,
  branchId,
  from,
  to,
  onClose,
}) => {
  const [data, setData] = useState<DrilldownResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const isAccount = target.kind === 'ACCOUNT';
  const subject = isAccount ? target.account : target.group;
  const figures: Figures = subject;
  const groupId = target.kind === 'GROUP' ? target.group.groupId : null;
  const accountId = target.kind === 'ACCOUNT' ? target.account.accountId : null;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    setData(null);
    const scope = {
      branchId: branchId && branchId !== 'ALL' ? branchId : undefined,
      from: from || undefined,
      to,
      limit: 500,
    };
    const request = groupId
      ? api.getTrialBalanceGroupLines({ groupId, ...scope })
      : api.getTrialBalanceAccountLines({ accountId: accountId!, ...scope });
    void request
      .then((next) => {
        if (live) setData(next);
      })
      .catch((err: any) => {
        if (live) {
          setError(
            err?.message ||
              (groupId
                ? 'Failed to load the journal lines for this group.'
                : 'Failed to load the journal lines for this account.')
          );
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [groupId, accountId, branchId, from, to, reloadKey]);

  const openingEntries = data?.entries.filter((entry) => entry.window === 'OPENING') ?? [];
  const periodEntries = data?.entries.filter((entry) => entry.window === 'PERIOD') ?? [];
  const differences = data
    ? FIGURE_ROWS.filter(({ key }) => Math.abs(data.totals[key] - figures[key]) >= 0.005)
    : [];
  const ties = Boolean(data) && differences.length === 0;
  const differenceText = differences
    .map(({ key, label }) => `${label} ${money(data!.totals[key] - figures[key])}`)
    .join(' · ');
  const subtitle = `Trial balance · ${isAccount ? 'account' : 'group'} · ${scopeName(branchId)} · ${
    from ? `${from} → ${to}` : `through ${to}`
  }`;

  return (
    <div className="fixed inset-0 z-[95] flex items-start justify-center overflow-y-auto bg-slate-950/70 p-4 backdrop-blur-sm">
      <ModalPanel
        label={`Posted journal lines for ${subject.code} ${subject.name}`}
        onClose={onClose}
        className="my-8 w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-800 shadow-2xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold">
              <span className="mr-2 font-mono text-xs text-slate-400">{subject.code}</span>
              {subject.name}
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close journal lines"
            className="shrink-0 rounded-lg p-1 text-slate-400 transition hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading && (
          <div
            role="status"
            className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400"
          >
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            Loading posted journal lines…
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 border-b border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300"
          >
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

        {data && (
          <>
            <LineTable
              title="Opening lines"
              caption={
                from
                  ? `Before ${from}${isAccount ? ' · running from zero' : ''}`
                  : 'Before the statement window'
              }
              entries={openingEntries}
              totalCount={data.totals.openingEntryCount}
              emptyMessage={
                from
                  ? `No POSTED lines fall before ${from} for this ${isAccount ? 'account' : 'group'}.`
                  : 'No opening window for this statement.'
              }
              showAccount={!isAccount}
              showRunningBalance={isAccount}
            />
            <LineTable
              title="Period lines"
              caption={from ? `${from} → ${to}` : `Through ${to}`}
              entries={periodEntries}
              totalCount={data.totals.periodEntryCount}
              emptyMessage={
                from
                  ? `No POSTED lines fall in ${from} → ${to} for this ${isAccount ? 'account' : 'group'}.`
                  : `No POSTED lines fall through ${to} for this ${isAccount ? 'account' : 'group'}.`
              }
              showAccount={!isAccount}
              showRunningBalance={isAccount}
              broughtForward={isAccount ? target.account.openingBalance : undefined}
            />

            <div className="border-t border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Trial balance / posted lines
                  </p>
                  <div className="mt-1 grid gap-x-6 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300 sm:grid-cols-2 lg:grid-cols-3">
                    {FIGURE_ROWS.map(({ key, label }) => (
                      <div key={key} className="flex items-center justify-between gap-3">
                        <span>{label}</span>
                        <span className="font-mono font-semibold">
                          {money(figures[key])}
                          <span className="mx-1 text-slate-400">/</span>
                          {money(data.totals[key])}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] leading-snug text-slate-400 dark:text-slate-500">
                    {isAccount
                      ? 'Running balance is debit-positive (Dr − Cr). Opening and closing are net per account; period debit and credit are posted turnover.'
                      : 'Opening and closing are net per account, matching the trial balance columns; period debit and credit are posted turnover.'}
                  </p>
                </div>
                <div className="flex max-w-sm flex-col items-end gap-1 text-right">
                  <StatusPill
                    ok={ties}
                    okLabel={isAccount ? 'Ties to trial balance account' : 'Ties to trial balance subtotal'}
                    badLabel="Differs from trial balance"
                  />
                  {!ties && (
                    <p className="text-[10px] font-semibold text-rose-600 dark:text-rose-400">
                      {differenceText}
                    </p>
                  )}
                  <p className="text-[10px] text-slate-400 dark:text-slate-500">
                    {data.totals.entryCount} posted line
                    {data.totals.entryCount === 1 ? '' : 's'} for this {isAccount ? 'account' : 'group'}.
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
      </ModalPanel>
    </div>
  );
};
