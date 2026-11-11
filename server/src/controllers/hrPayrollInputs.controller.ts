/**
 * Phase 1 payroll inputs: payable days, LOP days and overtime hours for an
 * employee over a payroll period, derived from the attendance register and
 * approved leave requests.
 *
 * This is a read-only projection. It uses the same HR read grants as the rest
 * of the attendance/leave surface (`hr-employee-view`, `hr-attendance-manage`
 * or the legacy `gl-payroll-manage` grant) and intersects the caller's allowed
 * branches in SQL; a named employee outside that scope is refused rather than
 * silently returning an empty row. There is no write path here, so no audit
 * row is written: the attendance and leave mutations that feed it already
 * audit in their own transactions.
 *
 * The one model is documented in `hrPayrollInputs.repo.ts`: attendance is the
 * authoritative daily fact, approved leave fills only days without an
 * attendance row (so a day is never counted twice), leave is clipped to the
 * period, and only approved leave contributes days.
 */
import crypto from 'crypto';
import type { Response } from 'express';
import {
  getPgConnected,
  permissionMatrix,
  pgPool,
  userPermissionOverrides,
  userPermissionSetGrants,
} from '../app';
import { effectivePermission } from '../services/permissionOverrides.service';
import { withTransaction } from '../db/transactions';
import { logAuditEvent } from '../services/audit.service';
import { getUserFromReq } from '../middleware/auth';
import { allowedBranchScope } from '../middleware/branchScope';
import { ApiError } from '../errors/ApiError';
import { isAccountingDate } from '../services/accounting.service';
import { HR_ATTENDANCE_EMPLOYEE_BY_ID_SQL } from '../models/hrAttendance.repo';
import {
  HR_PAYROLL_ADJUSTMENT_UPSERT_SQL,
  HR_PAYROLL_INPUT_LIST_SQL,
} from '../models/hrPayrollInputs.repo';

const MAX_PERIOD_DAYS = 366;
const MAX_ADJUSTMENT = 100_000_000;

interface HrBranchScope {
  /** A concrete filter branch; null means all branches (global only). */
  branchId: string | null;
  /** Allowed branches, or null for a global account. */
  allowed: Set<string> | null;
  empty: boolean;
}

function requireDb(): void {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function optionalText(value: unknown, max: number): string | null {
  const parsed = text(value, max);
  return parsed || null;
}

function parseDate(value: unknown, label: string): string {
  const date = text(value, 10);
  if (!date) throw new ApiError(400, `${label} is required.`);
  if (!isAccountingDate(date)) {
    throw new ApiError(400, `${label} must be a real date in YYYY-MM-DD form.`);
  }
  return date;
}

function parsePeriodKey(value: unknown): string {
  const periodKey = text(value, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)) {
    throw new ApiError(400, 'periodKey must be a real month in YYYY-MM form.');
  }
  return periodKey;
}

function adjustmentAmount(value: unknown, label: string): number {
  if (value === undefined || value === null || value === '') return 0;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_ADJUSTMENT) {
    throw new ApiError(400, `${label} must be between 0 and ${MAX_ADJUSTMENT}.`);
  }
  return Math.round(amount * 100) / 100;
}

/** Payroll inputs are HR preparation data; attendance-manage alone is not enough. */
function requireInputManage(req: any): void {
  const user = req.user || getUserFromReq(req);
  const allowed =
    effectivePermission(
      user,
      'hr-employee-manage',
      permissionMatrix,
      userPermissionOverrides,
      userPermissionSetGrants
    ) ||
    effectivePermission(
      user,
      'gl-payroll-manage',
      permissionMatrix,
      userPermissionOverrides,
      userPermissionSetGrants
    );
  if (!allowed) {
    throw new ApiError(403, 'Payroll inputs require the HR employee-manage permission.');
  }
}

/** Inclusive calendar-day count; both dates are already validated. */
function inclusiveDays(startAD: string, endAD: string): number {
  const start = Date.UTC(
    Number(startAD.slice(0, 4)),
    Number(startAD.slice(5, 7)) - 1,
    Number(startAD.slice(8, 10))
  );
  const end = Date.UTC(
    Number(endAD.slice(0, 4)),
    Number(endAD.slice(5, 7)) - 1,
    Number(endAD.slice(8, 10))
  );
  return Math.round((end - start) / 86_400_000) + 1;
}

function readScope(req: any): HrBranchScope {
  const user = req.user || getUserFromReq(req);
  const allowed = allowedBranchScope(user);
  const raw = text(req.query?.branchId, 50);
  if (allowed === null) {
    return { branchId: raw && raw !== 'ALL' ? raw : null, allowed: null, empty: false };
  }
  if (allowed.size === 0) return { branchId: null, allowed, empty: true };
  if (raw === 'ALL') {
    throw new ApiError(403, 'Forbidden: branch users cannot access all branches.');
  }
  if (raw && !allowed.has(raw)) {
    throw new ApiError(403, 'Forbidden: this account is not authorized for the requested branch.');
  }
  return {
    branchId: raw || user.branchId || [...allowed][0],
    allowed,
    empty: false,
  };
}

/** A named employee must exist and be inside the caller's allowed branches. */
async function assertEmployeeReadable(req: any, employeeId: string): Promise<any> {
  const employee = (await pgPool.query(HR_ATTENDANCE_EMPLOYEE_BY_ID_SQL, [employeeId])).rows[0];
  if (!employee) throw new ApiError(404, 'Employee not found.');
  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  if (allowed && !allowed.has(String(employee.branchId))) {
    throw new ApiError(403, 'Forbidden: this employee belongs to another branch.');
  }
  return employee;
}

