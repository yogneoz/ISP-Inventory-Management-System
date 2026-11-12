/**
 * People & HR → Organizational Chart.
 *
 * The chart is derived, never hand-maintained:
 *   * the nodes are the active designations in Org Masters (the refactored
 *     51-role catalogue), so a post with no holder still appears as vacant;
 *   * an edge is the designation's "Reports To" set in the catalogue;
 *   * the people on a node are the active employees whose designation resolves
 *     to that catalogue row, from the Employee Directory (branch-scoped).
 *
 * It therefore updates itself when HR edits an employee or a designation —
 * there is no second copy of the hierarchy to keep in sync. The notes panel
 * spells this out so nobody looks for an "edit chart" control.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Briefcase,
  Building2,
  ChevronDown,
  ChevronRight,
  Layers,
  LayoutGrid,
  MapPin,
  Network,
  RefreshCw,
  Search,
  Users,
} from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { PageHeader } from '../../components/common/PageHeader';
import { api } from '../../services/api';
import type {
  HrOrgCatalogue,
  HrOrgChartEmployee,
  HrOrgDesignationCatalogueRow,
} from '../../services/api';
import { isOperationAllowed } from '../../utils/permissions';
import { buildBranchHierarchy } from '../../utils/hrOrgBranchView';
import OrgChartBoard from './OrgChartBoard';
import type { User } from '../../types';

interface OrgChartProps {
  currentUser: User | null;
}

interface ChartNode {
  key: string;
  label: string;
  code: string | null;
  grade: string | null;
  band: string | null;
  department: string | null;
  employees: HrOrgChartEmployee[];
  children: ChartNode[];
  /** True when the catalogue names an outside line (Board, Audit Committee). */
  external?: boolean;
  dotted?: boolean;
}

const BOARD_KEY = '__board__';

const matches = (needle: string, ...haystack: Array<string | null | undefined>) => {
  if (!needle) return true;
  return haystack.some((value) => (value || '').toLowerCase().includes(needle));
};

/** Attach a designation to the post its reporting line names, when it is outside the catalogue. */
function resolveParent(
  row: HrOrgDesignationCatalogueRow,
  byId: Map<string, HrOrgDesignationCatalogueRow>
): { parent: string; dotted: boolean } {
  if (row.reportsToId && byId.has(row.reportsToId)) {
    return { parent: row.reportsToId, dotted: false };
  }
  const label = (row.reportsToLabel || '').toLowerCase();
  if (label) {
    const target = [...byId.values()].find(
      (candidate) => candidate.id !== row.id && label.includes(candidate.name.toLowerCase())
    );
    if (target) return { parent: target.id, dotted: label.includes('dotted') };
  }
  return { parent: BOARD_KEY, dotted: false };
}

