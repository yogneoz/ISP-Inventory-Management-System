/**
 * API-key service (Round 14 Part C).
 *
 * A key is `isp_live_<prefix>_<secret>`:
 *   - `prefix` is 6 random bytes, base64url — stored plaintext and indexed, so
 *     authentication is one row lookup;
 *   - `secret` is 32 random bytes, base64url — NEVER stored; only
 *     `sha256(secret)` is, and comparison is constant-time.
 *
 * Scope is an operation list from the permission catalogue plus a `read_only`
 * switch. The switch is enforced in `apiKeyAuth` before RBAC, because one
 * operation name often guards a GET and a POST route (see
 * docs/api-key-operations-inventory.md): an operation-only scope would leak
 * writes. The key's branch list is the complete branch scope and a key never
 * receives the Super Admin override.
 */
import crypto from 'node:crypto';
import { DEFAULT_PERMISSIONS_MATRIX } from '../../../client/src/utils/permissionMatrixData';
import {
  ApiKeyRow,
  expireApiKeyRow,
  findApiKeyByPrefix,
  insertApiKey,
  insertApiKeyAudit,
  listApiKeyAudit,
  listApiKeys,
  revokeApiKeyRow,
  touchApiKey,
} from '../models/apiKeys.repo';

export const API_KEY_HEADER = 'x-api-key';
export const API_KEY_TOKEN_PREFIX = 'isp_live_';

const PREFIX_BYTES = 6;
const SECRET_BYTES = 32;
const MAX_TTL_DAYS = 3650;

export interface ApiKeyScope {
  name: string;
  description?: string;
  operations: string[];
  readOnly: boolean;
  branchIds: string[];
  rpmLimit?: number | null;
  cidrAllowlist?: string[];
  expiresAt?: string | null;
  expiresInDays?: number | null;
}

export interface ApiKeyActor {
  id: string;
  email: string;
  name?: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ApiKeyPrincipal {
  id: string;
  email: string;
  name: string;
  role: 'API_KEY';
  branchId: string;
  allowedBranchIds: string[];
  apiKey: true;
  apiKeyOperations: string[];
  apiKeyReadOnly: boolean;
}

export interface IssuedApiKey {
  key: ApiKeyRow;
  secret: string;
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** sha256 of the secret half, hex. The only representation that is persisted. */
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export function generateApiKeyParts(): { prefix: string; secret: string; token: string } {
  const prefix = base64url(crypto.randomBytes(PREFIX_BYTES));
  const secret = base64url(crypto.randomBytes(SECRET_BYTES));
  return { prefix, secret, token: `${API_KEY_TOKEN_PREFIX}${prefix}_${secret}` };
}

/** Constant-time comparison of two hex digests. */
export function hashesMatch(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  if (expected.length !== actual.length || expected.length === 0) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export function splitToken(token: string): { prefix: string; secret: string } | null {
  if (!token.startsWith(API_KEY_TOKEN_PREFIX)) return null;
  const rest = token.slice(API_KEY_TOKEN_PREFIX.length);
  const separator = rest.indexOf('_');
  if (separator <= 0 || separator === rest.length - 1) return null;
  const prefix = rest.slice(0, separator);
  const secret = rest.slice(separator + 1);
  if (prefix.length > 32 || secret.length > 128) return null;
  return { prefix, secret };
}

/** The operation catalogue, as the creator UI and the validator both see it. */
export function knownOperations(): string[] {
  return Object.keys(DEFAULT_PERMISSIONS_MATRIX);
}

export interface ScopeValidation {
  ok: boolean;
  message?: string;
  scope?: Required<Omit<ApiKeyScope, 'expiresInDays' | 'description' | 'rpmLimit'>> & {
    rpmLimit: number | null;
    expiresAt: string | null;
    description: string;
  };
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)));
}

