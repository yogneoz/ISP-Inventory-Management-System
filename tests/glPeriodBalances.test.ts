/**
 * Period and party balances — the two accounting read models.
 *
 * Runs against its own throwaway database, because the rebuild truncates tables
 * every ledger write in the other suites maintains.
 *
 * What is proven, not asserted:
 *   - the trigger-maintained rows equal a from-scratch rebuild, byte for byte,
 *     `updated_at` included;
 *   - opening and closing carry forward across periods, hand-computed;
 *   - a backdated posting moves the later periods' openings with it;
 *   - party balances split by party and their closing figures sum to the
 *     control account's closing figure;
 *   - a rolled-back posting leaves no phantom in either model;
 *   - a locked model row is queued in `read_model_outbox`, is visible as
 *     pending, and replays through the same flush the operator command calls;
 *   - reads are branch-scoped;
 *   - the model reproduces `ACCOUNT_BALANCE_ROWS_SQL` for the same period window
 *     — the ledger is the definition, the model is the projection.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import { createThrowawayDatabase, dropThrowawayDatabase } from './fixtures/throwawayDatabase';
import { ACCOUNT_BALANCE_ROWS_SQL } from '../server/src/models/accounting.repo';
import {
  GL_PARTY_PERIOD_BALANCES_REBUILD_SQL,
  GL_PARTY_PERIOD_BALANCES_SQL,
  GL_PERIOD_BALANCES_REBUILD_SQL,
  GL_PERIOD_BALANCES_SQL,
  READ_MODEL_FLUSH_SQL,
  READ_MODEL_PENDING_COUNT_SQL,
} from '../server/src/models/readModels.repo';

dotenv.config();

const TEST_DB = 'inventory_gl_period_balances_test';
const BRANCH = 'GPB1';
const OTHER_BRANCH = 'GPB2';
const FY = 'fy-gp';
const P1 = 'gp-p1';
const P2 = 'gp-p2';
const P3 = 'gp-p3';
const CASH = 'gp-cash';
const AR = 'gp-ar';
const SALES = 'gp-sales';
const MISC = 'gp-misc';

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
       VALUES ($1, $1, 'Period Balance Branch', 'Test', FALSE),
              ($2, $2, 'Period Balance Branch 2', 'Test', FALSE)`,
      [BRANCH, OTHER_BRANCH]
    );
    await pool.query(
      `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed)
       VALUES ($1, 'GP-2082', '2026-01-01', '2026-12-31', '2082-09-17', '2083-09-16', TRUE, FALSE)`,
      [FY]
    );
    await pool.query(
      `INSERT INTO gl_periods (id, fiscal_year_id, period_key, start_date_ad, start_date_bs, end_date_ad, end_date_bs, status) VALUES
         ($1, $4, '2026-01', '2026-01-01', '2082-09-17', '2026-01-31', '2082-10-17', 'OPEN'),
         ($2, $4, '2026-02', '2026-02-01', '2082-10-18', '2026-02-28', '2082-11-16', 'OPEN'),
         ($3, $4, '2026-03', '2026-03-01', '2082-11-17', '2026-03-31', '2082-12-16', 'OPEN')`,
      [P1, P2, P3, FY]
    );
    await pool.query(
      `INSERT INTO gl_account_groups (id, code, name, account_type, statement_group, normal_balance) VALUES
         ('gp-asset', 'GPASSET', 'GP Assets', 'ASSET', 'CURRENT_ASSET', 'DEBIT'),
         ('gp-income', 'GPINC', 'GP Income', 'INCOME', 'REVENUE', 'CREDIT')`
    );
    // `subledger_type` is NOT NULL with a default, so a non-control account
    // omits the column instead of passing NULL.
    await pool.query(
      `INSERT INTO gl_accounts (id, code, name, group_id, normal_balance) VALUES
         ($1, 'GP1000', 'GP Cash', 'gp-asset', 'D'),
         ($2, 'GP4000', 'GP Service Revenue', 'gp-income', 'C'),
         ('gp-misc', 'GP1999', 'GP Sundry', 'gp-asset', 'D')`,
      [CASH, SALES]
    );
    // A control account must declare its subledger (`gl_accounts_control_subledger_check`).
    await pool.query(
      `INSERT INTO gl_accounts (id, code, name, group_id, normal_balance, is_control, subledger_type)
       VALUES ($1, 'GP1100', 'GP Receivable', 'gp-asset', 'D', TRUE, 'CUSTOMER')`,
      [AR]
    );
    ready = true;
  }
} catch (error: any) {
  // Never skip silently: a fixture that cannot be built must say why.
  console.error('glPeriodBalances fixture setup failed:', error?.message || error);
  ready = false;
  pool = null;
}

const skipNoDb = !ready && 'needs a reachable PostgreSQL (period-balance fixture)';

interface Line {
  accountId: string;
  debit?: number;
  credit?: number;
  /** Present on a control-account line that must also appear in the subledger. */
  partyId?: string;
  /** `created_at` is nullable on both ledger tables; a writer may store NULL. */
  createdAtNull?: boolean;
}

