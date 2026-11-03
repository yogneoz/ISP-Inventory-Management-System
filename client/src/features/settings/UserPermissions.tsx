/**
 * Settings → User Access & Exceptions: the per-user exception editor above
 * the role matrix (docs/permission-overrides-plan.md §10).
 *
 * The role matrix screen answers "what may this ROLE do?". This screen answers
 * "may this ONE PERSON do it?" without copying the role. Each operation is a
 * tri-state — Inherit (the role's answer), Grant, or Deny — and only the
 * differences are sent; the server resolves and enforces the result.
 *
 * Phase 2 adds a Permission sets tab (reusable grant bundles) and an
 * "Assigned permission sets" card in the user editor. The effective preview
 * includes set grants, while an individual deny still wins — the same order the
 * server resolves.
 *
 * Access is SUPER_ADMIN-only in three places: the route table, the sidebar, and
 * the server endpoints. The screen never authorises itself; it only decides
 * whether to render controls.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Branch, User } from '../../types';
import { api } from '../../services/api';
import type {
  PermissionSetSummary,
  UserPermissionOverridesResponse,
} from '../../services/api';
import { PageHeader } from '../../components/common/PageHeader';
import { DateField } from '../../components/DateField';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { useDialog } from '../../components/common/DialogProvider';
import { DEFAULT_GROUPS } from './PermissionManagement';
import { PermissionSetsPanel } from './PermissionSetsPanel';
import {
  countDraftChanges,
  draftEffectFor,
  draftsFingerprint,
  draftsFromOverrides,
  draftsToPayload,
  effectivePreview,
  setDraftEffect,
  updateDraft,
  validateDrafts,
  type PermissionDraftEffect,
  type PermissionOverrideDrafts,
} from '../../utils/userPermissionDraft';
import {
  AlertTriangle,
  Check,
  Info,
  RotateCcw,
  Layers,
  Save,
  Search,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';

export interface UserAccessFocusRequest {
  userId: string;
  /** Monotonic token: reopening the same person must still re-focus. */
  requestId: number;
  /** Optional operation to reveal once that account's exceptions load. */
  operationId?: string;
}

export interface UserPermissionsProps {
  currentUser: User;
  users: User[];
  branches: Branch[];
  dateMode: 'BS' | 'AD';
  /** A request from the Users screen to open one person's access editor. */
  focusRequest?: UserAccessFocusRequest | null;
  /** Opens the role-wide defaults screen. */
  onOpenRoleDefaults?: () => void;
}

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  INVENTORY_MANAGER: 'Inventory Manager',
  BRANCH_MANAGER: 'Branch Manager',
  FRONT_DESK: 'Front Desk',
  ACCOUNTANT: 'Accountant',
  HEAD_OFFICE_ADMIN: 'Head Office Admin',
  PROCUREMENT_OFFICER: 'Procurement Officer',
  FIELD_TECHNICIAN: 'Field Technician',
  AUDITOR: 'Auditor',
};

const EFFECT_LABELS: Record<PermissionDraftEffect, string> = {
  inherit: 'Inherit',
  grant: 'Grant',
  deny: 'Deny',
};

const todayAD = () => new Date().toISOString().slice(0, 10);

function roleLabel(role: string): string {
  return ROLE_LABELS[role] || role.replace(/_/g, ' ');
}

