/**
 * People & HR workforce report — headcount, separations and leave liability.
 *
 * One read-only endpoint serves the report screen:
 *   GET /api/hr/reports/workforce?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
 *
 * The employee, user and tenant are never accepted from the caller. The branch
 * scope is re-derived from the authenticated session, `branchId=ALL` is refused,
 * and every unrecognised or repeated filter is refused rather than ignored.
 *
 * Attrition is computed from the stored `employees.separation_date_ad`; current
 * `is_active` and mutable `updated_at` are never used as exit dates. The rate
 * denominator is the period-start headcount among employees with a recorded
 * joining date, and the rate is null with a reason when that baseline is
 * incomplete. Headcount is current active employees; leave liability is the
 * current calendar year's remaining DAYS (not money) for active employees, with
 * approved-request usage derived from the same ledger the leave screen uses.
 */
import type { Response } from 'express';
import { getPgConnected, pgPool } from '../app';
import { ApiError } from '../errors/ApiError';
import { getUserFromReq } from '../middleware/auth';
import { allowedBranchScope } from '../middleware/branchScope';
import {
  HR_REPORTS_ATTRITION_BY_BRANCH_SQL,
  HR_REPORTS_BALANCE_YEAR_SQL,
  HR_REPORTS_HEADCOUNT_SQL,
  HR_REPORTS_LEAVE_LIABILITY_SQL,
  HR_REPORTS_OVERTIME_BY_EMPLOYEE_SQL,
  HR_REPORTS_PAYROLL_COST_BY_BRANCH_SQL,
  HR_REPORTS_PAYROLL_COST_BY_PERIOD_SQL,
  HR_REPORTS_SSF_BY_EMPLOYEE_SQL,
  HR_REPORTS_SSF_RECONCILIATION_SQL,
  HR_REPORTS_STATUTORY_BY_PERIOD_SQL,
} from '../models/hrReports.repo';
import { buildSsfReconciliation } from '../services/ssfReconciliation.service';

const REPORT_FILTERS = new Set(['branchId', 'dateFrom', 'dateTo']);

function parseIsoDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, `${label} must be a real date in YYYY-MM-DD form.`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new ApiError(400, `${label} must be a real date in YYYY-MM-DD form.`);
  }
  return value;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

/**
 * Refuse every selector and unknown key. Repeated query parameters arrive as
 * arrays under Express's parser, so a string type check closes both the
 * `?branchId=A&branchId=B` and `?branchId[]=A` forms.
 */
function readFilters(req: any): { branchId: string | null; dateFrom: string; dateTo: string } {
  const query = req.query || {};
  for (const key of Object.keys(query)) {
    if (!REPORT_FILTERS.has(key)) {
      throw new ApiError(403, `Unknown report filter "${key}" is not allowed.`);
    }
  }
  for (const key of REPORT_FILTERS) {
    const value = query[key];
    if (value !== undefined && typeof value !== 'string') {
      throw new ApiError(403, `Repeated or structured report filter "${key}" is not allowed.`);
    }
  }

  const rawBranch = query.branchId;
  if (rawBranch === 'ALL') {
    throw new ApiError(403, 'Forbidden: reports do not widen to all branches by name.');
  }

  const today = isoDate(new Date());
  const dateTo = query.dateTo === undefined ? today : parseIsoDate(query.dateTo, 'dateTo');
  const dateFrom =
    query.dateFrom === undefined ? shiftDays(dateTo, -364) : parseIsoDate(query.dateFrom, 'dateFrom');
  if (dateFrom > dateTo) {
    throw new ApiError(400, 'dateFrom must be on or before dateTo.');
  }

  return { branchId: rawBranch || null, dateFrom, dateTo };
}

interface ReportScope {
  branchIds: string[] | null;
  branchId: string | null;
}

/** Re-derive the report scope from the session; no client tenant can widen it. */
function readScope(req: any, requestedBranch: string | null): ReportScope {
  const user = getUserFromReq(req);
  if (!user || !user.id) throw new ApiError(401, 'Unauthorized: Authentication required');

  const allowed = allowedBranchScope(user);
  if (allowed === null) {
    return { branchIds: requestedBranch ? [requestedBranch] : null, branchId: requestedBranch };
  }
  if (allowed.size === 0) {
    return { branchIds: [], branchId: null };
  }
  if (requestedBranch && !allowed.has(requestedBranch)) {
    throw new ApiError(403, 'Forbidden: this account is not authorized for the requested branch.');
  }
  if (requestedBranch) {
    return { branchIds: [requestedBranch], branchId: requestedBranch };
  }
  if (allowed.size === 1) {
    const only = [...allowed][0];
    return { branchIds: [only], branchId: only };
  }
  return { branchIds: [...allowed], branchId: null };
}

