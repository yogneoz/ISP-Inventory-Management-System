/**
 * Unit tests for the auth repo query builders (node:test).
 * Verifies SQL text and param ordering without a live database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  USER_SELECT_COLUMNS,
  USER_FIND_BY_EMAIL_SQL,
  USER_UPDATE_PASSWORD_SQL,
  USER_COUNT_SQL,
  USER_SUPER_ADMIN_EXISTS_SQL,
  USER_FIND_FOR_SETUP_SQL,
  USER_SUPER_ADMIN_UPDATE_SQL,
  USER_SUPER_ADMIN_INSERT_SQL,
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

    test('USER_FIND_FOR_SETUP_SQL prefers the oldest candidate row', () => {
      assert.match(USER_FIND_FOR_SETUP_SQL, /LOWER\(email\) = LOWER\(\$1\) OR role = 'SUPER_ADMIN'/);
      assert.match(USER_FIND_FOR_SETUP_SQL, /ORDER BY created_at ASC LIMIT 1/);
    });

    test('USER_SUPER_ADMIN_UPDATE_SQL returns the full camelCase row', () => {
      assert.match(USER_SUPER_ADMIN_UPDATE_SQL, /^UPDATE users SET/);
      assert.match(USER_SUPER_ADMIN_UPDATE_SQL, /role = 'SUPER_ADMIN'/);
      assert.match(USER_SUPER_ADMIN_UPDATE_SQL, /can_switch_user = true/);
      assert.match(USER_SUPER_ADMIN_UPDATE_SQL, /WHERE id = \$6/);
      assert.match(USER_SUPER_ADMIN_UPDATE_SQL, /RETURNING id, email, password/);
    });

    test('USER_SUPER_ADMIN_INSERT_SQL upserts on the email conflict target', () => {
      assert.match(USER_SUPER_ADMIN_INSERT_SQL, /INSERT INTO users \(id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user\)/);
      assert.match(USER_SUPER_ADMIN_INSERT_SQL, /ON CONFLICT \(email\) DO UPDATE SET/);
      assert.match(USER_SUPER_ADMIN_INSERT_SQL, /RETURNING id, email, password/);
      assert.equal(
        (USER_SUPER_ADMIN_INSERT_SQL.match(/\?/g) || []).length,
        0,
        'no unparameterized values'
      );
    });

    test('USER_FIND_BY_ID_OR_EMAIL_SQL matches id OR lowercased email', () => {
      assert.match(USER_FIND_BY_ID_OR_EMAIL_SQL, /WHERE id = \$1 OR LOWER\(email\) = LOWER\(\$2\) LIMIT 1/);
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
      for (const sql of [USER_FIND_BY_EMAIL_SQL, USER_FIND_FOR_SETUP_SQL, USER_FIND_BY_ID_OR_EMAIL_SQL]) {
        assert.equal(sql.includes(USER_SELECT_COLUMNS), true, sql);
      }
    });
  });
});
