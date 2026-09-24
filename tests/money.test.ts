import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  num,
  roundMoney,
  clamp,
  computeOperationTotalValue,
  computeLegacyOperationTotalValue,
  computeBillTotals,
} from '../server/src/utils/money';

describe('money helpers (C1 server-side recompute)', () => {
  describe('num', () => {
    test('parses numeric strings and passes numbers through', () => {
      assert.equal(num('12.5'), 12.5);
      assert.equal(num(7), 7);
      assert.equal(num(0), 0);
    });
    test('falls back for NaN/undefined/null/Infinity', () => {
      assert.equal(num('abc'), 0);
      assert.equal(num(undefined), 0);
      assert.equal(num(null), 0);
      assert.equal(num(Infinity), 0);
      assert.equal(num('abc', 5), 5);
    });
  });

  test('roundMoney rounds to 2 decimals with float-noise safety', () => {
    assert.equal(roundMoney(0.1 + 0.2), 0.3);
    assert.equal(roundMoney(1.005), 1.01);
    assert.equal(roundMoney(1234.5666), 1234.57);
  });

  test('clamp bounds both sides', () => {
    assert.equal(clamp(-5, 0, 100), 0);
    assert.equal(clamp(150, 0, 100), 100);
    assert.equal(clamp(42, 0, 100), 42);
  });

  describe('computeOperationTotalValue', () => {
    test('sums |quantity| × resolved unit cost, ignoring client totalValue', () => {
      const total = computeOperationTotalValue(
        [
          { productId: 'p1', quantity: 2, unitCost: 100, totalValue: 999999 },
          { productId: 'p2', quantity: 3, unitCost: 50.5 },
        ],
        (item) => item.unitCost
      );
      assert.equal(total, 2 * 100 + 3 * 50.5);
    });

    test('resolver chain mirrors the ledger: item → costPerUnit → op costPerUnit → product costPrice', () => {
      const items = [
        { productId: 'p1', quantity: 1 },                                  // falls to req costPerUnit
        { productId: 'p2', quantity: 1, costPerUnit: 20 },                 // falls to req costPerUnit
        { productId: 'p3', quantity: 1, unitCost: 30 },                    // item wins
      ];
      const resolve = (item: any) => Number(item.unitCost ?? item.costPerUnit ?? 10) || 99;
      assert.equal(computeOperationTotalValue(items, resolve), 10 + 20 + 30);
    });

    test('uses absolute quantities and treats missing costs as zero', () => {
      const total = computeOperationTotalValue(
        [{ productId: 'p1', quantity: -4 }, { productId: 'p2', quantity: 2 }],
        () => 0
      );
      assert.equal(total, 0);
    });

    test('empty items produce 0', () => {
      assert.equal(computeOperationTotalValue([], () => 5), 0);
    });
  });

  test('computeLegacyOperationTotalValue uses |quantityChanged| × costPerUnit', () => {
    assert.equal(computeLegacyOperationTotalValue(-5, 120), 600);
    assert.equal(computeLegacyOperationTotalValue('5', '120'), 600);
    assert.equal(computeLegacyOperationTotalValue(undefined, 120), 0);
  });

  describe('computeBillTotals', () => {
    const taxableLine = { productId: 'p1', quantity: 10, unitPrice: 100, taxRate: 13 };

    test('fully taxable, no discount: net/taxable/grand match client math', () => {
      const t = computeBillTotals([taxableLine]);
      assert.equal(t.grossSubtotal, 1000);
      assert.equal(t.discount, 0);
      assert.equal(t.netSubtotal, 1000);
      assert.equal(t.taxableAmount, 1000);
      assert.equal(t.nonTaxableAmount, 0);
      assert.equal(t.vatAmount, 130);
      assert.equal(t.grandTotal, 1130);
    });

    test('mixed taxable + exempt lines split net correctly', () => {
      const t = computeBillTotals([
        { quantity: 10, unitPrice: 100, taxRate: 13 },
        { quantity: 4, unitPrice: 50, taxRate: 0 },
      ]);
      assert.equal(t.taxableAmount, 1000);
      assert.equal(t.nonTaxableAmount, 200);
      assert.equal(t.vatAmount, 130);
      assert.equal(t.grandTotal, 1330);
    });

    test('isTaxExempt flag (no taxRate) marks the line exempt', () => {
      const t = computeBillTotals([{ quantity: 1, unitPrice: 500, isTaxExempt: true }]);
      assert.equal(t.taxableAmount, 0);
      assert.equal(t.nonTaxableAmount, 500);
      assert.equal(t.vatAmount, 0);
      assert.equal(t.grandTotal, 500);
    });

    test('bill-level discount is clamped to [0, gross] and allocated proportionally', () => {
      const t = computeBillTotals([taxableLine], 1500); // exceeds gross → clamped to 1000
      assert.equal(t.discount, 1000);
      assert.equal(t.netSubtotal, 0);
      assert.equal(t.vatAmount, 0);
      assert.equal(t.grandTotal, 0);

      const t2 = computeBillTotals(
        [
          { quantity: 1, unitPrice: 300, taxRate: 13 },
          { quantity: 1, unitPrice: 100, taxRate: 0 },
        ],
        200
      );
      // proportional allocation: 300/400 × 200 = 150 and 100/400 × 200 = 50
      assert.equal(t2.taxableAmount, 150);
      assert.equal(t2.nonTaxableAmount, 50);
      assert.equal(roundMoney(t2.vatAmount), roundMoney(150 * 0.13));
      assert.equal(t2.grandTotal, roundMoney(200 + (150 * 13) / 100));
    });

    test('negative bill discount is clamped to 0', () => {
      const t = computeBillTotals([taxableLine], -50);
      assert.equal(t.discount, 0);
      assert.equal(t.grandTotal, 1130);
    });

    test('per-line discounts are clamped to each line gross and summed', () => {
      const t = computeBillTotals([
        { quantity: 1, unitPrice: 100, discount: 40, taxRate: 13 },
        { quantity: 1, unitPrice: 50, discount: 80, taxRate: 0 }, // clamped to 50
      ]);
      assert.equal(t.discount, 90);
      assert.equal(t.netSubtotal, 60);
      assert.equal(t.taxableAmount, 60);
      assert.equal(t.vatAmount, roundMoney(60 * 0.13));
      assert.equal(t.grandTotal, roundMoney(60 * 1.13));
    });

    test('ignores client-supplied per-line subtotal/taxAmount aggregates', () => {
      const t = computeBillTotals([
        { quantity: 2, unitPrice: 100, taxRate: 13, subtotal: 99999, taxAmount: 99999, total: 99999 },
      ]);
      assert.equal(t.netSubtotal, 200);
      assert.equal(t.vatAmount, 26);
      assert.equal(t.grandTotal, 226);
    });

    test('degenerate/missing inputs produce zeros, not NaN', () => {
      const t = computeBillTotals([]);
      assert.equal(t.grossSubtotal, 0);
      assert.equal(t.grandTotal, 0);
      const bad = computeBillTotals([{ quantity: 'x', unitPrice: undefined }]);
      assert.equal(bad.grandTotal, 0);
      assert.ok(Number.isFinite(bad.vatAmount));
    });

    test('a taxable line without explicit taxRate defaults to 13%', () => {
      const t = computeBillTotals([{ quantity: 1, unitPrice: 100 }]);
      assert.equal(t.vatAmount, 13);
    });
  });
});
