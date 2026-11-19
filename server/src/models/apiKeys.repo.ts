/**
 * API-key repository — every statement the key programme runs.
 *
 * Kept out of the service so the no-inline-SQL guard stays green and so the
 * authentication read is one indexed lookup by prefix, never a scan.
 */
import { pgPool } from '../../db';

export interface ApiKeyRow {
  id: string;
  name: string;
  description: string;
  key_prefix: string;
  secret_hash: string;
  operations: string[];
  read_only: boolean;
  branch_ids: string[];
  rpm_limit: number | null;
  cidr_allowlist: string[];
  expires_at: string | null;
  is_active: boolean;
  revoked_at: string | null;
  revoked_by: string | null;
  created_by: string;
  created_by_email: string | null;
  rotated_from: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  created_at: string;
}

const COLUMNS = `id, name, description, key_prefix, secret_hash, operations, read_only,
  branch_ids, rpm_limit, cidr_allowlist, expires_at, is_active, revoked_at, revoked_by,
  created_by, created_by_email, rotated_from, last_used_at, last_used_ip, created_at`;

export const API_KEY_BY_PREFIX_SQL = `SELECT ${COLUMNS} FROM api_keys WHERE key_prefix = $1 LIMIT 1`;

export async function findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
  const result = await pgPool.query(API_KEY_BY_PREFIX_SQL, [prefix]);
  return (result.rows[0] as ApiKeyRow | undefined) ?? null;
}

export const API_KEY_LIST_SQL = `SELECT ${COLUMNS} FROM api_keys ORDER BY created_at DESC LIMIT $1`;

export async function listApiKeys(limit = 200): Promise<ApiKeyRow[]> {
  const result = await pgPool.query(API_KEY_LIST_SQL, [limit]);
  return result.rows as ApiKeyRow[];
}

export const API_KEY_BY_ID_SQL = `SELECT ${COLUMNS} FROM api_keys WHERE id = $1 LIMIT 1`;

export async function findApiKeyById(id: string): Promise<ApiKeyRow | null> {
  const result = await pgPool.query(API_KEY_BY_ID_SQL, [id]);
  return (result.rows[0] as ApiKeyRow | undefined) ?? null;
}

export const API_KEY_INSERT_SQL = `
INSERT INTO api_keys
  (name, description, key_prefix, secret_hash, operations, read_only, branch_ids,
   rpm_limit, cidr_allowlist, expires_at, created_by, created_by_email, rotated_from)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
RETURNING ${COLUMNS}`;

export interface ApiKeyInsert {
  name: string;
  description: string;
  prefix: string;
  secretHash: string;
  operations: string[];
  readOnly: boolean;
  branchIds: string[];
  rpmLimit: number | null;
  cidrAllowlist: string[];
  expiresAt: string | null;
  createdBy: string;
  createdByEmail: string | null;
  rotatedFrom: string | null;
}

export async function insertApiKey(input: ApiKeyInsert): Promise<ApiKeyRow> {
  const result = await pgPool.query(API_KEY_INSERT_SQL, [
    input.name,
    input.description,
    input.prefix,
    input.secretHash,
    input.operations,
    input.readOnly,
    input.branchIds,
    input.rpmLimit,
    input.cidrAllowlist,
    input.expiresAt,
    input.createdBy,
    input.createdByEmail,
    input.rotatedFrom,
  ]);
  return result.rows[0] as ApiKeyRow;
}

export const API_KEY_REVOKE_SQL = `
UPDATE api_keys
   SET is_active = FALSE, revoked_at = now(), revoked_by = $2
 WHERE id = $1 AND is_active = TRUE
RETURNING ${COLUMNS}`;

export async function revokeApiKeyRow(id: string, actor: string): Promise<ApiKeyRow | null> {
  const result = await pgPool.query(API_KEY_REVOKE_SQL, [id, actor]);
  return (result.rows[0] as ApiKeyRow | undefined) ?? null;
}

/** Shorten an old key's life after a rotation; the row stays auditable. */
export const API_KEY_EXPIRE_SQL = `
UPDATE api_keys SET expires_at = $2 WHERE id = $1 AND is_active = TRUE
RETURNING ${COLUMNS}`;

export async function expireApiKeyRow(id: string, expiresAt: string): Promise<ApiKeyRow | null> {
  const result = await pgPool.query(API_KEY_EXPIRE_SQL, [id, expiresAt]);
  return (result.rows[0] as ApiKeyRow | undefined) ?? null;
}

/**
 * Usage stamp, debounced to once a minute per key: a hot key must not turn every
 * request into an UPDATE, and the exact second of last use is not a security
 * decision.
 */
export const API_KEY_TOUCH_SQL = `
UPDATE api_keys
   SET last_used_at = now(), last_used_ip = $2
 WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`;

export async function touchApiKey(id: string, ip: string | null): Promise<void> {
  await pgPool.query(API_KEY_TOUCH_SQL, [id, ip]);
}

export const API_KEY_AUDIT_INSERT_SQL = `
INSERT INTO api_key_audit_logs (api_key_id, action, actor, actor_email, ip, user_agent, detail)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`;

export interface ApiKeyAuditInsert {
  apiKeyId: string;
  action: 'CREATE' | 'ROTATE' | 'REVOKE';
  actor: string;
  actorEmail: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: Record<string, unknown>;
}

export async function insertApiKeyAudit(entry: ApiKeyAuditInsert): Promise<void> {
  await pgPool.query(API_KEY_AUDIT_INSERT_SQL, [
    entry.apiKeyId,
    entry.action,
    entry.actor,
    entry.actorEmail,
    entry.ip,
    entry.userAgent,
    JSON.stringify(entry.detail),
  ]);
}

export const API_KEY_AUDIT_LIST_SQL = `
SELECT id, api_key_id, action, actor, actor_email, ip, user_agent, detail, created_at
  FROM api_key_audit_logs
 WHERE api_key_id = $1
 ORDER BY created_at DESC, id DESC
 LIMIT $2`;

export async function listApiKeyAudit(apiKeyId: string, limit = 100): Promise<any[]> {
  const result = await pgPool.query(API_KEY_AUDIT_LIST_SQL, [apiKeyId, limit]);
  return result.rows;
}
