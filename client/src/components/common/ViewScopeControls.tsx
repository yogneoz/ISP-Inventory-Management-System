import React from 'react';
import { Building2 } from 'lucide-react';
import type { Branch, FiscalYear, User } from '../../types';
import { canUserSeeAllBranches, filterFiscalYears, getAllowedBranches } from '../../utils/permissions';
import { FiscalYearSelect } from './FiscalYearSelect';

interface ViewScopeControlsProps {
  currentUser: User | null;
  branches: Branch[];
  selectedBranchId: string;
  onSelectBranch: (branchId: string) => void;
  fiscalYears: FiscalYear[];
  selectedFiscalYearId: string;
  onSelectFiscalYear: (fiscalYearId: string) => void;
  /** Desktop header styling, or the light drawer styling used on mobile. */
  variant: 'header' | 'drawer';
}

/**
 * The company-wide view scope (branch + fiscal year).
 *
 * Desktop keeps these in the header. Below `md` the header hides them, so the
 * mobile drawer renders the same controls through this component — one source
 * of truth for the option list, the "assigned branch" lock and the FY selector.
 */
export const ViewScopeControls: React.FC<ViewScopeControlsProps> = ({
  currentUser,
  branches,
  selectedBranchId,
  onSelectBranch,
  fiscalYears,
  selectedFiscalYearId,
  onSelectFiscalYear,
  variant,
}) => {
  const isHeader = variant === 'header';
  const canSeeAll = canUserSeeAllBranches(currentUser);
  const allowed = getAllowedBranches(currentUser, branches);
  const onlyAssignedBranch = !canSeeAll && allowed.length === 1;
  const branchSelectId = `${variant}-branch-scope`;

  return (
    <div className={isHeader ? 'flex items-center gap-1.5' : 'space-y-2'}>
      <div className={isHeader ? 'flex items-center gap-1.5' : 'space-y-1'}>
        {!isHeader && (
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            <Building2 className="h-3.5 w-3.5" />
            <span>View scope</span>
          </div>
        )}
        <label htmlFor={branchSelectId} className="sr-only">
          Branch view
        </label>

        {onlyAssignedBranch ? (
          <div
            className={
              isHeader
                ? 'flex items-center gap-1 rounded-md border border-amber-300/40 bg-amber-950/60 px-2 py-1 font-bold text-[11px] text-amber-200'
                : 'flex w-full items-center justify-between gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 font-bold text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200'
            }
          >
            <span>📍 {allowed[0]?.name || 'Assigned Branch'}</span>
            <span
              className={
                isHeader
                  ? 'text-[10px] bg-amber-800/80 text-amber-100 px-1 py-0.2 rounded font-normal uppercase'
                  : 'rounded bg-amber-200 px-1 py-0.5 text-[10px] font-normal uppercase text-amber-900 dark:bg-amber-900 dark:text-amber-100'
              }
            >
              Assigned
            </span>
          </div>
        ) : (
          <select
            id={branchSelectId}
            value={selectedBranchId}
            onChange={(event) => onSelectBranch(event.target.value)}
            className={
              isHeader
                ? 'rounded-md px-2.5 py-1 font-medium text-[11px] focus:outline-none transition-all cursor-pointer border border-white/30 bg-white/10 text-white focus:bg-white/20 backdrop-blur-xs dark:border dark:border-slate-800 dark:bg-[#0f1218] dark:text-slate-300 dark:focus:border-indigo-500'
                : 'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-800 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
            }
          >
            <option value="ALL" className="bg-slate-900 text-white">
              {canSeeAll
                ? '🏢 All Branches (Consolidated)'
                : `🏢 My Assigned Branches (${allowed.length})`}
            </option>
            {allowed.map((branch) => (
              <option key={branch.id} value={branch.id} className="bg-slate-900 text-white">
                {branch.isHeadquarters ? '⭐ ' : '📍 '}
                {branch.name} ({branch.code})
              </option>
            ))}
          </select>
        )}
      </div>

      <div
        className={
          isHeader
            ? 'flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium border-white/30 bg-white/10 text-white backdrop-blur-xs dark:border-slate-800 dark:bg-[#0f1218] dark:text-slate-300'
            : 'flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
        }
        title="Fiscal-year view"
      >
        <span
          className={
            isHeader
              ? 'text-[10px] font-bold text-indigo-200 dark:text-slate-400'
              : 'text-[10px] font-bold text-slate-500 dark:text-slate-400'
          }
        >
          FY
        </span>
        <FiscalYearSelect
          fiscalYears={filterFiscalYears(fiscalYears)}
          value={selectedFiscalYearId}
          onChange={onSelectFiscalYear}
          showFyPrefix={false}
          pageSize={3}
          title="Select fiscal-year view"
          triggerClassName={
            isHeader
              ? 'max-w-28 text-white dark:text-slate-200'
              : 'max-w-32 text-slate-800 dark:text-slate-200'
          }
          panelClassName=""
          align="left"
        />
      </div>
    </div>
  );
};

export default ViewScopeControls;
