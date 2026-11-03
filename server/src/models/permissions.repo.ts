/**
 * Repository for the permissions domain — the permission-matrix transaction
 * SQL lives here, following the same pattern as ./inventory.repo.ts and
 * ./auth.repo.ts.
 *
 * permissions.controller.ts keeps only HTTP concerns (payload validation,
 * cache refresh, response bodies); query text is defined once in this layer.
 */

/** Wipes all matrix rows inside the replace transaction. */
export const PERMISSION_MATRIX_DELETE_ALL_SQL = 'DELETE FROM permission_matrix';

/** Reads the whole matrix live from PostgreSQL (mirror-drift fix #7). */
export const PERMISSION_MATRIX_SELECT_SQL = 'SELECT operation_id, role, allowed FROM permission_matrix';

/**
 * Folds the SELECT rows into the client matrix shape
 * `Record<operationId, Record<role, boolean>>` (the same fold dbBoot's
 * loadPermissionMatrixFromDb uses at startup).
 */
export function rowsToPermissionMatrix(rows: Array<{ operation_id: string; role: string; allowed: boolean }>): Record<string, Record<string, boolean>> {
  const matrix: Record<string, Record<string, boolean>> = {};
  for (const row of rows) {
    const opId = row.operation_id as string;
    const role = row.role as string;
    if (!matrix[opId]) matrix[opId] = {};
    matrix[opId][role] = Boolean(row.allowed);
  }
  return matrix;
}

/** Upserts one (operation_id, role) grant. Executed per entry in the tx. */
export const PERMISSION_MATRIX_UPSERT_SQL =
  'INSERT INTO permission_matrix (operation_id, role, allowed) VALUES ($1, $2, $3) ON CONFLICT (operation_id, role) DO UPDATE SET allowed = EXCLUDED.allowed';

/** Flattens a client matrix object into ordered upsert rows. */
export function permissionMatrixEntries(
  matrix: Record<string, Record<string, boolean>>
): Array<[string, string, boolean]> {
  const entries: Array<[string, string, boolean]> = [];
  for (const [opId, roles] of Object.entries(matrix)) {
    if (roles && typeof roles === 'object') {
      for (const [role, allowed] of Object.entries(roles as Record<string, boolean>)) {
        entries.push([opId, role, Boolean(allowed)]);
      }
    }
  }
  return entries;
}

export function permissionMatrixUpsertParams(entry: [string, string, boolean]): unknown[] {
  return [entry[0], entry[1], entry[2]];
}

// ---------------------------------------------------------------------------
// Per-user permission overrides (section 30b of scripts/schema.sql).
//
// These rows are the durable exception layer ABOVE the role matrix: a grant
// opens one operation the role does not have, a deny closes one it does. The
// resolver in services/permissionOverrides.service.ts is the only place that
// interprets `effect`; this file owns the SQL and the row shapes.
// ---------------------------------------------------------------------------

export type PermissionOverrideEffect = 'grant' | 'deny';

/** One override as the API reads and writes it. */
export interface UserPermissionOverrideRecord {
  operationId: string;
  effect: PermissionOverrideEffect;
  reason: string;
  /** ISO-8601 timestamp, or null for "never expires". */
  expiresAt: string | null;
}

/** The minimal value the authz path needs for one operation. */
export interface UserPermissionOverrideEntry {
  effect: PermissionOverrideEffect;
  expiresAt: string | null;
}

/** userId -> operationId -> entry. Built once at boot and after every write. */
export type UserPermissionOverrideMap = Map<string, Map<string, UserPermissionOverrideEntry>>;

/** Raw snake_case row as PostgreSQL returns it. */
export interface PermissionOverrideRow {
  user_id: string;
  operation_id: string;
  effect: string;
  reason: string;
  expires_at: Date | string | null;
}

/** Reads every override, for the boot-time and post-write map rebuild. */
export const USER_PERMISSION_OVERRIDES_SELECT_SQL =
  'SELECT user_id, operation_id, effect, reason, expires_at FROM user_permission_overrides ORDER BY user_id, operation_id';

