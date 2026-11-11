/**
 * Annualised salary TDS (audit finding: monthly-progressive withholding).
 *
 * Two properties matter and are pinned here:
 *
 *   1. For a constant salary the withholding is UNCHANGED. Annualising scales
 *      both the income and every band by twelve, which is exactly linear, so no
 *      employee's regular pay moves when this ships.
 *   2. One-off earnings (incentive, arrears) are taxed at the MARGINAL annual
 *      rate they cause, not at the month's band as if they recurred. That is the
 *      case the old code got wrong: a bonus was extrapolated to twelve months.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateStatutory,
  annualiseSlabs,
  annualisedTds,
  progressiveTds,
  TDS_ANNUALISATION_MONTHS,
} from '../server/src/services/statutoryCalc.service';

const SLABS = [
  { lowerBound: 0, upperBound: 50000, ratePercent: 5 },
  { lowerBound: 50000, upperBound: 100000, ratePercent: 10 },
  { lowerBound: 100000, upperBound: null, ratePercent: 20 },
];

describe('annualised salary TDS', () => {
  describe('scaling', () => {
    test('annualiseSlabs multiplies every bound by twelve and keeps the open band open', () => {
      const annual = annualiseSlabs(SLABS);
      assert.deepEqual(annual.map((s) => s.lowerBound), [0, 600000, 1200000]);
      assert.deepEqual(annual.map((s) => s.upperBound), [600000, 1200000, null]);
      assert.deepEqual(annual.map((s) => s.ratePercent), [5, 10, 20]);
      assert.equal(TDS_ANNUALISATION_MONTHS, 12);
    });
  });

  describe('a constant salary keeps its withholding', () => {
    const taxableMonthly = 91866.67;

    test('annualised withholding equals the monthly-band liability', () => {
      const monthly = progressiveTds(taxableMonthly, SLABS).total;
      const annualised = annualisedTds({ monthlyTaxableRecurring: taxableMonthly, slabs: SLABS });
      assert.equal(monthly, 6686.67);
      assert.equal(annualised.monthlyTds, monthly);
      // 91,866.67 × 12 = 1,102,400.04: 30,000 in the 5% band, 50,240 in the 10%
      // band. (Twelve times the already-rounded monthly figure differs by 4p;
      // the annual number is computed from the unrounded base.)
      assert.equal(annualised.annualTds, 80240);
      assert.equal(annualised.oneOffTds, 0);
    });

    test('calculateStatutory with no one-off keeps the same monthly figure', () => {
      const result = calculateStatutory({
        monthlyGross: 97666.67,
        basicAmount: 58000,
        ssfEligible: true,
        employeeSsfPercent: 10,
        employerSsfPercent: 20,
        slabs: SLABS,
      });
      assert.equal(result.employeeSsf, 5800);
      assert.equal(result.employerSsf, 11600);
      assert.equal(result.taxableGross, 91866.67);
      assert.equal(result.monthlyTds, 6686.67);
      assert.equal(result.annualTds, 80240);
    });
  });

  describe('one-off earnings are taxed at the marginal annual rate', () => {
    test('a 7,500 bonus inside the 10% band adds exactly 750 of tax', () => {
      const result = annualisedTds({
        monthlyTaxableRecurring: 91866.67,
        oneOffTaxable: 7500,
        slabs: SLABS,
      });
      assert.equal(result.oneOffTds, 750);
      assert.equal(result.monthlyTds, 7436.67);
      assert.equal(result.annualTds, 80990);
      assert.equal(result.annualRecurringTds, 80240);
    });

    test('the month-carrying-bonus figure is not twelve times the bonus month', () => {
      // The old rule taxed 99,366.67 for the month and multiplied it by twelve,
      // which charges the bonus every month. The annual liability is 80,990.
      const result = annualisedTds({
        monthlyTaxableRecurring: 91866.67,
        oneOffTaxable: 7500,
        slabs: SLABS,
      });
      assert.notEqual(result.annualTds, result.monthlyTds * 12);
      assert.equal(result.annualTds, 80990);
    });

    test('a one-off that pushes into the next band is taxed at that band', () => {
      // Recurring taxable 91,866.67 annualises to 1,102,400.04 (already 10%).
      // Add 150,000: annual 1,252,400.04 crosses into the 20% band for 52,400.04.
      const result = annualisedTds({
        monthlyTaxableRecurring: 91866.67,
        oneOffTaxable: 150000,
        slabs: SLABS,
      });
      // Annual 1,252,400.04: 30,000 + 60,000 in the first two bands, then
      // 52,400.04 at 20% = 10,480.01 (total 100,480.01). The recurring salary
      // alone owed 80,240.00, so the bonus costs 20,240.01.
      assert.equal(result.oneOffTds, 20240.01);
      assert.equal(result.monthlyTds, 26926.68);
      assert.equal(result.annualTds, 100480.01);
    });

    test('one-off earnings cannot exceed the period gross', () => {
      const result = calculateStatutory({
        monthlyGross: 50000,
        oneOffEarnings: 90000,
        basicAmount: 30000,
        ssfEligible: false,
        employeeSsfPercent: 10,
        employerSsfPercent: 20,
        slabs: SLABS,
      });
      // Clamped to the 50,000 gross, so the recurring base is 0 and the whole
      // period is one-off income. It is not annualised (it happened once), so it
      // sits in the annual 5% band: 50,000 × 5% = 2,500.
      assert.equal(result.monthlyTds, 2500);
      assert.equal(result.annualTds, 2500);
    });
  });

  describe('degenerate input', () => {
    test('no income means no withholding', () => {
      const result = annualisedTds({ monthlyTaxableRecurring: 0, oneOffTaxable: 0, slabs: SLABS });
      assert.equal(result.monthlyTds, 0);
      assert.equal(result.annualTds, 0);
      assert.equal(result.oneOffTds, 0);
    });

    test('a negative or missing basis is treated as zero, never as a refund', () => {
      const result = annualisedTds({
        monthlyTaxableRecurring: -5000,
        oneOffTaxable: -100,
        slabs: SLABS,
      });
      assert.equal(result.monthlyTds, 0);
    });
  });
});
