/**
 * Settings → User Permissions → Permission sets (phase 2 of
 * docs/permission-overrides-plan.md).
 *
 * A set is a named bundle of GRANTS shared by several people. It exists so a
 * common bundle ("vendor desk", "stock auditor") is defined once instead of
 * copied into every user's exceptions. Sets never carry a deny: a per-user
 * deny still wins, so membership can never silently close an operation the
 * role allows.
 *
 * The panel only edits definitions. Assigning a set to a user happens in the
 * User exceptions tab, next to that person's individual exceptions.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { User } from '../../types';
import { api } from '../../services/api';
import type { PermissionSetSummary } from '../../services/api';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { useDialog } from '../../components/common/DialogProvider';
import { DEFAULT_GROUPS } from './PermissionManagement';
import {
  AlertTriangle,
  Check,
  Layers,
  Plus,
  Save,
  Search,
  Trash2,
  Users,
} from 'lucide-react';

export interface PermissionSetsPanelProps {
  sets: PermissionSetSummary[];
  users: User[];
  loading: boolean;
  error: string;
  onRetry: () => void;
  /** Re-reads the sets (and the selected user's effective answer) after a write. */
  onChanged: () => Promise<void>;
}

interface SetDraft {
  name: string;
  description: string;
  grants: string[];
}

const emptyDraft = (): SetDraft => ({ name: '', description: '', grants: [] });

const draftFingerprint = (draft: SetDraft) =>
  JSON.stringify([draft.name.trim(), draft.description.trim(), [...draft.grants].sort()]);

const draftFromSet = (set: PermissionSetSummary): SetDraft => ({
  name: set.name,
  description: set.description,
  grants: [...set.grants],
});

