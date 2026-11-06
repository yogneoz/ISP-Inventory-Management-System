import React, { useState, useEffect, useRef } from 'react';
import { User, Branch } from '../../types';
import {
  Users,
  Plus,
  Search,
  Shield,
  ShieldCheck,
  Building2,
  CheckCircle2,
  Edit,
  Trash2,
  Key,
  Eye,
  EyeOff,
  Copy,
  Check,
  Wand2,
  Lock,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Link2,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { PageHeader } from '../../components/common/PageHeader';
import { api } from '../../services/api';
import type { UserAccessSummary, UserPermissionOverridesResponse } from '../../services/api';
import { useDialog } from '../../components/common/DialogProvider';
import { ModalPanel } from '../../components/common/ModalPanel';
import { useActivationKey } from '../../components/common/KeepMounted';
import { isOperationAllowed } from '../../utils/permissions';
import {
  APP_ROLES,
  APP_ROLE_LABELS,
  DEFAULT_PERMISSIONS_MATRIX,
} from '../../utils/permissionMatrixData';
import { DEFAULT_GROUPS } from './PermissionManagement';
import {
  readAccessFilterUrl,
  syncAccessFilterUrl,
  type AccessFilterScope,
} from '../../utils/accessFilterUrl';
import type { RecordRoute } from '../../routes/appPaths';

/** operation id → the same label the two permission screens use. */
const OPERATION_NAMES: Record<string, string> = (() => {
  const names: Record<string, string> = {};
  for (const group of DEFAULT_GROUPS) {
    for (const operation of group.operations) names[operation.id] = operation.operationName;
  }
  return names;
})();

/**
 * Operation choices for the register's access filter. The matrix screen's
 * groups cover 51 operations; the catalogue also enforces four ids it does not
 * render. They still appear in every user's effective list, so the filter must
 * offer them too or those accounts could not be found by what they can do.
 */
const UNGROUPED_OPERATION_LABELS: Record<string, string> = {
  'purchase-return-create': 'Create Purchase Returns',
  'sales-invoice-create': 'Create Sales Invoices',
  'sales-return-create': 'Create Sales Returns',
  'shipment-cancel': 'Cancel Outbound Shipment',
};
const GROUPED_OPERATION_IDS = new Set(
  DEFAULT_GROUPS.flatMap((group) => group.operations.map((operation) => operation.id))
);
const UNGROUPED_OPERATIONS = Object.keys(DEFAULT_PERMISSIONS_MATRIX)
  .filter((operationId) => !GROUPED_OPERATION_IDS.has(operationId))
  .map((operationId) => ({
    id: operationId,
    name:
      OPERATION_NAMES[operationId] ||
      UNGROUPED_OPERATION_LABELS[operationId] ||
      operationId.replace(/-/g, ' '),
  }));
const OPERATION_FILTER_GROUPS = [
  ...DEFAULT_GROUPS.map((group) => ({
    category: group.category,
    operations: group.operations.map((operation) => ({
      id: operation.id,
      name: operation.operationName,
    })),
  })),
  ...(UNGROUPED_OPERATIONS.length > 0
    ? [{ category: 'Other operations', operations: UNGROUPED_OPERATIONS }]
    : []),
];

/** Reads a shared filter link, dropping an operation this build cannot render. */
function readInitialAccessFilters(): {
  accessFilter: AccessFilterScope;
  operationFilter: string;
} {
  const parsed = readAccessFilterUrl(window.location.search);
  return {
    accessFilter: parsed.accessFilter,
    operationFilter:
      parsed.operationFilter &&
      Object.prototype.hasOwnProperty.call(DEFAULT_PERMISSIONS_MATRIX, parsed.operationFilter)
        ? parsed.operationFilter
        : '',
  };
}

interface UsersManagementProps {
  currentUser: User | null;
  users: User[];
  branches: Branch[];
  onCreateUser?: (user: Omit<User, 'id'> & { password?: string }) => Promise<void>;
  onUpdateUser?: (id: string, user: Partial<User> & { password?: string }) => Promise<void>;
  onResetPassword?: (userId: string, newPassword: string) => Promise<void>;
  onDeleteUser?: (id: string) => Promise<void>;
  /** Opens the per-person access editor for this account. */
  onManageAccess?: (userId: string) => void;
  /** `/settings/users/new` or `/:id/edit`, when the URL names the editor. */
  recordRoute?: RecordRoute | null;
  onRecordRouteChange?: (record: RecordRoute | null) => void;
}

export const UsersManagement: React.FC<UsersManagementProps> = ({
  currentUser,
  users,
  branches,
  onCreateUser,
  onUpdateUser,
  onResetPassword,
  onDeleteUser,
  onManageAccess,
  recordRoute = null,
  onRecordRouteChange,
}) => {
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const isSuperAdmin = currentUser?.role === 'SUPER_ADMIN';
  const activationKey = useActivationKey('users');
  const [search, setSearch] = useState('');
  // A shared link may already name an access scope and/or operation.
  const [accessFilter, setAccessFilter] = useState<AccessFilterScope>(() =>
    isSuperAdmin ? readInitialAccessFilters().accessFilter : 'all'
  );
  const [operationFilter, setOperationFilter] = useState(() =>
    isSuperAdmin ? readInitialAccessFilters().operationFilter : ''
  );
  const [accessLinkCopied, setAccessLinkCopied] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [accessSummary, setAccessSummary] = useState<UserPermissionOverridesResponse | null>(null);
  const [accessSummaryLoading, setAccessSummaryLoading] = useState(false);
  const [accessSummaryError, setAccessSummaryError] = useState('');
  const [accessSummaryRetry, setAccessSummaryRetry] = useState(0);
  const recordRouteChangeRef = useRef(onRecordRouteChange);
  recordRouteChangeRef.current = onRecordRouteChange;

  // Users-register summary. One bulk read feeds every card; expanding one
  // card is the only thing that loads that account's exception rows.
  const [cardSummaries, setCardSummaries] = useState<Record<string, UserAccessSummary>>({});
  const [cardSummaryLoading, setCardSummaryLoading] = useState(false);
  const [cardSummaryError, setCardSummaryError] = useState('');
  const [cardSummaryRetry, setCardSummaryRetry] = useState(0);
  const [expandedAccessUserId, setExpandedAccessUserId] = useState<string | null>(null);
  const [accessDetails, setAccessDetails] = useState<Record<string, UserPermissionOverridesResponse>>({});
  const [accessDetailLoadingId, setAccessDetailLoadingId] = useState('');
  const [accessDetailError, setAccessDetailError] = useState<{ userId: string; message: string } | null>(null);

  // Add / Edit Modal State
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<string>('FRONT_DESK');
  const defaultBranchId = branches.find((b) => b.isHeadquarters)?.id || branches[0]?.id || '';
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [allowedBranchIds, setAllowedBranchIds] = useState<string[]>([defaultBranchId]);

  // Auto-assign branch access based on role.
  // SUPER_ADMIN and HEAD_OFFICE_ADMIN see all branches; INVENTORY_MANAGER sees all; others see primary + explicitly allowed.
  useEffect(() => {
    if (role === 'SUPER_ADMIN' || role === 'HEAD_OFFICE_ADMIN') {
      setAllowedBranchIds(branches.map((b) => b.id));
    } else if (role === 'INVENTORY_MANAGER') {
      setAllowedBranchIds(branches.map((b) => b.id));
    }
    // For other roles, keep the primary branch + any previously allowed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  useEffect(() => {
    if (branches.length > 0 && !branches.some((b) => b.id === branchId)) {
      const hqId = branches.find((b) => b.isHeadquarters)?.id || branches[0].id;
      setBranchId(hqId);
      setAllowedBranchIds([hqId]);
    }
  }, [branches]);

  // Reset Password Modal State
  const [resetModalUser, setResetModalUser] = useState<User | null>(null);
  const [newPasswordValue, setNewPasswordValue] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resetSuccessMsg, setResetSuccessMsg] = useState('');
  const [isResetting, setIsResetting] = useState(false);

  const filtered = users.filter((u) => {
    const searchText = (search || '').toLowerCase();
    const matchesSearch =
      (u?.name || '').toLowerCase().includes(searchText) ||
      (u?.email || '').toLowerCase().includes(searchText) ||
      (u?.role || '').toLowerCase().includes(searchText);
    if (!matchesSearch) return false;

    // Access filtering is a Super-Admin read. A Summary row that is absent or
    // still loading cannot prove either condition, so it fails closed rather
    // than showing an account the filter was meant to exclude.
    if (!isSuperAdmin) return true;
    const summary = cardSummaries[u.id];
    if (accessFilter === 'exceptions') {
      if (!summary || summary.grants + summary.denies === 0) return false;
    }
    if (operationFilter) {
      if (!summary || !summary.operations.includes(operationFilter)) return false;
    }
    return true;
  });

  const accessFilterActive = isSuperAdmin && (accessFilter !== 'all' || operationFilter !== '');
  const filtersActive = accessFilterActive || Boolean(search.trim());

  // Keep the address bar shareable. `activationKey` re-applies the params when
  // the user returns to this tab after App cleared them while it was hidden.
  useEffect(() => {
    if (!isSuperAdmin) {
      syncAccessFilterUrl('all', '');
      return;
    }
    syncAccessFilterUrl(accessFilter, operationFilter);
  }, [isSuperAdmin, accessFilter, operationFilter, activationKey]);

  const clearAccessFilters = () => {
    setAccessFilter('all');
    setOperationFilter('');
  };

  const handleCopyAccessLink = () => {
    // Write the current controls first so the clipboard cannot receive a URL
    // from before the last select change committed.
    syncAccessFilterUrl(accessFilter, operationFilter);
    navigator.clipboard.writeText(window.location.href);
    setAccessLinkCopied(true);
    window.setTimeout(() => setAccessLinkCopied(false), 2000);
  };

  const usersPagination = useClientPagination(filtered, 12, [
    search,
    accessFilter,
    operationFilter,
  ]);

  const openAddModal = () => {
    setEditingUser(null);
    setName('');
    setEmail('');
    setPassword('');
    setRole('FRONT_DESK');
    const defaultB = branches.find((b) => b.isHeadquarters)?.id || branches[0]?.id || '';
    setBranchId(defaultB);
    setAllowedBranchIds([defaultB]);
    setIsModalOpen(true);
  };

  const openEditModal = (u: User) => {
    setEditingUser(u);
    setName(u.name);
    setEmail(u.email);
    setPassword('');
    setRole(u.role);
    const primaryB = u.branchId || branches.find((b) => b.isHeadquarters)?.id || branches[0]?.id || '';
    setBranchId(primaryB);
    setAllowedBranchIds(
      u.allowedBranchIds && u.allowedBranchIds.length > 0
        ? u.allowedBranchIds
        : [primaryB]
    );
    setIsModalOpen(true);
  };

  const closeUserModal = () => {
    setIsModalOpen(false);
    setEditingUser(null);
    recordRouteChangeRef.current?.(null);
  };

  const handleOpenAddModal = () => {
    if (onRecordRouteChange) {
      recordRouteChangeRef.current?.({ kind: 'create' });
      return;
    }
    openAddModal();
  };

  const handleOpenEditModal = (u: User) => {
    if (onRecordRouteChange) {
      recordRouteChangeRef.current?.({ kind: 'edit', id: u.id });
      return;
    }
    openEditModal(u);
  };

  // The URL owns the open editor: a refresh on `/settings/users/:id/edit`
  // reopens the same account instead of dropping back to the card grid.
  const recordKind = recordRoute?.kind === 'create' ? 'create' : recordRoute?.kind === 'edit' ? 'edit' : '';
  const recordId = recordRoute?.kind === 'edit' ? recordRoute.id : '';
  useEffect(() => {
    if (!recordKind) {
      if (isModalOpen || editingUser) {
        setIsModalOpen(false);
        setEditingUser(null);
      }
      return;
    }
    if (recordKind === 'create' && (!isModalOpen || editingUser)) openAddModal();
  }, [recordKind]);

  useEffect(() => {
    if (recordKind !== 'edit' || users.length === 0) return;
    const wanted = recordId.toLowerCase();
    const user = users.find(
      (row) => row.id?.toLowerCase() === wanted || row.email?.toLowerCase() === wanted
    );
    if (!user) {
      recordRouteChangeRef.current?.(null);
      return;
    }
    if (editingUser?.id !== user.id) openEditModal(user);
  }, [recordKind, recordId, users]);

  const handleOpenResetModal = (u: User) => {
    setResetModalUser(u);
    setNewPasswordValue(generateRandomPassword());
    setShowResetPassword(true);
    setCopied(false);
    setResetSuccessMsg('');
  };

  // The modal summary is a read, never a second editor. It is only offered to
  // a Super Admin for an account whose access can actually change.
  useEffect(() => {
    if (!isModalOpen || !editingUser || !isSuperAdmin || editingUser.role === 'SUPER_ADMIN') {
      setAccessSummary(null);
      setAccessSummaryError('');
      setAccessSummaryLoading(false);
      return;
    }
    let cancelled = false;
    setAccessSummary(null);
    setAccessSummaryError('');
    setAccessSummaryLoading(true);
    api.getUserPermissionOverrides(editingUser.id)
      .then((summary) => {
        if (!cancelled) setAccessSummary(summary);
      })
      .catch((err: any) => {
        if (!cancelled) {
          setAccessSummaryError(err?.message || 'The access summary could not be read.');
        }
      })
      .finally(() => {
        if (!cancelled) setAccessSummaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isModalOpen, editingUser, isSuperAdmin, accessSummaryRetry]);

  // One bulk read for the register. The keep-mounted tab can be hidden for a
  // long time while access is edited on another screen, so the activation key
  // re-reads the counts on every return instead of trusting the first mount.
  useEffect(() => {
    if (!isSuperAdmin) {
      setCardSummaries({});
      setCardSummaryError('');
      setCardSummaryLoading(false);
      return;
    }
    let cancelled = false;
    setCardSummaryLoading(true);
    setCardSummaryError('');
    api.getUserAccessSummaries()
      .then((response) => {
        if (cancelled) return;
        const next: Record<string, UserAccessSummary> = {};
        for (const row of response.users) next[row.userId] = row;
        setCardSummaries(next);
        setExpandedAccessUserId(null);
        setAccessDetails({});
      })
      .catch((err: any) => {
        if (!cancelled) {
          setCardSummaryError(err?.message || 'The access summaries could not be read.');
        }
      })
      .finally(() => {
        if (!cancelled) setCardSummaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin, activationKey, users.length, cardSummaryRetry]);

  const loadAccessDetails = (userId: string, force = false) => {
    if (!force && (accessDetails[userId] || accessDetailLoadingId === userId)) return;
    setAccessDetailLoadingId(userId);
    setAccessDetailError(null);
    api.getUserPermissionOverrides(userId)
      .then((detail) => {
        setAccessDetails((current) => ({ ...current, [userId]: detail }));
      })
      .catch((err: any) => {
        setAccessDetailError({
          userId,
          message: err?.message || 'The access details could not be read.',
        });
      })
      .finally(() => {
        setAccessDetailLoadingId((current) => (current === userId ? '' : current));
      });
  };

  const toggleAccessDetails = (userId: string) => {
    if (expandedAccessUserId === userId) {
      setExpandedAccessUserId(null);
      return;
    }
    setExpandedAccessUserId(userId);
    setAccessDetailError(null);
    loadAccessDetails(userId);
  };

  const generateRandomPassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
    let pass = 'INV';
    for (let i = 0; i < 6; i++) {
      pass += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return pass + '!';
  };

  const handleGeneratePasswordClick = () => {
    setNewPasswordValue(generateRandomPassword());
    setCopied(false);
  };

  const handleCopyPassword = () => {
    if (!newPasswordValue) return;
    navigator.clipboard.writeText(newPasswordValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleConfirmPasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetModalUser || !newPasswordValue.trim()) return;

    setIsResetting(true);
    setResetSuccessMsg('');

    try {
      if (onResetPassword) {
        await onResetPassword(resetModalUser.id, newPasswordValue.trim());
      } else if (onUpdateUser) {
        await onUpdateUser(resetModalUser.id, { password: newPasswordValue.trim() });
      } else {
        await api.resetUserPassword(resetModalUser.id, newPasswordValue.trim());
      }

      setResetSuccessMsg(
        `Success! Password for ${resetModalUser.name} (${resetModalUser.email}) has been updated. Provide them with their new login credential.`
      );
    } catch (err: any) {
      alertDialog(err.message || 'Failed to reset password. Please try again.');
    } finally {
      setIsResetting(false);
    }
  };

  const toggleBranchPermission = (bId: string) => {
    if (allowedBranchIds.includes(bId)) {
      if (allowedBranchIds.length === 1) return; // keep at least 1
      setAllowedBranchIds(allowedBranchIds.filter((id) => id !== bId));
    } else {
      setAllowedBranchIds([...allowedBranchIds, bId]);
    }
  };

  const handleDelete = async (u: User) => {
    if (await confirmDialog(`Are you sure you want to delete user "${u.name}" (${u.email})?`)) {
      if (onDeleteUser) {
        await onDeleteUser(u.id);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email) return;

    if (editingUser) {
      if (onUpdateUser) {
        await onUpdateUser(editingUser.id, {
          name,
          email,
          role: role as User['role'],
          branchId,
          allowedBranchIds,
          ...(password ? { password } : {}),
        });
      }
    } else {
      if (onCreateUser) {
        await onCreateUser({
          name,
          email,
          role: role as User['role'],
          branchId,
          allowedBranchIds,
          password: password || 'password@123',
        });
      }
    }

    setName('');
    setEmail('');
    setPassword('');
    closeUserModal();
  };

  const getRoleBadge = (_r: string) => {
    switch (_r) {
      case 'SUPER_ADMIN':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300 border-purple-300 dark:border-purple-800';
      case 'INVENTORY_MANAGER':
        return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 border-indigo-300 dark:border-indigo-800';
      case 'HEAD_OFFICE_ADMIN':
        return 'bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-300 border-cyan-300 dark:border-cyan-800';
      case 'BRANCH_MANAGER':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 border-blue-300 dark:border-blue-800';
      case 'PROCUREMENT_OFFICER':
        return 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border-rose-300 dark:border-rose-800';
      case 'FRONT_DESK':
        return 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300 border-teal-300 dark:border-teal-800';
      case 'FIELD_TECHNICIAN':
        return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800';
      case 'ACCOUNTANT':
        return 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-300 dark:border-amber-800';
      case 'AUDITOR':
        return 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300 border-violet-300 dark:border-violet-800';
      default:
        return 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300';
    }
  };

  const cardBg = 'bg-white border-slate-200 text-slate-800 shadow-xs dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-300';

  const accessBase = accessSummary?.base || {};
  const accessTotal = Object.keys(accessBase).length;
  const accessRoleAllowed = Object.values(accessBase).filter(Boolean).length;
  const activeOverrides = (accessSummary?.overrides || []).filter((row) => !row.expired);
  const extraPermissions = activeOverrides.filter(
    (row) => row.effect === 'grant' && accessBase[row.operationId] === false
  ).length;
  const personalDenies = activeOverrides.filter((row) => row.effect === 'deny').length;
  const accessSetCount = accessSummary?.setIds?.length || 0;
  const accessEffective = accessSummary?.operations.length || 0;

  // Compare against the same normalised baseline handleOpenEditModal seeds:
  // an older account with no allowedBranchIds opens with its primary branch
  // ticked, so that must not look like an unsaved change.
  const editingPrimaryBranchId =
    editingUser?.branchId || branches.find((b) => b.isHeadquarters)?.id || branches[0]?.id || '';
  const editingAllowedBranchIds =
    editingUser?.allowedBranchIds && editingUser.allowedBranchIds.length > 0
      ? editingUser.allowedBranchIds
      : [editingPrimaryBranchId];
  const sortedAllowedBranchIds = [...allowedBranchIds].sort().join('|');
  const sortedEditingBranchIds = [...editingAllowedBranchIds].sort().join('|');
  const userFormDirty = Boolean(
    editingUser &&
      (name !== editingUser.name ||
        email !== editingUser.email ||
        role !== editingUser.role ||
        branchId !== editingPrimaryBranchId ||
        sortedAllowedBranchIds !== sortedEditingBranchIds ||
        password.length > 0)
  );
  const canShowAccess = Boolean(
    editingUser && isSuperAdmin && editingUser.role !== 'SUPER_ADMIN' && onManageAccess
  );

  const handleManageAccess = () => {
    if (!editingUser || !onManageAccess || userFormDirty) return;
    const userId = editingUser.id;
    setIsModalOpen(false);
    setEditingUser(null);
    onManageAccess(userId);
  };

  if (!isOperationAllowed('admin-users', currentUser?.role)) {
    return (
      <div className={`p-10 rounded-3xl border text-center space-y-4 max-w-2xl mx-auto my-8 bg-rose-50 border-rose-200 text-rose-900 dark:bg-rose-950/20 dark:border-rose-900/40 dark:text-rose-300`}>
        <Shield className="h-14 w-14 text-rose-500 mx-auto animate-bounce" />
        <h2 className="text-xl font-bold font-serif">Access Denied</h2>
        <p className="text-xs leading-relaxed max-w-md mx-auto opacity-90">
          You do not have the <strong>User Management &amp; Role Assignment</strong> permission to access staff accounts. Contact your Super Admin to grant this permission.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <PageHeader
        title="User Access & Role Administration"
        description="Add, update roles, assign branches, or reset user passwords in case staff forget credentials."
        icon={<Users className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />}
        actions={
          <button
            onClick={handleOpenAddModal}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 text-xs font-bold text-white shadow-xs transition-colors cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            <span>Add New User</span>
          </button>
        }
      />

      {/* Search + access filter */}
      <div className={`p-4 rounded-xl border ${cardBg}`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="relative w-full md:w-80 lg:w-96 shrink-0 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="🔍 Search user by name, email, or role..."
              className={`w-full rounded-lg pl-9 pr-4 py-2 text-xs focus:outline-none border border-slate-200 bg-slate-50 text-slate-800 placeholder-slate-400 dark:border dark:border-slate-800 dark:bg-slate-900 dark:text-white dark:placeholder-slate-500`}
            />
          </div>

          {isSuperAdmin && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="block">
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Access
                </span>
                <select
                  aria-label="Access filter"
                  value={accessFilter}
                  onChange={(e) => setAccessFilter(e.target.value as 'all' | 'exceptions')}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-800 focus:outline-none dark:border-slate-800 dark:bg-slate-900 dark:text-white"
                >
                  <option value="all">All accounts</option>
                  <option value="exceptions">With personal exceptions</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Can perform
                </span>
                <select
                  aria-label="Effective operation filter"
                  value={operationFilter}
                  onChange={(e) => setOperationFilter(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-800 focus:outline-none sm:w-64 dark:border-slate-800 dark:bg-slate-900 dark:text-white"
                >
                  <option value="">Any operation</option>
                  {OPERATION_FILTER_GROUPS.map((group) => (
                    <optgroup key={group.category} label={group.category}>
                      {group.operations.map((operation) => (
                        <option key={operation.id} value={operation.id}>
                          {operation.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>

              <button
                type="button"
                onClick={handleCopyAccessLink}
                title="Copy a link to this filtered view"
                className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50/60 px-2.5 py-2 text-[11px] font-bold text-indigo-700 hover:bg-indigo-100 dark:border-indigo-900 dark:bg-indigo-950/30 dark:text-indigo-300 dark:hover:bg-indigo-950/60"
              >
                {accessLinkCopied ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Link2 className="h-3.5 w-3.5" />
                )}
                <span>{accessLinkCopied ? 'Copied' : 'Copy link'}</span>
              </button>

              {accessFilterActive && (
                <button
                  type="button"
                  onClick={clearAccessFilters}
                  className="rounded-lg border border-slate-200 px-2.5 py-2 text-[11px] font-bold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Clear access filters
                </button>
              )}
            </div>
          )}
        </div>

        {filtersActive && (
          <p className="mt-2 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
            {accessFilterActive && cardSummaryLoading && Object.keys(cardSummaries).length === 0
              ? 'Reading access data to apply the filter…'
              : `Showing ${filtered.length} of ${users.length} staff account${users.length === 1 ? '' : 's'}.`}
          </p>
        )}
      </div>

      {isSuperAdmin && cardSummaryError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <span>Access summaries could not be read: {cardSummaryError}</span>
          <button
            type="button"
            onClick={() => setCardSummaryRetry((current) => current + 1)}
            className="font-bold underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      )}

      {filtered.length === 0 && (
        <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-xs dark:border-slate-700">
          <p className="font-semibold text-slate-600 dark:text-slate-300">
            {users.length === 0
              ? 'No staff accounts have been created yet.'
              : 'No staff accounts match the current search and access filters.'}
          </p>
          {users.length > 0 && filtersActive && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                clearAccessFilters();
              }}
              className="mt-2 text-[11px] font-bold text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Grid of Users */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {usersPagination.pagedItems.map((u) => {
          const userBranch = branches.find((b) => b.id === u.branchId);
          const summary = cardSummaries[u.id];
          const summaryExpanded = expandedAccessUserId === u.id;
          const detail = accessDetails[u.id];
          const detailBase = detail?.base || {};
          const activeDetailOverrides = detail
            ? detail.overrides.filter((row) => !row.expired)
            : [];
          const expiredDetailOverrides = detail
            ? detail.overrides.length - activeDetailOverrides.length
            : 0;
          const detailError = accessDetailError?.userId === u.id ? accessDetailError.message : '';

          return (
            <div key={u.id} className={`p-4 rounded-2xl border transition-all ${cardBg}`}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className={`h-10 w-10 rounded-full bg-indigo-600/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center font-bold text-sm border border-indigo-500/30`}>
                    {u.name.charAt(0)}
                  </div>
                  <div>
                    <h3 className="font-bold text-sm text-slate-900 dark:text-white">{u.name}</h3>
                    <p className="text-xs text-slate-500">{u.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleOpenResetModal(u)}
                    title="Reset Password"
                    className={`p-1.5 rounded-lg text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-950/60 hover:bg-amber-100 transition-colors cursor-pointer flex items-center gap-1 font-semibold text-[10px]`}
                  >
                    <Key className="h-3.5 w-3.5" />
                    <span>Reset Pass</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenEditModal(u)}
                    title="Edit User"
                    className={`p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:text-indigo-400 dark:hover:bg-indigo-950/60 transition-colors cursor-pointer`}
                  >
                    <Edit className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(u)}
                    title="Delete User"
                    className={`p-1.5 rounded-lg text-slate-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:text-rose-400 dark:hover:bg-rose-950/60 transition-colors cursor-pointer`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500 flex items-center gap-1">
                    <Shield className="h-3.5 w-3.5" /> Role:
                  </span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${getRoleBadge(u.role)}`}>
                    {u.role.replace('_', ' ')}
                  </span>
                </div>

                <div className="flex items-start justify-between">
                  <span className="text-slate-500 flex items-center gap-1 mt-0.5">
                    <Building2 className="h-3.5 w-3.5" /> Branch Access:
                  </span>
                  <span className="font-semibold text-slate-800 dark:text-slate-200 text-right">
                    {u.role === 'SUPER_ADMIN' || u.role === 'INVENTORY_MANAGER' || u.role === 'HEAD_OFFICE_ADMIN' ? (
                      <span className="text-purple-600 dark:text-purple-400 font-bold">All Branches (Global Access)</span>
                    ) : u.allowedBranchIds && u.allowedBranchIds.length > 1 ? (
                      <span className={`text-indigo-600 dark:text-indigo-400 font-bold`}>
                        {u.allowedBranchIds.length} Branches Assigned ({u.allowedBranchIds.map((id) => branches.find((b) => b.id === id)?.name || id).join(', ')})
                      </span>
                    ) : (
                      userBranch?.name || 'Headquarters'
                    )}
                  </span>
                </div>
              </div>

              {isSuperAdmin && (
                <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
                  {u.role === 'SUPER_ADMIN' ? (
                    <p className="flex items-center gap-1.5 text-[10px] font-semibold text-purple-700 dark:text-purple-300">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      Full access by role · exceptions do not apply
                    </p>
                  ) : summary ? (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                          Access
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleAccessDetails(u.id)}
                          aria-expanded={summaryExpanded}
                          aria-controls={`access-details-${u.id}`}
                          className="flex items-center gap-0.5 text-[10px] font-bold text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          {summaryExpanded ? 'Hide details' : 'Details'}
                          {summaryExpanded ? (
                            <ChevronUp className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                      <p className="mt-1 text-[11px] font-bold text-slate-800 dark:text-slate-200">
                        Effective {summary.effective} of {summary.total} operations
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] font-semibold">
                        <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
                          +{summary.grants} grant{summary.grants === 1 ? '' : 's'}
                        </span>
                        <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300">
                          −{summary.denies} den{summary.denies === 1 ? 'y' : 'ies'}
                        </span>
                        <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                          {summary.setCount} set{summary.setCount === 1 ? '' : 's'}
                        </span>
                      </div>
                      {summary.nextExpiry && (
                        <p className="mt-1 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                          Next exception expiry: {new Date(summary.nextExpiry).toLocaleDateString()}
                        </p>
                      )}
                      {summaryExpanded && (
                        <div
                          id={`access-details-${u.id}`}
                          className="mt-2 border-t border-slate-200 pt-2 dark:border-slate-700"
                        >
                          {accessDetailLoadingId === u.id ? (
                            <p className="text-[10px] text-slate-500 dark:text-slate-400">
                              Reading exceptions…
                            </p>
                          ) : detailError ? (
                            <div
                              role="alert"
                              className="flex flex-wrap items-center gap-2 text-[10px] font-semibold text-rose-700 dark:text-rose-300"
                            >
                              <span>{detailError}</span>
                              <button
                                type="button"
                                onClick={() => loadAccessDetails(u.id, true)}
                                className="font-bold underline underline-offset-2"
                              >
                                Retry
                              </button>
                            </div>
                          ) : detail ? (
                            activeDetailOverrides.length === 0 ? (
                              <p className="text-[10px] text-slate-500 dark:text-slate-400">
                                Role defaults only; no active personal exceptions.
                              </p>
                            ) : (
                              <>
                                <ul className="space-y-1.5">
                                  {activeDetailOverrides.map((row) => (
                                    <li key={row.operationId} className="text-[10px] leading-4">
                                      <div className="flex flex-wrap items-center gap-1">
                                        <span
                                          className={
                                            row.effect === 'grant'
                                              ? 'font-bold text-emerald-700 dark:text-emerald-300'
                                              : 'font-bold text-rose-700 dark:text-rose-300'
                                          }
                                        >
                                          {row.effect === 'grant' ? '+' : '−'}
                                        </span>
                                        <span className="font-bold text-slate-800 dark:text-slate-200">
                                          {OPERATION_NAMES[row.operationId] || row.operationId}
                                        </span>
                                        <span className="text-slate-500 dark:text-slate-400">
                                          Role: {detailBase[row.operationId] ? 'allowed' : 'denied'}
                                        </span>
                                      </div>
                                      <p className="text-slate-600 dark:text-slate-400">{row.reason}</p>
                                      <p className="text-slate-400">
                                        {row.expiresAt
                                          ? `Expires ${new Date(row.expiresAt).toLocaleDateString()}`
                                          : 'No expiry'}
                                      </p>
                                    </li>
                                  ))}
                                </ul>
                                {expiredDetailOverrides > 0 && (
                                  <p className="mt-1 text-[10px] text-slate-400">
                                    {expiredDetailOverrides} expired exception
                                    {expiredDetailOverrides === 1 ? '' : 's'} ignored.
                                  </p>
                                )}
                              </>
                            )
                          ) : null}
                        </div>
                      )}
                    </>
                  ) : cardSummaryLoading ? (
                    <p className="text-[10px] text-slate-500 dark:text-slate-400">
                      Reading access summary…
                    </p>
                  ) : null}
                </div>
              )}

              {onManageAccess && isSuperAdmin && u.role !== 'SUPER_ADMIN' && (
                <button
                  type="button"
                  onClick={() => onManageAccess(u.id)}
                  className="mt-3 flex w-full items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50/60 px-3 py-2 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100 dark:border-indigo-900 dark:bg-indigo-950/30 dark:text-indigo-300 dark:hover:bg-indigo-950/60"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Access &amp; permissions
                </button>
              )}

              <div className="mt-4 pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[10px]">
                <span className={`text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1`}>
                  <CheckCircle2 className="h-3 w-3" /> Active Account
                </span>
                <span className="text-slate-400 font-mono">ID: {u.id}</span>
              </div>
            </div>
          );
        })}
      </div>
      <TablePagination
        page={usersPagination.page}
        pageCount={usersPagination.pageCount}
        totalItems={usersPagination.totalItems}
        rangeStart={usersPagination.rangeStart}
        rangeEnd={usersPagination.rangeEnd}
        pageSize={usersPagination.pageSize}
        onPageChange={usersPagination.setPage}
        onPageSizeChange={usersPagination.setPageSize}
        className="mt-1"
      />

      {/* Modal Add / Edit User */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <ModalPanel
            label={editingUser ? 'Edit User & Credentials' : 'Add System User'}
            onClose={closeUserModal}
            className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl bg-white border-slate-200 text-slate-900 dark:bg-[#0f1218] dark:border-slate-800 dark:text-white`}
          >
            <h3 className="text-base font-bold mb-4 flex items-center gap-2">
              <Users className={`h-5 w-5 text-indigo-600 dark:text-indigo-400`} />
              <span>{editingUser ? 'Edit User & Credentials' : 'Add System User'}</span>
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4 text-xs">
              <div>
                <label className="block font-semibold mb-1">Full Name *</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Full Name"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">Official Email *</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1 flex items-center gap-1">
                  <Key className="h-3.5 w-3.5 text-indigo-500" />
                  <span>Password {editingUser && '(Leave blank to keep unchanged)'}</span>
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={editingUser ? '••••••••' : 'Enter login password'}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">User Role *</label>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-2"
                  >
                    {APP_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {APP_ROLE_LABELS[r] || r}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-semibold mb-1">Primary Home Branch *</label>
                  <select
                    value={branchId}
                    onChange={(e) => {
                      const newPrimary = e.target.value;
                      setBranchId(newPrimary);
                      if (!allowedBranchIds.includes(newPrimary)) {
                        setAllowedBranchIds([...allowedBranchIds, newPrimary]);
                      }
                    }}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-2"
                  >
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.code})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Branch Access Permissions (Multi-Branch Selection) */}
              <div className="pt-2">
                <label className="block font-semibold mb-1.5 flex items-center justify-between">
                  <span>Branch Data & Store Access Permissions</span>
                  {role === 'SUPER_ADMIN' || role === 'INVENTORY_MANAGER' || role === 'HEAD_OFFICE_ADMIN' ? (
                    <span className="text-[10px] font-bold text-purple-600 dark:text-purple-400 bg-purple-100 dark:bg-purple-950 px-2 py-0.5 rounded">
                      Unrestricted Global Access
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-500 font-normal">
                      Select 1 or more branches allowed for this user
                    </span>
                  )}
                </label>

                {role === 'SUPER_ADMIN' || role === 'INVENTORY_MANAGER' || role === 'HEAD_OFFICE_ADMIN' ? (
                  <div className="p-3 rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-950/30 text-purple-900 dark:text-purple-300 text-[11px]">
                    🔒 <strong>Super Admin, Stock Manager & Head Office Admin</strong> automatically have full operational and data visibility access across ALL branches in the company.
                  </div>
                ) : (
                  <div className="space-y-1.5 p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 max-h-36 overflow-y-auto">
                    {branches.map((b) => {
                      const isChecked = allowedBranchIds.includes(b.id);
                      return (
                        <label
                          key={b.id}
                          className="flex items-center justify-between p-1.5 rounded-lg hover:bg-slate-200/50 dark:hover:bg-slate-800 cursor-pointer select-none"
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleBranchPermission(b.id)}
                              className={`rounded border-slate-300 text-indigo-600 dark:text-indigo-400 focus:ring-indigo-500 h-4 w-4`}
                            />
                            <span className="font-medium text-slate-800 dark:text-slate-200">
                              {b.name} ({b.code})
                            </span>
                          </div>
                          {b.id === branchId && (
                            <span className="text-[10px] bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 px-1.5 py-0.5 rounded font-bold">
                              Primary
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              {canShowAccess && (
                <div className="space-y-2 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 dark:border-indigo-900 dark:bg-indigo-950/20">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="flex items-center gap-1.5 text-xs font-bold text-indigo-900 dark:text-indigo-200">
                      <ShieldCheck className="h-4 w-4" />
                      Access &amp; permissions
                    </h4>
                    <button
                      type="button"
                      onClick={handleManageAccess}
                      disabled={userFormDirty}
                      title={userFormDirty ? 'Save or cancel your changes first' : 'Open the access editor'}
                      className="text-[10px] font-bold text-indigo-700 hover:underline disabled:cursor-not-allowed disabled:opacity-40 dark:text-indigo-300"
                    >
                      Manage access →
                    </button>
                  </div>

                  {accessSummaryLoading && !accessSummary ? (
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">Reading access summary…</p>
                  ) : accessSummaryError ? (
                    <div
                      role="alert"
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[10px] font-semibold text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                    >
                      <span>{accessSummaryError}</span>
                      <button
                        type="button"
                        onClick={() => setAccessSummaryRetry((current) => current + 1)}
                        className="font-bold underline underline-offset-2"
                      >
                        Retry
                      </button>
                    </div>
                  ) : accessSummary ? (
                    <>
                      <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                        <div className="rounded-lg bg-white px-2 py-1.5 dark:bg-slate-900">
                          <span className="block text-slate-500 dark:text-slate-400">Role default</span>
                          <strong className="text-slate-800 dark:text-slate-200">
                            {accessRoleAllowed} of {accessTotal} operations
                          </strong>
                        </div>
                        <div className="rounded-lg bg-white px-2 py-1.5 dark:bg-slate-900">
                          <span className="block text-slate-500 dark:text-slate-400">Extra permissions</span>
                          <strong className="text-emerald-700 dark:text-emerald-300">
                            {extraPermissions} extra permission{extraPermissions === 1 ? '' : 's'}
                          </strong>
                        </div>
                        <div className="rounded-lg bg-white px-2 py-1.5 dark:bg-slate-900">
                          <span className="block text-slate-500 dark:text-slate-400">Personal denies</span>
                          <strong className="text-rose-700 dark:text-rose-300">
                            {personalDenies} personal den{personalDenies === 1 ? 'y' : 'ies'}
                          </strong>
                        </div>
                        <div className="rounded-lg bg-white px-2 py-1.5 dark:bg-slate-900">
                          <span className="block text-slate-500 dark:text-slate-400">Permission sets</span>
                          <strong className="text-slate-800 dark:text-slate-200">
                            {accessSetCount} permission set{accessSetCount === 1 ? '' : 's'}
                          </strong>
                        </div>
                      </div>
                      <p className="text-[10px] font-semibold text-slate-700 dark:text-slate-300">
                        Effective: {accessEffective} of {accessTotal} operations
                      </p>
                    </>
                  ) : null}

                  <p className="text-[10px] leading-4 text-slate-500 dark:text-slate-400">
                    Changing the role changes inherited defaults. This form never edits personal exceptions or
                    sets.
                    {userFormDirty && ' Save or cancel your changes to manage access.'}
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={closeUserModal}
                  className="px-4 py-2 rounded-lg bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold cursor-pointer"
                >
                  {editingUser ? 'Update User' : 'Create User'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}

      {/* Dedicated Reset Password Modal */}
      {resetModalUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <ModalPanel
            label="Reset Password for Staff"
            onClose={() => setResetModalUser(null)}
            className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl bg-white border-slate-200 text-slate-900 dark:bg-[#0f1218] dark:border-slate-800 dark:text-white`}
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800 mb-4">
              <div className="flex items-center gap-2">
                <div className={`p-2 rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-950/80 dark:text-amber-400`}>
                  <Key className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold">Reset Password for Staff</h3>
                  <p className="text-[11px] text-slate-500">{resetModalUser.name} ({resetModalUser.email})</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setResetModalUser(null)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xs font-bold"
              >
                ✕
              </button>
            </div>

            {resetSuccessMsg ? (
              <div className="space-y-4">
                <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-200 space-y-2">
                  <div className="flex items-center gap-2 font-bold text-emerald-900 dark:text-emerald-100">
                    <CheckCircle2 className={`h-5 w-5 text-emerald-600 dark:text-emerald-400`} />
                    <span>Password Successfully Reset!</span>
                  </div>
                  <p className="text-[11px]">{resetSuccessMsg}</p>
                </div>

                <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <div className="text-xs">
                    <span className="text-slate-500 block text-[10px]">New Issued Password:</span>
                    <span className="font-mono font-bold text-slate-900 dark:text-white text-sm">{newPasswordValue}</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyPassword}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition-colors"
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>

                <div className="pt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setResetModalUser(null)}
                    className="px-4 py-2 rounded-xl bg-slate-800 text-white font-bold text-xs hover:bg-slate-700 cursor-pointer"
                  >
                    Done & Close
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleConfirmPasswordReset} className="space-y-4 text-xs">
                <div>
                  <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1.5 flex items-center justify-between">
                    <span>New Password Credential *</span>
                    <button
                      type="button"
                      onClick={handleGeneratePasswordClick}
                      className={`text-[10px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1 cursor-pointer`}
                    >
                      <Wand2 className="h-3 w-3" />
                      <span>Auto Generate Strong Password</span>
                    </button>
                  </label>
                  <div className="relative flex items-center">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      type={showResetPassword ? 'text' : 'password'}
                      required
                      value={newPasswordValue}
                      onChange={(e) => setNewPasswordValue(e.target.value)}
                      placeholder="Enter new password"
                      className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 pl-9 pr-20 py-2.5 font-mono text-xs font-bold text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute right-2 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setShowResetPassword(!showResetPassword)}
                        className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                        title={showResetPassword ? 'Hide password' : 'Show password'}
                      >
                        {showResetPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                      <button
                        type="button"
                        onClick={handleCopyPassword}
                        className={`p-1 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400`}
                        title="Copy password"
                      >
                        {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-[11px] text-amber-900 dark:text-amber-200 space-y-1">
                  <p>
                    ⚠️ Resetting password for <strong>{resetModalUser.name}</strong> will take effect immediately.
                  </p>
                  <p className="text-[10px] text-amber-700 dark:text-amber-300">
                    Be sure to copy and send the new password to the staff member so they can sign in.
                  </p>
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => setResetModalUser(null)}
                    className="px-4 py-2 rounded-xl bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isResetting || !newPasswordValue.trim()}
                    className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {isResetting ? (
                      <span>Updating...</span>
                    ) : (
                      <>
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>Confirm Reset Password</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}
          </ModalPanel>
        </div>
      )}
    </div>
  );
};
