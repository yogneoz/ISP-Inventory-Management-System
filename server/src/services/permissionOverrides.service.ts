/**
 * Per-user permission overrides — the exception layer above the role matrix.
 *
 * Design: docs/permission-overrides-plan.md. One row in
 * `user_permission_overrides` changes one operation for one user; every other
 * (user, operation) pair keeps the role's `permission_matrix` answer. The
 * resolution order is deliberately small and total:
 *
 *   SUPER_ADMIN                       -> allowed (immutable; never locked out)
 *   an override row for this user     -> grant / deny (deny wins by being the
 *                                        same row: one effect per operation)
 *   an assigned permission set grant  -> allowed (sets carry grants only)
 *   no exception / set                -> permission_matrix[operation][role]
 *
 * Two details carry real weight:
 *
 *  - An override for an operation the matrix does not know is IGNORED. A
 *    hand-written row for a removed/renamed operation must not open a gate;
 *    absent rows already fail closed.
 *  - An expired override is IGNORED on read (both grant and deny), so a
 *    temporary exception lapses without a cleanup job and without changing
 *    what the role meant before it was added.
 *
 * The write path is replace-per-user and publishes only AFTER the transaction
 * commits, mirroring `persistPermissionMatrix` (AUD-2): the authz path must
 * never enforce an override the database rolled back.
 */
import { DEFAULT_PERMISSIONS_MATRIX } from '../../../client/src/utils/permissionMatrixData';
import {
  USER_PERMISSION_OVERRIDE_UPSERT_SQL,
  USER_PERMISSION_OVERRIDES_DELETE_FOR_USER_SQL,
  type PermissionOverrideEffect,
  type UserAccessSummaryRecord,
  type UserPermissionOverrideEntry,
  type UserPermissionOverrideMap,
  type UserPermissionOverrideRecord,
  type UserPermissionSetGrantMap,
} from '../models/permissions.repo';

/** The fields the resolver needs from a signed-in user. */
export interface PermissionSubject {
  id?: string;
  role?: string;
}

