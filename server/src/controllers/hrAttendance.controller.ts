/**
 * Phase 1 attendance foundation: shifts, leave types, branch holidays and the
 * daily attendance register with an idempotent CSV import.
 *
 * Reads accept the employee-view grant (or attendance-manage / the legacy
 * payroll grant); every write requires `hr-attendance-manage` or the legacy
 * `gl-payroll-manage` grant at the route, and is repeated inside the controller
 * so a future route edit cannot widen it. Shifts and leave types are company
 * catalogues; holidays and attendance rows are branch custody. An attendance
 * row's branch is derived from the employee, never trusted from the request.
 *
 * Every mutation and its audit row share one transaction. Attendance is unique
 * by employee + AD date, so re-importing the same sheet updates the same days
 * and reports UPDATE rather than creating duplicates.
 */
import crypto from 'crypto';
import type { Response } from 'express';
import { getPgConnected, pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { logAuditEvent } from '../services/audit.service';
import { getUserFromReq } from '../middleware/auth';
import { allowedBranchScope } from '../middleware/branchScope';
import { ApiError } from '../errors/ApiError';
import { isAccountingDate, isUniqueViolation } from '../services/accounting.service';
import { resolveBsDateForLedger } from '../utils/bsDate';
import { parseCsv } from '../services/csvImport';
import { BRANCH_EXISTS_SQL } from '../models/accounting.repo';
import {
  HR_ATTENDANCE_BY_ID_SQL,
  HR_ATTENDANCE_DELETE_SQL,
  HR_ATTENDANCE_EMPLOYEES_BY_CODES_SQL,
  HR_ATTENDANCE_EMPLOYEE_BY_ID_SQL,
  HR_ATTENDANCE_EXISTING_SQL,
  HR_ATTENDANCE_LIST_SQL,
  HR_ATTENDANCE_STATUSES,
  HR_ATTENDANCE_UPSERT_SQL,
  HR_HOLIDAY_BY_ID_SQL,
  HR_HOLIDAY_DELETE_SQL,
  HR_HOLIDAY_INSERT_SQL,
  HR_HOLIDAY_LIST_SQL,
  HR_LEAVE_TYPE_BY_ID_SQL,
  HR_LEAVE_TYPE_INSERT_SQL,
  HR_LEAVE_TYPE_LIST_SQL,
  HR_LEAVE_TYPE_UPDATE_SQL,
  HR_SHIFT_BY_ID_SQL,
  HR_SHIFT_INSERT_SQL,
  HR_SHIFT_LIST_SQL,
  HR_SHIFT_UPDATE_SQL,
  type HrAttendanceStatus,
} from '../models/hrAttendance.repo';

const IMPORT_MAX_ROWS = 2000;
const IMPORT_MAX_CSV_CHARS = 512 * 1024;
const MAX_OT_HOURS = 24;

interface HrBranchScope {
  /** A concrete filter branch; null means all branches (global only). */
  branchId: string | null;
  /** Allowed branches, or null for a global account. */
  allowed: Set<string> | null;
  empty: boolean;
}

interface AttendanceEmployee {
  id: string;
  employeeCode: string;
  name: string;
  branchId: string;
  isActive: boolean;
}

interface ShiftLookup {
  id: string;
  code: string;
  name: string;
}

interface ImportAttendanceRow {
  rowNumber: number;
  employeeCode: string | null;
  employeeName: string | null;
  attendanceDateAD: string | null;
  action: 'CREATE' | 'UPDATE' | 'SKIP';
  errors: string[];
  record?: {
    employeeId: string;
    branchId: string;
    attendanceDateAD: string;
    attendanceDateBS: string;
    shiftId: string | null;
    status: HrAttendanceStatus;
    checkInTime: string | null;
    checkOutTime: string | null;
    overtimeHours: number;
    notes: string | null;
  };
}

/** Header aliases accept the biometric export and a plain spreadsheet copy. */
const IMPORT_HEADER_ALIASES: Record<string, string[]> = {
  employeeCode: ['hrmsid', 'employeecode', 'code'],
  date: ['date', 'attendancedate', 'attendancedatead'],
  status: ['status', 'attendance', 'attendancestatus'],
  shift: ['shift', 'shiftcode', 'shiftname'],
  checkIn: ['checkin', 'checkintime', 'in'],
  checkOut: ['checkout', 'checkouttime', 'out'],
  overtime: ['ot', 'overtime', 'overtimehours'],
  notes: ['notes', 'note', 'remarks'],
};

const REQUIRED_IMPORT_COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'employeeCode', label: 'HRMS ID' },
  { key: 'date', label: 'Date' },
  { key: 'status', label: 'Status' },
];

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

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseDate(value: unknown, label: string): string {
  const date = text(value, 10);
  if (!date) throw new ApiError(400, `${label} is required.`);
  if (!isAccountingDate(date)) throw new ApiError(400, `${label} must be a real date in YYYY-MM-DD form.`);
  return date;
}

function optionalDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return parseDate(value, label);
}

function parseTime(value: unknown, label: string): string | null {
  const time = text(value, 5);
  if (!time) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new ApiError(400, `${label} must use 24-hour HH:MM form.`);
  }
  return time;
}

function parseStatus(value: unknown): HrAttendanceStatus {
  const status = text(value, 20).toUpperCase().replace(/[\s-]+/g, '_');
  if (!(HR_ATTENDANCE_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(400, `Status must be one of: ${HR_ATTENDANCE_STATUSES.join(', ')}.`);
  }
  return status as HrAttendanceStatus;
}

function parseOvertime(value: unknown, label = 'Overtime hours'): number {
  if (value === undefined || value === null || value === '') return 0;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0 || hours > MAX_OT_HOURS) {
    throw new ApiError(400, `${label} must be between 0 and ${MAX_OT_HOURS}.`);
  }
  return Math.round(hours * 100) / 100;
}

function parseCode(value: unknown, fallback: string): string {
  const raw = text(value, 30).toUpperCase();
  const code = raw || fallback;
  if (!code) throw new ApiError(400, 'A code is required.');
  if (!/^[A-Z0-9][A-Z0-9._/-]{0,29}$/.test(code)) {
    throw new ApiError(400, 'Code must be 1–30 letters, digits, dots, dashes, slashes or underscores.');
  }
  return code;
}

function codeFromName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
}

function uniqueShiftConflict(): ApiError {
  return new ApiError(409, 'A shift with that name or code already exists.');
}

function uniqueLeaveTypeConflict(): ApiError {
  return new ApiError(409, 'A leave type with that name or code already exists.');
}

function uniqueHolidayConflict(): ApiError {
  return new ApiError(409, 'That branch already has a holiday on this date.');
}

/** Read scope: global accounts may span branches; branch accounts are pinned. */
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

async function loadEmployee(employeeId: string): Promise<AttendanceEmployee> {
  const employee = (await pgPool.query(HR_ATTENDANCE_EMPLOYEE_BY_ID_SQL, [employeeId])).rows[0];
  if (!employee) throw new ApiError(404, 'Employee not found.');
  return employee;
}

async function loadShift(shiftId: string): Promise<ShiftLookup> {
  const shift = (await pgPool.query(HR_SHIFT_BY_ID_SQL, [shiftId])).rows[0];
  if (!shift) throw new ApiError(400, 'The selected shift does not exist.');
  return shift;
}

function attendanceResponse(row: any): any {
  return { ...row, overtimeHours: Number(row.overtimeHours ?? 0) };
}

/** GET /api/hr/shifts?activeOnly=1 */
export async function get_hrShifts(req: any, res: Response): Promise<any> {
  requireDb();
  const activeOnly = String(req.query?.activeOnly ?? '') === '1';
  return res.json((await pgPool.query(HR_SHIFT_LIST_SQL, [activeOnly])).rows);
}

