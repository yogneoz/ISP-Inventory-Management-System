import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateFixedAssetValues } from '../client/src/utils/depreciation';

// ---------------------------------------------------------------------------
// Straight line
// ---------------------------------------------------------------------------
describe('calculateFixedAssetValues — straight line', () => {
  const asset = {
    acquisitionCost: 120000,
    acquisitionDateAD: '2025-01-01',
    asOfDateAD: '2026-01-01',
    depreciationMethod: 'STRAIGHT_LINE',
    depreciationRatePercent: 10,
  };

  it('accrues 12 months of straight-line depreciation', () => {
    const r = calculateFixedAssetValues(asset);
    // 120000 * 10% * 12/12 = 12000
    assert.equal(r.accumulatedDepreciation, 12000);
    assert.equal(r.netBookValue, 108000);
    assert.equal(r.annualDepreciation, 12000);
  });

  it('truncates partial months', () => {
    // 2025-01-15 → 2026-01-14 = 11 full months
    const r = calculateFixedAssetValues({ ...asset, acquisitionDateAD: '2025-01-15', asOfDateAD: '2026-01-14' });
    assert.equal(r.accumulatedDepreciation, 11000);
  });

  it('reports the same constant annual charge every year', () => {
    const year1 = calculateFixedAssetValues({ ...asset, asOfDateAD: '2026-01-01' });
    const year3 = calculateFixedAssetValues({ ...asset, asOfDateAD: '2028-01-01' });
    assert.equal(year1.annualDepreciation, year3.annualDepreciation);
  });
});

// ---------------------------------------------------------------------------
// Reducing balance (DB / WDV)
// ---------------------------------------------------------------------------
describe('calculateFixedAssetValues — reducing balance', () => {
  const asset = {
    acquisitionCost: 100000,
    acquisitionDateAD: '2025-01-01',
    asOfDateAD: '2026-01-01',
    depreciationMethod: 'DECLINING_BALANCE',
    depreciationRatePercent: 40,
  };

  it('compounds the balance: accumulated = cost × (1 − (1−r)^years)', () => {
    const r = calculateFixedAssetValues(asset);
    assert.ok(Math.abs(r.accumulatedDepreciation - 40000) < 1e-6);
    assert.ok(Math.abs(r.netBookValue - 60000) < 1e-6);
  });

  it('reports the CURRENT-year charge, not the first-year amount', () => {
    // Year 1 charge: 40000. Year 2 charge: 60000*40% = 24000.
    const year1 = calculateFixedAssetValues(asset);
    const year2 = calculateFixedAssetValues({ ...asset, asOfDateAD: '2027-01-01' });
    assert.ok(Math.abs(year1.annualDepreciation - 40000) < 1e-6);
    assert.ok(Math.abs(year2.annualDepreciation - 24000) < 1e-6);
    assert.ok(year2.annualDepreciation < year1.annualDepreciation);
  });

  it('ties annual charge to the accumulated delta over the last 12 months', () => {
    const at36 = calculateFixedAssetValues({ ...asset, asOfDateAD: '2028-01-01' });
    const at24 = calculateFixedAssetValues({ ...asset, asOfDateAD: '2027-01-01' });
    const yearCharge = at36.accumulatedDepreciation - at24.accumulatedDepreciation;
    assert.ok(Math.abs(at36.annualDepreciation - yearCharge) < 1e-6);
  });

  it('accepts WRITTEN_DOWN_VALUE and REDUCING_BALANCE aliases identically', () => {
    const wdv = calculateFixedAssetValues({ ...asset, depreciationMethod: 'WRITTEN_DOWN_VALUE' });
    const rb = calculateFixedAssetValues({ ...asset, depreciationMethod: 'REDUCING_BALANCE' });
    assert.equal(wdv.accumulatedDepreciation, rb.accumulatedDepreciation);
  });
});

// ---------------------------------------------------------------------------
// Caps and degenerate inputs
// ---------------------------------------------------------------------------
describe('calculateFixedAssetValues — caps and degenerate inputs', () => {
  it('never lets accumulated depreciation exceed the acquisition cost', () => {
    const r = calculateFixedAssetValues({
      acquisitionCost: 10000,
      acquisitionDateAD: '2000-01-01',
      asOfDateAD: '2030-01-01',
      depreciationMethod: 'STRAIGHT_LINE',
      depreciationRatePercent: 50,
    });
    assert.equal(r.accumulatedDepreciation, 10000);
    assert.equal(r.netBookValue, 0);
  });

  it('reducing balance approaches but never crosses zero NBV', () => {
    const r = calculateFixedAssetValues({
      acquisitionCost: 10000,
      acquisitionDateAD: '1990-01-01',
      asOfDateAD: '2030-01-01',
      depreciationMethod: 'WRITTEN_DOWN_VALUE',
      depreciationRatePercent: 40,
    });
    assert.ok(r.netBookValue >= 0);
    assert.ok(r.accumulatedDepreciation <= 10000);
  });

  it('keeps stored values verbatim when cost or rate is missing', () => {
    const r = calculateFixedAssetValues({
      accumulatedDepreciation: 750,
      netBookValue: 250,
      depreciationRatePercent: 15,
    });
    assert.equal(r.accumulatedDepreciation, 750);
    assert.equal(r.netBookValue, 250);
    assert.equal(r.annualDepreciation, 0);
  });

  it('treats zero/negative cost as non-depreciable', () => {
    const r = calculateFixedAssetValues({
      acquisitionCost: -5,
      depreciationRatePercent: 15,
      accumulatedDepreciation: 3,
      netBookValue: 9,
    });
    assert.equal(r.acquisitionCost, 0);
    assert.equal(r.accumulatedDepreciation, 3);
    assert.equal(r.netBookValue, 9);
  });

  it('handles an as-of date before acquisition (zero elapsed)', () => {
    const r = calculateFixedAssetValues({
      acquisitionCost: 100000,
      acquisitionDateAD: '2026-06-01',
      asOfDateAD: '2026-01-01',
      depreciationMethod: 'DECLINING_BALANCE',
      depreciationRatePercent: 40,
    });
    assert.equal(r.accumulatedDepreciation, 0);
    assert.ok(Math.abs(r.netBookValue - 100000) < 1e-6);
  });
});
