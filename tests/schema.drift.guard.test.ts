/**
 * Schema-drift guard (regression test).
 *
 * PROVES, against the real application database, that every column of every
 * table in the live PostgreSQL schema is declared in scripts/schema.sql's
 * CREATE TABLE blocks — and vice versa — so a fresh database built from the
 * script can never silently diverge from a database the server has synced
 * and evolved. This is the regression guard for drift like
 * purchase_orders.status_override living only in an ALTER statement (now
 * fixed); if a future migration adds a column in dbBoot's runtime DDL or an
 * ad-hoc ALTER but forgets the CREATE TABLE block, this test fails with the
 * exact missing column named.
 *
 * Isolation: read-only against the application database (information_schema
 * queries only — no writes, no throwaway database, nothing created or
 * dropped). When no PostgreSQL is reachable the tests are skipped, so
 * environments without a database (CI, demo mode) stay green — this is an
 * integration guard, not a unit test.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const SCHEMA_SQL_PATH = path.resolve('scripts/schema.sql');

interface TableColumns {
  [table: string]: Set<string>;
}

/** Parse every CREATE TABLE IF NOT EXISTS block out of schema.sql. */
function parseSchemaSql(sqlText: string): TableColumns {
  const tables: TableColumns = {};
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sqlText)) !== null) {
    const name = m[1];
    const body = m[2];
    const cols = new Set<string>();
    for (const line of body.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('--')) continue;
      // Table-level constraints never introduce a column.
      if (/^(PRIMARY KEY|UNIQUE|CONSTRAINT|CHECK|FOREIGN KEY)/i.test(t)) continue;
      const cm = t.match(/^(\w+)\s+(.+?),?$/);
      if (cm && !['PRIMARY', 'UNIQUE', 'CONSTRAINT', 'FOREIGN', 'CHECK'].includes(cm[1].toUpperCase())) {
        cols.add(cm[1].toLowerCase());
      }
    }
    tables[name] = cols;
  }
  return tables;
}

describe('schema.sql vs live database drift guard', () => {
  let pool: pg.Pool | null = null;
  let dbReachable = false;

  before(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) return;
    try {
      pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2000 });
      const probe = await pool.query('SELECT 1');
      dbReachable = probe.rowCount === 1;
    } catch {
      dbReachable = false; // no DB reachable: tests below skip
    }
  });

  after(async () => {
    if (pool) await pool.end();
  });

  test('schema.sql exists and parses to the expected 30 tables', () => {
    const sqlText = fs.readFileSync(SCHEMA_SQL_PATH, 'utf8');
    const tables = parseSchemaSql(sqlText);
    assert.equal(Object.keys(tables).length, 30, 'schema.sql should declare exactly 30 tables');
  });

  test('every live database column is declared in a schema.sql CREATE TABLE block', async () => {
    if (!dbReachable || !pool) return; // skip without a reachable DB
    const sqlText = fs.readFileSync(SCHEMA_SQL_PATH, 'utf8');
    const schemaTables = parseSchemaSql(sqlText);

    const res = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`
    );
    const liveTables: TableColumns = {};
    for (const row of res.rows) {
      if (!liveTables[row.table_name]) liveTables[row.table_name] = new Set();
      liveTables[row.table_name].add(row.column_name.toLowerCase());
    }

    // 1. No table in the live DB may be absent from schema.sql.
    for (const table of Object.keys(liveTables).sort()) {
      assert.ok(
        schemaTables[table],
        `Table "${table}" exists in the live database but has no CREATE TABLE block in scripts/schema.sql — add it there.`
      );
      // 2. Every live column must appear in the CREATE TABLE block.
      for (const col of liveTables[table]) {
        assert.ok(
          schemaTables[table].has(col),
          `Column "${table}.${col}" exists in the live database but is missing from the "${table}" CREATE TABLE block in scripts/schema.sql (drift like the old status_override gap).`
        );
      }
      // 3. The CREATE TABLE block must not declare columns the live DB lacks.
      for (const col of schemaTables[table]) {
        assert.ok(
          liveTables[table].has(col),
          `Column "${table}.${col}" is declared in scripts/schema.sql but does not exist in the live database — remove it from schema.sql or add it to the runtime DDL.`
        );
      }
    }
    // 4. schema.sql must not declare tables the live DB lacks.
    for (const table of Object.keys(schemaTables).sort()) {
      assert.ok(
        liveTables[table],
        `Table "${table}" is declared in scripts/schema.sql but does not exist in the live database.`
      );
    }
  });
});