/** POST /api/hr/shifts */
export async function post_hrShift(req: any, res: Response): Promise<any> {
  requireDb();
  const name = text(req.body?.name, 120);
  if (!name) throw new ApiError(400, 'A shift name is required.');
  const code = parseCode(req.body?.code, codeFromName(name));
  const startTime = parseTime(req.body?.startTime, 'Start time');
  const endTime = parseTime(req.body?.endTime, 'End time');
  if (!startTime || !endTime) throw new ApiError(400, 'Start and end times are required.');
  const graceMinutes = Math.trunc(Number(req.body?.graceMinutes ?? 0));
  if (!Number.isFinite(graceMinutes) || graceMinutes < 0 || graceMinutes > 240) {
    throw new ApiError(400, 'Grace minutes must be between 0 and 240.');
  }
  const isActive = parseBoolean(req.body?.isActive, true);

  try {
    const saved = await withTransaction(async (client) => {
      const row = (
        await client.query(HR_SHIFT_INSERT_SQL, [
          `hr-shift-${crypto.randomUUID()}`,
          code,
          name,
          startTime,
          endTime,
          graceMinutes,
          isActive,
          actorOf(req),
        ])
      ).rows[0];
      await logAuditEvent(
        req,
        'CREATE_HR_SHIFT',
        'ACCOUNTING',
        `Created HR shift ${code} ${name} (${startTime}–${endTime})`,
        undefined,
        client
      );
      return row;
    });
    return res.status(201).json(saved);
  } catch (err) {
    if (isUniqueViolation(err)) throw uniqueShiftConflict();
    throw err;
  }
}

/** PATCH /api/hr/shifts/:id */
export async function patch_hrShift(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A shift id is required.');
  const existing = (await pgPool.query(HR_SHIFT_BY_ID_SQL, [id])).rows[0];
  if (!existing) throw new ApiError(404, 'Shift not found.');

  const name = req.body?.name === undefined ? existing.name : text(req.body.name, 120);
  if (!name) throw new ApiError(400, 'A shift name is required.');
  const code =
    req.body?.code === undefined
      ? existing.code
      : parseCode(req.body.code, codeFromName(name));
  const startTime =
    req.body?.startTime === undefined
      ? existing.startTime
      : parseTime(req.body.startTime, 'Start time');
  const endTime =
    req.body?.endTime === undefined ? existing.endTime : parseTime(req.body.endTime, 'End time');
  if (!startTime || !endTime) throw new ApiError(400, 'Start and end times are required.');
  const graceMinutes =
    req.body?.graceMinutes === undefined
      ? Number(existing.graceMinutes)
      : Math.trunc(Number(req.body.graceMinutes));
  if (!Number.isFinite(graceMinutes) || graceMinutes < 0 || graceMinutes > 240) {
    throw new ApiError(400, 'Grace minutes must be between 0 and 240.');
  }
  const isActive = parseBoolean(req.body?.isActive, Boolean(existing.isActive));

  try {
    const saved = await withTransaction(async (client) => {
      const row = (
        await client.query(HR_SHIFT_UPDATE_SQL, [
          id,
          code,
          name,
          startTime,
          endTime,
          graceMinutes,
          isActive,
          actorOf(req),
        ])
      ).rows[0];
      await logAuditEvent(
        req,
        'UPDATE_HR_SHIFT',
        'ACCOUNTING',
        `Updated HR shift ${row.code} ${row.name} (${row.isActive ? 'active' : 'inactive'})`,
        undefined,
        client
      );
      return row;
    });
    return res.json(saved);
  } catch (err) {
    if (isUniqueViolation(err)) throw uniqueShiftConflict();
    throw err;
  }
}

/** GET /api/hr/leave-types?activeOnly=1 */
export async function get_hrLeaveTypes(req: any, res: Response): Promise<any> {
  requireDb();
  const activeOnly = String(req.query?.activeOnly ?? '') === '1';
  return res.json((await pgPool.query(HR_LEAVE_TYPE_LIST_SQL, [activeOnly])).rows);
}

