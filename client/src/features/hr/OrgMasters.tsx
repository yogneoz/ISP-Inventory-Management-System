/**
 * People & HR organisation masters — departments, designations and work
 * stations used as suggestions in the employee form. Renaming or retiring a
 * master never rewrites an employee's stored text value.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Briefcase, Building2, Edit2, MapPin, Plus, X } from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import { FilterCard } from '../../components/common/FilterCard';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { ModalPanel } from '../../components/common/ModalPanel';
import { PageHeader } from '../../components/common/PageHeader';
import { api } from '../../services/api';
import type { HrOrgMasterKind, HrOrgMasterRecord } from '../../services/api';
import { isOperationAllowed } from '../../utils/permissions';
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

  const [activeKind, setActiveKind] = useState<HrOrgMasterKind>('DEPARTMENT');
  const [masters, setMasters] = useState<HrOrgMasterRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<HrOrgMasterRecord | null>(null);
  const [form, setForm] = useState<OrgMasterForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const loadMasters = async () => {
    setLoading(true);
    try {
      const rows = await api.getHrOrgMasters();
      setMasters(Array.isArray(rows) ? rows : []);
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
          canManage ? (
            <button
              onClick={openCreate}
              className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md transition-all hover:bg-indigo-500"
            >
              <Plus className="h-4 w-4" />
              <span>Add {activeMeta.singular}</span>
            </button>
          ) : null
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
                        {canManage ? (
                          <button
                            onClick={() => openEdit(master)}
                            title={`Edit ${master.name}`}
                            className="cursor-pointer rounded-lg p-1 text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </button>
                        ) : (
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
    </div>
  );
};

export default OrgMasters;
