/**
 * The unseeded-date marker, the client/server day check, and provisional years.
 *
 * Three things this pins:
 *
 *  1. A date the calendar does not have is reported as such — every screen, and
 *     every BS column a resolver fills. `BS_DATE_FALLBACK = '2083-04-16 BS'` was
 *     a real (wrong) date for all but one day: it dated ledgers and audit rows to
 *     a day that had nothing to do with the operation and made an unseeded
 *     calendar look seeded. The server and the client now carry the same
 *     literal, and this test refuses a second (drifting) copy.
 *  2. The client's day check and the server's answer the same question. The
 *     server derives from bs_day_records; the client derives from the same year
 *     configuration the rows were expanded from, so for a given calendar the two
 *     agree on every day — including the days at the edges.
 *  3. Seeding a year the published patro does not cover is allowed but flagged:
 *     the start is derived from the previous seeded year's end + 1 (never the
 *     old `year - 57` guess) and the year is provisional until the patro
 *     confirms it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BS_NOT_SEEDED as SERVER_MARKER,
  isBsDateMissing,
  resolveBsDateForLedgerSync,
} from '../server/src/utils/bsDate';
import { buildBsDayRecordsForYear, DEFAULT_BS_YEARS_SERVER } from '../server/src/config/bsCalendar';
import {
  BS_NOT_SEEDED as CLIENT_MARKER,
  convertADToBS,
  ensureBSDayForAD,
  formatBSDate,
  formatDualDate,
  getBsCalendarCoverage,
  getProvisionalYears,
  hasExactBSDayRecord,
  resetBsCalendarData,
  seedBSYearCalendar,
} from '../client/src/utils/nepaliCalendar';
import { resolveSeedConfig, patroYears } from '../server/src/services/bsCalendarSeed.service';

const read = (relativePath: string): string => fs.readFileSync(path.resolve(relativePath), 'utf8');

describe('unseeded BS dates — explicit marker, never a fabricated date', () => {
  test('the server and the client carry the same literal', () => {
    assert.equal(SERVER_MARKER, 'BS not seeded');
    assert.equal(CLIENT_MARKER, SERVER_MARKER, 'the two copies of the marker literal must not drift');
  });

  test('the resolvers return the marker instead of a date', () => {
    // Far outside any seeded calendar: the in-memory cache cannot have it.
    assert.equal(resolveBsDateForLedgerSync('2099-01-01'), SERVER_MARKER);
    assert.equal(isBsDateMissing(SERVER_MARKER), true);
    assert.equal(isBsDateMissing(''), true);
    assert.equal(isBsDateMissing('2083-04-16 BS'), false);
  });

  test('the fictitious fallback is gone from the server tree', () => {
    const bsDate = read('server/src/utils/bsDate.ts');
    // The constant and every return of it must be gone. The docstring may still
    // NAME the old fallback (that is how a reader learns why it went away).
    assert.ok(!bsDate.includes('export const BS_DATE_FALLBACK'), 'the fallback constant must not come back');
    assert.ok(!/return\s+BS_DATE_FALLBACK/.test(bsDate), 'nothing may return the fallback');
    assert.ok(bsDate.includes('export const BS_NOT_SEEDED'), 'the marker must exist');
    assert.ok(
      /return record\?\.bsDate \? `\$\{record\.bsDate\} BS` : BS_NOT_SEEDED;/.test(bsDate),
      'the sync resolver must return the marker when the day is unseeded'
    );
  });

  test('client display shows the marker (and does not throw) for an unseeded day', () => {
    resetBsCalendarData();
    assert.equal(formatBSDate(CLIENT_MARKER), CLIENT_MARKER);
    const dual = formatDualDate('2099-01-01');
    assert.ok(dual.includes(CLIENT_MARKER), `expected the marker in "${dual}"`);
    assert.ok(dual.includes('2099-01-01'), 'the AD date is still shown');
    // The previous implementation threw here (convertADToBS throws outside the
    // mapped range), which took the whole screen down.
    assert.doesNotThrow(() => formatDualDate('2099-01-01'));
  });

  test('an AD value that is not a date gets the marker, not Shrawan 16, 2083', () => {
    resetBsCalendarData();
    // The second fabrication path, and the one that reached STORED columns:
    // convertADToBS returned a valid-looking "16 Shrawan 2083 BS" for anything
    // Date() could not parse, and CustomersManagement stores
    // convertADToBS(issuedDateAD).formattedBSShort as the device row's
    // issuedDateBS. An empty string is a cleared field, not "today".
    for (const bad of ['', 'not-a-date', '2026-13-45']) {
      const converted = convertADToBS(bad);
      assert.equal(converted.formattedBSShort, CLIENT_MARKER, `"${bad}" must not be dated`);
      assert.equal(converted.formattedBS, CLIENT_MARKER);
      assert.equal(converted.yearBS, 0, 'no caller may read the marker as a seeded year');
      assert.equal(converted.monthBS, 0);
      assert.equal(converted.dayBS, 0);
    }
    const source = read('client/src/utils/nepaliCalendar.ts');
    assert.ok(
      !source.includes("'2083-04-16 BS'"),
      'the fabricated fallback date must not come back into the client calendar utility'
    );
  });
});

describe('client and server agree about which days exist', () => {
  test('every sampled AD date resolves exactly when the server has a day record', () => {
    resetBsCalendarData();
    const serverDays = new Set(
      DEFAULT_BS_YEARS_SERVER.flatMap((year) =>
        buildBsDayRecordsForYear(year.yearBS, year.daysInMonths, year.startAD).map((record) => record.adDate)
      )
    );
    assert.ok(serverDays.size > 2000, 'the reference calendar must cover several years');

    const samples: string[] = [
      ...Array.from(serverDays).filter((_, index) => index % 97 === 0), // every ~3 months
      Array.from(serverDays)[0], // first day
      Array.from(serverDays)[serverDays.size - 1], // last day
      '2099-01-01', // far future
      '1990-01-01', // far past
      '2021-04-13', // the day BEFORE the calendar starts
      '2029-04-14', // the day AFTER it ends
    ];
    for (const adDate of samples) {
      assert.equal(
        hasExactBSDayRecord(adDate),
        serverDays.has(adDate),
        `${adDate}: client says ${hasExactBSDayRecord(adDate)}, the day table says ${serverDays.has(adDate)}`
      );
    }
    // Malformed input is refused rather than coerced.
    assert.equal(hasExactBSDayRecord('not-a-date'), false);
    assert.equal(hasExactBSDayRecord(''), false);
  });

  test('a form gate blocks exactly where the server would return 400', () => {
    resetBsCalendarData();
    assert.match(String(ensureBSDayForAD('2026-10-10')), /^\d{4}-\d{2}-\d{2} BS$/);
    assert.equal(ensureBSDayForAD('2099-01-01'), null, 'unseeded date: the caller must block');
    assert.equal(ensureBSDayForAD(''), null);
  });

  test('the docstring describes the check the function performs', () => {
    const source = read('client/src/utils/nepaliCalendar.ts');
    const body = /export function hasExactBSDayRecord[\s\S]*?\n}/.exec(source)?.[0] ?? '';
    assert.ok(body.includes('exactAdDateSet()'), 'the check must ask for an actual day record');
    assert.ok(!body.includes('setDate('), 'span arithmetic must not stand in for a day record');
    assert.ok(
      source.includes('a SPAN test, not a record test'),
      'the docstring must keep explaining what the old implementation got wrong'
    );
  });
});

describe('provisional years — seeded, derivable, flagged', () => {
  test('a supplied Baisakh 1 is patro data; a derived one is provisional', () => {
    const seeded = [
      { yearBS: 2085, daysInMonths: [31, 32, 31, 32, 30, 31, 30, 30, 29, 30, 30, 30], startAD: '2028-04-13' },
    ];
    // 2085 is 366 days, so the next year starts 2029-04-14 — the old
    // `${year - 57}-04-14` would have said the same by luck here, which is why
    // the derivation is checked against a year where the two disagree.
    const derived = resolveSeedConfig(2086, [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 30], undefined, seeded);
    assert.equal(derived.startAD, '2029-04-14');
    assert.equal(derived.startAdSource, 'estimated');
    assert.equal(derived.isProvisional, true, 'a year the patro does not cover is provisional');
  });

  test('a patro-verified year derived from its predecessor is NOT provisional', () => {
    const seeded = [
      { yearBS: 2078, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2021-04-14' },
    ];
    // BS 2079 as published: the derivation from 2078's end must land on the
    // patro's own Baisakh 1, so the year is verified, not flagged.
    const config = resolveSeedConfig(2079, [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], undefined, seeded);
    assert.equal(config.startAD, '2022-04-14');
    assert.equal(config.startAdSource, 'patro', "the derived start IS the patro's Baisakh 1");
    assert.equal(config.isProvisional, false, 'the patro data verifies BS 2079');
  });

  test('a patro-verified year whose array disagrees with the patro IS flagged', () => {
    const config = resolveSeedConfig(2079, [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], undefined, [
      { yearBS: 2078, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2021-04-14' },
    ]);
    assert.equal(config.isProvisional, true, 'a hand-entered array for a published year is provisional');
  });

  test('a supplied start is recorded as patro data', () => {
    const config = resolveSeedConfig(2087, [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 30], '2030-04-14', []);
    assert.equal(config.startAD, '2030-04-14');
    assert.equal(config.startAdSource, 'patro');
    assert.equal(config.isProvisional, true, 'still provisional: the patro does not cover BS 2087 yet');
  });

  test('a gap below the new year is respected, not assumed away', () => {
    const seeded = [
      { yearBS: 2080, daysInMonths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30], startAD: '2023-04-14' },
      { yearBS: 2083, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2026-04-14' },
    ];
    const config = resolveSeedConfig(2084, [31, 31, 32, 31, 31, 30, 30, 30, 29, 30, 30, 30], undefined, seeded);
    assert.equal(config.startAD, '2027-04-14', 'the closest seeded year below wins');
  });

  test('the client mirror exposes provisional years to the coverage warning', () => {
    resetBsCalendarData();
    seedBSYearCalendar(2085, [31, 32, 31, 32, 30, 31, 30, 30, 29, 30, 30, 30], '2028-04-13', {
      startAdSource: 'patro',
      isProvisional: false,
    });
    seedBSYearCalendar(2086, [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 30], '2029-04-14', {
      startAdSource: 'estimated',
      isProvisional: true,
    });
    assert.deepEqual(getProvisionalYears(), [2086]);
    const coverage = getBsCalendarCoverage('2026-10-17');
    assert.deepEqual(coverage.provisionalYears, [2086]);
    assert.equal(coverage.maxBS.startsWith('2086'), true, 'the provisional year still extends coverage');
    resetBsCalendarData();
    assert.deepEqual(getProvisionalYears(), [], 'the bundled data is all patro-verified');
  });

  test('the bundled reference data covers the years the service reports', () => {
    const years = patroYears();
    assert.ok(years.includes(2085), 'BS 2085 must be verified');
    assert.ok(!years.includes(2086), 'BS 2086 is not published yet, so it can never be "verified"');
  });
});
