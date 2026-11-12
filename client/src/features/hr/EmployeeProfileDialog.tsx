/**
 * F1 Employee Profile dialog.
 *
 * The paper form's personal, family, experience, qualification, medical,
 * declaration and reference sections in one place, saved as a whole profile:
 * the server replaces every section on PUT, so the client always sends all of
 * them back and an emptied table really is cleared.
 *
 * A caller who may only view the employee master gets the masked shape from the
 * server (no scalars, no rows) and this dialog shows the notice instead of an
 * editable form; the write gate stays on the server.
 */
import React, { useEffect, useState } from 'react';
import { Camera, Plus, Trash2, X } from 'lucide-react';
import { ModalPanel } from '../../components/common/ModalPanel';
import { useDialog } from '../../components/common/DialogProvider';
import { api } from '../../services/api';
import type {
  EmployeeRecord,
  EmployeeUserOption,
  HrEmployeeProfileInput,
  HrEmployeeProfileResponse,
  HrOrgMasterKind,
  HrOrgMasterRecord,
  EmployeeLoginHandoff,
  HrEmployeeBranchTransfer,
} from '../../services/api';
import { HR_BLOOD_GROUPS, HR_LOGIN_ROLES, HR_PROFILE_MAX_ROWS } from '../../services/api/hr';
import { APP_ROLE_LABELS } from '../../utils/permissionMatrixData';
import { EmployeeSelfServicePhotoDialog } from './EmployeeSelfServicePhotoDialog';

const ORG_KIND_NOUN: Record<HrOrgMasterKind, string> = {
  DEPARTMENT: 'department',
  DESIGNATION: 'designation',
  WORK_STATION: 'work station',
};

interface EmployeeProfileDialogProps {
  /** null creates a new employee: same form, same photo picker. */
  employee: EmployeeRecord | null;
  canManage: boolean;
  onClose: () => void;
  branches?: Array<{ id: string; name: string; isHeadquarters?: boolean }>;
  /** Branch name for the read-only half of the record block. */
  branchName?: string;
  /** Login accounts this employee can be linked to (HR master). */
  userOptions?: EmployeeUserOption[];
  /** Branch a new employee starts on. */
  defaultBranchId?: string;
  /** Department/designation/work-station suggestions from Org Masters. */
  orgMasters?: HrOrgMasterRecord[];
  /** Called after a catalogue entry is added from inside the form. */
  onOrgMasterCreated?: () => void;
  /** Re-reads the directory after the record is saved. */
  onRecordSaved?: () => void | Promise<void>;
}

interface RecordDraft {
  employeeCode: string;
  name: string;
  branchId: string;
  userId: string;
  department: string;
  designation: string;
  designationCode: string;
  employmentType: string;
  joiningDateAD: string;
  dateOfBirthAD: string;
  contractExpiryAD: string;
  separationDateAD: string;
  workStation: string;
  address: string;
  personalContact: string;
  emergencyContactPerson: string;
  emergencyContactNumber: string;
  internalEmail: string;
  personalEmail: string;
  panNumber: string;
  ssfNumber: string;
  ssfEligible: boolean;
  bankName: string;
  bankAccount: string;
  monthlySalary: string;
  isActive: boolean;
}

const text = (value: string | null | undefined): string => value ?? '';
const salaryText = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? '' : String(value);

/** One draft shape for both modes: a new employee starts blank, an edit starts filled. */
const recordFrom = (employee: EmployeeRecord | null, defaultBranchId: string): RecordDraft => ({
  employeeCode: employee?.employeeCode ?? '',
  name: employee?.name ?? '',
  branchId: employee?.branchId ?? defaultBranchId,
  userId: employee?.userId ?? '',
  department: text(employee?.department),
  designation: text(employee?.designation),
  designationCode: text(employee?.designationCode),
  employmentType: text(employee?.employmentType),
  joiningDateAD: text(employee?.joiningDateAD),
  dateOfBirthAD: text(employee?.dateOfBirthAD),
  contractExpiryAD: text(employee?.contractExpiryAD),
  separationDateAD: text(employee?.separationDateAD),
  workStation: text(employee?.workStation),
  address: text(employee?.address),
  personalContact: text(employee?.personalContact),
  emergencyContactPerson: text(employee?.emergencyContactPerson),
  emergencyContactNumber: text(employee?.emergencyContactNumber),
  internalEmail: text(employee?.internalEmail),
  personalEmail: text(employee?.personalEmail),
  panNumber: text(employee?.panNumber),
  ssfNumber: text(employee?.ssfNumber),
  ssfEligible: employee?.ssfEligible ?? false,
  bankName: text(employee?.bankName),
  bankAccount: text(employee?.bankAccount),
  monthlySalary: salaryText(employee?.monthlySalary),
  isActive: employee?.isActive ?? true,
});

const formatTransferDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

const inputClass =
  'h-9 w-full rounded-lg border border-slate-300 bg-transparent px-2.5 text-xs disabled:opacity-60 dark:border-slate-700';
const areaClass =
  'w-full rounded-lg border border-slate-300 bg-transparent px-2.5 py-1.5 text-xs disabled:opacity-60 dark:border-slate-700';
const labelClass =
  'mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400';
const headerClass =
  'border-b border-slate-100 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:border-slate-800';

let rowSeq = 0;
const nextKey = (): string => `row-${(rowSeq += 1)}`;

const nullable = (value: string): string | null => {
  const parsed = value.trim();
  return parsed || null;
};

interface FamilyDraft {
  key: string;
  name: string;
  age: string;
  occupation: string;
  relation: string;
}
interface ExperienceDraft {
  key: string;
  organization: string;
  fromAD: string;
  toAD: string;
  designation: string;
}
interface QualificationDraft {
  key: string;
  examPassed: string;
  boardUniversity: string;
  percentage: string;
}
interface ReferenceDraft {
  key: string;
  name: string;
  organization: string;
  contact: string;
  relation: string;
}

interface ScalarDraft {
  fatherName: string;
  grandfatherName: string;
  permanentAddress: string;
  localAddress: string;
  emergencyContactAddress: string;
  emergencyContactRelation: string;
  bloodGroup: string;
  medicalConditions: string;
  medicalDetails: string;
  accidentDetails: string;
  caseDetails: string;
  declarationDateAD: string;
  declarationName: string;
}

const EMPTY_SCALARS: ScalarDraft = {
  fatherName: '',
  grandfatherName: '',
  permanentAddress: '',
  localAddress: '',
  emergencyContactAddress: '',
  emergencyContactRelation: '',
  bloodGroup: '',
  medicalConditions: '',
  medicalDetails: '',
  accidentDetails: '',
  caseDetails: '',
  declarationDateAD: '',
  declarationName: '',
};

