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
    assert.equal(Object.keys(DEFAULT_PERMISSIONS_MATRIX).length, 71, 'operation total');
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
    // HR access no longer rides on the payroll grant: reading PII and editing
    // the master are their own operations, while payroll posting stays separate.
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['hr-employee-view'].ACCOUNTANT, true);
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['hr-employee-manage'].ACCOUNTANT, false);
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['hr-employee-view'].AUDITOR, true);
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['hr-employee-manage'].AUDITOR, false);
    // The two HR roles are first-class catalogue entries, not aliases for the
    // payroll grant. Officers read; managers read and maintain.
    assert.ok(APP_ROLES.includes('HR_MANAGER'));
    assert.ok(APP_ROLES.includes('HR_OFFICER'));
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['hr-employee-view'].HR_MANAGER, true);
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['hr-employee-manage'].HR_MANAGER, true);
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['hr-employee-view'].HR_OFFICER, true);
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['hr-employee-manage'].HR_OFFICER, false);
    // Attendance is its own write control: managers and head office write,
    // officers/auditors only read, and a payroll manager keeps access through
    // the legacy gl-payroll-manage grant the HR routes accept.
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['hr-attendance-manage'].HR_MANAGER, true);
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['hr-attendance-manage'].HEAD_OFFICE_ADMIN, true);
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['hr-attendance-manage'].HR_OFFICER, false);
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['hr-attendance-manage'].AUDITOR, false);
    assert.equal(DEFAULT_PERMISSIONS_MATRIX['hr-attendance-manage'].ACCOUNTANT, false);

    const panel = source('client/src/features/settings/PermissionManagement.tsx');
    const accessLabels = source('client/src/features/settings/UserPermissions.tsx');
    const core = source('server/src/controllers/permissions.core.ts');
    const schema = source('scripts/schema.sql');
    for (const role of ['HR_MANAGER', 'HR_OFFICER']) {
      assert.ok(panel.includes(`key: '${role}'`), `${role} has no permission column`);
      assert.ok(accessLabels.includes(`${role}:`), `${role} has no access-screen label`);
      assert.ok(core.includes(`'${role}'`), `${role} is not accepted by the role validator`);
      assert.ok(schema.includes(`'${role}'`), `${role} is missing from the users.role whitelist`);
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

    const hr = source('server/src/routes/hr.routes.ts');
    for (const gate of [
      "const HR_VIEW = ['hr-employee-view', 'hr-attendance-manage', 'gl-payroll-manage'] as const",
      "const HR_ATTENDANCE_WRITE = ['hr-attendance-manage', 'gl-payroll-manage'] as const",
      "const HR_SALARY_READ = ['hr-employee-view', 'hr-employee-manage', 'gl-payroll-manage'] as const",
      "const HR_SALARY_WRITE = ['hr-employee-manage', 'gl-payroll-manage'] as const",
      "app.get('/api/hr/attendance', requirePermissionAny(...HR_VIEW)",
      "app.post('/api/hr/attendance', requirePermissionAny(...HR_ATTENDANCE_WRITE)",
      "'/api/hr/attendance/import',\n    requirePermissionAny(...HR_ATTENDANCE_WRITE)",
      "app.get('/api/hr/holidays', requirePermissionAny(...HR_VIEW)",
      "app.post('/api/hr/holidays', requirePermissionAny(...HR_ATTENDANCE_WRITE)",
      "app.get('/api/hr/shifts', requirePermissionAny(...HR_VIEW)",
      "app.get('/api/hr/leave-types', requirePermissionAny(...HR_VIEW)",
      "app.get('/api/hr/leave-balances', requirePermissionAny(...HR_VIEW)",
      "app.get('/api/hr/leave-requests', requirePermissionAny(...HR_VIEW)",
      "app.post('/api/hr/leave-balances', requirePermissionAny(...HR_ATTENDANCE_WRITE)",
      "app.patch('/api/hr/leave-balances/:id', requirePermissionAny(...HR_ATTENDANCE_WRITE)",
      "app.post('/api/hr/leave-requests', requirePermissionAny(...HR_ATTENDANCE_WRITE)",
      "app.post('/api/hr/leave-requests/:id/approve', requirePermissionAny(...HR_ATTENDANCE_WRITE)",
      "app.post('/api/hr/leave-requests/:id/reject', requirePermissionAny(...HR_ATTENDANCE_WRITE)",
      "app.post('/api/hr/leave-requests/:id/cancel', requirePermissionAny(...HR_ATTENDANCE_WRITE)",
      "app.get('/api/hr/payroll-inputs', requirePermissionAny(...HR_VIEW)",
      "app.get(\n    '/api/hr/employee-salaries',\n    requirePermissionAny(...HR_SALARY_READ)",
      "app.post(\n    '/api/hr/employee-salaries',\n    requirePermissionAny(...HR_SALARY_WRITE)",
      "app.patch(\n    '/api/hr/employee-salaries/:id',\n    requirePermissionAny(...HR_SALARY_WRITE)",
      "app.get(\n    '/api/hr/statutory-configs',\n    requirePermissionAny(...HR_SALARY_READ)",
      "app.post(\n    '/api/hr/statutory-configs',\n    requirePermissionAny(...HR_SALARY_WRITE)",
      "app.patch(\n    '/api/hr/statutory-configs/:id',\n    requirePermissionAny(...HR_SALARY_WRITE)",
      "app.get(\n    '/api/hr/employee-salaries/:id/statutory',\n    requirePermissionAny(...HR_SALARY_READ)",
      "app.get(\n    '/api/hr/self-service/payslips',\n    requirePermissionAny('hr-self-service')",
      "app.get(\n    '/api/hr/self-service/leave',\n    requirePermissionAny('hr-self-service')",
    ]) {
      assert.ok(hr.includes(gate), `missing HR attendance gate: ${gate}`);
    }

    const payroll = source('server/src/routes/payroll.routes.ts');
    for (const gate of [
      "app.get('/api/employees', requirePermissionAny('hr-employee-view', 'gl-payroll-manage')",
      "app.get('/api/employees/:id', requirePermissionAny('hr-employee-view', 'gl-payroll-manage')",
      "app.get('/api/employees/user-options', requirePermissionAny('hr-employee-manage', 'gl-payroll-manage')",
      "app.post('/api/employees', requirePermissionAny('hr-employee-manage', 'gl-payroll-manage')",
      "app.patch('/api/employees/:id', requirePermissionAny('hr-employee-manage', 'gl-payroll-manage')",
      "app.post('/api/payroll-runs', requirePermission('gl-payroll-post')",
      "app.post(\n    '/api/payroll-runs/draft',\n    requirePermissionAny('hr-employee-manage', 'gl-payroll-manage')",
      "app.post('/api/payroll-runs/:id/approve', requirePermission('gl-payroll-post')",
      "app.post('/api/payroll-runs/:id/post', requirePermission('gl-payroll-post')",
      "app.post('/api/payroll-runs/:id/pay', requirePermission('gl-payroll-post')",
      "requirePermissionAny('gl-view', 'hr-employee-manage', 'gl-payroll-manage')",
      "'/api/payroll-runs',\n    requirePermissionAny('gl-view', 'hr-employee-manage', 'gl-payroll-manage')",
      "'/api/payroll-runs/:id',\n    requirePermissionAny('gl-view', 'hr-employee-manage', 'gl-payroll-manage')",
      "const payrollOutputRead = requirePermissionAny(\n    'gl-view',\n    'hr-employee-manage',\n    'gl-payroll-manage'\n  )",
      "'/api/payroll-runs/:id/payslips', payrollOutputRead",
      "'/api/payroll-runs/:id/payslips/:employeeId/print',\n    payrollOutputRead",
      "'/api/payroll-runs/:id/register', payrollOutputRead",
      "app.get(\n    '/api/payroll-runs/:id/bank-file',\n    requirePermissionAny('hr-employee-manage', 'gl-payroll-manage')",
      "app.delete(\n    '/api/payroll-runs/:id',\n    requirePermissionAny('hr-employee-manage', 'gl-payroll-manage')",
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
      ['client/src/features/finance/SubledgersManagement.tsx', "isOperationAllowed('gl-subledger-manage'"],
      ['client/src/features/finance/BillTermsManagement.tsx', "isOperationAllowed('gl-bill-terms-manage'"],
      ['client/src/features/finance/CostCentersManagement.tsx', "isOperationAllowed('gl-dimension-manage'"],
      ['client/src/features/finance/NarrationTemplatesManagement.tsx', "isOperationAllowed('gl-dimension-manage'"],
      ['client/src/features/finance/DailyCashClose.tsx', "isOperationAllowed('gl-cash-close'"],
      ['client/src/features/finance/OpeningStockManager.tsx', "isOperationAllowed('opening-stock-edit'"],
      ['client/src/features/finance/VendorOpeningBalances.tsx', "isOperationAllowed('opening-stock-view'"],
      ['client/src/features/dashboard/Dashboard.tsx', "isOperationAllowed('assets-view'"],
      ['client/src/features/hr/Payroll.tsx', "isOperationAllowed('hr-employee-manage'"],
    ];
    for (const [path, gate] of screens) {
      assert.ok(source(path).includes(gate), `${path} is missing ${gate}`);
    }

    const tabs = source('client/src/routes/tabPermissions.ts');
    assert.ok(tabs.includes("'fixed-assets': 'assets-view'"), 'fixed-assets tab must read assets-view');
    assert.ok(tabs.includes("'depreciation-register': 'assets-view'"), 'depreciation tab must read assets-view');
    assert.ok(tabs.includes("'hr-payroll':"), 'the payroll tab must be declared in the tab table');

    const sidebar = source('client/src/components/layout/Sidebar.tsx');
    assert.ok(
      sidebar.includes("isOperationAllowed('assets-view', currentUser?.role)"),
      'the finance asset links must use assets-view'
    );
  });

  test('every matrix operation is named in the grouped permission UI', () => {
    const panel =
      source('client/src/features/settings/PermissionManagement.tsx') +
      source('client/src/features/settings/permissionGroups.ts');
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