export function validateScope(input: Partial<ApiKeyScope>, now = new Date()): ScopeValidation {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 2 || name.length > 120) {
    return { ok: false, message: 'name: 2–120 characters are required.' };
  }
  const operations = normalizeList(input.operations);
  if (operations.length === 0) {
    return { ok: false, message: 'operations: choose at least one operation.' };
  }
  const known = new Set(knownOperations());
  const unknown = operations.filter((operation) => !known.has(operation));
  if (unknown.length > 0) {
    return { ok: false, message: `operations: unknown operation ${unknown.join(', ')}.` };
  }
  const branchIds = normalizeList(input.branchIds);
  if (branchIds.some((branch) => branch === 'ALL')) {
    return { ok: false, message: 'branchIds: omit the list for company-wide scope instead of passing ALL.' };
  }

  let expiresAt: string | null = null;
  if (input.expiresAt) {
    const parsed = new Date(String(input.expiresAt));
    if (Number.isNaN(parsed.getTime())) return { ok: false, message: 'expiresAt: not a valid date.' };
    if (parsed.getTime() <= now.getTime()) return { ok: false, message: 'expiresAt: must be in the future.' };
    expiresAt = parsed.toISOString();
  } else if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
    const days = Number(input.expiresInDays);
    if (!Number.isFinite(days) || days < 1 || days > MAX_TTL_DAYS) {
      return { ok: false, message: `expiresInDays: 1–${MAX_TTL_DAYS}.` };
    }
    expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString();
  }

  let rpmLimit: number | null = null;
  if (input.rpmLimit !== undefined && input.rpmLimit !== null) {
    const rpm = Number(input.rpmLimit);
    if (!Number.isInteger(rpm) || rpm < 1 || rpm > 100_000) {
      return { ok: false, message: 'rpmLimit: a whole number between 1 and 100000.' };
    }
    rpmLimit = rpm;
  }

  const cidrAllowlist = normalizeList(input.cidrAllowlist);
  const cidrPattern = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
  if (cidrAllowlist.some((entry) => !cidrPattern.test(entry))) {
    return { ok: false, message: 'cidrAllowlist: use IPv4 addresses or CIDR blocks.' };
  }

  return {
    ok: true,
    scope: {
      name,
      description: typeof input.description === 'string' ? input.description.trim().slice(0, 500) : '',
      operations,
      readOnly: input.readOnly !== false,
      branchIds,
      rpmLimit,
      cidrAllowlist,
      expiresAt,
    },
  };
}

export async function createApiKey(input: Partial<ApiKeyScope>, actor: ApiKeyActor): Promise<IssuedApiKey | { error: string; status: number }> {
  const validated = validateScope(input);
  if (!validated.ok || !validated.scope) return { error: validated.message || 'Invalid scope.', status: 400 };
  const scope = validated.scope;
  const parts = generateApiKeyParts();
  const key = await insertApiKey({
    name: scope.name,
    description: scope.description,
    prefix: parts.prefix,
    secretHash: hashSecret(parts.secret),
    operations: scope.operations,
    readOnly: scope.readOnly,
    branchIds: scope.branchIds,
    rpmLimit: scope.rpmLimit,
    cidrAllowlist: scope.cidrAllowlist,
    expiresAt: scope.expiresAt,
    createdBy: actor.id,
    createdByEmail: actor.email,
    rotatedFrom: null,
  });
  await insertApiKeyAudit({
    apiKeyId: key.id,
    action: 'CREATE',
    actor: actor.id,
    actorEmail: actor.email,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    detail: {
      name: key.name,
      operations: key.operations,
      readOnly: key.read_only,
      branchIds: key.branch_ids,
      expiresAt: key.expires_at,
      rpmLimit: key.rpm_limit,
      cidrAllowlist: key.cidr_allowlist,
    },
  });
  return { key, secret: parts.token };
}

export async function rotateApiKey(
  id: string,
  actor: ApiKeyActor,
  graceHours = 24
): Promise<IssuedApiKey | { error: string; status: number }> {
  const rows = await listApiKeys(500);
  const existing = rows.find((row) => row.id === id);
  if (!existing) return { error: 'API key not found.', status: 404 };
  if (!existing.is_active) return { error: 'This key is revoked; issue a new one instead.', status: 409 };
  const hours = Number(graceHours);
  if (!Number.isFinite(hours) || hours < 0 || hours > 720) {
    return { error: 'graceHours: 0–720.', status: 400 };
  }
  const parts = generateApiKeyParts();
  const created = await insertApiKey({
    name: existing.name,
    description: existing.description,
    prefix: parts.prefix,
    secretHash: hashSecret(parts.secret),
    operations: existing.operations,
    readOnly: existing.read_only,
    branchIds: existing.branch_ids,
    rpmLimit: existing.rpm_limit,
    cidrAllowlist: existing.cidr_allowlist,
    expiresAt: existing.expires_at,
    createdBy: existing.created_by,
    createdByEmail: existing.created_by_email,
    rotatedFrom: existing.id,
  });
  const graceEnd = new Date(Date.now() + hours * 3_600_000).toISOString();
  const shortened = existing.expires_at && new Date(existing.expires_at).getTime() < new Date(graceEnd).getTime()
    ? existing.expires_at
    : graceEnd;
  await expireApiKeyRow(existing.id, shortened);
  await insertApiKeyAudit({
    apiKeyId: created.id,
    action: 'ROTATE',
    actor: actor.id,
    actorEmail: actor.email,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    detail: { rotatedFrom: existing.id, graceEndsAt: shortened },
  });
  return { key: created, secret: parts.token };
}

export async function revokeApiKey(id: string, actor: ApiKeyActor): Promise<{ key: ApiKeyRow } | { error: string; status: number }> {
  const revoked = await revokeApiKeyRow(id, actor.id);
  if (!revoked) return { error: 'API key not found or already revoked.', status: 404 };
  await insertApiKeyAudit({
    apiKeyId: revoked.id,
    action: 'REVOKE',
    actor: actor.id,
    actorEmail: actor.email,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    detail: { name: revoked.name },
  });
  return { key: revoked };
}

