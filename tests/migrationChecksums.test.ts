/**
 * Worklist A4 — a numbered migration's comments are prose, its statements are
 * frozen.
 *
 * On 2026-11-17 rewording 0030's comments after it had been applied changed its
 * checksum and the runner refused to boot; the repair needed a hand-written
 * verifier. The checksum now hashes the SQL with comments removed, so a prose
 * fix is free while a statement change still fails, and an installation that
 * recorded the old raw checksum is upgraded once instead of being locked out.
 *
 * PROVES:
 *   1. the scanner removes line and (nested) block comments and keeps `--` where
 *      PostgreSQL would: inside string literals, quoted identifiers and
 *      dollar-quoted bodies;
 *   2. two files that differ only in comments hash the same, and a statement
 *      change hashes differently;
 *   3. against a throwaway database: a comment-only edit re-runs cleanly and
 *      re-records the checksum, a statement edit still refuses to boot, and a
 *      legacy raw checksum is accepted once and upgraded;
 *   4. line endings are not part of the digest (A4b): a CRLF checkout of a file
 *      whose dollar-quoted body keeps its `\r` hashes like the LF checkout, and
 *      a ledger recorded from the CRLF copy is accepted once and upgraded.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  BASELINE_VERSION,
  migrationChecksum,
  runSchemaMigrations,
  stripSqlComments,
} from '../server/src/boot/migrations';

dotenv.config();

const ROOT = path.resolve('.');
const SCHEMA_SQL = fs.readFileSync(path.join(ROOT, 'scripts', 'schema.sql'), 'utf8');
const BASE_URL = process.env.DATABASE_URL;
const TEST_DB = 'inventory_migration_checksum_test';
const MIGRATIONS_DIR = path.join(ROOT, 'tests', `.tmp-migration-checksums-${process.pid}`);
const PROBE = path.join(MIGRATIONS_DIR, '0002_checksum_probe.sql');

const WITHOUT_COMMENTS = 'CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY);\n';
const WITH_COMMENTS =
  '-- A comment added after the migration was applied.\n' +
  'CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY); /* trailing block */\n';

