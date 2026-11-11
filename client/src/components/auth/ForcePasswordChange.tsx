/**
 * First-sign-in password change.
 *
 * A login created from the employee record starts on a one-time password that
 * HR hands over once. The server accepts only the account endpoints while the
 * flag is set, so this screen is everything the account can do until the
 * employee replaces it with a password only they know.
 */
import React, { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api } from '../../services/api';
import type { User } from '../../types';

interface ForcePasswordChangeProps {
  user: User;
  onDone: (user: User, token: string) => void | Promise<void>;
  onLogout: () => void;
}

const inputClass =
  'h-10 w-full rounded-xl border border-slate-300 bg-transparent px-3 text-sm dark:border-slate-700';

export const ForcePasswordChange: React.FC<ForcePasswordChangeProps> = ({
  user,
  onDone,
  onLogout,
}) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError('Choose a password of at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('The two new passwords do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('Choose a password different from the one-time one.');
      return;
    }
    setSaving(true);
    try {
      await api.updateProfile({ currentPassword, newPassword });
      // Changing the password retires every issued token: sign in again with
      // the credential the employee just chose.
      const res = await api.login(user.email, newPassword);
      await onDone(res.user, res.token);
    } catch (err: any) {
      setError(err?.message || 'The password could not be changed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="app-shell">
      <div className="mx-auto w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300">
            <KeyRound size={18} />
          </span>
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
              Set your password
            </h2>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {user.name} · {user.email}
            </p>
          </div>
        </div>
        <p className="mb-4 text-[11px] text-slate-500 dark:text-slate-400">
          This account was created with a one-time password. Enter it once, then choose the
          password you will use from now on.
        </p>
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500">
              One-time password
            </label>
            <input
              type="password"
              autoFocus
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              className={inputClass}
              autoComplete="current-password"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500">
              New password
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className={inputClass}
              autoComplete="new-password"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Repeat new password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className={inputClass}
              autoComplete="new-password"
            />
          </div>
          {error ? <p className="text-[11px] font-semibold text-rose-600">{error}</p> : null}
          <button
            type="submit"
            disabled={saving}
            className="w-full cursor-pointer rounded-xl bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save password and continue'}
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="w-full cursor-pointer rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
};
