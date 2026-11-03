/**
 * Permissions controller — HTTP orchestration for the permissions domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { pgPool, permissionMatrix, userPermissionOverrides, setPermissionMatrix, setUserPermissionOverrides, setUserPermissionSetGrants, getUserFromReq, withTransaction, logAuditEvent } from '../app';
import {
  PERMISSION_MATRIX_SELECT_SQL,
  PERMISSION_TARGET_USER_SELECT_SQL,
  PERMISSION_SETS_SELECT_SQL,
  PERMISSION_SET_BY_ID_SELECT_SQL,
  PERMISSION_SET_GRANTS_SELECT_SQL,
  PERMISSION_SET_MEMBERS_SELECT_SQL,
  PERMISSION_SET_INSERT_SQL,
  PERMISSION_SET_UPDATE_SQL,
  PERMISSION_SET_DELETE_SQL,
  PERMISSION_SET_GRANTS_DELETE_SQL,
  PERMISSION_SET_GRANT_INSERT_SQL,
  PERMISSION_SET_MEMBERS_DELETE_FOR_USER_SQL,
  PERMISSION_SET_MEMBER_INSERT_SQL,
  PERMISSION_SET_USER_GRANTS_SELECT_SQL,
  USER_ACCESS_SUMMARY_USERS_SELECT_SQL,
  USER_PERMISSION_SET_COUNTS_SELECT_SQL,
  USER_PERMISSION_OVERRIDES_SELECT_SQL,
  USER_PERMISSION_OVERRIDES_FOR_OPERATION_ROLE_SELECT_SQL,
  USER_PERMISSION_OVERRIDES_FOR_USER_SELECT_SQL,
  USER_PERMISSION_SET_IDS_SELECT_SQL,
  USER_PERMISSION_SET_GRANTS_SELECT_SQL,
  rowsToOperationPermissionOverrideRecords,
  rowsToPermissionMatrix,
  rowsToUserPermissionOverrideRecords,
  rowsToUserPermissionOverrideMap,
  rowsToPermissionSetRecords,
  rowsToUserPermissionSetGrantMap,
  type PermissionSetRecord,
  type UserPermissionOverrideRecord,
  type UserPermissionSetGrantMap,
} from '../models/permissions.repo';
import { DEFAULT_PERMISSIONS_MATRIX } from '../../../client/src/utils/permissionMatrixData';
import { VALID_ROLES } from './permissions.core';
import { persistPermissionMatrix } from '../services/permissionMatrix.service';
import {
  bumpPermissionsVersion,
  effectiveOperations,
  getPermissionsVersion,
  isOverrideExpired,
  persistUserPermissionOverrides,
  replaceUserOverrides,
  roleBaseAllowed,
  summarizeUserAccess,
} from '../services/permissionOverrides.service';
/** Forwarded from permissions.routes.ts (get_permissions). */
export async function get_permissions(req: any, res: Response): Promise<any> {
  // Mirror-drift rule (#7): the permission matrix is served LIVE from
  // PostgreSQL — the same SELECT the bootstrap slices use — so a manual DB
  // edit, a second server instance or a missed cache refresh can never be
  // served stale here either. The in-memory matrix is only the operational
  // cache the authz middleware reads per request, and the resilience
  // fallback if the live read fails.
  try {
    const matrix = rowsToPermissionMatrix(
      (await pgPool.query(PERMISSION_MATRIX_SELECT_SQL)).rows
    );
    res.json({ matrix });
  } catch (err: any) {
    console.warn('permissions live read failed, serving operational cache:', err?.message || err);
    res.json({ matrix: permissionMatrix });
  }
  return;
}

