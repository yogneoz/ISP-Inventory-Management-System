/**
 * Party statement dialog for the AR/AP reporting surface. The aging row names
 * a party; this reads that party's posted subledger statement and shows the
 * control tie-out without leaving the report.
 */
import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ModalPanel } from '../common/ModalPanel';
import { api } from '../../services/api';
import type { LedgerLineDTO, PartyLedgerTieOut } from '../../services/api/sales';
import { money } from './statementFormat';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { StatusPill } from './StatementPrimitives';

interface StatementData {
  openingBalance: number;
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
  ledger: LedgerLineDTO[];
  tieOut: PartyLedgerTieOut;
}

export const PartyStatementDialog: React.FC<{
  type: 'AR' | 'AP';
  partyId: string;
  partyName: string;
  branchId?: string;
  asOf: string;
  dateMode: 'BS' | 'AD';
  onClose: () => void;
}> = ({ type, partyId, partyName, branchId, asOf, dateMode, onClose }) => {
  const [data, setData] = useState<StatementData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    const params = { toAd: asOf || undefined, branchId };
    const read =
      type === 'AR' ? api.getCustomerLedger(partyId, params) : api.getVendorLedger(partyId, params);
    void read
      .then((next: any) => {
        if (live) setData(next);
      })
      .catch((err: any) => {
        if (live) setError(err?.message || 'The party statement could not be read.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [type, partyId, branchId, asOf]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
      <ModalPanel
        label={`${partyName} statement`}
        onClose={onClose}
        className="max-h-[85vh] w-full max-w-4xl overflow-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              {partyName} · {type === 'AR' ? 'Customer statement' : 'Supplier statement'}
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Posted subledger statement through {formatDualDate(asOf, dateMode)}.
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {error && (
          <p className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300">
            {error}
          </p>
        )}

        {loading && (
          <p className="mt-4 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Reading statement…
          </p>
        )}

        {data && (
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              {[
                ['Opening', data.openingBalance],
                ['Debit', data.totalDebit],
                ['Credit', data.totalCredit],
                ['Closing', data.closingBalance],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border border-slate-200 px-2.5 py-2 dark:border-slate-800">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</p>
                  <p className="mt-0.5 font-mono font-bold text-slate-900 dark:text-white">{money(Number(value))}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300">
              <span>
                Control tie-out · {data.tieOut.controlAccountCode} {data.tieOut.controlAccountName} · party{' '}
                {money(data.tieOut.partyBalance)} · control {money(data.tieOut.controlBalance)} · all books{' '}
                {money(data.tieOut.subledgerBalance)} · difference {money(data.tieOut.difference)}
              </span>
              <StatusPill
                ok={data.tieOut.status === 'RECONCILED'}
                okLabel="Reconciled"
                badLabel="Difference"
              />
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
                  <tr>
                    <th className="px-2.5 py-1.5">Date</th>
                    <th className="px-2.5 py-1.5">Document</th>
                    <th className="px-2.5 py-1.5">Type</th>
                    <th className="px-2.5 py-1.5 text-right">Debit</th>
                    <th className="px-2.5 py-1.5 text-right">Credit</th>
                    <th className="px-2.5 py-1.5 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium dark:divide-slate-800/60">
                  {data.ledger.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-4 text-center text-slate-400">
                        No posted statement lines for this party.
                      </td>
                    </tr>
                  ) : (
                    data.ledger.map((line) => (
                      <tr key={line.id} className="text-slate-800 dark:text-slate-300">
                        <td className="px-2.5 py-1.5 font-mono text-[11px]">{formatDualDate(line.dateAD, dateMode)}</td>
                        <td className="px-2.5 py-1.5">{line.documentNumber}</td>
                        <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400">{line.type}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono">{line.debit ? money(line.debit) : '—'}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono">{line.credit ? money(line.credit) : '—'}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono">{money(line.balance)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </ModalPanel>
    </div>
  );
};
