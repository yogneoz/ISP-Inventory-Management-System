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
import crypto from 'node:crypto';
import { pgPool, permissionMatrix } from '../app';
import { withTransaction } from '../db/transactions';
import { ApiError } from '../errors/ApiError';
import { logAuditEvent } from './audit.service';
import { resolveBsDateForLedger, resolveBsDateForLedgerSync } from '../utils/bsDate';
import {
  IDEMPOTENCY_COMPLETE_SQL,
  IDEMPOTENCY_INSERT_SQL,
  IDEMPOTENCY_LOOKUP_SQL,
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
  MOBILE_ROSTER_SQL,
  MOBILE_WORK_ORDER_COMPLETE_SQL,
  MOBILE_WORK_ORDER_SQL,
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
  return new Date().toISOString().slice(0, 10);
}

function nowTime(): string {
  return new Date().toISOString().slice(11, 16);
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
 * that moves the number. The GeofenceEvaluator on the phone computes a richer
 * score for display; this one is what the database keeps.
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
  const windowEnd = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const [roster, announcements, pendingLeave, pendingClaims, attendance] = await Promise.all([
    pgPool.query(MOBILE_ROSTER_SQL, [employee.id, today, windowEnd]),
    pgPool.query(MOBILE_ANNOUNCEMENTS_SQL, [employee.branch_id]),
    pgPool.query(MOBILE_PENDING_LEAVE_COUNT_SQL, [employee.id]),
    pgPool.query(MOBILE_PENDING_CLAIM_COUNT_SQL, [employee.id]),
    pgPool.query(MOBILE_ATTENDANCE_TODAY_SQL, [employee.id, today]),
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
    punchState,
    shiftWindow: first ? `${first.shiftDateAd} ${first.startHour}:${String(first.startMinute).padStart(2, '0')}–${first.endHour}:${String(first.endMinute).padStart(2, '0')}` : 'NO_SHIFT',
    unreadNotices: announcements.rows.length,
    pendingApprovals: Number(pendingLeave.rows[0]?.pending || 0) + Number(pendingClaims.rows[0]?.pending || 0),
    vanLocation: employee.branch_code,
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
  const verdict = evaluateGeofence(employee, latitude, longitude, accuracy);
  if (verdict.configured && !verdict.inside) {
    throw new ApiError(
      422,
      `Outside the branch geofence: this punch is ${verdict.distanceMeters} m from the branch and the fence is ${verdict.radiusMeters} m.`
    );
  }
  const integrity = integrityFor(verdict, accuracy);
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
      `${action === 'CLOCK_IN' ? 'Clocked in' : 'Clocked out'} at ${punchTime} on ${attendanceDateAd} (${integrity.status}, risk ${integrity.riskScore})`,
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

export async function pullChanges(employee: any, since: unknown, limit: unknown): Promise<any> {
  const cursor = Math.max(0, Math.trunc(Number(since) || 0));
  const size = Math.min(MAX_PULL_ROWS, Math.max(1, Math.trunc(Number(limit) || 200)));
  const rows = (await pgPool.query(MOBILE_CHANGE_PULL_SQL, [cursor, employee.id, size])).rows;
  const serverCursor = rows.length ? Number(rows[rows.length - 1].seq) : cursor;
  return {
    serverCursor,
    revokedDevice: false,
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
  const row = (
    await pgPool.query(MOBILE_CLAIM_INSERT_SQL, [
      claimId,
      employee.id,
      employee.branch_id,
      category,
      Math.round(amount * 100) / 100,
      text(body?.currency, 3) || 'NPR',
      text(body?.ticketCode, 60) || null,
      description,
      Boolean(body?.receiptAttached),
    ])
  ).rows[0];
  await pgPool.query(MOBILE_CHANGE_INSERT_SQL, [
    'EXPENSE_CLAIM',
    row.id,
    'UPSERT',
    employee.branch_id,
    employee.id,
    JSON.stringify({ id: row.id, status: row.status, amount }),
  ]);
  return {
    claimId: row.id,
    status: row.status,
    accountingOutboxStatus: 'QUEUED',
    submittedAt: row.submitted_at,
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

export async function claimForEmployee(employee: any, claimId: string): Promise<any> {
  const row = (
    await pgPool.query(MOBILE_CLAIM_BY_ID_SQL, [text(claimId, 60), employee.id])
  ).rows[0];
  if (!row) throw new ApiError(404, 'Claim not found.');
  return row;
}