/** POST /api/hr/leave-types */
export async function post_hrLeaveType(req: any, res: Response): Promise<any> {
  requireDb();
  const name = text(req.body?.name, 120);
  if (!name) throw new ApiError(400, 'A leave-type name is required.');
  const code = parseCode(req.body?.code, codeFromName(name));
  const quota = Number(req.body?.annualQuotaDays ?? 0);
  if (!Number.isFinite(quota) || quota < 0 || quota > 366) {
    throw new ApiError(400, 'Annual quota must be between 0 and 366 days.');
  }
  const isPaid = parseBoolean(req.body?.isPaid, true);
  const isActive = parseBoolean(req.body?.isActive, true);

  try {
    const saved = await withTransaction(async (client) => {
      const row = (
        await client.query(HR_LEAVE_TYPE_INSERT_SQL, [
          `hr-leave-${crypto.randomUUID()}`,
          code,
          name,
          Math.round(quota * 10) / 10,
          isPaid,
          isActive,
          actorOf(req),
        ])
      ).rows[0];
      await logAuditEvent(
        req,
        'CREATE_HR_LEAVE_TYPE',
        'ACCOUNTING',
        `Created HR leave type ${code} ${name} (${row.annualQuotaDays} days, ${isPaid ? 'paid' : 'unpaid'})`,
        undefined,
        client
      );
      return row;
    });
    return res.status(201).json(saved);
  } catch (err) {
    if (isUniqueViolation(err)) throw uniqueLeaveTypeConflict();
    throw err;
  }
}

/** PATCH /api/hr/leave-types/:id */
export async function patch_hrLeaveType(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A leave-type id is required.');
  const existing = (await pgPool.query(HR_LEAVE_TYPE_BY_ID_SQL, [id])).rows[0];
  if (!existing) throw new ApiError(404, 'Leave type not found.');

  const name = req.body?.name === undefined ? existing.name : text(req.body.name, 120);
  if (!name) throw new ApiError(400, 'A leave-type name is required.');
  const code =
    req.body?.code === undefined
      ? existing.code
      : parseCode(req.body.code, codeFromName(name));
  const quota =
    req.body?.annualQuotaDays === undefined
      ? Number(existing.annualQuotaDays)
      : Number(req.body.annualQuotaDays);
  if (!Number.isFinite(quota) || quota < 0 || quota > 366) {
    throw new ApiError(400, 'Annual quota must be between 0 and 366 days.');
  }
  const isPaid = parseBoolean(req.body?.isPaid, Boolean(existing.isPaid));
  const isActive = parseBoolean(req.body?.isActive, Boolean(existing.isActive));

  try {
    const saved = await withTransaction(async (client) => {
      const row = (
        await client.query(HR_LEAVE_TYPE_UPDATE_SQL, [
          id,
          code,
          name,
          Math.round(quota * 10) / 10,
          isPaid,
          isActive,
          actorOf(req),
        ])
      ).rows[0];
      await logAuditEvent(
        req,
        'UPDATE_HR_LEAVE_TYPE',
        'ACCOUNTING',
        `Updated HR leave type ${row.code} ${row.name} (${row.isActive ? 'active' : 'inactive'})`,
        undefined,
        client
      );
      return row;
    });
    return res.json(saved);
  } catch (err) {
    if (isUniqueViolation(err)) throw uniqueLeaveTypeConflict();
    throw err;
  }
}

/** GET /api/hr/holidays?branchId=&from=&to= */
export async function get_hrHolidays(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = readScope(req);
  if (scope.empty) return res.json([]);
  const from = optionalDate(req.query?.from, 'from');
  const to = optionalDate(req.query?.to, 'to');
  if (from && to && from > to) throw new ApiError(400, 'from must not be after to.');
  const rows = (
    await pgPool.query(HR_HOLIDAY_LIST_SQL, [
      scope.branchId,
      scope.allowed ? [...scope.allowed] : null,
      from,
      to,
    ])
  ).rows;
  return res.json(rows);
}