function rawChecksum(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

describe('migration checksum scanner (A4)', () => {
  test('line and block comments are removed, nested blocks included', () => {
    const sql = [
      '-- header',
      'CREATE TABLE t (',
      '  id INTEGER, /* inline /* nested */ still a comment */',
      '  name TEXT -- trailing',
      ');',
    ].join('\n');
    const stripped = stripSqlComments(sql);
    assert.ok(!stripped.includes('header'));
    assert.ok(!stripped.includes('inline'));
    assert.ok(!stripped.includes('trailing'));
    assert.ok(stripped.includes('CREATE TABLE t ('));
    assert.ok(stripped.includes('name TEXT'));
  });

  test('a `--` inside a string, an identifier or a dollar-quoted body is not a comment', () => {
    const sql = [
      `INSERT INTO notes (label) VALUES ('total -- not a comment');`,
      `SELECT 1 AS "weird -- column";`,
      `CREATE FUNCTION f() RETURNS void AS $$`,
      `BEGIN -- body comment stays part of the body`,
      `  RAISE NOTICE 'x';`,
      `END;`,
      `$$ LANGUAGE plpgsql;`,
    ].join('\n');
    const stripped = stripSqlComments(sql);
    assert.ok(stripped.includes("'total -- not a comment'"));
    assert.ok(stripped.includes('"weird -- column"'));
    assert.ok(stripped.includes('-- body comment stays part of the body'));
    assert.ok(stripped.includes('$$ LANGUAGE plpgsql'));
  });

  test('comments alone do not change the checksum; a statement change does', () => {
    assert.equal(migrationChecksum(WITH_COMMENTS), migrationChecksum(WITHOUT_COMMENTS));
    assert.notEqual(
      migrationChecksum('CREATE TABLE checksum_probe (id BIGINT PRIMARY KEY);\n'),
      migrationChecksum(WITHOUT_COMMENTS)
    );
    // A literal edit is a statement change even when it looks like a comment.
    assert.notEqual(
      migrationChecksum(`INSERT INTO t VALUES ('a -- b');\n`),
      migrationChecksum(`INSERT INTO t VALUES ('a -- c');\n`)
    );
  });

  test('a CRLF checkout and an LF checkout of one file hash the same (A4b)', () => {
    const lf = [
      '-- header',
      'CREATE OR REPLACE FUNCTION crlf_probe() RETURNS integer AS $$',
      'BEGIN -- a body is copied verbatim, so its line endings survive the scanner',
      "  IF current_setting('x', true) = 'on' THEN",
      '    RETURN NULL;',
      '  END IF;',
      '  RETURN 1;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      '',
    ].join('\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    assert.notEqual(rawChecksum(crlf), rawChecksum(lf), 'the two checkouts really do differ in bytes');
    assert.equal(migrationChecksum(crlf), migrationChecksum(lf), 'the digest must not depend on them');
    // Normalising line endings must not hide a statement edit inside the body.
    assert.notEqual(
      migrationChecksum(lf.replace('RETURN 1;', 'RETURN 2;')),
      migrationChecksum(lf)
    );
  });
});

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

function withDbName(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe('migration runner — checksum compatibility (A4)', { skip: skipNoDb }, () => {
  let client: pg.Client | null = null;

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
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
    fs.writeFileSync(PROBE, WITHOUT_COMMENTS);
  });

  after(async () => {
    fs.rmSync(MIGRATIONS_DIR, { recursive: true, force: true });
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

  async function run(): Promise<{ applied: string[] }> {
    assert.ok(client);
    return runSchemaMigrations(client as any, { baselineSql: SCHEMA_SQL, migrationsDir: MIGRATIONS_DIR });
  }

  async function recordedOf(version: string): Promise<string> {
    assert.ok(client);
    const result = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [
      version,
    ]);
    return String(result.rows[0].checksum);
  }

  async function recordedChecksum(): Promise<string> {
    return recordedOf('0002_checksum_probe');
  }

  test('a comment-only edit after the migration was applied re-runs cleanly', async () => {
    const first = await run();
    assert.deepEqual(first.applied, ['0002_checksum_probe']);
    const before = await recordedChecksum();
    assert.equal(before, migrationChecksum(WITHOUT_COMMENTS));

    fs.writeFileSync(PROBE, WITH_COMMENTS);
    const second = await run();
    assert.deepEqual(second.applied, [], 'nothing is re-applied');
    assert.equal(await recordedChecksum(), before, 'the checksum did not change for a comment');
  });

  test('a statement edit after the migration was applied still refuses to boot', async () => {
    fs.writeFileSync(
      PROBE,
      `${WITH_COMMENTS}ALTER TABLE checksum_probe ADD COLUMN note TEXT;\n`
    );
    await assert.rejects(run, /changed after it was applied/);
    // Restore the applied file so the next test starts from a consistent state.
    fs.writeFileSync(PROBE, WITH_COMMENTS);
    const again = await run();
    assert.deepEqual(again.applied, []);
  });

  test('a ledger written with the comment-stripped convention is accepted and upgraded', async () => {
    assert.ok(client);
    const naive = WITH_COMMENTS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
    await client.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [
      '0002_checksum_probe',
      rawChecksum(naive),
    ]);
    const result = await run();
    assert.deepEqual(result.applied, [], 'the historical value does not re-apply the migration');
    assert.equal(await recordedChecksum(), migrationChecksum(WITH_COMMENTS));
  });

  test('a legacy raw checksum is accepted once and upgraded to the comment-insensitive one', async () => {
    assert.ok(client);
    const normalized = migrationChecksum(WITH_COMMENTS);
    await client.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [
      '0002_checksum_probe',
      rawChecksum(WITH_COMMENTS),
    ]);
    const result = await run();
    assert.deepEqual(result.applied, [], 'the legacy value does not re-apply the migration');
    assert.equal(await recordedChecksum(), normalized, 'the row was upgraded in place');
    // The baseline row keeps its own checksum and is never compared.
    assert.notEqual(normalized, rawChecksum(WITH_COMMENTS));
    const baseline = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [
      BASELINE_VERSION,
    ]);
    assert.ok(baseline.rows[0].checksum);
  });

  test('a digest recorded from a CRLF checkout is accepted once and upgraded (A4b)', async () => {
    assert.ok(client);
    const db = client;
    const lfSql = [
      '-- CRLF probe',
      'CREATE OR REPLACE FUNCTION crlf_probe() RETURNS integer AS $$',
      'BEGIN',
      '  RETURN 1;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      '',
    ].join('\n');
    const probeFile = path.join(MIGRATIONS_DIR, '0003_crlf_probe.sql');
    const canonical = migrationChecksum(lfSql);
    // What a checkout that read the CRLF copy recorded before A4b.
    const crlfDigest = rawChecksum(stripSqlComments(lfSql.replace(/\n/g, '\r\n')));
    const recordCrlfDigest = () =>
      db.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [
        '0003_crlf_probe',
        crlfDigest,
      ]);
    fs.writeFileSync(probeFile, lfSql);
    try {
      assert.deepEqual((await run()).applied, ['0003_crlf_probe']);
      assert.equal(await recordedOf('0003_crlf_probe'), canonical);
      assert.notEqual(crlfDigest, canonical, 'the CRLF digest is a different value');

      // The legacy entry must not launder a real edit: a CRLF ledger plus a
      // changed statement is still a statement change.
      await recordCrlfDigest();
      fs.writeFileSync(probeFile, lfSql.replace('RETURN 1;', 'RETURN 2;'));
      await assert.rejects(run, /changed after it was applied/);

      // Unedited again: that same CRLF digest is accepted once and upgraded.
      fs.writeFileSync(probeFile, lfSql);
      await recordCrlfDigest();
      const second = await run();
      assert.deepEqual(second.applied, [], 'the historical digest does not re-apply the migration');
      assert.equal(await recordedOf('0003_crlf_probe'), canonical, 'the row was upgraded in place');
    } finally {
      fs.rmSync(probeFile, { force: true });
    }
  });
});
