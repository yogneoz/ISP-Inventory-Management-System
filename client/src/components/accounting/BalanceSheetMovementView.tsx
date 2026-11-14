import React from 'react';
import type {
  BalanceSheetMovementAmount,
  BalanceSheetMovementGroup,
  BalanceSheetMovementResponse,
  BalanceSheetMovementSection,
} from '../../services/api/accounting';
import { StatusPill } from './StatementPrimitives';
import { money } from './statementFormat';
import { formatDualDate } from '../../utils/nepaliCalendar';

const percent = (value: number | null): string =>
  value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;

const amountClass = (value: number): string =>
  value < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300';

const MovementCells: React.FC<{
  amount: BalanceSheetMovementAmount;
  strong?: boolean;
}> = ({ amount, strong = false }) => (
  <>
    <td className={`px-3 py-1 text-right font-mono ${amountClass(amount.opening)} ${strong ? 'font-bold' : ''}`}>
      {money(amount.opening)}
    </td>
    <td className={`px-3 py-1 text-right font-mono ${amountClass(amount.period)} ${strong ? 'font-bold' : ''}`}>
      {money(amount.period)}
    </td>
    <td className={`px-3 py-1 text-right font-mono ${amountClass(amount.closing)} ${strong ? 'font-bold' : ''}`}>
      {money(amount.closing)}
    </td>
    <td className={`px-3 py-1 text-right font-mono ${amountClass(amount.change)} ${strong ? 'font-bold' : ''}`}>
      {amount.change > 0 ? '+' : ''}
      {money(amount.change)}
    </td>
    <td
      className={`px-3 py-1 text-right font-mono ${
        amount.changePercent !== null && amount.changePercent < 0
          ? 'text-rose-600 dark:text-rose-400'
          : 'text-slate-600 dark:text-slate-400'
      } ${strong ? 'font-bold' : ''}`}
    >
      {percent(amount.changePercent)}
    </td>
  </>
);

const MovementRow: React.FC<{
  label: React.ReactNode;
  amount: BalanceSheetMovementAmount;
  indent?: number;
  emphasis?: boolean;
  muted?: boolean;
}> = ({ label, amount, indent = 0, emphasis = false, muted = false }) => (
  <tr
    className={
      emphasis
        ? 'border-b border-slate-200 bg-slate-50 font-bold text-slate-900 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-100'
        : 'border-b border-slate-100 text-slate-700 dark:border-slate-800/60 dark:text-slate-300'
    }
  >
    <td
      className={`px-3 py-1 ${muted ? 'text-slate-500 dark:text-slate-400' : ''}`}
      style={{ paddingLeft: 12 + indent * 16 }}
    >
      {label}
    </td>
    <MovementCells amount={amount} strong={emphasis} />
  </tr>
);

const MovementGroupRows: React.FC<{
  groups: BalanceSheetMovementGroup[];
  depth?: number;
}> = ({ groups, depth = 0 }) => (
  <>
    {groups.map((group) => (
      <React.Fragment key={group.groupId}>
        <MovementRow
          indent={depth}
          emphasis
          label={
            <span>
              {depth > 0 && <span className="mr-1 text-slate-400">↳ </span>}
              <span className="mr-2 font-mono text-[10px] text-slate-400">{group.groupCode}</span>
              {group.groupName}
            </span>
          }
          amount={group}
        />
        {group.accounts.map((account) => (
          <MovementRow
            key={account.accountId}
            indent={depth + 1}
            label={
              <span>
                <span className="mr-2 font-mono text-[10px] text-slate-400">{account.code}</span>
                {account.name}
              </span>
            }
            amount={account}
          />
        ))}
        <MovementGroupRows groups={group.children} depth={depth + 1} />
      </React.Fragment>
    ))}
  </>
);

