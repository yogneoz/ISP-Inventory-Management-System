/**
 * U-2 wiring pins — the remaining all-customer and all-location <select>s are
 * gone, and the shared pickers own the interaction.
 *
 * These are source pins, not substitutes for the jsdom behaviour tests in
 * customerPicker.test.ts and locationPicker.test.ts: they prove the screens
 * actually wire the controls to the right source, which a component test
 * cannot see.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('U-2 — searchable directory pickers are wired in the forms', () => {
  test('CustomersManagement uses the customer search and keeps no full-array option list', () => {
    const source = read('client/src/features/sales/CustomersManagement.tsx');
    assert.match(source, /<CustomerPicker/);
    assert.match(source, /search=\{api\.searchCustomers\}/);
    assert.doesNotMatch(source, /\bcustomers\.map\(/, 'the 12k-row native option list must be gone');
    assert.doesNotMatch(source, /customers\?:/, 'the screen must not receive the full customer array');
  });

  test('ConsumableIssuePanel searches customers and locations inside its scrollable table', () => {
    const source = read('client/src/features/inventory/stockops/ConsumableIssuePanel.tsx');
    assert.match(source, /<CustomerPicker/);
    assert.match(source, /search=\{api\.searchCustomers\}/);
    assert.match(source, /<LocationPicker/);
    assert.match(source, /locations=\{locations\}/);
    assert.match(source, /\bportal\b/, 'the table needs the portal so the list is not clipped');
    assert.doesNotMatch(source, /\bcustomers\.map\(/);
    assert.doesNotMatch(source, /Select POP location/);
  });

  test('Assign Fixed Asset searches network locations instead of rendering every row', () => {
    const source = read('client/src/features/inventory/stockops/AssignAssetPanel.tsx');
    assert.match(source, /<LocationPicker/);
    assert.match(source, /locations=\{locations\}/);
    assert.doesNotMatch(source, /Select POP location/);
    assert.doesNotMatch(
      source,
      /locations\s*\n\s*\.filter\(\(l\) => l\.type === 'POP_SERVER_ROOM'/,
      'the per-row location option list must be gone'
    );
  });

  test('CustomerLedger supplies a searchable party control; LedgerView still renders the native one when none is given', () => {
    const ledger = read('client/src/features/finance/CustomerLedger.tsx');
    assert.match(ledger, /<CustomerPicker/);
    assert.match(ledger, /partySelector=\{/);
    assert.match(ledger, /search=\{api\.searchCustomers\}/);
    assert.doesNotMatch(ledger, /\bcustomers\.map\(/);

    const view = read('client/src/components/common/LedgerView.tsx');
    assert.match(view, /partySelector \?\? \(/, 'VendorLedger must keep the native select fallback');
    assert.match(view, /parties = \[\]/, 'the native select must tolerate an omitted list');
  });

  test('both wrappers delegate the interaction mechanics to SearchPicker', () => {
    for (const file of [
      'client/src/components/common/CustomerPicker.tsx',
      'client/src/components/common/LocationPicker.tsx',
    ]) {
      const source = read(file);
      assert.match(source, /from '\.\/SearchPicker'/, `${file} must reuse the shared core`);
      assert.doesNotMatch(source, /window\.setTimeout/, `${file} must not reimplement the debounce`);
      assert.doesNotMatch(source, /addEventListener\('mousedown'/, `${file} must not reimplement outside-click`);
    }
  });
});
