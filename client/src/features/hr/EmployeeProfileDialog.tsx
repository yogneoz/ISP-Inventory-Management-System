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
import { Plus, Trash2, X } from 'lucide-react';
import { ModalPanel } from '../../components/common/ModalPanel';
import { useDialog } from '../../components/common/DialogProvider';
import { api } from '../../services/api';
import type {
  EmployeeRecord,
  HrEmployeeProfileInput,
  HrEmployeeProfileResponse,
} from '../../services/api';
import { HR_BLOOD_GROUPS, HR_PROFILE_MAX_ROWS } from '../../services/api/hr';

interface EmployeeProfileDialogProps {
  employee: EmployeeRecord;
  canManage: boolean;
  onClose: () => void;
}

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
}) => {
  const { alert: alertDialog } = useDialog();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [masked, setMasked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState('');
  const [scalars, setScalars] = useState<ScalarDraft>(EMPTY_SCALARS);
  const [family, setFamily] = useState<FamilyDraft[]>([]);
  const [experience, setExperience] = useState<ExperienceDraft[]>([]);
  const [qualifications, setQualifications] = useState<QualificationDraft[]>([]);
  const [references, setReferences] = useState<ReferenceDraft[]>([]);

  const readOnly = !canManage || masked;

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
  };

  const load = async () => {
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
  }, [employee.id]);

  const handleSave = async () => {
    setSavedNote('');
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
      const saved = await api.saveEmployeeProfile(employee.id, payload, employee.branchId);
      applyResponse(saved);
      setSavedNote('Profile saved.');
    } catch (err: any) {
      alertDialog(`Failed to save the profile: ${err?.message || 'Database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const atLimit = (count: number, max: number): boolean => count >= max;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <ModalPanel
        label={`F1 Profile — ${employee.name}`}
        onClose={onClose}
        className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold">F1 Employee Profile</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {employee.name} · <span className="font-mono">{employee.employeeCode}</span> · F1
              Employee Detail Form
            </p>
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
        ) : loadError ? (
          <div className="space-y-3 py-6 text-center">
            <p className="text-xs text-rose-600 dark:text-rose-400">{loadError}</p>
            <button
              onClick={() => void load()}
              className="cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold dark:border-slate-700"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="space-y-6 text-xs">
            {masked ? (
              <p className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
                Your role can read the employee master but not its personal profile. Ask an HR
                manager for the F1 details.
              </p>
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

            <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
              {savedNote ? <span className="text-[11px] text-emerald-600">{savedNote}</span> : null}
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {readOnly ? 'Close' : 'Cancel'}
              </button>
              {readOnly ? null : (
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="cursor-pointer rounded-xl bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? 'Saving…' : 'Save profile'}
                </button>
              )}
            </div>
          </div>
        )}
      </ModalPanel>
    </div>
  );
};