/** Minimal client surface; the pooled transaction client satisfies it. */
export interface OverrideQueryClient {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

/** The two steps the controller supplies from ../app. */
export interface PersistOverridesDeps {
  /** Runs `fn` inside BEGIN…COMMIT; rejects when the transaction or COMMIT fails. */
  runInTransaction: <T>(fn: (client: OverrideQueryClient) => Promise<T>) => Promise<T>;
  /** Publishes a COMMITTED replacement to the authz read path. */
  publish: (userId: string, records: UserPermissionOverrideRecord[]) => void;
}

/**
 * Monotonic counter for the client's permission cache. Incremented only after
 * a committed write; a restart resets it, which is safe because the client
 * re-reads on bootstrap/login rather than persisting the number.
 */
let permissionsVersion = 1;

/**
 * The operation catalogue. Importing the same defaults the boot seeder uses
 * keeps write validation and read resolution on one list, and lets a grant for
 * a newly added operation apply before `permission_matrix` has a role row for
 * it (a case docs/permission-overrides-plan.md explicitly allows).
 */
export const PERMISSION_OPERATIONS: ReadonlySet<string> = new Set(
  Object.keys(DEFAULT_PERMISSIONS_MATRIX)
);

export function getPermissionsVersion(): number {
  return permissionsVersion;
}

export function bumpPermissionsVersion(): void {
  permissionsVersion += 1;
}

/**
 * True when the user may perform `operation`.
 *
 * Mirrors `requirePermissionAny`'s semantics: SUPER_ADMIN always passes (its
 * branch restrictions are enforced separately), a deny always loses the
 * operation, a grant opens one the role does not have, an assigned set adds a
 * grant, and no row inherits. An explicit per-user deny outranks a set grant:
 * the sets are checked only after the override row.
 */
export function effectivePermission(
  user: PermissionSubject | null | undefined,
  operation: string,
  matrix: Record<string, Record<string, boolean>>,
  overrides: UserPermissionOverrideMap,
  setGrants: UserPermissionSetGrantMap = new Map(),
  now: number = Date.now()
): boolean {
  if (!user || !user.role) return false;
  if (user.role === 'SUPER_ADMIN') return true;

  // A grant for an operation the system does not know must not open a gate.
  // "Known" is the catalogue plus whatever the matrix still carries: a matrix
  // row is an operation some route enforces, even if the catalogue was
  // trimmed. Truly unknown ids fall through to the matrix lookup and fail
  // closed.
  const known =
    PERMISSION_OPERATIONS.has(operation) ||
    Object.prototype.hasOwnProperty.call(matrix, operation);
  if (known) {
    const entry = overrides.get(String(user.id || ''))?.get(operation);
    if (entry && !isOverrideExpired(entry, now)) {
      return entry.effect === 'grant';
    }
    // Sets carry grants only, so they are checked AFTER an explicit deny.
    if (setGrants.get(String(user.id || ''))?.has(operation)) return true;
  }

  return Boolean(matrix[operation]?.[user.role]);
}

/** The role's own answer, before any per-user exception. */
export function roleBaseAllowed(
  user: PermissionSubject | null | undefined,
  operation: string,
  matrix: Record<string, Record<string, boolean>>
): boolean {
  if (!user || !user.role) return false;
  if (user.role === 'SUPER_ADMIN') return true;
  return Boolean(matrix[operation]?.[user.role]);
}

/**
 * Every operation the user may perform, sorted. The union is deliberate: a
 * grant can name an operation the matrix currently lacks a role row for, and
 * the resolver (not the matrix) decides whether it is allowed.
 */
export function effectiveOperations(
  user: PermissionSubject | null | undefined,
  matrix: Record<string, Record<string, boolean>>,
  overrides: UserPermissionOverrideMap,
  setGrants: UserPermissionSetGrantMap = new Map(),
  now: number = Date.now()
): string[] {
  const operations = new Set<string>(Object.keys(matrix));
  for (const operation of overrides.get(String(user?.id || ''))?.keys() || []) {
    operations.add(operation);
  }
  for (const operation of setGrants.get(String(user?.id || '')) || []) {
    operations.add(operation);
  }
  return [...operations]
    .filter((operation) => effectivePermission(user, operation, matrix, overrides, setGrants, now))
    .sort();
}

/** The account fields the Users register summary needs. */
export interface AccessSummarySubject {
  id: string;
  role: string;
}

/**
 * One bulk read for the Users register: per-account counts and the effective
 * operation ids its access filter reads, not a second editor. Role defaults,
 * assigned sets and active overrides are resolved with the same
 * `effectiveOperations` the authz path uses, so a card or filter can never
 * advertise an answer the server would refuse.
 *
 * Expired overrides are ignored in both the counts and the nearest expiry: a
 * lapsed exception is not part of the person's current access.
 */
export function summarizeUserAccess(
  users: readonly AccessSummarySubject[],
  matrix: Record<string, Record<string, boolean>>,
  overrides: UserPermissionOverrideMap,
  setGrants: UserPermissionSetGrantMap,
  setCounts: ReadonlyMap<string, number>,
  total: number,
  now: number = Date.now()
): UserAccessSummaryRecord[] {
  return users.map((user) => {
    let grants = 0;
    let denies = 0;
    let nextExpiry: string | null = null;
    for (const entry of overrides.get(user.id)?.values() || []) {
      if (isOverrideExpired(entry, now)) continue;
      if (entry.effect === 'grant') grants += 1;
      else denies += 1;
      if (entry.expiresAt) {
        const expiry = Date.parse(entry.expiresAt);
        if (
          Number.isFinite(expiry) &&
          (nextExpiry === null || expiry < Date.parse(nextExpiry))
        ) {
          nextExpiry = new Date(expiry).toISOString();
        }
      }
    }
    // The operation list is what the register's access filter reads. A Super
    // Admin may not have a matrix row for a newly added catalogue operation,
    // so the union keeps the card truthful for every selectable operation.
    const operations =
      user.role === 'SUPER_ADMIN'
        ? [...new Set([
            ...Object.keys(matrix),
            ...Object.keys(DEFAULT_PERMISSIONS_MATRIX),
          ])].sort()
        : effectiveOperations(user, matrix, overrides, setGrants, now);
    return {
      userId: user.id,
      role: user.role,
      effective: Math.min(total, operations.length),
      total,
      grants,
      denies,
      setCount: setCounts.get(user.id) || 0,
      nextExpiry,
      operations,
    };
  });
}

/**
 * Whether an override has lapsed. Exported so the admin read can label an
 * expired row without duplicating the comparison.
 */
export function isOverrideExpired(
  entry: { expiresAt: string | null },
  now: number = Date.now()
): boolean {
  if (!entry.expiresAt) return false;
  const expiry = Date.parse(entry.expiresAt);
  // An unparseable timestamp is treated as expired: the fail-closed direction.
  return !Number.isFinite(expiry) || expiry <= now;
}

/**
 * Replaces one user's entries in the indexed map, returning a NEW map so the
 * published value is never mutated in place (a mounted request may still hold
 * the old reference while resolving).
 */
export function replaceUserOverrides(
  current: UserPermissionOverrideMap,
  userId: string,
  records: UserPermissionOverrideRecord[]
): UserPermissionOverrideMap {
  const next = new Map(current);
  if (records.length === 0) {
    next.delete(userId);
    return next;
  }
  const operations = new Map<string, UserPermissionOverrideEntry>();
  for (const record of records) {
    operations.set(record.operationId, {
      effect: record.effect as PermissionOverrideEffect,
      expiresAt: record.expiresAt,
    });
  }
  next.set(userId, operations);
  return next;
}

/**
 * Replace a user's override rows atomically and publish them only after the
 * COMMIT. Rejects with the transaction's own error and publishes nothing on
 * failure, so the running authz path cannot diverge from the table.
 */
export async function persistUserPermissionOverrides(
  userId: string,
  records: UserPermissionOverrideRecord[],
  deps: PersistOverridesDeps
): Promise<void> {
  await deps.runInTransaction(async (client) => {
    await client.query(USER_PERMISSION_OVERRIDES_DELETE_FOR_USER_SQL, [userId]);
    for (const record of records) {
      await client.query(USER_PERMISSION_OVERRIDE_UPSERT_SQL, [
        userId,
        record.operationId,
        record.effect,
        record.reason,
        record.expiresAt,
      ]);
    }
  });
  // Strictly after COMMIT — the authz path reads the published map per request.
  deps.publish(
    userId,
    records.map((record) => ({
      operationId: record.operationId,
      effect: record.effect,
      reason: record.reason,
      expiresAt: record.expiresAt,
    }))
  );
}
