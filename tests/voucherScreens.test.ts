/**
 * Voucher screen separation and searchable-picker guard.
 *
 * The journal and cash/bank entry forms are posting surfaces; the posted
 * voucher register is a read surface with its own navigation. This pins the
 * split, the operation that hides each screen, and the bounded server lookups
 * that replace the old whole-chart / whole-employee dropdown loads.
 *
 * Source pins are deliberate: the API suites exercise the routes against
 * PostgreSQL, while this guard fails fast if a later edit folds the register
 * back into the form or reintroduces a native dropdown.
 */
import { describe, test } from 'node:test';
import { readScreenRoutes } from './harness/screenRouteSource';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isTabAccessible } from '../client/src/routes/tabPermissions';

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), 'utf8');

const ENTRY_PATH = 'client/src/features/finance/VoucherEntries.tsx';
const REGISTER_PATH = 'client/src/features/finance/PostedVouchers.tsx';

describe('voucher entry and posted-voucher screens', () => {
  test('entry screens require the posting operation; the register requires ledger read', () => {
    const tabs = source('client/src/routes/tabPermissions.ts');
    assert.ok(tabs.includes("'journal-entry': 'gl-post'"), 'Journal Entry must require gl-post');
    assert.ok(tabs.includes("'cash-bank-entry': 'gl-post'"), 'Cash & Bank Entry must require gl-post');
    assert.ok(tabs.includes("'posted-vouchers': 'gl-view'"), 'Posted Vouchers must require gl-view');
    for (const [tab, operation] of [
      ['accounting-chart', 'gl-chart-manage'],
      ['subledgers', 'gl-subledger-manage'],
      ['bill-terms', 'gl-bill-terms-manage'],
      ['cost-centers', 'gl-dimension-manage'],
      ['narration-templates', 'gl-dimension-manage'],
    ]) {
      assert.ok(
        tabs.includes(`'${tab}': '${operation}'`),
        `${tab} must be hidden unless the account can operate it (${operation})`
      );
    }

    // The guard is behaviour, not just a table: an auditor can read the ledger
    // and open Posted Vouchers, but cannot open the posting form or the chart
    // maintenance screen. An accountant can do all three.
    const auditor = { role: 'AUDITOR' } as any;
    const accountant = { role: 'ACCOUNTANT' } as any;
    assert.equal(isTabAccessible('journal-entry', auditor), false);
    assert.equal(isTabAccessible('cash-bank-entry', auditor), false);
    assert.equal(isTabAccessible('posted-vouchers', auditor), true);
    assert.equal(isTabAccessible('accounting-chart', auditor), false);
    assert.equal(isTabAccessible('journal-entry', accountant), true);
    assert.equal(isTabAccessible('cash-bank-entry', accountant), true);
    assert.equal(isTabAccessible('posted-vouchers', accountant), true);
    assert.equal(isTabAccessible('accounting-chart', accountant), true);
  });

  test('the sidebar hides each screen behind the operation it needs', () => {
    const sidebar = source('client/src/components/layout/Sidebar.tsx');
    assert.match(
      sidebar,
      /isOperationAllowed\('gl-post'[\s\S]{0,400}'journal-entry'[\s\S]{0,400}'cash-bank-entry'/,
      'entry forms must only appear under gl-post'
    );
    assert.match(
      sidebar,
      /isOperationAllowed\('gl-view'[\s\S]{0,400}'posted-vouchers'/,
      'Posted Vouchers must appear under gl-view'
    );
    for (const operation of [
      'gl-chart-manage',
      'gl-subledger-manage',
      'gl-bill-terms-manage',
      'gl-dimension-manage',
    ]) {
      assert.ok(
        sidebar.includes(`isOperationAllowed('${operation}'`),
        `the accounting masters sidebar must use ${operation}`
      );
    }
  });

  test('the posted-voucher list lives only on its own routed screen', () => {
    const entry = source(ENTRY_PATH);
    assert.doesNotMatch(entry, /Posted vouchers/i, 'the entry form still embeds the register');
    assert.doesNotMatch(entry, /getAccountingJournals/, 'the entry form still reads the register');
    assert.doesNotMatch(entry, /reverseAccountingJournal/, 'the entry form still reverses vouchers');
    assert.doesNotMatch(entry, /VoucherDetailDialog/, 'the entry form still owns the detail dialog');

    const register = source(REGISTER_PATH);
    assert.match(register, /getAccountingJournals/);
    assert.match(register, /reverseAccountingJournal/);
    assert.match(register, /VoucherDetailDialog/);
    assert.match(register, /isOperationAllowed\('gl-reverse'/);

    // A4 moved the entries into the route table module.
    assert.match(readScreenRoutes(), /screenRoute\('posted-vouchers'/);
    assert.match(
      source('client/src/routes/appPaths.ts'),
      /'posted-vouchers': '\/finance\/accounting\/posted-vouchers'/
    );
    assert.match(
      source('client/src/screenPreload.ts'),
      /'posted-vouchers': \(\) => import\('\.\/features\/finance\/PostedVouchers'\)/
    );
    assert.ok(
      source('client/src/components/layout/Sidebar.tsx').includes("'posted-vouchers'"),
      'the sidebar has no Posted Vouchers entry'
    );
  });

  test('every directory field on the voucher screens is a search box', () => {
    const entry = source(ENTRY_PATH);
    const register = source(REGISTER_PATH);
    assert.doesNotMatch(entry, /<select\b/, 'a native select remains in the entry form');
    assert.doesNotMatch(register, /<select\b/, 'a native select remains in the register');
    assert.match(entry, /<SearchSelect/, 'the entry form must use the shared searchable select');
    assert.match(entry, /<SearchPicker<AccountingAccount>/, 'ledgers must be searched on the server');
    assert.match(entry, /search=\{api\.searchAccountingAccounts\}/);
    assert.match(entry, /<CustomerPicker/, 'customer parties must keep the shared picker');
    assert.match(entry, /searchEmployees/, 'employee parties must use a search box');
    assert.match(register, /<SearchSelect/, 'the register branch filter must be searchable');
    assert.match(
      source('client/src/components/common/SearchSelect.tsx'),
      /<SearchPicker/,
      'SearchSelect must reuse the shared picker mechanics'
    );
  });

  test('the server offers bounded account and employee lookups', () => {
    const routes = source('server/src/routes/accounting.routes.ts');
    assert.match(
      routes,
      /'\/api\/accounting\/accounts\/search'[\s\S]{0,200}requirePermissionAny\('gl-view', 'gl-post'\)/,
      'the account search route must accept a ledger reader or a voucher poster'
    );
    const payrollRoutes = source('server/src/routes/payroll.routes.ts');
    assert.match(
      payrollRoutes,
      /app\.get\('\/api\/employees\/search', requirePermissionAny\('gl-view', 'gl-post'\)/,
      'the slim employee picker must accept a voucher poster as well as a ledger reader'
    );
    // The employee master moved behind the HR gates: reading it is
    // hr-employee-view (or the legacy payroll grant), not a ledger grant, and
    // the slim picker above is what a voucher poster needs.
    assert.match(
      payrollRoutes,
      /app\.get\('\/api\/employees', requirePermissionAny\('hr-employee-view', 'gl-payroll-manage'\)/,
      'the employee master must stay behind the HR read gate'
    );
    assert.match(
      payrollRoutes,
      /app\.get\('\/api\/employees\/:id\/ledger', requirePermission\('gl-view'\)/,
      'the employee ledger must stay a full gl-view read'
    );

    const accountingRepo = source('server/src/models/accounting.repo.ts');
    assert.match(accountingRepo, /export function buildAccountSearchQuery/);
    assert.match(accountingRepo, /const limit = Math\.min\(50,/, 'the account lookup must clamp its page size');
    assert.match(accountingRepo, /LIMIT \$\{limit\}/, 'the account lookup must limit in SQL');

    const payrollRepo = source('server/src/models/payroll.repo.ts');
    assert.match(payrollRepo, /limit\?: number \| null/, 'employee search must accept a limit');
    assert.match(payrollRepo, /const limit = Math\.min\(/, 'employee search must clamp its page size');
    assert.match(payrollRepo, /EMPLOYEE_PICKER_MAX = 50/, 'the employee picker must cap its page at 50');
    assert.match(
      payrollRepo,
      /Number\(opts\.limit\) \|\| 20/,
      'the employee picker must default to 20 rows'
    );
    const pickerColumns =
      payrollRepo.match(/export const EMPLOYEE_PICKER_COLUMNS = `([\s\S]*?)`;/)?.[1] || '';
    assert.ok(pickerColumns.includes('employee_code'), 'the picker must select the employee code');
    assert.doesNotMatch(
      pickerColumns,
      /pan_number|ssf_number|bank_account/,
      'the picker projection must not expose payroll identifiers or bank details'
    );

    const api = source('client/src/services/api/accounting.ts');
    assert.match(api, /export async function searchAccountingAccounts/);
    assert.match(api, /params\.set\('query', query\.trim\(\)\)/, 'employee search must send the query');
    assert.match(api, /params\.set\('limit', String\(limit\)\)/, 'employee search must send the limit');
    assert.match(api, /\/api\/employees\/search/, 'the voucher picker must call the slim endpoint');
  });
});