/** Forwarded from permissions.routes.ts (put_permissions). */
export async function put_permissions(req: any, res: Response): Promise<any> {
try {
    const { matrix } = req.body as { matrix?: Record<string, Record<string, boolean>> };
    if (!matrix || typeof matrix !== 'object') {
      res.status(400).json({ message: 'Invalid permission matrix payload.' });
      return;
    }
    // AUD-2: the replace + publish sequence lives in the service so the
    // in-memory matrix is only ever published after the COMMIT resolves.
    await persistPermissionMatrix(matrix, {
      runInTransaction: withTransaction,
      publish: setPermissionMatrix,
    });
    console.log(`✅ Permission matrix updated by ${(getUserFromReq(req)).email || 'unknown'}.`);
    // Audit + broadcast: every connected client re-reads the matrix slice
    // (targeted PERMISSIONS domain) instead of acting on stale grants until
    // an unrelated reload. Also the first audit trail this table ever had.
    logAuditEvent(req, 'UPDATE_PERMISSION_MATRIX', 'PERMISSIONS', `Updated permission matrix (${Object.keys(matrix).length} role-operation rules).`);
    res.json({ message: 'Permission matrix updated successfully.', operationCount: Object.keys(matrix).length });
    return;
  } catch (err: any) {
    res.status(500).json({ message: `Unable to update permissions: ${err.message}` });
    return;
  }

}

// ---------------------------------------------------------------------------
// Per-user permission overrides (docs/permission-overrides-plan.md, phase 1).
//
// These handlers deliberately sit behind `requireRole('SUPER_ADMIN')` at the
// route layer rather than `admin-users`: a Head Office Admin who manages staff
// must not be able to grant operations to themselves. The catalogue check
// reuses DEFAULT_PERMISSIONS_MATRIX (the same seed the role matrix is built
// from), so an unknown operation id is a 400 before anything is written.
// ---------------------------------------------------------------------------

function basePermissionMap(
  role: string,
  matrix: Record<string, Record<string, boolean>>
): Record<string, boolean> {
  const base: Record<string, boolean> = {};
  for (const operationId of Object.keys(DEFAULT_PERMISSIONS_MATRIX)) {
    base[operationId] = roleBaseAllowed({ role }, operationId, matrix);
  }
  return base;
}

function overrideResponseRows(records: UserPermissionOverrideRecord[]) {
  const now = Date.now();
  return records.map((record) => ({ ...record, expired: isOverrideExpired(record, now) }));
}

// ---------------------------------------------------------------------------
// Reusable permission sets (phase 2).
//
// Definitions live in three tables; the authz path only reads the derived
// userId -> operations map. Every committed set/membership write re-reads that
// derivation and publishes it, so the running middleware never enforces a set
// the database rolled back. Admin reads stay LIVE like the matrix and override
// reads above.
// ---------------------------------------------------------------------------

/** Reads every set with its grants and members, for the admin list/editor. */
async function loadPermissionSetRecords(): Promise<PermissionSetRecord[]> {
  const [setsRes, grantsRes, membersRes] = await Promise.all([
    pgPool.query(PERMISSION_SETS_SELECT_SQL),
    pgPool.query(PERMISSION_SET_GRANTS_SELECT_SQL),
    pgPool.query(PERMISSION_SET_MEMBERS_SELECT_SQL),
  ]);
  return rowsToPermissionSetRecords(
    setsRes.rows as any,
    grantsRes.rows as any,
    membersRes.rows as any
  );
}

/** Reads one user's set-contributed grants (rows already carry the user id). */
async function readUserSetGrants(userId: string): Promise<UserPermissionSetGrantMap> {
  const result = await pgPool.query(USER_PERMISSION_SET_GRANTS_SELECT_SQL, [userId]);
  return rowsToUserPermissionSetGrantMap(result.rows as any);
}

/**
 * Re-reads the derived map after a COMMIT, publishes it, and bumps the client
 * cache version. Called only after the write transaction resolves.
 */
async function publishPermissionSetGrants(): Promise<void> {
  try {
    const result = await pgPool.query(PERMISSION_SET_USER_GRANTS_SELECT_SQL);
    setUserPermissionSetGrants(rowsToUserPermissionSetGrantMap(result.rows as any));
  } catch (err) {
    // The write may already be committed, but a stale map must never keep
    // granting an operation after its set was deleted. Dropping the derived
    // map is the fail-closed direction: only role/override answers remain
    // until the next successful reload or a restart.
    setUserPermissionSetGrants(new Map());
    bumpPermissionsVersion();
    throw err;
  }
  bumpPermissionsVersion();
}

