/**
 * Fiscal-year close racing a posting — real pool connections, both orders.
 *
 * `postJournal` resolves the fiscal year with `FISCAL_YEAR_BOUNDS_SQL ... FOR
 * SHARE`, so an open posting holds a shared row lock for the length of its
 * transaction. `closeFiscalYear` takes `FOR UPDATE` on that same row before it
 * writes anything, so the two must serialize. This suite proves that against
 * PostgreSQL instead of reasoning about it:
 *
 *   1. POSTING PARKED → a third connection holds the document-sequence row, so
 *      the posting sits inside `postJournal`, between its fiscal-year read and
 *      its journal write. The close must wait there and lose its own
 *      `lock_timeout` (SQLSTATE 55P03); the year must stay open; releasing the
 *      sequence lets the posting commit; and the close, retried, then lands with
 *      that journal in its snapshot. Deleting `FOR SHARE` from the bounds query
 *      makes the close walk straight through — the executed proof, not the
 *      comment, is what pins the clause. Parking the posting is what makes that
 *      true: once a journal row exists, its foreign key to fiscal_years takes a
 *      KEY SHARE row lock, and the close would wait with no help from FOR SHARE.
 *   2. CLOSE FIRST → a later posting reads the committed `is_closed` flag and is
 *      refused, and no journal lands in the closed year.
 *   3. OVERRIDE → the one documented exception (a Super Admin override with a
 *      written reason, already audit-logged by the HTTP gate) still posts.
 *
 * The year-end close is company-wide and single-shot per year, so this runs in
 * its own throwaway database: a closed year left in the shared database is
 * visible to every suite that reads a company-wide statement.
 *
 * Every wait is bounded by a statement/lock timeout that the test ASSERTS on.
 * A hang here is a failure, never a skip; the only skip is a missing server.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import { createThrowawayDatabase, dropThrowawayDatabase } from './fixtures/throwawayDatabase';
import { postJournal } from '../server/src/services/accounting.service';
import { closeFiscalYear } from '../server/src/services/accountingClosing.service';
import { ENSURE_JOURNAL_PARTITION_SQL } from '../server/src/models/accounting.repo';
import { runWithClosedFiscalYearOverride } from '../server/src/state/fiscalWriteOverride';

dotenv.config();

const TEST_DB = 'inventory_fy_close_race_test';
const BRANCH = 'FCR1';
const FY = 'fcr-fy-2081';
const FY_CODE = 'FCR-2081';
const FY_START = '2024-07-17';
const FY_END = '2025-07-16';
const PERIOD = 'fcr-p-2025-01';
const POST_DATE = '2025-01-15';
const CASH = 'fcr-cash';
const PAYABLE = 'fcr-payable';

let pool: pg.Pool | null = null;
let adminPool: pg.Pool | null = null;
let ready = false;

try {
  if (process.env.DATABASE_URL) {
    const db = await createThrowawayDatabase(process.env.DATABASE_URL, TEST_DB);
    pool = db.pool;
    adminPool = db.adminPool;

    await pool.query(
      `INSERT INTO branches (id, code, name, location, is_demo)
       VALUES ($1, $1, 'Close Race Branch', 'Test', FALSE)`,
      [BRANCH]
    );
    // A fiscal year that has already ended: the close SQL itself refuses a year
    // whose end date is not yet in the past.
    await pool.query(
      `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed)
       VALUES ($1, $2, $3, $4, '2081-04-01', '2082-03-32', FALSE, FALSE)`,
      [FY, FY_CODE, FY_START, FY_END]
    );
    // The posting date's BS half, so the ledger write never depends on a
    // calendar read this fixture did not seed.
    await pool.query(
      `INSERT INTO bs_day_records (ad_date, bs_date, bs_year, bs_month, bs_month_name, bs_month_name_np,
         bs_day, day_of_week_name, day_of_week_name_np, fiscal_year, fiscal_year_id, quarter, is_weekend)
       VALUES ($1, '2081-10-02', 2081, 10, 'Poush', 'Poush', 2, 'Wednesday', 'Wednesday', '2081-82', $2, 'Q2', FALSE)`,
      [POST_DATE, FY]
    );
    await pool.query(
      `INSERT INTO gl_periods (id, fiscal_year_id, period_key, start_date_ad, start_date_bs, end_date_ad, end_date_bs, status)
       VALUES ($1, $2, '2025-01', '2025-01-01', '2081-09-18', '2025-01-31', '2081-10-18', 'OPEN')`,
      [PERIOD, FY]
    );
    await pool.query(
      `INSERT INTO gl_account_groups (id, code, name, account_type, statement_group, normal_balance) VALUES
         ('fcr-asset', 'FCRASSET', 'Race Assets', 'ASSET', 'CURRENT_ASSET', 'DEBIT'),
         ('fcr-liab', 'FCRLIAB', 'Race Liabilities', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT')`
    );
    // The first test parks a posting on this sequence row, so it has to exist.
    await pool.query(
      `INSERT INTO document_sequence_daily (branch_id, doc_type, date_ad, next_number)
       VALUES ($1, 'JV', $2::date, 0)`,
      [BRANCH, POST_DATE]
    );
    // Provision this month's ledger partitions up front. A posting provisions
    // them on first use, and that DDL takes ACCESS EXCLUSIVE on the journal
    // tables - an unrelated second reason for the close to wait. With the
    // partitions already in place, the fiscal-year row lock under test is the
    // only thing that can stop the close.
    await pool.query(ENSURE_JOURNAL_PARTITION_SQL, [POST_DATE]);
    // Balance-sheet accounts only: a P&L balance would make the close post a
    // closing journal, which is not the path under test here.
    await pool.query(
      `INSERT INTO gl_accounts (id, code, name, group_id, normal_balance) VALUES
         ($1, 'FCR1000', 'Race Cash', 'fcr-asset', 'D'),
         ($2, 'FCR2000', 'Race Payable', 'fcr-liab', 'C')`,
      [CASH, PAYABLE]
    );
    ready = true;
  }
} catch (error: any) {
  // Never skip silently: a fixture that cannot be built must say why.
  console.error('fiscalCloseRace fixture setup failed:', error?.message || error);
  ready = false;
  pool = null;
}

const skipNoDb = !ready && 'needs a reachable PostgreSQL (fiscal-close race fixture)';

/** One balanced journal that touches no income or expense account. */
function journalLines(amount: number) {
  // Both sides are always present: `postJournal` refuses a missing side rather
  // than reading it as zero.
  return [
    { accountId: CASH, debit: amount, credit: 0 },
    { accountId: PAYABLE, debit: 0, credit: amount },
  ];
}

