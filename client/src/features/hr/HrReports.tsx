/**
 * People & HR → HR Reports.
 *
 * Read-only workforce analytics: current active headcount (by branch and
 * department), stored separations over the selected period, current-year leave
 * balances in days, plus payroll cost, overtime and SSF/TDS filing figures from
 * posted payroll run lines. The server derives the branch scope from the
 * session; this screen sends no employee, tenant or branch selector.
 *
 * Separations come only from employees.separation_date_ad. The rate uses the
 * period-start headcount among employees with a recorded joining date and is
 * shown as unavailable when that baseline is incomplete.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Clock,
  FileBarChart,
  Landmark,
  RefreshCw,
  Scale,
  UserMinus,
  Users,
  Wallet,
} from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { useActivationKey } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type {
  HrPayrollReport,
  HrReportDepartmentRow,
  HrReportHeadcountRow,
  HrReportLeaveTypeRow,
  HrReportOvertimeBranchRow,
  HrReportOvertimeDepartmentRow,
  HrReportAttritionBranchRow,
  HrReportOvertimeEmployeeRow,
  HrReportPayrollCostBranchRow,
  HrReportPayrollCostPeriodRow,
  HrReportStatutoryPeriodRow,
  HrWorkforceReport,
} from '../../services/api';
import type { User } from '../../types';
import { formatMoney } from '../../utils/nprFormat';
import { isOperationAllowed } from '../../utils/permissions';

interface HrReportsProps {
  currentUser?: User | null;
}

type PeriodPreset = 'LAST_30_DAYS' | 'LAST_90_DAYS' | 'LAST_12_MONTHS' | 'YEAR_TO_DATE';

const PERIOD_OPTIONS: { value: PeriodPreset; label: string }[] = [
  { value: 'LAST_30_DAYS', label: 'Last 30 days' },
  { value: 'LAST_90_DAYS', label: 'Last 90 days' },
  { value: 'LAST_12_MONTHS', label: 'Last 12 months' },
  { value: 'YEAR_TO_DATE', label: 'Year to date' },
];

const panel =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const errorBox =
  'flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';
const labelClass = 'text-[10px] font-semibold uppercase tracking-wide text-slate-400';
const mutedText = 'text-[10px] text-slate-400';

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function todayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function rangeFor(preset: PeriodPreset): { fromAD: string; toAD: string } {
  const end = todayUTC();
  const start = new Date(end);
  if (preset === 'LAST_30_DAYS') start.setUTCDate(end.getUTCDate() - 29);
  else if (preset === 'LAST_90_DAYS') start.setUTCDate(end.getUTCDate() - 89);
  else if (preset === 'LAST_12_MONTHS') start.setUTCDate(end.getUTCDate() - 364);
  else start.setUTCMonth(0);
  return { fromAD: isoDate(start), toAD: isoDate(end) };
}

const formatDays = (value: number | null | undefined): string => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
};

const SummaryCard: React.FC<{
  label: string;
  value: string | number;
  hint?: string;
  icon: React.ReactNode;
}> = ({ label, value, hint, icon }) => (
  <div className={`${panel} flex items-start justify-between gap-3`}>
    <div>
      <p className={labelClass}>{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100">{value}</p>
      {hint && <p className={`mt-0.5 ${mutedText}`}>{hint}</p>}
    </div>
    <span className="rounded-xl bg-slate-100 p-2 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
      {icon}
    </span>
  </div>
);

const HeadcountTable: React.FC<{ rows: HrReportHeadcountRow[] }> = ({ rows }) => (
  <div className="mt-2 overflow-x-auto">
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
          <th className="px-1 py-2 font-semibold">Branch</th>
          <th className="px-1 py-2 text-right font-semibold">Employees</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.branchId} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
            <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{row.branchName}</td>
            <td className="px-1 py-2 text-right font-medium text-slate-700 dark:text-slate-200">
              {row.count}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const DepartmentTable: React.FC<{ rows: HrReportDepartmentRow[] }> = ({ rows }) => (
  <div className="mt-2 overflow-x-auto">
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
          <th className="px-1 py-2 font-semibold">Department</th>
          <th className="px-1 py-2 text-right font-semibold">Employees</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.department} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
            <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{row.department}</td>
            <td className="px-1 py-2 text-right font-medium text-slate-700 dark:text-slate-200">
              {row.count}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const LeaveTable: React.FC<{ rows: HrReportLeaveTypeRow[] }> = ({ rows }) => (
  <div className="mt-3 overflow-x-auto">
    <table className="w-full min-w-[640px] text-left text-xs">
      <thead>
        <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
          <th className="px-1 py-2 font-semibold">Leave type</th>
          <th className="px-1 py-2 text-right font-semibold">Employees</th>
          <th className="px-1 py-2 text-right font-semibold">Entitled</th>
          <th className="px-1 py-2 text-right font-semibold">Used</th>
          <th className="px-1 py-2 text-right font-semibold">Remaining</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.leaveTypeId}
            className="border-b border-slate-100 last:border-0 dark:border-slate-800"
          >
            <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
              {row.leaveTypeName}
              {!row.leaveTypePaid && <span className={`ml-2 ${mutedText}`}>Unpaid</span>}
            </td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {row.employeeCount}
            </td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatDays(row.entitlementDays)}
            </td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatDays(row.usedDays)}
            </td>
            <td className="px-1 py-2 text-right font-medium text-slate-700 dark:text-slate-200">
              {formatDays(row.remainingDays)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const AttritionTable: React.FC<{ rows: HrReportAttritionBranchRow[] }> = ({ rows }) => (
  <div className="mt-3 overflow-x-auto">
    <table className="w-full min-w-[680px] text-left text-xs">
      <thead>
        <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
          <th className="px-1 py-2 font-semibold">Branch</th>
          <th className="px-1 py-2 text-right font-semibold">Separations</th>
          <th className="px-1 py-2 text-right font-semibold">Headcount at start</th>
          <th className="px-1 py-2 text-right font-semibold">Rate</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.branchId} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
            <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{row.branchName}</td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {row.separations}
            </td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {row.headcountAtStart}
            </td>
            <td className="px-1 py-2 text-right font-medium text-slate-700 dark:text-slate-200">
              {row.ratePercent === null ? '—' : `${formatDays(row.ratePercent)}%`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const PayrollCostBranchTable: React.FC<{ rows: HrReportPayrollCostBranchRow[] }> = ({ rows }) => (
  <div className="mt-2 overflow-x-auto">
    <table className="w-full min-w-[680px] text-left text-xs">
      <thead>
        <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
          <th className="px-1 py-2 font-semibold">Branch</th>
          <th className="px-1 py-2 text-right font-semibold">Runs</th>
          <th className="px-1 py-2 text-right font-semibold">Gross</th>
          <th className="px-1 py-2 text-right font-semibold">Employer SSF</th>
          <th className="px-1 py-2 text-right font-semibold">Allowances</th>
          <th className="px-1 py-2 text-right font-semibold">Deductions</th>
          <th className="px-1 py-2 text-right font-semibold">Net</th>
          <th className="px-1 py-2 text-right font-semibold">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.branchId} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
            <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{row.branchName}</td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">{row.runCount}</td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatMoney(row.gross)}
            </td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatMoney(row.employerSsf)}
            </td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatMoney(row.allowances)}
            </td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatMoney(row.deductions)}
            </td>
            <td className="px-1 py-2 text-right font-medium text-slate-700 dark:text-slate-200">
              {formatMoney(row.net)}
            </td>
            <td className="px-1 py-2 text-right font-semibold text-slate-700 dark:text-slate-200">
              {formatMoney(row.totalCost)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const PayrollCostPeriodTable: React.FC<{ rows: HrReportPayrollCostPeriodRow[] }> = ({ rows }) => (
  <div className="mt-2 overflow-x-auto">
    <table className="w-full min-w-[680px] text-left text-xs">
      <thead>
        <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
          <th className="px-1 py-2 font-semibold">Pay period</th>
          <th className="px-1 py-2 text-right font-semibold">Runs</th>
          <th className="px-1 py-2 text-right font-semibold">Gross</th>
          <th className="px-1 py-2 text-right font-semibold">Employer SSF</th>
          <th className="px-1 py-2 text-right font-semibold">Allowances</th>
          <th className="px-1 py-2 text-right font-semibold">Deductions</th>
          <th className="px-1 py-2 text-right font-semibold">Net</th>
          <th className="px-1 py-2 text-right font-semibold">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.periodKey} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
            <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{row.periodKey}</td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">{row.runCount}</td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatMoney(row.gross)}
            </td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatMoney(row.employerSsf)}
            </td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatMoney(row.allowances)}
            </td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatMoney(row.deductions)}
            </td>
            <td className="px-1 py-2 text-right font-medium text-slate-700 dark:text-slate-200">
              {formatMoney(row.net)}
            </td>
            <td className="px-1 py-2 text-right font-semibold text-slate-700 dark:text-slate-200">
              {formatMoney(row.totalCost)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const OvertimeBranchTable: React.FC<{ rows: HrReportOvertimeBranchRow[] }> = ({ rows }) => (
  <div className="mt-2 overflow-x-auto">
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
          <th className="px-1 py-2 font-semibold">Branch</th>
          <th className="px-1 py-2 text-right font-semibold">Employees</th>
          <th className="px-1 py-2 text-right font-semibold">Hours</th>
          <th className="px-1 py-2 text-right font-semibold">Paid</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.branchId} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
            <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{row.branchName}</td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">{row.employeeCount}</td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatDays(row.overtimeHours)}
            </td>
            <td className="px-1 py-2 text-right font-medium text-slate-700 dark:text-slate-200">
              {formatMoney(row.overtimeAmount)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const OvertimeDepartmentTable: React.FC<{ rows: HrReportOvertimeDepartmentRow[] }> = ({ rows }) => (
  <div className="mt-2 overflow-x-auto">
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
          <th className="px-1 py-2 font-semibold">Department</th>
          <th className="px-1 py-2 text-right font-semibold">Employees</th>
          <th className="px-1 py-2 text-right font-semibold">Hours</th>
          <th className="px-1 py-2 text-right font-semibold">Paid</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.department} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
            <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{row.department}</td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">{row.employeeCount}</td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatDays(row.overtimeHours)}
            </td>
            <td className="px-1 py-2 text-right font-medium text-slate-700 dark:text-slate-200">
              {formatMoney(row.overtimeAmount)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const OvertimeEmployeeTable: React.FC<{ rows: HrReportOvertimeEmployeeRow[] }> = ({ rows }) => (
  <div className="mt-3 overflow-x-auto">
    <table className="w-full min-w-[680px] text-left text-xs">
      <thead>
        <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
          <th className="px-1 py-2 font-semibold">Employee</th>
          <th className="px-1 py-2 font-semibold">Branch</th>
          <th className="px-1 py-2 font-semibold">Department</th>
          <th className="px-1 py-2 text-right font-semibold">Runs</th>
          <th className="px-1 py-2 text-right font-semibold">Hours</th>
          <th className="px-1 py-2 text-right font-semibold">Paid</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.branchId}:${row.employeeId}`} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
            <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
              {row.employeeName} <span className={mutedText}>{row.employeeCode}</span>
            </td>
            <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{row.branchName}</td>
            <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{row.department}</td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">{row.runCount}</td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatDays(row.overtimeHours)}
            </td>
            <td className="px-1 py-2 text-right font-medium text-slate-700 dark:text-slate-200">
              {formatMoney(row.overtimeAmount)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const StatutoryTable: React.FC<{ rows: HrReportStatutoryPeriodRow[] }> = ({ rows }) => (
  <div className="mt-3 overflow-x-auto">
    <table className="w-full min-w-[620px] text-left text-xs">
      <thead>
        <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
          <th className="px-1 py-2 font-semibold">Pay period</th>
          <th className="px-1 py-2 text-right font-semibold">Payslips</th>
          <th className="px-1 py-2 text-right font-semibold">Employee SSF</th>
          <th className="px-1 py-2 text-right font-semibold">Employer SSF</th>
          <th className="px-1 py-2 text-right font-semibold">Total SSF</th>
          <th className="px-1 py-2 text-right font-semibold">TDS withheld</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.periodKey} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
            <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{row.periodKey}</td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">{row.payslipCount}</td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatMoney(row.employeeSsf)}
            </td>
            <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
              {formatMoney(row.employerSsf)}
            </td>
            <td className="px-1 py-2 text-right font-medium text-slate-700 dark:text-slate-200">
              {formatMoney(row.totalSsf)}
            </td>
            <td className="px-1 py-2 text-right font-medium text-slate-700 dark:text-slate-200">
              {formatMoney(row.tds)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const HrReports: React.FC<HrReportsProps> = ({ currentUser }) => {
  const allowed =
    isOperationAllowed('hr-employee-view', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);
  const activationKey = useActivationKey('hr-reports');
  const [preset, setPreset] = useState<PeriodPreset>('LAST_12_MONTHS');
  const [period, setPeriod] = useState(() => rangeFor('LAST_12_MONTHS'));
  const [report, setReport] = useState<HrWorkforceReport | null>(null);
  const [payroll, setPayroll] = useState<HrPayrollReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [nextReport, nextPayroll] = await Promise.all([
        api.getHrWorkforceReport({
          dateFrom: period.fromAD,
          dateTo: period.toAD,
        }),
        api.getHrPayrollReport({
          dateFrom: period.fromAD,
          dateTo: period.toAD,
        }),
      ]);
      setReport(nextReport);
      setPayroll(nextPayroll);
    } catch (err: any) {
      setError(err?.message || 'The HR reports could not be loaded.');
      setReport(null);
      setPayroll(null);
    } finally {
      setLoading(false);
    }
  }, [allowed, period.fromAD, period.toAD]);

  useEffect(() => {
    if (!allowed) return;
    void load();
    // The activation key is the tab-reactivation contract pinned by the source guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, load, activationKey]);

  if (!allowed) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="HR Reports"
          description="Workforce, payroll cost and statutory reports."
          icon={<FileBarChart className="h-5 w-5 text-emerald-500" />}
        />
        <div className={errorBox} role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>You do not have permission to view HR reports.</span>
        </div>
      </div>
    );
  }

  const periodLabel = report
    ? `${report.period.fromAD} to ${report.period.toAD}`
    : `${period.fromAD} to ${period.toAD}`;
  const scopeLabel = report?.scope.branchId
    ? `Branch ${report.scope.branchId}`
    : 'All permitted branches';

  return (
    <div className="space-y-4">
      <PageHeader
        title="HR Reports"
        description="Read-only workforce, payroll cost and statutory reports."
        icon={<FileBarChart className="h-5 w-5 text-emerald-500" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="hr-report-period" className="sr-only">
              Reporting period
            </label>
            <select
              id="hr-report-period"
              aria-label="Reporting period"
              value={preset}
              onChange={(event) => {
                const next = event.target.value as PeriodPreset;
                setPreset(next);
                setPeriod(rangeFor(next));
              }}
              disabled={loading}
              className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
            >
              {PERIOD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              aria-label="Refresh HR report"
              className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <RefreshCw className={`h-3.5 w-3.5 text-slate-400 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        }
      />

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[10px] text-slate-400">
        <span>Reporting period: {periodLabel}</span>
        <span>Scope: {scopeLabel}</span>
        <span>Headcount is current as of {report?.asOf || 'the latest read'}.</span>
      </div>

      {error && (
        <div className={errorBox} role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && (!report || !payroll) ? (
        <section className={panel}>
          <p className="px-1 py-6 text-center text-xs text-slate-400">Loading the HR reports…</p>
        </section>
      ) : !report || !payroll ? (
        <section className={panel}>
          <p className="px-1 py-6 text-center text-xs text-slate-400">
            No report is available for this period.
          </p>
        </section>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard
              label="Active headcount"
              value={report.headcount.total.toLocaleString('en-US')}
              hint="Current active employees"
              icon={<Users className="h-4 w-4" />}
            />
            <SummaryCard
              label="Separations"
              value={report.attrition.separations.toLocaleString('en-US')}
              hint={
                report.attrition.ratePercent === null
                  ? `Rate unavailable · ${periodLabel}`
                  : `${formatDays(report.attrition.ratePercent)}% of period-start headcount`
              }
              icon={<UserMinus className="h-4 w-4" />}
            />
            <SummaryCard
              label="Leave remaining"
              value={`${formatDays(report.leaveLiability.totalRemainingDays)} days`}
              hint={`Balance year ${report.leaveLiability.balanceYear} · current workforce`}
              icon={<Scale className="h-4 w-4" />}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard
              label="Gross payroll"
              value={formatMoney(payroll.payrollCost.totals.gross)}
              hint={`${payroll.payrollCost.totals.runCount} posted/paid run${
                payroll.payrollCost.totals.runCount === 1 ? '' : 's'
              }`}
              icon={<Wallet className="h-4 w-4" />}
            />
            <SummaryCard
              label="Employment cost"
              value={formatMoney(payroll.payrollCost.totals.totalCost)}
              hint={`Gross ${formatMoney(payroll.payrollCost.totals.gross)} + employer SSF ${formatMoney(
                payroll.payrollCost.totals.employerSsf
              )}`}
              icon={<Landmark className="h-4 w-4" />}
            />
            <SummaryCard
              label="Overtime"
              value={`${formatDays(payroll.overtime.totals.overtimeHours)} hrs`}
              hint={`${formatMoney(payroll.overtime.totals.overtimeAmount)} paid`}
              icon={<Clock className="h-4 w-4" />}
            />
            <SummaryCard
              label="SSF + TDS withheld"
              value={formatMoney(
                payroll.statutory.totals.employeeSsf + payroll.statutory.totals.tds
              )}
              hint="Employee SSF and TDS"
              icon={<Landmark className="h-4 w-4" />}
            />
          </div>

          <section className={panel}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  Headcount
                </h3>
                <p className={`mt-0.5 ${mutedText}`}>Current active employees by branch and department.</p>
              </div>
              <span className="text-[10px] text-slate-400">
                {report.headcount.total} active
              </span>
            </div>
            {report.headcount.total === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-slate-400">
                No active employees in this reporting scope.
              </p>
            ) : (
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <div>
                  <p className={labelClass}>By branch</p>
                  <HeadcountTable rows={report.headcount.byBranch} />
                </div>
                <div>
                  <p className={labelClass}>By department</p>
                  <DepartmentTable rows={report.headcount.byDepartment} />
                </div>
              </div>
            )}
          </section>

          <section className={panel}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  Attrition & separations
                </h3>
                <p className={`mt-0.5 ${mutedText}`}>Reporting period: {periodLabel}</p>
              </div>
              <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                Stored separation dates
              </span>
            </div>
            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
              <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
                <p className="text-[10px] uppercase tracking-wide text-slate-400">Separations</p>
                <p className="font-semibold text-slate-700 dark:text-slate-200">
                  {report.attrition.separations}
                </p>
              </div>
              <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
                <p className="text-[10px] uppercase tracking-wide text-slate-400">Attrition rate</p>
                <p className="font-semibold text-slate-700 dark:text-slate-200">
                  {report.attrition.ratePercent === null
                    ? '—'
                    : `${formatDays(report.attrition.ratePercent)}%`}
                </p>
              </div>
              <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
                <p className="text-[10px] uppercase tracking-wide text-slate-400">
                  Headcount at start
                </p>
                <p className="font-semibold text-slate-700 dark:text-slate-200">
                  {report.attrition.headcountAtStart}
                </p>
              </div>
            </div>
            {report.attrition.reason ? (
              <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
                {report.attrition.reason}
              </p>
            ) : null}
            {report.attrition.byBranch.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-slate-400">
                No employees are in this reporting scope.
              </p>
            ) : report.attrition.separations === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-slate-400">
                No separations were recorded in this period.
              </p>
            ) : (
              <AttritionTable rows={report.attrition.byBranch} />
            )}
            <p className={`mt-3 ${mutedText}`}>
              Counts use only the stored separation date; current status and record-edit timestamps
              are never treated as exit dates. The rate is separations divided by the headcount at
              the start of the period.
            </p>
          </section>

          <section className={panel}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  Leave liability
                </h3>
                <p className={`mt-0.5 ${mutedText}`}>
                  Balance year {report.leaveLiability.balanceYear} · active employees · days
                </p>
              </div>
              <span className="text-[10px] text-slate-400">
                {formatDays(report.leaveLiability.totalRemainingDays)} days remaining
              </span>
            </div>
            {report.leaveLiability.byLeaveType.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-slate-400">
                No leave balances are configured for the current year.
              </p>
            ) : (
              <>
                <LeaveTable rows={report.leaveLiability.byLeaveType} />
                <div className="mt-3 grid gap-2 text-[10px] text-slate-400 sm:grid-cols-3">
                  <span>Entitled: {formatDays(report.leaveLiability.totalEntitlementDays)} days</span>
                  <span>Adjustments: {formatDays(report.leaveLiability.totalAdjustmentDays)} days</span>
                  <span>Approved used: {formatDays(report.leaveLiability.totalUsedDays)} days</span>
                </div>
              </>
            )}
            <p className={`mt-3 ${mutedText}`}>
              Leave figures are days, not a monetary value. Used days come from APPROVED requests in
              the displayed balance year; inactive employees are excluded.
            </p>
          </section>

          <section className={panel}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  Payroll cost
                </h3>
                <p className={`mt-0.5 ${mutedText}`}>
                  Posted/paid run-line snapshots · {periodLabel}
                </p>
              </div>
              <span className="text-[10px] text-slate-400">
                {formatMoney(payroll.payrollCost.totals.totalCost)} cost ·{' '}
                {formatMoney(payroll.payrollCost.totals.gross)} gross +{' '}
                {formatMoney(payroll.payrollCost.totals.employerSsf)} employer SSF
              </span>
            </div>
            {payroll.payrollCost.totals.lineCount === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-slate-400">
                No posted payroll runs in this reporting period.
              </p>
            ) : (
              <>
                <div className="mt-3 grid gap-4 xl:grid-cols-2">
                  <div>
                    <p className={labelClass}>By branch</p>
                    <PayrollCostBranchTable rows={payroll.payrollCost.byBranch} />
                  </div>
                  <div>
                    <p className={labelClass}>By pay period</p>
                    <PayrollCostPeriodTable rows={payroll.payrollCost.byPeriod} />
                  </div>
                </div>
                <div className="mt-3 grid gap-2 text-[10px] text-slate-400 sm:grid-cols-2 lg:grid-cols-5">
                  <span>Basic: {formatMoney(payroll.payrollCost.totals.basic)}</span>
                  <span>
                    Overtime: {formatMoney(payroll.payrollCost.totals.overtime)}
                  </span>
                  <span>
                    Employer SSF: {formatMoney(payroll.payrollCost.totals.employerSsf)}
                  </span>
                  <span>Net: {formatMoney(payroll.payrollCost.totals.net)}</span>
                  <span>Cost: {formatMoney(payroll.payrollCost.totals.totalCost)}</span>
                </div>
              </>
            )}
            <p className={`mt-3 ${mutedText}`}>
              Only POSTED/PAID payroll runs are included; drafts and approved runs are not committed
              payroll. Amounts are stored line snapshots, not re-derived from current salary structures.
            </p>
          </section>

          <section className={panel}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  Overtime
                </h3>
                <p className={`mt-0.5 ${mutedText}`}>
                  Hours and paid amount on posted/paid runs · {periodLabel}
                </p>
              </div>
              <span className="text-[10px] text-slate-400">
                {formatDays(payroll.overtime.totals.overtimeHours)} hours
              </span>
            </div>
            {payroll.overtime.byEmployee.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-slate-400">
                No overtime was recorded on posted payroll runs in this period.
              </p>
            ) : (
              <>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <div>
                    <p className={labelClass}>By branch</p>
                    <OvertimeBranchTable rows={payroll.overtime.byBranch} />
                  </div>
                  <div>
                    <p className={labelClass}>By department</p>
                    <OvertimeDepartmentTable rows={payroll.overtime.byDepartment} />
                  </div>
                </div>
                <p className={`mt-4 ${labelClass}`}>By employee</p>
                <OvertimeEmployeeTable rows={payroll.overtime.byEmployee} />
              </>
            )}
            <p className={`mt-3 ${mutedText}`}>
              Hours and pay come from the same payroll line snapshot. Department is the employee's
              current department; payroll lines snapshot employee name and code, not department.
            </p>
          </section>

          <section className={panel}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  SSF payable reconciliation
                </h3>
                <p className={`mt-0.5 ${mutedText}`}>
                  Posted contributions vs the configured rates and the control account · {periodLabel}
                </p>
              </div>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  payroll.ssf.matches === null
                    ? 'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400'
                    : payroll.ssf.matches
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                      : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
                }`}
              >
                {payroll.ssf.matches === null
                  ? 'Not configured'
                  : payroll.ssf.matches
                    ? 'Reconciled'
                    : 'Needs review'}
              </span>
            </div>
            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className={labelClass}>Employee SSF</p>
                <p className="font-medium text-slate-700 dark:text-slate-200">
                  {formatMoney(payroll.ssf.employeeSsf)}
                </p>
              </div>
              <div>
                <p className={labelClass}>Employer SSF</p>
                <p className="font-medium text-slate-700 dark:text-slate-200">
                  {formatMoney(payroll.ssf.employerSsf)}
                </p>
              </div>
              <div>
                <p className={labelClass}>Payable (employee + employer)</p>
                <p className="font-medium text-slate-700 dark:text-slate-200">
                  {formatMoney(payroll.ssf.payable)}
                </p>
              </div>
              <div>
                <p className={labelClass}>Configured contribution</p>
                <p className="font-medium text-slate-700 dark:text-slate-200">
                  {formatMoney(payroll.ssf.configured)}
                </p>
              </div>
            </div>
            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
              <div>
                <p className={labelClass}>Control account</p>
                <p className="font-medium text-slate-700 dark:text-slate-200">
                  {payroll.ssf.controlAccount
                    ? `${payroll.ssf.controlAccount.code} ${payroll.ssf.controlAccount.name}`
                    : '—'}
                </p>
              </div>
              <div>
                <p className={labelClass}>Control balance</p>
                <p className="font-medium text-slate-700 dark:text-slate-200">
                  {payroll.ssf.controlBalance === null
                    ? '—'
                    : formatMoney(payroll.ssf.controlBalance)}
                </p>
              </div>
              <div>
                <p className={labelClass}>Difference</p>
                <p className="font-medium text-slate-700 dark:text-slate-200">
                  {payroll.ssf.difference === null
                    ? '—'
                    : formatMoney(payroll.ssf.difference)}
                </p>
              </div>
            </div>
            {payroll.ssf.byEmployee.length > 0 && (
              <>
                <p className={`mt-4 ${labelClass}`}>SSF payable by employee</p>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
                        <th className="px-1 py-2 font-semibold">Employee</th>
                        <th className="px-1 py-2 font-semibold">Code</th>
                        <th className="px-1 py-2 text-right font-semibold">Employee SSF</th>
                        <th className="px-1 py-2 text-right font-semibold">Employer SSF</th>
                        <th className="px-1 py-2 text-right font-semibold">Payable</th>
                        <th className="px-1 py-2 text-right font-semibold">Configured</th>
                        <th className="px-1 py-2 text-right font-semibold">Control</th>
                        <th className="px-1 py-2 text-right font-semibold">Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payroll.ssf.byEmployee.map((row) => (
                        <tr
                          key={`${row.employeeId}-${row.branchId}`}
                          className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                        >
                          <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                            {row.employeeName}
                            <span className="block text-[10px] text-slate-400">{row.branchName}</span>
                          </td>
                          <td className="px-1 py-2 font-mono text-slate-500 dark:text-slate-400">
                            {row.employeeCode}
                          </td>
                          <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
                            {formatMoney(row.employeeSsf)}
                          </td>
                          <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
                            {formatMoney(row.employerSsf)}
                          </td>
                          <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
                            {formatMoney(row.payable)}
                          </td>
                          <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
                            {formatMoney(row.configured)}
                          </td>
                          <td className="px-1 py-2 text-right text-slate-600 dark:text-slate-300">
                            {formatMoney(row.controlBalance)}
                          </td>
                          <td
                            className={`px-1 py-2 text-right font-semibold ${
                              row.matches
                                ? 'text-slate-700 dark:text-slate-200'
                                : 'text-amber-700 dark:text-amber-300'
                            }`}
                          >
                            {formatMoney(row.difference)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {payroll.ssf.unattributedControl !== null &&
                  payroll.ssf.unattributedControl !== 0 && (
                    <p className="mt-2 text-[10px] text-amber-700 dark:text-amber-300">
                      Unattributed control balance:{' '}
                      {formatMoney(payroll.ssf.unattributedControl)} — posted to SSF payable without
                      an employee party, so no row above claims it.
                    </p>
                  )}
              </>
            )}
            {payroll.ssf.reason && (
              <p className="mt-3 text-[10px] text-amber-700 dark:text-amber-300">{payroll.ssf.reason}</p>
            )}
            {payroll.ssf.rateNote && (
              <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400">
                {payroll.ssf.rateNote}
              </p>
            )}
            <p className={`mt-3 ${mutedText}`}>
              Employee and employer SSF are credited to SSF payable when a run is posted. The control
              balance is that account's credits less debits for POSTED journals in this period and branch
              scope; the configured contribution applies each run's own SSF rates to basic pay.
            </p>
          </section>

          <section className={panel}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  SSF & TDS filing
                </h3>
                <p className={`mt-0.5 ${mutedText}`}>
                  Employee/employer SSF and TDS withheld per pay period
                </p>
              </div>
              <span className="text-[10px] text-slate-400">
                {formatMoney(payroll.statutory.totals.totalSsf)} total SSF
              </span>
            </div>
            {payroll.statutory.byPeriod.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-slate-400">
                No SSF or TDS was withheld on posted payroll runs in this period.
              </p>
            ) : (
              <>
                <StatutoryTable rows={payroll.statutory.byPeriod} />
                <div className="mt-3 grid gap-2 text-[10px] text-slate-400 sm:grid-cols-3">
                  <span>
                    Employee SSF: {formatMoney(payroll.statutory.totals.employeeSsf)}
                  </span>
                  <span>
                    Employer SSF: {formatMoney(payroll.statutory.totals.employerSsf)}
                  </span>
                  <span>TDS withheld: {formatMoney(payroll.statutory.totals.tds)}</span>
                </div>
              </>
            )}
            <p className={`mt-3 ${mutedText}`}>
              Figures are the SSF and TDS columns stored on posted/paid payroll run lines. The
              employer SSF share is reported separately and is not deducted from employee net pay.
            </p>
          </section>
        </>
      )}
    </div>
  );
};

export default HrReports;
