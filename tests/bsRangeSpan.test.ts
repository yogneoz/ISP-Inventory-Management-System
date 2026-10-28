/**
 * AUD-5: the BS range conversion is bounded by construction.
 *
 * The tool walks every day between two operator-supplied AD dates and converts
 * each one. The default is one fiscal year, but nothing capped the span: a
 * multi-decade range ground the screen through tens of thousands of
 * conversions. `bsRangeSpanRefusal` now refuses the range before the loop
 * starts, and the last block pins that the screen calls it there — a helper
 * nobody calls would not bound anything.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  MAX_BS_RANGE_DAYS,
  adRangeDayCount,
  bsRangeSpanRefusal,
} from '../client/src/utils/bsRangeSpan';

const read = (relativePath: string): string => fs.readFileSync(path.resolve(relativePath), 'utf8');

describe('adRangeDayCount', () => {
  test('counts both endpoints (a single day is one day)', () => {
    assert.equal(adRangeDayCount('2025-04-14', '2025-04-14'), 1);
  });

  test('counts a fiscal year as 365 days', () => {
    assert.equal(adRangeDayCount('2025-04-14', '2026-04-13'), 365);
  });

  test('includes leap day and is not thrown off by a DST boundary', () => {
    assert.equal(adRangeDayCount('2024-02-28', '2024-03-01'), 3);
    // A US DST change falls inside this span; UTC day normalisation keeps it 32.
    assert.equal(adRangeDayCount('2025-03-01', '2025-04-01'), 32);
  });

  test('returns null for unparseable dates instead of NaN', () => {
    assert.equal(adRangeDayCount('', '2025-04-14'), null);
    assert.equal(adRangeDayCount('2025-04-14', 'not-a-date'), null);
  });

  test('a reversed range returns a value below 1 (the caller owns that message)', () => {
    assert.ok((adRangeDayCount('2025-01-10', '2025-01-01') ?? 0) < 1);
  });
});

describe('bsRangeSpanRefusal', () => {
  test('accepts a one-year range and a range exactly at the cap', () => {
    assert.equal(bsRangeSpanRefusal('2025-04-14', '2026-04-13'), null);
    assert.equal(bsRangeSpanRefusal('2025-01-01', '2025-01-10', 10), null);
  });

  test('refuses one day past the cap and names both numbers', () => {
    const message = bsRangeSpanRefusal('2025-01-01', '2025-01-11', 10);
    assert.ok(message, 'an 11-day range must be refused when the cap is 10');
    assert.match(message!, /spans 11 days/);
    assert.match(message!, /at most 10 days/);
  });

  test('the default cap is far above a real conversion but bounded', () => {
    assert.equal(MAX_BS_RANGE_DAYS, 3660);
    const message = bsRangeSpanRefusal('2000-01-01', '2025-12-31');
    assert.ok(message, 'a quarter-century range must be refused');
    assert.match(message!, /at most 3660 days \(about ten years\)/);
    assert.equal(bsRangeSpanRefusal('2016-01-01', '2025-12-31'), null);
  });

  test('invalid and reversed ranges are left to the caller, not refused twice', () => {
    assert.equal(bsRangeSpanRefusal('', '2025-04-14'), null);
    assert.equal(bsRangeSpanRefusal('2025-01-10', '2025-01-01'), null);
  });
});

describe('the conversion screen checks the span before its day loop', () => {
  test('NepaliFiscalManagement imports the rule and calls it ahead of the while loop', () => {
    const source = read('client/src/features/finance/NepaliFiscalManagement.tsx');

    assert.match(
      source,
      /import\s*\{\s*bsRangeSpanRefusal\s*\}\s*from\s*'[^']*utils\/bsRangeSpan'/,
      'the screen must use the shared span rule'
    );

    const callIndex = source.indexOf('bsRangeSpanRefusal(rangeStartDateAD, rangeEndDateAD)');
    const loopIndex = source.indexOf('while (current <= end)');
    assert.ok(callIndex > -1, 'the conversion handler must call the span rule');
    assert.ok(loopIndex > -1, 'the day loop is expected to still exist');
    assert.ok(
      callIndex < loopIndex,
      'the span must be checked before the loop starts, not inside it'
    );
  });
});