/** One posted journal plus its lines. The triggers do the rest. */
async function postJournal(
  client: pg.Client | pg.Pool,
  id: string,
  date: string,
  periodId: string,
  lines: Line[],
  options: { branchId?: string; subledgerType?: string } = {}
): Promise<string[]> {
  const branchId = options.branchId ?? BRANCH;
  const lineIds: string[] = [];
  await client.query(
    `INSERT INTO gl_journals (id, journal_no, journal_date_ad, journal_date_bs, fiscal_year_id, period_id, branch_id, source_type, source_id)
     VALUES ($1, $1, $2, '2082-01-01', $3, $4, $5, 'MANUAL', NULL)`,
    [id, date, FY, periodId, branchId]
  );
  let lineNo = 0;
  for (const line of lines) {
    lineNo += 1;
    const lineId = `${id}-l${lineNo}`;
    await client.query(
      `INSERT INTO gl_journal_lines (id, journal_id, journal_date_ad, journal_date_bs, line_no, account_id, branch_id, debit, credit, created_at)
       VALUES ($1, $2, $3, '2082-01-01', $4, $5, $6, $7, $8,
               CASE WHEN $9::boolean THEN NULL ELSE CURRENT_TIMESTAMP END)`,
      [lineId, id, date, lineNo, line.accountId, branchId, line.debit ?? 0, line.credit ?? 0, line.createdAtNull === true]
    );
    if (line.partyId) {
      await client.query(
        `INSERT INTO gl_subledger_entries (
           id, journal_id, journal_line_id, account_id, subledger_type, party_id, party_name,
           branch_id, entry_date_ad, entry_date_bs, debit, credit, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, '2082-01-01', $9, $10,
                   CASE WHEN $11::boolean THEN NULL ELSE CURRENT_TIMESTAMP END)`,
        [
          `${lineId}-sl`,
          id,
          lineId,
          line.accountId,
          options.subledgerType ?? 'CUSTOMER',
          line.partyId,
          branchId,
          date,
          line.debit ?? 0,
          line.credit ?? 0,
          line.createdAtNull === true,
        ]
      );
    }
    lineIds.push(lineId);
  }
  return lineIds;
}

async function periodSnapshot() {
  return (
    await pool!.query(
      `SELECT branch_id, account_id, period_id, period_key, fiscal_year_id, period_start_ad,
              opening_balance::text AS opening, period_debit::text AS debit,
              period_credit::text AS credit, closing_balance::text AS closing, updated_at
         FROM gl_period_balances
        ORDER BY branch_id, account_id, period_start_ad, period_id`
    )
  ).rows;
}

async function partySnapshot() {
  return (
    await pool!.query(
      `SELECT branch_id, account_id, subledger_type, party_id, period_id, period_key, fiscal_year_id,
              period_start_ad, opening_balance::text AS opening, period_debit::text AS debit,
              period_credit::text AS credit, closing_balance::text AS closing, updated_at
         FROM gl_party_period_balances
        ORDER BY branch_id, account_id, subledger_type, party_id, period_start_ad, period_id`
    )
  ).rows;
}

async function periodRow(accountId: string, periodId: string, branchId: string = BRANCH) {
  const result = await pool!.query(
    `SELECT opening_balance::text AS opening, period_debit::text AS debit,
            period_credit::text AS credit, closing_balance::text AS closing
       FROM gl_period_balances
      WHERE branch_id = $1 AND account_id = $2 AND period_id = $3`,
    [branchId, accountId, periodId]
  );
  return result.rows[0] ?? null;
}