/** POST /api/hr/holidays */
export async function post_hrHoliday(req: any, res: Response): Promise<any> {
  requireDb();
  const requestedBranch = text(req.body?.branchId, 50);
  const user = req.user || getUserFromReq(req);
  const allowed = allowedBranchScope(user);
  const branchId =
    requestedBranch && requestedBranch !== 'ALL'
      ? requestedBranch
      : allowed
        ? user.branchId || [...allowed][0] || ''
        : '';
  if (!branchId || branchId === 'ALL') {
    throw new ApiError(400, 'A concrete branch is required for a holiday.');
  }
  assertWriteBranch(req, branchId);

  const holidayDateAD = parseDate(req.body?.holidayDateAD, 'Holiday date');
  const name = text(req.body?.name, 120);
  if (!name) throw new ApiError(400, 'A holiday name is required.');
  const isPaid = parseBoolean(req.body?.isPaid, true);
  const notes = optionalText(req.body?.notes, 500);
  const holidayDateBS = await resolveBsDateForLedger(holidayDateAD);

  try {
    const saved = await withTransaction(async (client) => {
      if (!(await client.query(BRANCH_EXISTS_SQL, [branchId])).rows[0]) {
        throw new ApiError(400, `Branch ${branchId} does not exist.`);
      }
      const id = `hr-holiday-${crypto.randomUUID()}`;
      await client.query(HR_HOLIDAY_INSERT_SQL, [
        id,
        branchId,
        holidayDateAD,
        holidayDateBS,
        name,
        isPaid,
        notes,
        actorOf(req),
      ]);
      await logAuditEvent(
        req,
        'CREATE_HR_HOLIDAY',
        'ACCOUNTING',
        `Created HR holiday ${name} on ${holidayDateAD}`,
        branchId,
        client
      );
      return (await client.query(HR_HOLIDAY_BY_ID_SQL, [id])).rows[0];
    });
    return res.status(201).json(saved);
  } catch (err) {
    if (isUniqueViolation(err)) throw uniqueHolidayConflict();
    throw err;
  }
}

/** DELETE /api/hr/holidays/:id */
export async function delete_hrHoliday(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A holiday id is required.');
  const existing = (await pgPool.query(HR_HOLIDAY_BY_ID_SQL, [id])).rows[0];
  if (!existing) throw new ApiError(404, 'Holiday not found.');
  assertWriteBranch(req, String(existing.branchId));

  await withTransaction(async (client) => {
    await client.query(HR_HOLIDAY_DELETE_SQL, [id]);
    await logAuditEvent(
      req,
      'DELETE_HR_HOLIDAY',
      'ACCOUNTING',
      `Deleted HR holiday ${existing.name} on ${existing.holidayDateAD}`,
      String(existing.branchId),
      client
    );
  });
  return res.status(204).end();
}

/** GET /api/hr/attendance?branchId=&from=&to=&employeeId=&status= */
export async function get_hrAttendance(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = readScope(req);
  if (scope.empty) return res.json([]);
  const from = optionalDate(req.query?.from, 'from');
  const to = optionalDate(req.query?.to, 'to');
  if (from && to && from > to) throw new ApiError(400, 'from must not be after to.');
  const employeeId = optionalText(req.query?.employeeId, 50);
  const rawStatus = text(req.query?.status, 20);
  const status = rawStatus ? parseStatus(rawStatus) : null;
  const rows = (
    await pgPool.query(HR_ATTENDANCE_LIST_SQL, [
      scope.branchId,
      scope.allowed ? [...scope.allowed] : null,
      from,
      to,
      employeeId,
      status,
    ])
  ).rows;
  return res.json(rows.map(attendanceResponse));
}

