/**
 * The verification seed ships one worked example per permission layer so the
 * screens can demonstrate the resolution order. A demo that silently stops
 * changing access is worse than no demo — it teaches the wrong thing — so each
 * example is asserted against the same default matrix the server boots with.
 *
 * Pure: no database, no HTTP.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDemoPermissionFixtures,
  WIDENING_SET_ID,
  WIDENING_SET_MEMBER,
} from '../scripts/seed/demoPermissionFixtures';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';

const ROLE_OF_DEMO_USER: Record<string, string> = {
  'usr-frontdesk': 'FRONT_DESK',
  'usr-auditor': 'AUDITOR',
  'usr-ktm-manager': 'BRANCH_MANAGER',
};

describe('demo permission fixtures', () => {
  const fixtures = buildDemoPermissionFixtures();

  test('the matrix fixture covers every operation for every role', () => {
    const roles = new Set(Object.values(DEFAULT_PERMISSIONS_MATRIX).flatMap((roles) => Object.keys(roles)));
    assert.equal(fixtures.matrix.length, Object.keys(DEFAULT_PERMISSIONS_MATRIX).length * roles.size);
    assert.equal(roles.size, 12);
  });

  test('the granted example opens an operation its role denies', () => {
    const grant = fixtures.overrides.find((row) => row.effect === 'grant');
    assert.ok(grant, 'a demo grant must exist');
    const role = ROLE_OF_DEMO_USER[grant.user_id as string];
    assert.ok(role, `the granted account ${grant.user_id} must be a known demo user`);
    assert.equal(
      DEFAULT_PERMISSIONS_MATRIX[grant.operation_id as string][role],
      false,
      `${grant.operation_id} must not be a ${role} default, or the grant teaches nothing`
    );
  });

  test('the denied example closes an operation its role allows', () => {
    const deny = fixtures.overrides.find((row) => row.effect === 'deny');
    assert.ok(deny, 'a demo deny must exist');
    const role = ROLE_OF_DEMO_USER[deny.user_id as string];
    assert.ok(role, `the denied account ${deny.user_id} must be a known demo user`);
    assert.equal(
      DEFAULT_PERMISSIONS_MATRIX[deny.operation_id as string][role],
      true,
      `${deny.operation_id} must be a ${role} default, or the deny teaches nothing`
    );
  });

  test('the deny outranks the set grant on the same operation', () => {
    const deny = fixtures.overrides.find((row) => row.effect === 'deny');
    assert.ok(deny, 'a demo deny must exist');
    const grantedByASet = fixtures.grants.some(
      (row) =>
        row.operation_id === deny.operation_id &&
        fixtures.members.some((member) => member.set_id === row.set_id && member.user_id === deny.user_id)
    );
    assert.ok(
      grantedByASet,
      'the denied operation must also be granted to that user by an assigned set, so the screen shows the precedence rule'
    );
  });

  test('the widening set grants only operations its member role lacks', () => {
    const set = fixtures.sets.find((row) => row.id === WIDENING_SET_ID);
    assert.ok(set, 'the widening set must exist');
    const grants = fixtures.grants.filter((row) => row.set_id === WIDENING_SET_ID);
    assert.ok(grants.length > 0, 'the widening set must carry grants');
    for (const grant of grants) {
      const role = ROLE_OF_DEMO_USER[WIDENING_SET_MEMBER];
      assert.equal(
        DEFAULT_PERMISSIONS_MATRIX[grant.operation_id as string][role],
        false,
        `${grant.operation_id} is already a ${role} default, so the set would not widen access`
      );
    }
    assert.ok(
      fixtures.members.some((row) => row.set_id === WIDENING_SET_ID && row.user_id === WIDENING_SET_MEMBER),
      'the widening set must be assigned to the branch manager'
    );
  });

  test('every seeded override carries a reason (the API requires one)', () => {
    for (const row of fixtures.overrides) {
      assert.equal(typeof row.reason, 'string');
      assert.ok(String(row.reason).trim().length > 0, `${row.user_id}/${row.operation_id} needs a reason`);
    }
  });
});