export const PermissionSetsPanel: React.FC<PermissionSetsPanelProps> = ({
  sets,
  users,
  loading,
  error,
  onRetry,
  onChanged,
}) => {
  const { confirm: confirmDialog } = useDialog();
  const [selectedId, setSelectedId] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<SetDraft>(emptyDraft);
  const [listSearch, setListSearch] = useState('');
  const [operationSearch, setOperationSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState('');
  // Fingerprint of the last saved draft; the success banner is derived, so a
  // later edit hides it without a second piece of state to keep in sync.
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);

  const selected = sets.find((set) => set.id === selectedId) || null;

  // Open the first set on arrival, and recover when the selected one is deleted
  // by another tab (or by this one).
  useEffect(() => {
    if (creating) return;
    if (selectedId && sets.some((set) => set.id === selectedId)) return;
    setSelectedId(sets[0]?.id || '');
  }, [sets, selectedId, creating]);

  // Seed from the server whenever the chosen definition changes. Unsaved local
  // edits are not overwritten because `sets` only changes after a refresh.
  useEffect(() => {
    if (creating) return;
    setDraft(selected ? draftFromSet(selected) : emptyDraft());
    setSaveError('');
  }, [creating, selected?.id, selected?.updatedAt]);

  const baseline = useMemo(
    () => (creating ? emptyDraft() : selected ? draftFromSet(selected) : emptyDraft()),
    [creating, selected?.id, selected?.updatedAt]
  );
  const dirty = draftFingerprint(baseline) !== draftFingerprint(draft);
  const saved = savedFingerprint !== null && savedFingerprint === draftFingerprint(draft);

  const filteredSets = useMemo(() => {
    const query = listSearch.trim().toLowerCase();
    if (!query) return sets;
    return sets.filter(
      (set) =>
        set.name.toLowerCase().includes(query) ||
        set.description.toLowerCase().includes(query)
    );
  }, [sets, listSearch]);

  const visibleGroups = useMemo(() => {
    const query = operationSearch.trim().toLowerCase();
    return DEFAULT_GROUPS.map((group) => {
      const groupMatches = group.category.toLowerCase().includes(query);
      return {
        ...group,
        operations: group.operations.filter((operation) => {
          if (!query || groupMatches) return true;
          return (
            operation.operationName.toLowerCase().includes(query) ||
            operation.description.toLowerCase().includes(query) ||
            operation.id.toLowerCase().includes(query)
          );
        }),
      };
    }).filter((group) => group.operations.length > 0);
  }, [operationSearch]);

  const memberNames = useMemo(() => {
    if (!selected) return [];
    return selected.members.map(
      (id) => users.find((user) => user.id === id)?.name || id
    );
  }, [selected, users]);

  const guardDiscard = async (): Promise<boolean> => {
    if (!dirty) return true;
    return confirmDialog('Discard the unsaved changes to this permission set?', {
      title: 'Unsaved changes',
      confirmLabel: 'Discard',
    });
  };

  const selectSet = async (set: PermissionSetSummary) => {
    if (!creating && set.id === selectedId) return;
    if (!(await guardDiscard())) return;
    setCreating(false);
    setSelectedId(set.id);
    setSaveError('');
    setSavedFingerprint(null);
  };

  const startNew = async () => {
    if (!(await guardDiscard())) return;
    setCreating(true);
    setSelectedId('');
    setDraft(emptyDraft());
    setOperationSearch('');
    setSaveError('');
    setSavedFingerprint(null);
  };

  const toggleGrant = (operationId: string) => {
    if (saving || deleting) return;
    setDraft((current) => {
      const has = current.grants.includes(operationId);
      return {
        ...current,
        grants: has
          ? current.grants.filter((id) => id !== operationId)
          : [...current.grants, operationId].sort(),
      };
    });
    setSaveError('');
  };

  const toggleGroup = (operationIds: string[], allSelected: boolean) => {
    if (saving || deleting) return;
    setDraft((current) => {
      const next = new Set(current.grants);
      for (const id of operationIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return { ...current, grants: [...next].sort() };
    });
    setSaveError('');
  };

  const handleSave = async () => {
    if (saving || deleting) return;
    const name = draft.name.trim();
    if (!name) {
      setSaveError('A set name is required.');
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      const payload = {
        name,
        description: draft.description.trim(),
        grants: [...draft.grants].sort(),
      };
      const next = creating
        ? await api.createPermissionSet(payload)
        : await api.updatePermissionSet(selected!.id, payload);
      await onChanged();
      setCreating(false);
      setSelectedId(next.id);
      setDraft(draftFromSet(next));
      setSavedFingerprint(draftFingerprint(draftFromSet(next)));
    } catch (err: any) {
      setSaveError(err?.message || 'The permission set could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selected || saving || deleting) return;
    const memberNote =
      selected.members.length === 0
        ? 'No user is assigned to it.'
        : `${selected.members.length} user${selected.members.length === 1 ? '' : 's'} will immediately lose its grants.`;
    const ok = await confirmDialog(
      `Delete the permission set "${selected.name}"? ${memberNote}`,
      { title: 'Delete permission set', confirmLabel: 'Delete set' }
    );
    if (!ok) return;
    setDeleting(true);
    setSaveError('');
    try {
      await api.deletePermissionSet(selected.id);
      await onChanged();
      setSelectedId('');
      setDraft(emptyDraft());
      setSavedFingerprint(null);
    } catch (err: any) {
      setSaveError(err?.message || 'The permission set could not be deleted.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5 rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-[11px] leading-5 text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
        <Layers className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          A permission set is a reusable bundle of <strong>grants</strong>. Assign it to several
          people in <strong>User exceptions</strong>; an individual deny on a user still wins.
          Deleting a set removes its grants from every member immediately.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
        {/* Set list */}
        <section className="rounded-2xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 p-3 dark:border-slate-800">
            <div>
              <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100">Permission sets</h3>
              <p className="text-[10px] text-slate-500 dark:text-slate-400">
                {sets.length} set{sets.length === 1 ? '' : 's'} defined
              </p>
            </div>
            <button
              type="button"
              onClick={() => void startNew()}
              disabled={saving || deleting}
              className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-[10px] font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
            >
              <Plus className="h-3.5 w-3.5" /> New
            </button>
          </div>
          <div className="border-b border-slate-200 p-2.5 dark:border-slate-800">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={listSearch}
                onChange={(event) => setListSearch(event.target.value)}
                placeholder="Search sets…"
                aria-label="Search permission sets"
                className="w-full rounded-xl border border-slate-300 bg-slate-50 py-2 pl-9 pr-3 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>
          </div>
          <div className="max-h-[calc(100vh-300px)] overflow-y-auto p-1.5">
            {filteredSets.length === 0 ? (
              <p className="p-4 text-center text-[11px] text-slate-500 dark:text-slate-400">
                {sets.length === 0
                  ? 'No sets yet. Create one to bundle grants several people share.'
                  : 'No set matches this search.'}
              </p>
            ) : (
              filteredSets.map((set) => {
                const active = !creating && set.id === selectedId;
                return (
                  <button
                    key={set.id}
                    type="button"
                    onClick={() => void selectSet(set)}
                    aria-current={active ? 'true' : undefined}
                    className={`mb-1 w-full rounded-xl px-2.5 py-2 text-left transition-colors ${
                      active
                        ? 'bg-blue-50 ring-1 ring-blue-300 dark:bg-blue-950/40 dark:ring-blue-800'
                        : 'hover:bg-slate-100 dark:hover:bg-slate-800/60'
                    }`}
                  >
                    <span className="block truncate text-xs font-bold text-slate-900 dark:text-slate-100">
                      {set.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-slate-500 dark:text-slate-400">
                      {set.grants.length} grant{set.grants.length === 1 ? '' : 's'} ·{' '}
                      {set.members.length} member{set.members.length === 1 ? '' : 's'}
                    </span>
                    {set.description && (
                      <span className="mt-0.5 block truncate text-[10px] text-slate-400 dark:text-slate-500">
                        {set.description}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* Editor */}
        <section className="min-w-0 rounded-2xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
          {error ? (
            <div className="p-4">
              <LoadStateNotice
                subject="the permission sets"
                loading={loading}
                error={error}
                onRetry={onRetry}
              />
            </div>
          ) : loading && sets.length === 0 && !creating ? (
            <div className="p-4">
              <LoadStateNotice
                subject="the permission sets"
                loading
                error=""
                onRetry={onRetry}
              />
            </div>
          ) : !selected && !creating ? (
            <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 p-8 text-center">
              <Layers className="h-8 w-8 text-slate-300 dark:text-slate-600" />
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                No permission set selected
              </p>
              <p className="max-w-md text-[11px] text-slate-500 dark:text-slate-400">
                Create a set for a bundle of grants that more than one person needs.
              </p>
              <button
                type="button"
                onClick={() => void startNew()}
                className="mt-1 flex items-center gap-1.5 rounded-xl bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
              >
                <Plus className="h-4 w-4" /> New permission set
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3 border-b border-slate-200 p-4 dark:border-slate-800 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                      {creating ? 'New permission set' : selected!.name}
                    </h3>
                    {!creating && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                        {draft.grants.length} grant{draft.grants.length === 1 ? '' : 's'}
                      </span>
                    )}
                    {dirty && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                        Unsaved changes
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                    {creating
                      ? 'Name the bundle, then tick the operations it grants.'
                      : `Used by ${selected!.members.length} user${selected!.members.length === 1 ? '' : 's'} · last saved ${new Date(selected!.updatedAt).toLocaleString()}`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {!creating && (
                    <button
                      type="button"
                      onClick={() => void handleDelete()}
                      disabled={saving || deleting}
                      className="flex items-center gap-1 rounded-xl border border-rose-300 px-2.5 py-1.5 text-[11px] font-bold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {deleting ? 'Deleting…' : 'Delete set'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={saving || deleting || !dirty}
                    className="flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-md shadow-blue-600/20 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
                  >
                    <Save className="h-4 w-4" />
                    {saving ? 'Saving…' : creating ? 'Create set' : 'Save set'}
                  </button>
                </div>
              </div>

              <div className="space-y-3 p-4">
                {saveError && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-semibold leading-5 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{saveError} Nothing was saved.</span>
                  </div>
                )}
                {saved && (
                  <div
                    role="status"
                    className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] font-semibold leading-5 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                  >
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Saved. The server enforces the new grants immediately for every assigned
                      user, and their open tab refreshes through the permissions broadcast.
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                  <label className="block text-[10px] font-bold text-slate-600 dark:text-slate-400">
                    Set name <span aria-hidden="true">*</span>
                    <input
                      type="text"
                      value={draft.name}
                      maxLength={120}
                      disabled={saving || deleting}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, name: event.target.value }))
                      }
                      placeholder="e.g. Vendor desk"
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    />
                  </label>
                  <label className="block text-[10px] font-bold text-slate-600 dark:text-slate-400">
                    Description (optional)
                    <input
                      type="text"
                      value={draft.description}
                      maxLength={500}
                      disabled={saving || deleting}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, description: event.target.value }))
                      }
                      placeholder="What is this bundle for?"
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200">
                        Granted operations
                      </h4>
                      <div className="relative w-full sm:max-w-[220px]">
                        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                        <input
                          type="search"
                          value={operationSearch}
                          onChange={(event) => setOperationSearch(event.target.value)}
                          placeholder="Search operations…"
                          aria-label="Search granted operations"
                          className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pl-9 pr-3 text-[11px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                        />
                      </div>
                    </div>

                    {visibleGroups.length === 0 ? (
                      <p className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-center text-[11px] text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
                        No operations match this filter.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {visibleGroups.map((group) => {
                          const ids = group.operations.map((operation) => operation.id);
                          const selectedCount = ids.filter((id) => draft.grants.includes(id)).length;
                          const allSelected = ids.length > 0 && selectedCount === ids.length;
                          return (
                            <div
                              key={group.id}
                              className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800"
                            >
                              <div className="flex items-center justify-between gap-3 bg-slate-100 px-3 py-2 dark:bg-slate-800/70">
                                <div className="min-w-0">
                                  <p className="truncate text-xs font-bold text-slate-800 dark:text-slate-200">
                                    {group.category}
                                  </p>
                                  <p className="text-[10px] text-slate-500 dark:text-slate-400">
                                    {selectedCount} of {ids.length} granted
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => toggleGroup(ids, allSelected)}
                                  disabled={saving || deleting}
                                  className="shrink-0 rounded-lg border border-slate-300 px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-white disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                                >
                                  {allSelected ? 'Clear group' : 'Grant all'}
                                </button>
                              </div>
                              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                                {group.operations.map((operation) => {
                                  const checked = draft.grants.includes(operation.id);
                                  return (
                                    <label
                                      key={operation.id}
                                      className="flex cursor-pointer items-start gap-2 p-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={saving || deleting}
                                        onChange={() => toggleGrant(operation.id)}
                                        className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                      />
                                      <span className="min-w-0">
                                        <span className="block text-xs font-semibold text-slate-900 dark:text-slate-100">
                                          {operation.operationName}
                                        </span>
                                        <span className="block text-[10px] leading-4 text-slate-500 dark:text-slate-400">
                                          {operation.description}
                                        </span>
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <aside className="space-y-2">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-800/40">
                      <div className="flex items-center gap-1.5">
                        <Users className="h-4 w-4 text-slate-500 dark:text-slate-400" />
                        <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200">
                          Assigned users
                        </h4>
                      </div>
                      {creating ? (
                        <p className="mt-2 text-[10px] leading-4 text-slate-500 dark:text-slate-400">
                          Assign the new set after creating it, from the User exceptions tab.
                        </p>
                      ) : memberNames.length === 0 ? (
                        <p className="mt-2 text-[10px] leading-4 text-slate-500 dark:text-slate-400">
                          Nobody is assigned yet. Use the User exceptions tab to add members.
                        </p>
                      ) : (
                        <ul className="mt-2 space-y-1">
                          {memberNames.slice(0, 8).map((name, index) => (
                            <li
                              key={`${name}-${index}`}
                              className="truncate text-[11px] text-slate-700 dark:text-slate-300"
                            >
                              {name}
                            </li>
                          ))}
                          {memberNames.length > 8 && (
                            <li className="text-[10px] text-slate-500 dark:text-slate-400">
                              +{memberNames.length - 8} more
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                    <p className="px-1 text-[10px] leading-4 text-slate-500 dark:text-slate-400">
                      A set grants operations only. It never changes a user&apos;s role, branch
                      scope, or an individual deny.
                    </p>
                  </aside>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
};
