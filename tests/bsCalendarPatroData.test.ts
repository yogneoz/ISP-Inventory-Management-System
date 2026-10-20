/**
 * The BS calendar is REFERENCE DATA, so it must have ONE copy and that copy
 * must match the published patro.
 *
 * The defect this pins (measured 2026-10-16 against hamropatro.com's month
 * pages, cross-checked with nepcalendar.com, bhitta.app and
 * nepalicalendar.rat32.com): THREE of the eight shipped years disagreed with
 * the patro — BS 2080, 2084 and 2085 — because the calendar lived in four
 * hand-maintained copies that drifted apart:
 *
 *   - BS 2084's client array put its days in the wrong months (Kartik started
 *     2027-10-18 instead of 10-17, Mangsir 11-17 instead of 11-16, Magh
 *     01-15 instead of 01-14, Falgun 02-14 instead of 02-13, Chaitra 03-15
 *     instead of 03-14). A second, DIFFERENT 2084 array lived in the seed
 *     script (Magh 30 = 366 days), and that is the copy which seeded
 *     `bs_calendar_years`: it made 2028-04-13 belong to both 2084-12-30 and
 *     2085-01-01 — the "mirror listed 2,923 days vs 2,922 rows" symptom in
 *     bsCalendarMirrorInvariant.test.ts.
 *   - BS 2085 was wrong after Jestha: the hand-entered array claimed Shrawan
 *     31 days (patro: 32), Ashwin 30 (patro: 31), Borais Falgun 29 (patro: 30)
 *     and Chaitra 31 (patro: 30) — every later month slid by a day.
 *   - BS 2080 claimed Poush 30 days (patro: 29) and Magh 30 (patro: 29).
 *
 * The four copies were replaced by shared/bsCalendarYears.json, read by the
 * client bundle, the server defaults, the database seeder, and — through the
 * bundled calendar — the UI seed presets.
 *
 * PROVES (pure + source-level, no database needed):
 *   - BS 2080, 2084 and 2085 carry the patro's month arrays and month starts;
 *   - consecutive years TILE the AD calendar (no gap, no overlap, no 366-day
 *     "2084 leap" story) and BS 2085 hands over to 2086-01-01 = 2029-04-14;
 *   - the client bundle, the server defaults and setup_db.js all project the
 *     ONE shared file, and no screen carries its own preset literal, so a
 *     hand-edited copy cannot drift from the rest again;
 *   - every BS date the fiscal-year seed data stores exists in the patro
 *     (the sole exception is documented below, not silently allowed).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getBsCalendarData,
  getBundledBsYearMonths,
  getSeedPresetYears,
  resetBsCalendarData,
  findCalendarOverlaps,
  type BSYearData,
} from '../client/src/utils/nepaliCalendar';
import {
  DEFAULT_BS_YEARS_SERVER,
  buildBsDayRecordsForYear,
} from '../server/src/config/bsCalendar';

const ROOT = process.cwd();
const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(ROOT, relativePath), 'utf8');

/** BS 2084 as published: Baisakh..Chaitra. */
const PATRO_2084 = [31, 31, 32, 31, 31, 30, 30, 30, 29, 30, 30, 30];

/** BS 2085 as published (Hamro Patro month pages, cross-checked with bhitta.app,
 *  nepcalendar.com, nepalicalendar.rat32.com): 366 days, and NOT the array the
 *  repo used to ship ([31,32,31,32,31,30,30,30,29,30,29,31]). */
const PATRO_2085 = [31, 32, 31, 32, 30, 31, 30, 30, 29, 30, 30, 30];

/** BS 2080 as published: Poush and Magh are 29 days, not 30. */
const PATRO_2080 = [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30];

const PATRO_MONTH_NAMES = [
  'Baisakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra',
];

/**
 * Month starts (BS day 1 -> AD) and the year's last day, read off the patro
 * month pages. Every entry below was read from hamropatro.com/calendar/
 * <year>/<month> and confirmed by at least one other patro.
 */
