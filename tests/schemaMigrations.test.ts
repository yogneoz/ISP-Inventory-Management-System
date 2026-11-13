/**
 * Phase 0A: the schema migration runner must establish a baseline exactly once,
 * adopt an already-current database without re-running every DDL statement, and
 * apply numbered files in order. These tests own throwaway databases and never
 * touch the application database.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import { BASELINE_VERSION, runSchemaMigrations } from '../server/src/boot/migrations';

dotenv.config();

const ROOT = path.resolve('.');
const SCHEMA_SQL = fs.readFileSync(path.join(ROOT, 'scripts', 'schema.sql'), 'utf8');
const BASE_URL = process.env.DATABASE_URL;
const TEST_DB = 'inventory_schema_migrations_test';
const ADOPT_DB = 'inventory_schema_migrations_adopt_test';
const MIGRATIONS_DIR = path.join(ROOT, 'tests', `.tmp-migrations-${process.pid}`);

function withDbName(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

let admin: pg.Client | null = null;
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
const skipNoDb = !reachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

async function recreateDatabase(name: string): Promise<pg.Client> {
  assert.ok(admin);
  assert.ok(BASE_URL);
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name]
  );
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const client = new pg.Client({ connectionString: withDbName(BASE_URL, name) });
  await client.connect();
  return client;
}

describe('schema migration runner', { skip: skipNoDb }, () => {
  before(async () => {
    assert.ok(BASE_URL);
    admin = new pg.Client({ connectionString: withDbName(BASE_URL, 'postgres') });
    await admin.connect();
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(MIGRATIONS_DIR, '0002_phase0a_probe.sql'),
      'CREATE TABLE phase0a_probe (id INTEGER PRIMARY KEY);\n'
    );
  });

  after(async () => {
    fs.rmSync(MIGRATIONS_DIR, { recursive: true, force: true });
    if (admin) {
      for (const name of [TEST_DB, ADOPT_DB]) {
        await admin
          .query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [name]
          )
          .catch(() => undefined);
        await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
    }
  });

  test('applies the baseline once and then each numbered migration exactly once', async () => {
    const client = await recreateDatabase(TEST_DB);
    try {
      const first = await runSchemaMigrations(client as any, {
        baselineSql: SCHEMA_SQL,
        migrationsDir: MIGRATIONS_DIR,
      });
      assert.equal(first.baselineSource, 'BASELINE');
      assert.deepEqual(first.applied, ['0002_phase0a_probe']);
      assert.equal(first.currentVersion, '0002_phase0a_probe');

      const probe = await client.query(`SELECT to_regclass('public.phase0a_probe') AS table_name`);
      assert.equal(probe.rows[0].table_name, 'phase0a_probe');

      const ledger = await client.query(
        'SELECT version, source FROM schema_migrations ORDER BY version'
      );
      assert.deepEqual(ledger.rows, [
        { version: BASELINE_VERSION, source: 'BASELINE' },
        { version: '0002_phase0a_probe', source: 'MIGRATION' },
      ]);

      const second = await runSchemaMigrations(client as any, {
        baselineSql: SCHEMA_SQL,
        migrationsDir: MIGRATIONS_DIR,
      });
      assert.equal(second.baselineSource, null);
      assert.deepEqual(second.applied, []);
      assert.equal(second.currentVersion, '0002_phase0a_probe');
    } finally {
      await client.end();
    }
  });

  test('adopts an existing current schema without applying the baseline DDL again', async () => {
    const client = await recreateDatabase(ADOPT_DB);
    try {
      await client.query(SCHEMA_SQL);
      const result = await runSchemaMigrations(client as any, {
        baselineSql: SCHEMA_SQL,
        migrationsDir: null,
      });

      assert.equal(result.baselineSource, 'ADOPTED');
      assert.deepEqual(result.applied, []);
      assert.equal(result.currentVersion, BASELINE_VERSION);

      const probe = await client.query(`SELECT to_regclass('public.phase0a_probe') AS table_name`);
      assert.equal(probe.rows[0].table_name, null, 'adoption must not run the numbered file');
      const row = await client.query(
        'SELECT source FROM schema_migrations WHERE version = $1',
        [BASELINE_VERSION]
      );
      assert.equal(row.rows[0].source, 'ADOPTED');
    } finally {
      await client.end();
    }
  });
});
