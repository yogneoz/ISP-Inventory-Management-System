/**
 * Finance micro-permission boot migration.
 *
 * A tenant that customized `gl-manage`, `gl-post` or the old depreciation gate
 * must keep that choice when the new operation rows are first inserted. These
 * tests pin the inheritance, the fresh-database fallback, the asset-read
 * exception, and the dbBoot wiring.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { APP_ROLES, DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';
import {
  FINANCE_PERMISSION_INHERITANCE,
  buildPermissionSeedEntries,
  type PermissionSeedRow,
} from '../server/src/boot/permissionSeed';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const valueOf = (
  entries: Array<[string, string, boolean]>,
  operationId: string,
  role: string
): boolean | undefined =>
  entries.find(([operation, entryRole]) => operation === operationId && entryRole === role)?.[2];

const MASTER_OPERATIONS = [
  'gl-chart-manage',
  'gl-subledger-manage',
  'gl-dimension-manage',
  'gl-bill-terms-manage',
  'gl-payroll-manage',
] as const;

describe('finance permission seed migration', () => {
  test('inherits a customized legacy matrix for every split grant', () => {
    const customized: PermissionSeedRow[] = [
      { operationId: 'gl-manage', role: 'ACCOUNTANT', allowed: false },
      { operationId: 'gl-manage', role: 'AUDITOR', allowed: true },
      { operationId: 'gl-post', role: 'ACCOUNTANT', allowed: false },
      { operationId: 'gl-post', role: 'HEAD_OFFICE_ADMIN', allowed: false },
      { operationId: 'fin-statements', role: 'ACCOUNTANT', allowed: false },
      { operationId: 'assets-manage', role: 'AUDITOR', allowed: false },
    ];

    const entries = buildPermissionSeedEntries(DEFAULT_PERMISSIONS_MATRIX, customized);

    for (const operation of MASTER_OPERATIONS) {
      assert.equal(
        valueOf(entries, operation, 'ACCOUNTANT'),
        false,
        `${operation} must inherit the narrowed gl-manage grant`
      );
    }
    assert.equal(
      valueOf(entries, 'gl-chart-manage', 'AUDITOR'),
      true,
      'a legacy gl-manage grant must also be inherited when it is wider than the new default'
    );

    for (const operation of ['gl-payroll-post', 'gl-cash-close', 'gl-opening-post']) {
      assert.equal(
        valueOf(entries, operation, 'ACCOUNTANT'),
        false,
        `${operation} must inherit the narrowed gl-post grant`
      );
    }
    assert.equal(
      valueOf(entries, 'gl-cash-close', 'HEAD_OFFICE_ADMIN'),
      false,
      'the posting inheritance is evaluated per role'
    );

    assert.equal(
      valueOf(entries, 'fin-depreciation-post', 'ACCOUNTANT'),
      false,
      'depreciation follows the old fin-statements gate'
    );

    assert.equal(
      valueOf(entries, 'assets-view', 'AUDITOR'),
      true,
      'asset reads keep the new read-only default; they were ungated before the split'
    );
    assert.equal(valueOf(entries, 'assets-view', 'ACCOUNTANT'), true);
    assert.equal(
      valueOf(entries, 'gl-view', 'ACCOUNTANT'),
      true,
      'operations outside the split keep their default'
    );
  });

  test('falls back to the defaults on a fresh database', () => {
    const entries = buildPermissionSeedEntries(DEFAULT_PERMISSIONS_MATRIX, []);

    assert.equal(
      entries.length,
      Object.keys(DEFAULT_PERMISSIONS_MATRIX).length * APP_ROLES.length,
      'every operation × role row is seeded'
    );
    assert.equal(valueOf(entries, 'gl-chart-manage', 'ACCOUNTANT'), true);
    assert.equal(valueOf(entries, 'gl-chart-manage', 'AUDITOR'), false);
    assert.equal(valueOf(entries, 'gl-payroll-post', 'ACCOUNTANT'), true);
    assert.equal(valueOf(entries, 'fin-depreciation-post', 'ACCOUNTANT'), true);
    assert.equal(valueOf(entries, 'assets-view', 'AUDITOR'), true);
  });

  test('a missing legacy row for one role does not block the others', () => {
    const entries = buildPermissionSeedEntries(DEFAULT_PERMISSIONS_MATRIX, [
      { operationId: 'gl-manage', role: 'ACCOUNTANT', allowed: false },
    ]);

    assert.equal(valueOf(entries, 'gl-chart-manage', 'ACCOUNTANT'), false);
    assert.equal(
      valueOf(entries, 'gl-chart-manage', 'HEAD_OFFICE_ADMIN'),
      true,
      'a role without a legacy row keeps its default'
    );
    assert.equal(valueOf(entries, 'gl-payroll-post', 'HEAD_OFFICE_ADMIN'), true);
  });

  test('the inheritance map covers only the split grants and their real parents', () => {
    assert.deepEqual(FINANCE_PERMISSION_INHERITANCE, {
      'gl-chart-manage': 'gl-manage',
      'gl-subledger-manage': 'gl-manage',
      'gl-dimension-manage': 'gl-manage',
      'gl-bill-terms-manage': 'gl-manage',
      'gl-payroll-manage': 'gl-manage',
      'gl-payroll-post': 'gl-post',
      'gl-cash-close': 'gl-post',
      'gl-opening-post': 'gl-post',
      'fin-depreciation-post': 'fin-statements',
    });
    assert.ok(
      !('assets-view' in FINANCE_PERMISSION_INHERITANCE),
      'asset reads keep the new read-only default instead of inheriting assets-manage'
    );

    for (const operation of Object.keys(FINANCE_PERMISSION_INHERITANCE)) {
      assert.ok(DEFAULT_PERMISSIONS_MATRIX[operation], `${operation} must exist in the matrix`);
    }
    for (const parent of Object.values(FINANCE_PERMISSION_INHERITANCE)) {
      assert.ok(
        ['gl-manage', 'gl-post', 'fin-statements'].includes(parent),
        `unexpected legacy parent ${parent}`
      );
    }
  });

  test('dbBoot uses the migration builder and keeps the insert idempotent', () => {
    const boot = read('server/src/boot/dbBoot.ts');
    const seed = read('server/src/boot/permissionSeed.ts');

    assert.match(
      boot,
      /buildPermissionSeedEntries\(\s*DEFAULT_PERMISSIONS_MATRIX\s*,/,
      'dbBoot must delegate the seed rows to the migration builder'
    );
    assert.ok(
      boot.includes('SELECT operation_id AS "operationId", role, allowed FROM permission_matrix'),
      'dbBoot must read the customized matrix before inserting missing operations'
    );
    assert.ok(
      boot.includes('ON CONFLICT (operation_id, role) DO NOTHING'),
      'the insert must never overwrite an existing grant'
    );
    assert.ok(
      !boot.includes('of Object.entries(DEFAULT_PERMISSIONS_MATRIX)'),
      'the old unconditional default loop must be gone'
    );
    assert.ok(
      seed.includes('Object.entries(matrix)'),
      'the migration builder must walk every operation in the default matrix'
    );
  });
});
