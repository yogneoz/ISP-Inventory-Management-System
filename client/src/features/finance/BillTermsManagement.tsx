/**
 * Bill Terms master — reusable credit policies that drive invoice due dates.
 *
 * `dueDays` is counted from the invoice date (0 = due on receipt). Parties can
 * default to a term; an invoice snapshots the resolved due date, so editing a
 * term later never rewrites posted history. A term used by a party or invoice
 * cannot be deleted; retire it instead.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Edit2, Plus, Trash2, X } from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import { FilterCard } from '../../components/common/FilterCard';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { ModalPanel } from '../../components/common/ModalPanel';
import { PageHeader } from '../../components/common/PageHeader';
import { api } from '../../services/api';
import { isOperationAllowed } from '../../utils/permissions';
import type { BillTerm, User } from '../../types';

interface BillTermsManagementProps {
  currentUser?: User | null;
}

interface BillTermForm {
  code: string;
  name: string;
  dueDays: string;
  discountDays: string;
  discountPercent: string;
  active: boolean;
}

const EMPTY_FORM: BillTermForm = {
  code: '',
  name: '',
  dueDays: '0',
  discountDays: '',
  discountPercent: '',
  active: true,
};

const codeFromName = (name: string): string =>
  name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);

function dueLabel(term: BillTerm): string {
  return Number(term.dueDays) === 0 ? 'Due on receipt' : `${term.dueDays} days from invoice date`;
}

function discountLabel(term: BillTerm): string {
  const percent = Number(term.discountPercent);
  if (!Number.isFinite(percent) || percent <= 0) return '—';
  const days = Number(term.discountDays);
  return Number.isFinite(days)
    ? `${percent}% within ${days} day${days === 1 ? '' : 's'}`
    : `${percent}% early-payment discount`;
}

export const BillTermsManagement: React.FC<BillTermsManagementProps> = ({ currentUser }) => {
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const canManage = isOperationAllowed('gl-bill-terms-manage', currentUser?.role);
  const activationKey = useActivationKey('bill-terms');

  const [terms, setTerms] = useState<BillTerm[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<BillTerm | null>(null);
  const [form, setForm] = useState<BillTermForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const loadTerms = async () => {
    setLoading(true);
    try {
      const rows = await api.getBillTerms(true);
      setTerms(Array.isArray(rows) ? rows : []);
      setLoadError('');
    } catch (err: any) {
      setLoadError(err?.message || 'The bill-terms list could not be read.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTerms();
    // Refetch after a tab re-activation as well as on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return terms;
    return terms.filter(
      (term) =>
        term.code.toLowerCase().includes(needle) ||
        term.name.toLowerCase().includes(needle) ||
        dueLabel(term).toLowerCase().includes(needle)
    );
  }, [search, terms]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setIsModalOpen(true);
  };

  const openEdit = (term: BillTerm) => {
    setEditing(term);
    setForm({
      code: term.code,
      name: term.name,
      dueDays: String(term.dueDays),
      discountDays: term.discountDays == null ? '' : String(term.discountDays),
      discountPercent: term.discountPercent == null ? '' : String(term.discountPercent),
      active: term.active,
    });
    setIsModalOpen(true);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) {
      alertDialog('A bill-term name is required.');
      return;
    }
    const code = (form.code.trim() || codeFromName(name)).toUpperCase();
    if (!code) {
      alertDialog('A bill-term code is required.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        code,
        name,
        dueDays: Number(form.dueDays) || 0,
        discountDays: form.discountDays.trim() === '' ? null : Number(form.discountDays),
        discountPercent: form.discountPercent.trim() === '' ? null : Number(form.discountPercent),
        active: form.active,
      };
      if (editing) await api.updateBillTerm(editing.id, payload);
      else await api.createBillTerm(payload);
      setIsModalOpen(false);
      await loadTerms();
    } catch (err: any) {
      alertDialog(`Failed to save bill terms: ${err?.message || 'Database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (term: BillTerm) => {
    if (
      !(await confirmDialog(
        `Delete '${term.name}'? Terms used by a party or invoice cannot be deleted — retire them instead.`
      ))
    ) {
      return;
    }
    try {
      await api.deleteBillTerm(term.id);
      await loadTerms();
    } catch (err: any) {
      alertDialog(`Failed to delete bill terms: ${err?.message || 'Database error'}`);
    }
  };

  return (
    <div className="flex h-[calc(100vh-6.5rem)] flex-col space-y-4 overflow-hidden">
      <PageHeader
        title="Bill Terms"
        description={
          loadError && terms.length === 0
            ? 'Bill-terms list unavailable — retry below'
            : `${terms.length} credit policies · due dates are counted from the invoice date`
        }
        icon={<CalendarClock className="h-5 w-5 text-indigo-500" />}
        actions={
          canManage ? (
            <button
              onClick={openCreate}
              className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md transition-all hover:bg-indigo-500"
            >
              <Plus className="h-4 w-4" />
              <span>Add Bill Terms</span>
            </button>
          ) : null
        }
      />

      <FilterCard
        searchPlaceholder="Search code, name or due rule…"
        searchValue={search}
        onSearchApply={setSearch}
        hasActiveFilters={Boolean(search)}
        onClearAll={() => setSearch('')}
      />

      <LoadStateNotice
        subject="bill terms"
        loading={loading}
        error={loadError}
        hasCachedRows={terms.length > 0}
        onRetry={loadTerms}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-md dark:border-slate-800 dark:bg-[#0f1218]">
        <div className="relative min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-20 border-b border-slate-200 bg-slate-100 text-[10px] font-bold tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
              <tr>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Code</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Name</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Due Rule</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Early-Payment Discount</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5 text-center">Status</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-slate-500">
                    {loading
                      ? 'Loading bill terms…'
                      : loadError
                        ? 'The bill-terms list could not be loaded — use Retry above.'
                        : terms.length === 0
                          ? 'No bill terms are configured. Add one to make credit due dates explicit.'
                          : 'No bill terms match this search.'}
                  </td>
                </tr>
              ) : (
                filtered.map((term) => (
                  <tr
                    key={term.id}
                    className="transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40"
                  >
                    <td className="px-2.5 py-1.5 font-mono font-bold text-indigo-600 dark:text-indigo-400">
                      {term.code}
                    </td>
                    <td className="px-2.5 py-1.5 font-bold text-slate-900 dark:text-white">
                      <div className="flex items-center gap-1.5">
                        <CalendarClock className="h-3.5 w-3.5 text-indigo-500" />
                        <span>{term.name}</span>
                      </div>
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-700 dark:text-slate-300">
                      {dueLabel(term)}
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      {discountLabel(term)}
                    </td>
                    <td className="px-2.5 py-1.5 text-center">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                          term.active
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                            : 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                        }`}
                      >
                        {term.active ? 'Active' : 'Retired'}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <div className="flex items-center justify-center gap-1">
                        {canManage ? (
                          <>
                            <button
                              onClick={() => openEdit(term)}
                              title={`Edit ${term.name}`}
                              className="cursor-pointer rounded-lg p-1 text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleDelete(term)}
                              title={`Delete ${term.name}`}
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
            label={editing ? 'Edit Bill Terms' : 'Add Bill Terms'}
            onClose={() => setIsModalOpen(false)}
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-bold">
                {editing ? 'Edit Bill Terms' : 'Add Bill Terms'}
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
                    required
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                    placeholder="NET_30"
                    className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 font-mono dark:border-slate-700"
                  />
                  <p className="mt-1 text-[10px] text-slate-500">
                    Leave blank to derive it from the name.
                  </p>
                </div>
                <div>
                  <label className="mb-1 block font-semibold">Name *</label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Net 30 Days"
                    className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 dark:border-slate-700"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block font-semibold">Due Days *</label>
                  <input
                    type="number"
                    min="0"
                    max="3650"
                    required
                    value={form.dueDays}
                    onChange={(e) => setForm({ ...form, dueDays: e.target.value })}
                    className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 font-mono dark:border-slate-700"
                  />
                  <p className="mt-1 text-[10px] text-slate-500">0 = due on receipt.</p>
                </div>
                <div>
                  <label className="mb-1 block font-semibold">Discount Days</label>
                  <input
                    type="number"
                    min="0"
                    max="3650"
                    value={form.discountDays}
                    onChange={(e) => setForm({ ...form, discountDays: e.target.value })}
                    placeholder="Optional"
                    className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 font-mono dark:border-slate-700"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-semibold">Discount %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={form.discountPercent}
                    onChange={(e) => setForm({ ...form, discountPercent: e.target.value })}
                    placeholder="Optional"
                    className="h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 font-mono dark:border-slate-700"
                  />
                </div>
              </div>

              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                />
                <span className="font-semibold">Active — offer this term on new invoices</span>
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
                  {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Bill Terms'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}
    </div>
  );
};

export default BillTermsManagement;