function branchLabel(user: User, branches: Branch[]): string {
  if (user.branchId === 'ALL') return 'All branches';
  const ids = [user.branchId, ...(user.allowedBranchIds || [])].filter(Boolean) as string[];
  const names = [...new Set(ids)]
    .map((id) => branches.find((branch) => branch.id === id)?.name || id)
    .filter(Boolean);
  if (names.length === 0) return 'No branch assigned';
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

export const UserPermissions: React.FC<UserPermissionsProps> = ({
  currentUser,
  users,
  branches,
  dateMode,
  focusRequest,
  onOpenRoleDefaults,
}) => {
  const { confirm: confirmDialog } = useDialog();
  const isSuperAdmin = currentUser.role === 'SUPER_ADMIN';

  const [selectedUserId, setSelectedUserId] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [response, setResponse] = useState<UserPermissionOverridesResponse | null>(null);
  const [drafts, setDrafts] = useState<PermissionOverrideDrafts>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [operationSearch, setOperationSearch] = useState('');
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  // A role-matrix drill-down can name one operation. Once that account's
  // exceptions load, clear the filters, expand its group and ring the row so
  // the admin lands on the exception instead of searching for it again.
  const [focusedOperationId, setFocusedOperationId] = useState<string | null>(null);
  const [pendingOperationFocus, setPendingOperationFocus] = useState<{
    userId: string;
    operationId: string;
  } | null>(null);
  const focusedRowRef = useRef<HTMLDivElement | null>(null);

  // Phase 2: the editor has two views — individual exceptions and the reusable
  // sets. The sets list also feeds the "Assigned permission sets" card below.
  const [view, setView] = useState<'users' | 'sets'>('users');
  const [sets, setSets] = useState<PermissionSetSummary[]>([]);
  const [setsLoading, setSetsLoading] = useState(false);
  const [setsLoadError, setSetsLoadError] = useState('');
  const [assignedSetDraft, setAssignedSetDraft] = useState<string[]>([]);
  const [savingSets, setSavingSets] = useState(false);
  const [setsSaveError, setSetsSaveError] = useState('');
  const [setsSaved, setSetsSaved] = useState(false);

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) || null,
    [users, selectedUserId]
  );

  // First visit opens a real account, preferring someone an exception can
  // actually apply to (a Super Admin is immutable and would show a dead editor).
  useEffect(() => {
    if (selectedUserId && users.some((user) => user.id === selectedUserId)) return;
    const preferred = users.find((user) => user.role !== 'SUPER_ADMIN') || users[0];
    setSelectedUserId(preferred?.id || '');
  }, [users, selectedUserId]);

  const load = useCallback(async (userId: string) => {
    setLoading(true);
    setLoadError('');
    setSaveError('');
    setSaved(false);
    try {
      const next = await api.getUserPermissionOverrides(userId);
      setResponse(next);
      setDrafts(draftsFromOverrides(next.overrides));
      setValidationErrors({});
      setSetsSaved(false);
    } catch (err: any) {
      setResponse(null);
      setDrafts({});
      setSetsSaved(false);
      setLoadError(err?.message || 'The user permission exceptions could not be read.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSets = useCallback(async () => {
    if (!isSuperAdmin) return;
    setSetsLoading(true);
    setSetsLoadError('');
    try {
      setSets(await api.getPermissionSets());
    } catch (err: any) {
      setSetsLoadError(err?.message || 'The permission sets could not be read.');
    } finally {
      setSetsLoading(false);
    }
  }, [isSuperAdmin]);

  useEffect(() => {
    void loadSets();
  }, [loadSets]);

  // A server read is the source of truth for membership. Local checkbox edits
  // leave `response` untouched, so this never fights the draft.
  useEffect(() => {
    setAssignedSetDraft(response?.setIds || []);
  }, [response?.userId, response?.setIds]);

  useEffect(() => {
    if (selectedUserId) void load(selectedUserId);
  }, [selectedUserId, load]);

  const serverDrafts = useMemo(
    () => draftsFromOverrides(response?.overrides || []),
    [response]
  );
  const dirty = Boolean(response) && draftsFingerprint(serverDrafts) !== draftsFingerprint(drafts);
  const changes = countDraftChanges(drafts);

  // Grants from the currently ticked sets, so the effective preview matches
  // what the server will resolve after Save (an individual deny still wins).
  const setGrants = useMemo(() => {
    const granted = new Set<string>();
    for (const set of sets) {
      if (!assignedSetDraft.includes(set.id)) continue;
      for (const operationId of set.grants) granted.add(operationId);
    }
    return granted;
  }, [sets, assignedSetDraft]);
  const serverSetIds = useMemo(() => [...(response?.setIds || [])].sort(), [response?.setIds]);
  const normalizedSetDraft = useMemo(() => [...assignedSetDraft].sort(), [assignedSetDraft]);
  const setsDirty =
    Boolean(response) && JSON.stringify(serverSetIds) !== JSON.stringify(normalizedSetDraft);

  const preview = response ? effectivePreview(response.base, drafts, setGrants) : null;
  const readOnly = !isSuperAdmin || response?.role === 'SUPER_ADMIN';

  const filteredUsers = useMemo(() => {
    const query = userSearch.trim().toLowerCase();
    if (!query) return users;
    return users.filter(
      (user) =>
        user.name.toLowerCase().includes(query) ||
        user.email.toLowerCase().includes(query) ||
        roleLabel(user.role).toLowerCase().includes(query) ||
        (user.id || '').toLowerCase().includes(query)
    );
  }, [users, userSearch]);

  const visibleGroups = useMemo(() => {
    const query = operationSearch.trim().toLowerCase();
    return DEFAULT_GROUPS.map((group) => {
      const groupMatches = group.category.toLowerCase().includes(query);
      return {
        ...group,
        operations: group.operations.filter((operation) => {
          if (differencesOnly && !drafts[operation.id]) return false;
          if (!query || groupMatches) return true;
          return (
            operation.operationName.toLowerCase().includes(query) ||
            operation.description.toLowerCase().includes(query) ||
            operation.id.toLowerCase().includes(query)
          );
        }),
      };
    }).filter((group) => group.operations.length > 0);
  }, [operationSearch, differencesOnly, drafts]);

  const handleSelectUser = async (user: User) => {
    if (user.id === selectedUserId) return;
    if (
      dirty &&
      !(await confirmDialog(
        `Discard the unsaved permission changes for ${selectedUser?.name || 'the current user'}?`,
        { title: 'Unsaved changes', confirmLabel: 'Discard' }
      ))
    ) {
      return;
    }
    // Clear the previous account's rows before the new read lands: the header
    // must never sit above another user's exceptions, even for one frame.
    setResponse(null);
    setDrafts({});
    setValidationErrors({});
    setSaveError('');
    setSelectedUserId(user.id);
    setOperationSearch('');
    setDifferencesOnly(false);
    setSaved(false);
    setSetsSaveError('');
    setSetsSaved(false);
  };

  // A deep link from Users selects one account through the same path as a
  // click in the left-hand list, so the unsaved-draft confirmation still runs.
  const consumedFocusRef = useRef<number | null>(null);
  useEffect(() => {
    if (!focusRequest || consumedFocusRef.current === focusRequest.requestId) return;
    const target = users.find((user) => user.id === focusRequest.userId);
    if (!target) return;
    consumedFocusRef.current = focusRequest.requestId;
    setView('users');
    if (target.id !== selectedUserId) void handleSelectUser(target);
    if (focusRequest.operationId) {
      setPendingOperationFocus({ userId: target.id, operationId: focusRequest.operationId });
    } else {
      setPendingOperationFocus(null);
      setFocusedOperationId(null);
    }
  }, [focusRequest, users, selectedUserId]);

  // Wait for the requested account's own read before revealing the row: the
  // previous account's response must never be mistaken for this one's.
  useEffect(() => {
    if (!pendingOperationFocus) return;
    if (selectedUserId !== pendingOperationFocus.userId) return;
    if (response?.userId !== pendingOperationFocus.userId) return;
    const group = DEFAULT_GROUPS.find((candidate) =>
      candidate.operations.some((operation) => operation.id === pendingOperationFocus.operationId)
    );
    // A stale link (operation removed from the catalogue) must not leave the
    // screen waiting forever.
    if (!group) {
      setPendingOperationFocus(null);
      return;
    }
    setOperationSearch('');
    setDifferencesOnly(false);
    setCollapsedGroups((current) =>
      current[group.id] ? { ...current, [group.id]: false } : current
    );
    setFocusedOperationId(pendingOperationFocus.operationId);
    setPendingOperationFocus(null);
  }, [pendingOperationFocus, selectedUserId, response]);

  useEffect(() => {
    if (!focusedOperationId) return;
    const node = focusedRowRef.current;
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [focusedOperationId]);

  const handleReset = () => {
    if (!selectedUserId || saving) return;
    void load(selectedUserId);
  };

  const handleSave = async () => {
    if (!selectedUser || !response || readOnly || saving) return;
    const validation = validateDrafts(drafts);
    if (!validation.ok) {
      setValidationErrors(validation.errors);
      setSaveError('Every exception needs a reason, and an expiry must be a future date.');
      return;
    }
    setSaving(true);
    setSaveError('');
    setValidationErrors({});
    setSaved(false);
    try {
      const next = await api.saveUserPermissionOverrides(selectedUser.id, draftsToPayload(drafts));
      setResponse(next);
      setDrafts(draftsFromOverrides(next.overrides));
      setSaved(true);
    } catch (err: any) {
      setSaveError(err?.message || 'The user permission exceptions could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSets = async () => {
    if (!selectedUser || !response || readOnly || savingSets) return;
    setSavingSets(true);
    setSetsSaveError('');
    setSetsSaved(false);
    try {
      const next = await api.saveUserPermissionSets(selectedUser.id, normalizedSetDraft);
      setResponse((prev) =>
        prev
          ? {
              ...prev,
              base: next.base || prev.base,
              setIds: next.setIds,
              operations: next.operations,
              version: next.version,
            }
          : prev
      );
      setSetsSaved(true);
      // Member counts changed; refresh the list without touching the drafts.
      void loadSets();
    } catch (err: any) {
      setSetsSaveError(err?.message || 'The permission set assignments could not be saved.');
    } finally {
      setSavingSets(false);
    }
  };

  const toggleAssignedSet = (setId: string) => {
    if (readOnly || savingSets) return;
    setAssignedSetDraft((current) =>
      current.includes(setId)
        ? current.filter((id) => id !== setId)
        : [...current, setId]
    );
    setSetsSaved(false);
    setSetsSaveError('');
  };

  const handleRevokeAll = async () => {
    if (!selectedUser || changes.total === 0 || readOnly) return;
    const ok = await confirmDialog(
      `Remove all ${changes.total} exception${changes.total === 1 ? '' : 's'} for ${selectedUser.name}? The draft is cleared; press Save to apply it.`,
      { title: 'Revoke all exceptions', confirmLabel: 'Clear draft' }
    );
    if (!ok) return;
    setDrafts({});
    setSaved(false);
    setValidationErrors({});
  };

  const setReason = (operationId: string, reason: string) => {
    setDrafts((current) => updateDraft(current, operationId, { reason }));
    setValidationErrors((current) => {
      if (!current[operationId]) return current;
      const next = { ...current };
      delete next[operationId];
      return next;
    });
  };

  const setExpiry = (operationId: string, adDate: string) => {
    setDrafts((current) => updateDraft(current, operationId, { expiresAt: adDate || null }));
    setValidationErrors((current) => {
      if (!current[operationId]) return current;
      const next = { ...current };
      delete next[operationId];
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <PageHeader
        title={view === 'sets' ? 'Permission Sets' : 'User Access & Exceptions'}
        description={
          view === 'sets'
            ? 'Define reusable bundles of grants once, then assign them to several people.'
            : "One person's effective access: role defaults, assigned sets, and personal grants or denies."
        }
        icon={<ShieldCheck className="h-5 w-5 text-blue-600 dark:text-blue-400" />}
        actions={
          view === 'users' ? (
          <>
            <button
              type="button"
              onClick={handleReset}
              disabled={!dirty || saving}
              className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-xs transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset changes
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={readOnly || saving || !dirty}
              className="flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-1.5 text-xs font-bold text-white shadow-md shadow-blue-600/20 transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
            >
              <Save className="h-4 w-4" />
              {saving
                ? 'Saving…'
                : changes.total === 0
                  ? 'Save exceptions'
                  : `Save ${changes.total} exception${changes.total === 1 ? '' : 's'}`}
            </button>
          </>
          ) : undefined
        }
      />

      <div
        role="tablist"
        aria-label="Permission administration view"
        className="flex w-fit gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1 dark:border-slate-800 dark:bg-slate-800/60"
      >
        {(
          [
            { id: 'users' as const, label: 'User exceptions', icon: UserCheck },
            { id: 'sets' as const, label: 'Permission sets', icon: Layers },
          ]
        ).map((tab) => {
          const active = view === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setView(tab.id)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold transition-colors ${
                active
                  ? 'bg-white text-blue-700 shadow-xs dark:bg-slate-900 dark:text-blue-300'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {view === 'users' ? (
        <>
      <div className="flex items-start gap-2.5 rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-[11px] leading-5 text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <p>
            <strong>Effective access is layered:</strong> role defaults, then set grants, then personal
            exceptions. Changes below apply to this person only.
          </p>
          <p>
            A <strong>grant</strong> opens an operation this person&apos;s role does not have; a{' '}
            <strong>deny</strong> closes one it does. Every exception needs a reason and is written to the
            audit trail. An expiry is optional — an expired row is ignored by the server.
          </p>
          {onOpenRoleDefaults && (
            <p>
              Role defaults are managed in Role Permission Defaults.{' '}
              <button
                type="button"
                onClick={onOpenRoleDefaults}
                className="font-bold underline underline-offset-2 hover:text-blue-700 dark:hover:text-blue-100"
              >
                View role defaults
              </button>
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* User list */}
        <section className="rounded-2xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 p-3 dark:border-slate-800">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={userSearch}
                onChange={(event) => setUserSearch(event.target.value)}
                placeholder="Search users…"
                aria-label="Search users"
                className="w-full rounded-xl border border-slate-300 bg-slate-50 py-2 pl-9 pr-3 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>
          </div>
          <div className="max-h-[calc(100vh-300px)] overflow-y-auto p-1.5">
            {filteredUsers.length === 0 ? (
              <p className="p-4 text-center text-[11px] text-slate-500 dark:text-slate-400">
                No user matches this search.
              </p>
            ) : (
              filteredUsers.map((user) => {
                const active = user.id === selectedUserId;
                return (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => {
                      setFocusedOperationId(null);
                      setPendingOperationFocus(null);
                      void handleSelectUser(user);
                    }}
                    aria-current={active ? 'true' : undefined}
                    className={`mb-1 w-full rounded-xl px-2.5 py-2 text-left transition-colors ${
                      active
                        ? 'bg-blue-50 ring-1 ring-blue-300 dark:bg-blue-950/40 dark:ring-blue-800'
                        : 'hover:bg-slate-100 dark:hover:bg-slate-800/60'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                          active
                            ? 'bg-blue-600 text-white'
                            : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {user.name
                          .split(/\s+/)
                          .slice(0, 2)
                          .map((part) => part.charAt(0))
                          .join('')
                          .toUpperCase() || '?'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-bold text-slate-900 dark:text-slate-100">
                          {user.name}
                        </span>
                        <span className="block truncate text-[10px] text-slate-500 dark:text-slate-400">
                          {roleLabel(user.role)}
                        </span>
                      </span>
                    </span>
                    <span className="mt-1 block truncate pl-9 text-[10px] text-slate-500 dark:text-slate-400">
                      {branchLabel(user, branches)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* Editor */}
        <section className="min-w-0 rounded-2xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
          {!selectedUser ? (
            <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 p-8 text-center">
              <UserCheck className="h-8 w-8 text-slate-300 dark:text-slate-600" />
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                Select a user to review their effective permissions
              </p>
              <p className="max-w-md text-[11px] text-slate-500 dark:text-slate-400">
                Exceptions are per person. A user with no rows behaves exactly like their role.
              </p>
            </div>
          ) : (
            <>
              <div className="border-b border-slate-200 p-4 dark:border-slate-800">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                        {selectedUser.name}
                      </h3>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                        {roleLabel(selectedUser.role)}
                      </span>
                      {dirty && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                          Unsaved changes
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
                      {selectedUser.email} · {branchLabel(selectedUser, branches)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-3 text-[11px]">
                    <span className="rounded-lg bg-emerald-50 px-2 py-1 font-semibold text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
                      {changes.grants} grant{changes.grants === 1 ? '' : 's'}
                    </span>
                    <span className="rounded-lg bg-rose-50 px-2 py-1 font-semibold text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
                      {changes.denies} denial{changes.denies === 1 ? '' : 's'}
                    </span>
                    {preview && (
                      <span className="text-slate-500 dark:text-slate-400">
                        Effective: <strong className="text-slate-800 dark:text-slate-200">{preview.allowed}</strong> of{' '}
                        {preview.total} operations
                      </span>
                    )}
                  </div>
                </div>

                {readOnly && (
                  <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>
                      <strong>Super Admin always has every operation; overrides do not apply.</strong>{' '}
                      This account is immutable so an administrator can never lock everyone out.
                    </p>
                  </div>
                )}

                <div className="mt-2 flex items-start gap-2 text-[11px] leading-5 text-slate-500 dark:text-slate-400">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <p>
                    Grants widen what this person can do, not which branches or rows they can see. Branch
                    scope stays on the account and is enforced separately.
                  </p>
                </div>
              </div>

              <div className="space-y-3 p-4">
                {loadError && (
                  <LoadStateNotice
                    subject="this user's permission exceptions"
                    loading={loading}
                    error={loadError}
                    onRetry={() => void load(selectedUser.id)}
                  />
                )}
                {loading && !response && <LoadStateNotice subject="this user's permission exceptions" loading error="" onRetry={() => void load(selectedUser.id)} />}

                {saveError && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-semibold leading-5 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{saveError} Your draft is still on screen; nothing was saved.</span>
                  </div>
                )}
                {saved && !dirty && (
                  <div
                    role="status"
                    className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] font-semibold leading-5 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                  >
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Saved. The server enforces these exceptions immediately, and the permissions
                      broadcast refreshes {selectedUser.name}&apos;s open tab automatically.
                    </span>
                  </div>
                )}

                {/* Reusable sets assigned to this person (phase 2). */}
                <div className="rounded-xl border border-slate-200 dark:border-slate-800">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <Layers className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" />
                      <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200">
                        Assigned permission sets
                      </h4>
                      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {normalizedSetDraft.length}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setView('sets')}
                      className="text-[10px] font-bold text-blue-600 hover:underline dark:text-blue-400"
                    >
                      Manage sets
                    </button>
                  </div>
                  <div className="space-y-2 p-3">
                    <p className="text-[10px] leading-4 text-slate-500 dark:text-slate-400">
                      A set adds its grants to this person. An individual denial below still wins,
                      and a set never changes their role or branch scope.
                    </p>
                    {setsLoadError && (
                      <div
                        role="alert"
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[10px] font-semibold text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                      >
                        <span>{setsLoadError}</span>
                        <button
                          type="button"
                          onClick={() => void loadSets()}
                          className="font-bold underline"
                        >
                          Retry
                        </button>
                      </div>
                    )}
                    {setsLoading && sets.length === 0 ? (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">Loading sets…</p>
                    ) : sets.length === 0 ? (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        No permission sets exist yet. Create one in the Permission sets tab.
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                        {sets.map((set) => {
                          const checked = assignedSetDraft.includes(set.id);
                          return (
                            <label
                              key={set.id}
                              className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5 transition-colors ${
                                checked
                                  ? 'border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30'
                                  : 'border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800/50'
                              } ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={readOnly || savingSets}
                                onChange={() => toggleAssignedSet(set.id)}
                                className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                              />
                              <span className="min-w-0">
                                <span className="block truncate text-[11px] font-bold text-slate-800 dark:text-slate-200">
                                  {set.name}
                                </span>
                                <span className="block text-[10px] text-slate-500 dark:text-slate-400">
                                  {set.grants.length} grant{set.grants.length === 1 ? '' : 's'}
                                  {set.members.length > 0 ? ` · ${set.members.length} member${set.members.length === 1 ? '' : 's'}` : ''}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    {setsSaveError && (
                      <div
                        role="alert"
                        className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[10px] font-semibold leading-4 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                      >
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>{setsSaveError} Your ticked sets were not changed on the server.</span>
                      </div>
                    )}
                    {setsSaved && !setsDirty && (
                      <div
                        role="status"
                        className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[10px] font-semibold leading-4 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                      >
                        <Check className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>Saved. The new set grants apply immediately.</span>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[10px] text-slate-500 dark:text-slate-400">
                        {serverSetIds.length} saved assignment{serverSetIds.length === 1 ? '' : 's'}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleSaveSets()}
                        disabled={readOnly || savingSets || !setsDirty}
                        className="rounded-lg bg-slate-700 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-600 dark:hover:bg-slate-500"
                      >
                        {savingSets ? 'Saving…' : 'Save set assignments'}
                      </button>
                    </div>
                  </div>
                </div>

                {response && !loadError && (
                  <>
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                      To add an extra permission, search for the operation below and choose{' '}
                      <strong>Grant</strong>. Other users with the same role keep the role default.
                    </div>

                    <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2.5 dark:border-slate-800 dark:bg-slate-800/40 md:flex-row md:items-center md:justify-between">
                      <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="relative w-full sm:max-w-xs">
                          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                          <input
                            type="search"
                            value={operationSearch}
                            onChange={(event) => setOperationSearch(event.target.value)}
                            placeholder="Search operations…"
                            aria-label="Search operations"
                            className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pl-9 pr-3 text-[11px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                          />
                        </div>
                        <label className="flex items-center gap-2 text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                          <input
                            type="checkbox"
                            checked={differencesOnly}
                            onChange={(event) => setDifferencesOnly(event.target.checked)}
                            className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                          />
                          Show only differences
                        </label>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleRevokeAll()}
                        disabled={readOnly || changes.total === 0}
                        className="self-start rounded-lg border border-rose-300 px-2.5 py-1 text-[11px] font-bold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40 md:self-auto"
                      >
                        Clear all exceptions
                      </button>
                    </div>

                    {visibleGroups.length === 0 ? (
                      <p className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-center text-[11px] text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
                        No operations match this filter.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {visibleGroups.map((group) => {
                          const collapsed = collapsedGroups[group.id] === true;
                          const groupPreview = effectivePreview(
                            Object.fromEntries(
                              group.operations.map((operation) => [
                                operation.id,
                                Boolean(response.base[operation.id] || setGrants.has(operation.id)),
                              ])
                            ),
                            Object.fromEntries(
                              group.operations
                                .filter((operation) => drafts[operation.id])
                                .map((operation) => [operation.id, drafts[operation.id]])
                            )
                          );
                          return (
                            <div
                              key={group.id}
                              className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800"
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  setCollapsedGroups((current) => ({ ...current, [group.id]: !collapsed }))
                                }
                                aria-expanded={!collapsed}
                                className="flex w-full items-center justify-between gap-3 bg-slate-100 px-3 py-2 text-left dark:bg-slate-800/70"
                              >
                                <span className="min-w-0">
                                  <span className="block truncate text-xs font-bold text-slate-800 dark:text-slate-200">
                                    {group.category}
                                  </span>
                                  <span className="block text-[10px] text-slate-500 dark:text-slate-400">
                                    {groupPreview.allowed} of {groupPreview.total} operations effective
                                  </span>
                                </span>
                                <span className="shrink-0 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                                  {collapsed ? 'Expand' : 'Collapse'}
                                </span>
                              </button>

                              {!collapsed && (
                                <div className="divide-y divide-slate-200 dark:divide-slate-800">
                                  {group.operations.map((operation) => {
                                    const effect = draftEffectFor(drafts, operation.id);
                                    const baseAllowed = Boolean(response.base[operation.id]);
                                    const draft = drafts[operation.id];
                                    const error = validationErrors[operation.id];
                                    return (
                                      <div
                                        key={operation.id}
                                        ref={focusedOperationId === operation.id ? focusedRowRef : undefined}
                                        data-focused-operation={
                                          focusedOperationId === operation.id ? operation.id : undefined
                                        }
                                        className={`p-3 ${
                                          focusedOperationId === operation.id
                                            ? 'bg-amber-50/70 ring-2 ring-inset ring-amber-300 dark:bg-amber-950/20 dark:ring-amber-700'
                                            : ''
                                        }`}
                                      >
                                        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                                          <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                              <p className="text-xs font-bold text-slate-900 dark:text-slate-100">
                                                {operation.operationName}
                                              </p>
                                              <span
                                                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                                  baseAllowed
                                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                                                    : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                                                }`}
                                              >
                                                Role: {baseAllowed ? 'allowed' : 'denied'}
                                              </span>
                                              {setGrants.has(operation.id) && (
                                                <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-800 dark:bg-sky-950/50 dark:text-sky-300">
                                                  Granted by a set
                                                </span>
                                              )}
                                              {focusedOperationId === operation.id && (
                                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                                                  Opened from role matrix
                                                </span>
                                              )}
                                            </div>
                                            <p className="mt-0.5 text-[10px] leading-4 text-slate-500 dark:text-slate-400">
                                              {operation.description}
                                            </p>
                                          </div>

                                          <div
                                            role="group"
                                            aria-label={`Exception for ${operation.operationName}`}
                                            className="flex shrink-0 overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700"
                                          >
                                            {(['inherit', 'grant', 'deny'] as const).map((option) => {
                                              const active = effect === option;
                                              return (
                                                <button
                                                  key={option}
                                                  type="button"
                                                  aria-pressed={active}
                                                  disabled={readOnly}
                                                  onClick={() =>
                                                    setDrafts((current) =>
                                                      setDraftEffect(current, operation.id, option)
                                                    )
                                                  }
                                                  className={`px-2.5 py-1 text-[10px] font-bold transition-colors disabled:cursor-not-allowed ${
                                                    active
                                                      ? option === 'deny'
                                                        ? 'bg-rose-600 text-white'
                                                        : option === 'grant'
                                                          ? 'bg-emerald-600 text-white'
                                                          : 'bg-slate-600 text-white'
                                                      : 'bg-white text-slate-600 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
                                                  }`}
                                                >
                                                  {EFFECT_LABELS[option]}
                                                </button>
                                              );
                                            })}
                                          </div>
                                        </div>

                                        {draft && (
                                          <div className="mt-2 grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800/50 sm:grid-cols-[minmax(0,1fr)_180px]">
                                            <label className="block text-[10px] font-bold text-slate-600 dark:text-slate-400">
                                              Reason <span aria-hidden="true">*</span>
                                              <input
                                                type="text"
                                                value={draft.reason}
                                                disabled={readOnly}
                                                onChange={(event) => setReason(operation.id, event.target.value)}
                                                placeholder="Why does this exception exist?"
                                                aria-invalid={Boolean(error)}
                                                className={`mt-1 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[11px] text-slate-900 focus:outline-none focus:ring-2 dark:bg-slate-900 dark:text-slate-100 ${
                                                  error
                                                    ? 'border-rose-400 focus:ring-rose-400'
                                                    : 'border-slate-300 focus:ring-blue-500 dark:border-slate-700'
                                                }`}
                                              />
                                            </label>
                                            <div className="text-[10px] font-bold text-slate-600 dark:text-slate-400">
                                              <DateField
                                                value={draft.expiresAt || ''}
                                                onChange={(adDate) => setExpiry(operation.id, adDate)}
                                                mode={dateMode}
                                                label="Expiry (optional)"
                                                min={todayAD()}
                                                disabled={readOnly}
                                              />
                                              {draft.expiresAt && (
                                                <button
                                                  type="button"
                                                  onClick={() => setExpiry(operation.id, '')}
                                                  className="mt-1 text-[10px] font-semibold text-blue-600 hover:underline dark:text-blue-400"
                                                >
                                                  Remove expiry
                                                </button>
                                              )}
                                            </div>
                                            {error && (
                                              <p role="alert" className="text-[10px] font-semibold text-rose-600 dark:text-rose-400 sm:col-span-2">
                                                {error}
                                              </p>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </section>
      </div>
        </>
      ) : (
        <PermissionSetsPanel
          sets={sets}
          users={users}
          loading={setsLoading}
          error={setsLoadError}
          onRetry={() => void loadSets()}
          onChanged={loadSets}
        />
      )}
    </div>
  );
};