/** POST /api/hr/attendance — manual create-or-update for one employee/day. */
export async function post_hrAttendance(req: any, res: Response): Promise<any> {
  requireDb();
  const employeeId = text(req.body?.employeeId, 50);
  if (!employeeId) throw new ApiError(400, 'An employee is required.');
  const employee = await loadEmployee(employeeId);
  assertWriteBranch(req, String(employee.branchId));

  const attendanceDateAD = parseDate(req.body?.attendanceDateAD, 'Attendance date');
  const status = parseStatus(req.body?.status);
  const shiftId = optionalText(req.body?.shiftId, 50);
  if (shiftId) await loadShift(shiftId);
  const checkInTime = parseTime(req.body?.checkInTime, 'Check-in time');
  const checkOutTime = parseTime(req.body?.checkOutTime, 'Check-out time');
  const overtimeHours = parseOvertime(req.body?.overtimeHours);
  const notes = optionalText(req.body?.notes, 500);
  const attendanceDateBS = await resolveBsDateForLedger(attendanceDateAD);

  const existing = (
    await pgPool.query(HR_ATTENDANCE_EXISTING_SQL, [[employeeId], [attendanceDateAD]])
  ).rows[0];

  const saved = await withTransaction(async (client) => {
    const id = `att-${crypto.randomUUID()}`;
    const upserted = (
      await client.query(HR_ATTENDANCE_UPSERT_SQL, [
        id,
        employeeId,
        String(employee.branchId),
        attendanceDateAD,
        attendanceDateBS,
        shiftId,
        status,
        checkInTime,
        checkOutTime,
        overtimeHours,
        notes,
        'MANUAL',
        actorOf(req),
        actorOf(req),
      ])
    ).rows[0];
    await logAuditEvent(
      req,
      'UPSERT_HR_ATTENDANCE',
      'ACCOUNTING',
      `Saved ${status} attendance for ${employee.employeeCode} on ${attendanceDateAD}`,
      String(employee.branchId),
      client
    );
    return (await client.query(HR_ATTENDANCE_BY_ID_SQL, [upserted.id])).rows[0];
  });

  return res.status(existing ? 200 : 201).json(attendanceResponse(saved));
}

/** DELETE /api/hr/attendance/:id */
export async function delete_hrAttendance(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'An attendance id is required.');
  const existing = (await pgPool.query(HR_ATTENDANCE_BY_ID_SQL, [id])).rows[0];
  if (!existing) throw new ApiError(404, 'Attendance record not found.');
  assertWriteBranch(req, String(existing.branchId));

  await withTransaction(async (client) => {
    await client.query(HR_ATTENDANCE_DELETE_SQL, [id]);
    await logAuditEvent(
      req,
      'DELETE_HR_ATTENDANCE',
      'ACCOUNTING',
      `Deleted attendance for ${existing.employeeCode} on ${existing.attendanceDateAD}`,
      String(existing.branchId),
      client
    );
  });
  return res.status(204).end();
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function importHeaderIndexes(header: string[]): Record<string, number> {
  const normalized = header.map(normalizeHeader);
  const indexes: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(IMPORT_HEADER_ALIASES)) {
    const at = normalized.findIndex((value) => aliases.includes(value));
    if (at >= 0) indexes[field] = at;
  }
  return indexes;
}

function importDate(value: string, label: string, errors: string[]): string | null {
  const clean = value.trim();
  if (!clean) {
    errors.push(`${label} is required.`);
    return null;
  }
  const dayFirst = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(clean);
  const iso = dayFirst
    ? `${dayFirst[3]}-${dayFirst[2].padStart(2, '0')}-${dayFirst[1].padStart(2, '0')}`
    : clean;
  if (!isAccountingDate(iso)) {
    errors.push(`${label} "${clean}" is not a real date (use YYYY-MM-DD).`);
    return null;
  }
  return iso;
}

function importStatus(value: string, errors: string[]): HrAttendanceStatus | null {
  const status = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!status) {
    errors.push('Status is required.');
    return null;
  }
  if (!(HR_ATTENDANCE_STATUSES as readonly string[]).includes(status)) {
    errors.push(`Status "${value.trim()}" must be one of: ${HR_ATTENDANCE_STATUSES.join(', ')}.`);
    return null;
  }
  return status as HrAttendanceStatus;
}

function importTime(value: string, label: string, errors: string[]): string | null {
  const clean = value.trim();
  if (!clean) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clean)) {
    errors.push(`${label} must use 24-hour HH:MM form.`);
    return null;
  }
  return clean;
}

