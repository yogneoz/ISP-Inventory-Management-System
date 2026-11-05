import React, { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { api } from '../../services/api';
import type {
  StatementGroupBlock,
  StatementGroupDrilldownStatement,
  StatementGroupLinesResponse,
} from '../../services/api/accounting';
import { ModalPanel } from '../common/ModalPanel';
import { StatusPill } from './StatementPrimitives';
import { money } from './statementFormat';
import { JournalLink, VoucherDetailDialog } from './VoucherDetailDialog';

interface StatementGroupDrilldownProps {
  group: StatementGroupBlock;
  statement: StatementGroupDrilldownStatement;
  branchId: string | null;
  from: string | null;
  to: string;
  onClose: () => void;
}

function statementName(statement: StatementGroupDrilldownStatement): string {
  return statement === 'PROFIT_AND_LOSS' ? 'Profit & loss' : 'Balance sheet';
}

function scopeName(branchId: string | null): string {
  if (branchId === 'ALL') return 'all branches';
  return branchId || 'no branch';
}

function lineDescription(entry: StatementGroupLinesResponse['entries'][number]): string {
  return entry.memo || entry.journalMemo || entry.sourceType.replace(/_/g, ' ');
}

/**
 * The POSTED journal lines behind one statement group subtotal.
 *
 * Opens from a group heading in the profit-and-loss or balance-sheet register.
 * The request carries the exact statement mode, branch and window that produced
 * the figure on screen, and the server returns totals over every matching line
 * (not just the displayed page). The footer compares those totals with the
 * subtotal the group was opened from, so a drift between the statement and the
 * ledger is visible instead of silently trusted.
 */
export const StatementGroupDrilldown: React.FC<StatementGroupDrilldownProps> = ({
  group,
  statement,
  branchId,
  from,
  to,
  onClose,
}) => {
  const [data, setData] = useState<StatementGroupLinesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    setData(null);
    void api
      .getStatementGroupLines({
        statement,
        groupId: group.groupId,
        branchId: branchId && branchId !== 'ALL' ? branchId : undefined,
        from: from || undefined,
        to,
        limit: 500,
      })
      .then((next) => {
        if (live) setData(next);
      })
      .catch((err: any) => {
        if (live) setError(err?.message || 'Failed to load the journal lines for this group.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [statement, group.groupId, branchId, from, to, reloadKey]);

  const subtitle =
    statement === 'PROFIT_AND_LOSS'
      ? `${statementName(statement)} · ${scopeName(branchId)} · ${from || 'from inception'} → ${to}`
      : `${statementName(statement)} · ${scopeName(branchId)} · as of ${to}`;
  const expected = group.amount;
  const lineTotal = data?.totals.amount ?? 0;
  const difference = data ? Math.round((lineTotal - expected) * 100) / 100 : 0;
  const ties = Boolean(data) && Math.abs(difference) < 0.005;

  return (
    <>
    <div className="fixed inset-0 z-[95] flex items-start justify-center overflow-y-auto bg-slate-950/70 p-4 backdrop-blur-sm">
      <ModalPanel
        label={`Journal lines for ${group.groupCode} ${group.groupName}`}
        onClose={onClose}
        className="my-8 w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-800 shadow-2xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold">
              <span className="mr-2 font-mono text-xs text-slate-400">{group.groupCode}</span>
              {group.groupName}
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
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
                  <tr>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Journal</th>
                    <th className="px-3 py-2">Account</th>
                    <th className="px-3 py-2">Description</th>
                    <th className="px-3 py-2 text-right">Debit</th>
                    <th className="px-3 py-2 text-right">Credit</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {data.entries.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-slate-400">
                        No posted journal lines fall in this window for this group.
                      </td>
                    </tr>
                  ) : (
                    data.entries.map((entry) => (
                      <tr key={entry.id} className="align-top">
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                          {entry.journalDateAD}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <JournalLink
                            journalId={entry.journalId}
                            journalNo={entry.journalNo}
                            onOpen={setDetailId}
                          />
                          <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-slate-400">
                            {entry.sourceType.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="mr-2 font-mono text-[10px] text-slate-400">
                            {entry.accountCode}
                          </span>
                          {entry.accountName}
                        </td>
                        <td className="max-w-[260px] px-3 py-2 text-slate-600 dark:text-slate-400">
                          <span className="block break-words">{lineDescription(entry)}</span>
                          <span className="mt-0.5 block text-[10px] text-slate-400">
                            {entry.branchId}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-600 dark:text-slate-400">
                          {entry.debit > 0 ? money(entry.debit) : '—'}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-600 dark:text-slate-400">
                          {entry.credit > 0 ? money(entry.credit) : '—'}
                        </td>
                        <td
                          className={`whitespace-nowrap px-3 py-2 text-right font-mono font-bold ${
                            entry.amount < 0
                              ? 'text-rose-600 dark:text-rose-400'
                              : 'text-slate-800 dark:text-slate-200'
                          }`}
                        >
                          {money(entry.amount)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                <p>
                  {data.entries.length} of {data.totals.entryCount} posted line
                  {data.totals.entryCount === 1 ? '' : 's'} shown · debit{' '}
                  <span className="font-mono">{money(data.totals.debit)}</span> · credit{' '}
                  <span className="font-mono">{money(data.totals.credit)}</span>
                </p>
                {data.truncated && (
                  <p className="mt-0.5 font-semibold text-amber-600 dark:text-amber-400">
                    Only the first {data.limit} lines are listed; the totals cover every line.
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                <span>
                  Statement subtotal <span className="font-mono font-bold">{money(expected)}</span>
                  {' · '}line total{' '}
                  <span className="font-mono font-bold">{money(lineTotal)}</span>
                </span>
                {data && (
                  <StatusPill
                    ok={ties}
                    okLabel="Ties to statement subtotal"
                    badLabel={`Difference ${money(difference)}`}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </ModalPanel>
    </div>
    {detailId && <VoucherDetailDialog journalId={detailId} onClose={() => setDetailId(null)} />}
    </>
  );
};