function num(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

/** GET /api/hr/reports/workforce — session-scoped workforce aggregates. */
export async function get_hrWorkforceReport(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');

  const filters = readFilters(req);
  const scope = readScope(req, filters.branchId);

  const [headcountResult, leaveResult, yearResult, attritionResult] = await Promise.all([
    pgPool.query(HR_REPORTS_HEADCOUNT_SQL, [scope.branchIds]),
    pgPool.query(HR_REPORTS_LEAVE_LIABILITY_SQL, [scope.branchIds]),
    pgPool.query(HR_REPORTS_BALANCE_YEAR_SQL),
    pgPool.query(HR_REPORTS_ATTRITION_BY_BRANCH_SQL, [
      filters.dateFrom,
      filters.dateTo,
      scope.branchIds,
    ]),
  ]);

  const branchMap = new Map<string, { branchId: string; branchName: string; count: number }>();
  const departmentMap = new Map<string, number>();
  let headcountTotal = 0;
  for (const row of headcountResult.rows) {
    const count = Number(row.count ?? 0);
    headcountTotal += count;
    const branchId = String(row.branchId);
    const branch = branchMap.get(branchId);
    if (branch) branch.count += count;
    else {
      branchMap.set(branchId, {
        branchId,
        branchName: String(row.branchName || branchId),
        count,
      });
    }
    const department = String(row.department || 'Unassigned');
    departmentMap.set(department, (departmentMap.get(department) || 0) + count);
  }

  const leaveByType = leaveResult.rows.map((row: any) => ({
    leaveTypeId: String(row.leaveTypeId),
    leaveTypeCode: String(row.leaveTypeCode),
    leaveTypeName: String(row.leaveTypeName),
    leaveTypePaid: Boolean(row.leaveTypePaid),
    employeeCount: Number(row.employeeCount ?? 0),
    entitlementDays: num(row.entitlementDays),
    adjustmentDays: num(row.adjustmentDays),
    usedDays: num(row.usedDays),
    remainingDays: num(row.remainingDays),
  }));
  const attritionByBranch = attritionResult.rows.map((row: any) => {
    const separations = Number(row.separations ?? 0);
    const headcountAtStart = Number(row.headcountAtStart ?? 0);
    const unknownJoiningCount = Number(row.unknownJoiningCount ?? 0);
    return {
      branchId: String(row.branchId),
      branchName: String(row.branchName || row.branchId),
      separations,
      headcountAtStart,
      unknownJoiningCount,
      ratePercent:
        headcountAtStart > 0 && unknownJoiningCount === 0
          ? num((separations / headcountAtStart) * 100)
          : null,
    };
  });
  const attritionTotals = attritionByBranch.reduce(
    (totals: any, row: any) => {
      totals.separations += row.separations;
      totals.headcountAtStart += row.headcountAtStart;
      totals.unknownJoiningCount += row.unknownJoiningCount;
      return totals;
    },
    { separations: 0, headcountAtStart: 0, unknownJoiningCount: 0 }
  );
  let attritionReason: string | null = null;
  if (attritionTotals.unknownJoiningCount > 0) {
    attritionReason = `${attritionTotals.unknownJoiningCount} employee${
      attritionTotals.unknownJoiningCount === 1 ? '' : 's'
    } in scope ${
      attritionTotals.unknownJoiningCount === 1 ? 'has' : 'have'
    } no joining date, so the period-start headcount is incomplete; only the separation count is reported.`;
  } else if (attritionTotals.headcountAtStart === 0) {
    attritionReason =
      'No employees with a recorded joining date were employed at the start of the period, so an attrition rate cannot be calculated.';
  }

  const leaveTotals = leaveByType.reduce(
    (
      totals: {
        entitlementDays: number;
        adjustmentDays: number;
        usedDays: number;
        remainingDays: number;
      },
      row: {
        entitlementDays: number;
        adjustmentDays: number;
        usedDays: number;
        remainingDays: number;
      }
    ) => {
      totals.entitlementDays += row.entitlementDays;
      totals.adjustmentDays += row.adjustmentDays;
      totals.usedDays += row.usedDays;
      totals.remainingDays += row.remainingDays;
      return totals;
    },
    { entitlementDays: 0, adjustmentDays: 0, usedDays: 0, remainingDays: 0 }
  );

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    period: { fromAD: filters.dateFrom, toAD: filters.dateTo },
    asOf: isoDate(new Date()),
    scope: { branchId: scope.branchId },
    headcount: {
      total: headcountTotal,
      byBranch: [...branchMap.values()],
      byDepartment: [...departmentMap.entries()]
        .map(([department, count]) => ({ department, count }))
        .sort((a, b) => b.count - a.count || a.department.localeCompare(b.department)),
    },
    attrition: {
      available: true,
      separations: attritionTotals.separations,
      ratePercent:
        attritionTotals.headcountAtStart > 0 && attritionTotals.unknownJoiningCount === 0
          ? num(
              (attritionTotals.separations / attritionTotals.headcountAtStart) * 100
            )
          : null,
      rateBasis: 'PERIOD_START_HEADCOUNT',
      headcountAtStart: attritionTotals.headcountAtStart,
      unknownJoiningCount: attritionTotals.unknownJoiningCount,
      reason: attritionReason,
      byBranch: attritionByBranch,
    },
    leaveLiability: {
      balanceYear: Number(yearResult.rows[0]?.balanceYear ?? new Date().getFullYear()),
      totalEntitlementDays: num(leaveTotals.entitlementDays),
      totalAdjustmentDays: num(leaveTotals.adjustmentDays),
      totalUsedDays: num(leaveTotals.usedDays),
      totalRemainingDays: num(leaveTotals.remainingDays),
      byLeaveType: leaveByType,
    },
  });
}

