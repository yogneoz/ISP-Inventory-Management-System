// Auth primitives: scrypt password hashing, HMAC-SHA256 signed auth tokens,
// and request helpers. Extracted verbatim from app.ts.
import crypto from 'crypto';
import type { User } from '../../../client/src/types';

const PASSWORD_HASH_PREFIX = 'scrypt$';
const AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
// Warn only where the fallback is legitimate. Production never reaches a served
// request on this secret: server/index.ts refuses to boot (boot/authSecret.ts)
// with a FATAL line, so warning here too would claim the process is "using" a
// secret it is about to die over.
if (!process.env.AUTH_TOKEN_SECRET && process.env.NODE_ENV !== 'production') {
  console.warn(
    '⚠️  AUTH_TOKEN_SECRET is not set — using an ephemeral in-memory secret. All login tokens will be invalidated on every server restart and multi-instance deployments will not work. Set a persistent AUTH_TOKEN_SECRET in your .env to avoid this. Production refuses to start without one (see server/src/boot/authSecret.ts).'
  );
}
const AUTH_TOKEN_TTL_SECONDS = 8 * 60 * 60;

/**
 * A verified token plus its session fingerprint. `ver` lives only in the
 * token; it is not part of the user record the client receives.
 */
export type SessionUser = Partial<User> & { ver?: string };

/**
 * Fingerprint of the fields a token must stay in step with. A signed token is
 * otherwise valid for its whole 8-hour life, so without this a deactivated
 * account, a demoted role and a reset password all keep working until expiry.
 *
 * The material is mixed through the same HMAC key as the token, so the value
 * carries no recoverable password material. `status` defaults to 'active' so a
 * legacy row with no status compares equal on both sides.
 */
export function sessionFingerprint(user: Partial<User> & { status?: string }): string {
  const material = [
    user.password || '',
    user.role || '',
    user.branchId || '',
    (user.allowedBranchIds || []).join(','),
    user.canSwitchUser ? '1' : '0',
    user.status || 'active',
  ].join('|');
  return crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(material).digest('base64url').slice(0, 22);
}

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
    // Stamped from the signed-in row, re-checked on every request against the
    // live user cache (see sessionStillValid below). Only a credential-bearing
    // row gets one: request-level tests and tooling mint tokens for principals
    // that were never users table rows, and their empty `ver` says so.
    ver: user.password ? sessionFingerprint(user as Partial<User> & { status?: string }) : '',
    exp: Math.floor(Date.now() / 1000) + AUTH_TOKEN_TTL_SECONDS,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function getUserFromReq(req: any): Partial<User> {
  return req.user || {};
}

/**
 * Is this signed token still describing the account it was issued for?
 *
 * The fingerprint covers password, role, branch scope, switch permission and
 * account status, so deactivating a user, changing their role or scope, or
 * resetting their password makes every already-issued token stop working
 * instead of remaining valid for the rest of its 8-hour life.
 *
 * The cache is passed in rather than imported so the HTTP middleware and the
 * SSE gate (which has its own token path) can share one rule without a second
 * import cycle. An account that is not in the cache is treated as valid on
 * purpose: the cache is hydrated from `users` at boot, but request-level tests
 * (and a boot that has not reached hydration yet) carry accounts that were
 * never rows in this database. Refusing those would turn a missing cache into
 * a global outage, and a deleted row has no fingerprint to compare against.
 *
 * A token minted without a credential row (no `ver`) is allowed for the same
 * reason, but still loses to a deactivated account: status is checked first.
 * Tokens from before this fingerprint existed are in that group and simply
 * expire within their 8-hour life.
 */
export function sessionStillValid(user: SessionUser, cache: readonly Partial<User>[]): boolean {
  const cached = cache.find((row: any) => row.id === user.id) as any;
  if (!cached) return true;
  if (String(cached.status || 'active') !== 'active') return false;
  if (!user.ver) return true;
  return sessionFingerprint(cached) === user.ver;
}

export function verifyAuthToken(token: string): SessionUser | null {
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
      ver: typeof parsed.ver === 'string' ? parsed.ver : '',
    };
  } catch (_err) {
    return null;
  }
}
