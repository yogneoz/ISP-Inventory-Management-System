import React, { useState, useEffect } from 'react';
import { User, Branch } from '../../types';
import {
  Users,
  Plus,
  Search,
  Shield,
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
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { api } from '../../services/api';

interface UsersManagementProps {
  currentUser: User | null;
  users: User[];
  branches: Branch[];
  onCreateUser?: (user: Omit<User, 'id'> & { password?: string }) => Promise<void>;
  onUpdateUser?: (id: string, user: Partial<User> & { password?: string }) => Promise<void>;
  onResetPassword?: (userId: string, newPassword: string) => Promise<void>;
  onDeleteUser?: (id: string) => Promise<void>;}

export const UsersManagement: React.FC<UsersManagementProps> = ({
  users,
  branches,
  onCreateUser,
  onUpdateUser,
  onResetPassword,
  onDeleteUser,}) => {
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  // Add / Edit Modal State
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<User['role']>('FRONT_DESK');
  const defaultBranchId = branches.find((b) => b.isHeadquarters)?.id || branches[0]?.id || '';
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [allowedBranchIds, setAllowedBranchIds] = useState<string[]>([defaultBranchId]);

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

  const filtered = users.filter(
    (u) =>
      (u?.name || '').toLowerCase().includes((search || '').toLowerCase()) ||
      (u?.email || '').toLowerCase().includes((search || '').toLowerCase()) ||
      (u?.role || '').toLowerCase().includes((search || '').toLowerCase())
  );

  const usersPagination = useClientPagination(filtered, 12, [search]);

  const handleOpenAddModal = () => {
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

  const handleOpenEditModal = (u: User) => {
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

  const handleOpenResetModal = (u: User) => {
    setResetModalUser(u);
    setNewPasswordValue(generateRandomPassword());
    setShowResetPassword(true);
    setCopied(false);
    setResetSuccessMsg('');
  };

  const generateRandomPassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
    let pass = 'IZ';
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
      alert(err.message || 'Failed to reset password. Please try again.');
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
    if (window.confirm(`Are you sure you want to delete user "${u.name}" (${u.email})?`)) {
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
          role,
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
          role,
          branchId,
          allowedBranchIds,
          password: password || 'password@123',
        });
      }
    }

    setName('');
    setEmail('');
    setPassword('');
    setEditingUser(null);
    setIsModalOpen(false);
  };

  const getRoleBadge = (r: User['role']) => {
    switch (r) {
      case 'SUPER_ADMIN':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300 border-purple-300 dark:border-purple-800';
      case 'INVENTORY_MANAGER':
        return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 border-indigo-300 dark:border-indigo-800';
      case 'BRANCH_MANAGER':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 border-blue-300 dark:border-blue-800';
      case 'FRONT_DESK':
        return 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300 border-teal-300 dark:border-teal-800';
      case 'ACCOUNTANT':
        return 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-300 dark:border-amber-800';
      default:
        return 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300';
    }
  };

  const cardBg = 'bg-white border-slate-200 text-slate-800 shadow-xs dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-300';

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-serif font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Users className={`h-5 w-5 text-indigo-600 dark:text-indigo-400`} />
            <span>User Access & Role Administration</span>
          </h2>
          <p className="truncate text-slate-500 text-xs mt-0.5">
            Add, update roles, assign branches, or reset user passwords in case staff forget credentials.
          </p>
        </div>
        <button
          onClick={handleOpenAddModal}
          className="flex items-center gap-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 text-xs font-bold text-white shadow-xs transition-colors cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>Add New User</span>
        </button>
      </div>

      {/* Search Bar */}
      <div className={`p-4 rounded-xl border ${cardBg}`}>
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
      </div>

      {/* Grid of Users */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {usersPagination.pagedItems.map((u) => {
          const userBranch = branches.find((b) => b.id === u.branchId);

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
                    {u.role === 'SUPER_ADMIN' || u.role === 'INVENTORY_MANAGER' ? (
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
          <div
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
                    onChange={(e) => setRole(e.target.value as any)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-2"
                  >
                    <option value="SUPER_ADMIN">Super Admin (All Branches)</option>
                    <option value="INVENTORY_MANAGER">Inventory Manager (All Branches)</option>
                    <option value="BRANCH_MANAGER">Branch Manager</option>
                    <option value="FRONT_DESK">Front Desk</option>
                    <option value="ACCOUNTANT">Accountant</option>
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
                  {role === 'SUPER_ADMIN' || role === 'INVENTORY_MANAGER' ? (
                    <span className="text-[10px] font-bold text-purple-600 dark:text-purple-400 bg-purple-100 dark:bg-purple-950 px-2 py-0.5 rounded">
                      Unrestricted Global Access
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-500 font-normal">
                      Select 1 or more branches allowed for this user
                    </span>
                  )}
                </label>

                {role === 'SUPER_ADMIN' || role === 'INVENTORY_MANAGER' ? (
                  <div className="p-3 rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-950/30 text-purple-900 dark:text-purple-300 text-[11px]">
                    🔒 <strong>Super Admin & Stock Managers</strong> automatically have full operational and data visibility access across ALL branches in the company.
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

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
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
          </div>
        </div>
      )}

      {/* Dedicated Reset Password Modal */}
      {resetModalUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div
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
          </div>
        </div>
      )}
    </div>
  );
};
