/**
 * ACC-7 — a populated install upgrades to the fresh-install end state.
 *
 * The starting database is built from the schema at the commit immediately
 * before the ACC-2 custody slice (`1e9bbeb`), then given the shape a real
 * install would have: a chart the operator reorganised, posted AR detail with
 * no party book, and an existing open period. The current migration runner and
 * boot seeders are applied on top. The assertions cover the upgrade contract,
 * the replay contract, and schema parity with a database built fresh from
 * `scripts/schema.sql` plus every migration.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import { createThrowawayDatabase, dropThrowawayDatabase, type ThrowawayDatabase } from './fixtures/throwawayDatabase';
import { runSchemaMigrations } from '../server/src/boot/migrations';
import { ensureDefaultChart, ensureDefaultSubledgers } from '../server/src/services/accountingSeed.service';

dotenv.config();

const PRIOR_COMMIT = '1e9bbeb';
const PRIOR_DB = 'inventory_acc7_prior_test';
const FRESH_DB = 'inventory_acc7_fresh_test';

let dbReachable = false;
if (process.env.DATABASE_URL) {
  const probe = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
    dbReachable = true;
  } catch {
    dbReachable = false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const schemaSql = fs.readFileSync(path.join(process.cwd(), 'scripts/schema.sql'), 'utf8');
const migrationsDir = path.join(process.cwd(), 'scripts', 'migrations');

async function schemaSignature(pool: pg.Pool): Promise<Record<string, string[]>> {
  const tableRows = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`
  );
  const tables = tableRows.rows.map((row) => row.table_name);
  const columns = (
    await pool.query(
      `SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable
         FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`
    )
  ).rows.map((row) => Object.values(row)[0] as string);
  const constraints = (
    await pool.query(
      `SELECT c.relname || '.' || con.conname || ':' || con.contype::text
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
        WHERE c.relnamespace = 'public'::regnamespace
        ORDER BY 1`
    )
  ).rows.map((row) => Object.values(row)[0] as string);
  const indexes = (
    await pool.query(`SELECT indexname || ':' || indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1`)
  ).rows.map((row) => Object.values(row)[0] as string);
  const triggers = (
    await pool.query(
      `SELECT c.relname || '.' || t.tgname
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
        ORDER BY 1`
    )
  ).rows.map((row) => Object.values(row)[0] as string);
  // Month partitions are provisioned data-dependently (a converted ledger
  // creates a child only for the months its rows occupy), so which ones exist
  // says nothing about whether the upgrade and the fresh install agree on the
  // schema. Their shape is verified by the fresh-install comparison script and
  // the partition tests instead.
  const provisionedChild = /_\d{6}(?:[._:]|$)/;
  const schemaOnly = (entries: string[]) => entries.filter((entry) => !provisionedChild.test(entry));
  return {
    tables: schemaOnly(tables),
    columns: schemaOnly(columns),
    constraints: schemaOnly(constraints),
    indexes: schemaOnly(indexes),
    triggers: schemaOnly(triggers),
  };
}

async function snap(pool: pg.Pool) {
  return {
    arGroup: (
      await pool.query(
        `SELECT g.code FROM gl_accounts a JOIN gl_account_groups g ON g.id = a.group_id WHERE a.code = '1100'`
      )
    ).rows[0]?.code,
    apGroup: (
      await pool.query(
        `SELECT g.code FROM gl_accounts a JOIN gl_account_groups g ON g.id = a.group_id WHERE a.code = '2100'`
      )
    ).rows[0]?.code,
    tradeGroups: (
      await pool.query(
        `SELECT code, parent_id AS "parentId" FROM gl_account_groups WHERE code IN ('1110','2110') ORDER BY code`
      )
    ).rows,
    partyBook: (
      await pool.query(
        `SELECT COUNT(*)::int AS count FROM gl_subledgers
          WHERE main_account_id = 'gla-1100' AND party_id = 'CUST-PRIOR'`
      )
    ).rows[0].count,
    books: Number((await pool.query('SELECT COUNT(*)::int AS count FROM gl_subledgers')).rows[0].count),
    checklist: (
      await pool.query(
        `SELECT task_code AS "taskCode", required FROM gl_close_checklist_items
          WHERE period_id = 'period-prior' ORDER BY task_code`
      )
    ).rows,
    checklistCount: Number(
      (await pool.query('SELECT COUNT(*)::int AS count FROM gl_close_checklist_items')).rows[0].count
    ),
    walletAccounts: (
      await pool.query(`SELECT code FROM gl_accounts WHERE code IN ('1030','1040','1050') ORDER BY code`)
    ).rows.map((row) => row.code),
  };
}

describe('ACC-7 existing-install upgrade', { skip: skipNoDb }, () => {
  let prior: ThrowawayDatabase | null = null;
  let fresh: ThrowawayDatabase | null = null;

  before(async () => {
    const base = process.env.DATABASE_URL!;
    prior = await createThrowawayDatabase(base, PRIOR_DB);
    fresh = await createThrowawayDatabase(base, FRESH_DB);
  });

  after(async () => {
    if (prior) await dropThrowawayDatabase(prior.adminPool, PRIOR_DB);
    if (fresh) await dropThrowawayDatabase(fresh.adminPool, FRESH_DB);
  });

  test('upgrades data, backfills books and tasks, and replays without change', async () => {
    const priorSchema = execFileSync('git', ['show', `${PRIOR_COMMIT}:scripts/schema.sql`], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.ok(priorSchema.length > 100_000, 'the prior schema must come from git history');

    await prior!.pool.query('DROP SCHEMA public CASCADE');
    await prior!.pool.query('CREATE SCHEMA public');
    await prior!.pool.query(priorSchema);

    // A realistic pre-upgrade install: operator moved AP into its own group,
    // AR is still in the root assets group, one customer has posted detail,
    // and an open period already exists.
    await prior!.pool.query(`
      INSERT INTO branches (id, code, name, location, active, allow_procurement, allow_warehouse_transfer, is_demo)
      VALUES ('BR-OLD', 'OLD', 'Prior Install Branch', 'Kathmandu', TRUE, TRUE, TRUE, FALSE);

      INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed, is_demo)
      VALUES ('fy-old', '2083-84', '2026-07-17', '2027-07-16', '2083-04-01 BS', '2084-03-32 BS', TRUE, FALSE, FALSE);

      INSERT INTO gl_periods (id, fiscal_year_id, period_key, start_date_ad, start_date_bs, end_date_ad, end_date_bs, status)
      VALUES ('period-prior', 'fy-old', '2026-10', '2026-10-01', '2083-06-15 BS', '2026-10-31', '2083-07-14 BS', 'OPEN');

      INSERT INTO gl_account_groups (id, code, name, account_type, statement_group, normal_balance, sort_order, is_active, is_demo)
      VALUES
        ('group-root-assets', '1000', 'Current Assets', 'ASSET', 'CURRENT_ASSET', 'DEBIT', 10, TRUE, FALSE),
        ('group-root-liab', '2000', 'Current Liabilities', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT', 20, TRUE, FALSE),
        ('group-operator', '9000', 'Operator Receivables & Payables', 'ASSET', 'CURRENT_ASSET', 'DEBIT', 15, TRUE, FALSE);

      INSERT INTO gl_accounts (id, code, name, group_id, is_control, subledger_type, posting_role, account_kind, is_active, is_demo)
      VALUES
        ('gla-1100', '1100', 'Accounts Receivable', 'group-root-assets', TRUE, 'CUSTOMER', 'AR_CONTROL', 'OTHER', TRUE, FALSE),
        ('gla-2100', '2100', 'Accounts Payable', 'group-operator', TRUE, 'SUPPLIER', 'AP_CONTROL', 'OTHER', TRUE, FALSE),
        ('gla-4000', '4000', 'Sales Revenue', 'group-root-assets', FALSE, 'NONE', 'SALES', 'OTHER', TRUE, FALSE);

      INSERT INTO gl_journals (id, journal_no, journal_date_ad, journal_date_bs, fiscal_year_id, period_id, branch_id, source_type, source_id, memo, status, posted_by, is_demo)
      VALUES ('journal-prior', 'PRIOR-JV-1', '2026-10-20', '2083-07-03 BS', 'fy-old', 'period-prior', 'BR-OLD', 'SALES_INVOICE', 'prior-invoice-1', 'Prior install receivable', 'POSTED', 'prior-admin', FALSE);

      INSERT INTO gl_journal_lines (id, journal_id, journal_date_ad, journal_date_bs, line_no, account_id, branch_id, debit, credit, memo)
      VALUES
        ('line-prior-ar', 'journal-prior', '2026-10-20', '2083-07-03 BS', 1, 'gla-1100', 'BR-OLD', 500, 0, 'Customer receivable'),
        ('line-prior-sales', 'journal-prior', '2026-10-20', '2083-07-03 BS', 2, 'gla-4000', 'BR-OLD', 0, 500, 'Sales revenue');

      INSERT INTO gl_subledger_entries (id, journal_id, journal_line_id, account_id, subledger_type, party_id, party_name, branch_id, entry_date_ad, entry_date_bs, debit, credit)
      VALUES ('sub-prior-1', 'journal-prior', 'line-prior-ar', 'gla-1100', 'CUSTOMER', 'CUST-PRIOR', 'Prior Customer', 'BR-OLD', '2026-10-20', '2083-07-03 BS', 500, 0);
    `);

    const priorClient = await prior!.pool.connect();
    let applied: string[] = [];
    try {
      const run = await runSchemaMigrations(priorClient as any, { baselineSql: schemaSql, migrationsDir });
      applied = run.applied;
      assert.ok(applied.some((version) => version.startsWith('0016_')), `0016 must run: ${applied.join(', ')}`);
      await ensureDefaultChart(priorClient as any);
      await ensureDefaultSubledgers(priorClient as any);
    } finally {
      priorClient.release();
    }

    const upgraded = await snap(prior!.pool);
    assert.equal(upgraded.arGroup, '1110', 'AR still in the default root moves under Trade Receivables');
    assert.equal(upgraded.apGroup, '9000', 'the operator reorganisation of AP is preserved');
    assert.deepEqual(
      upgraded.tradeGroups.map((group: any) => group.code),
      ['1110', '2110']
    );
    assert.equal(upgraded.partyBook, 1, 'the posted party gets a backfilled book');
    assert.ok(upgraded.books >= 3, 'default controls and the party book exist');
    assert.deepEqual(upgraded.walletAccounts, ['1030', '1040', '1050']);
    const taskCodes = upgraded.checklist.map((task: any) => task.taskCode);
    assert.ok(taskCodes.includes('INVENTORY_RECONCILE'));
    assert.ok(taskCodes.includes('PSP_RECONCILE'));
    assert.ok(
      upgraded.checklist.every((task: any) => task.required || task.taskCode === 'LOCK_PERIOD'),
      'every task except the final optional lock is required'
    );

    // Replay: the runner records nothing twice, and the data snapshot is
    // byte-for-byte unchanged, including the close checklist.
    const replayClient = await prior!.pool.connect();
    try {
      const replay = await runSchemaMigrations(replayClient as any, { baselineSql: schemaSql, migrationsDir });
      assert.deepEqual(replay.applied, [], 'an already-upgraded database applies no migration twice');
      await ensureDefaultChart(replayClient as any);
      await ensureDefaultSubledgers(replayClient as any);
    } finally {
      replayClient.release();
    }
    assert.deepEqual(await snap(prior!.pool), upgraded, 'replaying the upgrade must not change data');

    // Fresh install reaches the same schema signature.
    const freshClient = await fresh!.pool.connect();
    try {
      await runSchemaMigrations(freshClient as any, { baselineSql: schemaSql, migrationsDir });
    } finally {
      freshClient.release();
    }
    const priorSignature = await schemaSignature(prior!.pool);
    const freshSignature = await schemaSignature(fresh!.pool);
    const schemaDiff: Record<string, { onlyUpgraded: string[]; onlyFresh: string[] }> = {};
    for (const key of Object.keys(freshSignature) as (keyof typeof freshSignature)[]) {
      const upgradedSet = new Set(priorSignature[key]);
      const freshSet = new Set(freshSignature[key]);
      const onlyUpgraded = priorSignature[key].filter((entry) => !freshSet.has(entry));
      const onlyFresh = freshSignature[key].filter((entry) => !upgradedSet.has(entry));
      if (onlyUpgraded.length || onlyFresh.length) schemaDiff[key] = { onlyUpgraded, onlyFresh };
    }
    assert.deepEqual(schemaDiff, {}, 'upgraded schema must match a fresh install');
  });
});
