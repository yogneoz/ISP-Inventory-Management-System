/**
 * Leave-request writes, parameterised by WHO is acting.
 *
 * The HR register (`hrLeave.controller.ts`) and employee self-service both need
 * the same rules: validate the window, take a per-employee advisory lock, refuse
 * an overlapping request, resolve the BS labels, insert, and write the audit row
 * in the same transaction. That logic lives here once. The difference between
 * the two callers is only how the employee is chosen:
 *
 *   - the register names an employee and then proves the caller may write it;
 *   - self-service passes the employee resolved from the session (`user_id`), so
 *     there is no selector for a client to tamper with.
 *
 * Cancellation is deliberately narrower for self-service: an employee may cancel
 * only their OWN pending/approved request, and approval stays an HR decision.
 */
import crypto from 'node:crypto';
import { pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { ApiError } from '../errors/ApiError';
import { logAuditEvent } from './audit.service';
import { isAccountingDate } from './accounting.service';
import { getUserFromReq } from '../middleware/auth';
import { resolveBsDateForLedger } from '../utils/bsDate';
import { HR_ATTENDANCE_EMPLOYEE_BY_ID_SQL, HR_LEAVE_TYPE_BY_ID_SQL } from '../models/hrAttendance.repo';
import {
  HR_LEAVE_REQUEST_ADVISORY_LOCK_SQL,
  HR_LEAVE_REQUEST_BY_ID_SQL,
  HR_LEAVE_REQUEST_DECIDE_SQL,
  HR_LEAVE_REQUEST_INSERT_SQL,
  HR_LEAVE_REQUEST_LOCK_SQL,
  HR_LEAVE_REQUEST_OVERLAP_SQL,
} from '../models/hrLeave.repo';

const MAX_REQUEST_DAYS = 366;

export interface LeaveEmployee {
  id: string;
  employeeCode: string;
  name?: string;
  branchId: string;
  isActive: boolean;
}

interface LeaveTypeLookup {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function optionalText(value: unknown, max: number): string | null {
  const parsed = text(value, max);
  return parsed || null;
}

function actorOf(req: any): string | null {
  // Same resolution as the register's writes: the JWT identity, not a header.
  const user = getUserFromReq(req) || {};
  return user.email || user.name || null;
}

function parseDate(value: unknown, label: string): string {
  const date = text(value, 10);
  if (!date) throw new ApiError(400, `${label} is required.`);
  if (!isAccountingDate(date)) {
    throw new ApiError(400, `${label} must be a real date in YYYY-MM-DD form.`);
  }
  return date;
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

/** Same projection the register returns, so both clients read one shape. */
export function leaveRequestResponse(row: any): any {
  return { ...row, daysCount: Number(row.daysCount ?? 0) };
}

export async function loadEmployeeForLeave(employeeId: string): Promise<LeaveEmployee> {
  const employee = (await pgPool.query(HR_ATTENDANCE_EMPLOYEE_BY_ID_SQL, [employeeId])).rows[0];
  if (!employee) throw new ApiError(404, 'Employee not found.');
  return employee;
}

async function loadLeaveType(leaveTypeId: string): Promise<LeaveTypeLookup> {
  const type = (await pgPool.query(HR_LEAVE_TYPE_BY_ID_SQL, [leaveTypeId])).rows[0];
  if (!type) throw new ApiError(400, 'The selected leave type does not exist.');
  return type;
}

/**
 * Create a PENDING request for `employee`. The caller has already established
 * that the actor may act for that employee (register: branch + manage grant;
 * self-service: it IS the session's employee).
 */
export async function createLeaveRequestFor(
  req: any,
  employee: LeaveEmployee,
  body: any
): Promise<any> {
  const employeeId = String(employee.id);
  const leaveTypeId = text(body?.leaveTypeId, 50);
  if (!leaveTypeId) throw new ApiError(400, 'A leave type is required.');
  const leaveType = await loadLeaveType(leaveTypeId);

  // Self-service accepts the app's startDate/endDate aliases; the register has
  // always used the AD-suffixed names. One accepted spelling each, not both.
  const startAD = parseDate(body?.startDateAD ?? body?.startDate, 'Start date');
  const endAD = parseDate(body?.endDateAD ?? body?.endDate, 'End date');
  if (endAD < startAD) throw new ApiError(400, 'End date must not be before the start date.');
  if (startAD.slice(0, 4) !== endAD.slice(0, 4)) {
    throw new ApiError(400, 'A leave request must stay within one calendar year.');
  }
  const daysCount = inclusiveDays(startAD, endAD);
  if (daysCount > MAX_REQUEST_DAYS) {
    throw new ApiError(400, `A leave request may cover at most ${MAX_REQUEST_DAYS} days.`);
  }
  const reason = optionalText(body?.reason, 500);
  const [startDateBS, endDateBS] = await Promise.all([
    resolveBsDateForLedger(startAD),
    resolveBsDateForLedger(endAD),
  ]);

  return withTransaction(async (client) => {
    // Serialize per employee: an overlapping submit cannot slip between the
    // overlap check and the insert.
    await client.query(HR_LEAVE_REQUEST_ADVISORY_LOCK_SQL, [employeeId]);
    const overlap = (
      await client.query(HR_LEAVE_REQUEST_OVERLAP_SQL, [employeeId, startAD, endAD])
    ).rows[0];
    if (overlap) {
      throw new ApiError(
        409,
        `Request ${overlap.requestNo} already covers one of these days for ${employee.employeeCode}.`
      );
    }
    const requestNo = `LR-${startAD.slice(0, 4)}-${crypto
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
      startAD,
      endAD,
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
      `Created leave request ${requestNo} for ${employee.employeeCode}: ${leaveType.code} ${startAD}–${endAD} (${daysCount} days)`,
      String(employee.branchId),
      client
    );
    return (await client.query(HR_LEAVE_REQUEST_BY_ID_SQL, [id])).rows[0];
  });
}

/**
 * Cancel `requestId`, refusing anything that is not the given employee's own
 * pending/approved request. Cancelling an approved request returns its days
 * because usage is derived from APPROVED rows, not from a stored counter.
 */
export async function cancelOwnLeaveRequest(
  req: any,
  employee: LeaveEmployee,
  requestId: string
): Promise<any> {
  const id = text(requestId, 50);
  if (!id) throw new ApiError(400, 'A leave request id is required.');
  const existing = (await pgPool.query(HR_LEAVE_REQUEST_BY_ID_SQL, [id])).rows[0];
  // Another employee's request is reported as absent, not forbidden: self-service
  // must not confirm that a request id exists outside the caller's records.
  if (!existing || String(existing.employeeId) !== String(employee.id)) {
    throw new ApiError(404, 'Leave request not found.');
  }
  if (existing.status !== 'PENDING' && existing.status !== 'APPROVED') {
    throw new ApiError(
      409,
      `Request ${existing.requestNo} is ${existing.status} and cannot be cancelled.`
    );
  }
  const note = optionalText(req.body?.note ?? req.body?.reason, 500);
  const actor = actorOf(req);

  return withTransaction(async (client) => {
    const locked = (await client.query(HR_LEAVE_REQUEST_LOCK_SQL, [id])).rows[0];
    if (!locked) throw new ApiError(404, 'Leave request not found.');
    if (String(locked.employeeId) !== String(employee.id)) {
      throw new ApiError(404, 'Leave request not found.');
    }
    if (locked.status !== 'PENDING' && locked.status !== 'APPROVED') {
      throw new ApiError(
        409,
        `Request ${existing.requestNo} is now ${locked.status}; reload and try again.`
      );
    }
    const updated = (
      await client.query(HR_LEAVE_REQUEST_DECIDE_SQL, [
        id,
        'CANCELLED',
        actor,
        note,
        ['PENDING', 'APPROVED'],
      ])
    ).rows[0];
    if (!updated) {
      throw new ApiError(409, 'The request changed while it was being cancelled. Reload and retry.');
    }
    await logAuditEvent(
      req,
      'CANCEL_HR_LEAVE_REQUEST',
      'ACCOUNTING',
      `Cancelled leave request ${existing.requestNo} for ${existing.employeeCode}: ${existing.daysCount} day(s)`,
      String(existing.branchId),
      client
    );
    return (await client.query(HR_LEAVE_REQUEST_BY_ID_SQL, [id])).rows[0];
  });
}
