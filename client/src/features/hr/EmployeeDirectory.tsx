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
  Edit2,
  FileText,
  Link2,
  Mail,
  Phone,
  Plus,
  Shield,
  UploadCloud,
  Users,
} from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import { FilterCard } from '../../components/common/FilterCard';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
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
  const [createOpen, setCreateOpen] = useState(false);
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
    void loadUserOptions();
    setCreateOpen(true);
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
                        {employee.profilePhoto ? (
                          <img
                            src={employee.profilePhoto}
                            alt=""
                            className="h-6 w-6 shrink-0 rounded-full border border-slate-200 object-cover dark:border-slate-700"
                          />
                        ) : (
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                            {employee.name
                              .split(/\s+/)
                              .filter(Boolean)
                              .slice(0, 2)
                              .map((part) => part[0])
                              .join('')
                              .toUpperCase()}
                          </span>
                        )}
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
                        {/* One edit entry: the F1 dialog also carries the HR
                            master fields, so there is no second edit button.
                            View-only roles get the same dialog read-only. */}
                        <button
                          onClick={() => setProfileFor(employee)}
                          title={
                            canManage
                              ? `Edit ${employee.name}`
                              : `View profile for ${employee.name}`
                          }
                          className="cursor-pointer rounded-lg p-1 text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
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

      {importOpen ? (
        <EmployeeImportDialog
          onClose={() => setImportOpen(false)}
          onImported={loadEmployees}
        />
      ) : null}

      {/* One form for every employee: the same F1 dialog creates and edits,
          including the photo picker. */}
      {profileFor || createOpen ? (
        <EmployeeProfileDialog
          employee={profileFor}
          canManage={canManage}
          branches={branches}
          branchName={profileFor ? branchLabel(profileFor.branchId) : ''}
          userOptions={userOptions}
          orgMasters={orgMasters}
          defaultBranchId={defaultBranchId}
          onRecordSaved={loadEmployees}
          onClose={() => {
            setProfileFor(null);
            setCreateOpen(false);
          }}
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
