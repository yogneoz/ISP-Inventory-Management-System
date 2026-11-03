import React from 'react';
import { StatCard } from '../common/StatCard';
import type { AgingBucketKey, AgingResponse, AgingType } from '../../services/api/accounting';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { StatusPill } from './StatementPrimitives';
import { amountCell, money } from './statementFormat';

const AGING_BUCKET_KEYS: AgingBucketKey[] = [
  'CURRENT',
  'DAYS_1_30',
  'DAYS_31_60',
  'DAYS_61_90',
  'DAYS_90_PLUS',
];

export const AgingView: React.FC<{
  data: AgingResponse;
  type: AgingType;
  onTypeChange: (type: AgingType) => void;
  dateMode: 'BS' | 'AD';
}> = ({ data, type, onTypeChange, dateMode }) => {
  const outstandingLabel = type === 'AR' ? 'NET RECEIVABLE' : 'NET PAYABLE';
  const openItems = data.parties.flatMap((party) =>
    party.rows.map((row) => ({ partyName: party.partyName, row }))
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Aging report type">
          {(['AR', 'AP'] as AgingType[]).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={type === entry}
              onClick={() => onTypeChange(entry)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                type === entry
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
              }`}
            >
              {entry === 'AR' ? 'Receivables (AR)' : 'Payables (AP)'}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span>
            {data.account.code} · {data.account.name} · as of{' '}
            <span className="font-semibold text-slate-700 dark:text-slate-200">
              {formatDualDate(data.asOf, dateMode)}
            </span>
          </span>
          <StatusPill
            ok={data.totals.reconciled}
            okLabel="Ties to control account"
            badLabel={`Control difference ${money(data.totals.difference)}`}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="OPEN ITEMS"
          value={money(data.totals.grossTotal)}
          tone="indigo"
          hint={`${data.parties.length} part${data.parties.length === 1 ? 'y' : 'ies'} with an open item`}
        />
        <StatCard
          label="UNAPPLIED CREDITS"
          value={money(data.totals.unappliedCredit)}
          tone="amber"
          hint="Receipts/payments not yet matched to a charge"
        />
        <StatCard
          label={outstandingLabel}
          value={money(data.totals.total)}
          tone={type === 'AR' ? 'emerald' : 'rose'}
          hint="Open items less unapplied credits"
        />
        <StatCard
          label="CONTROL BALANCE"
          value={money(data.totals.controlBalance)}
          tone="indigo"
          hint={`${data.account.postingRole} · GL side for the same branch and date`}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
          <div>
            <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">
              {type === 'AR' ? 'Customer balances' : 'Supplier balances'}
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Open documents by days past due. Credits are applied oldest-first; an unmatched remainder is kept in its own column.
            </p>
          </div>
          <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
            difference {money(data.totals.difference)}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
              <tr>
                <th className="px-2.5 py-1.5">Party</th>
                <th className="px-2.5 py-1.5 text-right">Current</th>
                <th className="px-2.5 py-1.5 text-right">1–30</th>
                <th className="px-2.5 py-1.5 text-right">31–60</th>
                <th className="px-2.5 py-1.5 text-right">61–90</th>
                <th className="px-2.5 py-1.5 text-right">90+</th>
                <th className="px-2.5 py-1.5 text-right">Credits</th>
                <th className="px-2.5 py-1.5 text-right">Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium dark:divide-slate-800/60">
              {data.parties.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                  No open {type === 'AR' ? 'receivable' : 'payable'} items for this branch and date.
                  </td>
                </tr>
              ) : (
                data.parties.map((party) => (
                  <tr key={party.partyId} className="text-slate-800 dark:text-slate-300">
                    <td className="px-2.5 py-1.5 font-bold">
                      {party.partyName}
                      <span className="ml-2 font-mono text-[10px] text-slate-400">{party.partyId}</span>
                    </td>
                    {AGING_BUCKET_KEYS.map((key) => (
                      <td key={key} className="px-2.5 py-1.5 text-right font-mono">
                        {amountCell(party.buckets[key])}
                      </td>
                    ))}
                    <td className={`px-2.5 py-1.5 text-right font-mono ${party.unappliedCredit ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                      {amountCell(party.unappliedCredit)}
                    </td>
                    <td className={`px-2.5 py-1.5 text-right font-mono font-bold ${party.total < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                      {money(party.total)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot className="border-t border-slate-200 bg-slate-100 text-xs font-bold text-slate-800 dark:border-slate-800 dark:bg-slate-900/80 dark:text-slate-200">
              <tr>
                <td className="px-2.5 py-1.5 text-right uppercase tracking-wider">Totals</td>
                {AGING_BUCKET_KEYS.map((key) => (
                  <td key={key} className="px-2.5 py-1.5 text-right font-mono">
                    {money(data.totals[key])}
                  </td>
                ))}
                <td className="px-2.5 py-1.5 text-right font-mono">{money(data.totals.unappliedCredit)}</td>
                <td className="px-2.5 py-1.5 text-right font-mono">{money(data.totals.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
          <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Open documents and unapplied credits</h3>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Every row is a posted subledger line behind the buckets. An unmatched credit is listed with amount remaining.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
              <tr>
                <th className="px-2.5 py-1.5">Party</th>
                <th className="px-2.5 py-1.5">Item</th>
                <th className="px-2.5 py-1.5">Document date</th>
                <th className="px-2.5 py-1.5">Due date</th>
                <th className="px-2.5 py-1.5 text-right">Days</th>
                <th className="px-2.5 py-1.5">Bucket</th>
                <th className="px-2.5 py-1.5 text-right">Open</th>
                <th className="px-2.5 py-1.5">Journal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium dark:divide-slate-800/60">
              {openItems.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                    No posted open items for this branch and date.
                  </td>
                </tr>
              ) : (
                openItems.map(({ partyName, row }, index) => (
                  <tr
                    key={`${row.journalNo}-${row.kind}-${index}`}
                    className="text-slate-800 dark:text-slate-300"
                  >
                    <td className="px-2.5 py-1.5 font-bold">{partyName}</td>
                    <td className="px-2.5 py-1.5">
                      {row.kind === 'CREDIT' ? (
                        <span className="font-bold text-amber-600 dark:text-amber-400">Unapplied credit</span>
                      ) : (
                        <span>
                          {row.documentNo ? `${row.documentNo} · ` : ''}
                          {row.description}
                        </span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 font-mono text-[11px]">
                      {formatDualDate(row.documentDateAD, dateMode)}
                    </td>
                    <td className="px-2.5 py-1.5 font-mono text-[11px]">
                      {row.dueDateAD ? formatDualDate(row.dueDateAD, dateMode) : '—'}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono">
                      {row.daysPastDue === null ? '—' : row.daysPastDue}
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400">
                      {row.bucket
                        ? data.buckets.find((bucket) => bucket.key === row.bucket)?.label || row.bucket
                        : 'Unapplied'}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono">{money(row.amount)}</td>
                    <td className="px-2.5 py-1.5 font-mono text-[11px] text-indigo-600 dark:text-indigo-400">
                      {row.journalNo}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