const PERMISSION_SET_NAME_MAX = 120;
const PERMISSION_SET_DESCRIPTION_MAX = 500;

type ParsedSetPayload =
  | { name: string; description: string; grants: string[] }
  | { error: string };

/** Validates a create/update payload. Unknown keys are rejected, not ignored. */
function parsePermissionSetPayload(body: any): ParsedSetPayload {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Body must be a JSON object with `name` and `grants`.' };
  }
  const unknownKeys = Object.keys(body).filter(
    (key) => !['name', 'description', 'grants'].includes(key)
  );
  if (unknownKeys.length > 0) {
    return { error: `Unknown field(s): ${unknownKeys.join(', ')}.` };
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { error: '`name` is required.' };
  if (name.length > PERMISSION_SET_NAME_MAX) {
    return { error: `\`name\` must be at most ${PERMISSION_SET_NAME_MAX} characters.` };
  }
  let description = '';
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      return { error: '`description` must be a string.' };
    }
    description = body.description.trim();
    if (description.length > PERMISSION_SET_DESCRIPTION_MAX) {
      return { error: `\`description\` must be at most ${PERMISSION_SET_DESCRIPTION_MAX} characters.` };
    }
  }
  if (!Array.isArray(body.grants)) {
    return { error: '`grants` must be an array of operation ids.' };
  }
  const knownOperations = new Set(Object.keys(DEFAULT_PERMISSIONS_MATRIX));
  const seen = new Set<string>();
  const grants: string[] = [];
  for (let index = 0; index < body.grants.length; index += 1) {
    const raw = body.grants[index];
    const operationId = typeof raw === 'string' ? raw.trim() : '';
    if (!operationId || !knownOperations.has(operationId)) {
      return { error: `grants[${index}] '${String(raw)}' is not a known operation.` };
    }
    if (seen.has(operationId)) {
      return { error: `grants[${index}] '${operationId}' is repeated.` };
    }
    seen.add(operationId);
    grants.push(operationId);
  }
  return { name, description, grants };
}

type ParsedSetIdsPayload = { setIds: string[] } | { error: string };

/** Validates the replace-membership payload for one user. */
function parseUserSetIdsPayload(body: any): ParsedSetIdsPayload {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Body must be a JSON object with a `setIds` array.' };
  }
  const unknownKeys = Object.keys(body).filter((key) => key !== 'setIds');
  if (unknownKeys.length > 0) {
    return { error: `Unknown field(s): ${unknownKeys.join(', ')}.` };
  }
  if (!Array.isArray(body.setIds)) {
    return { error: '`setIds` must be an array.' };
  }
  const seen = new Set<string>();
  const setIds: string[] = [];
  for (let index = 0; index < body.setIds.length; index += 1) {
    const raw = body.setIds[index];
    const setId = typeof raw === 'string' ? raw.trim() : '';
    if (!setId) return { error: `setIds[${index}] must be a non-empty set id.` };
    if (seen.has(setId)) return { error: `setIds[${index}] '${setId}' is repeated.` };
    seen.add(setId);
    setIds.push(setId);
  }
  return { setIds };
}

type ParsedOverridePayload =
  | { records: UserPermissionOverrideRecord[] }
  | { error: string };

/**
 * Validates the replace payload. Unknown body/item keys are rejected instead of
 * silently ignored, every reason is required, and an expiry must be a future
 * date — an override that is already dead should not be stored as if it were
 * a live exception.
 */
