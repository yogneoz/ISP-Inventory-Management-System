/**
 * Employee Directory — the HR master read/write screen.
 *
 * Fields follow the business's Employee Master Sheet: HRMS ID (employee code),
 * name, employment type, joining/DOB/contract dates, designation + code,
 * department, work station, contacts, e-mails, bank details, salary reference
 * and SSF eligibility. Payroll itself stays in Finance; this screen owns the
 * people records that payroll and asset assignment read.
 *
 * Master dates are AD-only on purpose: the sheet's joining/DOB/contract dates
 * predate the seeded BS calendar, so a required BS value would reject history.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Briefcase,
  Building2,
  CalendarDays,
  ClipboardList,
  Edit2,
  FileText,
  Landmark,
  Link2,
  Mail,
  Phone,
  Plus,
  Shield,
  UploadCloud,
  Users,
  X,
} from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import { FilterCard } from '../../components/common/FilterCard';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { ModalPanel } from '../../components/common/ModalPanel';
import { PageHeader } from '../../components/common/PageHeader';
import { api } from '../../services/api';
import type {
  EmployeeRecord,
  EmployeeUserOption,
  HrOrgMasterKind,
  HrOrgMasterRecord,
} from '../../services/api';
import { isOperationAllowed } from '../../utils/permissions';
import type { Branch, User } from '../../types';
import { EmployeeDocumentsDialog } from './EmployeeDocumentsDialog';
import { EmployeeProfileDialog } from './EmployeeProfileDialog';
import { EmployeeImportDialog } from './EmployeeImportDialog';

interface EmployeeDirectoryProps {
  currentUser: User | null;
  branches: Branch[];
  selectedBranchId?: string;
}

interface EmployeeForm {
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

const EMPTY_FORM: EmployeeForm = {
  employeeCode: '',
  name: '',
  branchId: '',
  userId: '',
  department: '',
  designation: '',
  designationCode: '',
  employmentType: '',
  joiningDateAD: '',
  dateOfBirthAD: '',
  contractExpiryAD: '',
  separationDateAD: '',
  workStation: '',
  address: '',
  personalContact: '',
  emergencyContactPerson: '',
  emergencyContactNumber: '',
  internalEmail: '',
  personalEmail: '',
  panNumber: '',
  ssfNumber: '',
  ssfEligible: false,
  bankName: '',
  bankAccount: '',
  monthlySalary: '',
  isActive: true,
};

const EMPLOYMENT_TYPES = ['Non-PB', 'Probation', 'Contract', 'Part-Time', 'Intern'];

const formatMoney = (value: string | number | null): string => {
  if (value === null || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('en-NP', { maximumFractionDigits: 0 }).format(amount);
};

export const EmployeeDirectory: React.FC<EmployeeDirectoryProps> = ({
  currentUser,
  branches,
  selectedBranchId = 'ALL',
}) => {
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const activationKey = useActivationKey('employees');
  const canManage =
    isOperationAllowed('hr-employee-manage', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);
  const canView =
    isOperationAllowed('hr-employee-view', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);

  const initialBranch =
    selectedBranchId && selectedBranchId !== 'ALL'
      ? selectedBranchId
      : currentUser?.branchId && currentUser.branchId !== 'ALL'
        ? currentUser.branchId
        : 'ALL';

  const [employees, setEmployees] = useState<EmployeeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [branchFilter, setBranchFilter] = useState(initialBranch);
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<EmployeeRecord | null>(null);
  const [form, setForm] = useState<EmployeeForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [userOptions, setUserOptions] = useState<EmployeeUserOption[]>([]);
  const [orgMasters, setOrgMasters] = useState<HrOrgMasterRecord[]>([]);
  const [documentsFor, setDocumentsFor] = useState<EmployeeRecord | null>(null);
  const [profileFor, setProfileFor] = useState<EmployeeRecord | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const loadEmployees = async () => {
    setLoading(true);
    try {
      const rows = await api.getEmployees({ branchId: branchFilter, query: search });
      setEmployees(Array.isArray(rows) ? rows : []);
      setLoadError('');
    } catch (err: any) {
      setLoadError(err?.message || 'The employee directory could not be read.');
    } finally {
      setLoading(false);
    }
  };

  const loadUserOptions = async () => {
    if (!canManage) return;
    try {
      const rows = await api.getEmployeeUserOptions();
      setUserOptions(Array.isArray(rows) ? rows : []);
    } catch {
      setUserOptions([]);
    }
  };

  const loadOrgMasters = async () => {
    try {
      const rows = await api.getHrOrgMasters({ activeOnly: true });
      setOrgMasters(Array.isArray(rows) ? rows : []);
    } catch {
      setOrgMasters([]);
    }
  };

  useEffect(() => {
    void loadEmployees();
    // Refetch on tab re-activation, branch switch and applied search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey, branchFilter, search]);

  useEffect(() => {
    void loadUserOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey, canManage]);

  useEffect(() => {
    void loadOrgMasters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey]);

  const branchLabel = (id?: string | null) =>
    id ? branches.find((branch) => branch.id === id)?.name || id : '—';

  const linkedUser = (userId?: string | null) =>
    userId ? userOptions.find((option) => option.id === userId) : undefined;

  const orgOptions = (kind: HrOrgMasterKind) =>
    orgMasters.filter((master) => master.kind === kind && master.isActive);

  const defaultBranchId = useMemo(() => {
    if (branchFilter !== 'ALL') return branchFilter;
    if (currentUser?.branchId && currentUser.branchId !== 'ALL') return currentUser.branchId;
    return branches.find((branch) => branch.isHeadquarters)?.id || branches[0]?.id || '';
  }, [branchFilter, branches, currentUser?.branchId]);

  const openCreate = () => {
    setEditing(null);
    void loadUserOptions();
    setForm({ ...EMPTY_FORM, branchId: defaultBranchId });
    setIsModalOpen(true);
  };

  const openEdit = (employee: EmployeeRecord) => {
    setEditing(employee);
    void loadUserOptions();
    setForm({
      employeeCode: employee.employeeCode,
      name: employee.name,
      branchId: employee.branchId,
      userId: employee.userId || '',
      department: employee.department || '',
      designation: employee.designation || '',
      designationCode: employee.designationCode || '',
      employmentType: employee.employmentType || '',
      joiningDateAD: employee.joiningDateAD || '',
      dateOfBirthAD: employee.dateOfBirthAD || '',
      contractExpiryAD: employee.contractExpiryAD || '',
      separationDateAD: employee.separationDateAD || '',
      workStation: employee.workStation || '',
      address: employee.address || '',
      personalContact: employee.personalContact || '',
      emergencyContactPerson: employee.emergencyContactPerson || '',
      emergencyContactNumber: employee.emergencyContactNumber || '',
      internalEmail: employee.internalEmail || '',
      personalEmail: employee.personalEmail || '',
      panNumber: employee.panNumber || '',
      ssfNumber: employee.ssfNumber || '',
      ssfEligible: employee.ssfEligible,
      bankName: employee.bankName || '',
      bankAccount: employee.bankAccount || '',
      monthlySalary: employee.monthlySalary === null ? '' : String(employee.monthlySalary),
      isActive: employee.isActive,
    });
    setIsModalOpen(true);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    const employeeCode = form.employeeCode.trim().toUpperCase();
    if (!name) {
      alertDialog('An employee name is required.');
      return;
    }
    if (!editing && !employeeCode) {
      alertDialog('An employee code (HRMS ID) is required.');
      return;
    }
    if (!editing && !form.branchId) {
      alertDialog('Choose the branch this employee belongs to.');
      return;
    }
    if (form.monthlySalary && Number(form.monthlySalary) < 0) {
      alertDialog('Monthly salary cannot be negative.');
      return;
    }
    if (
      form.joiningDateAD &&
      form.separationDateAD &&
      form.separationDateAD < form.joiningDateAD
    ) {
      alertDialog('Separation date must be on or after the joining date.');
      return;
    }

    const shared = {
      name,
      department: form.department.trim() || null,
      designation: form.designation.trim() || null,
      designationCode: form.designationCode.trim() || null,
      employmentType: form.employmentType.trim() || null,
      joiningDateAD: form.joiningDateAD || null,
      dateOfBirthAD: form.dateOfBirthAD || null,
      contractExpiryAD: form.contractExpiryAD || null,
      separationDateAD: form.separationDateAD || null,
      workStation: form.workStation.trim() || null,
      address: form.address.trim() || null,
      personalContact: form.personalContact.trim() || null,
      emergencyContactPerson: form.emergencyContactPerson.trim() || null,
      emergencyContactNumber: form.emergencyContactNumber.trim() || null,
      internalEmail: form.internalEmail.trim() || null,
      personalEmail: form.personalEmail.trim() || null,
      panNumber: form.panNumber.trim() || null,
      ssfNumber: form.ssfNumber.trim() || null,
      ssfEligible: form.ssfEligible,
      bankName: form.bankName.trim() || null,
      bankAccount: form.bankAccount.trim() || null,
      monthlySalary: form.monthlySalary === '' ? null : Number(form.monthlySalary),
      userId: form.userId || null,
      isActive: form.isActive,
    };

    setSaving(true);
    try {
      if (editing) {
        await api.updateEmployee(editing.id, shared);
      } else {
        await api.createEmployee({
          employeeCode,
          branchId: form.branchId,
          ...shared,
        });
      }
      setIsModalOpen(false);
      setEditing(null);
      await loadEmployees();
    } catch (err: any) {
      alertDialog(`Failed to save employee: ${err?.message || 'Database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (employee: EmployeeRecord) => {
    const next = !employee.isActive;
    if (
      !(await confirmDialog(
        next
          ? `Reactivate ${employee.name} (${employee.employeeCode})?`
          : `Deactivate ${employee.name} (${employee.employeeCode})? Payroll history is kept; the employee stops appearing in new runs.`
      ))
    ) {
      return;
    }
    try {
      await api.updateEmployee(employee.id, { isActive: next });
      await loadEmployees();
    } catch (err: any) {
      alertDialog(`Failed to update employee: ${err?.message || 'Database error'}`);
    }
  };

  if (!canView) {
    return (
      <div className="my-8 mx-auto max-w-2xl space-y-4 rounded-3xl border border-rose-200 bg-rose-50 p-10 text-center text-rose-900 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">
        <Shield className="mx-auto h-14 w-14 text-rose-500" />
        <h2 className="font-serif text-xl font-bold">Access Denied</h2>
        <p className="mx-auto max-w-md text-xs leading-relaxed opacity-90">
          You do not have the payroll/HR permission needed to read the employee directory.
        </p>
      </div>
    );
  }

  const inputClass =
    'h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 text-xs dark:border-slate-700';
  const labelClass = 'mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400';

  return (
    <div className="flex h-[calc(100vh-6.5rem)] flex-col space-y-4 overflow-hidden">
      <PageHeader
        title="Employee Directory"
        description={
          loadError && employees.length === 0
            ? 'Employee master unavailable — retry below'
            : `${employees.length} employee${employees.length === 1 ? '' : 's'} · HR master used by payroll and asset assignment`
        }
        icon={<Users className="h-5 w-5 text-indigo-500" />}
        actions={
          canManage ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setImportOpen(true)}
                className="flex cursor-pointer items-center gap-2 rounded-xl border border-indigo-200 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition-all hover:bg-indigo-50 dark:border-indigo-900/50 dark:text-indigo-300 dark:hover:bg-indigo-950/30"
              >
                <UploadCloud className="h-4 w-4" />
                <span>Import Master Sheet</span>
              </button>
              <button
                onClick={openCreate}
                className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md transition-all hover:bg-indigo-500"
              >
                <Plus className="h-4 w-4" />
                <span>Add Employee</span>
              </button>
            </div>
          ) : null
        }
      />

      <FilterCard
        searchPlaceholder="Search HRMS ID, name, PAN or SSF…"
        searchValue={search}
        onSearchApply={setSearch}
        hasActiveFilters={Boolean(search) || branchFilter !== 'ALL'}
        onClearAll={() => {
          setSearch('');
          setBranchFilter('ALL');
        }}
        filterChildren={
          <label className="block">
            <span className={labelClass}>Branch</span>
            <select
              value={branchFilter}
              onChange={(event) => setBranchFilter(event.target.value)}
              className="h-9 rounded-lg border border-slate-300 bg-transparent px-2.5 text-xs dark:border-slate-700"
            >
              <option value="ALL">All branches</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
        }
      />

      <LoadStateNotice
        subject="employees"
        loading={loading}
        error={loadError}
        hasCachedRows={employees.length > 0}
        onRetry={loadEmployees}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-md dark:border-slate-800 dark:bg-[#0f1218]">
        <div className="relative min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-20 border-b border-slate-200 bg-slate-100 text-[10px] font-bold tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
              <tr>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">HRMS ID</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Employee</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Designation</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Branch / Station</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Type</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Joined</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5">Contact</th>
                {canManage ? (
                  <th className="sticky top-0 bg-inherit px-2.5 py-1.5 text-right">Salary</th>
                ) : null}
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5 text-center">Status</th>
                <th className="sticky top-0 bg-inherit px-2.5 py-1.5 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {employees.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 10 : 9} className="p-6 text-center text-slate-500">
                    {loading
                      ? 'Loading employees…'
                      : loadError
                        ? 'The employee directory could not be loaded — use Retry above.'
                        : search || branchFilter !== 'ALL'
                          ? 'No employees match the current search and branch filter.'
                          : 'No employees have been added yet.'}
                  </td>
                </tr>
              ) : (
                employees.map((employee) => (
                  <tr
                    key={employee.id}
                    className="transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40"
                  >
                    <td className="px-2.5 py-1.5 font-mono font-bold text-indigo-600 dark:text-indigo-400">
                      {employee.employeeCode}
                    </td>
                    <td className="px-2.5 py-1.5 font-bold text-slate-900 dark:text-white">
                      <div className="flex items-center gap-1.5">
                        <Users className="h-3.5 w-3.5 text-slate-400" />
                        <span>{employee.name}</span>
                      </div>
                      {employee.department ? (
                        <p className="mt-0.5 text-[10px] font-normal text-slate-500">{employee.department}</p>
                      ) : null}
                      {employee.userId ? (
                        <p className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-normal text-slate-400">
                          <Link2 className="h-3 w-3" />
                          {linkedUser(employee.userId)?.email || 'Linked account'}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      <div className="flex items-center gap-1">
                        <Briefcase className="h-3 w-3 text-slate-400" />
                        <span>{employee.designation || '—'}</span>
                      </div>
                      {employee.designationCode ? (
                        <p className="mt-0.5 text-[10px] text-slate-400">{employee.designationCode}</p>
                      ) : null}
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        <Building2 className="h-3 w-3 text-slate-400" />
                        {branchLabel(employee.branchId)}
                      </span>
                      {employee.workStation ? (
                        <p className="mt-0.5 text-[10px] text-slate-400">{employee.workStation}</p>
                      ) : null}
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      {employee.employmentType || '—'}
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays className="h-3 w-3 text-slate-400" />
                        {employee.joiningDateAD || '—'}
                      </span>
                      {employee.separationDateAD ? (
                        <p className="mt-0.5 text-[10px] text-slate-400">
                          Left {employee.separationDateAD}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">
                      {employee.personalContact ? (
                        <span className="inline-flex items-center gap-1">
                          <Phone className="h-3 w-3 text-slate-400" />
                          {employee.personalContact}
                        </span>
                      ) : (
                        '—'
                      )}
                      {employee.internalEmail ? (
                        <p className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-slate-400">
                          <Mail className="h-3 w-3" />
                          {employee.internalEmail}
                        </p>
                      ) : null}
                    </td>
                    {canManage ? (
                      <td className="px-2.5 py-1.5 text-right font-semibold text-slate-700 dark:text-slate-300">
                        {formatMoney(employee.monthlySalary)}
                      </td>
                    ) : null}
                    <td className="px-2.5 py-1.5 text-center">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                          employee.isActive
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                            : 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                        }`}
                      >
                        {employee.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => setProfileFor(employee)}
                          title={`F1 profile for ${employee.name}`}
                          className="cursor-pointer rounded-lg p-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          <ClipboardList className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setDocumentsFor(employee)}
                          title={`Documents for ${employee.name}`}
                          className="cursor-pointer rounded-lg p-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          <FileText className="h-3.5 w-3.5" />
                        </button>
                        {canManage ? (
                          <>
                            <button
                              onClick={() => openEdit(employee)}
                              title={`Edit ${employee.name}`}
                              className="cursor-pointer rounded-lg p-1 text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleToggleActive(employee)}
                              title={employee.isActive ? `Deactivate ${employee.name}` : `Reactivate ${employee.name}`}
                              className={`cursor-pointer rounded-lg px-1.5 py-1 text-[10px] font-bold ${
                                employee.isActive
                                  ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40'
                                  : 'text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40'
                              }`}
                            >
                              {employee.isActive ? 'Deactivate' : 'Reactivate'}
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={editing ? 'Edit Employee' : 'Add Employee'}
            onClose={() => setIsModalOpen(false)}
            className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-bold">{editing ? 'Edit Employee' : 'Add Employee'}</h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5 text-xs">
              <section className="space-y-3">
                <h4 className="border-b border-slate-100 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:border-slate-800">
                  Identity & employment
                </h4>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label className={labelClass}>HRMS ID *</label>
                    <input
                      type="text"
                      required
                      disabled={Boolean(editing)}
                      value={form.employeeCode}
                      onChange={(event) =>
                        setForm({ ...form, employeeCode: event.target.value.toUpperCase() })
                      }
                      placeholder="IZ-0001"
                      className={`${inputClass} font-mono disabled:opacity-60`}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelClass}>Full name *</label>
                    <input
                      type="text"
                      required
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Branch *</label>
                    <select
                      required
                      disabled={Boolean(editing)}
                      value={form.branchId}
                      onChange={(event) => setForm({ ...form, branchId: event.target.value })}
                      className={`${inputClass} disabled:opacity-60`}
                    >
                      <option value="">Select branch</option>
                      {branches.map((branch) => (
                        <option key={branch.id} value={branch.id}>
                          {branch.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Linked user account</label>
                    <select
                      value={form.userId}
                      onChange={(event) => setForm({ ...form, userId: event.target.value })}
                      className={inputClass}
                    >
                      <option value="">Not linked</option>
                      {userOptions.map((option) => (
                        <option
                          key={option.id}
                          value={option.id}
                          disabled={option.linked && option.id !== form.userId}
                        >
                          {option.name} — {option.email}
                          {option.linked && option.id !== form.userId ? ' (already linked)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Employment type</label>
                    <input
                      list="employment-types"
                      value={form.employmentType}
                      onChange={(event) => setForm({ ...form, employmentType: event.target.value })}
                      placeholder="Non-PB"
                      className={inputClass}
                    />
                    <datalist id="employment-types">
                      {EMPLOYMENT_TYPES.map((type) => (
                        <option key={type} value={type} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className={labelClass}>Joining date (AD)</label>
                    <input
                      type="date"
                      value={form.joiningDateAD}
                      onChange={(event) => setForm({ ...form, joiningDateAD: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Department</label>
                    <input
                      type="text"
                      list="hr-department-options"
                      value={form.department}
                      onChange={(event) => setForm({ ...form, department: event.target.value })}
                      className={inputClass}
                    />
                    <datalist id="hr-department-options">
                      {orgOptions('DEPARTMENT').map((master) => (
                        <option key={master.id} value={master.name} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className={labelClass}>Designation</label>
                    <input
                      type="text"
                      list="hr-designation-options"
                      value={form.designation}
                      onChange={(event) => setForm({ ...form, designation: event.target.value })}
                      className={inputClass}
                    />
                    <datalist id="hr-designation-options">
                      {orgOptions('DESIGNATION').map((master) => (
                        <option key={master.id} value={master.name} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className={labelClass}>Designation code</label>
                    <input
                      type="text"
                      value={form.designationCode}
                      onChange={(event) => setForm({ ...form, designationCode: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Work station</label>
                    <input
                      type="text"
                      list="hr-work-station-options"
                      value={form.workStation}
                      onChange={(event) => setForm({ ...form, workStation: event.target.value })}
                      className={inputClass}
                    />
                    <datalist id="hr-work-station-options">
                      {orgOptions('WORK_STATION').map((master) => (
                        <option key={master.id} value={master.name} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className={labelClass}>Date of birth (AD)</label>
                    <input
                      type="date"
                      value={form.dateOfBirthAD}
                      onChange={(event) => setForm({ ...form, dateOfBirthAD: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Contract expiry (AD)</label>
                    <input
                      type="date"
                      value={form.contractExpiryAD}
                      onChange={(event) => setForm({ ...form, contractExpiryAD: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Separation date (AD)</label>
                    <input
                      type="date"
                      value={form.separationDateAD}
                      onChange={(event) => setForm({ ...form, separationDateAD: event.target.value })}
                      className={inputClass}
                    />
                    <p className="mt-1 text-[10px] text-slate-400">
                      Stored exit date for HR reports; set status to Inactive separately.
                    </p>
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <h4 className="border-b border-slate-100 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:border-slate-800">
                  Contact & address
                </h4>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label className={labelClass}>Personal contact</label>
                    <input
                      type="text"
                      value={form.personalContact}
                      onChange={(event) => setForm({ ...form, personalContact: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Emergency contact person</label>
                    <input
                      type="text"
                      value={form.emergencyContactPerson}
                      onChange={(event) =>
                        setForm({ ...form, emergencyContactPerson: event.target.value })
                      }
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Emergency contact number</label>
                    <input
                      type="text"
                      value={form.emergencyContactNumber}
                      onChange={(event) =>
                        setForm({ ...form, emergencyContactNumber: event.target.value })
                      }
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Internal e-mail</label>
                    <input
                      type="email"
                      value={form.internalEmail}
                      onChange={(event) => setForm({ ...form, internalEmail: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Personal e-mail</label>
                    <input
                      type="email"
                      value={form.personalEmail}
                      onChange={(event) => setForm({ ...form, personalEmail: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Address</label>
                    <input
                      type="text"
                      value={form.address}
                      onChange={(event) => setForm({ ...form, address: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <h4 className="border-b border-slate-100 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:border-slate-800">
                  Bank, statutory & salary reference
                </h4>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label className={labelClass}>Bank name</label>
                    <input
                      type="text"
                      value={form.bankName}
                      onChange={(event) => setForm({ ...form, bankName: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Bank account</label>
                    <input
                      type="text"
                      value={form.bankAccount}
                      onChange={(event) => setForm({ ...form, bankAccount: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>PAN</label>
                    <input
                      type="text"
                      value={form.panNumber}
                      onChange={(event) => setForm({ ...form, panNumber: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>SSF number</label>
                    <input
                      type="text"
                      value={form.ssfNumber}
                      onChange={(event) => setForm({ ...form, ssfNumber: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Monthly salary (reference)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.monthlySalary}
                      onChange={(event) => setForm({ ...form, monthlySalary: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div className="flex flex-col justify-end gap-1 pb-1">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.ssfEligible}
                        onChange={(event) => setForm({ ...form, ssfEligible: event.target.checked })}
                        className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                      />
                      <span className="font-semibold">SSF eligible</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.isActive}
                        onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
                        className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                      />
                      <span className="font-semibold">Active employee</span>
                    </label>
                  </div>
                </div>
                {canManage ? (
                  <p className="flex items-center gap-1 text-[10px] text-slate-500">
                    <Landmark className="h-3 w-3" />
                    Salary is a reference from the master sheet until effective-dated payroll structures ship.
                  </p>
                ) : null}
              </section>

              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="cursor-pointer rounded-xl bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Employee'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}
      {importOpen ? (
        <EmployeeImportDialog
          onClose={() => setImportOpen(false)}
          onImported={loadEmployees}
        />
      ) : null}

      {profileFor ? (
        <EmployeeProfileDialog
          employee={profileFor}
          canManage={canManage}
          onClose={() => setProfileFor(null)}
        />
      ) : null}

      {documentsFor ? (
        <EmployeeDocumentsDialog
          employee={documentsFor}
          canManage={canManage}
          onClose={() => setDocumentsFor(null)}
        />
      ) : null}
    </div>
  );
};

export default EmployeeDirectory;