/** Reads one user's overrides, for GET /api/users/:id/permission-overrides. */
export const USER_PERMISSION_OVERRIDES_FOR_USER_SELECT_SQL =
  'SELECT user_id, operation_id, effect, reason, expires_at FROM user_permission_overrides WHERE user_id = $1 ORDER BY operation_id';

/** Every account id+role, for the Users register's bulk access summary. */
export const USER_ACCESS_SUMMARY_USERS_SELECT_SQL =
  'SELECT id, role FROM users ORDER BY LOWER(name), id';

/** Assigned-set count per user; accounts with no set are simply absent. */
export const USER_PERMISSION_SET_COUNTS_SELECT_SQL =
  'SELECT user_id, COUNT(*)::int AS set_count FROM permission_set_members GROUP BY user_id';

/** One card's read-only access tally, before any operation detail is opened. */
export interface UserAccessSummaryRecord {
  userId: string;
  role: string;
  /** Operations allowed after role defaults, set grants and active overrides. */
  effective: number;
  /** Catalogue size, so every card shares one denominator. */
  total: number;
  /** Active direct grants (expired rows are excluded). */
  grants: number;
  /** Active direct denies (expired rows are excluded). */
  denies: number;
  /** Number of permission sets assigned to this account. */
  setCount: number;
  /** Nearest active exception expiry, ISO-8601, or null for none. */
  nextExpiry: string | null;
  /**
   * Every operation this account may perform, already resolved with the same
   * role matrix / sets / overrides as authz. The Users register filters on this
   * list, so selecting an operation never fans out one read per card.
   */
  operations: string[];
}

/** Clears a user's overrides at the start of the replace transaction. */
export const USER_PERMISSION_OVERRIDES_DELETE_FOR_USER_SQL =
  'DELETE FROM user_permission_overrides WHERE user_id = $1';

/** Upserts one override inside the replace transaction. */
export const USER_PERMISSION_OVERRIDE_UPSERT_SQL =
  'INSERT INTO user_permission_overrides (user_id, operation_id, effect, reason, expires_at) ' +
  'VALUES ($1, $2, $3, $4, $5) ' +
  'ON CONFLICT (user_id, operation_id) DO UPDATE SET ' +
  'effect = EXCLUDED.effect, reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, ' +
  'updated_at = CURRENT_TIMESTAMP';

/** Resolves the target account for both override endpoints. */
export const PERMISSION_TARGET_USER_SELECT_SQL =
  'SELECT id, email, name, role, branch_id AS "branchId" FROM users WHERE id = $1';

/** A stored value outside the CHECK constraint is read as a grant only by name. */
export function permissionOverrideEffect(value: string): PermissionOverrideEffect {
  return value === 'deny' ? 'deny' : 'grant';
}

/**
 * A timestamp PostgreSQL hands back as a Date; normalise it to ISO-8601. An
 * unparseable value is kept verbatim so the resolver's Date.parse() sees NaN
 * and treats the override as expired (fail closed), never as "no expiry".
 */
