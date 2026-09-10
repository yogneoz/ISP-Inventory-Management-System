import React, { useState } from 'react';
import { User, Branch } from '../../types';
import { canUserSwitchProfiles } from '../../utils/permissions';
import {
  X,
  User as UserIcon,
  Shield,
  Building2,
  CheckCircle2,
  RefreshCw,
  LogOut,
  Key,
  Mail,
  Search,
  UserCheck,
  Edit3,
  Lock,
  Sparkles,
  ShieldAlert,
  ArrowLeft,
} from 'lucide-react';

interface ProfileSwitchModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: User | null;
  rootUser?: User | null;
  onSwitchBackToRoot?: () => Promise<void>;
  users: User[];
  branches: Branch[];
  onSwitchProfile: (targetUserId: string) => Promise<void>;
  onUpdateProfile: (data: Partial<User> & { newPassword?: string }) => Promise<void>;
  onLogout: () => void;}

export const ProfileSwitchModal: React.FC<ProfileSwitchModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  rootUser,
  onSwitchBackToRoot,
  users,
  branches,
  onSwitchProfile,
  onUpdateProfile,
  onLogout,}) => {
  const [activeTab, setActiveTab] = useState<'switch' | 'edit' | 'info'>('switch');
  const [search, setSearch] = useState('');
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  // Edit profile form state
  const [editName, setEditName] = useState(currentUser?.name || '');
  const [editEmail, setEditEmail] = useState(currentUser?.email || '');
  const [editPassword, setEditPassword] = useState('');
  const [updateSuccess, setUpdateSuccess] = useState(false);
  const [updating, setUpdating] = useState(false);

  if (!isOpen || !currentUser) return null;

  const filteredUsers = users.filter((u) => {
    const q = (search || '').toLowerCase();
    const branchName = branches.find((b) => b.id === u.branchId)?.name || 'HQ/All';
    return (
      (u?.name || '').toLowerCase().includes(q) ||
      (u?.email || '').toLowerCase().includes(q) ||
      (u?.role || '').toLowerCase().includes(q) ||
      (branchName || '').toLowerCase().includes(q)
    );
  });

  const getRoleBadgeColor = (role: User['role']) => {
    switch (role) {
      case 'SUPER_ADMIN':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-950/80 dark:text-purple-300 border-purple-200 dark:border-purple-800';
      case 'INVENTORY_MANAGER':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-950/80 dark:text-blue-300 border-blue-200 dark:border-blue-800';
      case 'BRANCH_MANAGER':
        return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800';
      case 'FRONT_DESK':
        return 'bg-amber-100 text-amber-800 dark:bg-amber-950/80 dark:text-amber-300 border-amber-200 dark:border-amber-800';
      case 'ACCOUNTANT':
        return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/80 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800';
      default:
        return 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300 border-slate-200 dark:border-slate-700';
    }
  };

  const handleSwitch = async (targetId: string) => {
    if (targetId === currentUser.id) return;
    setSwitchingId(targetId);
    try {
      await onSwitchProfile(targetId);
      onClose();
    } catch (err) {
      console.error('Failed to switch profile:', err);
    } finally {
      setSwitchingId(null);
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setUpdating(true);
    setUpdateSuccess(false);
    try {
      await onUpdateProfile({
        name: editName,
        email: editEmail,
        ...(editPassword ? { newPassword: editPassword } : {}),
      });
      setUpdateSuccess(true);
      setEditPassword('');
      setTimeout(() => setUpdateSuccess(false), 3000);
    } catch (err) {
      console.error('Failed to update profile:', err);
    } finally {
      setUpdating(false);
    }
  };

  const currentBranchName =
    branches.find((b) => b.id === currentUser.branchId)?.name || 'Headquarters / All Branches';

  const canSwitchUser = canUserSwitchProfiles(currentUser, rootUser);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-xl overflow-hidden rounded-3xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200/80 dark:border-slate-800 transition-all flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="bg-gradient-to-r from-indigo-900 via-indigo-950 to-slate-950 p-6 text-white relative flex-shrink-0">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 rounded-full p-2 text-indigo-200 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>

          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="h-16 w-16 rounded-2xl bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center text-white text-2xl font-black font-serif shadow-lg border-2 border-white/20">
                {currentUser.name.split(' ').map((n) => n[0]).join('').substring(0, 2).toUpperCase()}
              </div>
              <span className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-emerald-500 border-2 border-indigo-950 shadow-md" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-bold tracking-tight text-white truncate font-serif">
                  {currentUser.name}
                </h2>
                <span
                  className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full border ${getRoleBadgeColor(
                    currentUser.role
                  )}`}
                >
                  {currentUser.role.replace('_', ' ')}
                </span>
              </div>
              <p className="text-xs text-indigo-200/90 font-mono mt-0.5 truncate">{currentUser.email}</p>
              <div className="flex items-center gap-1.5 text-[11px] text-indigo-300 mt-1 font-medium">
                <Building2 className="h-3.5 w-3.5 text-indigo-400" />
                <span>{currentBranchName}</span>
              </div>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex items-center gap-2 mt-5 border-t border-white/10 pt-3">
            <button
              onClick={() => setActiveTab('switch')}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                activeTab === 'switch'
                  ? 'bg-white text-indigo-950 shadow-md'
                  : 'text-indigo-200 hover:bg-white/10 hover:text-white'
              }`}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Switch Profile</span>
            </button>

            <button
              onClick={() => setActiveTab('edit')}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                activeTab === 'edit'
                  ? 'bg-white text-indigo-950 shadow-md'
                  : 'text-indigo-200 hover:bg-white/10 hover:text-white'
              }`}
            >
              <Edit3 className="h-3.5 w-3.5" />
              <span>Edit My Profile</span>
            </button>
          </div>
        </div>

        {/* Modal Body Content */}
        <div className="p-6 overflow-y-auto flex-1 space-y-4">
          {activeTab === 'switch' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-slate-800 dark:text-white flex items-center gap-1.5">
                    <UserCheck className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                    <span>Select Profile to Switch Session</span>
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Switch operational identity and permissions instantly across branches.
                  </p>
                </div>
              </div>

              {/* Active Switched Profile Banner & Switch Back Button */}
              {rootUser && rootUser.id !== currentUser.id && (
                <div className="rounded-2xl bg-amber-50 dark:bg-amber-950/40 p-4 border border-amber-300 dark:border-amber-800/80 space-y-3">
                  <div className="flex items-start gap-3">
                    <RefreshCw className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-amber-900 dark:text-amber-200">
                      <p className="font-bold text-xs">Active Switched Session</p>
                      <p className="mt-0.5 text-amber-800 dark:text-amber-300">
                        You are currently operating as <strong>{currentUser.name}</strong> ({currentUser.role.replace('_', ' ')}).
                        Your original root login identity is <strong>{rootUser.name}</strong> ({rootUser.role.replace('_', ' ')}).
                      </p>
                    </div>
                  </div>

                  {onSwitchBackToRoot && (
                    <button
                      type="button"
                      onClick={async () => {
                        await onSwitchBackToRoot();
                        onClose();
                      }}
                      className="w-full flex items-center justify-center gap-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold py-2 px-4 text-xs shadow-xs transition-colors cursor-pointer"
                    >
                      <ArrowLeft className="h-4 w-4" />
                      <span>Switch Back to Root Account ({rootUser.name})</span>
                    </button>
                  )}
                </div>
              )}

              {/* Check if user has permission to view other users and switch */}
              {!canSwitchUser ? (
                <div className="rounded-2xl bg-slate-50 dark:bg-slate-800/60 p-6 border border-slate-200 dark:border-slate-700 text-center space-y-3">
                  <div className="mx-auto h-12 w-12 rounded-2xl bg-amber-100 dark:bg-amber-950/80 flex items-center justify-center text-amber-600 dark:text-amber-400">
                    <Lock className="h-6 w-6" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-800 dark:text-white">
                      Switch User Login Restricted
                    </h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
                      Switch user login list is only visible to Employees who have switch user login enabled. Standard user accounts cannot view other user profiles or switch identities.
                    </p>
                  </div>
                  <div className="pt-2 text-[11px] text-slate-400">
                    If you require switch user login privileges, please contact your Administrator.
                  </div>
                  {/* Escape hatch: always allow logging out to re-authenticate
                      as an account with switch privileges (e.g. Super Admin). */}
                  <button
                    type="button"
                    onClick={onLogout}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 px-4 py-2 text-xs font-bold transition-colors cursor-pointer"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    <span>Log Out &amp; Re-authenticate</span>
                  </button>
                </div>
              ) : (
                <>
                  {/* Search user list */}
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Filter profiles by name, role, or branch..."
                      className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 pl-9 pr-3.5 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:border-indigo-500 focus:bg-white dark:focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                  </div>

                  {/* Users List */}
                  <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                    {filteredUsers.map((u) => {
                      const isCurrent = u.id === currentUser.id;
                      const isSwitching = switchingId === u.id;
                      const bName =
                        branches.find((b) => b.id === u.branchId)?.name || 'HQ / All Branches';

                      return (
                        <div
                          key={u.id}
                          className={`group flex items-center justify-between p-3 rounded-2xl border transition-all ${
                            isCurrent
                              ? 'bg-indigo-50/80 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-800 ring-1 ring-indigo-400/30'
                              : 'bg-white dark:bg-slate-800/80 border-slate-200/80 dark:border-slate-700 hover:border-indigo-300 dark:hover:border-indigo-600'
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <div className="h-10 w-10 rounded-xl bg-slate-100 dark:bg-slate-700 flex items-center justify-center font-bold text-slate-700 dark:text-slate-200 text-sm flex-shrink-0 group-hover:scale-105 transition-transform">
                              {u.name.split(' ').map((n) => n[0]).join('').substring(0, 2).toUpperCase()}
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-bold text-slate-900 dark:text-white truncate">
                                  {u.name}
                                </span>
                                <span
                                  className={`text-[9px] font-bold px-2 py-0.5 rounded-md border ${getRoleBadgeColor(
                                    u.role
                                  )}`}
                                >
                                  {u.role.replace('_', ' ')}
                                </span>
                              </div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono truncate flex items-center gap-2 mt-0.5">
                                <span>{u.email}</span>
                                <span>•</span>
                                <span className="flex items-center gap-1 font-sans">
                                  <Building2 className="h-3 w-3 text-slate-400" />
                                  {bName}
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="ml-3 flex-shrink-0">
                            {isCurrent ? (
                              <div className="flex items-center gap-1 text-[11px] font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-100/80 dark:bg-indigo-900/60 px-3 py-1.5 rounded-xl border border-indigo-200 dark:border-indigo-800">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                <span>Active</span>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleSwitch(u.id)}
                                disabled={isSwitching}
                                className="flex items-center gap-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white px-3.5 py-1.5 text-xs font-bold transition-all shadow-xs cursor-pointer"
                                title="Switch to this profile"
                              >
                                {isSwitching ? (
                                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <span>Switch</span>
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {filteredUsers.length === 0 && (
                      <div className="p-8 text-center text-slate-500 dark:text-slate-400 text-xs">
                        No user profiles found matching "{search}".
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'edit' && (
            <form onSubmit={handleUpdate} className="space-y-4">
              {updateSuccess && (
                <div className="flex items-center gap-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 p-3 text-xs text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  <span>Profile updated successfully!</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Full Name
                </label>
                <div className="relative">
                  <UserIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    required
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 pl-10 pr-3.5 py-2 text-xs text-slate-900 dark:text-white focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type="email"
                    required
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 pl-10 pr-3.5 py-2 text-xs text-slate-900 dark:text-white focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  New Password (Optional)
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type="password"
                    value={editPassword}
                    onChange={(e) => setEditPassword(e.target.value)}
                    placeholder="Leave blank to keep current password"
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 pl-10 pr-3.5 py-2 text-xs text-slate-900 dark:text-white focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={updating}
                  className="flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 text-xs font-bold transition-all cursor-pointer shadow-md disabled:opacity-50"
                >
                  {updating ? (
                    <span>Saving...</span>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      <span>Update Profile Info</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Modal Footer with Sign Out */}
        <div className="p-4 bg-slate-50 dark:bg-slate-900/90 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between flex-shrink-0">
          <div className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
            Session ID: <span className="font-mono text-slate-700 dark:text-slate-300">IZ-SES-{currentUser.id}</span>
          </div>

          <button
            type="button"
            onClick={() => {
              onLogout();
              onClose();
            }}
            className="flex items-center gap-1.5 rounded-xl bg-rose-50 dark:bg-rose-950/60 hover:bg-rose-100 dark:hover:bg-rose-900/80 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900 px-4 py-2 text-xs font-bold transition-all cursor-pointer"
          >
            <LogOut className="h-4 w-4 text-rose-600 dark:text-rose-400" />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </div>
  );
};
