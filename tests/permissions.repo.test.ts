/**
 * Unit tests for the permissions repo (node:test).
 * Verifies SQL text, entry flattening, and param ordering without a live
 * database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERMISSION_MATRIX_DELETE_ALL_SQL,
  PERMISSION_MATRIX_UPSERT_SQL,
  permissionMatrixEntries,
  permissionMatrixUpsertParams,
} from '../server/src/models/permissions.repo';

describe('permissions.repo', () => {
  test('DELETE_ALL_SQL wipes the whole matrix', () => {
    assert.equal(PERMISSION_MATRIX_DELETE_ALL_SQL, 'DELETE FROM permission_matrix');
  });

  test('UPSERT_SQL conflicts on (operation_id, role) and refreshes allowed', () => {
    assert.match(
      PERMISSION_MATRIX_UPSERT_SQL,
      /INSERT INTO permission_matrix \(operation_id, role, allowed\) VALUES \(\$1, \$2, \$3\)/
    );
    assert.match(PERMISSION_MATRIX_UPSERT_SQL, /ON CONFLICT \(operation_id, role\) DO UPDATE SET allowed = EXCLUDED\.allowed/);
  });

  test('permissionMatrixEntries flattens op → role → allowed into tuples', () => {
    const entries = permissionMatrixEntries({
      'op.create': { SUPER_ADMIN: true, MANAGER: false },
      'op.view': { VIEWER: true },
    });
    assert.deepEqual(entries, [
      ['op.create', 'SUPER_ADMIN', true],
      ['op.create', 'MANAGER', false],
      ['op.view', 'VIEWER', true],
    ]);
  });

  test('permissionMatrixEntries skips non-object role maps', () => {
    const entries = permissionMatrixEntries({
      'op.good': { ADMIN: true },
      'op.bad': null as unknown as Record<string, boolean>,
    });
    assert.deepEqual(entries, [['op.good', 'ADMIN', true]]);
  });

  test('permissionMatrixEntries coerces truthy/falsy values through Boolean()', () => {
    const entries = permissionMatrixEntries({
      'op.coerce': { ADMIN: 'yes' as unknown as boolean },
    });
    assert.deepEqual(entries, [['op.coerce', 'ADMIN', true]]);
  });

  test('permissionMatrixUpsertParams unwraps the tuple in order', () => {
    assert.deepEqual(permissionMatrixUpsertParams(['op.x', 'ROLE', false]), ['op.x', 'ROLE', false]);
  });
});
