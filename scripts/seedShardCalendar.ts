/**
 * CI-only shard baseline: seed every BS day in the bundled calendar.
 *
 * The unsharded suite happened to let one test file's BS seed satisfy another
 * file that ran concurrently against the same database. Matrix shards have
 * separate databases, so each shard must start with the same reference
 * calendar. This adds calendar rows only; tests still provision their own
 * business data and assertions.
 *
 * Usage: TEST_SHARD does not matter. Run with DATABASE_URL set.
 */
import pg from 'pg';
import dotenv from 'dotenv';
import {
  DEFAULT_BS_YEARS_SERVER,
  buildBsDayRecordsForYear,
} from '../server/src/config/bsCalendar';
import { ensureReferenceData } from '../tests/fixtures/referenceData';

dotenv.config({ quiet: true });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('seed-shard-calendar: DATABASE_URL is required');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString, max: 2 });
try {
  await ensureReferenceData(pool);

  const fiscalYears = (await pool.query('SELECT id, code FROM fiscal_years')).rows as Array<{
    id: string;
    code: string;
  }>;
  const fiscalYearIdByCode = new Map(fiscalYears.map((row) => [row.code, row.id]));

  const records = DEFAULT_BS_YEARS_SERVER.flatMap((year) =>
    buildBsDayRecordsForYear(year.yearBS, year.daysInMonths, year.startAD)
  );

  // One multi-row upsert per chunk. ensureBsDayRecords() writes one row per
  // query, which is fine in a unit test but adds minutes when every shard
  // bootstraps the whole calendar on a Windows runner.
  const columns = [
    'ad_date',
    'bs_date',
    'bs_year',
    'bs_month',
    'bs_month_name',
    'bs_month_name_np',
    'bs_day',
    'day_of_week_name',
    'day_of_week_name_np',
    'fiscal_year',
    'fiscal_year_id',
    'quarter',
    'is_weekend',
  ];
  const chunkSize = 400;
  for (let start = 0; start < records.length; start += chunkSize) {
    const chunk = records.slice(start, start + chunkSize);
    const values: unknown[] = [];
    const placeholders = chunk.map((record, index) => {
      const base = index * columns.length;
      values.push(
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
        fiscalYearIdByCode.get(record.fiscalYear) ?? null,
        record.quarter,
        Boolean(record.isWeekend)
      );
      return `(${columns.map((_, column) => `$${base + column + 1}`).join(', ')})`;
    });
    await pool.query(
      `INSERT INTO bs_day_records (${columns.join(', ')})
       VALUES ${placeholders.join(', ')}
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
         fiscal_year_id = EXCLUDED.fiscal_year_id,
         quarter = EXCLUDED.quarter,
         is_weekend = EXCLUDED.is_weekend`,
      values
    );
  }
  console.log(`seed-shard-calendar: ${records.length} BS day records available`);
} finally {
  await pool.end().catch(() => {});
}