export const OrgChart: React.FC<OrgChartProps> = ({ currentUser }) => {
  const activationKey = useActivationKey('org-chart');
  const allowed =
    isOperationAllowed('hr-employee-view', currentUser?.role) ||
    isOperationAllowed('hr-employee-manage', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);

  const [catalogue, setCatalogue] = useState<HrOrgCatalogue | null>(null);
  const [employees, setEmployees] = useState<HrOrgChartEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Three readings of the same data: who reports to whom, how each department
  // is built, and how the posts spread across the salary grades.
  const [view, setView] = useState<'TREE' | 'DEPARTMENTS' | 'GRADES' | 'BRANCH'>('TREE');

  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    Promise.all([api.getHrOrgCatalogue(), api.getHrOrgChart()])
      .then(([catalogueRows, employeeRows]) => {
        if (cancelled) return;
        setCatalogue(catalogueRows);
        setEmployees(Array.isArray(employeeRows) ? employeeRows : []);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setCatalogue(null);
        setEmployees([]);
        setLoadError(err?.message || 'The organisation chart could not be read.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, reloadKey, activationKey]);

  const chart = useMemo(() => {
    const designations = catalogue?.designations ?? [];
    const byId = new Map(designations.map((row) => [row.id, row]));
    const employeesByDesignation = new Map<string, HrOrgChartEmployee[]>();
    for (const employee of employees) {
      if (!employee.designationId) continue;
      const bucket = employeesByDesignation.get(employee.designationId) ?? [];
      bucket.push(employee);
      employeesByDesignation.set(employee.designationId, bucket);
    }

    const nodes = new Map<string, ChartNode>();
    for (const row of designations) {
      nodes.set(row.id, {
        key: row.id,
        label: row.name,
        code: row.code,
        grade: row.grade,
        band:
          row.bandMin != null && row.bandMax != null
            ? `NPR ${row.bandMin.toLocaleString('en-IN')}–${row.bandMax.toLocaleString('en-IN')}`
            : null,
        department: row.department,
        employees: employeesByDesignation.get(row.id) ?? [],
        children: [],
      });
    }

    const roots: ChartNode[] = [];
    const board: ChartNode = {
      key: BOARD_KEY,
      label: 'Board of Directors',
      code: null,
      grade: null,
      band: null,
      department: 'External governance',
      employees: [],
      children: [],
      external: true,
    };

    for (const row of designations) {
      const node = nodes.get(row.id);
      if (!node) continue;
      const { parent, dotted } = resolveParent(row, byId);
      if (dotted) node.dotted = true;
      if (parent === BOARD_KEY || !nodes.has(parent)) {
        // Direct reports of the Board / Audit Committee hang off the board node.
        if (row.reportsToId && nodes.has(row.reportsToId)) roots.push(node);
        else board.children.push(node);
        continue;
      }
      nodes.get(parent)!.children.push(node);
    }

    const sortNodes = (list: ChartNode[]) => {
      list.sort((a, b) => {
        if (a.employees.length !== b.employees.length) {
          return b.employees.length - a.employees.length;
        }
        return a.label.localeCompare(b.label);
      });
      list.forEach((child) => sortNodes(child.children));
    };
    sortNodes(board.children);
    roots.forEach((node) => sortNodes(node.children));
    if (board.children.length > 0) roots.unshift(board);

    const filled = designations.filter((row) => (employeesByDesignation.get(row.id) ?? []).length > 0).length;
    return {
      roots,
      designations,
      departments: catalogue?.departments ?? [],
      grades: catalogue?.grades ?? [],
      employeesByDesignation,
      designationCount: designations.length,
      departmentCount: catalogue?.departments.length ?? 0,
      filled,
      vacant: designations.length - filled,
      totalEmployees: employees.length,
    };
  }, [catalogue, employees]);

  const branches = useMemo(() => {
    const seen = new Map<string, string>();
    for (const employee of employees) {
      if (employee.branchId && !seen.has(employee.branchId)) {
        seen.set(employee.branchId, employee.branchName || employee.branchId);
      }
    }
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [employees]);
  const [branchId, setBranchId] = useState('');
  const effectiveBranchId =
    branchId || branches.find((branch) => /head office/i.test(branch.name))?.id || branches[0]?.id || null;
  const branchHierarchy = useMemo(
    () => (catalogue ? buildBranchHierarchy(catalogue, employees, effectiveBranchId) : null),
    [catalogue, employees, effectiveBranchId]
  );

  const needle = query.trim().toLowerCase();

  /** Keep a node when it or any descendant matches the search. */
  const nodeMatches = (node: ChartNode): boolean => {
    if (!needle) return true;
    if (matches(needle, node.label, node.code, node.grade, node.department)) return true;
    if (node.employees.some((employee) => matches(needle, employee.name, employee.employeeCode))) {
      return true;
    }
    return node.children.some(nodeMatches);
  };

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const gradeTone = (grade: string | null): string => {
    const tones: Record<string, string> = {
      G10: 'bg-slate-800 text-white',
      G9: 'bg-slate-700 text-white',
      G8: 'bg-blue-700 text-white',
      G7: 'bg-blue-600 text-white',
      G6: 'bg-indigo-600 text-white',
      G5: 'bg-teal-600 text-white',
      G4: 'bg-amber-600 text-white',
      G3: 'bg-orange-500 text-white',
      G2: 'bg-slate-500 text-white',
      G1: 'bg-stone-500 text-white',
    };
    return (grade && tones[grade]) || 'bg-slate-300 text-slate-700 dark:bg-slate-700 dark:text-slate-200';
  };

  const holdersOf = (designationId: string) =>
    chart.employeesByDesignation.get(designationId) ?? [];

  const postMatches = (row: HrOrgDesignationCatalogueRow): boolean => {
    if (!needle) return true;
    if (matches(needle, row.name, row.code, row.grade, row.department)) return true;
    return holdersOf(row.id).some((employee) =>
      matches(needle, employee.name, employee.employeeCode, employee.branchName)
    );
  };

  /** One compact post card, used by the department and grade views. */
  const renderPost = (row: HrOrgDesignationCatalogueRow, depth = 0, dotted = false) => {
    if (!postMatches(row)) return null;
    const holders = holdersOf(row.id);
    const shown = needle
      ? holders.filter((employee) =>
          matches(needle, employee.name, employee.employeeCode, employee.branchName)
        )
      : holders;
    return (
      <div
        key={row.id}
        style={{ marginLeft: depth * 10 }}
        className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 dark:border-slate-800 dark:bg-[#12161f]"
        title={row.responsibilities || undefined}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`rounded px-1 py-0.5 text-[8px] font-black ${gradeTone(row.grade)}`}>
            {row.grade || '—'}
          </span>
          <span className="text-[11px] font-semibold text-slate-900 dark:text-white">{row.name}</span>
          <span className="font-mono text-[10px] text-slate-400">{row.code}</span>
          {dotted ? (
            <span className="rounded-full border border-dashed border-slate-400 px-1 text-[8px] font-bold uppercase text-slate-500">
              dotted
            </span>
          ) : null}
          {holders.length === 0 ? (
            <span className="rounded-full border border-amber-300 bg-amber-50 px-1.5 text-[8px] font-bold uppercase text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              vacant
            </span>
          ) : (
            <span className="rounded-full bg-indigo-50 px-1.5 text-[8px] font-bold text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
              {holders.length}
            </span>
          )}
        </div>
        {shown.length > 0 ? (
          <p className="mt-0.5 truncate text-[10px] text-slate-500 dark:text-slate-400">
            {shown.map((employee) => employee.name).join(', ')}
          </p>
        ) : null}
      </div>
    );
  };

  /** View 3 — the same posts read as the grading matrix, highest band first. */
  const renderGrades = () => (
    <div className="space-y-2">
      {chart.grades.map((grade) => {
        const posts = chart.designations.filter(
          (row) => row.grade === grade.grade && postMatches(row)
        );
        const filled = posts.filter((row) => holdersOf(row.id).length > 0).length;
        return (
          <div
            key={grade.grade}
            className="rounded-2xl border border-slate-200 bg-white p-2.5 dark:border-slate-800 dark:bg-[#12161f]"
          >
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${gradeTone(grade.grade)}`}>
                  {grade.grade}
                </span>
                <span className="text-[11px] font-bold text-slate-900 dark:text-white">
                  {grade.careerBand}
                </span>
                <span className="text-[10px] text-slate-500 dark:text-slate-400">
                  NPR {grade.min.toLocaleString('en-IN')}–{grade.max.toLocaleString('en-IN')}
                </span>
              </div>
              <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                {posts.length} posts · {filled} filled · {posts.length - filled} vacant
              </span>
            </div>
            <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2 xl:grid-cols-3">
              {posts.length === 0 ? (
                <p className="p-2 text-center text-[10px] text-slate-500">No post at this grade.</p>
              ) : (
                posts.map((row) => renderPost(row))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderNode = (node: ChartNode, depth: number): React.ReactNode => {
    if (!nodeMatches(node)) return null;
    const isCollapsed = collapsed.has(node.key);
    const hasChildren = node.children.length > 0;
    const visibleEmployees = node.employees.filter((employee) =>
      matches(needle, employee.name, employee.employeeCode, employee.branchName)
    );
    const people = needle ? visibleEmployees : node.employees;

    return (
      <div key={node.key} className={depth === 0 ? '' : 'mt-2'}>
        <div
          className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 ${
            node.external
              ? 'border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/60'
              : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-[#12161f]'
          }`}
        >
          <button
            type="button"
            onClick={() => toggle(node.key)}
            disabled={!hasChildren}
            aria-label={isCollapsed ? `Expand ${node.label}` : `Collapse ${node.label}`}
            className="cursor-pointer rounded p-0.5 text-slate-500 hover:bg-slate-100 disabled:cursor-default disabled:opacity-40 dark:hover:bg-slate-800"
          >
            {hasChildren ? (
              isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />
            ) : (
              <span className="block h-4 w-4" />
            )}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-bold text-slate-900 dark:text-white">{node.label}</span>
              {node.code ? (
                <span className="font-mono text-[10px] text-slate-400">{node.code}</span>
              ) : null}
              {node.dotted ? (
                <span className="rounded-full border border-dashed border-slate-400 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                  dotted
                </span>
              ) : null}
              {!node.external && node.employees.length === 0 ? (
                <span className="rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                  vacant
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
              {node.external
                ? 'Reporting line leaves the company.'
                : [node.department, node.grade, node.band].filter(Boolean).join(' · ') ||
                  'No catalogue profile'}
            </p>
          </div>

          {node.employees.length > 0 ? (
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
              {node.employees.length} {node.employees.length === 1 ? 'person' : 'people'}
            </span>
          ) : null}
        </div>

        {people.length > 0 ? (
          <div className="ml-9 mt-1.5 flex flex-wrap gap-1.5">
            {people.map((employee) => (
              <span
                key={employee.id}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] dark:border-slate-800 dark:bg-slate-900/60"
                title={`${employee.name} · ${employee.employeeCode} · ${employee.branchName || employee.branchId}`}
              >
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-indigo-600 text-[8px] font-bold text-white">
                  {employee.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="font-semibold text-slate-800 dark:text-slate-200">{employee.name}</span>
                <span className="font-mono text-slate-400">{employee.employeeCode}</span>
                <span className="text-slate-500 dark:text-slate-400">
                  {employee.branchName || employee.branchId}
                </span>
              </span>
            ))}
          </div>
        ) : null}

        {hasChildren && !isCollapsed ? (
          <div className="ml-4 mt-2 border-l border-dashed border-slate-300 pl-3 dark:border-slate-700">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  };

  if (!allowed) {
    return (
      <div className="space-y-3">
        <PageHeader title="Organizational Chart" description="The chart is read with the HR employee-view grant." />
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs font-semibold text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle className="mr-1 inline h-4 w-4" />
          This account does not hold the HR employee-view permission, so the chart is not shown.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Organizational Chart"
        description="Derived from the Employee Directory and the graded designation catalogue — reporting lines live in Org Masters, not in this screen."
        actions={
          <button
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
            disabled={loading}
            className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        }
      />

      {loadError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300"
        >
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
            className="cursor-pointer rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-bold text-white"
          >
            Retry
          </button>
        </div>
      ) : null}

      <div className="space-y-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-[#12161f]">
        <div className="flex flex-wrap items-center gap-2">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by post, employee, code, grade, department or branch…"
            className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none"
          />
          <div className="flex items-center gap-0.5 rounded-lg border border-slate-300 p-0.5 dark:border-slate-700">
            {(
              [
                ['TREE', 'Tree', Network],
                ['DEPARTMENTS', 'Departments', LayoutGrid],
                ['GRADES', 'Grades', Layers],
                ['BRANCH', 'Branch', MapPin],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                aria-pressed={view === id}
                className={`flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold ${
                  view === id
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                <Icon className="h-3 w-3" /> {label}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-slate-500 dark:text-slate-400">
            {loading ? 'Reading…' : `${chart.totalEmployees} employees`}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-600 dark:text-slate-400">
          {[
            { label: 'Departments', value: chart.departmentCount, icon: Building2 },
            { label: 'Designations', value: chart.designationCount, icon: Briefcase },
            { label: 'Filled posts', value: chart.filled, icon: Users },
            { label: 'Vacant posts', value: chart.vacant, icon: AlertTriangle },
          ].map((card) => {
            const Icon = card.icon;
            return (
              <span key={card.label} className="inline-flex items-center gap-1" title={`${card.label}: ${loading ? '—' : card.value}`}>
                <Icon className="h-3 w-3 text-slate-400" />
                <b className="text-[10px] font-bold text-slate-800 dark:text-slate-200">{loading ? '—' : card.value}</b>{' '}
                {card.label.toLowerCase()}
              </span>
            );
          })}
          <span className="hidden h-3 w-px bg-slate-200 sm:inline dark:bg-slate-700" />
          <span className="flex items-center gap-0.5">
            {['G10', 'G9', 'G8', 'G7', 'G6', 'G5', 'G4', 'G3', 'G2', 'G1'].map((grade) => (
              <span key={grade} className={`rounded px-0.5 font-black ${gradeTone(grade)}`}>
                {grade}
              </span>
            ))}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-px w-4 bg-slate-500" /> solid line
          </span>
          <span className="flex items-center gap-1">
            <span className="h-px w-4 border-t border-dashed border-slate-400" /> dotted / advisory
          </span>
          <span className="flex items-center gap-1">
            <span className="rounded-full border border-amber-300 bg-amber-50 px-1 font-bold uppercase text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              vacant
            </span>
            no holder
          </span>
        </div>

        {view === 'BRANCH' ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-1.5 dark:border-slate-800">
            <MapPin className="h-4 w-4 text-indigo-500" />
            <label htmlFor="org-chart-branch" className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Branch
            </label>
            <select
              id="org-chart-branch"
              value={effectiveBranchId ?? ''}
              onChange={(event) => setBranchId(event.target.value)}
              className="h-7 rounded-lg border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-slate-500 dark:text-slate-400">
              {branchHierarchy
                ? `${branchHierarchy.headOfficeEmployees.length} head office core · ${branchHierarchy.branchEmployees.length} branch team · ${branchHierarchy.postCount} posts with people`
                : 'No branch selected'}
            </span>
            <span className="flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" /> head office core
              <span className="ml-1 h-1.5 w-1.5 rounded-full bg-emerald-500" /> branch team
            </span>
            {branchHierarchy && branchHierarchy.unlinkedEmployees.length > 0 ? (
              <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                {branchHierarchy.unlinkedEmployees.length} active employee(s) not linked to a designation
              </span>
            ) : null}
            <span className="ml-auto hidden text-[10px] text-slate-400 sm:inline">
              CEO → COO → departments, with the core team and this branch&rsquo;s own people.
            </span>
          </div>
        ) : null}
      </div>

      {loading && !catalogue ? (
        <div className="rounded-2xl border border-slate-200 p-6 text-center text-xs text-slate-500 dark:border-slate-800">
          Reading the catalogue and employee directory…
        </div>
      ) : chart.roots.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 p-6 text-center text-xs text-slate-500 dark:border-slate-800">
          No designations are configured yet. Add them in HR Org Master → Organization → Org Masters.
        </div>
      ) : view === 'TREE' ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-900/40">
          <div className="flex items-center gap-1.5 pb-2 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <Network className="h-3.5 w-3.5" /> Reporting tree
          </div>
          {chart.roots.map((node) => renderNode(node, 0))}
        </div>
      ) : view === 'DEPARTMENTS' && catalogue ? (
        <OrgChartBoard
          catalogue={catalogue}
          employeesByDesignation={chart.employeesByDesignation}
          needle={needle}
          onClearSearch={() => setQuery('')}
        />
      ) : view === 'BRANCH' ? (
        <div className="space-y-3">
          {branchHierarchy && branchHierarchy.postCount > 0 ? (
            <OrgChartBoard
              catalogue={branchHierarchy.catalogue}
              employeesByDesignation={branchHierarchy.employeesByDesignation}
              needle={needle}
              onClearSearch={() => setQuery('')}
              layoutKey={`branch:${effectiveBranchId}`}
              heading={`Branch hierarchy — ${branchHierarchy.branchName}`}
              teamOf={branchHierarchy.teamOf}
            />
          ) : (
            <div className="rounded-2xl border border-slate-200 p-6 text-center text-xs text-slate-500 dark:border-slate-800">
              Nobody in this branch is linked to a catalogue designation yet. Link them in HR Org Master →
              Organization → Unmatched employees, then reload.
            </div>
          )}
        </div>
      ) : (
        renderGrades()
      )}

      <details className="rounded-xl border border-indigo-200 bg-indigo-50/50 px-3 py-2 text-[10px] text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950/30 dark:text-indigo-200">
        <summary className="cursor-pointer font-bold">
          How this chart is built — and why there is no edit button
        </summary>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
          <li>
            <strong>Posts</strong> come from <strong>HR Org Master → Organization → Org Masters</strong>: all active
            designations, including graded roles nobody holds yet. A post with no employee shows a
            <strong>vacant</strong> badge.
          </li>
          <li>
            <strong>Lines</strong> come from each designation&rsquo;s <strong>Reports To</strong> in the catalogue.
            Change the reporting line there, not here; the chart redraws itself.
          </li>
          <li>
            <strong>People</strong> come from the <strong>Employee Directory</strong> (active employees in your
            branch scope), matched by designation name or code. Moving an employee changes the chart.
          </li>
          <li>
            The <strong>Departments</strong> and <strong>Branch</strong> boards start at the CEO, so the canvas is
            not spent on a governance placeholder. In the <strong>Tree</strong> view the Board of Directors /
            Audit Committee is kept as the external root, and dotted lines are labelled because they are
            not employment edges.
          </li>
          <li>
            <strong>Views</strong> are four readings of the same data, not four charts:{' '}
            <strong>Tree</strong> for reporting lines, <strong>Departments</strong> for the department columns,{' '}
            <strong>Grades</strong> for the G1–G10 salary bands, and <strong>Branch</strong> for the CEO → COO
            chain with the head-office core team and one branch's own team. The search box filters all four.
          </li>
        </ul>
      </details>
    </div>
  );
};

export default OrgChart;