function inputResponse(row: any): any {
  return {
    ...row,
    presentDays: Number(row.presentDays ?? 0),
    halfDays: Number(row.halfDays ?? 0),
    absentDays: Number(row.absentDays ?? 0),
    attendanceLeaveDays: Number(row.attendanceLeaveDays ?? 0),
    holidayDays: Number(row.holidayDays ?? 0),
    weekendDays: Number(row.weekendDays ?? 0),
    overtimeHours: Number(row.overtimeHours ?? 0),
    incentiveAmount: Number(row.incentiveAmount ?? 0),
    arrearsAmount: Number(row.arrearsAmount ?? 0),
    advanceAmount: Number(row.advanceAmount ?? 0),
    loanAmount: Number(row.loanAmount ?? 0),
    paidLeaveDays: Number(row.paidLeaveDays ?? 0),
    unpaidLeaveDays: Number(row.unpaidLeaveDays ?? 0),
    payableDays: Number(row.payableDays ?? 0),
    lopDays: Number(row.lopDays ?? 0),
  };
}

/**
 * GET /api/hr/payroll-inputs?from=&to=&branchId=&employeeId=
 *
 * `from` and `to` are the payroll period (inclusive AD dates). The period is
 * required and capped at one year; the response has one row per active
 * employee in scope, including employees with no attendance (all zeros).
 */
export async function get_hrPayrollInputs(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = readScope(req);
  if (scope.empty) return res.json([]);

  const from = parseDate(req.query?.from, 'from');
  const to = parseDate(req.query?.to, 'to');
  if (from > to) throw new ApiError(400, 'from must not be after to.');
  if (inclusiveDays(from, to) > MAX_PERIOD_DAYS) {
    throw new ApiError(400, `A payroll period may cover at most ${MAX_PERIOD_DAYS} days.`);
  }

  const employeeId = optionalText(req.query?.employeeId, 50);
  if (employeeId) await assertEmployeeReadable(req, employeeId);

  // Adjustments are monthly. A range that spans months still returns the
  // attendance projection, but exposes no single month's editable inputs.
  const adjustmentPeriodKey = from.slice(0, 7) === to.slice(0, 7) ? from.slice(0, 7) : null;
  const rows = (
    await pgPool.query(HR_PAYROLL_INPUT_LIST_SQL, [
      from,
      to,
      scope.branchId,
      scope.allowed ? [...scope.allowed] : null,
      employeeId,
      adjustmentPeriodKey,
    ])
  ).rows;
  return res.json(rows.map(inputResponse));
}

/**
 * PUT /api/hr/payroll-inputs
 * Body: { employeeId, periodKey, incentiveAmount?, arrearsAmount?,
 *         advanceAmount?, loanAmount?, notes? }
 *
 * One row per employee + month. The upsert keeps a correction from stacking a
 * second input row. The branch comes from the employee and the write is
 * audited in the same transaction; the generated run later snapshots these
 * amounts, so editing after preparation does not mutate that run.
 */
export async function put_hrPayrollInput(req: any, res: Response): Promise<any> {
  requireDb();
  requireInputManage(req);
  const employeeId = text(req.body?.employeeId, 50);
  if (!employeeId) throw new ApiError(400, 'An employee is required.');
  const periodKey = parsePeriodKey(req.body?.periodKey);
  const employee = await assertEmployeeReadable(req, employeeId);
  if (!employee.isActive) {
    throw new ApiError(409, 'Payroll inputs can only be set for an active employee.');
  }

  const incentiveAmount = adjustmentAmount(req.body?.incentiveAmount, 'Incentive');
  const arrearsAmount = adjustmentAmount(req.body?.arrearsAmount, 'Arrears');
  const advanceAmount = adjustmentAmount(req.body?.advanceAmount, 'Advance recovery');
  const loanAmount = adjustmentAmount(req.body?.loanAmount, 'Loan installment');
  const notes = optionalText(req.body?.notes, 500);

  const saved = await withTransaction(async (client) => {
    const row = (
      await client.query(HR_PAYROLL_ADJUSTMENT_UPSERT_SQL, [
        `hradj-${crypto.randomUUID()}`,
        employeeId,
        periodKey,
        incentiveAmount,
        arrearsAmount,
        advanceAmount,
        loanAmount,
        notes,
        getUserFromReq(req).email || getUserFromReq(req).name || null,
      ])
    ).rows[0];
    await logAuditEvent(
      req,
      'SET_HR_PAYROLL_INPUT',
      'ACCOUNTING',
      `Set payroll input for ${employee.employeeCode} ${periodKey}: incentive ${incentiveAmount.toFixed(2)}, arrears ${arrearsAmount.toFixed(2)}, advance ${advanceAmount.toFixed(2)}, loan ${loanAmount.toFixed(2)}.`,
      String(employee.branchId),
      client
    );
    return row;
  });

  return res.json({
    ...saved,
    employeeCode: employee.employeeCode,
    employeeName: employee.name,
    branchId: employee.branchId,
    incentiveAmount: Number(saved.incentiveAmount ?? 0),
    arrearsAmount: Number(saved.arrearsAmount ?? 0),
    advanceAmount: Number(saved.advanceAmount ?? 0),
    loanAmount: Number(saved.loanAmount ?? 0),
  });
}
