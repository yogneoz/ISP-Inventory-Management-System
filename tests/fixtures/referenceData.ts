/**
 * Reference-data fixtures for tests that run against a SCHEMA-ONLY database —
 * NOT a test file itself (scripts/run_tests.mjs globs `tests/*.test.ts`, so
 * nothing under tests/fixtures is picked up as a suite).
 *
 * Why this exists: CI creates its PostgreSQL database by applying
 * scripts/schema.sql and nothing else, while a booted server (dbBoot's
 * seedInitialPostgresData) and a dev install (`npm run setup:pg`) always seed
 * reference data FIRST — the demo branch master (WH001/BRH01), the fiscal-year
 * master, and the BS (Nepali) calendar in bs_day_records. Any suite that
 * exercises a dated write or a branch-bound path therefore failed on CI with
 * data-shaped errors that name nothing useful: a BS-gate 400 ("BS date is not
 * available for <today>") from bsDateOr400, or an
 * `inventory_stock.branch_id` foreign-key violation from a test's own
 * `before` hook (which then cancels every test in the file). Five suites hit
 * that: bootstrapTrim, receiveLane403, salesInvoiceCancel, serialGateHttp,
 * shipmentAuthz.
 *
 * The fix belongs in the tests, not in the CI step: each suite provisions what
 * it needs, the way tests/lifecycleLiveDrain.test.ts provisions its login
 * account and tests/auth.branch.guard.test.ts provisions its branch. Seeding
 * the CI step instead would hide the same gap from every future suite.
 *
 * Everything here is DERIVED from the application's own sources of truth —
 * INITIAL_MASTER_BRANCHES / INITIAL_MASTER_FISCAL_YEARS (the rows dbBoot
 * inserts) and the canonical DEFAULT_BS_YEARS_SERVER calendar through
 * buildBsDayRecordsForYear() (the same mapping setup_db.js writes). No fixture
 * carries a hardcoded BS literal, so a fixture can never disagree with a real
 * install or trip the C4 guard in tests/bs_date.guard.test.ts.
 *
 * Idempotent throughout: every statement is ON CONFLICT DO NOTHING/UPDATE, so
 * suites can provision the same rows concurrently without ordering concerns.
 */
import {
  DEFAULT_BS_YEARS_SERVER,
  buildBsDayRecordsForYear,
} from '../../server/src/config/bsCalendar';
import {
  INITIAL_MASTER_BRANCHES,
  INITIAL_MASTER_FISCAL_YEARS,
} from '../../server/src/config/seedData';

/** Minimal structural type: a pg.Pool or a checked-out pg.PoolClient. */
export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

/** The demo branch ids the app itself seeds (server/src/config/seedData.ts). */
export const WAREHOUSE_BRANCH_ID = 'WH001';
export const TRANSFER_BRANCH_ID = 'BRH01';

/** The AD date the server derives for "now" — receipts and cancels stamp the
 *  current day, so a BS row for it is what those paths need. Mirrors
 *  `new Date().toISOString().split('T')[0]` exactly. */
export function todayAd(): string {
  return new Date().toISOString().split('T')[0];
}

/** Ad -> BS day-record lookup over the bundled calendar, built once per year. */
const yearCache = new Map<number, any[]>();

function findBundledDayRecord(adDate: string): any | null {
  for (const year of DEFAULT_BS_YEARS_SERVER) {
    let records = yearCache.get(year.yearBS);
    if (!records) {
      records = buildBsDayRecordsForYear(year.yearBS, year.daysInMonths, year.startAD);
      yearCache.set(year.yearBS, records);
    }
    const hit = records.find((record: any) => record.adDate === adDate);
    if (hit) return hit;
  }
  return null;
}

/**
 * Idempotently writes the bs_day_records row for each AD date, derived from the
 * bundled BS calendar. Returns the resolved `AD -> BS` map so a caller can use
 * the exact BS string the gate will derive.
 *
 * Throws (rather than skipping) for a date the bundled calendar does not
 * cover: that is a test bug — a date outside 2078-2085 BS can never be dated by
 * this build — and a silent skip would hide it.
 */
