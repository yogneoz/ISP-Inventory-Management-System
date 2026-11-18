/**
 * SCALE-3 — the page-read index pass (migration 0040).
 *
 * Every register pages newest-first on `(created_at, id)` (or `(entry_date_ad,
 * id)` for the subledger book), and those reads are branch-scoped. The old
 * composites stopped at the date column, so a keyset page still needed a Sort as
 * soon as two rows shared a timestamp. Migration 0040 adds the `id`
 * tie-breaker, replaces the three narrower indexes (each an exact prefix of its
 * replacement) and puts a BRIN on the append-only date columns.
 *
 * The volume measurement lives in `scripts/measure_page_read_indexes.mjs` and
 * must run against the scratch `_scale` database. These tests guard the shape
 * that measurement depends on, on whatever database is configured:
 *
 *   1. the three page composites exist with the `id` tie-breaker and the
 *      narrower indexes they replace are gone;
 *   2. the five BRIN indexes exist and are BRIN, not B-tree;
 *   3. a keyset page plan ordered by `(created_at DESC, id DESC)` uses an index
 *      scan and has no Sort node once sequential scans are off, and the subledger
 *      page does the same on `(entry_date_ad DESC, id DESC)`.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (index catalogue + plan)';

async function indexDefinition(name: string): Promise<string | null> {
  const result = await pool!.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [name]
  );
  return result.rows[0]?.indexdef ?? null;
}

async function indexAccessMethod(name: string): Promise<string | null> {
  const result = await pool!.query(
    `SELECT a.amname FROM pg_class c JOIN pg_am a ON a.oid = c.relam
      WHERE c.relname = $1 AND c.relkind = 'I'`,
    [name]
  );
  return result.rows[0]?.amname ?? null;
}

async function planFor(sql: string, params: unknown[] = []): Promise<string> {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    // The configured database is small, so the planner would rightly prefer a
    // scan (or a BRIN + sort) over a page index. Disabling the alternatives asks
    // the question these tests are about: can this index produce the page order
    // at all? On the fixture volume the planner picks it unaided — that is what
    // `scripts/measure_page_read_indexes.mjs` records.
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    await client.query('SET LOCAL enable_sort = off');
    const plan = await client.query(`EXPLAIN (COSTS OFF) ${sql}`, params);
    return plan.rows.map((row: any) => Object.values(row)[0]).join('\n');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('page-read indexes (SCALE-3, migration 0040)', () => {
  after(async () => {
    if (pool && dbReachable) await pool.end();
  });

  test('the page composites carry the id tie-breaker', { skip: skipNoDb }, async () => {
    const expected = [
      ['idx_sales_invoices_branch_page_id', 'sales_invoices', 'branch_id, created_at DESC, id DESC'],
      ['idx_stock_ops_branch_page_id', 'stock_operations', 'branch_id, created_at DESC, id DESC'],
      ['idx_audit_branch_timestamp_id', 'audit_logs', 'branch_id, timestamp_ad DESC, id DESC'],
      ['idx_gl_subledger_date_page', 'gl_subledger_entries', 'entry_date_ad DESC, id DESC'],
    ];
    for (const [name, table, columns] of expected) {
      const definition = await indexDefinition(name);
      assert.ok(definition, `${name} must exist`);
      assert.match(definition!, new RegExp(`ON ONLY public\\.${table} USING btree \\(${columns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    }
  });

  test('the narrower page indexes they replace are gone', { skip: skipNoDb }, async () => {
    for (const name of ['idx_sales_invoices_branch_page', 'idx_stock_ops_branch_page', 'idx_audit_branch_timestamp']) {
      assert.equal(await indexDefinition(name), null, `${name} was superseded and must be dropped`);
    }
  });

  test('the append-only date columns carry BRIN indexes', { skip: skipNoDb }, async () => {
    // `id` rides along as a second column so the derived partition-child names
    // cannot collide with the `(<date> DESC)` B-trees (see migration 0040).
    const expected = [
      ['idx_gl_journals_date_brin', 'gl_journals', 'journal_date_ad, id'],
      ['idx_gl_subledger_entry_date_brin', 'gl_subledger_entries', 'entry_date_ad, id'],
      ['idx_stock_ops_date_brin', 'stock_operations', 'date_ad, id'],
      ['idx_serial_log_created_brin', 'serial_log', 'created_at, id'],
      ['idx_sales_invoices_created_brin', 'sales_invoices', 'created_at, id'],
    ];
    for (const [name, table, column] of expected) {
      assert.equal(await indexAccessMethod(name), 'brin', `${name} must be a BRIN index`);
      const definition = await indexDefinition(name);
      assert.ok(definition, `${name} must exist`);
      assert.match(definition!, new RegExp(`ON ONLY public\\.${table} USING brin \\(${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    }
  });

  test('a keyset page is served in index order, without a sort', { skip: skipNoDb }, async () => {
    const branch = await pool!.query(
      `SELECT branch_id FROM sales_invoices WHERE branch_id IS NOT NULL LIMIT 1`
    );
    assert.ok(branch.rows.length > 0, 'the configured database holds at least one invoice with a branch');
    const page = await planFor(
      `SELECT id FROM sales_invoices WHERE branch_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 51`,
      [branch.rows[0].branch_id]
    );
    assert.match(page, /Index (Only )?Scan/, `expected an index scan:\n${page}`);
    assert.doesNotMatch(page, /Seq Scan/, 'the page must not fall back to a sequential scan');
    assert.doesNotMatch(page, /->\s+Sort/, 'the index must produce the page order, not a sort');
  });

  test('the subledger book page is served in index order, without a sort', { skip: skipNoDb }, async () => {
    const page = await planFor(
      `SELECT id FROM gl_subledger_entries
        WHERE entry_date_ad >= CURRENT_DATE - 365
        ORDER BY entry_date_ad DESC, id DESC LIMIT 51`
    );
    assert.match(page, /Index (Only )?Scan/, `expected an index scan:\n${page}`);
    assert.doesNotMatch(page, /->\s+Sort/, 'the composite must produce the page order');
  });
});