function parseOverridePayload(body: any): ParsedOverridePayload {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Body must be a JSON object with an `overrides` array.' };
  }
  const unknownBodyKeys = Object.keys(body).filter((key) => key !== 'overrides');
  if (unknownBodyKeys.length > 0) {
    return { error: `Unknown field(s): ${unknownBodyKeys.join(', ')}.` };
  }
  if (!Array.isArray(body.overrides)) {
    return { error: '`overrides` must be an array.' };
  }

  const knownOperations = new Set(Object.keys(DEFAULT_PERMISSIONS_MATRIX));
  const seen = new Set<string>();
  const now = Date.now();
  const records: UserPermissionOverrideRecord[] = [];

  for (let index = 0; index < body.overrides.length; index += 1) {
    const raw = body.overrides[index];
    const at = `overrides[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `${at} must be an object.` };
    }
    const unknownKeys = Object.keys(raw).filter(
      (key) => !['operationId', 'effect', 'reason', 'expiresAt'].includes(key)
    );
    if (unknownKeys.length > 0) {
      return { error: `${at} has unknown field(s): ${unknownKeys.join(', ')}.` };
    }
    const operationId = typeof raw.operationId === 'string' ? raw.operationId.trim() : '';
    if (!operationId || !knownOperations.has(operationId)) {
      return { error: `${at}.operationId '${String(raw.operationId)}' is not a known operation.` };
    }
    if (seen.has(operationId)) {
      return { error: `${at}.operationId '${operationId}' is repeated.` };
    }
    seen.add(operationId);
    if (raw.effect !== 'grant' && raw.effect !== 'deny') {
      return { error: `${at}.effect must be 'grant' or 'deny'.` };
    }
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    if (!reason) {
      return { error: `${at}.reason is required (it is written to the audit trail).` };
    }
    let expiresAt: string | null = null;
    if (raw.expiresAt !== undefined && raw.expiresAt !== null) {
      if (typeof raw.expiresAt !== 'string') {
        return { error: `${at}.expiresAt must be an ISO date string or null.` };
      }
      const expiry = Date.parse(raw.expiresAt);
      if (!Number.isFinite(expiry)) {
        return { error: `${at}.expiresAt is not a valid date.` };
      }
      if (expiry <= now) {
        return { error: `${at}.expiresAt must be in the future.` };
      }
      expiresAt = new Date(expiry).toISOString();
    }
    records.push({ operationId, effect: raw.effect, reason, expiresAt });
  }

  return { records };
}

/**
 * GET /api/permissions/me — the effective operation set for the signed-in
 * session. Reads the matrix and overrides LIVE (the same sources the write
 * endpoints serve) so a just-committed exception is visible immediately.
 */
export async function get_my_permissions(req: any, res: Response): Promise<any> {
  const user = getUserFromReq(req);
  if (!user?.id) {
    res.status(401).json({ message: 'Unauthorized: Authentication required.' });
    return;
  }
  try {
    const [matrixRes, overrideRes, setGrantRes] = await Promise.all([
      pgPool.query(PERMISSION_MATRIX_SELECT_SQL),
      pgPool.query(USER_PERMISSION_OVERRIDES_FOR_USER_SELECT_SQL, [user.id]),
      pgPool.query(USER_PERMISSION_SET_GRANTS_SELECT_SQL, [user.id]),
    ]);
    const matrix = rowsToPermissionMatrix(matrixRes.rows);
    const overrides = rowsToUserPermissionOverrideMap(overrideRes.rows);
    const setGrants = rowsToUserPermissionSetGrantMap(setGrantRes.rows as any);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      role: user.role || '',
      operations: effectiveOperations(user, matrix, overrides, setGrants),
      version: getPermissionsVersion(),
    });
  } catch (err: any) {
    res.status(500).json({ message: `Unable to resolve your permissions: ${err.message}` });
  }
  return;
}

/**
 * GET /api/permissions/operation-overrides?operationId=…&role=…
 *
 * The matrix-cell drill-down: active direct overrides for one operation and
 * one role, filtered to the rows that actually change that role's answer. A
 * redundant grant (role already allows) or deny (role already denies) is not a
 * difference and is omitted. Permission-set grants are a separate layer and
 * are deliberately not mixed into this list.
 *
 * `roleAllowed` comes from the operational matrix cache — the same source the
 * authz middleware enforces. The UI labels it as the last saved role default.
 */
export async function get_operation_permission_overrides(
  req: any,
  res: Response
): Promise<any> {
  const operationId =
    typeof req.query?.operationId === 'string' ? req.query.operationId.trim() : '';
  const role = typeof req.query?.role === 'string' ? req.query.role.trim() : '';

  const operationKnown =
    Boolean(operationId) &&
    (Object.prototype.hasOwnProperty.call(DEFAULT_PERMISSIONS_MATRIX, operationId) ||
      Object.prototype.hasOwnProperty.call(permissionMatrix, operationId));
  if (!operationKnown) {
    res.status(400).json({ message: '`operationId` must name a known operation.' });
    return;
  }
  if (!VALID_ROLES.has(role)) {
    res.status(400).json({ message: '`role` must be a valid role.' });
    return;
  }

  try {
    const result = await pgPool.query(
      USER_PERMISSION_OVERRIDES_FOR_OPERATION_ROLE_SELECT_SQL,
      [operationId, role]
    );
    const roleAllowed = roleBaseAllowed({ role }, operationId, permissionMatrix);
    const users = rowsToOperationPermissionOverrideRecords(result.rows as any).filter(
      (row) => row.effect !== (roleAllowed ? 'grant' : 'deny')
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ operationId, role, roleAllowed, users });
  } catch (err: any) {
    res.status(500).json({
      message: `Unable to read the operation's personal exceptions: ${err.message}`,
    });
  }
  return;
}

