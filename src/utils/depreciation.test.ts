import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateFixedAssetValues } from './depreciation.ts';

test('straight-line depreciation is zero on the acquisition date and accrues by months since purchase', () => {
  const purchasedToday = calculateFixedAssetValues({
    acquisitionCost: 100000,
    acquisitionDateAD: '2026-09-03',
    asOfDateAD: '2026-09-03',
    depreciationMethod: 'STRAIGHT_LINE',
    depreciationRatePercent: 15,
  });

  assert.equal(purchasedToday.accumulatedDepreciation, 0);
  assert.equal(purchasedToday.netBookValue, 100000);

  const afterOneYear = calculateFixedAssetValues({
    acquisitionCost: 100000,
    acquisitionDateAD: '2025-09-03',
    asOfDateAD: '2026-09-03',
    depreciationMethod: 'STRAIGHT_LINE',
    depreciationRatePercent: 15,
  });

  assert.equal(afterOneYear.accumulatedDepreciation, 15000);
  assert.equal(afterOneYear.netBookValue, 85000);
});

test('reducing balance uses the purchase date as the start point and does not create a false opening value', () => {
  const result = calculateFixedAssetValues({
    acquisitionCost: 100000,
    acquisitionDateAD: '2025-09-03',
    asOfDateAD: '2026-09-03',
    depreciationMethod: 'REDUCING_BALANCE',
    depreciationRatePercent: 15,
  });

  assert.ok(result.accumulatedDepreciation > 0);
  assert.ok(result.netBookValue < 100000);
  assert.ok(result.netBookValue > 0);
});