export async function getApiKeyAudit(id: string, limit = 100): Promise<any[]> {
  return listApiKeyAudit(id, Math.min(Math.max(limit, 1), 500));
}

export function publicKeyView(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    prefix: row.key_prefix,
    operations: row.operations,
    readOnly: row.read_only,
    branchIds: row.branch_ids,
    rpmLimit: row.rpm_limit,
    cidrAllowlist: row.cidr_allowlist,
    expiresAt: row.expires_at,
    isActive: row.is_active,
    revokedAt: row.revoked_at,
    createdBy: row.created_by_email || row.created_by,
    rotatedFrom: row.rotated_from,
    lastUsedAt: row.last_used_at,
    lastUsedIp: row.last_used_ip,
    createdAt: row.created_at,
    status: !row.is_active
      ? 'Revoked'
      : row.expires_at && new Date(row.expires_at).getTime() <= Date.now()
        ? 'Expired'
        : row.expires_at && new Date(row.expires_at).getTime() <= Date.now() + 7 * 86_400_000
          ? 'Expiring'
          : 'Active',
  };
}

export async function listPublicKeys(): Promise<ReturnType<typeof publicKeyView>[]> {
  const rows = await listApiKeys(500);
  return rows.map(publicKeyView);
}

/** Per-process sliding-minute counter for the optional per-key RPM cap. */
const rpmBuckets = new Map<string, { minute: number; count: number }>();

function rpmAllows(key: ApiKeyRow): boolean {
  if (!key.rpm_limit) return true;
  const minute = Math.floor(Date.now() / 60_000);
  const bucket = rpmBuckets.get(key.id);
  if (!bucket || bucket.minute !== minute) {
    rpmBuckets.set(key.id, { minute, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= key.rpm_limit;
}

function ipAllowed(key: ApiKeyRow, ip: string | null): boolean {
  if (!key.cidr_allowlist || key.cidr_allowlist.length === 0) return true;
  if (!ip) return false;
  const normalized = ip.replace(/^::ffff:/, '');
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const value = octets.reduce((acc, n) => (acc << 8) + n, 0) >>> 0;
  return key.cidr_allowlist.some((entry) => {
    const [base, bitsRaw] = entry.split('/');
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    const baseOctets = base.split('.').map(Number);
    const baseValue = baseOctets.reduce((acc, n) => (acc << 8) + n, 0) >>> 0;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (baseValue & mask);
  });
}

export type ApiKeyAuthResult =
  | { ok: true; user: ApiKeyPrincipal; key: ApiKeyRow }
  | { ok: false; status: number; reason: string; code: string };

/**
 * Authenticate a raw `isp_live_…` token. Every failure is a 401 except a
 * disallowed address (403) so a partner can tell a bad credential from a
 * network policy. Messages never reveal which half matched.
 */
export async function authenticateApiKey(rawToken: string, ip: string | null = null): Promise<ApiKeyAuthResult> {
  const parts = splitToken(rawToken.trim());
  if (!parts) return { ok: false, status: 401, reason: 'Invalid API key.', code: 'API_KEY_INVALID' };
  const row = await findApiKeyByPrefix(parts.prefix);
  if (!row) return { ok: false, status: 401, reason: 'Invalid API key.', code: 'API_KEY_INVALID' };
  if (!hashesMatch(row.secret_hash, hashSecret(parts.secret))) {
    return { ok: false, status: 401, reason: 'Invalid API key.', code: 'API_KEY_INVALID' };
  }
  if (!row.is_active) return { ok: false, status: 401, reason: 'This API key has been revoked.', code: 'API_KEY_REVOKED' };
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, status: 401, reason: 'This API key has expired.', code: 'API_KEY_EXPIRED' };
  }
  if (!ipAllowed(row, ip)) {
    return { ok: false, status: 403, reason: 'This address is not allowed for the API key.', code: 'API_KEY_CIDR' };
  }
  if (!rpmAllows(row)) {
    return { ok: false, status: 429, reason: 'API key rate limit exceeded.', code: 'API_KEY_RATE_LIMIT' };
  }

  const user: ApiKeyPrincipal = {
    id: `api-key:${row.id}`,
    email: `api-key:${row.key_prefix}`,
    name: row.name,
    role: 'API_KEY',
    branchId: row.branch_ids.length === 1 ? row.branch_ids[0] : 'ALL',
    allowedBranchIds: row.branch_ids,
    apiKey: true,
    apiKeyOperations: row.operations,
    apiKeyReadOnly: row.read_only,
  };

  // Usage stamping must never fail a request the key is entitled to make.
  void touchApiKey(row.id, ip).catch(() => undefined);
  return { ok: true, user, key: row };
}
