/**
 * People & HR → My Profile (employee self-service).
 *
 * Read-only by design: every figure and field comes from
 * `GET /api/hr/self-service/profile`, which resolves the record from the
 * signed-in account's `employees.user_id`. There is no employee picker, no
 * branch picker and no save control, because the endpoint has no write path.
 * A caller without `hr-self-service` is refused on screen before the read is
 * attempted; the server repeats the same check.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, BadgeCheck, RefreshCw, UserCheck } from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { useActivationKey } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type { HrSelfProfile } from '../../services/api';
import type { User } from '../../types';
import { formatMoneyPrecise } from '../../utils/nprFormat';
import { isOperationAllowed } from '../../utils/permissions';

interface EmployeeSelfServiceProps {
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

const money = (value: number | string | null): string =>
  value === null || value === '' ? '—' : formatMoneyPrecise(value);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <dt className={labelClass}>{label}</dt>
    <dd className={valueClass}>{children}</dd>
  </div>
);

export const EmployeeSelfService: React.FC<EmployeeSelfServiceProps> = ({ currentUser }) => {
  const allowed = isOperationAllowed('hr-self-service', currentUser?.role);
  const activationKey = useActivationKey('hr-self-service');

  const [profile, setProfile] = useState<HrSelfProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!allowed) {
      setProfile(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const next = await api.getMyHrProfile();
      setProfile(next || null);
    } catch (err: any) {
      setError(err?.message || 'Your employee profile could not be loaded.');
      setProfile(null);
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
          title="My Profile"
          description="Your own employee record."
          icon={<UserCheck className="h-5 w-5 text-emerald-500" />}
        />
        <div className={errorBox} role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>You do not have permission to view your employee profile.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="My Profile"
        description="Your own employee record, read-only. Payroll changes and document updates are handled by HR."
        icon={<UserCheck className="h-5 w-5 text-emerald-500" />}
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

      {loading && !profile ? (
        <section className={panel}>
          <p className="px-1 py-6 text-center text-xs text-slate-400">Loading your profile…</p>
        </section>
      ) : !profile ? (
        <section className={panel}>
          <p className="px-1 py-6 text-center text-xs text-slate-400">
            No employee record is linked to this account. Ask HR to link your login.
          </p>
        </section>
      ) : (
        <>
          <section className={panel}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3 dark:border-slate-800">
              <div>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {profile.name}
                </p>
                <p className="text-[11px] text-slate-400">
                  {profile.employeeCode} · {show(profile.designation)} ·{' '}
                  {show(profile.branchName || profile.branchId)}
                </p>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                <BadgeCheck className="h-3 w-3" />
                {profile.isActive ? 'Active' : 'Inactive'}
              </span>
            </div>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Employee code">{show(profile.employeeCode)}</Field>
              <Field label="Department">{show(profile.department)}</Field>
              <Field label="Designation">{show(profile.designation)}</Field>
              <Field label="Designation code">{show(profile.designationCode)}</Field>
              <Field label="Employment type">{show(profile.employmentType)}</Field>
              <Field label="Work station">{show(profile.workStation)}</Field>
              <Field label="Joining date (AD)">{show(profile.joiningDateAD)}</Field>
              <Field label="Contract expiry (AD)">{show(profile.contractExpiryAD)}</Field>
              <Field label="Date of birth (AD)">{show(profile.dateOfBirthAD)}</Field>
              <Field label="Branch">{show(profile.branchName || profile.branchId)}</Field>
            </dl>
          </section>

          <section className={panel}>
            <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">Contact</h3>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Personal contact">{show(profile.personalContact)}</Field>
              <Field label="Internal e-mail">{show(profile.internalEmail)}</Field>
              <Field label="Personal e-mail">{show(profile.personalEmail)}</Field>
              <Field label="Emergency contact">{show(profile.emergencyContactPerson)}</Field>
              <Field label="Emergency number">{show(profile.emergencyContactNumber)}</Field>
              <Field label="Address">{show(profile.address)}</Field>
            </dl>
          </section>

          <section className={panel}>
            <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              Statutory, bank & salary
            </h3>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="PAN number">{show(profile.panNumber)}</Field>
              <Field label="SSF number">{show(profile.ssfNumber)}</Field>
              <Field label="SSF eligible">{profile.ssfEligible ? 'Yes' : 'No'}</Field>
              <Field label="Bank">{show(profile.bankName)}</Field>
              <Field label="Bank account">{show(profile.bankAccount)}</Field>
              <Field label="Monthly salary (reference)">{money(profile.monthlySalary)}</Field>
            </dl>
            <p className="mt-3 text-[10px] text-slate-400">
              Monthly salary is the master-sheet reference value. Posted payroll comes from the
              effective-dated salary structure and payslips.
            </p>
          </section>

          <p className="text-[10px] text-slate-400">
            Read-only self-service. Only the profile linked to your login is returned; HR manages
            changes and documents.
          </p>
        </>
      )}
    </div>
  );
};

export default EmployeeSelfService;
