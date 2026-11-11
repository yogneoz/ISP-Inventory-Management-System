/**
 * Unit tests for the auth repo query builders (node:test).
 * Verifies SQL text and param ordering without a live database.
 *
 * The super-admin setup statements are covered by their SAFETY properties, not
 * their exact wording: the atomic claim must never upsert, never update a role,
 * and must carry its own "no SUPER_ADMIN exists" guard (audit finding C1).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  USER_SELECT_COLUMNS,
  USER_FIND_BY_EMAIL_SQL,
  USER_UPDATE_PASSWORD_SQL,
  USER_COUNT_SQL,
  USER_SUPER_ADMIN_EXISTS_SQL,
  USER_EMAIL_TAKEN_SQL,
  SUPER_ADMIN_SETUP_LOCK_SQL,
  USER_SUPER_ADMIN_CLAIM_SQL,
  superAdminInsertParams,
  USER_FIND_BY_ID_OR_EMAIL_SQL,
  userUpdatePasswordParams,
} from '../server/src/models/auth.repo';

describe('auth.repo', () => {
  describe('query constants', () => {
    test('USER_SELECT_COLUMNS aliases every snake_case column to camelCase', () => {
      assert.match(USER_SELECT_COLUMNS, /branch_id AS "branchId"/);
      assert.match(USER_SELECT_COLUMNS, /allowed_branch_ids AS "allowedBranchIds"/);
      assert.match(USER_SELECT_COLUMNS, /can_switch_user AS "canSwitchUser"/);
      assert.doesNotMatch(USER_SELECT_COLUMNS, /\b(id|email|password|name|role)\s+AS\b/);
    });

    test('USER_FIND_BY_EMAIL_SQL lowercases both sides of the comparison', () => {
      assert.match(USER_FIND_BY_EMAIL_SQL, /WHERE LOWER\(email\) = LOWER\(\$1\)/);
      assert.equal(USER_FIND_BY_EMAIL_SQL.includes(USER_SELECT_COLUMNS), true);
    });

    test('USER_UPDATE_PASSWORD_SQL stamps updated_at and matches by id', () => {
      assert.match(USER_UPDATE_PASSWORD_SQL, /^UPDATE users SET password = \$1/);
      assert.match(USER_UPDATE_PASSWORD_SQL, /updated_at = CURRENT_TIMESTAMP/);
      assert.match(USER_UPDATE_PASSWORD_SQL, /WHERE id = \$2/);
    });

    test('USER_COUNT_SQL counts total and SUPER_ADMIN users', () => {
      assert.match(USER_COUNT_SQL, /COUNT\(\*\) AS count/);
      assert.match(USER_COUNT_SQL, /role = 'SUPER_ADMIN'/);
    });

    test('USER_SUPER_ADMIN_EXISTS_SQL limits the existence probe to one row', () => {
      assert.match(USER_SUPER_ADMIN_EXISTS_SQL, /SELECT 1 FROM users/);
      assert.match(USER_SUPER_ADMIN_EXISTS_SQL, /LIMIT 1/);
    });

    test('USER_EMAIL_TAKEN_SQL probes by lowercased email and is not limited to admins', () => {
      assert.match(USER_EMAIL_TAKEN_SQL, /SELECT 1 FROM users/);
      assert.match(USER_EMAIL_TAKEN_SQL, /LOWER\(email\) = LOWER\(\$1\)/);
      assert.doesNotMatch(USER_EMAIL_TAKEN_SQL, /role/);
    });

    test('SUPER_ADMIN_SETUP_LOCK_SQL takes a transaction-scoped advisory lock', () => {
      assert.match(SUPER_ADMIN_SETUP_LOCK_SQL, /pg_advisory_xact_lock/);
      assert.match(SUPER_ADMIN_SETUP_LOCK_SQL, /users\.super_admin\.setup/);
    });
  });

  describe('one-time Super Admin claim (C1)', () => {
    test('claims with a single INSERT … SELECT, not an upsert', () => {
      assert.match(USER_SUPER_ADMIN_CLAIM_SQL, /^INSERT INTO users \(/);
      assert.match(USER_SUPER_ADMIN_CLAIM_SQL, /SELECT \$1, \$2, \$3, \$4, 'SUPER_ADMIN'/);
      assert.doesNotMatch(USER_SUPER_ADMIN_CLAIM_SQL, /ON CONFLICT/, 'a conflict must fail, never adopt the row');
      assert.doesNotMatch(USER_SUPER_ADMIN_CLAIM_SQL, /DO UPDATE/i);
    });

    test('never promotes an existing account', () => {
      assert.doesNotMatch(USER_SUPER_ADMIN_CLAIM_SQL, /^UPDATE/im, 'setup must not UPDATE an existing user');
      assert.match(USER_SUPER_ADMIN_CLAIM_SQL, /NOT EXISTS \(SELECT 1 FROM users WHERE LOWER\(email\) = LOWER\(\$2\)\)/);
    });

    test('carries its own "no SUPER_ADMIN exists" guard and returns the created row', () => {
      assert.match(USER_SUPER_ADMIN_CLAIM_SQL, /NOT EXISTS \(SELECT 1 FROM users WHERE role = 'SUPER_ADMIN'\)/);
      assert.match(USER_SUPER_ADMIN_CLAIM_SQL, new RegExp(`RETURNING ${USER_SELECT_COLUMNS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    });

    test('binds every value', () => {
      assert.equal((USER_SUPER_ADMIN_CLAIM_SQL.match(/\?/g) || []).length, 0, 'no ?-style placeholders');
      // $2 appears twice (both NOT EXISTS guards) by design, so compare the
      // DISTINCT placeholder set rather than counting occurrences.
      assert.deepEqual(
        [...new Set(USER_SUPER_ADMIN_CLAIM_SQL.match(/\$\d+/g) || [])].sort(),
        ['$1', '$2', '$3', '$4', '$5', '$6']
      );
    });
  });

  describe('param builders', () => {
    test('superAdminInsertParams preserves the six-value order (id first)', () => {
      const params = superAdminInsertParams('usr-1', 'a@b.c', 'hash', 'Name', 'WH001', ['WH001', 'BR2']);
      assert.deepEqual(params, ['usr-1', 'a@b.c', 'hash', 'Name', 'WH001', ['WH001', 'BR2']]);
    });

    test('userUpdatePasswordParams pairs hash with user id', () => {
      assert.deepEqual(userUpdatePasswordParams('h', 'u9'), ['h', 'u9']);
    });
  });

  describe('statement consistency', () => {
    test('every users SELECT uses the shared camelCase column list', () => {
      for (const sql of [USER_FIND_BY_EMAIL_SQL, USER_FIND_BY_ID_OR_EMAIL_SQL]) {
        assert.equal(sql.includes(USER_SELECT_COLUMNS), true, sql);
      }
    });
  });
});