const PATRO_ANCHORS: Record<number, Record<string, string>> = {
  2080: {
    '2080-01-01': '2023-04-14', // Baisakh
    '2080-02-01': '2023-05-15', // Jestha (32 days)
    '2080-03-01': '2023-06-16', // Ashadh
    '2080-04-01': '2023-07-17', // Shrawan (32 days)
    '2080-05-01': '2023-08-18', // Bhadra
    '2080-06-01': '2023-09-18', // Ashwin
    '2080-07-01': '2023-10-18', // Kartik
    '2080-08-01': '2023-11-17', // Mangsir
    '2080-09-01': '2023-12-17', // Poush (29 days)
    '2080-10-01': '2024-01-15', // Magh (29 days)
    '2080-11-01': '2024-02-13', // Falgun
    '2080-12-01': '2024-03-14', // Chaitra
    '2080-12-30': '2024-04-12', // last day of the BS year
  },
  2084: {
    '2084-01-01': '2027-04-14', // Baisakh
    '2084-02-01': '2027-05-15', // Jestha
    '2084-03-01': '2027-06-15', // Ashadh (32 days)
    '2084-04-01': '2027-07-17', // Shrawan
    '2084-05-01': '2027-08-17', // Bhadra
    '2084-06-01': '2027-09-17', // Ashwin
    '2084-07-01': '2027-10-17', // Kartik
    '2084-08-01': '2027-11-16', // Mangsir (30 days)
    '2084-09-01': '2027-12-16', // Poush (29 days)
    '2084-10-01': '2028-01-14', // Magh (30 days)
    '2084-11-01': '2028-02-13', // Falgun
    '2084-12-01': '2028-03-14', // Chaitra
    '2084-12-30': '2028-04-12', // last day of the BS year
  },
  2085: {
    '2085-01-01': '2028-04-13', // Baisakh
    '2085-02-01': '2028-05-14', // Jestha (32 days)
    '2085-03-01': '2028-06-15', // Ashadh
    '2085-04-01': '2028-07-16', // Shrawan (32 days)
    '2085-05-01': '2028-08-17', // Bhadra (30 days — the old array said 31)
    '2085-06-01': '2028-09-16', // Ashwin (31 days — the old array said 30)
    '2085-07-01': '2028-10-17', // Kartik
    '2085-08-01': '2028-11-16', // Mangsir
    '2085-09-01': '2028-12-16', // Poush (29 days)
    '2085-10-01': '2029-01-14', // Magh
    '2085-11-01': '2029-02-13', // Falgun (30 days — the old array said 29)
    '2085-12-01': '2029-03-15', // Chaitra (30 days — the old array said 31)
    '2085-12-30': '2029-04-13', // last day of the BS year
  },
};

const addDays = (isoDate: string, days: number): string => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
};

const sortYears = (data: Record<number, BSYearData>): BSYearData[] =>
  Object.values(data).sort((a, b) => a.yearBS - b.yearBS);

/** Expands one bundled year into { bsDate -> adDate } using the server's builder. */
const dayRecordsFor = (yearBS: number): Map<string, string> => {
  const year = getBsCalendarData()[yearBS];
  assert.ok(year, `BS ${yearBS} must be part of the bundled calendar`);
  return new Map(
    buildBsDayRecordsForYear(yearBS, year.daysInMonths, year.startAD).map((r: any) => [
      r.bsDate,
      r.adDate,
    ])
  );
};

/** Every BS date the bundled calendar can produce, as a set. */
const allBundledBsDates = (): Set<string> => {
  const dates = new Set<string>();
  for (const year of sortYears(getBsCalendarData())) {
    for (const bsDate of dayRecordsFor(year.yearBS).keys()) dates.add(bsDate);
  }
  return dates;
};

