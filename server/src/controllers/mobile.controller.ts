/**
 * Mobile client API (`/api/v1/*`) — HTTP layer for PulseHR.
 *
 * Every handler here is thin on purpose: it validates the envelope, resolves
 * the caller's own employee, and delegates to a service or to the existing
 * self-service controller. No business rule is reimplemented for the phone, so
 * the web UI and the app cannot drift apart.
 *
 * Authentication: `/api/v1/auth/login` is the only open route. Everything else
 * runs behind the same HMAC bearer token the web client uses, so the existing
 * `authenticateUser` / branch gates apply unchanged. The employee is always
 * derived from the token (`users.id → employees.user_id`).
 */
import type { Response } from 'express';
import { pgPool } from '../app';
import { ApiError } from '../errors/ApiError';
import { issueAuthToken, verifyPassword } from '../middleware/auth';
import { USER_FIND_BY_EMAIL_SQL, USER_FIND_BY_ID_OR_EMAIL_SQL } from '../models/auth.repo';
import {
  MOBILE_BREADCRUMB_INSERT_SQL,
  MOBILE_CONTACT_UPDATE_SQL,
  MOBILE_REFRESH_REVOKE_SQL,
} from '../models/mobile.repo';
import {
  buildBootstrap,
  capabilitiesForUser,
  claimForEmployee,
  completeWorkOrder,
  consumeRefreshToken,
  createDelegation,
  issueRefreshToken,
  pullChanges,
  registerDevice,
  registerFcmToken,
  resolveEmployeeForUser,
  submitClaim,
  submitPunch,
} from '../services/mobile.service';

/** The web token lives 8 hours; the app refreshes long before that. */
const ACCESS_TOKEN_SECONDS = 8 * 60 * 60;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function ownEmployee(req: any): any {
  const user = req.user || {};
  if (!user.id) throw new ApiError(401, 'Unauthorized: Authentication required');
  return user;
}

/** POST /api/v1/auth/login */
export async function post_v1Login(req: any, res: Response): Promise<any> {
  const email = text(req.body?.email, 150).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password) throw new ApiError(400, 'email and password are required.');

  const dbUser = (await pgPool.query(USER_FIND_BY_EMAIL_SQL, [email])).rows[0];
  const check = dbUser ? verifyPassword(password, String(dbUser.password || '')) : { valid: false };
  if (!dbUser || !check.valid) throw new ApiError(401, 'Invalid email or password.');
  if (String(dbUser.status || 'active') !== 'active') {
    throw new ApiError(403, 'This account is not active. Contact an administrator.');
  }

  const employee = await resolveEmployeeForUser(dbUser.id);
  const deviceId = text(req.body?.deviceId, 120) || 'dev_and_primary';
  const refreshToken = await issueRefreshToken(dbUser.id, deviceId);

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    accessToken: issueAuthToken(dbUser as any),
    refreshToken,
    expiresInSeconds: ACCESS_TOKEN_SECONDS,
    userId: dbUser.id,
    email: dbUser.email,
    role: dbUser.role,
    employeeId: employee.id,
    capabilities: capabilitiesForUser(dbUser),
    branchScope: dbUser.branch_id || employee.branch_id || 'ALL',
    employeeName: employee.name,
    branchCode: employee.branch_code,
  });
}

/** POST /api/v1/auth/refresh — rotates the refresh token on every use. */
export async function post_v1Refresh(req: any, res: Response): Promise<any> {
  const presented = text(req.body?.refreshToken, 200);
  if (!presented) throw new ApiError(400, 'refreshToken is required.');
  const userId = await consumeRefreshToken(presented);
  const dbUser = (await pgPool.query(USER_FIND_BY_ID_OR_EMAIL_SQL, [userId, userId])).rows[0];
  if (!dbUser) throw new ApiError(401, 'This account no longer exists.');
  if (String(dbUser.status || 'active') !== 'active') {
    throw new ApiError(403, 'This account is not active.');
  }
  const employee = await resolveEmployeeForUser(dbUser.id);
  const refreshToken = await issueRefreshToken(dbUser.id, 'dev_and_primary');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    accessToken: issueAuthToken(dbUser as any),
    refreshToken,
    expiresInSeconds: ACCESS_TOKEN_SECONDS,
    userId: dbUser.id,
    email: dbUser.email,
    role: dbUser.role,
    employeeId: employee.id,
    capabilities: capabilitiesForUser(dbUser),
    branchScope: dbUser.branch_id || employee.branch_id || 'ALL',
  });
}

/** POST /api/v1/auth/logout — revokes the presented refresh token. */
export async function post_v1Logout(req: any, res: Response): Promise<any> {
  const presented = text(req.body?.refreshToken, 200);
  if (presented) {
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update(presented).digest('hex');
    await pgPool.query(MOBILE_REFRESH_REVOKE_SQL, [hash]);
  }
  return res.json({ loggedOut: true });
}

/** GET /api/v1/workplace/bootstrap */
export async function get_v1Bootstrap(req: any, res: Response): Promise<any> {
  const user = ownEmployee(req);
  const employee = await resolveEmployeeForUser(user.id);
  const payload = await buildBootstrap(user, employee);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(payload);
}

/** GET /api/v1/sync/pull?updated_since=&limit= */
export async function get_v1SyncPull(req: any, res: Response): Promise<any> {
  const user = ownEmployee(req);
  const employee = await resolveEmployeeForUser(user.id);
  const payload = await pullChanges(employee, req.query.updated_since, req.query.limit);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(payload);
}