function payrollCostRow(row: any) {
  return {
    runCount: Number(row.runCount ?? 0),
    lineCount: Number(row.lineCount ?? 0),
    gross: num(row.gross),
    // The employer's SSF share is a company cost the fund is owed, so payroll
    // cost is gross wages plus it — the same total the payroll journal debits
    // to salary expense. It is never withheld from the employee.
    employerSsf: num(row.employerSsf),
    totalCost: num(num(row.gross) + num(row.employerSsf)),
    basic: num(row.basic),
    allowances: num(row.allowances),
    overtime: num(row.overtime),
    incentive: num(row.incentive),
    arrears: num(row.arrears),
    lopDeduction: num(row.lopDeduction),
    deductions: num(row.deductions),
    net: num(row.net),
  };
}

/**
 * GET /api/hr/reports/payroll — payroll cost, overtime and SSF/TDS filing
 * aggregates for the selected period. Every amount comes from an immutable
 * POSTED/PAID `payroll_run_lines` snapshot; draft and approved runs are not
 * committed payroll and are excluded. The endpoint accepts the same strict
 * filters and re-derives the same session branch scope as the workforce read.
 */
export async function get_hrPayrollReport(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');

  const filters = readFilters(req);
  const scope = readScope(req, filters.branchId);

  const [branchResult, periodResult, overtimeResult, statutoryResult, ssfResult, ssfEmployeeResult] =
    await Promise.all([
    pgPool.query(HR_REPORTS_PAYROLL_COST_BY_BRANCH_SQL, [
      filters.dateFrom,
      filters.dateTo,
      scope.branchIds,
    ]),
    pgPool.query(HR_REPORTS_PAYROLL_COST_BY_PERIOD_SQL, [
      filters.dateFrom,
      filters.dateTo,
      scope.branchIds,
    ]),
    pgPool.query(HR_REPORTS_OVERTIME_BY_EMPLOYEE_SQL, [
      filters.dateFrom,
      filters.dateTo,
      scope.branchIds,
    ]),
    pgPool.query(HR_REPORTS_STATUTORY_BY_PERIOD_SQL, [
      filters.dateFrom,
      filters.dateTo,
      scope.branchIds,
    ]),
    pgPool.query(HR_REPORTS_SSF_RECONCILIATION_SQL, [
      filters.dateFrom,
      filters.dateTo,
      scope.branchIds,
    ]),
    pgPool.query(HR_REPORTS_SSF_BY_EMPLOYEE_SQL, [
      filters.dateFrom,
      filters.dateTo,
      scope.branchIds,
    ]),
  ]);

  const payrollByBranch = branchResult.rows.map((row: any) => ({
    branchId: String(row.branchId),
    branchName: String(row.branchName || row.branchId),
    ...payrollCostRow(row),
  }));
  const payrollByPeriod = periodResult.rows.map((row: any) => ({
    periodKey: String(row.periodKey),
    ...payrollCostRow(row),
  }));
  const payrollTotals = payrollByBranch.reduce(
    (totals: any, row: any) => {
      totals.runCount += row.runCount;
      totals.lineCount += row.lineCount;
      for (const key of [
        'gross',
        'employerSsf',
        'totalCost',
        'basic',
        'allowances',
        'overtime',
        'incentive',
        'arrears',
        'lopDeduction',
        'deductions',
        'net',
      ]) {
        totals[key] = num(totals[key] + row[key]);
      }
      return totals;
    },
    {
      runCount: 0,
      lineCount: 0,
      gross: 0,
      employerSsf: 0,
      totalCost: 0,
      basic: 0,
      allowances: 0,
      overtime: 0,
      incentive: 0,
      arrears: 0,
      lopDeduction: 0,
      deductions: 0,
      net: 0,
    }
  );

  const overtimeByEmployee = overtimeResult.rows.map((row: any) => ({
    employeeId: String(row.employeeId),
    employeeCode: String(row.employeeCode),
    employeeName: String(row.employeeName),
    branchId: String(row.branchId),
    branchName: String(row.branchName || row.branchId),
    department: String(row.department || 'Unassigned'),
    runCount: Number(row.runCount ?? 0),
    overtimeHours: num(row.overtimeHours),
    overtimeAmount: num(row.overtimeAmount),
  }));
  const overtimeBranchMap = new Map<string, any>();
  const overtimeDepartmentMap = new Map<string, any>();
  for (const row of overtimeByEmployee) {
    const branch = overtimeBranchMap.get(row.branchId) || {
      branchId: row.branchId,
      branchName: row.branchName,
      employeeCount: 0,
      employeeIds: new Set<string>(),
      overtimeHours: 0,
      overtimeAmount: 0,
    };
    branch.employeeIds.add(row.employeeId);
    branch.employeeCount = branch.employeeIds.size;
    branch.overtimeHours = num(branch.overtimeHours + row.overtimeHours);
    branch.overtimeAmount = num(branch.overtimeAmount + row.overtimeAmount);
    overtimeBranchMap.set(row.branchId, branch);

    const department = overtimeDepartmentMap.get(row.department) || {
      department: row.department,
      employeeCount: 0,
      employeeIds: new Set<string>(),
      overtimeHours: 0,
      overtimeAmount: 0,
    };
    department.employeeIds.add(row.employeeId);
    department.employeeCount = department.employeeIds.size;
    department.overtimeHours = num(department.overtimeHours + row.overtimeHours);
    department.overtimeAmount = num(department.overtimeAmount + row.overtimeAmount);
    overtimeDepartmentMap.set(row.department, department);
  }
  const overtimeByBranch = [...overtimeBranchMap.values()].map((row: any) => {
    const { employeeIds, ...visible } = row;
    return visible;
  });
  const overtimeByDepartment = [...overtimeDepartmentMap.values()]
    .map((row: any) => {
      const { employeeIds, ...visible } = row;
      return visible;
    })
    .sort(
      (a: any, b: any) =>
        b.overtimeHours - a.overtimeHours || a.department.localeCompare(b.department)
    );
  const overtimeTotals = overtimeByEmployee.reduce(
    (totals: any, row: any) => {
      totals.employeeCount += 1;
      totals.overtimeHours = num(totals.overtimeHours + row.overtimeHours);
      totals.overtimeAmount = num(totals.overtimeAmount + row.overtimeAmount);
      return totals;
    },
    { employeeCount: 0, overtimeHours: 0, overtimeAmount: 0 }
  );

  const statutoryByPeriod = statutoryResult.rows.map((row: any) => {
    const employeeSsf = num(row.employeeSsf);
    const employerSsf = num(row.employerSsf);
    return {
      periodKey: String(row.periodKey),
      payslipCount: Number(row.payslipCount ?? 0),
      employeeSsf,
      employerSsf,
      totalSsf: num(employeeSsf + employerSsf),
      tds: num(row.tds),
    };
  });
  const statutoryTotals = statutoryByPeriod.reduce(
    (totals: any, row: any) => {
      totals.payslipCount += row.payslipCount;
      totals.employeeSsf = num(totals.employeeSsf + row.employeeSsf);
      totals.employerSsf = num(totals.employerSsf + row.employerSsf);
      totals.totalSsf = num(totals.totalSsf + row.totalSsf);
      totals.tds = num(totals.tds + row.tds);
      return totals;
    },
    { payslipCount: 0, employeeSsf: 0, employerSsf: 0, totalSsf: 0, tds: 0 }
  );

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    period: { fromAD: filters.dateFrom, toAD: filters.dateTo },
    asOf: isoDate(new Date()),
    scope: { branchId: scope.branchId },
    basis: {
      source: 'payroll_run_lines',
      runStatuses: ['POSTED', 'PAID'],
    },
    payrollCost: {
      available: true,
      totals: payrollTotals,
      byBranch: payrollByBranch,
      byPeriod: payrollByPeriod,
    },
    overtime: {
      available: true,
      totals: overtimeTotals,
      byBranch: overtimeByBranch,
      byDepartment: overtimeByDepartment,
      byEmployee: overtimeByEmployee,
    },
    statutory: {
      available: true,
      totals: statutoryTotals,
      byPeriod: statutoryByPeriod,
    },
    // What the posted runs owe the fund, what the configured rates imply, and
    // what the SSF payable control account carries — tied out for this period.
    ssf: buildSsfReconciliation(ssfResult.rows[0] || {}, ssfEmployeeResult.rows),
  });
}