function importOvertime(value: string, errors: string[]): number {
  const clean = value.trim();
  if (!clean) return 0;
  const hours = Number(clean);
  if (!Number.isFinite(hours) || hours < 0 || hours > MAX_OT_HOURS) {
    errors.push(`Overtime hours "${clean}" must be between 0 and ${MAX_OT_HOURS}.`);
    return 0;
  }
  return Math.round(hours * 100) / 100;
}

/** POST /api/hr/attendance/import — body: { csv } */
export async function post_hrAttendanceImport(req: any, res: Response): Promise<any> {
  requireDb();
  const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
  if (!csv.trim()) throw new ApiError(400, 'Provide the attendance CSV.');
  if (csv.length > IMPORT_MAX_CSV_CHARS) {
    throw new ApiError(413, 'The CSV exceeds 512 KB. Split the month and import it in parts.');
  }

  const table = parseCsv(csv);
  if (table.length < 2) {
    throw new ApiError(400, 'The CSV needs a header row and at least one attendance row.');
  }
  const dataRows = table.slice(1);
  if (dataRows.length > IMPORT_MAX_ROWS) {
    throw new ApiError(400, `Import at most ${IMPORT_MAX_ROWS} rows at a time.`);
  }

  const columns = importHeaderIndexes(table[0]);
  const missing = REQUIRED_IMPORT_COLUMNS.filter((column) => columns[column.key] === undefined);
  if (missing.length > 0) {
    throw new ApiError(
      400,
      `The CSV is missing required column(s): ${missing.map((column) => column.label).join(', ')}.`
    );
  }

  const raw = (row: string[], field: string): string =>
    columns[field] === undefined ? '' : String(row[columns[field]] ?? '').trim();

  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  const shifts = (await pgPool.query(HR_SHIFT_LIST_SQL, [false])).rows as ShiftLookup[];
  const shiftByKey = new Map<string, ShiftLookup>();
  for (const shift of shifts) {
    for (const key of [shift.id, shift.code, shift.name]) {
      if (key) shiftByKey.set(String(key).trim().toLowerCase(), shift);
    }
  }

  const codes = new Set<string>();
  for (const row of dataRows) {
    const code = raw(row, 'employeeCode').toUpperCase();
    if (/^[A-Z0-9][A-Z0-9._/-]{0,49}$/.test(code)) codes.add(code);
  }
  const employees = codes.size
    ? ((await pgPool.query(HR_ATTENDANCE_EMPLOYEES_BY_CODES_SQL, [[...codes]])).rows as AttendanceEmployee[])
    : [];
  const employeeByCode = new Map<string, AttendanceEmployee>(
    employees.map((employee) => [String(employee.employeeCode).toUpperCase(), employee])
  );

  const seen = new Map<string, number>();
  const rows: ImportAttendanceRow[] = [];

  dataRows.forEach((row, index) => {
    const rowNumber = index + 2;
    const errors: string[] = [];
    const employeeCode = raw(row, 'employeeCode').toUpperCase();

    if (!employeeCode) {
      errors.push('HRMS ID (employee code) is required.');
    } else if (!/^[A-Z0-9][A-Z0-9._/-]{0,49}$/.test(employeeCode)) {
      errors.push(
        `HRMS ID "${employeeCode}" may use only letters, digits, dots, dashes, slashes or underscores (max 50).`
      );
    }

    const attendanceDateAD = importDate(raw(row, 'date'), 'Date', errors);
    const status = importStatus(raw(row, 'status'), errors);
    const checkInTime = importTime(raw(row, 'checkIn'), 'Check-in time', errors);
    const checkOutTime = importTime(raw(row, 'checkOut'), 'Check-out time', errors);
    const overtimeHours = importOvertime(raw(row, 'overtime'), errors);
    const notes = raw(row, 'notes') ? raw(row, 'notes').slice(0, 500) : null;

    const shiftText = raw(row, 'shift');
    const shift = shiftText ? shiftByKey.get(shiftText.toLowerCase()) : undefined;
    if (shiftText && !shift) {
      errors.push(`Unknown shift "${shiftText}". Add it under Shifts or leave the cell blank.`);
    }

    const employee = employeeCode ? employeeByCode.get(employeeCode) : undefined;
    if (employeeCode && !employee) {
      errors.push(`Unknown employee code ${employeeCode}.`);
    } else if (employee && allowed && !allowed.has(String(employee.branchId))) {
      errors.push(`Employee ${employeeCode} is outside your allowed branches.`);
    }

    if (employeeCode && attendanceDateAD) {
      const key = `${employeeCode}|${attendanceDateAD}`;
      const firstRow = seen.get(key);
      if (firstRow) {
        errors.push(
          `Duplicate ${employeeCode} on ${attendanceDateAD} in the file (first seen at sheet row ${firstRow}).`
        );
      } else {
        seen.set(key, rowNumber);
      }
    }

    rows.push({
      rowNumber,
      employeeCode: employeeCode || null,
      employeeName: employee?.name ?? null,
      attendanceDateAD,
      action: 'SKIP',
      errors,
      record:
        errors.length === 0 && employee && attendanceDateAD && status
          ? {
              employeeId: String(employee.id),
              branchId: String(employee.branchId),
              attendanceDateAD,
              attendanceDateBS: '',
              shiftId: shift ? String(shift.id) : null,
              status,
              checkInTime,
              checkOutTime,
              overtimeHours,
              notes,
            }
          : undefined,
    });
  });

  const employeeIds = [...new Set(rows.filter((row) => row.record).map((row) => row.record!.employeeId))];
  const dates = [...new Set(rows.filter((row) => row.record).map((row) => row.record!.attendanceDateAD))];
  const existingRows =
    employeeIds.length && dates.length
      ? (await pgPool.query(HR_ATTENDANCE_EXISTING_SQL, [employeeIds, dates])).rows
      : [];
  const existing = new Set(
    existingRows.map((row: any) => `${row.employeeId}|${row.attendanceDateAD}`)
  );

  for (const row of rows) {
    if (!row.record) continue;
    row.action = existing.has(`${row.record.employeeId}|${row.record.attendanceDateAD}`)
      ? 'UPDATE'
      : 'CREATE';
  }

  const validRows = rows.filter((row) => row.record);
  const datesToResolve = [...new Set(validRows.map((row) => row.record!.attendanceDateAD))];
  const bsByDate = new Map<string, string>();
  for (const date of datesToResolve) {
    bsByDate.set(date, await resolveBsDateForLedger(date));
  }
  for (const row of validRows) {
    row.record!.attendanceDateBS = bsByDate.get(row.record!.attendanceDateAD) || '';
  }

  const created = rows.filter((row) => row.action === 'CREATE').length;
  const updated = rows.filter((row) => row.action === 'UPDATE').length;
  const skipped = rows.filter((row) => row.action === 'SKIP').length;

  if (validRows.length > 0) {
    const auditBranches = new Set(validRows.map((row) => row.record!.branchId));
    const auditBranch = auditBranches.size === 1 ? [...auditBranches][0] : undefined;
    await withTransaction(async (client) => {
      for (const row of validRows) {
        const record = row.record!;
        await client.query(HR_ATTENDANCE_UPSERT_SQL, [
          `att-${crypto.randomUUID()}`,
          record.employeeId,
          record.branchId,
          record.attendanceDateAD,
          record.attendanceDateBS,
          record.shiftId,
          record.status,
          record.checkInTime,
          record.checkOutTime,
          record.overtimeHours,
          record.notes,
          'IMPORT',
          actorOf(req),
          actorOf(req),
        ]);
      }
      await logAuditEvent(
        req,
        'IMPORT_HR_ATTENDANCE',
        'ACCOUNTING',
        `Imported attendance CSV: ${created} created, ${updated} updated, ${skipped} skipped`,
        auditBranch,
        client
      );
    });
  }

  return res.json({
    totalRows: rows.length,
    validRows: validRows.length,
    created,
    updated,
    skipped,
    rows: rows.map((row) => ({
      rowNumber: row.rowNumber,
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      attendanceDateAD: row.attendanceDateAD,
      action: row.action,
      errors: row.errors,
    })),
  });
}
