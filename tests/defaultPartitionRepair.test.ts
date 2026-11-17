/**
 * Worklist A5 — a dirty DEFAULT partition has a repair path.
 *
 * Rows in `gl_journals_default` / `gl_journal_lines_default` cannot be pruned and
 * make PostgreSQL refuse to attach a monthly child for a month `DEFAULT` already
 * holds rows in. Before this slice the code detected that state and could not
 * fix it. The repair detaches both DEFAULT children, provisions the months the
 * rows belong to with the same function the posting path uses, reinserts them
 * through the parent, and reattaches DEFAULT — in one transaction, deleting
 * nothing.
 *
 * PROVES, against a throwaway database built from `scripts/schema.sql`:
 *   1. the rows really land in DEFAULT (the test's starting state);
 *   2. a plan run reports the month and moves nothing;
 *   3. the repair moves the journal and its line into the month child, leaves
 *      DEFAULT empty, keeps the registry row single, and re-enables the
 *      registry-sync triggers it had to disable for the reinsert;
 *   4. a second run is a no-op ("clean"), so a retry cannot double-write.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import { repairDefaultPartitions } from '../server/src/boot/journalPartitionRepair';
import { defaultPartitionIsDirty, journalPartitionStatus } from '../server/src/boot/journalPartitions';

dotenv.config();

const ROOT = path.resolve('.');
const SCHEMA_SQL = fs.readFileSync(path.join(ROOT, 'scripts', 'schema.sql'), 'utf8');
const BASE_URL = process.env.DATABASE_URL;
const TEST_DB = 'inventory_default_repair_test';

function withDbName(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

let admin: pg.Client | null = null;
let client: pg.Client | null = null;
let reachable = false;
if (BASE_URL) {
  const probe = new pg.Client({ connectionString: BASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
    reachable = true;
  } catch {
    reachable = false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}
const skipNoDb = !reachable && 'needs a reachable PostgreSQL (partition DDL)';

const DIRTY_MONTH = '201908';

describe('dirty DEFAULT partition repair (A5)', { skip: skipNoDb }, () => {
  before(async () => {
    assert.ok(BASE_URL);
    admin = new pg.Client({ connectionString: withDbName(BASE_URL, 'postgres') });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB]
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    client = new pg.Client({ connectionString: withDbName(BASE_URL, TEST_DB) });
    await client.connect();
    await client.query(SCHEMA_SQL);
    // A journal dated a month that has no child yet: PostgreSQL routes it to the
    // DEFAULT catch-all, which is the state this slice repairs.
    await client.query(`
      INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs)
      VALUES ('fy-a5', 'FY2080', '2019-07-17', '2020-07-15', '2080-04-01', '2081-03-31');
      INSERT INTO gl_periods (id, fiscal_year_id, period_key, start_date_ad, end_date_ad, start_date_bs, end_date_bs)
      VALUES ('per-a5', 'fy-a5', '2019-08', '2019-07-17', '2019-08-16', '2080-04-01', '2080-04-31');
      INSERT INTO branches (id, code, name, location) VALUES ('BR-A5', 'A5', 'Repair probe', 'Kathmandu');
      INSERT INTO gl_account_groups (id, code, name, account_type, statement_group, normal_balance)
      VALUES ('grp-a5', '9900', 'Repair probe group', 'ASSET', 'CURRENT_ASSET', 'DEBIT');
      INSERT INTO gl_accounts (id, code, name, group_id) VALUES ('acc-a5', '99000', 'Repair probe account', 'grp-a5');
      INSERT INTO gl_journals (id, journal_no, journal_date_ad, journal_date_bs, fiscal_year_id, period_id, branch_id)
      VALUES ('jrn-a5', 'JRN-A5', '2019-08-10', '2080-04-25', 'fy-a5', 'per-a5', 'BR-A5');
      INSERT INTO gl_journal_lines (id, journal_id, journal_date_ad, journal_date_bs, line_no, account_id, branch_id, debit)
      VALUES ('ln-a5', 'jrn-a5', '2019-08-10', '2080-04-25', 1, 'acc-a5', 'BR-A5', 100.00);
    `);
  });

  after(async () => {
    if (client) await client.end().catch(() => undefined);
    if (admin) {
      await admin
        .query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [TEST_DB]
        )
        .catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });

  const db = () => {
    assert.ok(client);
    return client as unknown as { query: (sql: string, params?: unknown[]) => Promise<any> };
  };

  test('the starting state is a dirty DEFAULT that reports the month', async () => {
    const status = await journalPartitionStatus(db() as any);
    assert.ok(defaultPartitionIsDirty(status), 'DEFAULT must hold the row for this test to mean anything');
    assert.equal(status.defaultRows?.journals, 1);
    assert.equal(status.defaultRows?.lines, 1);
    const inDefault = await db().query(`SELECT count(*)::int AS n FROM gl_journals_default`);
    assert.equal(inDefault.rows[0].n, 1, 'the journal is in DEFAULT, not in a month child');
  });

  test('a plan run names the month and moves nothing', async () => {
    const plan = await repairDefaultPartitions(db() as any);
    assert.equal(plan.reason, 'planned');
    assert.equal(plan.repaired, false);
    assert.deepEqual(plan.months, [DIRTY_MONTH]);
    assert.equal(plan.journalsMoved, 1);
    const stillDirty = await journalPartitionStatus(db() as any);
    assert.equal(stillDirty.defaultRows?.journals, 1, 'plan mode changes nothing');
  });

  test('the repair moves the journal and its line into the month and empties DEFAULT', async () => {
    const report = await repairDefaultPartitions(db() as any, { apply: true });
    assert.equal(report.reason, 'repaired');
    assert.equal(report.repaired, true);
    assert.equal(report.dirtyAfter?.journals, 0);
    assert.equal(report.dirtyAfter?.lines, 0);

    const month = await db().query(
      `SELECT count(*)::int AS journals,
              (SELECT count(*)::int FROM gl_journal_lines_${DIRTY_MONTH}) AS lines
         FROM gl_journals_${DIRTY_MONTH}`
    );
    assert.equal(month.rows[0].journals, 1, 'the journal is in its month partition');
    assert.equal(month.rows[0].lines, 1, 'its line moved with it');

    const registry = await db().query(`SELECT count(*)::int AS n FROM gl_journals_registry WHERE id = 'jrn-a5'`);
    assert.equal(registry.rows[0].n, 1, 'the registry row was not duplicated by the reinsert');

    // The registry trigger exists on the parent and is cloned onto every child,
    // so the check is scoped to the two parents the repair disabled.
    const triggers = await db().query(
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgrelid IN ('gl_journals'::regclass, 'gl_journal_lines'::regclass)
          AND tgname IN ('trg_gl_journals_registry_sync', 'trg_gl_journal_lines_registry_sync')
        ORDER BY tgname`
    );
    assert.equal(triggers.rows.length, 2);
    for (const row of triggers.rows) {
      assert.equal(row.tgenabled, 'O', `${row.tgname} must be enabled again after the repair`);
    }

    const defaults = await db().query(
      `SELECT (SELECT count(*)::int FROM gl_journals_default) AS journals,
              (SELECT count(*)::int FROM gl_journal_lines_default) AS lines`
    );
    assert.deepEqual(defaults.rows[0], { journals: 0, lines: 0 });
  });

  test('a second repair is a no-op', async () => {
    const again = await repairDefaultPartitions(db() as any, { apply: true });
    assert.equal(again.reason, 'clean');
    const month = await db().query(`SELECT count(*)::int AS n FROM gl_journals_${DIRTY_MONTH}`);
    assert.equal(month.rows[0].n, 1, 'nothing was rewritten');
  });
});
