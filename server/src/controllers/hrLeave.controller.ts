/**
 * Phase 1 leave: per-employee balances and the leave-request approval workflow.
 *
 * A balance row stores entitlement + adjustment for one employee, leave type
 * and calendar year. Used days are DERIVED from APPROVED requests, which is what
 * makes reject/cancel return the days without a second counter that could
 * drift. Approval is the only place balance sufficiency is enforced: a pending
 * request may be submitted, but it cannot be approved past the remaining days.
 *
 * Reads and writes use the same HR gates as attendance — `hr-employee-view` (or
 * `hr-attendance-manage` / the legacy payroll grant) reads, and
 * `hr-attendance-manage` or the legacy grant writes. The write gate is repeated
 * here, not just on the route. The request's branch comes from the employee,
 * never from the request body, and every list intersects the caller's allowed
 * branches.
 *
 * Every mutation and its audit row share one transaction. Request creation takes
 * a transaction-scoped advisory lock per employee so two overlapping submits
 * cannot race past the overlap check.
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
import { isAccountingDate, isUniqueViolation } from '../services/accounting.service';
import { resolveBsDateForLedger } from '../utils/bsDate';
import {
  HR_ATTENDANCE_EMPLOYEE_BY_ID_SQL,
  HR_LEAVE_TYPE_BY_ID_SQL,
} from '../models/hrAttendance.repo';
import {
  HR_LEAVE_BALANCE_BY_ID_SQL,
  HR_LEAVE_BALANCE_BY_KEY_LOCK_SQL,
  HR_LEAVE_BALANCE_INSERT_SQL,
  HR_LEAVE_BALANCE_LIST_SQL,
  HR_LEAVE_BALANCE_UPDATE_SQL,
  HR_LEAVE_BALANCE_USED_SQL,
  HR_LEAVE_REQUEST_ADVISORY_LOCK_SQL,
  HR_LEAVE_REQUEST_BY_ID_SQL,
  HR_LEAVE_REQUEST_DECIDE_SQL,
  HR_LEAVE_REQUEST_INSERT_SQL,
  HR_LEAVE_REQUEST_LIST_SQL,
  HR_LEAVE_REQUEST_LOCK_SQL,
  HR_LEAVE_REQUEST_OVERLAP_SQL,
  HR_LEAVE_REQUEST_STATUSES,
  type HrLeaveRequestStatus,
} from '../models/hrLeave.repo';

const MAX_ENTITLEMENT_DAYS = 366;
const MAX_REQUEST_DAYS = 366;

interface HrBranchScope {
  /** A concrete filter branch; null means all branches (global only). */
  branchId: string | null;
  /** Allowed branches, or null for a global account. */
  allowed: Set<string> | null;
  empty: boolean;
}

interface LeaveEmployee {
  id: string;
  employeeCode: string;
  name: string;
  branchId: string;
  isActive: boolean;
}

interface LeaveTypeLookup {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

function requireDb(): void {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function actorOf(req: any): string | null {
  const user = getUserFromReq(req);
  return user.email || user.name || null;
}

function optionalText(value: unknown, max: number): string | null {
  const parsed = text(value, max);
  return parsed || null;
}

/** The route already gates writes; repeating it closes a bypassed route edit. */
function requireManage(req: any): void {
  const user = req.user || getUserFromReq(req);
  const allowed =
    effectivePermission(
      user,
      'hr-attendance-manage',
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
    throw new ApiError(403, 'Attendance and leave require the HR manage permission.');
  }
}

function parseDate(value: unknown, label: string): string {
  const date = text(value, 10);
  if (!date) throw new ApiError(400, `${label} is required.`);
  if (!isAccountingDate(date)) {
    throw new ApiError(400, `${label} must be a real date in YYYY-MM-DD form.`);
  }
  return date;
}

function optionalDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return parseDate(value, label);
}

function parseYear(value: unknown): number {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new ApiError(400, 'Balance year must be a four-digit year.');
  }
  return year;
}

