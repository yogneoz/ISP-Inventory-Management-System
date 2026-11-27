/**
 * BS ledger summary — money reconciliation against the AD ledger.
 *
 * A throwaway database gets two Nepali fiscal years (2079-80 and 2080-81),
 * journals on the first and last day of Shrawan and on Ashad month-end, and
 * the real buildBsLedgerSummary() read. Every BS month, quarter and fiscal-year
 * total is then compared with an independently queried AD date-range total, so
 * a calendar/quarter mapping mistake cannot hide behind the same grouping.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import { ensureBsDayRecords, ensureReferenceData } from './fixtures/referenceData';
import { DEFAULT_BS_YEARS_SERVER, buildBsDayRecordsForYear } from '../server/src/config/bsCalendar';
import { replayOnContention } from '../server/src/db/transactions';

dotenv.config();

const TEST_DB = 'inventory_bs_summary_test';
const BR = 'BSBR';
const ACCOUNT_GROUP = 'BSGRP';
const ACCOUNT_ASSET = 'BSA';
const ACCOUNT_EQUITY = 'BSL';
const FY1 = 'bs-fy-2079-80';
const FY2 = 'bs-fy-2080-81';

let adminPool: pg.Pool | null = null;
let client: pg.Client | null = null;
let dbReachable = false;

const DATES: Array<{ ad: string; amount: number; label: string }> = [];
const JOURNAL_ROWS: Array<{ id: string; date: string; amount: number }> = [];

async function ledgerTotal(db: pg.Client, from: string, to: string): Promise<{ debit: number; credit: number; balance: number }> {
  const row = (await db.query(
    `SELECT COALESCE(SUM(l.debit), 0)::numeric AS debit,
            COALESCE(SUM(l.credit), 0)::numeric AS credit,
            COALESCE(SUM(l.debit - l.credit), 0)::numeric AS balance
       FROM gl_journal_lines l
       JOIN gl_journals j ON j.id = l.journal_id AND j.journal_date_ad = l.journal_date_ad
      WHERE j.status = 'POSTED'
        AND l.journal_date_ad BETWEEN $1::date AND $2::date
        AND l.branch_id = $3`,
    [from, to, BR]
  )).rows[0];
  return {
    debit: Number(row.debit),
    credit: Number(row.credit),
    balance: Number(row.balance),
  };
}

describe('BS ledger summary reconciliation', () => {
  before(async () => {
    if (!process.env.DATABASE_URL) return;
    const adminUrl = new URL(process.env.DATABASE_URL);
    adminUrl.pathname = '/postgres';
    adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      await adminPool.query(`CREATE DATABASE ${TEST_DB}`);
      dbReachable = true;
    } catch {
      dbReachable = false;
      return;
    }

    const testUrl = new URL(process.env.DATABASE_URL);
    testUrl.pathname = `/${TEST_DB}`;
    client = new pg.Client({ connectionString: testUrl.toString() });
    await client.connect();
    await client.query(fs.readFileSync(path.resolve('scripts/schema.sql'), 'utf8'));

    await ensureReferenceData(client);
    await client.query(
      `INSERT INTO branches (id, code, name, location, active, allow_procurement, allow_warehouse_transfer, is_demo)
       VALUES ($1, $1, 'BS Summary Branch', 'Test', TRUE, TRUE, TRUE, FALSE)`,
      [BR]
    );
    await client.query(
      `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed, is_demo)
       VALUES ($1, '2079-80', '2022-07-17', '2023-07-16', '2079-04-01 BS', '2080-03-31 BS', FALSE, FALSE, FALSE)`,
      [FY1]
    );
    const fy2 = (await client.query(`SELECT id FROM fiscal_years WHERE code = '2080-81'`)).rows[0];
    assert.ok(fy2?.id, 'the reference fixture must seed fiscal year 2080-81');
    const fy2Id = String(fy2.id);
    await client.query(
      `INSERT INTO gl_periods (id, fiscal_year_id, period_key, start_date_ad, start_date_bs, end_date_ad, end_date_bs, status)
       VALUES
         ('bsp-1', $1, '2079-04', '2022-07-17', '2079-04-01 BS', '2023-07-16', '2080-03-31 BS', 'OPEN'),
         ('bsp-2', $2, '2080-04', '2023-07-17', '2080-04-01 BS', '2024-07-15', '2081-03-31 BS', 'OPEN')`,
      [FY1, fy2Id]
    );
    await client.query(
      `INSERT INTO gl_account_groups (id, code, name, account_type, statement_group, normal_balance)
       VALUES ($1, $1, 'BS Summary Group', 'ASSET', 'CURRENT_ASSET', 'DEBIT')`,
      [ACCOUNT_GROUP]
    );
    await client.query(
      `INSERT INTO gl_accounts (id, code, name, group_id)
       VALUES ($1, $1, 'BS Summary Asset', $3), ($2, $2, 'BS Summary Equity', $3)`,
      [ACCOUNT_ASSET, ACCOUNT_EQUITY, ACCOUNT_GROUP]
    );

    // Seed the actual bundled calendar before selecting real month boundaries;
    // no BS date literal is invented in this test.
    const calendarDates = DEFAULT_BS_YEARS_SERVER
      .filter((year) => year.yearBS >= 2079 && year.yearBS <= 2081)
      .flatMap((year) =>
        buildBsDayRecordsForYear(year.yearBS, year.daysInMonths, year.startAD).map((day) => day.adDate)
      );
    await ensureBsDayRecords(client, calendarDates);

    // First and last day of Shrawan 2079, Ashad month-end 2080, first day of
    // Shrawan 2080, and Ashad month-end 2081: two fiscal years and both
    // boundary months of the Nepali year.
    const boundary = await client.query(
      `SELECT ad_date::text AS ad
         FROM bs_day_records
        WHERE (bs_year = 2079 AND bs_month = 4)
        ORDER BY ad_date ASC
        LIMIT 1`
    );
    const shrawanLast = await client.query(
      `SELECT ad_date::text AS ad
         FROM bs_day_records
        WHERE (bs_year = 2079 AND bs_month = 4)
        ORDER BY ad_date DESC
        LIMIT 1`
    );
    const ashad1 = await client.query(
      `SELECT ad_date::text AS ad
         FROM bs_day_records
        WHERE (bs_year = 2080 AND bs_month = 3)
        ORDER BY ad_date DESC
        LIMIT 1`
    );
    const shrawan2 = await client.query(
      `SELECT ad_date::text AS ad
         FROM bs_day_records
        WHERE (bs_year = 2080 AND bs_month = 4)
        ORDER BY ad_date ASC
        LIMIT 1`
    );
    const ashad2 = await client.query(
      `SELECT ad_date::text AS ad
         FROM bs_day_records
        WHERE (bs_year = 2081 AND bs_month = 3)
        ORDER BY ad_date DESC
        LIMIT 1`
    );
    DATES.push(
      { ad: boundary.rows[0].ad, amount: 100, label: 'Shrawan first day 2079' },
      { ad: shrawanLast.rows[0].ad, amount: 200, label: 'Shrawan last day 2079' },
      { ad: ashad1.rows[0].ad, amount: 300, label: 'Ashad month-end 2080' },
      { ad: shrawan2.rows[0].ad, amount: 400, label: 'Shrawan first day 2080' },
      { ad: ashad2.rows[0].ad, amount: 500, label: 'Ashad month-end 2081' }
    );
    for (const [index, entry] of DATES.entries()) {
      const day = (await client.query(
        `SELECT bs_date, fiscal_year_id FROM bs_day_records WHERE ad_date = $1::date`,
        [entry.ad]
      )).rows[0];
      assert.ok(day.fiscal_year_id, `${entry.label} must link to its fiscal year`);
      await replayOnContention('Journal partition DDL', () =>
        client!.query(`SELECT ensure_journal_month_partition($1::date)`, [entry.ad])
      );
      const journalId = `bsj-${index + 1}`;
      await client.query(
        `INSERT INTO gl_journals
           (id, journal_no, journal_date_ad, journal_date_bs, fiscal_year_id, period_id, branch_id, memo)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)`,
        [journalId, `BSJ-${index + 1}`, entry.ad, `${day.bs_date} BS`, day.fiscal_year_id, day.fiscal_year_id === FY1 ? 'bsp-1' : 'bsp-2', BR, entry.label]
      );
      await client.query(
        `INSERT INTO gl_journal_lines
           (id, journal_id, journal_date_ad, journal_date_bs, line_no, account_id, branch_id, debit, credit)
         VALUES
           ($1, $2, $3::date, $4, 1, $5, $6, $7, 0),
           ($8, $2, $3::date, $4, 2, $9, $6, 0, $7)`,
        [
          `bsl-${index + 1}-dr`,
          journalId,
          entry.ad,
          `${day.bs_date} BS`,
          ACCOUNT_ASSET,
          BR,
          entry.amount,
          `bsl-${index + 1}-cr`,
          ACCOUNT_EQUITY,
        ]
      );
      JOURNAL_ROWS.push({ id: journalId, date: entry.ad, amount: entry.amount });
    }


  });

  after(async () => {
    if (client) await client.end().catch(() => undefined);
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`).catch(() => undefined);
      await adminPool.end().catch(() => undefined);
    }
  });

  test('every BS month, quarter and fiscal-year total equals its AD date-range total', async (t) => {
    if (!dbReachable || !client) return t.skip('PostgreSQL is not reachable');
    const { buildBsLedgerSummary } = await import('../server/src/services/accountingStatements.service');
    const from = DATES[0].ad;
    const to = DATES[DATES.length - 1].ad;
    const summary = await buildBsLedgerSummary(client, {
      from,
      to,
      branchId: BR,
      empty: false,
    });

    assert.equal(summary.reconciled, true);
    assert.equal(summary.difference, 0);
    assert.equal(summary.totals.debit, 1500);
    assert.equal(summary.totals.credit, 1500);
    assert.deepEqual(summary.totals, summary.adTotals);
    assert.equal(new Set(summary.months.map((month) => month.fiscalYear)).size, 2);

    for (const month of summary.months) {
      assert.match(month.quarter, /^Q[1-4]$/);
      assert.ok(month.bsMonthNameNp.length > 0);
      assert.match(month.startBS, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(month.endBS, /^\d{4}-\d{2}-\d{2}$/);
      const ad = await ledgerTotal(client, month.startAD, month.endAD);
      assert.deepEqual(
        { debit: month.debit, credit: month.credit, balance: month.balance },
        ad,
        `${month.bsYear}-${month.bsMonth} must equal the AD total for ${month.startAD}..${month.endAD}`
      );
    }

    for (const fiscalYear of [...new Set(summary.months.map((month) => month.fiscalYear))]) {
      const months = summary.months.filter((month) => month.fiscalYear === fiscalYear);
      const ad = await ledgerTotal(client, months[0].startAD, months[months.length - 1].endAD);
      const bs = months.reduce(
        (total, month) => ({
          debit: total.debit + month.debit,
          credit: total.credit + month.credit,
          balance: total.balance + month.balance,
        }),
        { debit: 0, credit: 0, balance: 0 }
      );
      assert.deepEqual(bs, ad, `${fiscalYear} must equal its AD range`);
    }

    for (const quarter of summary.quarters) {
      const same = summary.months.filter(
        (month) => month.fiscalYear === quarter.fiscalYear && month.quarter === quarter.quarter
      );
      const ad = await ledgerTotal(client, same[0].startAD, same[same.length - 1].endAD);
      assert.deepEqual(
        { debit: quarter.debit, credit: quarter.credit, balance: quarter.balance },
        ad,
        `${quarter.bsYear} ${quarter.quarter} must equal its AD range`
      );
    }

    const first = summary.months.find((month) => month.bsYear === 2079 && month.bsMonth === 4);
    const last = summary.months.find((month) => month.bsYear === 2081 && month.bsMonth === 3);
    assert.ok(first && first.startBS.endsWith('-04-01'));
    assert.ok(last && last.endBS.startsWith('2081-03-'));
    assert.equal(first.quarter, 'Q1');
    assert.equal(last.quarter, 'Q4');
    assert.match(summary.quarters[0].quarter, /^Q1$/);
  });
});
