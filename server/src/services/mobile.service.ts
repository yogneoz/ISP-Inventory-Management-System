/**
 * Mobile client backend (`/api/v1/*`) — the behaviour behind the routes.
 *
 * PulseHR is offline-first: it queues writes with an `idempotencyKey`, carries a
 * `baseVersion` for optimistic concurrency, and pulls changes with a cursor.
 * This service is what makes those three promises true on the server:
 *
 *   - a replayed punch returns the first response instead of writing twice;
 *   - a stale work-order completion is a 409, not an overwrite;
 *   - `/sync/pull` reads `mobile_change_log` by monotonic `seq`.
 *
 * The employee is always the one linked to the signed-in account
 * (`users.id → employees.user_id`). No route accepts an employee id from the
 * body, so a signed-in phone cannot act for a colleague.
 *
 * Geofencing is evaluated HERE from the branch's stored coordinates. The client
 * sends its own `distanceMeters` for diagnostics only; a claim the server has
 * not computed is never trusted.
 */
import { addDaysAD, businessDateAD, businessTimeHHMM } from '../../../shared/businessDate';
import { workplaceCapabilitiesFor } from '../../../shared/workplaceCapabilities';
import crypto from 'node:crypto';
import { pgPool, permissionMatrix } from '../app';
import { withTransaction } from '../db/transactions';
import { ApiError } from '../errors/ApiError';
import { logAuditEvent } from './audit.service';
import { resolveBsDateForLedger, resolveBsDateForLedgerSync } from '../utils/bsDate';
import { assignFieldWorkOrder, technicianDispatchState } from '../models/fieldWorkOrders.repo';
import {
  appendFieldWorkOrderEvidence,
  listFieldWorkOrderEvidence,
} from '../models/fieldWorkOrderEvidence.repo';
import { parseEvidenceBody } from './workOrderEvidence.service';
import { enqueueExpenseClaimOutbox } from './accountingOutbox.service';
import {
  IDEMPOTENCY_COMPLETE_SQL,
  IDEMPOTENCY_INSERT_SQL,
  IDEMPOTENCY_LOOKUP_SQL,
  MOBILE_DEVICE_ADMIT_SQL,
  MOBILE_DEVICE_REVOKE_SQL,
  MOBILE_DEVICE_STATE_SQL,
  MOBILE_DEVICE_TOUCH_SQL,
  MOBILE_ANNOUNCEMENTS_SQL,
  MOBILE_ATTENDANCE_PROOF_UPSERT_SQL,
  MOBILE_ATTENDANCE_TODAY_SQL,
  MOBILE_ATTENDANCE_UPSERT_SQL,
  MOBILE_CHANGE_INSERT_SQL,
  MOBILE_CHANGE_PULL_SQL,
  MOBILE_CLAIM_BY_ID_SQL,
  MOBILE_CLAIM_INSERT_SQL,
  MOBILE_DELEGATE_EXISTS_SQL,
  MOBILE_DELEGATION_INSERT_SQL,
  MOBILE_DEVICE_BIND_SQL,
  MOBILE_EMPLOYEE_BY_USER_SQL,
  MOBILE_EMPLOYEE_STOCK_CONSUME_SQL,
  MOBILE_FCM_UPSERT_SQL,
  MOBILE_PENDING_CLAIM_COUNT_SQL,
  MOBILE_PENDING_LEAVE_COUNT_SQL,
  MOBILE_REFRESH_FIND_SQL,
  MOBILE_REFRESH_INSERT_SQL,
  MOBILE_REFRESH_REVOKE_SQL,
  MOBILE_JOB_QUEUE_SQL,
  MOBILE_ROSTER_SQL,
  MOBILE_SYNC_REJECTION_COUNT_SQL,
  MOBILE_SYNC_REJECTION_UPSERT_SQL,
  MOBILE_VAN_STOCK_SQL,
  MOBILE_WORK_ORDER_BRANCH_SQL,
  MOBILE_WORK_ORDER_COMPLETE_SQL,
  MOBILE_WORK_ORDER_SQL,
  MOBILE_TECHNICIAN_IN_BRANCH_SQL,
} from '../models/mobile.repo';

export const REFRESH_TOKEN_TTL_DAYS = 30;

const MAX_PULL_ROWS = 500;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDateOrNull(value: unknown): string | null {
  const raw = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? null : raw;
}

/** `HH:MM` or `HH:MM:SS` from a wall-clock string; null when it is not a time. */
function timeOrNull(value: unknown): string | null {
  const raw = text(value, 8);
  if (/^\d{2}:\d{2}$/.test(raw)) return raw;
  if (/^\d{2}:\d{2}:\d{2}$/.test(raw)) return raw.slice(0, 5);
  return null;
}

function todayAD(): string {
  return businessDateAD();
}

function nowTime(): string {
  // A punch with no client time is stamped in the office's wall clock, not
  // UTC's: 06:30 in Kathmandu is 00:45 on the UTC clock.
  return businessTimeHHMM();
}

function requestHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