describe('each corrected year matches the published patro', () => {
  const cases: { yearBS: number; months: number[]; totalDays: number }[] = [
    { yearBS: 2080, months: PATRO_2080, totalDays: 365 },
    { yearBS: 2084, months: PATRO_2084, totalDays: 365 },
    { yearBS: 2085, months: PATRO_2085, totalDays: 366 },
  ];

  for (const { yearBS, months, totalDays } of cases) {
    test(`the shipped ${yearBS} month array is the patro array (${totalDays} days)`, () => {
      resetBsCalendarData();
      const shipped = getBsCalendarData()[yearBS];
      assert.ok(shipped, `BS ${yearBS} must be seeded`);
      assert.deepEqual(
        shipped.daysInMonths,
        months,
        `BS ${yearBS} day counts must match the patro month by month`
      );
      assert.equal(
        shipped.daysInMonths.reduce((sum, d) => sum + d, 0),
        totalDays,
        `BS ${yearBS} must be ${totalDays} days`
      );
      assert.equal(
        getBundledBsYearMonths(yearBS)!.length,
        12,
        `${PATRO_MONTH_NAMES.length} months per year`
      );
    });

    test(`every ${yearBS} month starts on the patro date`, () => {
      resetBsCalendarData();
      const byBsDate = dayRecordsFor(yearBS);
      for (const [bsDate, adDate] of Object.entries(PATRO_ANCHORS[yearBS])) {
        assert.equal(byBsDate.get(bsDate), adDate, `${bsDate} must convert to ${adDate}`);
      }
      assert.equal(byBsDate.size, totalDays, `the ${yearBS} array must expand to ${totalDays} days`);
    });
  }

  test('BS 2085 starts the day after BS 2084 ends and hands over to BS 2086 handoff date', () => {
    resetBsCalendarData();
    const data = getBsCalendarData();
    const y2084 = data[2084];
    const y2085 = data[2085];
    assert.ok(y2084 && y2085, 'both years must be seeded');
    assert.equal(
      y2085.startAD,
      addDays(y2084.startAD, y2084.daysInMonths.reduce((sum, d) => sum + d, 0)),
      'BS 2085 must start the day after BS 2084 ends'
    );
    assert.equal(y2085.startAD, '2028-04-13', 'Nepali New Year 2085 is 13 April 2028');
    const last2085 = dayRecordsFor(2085).get('2085-12-30');
    assert.equal(last2085, '2029-04-13', 'Chaitra 30, 2085 is the last day of the year');
    assert.equal(
      addDays(last2085!, 1),
      '2029-04-14',
      'Baisakh 1, 2086 is 14 April 2029 (the next seeded year starts there)'
    );
  });

  test('consecutive seeded years tile the AD calendar with no gap and no overlap', () => {
    resetBsCalendarData();
    const years = sortYears(getBsCalendarData());
    assert.ok(years.length >= 8, `expected the full bundled range, got ${years.length} years`);
    const problems: string[] = [];
    for (let i = 1; i < years.length; i++) {
      const prev = years[i - 1];
      const expected = addDays(prev.startAD, prev.daysInMonths.reduce((sum, d) => sum + d, 0));
      if (years[i].startAD !== expected) {
        problems.push(
          `BS ${prev.yearBS} ends ${addDays(expected, -1)} but BS ${years[i].yearBS} starts ` +
            `${years[i].startAD} (expected ${expected})`
        );
      }
    }
    assert.deepEqual(problems, [], `calendar must be contiguous:\n  ${problems.join('\n  ')}`);
    assert.deepEqual(
      findCalendarOverlaps(getBsCalendarData()),
      [],
      'the shipped calendar must not claim any AD date twice'
    );
  });
});

