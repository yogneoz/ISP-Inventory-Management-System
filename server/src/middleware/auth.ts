// Auth primitives: scrypt password hashing, HMAC-SHA256 signed auth tokens,
// and request helpers. Extracted verbatim from app.ts.
import crypto from 'crypto';
import type { User } from '../../../client/src/types';

const PASSWORD_HASH_PREFIX = 'scrypt$';
const AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.AUTH_TOKEN_SECRET) {
  console.warn(
    '⚠️  AUTH_TOKEN_SECRET is not set — using an ephemeral in-memory secret. All login tokens will be invalidated on every server restart and multi-instance deployments will not work. Set a persistent AUTH_TOKEN_SECRET in your .env to avoid this.'
  );
}
const AUTH_TOKEN_TTL_SECONDS = 8 * 60 * 60;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${PASSWORD_HASH_PREFIX}${salt}$${derivedKey.toString('hex')}`;
}

export function verifyPassword(password: string, storedPassword: string): { valid: boolean; upgradedHash?: string } {
  if (!storedPassword) return { valid: false };

  if (!storedPassword.startsWith(PASSWORD_HASH_PREFIX)) {
    return { valid: password === storedPassword, upgradedHash: password === storedPassword ? hashPassword(password) : undefined };
  }

  const [, salt, storedHash] = storedPassword.split('$');
  if (!salt || !storedHash) return { valid: false };

  try {
    const derivedKey = crypto.scryptSync(password, salt, 64);
    const expectedHash = Buffer.from(storedHash, 'hex');
    return {
      valid: expectedHash.length === derivedKey.length && crypto.timingSafeEqual(expectedHash, derivedKey),
    };
  } catch (_err) {
    return { valid: false };
  }
}

/**
 * Issue a signed HMAC token for the given user.
 *
 * `sessionRoot` captures the profile that originally signed in (e.g. Super
 * Admin) when a privileged account impersonates another profile. The root
 * marker fields stamped into the token let the impersonated session verify
 * it may switch *back* to the root account, even though the active profile
 * itself has no switch permission. A null/self `sessionRoot` means the token
 * has no root marker (a fresh login or a collapsed switch-back session).
 */
export function issueAuthToken(user: User, sessionRoot?: Partial<User> | null): string {
  const root = sessionRoot && sessionRoot.id && sessionRoot.id !== user.id ? sessionRoot : null;
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    branchId: user.branchId || '',
    allowedBranchIds: user.allowedBranchIds || [],
    canSwitchUser: Boolean(user.canSwitchUser),
    rootId: root?.id || '',
    rootEmail: root?.email || '',
    rootCanSwitchUser: Boolean(root?.canSwitchUser),
    rootRole: root?.role || '',
    exp: Math.floor(Date.now() / 1000) + AUTH_TOKEN_TTL_SECONDS,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function getUserFromReq(req: any): Partial<User> {
  return req.user || {};
}

export function verifyAuthToken(token: string): Partial<User> | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.sub || !parsed.email || !parsed.exp || parsed.exp <= Math.floor(Date.now() / 1000)) return null;
    return {
      id: parsed.sub,
      email: parsed.email,
      name: parsed.name || '',
      role: parsed.role,
      branchId: parsed.branchId || '',
      allowedBranchIds: Array.isArray(parsed.allowedBranchIds) ? parsed.allowedBranchIds : [],
      canSwitchUser: Boolean(parsed.canSwitchUser),
      rootId: parsed.rootId || '',
      rootEmail: parsed.rootEmail || '',
      rootCanSwitchUser: Boolean(parsed.rootCanSwitchUser),
      rootRole: parsed.rootRole || '',
    };
  } catch (_err) {
    return null;
  }
}
