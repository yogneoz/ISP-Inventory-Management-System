/**
 * Repository for the auth domain — every SQL string and param-list builder
 * for user lookups, super-admin setup, and password persistence lives here,
 * following the same pattern as ./inventory.repo.ts and ./procurement.repo.ts.
 *
 * auth.controller.ts keeps only HTTP concerns (request shaping, session
 * handling, response bodies); query text and column lists are defined once
 * in this layer.
 */

/** Column list every users row read must return (camelCase aliased). */
export const USER_SELECT_COLUMNS =
  'id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser", must_change_password AS "mustChangePassword", status';

/** A password change or reset clears the first-sign-in requirement. */
export const USER_CLEAR_MUST_CHANGE_SQL =
  'UPDATE users SET must_change_password = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1';

/**
 * An employee's login follows their employment. Deactivation suspends an
 * active account; reactivation restores only an account this rule suspended,
 * so an administrator's deliberate lock is never lifted by an HR edit.
 */
export const USER_SUSPEND_SQL =
  "UPDATE users SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'active' RETURNING id, status";

export const USER_RESTORE_SQL =
  "UPDATE users SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'inactive' RETURNING id, status";

/**
 * The signed-in account's avatar: the photo on the employee linked to it.
 * Read separately from the users row so login/switch can attach it to the user
 * payload without widening USER_SELECT_COLUMNS (which also feeds RETURNING
 * clauses, where a subquery is not allowed).
 */
export const USER_LINKED_AVATAR_SQL =
  'SELECT profile_photo AS "avatarUrl" FROM employees WHERE user_id = $1 LIMIT 1';

/** Login lookup: case-insensitive match on email. */
export const USER_FIND_BY_EMAIL_SQL =
  `SELECT ${USER_SELECT_COLUMNS} FROM users WHERE LOWER(email) = LOWER($1)`;

/** Password-hash upgrade after a successful login (bcrypt cost migration). */
export const USER_UPDATE_PASSWORD_SQL =
  'UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2';

/** Setup-status counters: total users and how many are SUPER_ADMIN. */
export const USER_COUNT_SQL =
  "SELECT COUNT(*) AS count, COUNT(CASE WHEN role = 'SUPER_ADMIN' THEN 1 END) AS sa_count FROM users";

/** Super-admin already exists guard. */
export const USER_SUPER_ADMIN_EXISTS_SQL =
  "SELECT 1 FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1";

/**
 * Is this email already an account? First-launch setup must never adopt an
 * existing row: promoting a known employee's address to SUPER_ADMIN — with a
 * password the caller chooses — is account takeover, and it was exactly what
 * the old setup path did (audit finding C1).
 */
export const USER_EMAIL_TAKEN_SQL =
  'SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1';

/**
 * Serialises concurrent first-launch claims. `pg_advisory_xact_lock` is held
 * until the claim transaction commits or rolls back, so two requests that both
 * passed the (necessarily racy) existence probe cannot both insert.
 */
export const SUPER_ADMIN_SETUP_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('users.super_admin.setup'))";

/**
 * The one-time Super Admin claim.
 *
 * One INSERT … SELECT that fails closed in three ways:
 *   - `WHERE NOT EXISTS (role = 'SUPER_ADMIN')` — a second claim inserts nothing,
 *     even if it somehow runs outside the advisory lock;
 *   - `WHERE NOT EXISTS (LOWER(email) = LOWER($2))` — an existing account is
 *     never promoted or overwritten;
 *   - no `ON CONFLICT … DO UPDATE` — a duplicate email is an error, not an
 *     upsert onto somebody else's row.
 *
 * A zero-row result is therefore "someone else got here first", never a success.
 */
export const USER_SUPER_ADMIN_CLAIM_SQL = `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user)
SELECT $1, $2, $3, $4, 'SUPER_ADMIN', $5, $6, true
WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'SUPER_ADMIN')
  AND NOT EXISTS (SELECT 1 FROM users WHERE LOWER(email) = LOWER($2))
RETURNING ${USER_SELECT_COLUMNS}`;

export function superAdminInsertParams(
  targetId: string,
  cleanEmail: string,
  passwordHash: string,
  name: string,
  hqBranchId: string,
  allowedBranches: string[]
): unknown[] {
  return [targetId, cleanEmail, passwordHash, name, hqBranchId, allowedBranches];
}

/**
 * Is this email already another account's? Self-service profile edits must not
 * be able to claim an address somebody else signs in with (audit finding H2).
 * The `users.email` unique constraint is the race-safe backstop.
 */
export const USER_EMAIL_TAKEN_BY_OTHER_SQL =
  'SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2 LIMIT 1';

/**
 * One statement for a self-service profile edit: every supplied field is
 * COALESCEd over the stored value, so name/email/branch/password move together
 * and a half-applied profile (the old in-memory-only write) is impossible.
 */
export const USER_UPDATE_PROFILE_SQL = `UPDATE users SET
  name = COALESCE($2, name),
  email = COALESCE($3, email),
  branch_id = COALESCE($4, branch_id),
  password = COALESCE($5, password),
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING ${USER_SELECT_COLUMNS}`;

/** Profile-switch lookup: by id or case-insensitive email. */
export const USER_FIND_BY_ID_OR_EMAIL_SQL =
  `SELECT ${USER_SELECT_COLUMNS} FROM users WHERE id = $1 OR LOWER(email) = LOWER($2) LIMIT 1`;

/** Shared param builder for the password-persist statements. */
export function userUpdatePasswordParams(passwordHash: string, userId: string): unknown[] {
  return [passwordHash, userId];
}
