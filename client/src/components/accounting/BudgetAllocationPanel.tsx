/**
 * Cost-centre allocation for operating-expense budgets.
 *
 * The branch default is the required fallback. An expense group can opt into
 * an override; otherwise its effective split is the default. Budget amounts are
 * allocated for display only. Actuals remain the POSTED lines' own
 * cost_center_id values, and untagged actuals stay in an explicit unallocated
 * row instead of being spread by the allocation ratio.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Layers,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../../services/api';
import type {
  BudgetAllocationGroup,
  BudgetAllocationResponse,
  BudgetDepartmentResponse,
} from '../../services/api/accounting';
import { RegisterEmpty } from './AccountingRegisterShell';
import { formatMoney } from '../../utils/nprFormat';

export interface BudgetAllocationPanelProps {
  fiscalYearId: string;
  fiscalYearCode: string;
  from: string;
  to: string;
  /** `ALL` is a read-only consolidated view; allocation is edited per branch. */
  branchId: string;
  canManage: boolean;
  locked: boolean;
  reloadToken?: number;
}

interface DraftRule {
  accountGroup: string;
  costCenterId: string;
  percentage: number;
  code: string;
  name: string;
  branchId: string | null;
  active: boolean;
}

const DEFAULT_GROUP = 'DEFAULT';
const FULL_BP = 10000;

const panelClass =
  'rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60';