/**
 * GET /api/users/access-summary — one bulk read for the Users register.
 *
 * Counts plus each account's effective operation ids: one read feeds both the
 * "1 grant / 0 denies / 2 sets" tally and the register's access filter, so a
 * card never fans out one request per user or per selected operation. The
 * exception reasons stay on `/api/users/:id/permission-overrides`, loaded only
 * when a card is expanded. SUPER_ADMIN only (route layer) because it names
 * every account's access.
 */
export async function get_user_access_summaries(_req: any, res: Response): Promise<any> {
  try {
    const [usersRes, matrixRes, overrideRes, setGrantRes, setCountRes] = await Promise.all([
      pgPool.query(USER_ACCESS_SUMMARY_USERS_SELECT_SQL),
      pgPool.query(PERMISSION_MATRIX_SELECT_SQL),
      pgPool.query(USER_PERMISSION_OVERRIDES_SELECT_SQL),
      pgPool.query(PERMISSION_SET_USER_GRANTS_SELECT_SQL),
      pgPool.query(USER_PERMISSION_SET_COUNTS_SELECT_SQL),
    ]);
    const matrix = rowsToPermissionMatrix(matrixRes.rows);
    const overrides = rowsToUserPermissionOverrideMap(overrideRes.rows);
    const setGrants = rowsToUserPermissionSetGrantMap(setGrantRes.rows as any);
    const setCounts = new Map<string, number>();
    for (const row of setCountRes.rows as any[]) {
      setCounts.set(String(row.user_id), Number(row.set_count) || 0);
    }
    const total = Object.keys(DEFAULT_PERMISSIONS_MATRIX).length;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      users: summarizeUserAccess(
        usersRes.rows as Array<{ id: string; role: string }>,
        matrix,
        overrides,
        setGrants,
        setCounts,
        total
      ),
      total,
      version: getPermissionsVersion(),
    });
  } catch (err: any) {
    res.status(500).json({ message: `Unable to read access summaries: ${err.message}` });
  }
  return;
}