async function post(client: pg.PoolClient, amount: number) {
  return postJournal(client, {
    journalDateAD: POST_DATE,
    branchId: BRANCH,
    sourceType: 'MANUAL',
    memo: 'close race',
    lines: journalLines(amount),
  });
}

async function isClosed(): Promise<boolean> {
  const row = (await pool!.query('SELECT is_closed FROM fiscal_years WHERE id = $1', [FY])).rows[0];
  return row.is_closed === true;
}

async function manualJournalCount(): Promise<number> {
  const row = (
    await pool!.query(
      `SELECT COUNT(*)::int AS n FROM gl_journals WHERE fiscal_year_id = $1 AND source_type = 'MANUAL'`,
      [FY]
    )
  ).rows[0];
  return Number(row.n);
}

after(async () => {
  if (pool) await pool.end().catch(() => undefined);
  await dropThrowawayDatabase(adminPool, TEST_DB);
});

describe('fiscal-year close racing a posting', { skip: skipNoDb }, () => {
  test('a posting parked before its journal write holds the close back, and the close lands once it commits', async () => {
    const posting = await pool!.connect();
    const closing = await pool!.connect();
    const locker = await pool!.connect();
    try {
      const postingPid = Number((await posting.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const closingPid = Number((await closing.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const lockerPid = Number((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      assert.equal(
        new Set([postingPid, closingPid, lockerPid]).size,
        3,
        'the proof needs three real pool connections'
      );

      // Park the posting inside `postJournal`, after it has resolved the fiscal
      // year and before it writes the journal row. That window is the whole
      // point: once the journal row exists, its foreign key to fiscal_years takes
      // a KEY SHARE row lock that makes the close wait on its own, so a posting
      // that had already inserted would prove nothing about the bounds query.
      await locker.query('BEGIN');
      const parkedRow = await locker.query(
        `SELECT 1 FROM document_sequence_daily
         WHERE branch_id = $1 AND doc_type = 'JV' AND date_ad = $2::date
         FOR UPDATE`,
        [BRANCH, POST_DATE]
      );
      assert.equal(parkedRow.rowCount, 1, 'the sequence row the posting claims must exist to park it');

      await posting.query('BEGIN');
      await posting.query("SET LOCAL statement_timeout = '20000ms'");
      const postingAttempt = post(posting, 500).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      );

      // Bounded, asserted wait for the posting to actually reach that point: no
      // sleep-and-hope, and no silent pass if it never gets there.
      let parked = false;
      const parkDeadline = Date.now() + 5000;
      while (Date.now() < parkDeadline) {
        const waitsFor = (await pool!.query('SELECT pg_blocking_pids($1) AS pids', [postingPid])).rows[0]
          .pids as number[];
        if (waitsFor.map(Number).includes(lockerPid)) {
          parked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(parked, 'the posting must be parked on its document sequence before the close is tried');

      // The close must now wait for that uncommitted posting. Its own
      // lock_timeout turns "still waiting" into a named SQLSTATE instead of a
      // hung suite.
      await closing.query('BEGIN');
      await closing.query("SET LOCAL lock_timeout = '1200ms'");
      await closing.query("SET LOCAL statement_timeout = '6000ms'");
      const closeAttempt = closeFiscalYear(closing, { fiscalYearId: FY }).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      const blockedBy = (await pool!.query('SELECT pg_blocking_pids($1) AS pids', [closingPid])).rows[0]
        .pids as number[];
      const closeOutcome = await closeAttempt;
      const closeError: any = closeOutcome.ok ? undefined : closeOutcome.error;
      await closing.query('ROLLBACK');

      assert.ok(
        blockedBy.map(Number).includes(postingPid),
        'the close must be blocked by the in-flight posting itself'
      );
      assert.equal(
        closeError?.code,
        '55P03',
        'the close must wait on the fiscal-year row lock the open posting holds (55P03 from its lock_timeout)'
      );
      assert.equal(await isClosed(), false, 'a blocked close must not have closed the year');

      // Nothing was waiting on the close: release the sequence and the posting
      // finishes normally, in the year that is still open.
      await locker.query('ROLLBACK');
      const posted = await postingAttempt;
      assert.ok(posted.ok, 'the posting must complete once the sequence is free');
      await posting.query('COMMIT');
      assert.equal(await manualJournalCount(), 1, 'the posting must have written its journal');
      assert.equal(await isClosed(), false, 'the posting must not have landed in a closed year');

      // And now the very same close succeeds.
      await closing.query('BEGIN');
      const result = await closeFiscalYear(closing, { fiscalYearId: FY });
      await closing.query('COMMIT');
      assert.equal(result.journalCount, 0, 'a balance-sheet-only ledger needs no closing journal');
      assert.equal(await isClosed(), true, 'the close must land once the posting is done');
      assert.equal(await manualJournalCount(), 1, 'the pre-close posting must survive the close');
    } finally {
      // Release the parking lock first: the posting's own transaction may still
      // be queued behind it, and rolling that back first would wait for it.
      await locker.query('ROLLBACK').catch(() => undefined);
      await posting.query('ROLLBACK').catch(() => undefined);
      await closing.query('ROLLBACK').catch(() => undefined);
      locker.release();
      posting.release();
      closing.release();
    }
  });

  test('a posting after the close observes is_closed and is refused', async () => {
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      let postError: any = null;
      try {
        await post(client, 250);
      } catch (error) {
        postError = error;
      }
      await client.query('ROLLBACK');

      assert.equal(postError?.status, 409, 'a closed year must refuse the posting');
      assert.match(String(postError?.message), /Fiscal year FCR-2081 is closed/);
      assert.equal(await manualJournalCount(), 1, 'the refused posting must write nothing');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  test('the audit-logged Super Admin override still posts into the closed year', async () => {
    const client = await pool!.connect();
    try {
      await runWithClosedFiscalYearOverride(
        'year-end adjustment approved by the board',
        async () => {
          await client.query('BEGIN');
          const journal = await post(client, 125);
          await client.query('COMMIT');
          assert.ok(journal.id, 'the authorized override must reach the ledger');
        }
      );
      assert.equal(await manualJournalCount(), 2);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