function percentText(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

function groupTotal(rules: DraftRule[]): number {
  return Math.round(rules.reduce((sum, rule) => sum + rule.percentage * 100, 0));
}

function groupTotalText(rules: DraftRule[]): string {
  return `${(groupTotal(rules) / 100).toFixed(2)}%`;
}

function ruleAmount(rule: DraftRule, groupBudget: number): number {
  return Math.round(groupBudget * rule.percentage) / 100;
}

function rulesFor(rules: DraftRule[], group: string): DraftRule[] {
  return rules.filter((rule) => rule.accountGroup === group);
}

function effectiveRules(rules: DraftRule[], group: string): DraftRule[] {
  const own = rulesFor(rules, group);
  return own.length > 0 ? own : rulesFor(rules, DEFAULT_GROUP);
}

function allocationLabel(groups: BudgetAllocationGroup[], group: string): string {
  return groups.find((candidate) => candidate.accountGroup === group)?.label || group;
}

export const BudgetAllocationPanel: React.FC<BudgetAllocationPanelProps> = ({
  fiscalYearId,
  fiscalYearCode,
  from,
  to,
  branchId,
  canManage,
  locked,
  reloadToken = 0,
}) => {
  const concrete = branchId !== 'ALL';
  const [allocation, setAllocation] = useState<BudgetAllocationResponse | null>(null);
  const [departments, setDepartments] = useState<BudgetDepartmentResponse | null>(null);
  const [loading, setLoading] = useState(concrete);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftRule[]>([]);
  const [activeGroup, setActiveGroup] = useState(DEFAULT_GROUP);
  const [addCentreId, setAddCentreId] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    setNotice('');
  }, [fiscalYearId, branchId]);

  useEffect(() => {
    if (!concrete) {
      setLoading(false);
      setAllocation(null);
      setDepartments(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError('');
    if (
      typeof api.getAccountingBudgetAllocation !== 'function' ||
      typeof api.getAccountingBudgetDepartmentVariance !== 'function'
    ) {
      setLoading(false);
      setError('The cost-centre allocation API is unavailable.');
      return () => {
        live = false;
      };
    }

    Promise.all([
      api.getAccountingBudgetAllocation({ fiscalYearId, branchId }),
      api.getAccountingBudgetDepartmentVariance({
        fiscalYearId,
        branchId,
        from,
        to,
      }),
    ])
      .then(([profile, departmentResult]) => {
        if (!live) return;
        setAllocation(profile);
        setDepartments(departmentResult);
        setDraft(
          profile.rules.map((rule) => ({
            accountGroup: rule.accountGroup,
            costCenterId: rule.costCenterId,
            percentage: rule.percentage,
            code: rule.code,
            name: rule.name,
            branchId: rule.branchId,
            active: rule.active,
          }))
        );
      })
      .catch((err: any) => {
        if (!live) return;
        setError(err?.message || 'Could not load the cost-centre allocation.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
    };
  }, [concrete, fiscalYearId, branchId, from, to, reloadToken, refresh]);

  const lockedNow = Boolean(allocation?.locked || locked);
  const groups = allocation?.groups || [];
  const activeRules = effectiveRules(draft, activeGroup);
  const ownActiveRules = rulesFor(draft, activeGroup);
  const activeGroupBudget =
    activeGroup === DEFAULT_GROUP
      ? allocation?.totalExpenseBudget || 0
      : groups.find((group) => group.accountGroup === activeGroup)?.budget || 0;
  const activeTotalBp = groupTotal(activeRules);
  const activeHasOverride = activeGroup === DEFAULT_GROUP || ownActiveRules.length > 0;
  const activeLabel = allocationLabel(groups, activeGroup);
  const availableCentres = useMemo(() => {
    const used = new Set(activeRules.map((rule) => rule.costCenterId));
    return (allocation?.centres || []).filter(
      (centre) => centre.active && !used.has(centre.id)
    );
  }, [allocation?.centres, activeRules]);

  const startEditing = () => {
    if (!allocation || lockedNow) return;
    setDraft(
      allocation.rules.map((rule) => ({
        accountGroup: rule.accountGroup,
        costCenterId: rule.costCenterId,
        percentage: rule.percentage,
        code: rule.code,
        name: rule.name,
        branchId: rule.branchId,
        active: rule.active,
      }))
    );
    setActiveGroup(DEFAULT_GROUP);
    setSaveError('');
    setNotice('');
    setEditing(true);
  };

  const cancelEditing = () => {
    if (!allocation) return;
    setDraft(
      allocation.rules.map((rule) => ({
        accountGroup: rule.accountGroup,
        costCenterId: rule.costCenterId,
        percentage: rule.percentage,
        code: rule.code,
        name: rule.name,
        branchId: rule.branchId,
        active: rule.active,
      }))
    );
    setEditing(false);
    setSaveError('');
  };

  const addRule = () => {
    if (!allocation || !activeHasOverride) return;
    const centre = allocation.centres.find((candidate) => candidate.id === addCentreId);
    if (!centre || activeRules.some((rule) => rule.costCenterId === centre.id)) return;
    setDraft((current) => [
      ...current,
      {
        accountGroup: activeGroup,
        costCenterId: centre.id,
        percentage: 0,
        code: centre.code,
        name: centre.name,
        branchId: centre.branchId,
        active: centre.active,
      },
    ]);
    setAddCentreId('');
    setSaveError('');
  };

  const removeRule = (rule: DraftRule) => {
    setDraft((current) =>
      current.filter(
        (candidate) =>
          !(
            candidate.accountGroup === rule.accountGroup &&
            candidate.costCenterId === rule.costCenterId
          )
      )
    );
    setSaveError('');
  };

  const updatePercentage = (rule: DraftRule, value: string) => {
    const parsed = Number(value);
    const next = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
    setDraft((current) =>
      current.map((candidate) =>
        candidate.accountGroup === rule.accountGroup &&
        candidate.costCenterId === rule.costCenterId
          ? { ...candidate, percentage: next }
          : candidate
      )
    );
    setSaveError('');
  };

  const startOverride = () => {
    const inherited = rulesFor(draft, DEFAULT_GROUP);
    if (!inherited.length) return;
    setDraft((current) => [
      ...current.filter((rule) => rule.accountGroup !== activeGroup),
      ...inherited.map((rule) => ({
        ...rule,
        accountGroup: activeGroup,
      })),
    ]);
    setSaveError('');
  };

  const resetToDefault = () => {
    setDraft((current) => current.filter((rule) => rule.accountGroup !== activeGroup));
    setSaveError('');
  };

  const distributeEqually = () => {
    if (!activeRules.length) return;
    const base = Math.floor(FULL_BP / activeRules.length);
    const remainder = FULL_BP - base * activeRules.length;
    const percentages = new Map(
      activeRules.map((rule, index) => [
        `${rule.accountGroup}|${rule.costCenterId}`,
        (base + (index < remainder ? 1 : 0)) / 100,
      ])
    );
    setDraft((current) =>
      current.map((rule) => {
        const next = percentages.get(`${rule.accountGroup}|${rule.costCenterId}`);
        return next === undefined ? rule : { ...rule, percentage: next };
      })
    );
    setSaveError('');
  };

  const save = async () => {
    if (!allocation || !canManage || lockedNow) return;
    const defaultRules = rulesFor(draft, DEFAULT_GROUP);
    if (!defaultRules.length) {
      setSaveError('Add at least one cost centre to the branch default.');
      return;
    }
    if (groupTotal(defaultRules) !== FULL_BP) {
      setSaveError('The branch default allocation must total exactly 100%.');
      return;
    }
    for (const group of draft
      .map((rule) => rule.accountGroup)
      .filter((groupName, index, all) => groupName !== DEFAULT_GROUP && all.indexOf(groupName) === index)) {
      const own = rulesFor(draft, group);
      if (own.length && groupTotal(own) !== FULL_BP) {
        setSaveError(`${allocationLabel(groups, group)} must total exactly 100%.`);
        return;
      }
    }

    setSaving(true);
    setSaveError('');
    try {
      const saved = await api.saveAccountingBudgetAllocation({
        fiscalYearId,
        branchId,
        rules: draft.map((rule) => ({
          accountGroup: rule.accountGroup,
          costCenterId: rule.costCenterId,
          percentage: rule.percentage,
        })),
      });
      setAllocation(saved);
      setEditing(false);
      setNotice(
        `Saved ${saved.rules.length} cost-centre rule${saved.rules.length === 1 ? '' : 's'} for ${saved.branchName}.`
      );
      setRefresh((current) => current + 1);
    } catch (err: any) {
      setSaveError(err?.message || 'The cost-centre allocation could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  if (!concrete) {
    return (
      <section className={panelClass}>
        <div className="flex items-start gap-2">
          <Layers className="mt-0.5 h-4 w-4 text-indigo-500" />
          <div>
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">
              Cost-centre allocation
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              Allocations are branch-specific. Choose a branch in the scope bar to view or edit
              its OPEX split.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (loading && !allocation) {
    return (
      <section className={panelClass}>
        <p className="text-xs text-slate-400">Loading the cost-centre allocation…</p>
      </section>
    );
  }

  if (error && !allocation) {
    return (
      <section className={panelClass}>
        <div className="flex items-start gap-2 text-[11px] text-rose-700 dark:text-rose-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      </section>
    );
  }

  if (!allocation) return null;

  return (
    <section className={panelClass}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">
              Cost-centre allocation
            </h3>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                allocation.status === 'READY'
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                  : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
              }`}
            >
              {allocation.status === 'READY'
                ? `READY · ${allocation.rules.length} rule${allocation.rules.length === 1 ? '' : 's'}`
                : 'Not configured'}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            FY {fiscalYearCode} · {allocation.branchName} · operating-expense budget only.
            Revenue and capital purchases are outside this allocation.
          </p>
        </div>
        {canManage && !lockedNow && !editing && (
          <button
            type="button"
            onClick={startEditing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-2.5 py-1.5 text-[11px] font-semibold text-indigo-700 transition-colors hover:bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit allocation
          </button>
        )}
        {lockedNow && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
            Budget locked
          </span>
        )}
      </div>

      {notice && (
        <p role="status" className="mt-3 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
          {notice}
        </p>
      )}
      {saveError && (
        <div
          role="status"
          className="mt-3 flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-200"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      {allocation.status === 'MISSING' && !editing && (
        <div className="mt-3">
          <RegisterEmpty message="No cost-centre allocation is configured for this branch. Set a default split to produce department budget figures." />
        </div>
      )}

      {editing && (
        <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 dark:border-indigo-900/60 dark:bg-indigo-950/20">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Allocation expense groups">
            {[{ accountGroup: DEFAULT_GROUP, label: 'Branch default', budget: allocation.totalExpenseBudget, hasOverride: true }, ...groups].map((group) => (
              <button
                key={group.accountGroup}
                type="button"
                role="tab"
                aria-selected={activeGroup === group.accountGroup}
                onClick={() => {
                  setActiveGroup(group.accountGroup);
                  setAddCentreId('');
                }}
                className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
                  activeGroup === group.accountGroup
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                {group.label}
                {group.accountGroup !== DEFAULT_GROUP && 'hasOverride' in group && group.hasOverride && (
                  <span className="ml-1 text-[10px] opacity-80">override</span>
                )}
              </button>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                {activeLabel}
              </p>
              <p className="text-[10px] text-slate-500 dark:text-slate-400">
                {activeGroup === DEFAULT_GROUP
                  ? 'Fallback for every expense group without an override.'
                  : 'This group replaces the branch default for its accounts.'}{' '}
                Group budget {formatMoney(activeGroupBudget)}.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {activeGroup !== DEFAULT_GROUP && !activeHasOverride && (
                <button
                  type="button"
                  onClick={startOverride}
                  className="inline-flex items-center gap-1 rounded-lg border border-indigo-300 bg-white px-2.5 py-1.5 text-[10px] font-semibold text-indigo-700 hover:bg-indigo-50 dark:border-indigo-700 dark:bg-slate-900 dark:text-indigo-300"
                >
                  <Pencil className="h-3 w-3" /> Override this group
                </button>
              )}
              {activeGroup !== DEFAULT_GROUP && activeHasOverride && (
                <button
                  type="button"
                  onClick={resetToDefault}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300"
                >
                  <RotateCcw className="h-3 w-3" /> Use default
                </button>
              )}
              {activeHasOverride && activeRules.length > 0 && (
                <button
                  type="button"
                  onClick={distributeEqually}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300"
                >
                  Distribute equally
                </button>
              )}
            </div>
          </div>

          {activeGroup !== DEFAULT_GROUP && !activeHasOverride ? (
            <p className="mt-3 rounded-lg border border-dashed border-slate-300 bg-white/70 px-3 py-2 text-[10px] text-slate-500 dark:border-slate-600 dark:bg-slate-900/40 dark:text-slate-400">
              This group inherits the branch default:
              {activeRules.length === 0
                ? ' no default is configured yet.'
                : ` ${activeRules.map((rule) => `${rule.code} ${rule.percentage.toFixed(2)}%`).join(' · ')}.`}
            </p>
          ) : (
            <>
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full border-collapse text-left text-[11px]">
                  <thead>
                    <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-400 dark:border-slate-700 dark:text-slate-500">
                      <th className="px-2 py-2 font-semibold">Cost centre</th>
                      <th className="px-2 py-2 text-right font-semibold">Share</th>
                      <th className="px-2 py-2 text-right font-semibold">Budget preview</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {activeRules.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-2 py-3 text-[10px] text-slate-500">
                          Add a cost centre to start this split.
                        </td>
                      </tr>
                    ) : (
                      activeRules.map((rule) => (
                        <tr
                          key={`${rule.accountGroup}-${rule.costCenterId}`}
                          className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                        >
                          <td className="px-2 py-2">
                            <span className="font-mono text-[10px] text-slate-400">{rule.code}</span>{' '}
                            <span className="font-medium text-slate-700 dark:text-slate-200">
                              {rule.name}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-right">
                            <div className="inline-flex items-center gap-1">
                              <input
                                aria-label={`Allocation percentage for ${rule.code}`}
                                type="number"
                                min="0"
                                max="100"
                                step="0.01"
                                value={rule.percentage}
                                onChange={(event) => updatePercentage(rule, event.target.value)}
                                className="w-20 rounded-lg border border-slate-300 bg-white px-2 py-1 text-right font-mono text-[11px] text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                              />
                              <span className="text-[10px] text-slate-400">%</span>
                            </div>
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-slate-600 dark:text-slate-300">
                            {formatMoney(ruleAmount(rule, activeGroupBudget))}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => removeRule(rule)}
                              aria-label={`Remove ${rule.code} from ${activeLabel}`}
                              className="rounded-lg p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30 dark:hover:text-rose-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-200 font-semibold dark:border-slate-700">
                      <td className="px-2 py-2" colSpan={1}>
                        Total
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        <span
                          className={
                            activeTotalBp === FULL_BP
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-rose-600 dark:text-rose-400'
                          }
                        >
                          {groupTotalText(activeRules)}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        {formatMoney(
                          activeRules.reduce(
                            (sum, rule) => sum + ruleAmount(rule, activeGroupBudget),
                            0
                          )
                        )}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  aria-label="Add cost centre to allocation"
                  value={addCentreId}
                  onChange={(event) => setAddCentreId(event.target.value)}
                  disabled={availableCentres.length === 0}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-[11px] text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                >
                  <option value="">
                    {availableCentres.length ? 'Choose cost centre…' : 'All active centres added'}
                  </option>
                  {availableCentres.map((centre) => (
                    <option key={centre.id} value={centre.id}>
                      {centre.code} · {centre.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={addRule}
                  disabled={!addCentreId}
                  className="inline-flex items-center gap-1 rounded-lg border border-indigo-300 bg-indigo-50 px-2.5 py-1.5 text-[10px] font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300"
                >
                  <Plus className="h-3 w-3" /> Add
                </button>
              </div>
            </>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-indigo-200/70 pt-3 dark:border-indigo-900/60">
            <p className="text-[10px] text-slate-500 dark:text-slate-400">
              Every group must total 100%. Actuals are tagged POSTED lines; the department preview
              below shows untagged actual separately.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={cancelEditing}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300"
              >
                <X className="h-3 w-3" /> Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving || lockedNow}
                className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-[10px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                <Save className="h-3 w-3" /> {saving ? 'Saving…' : 'Save allocation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {!editing && allocation.status === 'READY' && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {[{ accountGroup: DEFAULT_GROUP, label: 'Branch default', budget: allocation.totalExpenseBudget, hasOverride: true, rules: rulesFor(draft, DEFAULT_GROUP) }, ...allocation.groups.map((group) => ({ ...group, rules: effectiveRules(draft, group.accountGroup) }))].map((group) => (
            <div
              key={group.accountGroup}
              className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/30"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                    {group.label}
                  </p>
                  <p className="text-[10px] uppercase tracking-wider text-slate-400">
                    {group.accountGroup === DEFAULT_GROUP
                      ? 'Fallback'
                      : group.hasOverride
                        ? 'Override'
                        : 'Inherited'}
                  </p>
                </div>
                <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
                  {formatMoney(group.budget)}
                </span>
              </div>
              <div className="mt-1.5 space-y-0.5">
                {group.rules.length === 0 ? (
                  <p className="text-[10px] text-slate-400">No split configured.</p>
                ) : (
                  group.rules.map((rule) => (
                    <div
                      key={`${group.accountGroup}-${rule.costCenterId}`}
                      className="flex items-center justify-between gap-2 text-[10px]"
                    >
                      <span className="truncate text-slate-600 dark:text-slate-300">
                        {rule.code} · {rule.name}
                      </span>
                      <span className="font-mono text-slate-500 dark:text-slate-400">
                        {rule.percentage.toFixed(2)}%
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {departments && (
        <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Department preview
              </h4>
              <p className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                Posted expense actuals by cost-centre tag · {departments.from} to {departments.to}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  departments.tieOut.reconciled
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                    : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
                }`}
                title="Department budgets and tagged actuals must tie to their source totals."
              >
                {departments.tieOut.reconciled ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <AlertTriangle className="h-3 w-3" />
                )}
                {departments.tieOut.reconciled ? 'Reconciled' : 'Does not tie'}
              </span>
              <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
                {departments.tieOut.reconciled ? 'Zero variance' : 'Variance'} · budget Δ{' '}
                {formatMoney(departments.tieOut.budgetDifference)} · actual Δ{' '}
                {formatMoney(departments.tieOut.actualDifference)}
              </span>
            </div>
          </div>

          {departments.status === 'MISSING' ? (
            <p className="mt-2 rounded-lg border border-dashed border-amber-300 bg-amber-50/60 px-3 py-2 text-[10px] text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/20 dark:text-amber-200">
              No allocation is configured, so department budgets are not shown. Tagged actuals
              still appear below with a zero budget.
            </p>
          ) : null}

          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full border-collapse text-left text-[11px]">
              <thead>
                <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-400 dark:border-slate-700 dark:text-slate-500">
                  <th className="px-2 py-2 font-semibold">Cost centre</th>
                  <th className="px-2 py-2 text-right font-semibold">Budget</th>
                  <th className="px-2 py-2 text-right font-semibold">Tagged actual</th>
                  <th className="px-2 py-2 text-right font-semibold">Variance</th>
                  <th className="px-2 py-2 text-right font-semibold">Utilisation</th>
                </tr>
              </thead>
              <tbody>
                {departments.departments.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-2 py-3 text-[10px] text-slate-500">
                      No tagged or budgeted departments in this window.
                    </td>
                  </tr>
                ) : (
                  departments.departments.map((department) => (
                    <tr
                      key={department.costCenterId}
                      className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                    >
                      <td className="px-2 py-2">
                        <span className="font-mono text-[10px] text-slate-400">
                          {department.code}
                        </span>{' '}
                        <span className="font-medium text-slate-700 dark:text-slate-200">
                          {department.name}
                        </span>
                        {!department.inAllocation && (
                          <span className="ml-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                            Not in profile
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-slate-600 dark:text-slate-300">
                        {formatMoney(department.budget)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-slate-600 dark:text-slate-300">
                        {formatMoney(department.actual)}
                        <span className="ml-1 text-[10px] text-slate-400">
                          ({department.lineCount})
                        </span>
                      </td>
                      <td
                        className={`px-2 py-2 text-right font-mono font-semibold ${
                          department.variance < 0
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-emerald-600 dark:text-emerald-400'
                        }`}
                      >
                        {formatMoney(department.variance)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-slate-600 dark:text-slate-300">
                        {percentText(department.utilisationPercent)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-200 font-semibold dark:border-slate-700">
                  <td className="px-2 py-2">Allocated</td>
                  <td className="px-2 py-2 text-right font-mono">
                    {formatMoney(departments.totals.allocatedBudget)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">
                    {formatMoney(departments.totals.taggedActual)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">
                    {formatMoney(departments.totals.allocatedBudget - departments.totals.taggedActual)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">
                    {percentText(
                      departments.totals.allocatedBudget > 0
                        ? (departments.totals.taggedActual / departments.totals.allocatedBudget) * 100
                        : null
                    )}
                  </td>
                </tr>
                <tr className="border-t border-slate-100 text-amber-700 dark:border-slate-800 dark:text-amber-300">
                  <td className="px-2 py-2">
                    Unallocated actual
                    <span className="ml-1 text-[10px] font-normal">(no cost-centre tag)</span>
                  </td>
                  <td className="px-2 py-2 text-right font-mono">—</td>
                  <td className="px-2 py-2 text-right font-mono">
                    {formatMoney(departments.totals.unallocatedActual)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">—</td>
                  <td className="px-2 py-2 text-right font-mono">—</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500 dark:text-slate-400">
            <span>
              Tagged {departments.coverage.taggedExpenseLines} of{' '}
              {departments.coverage.totalExpenseLines} posted expense lines
              {departments.coverage.taggedPercent !== null
                ? ` (${departments.coverage.taggedPercent.toFixed(1)}%)`
                : ''}.
            </span>
            <span>
              Expense budget {formatMoney(departments.totals.expenseBudget)} · actual{' '}
              {formatMoney(departments.totals.expenseActual)}
            </span>
          </div>
          {departments.coverage.untaggedExpenseLines > 0 && (
            <p className="mt-1 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-[10px] text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/20 dark:text-amber-200">
              {departments.coverage.untaggedExpenseLines} posted expense line
              {departments.coverage.untaggedExpenseLines === 1 ? '' : 's'} have no cost-centre tag.
              Their {formatMoney(departments.totals.unallocatedActual)} stays in the unallocated row
              and is not spread across departments.
            </p>
          )}
        </div>
      )}
    </section>
  );
};

export default BudgetAllocationPanel;
