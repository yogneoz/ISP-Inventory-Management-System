/**
 * People & HR → Attendance & Leave.
 *
 * The first Phase 1 slice: the daily register plus the master data it needs.
 * Shifts and leave types are company catalogues; holidays and attendance days
 * are branch-owned. View-only HR roles can read every tab; only attendance
 * managers see the add/import/edit controls.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { PeriodRangeField } from '../../components/common/PeriodRangeField';
import {
  Calculator,
  CalendarCheck,
  CalendarDays,
  Clock,
  FileText,
  Plus,
  Scale,
  UploadCloud,
  Users,
  X,
} from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { ModalPanel } from '../../components/common/ModalPanel';
import { PageHeader } from '../../components/common/PageHeader';
import { api } from '../../services/api';
import type {
  Branch,
  User,
} from '../../types';
import type {
  EmployeeRecord,
  HrAttendanceImportResult,
  HrAttendanceRecord,
  HrAttendanceStatus,
  HrHolidayRecord,
  HrLeaveBalanceRecord,
  HrLeaveRequestRecord,
  HrLeaveRequestStatus,
  HrLeaveTypeRecord,
  HrPayrollInputRecord,
  HrShiftRecord,
} from '../../services/api';
import { isOperationAllowed } from '../../utils/permissions';
import { useBootstrapData } from '../../contexts/AppProviders';

interface AttendanceLeaveProps {
  currentUser: User | null;
  selectedBranchId?: string;
  /** Header calendar for the register's From/To filter; rows stay AD. */
  dateMode: 'BS' | 'AD';
}

type Tab =
  | 'ATTENDANCE'
  | 'SHIFTS'
  | 'HOLIDAYS'
  | 'LEAVE_TYPES'
  | 'LEAVE_REQUESTS'
  | 'BALANCES'
  | 'PAYROLL_INPUTS';

interface AttendanceForm {
  employeeId: string;
  attendanceDateAD: string;
  status: HrAttendanceStatus;
  shiftId: string;
  checkInTime: string;
  checkOutTime: string;
  overtimeHours: string;
  notes: string;
}

interface ShiftForm {
  name: string;
  code: string;
  startTime: string;
  endTime: string;
  graceMinutes: string;
  isActive: boolean;
}

interface LeaveTypeForm {
  name: string;
  code: string;
  annualQuotaDays: string;
  isPaid: boolean;
  isActive: boolean;
}

interface HolidayForm {
  branchId: string;
  holidayDateAD: string;
  name: string;
  isPaid: boolean;
  notes: string;
}

interface LeaveRequestForm {
  employeeId: string;
  leaveTypeId: string;
  startDateAD: string;
  endDateAD: string;
  reason: string;
}

interface BalanceForm {
  employeeId: string;
  leaveTypeId: string;
  balanceYear: string;
  entitlementDays: string;
  adjustmentDays: string;
  notes: string;
}

interface PayrollInputForm {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  periodKey: string;
  incentiveAmount: string;
  arrearsAmount: string;
  advanceAmount: string;
  loanAmount: string;
  notes: string;
}

const TABS: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
  { id: 'ATTENDANCE', label: 'Daily Attendance', icon: Users },
  { id: 'SHIFTS', label: 'Shifts', icon: Clock },
  { id: 'HOLIDAYS', label: 'Holidays', icon: CalendarDays },
  { id: 'LEAVE_TYPES', label: 'Leave Types', icon: FileText },
  { id: 'LEAVE_REQUESTS', label: 'Leave Requests', icon: CalendarCheck },
  { id: 'BALANCES', label: 'Leave Balances', icon: Scale },
  { id: 'PAYROLL_INPUTS', label: 'Payroll Inputs', icon: Calculator },
];

const STATUS_OPTIONS: HrAttendanceStatus[] = [
  'PRESENT',
  'ABSENT',
  'LEAVE',
  'HALF_DAY',
  'HOLIDAY',
  'WEEKEND',
];

const STATUS_LABEL: Record<HrAttendanceStatus, string> = {
  PRESENT: 'Present',
  ABSENT: 'Absent',
  LEAVE: 'Leave',
  HALF_DAY: 'Half day',
  HOLIDAY: 'Holiday',
  WEEKEND: 'Weekend',
};

