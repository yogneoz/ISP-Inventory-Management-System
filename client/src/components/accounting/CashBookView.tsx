import React from 'react';
import { KpiStrip } from '../common/KpiStrip';
import type { CashBookResponse } from '../../services/api/accounting';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { money } from './statementFormat';
import { JournalLink } from './VoucherDetailDialog';

export const CashBookView: React.FC<{
  data: CashBookResponse;
  dateMode: 'BS' | 'AD';
  onOpenVoucher?: (journalId: string) => void;
}> = ({ data, dateMode, onOpenVoucher }) => {
  const companyBook = data.book === 'BANK' || data.book === 'WALLET';
  const label = data.book === 'BANK' ? 'bank' : data.book === 'WALLET' ? 'wallet clearing' : 'cash';
  return (
  <div className="space-y-4">
    <KpiStrip
      items={[
        { label: 'OPENING BALANCE', value: money(data.opening), tone: 'text-indigo-500 dark:text-indigo-400', hint: 'Before the period start' },
        { label: 'RECEIPTS', value: money(data.receipts), tone: 'text-emerald-500 dark:text-emerald-400', hint: companyBook ? 'Company-wide debits' : 'Branch debits to cash' },
        { label: 'PAYMENTS', value: money(data.payments), tone: 'text-rose-500 dark:text-rose-400', hint: companyBook ? 'Company-wide credits' : 'Branch credits to cash' },
        {
          label: 'CLOSING BALANCE',
          value: money(data.closing),
          tone: 'text-amber-500 dark:text-amber-400',
          hint: companyBook ? 'Company balance per account' : 'Branch till closing',
        },
      ]}
    />
    {companyBook && (
      <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-[11px] font-medium text-indigo-800 dark:border-indigo-500/40 dark:bg-indigo-950/30 dark:text-indigo-300">
        Company {label} balance {money(data.closing)} · selected-branch movement{' '}
        {money(data.branchMovement)} ({money(data.branchReceipts)} in, {money(data.branchPayments)} out).
        A branch filter never splits the external account balance.
      </div>
    )}

    {data.accounts.length === 0 ? (
      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-8 text-center text-xs text-slate-400 dark:border-slate-800 dark:bg-slate-900/40">
        No {label} account carries a posted balance for this branch and date.
      </div>
    ) : (
      data.accounts.map((account) => (
        <div
          key={account.accountId}
          className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
            <div>
              <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">
                <span className="mr-2 font-mono text-[11px] text-slate-400">{account.code}</span>
                {account.name}
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {account.accountKind || account.postingRole || 'CUSTODY'}
                {account.providerCode ? ` · ${account.providerCode}` : ''}
                {account.isShared ? ' · shared' : account.branchCode ? ` · owner ${account.branchCode}` : ''}
                {account.bankName ? ` · ${account.bankName}` : ''}
                {account.accountNumber ? ` · ${account.accountNumber}` : ''}
                {' · '}opening {money(account.opening)} · receipts {money(account.receipts)} · payments {money(account.payments)}
              </p>
            </div>
            <span className="font-mono text-sm font-bold text-slate-900 dark:text-white">
              Closing {money(account.closing)}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
                <tr>
                  <th className="px-2.5 py-1.5">Date</th>
                  <th className="px-2.5 py-1.5">Journal</th>
                  <th className="px-2.5 py-1.5">Source</th>
                  {companyBook && <th className="px-2.5 py-1.5">Branch</th>}
                  <th className="px-2.5 py-1.5">Memo</th>
                  <th className="px-2.5 py-1.5 text-right">Receipt</th>
                  <th className="px-2.5 py-1.5 text-right">Payment</th>
                  <th className="px-2.5 py-1.5 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium dark:divide-slate-800/60">
                {account.entries.length === 0 ? (
                  <tr>
                    <td colSpan={companyBook ? 8 : 7} className="px-3 py-4 text-center text-slate-400">
                      No {label} movement in this period.
                    </td>
                  </tr>
                ) : (
                  account.entries.map((entry, index) => (
                    <tr key={`${entry.journalNo}-${index}`} className="text-slate-800 dark:text-slate-300">
                      <td className="px-2.5 py-1.5 font-mono text-[11px]">{formatDualDate(entry.journalDateAD, dateMode)}</td>
                      <td className="px-2.5 py-1.5 font-mono text-[11px] text-indigo-600 dark:text-indigo-400">
                        {onOpenVoucher && entry.journalId ? (
                          <JournalLink
                            journalId={entry.journalId}
                            journalNo={entry.journalNo}
                            onOpen={onOpenVoucher}
                          />
                        ) : (
                          entry.journalNo
                        )}
                      </td>
                      <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400">{entry.sourceType}</td>
                      {companyBook && (
                        <td className="px-2.5 py-1.5 font-mono text-[10px] text-slate-500 dark:text-slate-400">
                          {entry.branchCode || entry.branchId}
                        </td>
                      )}
                      <td className="max-w-[18rem] truncate px-2.5 py-1.5 text-slate-500 dark:text-slate-400">{entry.memo || '—'}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono text-emerald-600 dark:text-emerald-400">
                        {entry.debit ? money(entry.debit) : '—'}
                      </td>
                      <td className="px-2.5 py-1.5 text-right font-mono text-rose-600 dark:text-rose-400">
                        {entry.credit ? money(entry.credit) : '—'}
                      </td>
                      <td className="px-2.5 py-1.5 text-right font-mono">{money(entry.balance)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))
    )}
  </div>
  );
};
