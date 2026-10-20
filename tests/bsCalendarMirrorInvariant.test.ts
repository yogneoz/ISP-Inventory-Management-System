/**
 * AD → BS conversion must be a FUNCTION, on both sides.
 *
 * The defect this pins: the client mirror listed 2,923 days while
 * bs_day_records held 2,922. `generateCalendarDatabase()` emitted a record per
 * (year, day) pair and simply concatenated the years, so a year whose month
 * array overran its successor produced TWO records for one AD date:
 *
 *   BS 2084 seeded as 366 days from 2027-04-14
 *   BS 2085 starts 2028-04-13
 *   → 2028-04-13 was claimed as 2084-12-30 AND 2085-01-01
 *
 * The database never had that problem because `bs_day_records.ad_date` is the
 * PRIMARY KEY and every seed path inserts `ON CONFLICT (ad_date) DO UPDATE`
 * year by year — the later year wins, so the table stored 2085-01-01 and 2,922
 * rows. The client now applies the same rule, which makes the two agree in both
 * count and content, and the overlap is reported instead of silently swallowed.
 *
 * The bad 2084 array itself is fixed (BS 2084 is 365 days — see
 * bsCalendarPatroData.test.ts), so the shipped calendar has NO overlap left —
 * the rule below is defensive, and is proven against a synthetic overlap.
 *
 * PROVES (pure + source-level, plus a live-DB check that runs in CI):
 *   - findCalendarOverlaps is pure and flags exactly the shared day of a
 *     synthetic overlapping pair, and nothing for contiguous years;
 *   - the generated mirror holds one record per AD date (count == distinct AD
 *     dates) for the real shipped calendar data;
 *   - an overlapping day resolves to the LATER BS year — identical to the
 *     database's ON CONFLICT rule — and the shipped data has no overlap at all;
 *   - the client generator and the server's in-memory generator resolve the
 *     same year data to the same AD → BS pairs;
 *   - against a reachable PostgreSQL: seeding the mirror exactly the way App.tsx
 *     does (GET /api/bs-calendar/years) yields the same day count and the same
 *     BS date for every AD date the table stores.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  generateCalendarDatabase,
  findCalendarOverlaps,
  getBsCalendarData,
  lookupBSDayRecord,
  resetBsCalendarData,
  seedBSYearCalendar,
  type BSYearData,
} from '../client/src/utils/nepaliCalendar';
import {
  setInMemoryBsCalendarYears,
  generateInMemoryBsDayRecords,
  getInMemoryBsDayRecords,
} from '../server/src/config/bsCalendar';

dotenv.config();

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (bs_day_records)';

const TWO_DAYS = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]; // 24-day toy years

describe('AD → BS conversion is a function (one BS date per AD date)', () => {
  test('findCalendarOverlaps flags the shared day of an overlapping pair', () => {
    const contiguous: Record<number, BSYearData> = {
      9000: { yearBS: 9000, daysInMonths: TWO_DAYS, startAD: '2020-01-01' },
      9001: { yearBS: 9001, daysInMonths: TWO_DAYS, startAD: '2020-01-25' },
    };
    assert.deepEqual(findCalendarOverlaps(contiguous), [], 'contiguous years must report no overlap');

    // 9000 runs 2020-01-01 .. 2020-01-24; starting 9001 a day early collides.
    const overlapping: Record<number, BSYearData> = {
      9000: { yearBS: 9000, daysInMonths: TWO_DAYS, startAD: '2020-01-01' },
      9001: { yearBS: 9001, daysInMonths: TWO_DAYS, startAD: '2020-01-24' },
    };
    assert.deepEqual(findCalendarOverlaps(overlapping), [
      {
        adDate: '2020-01-24',
        earlierYearBS: 9000,
        earlierBs: '9000-12-02', // 12 months × 2 days: the 24th day is Chaitra 2
        laterYearBS: 9001,
        laterBs: '9001-01-01',
      },
    ]);
  });

  test('the generated mirror holds exactly one record per AD date', () => {
    const db = generateCalendarDatabase();
    assert.ok(db.length > 2000, `expected the real calendar, got ${db.length} days`);
    const distinct = new Set(db.map((d) => d.adDate));
    assert.equal(
      db.length,
      distinct.size,
      `the mirror must not list one AD date twice (${db.length} records, ${distinct.size} distinct AD dates)`
    );
    // Chronological order is what getCalendarBounds() relies on for min/max.
    const sorted = [...distinct].sort();
    assert.deepEqual(db.map((d) => d.adDate), sorted, 'records must stay in ascending AD order');
  });

  test('an overlapping day resolves to the LATER BS year, like bs_day_records does', () => {
    // The shipped calendar is contiguous, so prove the tie-break on a pair that
    // really does overlap: 9000 ends 2020-01-24 and 9001 also claims that day.
    resetBsCalendarData();
    seedBSYearCalendar(9000, TWO_DAYS, '2020-01-01');
    seedBSYearCalendar(9001, TWO_DAYS, '2020-01-24');
    const overlaps = findCalendarOverlaps(getBsCalendarData());
    assert.equal(overlaps.length, 1, 'the synthetic pair must overlap on exactly one day');
    for (const overlap of overlaps) {
      const record = lookupBSDayRecord(overlap.adDate);
      assert.equal(
        record?.bsDate,
        overlap.laterBs,
        `${overlap.adDate}: expected the later BS year (${overlap.laterBs}) to win over ${overlap.earlierBs}`
      );
      // The database keeps the later year too (PK ad_date + ON CONFLICT DO UPDATE).
      assert.equal(record?.bsYear, overlap.laterYearBS);
    }
    resetBsCalendarData();
    assert.deepEqual(
      findCalendarOverlaps(getBsCalendarData()),
      [],
      'the shipped calendar must be contiguous again after the synthetic seed'
    );
  });

  test('the client mirror and the server in-memory calendar agree day for day', () => {
    const years = Object.values(getBsCalendarData()).sort((a, b) => a.yearBS - b.yearBS);
    setInMemoryBsCalendarYears(
      years.map((y) => ({ yearBS: y.yearBS, daysInMonths: y.daysInMonths, startAD: y.startAD }))
    );
    generateInMemoryBsDayRecords();

    const client = generateCalendarDatabase();
    const server = getInMemoryBsDayRecords();
    assert.equal(
      client.length,
      server.length,
      `client mirror has ${client.length} days, the server in-memory calendar has ${server.length}`
    );

    const serverByAd = new Map(server.map((r: any) => [r.adDate, r.bsDate]));
    const mismatches = client
      .filter((row) => serverByAd.get(row.adDate) !== row.bsDate)
      .map((row) => `${row.adDate}: client ${row.bsDate} vs server ${serverByAd.get(row.adDate)}`);
    assert.deepEqual(mismatches, [], `AD → BS disagreements:\n  ${mismatches.slice(0, 10).join('\n  ')}`);
  });

  test('live: the mirror App.tsx builds matches bs_day_records exactly', { skip: skipNoDb }, async () => {
    const years = (
      await pool!.query(
        'SELECT year_bs AS "yearBS", days_in_months AS "daysInMonths", start_ad::text AS "startAD" FROM bs_calendar_years ORDER BY year_bs'
      )
    ).rows as Array<{ yearBS: number; daysInMonths: number[]; startAD: string }>;
    assert.ok(years.length > 0, 'bs_calendar_years must be seeded');

    // Exactly what App.tsx's bootstrap does with GET /api/bs-calendar/years.
    resetBsCalendarData();
    for (const y of years) seedBSYearCalendar(y.yearBS, y.daysInMonths, y.startAD);
    const mirror = generateCalendarDatabase();

    const rows = (
      await pool!.query('SELECT ad_date::text AS "adDate", bs_date AS "bsDate" FROM bs_day_records')
    ).rows as Array<{ adDate: string; bsDate: string }>;
    assert.equal(
      mirror.length,
      rows.length,
      `client mirror has ${mirror.length} days but bs_day_records has ${rows.length}`
    );

    const storedByAd = new Map(rows.map((r) => [r.adDate, r.bsDate]));
    const disagreements = mirror
      .filter((row) => storedByAd.get(row.adDate) !== row.bsDate)
      .map((row) => `${row.adDate}: mirror ${row.bsDate} vs table ${storedByAd.get(row.adDate)}`);
    assert.deepEqual(disagreements, [], `AD → BS disagreements:\n  ${disagreements.slice(0, 10).join('\n  ')}`);

    // And every seeded year must actually be representable in the mirror.
    const coveredYears = new Set(mirror.map((row) => row.bsYear));
    const missing = years.map((y) => y.yearBS).filter((y) => !coveredYears.has(y));
    assert.deepEqual(missing, [], `years present in bs_calendar_years but absent from the mirror: ${missing.join(', ')}`);
  });
});