const MovementTable: React.FC<{
  title: string;
  sections: BalanceSheetMovementSection[];
  total: BalanceSheetMovementAmount;
  totalLabel: string;
  footer?: React.ReactNode;
  /** Null hides the empty-section row (used by the tie-out table). */
  emptyMessage?: string | null;
}> = ({ title, sections, total, totalLabel, footer, emptyMessage }) => (
  <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
    <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200">
        {title}
      </h3>
      <span className="font-mono text-sm font-bold">{money(total.closing)}</span>
    </div>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-xs">
        <thead className="border-b border-slate-200 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-300">
          <tr>
            <th className="px-3 py-2">Particular</th>
            <th className="px-3 py-2 text-right">Opening</th>
            <th className="px-3 py-2 text-right">Period</th>
            <th className="px-3 py-2 text-right">Closing</th>
            <th className="px-3 py-2 text-right">Change</th>
            <th className="px-3 py-2 text-right">Change %</th>
          </tr>
        </thead>
        <tbody>
          {sections.length === 0 ? (
            emptyMessage === null ? null : (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-xs text-slate-400">
                  {emptyMessage || 'No opening balances or posted movements in this section.'}
                </td>
              </tr>
            )
          ) : (
            sections.map((section) => (
              <React.Fragment key={section.statementGroup}>
                <MovementRow label={section.label} amount={section} emphasis />
                <MovementGroupRows groups={section.groups} />
              </React.Fragment>
            ))
          )}
          {footer}
          <tr className="border-t-2 border-slate-300 bg-slate-100 font-bold text-slate-900 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-100">
            <td className="px-3 py-2">{totalLabel}</td>
            <MovementCells amount={total} strong />
          </tr>
        </tbody>
      </table>
    </div>
  </section>
);

/**
 * Opening / period / closing presentation of the balance sheet. Opening is the
 * balance before `from`, period is posted turnover inside `from`..`asOf`, and
 * closing is the statutory as-of balance. Change is derived from the balances,
 * while Change % deliberately shows a dash when opening is zero.
 */
export const BalanceSheetMovementView: React.FC<{
  data: BalanceSheetMovementResponse;
}> = ({ data }) => {
  const differenceLabel = `Opening / period / closing difference ${money(
    data.difference.opening
  )} / ${money(data.difference.period)} / ${money(data.difference.closing)}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
        <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
          Movement from {formatDualDate(data.from)} to {formatDualDate(data.asOf)}. Opening is the
          balance before the period; period is posted turnover; closing is the balance as of the
          end date.
        </p>
        <StatusPill
          ok={data.balanced}
          okLabel="Movement balances"
          badLabel={differenceLabel}
        />
      </div>

      <div className="grid grid-cols-1 gap-4">
        <MovementTable
          title="Assets"
          sections={data.assets.sections}
          total={data.totalAssets}
          totalLabel="Total assets"
          footer={
            <>
              <MovementRow
                muted
                label="Cash & bank (per cash book)"
                amount={data.cashAndBank}
              />
              <MovementRow
                muted
                label="Due from head office"
                amount={data.interBranch.dueFromHeadOffice}
              />
            </>
          }
        />

        <MovementTable
          title="Liabilities & equity"
          sections={data.liabilities.sections}
          total={data.totalLiabilitiesAndEquity}
          totalLabel="Total liabilities & equity"
          footer={
            <>
              <MovementRow label="Total liabilities" amount={data.totalLiabilities} emphasis />
              <MovementRow label="Equity" amount={data.equity.postedTotal} emphasis />
              {data.equity.sections.map((section) => (
                <React.Fragment key={section.statementGroup}>
                  <MovementRow label={section.label} amount={section} emphasis />
                  <MovementGroupRows groups={section.groups} />
                </React.Fragment>
              ))}
              <MovementRow
                muted
                label="Current earnings (opening + period profit)"
                amount={data.equity.currentEarnings}
              />
              <MovementRow label="Total equity" amount={data.totalEquity} emphasis />
              <MovementRow
                muted
                label="Due to head office"
                amount={data.interBranch.dueToHeadOffice}
              />
            </>
          }
        />
      </div>

      <MovementTable
        title="Tie-out"
        sections={[]}
        total={data.difference}
        totalLabel="Difference (assets − liabilities − equity)"
        emptyMessage={null}
        footer={
          <>
            <MovementRow label="Total assets" amount={data.totalAssets} />
            <MovementRow label="Total liabilities & equity" amount={data.totalLiabilitiesAndEquity} />
          </>
        }
      />

      <p className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[10px] leading-snug text-slate-500 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
        Opening current earnings is cumulative income less expenses before the period start;
        period earnings is this period's profit. The two add to closing current earnings, so profit
        is included once. Change is closing minus opening; the period column is the posted movement
        and should equal it for every line.
      </p>
    </div>
  );
};

export default BalanceSheetMovementView;
