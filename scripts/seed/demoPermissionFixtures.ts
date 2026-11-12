/**
 * Canonical permission settings fixtures.
 *
 * The permission matrix is application configuration rather than demo activity,
 * but a fresh reset truncates it. Re-seeding the same default catalogue the
 * server boots with keeps the settings screen and authorization resolver
 * coherent.
 *
 * The fixtures also ship one worked example per layer of the resolution order,
 * so the permission screens demonstrate the model instead of only describing
 * it. `tests/demoPermissionFixtures.test.ts` pins each one and fails if an
 * example stops changing effective access:
 *
 *   1. a personal GRANT that opens an operation the role does not have
 *      (front desk -> finance dashboard);
 *   2. a personal DENY that closes an operation the role does have — and that
 *      also outranks the set grant below, which is the precedence rule
 *      (auditor -> finance dashboard);
 *   3. a SET that genuinely widens access, because every operation it carries
 *      is one the member's role lacks (branch manager -> branch finance read).
 *
 * The two older sets (auditor, procurement) carry grants those roles already
 * had, so they show the reusable-set workflow without changing anyone's
 * effective access.
 */
import { DEFAULT_PERMISSIONS_MATRIX } from '../../client/src/utils/permissionMatrixData';
import { insertRows, type Row } from './fixtureUtils';

const CREATED_AT = '2026-11-01T08:00:00Z';

export interface DemoPermissionFixtures {
  matrix: Row[];
  sets: Row[];
  grants: Row[];
  members: Row[];
  overrides: Row[];
}

/** The set whose grants are all outside its member's role: the widening demo. */
export const WIDENING_SET_ID = 'demo-permission-set-branch-finance';
export const WIDENING_SET_MEMBER = 'usr-ktm-manager';

export function buildDemoPermissionFixtures(): DemoPermissionFixtures {
  const matrix: Row[] = [];
  for (const [operationId, roles] of Object.entries(DEFAULT_PERMISSIONS_MATRIX)) {
    for (const [role, allowed] of Object.entries(roles)) {
      matrix.push({ operation_id: operationId, role, allowed });
    }
  }

  const sets: Row[] = [
    {
      id: 'demo-permission-set-auditor',
      name: 'Demo Auditor Read-Only',
      description: 'Read-only finance, stock and employee visibility for the internal auditor.',
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
    {
      id: 'demo-permission-set-procurement',
      name: 'Demo Procurement Desk',
      description: 'Procurement ordering, receiving and supplier maintenance for the demo inventory desk.',
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
    {
      id: WIDENING_SET_ID,
      name: 'Demo Branch Finance Read',
      description:
        'Read-only finance, VAT, audit and employee visibility for a branch manager — every grant here is one the Branch Manager role does not have, so assigning it visibly widens access.',
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
  ];

  const grants: Row[] = [
    ...['gl-view', 'admin-audit', 'warranty-view', 'prod-view', 'stock-valuation', 'hr-employee-view'].map(
      (operationId) => ({ set_id: 'demo-permission-set-auditor', operation_id: operationId })
    ),
    ...['po-create', 'po-receive', 'inv-create', 'inv-pay', 'purchase-return-create', 'suppliers-manage'].map(
      (operationId) => ({ set_id: 'demo-permission-set-procurement', operation_id: operationId })
    ),
    // Deliberately operations a Branch Manager lacks (see the module header).
    ...['fin-statements', 'vat-register', 'admin-audit', 'hr-employee-view'].map((operationId) => ({
      set_id: WIDENING_SET_ID,
      operation_id: operationId,
    })),
  ];

  const members: Row[] = [
    { user_id: 'usr-auditor', set_id: 'demo-permission-set-auditor', created_at: CREATED_AT },
    { user_id: 'usr-inventory', set_id: 'demo-permission-set-procurement', created_at: CREATED_AT },
    { user_id: WIDENING_SET_MEMBER, set_id: WIDENING_SET_ID, created_at: CREATED_AT },
  ];

  // Layer 2: one grant and one deny, each on an account whose role answers the
  // opposite way. `reason` is required by the API's own audit rule.
  const overrides: Row[] = [
    {
      user_id: 'usr-frontdesk',
      operation_id: 'gl-view',
      effect: 'grant',
      reason: 'Demo: the front desk may open the finance dashboard (FRONT_DESK does not allow it).',
      expires_at: null,
    },
    {
      user_id: 'usr-auditor',
      operation_id: 'gl-view',
      effect: 'deny',
      reason: 'Demo: the auditor reads statements, not the live dashboard — a deny also outranks a set grant.',
      expires_at: null,
    },
  ];

  return { matrix, sets, grants, members, overrides };
}

export async function applyDemoPermissionFixtures(client: any): Promise<Record<string, number>> {
  const fixtures = buildDemoPermissionFixtures();
  await insertRows(client, 'permission_matrix', ['operation_id', 'role', 'allowed'], fixtures.matrix);
  await insertRows(client, 'permission_sets', ['id', 'name', 'description', 'created_at', 'updated_at'], fixtures.sets);
  await insertRows(client, 'permission_set_grants', ['set_id', 'operation_id'], fixtures.grants);
  await insertRows(client, 'permission_set_members', ['user_id', 'set_id', 'created_at'], fixtures.members);
  await insertRows(
    client,
    'user_permission_overrides',
    ['user_id', 'operation_id', 'effect', 'reason', 'expires_at'],
    fixtures.overrides
  );
  return {
    demoPermissionMatrixRows: fixtures.matrix.length,
    demoPermissionSets: fixtures.sets.length,
    demoPermissionSetGrants: fixtures.grants.length,
    demoPermissionSetMembers: fixtures.members.length,
    demoPermissionOverrides: fixtures.overrides.length,
  };
}
