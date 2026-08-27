/**
 * Express authentication middleware and audit helpers.
 */
import type { User, AuditLog } from '../../src/types';
import {
  extractBearerToken,
  getSession,
  normalizeRole,
  rolesMatch,
  getTodayBsStamp,
  hashPassword,
  isBcryptHash,
  type SessionRecord,
} from './authUtils';
import { pgPool, isPgConnected } from './db';
import * as store from '../store';
import { broadcastChange } from './sync';

export const PUBLIC_API_PATHS = [
  '/api/health',
  '/api/auth/login',
  '/api/auth/setup-status',
  '/api/auth/setup-superadmin',
  '/api/auth/forgot-password',
];

export function isPublicApiPath(path: string): boolean {
  if (!path) return false;
  const bare = path.split('?')[0];
  return PUBLIC_API_PATHS.some((p) => bare === p || bare.startsWith(p + '/'));
}

export function findUserByIdOrEmail(idOrEmail: string | undefined | null): User | undefined {
  if (!idOrEmail) return undefined;
  const key = String(idOrEmail).toLowerCase();
  return store.users.find((u) => u.id === idOrEmail || (u.email || '').toLowerCase() === key);
}

export function sanitizeUser(user: User | any) {
  if (!user) return user;
  const { password: _pw, ...rest } = user;
  return { ...rest, role: normalizeRole(rest.role) };
}

export async function migrateUserPasswordIfNeeded(user: User, plainPassword: string): Promise<void> {
  if (!user?.password || isBcryptHash(user.password)) return;
  try {
    const hashed = await hashPassword(plainPassword);
    user.password = hashed;
    const idx = store.users.findIndex((u) => u.id === user.id);
    if (idx !== -1) store.users[idx].password = hashed;
    if (isPgConnected) {
      await pgPool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, user.id]).catch(() => {});
    }
    store.saveDataStore();
  } catch (err) {
    console.warn('Password migration note:', err);
  }
}

/**
 * Resolve the acting user from a verified session token only.
 */
export function getUserFromReq(req: any): {
  id?: string;
  email: string;
  name: string;
  role: string;
  branchId?: string;
  allowedBranchIds?: string[];
  canSwitchUser?: boolean;
  authenticated: boolean;
} {
  const session = req.session as SessionRecord | undefined;
  if (session) {
    const live = findUserByIdOrEmail(session.userId) || findUserByIdOrEmail(session.email);
    return {
      id: live?.id || session.userId,
      email: live?.email || session.email,
      name: live?.name || session.name,
      role: normalizeRole(live?.role || session.role),
      branchId: live?.branchId || session.branchId,
      allowedBranchIds: live?.allowedBranchIds || session.allowedBranchIds,
      canSwitchUser: live?.canSwitchUser ?? session.canSwitchUser,
      authenticated: true,
    };
  }
  return {
    email: 'anonymous',
    name: 'Anonymous',
    role: 'FRONT_DESK',
    authenticated: false,
  };
}

export function authenticateUser(req: any, res: any, next: any) {
  const queryToken =
    typeof req.query?.token === 'string'
      ? req.query.token
      : typeof req.query?.access_token === 'string'
        ? req.query.access_token
        : null;
  const token = extractBearerToken(req) || queryToken;
  const session = getSession(token);
  if (session) {
    req.session = session;
    req.authToken = token;
    const live = findUserByIdOrEmail(session.userId) || findUserByIdOrEmail(session.email);
    req.user = {
      id: live?.id || session.userId,
      email: live?.email || session.email,
      name: live?.name || session.name,
      role: normalizeRole(live?.role || session.role),
      branchId: live?.branchId || session.branchId,
      allowedBranchIds: live?.allowedBranchIds || session.allowedBranchIds,
      canSwitchUser: live?.canSwitchUser ?? session.canSwitchUser,
      authenticated: true,
    };
    if (live) store.setActiveUser(live);
  } else {
    req.session = null;
    req.authToken = null;
    req.user = getUserFromReq(req);
  }

  const relPath = (req.path || req.url || '').split('?')[0];
  const original = (req.originalUrl || '').split('?')[0];
  const candidates = [original, relPath, relPath.startsWith('/api') ? relPath : `/api${relPath}`];
  const isPublic = candidates.some(
    (p) =>
      isPublicApiPath(p) ||
      p.endsWith('/health') ||
      p.includes('/auth/login') ||
      p.includes('/auth/setup-status') ||
      p.includes('/auth/setup-superadmin') ||
      p.includes('/auth/forgot-password')
  );

  if (!isPublic && !req.session) {
    return res.status(401).json({ message: 'Unauthorized: valid session token required.' });
  }
  next();
}

export function requireAuth(req: any, res: any, next: any) {
  if (!req.session || !req.user?.authenticated) {
    return res.status(401).json({ message: 'Unauthorized: Authentication required to access endpoint' });
  }
  next();
}

export function requireRole(...allowedRoles: string[]) {
  return (req: any, res: any, next: any) => {
    if (!req.session || !req.user?.authenticated) {
      return res.status(401).json({ message: 'Unauthorized: Authentication required' });
    }
    const role = normalizeRole(req.user.role);
    if (allowedRoles.length > 0 && !rolesMatch(role, allowedRoles)) {
      return res.status(403).json({
        message: `Forbidden: Access restricted. Role '${role}' lacks sufficient privileges for this operational action. Required role: ${allowedRoles.join(' or ')}`,
      });
    }
    next();
  };
}

export function logAuditEvent(
  req: any,
  action: string,
  module: string,
  details: string,
  overrideBranchId?: string
) {
  const u = getUserFromReq(req);
  const auditItem: AuditLog = {
    id: `aud-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
    userEmail: u.email,
    userName: u.name,
    action,
    module: module as AuditLog['module'],
    details,
    timestampAD: new Date().toISOString(),
    timestampBS: getTodayBsStamp(),
    branchId: overrideBranchId || u.branchId,
  };

  store.auditTrail.unshift(auditItem);
  broadcastChange({
    type: action,
    entity: module,
    branchId: auditItem.branchId,
  });

  pgPool
    .query(
      `INSERT INTO audit_logs (id, user_email, user_name, action, module, details, timestamp_ad, timestamp_bs, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        auditItem.id,
        auditItem.userEmail,
        auditItem.userName,
        auditItem.action,
        auditItem.module,
        auditItem.details,
        auditItem.timestampBS,
        auditItem.branchId,
      ]
    )
    .catch(() => {});

  return auditItem;
}
