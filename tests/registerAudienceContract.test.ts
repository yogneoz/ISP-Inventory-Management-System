/**
 * Register audience contract — the four warehouse registers each serve a
 * distinct audience, enforced by one coherent chain:
 *   permission-matrix operation -> sidebar nav gate -> App tab gate ->
 *   component action gating -> server route + controller lane checks.
 *
 * Registers under contract:
 *   1. Receive Inbound Stock & Pullouts  (warehouse lane, wh-receive-pullouts)
 *   2. Receive Branch Stock Transfer      (branch lane, branch-transfer-receive)
 *   3. Shipment & Transfer Register       (master register, lane-gated actions,
 *                                          branch-scoped list for non-HQ)
 *   4. Warehouse Pullout Report           (pullout-report-view, view-only)
 *
 * PROVES (source pins, no DB needed):
 *   1. The shipments receive route accepts EITHER lane operation through
 *      requirePermissionAny, and GET /api/shipments is authenticated.
 *   2. requirePermission delegates to requirePermissionAny (single-op
 *      behavior unchanged, OR-semantics shared).
 *   3. post_receive enforces destination affinity (receiver operates the
 *      destination branch) plus the lane's own matrix operation.
 *   4. get_shipments scopes branch-bound accounts to shipments touching
 *      their branches while HQ/SUPER see everything.
 *   5. pullout-report-view is a real matrix operation editable in Permission
 *      Management.
 *   6. Both nav layers (Sidebar + App TAB_PERMISSIONS) gate the report.
 *   7. Report mode is read-only: receive handler stripped, no tab strip.
 *   8. ShipmentRegister's Receive button is lane- and scope-gated
 *      (view-only rows for low-privilege roles).
 *   9. Receive-station badges are lane-scoped instead of one shared number.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(relativePath), 'utf8');

describe('register audience contract', () => {
  test('receive route accepts either lane operation and GET is authenticated', () => {
    const routes = read('server/src/routes/shipments.routes.ts');
    assert.ok(
      routes.includes(
        "requirePermissionAny('wh-receive-pullouts', 'branch-transfer-receive')"
      ),
      'POST /api/shipments/:id/receive must accept either receiving-lane operation'
    );
    assert.ok(
      routes.includes("app.get('/api/shipments', requireAuth,"),
      'GET /api/shipments must require authentication'
    );
  });

  test('requirePermission delegates to the shared OR-middleware', () => {
    const middleware = read('server/src/middleware/index.ts');
    assert.ok(
      middleware.includes('export function requirePermissionAny(...operationIds: string[])'),
      'requirePermissionAny must exist for OR-semantics route gates'
    );
    assert.ok(
      middleware.includes('return requirePermissionAny(operationId);'),
      'requirePermission must delegate so matrix/branch-flag logic stays single-sourced'
    );
  });

  test('post_receive enforces destination affinity and the lane operation', () => {
    const controller = read('server/src/controllers/shipments.controller.ts');
    assert.ok(
      controller.includes('receiverBranches.has(sh.destinationBranchId)'),
      'receiver must operate the shipment destination branch (or be HQ-wide)'
    );
    assert.ok(
      controller.includes(
        "const laneOp = destIsWarehouse ? 'wh-receive-pullouts' : 'branch-transfer-receive';"
      ),
      'each shipment must unlock only its own lane operation from the matrix'
    );
    assert.ok(
      controller.includes("receiveUser.role !== 'SUPER_ADMIN'"),
      'SUPER_ADMIN keeps its matrix bypass for receiving'
    );
  });

  test('get_shipments scopes branch-bound accounts', () => {
    const controller = read('server/src/controllers/shipments.controller.ts');
    assert.ok(
      controller.includes('mine.has(src) || mine.has(dst)'),
      'branch-bound accounts must only see shipments touching their branches'
    );
    assert.ok(
      controller.includes("user.branchId === 'HEAD_OFFICE_ADMIN' ||") ||
        controller.includes("user.role === 'HEAD_OFFICE_ADMIN'"),
      'HQ accounts must keep the full list'
    );
  });

  test('pullout-report-view is a manageable matrix operation', () => {
    const matrix = read('client/src/utils/permissionMatrixData.ts');
    assert.ok(
      matrix.includes("'pullout-report-view',"),
      'operation id must be listed in INVENTORY_OPERATIONS'
    );
    assert.ok(
      matrix.includes("'pullout-report-view': {"),
      'operation must have a default role row so it seeds into the DB'
    );
    const management = read('client/src/features/settings/PermissionManagement.tsx');
    assert.ok(
      management.includes("id: 'pullout-report-view',"),
      'operation must be toggleable in Permission Management'
    );
  });

  test('Warehouse Pullout Report is gated in both nav layers', () => {
    const sidebar = read('client/src/components/layout/Sidebar.tsx');
    assert.ok(
      sidebar.includes("isOperationAllowed('pullout-report-view', currentUser?.role)"),
      'sidebar entry must follow the matrix toggle (enable=show, disable=hide)'
    );
    const app = read('client/src/App.tsx');
    assert.ok(
      app.includes("'pullout-report': 'pullout-report-view',"),
      'App tab gate must map the report to its operation'
    );
  });

  test('report mode renders read-only', () => {
    const stockOps = read('client/src/features/inventory/StockOperations.tsx');
    assert.ok(
      stockOps.includes(
        'onReceiveOperation: initialType === \'PULLOUT_REPORT\' ? undefined : onReceiveOperation'
      ),
      'report mode must strip the receive handler so PulloutBinsPanel hides its Receive action'
    );
    const tabBar = read('client/src/features/inventory/stockops/StockOperationsTabBar.tsx');
    assert.ok(
      tabBar.includes(
        "if (initialType === 'PULLOUT_REPORT' || initialType === 'DAMAGE_REPORT') return null;"
      ),
      'report mode must render no tab strip so it cannot hop into dispatch/receive panels'
    );
  });

  test('ShipmentRegister receive button is lane- and scope-gated', () => {
    const register = read('client/src/features/procurement/ShipmentRegister.tsx');
    assert.ok(
      register.includes(
        "const laneReceiveOp = destIsWarehouse ? 'wh-receive-pullouts' : 'branch-transfer-receive';"
      ),
      'the register must resolve the lane operation per row'
    );
    assert.ok(
      register.includes('const canShowReceiveButton = canReceiveLane && destInScope && receiverActive;'),
      'low-privilege roles (no lane operation) must get view-only rows'
    );
    assert.ok(
      register.includes('receiverBranches.has(sh.destinationBranchId)'),
      'the Receive action must require destination affinity, mirroring the server'
    );
  });

  test('receive-station badges are lane-scoped', () => {
    const sidebar = read('client/src/components/layout/Sidebar.tsx');
    assert.ok(
      sidebar.includes('badge: warehouseInboundCount ?? inTransitShipmentCount'),
      'warehouse receive nav must show the warehouse-lane pending count'
    );
    assert.ok(
      sidebar.includes('badge: branchInboundCount ?? inTransitShipmentCount'),
      'branch receive nav must show the branch-lane pending count'
    );
    const app = read('client/src/App.tsx');
    assert.ok(
      app.includes('warehouseInboundCount={warehouseInboundCount}') &&
        app.includes('branchInboundCount={branchInboundCount}'),
      'App must compute and pass both lane counts to the sidebar'
    );
  });
});
