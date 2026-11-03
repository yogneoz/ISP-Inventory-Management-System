import React from 'react';
import { ChevronRight } from 'lucide-react';
import { StatCard } from '../common/StatCard';
import type {
  ControlAgreement,
  TrialBalanceAccount,
  TrialBalanceGroup,
  TrialBalanceResponse,
} from '../../services/api/accounting';
import { StatusPill } from './StatementPrimitives';
import { amountCell, money } from './statementFormat';

const toRow = (
  account: TrialBalanceAccount,
  depth: number,
  onOpenAccount?: (account: TrialBalanceAccount) => void
) => (
  <tr key={account.accountId} className="text-slate-800 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/40">
    <td className="px-2.5 py-1.5 font-mono text-[11px] text-indigo-600 dark:text-indigo-400">{account.code}</td>
    <td className="px-2.5 py-1.5 font-bold" style={{ paddingLeft: 8 + (depth + 1) * 16 }}>
      {onOpenAccount ? (
        <button
          type="button"
          onClick={() => onOpenAccount(account)}
          aria-label={`Open journal lines for ${account.code} ${account.name}`}
          className="-mx-1 flex w-full items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-indigo-50/70 dark:hover:bg-indigo-950/20"
        >
          {account.name}
          <ChevronRight className="h-3 w-3 shrink-0 text-slate-400" />
        </button>
      ) : (
        account.name
      )}
    </td>
    <td className="px-2.5 py-1.5 text-right font-mono">{amountCell(account.openingDebit)}</td>
    <td className="px-2.5 py-1.5 text-right font-mono">{amountCell(account.openingCredit)}</td>
    <td className="px-2.5 py-1.5 text-right font-mono">{amountCell(account.periodDebit)}</td>
    <td className="px-2.5 py-1.5 text-right font-mono">{amountCell(account.periodCredit)}</td>
    <td className="px-2.5 py-1.5 text-right font-mono">{amountCell(account.closingDebit)}</td>
    <td className="px-2.5 py-1.5 text-right font-mono">{amountCell(account.closingCredit)}</td>
  </tr>
);

const groupLabel = (group: TrialBalanceGroup, depth: number) => (
  <span
    className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300"
    style={{ paddingLeft: depth * 16 }}
  >
    {depth > 0 && <span className="text-slate-400">↳</span>}
    <span>
      {group.code} · {group.name}
    </span>
    {depth > 0 && (
      <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-slate-600 dark:bg-slate-700 dark:text-slate-300">
        sub-group
      </span>
    )}
  </span>
);

const toGroupRows = (
  group: TrialBalanceGroup,
  depth: number,
  onOpenGroup?: (group: TrialBalanceGroup) => void,
  onOpenAccount?: (account: TrialBalanceAccount) => void
): React.ReactNode[] => [
  <tr
    key={`group-${group.groupId}`}
    className={depth === 0 ? 'bg-slate-100 dark:bg-slate-800/60' : 'bg-slate-50 dark:bg-slate-800/40'}
  >
    <td colSpan={2} className="px-2.5 py-1.5">
      {onOpenGroup ? (
        <button
          type="button"
          onClick={() => onOpenGroup(group)}
          aria-label={`Open journal lines for ${group.code} ${group.name}`}
          className="-mx-1 flex w-full items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-indigo-50/70 dark:hover:bg-indigo-950/20"
        >
          {groupLabel(group, depth)}
          <ChevronRight className="h-3 w-3 shrink-0 text-slate-400" />
        </button>
      ) : (
        groupLabel(group, depth)
      )}
    </td>
    <td className="px-2.5 py-1.5 text-right font-mono">{amountCell(group.openingDebit)}</td>
    <td className="px-2.5 py-1.5 text-right font-mono">{amountCell(group.openingCredit)}</td>
    <td className="px-2.5 py-1.5 text-right font-mono">{amountCell(group.periodDebit)}</td>
    <td className="px-2.5 py-1.5 text-right font-mono">{amountCell(group.periodCredit)}</td>
    <td className="px-2.5 py-1.5 text-right font-mono">{amountCell(group.closingDebit)}</td>
    <td className="px-2.5 py-1.5 text-right font-mono">{amountCell(group.closingCredit)}</td>
  </tr>,
  ...group.accounts.map((account) => toRow(account, depth, onOpenAccount)),
  ...group.children.flatMap((child) => toGroupRows(child, depth + 1, onOpenGroup, onOpenAccount)),
];

