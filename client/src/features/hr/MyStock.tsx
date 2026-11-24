/**
 * My Stock — the signed-in employee's own equipment custody.
 *
 * The payload is the existing `EmployeeStockPanel` in self mode; this screen's
 * only job is to resolve which employee record the account is, because the
 * holdings API is keyed by employee id and the session carries a user, not an
 * employee (the link is `employees.user_id`, resolved here by the self-service
 * profile read the rest of My Workplace already uses).
 */
import React, { useEffect, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../../services/api';
import { EmployeeStockPanel } from '../inventory/EmployeeStockPanel';
import type { User } from '../../types';

export const MyStock: React.FC<{ currentUser?: User | null }> = ({ currentUser }) => {
  const [employeeId, setEmployeeId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    api.getMyHrProfile()
      .then((profile: any) => {
        if (live) setEmployeeId(String(profile?.id || ''));
      })
      .catch((err: any) => {
        if (live) setError(err?.message || 'Your employee record could not be loaded.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">My Stock</h1>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          The equipment this account holds, and every movement that put it there.
        </p>
      </div>

      {loading && (
        <p className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 size={13} className="animate-spin" /> Loading your custody record…
        </p>
      )}

      {!loading && error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300"
        >
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!loading && !error && employeeId && (
        <EmployeeStockPanel employeeId={employeeId} self currentUser={currentUser} />
      )}

      {!loading && !error && !employeeId && (
        <p className="text-xs text-slate-500">
          No employee record is linked to this account yet, so there is no custody to show. Ask an administrator to
          link your login to your employee record.
        </p>
      )}
    </section>
  );
};

export default MyStock;
