/**
 * DF-17 — the last three silent reads.
 *
 * 1. Cached-bootstrap settings backfill: a failed GET /api/settings was
 *    dropped, so the app ran on `{}` defaults (the company-wide blind count
 *    read as false) with nothing saying the configuration was unknown.
 * 2. Sellable-serial list: a failed read kept the previous branch's units, so
 *    the Sell-to-Customer form offered serials the server would refuse.
 * 3. Permission-save resync: a rejected save re-read the server matrix but
 *    swallowed a failure, leaving the rejected edits looking trustworthy.
 *
 * These are source pins: the first two live inside App's bootstrap/refresh
 * flow and the third inside a screen with dialog and dark-mode providers —
 * there is no route-tree harness (A6). Each pin names the behaviour the task's
 * acceptance criteria require.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8');
const count = (source: string, needle: string) => source.split(needle).length - 1;

describe('DF-17 — settings backfill failure is visible and retryable', () => {
  const app = read('client/src/App.tsx');

  test('the backfill reports its failure instead of swallowing it', () => {
    assert.ok(
      app.includes('const loadSettingsFromServer = async () => {'),
      'one loader owns the GET /api/settings backfill'
    );
    assert.match(
      app,
      /setSettingsBackfillError\(err\?\.message \|\| 'The company settings could not be read\.'\)/,
      'a failed settings read must be recorded, not dropped'
    );
    assert.ok(
      app.includes('void loadSettingsFromServer();'),
      'the cached-payload path must go through the reporting loader'
    );
    assert.doesNotMatch(
      app,
      /\.getSettings\(\)\s*\n?\s*\.then/,
      'the old fire-and-forget settings backfill must be gone'
    );
  });

  test('a settings-unknown notice with Retry is rendered, and the blind toggle cannot claim the default', () => {
    assert.match(app, /subject="company settings"/);
    assert.match(app, /error=\{settingsBackfillError\}/);
    assert.match(app, /onRetry=\{\(\) => void loadSettingsFromServer\(\)\}/);
    assert.ok(
      app.includes('settingsUnknown={Boolean(settingsBackfillError) || settingsBackfillLoading}'),
      'the audit screen must know the setting is unknown — failed OR not read yet'
    );

    const audit = read('client/src/features/inventory/PhysicalStockAudit.tsx');
    assert.ok(audit.includes('settingsUnknown = false'), 'the prop must default to known for other callers');
    assert.ok(audit.includes('disabled={settingsUnknown}'), 'the toggle must be disabled while unknown');
    assert.ok(
      audit.includes("settingsUnknown ? 'UNKNOWN'"),
      'the toggle must not present an unknown setting as OFF'
    );
  });
});

describe('DF-17 — sellable serials are branch-clean and retryable', () => {
  const app = read('client/src/App.tsx');
  const sales = read('client/src/features/sales/SalesInvoices.tsx');

  test('the list clears on a branch change and a failure is reported', () => {
    assert.ok(app.includes('const loadSellableSerials = async (branchId?: string) => {'));
    assert.match(
      app,
      /if \(sellableSerialsScopeRef\.current !== scope\) \{\s*\n\s*sellableSerialsScopeRef\.current = scope;\s*\n\s*setInventorySerials\(\[\]\);/,
      'the previous branch’s units must be dropped the moment the scope changes'
    );
    assert.match(
      app,
      /setSellableSerialsError\(err\?\.message \|\| 'The sellable serial list could not be read\.'\)/,
      'the failure must be surfaced'
    );
    assert.ok(
      app.includes('void loadSellableSerials(requestBranchId);'),
      'every refresh must go through the branch-aware loader'
    );
    assert.doesNotMatch(
      app,
      /console\.error\('Error fetching sellable serials:'/,
      'a console line is not a user-visible failure state'
    );
    assert.equal(
      count(app, 'inventorySerialsError={sellableSerialsError}'),
      2,
      'both SalesInvoices render sites (create-sale and sales-list) must receive the state'
    );
    // Close-out residual: the successful bootstrap path is not the only one
    // that must drop the old branch's rows. If the bootstrap itself fails after
    // a branch switch, the loader was never called and the previous branch's
    // units stayed in the form; the catch now re-reads the new scope through
    // the same clearing loader (never on a 401).
    assert.match(
      app,
      /const sellableScope =[\s\S]*?if \([\s\S]*?status !== 401 &&[\s\S]*?sellableSerialsScopeRef\.current !== null &&[\s\S]*?sellableSerialsScopeRef\.current !== sellableScope[\s\S]*?void loadSellableSerials\(requestBranchId\);/,
      'a failed bootstrap after a branch switch must still clear and re-read the sellable list'
    );
  });

  test('the sell-to-customer form shows the retryable notice and refuses to guess', () => {
    assert.ok(sales.includes('inventorySerialsError?: string;'));
    assert.ok(sales.includes('onRetryInventorySerials?: () => void;'));
    assert.match(sales, /subject="sellable serials"/);
    assert.match(sales, /error=\{inventorySerialsError\}/);
    assert.match(sales, /onRetry=\{\(\) => onRetryInventorySerials\?\.\(\)\}/);
    assert.match(
      sales,
      /if \(inventorySerialsError\) \{\s*\n\s*setFormError\('The sellable serial list could not be read — use Retry above before posting this invoice\.'\);/,
      'posting a serialized line must say the list is unavailable, not “not in inventory”'
    );
  });
});

describe('DF-17 — a failed permission resync disables Save until the matrix is known', () => {
  const source = read('client/src/features/settings/PermissionManagement.tsx');

  test('the rejected-save resync reports failure instead of swallowing it', () => {
    assert.ok(source.includes('const resyncMatrixFromServer = async () => {'));
    assert.match(
      source,
      /setMatrixResyncError\(err\?\.message \|\| 'The server permission matrix could not be read\.'\)/
    );
    assert.equal(
      count(source, 'void resyncMatrixFromServer();'),
      2,
      'both the save and reset failure paths must re-sync'
    );
    assert.doesNotMatch(
      source,
      /\.getPermissionsMatrix\(\)\s*\n?\s*\.then\(\(serverMatrix\) => applyServerMatrix\(serverMatrix\)\)/,
      'the old silent resync must be gone'
    );
  });

  test('Save and Reset stay disabled while the server matrix is unknown, with a Retry', () => {
    assert.ok(
      source.includes('const saveBlocked = isSaving || isResyncing || Boolean(matrixResyncError);'),
      'one flag must express the blocked state'
    );
    assert.equal(
      count(source, 'if (!isSuperAdmin || saveBlocked) return;'),
      2,
      'the save and reset handlers must both refuse while blocked'
    );
    assert.equal(
      count(source, 'disabled={!isSuperAdmin || saveBlocked}'),
      2,
      'both write buttons must be disabled while blocked'
    );
    assert.match(source, /subject="the server permission matrix"/);
    assert.match(source, /error=\{matrixResyncError\}/);
    assert.ok(
      source.includes('emptyNote=" Save stays disabled until the server matrix can be read."'),
      'the notice must explain why Save is unavailable'
    );
  });
});
