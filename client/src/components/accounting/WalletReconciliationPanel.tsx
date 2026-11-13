/**
 * Provider clearing workspace: unsettled wallet receipts, gross-to-net
 * settlements, and the provider statement import/matching surface.
 *
 * It is company-wide for the same reason as bank reconciliation: one provider
 * account receives every branch's receipts and settles once. Branch remains a
 * posting dimension on the original receipt.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Link2, RefreshCw, Upload, Wallet } from 'lucide-react';
import { StatCard } from '../common/StatCard';
import { useActivationKey, useTabActive } from '../common/KeepMounted';
import { api } from '../../services/api';
import type {
  SettlementAccount,
  WalletPendingReceipt,
  WalletReconciliationResponse,
} from '../../services/api/accounting';
import type { User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { money } from './statementFormat';

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function todayAD(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface WalletReconciliationPanelProps {
  branchId: string;
  to: string;
  dateMode: 'BS' | 'AD';
  currentUser?: User | null;
}

export const WalletReconciliationPanel: React.FC<WalletReconciliationPanelProps> = ({
  branchId,
  to,
  dateMode,
  currentUser,
}) => {
  const [data, setData] = useState<WalletReconciliationResponse | null>(null);
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState(() => monthStart(to));
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [banks, setBanks] = useState<SettlementAccount[]>([]);
  const [settling, setSettling] = useState<WalletPendingReceipt | null>(null);
  const [settleBankId, setSettleBankId] = useState('');
  const [settleDate, setSettleDate] = useState(todayAD());
  const [settleGross, setSettleGross] = useState('');
  const [settleFee, setSettleFee] = useState('0');
  const [settleReference, setSettleReference] = useState('');
  const [importContent, setImportContent] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const [importErrors, setImportErrors] = useState<Array<{ row: number; message: string }>>([]);
  const activationKey = useActivationKey('accounting-cash-book');
  const isVisible = useTabActive('accounting-cash-book');
  const canWrite = isOperationAllowed('gl-cash-close', currentUser?.role);

  useEffect(() => {
    if (!to) return;
    setFrom((current) => (current && current <= to ? current : monthStart(to)));
  }, [to]);

  useEffect(() => {
    let live = true;
    api.getSettlementAccounts()
      .then((rows) => {
        if (live) setBanks((Array.isArray(rows) ? rows : []).filter((row) => row.accountKind === 'BANK'));
      })
      .catch(() => {
        if (live) setBanks([]);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!isVisible || branchId !== 'ALL' || !to || from > to) return;
    let live = true;
    setLoading(true);
    setError('');
    void api
      .getWalletReconciliation({ accountId: accountId || undefined, from, to })
      .then((next) => {
        if (!live) return;
        setData(next);
        if (!accountId && next.account?.accountId) setAccountId(next.account.accountId);
      })
      .catch((err: any) => {
        if (!live) return;
        setError(err?.message || 'Failed to load provider reconciliation.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [isVisible, branchId, accountId, from, to, activationKey, reloadKey]);

  useEffect(() => {
    if (settling) {
      setSettleGross(String(settling.outstandingGross));
      setSettleFee('0');
      setSettleReference('');
      setSettleDate(todayAD());
      setSettleBankId(
        banks.find((bank) => bank.postingRole === 'BANK')?.id ||
          data?.account?.settlementAccountId ||
          banks[0]?.id ||
          ''
      );
    }
  }, [settling, banks, data?.account?.settlementAccountId]);

  const actionContext = useMemo(
    () => ({
      accountId: data?.account?.accountId || accountId,
      from: data?.from || from,
      to: data?.to || to,
    }),
    [data?.account?.accountId, data?.from, data?.to, accountId, from, to]
  );

  async function runAction<T extends { workspace: WalletReconciliationResponse }>(
    action: () => Promise<T>,
    successMessage = ''
  ) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await action();
      setData(result.workspace);
      if (successMessage) setMessage(successMessage);
    } catch (err: any) {
      setError(err?.message || 'The provider reconciliation action failed.');
    } finally {
      setBusy(false);
    }
  }

  const submitSettlement = async () => {
    if (!settling) return;
    const gross = Number(settleGross);
    const fee = Number(settleFee) || 0;
    if (!Number.isFinite(gross) || gross <= 0) {
      setError('Settlement gross must be greater than zero.');
      return;
    }
    if (fee < 0 || fee >= gross) {
      setError('The fee must be at least 0 and less than gross.');
      return;
    }
    if (!settleBankId) {
      setError('Choose the bank account that received the settlement.');
      return;
    }
    await runAction(
      () =>
        api.createPaymentSettlement({
          customerPaymentId: settling.id,
          bankAccountId: settleBankId,
          settlementDateAD: settleDate,
          grossAmount: gross,
          feeAmount: fee,
          providerReference: settleReference.trim() || undefined,
          ...actionContext,
        }),
      `Settled NPR ${money(gross)} from ${settling.paymentNumber}.`
    );
    setSettling(null);
  };

  const importStatement = async () => {
    if (!accountId) {
      setError('Choose a wallet account first.');
      return;
    }
    setImportMessage('');
    setImportErrors([]);
    setBusy(true);
    setError('');
    try {
      const result = await api.importProviderStatement({
        accountId,
        content: importContent,
        from,
        to,
      });
      setData(result.workspace);
      setImportMessage(
        `Imported ${result.imported} line(s), ${result.duplicates} duplicate(s); ${result.autoMatched} auto-matched.`
      );
      setImportErrors(result.errors || []);
      setImportContent('');
    } catch (err: any) {
      setError(err?.message || 'The provider statement could not be imported.');
    } finally {
      setBusy(false);
    }
  };

  const matchLine = async (lineId: string, settlementId: string) => {
    await runAction(
      () => api.matchProviderStatementLine(lineId, settlementId, actionContext),
      'Provider statement line matched.'
    );
  };

  if (branchId !== 'ALL') {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-6 text-center text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-300">
        Wallet reconciliation is company-wide because every branch posts to the same provider clearing account. Switch the branch selector to All Branches.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40 md:grid-cols-4">
        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">
          Wallet account
          <select
            aria-label="Wallet reconciliation account"
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
                {account.providerCode ? ` · ${account.providerCode}` : ''}
                {!account.isActive ? ' (inactive)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">
          Period start (AD)
          <input
            aria-label="Wallet reconciliation period start"
            type="date"
            value={from}
            max={to}
            onChange={(event) => setFrom(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
          />
        </label>
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-snug text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
          Period end <span className="font-semibold text-slate-700 dark:text-slate-200">{formatDualDate(to, dateMode)}</span>
          <br />Company-wide · {data?.account?.providerCode || 'provider'} clearing
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((key) => key + 1)}
          disabled={loading || busy}
          className="ml-auto flex items-center gap-1.5 self-center rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-200 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {message && (
        <div role="status" className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300">
          {message}
        </div>
      )}
      {loading && !data && (
        <div role="status" className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
          Loading provider clearing…
        </div>
      )}

      {!loading && data && data.accounts.length === 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-8 text-center text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
          <Wallet className="mx-auto mb-2 h-7 w-7 text-slate-300 dark:text-slate-600" />
          No WALLET clearing ledger is available. Add one in the chart of accounts first.
        </div>
      )}

      {data?.account && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="CLEARING BALANCE" value={money(data.summary.ledgerClosing)} tone="indigo" hint="Posted wallet-ledger balance" />
            <StatCard label="UNSETTLED GROSS" value={money(data.summary.unsettledGross)} tone="amber" hint="Gross receipts less every posted settlement" />
            <StatCard
              label="DIFFERENCE"
              value={money(data.summary.difference)}
              tone={data.summary.reconciled ? 'emerald' : 'rose'}
              hint="Clearing balance minus unsettled gross"
            />
            <StatCard
              label="UNMATCHED PROVIDER"
              value={String(data.statement.unmatchedCount)}
              tone={data.statement.unmatchedCount ? 'rose' : 'emerald'}
              hint={`${money(data.statement.unmatchedAmount)} net still unmatched`}
            />
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] dark:border-slate-800 dark:bg-slate-900/40 lg:grid-cols-5">
            <div><span className="block text-slate-400">Gross receipts</span><span className="font-mono font-bold">{money(data.summary.grossReceipts)}</span></div>
            <div><span className="block text-slate-400">Settled gross</span><span className="font-mono font-bold">{money(data.summary.settledGross)}</span></div>
            <div><span className="block text-slate-400">Fees</span><span className="font-mono font-bold">{money(data.summary.fees)}</span></div>
            <div><span className="block text-slate-400">Bank net</span><span className="font-mono font-bold">{money(data.summary.netBanked)}</span></div>
            <div>
              <span className="block text-slate-400">Tie-out</span>
              <span className={`font-semibold ${data.summary.reconciled ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
                {data.summary.reconciled ? 'Clearing = unsettled gross' : 'Needs investigation'}
              </span>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
            <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
              <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Receipts awaiting settlement</h3>
              <span className="text-[11px] text-slate-500">{data.pending.length} receipt(s)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
                  <tr>
                    <th className="px-2.5 py-1.5">Receipt</th>
                    <th className="px-2.5 py-1.5">Customer</th>
                    <th className="px-2.5 py-1.5">Date</th>
                    <th className="px-2.5 py-1.5">Provider ref</th>
                    <th className="px-2.5 py-1.5 text-right">Gross</th>
                    <th className="px-2.5 py-1.5 text-right">Settled</th>
                    <th className="px-2.5 py-1.5 text-right">Outstanding</th>
                    {canWrite && <th className="px-2.5 py-1.5 text-right">Action</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium dark:divide-slate-800/60">
                  {data.pending.length === 0 ? (
                    <tr><td colSpan={canWrite ? 8 : 7} className="px-3 py-4 text-center text-slate-400">Every wallet receipt is settled.</td></tr>
                  ) : data.pending.map((receipt) => (
                    <tr key={receipt.id}>
                      <td className="px-2.5 py-1.5 font-mono text-[11px]">{receipt.paymentNumber}</td>
                      <td className="px-2.5 py-1.5">{receipt.customerName}</td>
                      <td className="px-2.5 py-1.5 font-mono text-[11px]">{formatDualDate(receipt.paymentDateAD, dateMode)}</td>
                      <td className="px-2.5 py-1.5 font-mono text-[10px]">{receipt.providerTransactionId || '—'}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono">{money(receipt.grossAmount)}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono">{money(receipt.settledGross)}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono font-bold">{money(receipt.outstandingGross)}</td>
                      {canWrite && (
                        <td className="px-2.5 py-1.5 text-right">
                          <button type="button" onClick={() => setSettling(receipt)} className="rounded-lg border border-indigo-300 px-2 py-1 text-[10px] font-bold text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500/40 dark:text-indigo-300 dark:hover:bg-indigo-950/30">
                            Settle
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {settling && canWrite && (
            <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-500/30 dark:bg-indigo-950/20">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-bold text-indigo-900 dark:text-indigo-200">Settle {settling.paymentNumber}</h3>
                <button type="button" onClick={() => setSettling(null)} className="text-[11px] font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Cancel</button>
              </div>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-6">
                <label className="text-[10px] font-semibold text-slate-500">Bank account
                  <select value={settleBankId} onChange={(event) => setSettleBankId(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-900 dark:text-white">
                    <option value="">Choose bank</option>
                    {banks.map((bank) => <option key={bank.id} value={bank.id}>{bank.code} · {bank.name}</option>)}
                  </select>
                </label>
                <label className="text-[10px] font-semibold text-slate-500">Date
                  <input type="date" value={settleDate} onChange={(event) => setSettleDate(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-900 dark:text-white" />
                </label>
                <label className="text-[10px] font-semibold text-slate-500">Gross
                  <input type="number" min="0.01" step="0.01" value={settleGross} onChange={(event) => setSettleGross(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-mono dark:border-slate-600 dark:bg-slate-900 dark:text-white" />
                </label>
                <label className="text-[10px] font-semibold text-slate-500">Fee
                  <input type="number" min="0" step="0.01" value={settleFee} onChange={(event) => setSettleFee(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-mono dark:border-slate-600 dark:bg-slate-900 dark:text-white" />
                </label>
                <label className="text-[10px] font-semibold text-slate-500">Provider ref
                  <input value={settleReference} onChange={(event) => setSettleReference(event.target.value)} placeholder="batch reference" className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-900 dark:text-white" />
                </label>
                <div className="flex items-end">
                  <button type="button" onClick={submitSettlement} disabled={busy} className="w-full rounded-lg bg-indigo-600 px-2 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
                    Post net {money(Math.max(0, (Number(settleGross) || 0) - (Number(settleFee) || 0)))}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
            <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
              <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Provider settlements in this period</h3>
              <span className="text-[11px] text-slate-500">{data.settlements.length} settlement(s)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
                  <tr>
                    <th className="px-2.5 py-1.5">Settlement</th><th className="px-2.5 py-1.5">Receipt</th><th className="px-2.5 py-1.5">Bank</th>
                    <th className="px-2.5 py-1.5 text-right">Gross</th><th className="px-2.5 py-1.5 text-right">Fee</th><th className="px-2.5 py-1.5 text-right">Net</th><th className="px-2.5 py-1.5">Provider ref</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium dark:divide-slate-800/60">
                  {data.settlements.length === 0 ? (
                    <tr><td colSpan={7} className="px-3 py-4 text-center text-slate-400">No provider settlement in this period.</td></tr>
                  ) : data.settlements.map((settlement) => (
                    <tr key={settlement.id}>
                      <td className="px-2.5 py-1.5 font-mono text-[11px]">{settlement.settlementNumber}</td>
                      <td className="px-2.5 py-1.5 font-mono text-[11px]">{settlement.paymentNumber}</td>
                      <td className="px-2.5 py-1.5">{settlement.bankAccountCode}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono">{money(settlement.grossAmount)}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono">{money(settlement.feeAmount)}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono">{money(settlement.netAmount)}</td>
                      <td className="px-2.5 py-1.5 font-mono text-[10px]">{settlement.providerReference || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Provider statement</h3>
              <span className="text-[11px] text-slate-500">{data.statement.matchedCount} matched · {data.statement.unmatchedCount} unmatched</span>
            </div>
            {canWrite && (
              <div className="mb-3 space-y-2">
                <textarea
                  aria-label="Provider statement content"
                  value={importContent}
                  onChange={(event) => setImportContent(event.target.value)}
                  rows={3}
                  placeholder="Paste provider CSV (date, description, reference, amount = net deposit) or OFX content"
                  className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 font-mono text-[11px] dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={importStatement} disabled={busy || !importContent.trim()} className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
                    <Upload className="h-3.5 w-3.5" /> Import & auto-match
                  </button>
                  {importMessage && <span className="text-[11px] text-emerald-700 dark:text-emerald-400">{importMessage}</span>}
                  {importErrors.map((issue) => <span key={`${issue.row}-${issue.message}`} className="text-[11px] text-rose-700 dark:text-rose-400">Row {issue.row}: {issue.message}</span>)}
                </div>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
                  <tr>
                    <th className="px-2.5 py-1.5">Date</th><th className="px-2.5 py-1.5">Description</th><th className="px-2.5 py-1.5">Reference</th>
                    <th className="px-2.5 py-1.5 text-right">Net deposit</th><th className="px-2.5 py-1.5">Matched settlement</th><th className="px-2.5 py-1.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium dark:divide-slate-800/60">
                  {data.lines.length === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-4 text-center text-slate-400">No provider statement lines in this period.</td></tr>
                  ) : data.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="px-2.5 py-1.5 font-mono text-[11px]">{formatDualDate(line.statementDate, dateMode)}</td>
                      <td className="px-2.5 py-1.5">{line.description}</td>
                      <td className="px-2.5 py-1.5 font-mono text-[10px]">{line.reference || '—'}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono">{money(line.amount)}</td>
                      <td className="px-2.5 py-1.5 font-mono text-[10px]">
                        {line.matchedSettlementNumber ? `${line.matchedSettlementNumber} · ${money(line.matchedSettlementNet || 0)}` : '—'}
                      </td>
                      <td className="px-2.5 py-1.5 text-right">
                        {!line.matchedSettlementId && canWrite && line.suggestedSettlementId ? (
                          <button
                            type="button"
                            onClick={() => matchLine(line.id, line.suggestedSettlementId!)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 rounded-lg border border-indigo-300 px-2 py-1 text-[10px] font-bold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-500/40 dark:text-indigo-300 dark:hover:bg-indigo-950/30"
                          >
                            <Link2 className="h-3 w-3" /> Match
                          </button>
                        ) : line.matchedSettlementId ? (
                          <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">Matched</span>
                        ) : (
                          <span className="text-[10px] text-slate-400">No suggestion</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default WalletReconciliationPanel;
