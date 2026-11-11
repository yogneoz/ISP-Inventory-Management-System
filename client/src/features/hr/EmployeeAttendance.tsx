/**
 * People & HR → My Attendance (employee self-service).
 *
 * Read-only view of the signed-in employee's own attendance for the server's
 * rolling 90-day window. The endpoint derives the employee from
 * `employees.user_id`, has no employee/branch selector and no clock-in/out,
 * edit, delete or approval path. A role without `hr-self-service` is refused
 * before the read is attempted.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Clock, RefreshCw } from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { useActivationKey } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type {
  HrSelfAttendanceRecord,
  HrSelfAttendanceSummary,
} from '../../services/api';
import type { User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';

interface EmployeeAttendanceProps {
  currentUser?: User | null;
}

const panel =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const errorBox =
  'flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';
const labelClass = 'text-[10px] font-semibold uppercase tracking-wide text-slate-400';

const EMPTY_SUMMARY: HrSelfAttendanceSummary = {
  totalDays: 0,
  presentDays: 0,
  absentDays: 0,
  leaveDays: 0,
  halfDays: 0,
  holidayDays: 0,
  weekendDays: 0,
  overtimeHours: 0,
};

const show = (value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : value;

const number = (value: number): string =>
  Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });

const statusLabel = (status: string): string => status.replace(/_/g, ' ');

const statusBadge = (status: string): string => {
  if (status === 'PRESENT') {
    return 'inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300';
  }
  if (status === 'ABSENT') {
    return 'inline-flex items-center rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300';
  }
  if (status === 'LEAVE') {
    return 'inline-flex items-center rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300';
  }
  if (status === 'HALF_DAY') {
    return 'inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300';
  }
  return 'inline-flex items-center rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300';
};

const SummaryCard: React.FC<{ label: string; value: string; hint?: string }> = ({
  label,
  value,
  hint,
}) => (
  <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
    <p className={labelClass}>{label}</p>
    <p className="mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100">{value}</p>
    {hint && <p className="mt-0.5 text-[10px] text-slate-400">{hint}</p>}
  </div>
);

export const EmployeeAttendance: React.FC<EmployeeAttendanceProps> = ({ currentUser }) => {
  const allowed = isOperationAllowed('hr-self-service', currentUser?.role);
  const activationKey = useActivationKey('hr-self-attendance');

  const [summary, setSummary] = useState<HrSelfAttendanceSummary>(EMPTY_SUMMARY);
  const [records, setRecords] = useState<HrSelfAttendanceRecord[]>([]);
  const [windowStartAD, setWindowStartAD] = useState('');
  const [windowEndAD, setWindowEndAD] = useState('');
  const [windowDays, setWindowDays] = useState(90);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!allowed) {
      setSummary(EMPTY_SUMMARY);
      setRecords([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const next = await api.getMyHrAttendance();
      setSummary(next?.summary || EMPTY_SUMMARY);
      setRecords(next?.records || []);
      setWindowStartAD(next?.windowStartAD || '');
      setWindowEndAD(next?.windowEndAD || '');
      setWindowDays(Number(next?.windowDays) || 90);
    } catch (err: any) {
      setError(err?.message || 'Your attendance records could not be loaded.');
      setSummary(EMPTY_SUMMARY);
      setRecords([]);
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
          title="My Attendance"
          description="Your own recent attendance records."
          icon={<Clock className="h-5 w-5 text-emerald-500" />}
        />
        <div className={errorBox} role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>You do not have permission to view your attendance records.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="My Attendance"
        description={`Your own attendance for the last ${windowDays} days, read-only. HR maintains the attendance register.`}
        icon={<Clock className="h-5 w-5 text-emerald-500" />}
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh attendance"
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

      {loading && !records.length ? (
        <section className={panel}>
          <p className="px-1 py-6 text-center text-xs text-slate-400">Loading your attendance records…</p>
        </section>
      ) : (
        <>
          <section className={panel}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                Last {windowDays} days
              </h3>
              <span className="text-[10px] text-slate-400">
                {show(windowStartAD)} → {show(windowEndAD)} · {number(summary.totalDays)} recorded
              </span>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
              <SummaryCard label="Present" value={number(summary.presentDays)} />
              <SummaryCard label="Absent" value={number(summary.absentDays)} />
              <SummaryCard label="Leave" value={number(summary.leaveDays)} />
              <SummaryCard label="Half-day" value={number(summary.halfDays)} />
              <SummaryCard
                label="Holiday / weekend"
                value={number(summary.holidayDays + summary.weekendDays)}
              />
              <SummaryCard
                label="Overtime"
                value={`${number(summary.overtimeHours)} h`}
                hint="Recorded hours"
              />
            </div>
          </section>

          <section className={panel}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                Recent records
              </h3>
              <span className="text-[10px] text-slate-400">
                {records.length} record{records.length === 1 ? '' : 's'}, newest first
              </span>
            </div>
            {records.length ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
                      <th className="px-1 py-2 font-semibold">Date</th>
                      <th className="px-1 py-2 font-semibold">Status</th>
                      <th className="px-1 py-2 font-semibold">Shift</th>
                      <th className="px-1 py-2 font-semibold">Check in</th>
                      <th className="px-1 py-2 font-semibold">Check out</th>
                      <th className="px-1 py-2 text-right font-semibold">OT</th>
                      <th className="px-1 py-2 font-semibold">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((record) => (
                      <tr
                        key={record.id}
                        className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                      >
                        <td className="px-1 py-2.5">
                          <div className="font-medium text-slate-700 dark:text-slate-200">
                            {record.attendanceDateAD}
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-400">
                            {show(record.attendanceDateBS)}
                          </div>
                        </td>
                        <td className="px-1 py-2.5">
                          <span className={statusBadge(record.status)}>{statusLabel(record.status)}</span>
                        </td>
                        <td className="px-1 py-2.5 text-slate-600 dark:text-slate-300">
                          {record.shiftCode || record.shiftName ? (
                            <>
                              <div>{show(record.shiftCode)}</div>
                              <div className="mt-0.5 text-[10px] text-slate-400">
                                {show(record.shiftName)}
                              </div>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-1 py-2.5 text-slate-600 dark:text-slate-300">
                          {show(record.checkInTime)}
                        </td>
                        <td className="px-1 py-2.5 text-slate-600 dark:text-slate-300">
                          {show(record.checkOutTime)}
                        </td>
                        <td className="px-1 py-2.5 text-right text-slate-600 dark:text-slate-300">
                          {number(record.overtimeHours)} h
                        </td>
                        <td className="px-1 py-2.5 text-slate-600 dark:text-slate-300">
                          {show(record.notes)}
                          <div className="mt-0.5 text-[10px] text-slate-400">
                            {record.source === 'IMPORT' ? 'Imported' : 'Manual'}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-1 py-6 text-center text-xs text-slate-400">
                No attendance is recorded for your employee record in this window.
              </p>
            )}
          </section>

          <p className="text-[10px] text-slate-400">
            Only attendance for the employee linked to your login is returned. Self-service cannot
            clock in, edit or delete a day.
          </p>
        </>
      )}
    </div>
  );
};

export default EmployeeAttendance;