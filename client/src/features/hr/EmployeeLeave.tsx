/**
 * People & HR → My Leave (employee self-service).
 *
 * Read-only view of the signed-in employee's own leave balances and request
 * history. The server derives the employee from `employees.user_id` and the
 * endpoint has no apply, cancel or approve path, so this screen exposes no
 * employee/branch picker and no request action. A role without
 * `hr-self-service` is refused before the read is attempted.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CalendarDays, RefreshCw } from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { useActivationKey } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type { HrSelfLeaveBalance, HrSelfLeaveRequest } from '../../services/api';
import type { User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';

interface EmployeeLeaveProps {
  currentUser?: User | null;
}

const panel =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const errorBox =
  'flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';
const labelClass = 'text-[10px] font-semibold uppercase tracking-wide text-slate-400';
const valueClass = 'mt-0.5 text-xs font-medium text-slate-700 dark:text-slate-200';

const show = (value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : value;

const days = (value: number): string =>
  Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });

const statusBadge = (status: string): string => {
  if (status === 'APPROVED') {
    return 'inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300';
  }
  if (status === 'REJECTED') {
    return 'inline-flex items-center rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300';
  }
  if (status === 'CANCELLED') {
    return 'inline-flex items-center rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400';
  }
  return 'inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300';
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <dt className={labelClass}>{label}</dt>
    <dd className={valueClass}>{children}</dd>
  </div>
);

const BalanceCard: React.FC<{ balance: HrSelfLeaveBalance }> = ({ balance }) => (
  <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
    <div className="flex items-start justify-between gap-2">
      <div>
        <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">
          {balance.leaveTypeName}
        </p>
        <p className="mt-0.5 text-[10px] text-slate-400">
          {balance.leaveTypeCode} · {balance.balanceYear} ·{' '}
          {balance.leaveTypePaid ? 'Paid' : 'Unpaid'}
        </p>
      </div>
      <span className="text-right">
        <span className="block text-lg font-semibold text-emerald-600 dark:text-emerald-400">
          {days(balance.remainingDays)}
        </span>
        <span className="block text-[10px] uppercase tracking-wide text-slate-400">
          days left
        </span>
      </span>
    </div>
    <dl className="mt-3 grid grid-cols-3 gap-2">
      <Field label="Entitled">{days(balance.entitlementDays)}</Field>
      <Field label="Adjustment">{days(balance.adjustmentDays)}</Field>
      <Field label="Used">{days(balance.usedDays)}</Field>
    </dl>
  </div>
);

export const EmployeeLeave: React.FC<EmployeeLeaveProps> = ({ currentUser }) => {
  const allowed = isOperationAllowed('hr-self-service', currentUser?.role);
  const activationKey = useActivationKey('hr-self-leave');

  const [balances, setBalances] = useState<HrSelfLeaveBalance[]>([]);
  const [requests, setRequests] = useState<HrSelfLeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!allowed) {
      setBalances([]);
      setRequests([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const next = await api.getMyHrLeave();
      setBalances(next?.balances || []);
      setRequests(next?.requests || []);
    } catch (err: any) {
      setError(err?.message || 'Your leave records could not be loaded.');
      setBalances([]);
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, [allowed]);

  useEffect(() => {
    if (!allowed) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, load, activationKey]);

  if (!allowed) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="My Leave"
          description="Your own leave balances and request history."
          icon={<CalendarDays className="h-5 w-5 text-emerald-500" />}
        />
        <div className={errorBox} role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>You do not have permission to view your leave records.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="My Leave"
        description="Your own leave balances and request history, read-only. HR reviews and records leave decisions."
        icon={<CalendarDays className="h-5 w-5 text-emerald-500" />}
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 text-slate-400 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      />

      {error && (
        <div className={errorBox} role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && !balances.length && !requests.length ? (
        <section className={panel}>
          <p className="px-1 py-6 text-center text-xs text-slate-400">Loading your leave records…</p>
        </section>
      ) : (
        <>
          <section className={panel}>
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                Leave balances
              </h3>
              <span className="text-[10px] text-slate-400">
                Used days are derived from approved requests.
              </span>
            </div>
            {balances.length ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {balances.map((balance) => (
                  <BalanceCard key={balance.id} balance={balance} />
                ))}
              </div>
            ) : (
              <p className="px-1 py-6 text-center text-xs text-slate-400">
                No leave balance is configured for your employee record yet.
              </p>
            )}
          </section>

          <section className={panel}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                Leave requests
              </h3>
              <span className="text-[10px] text-slate-400">
                {requests.length} request{requests.length === 1 ? '' : 's'}
              </span>
            </div>
            {requests.length ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
                      <th className="px-1 py-2 font-semibold">Request</th>
                      <th className="px-1 py-2 font-semibold">Type</th>
                      <th className="px-1 py-2 font-semibold">Dates</th>
                      <th className="px-1 py-2 text-right font-semibold">Days</th>
                      <th className="px-1 py-2 font-semibold">Status</th>
                      <th className="px-1 py-2 font-semibold">Reason / decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((request) => (
                      <tr
                        key={request.id}
                        className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                      >
                        <td className="px-1 py-2.5 font-medium text-slate-700 dark:text-slate-200">
                          {request.requestNo}
                        </td>
                        <td className="px-1 py-2.5">
                          <div className="font-medium text-slate-700 dark:text-slate-200">
                            {request.leaveTypeName}
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-400">
                            {request.leaveTypeCode}
                          </div>
                        </td>
                        <td className="px-1 py-2.5">
                          <div className="text-slate-700 dark:text-slate-200">
                            {request.startDateAD} → {request.endDateAD}
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-400">
                            {show(request.startDateBS)} → {show(request.endDateBS)}
                          </div>
                        </td>
                        <td className="px-1 py-2.5 text-right text-slate-700 dark:text-slate-200">
                          {days(request.daysCount)}
                        </td>
                        <td className="px-1 py-2.5">
                          <span className={statusBadge(request.status)}>{request.status}</span>
                        </td>
                        <td className="px-1 py-2.5 text-slate-600 dark:text-slate-300">
                          <div>{show(request.reason)}</div>
                          {request.decisionNote && (
                            <div className="mt-0.5 text-[10px] text-slate-400">
                              Decision: {request.decisionNote}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-1 py-6 text-center text-xs text-slate-400">
                No leave requests are recorded for your employee record yet.
              </p>
            )}
          </section>

          <p className="text-[10px] text-slate-400">
            Only leave records for the employee linked to your login are returned. Self-service
            cannot create, change or cancel a request.
          </p>
        </>
      )}
    </div>
  );
};

export default EmployeeLeave;
