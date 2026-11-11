/**
 * Employee self-service — the signed-in employee's own profile and posted
 * payslips.
 *
 * Both reads are keyed by `employees.user_id`, never by an employee id the
 * caller supplies, and both are read-only. The profile uses the dedicated
 * own-profile projection; payslips are derived from immutable
 * `payroll_run_lines` snapshots and only POSTED/PAID runs are visible. A
 * caller cannot name another employee, login account or branch: every such
 * selector is refused instead of being ignored, so a future edit cannot
 * silently turn the endpoint into a company-wide read.
 *
 * The route gate and the controller check are both `hr-self-service`, which is
 * separate from the Finance `gl-view` grant. Branch scope is re-derived from
 * the session even though the lookup starts at the user id, so an employee
 * linked to a branch the account may no longer act on is refused.
 */
import type { Response } from 'express';
import {
  getPgConnected,
  permissionMatrix,
  pgPool,
  userPermissionOverrides,
  userPermissionSetGrants,
} from '../app';
import { effectivePermission } from '../services/permissionOverrides.service';
import { buildPayrollOutput } from '../services/payrollOutput.service';
import { getUserFromReq } from '../middleware/auth';
import { allowedBranchScope } from '../middleware/branchScope';
import { ApiError } from '../errors/ApiError';
import {
  HR_SELF_ATTENDANCE_SQL,
  HR_SELF_ATTENDANCE_WINDOW_DAYS,
  HR_SELF_ATTENDANCE_WINDOW_SQL,
  HR_SELF_DOCUMENTS_SQL,
  HR_SELF_DOCUMENT_EXPIRY_SOON_DAYS,
  HR_SELF_LEAVE_BALANCES_SQL,
  HR_SELF_LEAVE_REQUESTS_SQL,
  HR_SELF_PAYSLIPS_SQL,
  HR_SELF_PROFILE_SQL,
} from '../models/hrSelfService.repo';

function holdsPermission(req: any, operation: string): boolean {
  const user = req.user || getUserFromReq(req);
  return effectivePermission(
    user,
    operation,
    permissionMatrix,
    userPermissionOverrides,
    userPermissionSetGrants
  );
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Authentication, database readiness and the ESS grant, in that order. */
function requireSelfService(req: any): any {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');

  const user = getUserFromReq(req);
  if (!user || !user.id) throw new ApiError(401, 'Unauthorized: Authentication required');

  if (!holdsPermission(req, 'hr-self-service')) {
    throw new ApiError(403, 'Self-service requires the hr-self-service permission.');
  }
  return user;
}

/**
 * Resolve the caller's own employee and reject every selector that could name
 * a different record. `branchId=ALL` and another branch are refused; naming
 * the caller's own branch is allowed as a redundant filter.
 */
async function resolveOwnEmployee(req: any, user: any): Promise<any> {
  for (const selector of ['employeeId', 'userId', 'user_id']) {
    if (req.query?.[selector] !== undefined) {
      throw new ApiError(
        403,
        'Self-service always returns the signed-in employee; employee and user selectors are refused.'
      );
    }
  }

  const rawBranch = req.query?.branchId;
  if (rawBranch !== undefined && typeof rawBranch !== 'string') {
    throw new ApiError(403, 'Forbidden: self-service accepts at most one branch filter.');
  }
  const requestedBranch = text(rawBranch, 50);
  if (requestedBranch === 'ALL') {
    throw new ApiError(403, 'Forbidden: self-service does not widen to all branches.');
  }

  const employee = (await pgPool.query(HR_SELF_PROFILE_SQL, [user.id])).rows[0];
  if (!employee) throw new ApiError(404, 'No employee record is linked to this account.');

  const branchId = String(employee.branchId);
  if (requestedBranch && requestedBranch !== branchId) {
    throw new ApiError(403, 'Forbidden: this profile belongs to another branch.');
  }
  const allowed = allowedBranchScope(user);
  if (allowed && !allowed.has(branchId)) {
    throw new ApiError(403, 'Forbidden: this profile belongs to another branch.');
  }
  return employee;
}

/** Shape one stored run-line snapshot into the same payslip the run UI uses. */
function payslipFromLine(row: any, employee: any) {
  const run = {
    branchId: String(row.runBranchId),
    branchName: row.branchName || String(row.runBranchId),
    fiscalYearCode: row.fiscalYearCode || null,
    runNo: String(row.runNo),
    periodKey: String(row.runPeriodKey || row.periodKey),
    runDateAD: String(row.runDateAD),
    runDateBS: row.runDateBS || null,
    paidDateAD: row.paidDateAD || null,
    paymentMethod: row.paymentMethod || null,
    status: String(row.status),
  };
  return buildPayrollOutput(run, [row], [employee], true).payslips[0];
}

/** GET /api/hr/self-service/profile — the caller's own employee record. */
export async function get_hrSelfServiceProfile(req: any, res: Response): Promise<any> {
  const user = requireSelfService(req);
  const employee = await resolveOwnEmployee(req, user);

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(employee);
}

/**
 * GET /api/hr/self-service/payslips — the caller's own POSTED/PAID payslips.
 *
 * The list is derived from the immutable run-line snapshots, newest first. It
 * is deliberately not a run endpoint: there is no run id in the path, and the
 * SQL joins through `employees.user_id`, so a caller cannot ask for a run's
 * other employees. Draft and approved runs never enter the result.
 */
export async function get_hrSelfServicePayslips(req: any, res: Response): Promise<any> {
  const user = requireSelfService(req);
  const employee = await resolveOwnEmployee(req, user);
  const rows = (await pgPool.query(HR_SELF_PAYSLIPS_SQL, [user.id])).rows;
  const payslips = rows.map((row: any) => payslipFromLine(row, employee));

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ payslips });
}