/** GET /api/users/:id/permission-overrides — base role answer + exceptions. */
export async function get_user_permission_overrides(req: any, res: Response): Promise<any> {
  const userId = String(req.params?.id || '');
  if (!userId) {
    res.status(400).json({ message: 'A user id is required.' });
    return;
  }
  try {
    const targetRes = await pgPool.query(PERMISSION_TARGET_USER_SELECT_SQL, [userId]);
    const target = targetRes.rows[0];
    if (!target) {
      res.status(404).json({ message: `User '${userId}' was not found.` });
      return;
    }
    const [matrixRes, overrideRes, setIdsRes, setGrantRes] = await Promise.all([
      pgPool.query(PERMISSION_MATRIX_SELECT_SQL),
      pgPool.query(USER_PERMISSION_OVERRIDES_FOR_USER_SELECT_SQL, [userId]),
      pgPool.query(USER_PERMISSION_SET_IDS_SELECT_SQL, [userId]),
      pgPool.query(USER_PERMISSION_SET_GRANTS_SELECT_SQL, [userId]),
    ]);
    const matrix = rowsToPermissionMatrix(matrixRes.rows);
    const records = rowsToUserPermissionOverrideRecords(overrideRes.rows);
    const overrideMap = rowsToUserPermissionOverrideMap(overrideRes.rows);
    const setGrants = rowsToUserPermissionSetGrantMap(setGrantRes.rows as any);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      userId,
      role: target.role,
      base: basePermissionMap(target.role, matrix),
      overrides: overrideResponseRows(records),
      setIds: (setIdsRes.rows as any[]).map((row) => String(row.set_id)),
      operations: effectiveOperations(target, matrix, overrideMap, setGrants),
      version: getPermissionsVersion(),
    });
  } catch (err: any) {
    res.status(500).json({ message: `Unable to read permission overrides: ${err.message}` });
  }
  return;
}

/**
 * PUT /api/users/:id/permission-overrides — replace one user's exceptions.
 * SUPER_ADMIN only (route layer). A Super Admin target is refused: that role is
 * immutable, so an override could only create a misleading row.
 */
export async function put_user_permission_overrides(req: any, res: Response): Promise<any> {
  const userId = String(req.params?.id || '');
  if (!userId) {
    res.status(400).json({ message: 'A user id is required.' });
    return;
  }
  const parsed = parseOverridePayload(req.body);
  if ('error' in parsed) {
    res.status(400).json({ message: parsed.error });
    return;
  }
  try {
    const targetRes = await pgPool.query(PERMISSION_TARGET_USER_SELECT_SQL, [userId]);
    const target = targetRes.rows[0];
    if (!target) {
      res.status(404).json({ message: `User '${userId}' was not found.` });
      return;
    }
    if (target.role === 'SUPER_ADMIN') {
      res.status(400).json({
        message: 'Super Admin always has every operation; overrides do not apply to this account.',
      });
      return;
    }

    await persistUserPermissionOverrides(userId, parsed.records, {
      runInTransaction: withTransaction,
      publish: (publishedUserId, publishedRecords) => {
        setUserPermissionOverrides(
          replaceUserOverrides(userPermissionOverrides, publishedUserId, publishedRecords)
        );
        bumpPermissionsVersion();
      },
    });

    const changes =
      parsed.records.length === 0
        ? 'no exceptions (cleared)'
        : parsed.records.map((record) => `${record.effect} ${record.operationId} (${record.reason})`).join('; ');
    logAuditEvent(
      req,
      'UPDATE_USER_PERMISSIONS',
      'PERMISSIONS',
      `Replaced permission overrides for ${target.email}: ${changes}.`
    );

    // Respond with the freshly committed state, read live like the GET above.
    // Set grants are included so a saved override keeps the same effective
    // answer the screen was already showing (and the UI keeps its set ids).
    const [matrixRes, setIdsRes, setGrantRes] = await Promise.all([
      pgPool.query(PERMISSION_MATRIX_SELECT_SQL),
      pgPool.query(USER_PERMISSION_SET_IDS_SELECT_SQL, [userId]),
      pgPool.query(USER_PERMISSION_SET_GRANTS_SELECT_SQL, [userId]),
    ]);
    const matrix = rowsToPermissionMatrix(matrixRes.rows);
    const overrideMap = replaceUserOverrides(new Map(), userId, parsed.records);
    const setGrants = rowsToUserPermissionSetGrantMap(setGrantRes.rows as any);
    res.json({
      message: 'User permission overrides updated successfully.',
      userId,
      role: target.role,
      base: basePermissionMap(target.role, matrix),
      overrides: overrideResponseRows(parsed.records),
      setIds: (setIdsRes.rows as any[]).map((row) => String(row.set_id)),
      operations: effectiveOperations(target, matrix, overrideMap, setGrants),
      version: getPermissionsVersion(),
    });
  } catch (err: any) {
    res.status(500).json({ message: `Unable to update user permissions: ${err.message}` });
  }
  return;
}