export async function ensureBsDayRecords(
  db: Queryable,
  adDates: string[]
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  for (const adDate of adDates) {
    const record = findBundledDayRecord(adDate);
    if (!record) {
      throw new Error(
        `tests/fixtures/referenceData: ${adDate} is outside the bundled BS calendar ` +
          `(${DEFAULT_BS_YEARS_SERVER[0].startAD} .. ${DEFAULT_BS_YEARS_SERVER[DEFAULT_BS_YEARS_SERVER.length - 1].yearBS} ` +
          'BS). Pick a date the build can resolve, or extend DEFAULT_BS_YEARS_SERVER.'
      );
    }
    await db.query(
      `INSERT INTO bs_day_records (
         ad_date, bs_date, bs_year, bs_month, bs_month_name, bs_month_name_np,
         bs_day, day_of_week_name, day_of_week_name_np, fiscal_year, fiscal_year_id, quarter, is_weekend
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               (SELECT id FROM fiscal_years WHERE code = $13), $11, $12)
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
      [
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
        record.isWeekend,
        // $13: the same code again — PostgreSQL cannot infer one parameter's
        // type from both a varchar column and a varchar comparison.
        record.fiscalYear,
      ]
    );
    resolved.set(record.adDate, record.bsDate);
  }
  return resolved;
}

/** Idempotently inserts the demo branch master rows dbBoot seeds. */
export async function ensureDemoBranches(
  db: Queryable,
  ids: string[] = [WAREHOUSE_BRANCH_ID, TRANSFER_BRANCH_ID]
): Promise<void> {
  for (const id of ids) {
    const branch = INITIAL_MASTER_BRANCHES.find((b) => b.id === id);
    if (!branch) {
      throw new Error(`tests/fixtures/referenceData: '${id}' is not an app-seeded demo branch`);
    }
    await db.query(
      `INSERT INTO branches (id, code, name, location, phone, is_headquarters, active, allow_procurement, allow_warehouse_transfer, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE) ON CONFLICT (id) DO NOTHING`,
      [
        branch.id,
        branch.code,
        branch.name,
        branch.location,
        branch.phone || '',
        branch.isHeadquarters || false,
        branch.active !== false,
        branch.allowProcurement !== false,
        branch.allowWarehouseTransfer !== false,
      ]
    );
  }
}

/** Idempotently inserts the fiscal-year master rows dbBoot seeds. The
 *  bootstrap controller scopes its payload to the active fiscal year and
 *  dereferences it, so a suite that calls GET /api/bootstrap needs these. */
export async function ensureFiscalYearMaster(db: Queryable): Promise<void> {
  for (const fy of INITIAL_MASTER_FISCAL_YEARS) {
    await db.query(
      `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) ON CONFLICT (id) DO NOTHING`,
      [
        fy.id,
        fy.code,
        fy.startDateAD || '2025-07-16',
        fy.endDateAD || '2026-07-15',
        fy.startDateBS || '2082-04-01',
        fy.endDateBS || '2083-03-31',
        fy.isCurrent || false,
        fy.isClosed || false,
      ]
    );
  }
}

/**
 * The one call most suites need: branch master + fiscal-year master + the BS
 * day row for a date (`todayAd()` by default, i.e. the day the server stamps on
 * receipts and voids). Returns the AD/BS pair so a test dates its own writes
 * with the same values the server derives.
 */
export async function ensureReferenceData(
  db: Queryable,
  adDate: string = todayAd()
): Promise<{ adDate: string; bsDate: string }> {
  await ensureDemoBranches(db);
  await ensureFiscalYearMaster(db);
  const resolved = await ensureBsDayRecords(db, [adDate]);
  return { adDate, bsDate: resolved.get(adDate)! };
}
