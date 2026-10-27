/**
 * AUD-3 — line quantities are clamped where they enter a line.
 *
 * Six change-handlers pad a serial-slot array up to the line quantity, and
 * five screens render `Array.from({ length: quantity })` of serial inputs; the
 * quantity itself was bounded only at the bottom (`Math.max(1, …)`), so a
 * nine-digit value typed into a quantity cell allocated that many objects on
 * the keystroke and froze the tab — a hang the operator cannot cancel.
 *
 * WHAT IS PINNED
 *   1. The clamp: unreadable input reads as 1 (never 0, never NaN, which would
 *      poison totals), fractions floor, and anything above the ceiling clamps
 *      to it — the clamped path itself.
 *   2. The ceiling is 1000 and a custom ceiling is honoured.
 *   3. Source guard — every affected screen imports the helper and applies it
 *      where a quantity enters the line, and the old bottom-only clamps are
 *      gone, so the pad and render loops stay bounded by construction.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_LINE_QUANTITY, clampLineQuantity } from '../client/src/utils/lineQuantity';

const read = (file: string) => fs.readFileSync(path.join(file), 'utf8');

describe('clampLineQuantity (AUD-3)', () => {
  test('unreadable input reads as 1, never 0 and never NaN', () => {
    for (const value of ['', '   ', 'abc', null, undefined, NaN, {}, []]) {
      const clamped = clampLineQuantity(value);
      assert.equal(clamped, 1, `${JSON.stringify(value)} should read as 1`);
      assert.ok(Number.isInteger(clamped), 'the clamped quantity is always an integer');
    }
  });

  test('zero and negative quantities clamp up to 1', () => {
    assert.equal(clampLineQuantity(0), 1);
    assert.equal(clampLineQuantity(-5), 1);
    assert.equal(clampLineQuantity('0'), 1);
    assert.equal(clampLineQuantity('-999'), 1);
  });

  test('a typed nine-digit quantity clamps to the ceiling instead of allocating', () => {
    assert.equal(clampLineQuantity(999_999_999), MAX_LINE_QUANTITY);
    assert.equal(clampLineQuantity('999999999'), MAX_LINE_QUANTITY);
    assert.equal(clampLineQuantity(Number.MAX_SAFE_INTEGER), MAX_LINE_QUANTITY);
    assert.equal(clampLineQuantity('1e21'), MAX_LINE_QUANTITY);
    // Infinity is not a finite quantity: it reads as 1, not as the ceiling.
    assert.equal(clampLineQuantity(Infinity), 1);
    assert.equal(clampLineQuantity(-Infinity), 1);
  });

  test('values inside the range pass through; fractions floor', () => {
    assert.equal(clampLineQuantity(1), 1);
    assert.equal(clampLineQuantity(250), 250);
    assert.equal(clampLineQuantity('1000'), MAX_LINE_QUANTITY);
    assert.equal(clampLineQuantity(3.7), 3);
    assert.equal(clampLineQuantity('2.9'), 2);
    assert.equal(clampLineQuantity(1000.9), MAX_LINE_QUANTITY);
  });

  test('the ceiling is 1000 and a custom ceiling is honoured', () => {
    assert.equal(MAX_LINE_QUANTITY, 1000);
    assert.equal(clampLineQuantity(1001, 1000), 1000);
    assert.equal(clampLineQuantity(50, 10), 10);
    assert.equal(clampLineQuantity(2, 10), 2);
  });
});

describe('AUD-3 clamp wiring (source guards)', () => {
  /** Each affected screen, its helper import depth, and its clamp call. */
  const screens: Array<{ file: string; importPath: string; clamps: RegExp[] }> = [
    {
      file: 'client/src/features/sales/SalesInvoices.tsx',
      importPath: '../../utils/lineQuantity',
      clamps: [/quantity: clampLineQuantity\(patch\.quantity\)/, /const qty = clampLineQuantity\(line\.quantity\)/],
    },
    {
      file: 'client/src/features/procurement/PurchaseInvoiceForm.tsx',
      importPath: '../../utils/lineQuantity',
      clamps: [/const qty = clampLineQuantity\(newQty\)/, /const qty = clampLineQuantity\(line\.quantity\)/],
    },
    {
      file: 'client/src/features/procurement/CreateShipmentForm.tsx',
      importPath: '../../utils/lineQuantity',
      clamps: [/const qty = clampLineQuantity\(newQty\)/],
    },
    {
      file: 'client/src/features/inventory/stockops/ProductSalePanel.tsx',
      importPath: '../../../utils/lineQuantity',
      clamps: [/updated\.quantity = clampLineQuantity\(updates\.quantity\)/],
    },
    {
      file: 'client/src/features/inventory/stockops/CreateTransferPanel.tsx',
      importPath: '../../../utils/lineQuantity',
      clamps: [/updated\.quantitySent = clampLineQuantity\(updates\.quantitySent\)/],
    },
    {
      file: 'client/src/features/inventory/stockops/CreatePulloutPanel.tsx',
      importPath: '../../../utils/lineQuantity',
      clamps: [/updated\.quantity = clampLineQuantity\(updates\.quantity\)/],
    },
    {
      file: 'client/src/features/inventory/stockops/LabelDamagePanel.tsx',
      importPath: '../../../utils/lineQuantity',
      clamps: [/updated\.quantity = clampLineQuantity\(updates\.quantity\)/, /quantity: clampLineQuantity\(e\.target\.value\)/],
    },
  ];

  for (const { file, importPath, clamps } of screens) {
    test(`${path.basename(file)} clamps at the parse site`, () => {
      const source = read(file);
      assert.match(source, new RegExp(`from '${importPath.replace(/[/.]/g, (m) => `\\${m}`)}'`));
      for (const clamp of clamps) assert.match(source, clamp);
    });
  }

  test('the bottom-only clamps that left the top open are gone', () => {
    assert.doesNotMatch(
      read('client/src/features/sales/SalesInvoices.tsx'),
      /Math\.max\(1, Number\(line\.quantity\) \|\| 1\)/
    );
    assert.doesNotMatch(
      read('client/src/features/procurement/PurchaseInvoiceForm.tsx'),
      /const qty = Math\.max\(1, newQty\)/
    );
    assert.doesNotMatch(
      read('client/src/features/procurement/CreateShipmentForm.tsx'),
      /const qty = Math\.max\(1, newQty\)/
    );
    assert.doesNotMatch(
      read('client/src/features/inventory/stockops/LabelDamagePanel.tsx'),
      /Math\.max\(1, Number\(e\.target\.value\) \|\| 1\)/
    );
  });
});