/** Great-circle distance in metres. */
export function haversineMeters(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const dLat = rad(toLat - fromLat);
  const dLng = rad(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(fromLat)) * Math.cos(rad(toLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

export interface GeofenceVerdict {
  configured: boolean;
  distanceMeters: number | null;
  radiusMeters: number | null;
  inside: boolean;
}

/** A punch whose device clock differs from the server's by more than this is
 * stored and held for a supervisor instead of being refused: a wrong clock is
 * common on cheap phones and the technician did still turn up for work. */
export const PUNCH_CLOCK_SKEW_LIMIT_MS = 15 * 60 * 1000;

export type PunchVerdict = 'ACCEPTED' | 'FLAGGED' | 'HELD';

export interface PunchJudgement {
  verdict: PunchVerdict;
  integrityStatus: 'VERIFIED' | 'SUSPECT' | 'HELD';
  riskScore: number;
  notes: string;
  heldReason: string | null;
  clockSkewMs: number | null;
  geofence: GeofenceVerdict;
}

/**
 * Judge a punch instead of dropping it.
 *
 * v2's rule: a suspicious punch is accepted, scored and flagged, because a
 * wrongly rejected punch costs a technician a day of pay. Out of the fence is
 * FLAGGED; a device clock more than fifteen minutes away from the server's is
 * HELD (accepted, stored, waiting for a supervisor). Neither is a refusal.
 */
export function judgePunch(
  employee: any,
  coords: { latitude: number; longitude: number; accuracyMeters: number | null },
  deviceTimeEpochMs: number | null,
  serverNow: number = Date.now()
): PunchJudgement {
  const verdict = evaluateGeofence(employee, coords.latitude, coords.longitude, coords.accuracyMeters);
  const clockSkewMs =
    deviceTimeEpochMs !== null && Number.isFinite(deviceTimeEpochMs)
      ? Math.round(deviceTimeEpochMs - serverNow)
      : null;
  const notes: string[] = [];
  let risk = 0;

  if (coords.accuracyMeters !== null && coords.accuracyMeters > 50) {
    risk = 45;
    notes.push(`GPS accuracy ${Math.round(coords.accuracyMeters)} m`);
  } else if (coords.accuracyMeters !== null && coords.accuracyMeters > 20) {
    risk = 15;
    notes.push(`GPS accuracy ${Math.round(coords.accuracyMeters)} m`);
  }

  if (verdict.configured && verdict.distanceMeters !== null) {
    notes.push(
      `${verdict.distanceMeters} m from the branch fence (radius ${verdict.radiusMeters} m)`
    );
  } else {
    notes.push('No branch fence configured');
  }

  let heldReason: string | null = null;
  if (clockSkewMs !== null && Math.abs(clockSkewMs) > PUNCH_CLOCK_SKEW_LIMIT_MS) {
    const minutes = Math.round(Math.abs(clockSkewMs) / 60_000);
    heldReason = `Device clock differs from the server by ${minutes} minute(s)`;
    notes.push(heldReason);
    risk = Math.max(risk, 70);
  }

  const outside = verdict.configured && !verdict.inside;
  if (outside) {
    risk = Math.max(risk, 60);
    notes.push('Outside the branch fence: accepted and flagged for supervisor review');
  }

  const punchVerdict: PunchVerdict = heldReason ? 'HELD' : outside || risk >= 40 ? 'FLAGGED' : 'ACCEPTED';
  return {
    verdict: punchVerdict,
    integrityStatus: heldReason ? 'HELD' : risk >= 40 || outside ? 'SUSPECT' : 'VERIFIED',
    riskScore: risk,
    notes: notes.join('; ').slice(0, 500),
    heldReason,
    clockSkewMs,
    geofence: verdict,
  };
}

/** The branch's stored fence, with the phone's accuracy as a tolerance. */
export function evaluateGeofence(
  employee: any,
  latitude: number,
  longitude: number,
  accuracyMeters: number | null
): GeofenceVerdict {
  const fenceLat = numberOrNull(employee?.geofence_latitude);
  const fenceLng = numberOrNull(employee?.geofence_longitude);
  if (fenceLat === null || fenceLng === null) {
    // No fence configured is not a refusal: a head-office desk worker has none,
    // and the proof still records where the punch happened.
    return { configured: false, distanceMeters: null, radiusMeters: null, inside: true };
  }
  const radius = numberOrNull(employee?.geofence_radius_meters) ?? 150;
  const distance = haversineMeters(fenceLat, fenceLng, latitude, longitude);
  const tolerance = Math.max(0, accuracyMeters ?? 0);
  return {
    configured: true,
    distanceMeters: distance,
    radiusMeters: radius,
    inside: distance <= radius + tolerance,
  };
}

/**
 * A cheap integrity score, not a fraud model: a coarse GPS fix is the only
 * signal this server can see without device attestation, so it is the only one
 * that moves the number. Kept as the accuracy-only projection the older tests
 * and callers use; `judgePunch` is the full verdict.
 */
export function integrityFor(
  verdict: GeofenceVerdict,
  accuracyMeters: number | null
): { status: 'VERIFIED' | 'SUSPECT'; riskScore: number; notes: string } {
  let risk = 0;
  const notes: string[] = [];
  if (accuracyMeters !== null && accuracyMeters > 50) {
    risk = 45;
    notes.push(`GPS accuracy ${Math.round(accuracyMeters)} m`);
  } else if (accuracyMeters !== null && accuracyMeters > 20) {
    risk = 15;
    notes.push(`GPS accuracy ${Math.round(accuracyMeters)} m`);
  }
  if (verdict.configured && verdict.distanceMeters !== null) {
    notes.push(
      `${verdict.distanceMeters} m from the branch fence (radius ${verdict.radiusMeters} m)`
    );
  } else {
    notes.push('No branch fence configured');
  }
  return {
    status: risk >= 40 ? 'SUSPECT' : 'VERIFIED',
    riskScore: risk,
    notes: notes.join('; ').slice(0, 500),
  };
}

/** The caller's own employee record; 404 when the account has none. */
export async function resolveEmployeeForUser(userId: string): Promise<any> {
  const employee = (await pgPool.query(MOBILE_EMPLOYEE_BY_USER_SQL, [userId])).rows[0];
  if (!employee) {
    throw new ApiError(404, 'No employee record is linked to this account.');
  }
  return employee;
}

export function capabilitiesForUser(user: any): string[] {
  const role = String(user?.role || '');
  if (!role) return [];
  const capabilities: string[] = [];
  for (const [operation, roles] of Object.entries(permissionMatrix || {})) {
    if (role === 'SUPER_ADMIN') {
      capabilities.push(operation);
      continue;
    }
    const grant = (roles as Record<string, boolean>)?.[role];
    if (grant) capabilities.push(operation);
  }
  return capabilities;
}

function shiftDto(row: any): any {
  const start = String(row.start_time || '00:00').slice(0, 5);
  const end = String(row.end_time || '00:00').slice(0, 5);
  return {
    id: row.id,
    shiftCode: row.shift_code,
    shiftName: row.shift_name,
    shiftDateAd: String(row.shift_date_ad).slice(0, 10),
    startHour: Number(start.slice(0, 2)),
    startMinute: Number(start.slice(3, 5)),
    endHour: Number(end.slice(0, 2)),
    endMinute: Number(end.slice(3, 5)),
    crossesMidnight: end < start,
    workMode: 'FIELD',
    requireGeofenceCheckIn: true,
    requireGeofenceCheckOut: false,
    branchCode: row.branch_code,
    sequenceNo: 1,
    isStandby24x7: false,
  };
}

/**
 * The home screen's one call: roster, punch state, notices and counters.
 * `geofence` is included so the app can show the fence it is being measured
 * against instead of guessing one.
 */
export async function buildBootstrap(user: any, employee: any): Promise<any> {
  const today = todayAD();
  const windowEnd = addDaysAD(today, 14);
  const [roster, announcements, pendingLeave, pendingClaims, attendance, needsAttention] =
    await Promise.all([
      pgPool.query(MOBILE_ROSTER_SQL, [employee.id, today, windowEnd]),
      pgPool.query(MOBILE_ANNOUNCEMENTS_SQL, [employee.branch_id]),
      pgPool.query(MOBILE_PENDING_LEAVE_COUNT_SQL, [employee.id]),
      pgPool.query(MOBILE_PENDING_CLAIM_COUNT_SQL, [employee.id]),
      pgPool.query(MOBILE_ATTENDANCE_TODAY_SQL, [employee.id, today]),
      pgPool.query(MOBILE_SYNC_REJECTION_COUNT_SQL, [employee.id]),
    ]);

  const todayRow = attendance.rows[0] || null;
  const punchState = !todayRow?.check_in_time
    ? 'NOT_CLOCKED_IN'
    : todayRow.check_out_time
      ? 'CLOCKED_OUT'
      : 'CLOCKED_IN';
  const shifts = roster.rows.map(shiftDto);
  const first = shifts[0];

  return {
    serverTimeEpochMs: Date.now(),
    capabilities: capabilitiesForUser(user),
    workplaceCapabilities: workplaceCapabilitiesFor(capabilitiesForUser(user)),
    punchState,
    shiftWindow: first ? `${first.shiftDateAd} ${first.startHour}:${String(first.startMinute).padStart(2, '0')}–${first.endHour}:${String(first.endMinute).padStart(2, '0')}` : 'NO_SHIFT',
    unreadNotices: announcements.rows.length,
    pendingApprovals: Number(pendingLeave.rows[0]?.pending || 0) + Number(pendingClaims.rows[0]?.pending || 0),
    vanLocation: employee.branch_code,
    needsAttention: Number(needsAttention.rows[0]?.pending || 0),
    shifts,
    announcements: announcements.rows.map((row: any) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      category: row.category,
      publishedAt: row.published_at,
      isUrgent: row.is_urgent,
    })),
    geofence: {
      configured: numberOrNull(employee.geofence_latitude) !== null,
      latitude: numberOrNull(employee.geofence_latitude),
      longitude: numberOrNull(employee.geofence_longitude),
      radiusMeters: numberOrNull(employee.geofence_radius_meters),
    },
    todayAttendance: todayRow
      ? {
          id: todayRow.id,
          checkInTime: todayRow.check_in_time,
          checkOutTime: todayRow.check_out_time,
          status: todayRow.status,
        }
      : null,
  };
}

export interface PunchInput {
  action: unknown;
  attendanceDateAd: unknown;
  punchTime: unknown;
  latitude: unknown;
  longitude: unknown;
  distanceMeters: unknown;
  gpsAccuracyMeters: unknown;
  wifiBssid: unknown;
  deviceId: unknown;
  deviceTimeEpochMs: unknown;
  idempotencyKey: unknown;
}

/**
 * One punch, at most once per key.
 *
 * The whole write — attendance row, proof, change-log entry, audit row and the
 * stored idempotency response — is one transaction. A duplicate key that is
 * still in flight answers 409 ("retry shortly") rather than pretending success,
 * because a second punch must never be silently swallowed.
 */
export async function submitPunch(req: any, employee: any, body: PunchInput): Promise<any> {
  const action = text(body?.action, 10).toUpperCase();
  if (action !== 'CLOCK_IN' && action !== 'CLOCK_OUT') {
    throw new ApiError(400, 'action must be CLOCK_IN or CLOCK_OUT.');
  }
  const attendanceDateAd = isoDateOrNull(body?.attendanceDateAd) || todayAD();
  const punchTime = timeOrNull(body?.punchTime) || nowTime();
  const latitude = numberOrNull(body?.latitude);
  const longitude = numberOrNull(body?.longitude);
  if (latitude === null || longitude === null) {
    throw new ApiError(400, 'A punch needs its latitude and longitude.');
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new ApiError(400, 'The punch coordinates are outside the valid range.');
  }
  const accuracy = numberOrNull(body?.gpsAccuracyMeters);
  // Out of the fence and a skewed device clock are judgements, not refusals:
  // the punch is stored with its verdict so a supervisor can review it.
  const judgement = judgePunch(
    employee,
    { latitude, longitude, accuracyMeters: accuracy },
    numberOrNull(body?.deviceTimeEpochMs)
  );
  const verdict = judgement.geofence;
  const integrity = {
    status: judgement.integrityStatus,
    riskScore: judgement.riskScore,
    notes: judgement.notes,
  };
  const key = text(body?.idempotencyKey, 160);
  const hash = requestHash({ action, attendanceDateAd, employeeId: employee.id, latitude, longitude });
  const attendanceDateBs = await resolveBsDateForLedger(attendanceDateAd);
  const actor = String(req.user?.email || req.user?.name || employee.employee_code);
  const attendanceId = `hr-att-${crypto.randomUUID()}`;

  return withTransaction(async (client) => {
    if (key) {
      const inserted = await client.query(IDEMPOTENCY_INSERT_SQL, [
        'mobile.punch',
        key,
        hash,
        null,
        null,
      ]);
      if (inserted.rowCount === 0) {
        const prior = (await client.query(IDEMPOTENCY_LOOKUP_SQL, ['mobile.punch', key])).rows[0];
        if (prior?.response_body && Number(prior.request_hash) !== 0) {
          if (prior.request_hash !== hash) {
            throw new ApiError(
              409,
              'This idempotency key was already used for a different punch.'
            );
          }
          return { ...prior.response_body, replayed: true };
        }
        throw new ApiError(409, 'This punch is still being processed; retry shortly.');
      }
    }

    const attendance = (
      await client.query(MOBILE_ATTENDANCE_UPSERT_SQL, [
        attendanceId,
        employee.id,
        employee.branch_id,
        attendanceDateAd,
        attendanceDateBs,
        action === 'CLOCK_IN' ? punchTime : null,
        action === 'CLOCK_OUT' ? punchTime : null,
        actor,
      ])
    ).rows[0];

    await client.query(MOBILE_ATTENDANCE_PROOF_UPSERT_SQL, [
      attendance.id,
      latitude,
      longitude,
      verdict.distanceMeters ?? 0,
      accuracy,
      text(body?.wifiBssid, 64) || null,
      text(body?.deviceId, 120) || null,
      numberOrNull(body?.deviceTimeEpochMs),
      verdict.inside,
      integrity.status,
      integrity.riskScore,
      integrity.notes,
      judgement.verdict,
      judgement.heldReason,
      judgement.clockSkewMs,
    ]);

    const response = {
      id: attendance.id,
      attendanceDateAd,
      action,
      syncStatus: 'SYNCED',
      serverTimestamp: new Date().toISOString(),
      integrityStatus: integrity.status,
      riskScore: integrity.riskScore,
      integrityNotes: integrity.notes,
      verdict: judgement.verdict,
      heldReason: judgement.heldReason,
      checkInTime: attendance.check_in_time,
      checkOutTime: attendance.check_out_time,
      geofence: verdict,
    };

    await client.query(MOBILE_CHANGE_INSERT_SQL, [
      'ATTENDANCE',
      attendance.id,
      'UPSERT',
      employee.branch_id,
      employee.id,
      JSON.stringify(response),
    ]);

    await logAuditEvent(
      req,
      action === 'CLOCK_IN' ? 'MOBILE_CLOCK_IN' : 'MOBILE_CLOCK_OUT',
      'OPERATIONS',
      `${action === 'CLOCK_IN' ? 'Clocked in' : 'Clocked out'} at ${punchTime} on ${attendanceDateAd} (${judgement.verdict}, ${integrity.status}, risk ${integrity.riskScore})`,
      String(employee.branch_id),
      client
    );

    if (key) {
      await client.query(IDEMPOTENCY_COMPLETE_SQL, [
        'mobile.punch',
        key,
        200,
        JSON.stringify(response),
      ]);
    }
    return response;
  });
}

export async function pullChanges(
  employee: any,
  since: unknown,
  limit: unknown,
  deviceId?: string
): Promise<any> {
  const cursor = Math.max(0, Math.trunc(Number(since) || 0));
  const size = Math.min(MAX_PULL_ROWS, Math.max(1, Math.trunc(Number(limit) || 200)));
  const rows = (await pgPool.query(MOBILE_CHANGE_PULL_SQL, [cursor, employee.id, size])).rows;
  const serverCursor = rows.length ? Number(rows[rows.length - 1].seq) : cursor;
  const device = deviceId ? await deviceState(deviceId) : null;
  // A device that was revoked, or that now belongs to someone else, must stop
  // pulling: this is what makes a revocation take effect at the next sync.
  const revokedDevice = Boolean(device && (device.revoked || device.employeeId !== String(employee.id)));
  return {
    serverCursor,
    revokedDevice,
    updatedNoticesCount: rows.filter((row: any) => row.entity === 'ANNOUNCEMENT').length,
    changes: rows.map((row: any) => ({
      seq: Number(row.seq),
      entity: row.entity,
      entityId: row.entity_id,
      operation: row.operation,
      changedAt: row.changed_at,
      payload: row.payload,
    })),
  };
}

/** Opaque refresh token: only its SHA-256 is stored, like a partner key. */
export async function issueRefreshToken(userId: string, deviceId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await pgPool.query(MOBILE_REFRESH_INSERT_SQL, [userId, deviceId, hash, expiresAt]);
  return token;
}

export async function consumeRefreshToken(token: string): Promise<string> {
  const hash = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  const row = (await pgPool.query(MOBILE_REFRESH_FIND_SQL, [hash])).rows[0];
  if (!row) throw new ApiError(401, 'This refresh token is not valid.');
  // Rotation: the presented token dies the moment it is used.
  await pgPool.query(MOBILE_REFRESH_REVOKE_SQL, [hash]);
  return String(row.user_id);
}

export async function registerDevice(employee: any, body: any): Promise<any> {
  const deviceId = text(body?.deviceId, 120);
  if (!deviceId) throw new ApiError(400, 'A deviceId is required.');
  const row = (
    await pgPool.query(MOBILE_DEVICE_BIND_SQL, [
      deviceId,
      employee.id,
      text(body?.modelName, 120),
      text(body?.appVersion, 40),
    ])
  ).rows[0];
  if (!row) {
    throw new ApiError(
      409,
      'This device is already bound to another employee. Ask an administrator to release it.'
    );
  }
  return { registered: true, deviceId: row.device_id, boundAt: row.bound_at };
}

export interface DeviceState {
  deviceId: string;
  employeeId: string | null;
  revoked: boolean;
  approved: boolean;
}

/** The approve/revoke state of one device, or null when it was never seen. */
export async function deviceState(deviceId: string): Promise<DeviceState | null> {
  if (!deviceId) return null;
  const row = (await pgPool.query(MOBILE_DEVICE_STATE_SQL, [deviceId])).rows[0];
  if (!row) return null;
  return {
    deviceId: row.device_id,
    employeeId: row.employee_id ? String(row.employee_id) : null,
    revoked: Boolean(row.revoked_at),
    approved: Boolean(row.approved_at),
  };
}

/**
 * Admit the device a successful password login names.
 *
 * Returns the state after the write. A device already bound to another
 * employee, or one that was revoked, is refused here — the same rule the
 * register route enforces, applied before a token is minted.
 */
export async function admitDevice(employee: any, body: any, actor: string): Promise<DeviceState> {
  const deviceId = text(body?.deviceId, 120);
  const existing = deviceId ? await deviceState(deviceId) : null;
  if (existing && existing.employeeId !== String(employee.id)) {
    throw new ApiError(403, 'This device is bound to another employee. Ask an administrator to release it.');
  }
  if (existing && existing.revoked) {
    throw new ApiError(403, 'This device was revoked. Ask HR or IT to approve it again.');
  }
  const row = (
    await pgPool.query(MOBILE_DEVICE_ADMIT_SQL, [
      deviceId,
      employee.id,
      text(body?.modelName, 120),
      text(body?.appVersion, 40),
      actor,
    ])
  ).rows[0];
  if (!row) {
    throw new ApiError(403, 'This device could not be admitted for this employee.');
  }
  await pgPool.query(MOBILE_DEVICE_TOUCH_SQL, [deviceId]);
  return {
    deviceId: row.device_id,
    employeeId: row.employee_id ? String(row.employee_id) : null,
    revoked: false,
    approved: Boolean(row.approved_at),
  };
}

/** HR/IT revokes a lost or shared phone. Sync reports it on the next pull. */
export async function revokeDevice(deviceId: string, actor: string): Promise<any> {
  const id = text(deviceId, 120);
  if (!id) throw new ApiError(400, 'A deviceId is required.');
  const row = (await pgPool.query(MOBILE_DEVICE_REVOKE_SQL, [id])).rows[0];
  if (!row) throw new ApiError(404, 'No active device has that id.');
  return {
    deviceId: row.device_id,
    employeeId: row.employee_id,
    revokedAt: row.revoked_at,
    revokedBy: actor,
  };
}

/**
 * GET /api/v1/workplace/jobs — the technician's own queue.
 *
 * Scoped by both `technician_id` and the employee's branch in SQL: an order
 * reassigned to someone else, or raised by another branch, simply is not here.
 */
export async function jobQueue(employee: any): Promise<any> {
  const rows = (await pgPool.query(MOBILE_JOB_QUEUE_SQL, [employee.id, employee.branch_id])).rows;
  return { jobs: rows, count: rows.length };
}

/** GET /api/v1/workplace/stock — what this technician is carrying. */
export async function vanStock(employee: any): Promise<any> {
  const rows = (await pgPool.query(MOBILE_VAN_STOCK_SQL, [employee.id, employee.branch_id])).rows;
  return {
    // `vanLocation` keeps the bootstrap's word for the same thing.
    vanLocation: employee.branch_code,
    holdings: rows,
    count: rows.length,
  };
}

/**
 * POST /api/v1/sync/push — the offline queue's batch.
 *
 * Each queued action is applied through the SAME service the single-action
 * route calls, so a batched punch cannot differ from a live one. The answer is
 * per item, and a refused item is retained whole in `mobile_sync_rejections`:
 * that row is what the Needs attention inbox lists and what a coordinator's fix
 * can replay. A refusal never fails the batch, so one bad item cannot block the
 * other nineteen captured at the site.
 */
export const MAX_PUSH_ACTIONS = 50;

export interface PushItemResult {
  clientId: string;
  kind: string;
  status: 'ACCEPTED' | 'FLAGGED' | 'HELD' | 'REJECTED';
  code: string | null;
  message: string | null;
  retryable: boolean;
  result: any;
}

function rejectionCode(status: number): string {
  if (status === 400) return 'VALIDATION_ERROR';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  return 'REFUSED';
}

export async function pushActions(req: any, employee: any, body: any): Promise<any> {
  const actions = Array.isArray(body?.actions) ? body.actions.slice(0, MAX_PUSH_ACTIONS) : [];
  if (actions.length === 0) {
    throw new ApiError(400, 'actions must contain at least one queued action.');
  }
  const results: PushItemResult[] = [];

  for (const action of actions) {
    const clientId = text(action?.clientId, 120);
    const kind = text(action?.kind, 40).toUpperCase();
    const payload = action?.payload && typeof action.payload === 'object' ? action.payload : {};
    if (!clientId) {
      throw new ApiError(400, 'Every queued action needs a clientId.');
    }
    if (!['PUNCH', 'CLAIM', 'WORK_ORDER_COMPLETE'].includes(kind)) {
      throw new ApiError(400, `Unknown queued action kind '${kind}'.`);
    }
    const idempotencyKey = text(action?.idempotencyKey, 160) || text(payload?.idempotencyKey, 160);
    const withKey = { ...payload, idempotencyKey: idempotencyKey || undefined };

    try {
      let result: any;
      let status: PushItemResult['status'] = 'ACCEPTED';
      if (kind === 'PUNCH') {
        result = await submitPunch(req, employee, withKey as PunchInput);
        if (result?.verdict === 'FLAGGED' || result?.verdict === 'HELD') status = result.verdict;
      } else if (kind === 'CLAIM') {
        result = await submitClaim(req, employee, withKey);
      } else {
        const workOrderId = text(payload?.workOrderId, 60);
        if (!workOrderId) throw new ApiError(400, 'A work-order completion needs workOrderId.');
        result = await completeWorkOrder(req, employee, workOrderId, withKey);
      }
      results.push({ clientId, kind, status, code: null, message: null, retryable: false, result });
    } catch (err: any) {
      if (!(err instanceof ApiError)) throw err;
      // Keep the captured action, not just its error: the inbox can replay it.
      await pgPool.query(MOBILE_SYNC_REJECTION_UPSERT_SQL, [
        clientId,
        kind,
        employee.id,
        employee.branch_id,
        idempotencyKey || null,
        rejectionCode(err.status),
        String(err.message || 'Refused').slice(0, 500),
        err.status >= 500,
        JSON.stringify(payload),
      ]);
      results.push({
        clientId,
        kind,
        status: 'REJECTED',
        code: rejectionCode(err.status),
        message: String(err.message || 'Refused'),
        retryable: err.status >= 500,
        result: null,
      });
    }
  }

  return {
    receivedCount: actions.length,
    acceptedCount: results.filter((item) => item.status === 'ACCEPTED').length,
    flaggedCount: results.filter((item) => item.status === 'FLAGGED').length,
    heldCount: results.filter((item) => item.status === 'HELD').length,
    rejectedCount: results.filter((item) => item.status === 'REJECTED').length,
    results,
    serverTimestampEpochMs: Date.now(),
  };
}

export async function registerFcmToken(employee: any, body: any): Promise<any> {
  const fcmToken = text(body?.fcmToken, 500);
  if (!fcmToken) throw new ApiError(400, 'An fcmToken is required.');
  const topics = Array.isArray(body?.topics)
    ? body.topics.map((topic: unknown) => text(topic, 60)).filter(Boolean)
    : [];
  const row = (
    await pgPool.query(MOBILE_FCM_UPSERT_SQL, [
      employee.id,
      text(body?.deviceId, 120),
      fcmToken,
      text(body?.platform, 20) || 'ANDROID',
      topics,
    ])
  ).rows[0];
  return { registered: true, topics: row?.topics ?? topics };
}

export async function submitClaim(req: any, employee: any, body: any): Promise<any> {
  const claimId = text(body?.claimId, 60) || `hr-claim-${crypto.randomUUID()}`;
  const amount = numberOrNull(body?.amount);
  if (amount === null || amount <= 0) throw new ApiError(400, 'A claim needs a positive amount.');
  const category = text(body?.category, 60) || 'GENERAL';
  const description = text(body?.description, 500);
  const currency = text(body?.currency, 3) || 'NPR';
  const rounded = Math.round(amount * 100) / 100;

  // The claim, its change-log row and its accounting-outbox row commit together:
  // an approved claim must never exist without the posting it owes.
  const result = await withTransaction(async (client) => {
    const row = (
      await client.query(MOBILE_CLAIM_INSERT_SQL, [
        claimId,
        employee.id,
        employee.branch_id,
        category,
        rounded,
        currency,
        text(body?.ticketCode, 60) || null,
        description,
        Boolean(body?.receiptAttached),
      ])
    ).rows[0];
    const outboxStatus = await enqueueExpenseClaimOutbox(client, {
      claimId: row.id,
      employeeId: String(employee.id),
      employeeName: employee.name || null,
      branchId: String(employee.branch_id),
      amount: rounded,
      currency,
      category,
      description: description || null,
    });
    await client.query(MOBILE_CHANGE_INSERT_SQL, [
      'EXPENSE_CLAIM',
      row.id,
      'UPSERT',
      employee.branch_id,
      employee.id,
      JSON.stringify({ id: row.id, status: row.status, amount: rounded }),
    ]);
    return { row, outboxStatus };
  });
  return {
    claimId: result.row.id,
    status: result.row.status,
    accountingOutboxStatus: result.outboxStatus,
    submittedAt: result.row.submitted_at,
  };
}

export async function createDelegation(req: any, employee: any, body: any): Promise<any> {
  const delegateId = text(body?.delegateEmployeeId, 60);
  if (!delegateId) throw new ApiError(400, 'A delegateEmployeeId is required.');
  if (delegateId === String(employee.id)) {
    throw new ApiError(400, 'An employee cannot delegate to themselves.');
  }
  const delegate = (await pgPool.query(MOBILE_DELEGATE_EXISTS_SQL, [delegateId])).rows[0];
  if (!delegate) throw new ApiError(404, 'The delegate employee does not exist.');
  if (String(delegate.branch_id) !== String(employee.branch_id)) {
    throw new ApiError(403, 'A delegation cannot cross branches.');
  }
  const endDate = isoDateOrNull(body?.endDate);
  if (!endDate) throw new ApiError(400, 'endDate must be a real date in YYYY-MM-DD form.');
  const startDate = isoDateOrNull(body?.startDate) || todayAD();
  if (endDate < startDate) throw new ApiError(400, 'endDate must not be before startDate.');
  const capabilities = text(body?.capabilitiesCsv, 300)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 20);
  const id = `hr-deleg-${crypto.randomUUID()}`;
  const row = (
    await pgPool.query(MOBILE_DELEGATION_INSERT_SQL, [
      id,
      employee.id,
      delegateId,
      capabilities,
      startDate,
      endDate,
      String(req.user?.email || employee.employee_code),
      resolveBsDateForLedgerSync(startDate),
      resolveBsDateForLedgerSync(endDate),
    ])
  ).rows[0];
  return {
    id: row.id,
    delegateEmployeeId: delegateId,
    delegateName: delegate.name,
    startDate: String(row.start_date_ad).slice(0, 10),
    endDate: String(row.end_date_ad).slice(0, 10),
    capabilities,
  };
}

