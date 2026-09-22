/**
 * Repository for the auth domain — every SQL string and param-list builder
 * for user lookups, super-admin setup, and password persistence lives here,
 * following the same pattern as ./inventory.repo.ts and ./procurement.repo.ts.
 *
 * auth.controller.ts keeps only HTTP concerns (request shaping, session
 * handling, response bodies); query text and column lists are defined once
 * in this layer.
 */
import type { User } from '../../../client/src/types';

/** Column list every users row read must return (camelCase aliased). */
export const USER_SELECT_COLUMNS =
  'id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser"';

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

/** Super-admin setup lookup: existing row by email or any SUPER_ADMIN row. */
export const USER_FIND_FOR_SETUP_SQL = `SELECT ${USER_SELECT_COLUMNS}
         FROM users
         WHERE LOWER(email) = LOWER($1) OR role = 'SUPER_ADMIN'
         ORDER BY created_at ASC LIMIT 1`;

/** Super-admin upsert-by-id path (when a candidate row was found). */
export const USER_SUPER_ADMIN_UPDATE_SQL = `UPDATE users SET
             email = $1,
             password = $2,
             name = $3,
             role = 'SUPER_ADMIN',
             branch_id = $4,
             allowed_branch_ids = $5,
             can_switch_user = true
           WHERE id = $6
           RETURNING ${USER_SELECT_COLUMNS}`;

/** Super-admin insert-or-revive path (fallback and no-candidate paths). */
export const USER_SUPER_ADMIN_INSERT_SQL = `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user)
           VALUES ($1, $2, $3, $4, 'SUPER_ADMIN', $5, $6, true)
           ON CONFLICT (email) DO UPDATE SET
             password = EXCLUDED.password,
             name = EXCLUDED.name,
             role = 'SUPER_ADMIN',
             branch_id = EXCLUDED.branch_id,
             allowed_branch_ids = EXCLUDED.allowed_branch_ids,
             can_switch_user = true
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

/** Profile-switch lookup: by id or case-insensitive email. */
export const USER_FIND_BY_ID_OR_EMAIL_SQL =
  `SELECT ${USER_SELECT_COLUMNS} FROM users WHERE id = $1 OR LOWER(email) = LOWER($2) LIMIT 1`;

/** Shared param builder for the password-persist statements. */
export function userUpdatePasswordParams(passwordHash: string, userId: string): unknown[] {
  return [passwordHash, userId];
}

/** Row shape produced by the RETURNING clause of the super-admin statements. */
export type UserRow = Pick<
  User,
  'id' | 'email' | 'password' | 'name' | 'role' | 'branchId' | 'allowedBranchIds' | 'canSwitchUser'
>;
