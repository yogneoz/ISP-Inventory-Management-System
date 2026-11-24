/**
 * `npm run setup:pg` must never leave a database that cannot boot.
 *
 * The failure these tests pin is the one that bit this workstation: the schema
 * pass committed, the migration recorder stopped on an older migration's CHECK
 * because rows seeded by an earlier run already carried a newer value, and the
 * ledger named a version behind the schema. Boot then replayed that migration
 * against the seeded rows and failed.
 *
 * Two properties are proven against throwaway databases:
 *   1. the reset is one transaction — a migration that fails mid-run rolls back
 *      the wipe and the schema too, so the database is unchanged;
 *   2. a ledger stopped behind a validation CHECK is completed after the wipe,
 *      because the wipe runs before migrations replay.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  BASELINE_VERSION,
  neutralizeOuterTransactionControl,
  runSchemaMigrations,
} from '../server/src/boot/migrations';
import { resetSchema } from '../scripts/seed/resetSchema';

dotenv.config();

const ROOT = path.resolve('.');
const SCHEMA_SQL = fs.readFileSync(path.join(ROOT, 'scripts', 'schema.sql'), 'utf8');
const BASE_URL = process.env.DATABASE_URL;
const ATOMIC_DB = 'inventory_schema_reset_atomic_test';
const REPAIR_DB = 'inventory_schema_reset_repair_test';
const ATOMIC_DIR = path.join(ROOT, 'tests', `.tmp-reset-atomic-${process.pid}`);
const REPAIR_DIR = path.join(ROOT, 'tests', `.tmp-reset-repair-${process.pid}`);

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

function writeMigration(dir: string, name: string, sql: string): void {
  fs.writeFileSync(path.join(dir, name), sql);
}

describe('transactional schema reset', { skip: skipNoDb }, () => {
  before(async () => {
    assert.ok(BASE_URL);
    admin = new pg.Client({ connectionString: withDbName(BASE_URL, 'postgres') });
    await admin.connect();
    fs.mkdirSync(ATOMIC_DIR, { recursive: true });
    fs.mkdirSync(REPAIR_DIR, { recursive: true });
    // The first numbered step every scenario shares: idempotent, like a real
    // migration, so a reset that truncates the ledger can replay it.
    writeMigration(
      ATOMIC_DIR,
      '0002_reset_probe.sql',
      'CREATE TABLE IF NOT EXISTS reset_probe (id INTEGER PRIMARY KEY, kind VARCHAR(10) NOT NULL);\n'
    );
    writeMigration(
      ATOMIC_DIR,
      '0003_reset_boom.sql',
      'INSERT INTO reset_probe (id, kind) VALUES (1, \'OK\');\n' +
        'INSERT INTO reset_probe (id, kind) VALUES (1, \'OK\');\n'
    );
    writeMigration(
      REPAIR_DIR,
      '0002_reset_probe.sql',
      'CREATE TABLE IF NOT EXISTS reset_probe (id INTEGER PRIMARY KEY, kind VARCHAR(10) NOT NULL);\n'
    );
  });

  after(async () => {
    fs.rmSync(ATOMIC_DIR, { recursive: true, force: true });
    fs.rmSync(REPAIR_DIR, { recursive: true, force: true });
    if (admin) {
      for (const name of [ATOMIC_DB, REPAIR_DB]) {
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

  test("a migration's own BEGIN/COMMIT is neutralised in the reset, and only there", () => {
    const wrapped = "BEGIN;\nCREATE TABLE reset_wrapped (id INTEGER PRIMARY KEY);\nCOMMIT;\n";
    const neutralised = neutralizeOuterTransactionControl(wrapped);
    assert.doesNotMatch(neutralised, /^COMMIT;/m);
    assert.match(neutralised, /^CREATE TABLE reset_wrapped/m);

    // A dollar-quoted body keeps its text: this is a function, not a reset step.
    const body =
      "CREATE OR REPLACE FUNCTION reset_f() RETURNS void AS $$\nBEGIN\n  PERFORM 1;\nEND;\n$$ LANGUAGE plpgsql;\n";
    assert.equal(neutralizeOuterTransactionControl(body), body);
  });

  test('a migration that fails mid-reset rolls back the wipe, the schema and the ledger', async () => {
    const client = await recreateDatabase(ATOMIC_DB);
    try {
      await client.query(SCHEMA_SQL);
      await client.query('CREATE TABLE reset_keeper (id INTEGER PRIMARY KEY, note TEXT)');
      await client.query("INSERT INTO reset_keeper (id, note) VALUES (1, 'before the reset')");

      await assert.rejects(
        resetSchema(client as any, { baselineSql: SCHEMA_SQL, migrationsDir: ATOMIC_DIR, wipe: true }),
        /duplicate key/
      );

      const keeper = await client.query('SELECT note FROM reset_keeper');
      assert.deepEqual(
        keeper.rows,
        [{ note: 'before the reset' }],
        'the wipe must roll back with the failed migration pass'
      );
      const probe = await client.query(`SELECT to_regclass('public.reset_probe') AS table_name`);
      assert.equal(probe.rows[0].table_name, null, 'no part of the failed migration survives');
      // schema.sql itself declares the ledger table, so it survives the rollback
      // along with the rest of the old schema; what must not survive is a row.
      const ledger = await client.query('SELECT count(*)::int AS recorded FROM schema_migrations');
      assert.equal(ledger.rows[0].recorded, 0, 'no ledger row may outlive a failed reset');
    } finally {
      await client.end();
    }
  });

  test('a ledger stopped behind a validation CHECK is completed after the wipe, not left broken', async () => {
    const client = await recreateDatabase(REPAIR_DB);
    try {
      await client.query(SCHEMA_SQL);
      const first = await runSchemaMigrations(client as any, {
        baselineSql: SCHEMA_SQL,
        migrationsDir: REPAIR_DIR,
      });
      assert.deepEqual(first.applied, ['0002_reset_probe']);
      await client.query("INSERT INTO reset_probe (id, kind) VALUES (1, 'LEGACY')");

      // The next migration validates rows, exactly like 0011's role CHECK: on a
      // seeded database the recorder stops here, which is the state that made
      // boot fail after the reset.
      writeMigration(
        REPAIR_DIR,
        '0003_reset_probe_kind.sql',
        'ALTER TABLE reset_probe DROP CONSTRAINT IF EXISTS reset_probe_kind_check;\n' +
          "ALTER TABLE reset_probe ADD CONSTRAINT reset_probe_kind_check CHECK (kind = 'OK');\n"
      );
      await assert.rejects(
        runSchemaMigrations(client as any, {
          baselineSql: SCHEMA_SQL,
          migrationsDir: REPAIR_DIR,
        }),
        /reset_probe_kind_check/
      );
      const stuck = await client.query('SELECT version FROM schema_migrations ORDER BY version');
      assert.deepEqual(
        stuck.rows.map((row) => row.version),
        [BASELINE_VERSION, '0002_reset_probe'],
        'the recorder stopped with the ledger behind the migration files'
      );

      const result = await resetSchema(client as any, {
        baselineSql: SCHEMA_SQL,
        migrationsDir: REPAIR_DIR,
        wipe: true,
      });
      assert.deepEqual(result.applied, ['0002_reset_probe', '0003_reset_probe_kind']);
      const rows = await client.query('SELECT id FROM reset_probe');
      assert.deepEqual(rows.rows, [], 'the wipe runs before the CHECK, so the reset can finish');
      const done = await client.query('SELECT version FROM schema_migrations ORDER BY version');
      assert.deepEqual(done.rows.map((row) => row.version), [
        BASELINE_VERSION,
        '0002_reset_probe',
        '0003_reset_probe_kind',
      ]);
    } finally {
      await client.end();
    }
  });
});