export async function completeWorkOrder(req: any, employee: any, id: string, body: any): Promise<any> {
  const workOrderId = text(id, 60);
  if (!workOrderId) throw new ApiError(400, 'A work order id is required.');
  const existing = (
    await pgPool.query(MOBILE_WORK_ORDER_SQL, [workOrderId, employee.id])
  ).rows[0];
  if (!existing) throw new ApiError(404, 'This work order is not assigned to you.');
  const baseVersion = Number(body?.baseVersion);
  if (!Number.isInteger(baseVersion)) {
    throw new ApiError(400, 'baseVersion is required for an offline completion.');
  }
  const notes = [
    text(body?.completionNotes, 300),
    numberOrNull(body?.opticalPowerDbm) !== null ? `Rx ${body.opticalPowerDbm} dBm` : '',
    numberOrNull(body?.otdrLossDb) !== null ? `OTDR ${body.otdrLossDb} dB` : '',
    text(body?.customerSignatureName, 120) ? `Signed by ${text(body.customerSignatureName, 120)}` : '',
  ]
    .filter(Boolean)
    .join('; ')
    .slice(0, 1000);

  return withTransaction(async (client) => {
    const updated = (
      await client.query(MOBILE_WORK_ORDER_COMPLETE_SQL, [
        workOrderId,
        employee.id,
        baseVersion,
        notes || null,
        text(body?.serialUsed, 64) || null,
      ])
    ).rows[0];
    if (!updated) {
      throw new ApiError(
        409,
        'This work order changed since it was downloaded; refresh it before completing.'
      );
    }

    const consumed = Math.trunc(Number(body?.consumedCableMeters) || 0);
    const productId = text(body?.consumedProductId, 50);
    if (consumed > 0 && productId) {
      await client.query(MOBILE_EMPLOYEE_STOCK_CONSUME_SQL, [
        employee.id,
        productId,
        employee.branch_id,
        consumed,
        workOrderId,
        `Work order ${updated.work_order_no}`,
        String(req.user?.email || employee.employee_code),
      ]);
    }

    await logAuditEvent(
      req,
      'MOBILE_COMPLETE_WORK_ORDER',
      'OPERATIONS',
      `Completed work order ${updated.work_order_no} at version ${baseVersion}${consumed > 0 ? `, ${consumed} unit(s) consumed` : ''}`,
      String(employee.branch_id),
      client
    );

    return {
      workOrderId: updated.id,
      resultStatus: 'CLOSED',
      message: 'Operational close committed.',
      baseVersion: updated.row_version,
    };
  });
}

