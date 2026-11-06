/**
 * Finance micro-permission regression guard.
 *
 * Finance used to carry two broad umbrellas: `gl-manage` (chart + subledgers +
 * bill terms + dimensions + employee master) and `gl-post` (journals + opening
 * balances + payroll runs + daily cash close). This pins the split into
 * dedicated operations, the route gates that enforce them, and the client
 * gates that keep the same vocabulary on screen.
 *
 * Source pins are deliberate: every other finance API suite exercises the
 * routes end to end against PostgreSQL, while this guard fails fast (no
 * database) if a later edit quietly re-broadens a gate.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { APP_ROLES, DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), 'utf8');

const FINANCE_CONTROLS = [
  'gl-chart-manage',
  'gl-subledger-manage',
  'gl-dimension-manage',
  'gl-bill-terms-manage',
  'gl-payroll-manage',
  'gl-payroll-post',
  'gl-cash-close',
  'gl-opening-post',
  'fin-depreciation-post',
  'assets-view',
] as const;

const SPLIT_AWAY = [
  'gl-chart-manage',
  'gl-subledger-manage',
  'gl-dimension-manage',
  'gl-bill-terms-manage',
  'gl-payroll-manage',
  'gl-payroll-post',
  'gl-cash-close',
  'gl-opening-post',
] as const;

describe('finance micro permissions', () => {
  test('the broad gl-manage grant is replaced by dedicated operations', () => {
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['gl-manage'], undefined, 'gl-manage must not survive as a shadow gate');
    assert.equal(Object.keys(DEFAULT_PERMISSIONS_MATRIX).length, 64, 'operation total');
    for (const operation of FINANCE_CONTROLS) {
      assert.ok(DEFAULT_PERMISSIONS_MATRIX[operation], `${operation} is missing from the matrix`);
      assert.deepEqual(
        Object.keys(DEFAULT_PERMISSIONS_MATRIX[operation]).sort(),
        [...APP_ROLES].sort(),
        `${operation} must carry a default for every role`
      );
    }
    for (const operation of SPLIT_AWAY) {
      assert.notEqual(operation, 'gl-post', `${operation} must not collapse back into manual posting`);
    }
  });

  test('default grants keep finance operable while the auditor stays read-only', () => {
    for (const operation of FINANCE_CONTROLS) {
      assert.equal(DEFAULT_PERMISSIONS_MATRIX[operation].ACCOUNTANT, true, `ACCOUNTANT / ${operation}`);
      assert.equal(DEFAULT_PERMISSIONS_MATRIX[operation].HEAD_OFFICE_ADMIN, true, `HEAD_OFFICE_ADMIN / ${operation}`);
      assert.equal(DEFAULT_PERMISSIONS_MATRIX[operation].FRONT_DESK, false, `FRONT_DESK / ${operation}`);
    }
    for (const operation of [
      'gl-chart-manage',
      'gl-subledger-manage',
      'gl-dimension-manage',
      'gl-bill-terms-manage',
      'gl-payroll-manage',
      'gl-payroll-post',
      'gl-cash-close',
      'gl-opening-post',
      'fin-depreciation-post',
    ]) {
      assert.equal(DEFAULT_PERMISSIONS_MATRIX[operation].AUDITOR, false, `AUDITOR / ${operation}`);
    }
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['assets-view'].AUDITOR, true, 'AUDITOR can read the asset register');
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['assets-manage'].AUDITOR, false, 'AUDITOR cannot change assets');
    for (const role of APP_ROLES) {
      if (DEFAULT_PERMISSIONS_MATRIX['assets-manage'][role]) {
        assert.equal(DEFAULT_PERMISSIONS_MATRIX['assets-view'][role], true, `${role} manages assets but cannot read them`);
      }
    }
  });

  test('accounting masters, payroll, cash close and opening balances use their own gates', () => {
    const accounting = source('server/src/routes/accounting.routes.ts');
    for (const gate of [
      "app.post('/api/accounting/groups', requirePermission('gl-chart-manage')",
      "app.patch('/api/accounting/accounts/:id', requirePermission('gl-chart-manage')",
      "app.post('/api/accounting/chart-defaults', requirePermission('gl-chart-manage')",
      "app.post('/api/accounting/subledgers/generate', requirePermission('gl-subledger-manage')",
      "app.post('/api/accounting/bill-terms', requirePermission('gl-bill-terms-manage')",
      "app.post('/api/accounting/cost-centers', requirePermission('gl-dimension-manage')",
      "app.post('/api/accounting/narrations', requirePermission('gl-dimension-manage')",
      "app.post('/api/accounting/opening-balances', requirePermission('gl-opening-post')",
      "app.post('/api/accounting/cash-close', requirePermission('gl-cash-close')",
      "app.post('/api/accounting/cash-close/:id/reopen', requirePermission('gl-cash-close')",
      "app.post('/api/accounting/journals', requirePermission('gl-post')",
    ]) {
      assert.ok(accounting.includes(gate), `missing route gate: ${gate}`);
    }
    assert.ok(!accounting.includes("requirePermission('gl-manage')"), 'accounting still uses gl-manage');

    const fiscal = source('server/src/routes/fiscal.routes.ts');
    for (const gate of [
      "'/api/fiscal-years/:id/opening-stock',\n  requirePermission('opening-stock-view')",
      "'/api/fiscal-years/:id/opening-stock',\n  requirePermission('opening-stock-edit')",
      "'/api/fiscal-years/:id/vendor-opening-balances',\n  requirePermission('opening-stock-view')",
      "'/api/fiscal-years/:id/vendor-opening-balances',\n  requirePermission('opening-stock-edit')",
    ]) {
      assert.ok(fiscal.includes(gate), `missing fiscal opening gate: ${gate}`);
    }

    const payroll = source('server/src/routes/payroll.routes.ts');
    for (const gate of [
      "app.post('/api/employees', requirePermission('gl-payroll-manage')",
      "app.patch('/api/employees/:id', requirePermission('gl-payroll-manage')",
      "app.post('/api/payroll-runs', requirePermission('gl-payroll-post')",
      "app.post('/api/payroll-runs/:id/pay', requirePermission('gl-payroll-post')",
      "app.get('/api/payroll-runs', requirePermission('gl-view')",
    ]) {
      assert.ok(payroll.includes(gate), `missing payroll gate: ${gate}`);
    }
  });

  test('fixed-asset reads and depreciation posting are separately controlled', () => {
    const inventory = source('server/src/routes/inventory.routes.ts');
    for (const gate of [
      "app.get('/api/fixed-assets/page', requirePermissionAny('assets-view', 'branch-asset-assign')",
      "app.get('/api/fixed-assets/overview', requirePermission('assets-view')",
      "requirePermissionAny('assets-view', 'branch-asset-assign', 'assets-manage')",
      "app.post('/api/fixed-assets/depreciation', requirePermission('fin-depreciation-post')",
      "app.patch('/api/assets/:id/status', requirePermission('assets-manage')",
    ]) {
      assert.ok(inventory.includes(gate), `missing fixed-asset gate: ${gate}`);
    }
    assert.ok(!inventory.includes("requirePermission('fin-statements')"), 'depreciation still shares fin-statements');
    assert.ok(!/app\.get\('\/api\/fixed-assets\/[^']+', async/.test(inventory), 'a fixed-asset read lost its gate');

    const admin = source('server/src/routes/admin.routes.ts');
    assert.ok(
      admin.includes("app.get('/api/document-number-configs', requirePermission('admin-fiscal')"),
      'document-number reads must require admin-fiscal'
    );
    assert.ok(
      admin.includes("app.put('/api/document-number-configs', requirePermission('admin-fiscal')"),
      'document-number writes must require admin-fiscal'
    );
  });

  test('screens, tabs and the sidebar use the same micro permissions', () => {
    const screens: Array<[string, string]> = [
      ['client/src/features/finance/ChartOfAccountsRegister.tsx', "isOperationAllowed('gl-chart-manage'"],
      ['client/src/features/finance/GeneralLedgerMaster.tsx', "isOperationAllowed('gl-chart-manage'"],
      ['client/src/features/finance/SubledgersManagement.tsx', "isOperationAllowed('gl-subledger-manage'"],
      ['client/src/features/finance/BillTermsManagement.tsx', "isOperationAllowed('gl-bill-terms-manage'"],
      ['client/src/features/finance/CostCentersManagement.tsx', "isOperationAllowed('gl-dimension-manage'"],
      ['client/src/features/finance/NarrationTemplatesManagement.tsx', "isOperationAllowed('gl-dimension-manage'"],
      ['client/src/features/finance/DailyCashClose.tsx', "isOperationAllowed('gl-cash-close'"],
      ['client/src/features/finance/OpeningStockManager.tsx', "isOperationAllowed('opening-stock-edit'"],
      ['client/src/features/finance/VendorOpeningBalances.tsx', "isOperationAllowed('opening-stock-view'"],
      ['client/src/features/dashboard/Dashboard.tsx', "isOperationAllowed('assets-view'"],
    ];
    for (const [path, gate] of screens) {
      assert.ok(source(path).includes(gate), `${path} is missing ${gate}`);
    }

    const tabs = source('client/src/routes/tabPermissions.ts');
    assert.ok(tabs.includes("'fixed-assets': 'assets-view'"), 'fixed-assets tab must read assets-view');
    assert.ok(tabs.includes("'depreciation-register': 'assets-view'"), 'depreciation tab must read assets-view');

    const sidebar = source('client/src/components/layout/Sidebar.tsx');
    assert.ok(
      sidebar.includes("isOperationAllowed('assets-view', currentUser?.role)"),
      'the finance asset links must use assets-view'
    );
  });

  test('every matrix operation is named in the grouped permission UI', () => {
    const panel = source('client/src/features/settings/PermissionManagement.tsx');
    for (const operation of Object.keys(DEFAULT_PERMISSIONS_MATRIX)) {
      assert.ok(
        panel.includes(`DEFAULT_PERMISSIONS_MATRIX['${operation}']`),
        `${operation} is not exposed in PermissionManagement`
      );
    }
    assert.ok(!panel.includes("DEFAULT_PERMISSIONS_MATRIX['gl-manage']"), 'stale gl-manage entry');
    for (const operation of FINANCE_CONTROLS) {
      assert.ok(panel.includes(`id: '${operation}'`), `${operation} has no permission group entry`);
    }
  });
});
