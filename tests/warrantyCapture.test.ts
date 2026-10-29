/**
 * WTY-4 prefill rule — the dirty-date contract both capture screens share.
 *
 * The expiry is derived from the document date + the product's supplier term,
 * then it belongs to the operator. Re-deriving it after a date or product
 * change must never overwrite a typed contract date; a quantity change must
 * not touch it at all. These are pure functions, so the rule is pinned without
 * a browser and the invoice form and asset modal call the same code.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWarrantyPrefill,
  warrantyCoveredDefault,
  warrantyEndFieldError,
  warrantyEndFor,
} from '../client/src/utils/warrantyCapture';
import { resolveWarrantyCoverage } from '../shared/warrantyTerm';

describe('supplier warranty prefill', () => {
  test('12/0/24 months derive the exact expiry from the document date', () => {
    assert.equal(warrantyEndFor('2026-03-10', 12), '2027-03-10');
    assert.equal(warrantyEndFor('2026-03-10', 0), '', '0 months means no expiry');
    assert.equal(warrantyEndFor('2026-03-10', 24), '2028-03-10');
    assert.equal(warrantyEndFor('2026-03-10', undefined), '', 'an absent term suggests nothing');
  });

  test('a month-end start clamps to the target month last day', () => {
    assert.equal(warrantyEndFor('2026-01-31', 1), '2026-02-28');
    assert.equal(warrantyEndFor('2024-01-31', 1), '2024-02-29', 'a leap year keeps 29 Feb');
  });

  test('a changed document date re-derives only untouched drafts', () => {
    const drafts = [
      { key: 'untouched', warrantyEndDateAD: '2027-01-01', warrantyTouched: false },
      { key: 'typed', warrantyEndDateAD: '2029-12-31', warrantyTouched: true },
      { key: 'no-field' },
    ];
    const next = applyWarrantyPrefill(drafts, '2026-04-01', (draft) =>
      draft.key === 'typed' ? 6 : 12
    );
    assert.equal(next[0].warrantyEndDateAD, '2027-04-01', 'an untouched expiry follows the date');
    assert.equal(next[1].warrantyEndDateAD, '2029-12-31', 'a typed expiry is never clobbered');
    assert.equal('warrantyEndDateAD' in next[2], false, 'a quantity-only draft gains no field');
  });

  test('a 0-month product clears an untouched prefill', () => {
    const next = applyWarrantyPrefill(
      [{ warrantyEndDateAD: '2027-01-01', warrantyTouched: false }],
      '2026-04-01',
      () => 0
    );
    assert.equal(next[0].warrantyEndDateAD, '', 'no warranty means no prefilled date');
  });

  test('the capture field refuses a reversed or malformed date but allows empty', () => {
    assert.equal(warrantyEndFieldError('2026-04-01', ''), null);
    assert.equal(warrantyEndFieldError('2026-04-01', '2027-04-01'), null);
    assert.equal(warrantyEndFieldError('2026-04-01', '2026-04-01'), null, 'same-day is a valid term');
    assert.match(String(warrantyEndFieldError('2026-04-01', '2026-03-31')), /cannot be before the purchase date/);
    assert.match(String(warrantyEndFieldError('2026-04-01', '31/03/2026')), /real calendar date/);
    assert.match(
      String(warrantyEndFieldError('', '2027-04-01', 'Supplier warranty expiry')),
      /needs a valid purchase date first/
    );
  });
});

describe('explicit coverage switch (WTY-5)', () => {
  test('covered off writes no row and needs no date', () => {
    assert.equal(warrantyEndFieldError('2026-04-01', '', 'Seller warranty expiry', false), null);
    const resolved = resolveWarrantyCoverage({
      covered: false,
      endDateAD: '',
      startDateAD: '2026-04-01',
      termMonths: 12,
    });
    assert.equal(resolved.error, null);
    assert.equal(resolved.covered, false);
    assert.equal(resolved.endDateAD, null, 'off means no date and therefore no row');
  });

  test('covered on with a blank date is refused, not silently defaulted', () => {
    assert.match(
      String(warrantyEndFieldError('2026-04-01', '', 'Seller warranty expiry', true)),
      /required, or turn the warranty off/
    );
    const resolved = resolveWarrantyCoverage({
      covered: true,
      endDateAD: '',
      startDateAD: '2026-04-01',
      termMonths: 12,
    });
    assert.equal(resolved.covered, true);
    assert.equal(resolved.endDateAD, null);
    assert.match(String(resolved.error), /required, or turn the warranty off/);
  });

  test('covered on never derives silently: the screen must prefill or refuse', () => {
    const attempted = resolveWarrantyCoverage({
      covered: true,
      startDateAD: '2026-04-01',
      termMonths: 24,
    });
    assert.equal(attempted.endDateAD, null);
    assert.match(String(attempted.error), /required, or turn the warranty off/);
  });

  test('a legacy caller keeps the old blank-means-default behaviour', () => {
    const legacy = resolveWarrantyCoverage({ startDateAD: '2026-04-01', termMonths: 12 });
    assert.equal(legacy.covered, true);
    assert.equal(legacy.endDateAD, '2027-04-01');
    const zero = resolveWarrantyCoverage({ startDateAD: '2026-04-01', termMonths: 0 });
    assert.equal(zero.covered, false, 'a 0-month product carries no coverage');
  });

  test('a typed date on a 0-month product stores no misleading 0-month term', () => {
    const resolved = resolveWarrantyCoverage({
      covered: true,
      endDateAD: '2027-03-31',
      startDateAD: '2026-04-01',
      termMonths: 0,
    });
    assert.equal(resolved.endDateAD, '2027-03-31');
    assert.equal(resolved.termMonths, null, 'the catalog term does not describe a typed contract date');
  });

  test('the prefill never rewrites a draft whose coverage is switched off', () => {
    const next = applyWarrantyPrefill(
      [{ warrantyEndDateAD: '', warrantyTouched: false, warrantyCovered: false }],
      '2026-04-01',
      () => 12
    );
    assert.equal(next[0].warrantyEndDateAD, '', 'switched off stays empty');
  });

  test('a product with no seller term starts switched off', () => {
    assert.equal(warrantyCoveredDefault(0), false);
    assert.equal(warrantyCoveredDefault(undefined), false);
    assert.equal(warrantyCoveredDefault(24), true);
  });
});