/** POST /api/v1/workplace/attendance/punch */
export async function post_v1Punch(req: any, res: Response): Promise<any> {
  const user = ownEmployee(req);
  const employee = await resolveEmployeeForUser(user.id);
  const suppliedEmployee = text(req.body?.employeeId, 50);
  if (suppliedEmployee && suppliedEmployee !== String(employee.id)) {
    throw new ApiError(403, 'A punch always belongs to the signed-in employee.');
  }
  const payload = await submitPunch(req, employee, req.body || {});
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(payload.replayed ? 200 : 201).json(payload);
}

/** POST /api/v1/devices/register */
export async function post_v1DeviceRegister(req: any, res: Response): Promise<any> {
  const user = ownEmployee(req);
  const employee = await resolveEmployeeForUser(user.id);
  return res.status(201).json(await registerDevice(employee, req.body || {}));
}

/** POST /api/v1/notifications/fcm-token */
export async function post_v1FcmToken(req: any, res: Response): Promise<any> {
  const user = ownEmployee(req);
  const employee = await resolveEmployeeForUser(user.id);
  return res.json(await registerFcmToken(employee, req.body || {}));
}

/** PUT /api/v1/employees/me/contact */
export async function put_v1Contact(req: any, res: Response): Promise<any> {
  const user = ownEmployee(req);
  const employee = await resolveEmployeeForUser(user.id);
  const row = (
    await pgPool.query(MOBILE_CONTACT_UPDATE_SQL, [
      employee.id,
      text(req.body?.phone, 50) || null,
      text(req.body?.emergencyContactName, 200) || null,
      text(req.body?.emergencyContactPhone, 50) || null,
    ])
  ).rows[0];
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    updated: true,
    phone: row?.personal_contact ?? null,
    emergencyContactName: row?.emergency_contact_person ?? null,
    emergencyContactPhone: row?.emergency_contact_number ?? null,
  });
}

/** POST /api/v1/workplace/claims */
export async function post_v1Claim(req: any, res: Response): Promise<any> {
  const user = ownEmployee(req);
  const employee = await resolveEmployeeForUser(user.id);
  const suppliedEmployee = text(req.body?.employeeId, 50);
  if (suppliedEmployee && suppliedEmployee !== String(employee.id)) {
    throw new ApiError(403, 'A claim always belongs to the signed-in employee.');
  }
  const payload = await submitClaim(req, employee, req.body || {});
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(201).json(payload);
}

/** GET /api/v1/workplace/claims/:id */
export async function get_v1Claim(req: any, res: Response): Promise<any> {
  const user = ownEmployee(req);
  const employee = await resolveEmployeeForUser(user.id);
  return res.json(await claimForEmployee(employee, req.params?.id));
}

/** POST /api/v1/workplace/delegations */
export async function post_v1Delegation(req: any, res: Response): Promise<any> {
  const user = ownEmployee(req);
  const employee = await resolveEmployeeForUser(user.id);
  const payload = await createDelegation(req, employee, req.body || {});
  return res.status(201).json(payload);
}

/** POST /api/v1/workplace/jobs/:id/complete */
export async function post_v1WorkOrderComplete(req: any, res: Response): Promise<any> {
  const user = ownEmployee(req);
  const employee = await resolveEmployeeForUser(user.id);
  const payload = await completeWorkOrder(req, employee, String(req.params?.id || ''), req.body || {});
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(payload);
}

/**
 * POST /api/v1/workplace/location/batch — the route breadcrumb batch.
 *
 * `id` is the client's own point id and the insert is ON CONFLICT DO NOTHING, so
 * a re-sent batch is accepted without duplicating a single point. The response
 * echoes how many points in this batch were already stored.
 */
export async function post_v1LocationBatch(req: any, res: Response): Promise<any> {
  const user = ownEmployee(req);
  const employee = await resolveEmployeeForUser(user.id);
  const points = Array.isArray(req.body?.points) ? req.body.points.slice(0, 500) : [];
  if (points.length === 0) throw new ApiError(400, 'points must contain at least one breadcrumb.');
  let accepted = 0;
  for (const point of points) {
    const id = text(point?.id, 80);
    const latitude = Number(point?.latitude);
    const longitude = Number(point?.longitude);
    const capturedAt = Number(point?.capturedAtEpochMs);
    if (!id || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(capturedAt)) {
      throw new ApiError(400, 'Every breadcrumb needs id, latitude, longitude and capturedAtEpochMs.');
    }
    const inserted = await pgPool.query(MOBILE_BREADCRUMB_INSERT_SQL, [
      id,
      employee.id,
      text(req.body?.deviceId, 120),
      text(point?.sessionId, 80) || id,
      text(point?.eventType, 20) || 'WAYPOINT',
      latitude,
      longitude,
      Number.isFinite(Number(point?.accuracyMeters)) ? Number(point.accuracyMeters) : null,
      text(point?.siteLabel, 120),
      capturedAt,
      employee.branch_id,
    ]);
    accepted += inserted.rowCount || 0;
  }
  return res.status(201).json({
    acceptedCount: accepted,
    receivedCount: points.length,
    serverTimestampEpochMs: Date.now(),
    routeSessionId: text(req.body?.points?.[0]?.sessionId, 80) || null,
  });
}