/**
 * GET /api/hr/self-service/leave — the caller's own leave balances and request
 * history. Read-only by design: there is no apply, cancel or approve path on
 * self-service, and both reads are keyed by `employees.user_id`.
 */
export async function get_hrSelfServiceLeave(req: any, res: Response): Promise<any> {
  const user = requireSelfService(req);
  await resolveOwnEmployee(req, user);
  const [balanceRows, requestRows] = await Promise.all([
    pgPool.query(HR_SELF_LEAVE_BALANCES_SQL, [user.id]),
    pgPool.query(HR_SELF_LEAVE_REQUESTS_SQL, [user.id]),
  ]);
  const balances = balanceRows.rows.map((row: any) => ({
    ...row,
    entitlementDays: Number(row.entitlementDays ?? 0),
    adjustmentDays: Number(row.adjustmentDays ?? 0),
    usedDays: Number(row.usedDays ?? 0),
    remainingDays: Number(row.remainingDays ?? 0),
  }));
  const requests = requestRows.rows.map((row: any) => ({
    ...row,
    daysCount: Number(row.daysCount ?? 0),
  }));

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ balances, requests });
}

/**
 * GET /api/hr/self-service/documents — the caller's own document metadata.
 *
 * The vault has no issue-date column, so `issuedOnAD` is an explicit null and
 * the upload timestamp is returned separately. Downloads stay on the existing
 * authenticated content route, which repeats the own-record check; this
 * endpoint only builds its relative URL. No upload, replace, delete, submit or
 * approval path is exposed here.
 */
export async function get_hrSelfServiceDocuments(req: any, res: Response): Promise<any> {
  const user = requireSelfService(req);
  const employee = await resolveOwnEmployee(req, user);

  for (const selector of ['documentId', 'documentIds', 'document_ids']) {
    if (req.query?.[selector] !== undefined) {
      throw new ApiError(
        403,
        'Self-service always returns all of your documents; document-id selectors are refused.'
      );
    }
  }

  const rows = (await pgPool.query(HR_SELF_DOCUMENTS_SQL, [user.id])).rows;
  const summary = { totalDocuments: rows.length, expiringSoon: 0, expiredDocuments: 0 };
  const documents = rows.map((row: any) => {
    if (row.expiryStatus === 'EXPIRING') summary.expiringSoon += 1;
    if (row.expiryStatus === 'EXPIRED') summary.expiredDocuments += 1;
    return {
      ...row,
      byteSize: Number(row.byteSize ?? 0),
      issuedOnAD: null,
      contentUrl: `/api/employees/${encodeURIComponent(employee.id)}/documents/${encodeURIComponent(
        row.id
      )}/content`,
    };
  });

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    expirySoonDays: HR_SELF_DOCUMENT_EXPIRY_SOON_DAYS,
    summary,
    documents,
  });
}

/**
 * GET /api/hr/self-service/attendance — the caller's own attendance for the
 * rolling 90-day window ending today. Read-only by design: clock-in/out,
 * edits, deletes and approval stay on the HR attendance routes. The record
 * projection is intentionally small, and the summary is derived from the same
 * returned rows so it cannot drift from the table below it.
 */
export async function get_hrSelfServiceAttendance(req: any, res: Response): Promise<any> {
  const user = requireSelfService(req);
  await resolveOwnEmployee(req, user);

  const [windowResult, recordResult] = await Promise.all([
    pgPool.query(HR_SELF_ATTENDANCE_WINDOW_SQL, [HR_SELF_ATTENDANCE_WINDOW_DAYS]),
    pgPool.query(HR_SELF_ATTENDANCE_SQL, [user.id, HR_SELF_ATTENDANCE_WINDOW_DAYS]),
  ]);
  const records = recordResult.rows.map((row: any) => ({
    ...row,
    overtimeHours: Number(row.overtimeHours ?? 0),
  }));
  const summary: Record<string, number> = {
    totalDays: records.length,
    presentDays: 0,
    absentDays: 0,
    leaveDays: 0,
    halfDays: 0,
    holidayDays: 0,
    weekendDays: 0,
    overtimeHours: 0,
  };
  for (const record of records) {
    const key =
      record.status === 'PRESENT'
        ? 'presentDays'
        : record.status === 'ABSENT'
          ? 'absentDays'
          : record.status === 'LEAVE'
            ? 'leaveDays'
            : record.status === 'HALF_DAY'
              ? 'halfDays'
              : record.status === 'HOLIDAY'
                ? 'holidayDays'
                : record.status === 'WEEKEND'
                  ? 'weekendDays'
                  : null;
    if (key) summary[key] += 1;
    summary.overtimeHours += Number(record.overtimeHours ?? 0);
  }
  summary.overtimeHours = Math.round(summary.overtimeHours * 100) / 100;

  const window = windowResult.rows[0];
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    windowStartAD: window.windowStartAD,
    windowEndAD: window.windowEndAD,
    windowDays: HR_SELF_ATTENDANCE_WINDOW_DAYS,
    summary,
    records,
  });
}
