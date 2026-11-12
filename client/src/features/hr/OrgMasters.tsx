/**
 * People & HR organisation masters — departments, designations and work
 * stations used as suggestions in the employee form. Renaming or retiring a
 * master never rewrites an employee's stored text value.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Briefcase,
  Building2,
  ChevronDown,
  ChevronUp,
  Download,
  Edit2,
  GitBranch,
  MapPin,
  Plus,
  Users,
  X,
} from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import { FilterCard } from '../../components/common/FilterCard';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { ModalPanel } from '../../components/common/ModalPanel';
import { PageHeader } from '../../components/common/PageHeader';
import { api } from '../../services/api';
import type {
  EmployeeRecord,
  HrOrgMasterKind,
  HrOrgCatalogue,
  HrOrgMasterRecord,
  HrOrgUnmatchedEmployee,
} from '../../services/api';
import { isOperationAllowed } from '../../utils/permissions';
import { HR_CATALOGUE_SHEETS, downloadCsv } from '../../utils/hrOrgCatalogueExport';
import type { User } from '../../types';

interface OrgMastersProps {
  currentUser: User | null;
}

interface OrgMasterForm {
  name: string;
  code: string;
  isActive: boolean;
}

const EMPTY_FORM: OrgMasterForm = { name: '', code: '', isActive: true };

const KIND_ORDER: HrOrgMasterKind[] = ['DEPARTMENT', 'DESIGNATION', 'WORK_STATION'];

const KIND_META: Record<
  HrOrgMasterKind,
  {
    label: string;
    singular: string;
    description: string;
    icon: React.ElementType;
    color: string;
    bg: string;
    border: string;
  }
> = {
  DEPARTMENT: {
    label: 'Departments',
    singular: 'department',
    description: 'Teams and functions used to group employees and payroll cost.',
    icon: Building2,
    color: 'text-indigo-600 dark:text-indigo-400',
    bg: 'bg-indigo-50 dark:bg-indigo-950/30',
    border: 'border-indigo-200 dark:border-indigo-900',
  },
  DESIGNATION: {
    label: 'Designations',
    singular: 'designation',
    description: 'Job titles shown on the employee master and payroll register.',
    icon: Briefcase,
    color: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    border: 'border-amber-200 dark:border-amber-900',
  },
  WORK_STATION: {
    label: 'Work Stations',
    singular: 'work station',
    description: 'Offices, sites and field locations where employees are posted.',
    icon: MapPin,
    color: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
    border: 'border-emerald-200 dark:border-emerald-900',
  },
};

const codeFromName = (name: string): string =>
  name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);

export const OrgMasters: React.FC<OrgMastersProps> = ({ currentUser }) => {
  const { alert: alertDialog } = useDialog();
  const activationKey = useActivationKey('hr-org-masters');
  const canManage =
    isOperationAllowed('hr-employee-manage', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);
  // The employee list reads through GET /api/employees, gated on the view
  // grant (or the legacy payroll-master grant) — not on the manage grant.
  const canViewEmployees =
    isOperationAllowed('hr-employee-view', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);

  const [activeKind, setActiveKind] = useState<HrOrgMasterKind>('DEPARTMENT');
  const [masters, setMasters] = useState<HrOrgMasterRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<HrOrgMasterRecord | null>(null);
  const [form, setForm] = useState<OrgMasterForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Grade / reporting line / branch scope editor for a designation. It writes
  // the profile row the org chart reads; the catalogue row keeps its name.
  const [roleEditing, setRoleEditing] = useState<HrOrgMasterRecord | null>(null);
  const [roleForm, setRoleForm] = useState({
    grade: '',
    reportsToId: '',
    reportsToLabel: '',
    dottedLineTo: '',
    branchScope: '',
  });
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleError, setRoleError] = useState('');

  // The employee list is deliberately NOT part of the catalogue read: a master
  // row knows only its own name, and employees are fetched when asked for.
  const [employeeMaster, setEmployeeMaster] = useState<HrOrgMasterRecord | null>(null);
  const [employeeRows, setEmployeeRows] = useState<EmployeeRecord[]>([]);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [employeesLoading, setEmployeesLoading] = useState(false);
  const [employeesError, setEmployeesError] = useState('');
  const employeeRequestRef = useRef(0);
  // One grouped read for all three tab cards; a failure only hides the numbers.
  const [headcounts, setHeadcounts] = useState<Record<HrOrgMasterKind, number> | null>(null);
  // Stored values that no longer name a catalogue entry, so they can be relinked.
  // The graded master sheet behind Org Masters. Read-only here: it is the
  // reference the org chart and the employee form draw from, not a second
  // editable copy.
  const [catalogue, setCatalogue] = useState<HrOrgCatalogue | null>(null);
  const [catalogueTab, setCatalogueTab] = useState<'DESIGNATIONS' | 'GRADES' | 'CLUSTERS'>(
    'DESIGNATIONS'
  );
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [unmatched, setUnmatched] = useState<HrOrgUnmatchedEmployee[]>([]);
  const [unmatchedOpen, setUnmatchedOpen] = useState(false);
  const [relinkTargets, setRelinkTargets] = useState<Record<string, string>>({});
  const [relinking, setRelinking] = useState<string | null>(null);

  const loadMasters = async () => {
    setLoading(true);
    try {
      const [rows, headcountRows, unmatchedRows, catalogueRows] = await Promise.all([
        api.getHrOrgMasters(),
        api.getHrOrgHeadcounts().catch(() => null),
        api.getHrOrgUnmatched().catch(() => null),
        api.getHrOrgCatalogue().catch(() => null),
      ]);
      setMasters(Array.isArray(rows) ? rows : []);
      if (headcountRows) setHeadcounts(headcountRows);
      if (unmatchedRows) setUnmatched(Array.isArray(unmatchedRows) ? unmatchedRows : []);
      if (catalogueRows) setCatalogue(catalogueRows);
      setLoadError('');
    } catch (err: any) {
      setLoadError(err?.message || 'The organisation catalogue could not be read.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMasters();
    // Refetch after a tab re-activation as well as on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey]);

  const counts = useMemo(() => {
    const next: Record<HrOrgMasterKind, number> = {
      DEPARTMENT: 0,
      DESIGNATION: 0,
      WORK_STATION: 0,
    };
    for (const master of masters) {
      if (master.isActive) next[master.kind] += 1;
    }
    return next;
  }, [masters]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return masters
      .filter((master) => master.kind === activeKind)
      .filter(
        (master) =>
          !needle ||
          master.name.toLowerCase().includes(needle) ||
          (master.code || '').toLowerCase().includes(needle)
      );
  }, [masters, activeKind, search]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setIsModalOpen(true);
  };

  const openEdit = (master: HrOrgMasterRecord) => {
    setEditing(master);
    setForm({
      name: master.name,
      code: master.code || '',
      isActive: master.isActive,
    });
    setIsModalOpen(true);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) {
      alertDialog('A name is required.');
      return;
    }
    const code = (form.code.trim() || codeFromName(name)).toUpperCase();
    if (!code) {
      alertDialog('A code is required.');
      return;
    }

    setSaving(true);
    try {
      if (editing) {
        await api.updateHrOrgMaster(editing.id, {
          name,
          code,
          isActive: form.isActive,
        });
      } else {
        await api.createHrOrgMaster({
          kind: activeKind,
          name,
          code,
          isActive: form.isActive,
        });
      }
      setIsModalOpen(false);
      setEditing(null);
      await loadMasters();
    } catch (err: any) {
      alertDialog(`Failed to save ${KIND_META[activeKind].singular}: ${err?.message || 'Database error'}`);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Employees point at the catalogue row, not at its current name, so this
   * filter keeps the list attached when the master is renamed. The server
   * resolves the link from the employee's stored text on every write, and the
   * schema backfilled the rows that predate it.
   */
  const employeeFilterFor = (master: HrOrgMasterRecord) => {
    if (master.kind === 'DESIGNATION') return { designationId: master.id };
    if (master.kind === 'WORK_STATION') return { workstationId: master.id };
    return { departmentId: master.id };
  };

  const fetchEmployees = async (master: HrOrgMasterRecord, search: string) => {
    const requestId = employeeRequestRef.current + 1;
    employeeRequestRef.current = requestId;
    setEmployeesLoading(true);
    setEmployeesError('');
    try {
      const rows = await api.getEmployees({
        ...employeeFilterFor(master),
        query: search.trim() || undefined,
        limit: 50,
      });
      if (requestId !== employeeRequestRef.current) return;
      setEmployeeRows(Array.isArray(rows) ? rows : []);
    } catch (err: any) {
      if (requestId !== employeeRequestRef.current) return;
      setEmployeesError(err?.message || 'The employee list could not be read.');
    } finally {
      if (requestId === employeeRequestRef.current) setEmployeesLoading(false);
    }
  };

  const openEmployees = (master: HrOrgMasterRecord) => {
    setEmployeeMaster(master);
    setEmployeeRows([]);
    setEmployeeSearch('');
    setEmployeesError('');
    void fetchEmployees(master, '');
  };

  const closeEmployees = () => {
    // A late response for the closed master must not reopen or overwrite it.
    employeeRequestRef.current += 1;
    setEmployeeMaster(null);
    setEmployeeRows([]);
    setEmployeesError('');
    setEmployeesLoading(false);
  };

  const relinkKey = (row: HrOrgUnmatchedEmployee) => `${row.employeeId}:${row.field}`;

  /**
   * Relinking rewrites the employee's stored text to the chosen master, which
   * is what lets the write path resolve the catalogue id again. The old text
   * stays in the audit trail, and the report is re-read afterwards.
   */
  const relinkEmployee = async (row: HrOrgUnmatchedEmployee) => {
    const master = masters.find((entry) => entry.id === relinkTargets[relinkKey(row)]);
    if (!master) return;
    const key = relinkKey(row);
    setRelinking(key);
    try {
      const patch =
        row.field === 'DEPARTMENT'
          ? { department: master.name }
          : row.field === 'WORK_STATION'
            ? { workStation: master.name }
            : { designation: master.name, designationCode: master.code || undefined };
      await api.updateEmployee(row.employeeId, patch);
      setRelinkTargets((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      await loadMasters();
    } catch (err: any) {
      alertDialog(`Could not relink ${row.name}: ${err?.message || 'Database error'}`);
    } finally {
      setRelinking(null);
    }
  };

  const designationDetail = (id: string) =>
    catalogue?.designations.find((row) => row.id === id) ?? null;

  const openRole = (master: HrOrgMasterRecord) => {
    const detail = designationDetail(master.id);
    setRoleEditing(master);
    setRoleForm({
      grade: detail?.grade ?? '',
      reportsToId: detail?.reportsToId ?? '',
      reportsToLabel: detail?.reportsToLabel ?? '',
      dottedLineTo: detail?.dottedLineTo ?? '',
      branchScope: detail?.branchScope ?? '',
    });
    setRoleError('');
  };

  const saveRole = async () => {
    if (!roleEditing || roleSaving) return;
    setRoleSaving(true);
    setRoleError('');
    try {
      await api.updateHrOrgMaster(roleEditing.id, {
        grade: roleForm.grade || null,
        reportsToId: roleForm.reportsToId || null,
        // A solid line makes the outside label meaningless, so it is cleared
        // with the same save instead of lingering behind the chart.
        reportsToLabel: roleForm.reportsToId
          ? null
          : roleForm.reportsToLabel.trim() || null,
        dottedLineTo: roleForm.dottedLineTo.trim() || null,
        branchScope: roleForm.branchScope.trim() || null,
      });
      setRoleEditing(null);
      await loadMasters();
    } catch (err: any) {
      setRoleError(err?.message || 'Could not save the reporting details.');
    } finally {
      setRoleSaving(false);
    }
  };

  const activeMeta = KIND_META[activeKind];

  return (
    <div className="flex h-[calc(100vh-6.5rem)] flex-col space-y-4 overflow-hidden">
      <PageHeader
        title="HR Org Masters"
        description={
          loadError && masters.length === 0
            ? 'Organisation catalogue unavailable — retry below'
            : `${masters.length} entries · departments, designations and work stations for the employee form`
        }
        icon={<Building2 className="h-5 w-5 text-indigo-500" />}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              onClick={() => setUnmatchedOpen(true)}
              title="Employees whose stored department, designation or work station is not in the catalogue"
              className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
            >
              <AlertTriangle className="h-4 w-4" />
              <span>Unmatched ({unmatched.length})</span>
            </button>
            {canManage ? (
              <button
                onClick={openCreate}
                className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md transition-all hover:bg-indigo-500"
              >
                <Plus className="h-4 w-4" />
                <span>Add {activeMeta.singular}</span>
              </button>
            ) : null}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {KIND_ORDER.map((kind) => {
          const meta = KIND_META[kind];
          const Icon = meta.icon;
          const selected = activeKind === kind;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => {
                setActiveKind(kind);
                setSearch('');
              }}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                selected
                  ? `${meta.bg} ${meta.border} shadow-sm`
                  : 'border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-800 dark:bg-[#0f1218] dark:hover:bg-slate-800/40'
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon className={`h-4 w-4 shrink-0 ${meta.color}`} />
                <span className="min-w-0">
                  <span className="block text-xs font-bold text-slate-900 dark:text-white">
                    {meta.label}
                  </span>
                  <span className="block text-[10px] text-slate-500 dark:text-slate-400">
                    {counts[kind]} active
                    {headcounts
                      ? ` · ${headcounts[kind]} employee${headcounts[kind] === 1 ? '' : 's'}`
                      : ''}
                  </span>
                </span>
              </span>
              <span className={`h-2 w-2 shrink-0 rounded-full ${selected ? 'bg-indigo-500' : 'bg-slate-300 dark:bg-slate-700'}`} />
            </button>
          );
        })}
      </div>

      <FilterCard
        searchPlaceholder={`Search ${activeMeta.label.toLowerCase()} by name or code…`}
        searchValue={search}
        onSearchApply={setSearch}
        hasActiveFilters={Boolean(search)}
        onClearAll={() => setSearch('')}
      />

      <LoadStateNotice
        subject="organisation masters"
        loading={loading}
        error={loadError}
        hasCachedRows={masters.length > 0}
        onRetry={loadMasters}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-md dark:border-slate-800 dark:bg-[#0f1218]">
        <div className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{activeMeta.description}</p>
        </div>
        <div className="relative min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-20 border-b border-slate-200 bg-slate-100 text-[10px] font-bold tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
              <tr>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Name</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Code</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5 text-center">Status</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-slate-500">
                    {loading
                      ? `Loading ${activeMeta.label.toLowerCase()}…`
                      : loadError
                        ? 'The organisation catalogue could not be loaded — use Retry above.'
                        : masters.filter((master) => master.kind === activeKind).length === 0
                          ? `No ${activeMeta.label.toLowerCase()} configured yet. Add one to make it available in the employee form.`
                          : `No ${activeMeta.label.toLowerCase()} match this search.`}
                  </td>
                </tr>
              ) : (
                filtered.map((master) => (
                  <tr key={master.id} className="transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className="px-2.5 py-1.5 font-bold text-slate-900 dark:text-white">
                      <div className="flex items-center gap-1.5">
                        {React.createElement(KIND_META[master.kind].icon, {
                          className: `h-3.5 w-3.5 ${KIND_META[master.kind].color}`,
                        })}
                        <span>{master.name}</span>
                      </div>
                      {master.kind === 'DESIGNATION' && designationDetail(master.id) ? (
                        <p className="mt-0.5 text-[10px] font-normal text-slate-500 dark:text-slate-400">
                          {[
                            designationDetail(master.id)?.grade,
                            designationDetail(master.id)?.reportsTo
                              ? `Reports to ${designationDetail(master.id)?.reportsTo}`
                              : designationDetail(master.id)?.reportsToLabel,
                            designationDetail(master.id)?.branchScope,
                          ]
                            .filter(Boolean)
                            .join(' · ') || 'No grade or reporting line set'}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-2.5 py-1.5 font-mono text-slate-600 dark:text-slate-400">
                      {master.code || '—'}
                    </td>
                    <td className="px-2.5 py-1.5 text-center">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                          master.isActive
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                            : 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                        }`}
                      >
                        {master.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <div className="flex items-center justify-center gap-1">
                        {canViewEmployees && (
                          <button
                            onClick={() => openEmployees(master)}
                            title={`View employees in ${master.name}`}
                            aria-label={`View employees in ${master.name}`}
                            className="cursor-pointer rounded-lg p-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                          >
                            <Users className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {canManage && master.kind === 'DESIGNATION' ? (
                          <button
                            onClick={() => openRole(master)}
                            disabled={!designationDetail(master.id)}
                            title={
                              designationDetail(master.id)
                                ? `Grade, reporting line and scope for ${master.name}`
                                : 'The catalogue is still loading'
                            }
                            aria-label={`Grade and reporting for ${master.name}`}
                            className="cursor-pointer rounded-lg p-1 text-amber-600 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-40 dark:text-amber-400 dark:hover:bg-amber-950/40"
                          >
                            <GitBranch className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                        {canManage && (
                          <button
                            onClick={() => openEdit(master)}
                            title={`Edit ${master.name}`}
                            className="cursor-pointer rounded-lg p-1 text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {!canManage && !canViewEmployees && (
                          <span className="text-slate-400">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={editing ? `Edit ${activeMeta.singular}` : `Add ${activeMeta.singular}`}
            onClose={() => setIsModalOpen(false)}
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold capitalize">
                  {editing ? `Edit ${activeMeta.singular}` : `Add ${activeMeta.singular}`}
                </h3>
                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                  {editing ? 'Existing employee records keep their stored text.' : activeMeta.description}
                </p>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4 text-xs">
              <div>
                <label className="mb-1 block font-semibold">Name *</label>
                <input
                  type="text"
                  required
                  maxLength={120}
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder={activeKind === 'DEPARTMENT' ? 'Field Operations' : activeKind === 'DESIGNATION' ? 'Technician' : 'Test Station'}
                  className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 dark:border-slate-700"
                />
              </div>

              <div>
                <label className="mb-1 block font-semibold">Code</label>
                <input
                  type="text"
                  maxLength={30}
                  value={form.code}
                  onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })}
                  placeholder="Leave blank to derive it from the name"
                  className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 font-mono dark:border-slate-700"
                />
              </div>

              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                />
                <span className="font-semibold">Active — offer this value in the employee form</span>
              </label>

              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="cursor-pointer rounded-xl bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Entry'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}

      {roleEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={`Grade and reporting — ${roleEditing.name}`}
            onClose={() => setRoleEditing(null)}
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold">Grade, reporting line &amp; scope</h3>
                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                  {roleEditing.name} &middot; {roleEditing.code || 'no code'}
                </p>
              </div>
              <button
                onClick={() => setRoleEditing(null)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close grade and reporting editor"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mb-3 rounded-xl border border-indigo-200 bg-indigo-50/60 p-2.5 text-[10px] text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950/30 dark:text-indigo-200">
              These are the fields the <strong>Organizational Chart</strong> draws: the grade supplies the
              salary band, the reporting line makes the edge, and the branch scope is shown against the
              post. A designation with no solid line is placed under the Board (use the outside label) or
              left out of the tree, so give every post a line.
            </div>

            <form
              className="space-y-3 text-xs"
              onSubmit={(event) => {
                event.preventDefault();
                void saveRole();
              }}
            >
              <div>
                <label className="mb-1 block font-semibold">Grade</label>
                <select
                  value={roleForm.grade}
                  onChange={(event) => setRoleForm({ ...roleForm, grade: event.target.value })}
                  className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 dark:border-slate-700"
                >
                  <option value="">Not graded</option>
                  {(catalogue?.grades ?? []).map((grade) => (
                    <option key={grade.grade} value={grade.grade}>
                      {grade.grade} — {grade.careerBand} (NPR {grade.min.toLocaleString('en-IN')}–
                      {grade.max.toLocaleString('en-IN')})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block font-semibold">Reports to</label>
                <select
                  value={roleForm.reportsToId}
                  onChange={(event) => setRoleForm({ ...roleForm, reportsToId: event.target.value })}
                  className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 dark:border-slate-700"
                >
                  <option value="">None — the line leaves the company</option>
                  {(catalogue?.designations ?? [])
                    .filter((row) => row.id !== roleEditing.id)
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                        {row.code ? ` (${row.code})` : ''}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block font-semibold">Outside-line label</label>
                <input
                  type="text"
                  maxLength={120}
                  value={roleForm.reportsToLabel}
                  disabled={Boolean(roleForm.reportsToId)}
                  onChange={(event) =>
                    setRoleForm({ ...roleForm, reportsToLabel: event.target.value })
                  }
                  placeholder="e.g. Board of Directors / Board Audit Committee (admin: CEO)"
                  className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700"
                />
                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                  Used only when there is no designation above; the chart places the post under the Board.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-semibold">Dotted line to</label>
                  <input
                    type="text"
                    maxLength={120}
                    value={roleForm.dottedLineTo}
                    onChange={(event) =>
                      setRoleForm({ ...roleForm, dottedLineTo: event.target.value })
                    }
                    placeholder="e.g. HR Manager"
                    className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 dark:border-slate-700"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-semibold">Branch scope</label>
                  <input
                    type="text"
                    maxLength={80}
                    value={roleForm.branchScope}
                    onChange={(event) =>
                      setRoleForm({ ...roleForm, branchScope: event.target.value })
                    }
                    placeholder="e.g. Assigned Cluster (5-7 Branches)"
                    className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 dark:border-slate-700"
                  />
                </div>
              </div>

              {roleError ? (
                <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 px-2 py-1.5 text-[11px] font-semibold text-rose-700 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300">
                  {roleError}
                </p>
              ) : null}

              <div className="flex justify-end gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setRoleEditing(null)}
                  className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-[11px] font-semibold dark:border-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={roleSaving}
                  className="cursor-pointer rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {roleSaving ? 'Saving…' : 'Save reporting details'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}

      {employeeMaster && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={`Employees in ${employeeMaster.name}`}
            onClose={closeEmployees}
            className="w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold">Employees in {employeeMaster.name}</h3>
                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                  Linked by the catalogue id stored on each employee, so renaming this master keeps
                  the list attached; the employee's historical text is untouched.
                </p>
              </div>
              <button
                onClick={closeEmployees}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close employee list"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void fetchEmployees(employeeMaster, employeeSearch);
              }}
              className="mb-3 flex items-center gap-2"
            >
              <input
                type="text"
                value={employeeSearch}
                onChange={(event) => setEmployeeSearch(event.target.value)}
                placeholder="Filter by name, employee code, PAN or SSF…"
                className="h-9 flex-1 rounded-lg border border-slate-300 bg-transparent px-3 text-xs dark:border-slate-700"
              />
              <button
                type="submit"
                disabled={employeesLoading}
                className="cursor-pointer rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {employeesLoading ? 'Reading…' : 'Search'}
              </button>
            </form>

            {employeesError && (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
                <span>{employeesError}</span>
                <button
                  type="button"
                  onClick={() => void fetchEmployees(employeeMaster, employeeSearch)}
                  className="cursor-pointer rounded-lg border border-rose-300 px-2 py-0.5 font-bold dark:border-rose-800"
                >
                  Retry
                </button>
              </div>
            )}

            <div className="max-h-[50vh] overflow-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100 text-[10px] font-bold tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
                  <tr>
                    <th className="px-2.5 py-1.5">Code</th>
                    <th className="px-2.5 py-1.5">Employee</th>
                    <th className="px-2.5 py-1.5">Branch</th>
                    <th className="px-2.5 py-1.5">Designation</th>
                    <th className="px-2.5 py-1.5 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {employeeRows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-slate-500">
                        {employeesLoading
                          ? 'Reading employees…'
                          : employeesError
                            ? 'The employee list could not be loaded — use Retry above.'
                            : employeeSearch
                              ? `No employee recorded under this ${employeeMaster.kind === 'WORK_STATION' ? 'work station' : employeeMaster.kind.toLowerCase()} matches "${employeeSearch}".`
                              : `No employee is currently recorded under this ${employeeMaster.kind === 'WORK_STATION' ? 'work station' : employeeMaster.kind.toLowerCase()}.`}
                      </td>
                    </tr>
                  ) : (
                    employeeRows.map((employee) => (
                      <tr key={employee.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="px-2.5 py-1.5 font-mono text-slate-600 dark:text-slate-400">
                          {employee.employeeCode}
                        </td>
                        <td className="px-2.5 py-1.5 font-bold text-slate-900 dark:text-white">
                          {employee.name}
                        </td>
                        <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                          {employee.branchId}
                        </td>
                        <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                          {employee.designation || '—'}
                          {employee.designationCode ? (
                            <span className="ml-1.5 text-[10px] text-slate-400">
                              {employee.designationCode}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-2.5 py-1.5 text-center">
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                              employee.isActive
                                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                                : 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                            }`}
                          >
                            {employee.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400">
              {employeesLoading
                ? 'Reading the employee master…'
                : employeeRows.length >= 50
                  ? 'Showing the first 50 — search to narrow the list.'
                  : `${employeeRows.length} employee${employeeRows.length === 1 ? '' : 's'} shown.`}
            </p>
          </ModalPanel>
        </div>
      )}

      {canViewEmployees ? (
        <div className="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#12161f]">
          <button
            type="button"
            onClick={() => setCatalogueOpen((value) => !value)}
            className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left"
          >
            <span className="flex flex-wrap items-center gap-2">
              <BookOpen className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
              <span className="text-xs font-bold text-slate-900 dark:text-white">
                Refactored role catalogue
              </span>
              <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                {catalogue
                  ? `${catalogue.designations.length} posts · ${catalogue.grades.length} grades · ${catalogue.clusters.length} clusters · ${catalogue.branchPlan.length} planned branches`
                  : 'Reading the catalogue…'}
              </span>
            </span>
            {catalogueOpen ? (
              <ChevronUp className="h-4 w-4 text-slate-500" />
            ) : (
              <ChevronDown className="h-4 w-4 text-slate-500" />
            )}
          </button>

          {catalogueOpen ? (
            <div className="border-t border-slate-200 p-3 dark:border-slate-800">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ['DESIGNATIONS', `Designations (${catalogue?.designations.length ?? 0})`],
                      ['GRADES', `Grading matrix (${catalogue?.grades.length ?? 0})`],
                      ['CLUSTERS', `Clusters & branches (${catalogue?.clusters.length ?? 0}/${catalogue?.branchPlan.length ?? 0})`],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setCatalogueTab(id)}
                      className={`cursor-pointer rounded-lg px-2.5 py-1 text-[10px] font-bold ${
                        catalogueTab === id
                          ? 'bg-indigo-600 text-white'
                          : 'border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[9px] font-bold uppercase tracking-wide text-slate-400">
                    Export CSV
                  </span>
                  {HR_CATALOGUE_SHEETS.map((sheet) => (
                    <button
                      key={sheet.id}
                      type="button"
                      disabled={!catalogue}
                      onClick={() => {
                        if (catalogue) downloadCsv(sheet.file, sheet.build(catalogue));
                      }}
                      title={`${sheet.label} — one file per workbook sheet`}
                      className="flex cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <Download className="h-3 w-3" /> {sheet.label}
                    </button>
                  ))}
                </div>
              </div>

              {!catalogue ? (
                <p className="p-4 text-center text-[11px] text-slate-500">
                  The catalogue could not be read. Refresh the screen to try again.
                </p>
              ) : catalogueTab === 'DESIGNATIONS' ? (
                <div className="max-h-80 overflow-auto rounded-xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full border-collapse text-left text-[11px]">
                    <thead className="sticky top-0 border-b border-slate-200 bg-slate-100 text-[9px] font-bold uppercase tracking-wide text-slate-600 dark:border-slate-800 dark:bg-[#161b25] dark:text-slate-400">
                      <tr>
                        <th className="px-2 py-1.5">Code</th>
                        <th className="px-2 py-1.5">Designation</th>
                        <th className="px-2 py-1.5">Department</th>
                        <th className="px-2 py-1.5">Grade</th>
                        <th className="px-2 py-1.5">Band (NPR)</th>
                        <th className="px-2 py-1.5">Reports to</th>
                        <th className="px-2 py-1.5">Scope</th>
                        <th className="px-2 py-1.5">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {catalogue.designations.map((row) => (
                        <tr key={row.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                          <td className="px-2 py-1 font-mono text-[10px] text-slate-500">{row.code}</td>
                          <td className="px-2 py-1 font-semibold text-slate-900 dark:text-white">{row.name}</td>
                          <td className="px-2 py-1 text-slate-600 dark:text-slate-400">{row.department || '—'}</td>
                          <td className="px-2 py-1 font-mono text-[10px]">{row.grade || '—'}</td>
                          <td className="px-2 py-1 text-slate-600 dark:text-slate-400">
                            {row.bandMin != null && row.bandMax != null
                              ? `${row.bandMin.toLocaleString('en-IN')}–${row.bandMax.toLocaleString('en-IN')}`
                              : '—'}
                          </td>
                          <td className="px-2 py-1 text-slate-600 dark:text-slate-400">
                            {row.reportsTo || row.reportsToLabel || '—'}
                          </td>
                          <td className="px-2 py-1 text-slate-600 dark:text-slate-400">{row.branchScope || '—'}</td>
                          <td className="px-2 py-1 text-slate-600 dark:text-slate-400">{row.roleStatus || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : catalogueTab === 'GRADES' ? (
                <div className="max-h-80 overflow-auto rounded-xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full border-collapse text-left text-[11px]">
                    <thead className="sticky top-0 border-b border-slate-200 bg-slate-100 text-[9px] font-bold uppercase tracking-wide text-slate-600 dark:border-slate-800 dark:bg-[#161b25] dark:text-slate-400">
                      <tr>
                        <th className="px-2 py-1.5">Grade</th>
                        <th className="px-2 py-1.5">Band</th>
                        <th className="px-2 py-1.5">Min</th>
                        <th className="px-2 py-1.5">Step 1</th>
                        <th className="px-2 py-1.5">Step 2</th>
                        <th className="px-2 py-1.5">Step 3</th>
                        <th className="px-2 py-1.5">Max</th>
                        <th className="px-2 py-1.5">Promotion rule</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {catalogue.grades.map((grade) => (
                        <tr key={grade.grade} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                          <td className="px-2 py-1 font-mono font-bold">{grade.grade}</td>
                          <td className="px-2 py-1 text-slate-600 dark:text-slate-400">{grade.careerBand}</td>
                          <td className="px-2 py-1">{grade.min.toLocaleString('en-IN')}</td>
                          <td className="px-2 py-1">{grade.step1.toLocaleString('en-IN')}</td>
                          <td className="px-2 py-1">{grade.step2.toLocaleString('en-IN')}</td>
                          <td className="px-2 py-1">{grade.step3.toLocaleString('en-IN')}</td>
                          <td className="px-2 py-1">{grade.max.toLocaleString('en-IN')}</td>
                          <td className="max-w-[260px] px-2 py-1 text-[10px] text-slate-600 dark:text-slate-400">
                            {grade.promotionRule || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="max-h-80 space-y-3 overflow-auto">
                  <table className="w-full border-collapse text-left text-[11px]">
                    <thead className="border-b border-slate-200 text-[9px] font-bold uppercase tracking-wide text-slate-600 dark:border-slate-800 dark:text-slate-400">
                      <tr>
                        <th className="px-2 py-1.5">Cluster</th>
                        <th className="px-2 py-1.5">Hub</th>
                        <th className="px-2 py-1.5">Province</th>
                        <th className="px-2 py-1.5">Branches</th>
                        <th className="px-2 py-1.5">Note</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {catalogue.clusters.map((cluster) => (
                        <tr key={cluster.id}>
                          <td className="px-2 py-1 font-semibold">{cluster.name}</td>
                          <td className="px-2 py-1 text-slate-600 dark:text-slate-400">{cluster.hub}</td>
                          <td className="px-2 py-1 text-slate-600 dark:text-slate-400">{cluster.province || '—'}</td>
                          <td className="px-2 py-1 font-mono">{cluster.branchCount}</td>
                          <td className="max-w-[280px] px-2 py-1 text-[10px] text-slate-600 dark:text-slate-400">
                            {cluster.notes || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <table className="w-full border-collapse text-left text-[11px]">
                    <thead className="border-b border-slate-200 text-[9px] font-bold uppercase tracking-wide text-slate-600 dark:border-slate-800 dark:text-slate-400">
                      <tr>
                        <th className="px-2 py-1.5">Code</th>
                        <th className="px-2 py-1.5">Branch</th>
                        <th className="px-2 py-1.5">Cluster</th>
                        <th className="px-2 py-1.5">Tier</th>
                        <th className="px-2 py-1.5">Head post</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {catalogue.branchPlan.map((branch) => (
                        <tr key={branch.code}>
                          <td className="px-2 py-1 font-mono text-[10px] text-slate-500">{branch.code}</td>
                          <td className="px-2 py-1 font-semibold">{branch.name}</td>
                          <td className="px-2 py-1 text-slate-600 dark:text-slate-400">{branch.clusterName}</td>
                          <td className="px-2 py-1 text-slate-600 dark:text-slate-400">{branch.tier}</td>
                          <td className="px-2 py-1 text-slate-600 dark:text-slate-400">{branch.headDesignation}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400">
                Read-only view of the refactored master sheet. The reporting lines shown here are what the
                <strong> Organizational Chart</strong> draws, and the grade supplies the salary band — there is no
                second copy to keep in sync. This plan does not create operational branches; map a row to a live
                branch only when that branch opens.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {unmatchedOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label="Employees not linked to the catalogue"
            onClose={() => setUnmatchedOpen(false)}
            className="w-full max-w-4xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold">Employees not linked to the catalogue</h3>
                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                  Their stored department, designation or work station no longer names an entry, so the
                  employee list cannot attach them. Pick the entry they belong to and relink: the stored
                  text is rewritten to it, which reconnects the catalogue id. The old text stays in the
                  audit trail.
                </p>
              </div>
              <button
                onClick={() => setUnmatchedOpen(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close unmatched employees"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[55vh] overflow-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100 text-[10px] font-bold tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
                  <tr>
                    <th className="px-2.5 py-1.5">Employee</th>
                    <th className="px-2.5 py-1.5">Field</th>
                    <th className="px-2.5 py-1.5">Stored value</th>
                    <th className="px-2.5 py-1.5">Relink to</th>
                    <th className="px-2.5 py-1.5 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {unmatched.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-slate-500">
                        Every employee's department, designation and work station matches the catalogue.
                      </td>
                    </tr>
                  ) : (
                    unmatched.map((row) => {
                      const key = relinkKey(row);
                      const target = relinkTargets[key] || '';
                      const options = masters.filter((entry) => entry.kind === row.field);
                      return (
                        <tr key={key} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                          <td className="px-2.5 py-1.5">
                            <span className="font-bold text-slate-900 dark:text-white">{row.name}</span>
                            <span className="ml-1.5 font-mono text-[10px] text-slate-500 dark:text-slate-400">
                              {row.employeeCode} · {row.branchId}
                            </span>
                          </td>
                          <td className="px-2.5 py-1.5 capitalize text-slate-600 dark:text-slate-400">
                            {KIND_META[row.field].singular}
                          </td>
                          <td className="px-2.5 py-1.5">
                            <span className="inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                              {row.value}
                            </span>
                          </td>
                          <td className="px-2.5 py-1.5">
                            <select
                              aria-label={`Relink ${row.name} ${row.field}`}
                              disabled={!canManage}
                              value={target}
                              onChange={(event) =>
                                setRelinkTargets((prev) => ({ ...prev, [key]: event.target.value }))
                              }
                              className="h-8 rounded-lg border border-slate-300 bg-transparent px-2 text-[11px] dark:border-slate-700"
                            >
                              <option value="">Choose…</option>
                              {options.map((master) => (
                                <option key={master.id} value={master.id}>
                                  {master.name}
                                  {master.code ? ` (${master.code})` : ''}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2.5 py-1.5 text-center">
                            <button
                              onClick={() => void relinkEmployee(row)}
                              disabled={!canManage || !target || relinking === key}
                              className="cursor-pointer rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {relinking === key ? 'Relinking…' : 'Relink'}
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400">
              {unmatched.length === 0
                ? 'Nothing to relink.'
                : `${unmatched.length} unmatched value${unmatched.length === 1 ? '' : 's'} across ${
                    new Set(unmatched.map((row) => row.employeeId)).size
                  } employee(s). The report shows at most 500 rows.`}
            </p>
          </ModalPanel>
        </div>
      )}
    </div>
  );
};

export default OrgMasters;