export const TrialBalanceView: React.FC<{
  data: TrialBalanceResponse;
  onOpenGroup?: (group: TrialBalanceGroup) => void;
  onOpenAccount?: (account: TrialBalanceAccount) => void;
}> = ({ data, onOpenGroup, onOpenAccount }) => {
  const groups = data.groups || [];
  const rows = groups.length > 0
    ? groups.flatMap((group) => toGroupRows(group, 0, onOpenGroup, onOpenAccount))
    : data.accounts.map((account) => toRow(account, 0, onOpenAccount));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="OPENING DEBIT / CREDIT" value={`${money(data.totals.openingDebit)} / ${money(data.totals.openingCredit)}`} tone="indigo" hint="Balance brought forward" />
        <StatCard label="PERIOD DEBIT" value={money(data.totals.periodDebit)} tone="emerald" hint="Posted debits in the period" />
        <StatCard label="PERIOD CREDIT" value={money(data.totals.periodCredit)} tone="rose" hint="Posted credits in the period" />
        <StatCard label="CLOSING DEBIT / CREDIT" value={`${money(data.totals.closingDebit)} / ${money(data.totals.closingCredit)}`} tone="amber" hint="Balance carried forward" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
        <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
          Debits must equal credits in every column. Group and sub-group rows are subtotals.
        </p>
        <StatusPill ok={data.balanced} okLabel="Debits = Credits" badLabel="Out of balance" />
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
              <tr>
                <th className="px-2.5 py-1.5">Code</th>
                <th className="px-2.5 py-1.5">Account / group</th>
                <th className="px-2.5 py-1.5 text-right">Opening Dr</th>
                <th className="px-2.5 py-1.5 text-right">Opening Cr</th>
                <th className="px-2.5 py-1.5 text-right">Period Dr</th>
                <th className="px-2.5 py-1.5 text-right">Period Cr</th>
                <th className="px-2.5 py-1.5 text-right">Closing Dr</th>
                <th className="px-2.5 py-1.5 text-right">Closing Cr</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium dark:divide-slate-800/60">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                    No posted journal lines fall in this period for the selected branch.
                  </td>
                </tr>
              ) : (
                rows
              )}
            </tbody>
            <tfoot className="border-t border-slate-200 bg-slate-100 text-xs font-bold text-slate-800 dark:border-slate-800 dark:bg-slate-900/80 dark:text-slate-200">
              <tr>
                <td colSpan={2} className="px-2.5 py-1.5 text-right uppercase tracking-wider">Totals</td>
                <td className="px-2.5 py-1.5 text-right font-mono">{money(data.totals.openingDebit)}</td>
                <td className="px-2.5 py-1.5 text-right font-mono">{money(data.totals.openingCredit)}</td>
                <td className="px-2.5 py-1.5 text-right font-mono">{money(data.totals.periodDebit)}</td>
                <td className="px-2.5 py-1.5 text-right font-mono">{money(data.totals.periodCredit)}</td>
                <td className="px-2.5 py-1.5 text-right font-mono">{money(data.totals.closingDebit)}</td>
                <td className="px-2.5 py-1.5 text-right font-mono">{money(data.totals.closingCredit)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <ControlAgreementTable controls={data.controls} reconciled={data.controlsReconciled} />
    </div>
  );
};

const ControlAgreementTable: React.FC<{ controls: ControlAgreement[]; reconciled: boolean }> = ({
  controls,
  reconciled,
}) => (
  <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
      <div>
        <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Control accounts</h3>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          General-ledger balance against the party or branch subledger.
        </p>
      </div>
      <StatusPill ok={reconciled} okLabel="All reconciled" badLabel="Difference found" />
    </div>
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
          <tr>
            <th className="px-2.5 py-1.5">Account</th>
            <th className="px-2.5 py-1.5">Subledger</th>
            <th className="px-2.5 py-1.5 text-right">GL balance</th>
            <th className="px-2.5 py-1.5 text-right">Subledger balance</th>
            <th className="px-2.5 py-1.5 text-right">Difference</th>
            <th className="px-2.5 py-1.5 text-center">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 font-medium dark:divide-slate-800/60">
          {controls.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-3 py-4 text-center text-slate-400">
                No control account has a posted balance for this scope.
              </td>
            </tr>
          ) : (
            controls.map((control) => (
              <tr key={control.accountId} className="text-slate-800 dark:text-slate-300">
                <td className="px-2.5 py-1.5 font-bold">
                  <span className="mr-2 font-mono text-[11px] text-slate-400">{control.code}</span>
                  {control.name}
                </td>
                <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400">{control.subledgerType}</td>
                <td className="px-2.5 py-1.5 text-right font-mono">{money(control.glBalance)}</td>
                <td className="px-2.5 py-1.5 text-right font-mono">{money(control.subledgerBalance)}</td>
                <td className={`px-2.5 py-1.5 text-right font-mono ${Math.abs(control.difference) >= 0.005 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                  {money(control.difference)}
                </td>
                <td className="px-2.5 py-1.5 text-center">
                  <StatusPill ok={control.status === 'RECONCILED'} okLabel="Reconciled" badLabel="Difference" />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  </div>
);
