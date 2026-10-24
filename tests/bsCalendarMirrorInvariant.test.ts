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
 * PROVES (pure + source-level, plus a live-DB check):
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
 *
 * Isolation: the live check builds its OWN throwaway database
 * (`inventory_bs_mirror_test`) from scripts/schema.sql, then seeds it with the
 * bundled calendar through the server's own day-record builder. It used to read
 * the application database, which made it depend on a developer's seed data:
 * CI applies schema.sql and nothing else, so `bs_calendar_years` was empty there
 * and the test failed on every run. A developer's install is now never read or
 * written by this file, and a stale calendar in it cannot mask a generator
 * disagreement.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  DEFAULT_BS_YEARS_SERVER,
  buildBsDayRecordsForYear,
  setInMemoryBsCalendarYears,
  generateInMemoryBsDayRecords,
  getInMemoryBsDayRecords,
} from '../server/src/config/bsCalendar';

dotenv.config();

const ROOT = path.resolve('.');
const TEST_DB = 'inventory_bs_mirror_test';

/** Parse DATABASE_URL and swap the database for the throwaway one. */
function withDbName(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

// Reachability is decided before the tests are collected, so `skip` is honest
// (a skip option is evaluated when test() is called, not when before() runs).
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    const probe = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 2000,
    });
    await probe.query('SELECT 1');
    await probe.end();
    dbReachable = true;
  }
} catch {
  dbReachable = false;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (bs_day_records)';

const TWO_DAYS = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]; // 24-day toy years

/**
 * Writes generated day rows the way an install's seed path does: `ad_date` is
 * the primary key and the later year wins, which is exactly the collapse the
 * client generator mirrors. Batched so 2,900+ rows are a handful of statements.
 */
async function insertDayRecords(db: pg.Pool, records: any[]): Promise<void> {
  const BATCH = 200;
  for (let start = 0; start < records.length; start += BATCH) {
    const chunk = records.slice(start, start + BATCH);
    const params: any[] = [];
    const tuples: string[] = [];
    for (const record of chunk) {
      const base = params.length;
      params.push(
        record.adDate,
        record.bsDate,
        record.bsYear,
        record.bsMonth,
        record.bsMonthName,
        record.bsMonthNameNp,
        record.bsDay,
        record.dayOfWeekName,
        record.dayOfWeekNameNp,
        record.fiscalYear,
        record.quarter,
        record.isWeekend
      );
      // fiscal_year_id stays NULL: the throwaway database has no fiscal-year
      // master, and this test never reads that column.
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
          `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, ` +
          `NULL, $${base + 11}, $${base + 12})`
      );
    }
    await db.query(
      `INSERT INTO bs_day_records
         (ad_date, bs_date, bs_year, bs_month, bs_month_name, bs_month_name_np,
          bs_day, day_of_week_name, day_of_week_name_np, fiscal_year, fiscal_year_id,
          quarter, is_weekend)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (ad_date) DO UPDATE SET
         bs_date = EXCLUDED.bs_date,
         bs_year = EXCLUDED.bs_year,
         bs_month = EXCLUDED.bs_month,
         bs_month_name = EXCLUDED.bs_month_name,
         bs_month_name_np = EXCLUDED.bs_month_name_np,
         bs_day = EXCLUDED.bs_day,
         day_of_week_name = EXCLUDED.day_of_week_name,
         day_of_week_name_np = EXCLUDED.day_of_week_name_np,
         fiscal_year = EXCLUDED.fiscal_year,
         quarter = EXCLUDED.quarter,
         is_weekend = EXCLUDED.is_weekend`,
      params
    );
  }
}

describe('AD → BS conversion is a function (one BS date per AD date)', () => {
  let adminPool: pg.Pool | null = null; // connects to 'postgres' for CREATE/DROP
  let pool: pg.Pool | null = null; // the throwaway calendar database

  before(async () => {
    const base = process.env.DATABASE_URL;
    if (!base || !dbReachable) return;

    adminPool = new pg.Pool({
      connectionString: withDbName(base, 'postgres'),
      max: 2,
      connectionTimeoutMillis: 2000,
    });
    adminPool.on('error', () => undefined);
    await adminPool.query('SELECT 1');

    // A stale throwaway from an earlier run can hold connections; nothing else
    // owns this database, so terminate them and recreate it.
    await adminPool
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB]
      )
      .catch(() => undefined);
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await adminPool.query(`CREATE DATABASE ${TEST_DB}`);

    const schemaClient = new pg.Client({ connectionString: withDbName(base, TEST_DB) });
    await schemaClient.connect();
    try {
      await schemaClient.query(fs.readFileSync(path.join(ROOT, 'scripts', 'schema.sql'), 'utf8'));
    } finally {
      await schemaClient.end();
    }

    pool = new pg.Pool({
      connectionString: withDbName(base, TEST_DB),
      max: 4,
      connectionTimeoutMillis: 5000,
    });
    // Teardown drops this database. An idle client still attached when that
    // happens receives "terminating connection due to administrator command",
    // and pg reports it as an 'error' event on the pool: unhandled, node turns
    // it into an uncaughtException that fails the whole file even though every
    // test passed. These errors are expected here, so they are absorbed; a
    // failing query still rejects normally during the tests.
    pool.on('error', () => undefined);

    // The fixture is the real bundled calendar, seeded the way an install seeds
    // it: the year master first, then that year's day rows from the server's own
    // builder — so the comparison stays client generator vs server-written rows.
    for (const year of DEFAULT_BS_YEARS_SERVER) {
      await pool.query(
        `INSERT INTO bs_calendar_years (year_bs, days_in_months, start_ad)
         VALUES ($1, $2, $3)
         ON CONFLICT (year_bs) DO UPDATE SET
           days_in_months = EXCLUDED.days_in_months,
           start_ad = EXCLUDED.start_ad`,
        [year.yearBS, year.daysInMonths, year.startAD]
      );
      await insertDayRecords(
        pool,
        buildBsDayRecordsForYear(year.yearBS, year.daysInMonths, year.startAD)
      );
    }
  });

  after(async () => {
    if (pool) await pool.end();
    if (adminPool && dbReachable) {
      // The pool is closed, so a plain DROP should find no backends. Only a
      // client that raced the shutdown needs terminating; doing it on the
      // common path is what used to kill an idle client mid-teardown.
      try {
        await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      } catch {
        await adminPool
          .query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [TEST_DB]
          )
          .catch(() => undefined);
        await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => undefined);
      }
    }
    if (adminPool) await adminPool.end();
  });

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
    assert.ok(years.length > 0, 'the fixture must seed the calendar years');

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