describe('the repo keeps exactly one hand-maintained copy of the BS calendar', () => {
  const SHARED_SOURCE = 'shared/bsCalendarYears.json';

  test('the client bundle and the server defaults are both projections of the shared file', () => {
    resetBsCalendarData();
    const shared = JSON.parse(read(SHARED_SOURCE)) as {
      years: { yearBS: number; daysInMonths: number[]; startAD: string }[];
    };
    assert.ok(shared.years.length >= 8, 'the shared file must cover the bundled range');

    const clientYears = sortYears(getBsCalendarData());
    const serverYears = new Map(DEFAULT_BS_YEARS_SERVER.map((y) => [y.yearBS, y]));

    for (const year of shared.years) {
      const client = clientYears.find((y) => y.yearBS === year.yearBS);
      const server = serverYears.get(year.yearBS);
      assert.ok(client, `BS ${year.yearBS} is in ${SHARED_SOURCE} but not in the client bundle`);
      assert.ok(server, `BS ${year.yearBS} is in ${SHARED_SOURCE} but not in the server defaults`);
      assert.deepEqual(
        client!.daysInMonths,
        year.daysInMonths,
        `client BS ${year.yearBS} must be a projection of ${SHARED_SOURCE}`
      );
      assert.equal(client!.startAD, year.startAD, `client BS ${year.yearBS} startAD`);
      assert.deepEqual(
        server!.daysInMonths,
        year.daysInMonths,
        `server BS ${year.yearBS} must be a projection of ${SHARED_SOURCE}`
      );
      assert.equal(server!.startAD, year.startAD, `server BS ${year.yearBS} startAD`);
    }
  });

  test('setup_db.js loads the shared file instead of carrying its own year arrays', () => {
    const source = read('scripts/setup_db.js');
    assert.match(
      source,
      /shared\/bsCalendarYears\.json/,
      'the seeder must read shared/bsCalendarYears.json'
    );
    assert.match(
      source,
      /JSON\.parse\(\s*fs\.readFileSync\([^)]*shared\/bsCalendarYears\.json/,
      'the seeder must parse the shared file at runtime'
    );
    assert.equal(
      /daysInMonths:\s*\[/.test(source),
      false,
      'the seeder must not inline BS month arrays again (that copy is what seeded BS 2084/2085 wrong)'
    );
  });

  test('no screen carries its own seed-preset literals', () => {
    resetBsCalendarData();
    const screens = [
      'client/src/features/finance/BsCalendarUtility.tsx',
      'client/src/features/finance/NepaliFiscalManagement.tsx',
    ];
    for (const screen of screens) {
      const source = read(screen);
      assert.equal(
        /y === \d{4}\s*\?/.test(source),
        false,
        `${screen} must derive its presets from the bundled calendar, not literals`
      );
      assert.match(source, /getBundledBsYearMonths\(/, `${screen} must read bundled month arrays`);
      assert.match(source, /getSeedPresetYears\(/, `${screen} must derive its preset years`);
    }
  });

  test('the preset row offers only years the shared file covers', () => {
    resetBsCalendarData();
    const bundled = sortYears(getBsCalendarData()).map((y) => y.yearBS);
    const presets = getSeedPresetYears();
    assert.ok(presets.length > 0, 'the preset row must not be empty');
    for (const year of presets) {
      assert.ok(bundled.includes(year), `preset year ${year} is not in the bundled calendar`);
      assert.ok(getBundledBsYearMonths(year), `preset year ${year} has no month array`);
    }
    assert.deepEqual(
      [...presets].sort((a, b) => b - a),
      presets,
      'presets are newest first'
    );
  });
});

describe('seeded fiscal years store only BS dates that exist in the patro', () => {
  /**
   * The ONLY BS label allowed to point at a day the bundled calendar does not
   * contain, keyed `<fiscal year id>:<field>`. Keep this list empty if you can:
   * it is an escape hatch for data that lies outside the seeded calendar, and a
   * stale entry fails the test below.
   */
  const OUT_OF_CALENDAR_COVERAGE: Record<string, string> = {
    'fy-6:endDateBS':
      'fy-6 ends 2029-07-15, past the seeded BS calendar (which stops at 2085-12-30 = ' +
      '2029-04-13); re-derive this label once BS 2086 is seeded from the patro',
  };

  interface SeedFiscalYear {
    source: string;
    id: string;
    startDateAD: string;
    endDateAD: string;
    startDateBS: string;
    endDateBS: string;
  }

  const parseFiscalYears = (relativePath: string): SeedFiscalYear[] => {
    const pattern =
      /id: '(fy-\d+)',\s*code: '[\d-]+',\s*startDateAD: '([\d-]+)',\s*endDateAD: '([\d-]+)',\s*startDateBS: '([\d-]+) BS',\s*endDateBS: '([\d-]+) BS'/g;
    return [...read(relativePath).matchAll(pattern)].map((m) => ({
      source: relativePath,
      id: m[1],
      startDateAD: m[2],
      endDateAD: m[3],
      startDateBS: m[4],
      endDateBS: m[5],
    }));
  };

  const SEED_SOURCES = ['scripts/setup_db.js', 'server/src/config/seedData.ts'];

  test('every seeded fiscal-year BS label exists in the bundled calendar', () => {
    resetBsCalendarData();
    const validBs = allBundledBsDates();
    const usedEscapeHatches = new Set<string>();
    const problems: string[] = [];

    for (const source of SEED_SOURCES) {
      const years = parseFiscalYears(source);
      assert.ok(years.length > 0, `${source} must declare fiscal years`);
      for (const fy of years) {
        for (const [field, label] of [
          ['startDateBS', fy.startDateBS],
          ['endDateBS', fy.endDateBS],
        ] as const) {
          if (validBs.has(label)) continue;
          const key = `${fy.id}:${field}`;
          if (OUT_OF_CALENDAR_COVERAGE[key]) {
            usedEscapeHatches.add(key);
            continue;
          }
          const adSide = validBs.size > 0 ? `${fy.startDateAD}..${fy.endDateAD}` : '';
          problems.push(
            `${source} ${fy.id}.${field} = '${label} BS' is not a day the patro has ` +
              `(FY spans ${adSide}) — derive the label from its own AD date`
          );
        }
      }
    }

    assert.deepEqual(
      problems,
      [],
      `seeded fiscal years store dates that do not exist:\n  ${problems.join('\n  ')}`
    );

    const stale = Object.keys(OUT_OF_CALENDAR_COVERAGE).filter(
      (key) => !usedEscapeHatches.has(key)
    );
    assert.deepEqual(
      stale,
      [],
      `these OUT_OF_CALENDAR_COVERAGE entries are no longer needed: ${stale.join(', ')}`
    );
  });

  test('a fiscal-year BS label that exists also matches its own AD boundary', () => {
    resetBsCalendarData();
    const adToBs = new Map<string, string>();
    for (const year of sortYears(getBsCalendarData())) {
      for (const [bsDate, adDate] of dayRecordsFor(year.yearBS)) adToBs.set(adDate, bsDate);
    }

    const problems: string[] = [];
    for (const source of SEED_SOURCES) {
      for (const fy of parseFiscalYears(source)) {
        const derivedStart = adToBs.get(fy.startDateAD);
        const derivedEnd = adToBs.get(fy.endDateAD);
        if (derivedStart && derivedStart !== fy.startDateBS) {
          problems.push(
            `${source} ${fy.id}.startDateBS = ${fy.startDateBS} BS but ${fy.startDateAD} is ${derivedStart}`
          );
        }
        if (derivedEnd && derivedEnd !== fy.endDateBS) {
          problems.push(
            `${source} ${fy.id}.endDateBS = ${fy.endDateBS} BS but ${fy.endDateAD} is ${derivedEnd}`
          );
        }
      }
    }
    assert.deepEqual(problems, [], `seeded fiscal-year BS labels drifted:\n  ${problems.join('\n  ')}`);
  });
});
