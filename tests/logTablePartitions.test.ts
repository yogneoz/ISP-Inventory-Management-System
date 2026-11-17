import { purgeAuditLogs } from './support/purgeAuditLogs';
/**
 * Worklist A7 — the two high-volume log tables are monthly partitions whose
 * audit rows are append-only.
 *
 * These tests exist to fail if the partitioning or the guard is absent, and they
 * use a throwaway database built from scripts/schema.sql so they never depend on
 * the application database's history:
 *
 *   1. both tables are RANGE-partitioned by timestamp_ad with a DEFAULT child;
 *   2. a write routes to the month partition it belongs to, across two months,
 *      for BOTH tables (read back through tableoid, not the schema);
 *   3. an undated insert still succeeds (it lands in DEFAULT);
 *   4. UPDATE and DELETE on audit_logs are refused by the database, including a
 *      DELETE aimed straight at a child partition;
 *   5. the sanctioned purge switch (the one the ledger uses) still allows a
 *      deliberate removal, and the test-cleanup helper works;
 *   6. a populated, pre-A7 table converts with its rows preserved, and a second
 *      apply of the migration is a no-op.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  createThrowawayDatabase,
  dropThrowawayDatabase,
  withDbName,
  type ThrowawayDatabase,
} from './fixtures/throwawayDatabase';
import { ensureLogMonthPartition, resetEnsuredLogMonths } from '../server/src/boot/logPartitions';

const baseUrl = process.env.DATABASE_URL || '';
const skipNoDb = !baseUrl && 'needs DATABASE_URL for the throwaway database';

const MIGRATION = path.resolve('scripts/migrations/0032_log_table_partitions.sql');

let db: ThrowawayDatabase | null = null;

async function rejectMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (err: any) {
    return String(err?.message || err);
  }
}

async function relkind(pool: pg.Pool, table: string): Promise<string> {
  const res = await pool.query(
    `SELECT relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1`,
    [table]
  );
  return String(res.rows[0]?.relkind || '');
}

async function childOf(pool: pg.Pool, table: string, id: string): Promise<string> {
  const res = await pool.query(`SELECT tableoid::regclass::text AS child FROM ${table} WHERE id = $1`, [id]);
  return String(res.rows[0]?.child || '');
}

async function insertAudit(pool: pg.Pool, id: string, at: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (id, user_email, user_name, action, module, details, timestamp_ad, timestamp_bs)
     VALUES ($1, 'a7@test', 'A7', 'A7_TEST', 'SYSTEM', $2, $3, '2083-01-01')`,
    [id, `row ${id}`, at]
  );
}

async function insertTxn(pool: pg.Pool, id: string, at: string): Promise<void> {
  await pool.query(
    `INSERT INTO transaction_logs (id, transaction_number, change_type, quantity_before, quantity_changed,
                                   quantity_after, timestamp_ad, timestamp_bs)
     VALUES ($1, $2, 'MANUAL_ADJUSTMENT', 1, 1, 2, $3, '2083-01-01')`,
    [id, `TXN-${id}`, at]
  );
}

before(async () => {
  if (skipNoDb) return;
  db = await createThrowawayDatabase(baseUrl, 'inventory_a7_logs_test');
  resetEnsuredLogMonths();
});

after(async () => {
  if (!db) return;
  await db.pool.end().catch(() => undefined);
  await dropThrowawayDatabase(db.adminPool, 'inventory_a7_logs_test');
});

describe('log table partitions (A7)', () => {
  test('both log tables are partitioned with a DEFAULT child', { skip: skipNoDb }, async () => {
    assert.equal(await relkind(db!.pool, 'audit_logs'), 'p');
    assert.equal(await relkind(db!.pool, 'transaction_logs'), 'p');
    assert.equal(await relkind(db!.pool, 'audit_logs_default'), 'r');
    assert.equal(await relkind(db!.pool, 'transaction_logs_default'), 'r');
  });

  test('audit writes route to their month across two months', { skip: skipNoDb }, async () => {
    await ensureLogMonthPartition(db!.pool, 'audit_logs', '2026-08-05T10:00:00Z');
    await ensureLogMonthPartition(db!.pool, 'audit_logs', '2026-09-11T10:00:00Z');
    await insertAudit(db!.pool, 'a7-route-aug', '2026-08-05T10:00:00Z');
    await insertAudit(db!.pool, 'a7-route-sep', '2026-09-11T10:00:00Z');

    assert.equal(await childOf(db!.pool, 'audit_logs', 'a7-route-aug'), 'audit_logs_202608');
    assert.equal(await childOf(db!.pool, 'audit_logs', 'a7-route-sep'), 'audit_logs_202609');
  });

  test('transaction writes route to their month across two months', { skip: skipNoDb }, async () => {
    await ensureLogMonthPartition(db!.pool, 'transaction_logs', '2026-08-06T09:00:00Z');
    await ensureLogMonthPartition(db!.pool, 'transaction_logs', '2026-09-13T09:00:00Z');
    await insertTxn(db!.pool, 'a7-txn-aug', '2026-08-06T09:00:00Z');
    await insertTxn(db!.pool, 'a7-txn-sep', '2026-09-13T09:00:00Z');

    assert.equal(await childOf(db!.pool, 'transaction_logs', 'a7-txn-aug'), 'transaction_logs_202608');
    assert.equal(await childOf(db!.pool, 'transaction_logs', 'a7-txn-sep'), 'transaction_logs_202609');
  });

  test('a write with no date of its own still succeeds and lands in a partition', { skip: skipNoDb }, async () => {
    // "Undated" means the caller omits timestamp_ad: the column default supplies
    // it. The insert may not fail just because that month has no child yet — it
    // falls back to DEFAULT, which is the point of the catch-all.
    await db!.pool.query(
      `INSERT INTO audit_logs (id, user_email, user_name, action, module, details, timestamp_bs)
       VALUES ('a7-undated', 'a7@test', 'A7', 'A7_TEST', 'SYSTEM', 'no date', '2083-01-01')`
    );
    const child = await childOf(db!.pool, 'audit_logs', 'a7-undated');
    assert.ok(child.startsWith('audit_logs'), `unexpected child ${child}`);
  });

  test('the database refuses UPDATE and DELETE on audit rows', { skip: skipNoDb }, async () => {
    // The row has to be there: PostgreSQL fires no row trigger for a statement
    // that matches nothing, and a guard test that silently exercises zero rows
    // would pass on a table with no guard at all.
    await ensureLogMonthPartition(db!.pool, 'audit_logs', '2026-08-05T10:00:00Z');
    await insertAudit(db!.pool, 'a7-guard', '2026-08-05T10:00:00Z');
    const present = await db!.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE id = 'a7-guard'`);
    assert.equal(present.rows[0].n, 1);

    // scripts/run_tests.mjs hands every suite connection
    // `inventory.allow_ledger_purge=on` (the ledger suites need it), so this test
    // turns the switch off for its own session — otherwise it would measure the
    // escape hatch, not the guard.
    const client = await db!.pool.connect();
    try {
      await client.query(`SELECT set_config('inventory.allow_ledger_purge', 'off', false)`);

      const update = await rejectMessage(
        client.query(`UPDATE audit_logs SET action = 'TAMPERED' WHERE id = 'a7-guard'`)
      );
      assert.match(update, /append-only/i);

      const del = await rejectMessage(client.query(`DELETE FROM audit_logs WHERE id = 'a7-guard'`));
      assert.match(del, /append-only/i);

      // A child partition has its own trigger: a DELETE aimed at the child must
      // fail too, otherwise the guard is trivially bypassed.
      const childDel = await rejectMessage(
        client.query(`DELETE FROM audit_logs_202608 WHERE id = 'a7-guard'`)
      );
      assert.match(childDel, /append-only/i);
    } finally {
      await client.query(`SELECT set_config('inventory.allow_ledger_purge', 'on', false)`).catch(() => undefined);
      client.release();
    }

    assert.equal(await childOf(db!.pool, 'audit_logs', 'a7-guard'), 'audit_logs_202608');
  });

  test('the sanctioned purge switch still removes audit rows', { skip: skipNoDb }, async () => {
    await purgeAuditLogs(db!.pool, `DELETE FROM audit_logs WHERE id = 'a7-route-sep'`);
    const left = await db!.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE id = 'a7-route-sep'`);
    assert.equal(left.rows[0].n, 0);
    // transaction_logs has no append-only guard: its UPDATE path stays usable.
    await db!.pool.query(`UPDATE transaction_logs SET quantity_after = 3 WHERE id = 'a7-txn-aug'`);
  });

  test('a populated pre-A7 table converts with rows preserved, and a second apply is a no-op', { skip: skipNoDb }, async () => {
    const legacyUrl = withDbName(db!.url, 'inventory_a7_legacy_test');
    const legacy = await createThrowawayDatabase(baseUrl, 'inventory_a7_legacy_test');
    try {
      // Rebuild the two tables in their pre-A7 shape (plain, PK on id alone) and
      // seed rows in two months, which is what an existing install looks like.
      await legacy.pool.query('DROP TABLE audit_logs');
      await legacy.pool.query('DROP TABLE transaction_logs');
      await legacy.pool.query(`
        CREATE TABLE audit_logs (
          id VARCHAR(50) PRIMARY KEY,
          user_email VARCHAR(150) NOT NULL,
          user_name VARCHAR(150) NOT NULL,
          action VARCHAR(100) NOT NULL,
          module VARCHAR(50) NOT NULL,
          details TEXT,
          timestamp_ad TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          timestamp_bs VARCHAR(20),
          branch_id VARCHAR(50),
          fiscal_year_id VARCHAR(50),
          is_demo BOOLEAN NOT NULL DEFAULT FALSE
        )
      `);
      await legacy.pool.query(`
        CREATE TABLE transaction_logs (
          id VARCHAR(100) PRIMARY KEY,
          transaction_number VARCHAR(100) NOT NULL,
          product_id VARCHAR(50),
          product_sku VARCHAR(100),
          product_name VARCHAR(255),
          branch_id VARCHAR(50),
          change_type VARCHAR(50) NOT NULL,
          quantity_before INT NOT NULL,
          quantity_changed INT NOT NULL,
          quantity_after INT NOT NULL,
          unit_cost NUMERIC(12, 2) DEFAULT 0.00,
          reference_doc_id VARCHAR(100),
          timestamp_ad TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          timestamp_bs VARCHAR(20),
          fiscal_year_id VARCHAR(50),
          is_demo BOOLEAN NOT NULL DEFAULT FALSE,
          created_by VARCHAR(150)
        )
      `);
      await legacy.pool.query(`
        INSERT INTO audit_logs (id, user_email, user_name, action, module, details, timestamp_ad, timestamp_bs)
        VALUES ('legacy-a1', 'a@b', 'L', 'OLD', 'SYSTEM', 'aug', '2026-08-01T00:00:00Z', '2083-01-01'),
               ('legacy-a2', 'a@b', 'L', 'OLD', 'SYSTEM', 'sep', '2026-09-01T00:00:00Z', '2083-01-01'),
               ('legacy-a3', 'a@b', 'L', 'OLD', 'SYSTEM', 'sep', '2026-09-02T00:00:00Z', '2083-01-01')
      `);
      await legacy.pool.query(`
        INSERT INTO transaction_logs (id, transaction_number, change_type, quantity_before, quantity_changed,
                                      quantity_after, timestamp_ad, timestamp_bs)
        VALUES ('legacy-t1', 'OLD-1', 'MANUAL_ADJUSTMENT', 0, 1, 1, '2026-08-01T00:00:00Z', '2083-01-01'),
               ('legacy-t2', 'OLD-2', 'MANUAL_ADJUSTMENT', 1, 1, 2, '2026-09-01T00:00:00Z', '2083-01-01')
      `);

      const before = await legacy.pool.query(
        `SELECT (SELECT count(*)::int FROM audit_logs) AS audit, (SELECT count(*)::int FROM transaction_logs) AS txn`
      );

      const migrationSql = fs.readFileSync(MIGRATION, 'utf8');
      await legacy.pool.query(migrationSql);
      const after = await legacy.pool.query(
        `SELECT (SELECT count(*)::int FROM audit_logs) AS audit, (SELECT count(*)::int FROM transaction_logs) AS txn`
      );
      assert.equal(after.rows[0].audit, before.rows[0].audit);
      assert.equal(after.rows[0].txn, before.rows[0].txn);
      assert.equal(await relkind(legacy.pool, 'audit_logs'), 'p');
      assert.equal(await childOf(legacy.pool, 'audit_logs', 'legacy-a1'), 'audit_logs_202608');
      assert.equal(await childOf(legacy.pool, 'audit_logs', 'legacy-a2'), 'audit_logs_202609');
      assert.equal(await childOf(legacy.pool, 'transaction_logs', 'legacy-t1'), 'transaction_logs_202608');
      assert.equal(await childOf(legacy.pool, 'transaction_logs', 'legacy-t2'), 'transaction_logs_202609');

      // Second apply: no rows move, no error.
      await legacy.pool.query(migrationSql);
      const twice = await legacy.pool.query(
        `SELECT (SELECT count(*)::int FROM audit_logs) AS audit, (SELECT count(*)::int FROM transaction_logs) AS txn`
      );
      assert.deepEqual(twice.rows[0], after.rows[0]);
    } finally {
      await legacy.pool.end().catch(() => undefined);
      await dropThrowawayDatabase(legacy.adminPool, 'inventory_a7_legacy_test');
      void legacyUrl;
    }
  });
});
