import React from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight } from 'lucide-react';
import type { StatementGroupBlock, StatementSection } from '../../services/api/accounting';
import { money } from './statementFormat';

export const StatusPill: React.FC<{ ok: boolean; okLabel: string; badLabel: string }> = ({
  ok,
  okLabel,
  badLabel,
}) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${
      ok
        ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-400'
        : 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-400'
    }`}
  >
    {ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
    {ok ? okLabel : badLabel}
  </span>
);

export const statementGroupButtonLabel = (group: StatementGroupBlock): string =>
  `Open journal lines for ${group.groupCode} ${group.groupName}`;

const GroupLabel: React.FC<{ group: StatementGroupBlock; depth: number }> = ({ group, depth }) => (
  <p className="min-w-0 truncate text-[11px] font-semibold text-slate-600 dark:text-slate-300">
    {depth > 0 && <span className="mr-1 text-slate-400">↳ </span>}
    <span className="font-mono text-[10px] text-slate-400">{group.groupCode}</span>
    <span className="mx-1 text-slate-300"> · </span>
    {group.groupName}
  </p>
);

const GroupAmount: React.FC<{ group: StatementGroupBlock; clickable: boolean }> = ({
  group,
  clickable,
}) => (
  <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] font-bold text-slate-700 dark:text-slate-300">
    {money(group.amount)}
    {clickable && <ChevronRight className="h-3 w-3 text-slate-400" />}
  </span>
);

/**
 * One statement group and, recursively, its sub-groups. The group row shows the
 * rolled-up subtotal (direct accounts + children), the same value the endpoint
 * returns; a sub-group is indented and marked so a printed statement and the
 * screen both expose the chart hierarchy.
 *
 * When `onOpenGroup` is supplied the heading is a button that opens the POSTED
 * journal lines behind that subtotal; without it the statement stays read-only
 * (as in a print or a caller that does not want the drill-down).
 */
const StatementGroupRows: React.FC<{
  groups: StatementGroupBlock[];
  depth?: number;
  onOpenGroup?: (group: StatementGroupBlock) => void;
}> = ({ groups, depth = 0, onOpenGroup }) => (
  <>
    {groups.map((group: StatementGroupBlock) => (
      <div key={group.groupId} className="pr-3" style={{ paddingLeft: 12 + depth * 14 }}>
        {onOpenGroup ? (
          <button
            type="button"
            onClick={() => onOpenGroup(group)}
            aria-label={statementGroupButtonLabel(group)}
            className="flex w-full items-center justify-between gap-3 rounded-md border-b border-slate-100 pt-1 pr-1 pb-0.5 text-left transition-colors hover:bg-indigo-50/70 dark:border-slate-800/60 dark:hover:bg-indigo-950/20"
          >
            <GroupLabel group={group} depth={depth} />
            <GroupAmount group={group} clickable />
          </button>
        ) : (
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 pt-1 pb-0.5 dark:border-slate-800/60">
            <GroupLabel group={group} depth={depth} />
            <GroupAmount group={group} clickable={false} />
          </div>
        )}
        {group.accounts.map((account) => (
          <div
            key={account.accountId}
            className="flex items-center justify-between gap-3 border-b border-dashed border-slate-100 py-0.5 last:border-b-0 dark:border-slate-800/60"
          >
            <span className="min-w-0 truncate text-xs text-slate-700 dark:text-slate-300">
              <span className="mr-2 font-mono text-[10px] text-slate-400">{account.code}</span>
              {account.name}
            </span>
            <span
              className={`shrink-0 font-mono text-xs ${
                account.amount < 0
                  ? 'text-rose-600 dark:text-rose-400'
                  : 'text-slate-700 dark:text-slate-300'
              }`}
            >
              {money(account.amount)}
            </span>
          </div>
        ))}
        <StatementGroupRows
          groups={group.children}
          depth={depth + 1}
          onOpenGroup={onOpenGroup}
        />
      </div>
    ))}
  </>
);

export const SectionBody: React.FC<{
  sections: StatementSection[];
  onOpenGroup?: (group: StatementGroupBlock) => void;
}> = ({ sections, onOpenGroup }) => {
  if (sections.length === 0) {
    return <p className="px-3 py-3 text-xs text-slate-400">No posted amounts in this statement.</p>;
  }
  return (
    <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
      {sections.map((section) => (
        <div key={section.statementGroup} className="py-2">
          <div className="flex items-center justify-between gap-3 px-3 py-1">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {section.label}
            </h4>
            <span className="font-mono text-xs font-bold text-slate-800 dark:text-slate-200">
              {money(section.amount)}
            </span>
          </div>
          <StatementGroupRows groups={section.groups} onOpenGroup={onOpenGroup} />
        </div>
      ))}
    </div>
  );
};