/**
 * Dispatch (or re-dispatch) a job to a technician, with the two stated rules:
 *
 *   - the technician must hold a roster seat on the visit's date
 *     (`NO_ROSTER_SEAT`);
 *   - the technician may not already hold the day's ceiling of open jobs
 *     (`DAILY_JOB_CAP`, 8).
 *
 * A supervisor (Super Admin, Head Office Admin, Branch Manager) may waive
 * either rule for an emergency callout, but only with a reason of at least 15
 * characters — the reason, the person and the waived rule names are stored on
 * the order. Branch scope and "the technician exists" are never overridable.
 */
export const DISPATCH_DAILY_JOB_CAP = 8;
const DISPATCH_OVERRIDE_ROLES = new Set(['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'BRANCH_MANAGER']);
const OVERRIDE_REASON_MIN = 15;

function dispatchRuleLabel(rule: string): string {
  return rule === 'NO_ROSTER_SEAT'
    ? 'the technician has no roster seat on that date'
    : `the technician already holds ${DISPATCH_DAILY_JOB_CAP} open jobs that day`;
}

export async function assignWorkOrder(req: any, employee: any, id: string, body: any): Promise<any> {
  const workOrderId = text(id, 60);
  if (!workOrderId) throw new ApiError(400, 'A work order id is required.');
  const order = (
    await pgPool.query(MOBILE_WORK_ORDER_BRANCH_SQL, [workOrderId, employee.branch_id])
  ).rows[0];
  if (!order) throw new ApiError(404, 'Work order not found in your branch.');
  if (!['OPEN', 'ASSIGNED'].includes(String(order.status))) {
    throw new ApiError(409, `Work order is ${String(order.status).toLowerCase()}; only an open or assigned order can be dispatched.`);
  }

  const technicianId = text(body?.technicianId, 60);
  if (!technicianId) throw new ApiError(400, 'A technicianId is required.');
  const technician = (
    await pgPool.query(MOBILE_TECHNICIAN_IN_BRANCH_SQL, [technicianId, employee.branch_id])
  ).rows[0];
  if (!technician) {
    throw new ApiError(400, 'That technician is not in this branch.', { code: 'UNKNOWN_TECHNICIAN' });
  }

  const scheduledDateAD = String(order.scheduled_date_ad || '').slice(0, 10);
  const state = await technicianDispatchState(technicianId, scheduledDateAD);
  const violated: string[] = [];
  if (!state.rostered) violated.push('NO_ROSTER_SEAT');
  if (state.openJobs >= DISPATCH_DAILY_JOB_CAP) violated.push('DAILY_JOB_CAP');

  let override: { reason: string; by: string; rules: string[] } | null = null;
  if (violated.length > 0) {
    const reason = text(body?.overrideReason, 500);
    if (!reason) {
      throw new ApiError(
        409,
        `Dispatch refused: ${violated.map(dispatchRuleLabel).join('; ')}. Send overrideReason to waive it.`,
        { code: 'DISPATCH_RULE' }
      );
    }
    if (reason.length < OVERRIDE_REASON_MIN) {
      throw new ApiError(400, `An overrideReason must be at least ${OVERRIDE_REASON_MIN} characters.`);
    }
    if (!DISPATCH_OVERRIDE_ROLES.has(String(req.user?.role))) {
      throw new ApiError(403, 'Forbidden: only a supervisor may override a dispatch rule.');
    }
    override = {
      reason,
      by: String(req.user?.email || employee.employee_code || 'unknown'),
      rules: violated,
    };
  }

  const updated = await assignFieldWorkOrder(
    workOrderId,
    technicianId,
    String(technician.name || technicianId),
    override
  );
  if (!updated) throw new ApiError(409, 'This work order changed while it was being dispatched; refresh it and try again.');

  await logAuditEvent(
    req,
    override ? 'MOBILE_DISPATCH_OVERRIDE' : 'MOBILE_DISPATCH_ASSIGN',
    'OPERATIONS',
    override
      ? `Dispatched ${order.work_order_no} to ${technician.name} overriding ${override.rules.join(', ')}: ${override.reason}`
      : `Dispatched ${order.work_order_no} to ${technician.name} for ${scheduledDateAD}`,
    String(employee.branch_id)
  );

  return {
    workOrderId: updated.id,
    workOrderNo: updated.work_order_no,
    technicianId,
    technicianName: technician.name,
    scheduledDateAD,
    status: updated.status,
    overridden: Boolean(override),
    overrideRules: override?.rules || [],
  };
}

/**
 * Store a proof-of-work capture on a job assigned to the caller. The bytes are
 * content-addressed, so a queued capture re-sent after a timeout returns the
 * stored row (`inserted: false`) instead of a duplicate.
 */
export async function attachWorkOrderEvidence(req: any, employee: any, id: string, body: any): Promise<any> {
  const workOrderId = text(id, 60);
  const order = (await pgPool.query(MOBILE_WORK_ORDER_SQL, [workOrderId, employee.id])).rows[0];
  if (!order) throw new ApiError(404, 'This work order is not assigned to you.');
  const parsed = parseEvidenceBody(body);
  const saved = await appendFieldWorkOrderEvidence({
    workOrderId: String(order.id),
    branchId: String(order.branch_id),
    kind: parsed.kind,
    contentType: parsed.contentType,
    dataBase64: parsed.dataBase64,
    caption: parsed.caption,
    capturedAt: parsed.capturedAt,
    capturedBy: String(req.user?.email || employee.employee_code || 'unknown'),
    latitude: parsed.latitude,
    longitude: parsed.longitude,
    accuracyMeters: parsed.accuracyMeters,
  });
  await logAuditEvent(
    req,
    'MOBILE_WORK_ORDER_EVIDENCE',
    'OPERATIONS',
    `${saved.inserted ? 'Captured' : 'Replayed'} ${parsed.kind.toLowerCase()} ${saved.sha256.slice(0, 12)} on ${order.work_order_no}`,
    String(employee.branch_id)
  );
  return {
    evidenceId: saved.row.id,
    workOrderId: String(order.id),
    kind: saved.row.kind,
    contentType: saved.row.content_type,
    byteSize: saved.row.byte_size,
    sha256: saved.sha256,
    capturedAt: saved.row.captured_at,
    inserted: saved.inserted,
    count: saved.count,
  };
}

export async function listWorkOrderEvidence(employee: any, id: string): Promise<any> {
  const workOrderId = text(id, 60);
  const order = (await pgPool.query(MOBILE_WORK_ORDER_SQL, [workOrderId, employee.id])).rows[0];
  if (!order) throw new ApiError(404, 'This work order is not assigned to you.');
  const rows = await listFieldWorkOrderEvidence(String(order.id));
  return {
    workOrderId: String(order.id),
    evidence: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      contentType: row.content_type,
      byteSize: row.byte_size,
      sha256: row.sha256,
      capturedAt: row.captured_at,
      caption: row.caption,
    })),
    count: rows.length,
  };
}

export async function claimForEmployee(employee: any, claimId: string): Promise<any> {
  const row = (
    await pgPool.query(MOBILE_CLAIM_BY_ID_SQL, [text(claimId, 60), employee.id])
  ).rows[0];
  if (!row) throw new ApiError(404, 'Claim not found.');
  return row;
}