const STATUS_CLASS: Record<HrAttendanceStatus, string> = {
  PRESENT: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  ABSENT: 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-300',
  LEAVE: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  HALF_DAY: 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-300',
  HOLIDAY: 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-300',
  WEEKEND: 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

const LEAVE_STATUS_LABEL: Record<HrLeaveRequestStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

const LEAVE_STATUS_CLASS: Record<HrLeaveRequestStatus, string> = {
  PENDING: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  APPROVED: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  REJECTED: 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-300',
  CANCELLED: 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

const LEAVE_ACTION_CLASS =
  'cursor-pointer rounded-lg px-2 py-1 text-[10px] font-semibold hover:bg-slate-100 dark:hover:bg-slate-800';

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 7)}-01`;
const codeFromName = (name: string) =>
  name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);

const emptyAttendance = (): AttendanceForm => ({
  employeeId: '',
  attendanceDateAD: today(),
  status: 'PRESENT',
  shiftId: '',
  checkInTime: '',
  checkOutTime: '',
  overtimeHours: '0',
  notes: '',
});

const emptyShift = (): ShiftForm => ({
  name: '',
  code: '',
  startTime: '09:00',
  endTime: '18:00',
  graceMinutes: '0',
  isActive: true,
});

const emptyLeaveType = (): LeaveTypeForm => ({
  name: '',
  code: '',
  annualQuotaDays: '0',
  isPaid: true,
  isActive: true,
});

const emptyHoliday = (branchId = ''): HolidayForm => ({
  branchId,
  holidayDateAD: today(),
  name: '',
  isPaid: true,
  notes: '',
});

const emptyLeaveRequest = (): LeaveRequestForm => ({
  employeeId: '',
  leaveTypeId: '',
  startDateAD: today(),
  endDateAD: today(),
  reason: '',
});

const emptyBalance = (year = new Date().getFullYear()): BalanceForm => ({
  employeeId: '',
  leaveTypeId: '',
  balanceYear: String(year),
  entitlementDays: '0',
  adjustmentDays: '0',
  notes: '',
});

const emptyPayrollInput = (): PayrollInputForm => ({
  employeeId: '',
  employeeCode: '',
  employeeName: '',
  periodKey: '',
  incentiveAmount: '0',
  arrearsAmount: '0',
  advanceAmount: '0',
  loanAmount: '0',
  notes: '',
});

const inputClass =
  'h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 text-xs dark:border-slate-700';
const labelClass = 'mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400';

export const AttendanceLeave: React.FC<AttendanceLeaveProps> = ({
  currentUser,
  selectedBranchId = 'ALL',
  dateMode,
}) => {
  // Workspace data: owned by BootstrapDataProvider (step 6 of the App split).
  const { branches } = useBootstrapData();
  const { alert: alertDialog, confirm: confirmDialog } = useDialog();
  const activationKey = useActivationKey('hr-attendance');

  const isGlobal =
    currentUser?.role === 'SUPER_ADMIN' ||
    currentUser?.role === 'HEAD_OFFICE_ADMIN' ||
    currentUser?.branchId === 'ALL';
  const branchScope =
    isGlobal
      ? selectedBranchId && selectedBranchId !== 'ALL'
        ? selectedBranchId
        : undefined
      : currentUser?.branchId || (selectedBranchId !== 'ALL' ? selectedBranchId : undefined) || undefined;

  const canManage =
    isOperationAllowed('hr-attendance-manage', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);
  const canView =
    canManage ||
    isOperationAllowed('hr-employee-view', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);
  const canEditPayrollInputs =
    isOperationAllowed('hr-employee-manage', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);

  const [activeTab, setActiveTab] = useState<Tab>('ATTENDANCE');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [statusFilter, setStatusFilter] = useState<HrAttendanceStatus | ''>('');
  const [attendance, setAttendance] = useState<HrAttendanceRecord[]>([]);
  const [shifts, setShifts] = useState<HrShiftRecord[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<HrLeaveTypeRecord[]>([]);
  const [holidays, setHolidays] = useState<HrHolidayRecord[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<HrLeaveRequestRecord[]>([]);
  const [leaveBalances, setLeaveBalances] = useState<HrLeaveBalanceRecord[]>([]);
  const [payrollInputs, setPayrollInputs] = useState<HrPayrollInputRecord[]>([]);
  const [editingPayrollInput, setEditingPayrollInput] = useState<HrPayrollInputRecord | null>(null);
  const [payrollInputForm, setPayrollInputForm] = useState<PayrollInputForm>(emptyPayrollInput);
  const [leaveStatusFilter, setLeaveStatusFilter] = useState<HrLeaveRequestStatus | ''>('');
  const [balanceYear, setBalanceYear] = useState(String(new Date().getFullYear()));
  const [employees, setEmployees] = useState<EmployeeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const payrollInputPeriod =
    from && to && from.slice(0, 7) === to.slice(0, 7) ? from.slice(0, 7) : null;

  const [modal, setModal] = useState<'ATTENDANCE' | 'IMPORT' | 'SHIFT' | 'HOLIDAY' | 'LEAVE_TYPE' | 'LEAVE_REQUEST' | 'BALANCE' | 'PAYROLL_INPUT' | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingShift, setEditingShift] = useState<HrShiftRecord | null>(null);
  const [editingLeaveType, setEditingLeaveType] = useState<HrLeaveTypeRecord | null>(null);
  const [attendanceForm, setAttendanceForm] = useState<AttendanceForm>(emptyAttendance);
  const [shiftForm, setShiftForm] = useState<ShiftForm>(emptyShift);
  const [leaveTypeForm, setLeaveTypeForm] = useState<LeaveTypeForm>(emptyLeaveType);
  const [holidayForm, setHolidayForm] = useState<HolidayForm>(() => emptyHoliday());
  const [importCsv, setImportCsv] = useState('');
  const [importResult, setImportResult] = useState<HrAttendanceImportResult | null>(null);
  const [editingBalance, setEditingBalance] = useState<HrLeaveBalanceRecord | null>(null);
  const [leaveRequestForm, setLeaveRequestForm] = useState<LeaveRequestForm>(emptyLeaveRequest);
  const [balanceForm, setBalanceForm] = useState<BalanceForm>(() => emptyBalance());

  const defaultHolidayBranch = useMemo(() => {
    if (branchScope) return branchScope;
    if (currentUser?.branchId && currentUser.branchId !== 'ALL') return currentUser.branchId;
    return branches[0]?.id || '';
  }, [branchScope, currentUser?.branchId, branches]);

  const load = async () => {
    if (!canView) return;
    setLoading(true);
    try {
      const [
        attendanceRows,
        shiftRows,
        leaveTypeRows,
        holidayRows,
        employeeRows,
        leaveRequestRows,
        leaveBalanceRows,
        payrollInputRows,
      ] = await Promise.all([
        api.getHrAttendance({
          branchId: branchScope,
          from,
          to,
          status: statusFilter || undefined,
        }),
        api.getHrShifts(),
        api.getHrLeaveTypes(),
        api.getHrHolidays({ branchId: branchScope, from, to }),
        api.getEmployees({ branchId: branchScope, activeOnly: true, limit: 1000 }),
        api.getHrLeaveRequests({
          branchId: branchScope,
          from,
          to,
          status: leaveStatusFilter || undefined,
        }),
        api.getHrLeaveBalances({
          branchId: branchScope,
          year: /^\d{4}$/.test(balanceYear) ? Number(balanceYear) : undefined,
        }),
        from && to
          ? api.getHrPayrollInputs({ branchId: branchScope, from, to })
          : Promise.resolve([] as HrPayrollInputRecord[]),
      ]);
      setAttendance(Array.isArray(attendanceRows) ? attendanceRows : []);
      setShifts(Array.isArray(shiftRows) ? shiftRows : []);
      setLeaveTypes(Array.isArray(leaveTypeRows) ? leaveTypeRows : []);
      setHolidays(Array.isArray(holidayRows) ? holidayRows : []);
      setEmployees(Array.isArray(employeeRows) ? employeeRows : []);
      setLeaveRequests(Array.isArray(leaveRequestRows) ? leaveRequestRows : []);
      setLeaveBalances(Array.isArray(leaveBalanceRows) ? leaveBalanceRows : []);
      setPayrollInputs(Array.isArray(payrollInputRows) ? payrollInputRows : []);
      setError('');
    } catch (err: any) {
      setError(err?.message || 'The attendance register could not be read.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Refetch after a tab re-activation as well as on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey, canView, from, to, statusFilter, leaveStatusFilter, balanceYear, branchScope]);

  const activeShifts = useMemo(() => shifts.filter((shift) => shift.isActive), [shifts]);
  const activeLeaveTypes = useMemo(
    () => leaveTypes.filter((type) => type.isActive),
    [leaveTypes]
  );

  const openAttendance = () => {
    setAttendanceForm({
      ...emptyAttendance(),
      employeeId: employees[0]?.id || '',
      shiftId: activeShifts[0]?.id || '',
    });
    setModal('ATTENDANCE');
  };

  const openShift = (shift?: HrShiftRecord) => {
    setEditingShift(shift || null);
    setShiftForm(
      shift
        ? {
            name: shift.name,
            code: shift.code,
            startTime: shift.startTime.slice(0, 5),
            endTime: shift.endTime.slice(0, 5),
            graceMinutes: String(shift.graceMinutes),
            isActive: shift.isActive,
          }
        : emptyShift()
    );
    setModal('SHIFT');
  };

  const openLeaveType = (type?: HrLeaveTypeRecord) => {
    setEditingLeaveType(type || null);
    setLeaveTypeForm(
      type
        ? {
            name: type.name,
            code: type.code,
            annualQuotaDays: String(type.annualQuotaDays),
            isPaid: type.isPaid,
            isActive: type.isActive,
          }
        : emptyLeaveType()
    );
    setModal('LEAVE_TYPE');
  };

  const openHoliday = () => {
    setHolidayForm(emptyHoliday(defaultHolidayBranch));
    setModal('HOLIDAY');
  };

  const openImport = () => {
    setImportCsv('');
    setImportResult(null);
    setModal('IMPORT');
  };

  const openLeaveRequest = () => {
    setLeaveRequestForm({
      ...emptyLeaveRequest(),
      employeeId: employees[0]?.id || '',
      leaveTypeId: activeLeaveTypes[0]?.id || '',
    });
    setModal('LEAVE_REQUEST');
  };

  const openBalance = (balance?: HrLeaveBalanceRecord) => {
    setEditingBalance(balance || null);
    setBalanceForm(
      balance
        ? {
            employeeId: balance.employeeId,
            leaveTypeId: balance.leaveTypeId,
            balanceYear: String(balance.balanceYear),
            entitlementDays: String(balance.entitlementDays),
            adjustmentDays: String(balance.adjustmentDays),
            notes: balance.notes || '',
          }
        : {
            ...emptyBalance(Number(balanceYear) || new Date().getFullYear()),
            employeeId: employees[0]?.id || '',
            leaveTypeId: activeLeaveTypes[0]?.id || '',
          }
    );
    setModal('BALANCE');
  };

  const openPayrollInput = (row: HrPayrollInputRecord) => {
    if (!payrollInputPeriod) {
      alertDialog('Choose a single calendar month before editing payroll adjustments.');
      return;
    }
    setEditingPayrollInput(row);
    setPayrollInputForm({
      employeeId: row.employeeId,
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      periodKey: payrollInputPeriod,
      incentiveAmount: String(Number(row.incentiveAmount || 0)),
      arrearsAmount: String(Number(row.arrearsAmount || 0)),
      advanceAmount: String(Number(row.advanceAmount || 0)),
      loanAmount: String(Number(row.loanAmount || 0)),
      notes: row.adjustmentNotes || '',
    });
    setModal('PAYROLL_INPUT');
  };

  const savePayrollInput = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!payrollInputForm.employeeId || !payrollInputForm.periodKey) {
      alertDialog('Choose an employee and a payroll month.');
      return;
    }
    setSaving(true);
    try {
      await api.saveHrPayrollInput({
        employeeId: payrollInputForm.employeeId,
        periodKey: payrollInputForm.periodKey,
        incentiveAmount: Number(payrollInputForm.incentiveAmount || 0),
        arrearsAmount: Number(payrollInputForm.arrearsAmount || 0),
        advanceAmount: Number(payrollInputForm.advanceAmount || 0),
        loanAmount: Number(payrollInputForm.loanAmount || 0),
        notes: payrollInputForm.notes.trim() || null,
      });
      setModal(null);
      setEditingPayrollInput(null);
      await load();
    } catch (err: any) {
      alertDialog(`Failed to save payroll adjustments: ${err?.message || 'database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const saveLeaveRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!leaveRequestForm.employeeId) {
      alertDialog('Choose an employee.');
      return;
    }
    setSaving(true);
    try {
      await api.createHrLeaveRequest({
        employeeId: leaveRequestForm.employeeId,
        leaveTypeId: leaveRequestForm.leaveTypeId,
        startDateAD: leaveRequestForm.startDateAD,
        endDateAD: leaveRequestForm.endDateAD,
        reason: leaveRequestForm.reason.trim() || null,
      });
      setModal(null);
      await load();
    } catch (err: any) {
      alertDialog(`Failed to submit the leave request: ${err?.message || 'database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const saveBalance = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!balanceForm.employeeId) {
      alertDialog('Choose an employee.');
      return;
    }
    setSaving(true);
    try {
      if (editingBalance) {
        await api.updateHrLeaveBalance(editingBalance.id, {
          entitlementDays: Number(balanceForm.entitlementDays || 0),
          adjustmentDays: Number(balanceForm.adjustmentDays || 0),
          notes: balanceForm.notes.trim() || null,
        });
      } else {
        await api.createHrLeaveBalance({
          employeeId: balanceForm.employeeId,
          leaveTypeId: balanceForm.leaveTypeId,
          balanceYear: Number(balanceForm.balanceYear),
          entitlementDays: Number(balanceForm.entitlementDays || 0),
          adjustmentDays: Number(balanceForm.adjustmentDays || 0),
          notes: balanceForm.notes.trim() || null,
        });
      }
      setModal(null);
      setEditingBalance(null);
      await load();
    } catch (err: any) {
      alertDialog(`Failed to save the leave balance: ${err?.message || 'database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const decideRequest = async (
    request: HrLeaveRequestRecord,
    action: 'approve' | 'reject' | 'cancel'
  ) => {
    const verb = action === 'approve' ? 'Approve' : action === 'reject' ? 'Reject' : 'Cancel';
    const confirmed = await confirmDialog(
      `${verb} leave request ${request.requestNo} for ${request.employeeName} (${Number(
        request.daysCount
      ).toFixed(1)} day(s))?`,
      { title: `${verb} leave request`, confirmLabel: verb }
    );
    if (!confirmed) return;
    try {
      if (action === 'approve') await api.approveHrLeaveRequest(request.id);
      else if (action === 'reject') await api.rejectHrLeaveRequest(request.id);
      else await api.cancelHrLeaveRequest(request.id);
      await load();
    } catch (err: any) {
      alertDialog(`Failed to ${action} the leave request: ${err?.message || 'database error'}`);
    }
  };

  const saveAttendance = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!attendanceForm.employeeId) {
      alertDialog('Choose an employee.');
      return;
    }
    setSaving(true);
    try {
      await api.saveHrAttendance({
        employeeId: attendanceForm.employeeId,
        attendanceDateAD: attendanceForm.attendanceDateAD,
        status: attendanceForm.status,
        shiftId: attendanceForm.shiftId || null,
        checkInTime: attendanceForm.checkInTime || null,
        checkOutTime: attendanceForm.checkOutTime || null,
        overtimeHours: Number(attendanceForm.overtimeHours || 0),
        notes: attendanceForm.notes.trim() || null,
      });
      setModal(null);
      await load();
    } catch (err: any) {
      alertDialog(`Failed to save attendance: ${err?.message || 'database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const saveShift = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        name: shiftForm.name.trim(),
        code: shiftForm.code.trim() || codeFromName(shiftForm.name),
        startTime: shiftForm.startTime,
        endTime: shiftForm.endTime,
        graceMinutes: Number(shiftForm.graceMinutes || 0),
        isActive: shiftForm.isActive,
      };
      if (editingShift) await api.updateHrShift(editingShift.id, payload);
      else await api.createHrShift(payload);
      setModal(null);
      setEditingShift(null);
      await load();
    } catch (err: any) {
      alertDialog(`Failed to save shift: ${err?.message || 'database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const saveLeaveType = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        name: leaveTypeForm.name.trim(),
        code: leaveTypeForm.code.trim() || codeFromName(leaveTypeForm.name),
        annualQuotaDays: Number(leaveTypeForm.annualQuotaDays || 0),
        isPaid: leaveTypeForm.isPaid,
        isActive: leaveTypeForm.isActive,
      };
      if (editingLeaveType) await api.updateHrLeaveType(editingLeaveType.id, payload);
      else await api.createHrLeaveType(payload);
      setModal(null);
      setEditingLeaveType(null);
      await load();
    } catch (err: any) {
      alertDialog(`Failed to save leave type: ${err?.message || 'database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const saveHoliday = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.createHrHoliday({
        branchId: holidayForm.branchId || undefined,
        holidayDateAD: holidayForm.holidayDateAD,
        name: holidayForm.name.trim(),
        isPaid: holidayForm.isPaid,
        notes: holidayForm.notes.trim() || null,
      });
      setModal(null);
      await load();
    } catch (err: any) {
      alertDialog(`Failed to save holiday: ${err?.message || 'database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const runImport = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!importCsv.trim()) {
      alertDialog('Choose a CSV file or paste the sheet first.');
      return;
    }
    setSaving(true);
    try {
      const result = await api.importHrAttendance(importCsv);
      setImportResult(result);
      await load();
    } catch (err: any) {
      alertDialog(`Import failed: ${err?.message || 'database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const headerAction = () => {
    if (!canManage) return null;
    if (activeTab === 'ATTENDANCE') {
      return (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openImport}
            className="flex cursor-pointer items-center gap-2 rounded-xl border border-indigo-300 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 shadow-sm hover:bg-indigo-50 dark:border-indigo-800 dark:bg-transparent dark:text-indigo-300 dark:hover:bg-indigo-950/40"
          >
            <UploadCloud className="h-4 w-4" /> Import CSV
          </button>
          <button
            type="button"
            onClick={openAttendance}
            className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md hover:bg-indigo-500"
          >
            <Plus className="h-4 w-4" /> Add / Update Day
          </button>
        </div>
      );
    }
    if (activeTab === 'SHIFTS') {
      return (
        <button
          type="button"
          onClick={() => openShift()}
          className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md hover:bg-indigo-500"
        >
          <Plus className="h-4 w-4" /> Add Shift
        </button>
      );
    }
    if (activeTab === 'HOLIDAYS') {
      return (
        <button
          type="button"
          onClick={openHoliday}
          className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md hover:bg-indigo-500"
        >
          <Plus className="h-4 w-4" /> Add Holiday
        </button>
      );
    }
    if (activeTab === 'LEAVE_REQUESTS') {
      return (
        <button
          type="button"
          onClick={openLeaveRequest}
          className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md hover:bg-indigo-500"
        >
          <Plus className="h-4 w-4" /> New Request
        </button>
      );
    }
    if (activeTab === 'BALANCES') {
      return (
        <button
          type="button"
          onClick={() => openBalance()}
          className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md hover:bg-indigo-500"
        >
          <Plus className="h-4 w-4" /> Add Balance
        </button>
      );
    }
    if (activeTab === 'PAYROLL_INPUTS') {
      return null;
    }
    return (
      <button
        type="button"
        onClick={() => openLeaveType()}
        className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md hover:bg-indigo-500"
      >
        <Plus className="h-4 w-4" /> Add Leave Type
      </button>
    );
  };

  if (!canView) {
    return (
      <div className="p-6">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Your role cannot read the attendance register.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-6.5rem)] flex-col space-y-3 overflow-hidden">
      <PageHeader
        title="Attendance & Leave"
        description={`${attendance.length} attendance rows in ${from} → ${to} · ${
          leaveRequests.filter((row) => row.status === 'PENDING').length
        } leave request(s) pending`}
        icon={<CalendarDays className="h-5 w-5 text-indigo-500" />}
        actions={headerAction()}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs font-semibold transition-colors ${
                selected
                  ? 'border-indigo-300 bg-indigo-50 text-indigo-700 shadow-sm dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:bg-[#0f1218] dark:text-slate-300 dark:hover:bg-slate-800/40'
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-800 dark:bg-[#0f1218]">
        {activeTab !== 'BALANCES' && (
          <>
            <PeriodRangeField
              from={from}
              to={to}
              onChange={(range) => {
                setFrom(range.from);
                setTo(range.to);
              }}
              label="Period (AD)"
              startAriaLabel="Attendance range from"
              endAriaLabel="Attendance range to"
              requireEnd={false}
              mode={dateMode}
            />
          </>
        )}
        {activeTab === 'LEAVE_REQUESTS' && (
          <label className="flex items-center gap-1.5">
            <span className="font-semibold text-slate-500 dark:text-slate-400">Status</span>
            <select
              value={leaveStatusFilter}
              onChange={(event) =>
                setLeaveStatusFilter(event.target.value as HrLeaveRequestStatus | '')
              }
              className={inputClass}
            >
              <option value="">All statuses</option>
              {(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as HrLeaveRequestStatus[]).map(
                (status) => (
                  <option key={status} value={status}>
                    {LEAVE_STATUS_LABEL[status]}
                  </option>
                )
              )}
            </select>
          </label>
        )}
        {activeTab === 'BALANCES' && (
          <label className="flex items-center gap-1.5">
            <span className="font-semibold text-slate-500 dark:text-slate-400">Year</span>
            <input
              type="number"
              min="2000"
              max="2100"
              value={balanceYear}
              onChange={(event) => setBalanceYear(event.target.value)}
              className={inputClass}
            />
          </label>
        )}
        {activeTab === 'PAYROLL_INPUTS' && (
          <span className="text-[10px] text-slate-500 dark:text-slate-400">
            Attendance is read-only · incentive, arrears and recoveries are month inputs
            {payrollInputPeriod ? ` · ${payrollInputPeriod}` : ' · choose one calendar month to edit'}
          </span>
        )}
        {activeTab === 'ATTENDANCE' && (
          <label className="flex items-center gap-1.5">
            <span className="font-semibold text-slate-500 dark:text-slate-400">Status</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as HrAttendanceStatus | '')}
              className={inputClass}
            >
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABEL[status]}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={() => void load()}
          className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          Apply
        </button>
        <span className="ml-auto text-[10px] text-slate-500 dark:text-slate-400">
          {branchScope ? `Branch ${branches.find((branch) => branch.id === branchScope)?.name || branchScope}` : 'All branches'}
        </span>
      </div>

      <LoadStateNotice
        subject="attendance workspace"
        loading={loading}
        error={error}
        hasCachedRows={
          attendance.length +
            shifts.length +
            leaveTypes.length +
            holidays.length +
            leaveRequests.length +
            leaveBalances.length +
            payrollInputs.length >
          0
        }
        onRetry={load}
      />

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-white shadow-md dark:border-slate-800 dark:bg-[#0f1218]">
        {activeTab === 'ATTENDANCE' && (
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
              <tr>
                <th className="px-2.5 py-1.5">Date</th>
                <th className="px-2.5 py-1.5">Employee</th>
                <th className="px-2.5 py-1.5">Status</th>
                <th className="px-2.5 py-1.5">Shift</th>
                <th className="px-2.5 py-1.5">In / Out</th>
                <th className="px-2.5 py-1.5 text-right">OT hrs</th>
                <th className="px-2.5 py-1.5">Source</th>
                <th className="px-2.5 py-1.5">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {attendance.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-slate-500">
                    {loading ? 'Loading attendance…' : 'No attendance rows in this date range.'}
                  </td>
                </tr>
              ) : (
                attendance.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-slate-600 dark:text-slate-300">
                      {row.attendanceDateAD}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <div className="font-bold text-slate-900 dark:text-white">{row.employeeName}</div>
                      <div className="font-mono text-[10px] text-slate-500">{row.employeeCode}</div>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_CLASS[row.status]}`}>
                        {STATUS_LABEL[row.status]}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5">{row.shiftCode || row.shiftName || '—'}</td>
                    <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-slate-600 dark:text-slate-300">
                      {row.checkInTime || '—'} / {row.checkOutTime || '—'}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono">{Number(row.overtimeHours).toFixed(2)}</td>
                    <td className="px-2.5 py-1.5 text-[10px] text-slate-500">{row.source}</td>
                    <td className="max-w-[16rem] truncate px-2.5 py-1.5 text-slate-500" title={row.notes || ''}>
                      {row.notes || '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {activeTab === 'SHIFTS' && (
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
              <tr>
                <th className="px-2.5 py-1.5">Name</th>
                <th className="px-2.5 py-1.5">Code</th>
                <th className="px-2.5 py-1.5">Hours</th>
                <th className="px-2.5 py-1.5 text-right">Grace</th>
                <th className="px-2.5 py-1.5">Status</th>
                <th className="px-2.5 py-1.5 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {shifts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-slate-500">
                    {loading ? 'Loading shifts…' : 'No shifts configured yet.'}
                  </td>
                </tr>
              ) : (
                shifts.map((shift) => (
                  <tr key={shift.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className="px-2.5 py-1.5 font-bold text-slate-900 dark:text-white">{shift.name}</td>
                    <td className="px-2.5 py-1.5 font-mono text-slate-600 dark:text-slate-300">{shift.code}</td>
                    <td className="px-2.5 py-1.5 font-mono">{shift.startTime}–{shift.endTime}</td>
                    <td className="px-2.5 py-1.5 text-right">{shift.graceMinutes} min</td>
                    <td className="px-2.5 py-1.5 text-[10px] font-bold">
                      {shift.isActive ? 'Active' : 'Inactive'}
                    </td>
                    <td className="px-2.5 py-1.5 text-center">
                      {canManage ? (
                        <button
                          type="button"
                          onClick={() => openShift(shift)}
                          className="cursor-pointer rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                        >
                          Edit
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {activeTab === 'HOLIDAYS' && (
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
              <tr>
                <th className="px-2.5 py-1.5">Date</th>
                <th className="px-2.5 py-1.5">Holiday</th>
                <th className="px-2.5 py-1.5">Branch</th>
                <th className="px-2.5 py-1.5">Paid</th>
                <th className="px-2.5 py-1.5">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {holidays.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-slate-500">
                    {loading ? 'Loading holidays…' : 'No holidays in this date range.'}
                  </td>
                </tr>
              ) : (
                holidays.map((holiday) => (
                  <tr key={holiday.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className="whitespace-nowrap px-2.5 py-1.5 font-mono">{holiday.holidayDateAD}</td>
                    <td className="px-2.5 py-1.5 font-bold text-slate-900 dark:text-white">{holiday.name}</td>
                    <td className="px-2.5 py-1.5">{holiday.branchName}</td>
                    <td className="px-2.5 py-1.5 text-[10px]">{holiday.isPaid ? 'Paid' : 'Unpaid'}</td>
                    <td className="max-w-[18rem] truncate px-2.5 py-1.5 text-slate-500" title={holiday.notes || ''}>
                      {holiday.notes || '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {activeTab === 'LEAVE_TYPES' && (
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
              <tr>
                <th className="px-2.5 py-1.5">Name</th>
                <th className="px-2.5 py-1.5">Code</th>
                <th className="px-2.5 py-1.5 text-right">Annual quota</th>
                <th className="px-2.5 py-1.5">Paid</th>
                <th className="px-2.5 py-1.5">Status</th>
                <th className="px-2.5 py-1.5 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {leaveTypes.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-slate-500">
                    {loading ? 'Loading leave types…' : 'No leave types configured yet.'}
                  </td>
                </tr>
              ) : (
                leaveTypes.map((type) => (
                  <tr key={type.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className="px-2.5 py-1.5 font-bold text-slate-900 dark:text-white">{type.name}</td>
                    <td className="px-2.5 py-1.5 font-mono">{type.code}</td>
                    <td className="px-2.5 py-1.5 text-right font-mono">{Number(type.annualQuotaDays).toFixed(1)}</td>
                    <td className="px-2.5 py-1.5 text-[10px]">{type.isPaid ? 'Paid' : 'Unpaid'}</td>
                    <td className="px-2.5 py-1.5 text-[10px] font-bold">{type.isActive ? 'Active' : 'Inactive'}</td>
                    <td className="px-2.5 py-1.5 text-center">
                      {canManage ? (
                        <button
                          type="button"
                          onClick={() => openLeaveType(type)}
                          className="cursor-pointer rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                        >
                          Edit
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
        {activeTab === 'LEAVE_REQUESTS' && (
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
              <tr>
                <th className="px-2.5 py-1.5">Request</th>
                <th className="px-2.5 py-1.5">Employee</th>
                <th className="px-2.5 py-1.5">Type</th>
                <th className="px-2.5 py-1.5">Dates</th>
                <th className="px-2.5 py-1.5 text-right">Days</th>
                <th className="px-2.5 py-1.5">Status</th>
                <th className="px-2.5 py-1.5">Decided by</th>
                <th className="px-2.5 py-1.5 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {leaveRequests.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-slate-500">
                    {loading ? 'Loading leave requests…' : 'No leave requests in this date range.'}
                  </td>
                </tr>
              ) : (
                leaveRequests.map((request) => (
                  <tr key={request.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-slate-600 dark:text-slate-300">
                      {request.requestNo}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <div className="font-bold text-slate-900 dark:text-white">{request.employeeName}</div>
                      <div className="font-mono text-[10px] text-slate-500">{request.employeeCode}</div>
                    </td>
                    <td className="px-2.5 py-1.5">{request.leaveTypeName}</td>
                    <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-slate-600 dark:text-slate-300">
                      {request.startDateAD} → {request.endDateAD}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono">
                      {Number(request.daysCount).toFixed(1)}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${LEAVE_STATUS_CLASS[request.status]}`}
                      >
                        {LEAVE_STATUS_LABEL[request.status]}
                      </span>
                    </td>
                    <td
                      className="max-w-[12rem] truncate px-2.5 py-1.5 text-[10px] text-slate-500"
                      title={request.decisionNote || ''}
                    >
                      {request.decidedBy || '—'}
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-1.5 text-center">
                      {!canManage ? (
                        '—'
                      ) : request.status === 'PENDING' ? (
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void decideRequest(request, 'approve')}
                            className={`${LEAVE_ACTION_CLASS} text-emerald-600 dark:text-emerald-400`}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => void decideRequest(request, 'reject')}
                            className={`${LEAVE_ACTION_CLASS} text-rose-600 dark:text-rose-400`}
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            onClick={() => void decideRequest(request, 'cancel')}
                            className={`${LEAVE_ACTION_CLASS} text-slate-500`}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : request.status === 'APPROVED' ? (
                        <button
                          type="button"
                          onClick={() => void decideRequest(request, 'cancel')}
                          className={`${LEAVE_ACTION_CLASS} text-slate-500`}
                        >
                          Cancel
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {activeTab === 'BALANCES' && (
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
              <tr>
                <th className="px-2.5 py-1.5">Year</th>
                <th className="px-2.5 py-1.5">Employee</th>
                <th className="px-2.5 py-1.5">Leave type</th>
                <th className="px-2.5 py-1.5 text-right">Entitled</th>
                <th className="px-2.5 py-1.5 text-right">Adjustment</th>
                <th className="px-2.5 py-1.5 text-right">Used</th>
                <th className="px-2.5 py-1.5 text-right">Remaining</th>
                <th className="px-2.5 py-1.5">Notes</th>
                <th className="px-2.5 py-1.5 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {leaveBalances.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-6 text-center text-slate-500">
                    {loading ? 'Loading leave balances…' : 'No leave balances for this year.'}
                  </td>
                </tr>
              ) : (
                leaveBalances.map((balance) => (
                  <tr key={balance.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className="px-2.5 py-1.5 font-mono">{balance.balanceYear}</td>
                    <td className="px-2.5 py-1.5">
                      <div className="font-bold text-slate-900 dark:text-white">{balance.employeeName}</div>
                      <div className="font-mono text-[10px] text-slate-500">{balance.employeeCode}</div>
                    </td>
                    <td className="px-2.5 py-1.5">{balance.leaveTypeName}</td>
                    <td className="px-2.5 py-1.5 text-right font-mono">
                      {Number(balance.entitlementDays).toFixed(1)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono text-slate-500">
                      {Number(balance.adjustmentDays).toFixed(1)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono">
                      {Number(balance.usedDays).toFixed(1)}
                    </td>
                    <td
                      className={`px-2.5 py-1.5 text-right font-mono font-bold ${
                        Number(balance.remainingDays) < 0
                          ? 'text-rose-600 dark:text-rose-400'
                          : 'text-emerald-600 dark:text-emerald-400'
                      }`}
                    >
                      {Number(balance.remainingDays).toFixed(1)}
                    </td>
                    <td
                      className="max-w-[14rem] truncate px-2.5 py-1.5 text-slate-500"
                      title={balance.notes || ''}
                    >
                      {balance.notes || '—'}
                    </td>
                    <td className="px-2.5 py-1.5 text-center">
                      {canManage ? (
                        <button
                          type="button"
                          onClick={() => openBalance(balance)}
                          className="cursor-pointer rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                        >
                          Edit
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {activeTab === 'PAYROLL_INPUTS' && (
          <table className="w-full min-w-[1280px] border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
              <tr>
                <th className="px-2.5 py-1.5">Employee</th>
                <th className="px-2.5 py-1.5 text-right">Present</th>
                <th className="px-2.5 py-1.5 text-right">Half</th>
                <th className="px-2.5 py-1.5 text-right">Absent</th>
                <th className="px-2.5 py-1.5 text-right">Leave</th>
                <th className="px-2.5 py-1.5 text-right">Holiday</th>
                <th className="px-2.5 py-1.5 text-right">Weekend</th>
                <th className="px-2.5 py-1.5 text-right">Paid leave</th>
                <th className="px-2.5 py-1.5 text-right">Unpaid leave</th>
                <th className="px-2.5 py-1.5 text-right">Payable</th>
                <th className="px-2.5 py-1.5 text-right">LOP</th>
                <th className="px-2.5 py-1.5 text-right">OT hrs</th>
                <th className="px-2.5 py-1.5 text-right">Incentive</th>
                <th className="px-2.5 py-1.5 text-right">Arrears</th>
                <th className="px-2.5 py-1.5 text-right">Advance</th>
                <th className="px-2.5 py-1.5 text-right">Loan</th>
                <th className="px-2.5 py-1.5">Notes</th>
                <th className="px-2.5 py-1.5">Adjustments</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {payrollInputs.length === 0 ? (
                <tr>
                  <td colSpan={18} className="p-6 text-center text-slate-500">
                    {loading ? 'Loading payroll inputs…' : 'No active employees in this branch scope.'}
                  </td>
                </tr>
              ) : (
                payrollInputs.map((row) => (
                  <tr key={row.employeeId} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className="px-2.5 py-1.5">
                      <div className="font-bold text-slate-900 dark:text-white">{row.employeeName}</div>
                      <div className="font-mono text-[10px] text-slate-500">
                        {row.employeeCode} · {row.branchName}
                      </div>
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono">{Number(row.presentDays).toFixed(1)}</td>
                    <td className="px-2.5 py-1.5 text-right font-mono">{Number(row.halfDays).toFixed(1)}</td>
                    <td className="px-2.5 py-1.5 text-right font-mono">{Number(row.absentDays).toFixed(1)}</td>
                    <td className="px-2.5 py-1.5 text-right font-mono">{Number(row.attendanceLeaveDays).toFixed(1)}</td>
                    <td className="px-2.5 py-1.5 text-right font-mono">{Number(row.holidayDays).toFixed(1)}</td>
                    <td className="px-2.5 py-1.5 text-right font-mono">{Number(row.weekendDays).toFixed(1)}</td>
                    <td className="px-2.5 py-1.5 text-right font-mono text-emerald-600 dark:text-emerald-400">
                      {Number(row.paidLeaveDays).toFixed(1)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono text-amber-600 dark:text-amber-400">
                      {Number(row.unpaidLeaveDays).toFixed(1)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono font-bold">
                      {Number(row.payableDays).toFixed(1)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono font-bold text-rose-600 dark:text-rose-400">
                      {Number(row.lopDays).toFixed(1)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono">{Number(row.overtimeHours).toFixed(2)}</td>
                    <td className="px-2.5 py-1.5 text-right font-mono">
                      {Number(row.incentiveAmount || 0).toFixed(2)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono">
                      {Number(row.arrearsAmount || 0).toFixed(2)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono">
                      {Number(row.advanceAmount || 0).toFixed(2)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono">
                      {Number(row.loanAmount || 0).toFixed(2)}
                    </td>
                    <td
                      className="max-w-[12rem] truncate px-2.5 py-1.5 text-slate-500"
                      title={row.adjustmentNotes || ''}
                    >
                      {row.adjustmentNotes || '—'}
                    </td>
                    <td className="px-2.5 py-1.5">
                      {canEditPayrollInputs && payrollInputPeriod ? (
                        <button
                          type="button"
                          onClick={() => openPayrollInput(row)}
                          className="cursor-pointer rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                        >
                          Edit
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      {modal === 'ATTENDANCE' && (
        <ModalShell title="Add / update attendance" onClose={() => setModal(null)}>
          <form onSubmit={saveAttendance} className="space-y-3 text-xs">
            <label className="block">
              <span className={labelClass}>Employee *</span>
              <select
                required
                value={attendanceForm.employeeId}
                onChange={(event) => setAttendanceForm({ ...attendanceForm, employeeId: event.target.value })}
                className={inputClass}
              >
                <option value="">Choose an employee</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.employeeCode} — {employee.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={labelClass}>Date *</span>
                <input
                  type="date"
                  required
                  value={attendanceForm.attendanceDateAD}
                  onChange={(event) => setAttendanceForm({ ...attendanceForm, attendanceDateAD: event.target.value })}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Status *</span>
                <select
                  value={attendanceForm.status}
                  onChange={(event) =>
                    setAttendanceForm({ ...attendanceForm, status: event.target.value as HrAttendanceStatus })
                  }
                  className={inputClass}
                >
                  {STATUS_OPTIONS.map((status) => (
                    <option key={status} value={status}>{STATUS_LABEL[status]}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelClass}>Shift</span>
                <select
                  value={attendanceForm.shiftId}
                  onChange={(event) => setAttendanceForm({ ...attendanceForm, shiftId: event.target.value })}
                  className={inputClass}
                >
                  <option value="">No shift</option>
                  {activeShifts.map((shift) => (
                    <option key={shift.id} value={shift.id}>{shift.code} — {shift.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelClass}>OT hours</span>
                <input
                  type="number"
                  min="0"
                  max="24"
                  step="0.25"
                  value={attendanceForm.overtimeHours}
                  onChange={(event) => setAttendanceForm({ ...attendanceForm, overtimeHours: event.target.value })}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Check in</span>
                <input
                  type="time"
                  value={attendanceForm.checkInTime}
                  onChange={(event) => setAttendanceForm({ ...attendanceForm, checkInTime: event.target.value })}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Check out</span>
                <input
                  type="time"
                  value={attendanceForm.checkOutTime}
                  onChange={(event) => setAttendanceForm({ ...attendanceForm, checkOutTime: event.target.value })}
                  className={inputClass}
                />
              </label>
            </div>
            <label className="block">
              <span className={labelClass}>Notes</span>
              <textarea
                rows={2}
                maxLength={500}
                value={attendanceForm.notes}
                onChange={(event) => setAttendanceForm({ ...attendanceForm, notes: event.target.value })}
                className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
              />
            </label>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">
              Saving the same employee and date updates that day instead of creating a duplicate.
            </p>
            <ModalActions saving={saving} onCancel={() => setModal(null)} label="Save day" />
          </form>
        </ModalShell>
      )}

      {modal === 'IMPORT' && (
        <ModalShell title="Import attendance CSV" onClose={() => setModal(null)} wide>
          <form onSubmit={runImport} className="space-y-3 text-xs">
            <label className={`${labelClass} block`}>
              CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (file) setImportCsv(await file.text());
                }}
                className="mt-1 block w-full text-xs"
              />
            </label>
            <label className="block">
              <span className={labelClass}>Or paste the sheet</span>
              <textarea
                rows={7}
                value={importCsv}
                onChange={(event) => setImportCsv(event.target.value)}
                placeholder={'HRMS ID,Date,Status,Shift,Check In,Check Out,OT Hours,Notes\nPAYT-001,2026-09-16,Present,DAY,09:00,18:00,1.0,Imported'}
                className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 font-mono text-[11px] dark:border-slate-700"
              />
            </label>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">
              Required columns: HRMS ID, Date, Status. Unknown employees or shifts, duplicate rows,
              bad dates/statuses and rows outside your branches are skipped with their sheet row number.
              Re-importing the same days updates them.
            </p>
            {importResult && (
              <div className="space-y-2 rounded-lg border border-slate-200 p-2 dark:border-slate-800">
                <div className="flex flex-wrap gap-3 font-semibold">
                  <span>Rows: {importResult.totalRows}</span>
                  <span className="text-emerald-600">Created: {importResult.created}</span>
                  <span className="text-sky-600">Updated: {importResult.updated}</span>
                  <span className="text-rose-600">Skipped: {importResult.skipped}</span>
                </div>
                <div className="max-h-48 overflow-auto">
                  <table className="w-full text-left text-[10px]">
                    <thead className="bg-slate-100 dark:bg-slate-800">
                      <tr>
                        <th className="px-2 py-1">Row</th>
                        <th className="px-2 py-1">Employee</th>
                        <th className="px-2 py-1">Date</th>
                        <th className="px-2 py-1">Action</th>
                        <th className="px-2 py-1">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importResult.rows.slice(0, 200).map((row) => (
                        <tr key={row.rowNumber} className="border-t border-slate-200 dark:border-slate-800">
                          <td className="px-2 py-1 font-mono">{row.rowNumber}</td>
                          <td className="px-2 py-1">{row.employeeCode || '—'}</td>
                          <td className="px-2 py-1 font-mono">{row.attendanceDateAD || '—'}</td>
                          <td className="px-2 py-1 font-bold">{row.action}</td>
                          <td className="px-2 py-1 text-rose-600">{row.errors.join(' ') || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {importResult.rows.length > 200 && (
                  <p className="text-[10px] text-slate-500">Showing the first 200 rows.</p>
                )}
              </div>
            )}
            <ModalActions saving={saving} onCancel={() => setModal(null)} label="Import rows" />
          </form>
        </ModalShell>
      )}

      {modal === 'SHIFT' && (
        <ModalShell title={editingShift ? 'Edit shift' : 'Add shift'} onClose={() => setModal(null)}>
          <form onSubmit={saveShift} className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={labelClass}>Name *</span>
                <input
                  required
                  maxLength={120}
                  value={shiftForm.name}
                  onChange={(event) => setShiftForm({ ...shiftForm, name: event.target.value })}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Code</span>
                <input
                  maxLength={30}
                  value={shiftForm.code}
                  onChange={(event) => setShiftForm({ ...shiftForm, code: event.target.value.toUpperCase() })}
                  placeholder="Derived from name"
                  className={`${inputClass} font-mono`}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Start *</span>
                <input
                  type="time"
                  required
                  value={shiftForm.startTime}
                  onChange={(event) => setShiftForm({ ...shiftForm, startTime: event.target.value })}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelClass}>End *</span>
                <input
                  type="time"
                  required
                  value={shiftForm.endTime}
                  onChange={(event) => setShiftForm({ ...shiftForm, endTime: event.target.value })}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Grace minutes</span>
                <input
                  type="number"
                  min="0"
                  max="240"
                  value={shiftForm.graceMinutes}
                  onChange={(event) => setShiftForm({ ...shiftForm, graceMinutes: event.target.value })}
                  className={inputClass}
                />
              </label>
            </div>
            <label className="flex items-center gap-2 font-semibold">
              <input
                type="checkbox"
                checked={shiftForm.isActive}
                onChange={(event) => setShiftForm({ ...shiftForm, isActive: event.target.checked })}
                className="h-4 w-4"
              />
              Active — offer this shift in the attendance form
            </label>
            <ModalActions saving={saving} onCancel={() => setModal(null)} label={editingShift ? 'Save shift' : 'Add shift'} />
          </form>
        </ModalShell>
      )}

      {modal === 'LEAVE_TYPE' && (
        <ModalShell title={editingLeaveType ? 'Edit leave type' : 'Add leave type'} onClose={() => setModal(null)}>
          <form onSubmit={saveLeaveType} className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={labelClass}>Name *</span>
                <input
                  required
                  maxLength={120}
                  value={leaveTypeForm.name}
                  onChange={(event) => setLeaveTypeForm({ ...leaveTypeForm, name: event.target.value })}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Code</span>
                <input
                  maxLength={30}
                  value={leaveTypeForm.code}
                  onChange={(event) => setLeaveTypeForm({ ...leaveTypeForm, code: event.target.value.toUpperCase() })}
                  placeholder="Derived from name"
                  className={`${inputClass} font-mono`}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Annual quota (days)</span>
                <input
                  type="number"
                  min="0"
                  max="366"
                  step="0.5"
                  value={leaveTypeForm.annualQuotaDays}
                  onChange={(event) => setLeaveTypeForm({ ...leaveTypeForm, annualQuotaDays: event.target.value })}
                  className={inputClass}
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 font-semibold">
                <input
                  type="checkbox"
                  checked={leaveTypeForm.isPaid}
                  onChange={(event) => setLeaveTypeForm({ ...leaveTypeForm, isPaid: event.target.checked })}
                  className="h-4 w-4"
                />
                Paid leave
              </label>
              <label className="flex items-center gap-2 font-semibold">
                <input
                  type="checkbox"
                  checked={leaveTypeForm.isActive}
                  onChange={(event) => setLeaveTypeForm({ ...leaveTypeForm, isActive: event.target.checked })}
                  className="h-4 w-4"
                />
                Active
              </label>
            </div>
            <ModalActions saving={saving} onCancel={() => setModal(null)} label={editingLeaveType ? 'Save leave type' : 'Add leave type'} />
          </form>
        </ModalShell>
      )}

      {modal === 'HOLIDAY' && (
        <ModalShell title="Add holiday" onClose={() => setModal(null)}>
          <form onSubmit={saveHoliday} className="space-y-3 text-xs">
            {isGlobal && (
              <label className="block">
                <span className={labelClass}>Branch *</span>
                <select
                  required
                  value={holidayForm.branchId}
                  onChange={(event) => setHolidayForm({ ...holidayForm, branchId: event.target.value })}
                  className={inputClass}
                >
                  <option value="">Choose a branch</option>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>{branch.name}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={labelClass}>Date *</span>
                <input
                  type="date"
                  required
                  value={holidayForm.holidayDateAD}
                  onChange={(event) => setHolidayForm({ ...holidayForm, holidayDateAD: event.target.value })}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Name *</span>
                <input
                  required
                  maxLength={120}
                  value={holidayForm.name}
                  onChange={(event) => setHolidayForm({ ...holidayForm, name: event.target.value })}
                  className={inputClass}
                />
              </label>
            </div>
            <label className="flex items-center gap-2 font-semibold">
              <input
                type="checkbox"
                checked={holidayForm.isPaid}
                onChange={(event) => setHolidayForm({ ...holidayForm, isPaid: event.target.checked })}
                className="h-4 w-4"
              />
              Paid holiday
            </label>
            <label className="block">
              <span className={labelClass}>Notes</span>
              <textarea
                rows={2}
                maxLength={500}
                value={holidayForm.notes}
                onChange={(event) => setHolidayForm({ ...holidayForm, notes: event.target.value })}
                className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
              />
            </label>
            <ModalActions saving={saving} onCancel={() => setModal(null)} label="Add holiday" />
          </form>
        </ModalShell>
      )}

      {modal === 'LEAVE_REQUEST' && (
        <ModalShell title="New leave request" onClose={() => setModal(null)}>
          <form onSubmit={saveLeaveRequest} className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={labelClass}>Employee *</span>
                <select
                  required
                  value={leaveRequestForm.employeeId}
                  onChange={(event) =>
                    setLeaveRequestForm({ ...leaveRequestForm, employeeId: event.target.value })
                  }
                  className={inputClass}
                >
                  <option value="">Choose an employee</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.employeeCode} — {employee.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelClass}>Leave type *</span>
                <select
                  required
                  value={leaveRequestForm.leaveTypeId}
                  onChange={(event) =>
                    setLeaveRequestForm({ ...leaveRequestForm, leaveTypeId: event.target.value })
                  }
                  className={inputClass}
                >
                  <option value="">Choose a leave type</option>
                  {activeLeaveTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.code} — {type.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelClass}>Start date *</span>
                <input
                  type="date"
                  required
                  value={leaveRequestForm.startDateAD}
                  onChange={(event) =>
                    setLeaveRequestForm({ ...leaveRequestForm, startDateAD: event.target.value })
                  }
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelClass}>End date *</span>
                <input
                  type="date"
                  required
                  value={leaveRequestForm.endDateAD}
                  onChange={(event) =>
                    setLeaveRequestForm({ ...leaveRequestForm, endDateAD: event.target.value })
                  }
                  className={inputClass}
                />
              </label>
            </div>
            <label className="block">
              <span className={labelClass}>Reason</span>
              <textarea
                rows={2}
                maxLength={500}
                value={leaveRequestForm.reason}
                onChange={(event) =>
                  setLeaveRequestForm({ ...leaveRequestForm, reason: event.target.value })
                }
                className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
              />
            </label>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">
              Days are inclusive and the request must stay inside one calendar year. A request
              cannot overlap another pending or approved request; approval spends the employee's
              balance for that leave type and year.
            </p>
            <ModalActions saving={saving} onCancel={() => setModal(null)} label="Submit request" />
          </form>
        </ModalShell>
      )}

      {modal === 'PAYROLL_INPUT' && editingPayrollInput && (
        <ModalShell title="Payroll adjustments" onClose={() => setModal(null)}>
          <form onSubmit={savePayrollInput} className="space-y-3 text-xs">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
              <div className="font-semibold text-slate-700 dark:text-slate-200">
                {payrollInputForm.employeeName}
              </div>
              <div className="font-mono text-[10px] text-slate-500">
                {payrollInputForm.employeeCode} · {payrollInputForm.periodKey}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                ['incentiveAmount', 'Incentive (NPR)'],
                ['arrearsAmount', 'Arrears (NPR)'],
                ['advanceAmount', 'Advance recovery (NPR)'],
                ['loanAmount', 'Loan installment (NPR)'],
              ].map(([field, label]) => (
                <label key={field} className="block">
                  <span className={labelClass}>{label}</span>
                  <input
                    type="number"
                    min="0"
                    max="100000000"
                    step="0.01"
                    value={payrollInputForm[field as keyof PayrollInputForm]}
                    onChange={(event) =>
                      setPayrollInputForm({ ...payrollInputForm, [field]: event.target.value })
                    }
                    className={inputClass}
                  />
                </label>
              ))}
            </div>
            <label className="block">
              <span className={labelClass}>Notes</span>
              <textarea
                rows={2}
                maxLength={500}
                value={payrollInputForm.notes}
                onChange={(event) =>
                  setPayrollInputForm({ ...payrollInputForm, notes: event.target.value })
                }
                className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
              />
            </label>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">
              Incentives and arrears add to gross and taxable pay; advance and loan recoveries
              reduce net only. A generated run keeps the values it snapshotted.
            </p>
            <ModalActions
              saving={saving}
              onCancel={() => setModal(null)}
              label="Save adjustments"
            />
          </form>
        </ModalShell>
      )}

      {modal === 'BALANCE' && (
        <ModalShell
          title={editingBalance ? 'Edit leave balance' : 'Add leave balance'}
          onClose={() => setModal(null)}
        >
          <form onSubmit={saveBalance} className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={labelClass}>Employee *</span>
                <select
                  required
                  disabled={Boolean(editingBalance)}
                  value={balanceForm.employeeId}
                  onChange={(event) =>
                    setBalanceForm({ ...balanceForm, employeeId: event.target.value })
                  }
                  className={`${inputClass} disabled:opacity-60`}
                >
                  <option value="">Choose an employee</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.employeeCode} — {employee.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelClass}>Leave type *</span>
                <select
                  required
                  disabled={Boolean(editingBalance)}
                  value={balanceForm.leaveTypeId}
                  onChange={(event) =>
                    setBalanceForm({ ...balanceForm, leaveTypeId: event.target.value })
                  }
                  className={`${inputClass} disabled:opacity-60`}
                >
                  <option value="">Choose a leave type</option>
                  {leaveTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.code} — {type.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelClass}>Year *</span>
                <input
                  type="number"
                  required
                  min="2000"
                  max="2100"
                  disabled={Boolean(editingBalance)}
                  value={balanceForm.balanceYear}
                  onChange={(event) =>
                    setBalanceForm({ ...balanceForm, balanceYear: event.target.value })
                  }
                  className={`${inputClass} disabled:opacity-60`}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Entitlement days *</span>
                <input
                  type="number"
                  required
                  min="0"
                  max="366"
                  step="0.5"
                  value={balanceForm.entitlementDays}
                  onChange={(event) =>
                    setBalanceForm({ ...balanceForm, entitlementDays: event.target.value })
                  }
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Adjustment days</span>
                <input
                  type="number"
                  min="-366"
                  max="366"
                  step="0.5"
                  value={balanceForm.adjustmentDays}
                  onChange={(event) =>
                    setBalanceForm({ ...balanceForm, adjustmentDays: event.target.value })
                  }
                  className={inputClass}
                />
              </label>
            </div>
            <label className="block">
              <span className={labelClass}>Notes</span>
              <textarea
                rows={2}
                maxLength={500}
                value={balanceForm.notes}
                onChange={(event) => setBalanceForm({ ...balanceForm, notes: event.target.value })}
                className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
              />
            </label>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">
              One row per employee, leave type and year. Used days are derived from approved
              requests, so cancelling or rejecting a request returns the days automatically.
            </p>
            <ModalActions
              saving={saving}
              onCancel={() => setModal(null)}
              label={editingBalance ? 'Save balance' : 'Add balance'}
            />
          </form>
        </ModalShell>
      )}
    </div>
  );
};

const ModalShell: React.FC<{
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}> = ({ title, onClose, wide, children }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
    <ModalPanel
      label={title}
      onClose={onClose}
      className={`w-full ${wide ? 'max-w-4xl' : 'max-w-xl'} rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white`}
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-bold">{title}</h3>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {children}
    </ModalPanel>
  </div>
);

const ModalActions: React.FC<{
  saving: boolean;
  onCancel: () => void;
  label: string;
}> = ({ saving, onCancel, label }) => (
  <div className="flex justify-end gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
    <button
      type="button"
      onClick={onCancel}
      className="cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      Close
    </button>
    <button
      type="submit"
      disabled={saving}
      className="cursor-pointer rounded-xl bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {saving ? 'Saving…' : label}
    </button>
  </div>
);

export default AttendanceLeave;
