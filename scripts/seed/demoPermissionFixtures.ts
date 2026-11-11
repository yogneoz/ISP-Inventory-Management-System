/**
 * Canonical permission settings fixtures.
 *
 * The permission matrix is application configuration rather than demo activity,
 * but a fresh reset truncates it. Re-seeding the same default catalogue the
 * server boots with keeps the settings screen and authorization resolver
 * coherent. Two demo permission sets show the reusable-set workflow without
 * changing any account's effective access beyond those explicit grants.
 */
import { DEFAULT_PERMISSIONS_MATRIX } from '../../client/src/utils/permissionMatrixData';
import { insertRows, type Row } from './fixtureUtils';

const CREATED_AT = '2026-11-01T08:00:00Z';

export interface DemoPermissionFixtures {
  matrix: Row[];
  sets: Row[];
  grants: Row[];
  members: Row[];
}

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
  ];

  const grants: Row[] = [
    ...['gl-view', 'admin-audit', 'warranty-view', 'prod-view', 'stock-valuation', 'hr-employee-view'].map(
      (operationId) => ({ set_id: 'demo-permission-set-auditor', operation_id: operationId })
    ),
    ...['po-create', 'po-receive', 'inv-create', 'inv-pay', 'purchase-return-create', 'suppliers-manage'].map(
      (operationId) => ({ set_id: 'demo-permission-set-procurement', operation_id: operationId })
    ),
  ];

  const members: Row[] = [
    { user_id: 'usr-auditor', set_id: 'demo-permission-set-auditor', created_at: CREATED_AT },
    { user_id: 'usr-inventory', set_id: 'demo-permission-set-procurement', created_at: CREATED_AT },
  ];

  return { matrix, sets, grants, members };
}

export async function applyDemoPermissionFixtures(client: any): Promise<Record<string, number>> {
  const fixtures = buildDemoPermissionFixtures();
  await insertRows(client, 'permission_matrix', ['operation_id', 'role', 'allowed'], fixtures.matrix);
  await insertRows(client, 'permission_sets', ['id', 'name', 'description', 'created_at', 'updated_at'], fixtures.sets);
  await insertRows(client, 'permission_set_grants', ['set_id', 'operation_id'], fixtures.grants);
  await insertRows(client, 'permission_set_members', ['user_id', 'set_id', 'created_at'], fixtures.members);
  return {
    demoPermissionMatrixRows: fixtures.matrix.length,
    demoPermissionSets: fixtures.sets.length,
    demoPermissionSetGrants: fixtures.grants.length,
    demoPermissionSetMembers: fixtures.members.length,
  };
}
