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
import { businessDateAD } from '../../shared/businessDate';
import {
  ensureDefaultChart,
  ensureDefaultSubledgers,
} from '../../server/src/services/accountingSeed.service';
import { purgeAuditLogs } from '../support/purgeAuditLogs';

/** Minimal structural type: a pg.Pool or a checked-out pg.PoolClient. */
export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** The demo branch ids the app itself seeds (server/src/config/seedData.ts). */
export const WAREHOUSE_BRANCH_ID = 'WH001';
export const TRANSFER_BRANCH_ID = 'BRH01';

/** The AD date the server derives for "now" — receipts and cancels stamp the
 *  current business day, so a BS row for it is what those paths need. Same
 *  helper the server uses: Kathmandu's date, not UTC's (they disagree until
 *  05:45 local, which is when a UTC-derived fixture date was a day behind). */
export function todayAd(): string {
  return businessDateAD();
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
/**
 * True when a fiscal year is the current one on `todayAD`: it contains that
 * day and is not closed. The same rule dbBoot applies, so the fixture cannot
 * seed a different "current" year than a real install would.
 */
function isCurrentOn(
  fy: { startDateAD?: string; endDateAD?: string; isClosed?: boolean },
  todayAD: string
): boolean {
  const start = fy.startDateAD || '';
  const end = fy.endDateAD || '';
  return Boolean(start && end && !fy.isClosed && todayAD >= start && todayAD <= end);
}

export async function ensureFiscalYearMaster(db: Queryable): Promise<void> {
  // Derived, not copied from the constant: its isCurrent was true when it was
  // written and stops being true the day the year rolls over.
  const todayAD = businessDateAD();
  for (const fy of INITIAL_MASTER_FISCAL_YEARS) {
    await db.query(
      `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) ON CONFLICT DO NOTHING`,
      [
        fy.id,
        fy.code,
        fy.startDateAD || '2025-07-16',
        fy.endDateAD || '2026-07-15',
        fy.startDateBS || '2082-04-01',
        fy.endDateBS || '2083-03-31',
        isCurrentOn(fy, todayAD),
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
  // Any suite that exercises an invoice now also exercises its ledger posting,
  // so the posting defaults and their control-account books are part of the
  // reference data a schema-only database needs. The seeder is idempotent and
  // additive.
  await ensureDefaultChart(db);
  await ensureDefaultSubledgers(db);
  // A finance write persists both halves of the date for the document, its
  // monthly period and any reference/cheque date. Seed the whole month the
  // suite's business day falls in, so a period boundary and a nearby voucher
  // date resolve exactly as they do on a booted install.
  const [year, month] = adDate.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dates = Array.from(
    { length: daysInMonth },
    (_, index) => `${adDate.slice(0, 7)}-${String(index + 1).padStart(2, '0')}`
  );
  const resolved = await ensureBsDayRecords(db, dates);
  return { adDate, bsDate: resolved.get(adDate)! };
}

/* ---------------------------------------------------------------------------
 * Demo-master ownership
 *
 * The demo master above is a *schema-only* fallback, not a fixture every
 * database should carry. `ensureReferenceData()` seeds it unconditionally so a
 * CI database (which is `scripts/schema.sql` and nothing else) can run a suite;
 * pointed at a developer database that already owns its branch master, the same
 * call left WH001/BRH01 and the 2080-81/2081-82 fiscal years — plus the
 * journals, daily sequence counters and GL period balances suites posted
 * against them — sitting next to the install's real master and its own fiscal
 * years. A boot guard already refuses to do that from dbBoot; the fixture had
 * no equivalent.
 *
 * No single suite can clean it up safely: test files run concurrently, so one
 * file's teardown would delete a branch a sibling file is still using. The run
 * owns the decision instead — `scripts/testDbHygiene.ts` snapshots what existed
 * before the run and removes, afterwards, only the demo rows the run created,
 * driven by `scripts/run_tests.mjs`.
 * ------------------------------------------------------------------------ */

/** Ids of the demo branch master `dbBoot` and `ensureDemoBranches()` write. */
export const DEMO_MASTER_BRANCH_IDS: string[] = INITIAL_MASTER_BRANCHES.map((branch) => branch.id);

/** Ids of the demo fiscal-year master the same places write. */
export const DEMO_MASTER_FISCAL_YEAR_IDS: string[] = INITIAL_MASTER_FISCAL_YEARS.map((fy) => fy.id);

/** Every column that points at `parent`, read from the catalog rather than a
 *  hand-kept list — the branch master alone has ~275 referencing columns, and a
 *  missed one turns the parent delete into a foreign-key error nobody reads.
 *
 *  Read through pg_constraint (not information_schema's constraint views): those
 *  views join on constraint *name*, and this schema reuses names per table, so a
 *  name join multiplies 275 columns into ~140,000 rows — and a clean-up that
 *  believed them would fire one DELETE per phantom. */
async function foreignKeyColumns(
  db: Queryable,
  parent: string
): Promise<Array<{ table: string; column: string }>> {
  const result = await db.query(
    `SELECT DISTINCT child.relname AS "table", att.attname AS "column"
       FROM pg_constraint con
       JOIN pg_class child ON child.oid = con.conrelid
       JOIN pg_class parent ON parent.oid = con.confrelid
       JOIN LATERAL unnest(con.conkey) AS key(attnum) ON true
       JOIN pg_attribute att
         ON att.attrelid = con.conrelid AND att.attnum = key.attnum
      WHERE con.contype = 'f'
        AND parent.relname = $1
        AND parent.relnamespace = 'public'::regnamespace
        AND child.relnamespace = 'public'::regnamespace`,
    [parent]
  );
  return result.rows as Array<{ table: string; column: string }>;
}

/** Branch-scoped tables that carry a `branch_id` with no foreign key to
 *  `branches` — `audit_logs` and `document_number_retirements`. A catalog walk
 *  over foreign keys cannot see them, and leaving them behind is not cosmetic:
 *  `audit_logs` keeps the document numbers a re-created demo branch then reuses,
 *  so a number-keyed assertion elsewhere matches last run's evidence. */
async function branchScopedTablesWithoutForeignKey(
  db: Queryable
): Promise<Array<{ table: string; column: string }>> {
  const result = await db.query(
    `SELECT c.relname AS "table", a.attname AS "column"
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND a.attname = 'branch_id'
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND c.relkind IN ('r', 'p')
        AND NOT EXISTS (
          SELECT 1
            FROM pg_constraint con
            JOIN pg_class parent ON parent.oid = con.confrelid
           WHERE con.contype = 'f'
             AND con.conrelid = c.oid
             AND parent.relname = 'branches'
             AND a.attnum = ANY(con.conkey))`
  );
  return result.rows as Array<{ table: string; column: string }>;
}

/** Tables whose DELETE is refused unless the sanctioned purge switch is on:
 *  `audit_logs` and its month partitions (worklist A7). A test run removing its
 *  own evidence goes through the same switch the ledger purge uses — see
 *  tests/support/purgeAuditLogs.ts — instead of the guard being loosened. */
const APPEND_ONLY_AUDIT_TABLES = /^audit_logs/i;

/** Deletes every row that still points at `values` in `parent`, repeating until
 *  nothing changes: a first pass frees the rows whose own children are gone,
 *  a later pass the ones that were blocked. A row locked by the ACC-1b ledger
 *  purge trigger is only removed when the caller connected with
 *  `inventory.allow_ledger_purge=on` — which the test runner does. */
async function deleteReferencingRows(
  db: Queryable,
  parent: string,
  values: string[]
): Promise<number> {
  const columns =
    parent === 'branches'
      ? [
          ...(await foreignKeyColumns(db, 'branches')),
          ...(await branchScopedTablesWithoutForeignKey(db)),
        ]
      : await foreignKeyColumns(db, parent);
  let deleted = 0;
  for (let pass = 0; pass < 5; pass += 1) {
    let thisPass = 0;
    for (const ref of columns) {
      const statement = `DELETE FROM "${ref.table}" WHERE "${ref.column}" = ANY($1::text[])`;
      try {
        if (APPEND_ONLY_AUDIT_TABLES.test(ref.table)) {
          await purgeAuditLogs(db, statement, [values]);
        } else {
          const result = await db.query(statement, [values]);
          thisPass += result.rowCount ?? result.rows.length;
        }
      } catch {
        // Blocked by a row deeper in the chain, or by a guard trigger. The next
        // pass retries once the shallower rows are gone; the final `remaining`
        // count below is what tells the caller the truth either way.
      }
    }
    deleted += thisPass;
    if (thisPass === 0) break;
  }
  return deleted;
}

export interface DemoMasterRemoval {
  deletedRows: number;
  remaining: { branches: number; fiscalYears: number };
}

/**
 * Removes demo-master rows that a run created in a database which already had
 * its own master data, together with the suite residue that points at them.
 *
 * Only the ids passed in are touched — callers pass "the demo ids that were
 * absent before this run", so an install's own branches and fiscal years can
 * never be candidates. Branch residue is deleted first (journals, lines,
 * sequence counters, period balances), because a fiscal year's last dependent
 * is usually a GL period whose journal was posted at a demo branch.
 */
export async function removeDemoMasterRows(
  db: Queryable,
  branchIds: string[] = [],
  fiscalYearIds: string[] = [],
  log: (message: string) => void = () => {}
): Promise<DemoMasterRemoval> {
  let deletedRows = 0;

  if (branchIds.length > 0) {
    const children = await deleteReferencingRows(db, 'branches', branchIds);
    deletedRows += children;
    const branches = await db
      .query('DELETE FROM branches WHERE id = ANY($1::text[])', [branchIds])
      .catch((err: any) => {
        log(`test-hygiene: branch master delete refused: ${err?.message || err}`);
        return { rows: [], rowCount: 0 };
      });
    deletedRows += branches.rowCount ?? 0;
    log(`test-hygiene: removed ${branches.rowCount ?? 0} demo branch row(s) and ${children} dependent row(s)`);
  }

  if (fiscalYearIds.length > 0) {
    const children = await deleteReferencingRows(db, 'fiscal_years', fiscalYearIds);
    deletedRows += children;
    const fiscalYears = await db
      .query('DELETE FROM fiscal_years WHERE id = ANY($1::text[])', [fiscalYearIds])
      .catch((err: any) => {
        log(`test-hygiene: fiscal-year delete refused: ${err?.message || err}`);
        return { rows: [], rowCount: 0 };
      });
    deletedRows += fiscalYears.rowCount ?? 0;
    log(
      `test-hygiene: removed ${fiscalYears.rowCount ?? 0} demo fiscal-year row(s) and ${children} dependent row(s)`
    );
  }

  const remaining = await db.query(
    `SELECT (SELECT COUNT(*)::int FROM branches WHERE id = ANY($1::text[])) AS branches,
            (SELECT COUNT(*)::int FROM fiscal_years WHERE id = ANY($2::text[])) AS fiscal_years`,
    [branchIds, fiscalYearIds]
  );
  const row = remaining.rows[0] || { branches: 0, fiscal_years: 0 };
  return {
    deletedRows,
    remaining: { branches: Number(row.branches) || 0, fiscalYears: Number(row.fiscal_years) || 0 },
  };
}
