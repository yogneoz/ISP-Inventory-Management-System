/**
 * TRIM-1 contract — source-level guards for the bounded global search.
 *
 * The HTTP suite proves the endpoint's scope and caps. This file proves the
 * client cannot quietly regress to the old shape (whole arrays as props and
 * `.filter()` in the browser) and that the SQL stays capped and index-backed,
 * which is what keeps the feature usable when the install grows to a nationwide
 * customer/device count.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('TRIM-1 global-search contract', () => {
  const modal = read('client/src/components/common/GlobalSearchModal.tsx');
  const shell = read('client/src/components/layout/AppShell.tsx');
  const repo = read('server/src/models/globalSearch.repo.ts');
  const schema = read('scripts/schema.sql');

  test('the modal fetches bounded results instead of receiving whole slices', () => {
    assert.match(modal, /api\s*\.\s*searchGlobal\(/, 'the modal must call the search endpoint');
    for (const prop of ['products', 'purchaseOrders', 'invoices', 'shipments', 'assets', 'customerDevices', 'stock']) {
      assert.doesNotMatch(
        modal,
        new RegExp(`\\b${prop}\\s*:\\s*[A-Z]`),
        `the modal must not declare a whole-slice prop named "${prop}"`
      );
    }
    assert.doesNotMatch(modal, /\.slice\(0, 5\)/, 'the server applies the per-group cap');
    assert.match(modal, /p\.stockQty/, 'product stock arrives with the result row');
  });

  test('the shell no longer feeds the growing registers to the modal', () => {
    const usage = shell.slice(shell.indexOf('<GlobalSearchModal'), shell.indexOf('/>', shell.indexOf('<GlobalSearchModal')));
    for (const prop of ['products=', 'purchaseOrders=', 'invoices=', 'shipments=', 'assets=', 'customerDevices=', 'stock=']) {
      assert.ok(!usage.includes(prop), `AppShell must not pass ${prop} to GlobalSearchModal`);
    }
    assert.match(usage, /suppliers=\{suppliers\}/, 'the small reference tables stay local');
    assert.match(usage, /branches=\{branches\}/);
  });

  test('a failed search is retryable, never rendered as “no results”', () => {
    assert.match(modal, /error \? \(/, 'error must be a distinct branch');
    assert.match(modal, /Retry search/);
    assert.match(modal, /loading && totalResultsCount === 0/);
  });

  test('every SQL group is capped and the wildcard input is escaped', () => {
    assert.equal((repo.match(/LIMIT \$4/g) || []).length, 6, 'all six groups carry the hard cap');
    assert.match(repo, /replace\(\/\[\\\\%_\]\/g/, 'LIKE metacharacters are escaped');
    assert.match(repo, /lower-cases/i, 'the pattern is lower-cased to match the indexes');
  });

  test('the four expression groups have trigram indexes in the schema', () => {
    for (const index of [
      'idx_products_global_trgm',
      'idx_assets_global_trgm',
      'idx_customer_devices_global_trgm',
      'idx_shipments_global_trgm',
    ]) {
      assert.ok(schema.includes(index), `scripts/schema.sql is missing ${index}`);
    }
    assert.match(schema, /gin_trgm_ops/, 'the indexes must be trigram GIN');
  });
});
