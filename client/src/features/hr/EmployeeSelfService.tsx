/**
 * People & HR → My Profile (employee self-service).
 *
 * The record comes from `GET /api/hr/self-service/profile`, resolved from the
 * signed-in account's `employees.user_id` — there is no employee picker. Editing
 * is deliberately narrow: the employee owns their contact card and photo, while
 * salary, statutory ids, bank details and employment terms stay HR's. Those are
 * shown read-only with a lock, and the server refuses them by name even if this
 * screen is bypassed.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  BadgeCheck,
  Camera,
  Lock,
  Pencil,
  RefreshCw,
  Save,
  UserCheck,
  X,
} from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { useActivationKey } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type { HrSelfProfile } from '../../services/api';
import type { User } from '../../types';
import { formatMoneyPrecise } from '../../utils/nprFormat';
import { isOperationAllowed } from '../../utils/permissions';
import { broadcastSelfPhotoChanged } from '../../utils/selfPhoto';
import { patchStoredUser } from '../../utils/sessionCache';
import { EmployeeSelfServicePhotoDialog } from './EmployeeSelfServicePhotoDialog';

interface EmployeeSelfServiceProps {
  currentUser?: User | null;
}

const panel =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const errorBox =
  'flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';
const labelClass = 'text-[10px] font-semibold uppercase tracking-wide text-slate-400';
const valueClass = 'mt-0.5 text-xs font-medium text-slate-700 dark:text-slate-200';
const inputClass =
  'mt-1 h-9 w-full rounded-lg border border-slate-300 bg-transparent px-2.5 text-xs dark:border-slate-700';
const chipClass =
  'inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:border-slate-700 dark:text-slate-400';
const ghostButton =
  'flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[0-9+()\-\s]{6,30}$/;

const show = (value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : value;

const money = (value: number | string | null): string =>
  value === null || value === '' ? '—' : formatMoneyPrecise(value);

const initialsFor = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

interface Draft {
  personalContact: string;
  personalEmail: string;
  address: string;
  emergencyContactPerson: string;
  emergencyContactNumber: string;
}

const draftFrom = (profile: HrSelfProfile): Draft => ({
  personalContact: profile.personalContact || '',
  personalEmail: profile.personalEmail || '',
  address: profile.address || '',
  emergencyContactPerson: profile.emergencyContactPerson || '',
  emergencyContactNumber: profile.emergencyContactNumber || '',
});

const nullable = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const Field: React.FC<{ label: string; children: React.ReactNode; locked?: boolean }> = ({
  label,
  children,
  locked,
}) => (
  <div>
    <dt className={labelClass}>
      <span className="inline-flex items-center gap-1">
        {label}
        {locked ? <Lock className="h-2.5 w-2.5 text-slate-300 dark:text-slate-600" /> : null}
      </span>
    </dt>
    <dd className={valueClass}>{children}</dd>
  </div>
);

export const EmployeeSelfService: React.FC<EmployeeSelfServiceProps> = ({ currentUser }) => {
  const allowed = isOperationAllowed('hr-self-service', currentUser?.role);
  const activationKey = useActivationKey('hr-self-service');

  const [profile, setProfile] = useState<HrSelfProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    personalContact: '',
    personalEmail: '',
    address: '',
    emergencyContactPerson: '',
    emergencyContactNumber: '',
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [photoOpen, setPhotoOpen] = useState(false);

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
      setSavedNote('');
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

  const initials = useMemo(() => initialsFor(profile?.name || ''), [profile?.name]);

  const startEditing = (): void => {
    if (!profile) return;
    setDraft(draftFrom(profile));
    setSaveError('');
    setSavedNote('');
    setEditing(true);
  };

  const cancelEditing = (): void => {
    if (profile) setDraft(draftFrom(profile));
    setSaveError('');
    setEditing(false);
  };

  /** The allow-listed payload, never the HR-only columns. */
  const payloadFrom = useCallback(
    (source: Draft, photo: string | null) => ({
      personalContact: nullable(source.personalContact),
      personalEmail: nullable(source.personalEmail),
      address: nullable(source.address),
      emergencyContactPerson: nullable(source.emergencyContactPerson),
      emergencyContactNumber: nullable(source.emergencyContactNumber),
      profilePhoto: photo,
    }),
    []
  );

  const handleSave = async (): Promise<void> => {
    if (!profile) return;
    setSaveError('');
    setSavedNote('');
    const contact = draft.personalContact.trim();
    if (contact && !PHONE_PATTERN.test(contact)) {
      setSaveError('Personal contact must be 6–30 digits and may include + ( ) - and spaces.');
      return;
    }
    const emergency = draft.emergencyContactNumber.trim();
    if (emergency && !PHONE_PATTERN.test(emergency)) {
      setSaveError('Emergency number must be 6–30 digits and may include + ( ) - and spaces.');
      return;
    }
    const email = draft.personalEmail.trim();
    if (email && !EMAIL_PATTERN.test(email)) {
      setSaveError('Personal e-mail is not a valid address.');
      return;
    }
    setSaving(true);
    try {
      const next = await api.saveMyHrProfile(payloadFrom(draft, profile.profilePhoto ?? null));
      setProfile(next);
      setDraft(draftFrom(next));
      setEditing(false);
      setSavedNote('Saved. HR sees these details on your employee record.');
    } catch (err: any) {
      setSaveError(err?.message || 'Your changes could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const handlePhotoSave = async (dataUrl: string | null): Promise<void> => {
    if (!profile) return;
    const source = editing ? draft : draftFrom(profile);
    const next = await api.saveMyHrProfile(payloadFrom(source, dataUrl));
    setProfile(next);
    // The shell header reads the same photo from the session user: update it
    // now for this session and in the stored session so a reload keeps it.
    patchStoredUser({ avatarUrl: next.profilePhoto ?? undefined });
    broadcastSelfPhotoChanged(next.profilePhoto ?? null);
    setPhotoOpen(false);
    setSavedNote(dataUrl ? 'Profile picture updated.' : 'Profile picture removed.');
  };

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
        description="Your record, your contact details and your photo. Salary, statutory ids, bank details and employment terms are managed by HR."
        icon={<UserCheck className="h-5 w-5 text-emerald-500" />}
        actions={
          <button type="button" onClick={() => void load()} disabled={loading} className={ghostButton}>
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

      {savedNote ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] font-medium text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300">
          {savedNote}
        </p>
      ) : null}

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
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-4">
                <div className="relative shrink-0">
                  <div className="h-20 w-20 overflow-hidden rounded-full border border-slate-200 bg-slate-100 sm:h-24 sm:w-24 dark:border-slate-700 dark:bg-slate-800">
                    {profile.profilePhoto ? (
                      <img
                        src={profile.profilePhoto}
                        alt={`${profile.name} profile`}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-xl font-bold text-slate-400">
                        {initials || '—'}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setPhotoOpen(true)}
                    title="Change profile picture"
                    aria-label="Change profile picture"
                    className="absolute -bottom-1 -right-1 rounded-full border border-slate-200 bg-white p-1.5 text-slate-500 shadow-sm transition-colors hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                  >
                    <Camera className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-slate-800 dark:text-slate-100">
                    {profile.name}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {profile.employeeCode} · {show(profile.designation)} ·{' '}
                    {show(profile.branchName || profile.branchId)}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                      <BadgeCheck className="h-3 w-3" />
                      {profile.isActive ? 'Active' : 'Inactive'}
                    </span>
                    <span className={chipClass}>{show(profile.department)}</span>
                    <span className={chipClass}>{show(profile.employmentType)}</span>
                    <span className={chipClass}>Joined {show(profile.joiningDateAD)}</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {editing ? (
                  <button type="button" onClick={cancelEditing} className={ghostButton}>
                    <X className="h-3.5 w-3.5" />
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={startEditing}
                    className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit information
                  </button>
                )}
                <button type="button" onClick={() => setPhotoOpen(true)} className={ghostButton}>
                  <Camera className="h-3.5 w-3.5" />
                  {profile.profilePhoto ? 'Change photo' : 'Add photo'}
                </button>
              </div>
            </div>
          </section>

          <section className={panel}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                Contact & emergency
              </h3>
              <span className="text-[10px] text-slate-400">
                You can edit these five fields. Everything else is HR-managed.
              </span>
            </div>

            {saveError ? (
              <div className={`${errorBox} mt-3`} role="alert">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{saveError}</span>
              </div>
            ) : null}

            {editing ? (
              <div className="mt-3 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <label className="block">
                    <span className={labelClass}>Personal contact</span>
                    <input
                      type="tel"
                      value={draft.personalContact}
                      onChange={(event) =>
                        setDraft({ ...draft, personalContact: event.target.value })
                      }
                      className={inputClass}
                      placeholder="98XXXXXXXX"
                    />
                  </label>
                  <label className="block">
                    <span className={labelClass}>Personal e-mail</span>
                    <input
                      type="email"
                      value={draft.personalEmail}
                      onChange={(event) => setDraft({ ...draft, personalEmail: event.target.value })}
                      className={inputClass}
                      placeholder="you@example.com"
                    />
                  </label>
                  <label className="block">
                    <span className={labelClass}>Emergency contact person</span>
                    <input
                      type="text"
                      value={draft.emergencyContactPerson}
                      onChange={(event) =>
                        setDraft({ ...draft, emergencyContactPerson: event.target.value })
                      }
                      className={inputClass}
                    />
                  </label>
                  <label className="block">
                    <span className={labelClass}>Emergency number</span>
                    <input
                      type="tel"
                      value={draft.emergencyContactNumber}
                      onChange={(event) =>
                        setDraft({ ...draft, emergencyContactNumber: event.target.value })
                      }
                      className={inputClass}
                    />
                  </label>
                  <label className="block sm:col-span-2">
                    <span className={labelClass}>Address</span>
                    <input
                      type="text"
                      value={draft.address}
                      onChange={(event) => setDraft({ ...draft, address: event.target.value })}
                      className={inputClass}
                    />
                  </label>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={saving}
                    className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
                  >
                    <Save className="h-3.5 w-3.5" />
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </div>
            ) : (
              <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Personal contact">{show(profile.personalContact)}</Field>
                <Field label="Personal e-mail">{show(profile.personalEmail)}</Field>
                <Field label="Address">{show(profile.address)}</Field>
                <Field label="Emergency contact">{show(profile.emergencyContactPerson)}</Field>
                <Field label="Emergency number">{show(profile.emergencyContactNumber)}</Field>
              </dl>
            )}
          </section>

          <section className={panel}>
            <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">Employment</h3>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Employee code" locked>
                {show(profile.employeeCode)}
              </Field>
              <Field label="Department" locked>
                {show(profile.department)}
              </Field>
              <Field label="Designation" locked>
                {show(profile.designation)}
              </Field>
              <Field label="Designation code" locked>
                {show(profile.designationCode)}
              </Field>
              <Field label="Employment type" locked>
                {show(profile.employmentType)}
              </Field>
              <Field label="Work station" locked>
                {show(profile.workStation)}
              </Field>
              <Field label="Joining date (AD)" locked>
                {show(profile.joiningDateAD)}
              </Field>
              <Field label="Contract expiry (AD)" locked>
                {show(profile.contractExpiryAD)}
              </Field>
              <Field label="Date of birth (AD)" locked>
                {show(profile.dateOfBirthAD)}
              </Field>
              <Field label="Branch" locked>
                {show(profile.branchName || profile.branchId)}
              </Field>
              <Field label="Internal e-mail" locked>
                {show(profile.internalEmail)}
              </Field>
            </dl>
          </section>

          <section className={panel}>
            <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              Statutory, bank & salary
            </h3>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="PAN number" locked>
                {show(profile.panNumber)}
              </Field>
              <Field label="SSF number" locked>
                {show(profile.ssfNumber)}
              </Field>
              <Field label="SSF eligible" locked>
                {profile.ssfEligible ? 'Yes' : 'No'}
              </Field>
              <Field label="Bank" locked>
                {show(profile.bankName)}
              </Field>
              <Field label="Bank account" locked>
                {show(profile.bankAccount)}
              </Field>
              <Field label="Monthly salary (reference)" locked>
                {money(profile.monthlySalary)}
              </Field>
            </dl>
            <p className="mt-3 text-[10px] text-slate-400">
              Monthly salary is the master-sheet reference value. Posted payroll comes from the
              effective-dated salary structure and payslips. Only the profile linked to your login is
              returned; HR manages all other changes.
            </p>
          </section>

          {photoOpen ? (
            <EmployeeSelfServicePhotoDialog
              photo={profile.profilePhoto}
              employeeName={profile.name}
              onClose={() => setPhotoOpen(false)}
              onSave={handlePhotoSave}
            />
          ) : null}
        </>
      )}
    </div>
  );
};

export default EmployeeSelfService;