/** GET /api/permission-sets — every set with its grants and members. */
export async function get_permission_sets(_req: any, res: Response): Promise<any> {
  try {
    const sets = await loadPermissionSetRecords();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ sets, version: getPermissionsVersion() });
  } catch (err: any) {
    res.status(500).json({ message: `Unable to read permission sets: ${err.message}` });
  }
  return;
}

/** POST /api/permission-sets — create a named bundle of grants. */
export async function create_permission_set(req: any, res: Response): Promise<any> {
  const parsed = parsePermissionSetPayload(req.body);
  if ('error' in parsed) {
    res.status(400).json({ message: parsed.error });
    return;
  }
  const id = randomUUID();
  try {
    await withTransaction(async (client) => {
      await client.query(PERMISSION_SET_INSERT_SQL, [id, parsed.name, parsed.description]);
      for (const operationId of parsed.grants) {
        await client.query(PERMISSION_SET_GRANT_INSERT_SQL, [id, operationId]);
      }
    });
    // Publish only after COMMIT: the authz path must never enforce a rolled-back set.
    await publishPermissionSetGrants();
    logAuditEvent(
      req,
      'CREATE_PERMISSION_SET',
      'PERMISSIONS',
      `Created permission set "${parsed.name}" with ${parsed.grants.length} grant(s).`
    );
    const set = (await loadPermissionSetRecords()).find((row) => row.id === id) || null;
    res.status(201).json({
      message: 'Permission set created successfully.',
      set,
      version: getPermissionsVersion(),
    });
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ message: `A permission set named '${parsed.name}' already exists.` });
      return;
    }
    res.status(500).json({ message: `Unable to create the permission set: ${err.message}` });
  }
  return;
}

/** PUT /api/permission-sets/:id — replace a set's name, description and grants. */
export async function update_permission_set(req: any, res: Response): Promise<any> {
  const id = String(req.params?.id || '');
  if (!id) {
    res.status(400).json({ message: 'A permission set id is required.' });
    return;
  }
  const parsed = parsePermissionSetPayload(req.body);
  if ('error' in parsed) {
    res.status(400).json({ message: parsed.error });
    return;
  }
  try {
    const existing = await pgPool.query(PERMISSION_SET_BY_ID_SELECT_SQL, [id]);
    if (!existing.rows[0]) {
      res.status(404).json({ message: `Permission set '${id}' was not found.` });
      return;
    }
    await withTransaction(async (client) => {
      await client.query(PERMISSION_SET_UPDATE_SQL, [id, parsed.name, parsed.description]);
      await client.query(PERMISSION_SET_GRANTS_DELETE_SQL, [id]);
      for (const operationId of parsed.grants) {
        await client.query(PERMISSION_SET_GRANT_INSERT_SQL, [id, operationId]);
      }
    });
    await publishPermissionSetGrants();
    logAuditEvent(
      req,
      'UPDATE_PERMISSION_SET',
      'PERMISSIONS',
      `Permission set "${parsed.name}" now grants ${parsed.grants.length} operation(s).`
    );
    const set = (await loadPermissionSetRecords()).find((row) => row.id === id) || null;
    res.json({
      message: 'Permission set updated successfully.',
      set,
      version: getPermissionsVersion(),
    });
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ message: `A permission set named '${parsed.name}' already exists.` });
      return;
    }
    res.status(500).json({ message: `Unable to update the permission set: ${err.message}` });
  }
  return;
}

