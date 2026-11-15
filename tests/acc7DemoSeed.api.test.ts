/**
 * ACC-7 — the deterministic demo seed exercises the governance surface.
 *
 * A fresh schema plus every migration is seeded twice. The second pass must be
 * a no-op, and the resulting demo must contain the trade-group hierarchy,
 * custody accounts, party books, a real control difference, an unlinked
 * subledger row, a PSP settlement/fee row and a full close checklist.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import { createThrowawayDatabase, dropThrowawayDatabase, type ThrowawayDatabase } from './fixtures/throwawayDatabase';
import { runSchemaMigrations } from '../server/src/boot/migrations';
import { applyVerificationSeed } from '../scripts/seed/applyVerificationSeed';
import { buildVerificationDataset } from '../scripts/seed/verificationDataset';

dotenv.config();

const DEMO_DB = 'inventory_acc7_demo_test';
const schemaSql = fs.readFileSync(path.join(process.cwd(), 'scripts/schema.sql'), 'utf8');
const migrationsDir = path.join(process.cwd(), 'scripts', 'migrations');

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

async function snapshot(pool: pg.Pool) {
  const one = async (sql: string, params: any[] = []) =>
    Number((await pool.query(sql, params)).rows[0]?.count || 0);
  return {
    groups: await one('SELECT COUNT(*)::int AS count FROM gl_account_groups'),
    accounts: await one('SELECT COUNT(*)::int AS count FROM gl_accounts'),
    books: await one('SELECT COUNT(*)::int AS count FROM gl_subledgers'),
    subledgerRows: await one('SELECT COUNT(*)::int AS count FROM gl_subledger_entries'),
    settlements: await one('SELECT COUNT(*)::int AS count FROM payment_settlements'),
    checklist: await one('SELECT COUNT(*)::int AS count FROM gl_close_checklist_items'),
    journals: await one('SELECT COUNT(*)::int AS count FROM gl_journals'),
  };
}

describe('ACC-7 demo seed', { skip: skipNoDb }, () => {
  let demo: ThrowawayDatabase | null = null;

  before(async () => {
    demo = await createThrowawayDatabase(process.env.DATABASE_URL!, DEMO_DB);
    const client = await demo.pool.connect();
    try {
      await runSchemaMigrations(client as any, { baselineSql: schemaSql, migrationsDir });
    } finally {
      client.release();
    }
  });

  after(async () => {
    if (demo) await dropThrowawayDatabase(demo.adminPool, DEMO_DB);
  });

  test('seeds the governance surface deterministically and repeatably', async () => {
    const dataset = buildVerificationDataset();
    await applyVerificationSeed(demo!.pool as any, dataset);

    // NFRS files the trade controls straight into the statement sections
    // (2110 receivables under current assets, 5010 payables under current
    // liabilities); the section is the group and the account code is the
    // standard's own reference.
    const groups = (
      await demo!.pool.query(
        `SELECT code, name, statement_group AS "statementGroup" FROM gl_account_groups
          WHERE code IN ('2000','5000') ORDER BY code`
      )
    ).rows;
    assert.deepEqual(groups.map((row) => row.code), ['2000', '5000']);
    assert.equal(groups[0].name, 'Current Assets');
    assert.equal(groups[1].name, 'Current Liabilities');
    assert.deepEqual(groups.map((row) => row.statementGroup), ['CURRENT_ASSET', 'CURRENT_LIABILITY']);

    const controls = (
      await demo!.pool.query(
        `SELECT a.code, g.code AS "groupCode" FROM gl_accounts a
           JOIN gl_account_groups g ON g.id = a.group_id
          WHERE a.code IN ('2110','5010') ORDER BY a.code`
      )
    ).rows;
    assert.deepEqual(controls, [
      { code: '2110', groupCode: '2000' },
      { code: '5010', groupCode: '5000' },
    ]);

    const custody = (
      await demo!.pool.query(
        `SELECT code, account_kind AS "kind", branch_id AS "branchId"
           FROM gl_accounts WHERE code IN ('2320','2321','2322','2323','9030','9040','9050','2311','2312','2313','2314')
          ORDER BY code`
      )
    ).rows;
    assert.equal(custody.filter((row) => row.kind === 'BANK').length, 4, 'four banks');
    assert.equal(custody.filter((row) => row.kind === 'WALLET').length, 3, 'three wallet clearings');
    assert.equal(custody.filter((row) => row.kind === 'CASH' && row.branchId).length, 4, 'one till per branch');

    assert.ok(
      Number((await demo!.pool.query('SELECT COUNT(*)::int AS count FROM gl_subledgers WHERE party_id IS NOT NULL')).rows[0].count) > 0,
      'demo must carry party books, not only general books'
    );

    const health = (
      await demo!.pool.query(
        `SELECT COUNT(*)::int AS count FROM gl_subledger_entries WHERE subledger_id IS NULL`
      )
    ).rows[0].count;
    assert.equal(Number(health), 1, 'one deliberate unlinked row makes the health report visible');

    const difference = (
      await demo!.pool.query(
        `SELECT ABS(COALESCE(SUM(l.debit - l.credit), 0))::numeric AS difference
           FROM gl_journal_lines l JOIN gl_journals j ON j.id = l.journal_id AND j.journal_date_ad = l.journal_date_ad
          WHERE l.account_id = 'gla-2140' AND j.status = 'POSTED'`
      )
    ).rows[0].difference;
    assert.equal(Number(difference), 100, 'the employee-advance control has a visible tie-out difference');

    const settlement = (
      await demo!.pool.query(
        `SELECT gross_amount AS gross, fee_amount AS fee, net_amount AS net
           FROM payment_settlements WHERE id = 'demo-settlement-esewa-1'`
      )
    ).rows[0];
    assert.equal(Number(settlement.gross), 2525);
    assert.equal(Number(settlement.fee), 25);
    assert.equal(Number(settlement.net), 2500);

    const periods = Number((await demo!.pool.query('SELECT COUNT(*)::int AS count FROM gl_periods')).rows[0].count);
    const checklist = Number(
      (await demo!.pool.query('SELECT COUNT(*)::int AS count FROM gl_close_checklist_items')).rows[0].count
    );
    assert.equal(checklist, periods * 7, 'every demo period gets the full seven-task checklist');
    const codes = (
      await demo!.pool.query(
        `SELECT DISTINCT task_code AS "taskCode" FROM gl_close_checklist_items WHERE required ORDER BY task_code`
      )
    ).rows.map((row) => row.taskCode);
    assert.ok(codes.includes('INVENTORY_RECONCILE'));
    assert.ok(codes.includes('PSP_RECONCILE'));

    const first = await snapshot(demo!.pool);
    await applyVerificationSeed(demo!.pool as any, dataset);
    assert.deepEqual(await snapshot(demo!.pool), first, 'a repeated demo seed must not duplicate rows');
  });
});
