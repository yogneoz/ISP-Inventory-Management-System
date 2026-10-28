/**
 * WTY-1 — the one warranty date rule.
 *
 * A coverage stores an exact expiry date; the term is only the snapshot that
 * produced it. The browser prefill and the server capture must therefore agree
 * on calendar-month arithmetic, including the month-end clamp (31 Jan + 1
 * month is 28/29 Feb, never 3 March). These cases pin that rule and the
 * 30-day status boundary the two registers filter on.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WARRANTY_MONTHS,
  MAX_WARRANTY_MONTHS,
  addCalendarMonths,
  defaultWarrantyEnd,
  isAdDate,
  isValidWarrantyRange,
  warrantyDaysRemaining,
  warrantyStateFor,
  warrantyStatusLabel,
} from '../shared/warrantyTerm';

describe('addCalendarMonths', () => {
  test('adds whole calendar months across a year boundary', () => {
    assert.equal(addCalendarMonths('2026-12-15', 1), '2027-01-15');
    assert.equal(addCalendarMonths('2026-01-15', 12), '2027-01-15');
  });

  test('clamps a month-end start to the target month last day', () => {
    assert.equal(addCalendarMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addCalendarMonths('2028-01-31', 1), '2028-02-29');
    assert.equal(addCalendarMonths('2026-08-31', 1), '2026-09-30');
  });

  test('zero months keeps the same day', () => {
    assert.equal(addCalendarMonths('2026-01-31', 0), '2026-01-31');
  });

  test('returns null for an impossible date or an out-of-range term', () => {
    assert.equal(addCalendarMonths('2026-02-30', 1), null);
    assert.equal(addCalendarMonths('2026-13-01', 1), null);
    assert.equal(addCalendarMonths('2026-01-31', 1.5), null);
    assert.equal(addCalendarMonths('2026-01-31', -1), null);
    assert.equal(addCalendarMonths('2026-01-31', MAX_WARRANTY_MONTHS + 1), null);
  });
});

describe('date and range validation', () => {
  test('accepts only real canonical AD dates', () => {
    assert.equal(isAdDate('2026-10-28'), true);
    assert.equal(isAdDate('2028-02-29'), true);
    assert.equal(isAdDate('2026-02-29'), false);
    assert.equal(isAdDate('2026-1-01'), false);
    assert.equal(isAdDate('28/10/2026'), false);
    assert.equal(isAdDate(''), false);
  });

  test('the expiry may equal the start but never precede it', () => {
    assert.equal(isValidWarrantyRange('2026-10-28', '2026-10-28'), true);
    assert.equal(isValidWarrantyRange('2026-10-28', '2026-10-27'), false);
    assert.equal(isValidWarrantyRange('not-a-date', '2026-10-28'), false);
  });

  test('the default prefill is the product term, and 0 has no expiry', () => {
    assert.equal(DEFAULT_WARRANTY_MONTHS, 12);
    assert.equal(defaultWarrantyEnd('2026-01-31'), '2027-01-31');
    assert.equal(defaultWarrantyEnd('2026-01-31', 0), '2026-01-31');
    assert.equal(defaultWarrantyEnd('2026-01-31', 24), '2028-01-31');
  });
});

describe('expiry state', () => {
  const today = '2026-10-28';

  test('whole-day counts are exact and invalid dates have none', () => {
    assert.equal(warrantyDaysRemaining('2026-11-27', today), 30);
    assert.equal(warrantyDaysRemaining('2026-10-28', today), 0);
    assert.equal(warrantyDaysRemaining('2026-10-27', today), -1);
    assert.equal(warrantyDaysRemaining('bad', today), null);
  });

  test('the 30-day boundary is the single status rule', () => {
    assert.equal(warrantyStateFor('2026-11-28', today), 'VALID');
    assert.equal(warrantyStateFor('2026-11-27', today), 'EXPIRING_SOON');
    assert.equal(warrantyStateFor('2026-10-28', today), 'EXPIRING_SOON');
    assert.equal(warrantyStateFor('2026-10-27', today), 'EXPIRED');
    assert.equal(warrantyStateFor('bad', today), 'EXPIRED');
  });

  test('labels name the remaining or elapsed days', () => {
    assert.match(warrantyStatusLabel('2026-10-27', today), /Expired \(1 day ago\)/);
    assert.match(warrantyStatusLabel('2026-10-28', today), /Expiring \(0 days left\)/);
    assert.match(warrantyStatusLabel('2026-11-28', today), /Valid \(31 days left\)/);
    assert.match(warrantyStatusLabel('bad', today), /No expiry recorded/);
  });
});