function toIsoTimestamp(value: Date | string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** Folds raw rows into the API's camelCase records. */
export function rowsToUserPermissionOverrideRecords(
  rows: PermissionOverrideRow[]
): UserPermissionOverrideRecord[] {
  return rows.map((row) => ({
    operationId: row.operation_id,
    effect: permissionOverrideEffect(row.effect),
    reason: row.reason,
    expiresAt: toIsoTimestamp(row.expires_at),
  }));
}

/** Builds the indexed map the authz middleware reads per request. */
export function rowsToUserPermissionOverrideMap(
  rows: PermissionOverrideRow[]
): UserPermissionOverrideMap {
  const map: UserPermissionOverrideMap = new Map();
  for (const row of rows) {
    let operations = map.get(row.user_id);
    if (!operations) {
      operations = new Map();
      map.set(row.user_id, operations);
    }
    operations.set(row.operation_id, {
      effect: permissionOverrideEffect(row.effect),
      expiresAt: toIsoTimestamp(row.expires_at),
    });
  }
  return map;
}

/** Bind order for USER_PERMISSION_OVERRIDE_UPSERT_SQL. */
export function permissionOverrideUpsertParams(
  userId: string,
  record: UserPermissionOverrideRecord
): unknown[] {
  return [userId, record.operationId, record.effect, record.reason, record.expiresAt];
}

/**
 * Active direct overrides for one operation and one role, with the account
 * identity needed by the matrix drill-down. Expired rows are excluded here:
 * they cannot make anyone differ from the role default.
 */
export const USER_PERMISSION_OVERRIDES_FOR_OPERATION_ROLE_SELECT_SQL =
  'SELECT o.user_id, o.operation_id, o.effect, o.reason, o.expires_at, ' +
  'u.name, u.email, u.role ' +
  'FROM user_permission_overrides o ' +
  'JOIN users u ON u.id = o.user_id ' +
  'WHERE o.operation_id = $1 AND u.role = $2 ' +
  'AND (o.expires_at IS NULL OR o.expires_at > CURRENT_TIMESTAMP) ' +
  'ORDER BY u.name ASC, u.email ASC';

/** One account-level row for the matrix drill-down. */
export interface OperationPermissionOverrideRecord {
  userId: string;
  operationId: string;
  name: string;
  email: string;
  role: string;
  effect: PermissionOverrideEffect;
  reason: string;
  expiresAt: string | null;
}

/** Raw joined row returned by the operation/role drill-down query. */
export interface OperationPermissionOverrideRow {
  user_id: string;
  operation_id: string;
  name: string;
  email: string;
  role: string;
  effect: string;
  reason: string;
  expires_at: Date | string | null;
}

/** Folds the joined rows into the read-only API records. */
export function rowsToOperationPermissionOverrideRecords(
  rows: OperationPermissionOverrideRow[]
): OperationPermissionOverrideRecord[] {
  return rows.map((row) => ({
    userId: row.user_id,
    operationId: row.operation_id,
    name: row.name,
    email: row.email,
    role: row.role,
    effect: permissionOverrideEffect(row.effect),
    reason: row.reason,
    expiresAt: toIsoTimestamp(row.expires_at),
  }));
}

// ---------------------------------------------------------------------------
// Reusable permission sets (section 30c of scripts/schema.sql).
//
// A set is a named bundle of GRANTS shared by several users. The resolver
// treats every assigned set as an additional grant; an explicit per-user deny
// still wins. This file owns the SQL and row shapes; the controller owns
// validation and the audit trail.
// ---------------------------------------------------------------------------

/** One set as the API reads and writes it. */
export interface PermissionSetRecord {
  id: string;
  name: string;
  description: string;
  /** Catalogue operation ids this set grants, sorted for deterministic output. */
  grants: string[];
  /** User ids assigned to this set, sorted. */
  members: string[];
  createdAt: string;
  updatedAt: string;
}

/** userId -> operations granted by that user's sets. Derived, never stored. */
export type UserPermissionSetGrantMap = Map<string, Set<string>>;

/** Raw set header row. */
export interface PermissionSetRow {
  id: string;
  name: string;
  description: string;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Raw grant row. */
export interface PermissionSetGrantRow {
  set_id: string;
  operation_id: string;
}

/** Raw membership row. */
export interface PermissionSetMemberRow {
  set_id: string;
  user_id: string;
}

/** Raw per-user grant projection (members joined to grants). */
export interface UserPermissionSetGrantRow {
  user_id: string;
  operation_id: string;
}

/** Set headers, ordered by name for the admin list. */
export const PERMISSION_SETS_SELECT_SQL =
  'SELECT id, name, description, created_at, updated_at FROM permission_sets ORDER BY LOWER(name), id';

/** One set header, for existence checks before a replace. */
export const PERMISSION_SET_BY_ID_SELECT_SQL =
  'SELECT id, name, description, created_at, updated_at FROM permission_sets WHERE id = $1';

/** Every set's grant rows. */
export const PERMISSION_SET_GRANTS_SELECT_SQL =
  'SELECT set_id, operation_id FROM permission_set_grants ORDER BY set_id, operation_id';

/** Every set's memberships. */
export const PERMISSION_SET_MEMBERS_SELECT_SQL =
  'SELECT set_id, user_id FROM permission_set_members ORDER BY set_id, user_id';

/** One user's assigned set ids, for the user editor. */
export const USER_PERMISSION_SET_IDS_SELECT_SQL =
  'SELECT set_id FROM permission_set_members WHERE user_id = $1 ORDER BY set_id';

/** Every membership joined to that set's grants — the boot/authz map source. */
export const PERMISSION_SET_USER_GRANTS_SELECT_SQL =
  'SELECT m.user_id, g.operation_id FROM permission_set_members m ' +
  'JOIN permission_set_grants g ON g.set_id = m.set_id ORDER BY m.user_id, g.operation_id';

/** One user's set grants, for /api/permissions/me and the admin read. */
export const USER_PERMISSION_SET_GRANTS_SELECT_SQL =
  'SELECT m.user_id, g.operation_id FROM permission_set_members m ' +
  'JOIN permission_set_grants g ON g.set_id = m.set_id WHERE m.user_id = $1 ORDER BY g.operation_id';

/** Creates a set header inside the replace transaction. */
export const PERMISSION_SET_INSERT_SQL =
  'INSERT INTO permission_sets (id, name, description) VALUES ($1, $2, $3)';

/** Updates a set header inside the replace transaction. */
export const PERMISSION_SET_UPDATE_SQL =
  'UPDATE permission_sets SET name = $2, description = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1';

/** Deletes a set; grants and memberships cascade. */
export const PERMISSION_SET_DELETE_SQL = 'DELETE FROM permission_sets WHERE id = $1';

/** Clears a set's grants before the replacement rows are inserted. */
export const PERMISSION_SET_GRANTS_DELETE_SQL =
  'DELETE FROM permission_set_grants WHERE set_id = $1';

/** Inserts one grant row for a set. */
export const PERMISSION_SET_GRANT_INSERT_SQL =
  'INSERT INTO permission_set_grants (set_id, operation_id) VALUES ($1, $2)';

/** Clears a user's memberships before the replacement set ids are inserted. */
export const PERMISSION_SET_MEMBERS_DELETE_FOR_USER_SQL =
  'DELETE FROM permission_set_members WHERE user_id = $1';

/** Inserts one membership row. */
export const PERMISSION_SET_MEMBER_INSERT_SQL =
  'INSERT INTO permission_set_members (user_id, set_id) VALUES ($1, $2)';


function toIso(value: Date | string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** Folds the three admin reads into the API's camelCase set records. */
export function rowsToPermissionSetRecords(
  sets: PermissionSetRow[],
  grants: PermissionSetGrantRow[],
  members: PermissionSetMemberRow[]
): PermissionSetRecord[] {
  const grantsBySet = new Map<string, string[]>();
  for (const row of grants) {
    const list = grantsBySet.get(row.set_id) || [];
    list.push(row.operation_id);
    grantsBySet.set(row.set_id, list);
  }
  const membersBySet = new Map<string, string[]>();
  for (const row of members) {
    const list = membersBySet.get(row.set_id) || [];
    list.push(row.user_id);
    membersBySet.set(row.set_id, list);
  }
  return sets.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description || '',
    grants: (grantsBySet.get(row.id) || []).sort(),
    members: (membersBySet.get(row.id) || []).sort(),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }));
}

/** Folds membership+grant rows into the resolver's per-user map. */
export function rowsToUserPermissionSetGrantMap(
  rows: UserPermissionSetGrantRow[]
): UserPermissionSetGrantMap {
  const map: UserPermissionSetGrantMap = new Map();
  for (const row of rows) {
    let operations = map.get(row.user_id);
    if (!operations) {
      operations = new Set();
      map.set(row.user_id, operations);
    }
    operations.add(row.operation_id);
  }
  return map;
}
