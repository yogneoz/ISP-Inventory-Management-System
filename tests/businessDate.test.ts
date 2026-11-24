/**
 * The business date is Kathmandu's calendar date, not UTC's.
 *
 * Nepal is UTC+05:45 with no daylight saving, so for the first 5 h 45 min of
 * every local day the UTC date is still yesterday. The pinned instants below
 * are chosen so that UTC and Kathmandu disagree: a date derived from
 * `Date.prototype.toISOString()` would name 2026-11-22 while the office is
 * already on 2026-11-23.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUSINESS_TIME_ZONE, addDaysAD, businessDateAD, businessTimeHHMM } from '../shared/businessDate';
import { todayAd } from '../shared/warrantyTerm';

const ROOT = path.resolve('.');
/** A reference implementation: shift the instant by the fixed +05:45 offset. */
function kathmanduByOffset(at: Date): string {
  return new Date(at.getTime() + 5.75 * 3_600_000).toISOString().slice(0, 10);
}
/** What the old code returned, kept here to show the two disagree. */
function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

describe('business date (Nepal)', () => {
  test('an instant that UTC calls yesterday is already today in Kathmandu', () => {
    // 2026-11-22T18:30:00Z = 2026-11-23 00:15 Kathmandu.
    const at = new Date('2026-11-22T18:30:00.000Z');
    assert.equal(utcDate(at), '2026-11-22', 'the UTC-derived date is the previous day');
    assert.equal(businessDateAD(at), '2026-11-23');
    assert.equal(businessDateAD(at), kathmanduByOffset(at));
  });

  test('the day flips at 18:15Z, not at midnight UTC', () => {
    // 18:14:59Z = 23:59:59 Kathmandu on the 22nd.
    assert.equal(businessDateAD(new Date('2026-11-22T18:14:59.000Z')), '2026-11-22');
    // 18:15:00Z = 00:00:00 Kathmandu on the 23rd.
    const flip = new Date('2026-11-22T18:15:00.000Z');
    assert.equal(businessDateAD(flip), '2026-11-23');
    assert.equal(utcDate(flip), '2026-11-22', 'UTC still says the 22nd at the local midnight');
  });

  test('a local New Year is dated in the new year, not the old one', () => {
    const at = new Date('2026-12-31T18:30:00.000Z'); // 2027-01-01 00:15 Kathmandu
    assert.equal(utcDate(at), '2026-12-31');
    assert.equal(businessDateAD(at), '2027-01-01');
  });

  test('matches fixed-offset arithmetic across two full days at 15-minute steps', () => {
    const start = Date.parse('2026-11-21T00:00:00.000Z');
    for (let step = 0; step < 2 * 24 * 4; step += 1) {
      const at = new Date(start + step * 15 * 60_000);
      assert.equal(
        businessDateAD(at),
        kathmanduByOffset(at),
        `disagreed at ${at.toISOString()}`
      );
    }
  });

  test('the shared warranty clock uses it, so a term starts on the local day', () => {
    assert.equal(BUSINESS_TIME_ZONE, 'Asia/Kathmandu');
    const at = new Date('2026-11-22T18:30:00.000Z');
    assert.equal(todayAd(at), '2026-11-23');
  });

  test('the shared test fixture asks for the same day the server does', () => {
    // Suites date their writes with this, so a UTC-based fixture clock made them
    // assert against yesterday's AD day while the server stamped today's.
    const fixture = fs.readFileSync(
      path.join(ROOT, 'tests/fixtures/referenceData.ts'),
      'utf8'
    );
    assert.match(fixture, /return businessDateAD\(\);/);
    assert.doesNotMatch(fixture, /new Date\(\)\.toISOString\(\)/);
    assert.equal(todayAd(), businessDateAD());
  });

  test('the punch clock reads the office wall clock, not UTC', () => {
    // 18:30Z on the 22nd is 00:15 on the 23rd in Kathmandu.
    assert.equal(businessTimeHHMM(new Date('2026-11-22T18:30:00.000Z')), '00:15');
    assert.equal(businessTimeHHMM(new Date('2026-11-23T04:30:00.000Z')), '10:15');
    assert.throws(() => businessTimeHHMM(new Date(Number.NaN)), TypeError);
  });

  test('calendar-day arithmetic lands on a day, not on "now + n ms"', () => {
    assert.equal(addDaysAD('2026-11-23', 14), '2026-12-07');
    assert.equal(addDaysAD('2026-12-31', 1), '2027-01-01');
    assert.equal(addDaysAD('2026-03-01', -1), '2026-02-28');
    assert.throws(() => addDaysAD('23/11/2026', 1), TypeError);
  });

  test('no source composes a date from the bare clock', () => {
    // The codemod only replaced toISOString().slice(0, 10) / split('T')[0].
    // Every other way of turning the machine clock into a date is the same bug:
    // toLocaleDateString() formats the machine zone, the get* parts read it in
    // that zone, and Date.now() + n days is an instant, not a calendar day.
    const CLOCK_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
      { pattern: /\.toLocaleDateString\(/, why: 'toLocaleDateString formats the machine zone' },
      { pattern: /new Date\(\)\.get(?:UTC)?(?:FullYear|Month|Date)\(\)/, why: 'date parts read off the clock' },
      { pattern: /new Date\(\)\.toLocale(?:String|DateString)\(/, why: 'the clock rendered as a date string' },
      { pattern: /Date\.now\(\)[^\n;]*toISOString\(\)\.slice\(0,\s*10\)/, why: 'now + offset truncated to a date' },
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile() || !full.endsWith('.ts')) continue;
        const text = fs.readFileSync(full, 'utf8');
        for (const { pattern, why } of CLOCK_PATTERNS) {
          if (pattern.test(text)) offenders.push(`${path.relative(ROOT, full)}: ${why}`);
        }
      }
    };
    walk(path.join(ROOT, 'server', 'src'));
    walk(path.join(ROOT, 'shared'));
    assert.deepEqual(
      offenders,
      [],
      'use businessDateAD() / businessTimeHHMM() / addDaysAD() instead of the machine clock'
    );
  });

  test('the remaining clock-derived dates go through the shared helper', () => {
    const files = [
      'server/src/services/mobile.service.ts', // punch time, roster window
      'server/src/controllers/hrReports.controller.ts', // leave-balance year
      'server/src/controllers/hrRecruitment.controller.ts', // reference year
      'server/src/controllers/hrPerformance.controller.ts',
      'server/src/controllers/hrLifecycle.controller.ts',
      'server/src/controllers/warranty.controller.ts', // days remaining
      'server/src/controllers/misc.controller.ts', // approval posting date
      'server/src/controllers/procurement.controller.ts', // serial history date
      'server/src/models/sales.repo.ts', // transaction row date fallbacks
      'server/src/models/procurement.repo.ts',
      'server/src/services/serials.service.ts', // serial history dates
      'server/src/services/damage.service.ts',
    ];
    for (const file of files) {
      assert.match(
        fs.readFileSync(path.join(ROOT, file), 'utf8'),
        /businessDateAD|businessTimeHHMM|addDaysAD/,
        `${file} must use the shared business clock`
      );
    }
    const mobile = fs.readFileSync(path.join(ROOT, 'server/src/services/mobile.service.ts'), 'utf8');
    assert.match(mobile, /return businessTimeHHMM\(\);/);
    assert.match(mobile, /addDaysAD\(today, 14\)/);
  });

  test('no server or shared source derives "today" from toISOString again', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile() || !full.endsWith('.ts')) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (
          /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/.test(text) ||
          /new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/.test(text)
        ) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, 'server', 'src'));
    walk(path.join(ROOT, 'shared'));
    assert.deepEqual(
      offenders,
      [],
      'derive the business date from businessDateAD(), not the UTC clock'
    );
  });

  test('the accounting paths that post by default date use the shared helper', () => {
    const files = [
      'server/src/controllers/inventory.controller.ts', // reversals, audits, damages
      'server/src/controllers/sales.controller.ts', // cancels, returns, payments
      'server/src/controllers/procurement.controller.ts',
      'server/src/controllers/shipments.controller.ts',
      'server/src/controllers/warranty.controller.ts',
      'server/src/services/bankReconciliation.service.ts',
      'server/src/services/cashClose.service.ts',
      'server/src/services/paymentSettlement.service.ts',
      'server/src/boot/logPartitions.ts',
    ];
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.match(text, /businessDateAD/, `${file} must use the shared business date`);
    }
    const cashClose = fs.readFileSync(
      path.join(ROOT, 'server/src/services/cashClose.service.ts'),
      'utf8'
    );
    assert.doesNotMatch(
      cashClose,
      /getFullYear\(\)/,
      'the daily close must not compose its own local date'
    );
  });
});
