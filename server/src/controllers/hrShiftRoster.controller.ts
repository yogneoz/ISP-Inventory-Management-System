/**
 * Shift roster (`/api/hr/shift-roster`) — the weekly planner behind the mobile
 * bootstrap's "today's shift".
 *
 * Before this controller the roster table had no writer at all, so a phone's
 * `shiftWindow` was always `NO_SHIFT`. Every row is branch-scoped from the
 * session, the employee must belong to that branch, and the BS half is derived
 * server-side (`resolveBsDateForLedgerSync`) so the dual-date guard holds.
 */
import type { Response } from 'express';
import { pgPool } from '../app';
import { ApiError } from '../errors/ApiError';
import { getUserFromReq } from '../middleware/auth';
import { logAuditEvent } from '../services/audit.service';
import { resolveBsDateForLedgerSync } from '../utils/bsDate';
import { businessDateAD } from '../../../shared/businessDate';
import {
  HR_SHIFT_ROSTER_DELETE_SQL,
  HR_SHIFT_ROSTER_EMPLOYEE_SQL,
  HR_SHIFT_ROSTER_LIST_SQL,
  HR_SHIFT_ROSTER_SHIFT_EXISTS_SQL,
  HR_SHIFT_ROSTER_UPSERT_SQL,
} from '../models/hrShiftRoster.repo';

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isoDateOrNull(value: unknown): string | null {
  const raw = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? null : raw;
}

function addDays(dateAD: string, days: number): string {
  const base = new Date(`${dateAD}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Branch scope from the session; a privileged account must name one. */
function branchForWrite(req: any): string {
  const user = getUserFromReq(req);
  const requested = text(req.body?.branchId, 50) || text(req.query?.branchId, 50);
  if (user.role === 'SUPER_ADMIN' || user.role === 'HEAD_OFFICE_ADMIN' || user.branchId === 'ALL') {
    if (!requested || requested === 'ALL') {
      throw new ApiError(400, 'branchId is required for a company-wide account.');
    }
    return requested;
  }
  return String(user.branchId || '');
}

/** GET /api/hr/shift-roster?from=&to=&branchId= */
export async function get_hrShiftRoster(req: any, res: Response): Promise<any> {
  const branchId = branchForWrite(req);
  const from = isoDateOrNull(req.query?.from) || businessDateAD();
  const to = isoDateOrNull(req.query?.to) || addDays(from, 6);
  if (to < from) throw new ApiError(400, '`to` must not be before `from`.');
  const rows = (await pgPool.query(HR_SHIFT_ROSTER_LIST_SQL, [branchId, from, to])).rows;
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ branchId, from, to, roster: rows });
}

/** POST /api/hr/shift-roster — one seat (employee + date + shift), idempotent. */
export async function post_hrShiftRoster(req: any, res: Response): Promise<any> {
  const branchId = branchForWrite(req);
  const employeeId = text(req.body?.employeeId, 50);
  const shiftId = text(req.body?.shiftId, 50);
  const shiftDateAD = isoDateOrNull(req.body?.shiftDateAD) || isoDateOrNull(req.body?.shiftDateAd);
  if (!employeeId) throw new ApiError(400, 'employeeId is required.');
  if (!shiftId) throw new ApiError(400, 'shiftId is required.');
  if (!shiftDateAD) throw new ApiError(400, 'shiftDateAD must be a real date in YYYY-MM-DD form.');

  const employee = (await pgPool.query(HR_SHIFT_ROSTER_EMPLOYEE_SQL, [employeeId])).rows[0];
  if (!employee) throw new ApiError(404, 'The employee does not exist.');
  if (String(employee.branchId) !== String(branchId)) {
    throw new ApiError(403, 'An employee cannot be rostered into another branch.');
  }
  const shift = (await pgPool.query(HR_SHIFT_ROSTER_SHIFT_EXISTS_SQL, [shiftId])).rows[0];
  if (!shift) throw new ApiError(404, 'The shift does not exist.');

  const id = `hr-roster-${employeeId}-${shiftId}-${shiftDateAD}`.slice(0, 60);
  const row = (
    await pgPool.query(HR_SHIFT_ROSTER_UPSERT_SQL, [
      id,
      employeeId,
      shiftId,
      branchId,
      shiftDateAD,
      resolveBsDateForLedgerSync(shiftDateAD),
    ])
  ).rows[0];

  await logAuditEvent(
    req,
    'HR_SHIFT_ROSTER_UPSERT',
    'OPERATIONS',
    `Rostered ${employee.name} on ${shiftDateAD} (shift ${shiftId})`,
    branchId
  );
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(201).json({
    id: row.id,
    employeeId: row.employeeId,
    employeeName: employee.name,
    shiftId: row.shiftId,
    branchId: row.branchId,
    shiftDateAD: row.shiftDateAD,
    shiftDateBS: row.shiftDateBS,
  });
}

/** DELETE /api/hr/shift-roster/:id */
export async function delete_hrShiftRoster(req: any, res: Response): Promise<any> {
  const branchId = branchForWrite(req);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'A roster id is required.');
  const row = (await pgPool.query(HR_SHIFT_ROSTER_DELETE_SQL, [id, branchId])).rows[0];
  if (!row) throw new ApiError(404, 'No roster row with that id exists in this branch.');
  await logAuditEvent(req, 'HR_SHIFT_ROSTER_DELETE', 'OPERATIONS', `Removed roster row ${id}`, branchId);
  return res.json({ removed: true, id: row.id });
}