describe('period and party balances (throwaway PostgreSQL)', { skip: skipNoDb }, () => {
  after(async () => {
    if (pool) await pool.end().catch(() => undefined);
    await dropThrowawayDatabase(adminPool, TEST_DB);
  });

  test('a posted journal updates its period row in the same transaction', async () => {
    await postJournal(pool!, 'gp-j1', '2026-01-15', P1, [
      { accountId: AR, debit: 1000, partyId: 'cust-1' },
      { accountId: SALES, credit: 1000 },
    ]);
    const row = await periodRow(AR, P1);
    assert.equal(row.opening, '0.00');
    assert.equal(row.debit, '1000.00');
    assert.equal(row.credit, '0.00');
    assert.equal(row.closing, '1000.00');

    const party = (
      await pool!.query(
        `SELECT opening_balance::text AS opening, closing_balance::text AS closing
           FROM gl_party_period_balances
          WHERE branch_id = $1 AND account_id = $2 AND party_id = 'cust-1' AND period_id = $3`,
        [BRANCH, AR, P1]
      )
    ).rows[0];
    assert.equal(party.opening, '0.00');
    assert.equal(party.closing, '1000.00');
  });

  test('opening and closing carry forward across periods', async () => {
    await postJournal(pool!, 'gp-j2', '2026-02-10', P2, [
      { accountId: AR, debit: 500, partyId: 'cust-1' },
      { accountId: SALES, credit: 500 },
    ]);
    await postJournal(pool!, 'gp-j3', '2026-03-05', P3, [
      { accountId: CASH, debit: 300 },
      { accountId: AR, credit: 300, partyId: 'cust-1' },
    ]);

    assert.deepEqual(await periodRow(AR, P1), {
      opening: '0.00', debit: '1000.00', credit: '0.00', closing: '1000.00',
    });
    assert.deepEqual(await periodRow(AR, P2), {
      opening: '1000.00', debit: '500.00', credit: '0.00', closing: '1500.00',
    });
    assert.deepEqual(await periodRow(AR, P3), {
      opening: '1500.00', debit: '0.00', credit: '300.00', closing: '1200.00',
    });
    // A credit-normal revenue account carries the negative signed balance.
    assert.deepEqual(await periodRow(SALES, P2), {
      opening: '-1000.00', debit: '0.00', credit: '500.00', closing: '-1500.00',
    });
    assert.deepEqual(await periodRow(CASH, P3), {
      opening: '0.00', debit: '300.00', credit: '0.00', closing: '300.00',
    });
  });

  test('incremental maintenance equals a from-scratch rebuild, byte for byte', async () => {
    const incremental = await periodSnapshot();
    const parties = await partySnapshot();
    assert.ok(incremental.length > 0 && parties.length > 0);

    const rebuilt = await pool!.query(GL_PERIOD_BALANCES_REBUILD_SQL);
    assert.equal(Number(rebuilt.rows[0].rows), incremental.length);
    assert.deepEqual(await periodSnapshot(), incremental, 'period rows are identical, updated_at included');

    const rebuiltParties = await pool!.query(GL_PARTY_PERIOD_BALANCES_REBUILD_SQL);
    assert.equal(Number(rebuiltParties.rows[0].rows), parties.length);
    assert.deepEqual(await partySnapshot(), parties, 'party rows are identical, updated_at included');
  });

  test('a backdated posting moves the later periods with it', async () => {
    await postJournal(pool!, 'gp-j4-backdated', '2026-01-31', P1, [
      { accountId: AR, debit: 200, partyId: 'cust-1' },
      { accountId: SALES, credit: 200 },
    ]);

    assert.deepEqual(await periodRow(AR, P1), {
      opening: '0.00', debit: '1200.00', credit: '0.00', closing: '1200.00',
    });
    assert.deepEqual(await periodRow(AR, P2), {
      opening: '1200.00', debit: '500.00', credit: '0.00', closing: '1700.00',
    });
    assert.deepEqual(await periodRow(AR, P3), {
      opening: '1700.00', debit: '0.00', credit: '300.00', closing: '1400.00',
    });

    const incremental = await periodSnapshot();
    await pool!.query(GL_PERIOD_BALANCES_REBUILD_SQL);
    assert.deepEqual(await periodSnapshot(), incremental, 'the cascade agrees with the rebuild');
  });

  test('party balances split by party and sum to the control account', async () => {
    await postJournal(pool!, 'gp-j5', '2026-02-20', P2, [
      { accountId: AR, debit: 400, partyId: 'cust-2' },
      { accountId: SALES, credit: 400 },
    ]);

    const parties = await partySnapshot();
    const cust2 = parties.find((row: any) => row.party_id === 'cust-2' && row.period_id === P2);
    assert.equal(cust2.closing, '400.00');
    assert.equal(cust2.opening, '0.00');

    // The control account's closing figure is the sum of its parties' balances
    // carried forward. Party rows are sparse — a party with no activity in a
    // period has no row for it — so the tie-out takes each party's latest row at
    // or before the account's period, which is exactly how an aging read works.
    const tieOut = (
      await pool!.query(
        `SELECT g.period_id,
                COALESCE((
                  SELECT SUM(latest.closing_balance)
                    FROM (
                      SELECT DISTINCT ON (p.party_id) p.closing_balance
                        FROM gl_party_period_balances p
                       WHERE p.branch_id = g.branch_id
                         AND p.account_id = g.account_id
                         AND p.period_start_ad <= g.period_start_ad
                       ORDER BY p.party_id, p.period_start_ad DESC, p.period_id DESC
                    ) latest
                ), 0)::numeric(16,2)::text AS party_closing,
                g.closing_balance::numeric(16,2)::text AS account_closing
           FROM gl_period_balances g
          WHERE g.branch_id = $1 AND g.account_id = $2
          ORDER BY g.period_start_ad, g.period_id`,
        [BRANCH, AR]
      )
    ).rows;
    assert.equal(tieOut.length, 3);
    for (const row of tieOut) {
      assert.equal(row.party_closing, row.account_closing, `period ${row.period_id} ties out`);
    }
  });

  test('a rolled-back posting leaves no phantom in either model', async () => {
    const before = await periodSnapshot();
    const beforeParties = await partySnapshot();
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await postJournal(client, 'gp-j-rollback', '2026-03-20', P3, [
        { accountId: AR, debit: 99, partyId: 'cust-2' },
        { accountId: SALES, credit: 99 },
      ]);
      const inside = await client.query(
        `SELECT closing_balance::text AS closing FROM gl_period_balances
          WHERE branch_id = $1 AND account_id = $2 AND period_id = $3`,
        [BRANCH, AR, P3]
      );
      // 1,800 closing after j5 plus this uncommitted 99.
      assert.equal(inside.rows[0].closing, '1899.00', 'the model reflects the uncommitted write');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    assert.deepEqual(await periodSnapshot(), before);
    assert.deepEqual(await partySnapshot(), beforeParties);
  });

  test('a locked model row is queued, visible as pending, and replays', async () => {
    const holder = await pool!.connect();
    const writer = await pool!.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT closing_balance FROM gl_period_balances
          WHERE branch_id = $1 AND account_id = $2 AND period_id = $3 FOR UPDATE`,
        [BRANCH, AR, P2]
      );
      await writer.query('BEGIN');
      await writer.query(`SET LOCAL lock_timeout = '200ms'`);
      await postJournal(writer, 'gp-j6-queued', '2026-02-25', P2, [
        { accountId: AR, debit: 10, partyId: 'cust-2' },
        { accountId: SALES, credit: 10 },
      ]);
      await writer.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      writer.release();
    }

    const pending = (await pool!.query(READ_MODEL_PENDING_COUNT_SQL)).rows[0];
    assert.ok(pending.pending >= 1, JSON.stringify(pending));
    assert.equal((await periodRow(AR, P2)).closing, '2100.00', 'the model is still behind');

    while (true) {
      const flushed = (await pool!.query(READ_MODEL_FLUSH_SQL, [100])).rows[0];
      if (Number(flushed.remaining) === 0) break;
    }
    assert.equal((await periodRow(AR, P2)).closing, '2110.00', 'the queued key replayed into the model');

    const incremental = await periodSnapshot();
    await pool!.query(GL_PERIOD_BALANCES_REBUILD_SQL);
    assert.deepEqual(await periodSnapshot(), incremental);
  });

  test('reads are branch-scoped', async () => {
    await postJournal(
      pool!,
      'gp-j7-other',
      '2026-01-20',
      P1,
      [
        { accountId: CASH, debit: 50 },
        { accountId: AR, credit: 50, partyId: 'cust-9' },
      ],
      { branchId: OTHER_BRANCH }
    );

    const mine = (await pool!.query(GL_PERIOD_BALANCES_SQL, [BRANCH, null, AR])).rows;
    assert.ok(mine.length >= 3);
    assert.ok(mine.every((row: any) => row.accountId === AR));

    const other = (await pool!.query(GL_PERIOD_BALANCES_SQL, [OTHER_BRANCH, null, null])).rows;
    assert.equal(other.length, 2, 'the other branch sees only its own two lines');

    const myParties = (await pool!.query(GL_PARTY_PERIOD_BALANCES_SQL, [BRANCH, 'CUSTOMER', null, null])).rows;
    assert.ok(myParties.every((row: any) => row.partyId !== 'cust-9'));

    const otherParties = (await pool!.query(GL_PARTY_PERIOD_BALANCES_SQL, [OTHER_BRANCH, null, null, null])).rows;
    assert.equal(otherParties.length, 1);
    assert.equal(otherParties[0].partyId, 'cust-9');
  });

  test('the model reproduces the ledger query for every period window', async () => {
    const periods = (
      await pool!.query(
        `SELECT id, start_date_ad::text AS start, end_date_ad::text AS "end"
           FROM gl_periods ORDER BY start_date_ad`
      )
    ).rows;

    for (const period of periods) {
      const ledger = (await pool!.query(ACCOUNT_BALANCE_ROWS_SQL, [period.start, period["end"], BRANCH])).rows;
      const model = (
        await pool!.query(
          `SELECT account_id, opening_balance::text AS opening, period_debit::text AS debit,
                  period_credit::text AS credit
             FROM gl_period_balances
            WHERE branch_id = $1 AND period_id = $2`,
          [BRANCH, period.id]
        )
      ).rows;
      const byAccount = new Map(ledger.map((row: any) => [row.accountId, row]));
      assert.ok(model.length > 0, `period ${period.id} has balances`);
      for (const row of model) {
        const direct = byAccount.get(row.account_id);
        assert.ok(direct, `ledger has ${row.account_id}`);
        assert.equal(row.opening, Number(direct.openingBalance).toFixed(2), `${row.account_id} opening`);
        assert.equal(row.debit, Number(direct.periodDebit).toFixed(2), `${row.account_id} debit`);
        assert.equal(row.credit, Number(direct.periodCredit).toFixed(2), `${row.account_id} credit`);
      }
    }
  });

  test('a ledger row written without created_at cannot wedge the refresh', async () => {
    // `created_at` is nullable on both ledger tables, so a writer can store NULL.
    // Without a fallback, any group whose only rows were NULL computed NULL for
    // the model's NOT NULL `updated_at`: the refresh raised, the trigger queued
    // the key in `read_model_outbox`, and the replay hit the same violation for
    // ever. `gp-misc` and party `cust-3` are fresh keys, so this group has no
    // row carrying a real write time — the exact shape that used to wedge.
    const before = await periodRow(AR, P3);
    await postJournal(pool!, 'gp-j9-null-created', '2026-03-30', P3, [
      { accountId: MISC, debit: 40, createdAtNull: true },
      { accountId: AR, credit: 40, partyId: 'cust-3', createdAtNull: true },
    ]);

    // Applied inline, with nothing left for a replay that could never succeed.
    const misc = await periodRow(MISC, P3);
    assert.equal(misc.debit, '40.00');
    assert.equal(misc.closing, '40.00');
    assert.equal(
      (await pool!.query(READ_MODEL_PENDING_COUNT_SQL)).rows[0].pending,
      0,
      'nothing was queued: the row was written, not deferred'
    );

    // `updated_at` falls back to the group's posting date at UTC — derived from
    // the ledger rows alone, so the rebuild below must produce the same value.
    const stamps = (
      await pool!.query(
        `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS at
           FROM gl_period_balances
          WHERE branch_id = $1 AND account_id = $2 AND period_id = $3`,
        [BRANCH, MISC, P3]
      )
    ).rows;
    assert.deepEqual(stamps, [{ at: '2026-03-30 00:00:00' }]);

    const party = (
      await pool!.query(
        `SELECT closing_balance::text AS closing,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS at
           FROM gl_party_period_balances
          WHERE branch_id = $1 AND account_id = $2 AND party_id = 'cust-3' AND period_id = $3`,
        [BRANCH, AR, P3]
      )
    ).rows;
    assert.deepEqual(party, [{ closing: '-40.00', at: '2026-03-30 00:00:00' }]);

    // The control account moved by the same 40, so the party row still ties out.
    assert.equal(Number((await periodRow(AR, P3)).closing) - Number(before.closing), -40);

    // And the incremental rows stay identical to a from-scratch rebuild.
    const incremental = await periodSnapshot();
    const parties = await partySnapshot();
    await pool!.query(GL_PERIOD_BALANCES_REBUILD_SQL);
    await pool!.query(GL_PARTY_PERIOD_BALANCES_REBUILD_SQL);
    assert.deepEqual(await periodSnapshot(), incremental, 'period rows identical, updated_at included');
    assert.deepEqual(await partySnapshot(), parties, 'party rows identical, updated_at included');
  });
});
