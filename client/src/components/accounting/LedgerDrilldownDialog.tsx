import React, { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { api } from '../../services/api';
import type {
  BudgetVarianceLinesResponse,
  CashBookEntry,
  StatementGroupBlock,
  StatementGroupDrilldownStatement,
} from '../../services/api/accounting';
import { ModalPanel } from '../common/ModalPanel';
import { JournalLink, VoucherDetailDialog } from './VoucherDetailDialog';
import { money } from './statementFormat';

type CashBookDrillEntry = CashBookEntry & {
  accountCode: string;
  accountName: string;
};

type BudgetTieOut = BudgetVarianceLinesResponse['tieOut'];

export type LedgerDrilldownRequest =
  | {
      kind: 'statement-groups';
      title: string;
      subtitle: string;
      statement: StatementGroupDrilldownStatement;
      groups: StatementGroupBlock[];
      branchId?: string | null;
      from?: string | null;
      to: string;
    }
  | {
      kind: 'accounts';
      title: string;
      subtitle: string;
      accountIds: string[];
      branchId?: string | null;
      from?: string | null;
      to: string;
    }
  | {
      kind: 'budget-account';
      title: string;
      subtitle: string;
      fiscalYearId: string;
      accountId: string;
      branchId?: string | null;
      from?: string | null;
      to: string;
    }
  | {
      kind: 'cash-book';
      title: string;
      subtitle: string;
      entries: CashBookDrillEntry[];
    };

interface DrillLine {
  id: string;
  date: string;
  journalId: string;
  journalNo: string;
  accountCode: string;
  accountName: string;
  sourceType: string;
  branchId: string;
  memo: string;
  debit: number;
  credit: number;
  net: number;
  window?: string;
}

const n = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const lineId = (entry: {
  id?: string;
  journalId: string;
  journalNo: string;
  accountCode: string;
  lineNo?: number;
}) =>
  entry.id ||
  `${entry.journalId}-${entry.journalNo}-${entry.accountCode}-${entry.lineNo ?? ''}`;

const fromStatementEntry = (
  entry: {
    id: string;
    journalDateAD: string;
    journalId: string;
    journalNo: string;
    accountCode: string;
    accountName: string;
    sourceType: string;
    branchId: string;
    memo: string | null;
    journalMemo: string | null;
    debit: number;
    credit: number;
    amount: number;
  }
): DrillLine => ({
  id: entry.id,
  date: entry.journalDateAD,
  journalId: entry.journalId,
  journalNo: entry.journalNo,
  accountCode: entry.accountCode,
  accountName: entry.accountName,
  sourceType: entry.sourceType,
  branchId: entry.branchId,
  memo: entry.memo || entry.journalMemo || entry.sourceType.replace(/_/g, ' '),
  debit: n(entry.debit),
  credit: n(entry.credit),
  net: n(entry.amount),
});

const fromAccountEntry = (
  entry: {
    id: string;
    journalDateAD: string;
    journalId: string;
    journalNo: string;
    accountCode: string;
    accountName: string;
    sourceType: string;
    branchId: string;
    memo: string | null;
    journalMemo: string | null;
    debit: number;
    credit: number;
    window: string;
  }
): DrillLine => ({
  id: entry.id,
  date: entry.journalDateAD,
  journalId: entry.journalId,
  journalNo: entry.journalNo,
  accountCode: entry.accountCode,
  accountName: entry.accountName,
  sourceType: entry.sourceType,
  branchId: entry.branchId,
  memo: entry.memo || entry.journalMemo || entry.sourceType.replace(/_/g, ' '),
  debit: n(entry.debit),
  credit: n(entry.credit),
  net: n(entry.debit) - n(entry.credit),
  window: entry.window,
});

const fromCashBookEntry = (entry: CashBookDrillEntry): DrillLine => ({
  id: lineId(entry),
  date: entry.journalDateAD,
  journalId: entry.journalId,
  journalNo: entry.journalNo,
  accountCode: entry.accountCode,
  accountName: entry.accountName,
  sourceType: entry.sourceType,
  branchId: entry.branchId,
  memo: entry.memo || entry.sourceType || entry.journalNo,
  debit: n(entry.debit),
  credit: n(entry.credit),
  net: n(entry.debit) - n(entry.credit),
});

const fromBudgetEntry = (
  entry: BudgetVarianceLinesResponse['entries'][number]
): DrillLine => ({
  id: entry.id,
  date: entry.journalDateAD,
  journalId: entry.journalId,
  journalNo: entry.journalNo,
  accountCode: entry.accountCode,
  accountName: entry.accountName,
  sourceType: entry.sourceType,
  branchId: entry.branchId,
  memo: entry.memo || entry.journalMemo || entry.sourceType.replace(/_/g, ' '),
  debit: n(entry.debit),
  credit: n(entry.credit),
  net: n(entry.amount),
});

export const LedgerDrilldownDialog: React.FC<{
  request: LedgerDrilldownRequest;
  onClose: () => void;
}> = ({ request, onClose }) => {
  const [lines, setLines] = useState<DrillLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [budgetTieOut, setBudgetTieOut] = useState<BudgetTieOut | null>(null);

  useEffect(() => {
    let live = true;
    setError('');
    setDetailId(null);
    setBudgetTieOut(null);

    if (request.kind === 'cash-book') {
      setLines(request.entries.map(fromCashBookEntry));
      setLoading(false);
      return () => {
        live = false;
      };
    }

    setLoading(true);
    setLines([]);
    const branchId = request.branchId && request.branchId !== 'ALL' ? request.branchId : undefined;
    const from = request.from || undefined;

    const load = async () => {
      try {
        if (request.kind === 'budget-account') {
          const response = await api.getAccountingBudgetVarianceLines({
            fiscalYearId: request.fiscalYearId,
            accountId: request.accountId,
            branchId,
            from,
            to: request.to,
            limit: 500,
          });
          if (!live) return;
          setLines(response.entries.map(fromBudgetEntry));
          setBudgetTieOut(response.tieOut);
        } else if (request.kind === 'statement-groups') {
          const responses = await Promise.all(
            request.groups.map((group) =>
              api.getStatementGroupLines({
                statement: request.statement,
                groupId: group.groupId,
                branchId,
                from,
                to: request.to,
                limit: 500,
              })
            )
          );
          if (!live) return;
          setLines(responses.flatMap((response) => response.entries.map(fromStatementEntry)));
        } else {
          const responses = await Promise.all(
            request.accountIds.map((accountId) =>
              api.getTrialBalanceAccountLines({
                accountId,
                branchId,
                from,
                to: request.to,
                limit: 500,
              })
            )
          );
          if (!live) return;
          setLines(responses.flatMap((response) => response.entries.map(fromAccountEntry)));
        }
      } catch (err: any) {
        if (!live) return;
        setError(err?.message || 'The posted ledger lines could not be loaded.');
      } finally {
        if (live) setLoading(false);
      }
    };

    void load();
    return () => {
      live = false;
    };
  }, [request, reloadKey]);

  const totalDebit = lines.reduce((sum, line) => sum + line.debit, 0);
  const totalCredit = lines.reduce((sum, line) => sum + line.credit, 0);
  const netLabel =
    request.kind === 'statement-groups'
      ? 'Amount'
      : request.kind === 'budget-account'
        ? 'Actual'
        : 'Net';

  return (
    <>
      <div className="fixed inset-0 z-[95] flex items-start justify-center overflow-y-auto bg-slate-950/70 p-4 backdrop-blur-sm">
        <ModalPanel
          label={request.title}
          onClose={onClose}
          className="my-8 w-full max-w-6xl overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-800 shadow-2xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        >
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-bold">{request.title}</h3>
              <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{request.subtitle}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close posted ledger lines"
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
              <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading posted journal lines…
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 border-b border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300"
            >
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
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

          {!loading && !error && (
            <>
              <div className="max-h-[65vh] overflow-auto">
                <table className="w-full min-w-[980px] text-left text-xs">
                  <thead className="sticky top-0 border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
                    <tr>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Journal</th>
                      <th className="px-3 py-2">Account</th>
                      <th className="px-3 py-2">Description</th>
                      <th className="px-3 py-2 text-right">Debit</th>
                      <th className="px-3 py-2 text-right">Credit</th>
                      <th className="px-3 py-2 text-right">{netLabel}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                    {lines.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                          No posted journal lines fall in this window.
                        </td>
                      </tr>
                    ) : (
                      lines.map((line) => (
                        <tr key={line.id} className="align-top">
                          <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                            {line.date}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            <JournalLink
                              journalId={line.journalId}
                              journalNo={line.journalNo}
                              onOpen={setDetailId}
                            />
                            <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-slate-400">
                              {line.window ? `${line.window} · ` : ''}
                              {line.sourceType.replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <span className="mr-2 font-mono text-[10px] text-slate-400">{line.accountCode}</span>
                            {line.accountName}
                          </td>
                          <td className="max-w-[280px] px-3 py-2 text-slate-600 dark:text-slate-400">
                            <span className="block break-words">{line.memo}</span>
                            <span className="mt-0.5 block text-[10px] text-slate-400">{line.branchId}</span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-600 dark:text-slate-400">
                            {line.debit > 0 ? money(line.debit) : '—'}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-600 dark:text-slate-400">
                            {line.credit > 0 ? money(line.credit) : '—'}
                          </td>
                          <td
                            className={`whitespace-nowrap px-3 py-2 text-right font-mono font-bold ${
                              line.net < 0
                                ? 'text-rose-600 dark:text-rose-400'
                                : 'text-slate-800 dark:text-slate-200'
                            }`}
                          >
                            {money(line.net)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {budgetTieOut && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] text-slate-500 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
                  <span>
                    Budget <span className="font-mono">{money(budgetTieOut.budget)}</span> · actual{' '}
                    <span className="font-mono">{money(budgetTieOut.actual)}</span> · lines{' '}
                    <span className="font-mono">{money(budgetTieOut.lineActual)}</span>
                  </span>
                  <span
                    className={
                      budgetTieOut.reconciled
                        ? 'font-semibold text-emerald-600 dark:text-emerald-400'
                        : 'font-semibold text-rose-600 dark:text-rose-400'
                    }
                  >
                    {budgetTieOut.reconciled
                      ? 'Ties to budget actual'
                      : `Difference ${money(budgetTieOut.difference)}`}
                  </span>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3 text-[11px] text-slate-500 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
                <span>
                  {lines.length} posted line{lines.length === 1 ? '' : 's'} · debit{' '}
                  <span className="font-mono">{money(totalDebit)}</span> · credit{' '}
                  <span className="font-mono">{money(totalCredit)}</span>
                </span>
                <span>Click a journal number to inspect the full voucher.</span>
              </div>
            </>
          )}
        </ModalPanel>
      </div>
      {detailId && <VoucherDetailDialog journalId={detailId} onClose={() => setDetailId(null)} />}
    </>
  );
};

export default LedgerDrilldownDialog;