function parseDays(value: unknown, label: string, min: number, max: number): number {
  const days = Number(value);
  if (!Number.isFinite(days) || days < min || days > max) {
    throw new ApiError(400, `${label} must be between ${min} and ${max} days.`);
  }
  return Math.round(days * 100) / 100;
}

function parseRequestStatusFilter(value: unknown): HrLeaveRequestStatus | null {
  const status = text(value, 20).toUpperCase();
  if (!status) return null;
  if (!(HR_LEAVE_REQUEST_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(400, `Status must be one of: ${HR_LEAVE_REQUEST_STATUSES.join(', ')}.`);
  }
  return status as HrLeaveRequestStatus;
}

/** Inclusive calendar-day count; both dates are validated YYYY-MM-DD. */
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

function assertWriteBranch(req: any, branchId: string): void {
  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  if (allowed && !allowed.has(branchId)) {
    throw new ApiError(403, 'Forbidden: this record belongs to another branch.');
  }
}

async function loadEmployee(employeeId: string): Promise<LeaveEmployee> {
  const employee = (await pgPool.query(HR_ATTENDANCE_EMPLOYEE_BY_ID_SQL, [employeeId])).rows[0];
  if (!employee) throw new ApiError(404, 'Employee not found.');
  return employee;
}

async function loadLeaveType(leaveTypeId: string): Promise<LeaveTypeLookup> {
  const type = (await pgPool.query(HR_LEAVE_TYPE_BY_ID_SQL, [leaveTypeId])).rows[0];
  if (!type) throw new ApiError(400, 'The selected leave type does not exist.');
  return type;
}

/** Reads that name an employee must not confirm another branch's employee. */
async function assertEmployeeReadable(req: any, employeeId: string): Promise<void> {
  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  if (!allowed) return;
  const employee = await loadEmployee(employeeId);
  if (!allowed.has(String(employee.branchId))) {
    throw new ApiError(403, 'Forbidden: this employee belongs to another branch.');
  }
}

function balanceResponse(row: any): any {
  return {
    ...row,
    entitlementDays: Number(row.entitlementDays ?? 0),
    adjustmentDays: Number(row.adjustmentDays ?? 0),
    usedDays: Number(row.usedDays ?? 0),
    remainingDays: Number(row.remainingDays ?? 0),
  };
}

function requestResponse(row: any): any {
  return { ...row, daysCount: Number(row.daysCount ?? 0) };
}

function uniqueBalanceConflict(): ApiError {
  return new ApiError(409, 'This employee already has a balance for that leave type and year.');
}

/** GET /api/hr/leave-balances?branchId=&year=&employeeId=&leaveTypeId= */
export async function get_hrLeaveBalances(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = readScope(req);
  if (scope.empty) return res.json([]);
  const employeeId = optionalText(req.query?.employeeId, 50);
  if (employeeId) await assertEmployeeReadable(req, employeeId);
  const leaveTypeId = optionalText(req.query?.leaveTypeId, 50);
  const rawYear = text(req.query?.year, 4);
  const year = rawYear ? parseYear(rawYear) : null;
  const rows = (
    await pgPool.query(HR_LEAVE_BALANCE_LIST_SQL, [
      scope.branchId,
      scope.allowed ? [...scope.allowed] : null,
      year,
      employeeId,
      leaveTypeId,
    ])
  ).rows;
  return res.json(rows.map(balanceResponse));
}

/** POST /api/hr/leave-balances — one row per employee + leave type + year. */
export async function post_hrLeaveBalance(req: any, res: Response): Promise<any> {
  requireDb();
  requireManage(req);
  const employeeId = text(req.body?.employeeId, 50);
  if (!employeeId) throw new ApiError(400, 'An employee is required.');
  const employee = await loadEmployee(employeeId);
  assertWriteBranch(req, String(employee.branchId));
  const leaveTypeId = text(req.body?.leaveTypeId, 50);
  if (!leaveTypeId) throw new ApiError(400, 'A leave type is required.');
  await loadLeaveType(leaveTypeId);
  const balanceYear = parseYear(req.body?.balanceYear);
  const entitlementDays = parseDays(
    req.body?.entitlementDays ?? 0,
    'Entitlement days',
    0,
    MAX_ENTITLEMENT_DAYS
  );
  const adjustmentDays = parseDays(
    req.body?.adjustmentDays ?? 0,
    'Adjustment days',
    -MAX_ENTITLEMENT_DAYS,
    MAX_ENTITLEMENT_DAYS
  );
  const notes = optionalText(req.body?.notes, 500);

  try {
    const saved = await withTransaction(async (client) => {
      const id = `hr-leave-bal-${crypto.randomUUID()}`;
      await client.query(HR_LEAVE_BALANCE_INSERT_SQL, [
        id,
        employeeId,
        String(employee.branchId),
        leaveTypeId,
        balanceYear,
        entitlementDays,
        adjustmentDays,
        notes,
        actorOf(req),
      ]);
      await logAuditEvent(
        req,
        'CREATE_HR_LEAVE_BALANCE',
        'ACCOUNTING',
        `Set ${balanceYear} leave balance for ${employee.employeeCode}: ${entitlementDays} entitled, ${adjustmentDays} adjusted`,
        String(employee.branchId),
        client
      );
      return (await client.query(HR_LEAVE_BALANCE_BY_ID_SQL, [id])).rows[0];
    });
    return res.status(201).json(balanceResponse(saved));
  } catch (err) {
    if (isUniqueViolation(err)) throw uniqueBalanceConflict();
    throw err;
  }
}

/** PATCH /api/hr/leave-balances/:id */
export async function patch_hrLeaveBalance(req: any, res: Response): Promise<any> {
  requireDb();
  requireManage(req);
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A balance id is required.');
  const existing = (await pgPool.query(HR_LEAVE_BALANCE_BY_ID_SQL, [id])).rows[0];
  if (!existing) throw new ApiError(404, 'Leave balance not found.');
  assertWriteBranch(req, String(existing.branchId));

  const entitlementDays =
    req.body?.entitlementDays === undefined
      ? Number(existing.entitlementDays)
      : parseDays(req.body.entitlementDays, 'Entitlement days', 0, MAX_ENTITLEMENT_DAYS);
  const adjustmentDays =
    req.body?.adjustmentDays === undefined
      ? Number(existing.adjustmentDays)
      : parseDays(
          req.body.adjustmentDays,
          'Adjustment days',
          -MAX_ENTITLEMENT_DAYS,
          MAX_ENTITLEMENT_DAYS
        );
  const notes =
    req.body?.notes === undefined ? existing.notes : optionalText(req.body.notes, 500);

  const saved = await withTransaction(async (client) => {
    await client.query(HR_LEAVE_BALANCE_UPDATE_SQL, [
      id,
      entitlementDays,
      adjustmentDays,
      notes,
      actorOf(req),
    ]);
    await logAuditEvent(
      req,
      'UPDATE_HR_LEAVE_BALANCE',
      'ACCOUNTING',
      `Updated ${existing.balanceYear} leave balance for ${existing.employeeCode}: ${entitlementDays} entitled, ${adjustmentDays} adjusted`,
      String(existing.branchId),
      client
    );
    return (await client.query(HR_LEAVE_BALANCE_BY_ID_SQL, [id])).rows[0];
  });
  return res.json(balanceResponse(saved));
}

/** GET /api/hr/leave-requests?branchId=&status=&employeeId=&from=&to= */
export async function get_hrLeaveRequests(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = readScope(req);
  if (scope.empty) return res.json([]);
  const employeeId = optionalText(req.query?.employeeId, 50);
  if (employeeId) await assertEmployeeReadable(req, employeeId);
  const status = parseRequestStatusFilter(req.query?.status);
  const from = optionalDate(req.query?.from, 'from');
  const to = optionalDate(req.query?.to, 'to');
  if (from && to && from > to) throw new ApiError(400, 'from must not be after to.');
  const rows = (
    await pgPool.query(HR_LEAVE_REQUEST_LIST_SQL, [
      scope.branchId,
      scope.allowed ? [...scope.allowed] : null,
      status,
      employeeId,
      from,
      to,
    ])
  ).rows;
  return res.json(rows.map(requestResponse));
}

/** POST /api/hr/leave-requests */
export async function post_hrLeaveRequest(req: any, res: Response): Promise<any> {
  requireDb();
  requireManage(req);
  const employeeId = text(req.body?.employeeId, 50);
  if (!employeeId) throw new ApiError(400, 'An employee is required.');
  const employee = await loadEmployee(employeeId);
  assertWriteBranch(req, String(employee.branchId));
  const leaveTypeId = text(req.body?.leaveTypeId, 50);
  if (!leaveTypeId) throw new ApiError(400, 'A leave type is required.');
  const leaveType = await loadLeaveType(leaveTypeId);

  const startDateAD = parseDate(req.body?.startDateAD, 'Start date');
  const endDateAD = parseDate(req.body?.endDateAD, 'End date');
  if (endDateAD < startDateAD) {
    throw new ApiError(400, 'End date must not be before the start date.');
  }
  if (startDateAD.slice(0, 4) !== endDateAD.slice(0, 4)) {
    throw new ApiError(400, 'A leave request must stay within one calendar year.');
  }
  const daysCount = inclusiveDays(startDateAD, endDateAD);
  if (daysCount > MAX_REQUEST_DAYS) {
    throw new ApiError(400, `A leave request may cover at most ${MAX_REQUEST_DAYS} days.`);
  }
  const reason = optionalText(req.body?.reason, 500);
  const [startDateBS, endDateBS] = await Promise.all([
    resolveBsDateForLedger(startDateAD),
    resolveBsDateForLedger(endDateAD),
  ]);

  const saved = await withTransaction(async (client) => {
    // Serialize per employee: an overlapping submit cannot slip between the
    // overlap check and the insert.
    await client.query(HR_LEAVE_REQUEST_ADVISORY_LOCK_SQL, [employeeId]);
    const overlap = (
      await client.query(HR_LEAVE_REQUEST_OVERLAP_SQL, [employeeId, startDateAD, endDateAD])
    ).rows[0];
    if (overlap) {
      throw new ApiError(
        409,
        `Request ${overlap.requestNo} already covers one of these days for ${employee.employeeCode}.`
      );
    }
    const requestNo = `LR-${startDateAD.slice(0, 4)}-${crypto
      .randomBytes(3)
      .toString('hex')
      .toUpperCase()}`;
    const id = `hr-leave-req-${crypto.randomUUID()}`;
    await client.query(HR_LEAVE_REQUEST_INSERT_SQL, [
      id,
      requestNo,
      employeeId,
      String(employee.branchId),
      leaveTypeId,
      startDateAD,
      endDateAD,
      startDateBS,
      endDateBS,
      daysCount,
      reason,
      actorOf(req),
    ]);
    await logAuditEvent(
      req,
      'CREATE_HR_LEAVE_REQUEST',
      'ACCOUNTING',
      `Created leave request ${requestNo} for ${employee.employeeCode}: ${leaveType.code} ${startDateAD}–${endDateAD} (${daysCount} days)`,
      String(employee.branchId),
      client
    );
    return (await client.query(HR_LEAVE_REQUEST_BY_ID_SQL, [id])).rows[0];
  });
  return res.status(201).json(requestResponse(saved));
}

interface DecisionInput {
  status: 'APPROVED' | 'REJECTED' | 'CANCELLED';
  allowedFrom: readonly HrLeaveRequestStatus[];
  action: string;
  detail: (request: any) => string;
}

/**
 * Shared guarded transition. `APPROVED` additionally spends the balance; the
 * other transitions only change the status, which is what returns days.
 */
async function decideLeaveRequest(
  req: any,
  res: Response,
  decision: DecisionInput
): Promise<any> {
  requireDb();
  requireManage(req);
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A leave request id is required.');
  const existing = (await pgPool.query(HR_LEAVE_REQUEST_BY_ID_SQL, [id])).rows[0];
  if (!existing) throw new ApiError(404, 'Leave request not found.');
  assertWriteBranch(req, String(existing.branchId));
  if (!decision.allowedFrom.includes(existing.status)) {
    throw new ApiError(
      409,
      `Request ${existing.requestNo} is ${existing.status} and cannot be ${decision.status.toLowerCase()}.`
    );
  }
  const note = optionalText(req.body?.note ?? req.body?.decisionNote, 500);
  const actor = actorOf(req);

  const saved = await withTransaction(async (client) => {
    const locked = (await client.query(HR_LEAVE_REQUEST_LOCK_SQL, [id])).rows[0];
    if (!locked) throw new ApiError(404, 'Leave request not found.');
    if (!decision.allowedFrom.includes(locked.status)) {
      throw new ApiError(
        409,
        `Request ${existing.requestNo} is now ${locked.status}; reload and try again.`
      );
    }
    if (decision.status === 'APPROVED') {
      const year = Number(String(locked.startDateAD).slice(0, 4));
      const balance = (
        await client.query(HR_LEAVE_BALANCE_BY_KEY_LOCK_SQL, [
          locked.employeeId,
          locked.leaveTypeId,
          year,
        ])
      ).rows[0];
      if (!balance) {
        throw new ApiError(
          409,
          `No ${year} leave balance is configured for this employee and leave type.`
        );
      }
      const used = (
        await client.query(HR_LEAVE_BALANCE_USED_SQL, [
          locked.employeeId,
          locked.leaveTypeId,
          year,
        ])
      ).rows[0];
      const remaining =
        Number(balance.entitlementDays) + Number(balance.adjustmentDays) - Number(used.usedDays);
      const requested = Number(locked.daysCount);
      if (remaining < requested) {
        throw new ApiError(
          409,
          `Insufficient leave balance: ${remaining} day(s) remaining, ${requested} requested.`
        );
      }
    }
    const updated = (
      await client.query(HR_LEAVE_REQUEST_DECIDE_SQL, [
        id,
        decision.status,
        actor,
        note,
        [...decision.allowedFrom],
      ])
    ).rows[0];
    if (!updated) {
      throw new ApiError(409, 'The request changed while it was being decided. Reload and retry.');
    }
    await logAuditEvent(
      req,
      decision.action,
      'ACCOUNTING',
      decision.detail(existing),
      String(existing.branchId),
      client
    );
    return (await client.query(HR_LEAVE_REQUEST_BY_ID_SQL, [id])).rows[0];
  });
  return res.json(requestResponse(saved));
}

/** POST /api/hr/leave-requests/:id/approve — spends the balance. */
export async function post_hrLeaveRequestApprove(req: any, res: Response): Promise<any> {
  return decideLeaveRequest(req, res, {
    status: 'APPROVED',
    allowedFrom: ['PENDING'],
    action: 'APPROVE_HR_LEAVE_REQUEST',
    detail: (request) =>
      `Approved leave request ${request.requestNo} for ${request.employeeCode}: ${request.daysCount} day(s)`,
  });
}

/** POST /api/hr/leave-requests/:id/reject */
export async function post_hrLeaveRequestReject(req: any, res: Response): Promise<any> {
  return decideLeaveRequest(req, res, {
    status: 'REJECTED',
    allowedFrom: ['PENDING'],
    action: 'REJECT_HR_LEAVE_REQUEST',
    detail: (request) =>
      `Rejected leave request ${request.requestNo} for ${request.employeeCode}`,
  });
}

/**
 * POST /api/hr/leave-requests/:id/cancel — cancels a pending or approved
 * request; an approved cancellation returns its days because usage is derived.
 */
export async function post_hrLeaveRequestCancel(req: any, res: Response): Promise<any> {
  return decideLeaveRequest(req, res, {
    status: 'CANCELLED',
    allowedFrom: ['PENDING', 'APPROVED'],
    action: 'CANCEL_HR_LEAVE_REQUEST',
    detail: (request) =>
      `Cancelled leave request ${request.requestNo} for ${request.employeeCode}: ${request.daysCount} day(s)`,
  });
}
