/**
 * Bill-term due-date arithmetic shared by the API and the invoice forms.
 * These are pure calendar checks: no database, no timezone, no form state.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysAD,
  computeDueDateAD,
  isValidADDate,
  MAX_BILL_TERM_DAYS,
} from '../shared/billTerms';

describe('bill-term due dates', () => {
  test('zero days means due on the invoice date', () => {
    assert.equal(computeDueDateAD('2026-11-04', 0), '2026-11-04');
  });

  test('adds whole days across a month boundary', () => {
    assert.equal(computeDueDateAD('2026-01-31', 1), '2026-02-01');
    assert.equal(computeDueDateAD('2026-01-15', 30), '2026-02-14');
  });

  test('adds days across a year boundary and leap day', () => {
    assert.equal(computeDueDateAD('2026-12-20', 30), '2027-01-19');
    assert.equal(computeDueDateAD('2024-02-28', 1), '2024-02-29');
  });

  test('rejects malformed and impossible dates', () => {
    assert.equal(computeDueDateAD('2026-02-30', 30), null);
    assert.equal(computeDueDateAD('04/11/2026', 30), null);
    assert.equal(computeDueDateAD('', 30), null);
    assert.equal(isValidADDate('2026-11-04'), true);
    assert.equal(isValidADDate('2026-13-01'), false);
  });

  test('rejects negative and absurd day counts', () => {
    assert.equal(addDaysAD('2026-11-04', -1), null);
    assert.equal(addDaysAD('2026-11-04', MAX_BILL_TERM_DAYS + 1), null);
  });
});
