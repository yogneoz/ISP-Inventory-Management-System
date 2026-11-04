/**
 * Cost-centre master — the analytical dimension posted on journal lines.
 * A centre is either global (no branch) or belongs to one branch; a branch
 * centre may sit under a parent centre in the same branch. Posted lines and
 * child centres block deletion, so the screen retires instead.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Building2, Edit2, Layers, Plus, Trash2, X } from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import { FilterCard } from '../../components/common/FilterCard';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { ModalPanel } from '../../components/common/ModalPanel';
import { PageHeader } from '../../components/common/PageHeader';
import { api } from '../../services/api';
import { isOperationAllowed } from '../../utils/permissions';
import type { Branch, CostCenter, User } from '../../types';

interface CostCentersManagementProps {
  branches?: Branch[];
  currentUser?: User | null;
}

interface CostCenterForm {
  code: string;
  name: string;
  parentId: string;
  branchId: string;
  active: boolean;
}

const EMPTY_FORM: CostCenterForm = {
  code: '',
  name: '',
  parentId: '',
  branchId: '',
  active: true,
};

const codeFromName = (name: string): string =>
  name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);

export const CostCentersManagement: React.FC<CostCentersManagementProps> = ({
  branches = [],
  currentUser,
}) => {
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const canManage = isOperationAllowed('gl-manage', currentUser?.role);
  const activationKey = useActivationKey('cost-centers');

  const [centers, setCenters] = useState<CostCenter[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<CostCenter | null>(null);
  const [form, setForm] = useState<CostCenterForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const loadCenters = async () => {
    setLoading(true);
    try {
      const rows = await api.getCostCenters(true);
      setCenters(Array.isArray(rows) ? rows : []);
      setLoadError('');
    } catch (err: any) {
      setLoadError(err?.message || 'The cost-centre list could not be read.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadCenters();
    // Refetch after a tab re-activation as well as on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey]);

  const branchLabel = (id?: string | null) =>
    id ? branches.find((branch) => branch.id === id)?.name || id : 'All branches';

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return centers;
    return centers.filter(
      (center) =>
        center.code.toLowerCase().includes(needle) ||
        center.name.toLowerCase().includes(needle) ||
        branchLabel(center.branchId).toLowerCase().includes(needle)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centers, search, branches]);

  const parentOptions = useMemo(
    () =>
      centers.filter(
        (center) =>
          center.id !== editing?.id &&
          center.active &&
          (form.branchId ? center.branchId === form.branchId : !center.branchId)
      ),
    [centers, editing?.id, form.branchId]
  );

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setIsModalOpen(true);
  };

  const openEdit = (center: CostCenter) => {
    setEditing(center);
    setForm({
      code: center.code,
      name: center.name,
      parentId: center.parentId || '',
      branchId: center.branchId || '',
      active: center.active,
    });
    setIsModalOpen(true);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) {
      alertDialog('A cost-centre name is required.');
      return;
    }
    const code = (form.code.trim() || codeFromName(name)).toUpperCase();
    if (!code) {
      alertDialog('A cost-centre code is required.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        code,
        name,
        parentId: form.parentId || null,
        branchId: form.branchId || null,
        active: form.active,
      };
      if (editing) await api.updateCostCenter(editing.id, payload);
      else await api.createCostCenter(payload);
      setIsModalOpen(false);
      await loadCenters();
    } catch (err: any) {
      alertDialog(`Failed to save cost centre: ${err?.message || 'Database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (center: CostCenter) => {
    if (
      !(await confirmDialog(
        `Delete '${center.name}'? A centre used by posted lines or child centres must be retired instead.`
      ))
    ) {
      return;
    }
    try {
      await api.deleteCostCenter(center.id);
      await loadCenters();
    } catch (err: any) {
      alertDialog(`Failed to delete cost centre: ${err?.message || 'Database error'}`);
    }
  };

  return (
    <div className="flex h-[calc(100vh-6.5rem)] flex-col space-y-4 overflow-hidden">
      <PageHeader
        title="Cost Centers"
        description={
          loadError && centers.length === 0
            ? 'Cost-centre list unavailable — retry below'
            : `${centers.length} analytical centres · post them on manual journal lines`
        }
        icon={<Layers className="h-5 w-5 text-indigo-500" />}
        actions={
          canManage ? (
            <button
              onClick={openCreate}
              className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md transition-all hover:bg-indigo-500"
            >
              <Plus className="h-4 w-4" />
              <span>Add Cost Center</span>
            </button>
          ) : null
        }
      />

      <FilterCard
        searchPlaceholder="Search code, name or branch…"
        searchValue={search}
        onSearchApply={setSearch}
        hasActiveFilters={Boolean(search)}
        onClearAll={() => setSearch('')}
      />

      <LoadStateNotice
        subject="cost centers"
        loading={loading}
        error={loadError}
        hasCachedRows={centers.length > 0}
        onRetry={loadCenters}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-md dark:border-slate-800 dark:bg-[#0f1218]">
        <div className="relative min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-20 border-b border-slate-200 bg-slate-100 text-[10px] font-bold tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
              <tr>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Code</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Cost Center</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Parent</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Branch</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5 text-center">Status</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-slate-500">
                    {loading
                      ? 'Loading cost centers…'
                      : loadError
                        ? 'The cost-centre list could not be loaded — use Retry above.'
                        : centers.length === 0
                          ? 'No cost centers are configured. Add one before posting analytical journal lines.'
                          : 'No cost centers match this search.'}
                  </td>
                </tr>
              ) : (
                filtered.map((center) => (
                  <tr key={center.id} className="transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className="px-2.5 py-1.5 font-mono font-bold text-indigo-600 dark:text-indigo-400">
                      {center.code}
                    </td>
                    <td className="px-2.5 py-1.5 font-bold text-slate-900 dark:text-white">
                      <div className="flex items-center gap-1.5">
                        <Layers className="h-3.5 w-3.5 text-indigo-500" />
                        <span>{center.name}</span>
                      </div>
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      {center.parentName || '—'}
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        <Building2 className="h-3 w-3 text-slate-400" />
                        {branchLabel(center.branchId)}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 text-center">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                          center.active
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                            : 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                        }`}
                      >
                        {center.active ? 'Active' : 'Retired'}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <div className="flex items-center justify-center gap-1">
                        {canManage ? (
                          <>
                            <button
                              onClick={() => openEdit(center)}
                              title={`Edit ${center.name}`}
                              className="cursor-pointer rounded-lg p-1 text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleDelete(center)}
                              title={`Delete ${center.name}`}
                              className="cursor-pointer rounded-lg p-1 text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
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
            label={editing ? 'Edit Cost Center' : 'Add Cost Center'}
            onClose={() => setIsModalOpen(false)}
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-bold">{editing ? 'Edit Cost Center' : 'Add Cost Center'}</h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-semibold">Code *</label>
                  <input
                    type="text"
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                    placeholder="BRANCH_OPS"
                    className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 font-mono dark:border-slate-700"
                  />
                  <p className="mt-1 text-[10px] text-slate-500">Leave blank to derive it from the name.</p>
                </div>
                <div>
                  <label className="mb-1 block font-semibold">Name *</label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Branch Operations"
                    className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 dark:border-slate-700"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-semibold">Parent Center</label>
                  <select
                    value={form.parentId}
                    onChange={(e) => setForm({ ...form, parentId: e.target.value })}
                    className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 dark:border-slate-700"
                  >
                    <option value="">No parent (top level)</option>
                    {parentOptions.map((center) => (
                      <option key={center.id} value={center.id}>
                        {center.code} · {center.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-semibold">Branch</label>
                  <select
                    value={form.branchId}
                    onChange={(e) => setForm({ ...form, branchId: e.target.value })}
                    className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 dark:border-slate-700"
                  >
                    <option value="">All branches</option>
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[10px] text-slate-500">A branch centre is usable only in that branch.</p>
                </div>
              </div>

              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                />
                <span className="font-semibold">Active — offer this centre on new journal lines</span>
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
                  {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Cost Center'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}
    </div>
  );
};

export default CostCentersManagement;