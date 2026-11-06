/**
 * Narration-template master — reusable journal/payment descriptions.
 * The template is only a quick-pick: the posted journal stores the chosen text,
 * never the template id, so editing or retiring a template cannot rewrite history.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Edit2, MessageSquare, Plus, Trash2, X } from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import { FilterCard } from '../../components/common/FilterCard';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { ModalPanel } from '../../components/common/ModalPanel';
import { PageHeader } from '../../components/common/PageHeader';
import { api } from '../../services/api';
import { isOperationAllowed } from '../../utils/permissions';
import type { NarrationTemplate, NarrationTransactionType, User } from '../../types';

interface NarrationTemplatesManagementProps {
  currentUser?: User | null;
}

interface NarrationForm {
  code: string;
  text: string;
  transactionType: NarrationTransactionType;
  active: boolean;
}

const TRANSACTION_TYPES: Array<{ value: NarrationTransactionType; label: string }> = [
  { value: 'ALL', label: 'All transactions' },
  { value: 'MANUAL_JOURNAL', label: 'Manual journal' },
  { value: 'CUSTOMER_RECEIPT', label: 'Customer receipt' },
  { value: 'VENDOR_PAYMENT', label: 'Vendor payment' },
  { value: 'EXPENSE', label: 'Expense' },
  { value: 'PAYROLL', label: 'Payroll' },
  { value: 'OPENING_BALANCE', label: 'Opening balance' },
];

const typeLabel = (value: NarrationTransactionType) =>
  TRANSACTION_TYPES.find((type) => type.value === value)?.label || value;

const EMPTY_FORM: NarrationForm = {
  code: '',
  text: '',
  transactionType: 'ALL',
  active: true,
};

const codeFromText = (text: string): string =>
  text
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);

export const NarrationTemplatesManagement: React.FC<NarrationTemplatesManagementProps> = ({
  currentUser,
}) => {
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const canManage = isOperationAllowed('gl-dimension-manage', currentUser?.role);
  const activationKey = useActivationKey('narration-templates');

  const [templates, setTemplates] = useState<NarrationTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<NarrationTemplate | null>(null);
  const [form, setForm] = useState<NarrationForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const loadTemplates = async () => {
    setLoading(true);
    try {
      const rows = await api.getNarrationTemplates(true);
      setTemplates(Array.isArray(rows) ? rows : []);
      setLoadError('');
    } catch (err: any) {
      setLoadError(err?.message || 'The narration-template list could not be read.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTemplates();
    // Refetch after a tab re-activation as well as on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return templates;
    return templates.filter(
      (template) =>
        template.code.toLowerCase().includes(needle) ||
        template.text.toLowerCase().includes(needle) ||
        typeLabel(template.transactionType).toLowerCase().includes(needle)
    );
  }, [search, templates]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setIsModalOpen(true);
  };

  const openEdit = (template: NarrationTemplate) => {
    setEditing(template);
    setForm({
      code: template.code,
      text: template.text,
      transactionType: template.transactionType,
      active: template.active,
    });
    setIsModalOpen(true);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const narration = form.text.trim();
    if (!narration) {
      alertDialog('Narration text is required.');
      return;
    }
    const code = (form.code.trim() || codeFromText(narration)).toUpperCase();
    if (!code) {
      alertDialog('A narration code is required.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        code,
        text: narration,
        transactionType: form.transactionType,
        active: form.active,
      };
      if (editing) await api.updateNarrationTemplate(editing.id, payload);
      else await api.createNarrationTemplate(payload);
      setIsModalOpen(false);
      await loadTemplates();
    } catch (err: any) {
      alertDialog(`Failed to save narration template: ${err?.message || 'Database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (template: NarrationTemplate) => {
    if (!(await confirmDialog(`Delete narration '${template.code}'?`))) return;
    try {
      await api.deleteNarrationTemplate(template.id);
      await loadTemplates();
    } catch (err: any) {
      alertDialog(`Failed to delete narration template: ${err?.message || 'Database error'}`);
    }
  };

  return (
    <div className="flex h-[calc(100vh-6.5rem)] flex-col space-y-4 overflow-hidden">
      <PageHeader
        title="Narration Templates"
        description={
          loadError && templates.length === 0
            ? 'Narration-template list unavailable — retry below'
            : `${templates.length} reusable descriptions · pick text; the journal stores the text, not the template`
        }
        icon={<MessageSquare className="h-5 w-5 text-indigo-500" />}
        actions={
          canManage ? (
            <button
              onClick={openCreate}
              className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md transition-all hover:bg-indigo-500"
            >
              <Plus className="h-4 w-4" />
              <span>Add Narration</span>
            </button>
          ) : null
        }
      />

      <FilterCard
        searchPlaceholder="Search code, text or transaction type…"
        searchValue={search}
        onSearchApply={setSearch}
        hasActiveFilters={Boolean(search)}
        onClearAll={() => setSearch('')}
      />

      <LoadStateNotice
        subject="narration templates"
        loading={loading}
        error={loadError}
        hasCachedRows={templates.length > 0}
        onRetry={loadTemplates}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-md dark:border-slate-800 dark:bg-[#0f1218]">
        <div className="relative min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-20 border-b border-slate-200 bg-slate-100 text-[10px] font-bold tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
              <tr>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Code</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Narration Text</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Transaction Type</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5 text-center">Status</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-slate-500">
                    {loading
                      ? 'Loading narration templates…'
                      : loadError
                        ? 'The narration-template list could not be loaded — use Retry above.'
                        : templates.length === 0
                          ? 'No narration templates are configured. Add one to standardise journal and payment text.'
                          : 'No narration templates match this search.'}
                  </td>
                </tr>
              ) : (
                filtered.map((template) => (
                  <tr key={template.id} className="transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className="px-2.5 py-1.5 font-mono font-bold text-indigo-600 dark:text-indigo-400">
                      {template.code}
                    </td>
                    <td className="max-w-xl px-2.5 py-1.5 text-slate-800 dark:text-slate-200">
                      <div className="flex items-start gap-1.5">
                        <MessageSquare className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-indigo-500" />
                        <span className="line-clamp-2">{template.text}</span>
                      </div>
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      {typeLabel(template.transactionType)}
                    </td>
                    <td className="px-2.5 py-1.5 text-center">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                          template.active
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                            : 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                        }`}
                      >
                        {template.active ? 'Active' : 'Retired'}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <div className="flex items-center justify-center gap-1">
                        {canManage ? (
                          <>
                            <button
                              onClick={() => openEdit(template)}
                              title={`Edit ${template.code}`}
                              className="cursor-pointer rounded-lg p-1 text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleDelete(template)}
                              title={`Delete ${template.code}`}
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
            label={editing ? 'Edit Narration Template' : 'Add Narration Template'}
            onClose={() => setIsModalOpen(false)}
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-bold">
                {editing ? 'Edit Narration Template' : 'Add Narration Template'}
              </h3>
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
                    placeholder="CASH_SALE"
                    className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 font-mono dark:border-slate-700"
                  />
                  <p className="mt-1 text-[10px] text-slate-500">Leave blank to derive it from the text.</p>
                </div>
                <div>
                  <label className="mb-1 block font-semibold">Transaction Type *</label>
                  <select
                    value={form.transactionType}
                    onChange={(e) =>
                      setForm({ ...form, transactionType: e.target.value as NarrationTransactionType })
                    }
                    className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 dark:border-slate-700"
                  >
                    {TRANSACTION_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="mb-1 block font-semibold">Narration Text *</label>
                <textarea
                  rows={4}
                  required
                  value={form.text}
                  onChange={(e) => setForm({ ...form, text: e.target.value })}
                  placeholder="e.g. Cash received against invoice"
                  className="w-full resize-y rounded-lg border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700"
                />
                <p className="mt-1 text-[10px] text-slate-500">
                  This text is copied into the journal/payment memo. Editing it later never changes posted text.
                </p>
              </div>

              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                />
                <span className="font-semibold">Active — offer this template in quick-picks</span>
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
                  {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Narration'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}
    </div>
  );
};

export default NarrationTemplatesManagement;