import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Lock,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
} from 'lucide-react';
import type { User } from '../../types';
import { api } from '../../services/api';
import { isOperationAllowed } from '../../utils/permissions';
import { PageHeader } from '../../components/common/PageHeader';
import { publishLoginLockCount } from '../../utils/loginLockBadge';

/**
 * Login Locks — the sign-in throttle, on its own screen.
 *
 * The limiter keeps its buckets in the server process's memory, so a block can
 * only be lifted by the running server; this screen is the authorised way to
 * do it. Rows are buckets, not people: an account row clears that account's
 * failed sign-ins, an address row clears the shared per-IP counter (which frees
 * everyone behind that address). "Release all" is a separate, explicit action.
 */
interface LoginLockBlock {
  scope: string;
  kind: 'account' | 'ip';
  target: string;
  attempts: number;
  limit: number;
  retryAfterSec: number;
}

interface LoginLocksProps {
  currentUser: User | null;
  /** Bootstrap users, used to show the employee's name beside their email. */
  users: User[];
}

export const LoginLocks: React.FC<LoginLocksProps> = ({ currentUser, users }) => {
  const [blocks, setBlocks] = useState<LoginLockBlock[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const canAdminister = isOperationAllowed('admin-users', currentUser?.role);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.getRateLimitBlocks();
      const next = res.blocks || [];
      setBlocks(next);
      // Feed the sidebar's "N locked" pill from this same read.
      publishLoginLockCount(next.length);
    } catch (err: any) {
      setError(err?.message || 'Could not read the sign-in limiter.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (canAdminister) void load();
  }, [canAdminister, load]);

  /** Display name for an account bucket, falling back to the address itself. */
  const nameFor = (email: string): string => {
    const match = users.find((user) => String(user.email || '').toLowerCase() === email.toLowerCase());
    return match?.name ? String(match.name) : '';
  };

  const release = async (payload: { email?: string; ip?: string; all?: boolean }) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api.releaseRateLimit(payload);
      setNotice(
        res.released > 0
          ? `${res.released} lock${res.released === 1 ? '' : 's'} released. Affected users can sign in now.`
          : 'Nothing to release — those buckets were already clear.'
      );
      await load();
    } catch (err: any) {
      setError(err?.message || 'The release was refused.');
      setBusy(false);
    }
  };

  if (!canAdminister) {
    return (
      <div className="mx-auto my-8 max-w-2xl space-y-4 rounded-3xl border border-rose-200 bg-rose-50 p-10 text-center text-rose-900 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">
        <ShieldAlert className="mx-auto h-14 w-14 text-rose-500" />
        <h2 className="font-serif text-xl font-bold">Access Denied</h2>
        <p className="mx-auto max-w-md text-xs leading-relaxed opacity-90">
          You need the <strong>User Management &amp; Role Assignment</strong> permission to see or release
          sign-in locks. Contact your Super Admin to grant it.
        </p>
      </div>
    );
  }

  const accountLocks = blocks.filter((block) => block.kind === 'account').length;
  const addressLocks = blocks.length - accountLocks;

  return (
    <div className="space-y-3">
      <PageHeader
        title="Login Locks & Sign-in Throttle"
        description="Accounts and addresses the sign-in limiter is currently holding closed. A block clears itself within a minute; release it here when someone cannot wait."
        icon={<Lock className="h-5 w-5 text-amber-500" />}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              onClick={load}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 shadow-xs transition-colors hover:bg-slate-50 disabled:opacity-60 cursor-pointer dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <RefreshCw className="h-4 w-4" />
              <span>Refresh</span>
            </button>
            <button
              onClick={() => release({ all: true })}
              disabled={busy || blocks.length === 0}
              className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700 transition-colors hover:bg-rose-100 disabled:opacity-60 cursor-pointer dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
            >
              Release all
            </button>
          </div>
        }
      />

      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="font-medium">{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="font-medium">{notice}</span>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3 dark:border-slate-800">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-100">
            <ShieldCheck className="h-4 w-4 text-slate-400" />
            <span>
              {blocks.length === 0
                ? 'No locks right now'
                : `${accountLocks} account${accountLocks === 1 ? '' : 's'} · ${addressLocks} address${addressLocks === 1 ? '' : 'es'} blocked`}
            </span>
          </div>
          <span className="text-[10px] text-slate-500 dark:text-slate-400">
            Limits: 4 failed sign-ins per account · 10 attempts per address, per minute
          </span>
        </div>

        {busy && blocks.length === 0 && (
          <p className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">Reading limiter state…</p>
        )}

        {!busy && blocks.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <ShieldCheck className="h-8 w-8 text-emerald-500" />
            <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              Nobody is locked out.
            </p>
            <p className="max-w-md text-[11px] text-slate-500 dark:text-slate-400">
              Sign-in throttling clears itself within a minute. A block appears here the moment an account
              or address reaches its limit.
            </p>
          </div>
        )}

        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {blocks.map((block) => {
            const employeeName = block.kind === 'account' ? nameFor(block.target) : '';
            return (
              <div
                key={`${block.scope}:${block.kind}:${block.target}`}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-bold text-slate-800 dark:text-slate-100">
                    {block.kind === 'account'
                      ? employeeName || block.target
                      : `Address ${block.target}`}
                  </p>
                  <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                    {block.kind === 'account' ? (
                      <>
                        {block.target}
                        {!employeeName && ' · account not in the current user list'}
                      </>
                    ) : (
                      'every account signing in from this address'
                    )}
                  </p>
                  <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                    {block.kind === 'account' ? 'failed sign-ins' : 'sign-in attempts'} · {block.attempts}/
                    {block.limit} in the window · clears in {block.retryAfterSec}s ·{' '}
                    {block.scope === 'auth-login' ? 'sign-in' : 'password reset'}
                  </p>
                </div>
                <button
                  onClick={() => release(block.kind === 'account' ? { email: block.target } : { ip: block.target })}
                  disabled={busy}
                  className="shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 text-[11px] font-bold text-white transition-colors hover:bg-amber-600 disabled:opacity-60 cursor-pointer"
                  aria-label={`Release ${block.kind === 'account' ? `the lock on ${block.target}` : `address ${block.target}`}`}
                >
                  Release
                </button>
              </div>
            );
          })}
        </div>

        <p className="pt-3 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
          Releasing an account clears only that person's failed sign-ins. Releasing an address frees every
          account behind it, because the per-address counter is shared. Every release is written to the audit
          trail as <code className="font-mono">RELEASE_LOGIN_LOCK</code>.
        </p>
      </div>
    </div>
  );
};