/** DELETE /api/permission-sets/:id — delete a set; grants and memberships cascade. */
export async function delete_permission_set(req: any, res: Response): Promise<any> {
  const id = String(req.params?.id || '');
  if (!id) {
    res.status(400).json({ message: 'A permission set id is required.' });
    return;
  }
  try {
    const existing = await pgPool.query(PERMISSION_SET_BY_ID_SELECT_SQL, [id]);
    const set = existing.rows[0];
    if (!set) {
      res.status(404).json({ message: `Permission set '${id}' was not found.` });
      return;
    }
    await withTransaction(async (client) => {
      await client.query(PERMISSION_SET_DELETE_SQL, [id]);
    });
    await publishPermissionSetGrants();
    logAuditEvent(
      req,
      'DELETE_PERMISSION_SET',
      'PERMISSIONS',
      `Deleted permission set "${set.name}" (${id}).`
    );
    res.json({
      success: true,
      message: 'Permission set deleted successfully.',
      version: getPermissionsVersion(),
    });
  } catch (err: any) {
    res.status(500).json({ message: `Unable to delete the permission set: ${err.message}` });
  }
  return;
}

/**
 * PUT /api/users/:id/permission-sets — replace one user's set memberships.
 * SUPER_ADMIN only (route layer). A Super Admin target is refused for the same
 * reason as overrides: that role is immutable, so a membership row could only
 * mislead the next administrator.
 */
export async function put_user_permission_sets(req: any, res: Response): Promise<any> {
  const userId = String(req.params?.id || '');
  if (!userId) {
    res.status(400).json({ message: 'A user id is required.' });
    return;
  }
  const parsed = parseUserSetIdsPayload(req.body);
  if ('error' in parsed) {
    res.status(400).json({ message: parsed.error });
    return;
  }
  try {
    const targetRes = await pgPool.query(PERMISSION_TARGET_USER_SELECT_SQL, [userId]);
    const target = targetRes.rows[0];
    if (!target) {
      res.status(404).json({ message: `User '${userId}' was not found.` });
      return;
    }
    if (target.role === 'SUPER_ADMIN') {
      res.status(400).json({
        message: 'Super Admin always has every operation; permission sets do not apply to this account.',
      });
      return;
    }

    const allSets = await loadPermissionSetRecords();
    const byId = new Map(allSets.map((set) => [set.id, set]));
    const missing = parsed.setIds.filter((setId) => !byId.has(setId));
    if (missing.length > 0) {
      res.status(400).json({ message: `Unknown permission set(s): ${missing.join(', ')}.` });
      return;
    }

    await withTransaction(async (client) => {
      await client.query(PERMISSION_SET_MEMBERS_DELETE_FOR_USER_SQL, [userId]);
      for (const setId of parsed.setIds) {
        await client.query(PERMISSION_SET_MEMBER_INSERT_SQL, [userId, setId]);
      }
    });
    await publishPermissionSetGrants();

    const names = parsed.setIds.map((setId) => byId.get(setId)!.name).join(', ');
    logAuditEvent(
      req,
      'ASSIGN_USER_PERMISSION_SETS',
      'PERMISSIONS',
      `Assigned permission set(s) to ${target.email}: ${names || 'none (cleared)'}.`
    );

    const [matrixRes, overrideRes] = await Promise.all([
      pgPool.query(PERMISSION_MATRIX_SELECT_SQL),
      pgPool.query(USER_PERMISSION_OVERRIDES_FOR_USER_SELECT_SQL, [userId]),
    ]);
    const matrix = rowsToPermissionMatrix(matrixRes.rows);
    const overrides = rowsToUserPermissionOverrideMap(overrideRes.rows);
    const setGrants = await readUserSetGrants(userId);
    res.json({
      message: 'User permission sets updated successfully.',
      userId,
      role: target.role,
      base: basePermissionMap(target.role, matrix),
      setIds: parsed.setIds,
      operations: effectiveOperations(target, matrix, overrides, setGrants),
      version: getPermissionsVersion(),
    });
  } catch (err: any) {
    if (err?.code === '23503') {
      res.status(409).json({ message: 'A permission set or user changed while saving; reload and try again.' });
      return;
    }
    res.status(500).json({ message: `Unable to update user permission sets: ${err.message}` });
  }
  return;
}