const blankFamily = (): FamilyDraft => ({
  key: nextKey(),
  name: '',
  age: '',
  occupation: '',
  relation: '',
});
const blankExperience = (): ExperienceDraft => ({
  key: nextKey(),
  organization: '',
  fromAD: '',
  toAD: '',
  designation: '',
});
const blankQualification = (): QualificationDraft => ({
  key: nextKey(),
  examPassed: '',
  boardUniversity: '',
  percentage: '',
});
const blankReference = (): ReferenceDraft => ({
  key: nextKey(),
  name: '',
  organization: '',
  contact: '',
  relation: '',
});

const Section: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({
  title,
  hint,
  children,
}) => (
  <section className="space-y-3">
    <div>
      <h4 className={headerClass}>{title}</h4>
      {hint ? <p className="mt-1 text-[10px] text-slate-400">{hint}</p> : null}
    </div>
    {children}
  </section>
);

export const EmployeeProfileDialog: React.FC<EmployeeProfileDialogProps> = ({
  employee,
  canManage,
  onClose,
  branches = [],
  branchName = '',
  userOptions = [],
  defaultBranchId = '',
  orgMasters = [],
  onOrgMasterCreated,
  onRecordSaved,
}) => {
  const { alert: alertDialog } = useDialog();
  const isCreate = !employee;
  // Masters added from this form stay here until the directory reloads, so the
  // picker offers the new entry straight away without a second GET.
  const [createdMasters, setCreatedMasters] = useState<HrOrgMasterRecord[]>([]);
  const orgList = (kind: HrOrgMasterKind): HrOrgMasterRecord[] => {
    const seen = new Set<string>();
    const rows: HrOrgMasterRecord[] = [];
    for (const master of [...orgMasters, ...createdMasters]) {
      if (master.kind !== kind || !master.isActive || seen.has(master.id)) continue;
      seen.add(master.id);
      rows.push(master);
    }
    return rows;
  };
  /**
   * Picker options for one catalogue kind. Every value comes from Org Masters,
   * so the server can resolve its id; the current value is kept as an extra
   * option when it predates the catalogue (or was retired from it), so editing
   * an old record never silently rewrites its stored text.
   */
  const orgSelectOptions = (kind: HrOrgMasterKind, current: string) => {
    const options = orgList(kind);
    const legacy = current.trim() !== '' && !options.some((master) => master.name === current);
    return (
      <>
        <option value="">— Not set —</option>
        {options.map((master) => (
          <option key={master.id} value={master.name}>
            {master.name}
            {master.code ? ` (${master.code})` : ''}
          </option>
        ))}
        {legacy ? <option value={current}>{current} — not in catalogue</option> : null}
      </>
    );
  };
  const [loading, setLoading] = useState(!employee);
  const [loadError, setLoadError] = useState('');
  const [masked, setMasked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState('');
  // The employee-master half of the record. It is saved by the same Save as the
  // F1 sections, so editing a person is one dialog instead of two.
  const [photo, setPhoto] = useState<string | null>(employee?.profilePhoto ?? null);
  const [photoOpen, setPhotoOpen] = useState(false);
  // A login created with this save. There is no mailer, so the one-time
  // password is shown here exactly once: HR reads it and hands it over.
  const [createLogin, setCreateLogin] = useState(false);
  const [loginRole, setLoginRole] = useState('FRONT_DESK');
  const [createdLogin, setCreatedLogin] = useState<EmployeeLoginHandoff | null>(null);
  const [record, setRecord] = useState<RecordDraft>(() => recordFrom(employee, defaultBranchId));
  // A designation chosen from the catalogue owns its code: the write path
  // resolves the id from name-or-code, so letting the code drift here would
  // detach the employee from the master it was just linked to.
  const designationMaster = orgMasters.find(
    (master) =>
      master.kind === 'DESIGNATION' && master.isActive && master.name === record.designation
  );
  // Keep the locked field showing — and saving — the master's own code, so a
  // record opened with a stale code cannot stay out of step with the catalogue.
  useEffect(() => {
    if (!designationMaster) return;
    const code = designationMaster.code || '';
    setRecord((prev) =>
      prev.designationCode === code ? prev : { ...prev, designationCode: code }
    );
  }, [designationMaster]);
  const [scalars, setScalars] = useState<ScalarDraft>(EMPTY_SCALARS);
  const [family, setFamily] = useState<FamilyDraft[]>([]);
  const [experience, setExperience] = useState<ExperienceDraft[]>([]);
  const [qualifications, setQualifications] = useState<QualificationDraft[]>([]);
  const [references, setReferences] = useState<ReferenceDraft[]>([]);
  const [branchTransfers, setBranchTransfers] = useState<HrEmployeeBranchTransfer[]>([]);

  const readOnly = !canManage || masked;

  // Inline catalogue creation: an administrator (or HR manager, who holds
  // hr-employee-manage by default) can add a missing entry without leaving the
  // employee they are entering. The server keeps the write gate.
  const [addingKind, setAddingKind] = useState<HrOrgMasterKind | null>(null);
  const [newMasterName, setNewMasterName] = useState('');
  const [newMasterCode, setNewMasterCode] = useState('');
  const [addingMaster, setAddingMaster] = useState(false);
  const [addMasterError, setAddMasterError] = useState('');

  const startAddingMaster = (kind: HrOrgMasterKind) => {
    setAddingKind(kind);
    setNewMasterName('');
    setNewMasterCode('');
    setAddMasterError('');
  };

  const cancelAddingMaster = () => {
    setAddingKind(null);
    setNewMasterName('');
    setNewMasterCode('');
    setAddMasterError('');
    setAddingMaster(false);
  };

  const addOrgMaster = async () => {
    if (!addingKind || addingMaster) return;
    const name = newMasterName.trim();
    if (!name) {
      setAddMasterError('A name is required.');
      return;
    }
    const kind = addingKind;
    setAddingMaster(true);
    setAddMasterError('');
    try {
      const master = await api.createHrOrgMaster({
        kind,
        name,
        code: newMasterCode.trim() || undefined,
      });
      setCreatedMasters((prev) => [...prev.filter((row) => row.id !== master.id), master]);
      // Select it right away, so the record keeps its catalogue id.
      if (kind === 'DEPARTMENT') {
        setRecord((prev) => ({ ...prev, department: master.name }));
      } else if (kind === 'WORK_STATION') {
        setRecord((prev) => ({ ...prev, workStation: master.name }));
      } else {
        setRecord((prev) => ({
          ...prev,
          designation: master.name,
          designationCode: master.code || '',
        }));
      }
      cancelAddingMaster();
      onOrgMasterCreated?.();
    } catch (err: any) {
      setAddMasterError(err?.message || 'Could not add the catalogue entry.');
    } finally {
      setAddingMaster(false);
    }
  };

  const renderAdder = () => (
    <div className="mt-1.5 rounded-lg border border-dashed border-indigo-300 p-2 dark:border-indigo-900">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          autoFocus
          type="text"
          maxLength={120}
          value={newMasterName}
          placeholder={`New ${addingKind ? ORG_KIND_NOUN[addingKind] : 'entry'}`}
          onChange={(event) => setNewMasterName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void addOrgMaster();
            } else if (event.key === 'Escape') {
              cancelAddingMaster();
            }
          }}
          className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-transparent px-2 text-[11px] dark:border-slate-700"
        />
        <input
          type="text"
          maxLength={30}
          value={newMasterCode}
          placeholder="Code"
          onChange={(event) => setNewMasterCode(event.target.value.toUpperCase())}
          className="h-8 w-20 rounded-lg border border-slate-300 bg-transparent px-2 font-mono text-[11px] dark:border-slate-700"
        />
        <button
          type="button"
          onClick={() => void addOrgMaster()}
          disabled={addingMaster}
          className="h-8 cursor-pointer rounded-lg bg-indigo-600 px-2.5 text-[11px] font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {addingMaster ? 'Adding…' : 'Add'}
        </button>
        <button
          type="button"
          onClick={cancelAddingMaster}
          className="h-8 cursor-pointer rounded-lg border border-slate-300 px-2.5 text-[11px] font-semibold dark:border-slate-700"
        >
          Cancel
        </button>
      </div>
      <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
        Saves it to Org Masters and selects it here. The code is optional — blank derives it from
        the name.
      </p>
      {addMasterError ? (
        <p className="mt-1 text-[10px] font-semibold text-rose-600 dark:text-rose-400">
          {addMasterError}
        </p>
      ) : null}
    </div>
  );
  // The account an employee is linked to. Its role is editable from here, but
  // only between non-admin roles — the server refuses admin targets.
  const linkedLogin = record.userId
    ? userOptions.find((option) => option.id === record.userId)
    : undefined;
  // An administrator login linked to this employee is read-only here: the
  // server refuses to re-role a Super Admin or Sub Super Admin account, so the
  // dialog shows the real role instead of a picker that cannot save.
  const canEditLinkedRole = Boolean(linkedLogin && HR_LOGIN_ROLES.includes(linkedLogin.role));

  useEffect(() => {
    // An administrator login linked to this employee cannot be re-roled from
    // here, so never prefill an option the picker does not offer.
    if (linkedLogin && HR_LOGIN_ROLES.includes(linkedLogin.role)) {
      setLoginRole(linkedLogin.role);
    }
  }, [linkedLogin?.role, record.userId]);

  const applyResponse = (data: HrEmployeeProfileResponse) => {
    setMasked(Boolean(data.masked));
    setScalars({
      fatherName: data.profile.fatherName || '',
      grandfatherName: data.profile.grandfatherName || '',
      permanentAddress: data.profile.permanentAddress || '',
      localAddress: data.profile.localAddress || '',
      emergencyContactAddress: data.profile.emergencyContactAddress || '',
      emergencyContactRelation: data.profile.emergencyContactRelation || '',
      bloodGroup: data.profile.bloodGroup || '',
      medicalConditions: data.profile.medicalConditions || '',
      medicalDetails: data.profile.medicalDetails || '',
      accidentDetails: data.profile.accidentDetails || '',
      caseDetails: data.profile.caseDetails || '',
      declarationDateAD: data.profile.declarationDateAD || '',
      declarationName: data.profile.declarationName || '',
    });
    setFamily(
      data.familyMembers.map((row) => ({
        key: row.id,
        name: row.name || '',
        age: row.age === null || row.age === undefined ? '' : String(row.age),
        occupation: row.occupation || '',
        relation: row.relation || '',
      }))
    );
    setExperience(
      data.experience.map((row) => ({
        key: row.id,
        organization: row.organization || '',
        fromAD: row.fromAD || '',
        toAD: row.toAD || '',
        designation: row.designation || '',
      }))
    );
    setQualifications(
      data.qualifications.map((row) => ({
        key: row.id,
        examPassed: row.examPassed || '',
        boardUniversity: row.boardUniversity || '',
        percentage:
          row.percentage === null || row.percentage === undefined
            ? ''
            : String(Number(row.percentage)),
      }))
    );
    setReferences(
      data.references.map((row) => ({
        key: row.id,
        name: row.name || '',
        organization: row.organization || '',
        contact: row.contact || '',
        relation: row.relation || '',
      }))
    );
    setBranchTransfers(data.branchTransfers ?? []);
  };

  const load = async () => {
    if (!employee) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await api.getEmployeeProfile(employee.id, employee.branchId);
      applyResponse(data);
      setLoadError('');
    } catch (err: any) {
      setLoadError(err?.message || 'The employee profile could not be read.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // The dialog is remounted per employee; reload only when that id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee?.id]);

  /** HR sets the picture here; the same crop/resize dialog the employee uses. */
  const handlePhotoSave = async (dataUrl: string | null): Promise<void> => {
    setPhotoOpen(false);
    if (isCreate) {
      // There is no employee row yet, so the picture waits for the create.
      setPhoto(dataUrl);
      setSavedNote(dataUrl ? 'Photo ready; it saves with the employee.' : '');
      return;
    }
    const saved = await api.updateEmployee(employee.id, { profilePhoto: dataUrl });
    setPhoto(saved.profilePhoto ?? null);
    setSavedNote(dataUrl ? 'Photo updated.' : 'Photo removed.');
    await onRecordSaved?.();
  };

  const handleSave = async () => {
    setSavedNote('');
    const name = record.name.trim();
    if (!name) {
      alertDialog('An employee name is required.');
      return;
    }
    const employeeCode = record.employeeCode.trim().toUpperCase();
    if (isCreate && !employeeCode) {
      alertDialog('An employee code (HRMS ID) is required.');
      return;
    }
    if (!record.branchId) {
      alertDialog('Choose the branch this employee belongs to.');
      return;
    }
    const monthlySalary = record.monthlySalary.trim() === '' ? null : Number(record.monthlySalary);
    if (monthlySalary !== null && (!Number.isFinite(monthlySalary) || monthlySalary < 0)) {
      alertDialog('Monthly salary must be a number of zero or more.');
      return;
    }
    if (
      record.joiningDateAD &&
      record.separationDateAD &&
      record.separationDateAD < record.joiningDateAD
    ) {
      alertDialog('Separation date must be on or after the joining date.');
      return;
    }
    const familyRows = family.map((row) => ({
      name: row.name.trim(),
      age: row.age.trim() === '' ? null : Number(row.age),
      occupation: nullable(row.occupation),
      relation: nullable(row.relation),
    }));
    if (familyRows.some((row) => !row.name)) {
      alertDialog('Every family row needs a member name.');
      return;
    }
    if (familyRows.some((row) => row.age !== null && !Number.isInteger(row.age))) {
      alertDialog('Family member ages must be whole numbers.');
      return;
    }

    const experienceRows = experience.map((row) => ({
      organization: row.organization.trim(),
      fromAD: row.fromAD || null,
      toAD: row.toAD || null,
      designation: nullable(row.designation),
    }));
    if (experienceRows.some((row) => !row.organization)) {
      alertDialog('Every experience row needs an organisation name.');
      return;
    }
    if (
      experienceRows.some((row) => row.fromAD && row.toAD && row.toAD < row.fromAD)
    ) {
      alertDialog('An experience end date cannot fall before its start date.');
      return;
    }

    const qualificationRows = qualifications.map((row) => ({
      examPassed: row.examPassed.trim(),
      boardUniversity: nullable(row.boardUniversity),
      percentage: row.percentage.trim() === '' ? null : Number(row.percentage),
    }));
    if (qualificationRows.some((row) => !row.examPassed)) {
      alertDialog('Every qualification row needs the exam passed.');
      return;
    }
    if (
      qualificationRows.some(
        (row) => row.percentage !== null && (Number.isNaN(row.percentage) || row.percentage < 0 || row.percentage > 100)
      )
    ) {
      alertDialog('Qualification percentages must be between 0 and 100.');
      return;
    }

    const referenceRows = references.map((row) => ({
      name: row.name.trim(),
      organization: nullable(row.organization),
      contact: nullable(row.contact),
      relation: nullable(row.relation),
    }));
    if (referenceRows.some((row) => !row.name)) {
      alertDialog('Every reference row needs a name.');
      return;
    }

    const payload: HrEmployeeProfileInput = {
      fatherName: nullable(scalars.fatherName),
      grandfatherName: nullable(scalars.grandfatherName),
      permanentAddress: nullable(scalars.permanentAddress),
      localAddress: nullable(scalars.localAddress),
      emergencyContactAddress: nullable(scalars.emergencyContactAddress),
      emergencyContactRelation: nullable(scalars.emergencyContactRelation),
      bloodGroup: nullable(scalars.bloodGroup),
      medicalConditions: nullable(scalars.medicalConditions),
      medicalDetails: nullable(scalars.medicalDetails),
      accidentDetails: nullable(scalars.accidentDetails),
      caseDetails: nullable(scalars.caseDetails),
      declarationDateAD: nullable(scalars.declarationDateAD),
      declarationName: nullable(scalars.declarationName),
      familyMembers: familyRows,
      experience: experienceRows,
      qualifications: qualificationRows,
      references: referenceRows,
    };

    setSaving(true);
    try {
      const master = {
        name,
        // Branch is deliberately not part of an edit: a move must go through
        // the dedicated transfer process so it carries a date and reason, and
        // a stale open form cannot move the employee back.
        userId: record.userId || null,
        department: nullable(record.department),
        designation: nullable(record.designation),
        designationCode: nullable(record.designationCode),
        employmentType: nullable(record.employmentType),
        joiningDateAD: record.joiningDateAD || null,
        dateOfBirthAD: record.dateOfBirthAD || null,
        contractExpiryAD: record.contractExpiryAD || null,
        separationDateAD: record.separationDateAD || null,
        workStation: nullable(record.workStation),
        address: nullable(record.address),
        personalContact: nullable(record.personalContact),
        emergencyContactPerson: nullable(record.emergencyContactPerson),
        emergencyContactNumber: nullable(record.emergencyContactNumber),
        internalEmail: nullable(record.internalEmail),
        personalEmail: nullable(record.personalEmail),
        panNumber: nullable(record.panNumber),
        ssfNumber: nullable(record.ssfNumber),
        ssfEligible: record.ssfEligible,
        bankName: nullable(record.bankName),
        bankAccount: nullable(record.bankAccount),
        monthlySalary,
        isActive: record.isActive,
        // A linked account keeps its role here; the server refuses admin roles
        // and never demotes a Super Admin or Sub Super Admin from this form.
        ...(canEditLinkedRole && HR_LOGIN_ROLES.includes(loginRole) ? { loginRole } : {}),
      };

      if (isCreate) {
        // Employee first, then the F1 sections and the picked photo, so a
        // failed half never leaves profile rows without an employee.
        const created = await api.createEmployee({
          employeeCode,
          branchId: record.branchId,
          ...master,
          ...(createLogin ? { createLogin: true, loginRole } : {}),
        });
        await api.saveEmployeeProfile(created.id, payload, created.branchId);
        if (photo) await api.updateEmployee(created.id, { profilePhoto: photo });
        await onRecordSaved?.();
        if (created.login) {
          // Keep the dialog open: the one-time password is not shown again.
          setCreatedLogin(created.login);
          return;
        }
        onClose();
        return;
      }

      // A failed profile read means the F1 sections are unknown; writing them
      // back would blank the employee's paper form. Save the master only and
      // let the operator retry the read.
      if (!loadError) {
        const saved = await api.saveEmployeeProfile(employee.id, payload, employee.branchId);
        applyResponse(saved);
      }
      // Same Save, second resource: the master fields the dialog owns. A login
      // is created here too when the employee had none, so HR never has to
      // leave the employee record to give someone access.
      const savedRow = await api.updateEmployee(employee.id, {
        ...master,
        ...(createLogin ? { createLogin: true, loginRole } : {}),
      });
      await onRecordSaved?.();
      if (savedRow.login) {
        setCreatedLogin(savedRow.login);
        return;
      }
      setSavedNote('Profile saved.');
      if (savedRow.branchId !== employee.branchId) {
        // The branch move was written after the profile PUT, so refresh the
        // history instead of leaving the dialog on the pre-transfer list.
        try {
          applyResponse(await api.getEmployeeProfile(employee.id));
        } catch {
          // The save succeeded; the history will be fresh on the next open.
        }
      }
    } catch (err: any) {
      alertDialog(`Failed to save the employee: ${err?.message || 'Database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const atLimit = (count: number, max: number): boolean => count >= max;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <ModalPanel
        label={isCreate ? 'New employee' : `F1 Profile — ${record.name}`}
        onClose={onClose}
        className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {photo ? (
              <img
                src={photo}
                alt=""
                className="h-11 w-11 shrink-0 rounded-full border border-slate-200 object-cover dark:border-slate-700"
              />
            ) : (
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                {(record.name || 'New employee')
                  .split(/\s+/)
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((part) => part[0])
                  .join('')
                  .toUpperCase()}
              </span>
            )}
            <div>
              <h3 className="text-base font-bold">
                {isCreate ? 'New employee' : 'F1 Employee Profile'}
              </h3>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {record.name || 'Unnamed'} ·{' '}
                <span className="font-mono">{record.employeeCode || '—'}</span> ·{' '}
                {isCreate ? 'Employee master and F1 form' : 'F1 Employee Detail Form'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <p className="py-10 text-center text-xs text-slate-500">Loading the profile…</p>
        ) : (
          <div className="space-y-6 text-xs">
            {loadError ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50/60 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-200">
                <span>
                  The F1 profile could not be read ({loadError}). Every field below is still
                  open; saving keeps only the master fields until the profile loads.
                </span>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="cursor-pointer rounded-lg border border-rose-300 px-2 py-1 font-semibold dark:border-rose-800"
                >
                  Retry
                </button>
              </div>
            ) : null}
            {masked ? (
              <p className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
                Your role can read the employee master but not its personal profile. Ask an HR
                manager for the F1 details.
              </p>
            ) : null}

            <Section
              title="Employee record"
              hint="HR master fields. They save with the F1 sections, so editing a person is one dialog."
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="flex items-center gap-3 sm:col-span-3">
                  {photo ? (
                    <img
                      src={photo}
                      alt=""
                      className="h-14 w-14 shrink-0 rounded-full border border-slate-200 object-cover dark:border-slate-700"
                    />
                  ) : (
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      {(record.name || 'New employee')
                        .split(/\s+/)
                        .filter(Boolean)
                        .slice(0, 2)
                        .map((part) => part[0])
                        .join('')
                        .toUpperCase()}
                    </span>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() => setPhotoOpen(true)}
                      className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-300 px-2.5 py-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700"
                    >
                      <Camera className="h-3.5 w-3.5" />
                      {photo ? 'Change photo' : 'Upload photo'}
                    </button>
                  </div>
                </div>
                <div>
                  <label className={labelClass}>HRMS ID{isCreate ? ' *' : ''}</label>
                  <input
                    type="text"
                    disabled={!isCreate}
                    value={record.employeeCode}
                    onChange={(event) =>
                      setRecord({ ...record, employeeCode: event.target.value.toUpperCase() })
                    }
                    placeholder="EMP-0001"
                    className={`${inputClass} font-mono`}
                  />
                </div>
                <div>
                  <label className={labelClass}>Full name{isCreate ? ' *' : ''}</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={record.name}
                    onChange={(event) => setRecord({ ...record, name: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Branch *</label>
                  {!isCreate || readOnly ? (
                    <>
                      <input
                        type="text"
                        disabled
                        value={branchName || record.branchId}
                        className={inputClass}
                      />
                      {!isCreate && canManage ? (
                        <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                          Use Transfer in the Employee Directory to move this employee; the
                          destination, effective date and reason are recorded together.
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <select
                      value={record.branchId}
                      onChange={(event) => setRecord({ ...record, branchId: event.target.value })}
                      className={inputClass}
                    >
                      <option value="">Select branch</option>
                      {branches.map((branch) => (
                        <option key={branch.id} value={branch.id}>
                          {branch.name}
                        </option>
                      ))}
                      {record.branchId && !branches.some((branch) => branch.id === record.branchId) ? (
                        <option value={record.branchId}>
                          {branchName || record.branchId} — not in Branch Management
                        </option>
                      ) : null}
                    </select>
                  )}
                </div>
                <div>
                  <label className={labelClass}>Monthly salary (reference)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    disabled={readOnly}
                    value={record.monthlySalary}
                    onChange={(event) =>
                      setRecord({ ...record, monthlySalary: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className={labelClass}>Linked login account</label>
                  <select
                    disabled={readOnly || userOptions.length === 0}
                    value={record.userId}
                    onChange={(event) => setRecord({ ...record, userId: event.target.value })}
                    className={inputClass}
                  >
                    <option value="">Not linked</option>
                    {userOptions.map((option) => (
                      <option
                        key={option.id}
                        value={option.id}
                        disabled={option.linked && option.id !== record.userId}
                      >
                        {option.name} — {option.email}
                        {option.linked && option.id !== record.userId ? ' (already linked)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col justify-end gap-1 pb-1">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={record.ssfEligible}
                      onChange={(event) =>
                        setRecord({ ...record, ssfEligible: event.target.checked })
                      }
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                    />
                    <span className="font-semibold">SSF eligible</span>
                  </label>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={record.isActive}
                      onChange={(event) =>
                        setRecord({ ...record, isActive: event.target.checked })
                      }
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                    />
                    <span className="font-semibold">Active employee</span>
                  </label>
                </div>
                {!readOnly && !createdLogin ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 sm:col-span-3 dark:border-slate-700 dark:bg-slate-900/40">
                    {record.userId ? (
                      canEditLinkedRole ? (
                        <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-3">
                          <div>
                            <label className={labelClass}>Login role</label>
                            <select
                              value={loginRole}
                              onChange={(event) => setLoginRole(event.target.value)}
                              className={inputClass}
                            >
                              {HR_LOGIN_ROLES.map((role) => (
                                <option key={role} value={role}>
                                  {APP_ROLE_LABELS[role] || role.replace(/_/g, ' ')}
                                </option>
                              ))}
                            </select>
                          </div>
                          <p className="text-[11px] text-slate-500 sm:col-span-2 dark:text-slate-400">
                            {linkedLogin ? `${linkedLogin.name} · ${linkedLogin.email}. ` : ''}
                            This role saves with the employee. Administrator roles cannot be
                            assigned from here.
                          </p>
                        </div>
                      ) : (
                        <p className="text-[11px] text-slate-600 dark:text-slate-300">
                          {linkedLogin ? `${linkedLogin.name} · ${linkedLogin.email}` : 'Linked login'} —{' '}
                          <span className="font-semibold">
                            {linkedLogin
                              ? APP_ROLE_LABELS[linkedLogin.role] || linkedLogin.role.replace(/_/g, ' ')
                              : 'unknown role'}
                          </span>
                          . This is an administrator account, so its role is not editable from the
                          employee record.
                        </p>
                      )
                    ) : (
                      <>
                        <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold">
                          <input
                            type="checkbox"
                            checked={createLogin}
                            onChange={(event) => setCreateLogin(event.target.checked)}
                            className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                          />
                          Create a login for this employee
                        </label>
                        {createLogin ? (
                          <div className="mt-2 grid grid-cols-1 items-end gap-2 sm:grid-cols-3">
                            <div>
                              <label className={labelClass}>Login role</label>
                              <select
                                value={loginRole}
                                onChange={(event) => setLoginRole(event.target.value)}
                                className={inputClass}
                              >
                                {HR_LOGIN_ROLES.map((role) => (
                                  <option key={role} value={role}>
                                    {APP_ROLE_LABELS[role] || role.replace(/_/g, ' ')}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <p className="text-[11px] text-slate-500 sm:col-span-2 dark:text-slate-400">
                              The internal (or personal) e-mail becomes the username. The one-time
                              password is shown once after saving; the employee must replace it at
                              first sign-in.
                            </p>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <label className={labelClass}>Department</label>
                    {canManage ? (
                      <button
                        type="button"
                        onClick={() => startAddingMaster('DEPARTMENT')}
                        className="flex cursor-pointer items-center gap-0.5 text-[10px] font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                      >
                        <Plus className="h-3 w-3" /> New
                      </button>
                    ) : null}
                  </div>
                  <select
                    aria-label="Department"
                    disabled={readOnly}
                    value={record.department}
                    onChange={(event) => setRecord({ ...record, department: event.target.value })}
                    className={inputClass}
                  >
                    {orgSelectOptions('DEPARTMENT', record.department)}
                  </select>
                  {addingKind === 'DEPARTMENT' ? renderAdder() : null}
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <label className={labelClass}>Designation</label>
                    {canManage ? (
                      <button
                        type="button"
                        onClick={() => startAddingMaster('DESIGNATION')}
                        className="flex cursor-pointer items-center gap-0.5 text-[10px] font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                      >
                        <Plus className="h-3 w-3" /> New
                      </button>
                    ) : null}
                  </div>
                  <select
                    aria-label="Designation"
                    disabled={readOnly}
                    value={record.designation}
                    onChange={(event) => {
                      const name = event.target.value;
                      const master = orgList('DESIGNATION').find((row) => row.name === name);
                      setRecord({
                        ...record,
                        designation: name,
                        // The code travels with the master so the server always
                        // resolves its id; a legacy value keeps its own code.
                        designationCode:
                          name === '' ? '' : master ? master.code || '' : record.designationCode,
                      });
                    }}
                    className={inputClass}
                  >
                    {orgSelectOptions('DESIGNATION', record.designation)}
                  </select>
                  {addingKind === 'DESIGNATION' ? renderAdder() : null}
                </div>
                <div>
                  <label className={labelClass}>
                    Designation code
                    {designationMaster ? (
                      <span className="ml-1 font-normal text-slate-400">from catalogue</span>
                    ) : null}
                  </label>
                  <input
                    type="text"
                    disabled={readOnly}
                    readOnly={Boolean(designationMaster)}
                    title={
                      designationMaster
                        ? 'Set by the selected catalogue designation'
                        : undefined
                    }
                    value={record.designationCode}
                    onChange={(event) =>
                      setRecord({ ...record, designationCode: event.target.value })
                    }
                    className={`${inputClass}${
                      designationMaster ? ' cursor-not-allowed opacity-60' : ''
                    }`}
                  />
                </div>
                <div>
                  <label className={labelClass}>Employment type</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={record.employmentType}
                    onChange={(event) =>
                      setRecord({ ...record, employmentType: event.target.value })
                    }
                    placeholder="Non-PB"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Joining date (AD)</label>
                  <input
                    type="date"
                    disabled={readOnly}
                    value={record.joiningDateAD}
                    onChange={(event) => setRecord({ ...record, joiningDateAD: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Date of birth (AD)</label>
                  <input
                    type="date"
                    disabled={readOnly}
                    value={record.dateOfBirthAD}
                    onChange={(event) => setRecord({ ...record, dateOfBirthAD: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Contract expiry (AD)</label>
                  <input
                    type="date"
                    disabled={readOnly}
                    value={record.contractExpiryAD}
                    onChange={(event) =>
                      setRecord({ ...record, contractExpiryAD: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Separation date (AD)</label>
                  <input
                    type="date"
                    disabled={readOnly}
                    value={record.separationDateAD}
                    onChange={(event) =>
                      setRecord({ ...record, separationDateAD: event.target.value })
                    }
                    className={inputClass}
                  />
                  <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                    A separation date that has already arrived deactivates the employee and disables their
                    login.
                  </p>
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <label className={labelClass}>Work station</label>
                    {canManage ? (
                      <button
                        type="button"
                        onClick={() => startAddingMaster('WORK_STATION')}
                        className="flex cursor-pointer items-center gap-0.5 text-[10px] font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                      >
                        <Plus className="h-3 w-3" /> New
                      </button>
                    ) : null}
                  </div>
                  <select
                    aria-label="Work station"
                    disabled={readOnly}
                    value={record.workStation}
                    onChange={(event) => setRecord({ ...record, workStation: event.target.value })}
                    className={inputClass}
                  >
                    {orgSelectOptions('WORK_STATION', record.workStation)}
                  </select>
                  {addingKind === 'WORK_STATION' ? renderAdder() : null}
                </div>
                <div>
                  <label className={labelClass}>Personal contact</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={record.personalContact}
                    onChange={(event) =>
                      setRecord({ ...record, personalContact: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Emergency contact person</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={record.emergencyContactPerson}
                    onChange={(event) =>
                      setRecord({ ...record, emergencyContactPerson: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Emergency contact number</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={record.emergencyContactNumber}
                    onChange={(event) =>
                      setRecord({ ...record, emergencyContactNumber: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Internal e-mail</label>
                  <input
                    type="email"
                    disabled={readOnly}
                    value={record.internalEmail}
                    onChange={(event) => setRecord({ ...record, internalEmail: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Personal e-mail</label>
                  <input
                    type="email"
                    disabled={readOnly}
                    value={record.personalEmail}
                    onChange={(event) => setRecord({ ...record, personalEmail: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div className="sm:col-span-3">
                  <label className={labelClass}>Address</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={record.address}
                    onChange={(event) => setRecord({ ...record, address: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>PAN</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={record.panNumber}
                    onChange={(event) => setRecord({ ...record, panNumber: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>SSF number</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={record.ssfNumber}
                    onChange={(event) => setRecord({ ...record, ssfNumber: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Bank name</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={record.bankName}
                    onChange={(event) => setRecord({ ...record, bankName: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Bank account</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={record.bankAccount}
                    onChange={(event) => setRecord({ ...record, bankAccount: event.target.value })}
                    className={inputClass}
                  />
                </div>
              </div>
            </Section>

            {!isCreate ? (
              <Section
                title="Branch transfer history"
                hint="Where this employee has been posted. Moves are requested through the transfer process and recorded only after manager approval."
              >
                {branchTransfers.length === 0 ? (
                  <p className="rounded-xl border border-slate-200 px-3 py-2 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
                    No branch transfers recorded. The current branch is the employee's first posting
                    in this history.
                  </p>
                ) : (
                  <ol className="space-y-2">
                    {branchTransfers.map((transfer) => (
                      <li
                        key={transfer.id}
                        className="rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-700"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="flex flex-wrap items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
                            {transfer.fromBranchName} → {transfer.toBranchName}
                            <span
                              className={`rounded-full border px-1.5 py-0.5 text-[9px] font-bold ${
                                transfer.status === 'PENDING'
                                  ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300'
                                  : transfer.status === 'APPROVED'
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300'
                                    : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300'
                              }`}
                            >
                              {transfer.status}
                            </span>
                          </span>
                          <span className="text-[10px] text-slate-500 dark:text-slate-400">
                            {transfer.effectiveDateAD
                              ? `${transfer.effectiveDateAD} · effective`
                              : formatTransferDate(transfer.createdAt)}
                          </span>
                        </div>
                        {transfer.reason ? (
                          <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-300">
                            {transfer.reason}
                          </p>
                        ) : null}
                        <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                          Requested by {transfer.transferredBy || 'System'} ·{' '}
                          {formatTransferDate(transfer.createdAt)}
                        </p>
                        {transfer.status !== 'PENDING' ? (
                          <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                            {transfer.approvedBy
                              ? `${transfer.status === 'APPROVED' ? 'Approved' : 'Rejected'} by ${transfer.approvedBy}`
                              : 'Recorded before the approval workflow'}
                            {transfer.decisionNote ? ` · ${transfer.decisionNote}` : ''}
                          </p>
                        ) : (
                          <p className="mt-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                            Awaiting manager approval; the employee has not moved yet.
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </Section>
            ) : null}

            <Section title="Personal details">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className={labelClass}>Father's name</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={scalars.fatherName}
                    onChange={(event) => setScalars({ ...scalars, fatherName: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Grandfather's name</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={scalars.grandfatherName}
                    onChange={(event) =>
                      setScalars({ ...scalars, grandfatherName: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Blood group</label>
                  <select
                    disabled={readOnly}
                    value={scalars.bloodGroup}
                    onChange={(event) => setScalars({ ...scalars, bloodGroup: event.target.value })}
                    className={inputClass}
                  >
                    <option value="">Not recorded</option>
                    {HR_BLOOD_GROUPS.map((group) => (
                      <option key={group} value={group}>
                        {group}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-3">
                  <label className={labelClass}>Permanent address</label>
                  <textarea
                    rows={2}
                    disabled={readOnly}
                    value={scalars.permanentAddress}
                    onChange={(event) =>
                      setScalars({ ...scalars, permanentAddress: event.target.value })
                    }
                    className={areaClass}
                  />
                </div>
                <div className="sm:col-span-3">
                  <label className={labelClass}>Local address</label>
                  <textarea
                    rows={2}
                    disabled={readOnly}
                    value={scalars.localAddress}
                    onChange={(event) => setScalars({ ...scalars, localAddress: event.target.value })}
                    className={areaClass}
                  />
                </div>
              </div>
            </Section>

            <Section
              title="In case of emergency (I.C.E.)"
              hint="The contact person and number are on the employee master form."
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className={labelClass}>Relation</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={scalars.emergencyContactRelation}
                    onChange={(event) =>
                      setScalars({ ...scalars, emergencyContactRelation: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className={labelClass}>Address</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={scalars.emergencyContactAddress}
                    onChange={(event) =>
                      setScalars({ ...scalars, emergencyContactAddress: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
              </div>
            </Section>

            <Section title="Family details">
              <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                <table className="w-full min-w-[620px] text-left text-xs">
                  <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-900/40">
                    <tr>
                      <th className="px-2 py-1.5 font-semibold">Member</th>
                      <th className="px-2 py-1.5 font-semibold">Age</th>
                      <th className="px-2 py-1.5 font-semibold">Occupation</th>
                      <th className="px-2 py-1.5 font-semibold">Relation</th>
                      <th className="px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {family.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-2 py-3 text-center text-slate-400">
                          No family members recorded.
                        </td>
                      </tr>
                    ) : (
                      family.map((row, index) => (
                        <tr key={row.key}>
                          <td className="px-2 py-1.5">
                            <input
                              type="text"
                              disabled={readOnly}
                              value={row.name}
                              onChange={(event) =>
                                setFamily(
                                  family.map((item, i) =>
                                    i === index ? { ...item, name: event.target.value } : item
                                  )
                                )
                              }
                              className={inputClass}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              min={0}
                              max={150}
                              disabled={readOnly}
                              value={row.age}
                              onChange={(event) =>
                                setFamily(
                                  family.map((item, i) =>
                                    i === index ? { ...item, age: event.target.value } : item
                                  )
                                )
                              }
                              className={inputClass}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="text"
                              disabled={readOnly}
                              value={row.occupation}
                              onChange={(event) =>
                                setFamily(
                                  family.map((item, i) =>
                                    i === index ? { ...item, occupation: event.target.value } : item
                                  )
                                )
                              }
                              className={inputClass}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="text"
                              disabled={readOnly}
                              value={row.relation}
                              onChange={(event) =>
                                setFamily(
                                  family.map((item, i) =>
                                    i === index ? { ...item, relation: event.target.value } : item
                                  )
                                )
                              }
                              className={inputClass}
                            />
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            {readOnly ? null : (
                              <button
                                type="button"
                                onClick={() => setFamily(family.filter((_, i) => i !== index))}
                                title="Remove this family member"
                                className="cursor-pointer rounded-lg p-1 text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {readOnly ? null : (
                <button
                  type="button"
                  onClick={() => setFamily([...family, blankFamily()])}
                  disabled={atLimit(family.length, HR_PROFILE_MAX_ROWS.familyMembers)}
                  className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-300 px-2.5 py-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700"
                >
                  <Plus className="h-3.5 w-3.5" /> Add family member
                </button>
              )}
            </Section>

            <Section title="Experience" hint="The form asks for a separate project list; attach it under Documents.">
              <div className="space-y-2">
                {experience.length === 0 ? (
                  <p className="text-slate-400">No experience recorded.</p>
                ) : (
                  experience.map((row, index) => (
                    <div
                      key={row.key}
                      className="grid grid-cols-1 gap-2 rounded-xl border border-slate-200 p-2 sm:grid-cols-6 dark:border-slate-800"
                    >
                      <div className="sm:col-span-2">
                        <label className={labelClass}>Organisation</label>
                        <input
                          type="text"
                          disabled={readOnly}
                          value={row.organization}
                          onChange={(event) =>
                            setExperience(
                              experience.map((item, i) =>
                                i === index ? { ...item, organization: event.target.value } : item
                              )
                            )
                          }
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>From (AD)</label>
                        <input
                          type="date"
                          disabled={readOnly}
                          value={row.fromAD}
                          onChange={(event) =>
                            setExperience(
                              experience.map((item, i) =>
                                i === index ? { ...item, fromAD: event.target.value } : item
                              )
                            )
                          }
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>To (AD)</label>
                        <input
                          type="date"
                          disabled={readOnly}
                          value={row.toAD}
                          onChange={(event) =>
                            setExperience(
                              experience.map((item, i) =>
                                i === index ? { ...item, toAD: event.target.value } : item
                              )
                            )
                          }
                          className={inputClass}
                        />
                      </div>
                      <div className="sm:col-span-1">
                        <label className={labelClass}>Designation</label>
                        <input
                          type="text"
                          disabled={readOnly}
                          value={row.designation}
                          onChange={(event) =>
                            setExperience(
                              experience.map((item, i) =>
                                i === index ? { ...item, designation: event.target.value } : item
                              )
                            )
                          }
                          className={inputClass}
                        />
                      </div>
                      <div className="flex items-end justify-end">
                        {readOnly ? null : (
                          <button
                            type="button"
                            onClick={() => setExperience(experience.filter((_, i) => i !== index))}
                            title="Remove this experience"
                            className="cursor-pointer rounded-lg p-2 text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
              {readOnly ? null : (
                <button
                  type="button"
                  onClick={() => setExperience([...experience, blankExperience()])}
                  disabled={atLimit(experience.length, HR_PROFILE_MAX_ROWS.experience)}
                  className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-300 px-2.5 py-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700"
                >
                  <Plus className="h-3.5 w-3.5" /> Add experience
                </button>
              )}
            </Section>

            <Section title="Qualifications">
              <div className="space-y-2">
                {qualifications.length === 0 ? (
                  <p className="text-slate-400">No qualifications recorded.</p>
                ) : (
                  qualifications.map((row, index) => (
                    <div
                      key={row.key}
                      className="grid grid-cols-1 gap-2 rounded-xl border border-slate-200 p-2 sm:grid-cols-5 dark:border-slate-800"
                    >
                      <div className="sm:col-span-2">
                        <label className={labelClass}>Exam passed</label>
                        <input
                          type="text"
                          disabled={readOnly}
                          value={row.examPassed}
                          onChange={(event) =>
                            setQualifications(
                              qualifications.map((item, i) =>
                                i === index ? { ...item, examPassed: event.target.value } : item
                              )
                            )
                          }
                          className={inputClass}
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className={labelClass}>Board / university</label>
                        <input
                          type="text"
                          disabled={readOnly}
                          value={row.boardUniversity}
                          onChange={(event) =>
                            setQualifications(
                              qualifications.map((item, i) =>
                                i === index ? { ...item, boardUniversity: event.target.value } : item
                              )
                            )
                          }
                          className={inputClass}
                        />
                      </div>
                      <div className="flex items-end gap-1">
                        <div className="flex-1">
                          <label className={labelClass}>%</label>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            disabled={readOnly}
                            value={row.percentage}
                            onChange={(event) =>
                              setQualifications(
                                qualifications.map((item, i) =>
                                  i === index ? { ...item, percentage: event.target.value } : item
                                )
                              )
                            }
                            className={inputClass}
                          />
                        </div>
                        {readOnly ? null : (
                          <button
                            type="button"
                            onClick={() =>
                              setQualifications(qualifications.filter((_, i) => i !== index))
                            }
                            title="Remove this qualification"
                            className="cursor-pointer rounded-lg p-2 text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
              {readOnly ? null : (
                <button
                  type="button"
                  onClick={() => setQualifications([...qualifications, blankQualification()])}
                  disabled={atLimit(qualifications.length, HR_PROFILE_MAX_ROWS.qualifications)}
                  className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-300 px-2.5 py-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700"
                >
                  <Plus className="h-3.5 w-3.5" /> Add qualification
                </button>
              )}
            </Section>

            <Section title="Medical history">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className={labelClass}>Disease (if any)</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={scalars.medicalConditions}
                    onChange={(event) =>
                      setScalars({ ...scalars, medicalConditions: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className={labelClass}>Details</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={scalars.medicalDetails}
                    onChange={(event) =>
                      setScalars({ ...scalars, medicalDetails: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
              </div>
            </Section>

            <Section title="Other information">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Accident (if any) — details</label>
                  <textarea
                    rows={2}
                    disabled={readOnly}
                    value={scalars.accidentDetails}
                    onChange={(event) =>
                      setScalars({ ...scalars, accidentDetails: event.target.value })
                    }
                    className={areaClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Suit / case filed — details</label>
                  <textarea
                    rows={2}
                    disabled={readOnly}
                    value={scalars.caseDetails}
                    onChange={(event) => setScalars({ ...scalars, caseDetails: event.target.value })}
                    className={areaClass}
                  />
                </div>
              </div>
            </Section>

            <Section title="Official references">
              <div className="space-y-2">
                {references.length === 0 ? (
                  <p className="text-slate-400">No references recorded.</p>
                ) : (
                  references.map((row, index) => (
                    <div
                      key={row.key}
                      className="grid grid-cols-1 gap-2 rounded-xl border border-slate-200 p-2 sm:grid-cols-5 dark:border-slate-800"
                    >
                      <div>
                        <label className={labelClass}>Name</label>
                        <input
                          type="text"
                          disabled={readOnly}
                          value={row.name}
                          onChange={(event) =>
                            setReferences(
                              references.map((item, i) =>
                                i === index ? { ...item, name: event.target.value } : item
                              )
                            )
                          }
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>Organisation</label>
                        <input
                          type="text"
                          disabled={readOnly}
                          value={row.organization}
                          onChange={(event) =>
                            setReferences(
                              references.map((item, i) =>
                                i === index ? { ...item, organization: event.target.value } : item
                              )
                            )
                          }
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>Contact</label>
                        <input
                          type="text"
                          disabled={readOnly}
                          value={row.contact}
                          onChange={(event) =>
                            setReferences(
                              references.map((item, i) =>
                                i === index ? { ...item, contact: event.target.value } : item
                              )
                            )
                          }
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>Relation</label>
                        <input
                          type="text"
                          disabled={readOnly}
                          value={row.relation}
                          onChange={(event) =>
                            setReferences(
                              references.map((item, i) =>
                                i === index ? { ...item, relation: event.target.value } : item
                              )
                            )
                          }
                          className={inputClass}
                        />
                      </div>
                      <div className="flex items-end justify-end">
                        {readOnly ? null : (
                          <button
                            type="button"
                            onClick={() => setReferences(references.filter((_, i) => i !== index))}
                            title="Remove this reference"
                            className="cursor-pointer rounded-lg p-2 text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
              {readOnly ? null : (
                <button
                  type="button"
                  onClick={() => setReferences([...references, blankReference()])}
                  disabled={atLimit(references.length, HR_PROFILE_MAX_ROWS.references)}
                  className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-300 px-2.5 py-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700"
                >
                  <Plus className="h-3.5 w-3.5" /> Add reference
                </button>
              )}
            </Section>

            <Section
              title="Declaration"
              hint="The employee declares the information above is true; the signature itself stays on the paper form."
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className={labelClass}>Declaration date (AD)</label>
                  <input
                    type="date"
                    disabled={readOnly}
                    value={scalars.declarationDateAD}
                    onChange={(event) =>
                      setScalars({ ...scalars, declarationDateAD: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className={labelClass}>Declared by (typed signature)</label>
                  <input
                    type="text"
                    disabled={readOnly}
                    value={scalars.declarationName}
                    onChange={(event) =>
                      setScalars({ ...scalars, declarationName: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
              </div>
            </Section>

            {createdLogin ? (
              <div className="rounded-xl border border-emerald-300 bg-emerald-50/70 px-3 py-2 text-[11px] text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
                <p className="font-bold">Login created for {createdLogin.email}</p>
                <p className="mt-0.5">
                  One-time password:{' '}
                  <span className="font-mono text-sm font-bold">{createdLogin.temporaryPassword}</span>
                </p>
                <p className="mt-0.5">
                  Hand it over now — it is not shown again. The employee must set a new
                  password at first sign-in.
                </p>
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
              {savedNote ? <span className="text-[11px] text-emerald-600">{savedNote}</span> : null}
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {readOnly || createdLogin ? 'Close' : 'Cancel'}
              </button>
              {readOnly || createdLogin ? null : (
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="cursor-pointer rounded-xl bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? 'Saving…' : isCreate ? 'Create employee' : 'Save profile'}
                </button>
              )}
            </div>
          </div>
        )}
      </ModalPanel>

      {photoOpen ? (
        <EmployeeSelfServicePhotoDialog
          photo={photo}
          employeeName={record.name || 'New employee'}
          onClose={() => setPhotoOpen(false)}
          onSave={handlePhotoSave}
        />
      ) : null}
    </div>
  );
};
