/**
 * SCALE-3 — PgBouncer `pool_mode=transaction` readiness.
 *
 * A transaction-mode pooler hands a client a different server connection per
 * transaction, so anything the application keeps *in a session* either
 * disappears or leaks to the next client. This file pins the two conclusions of
 * the audit:
 *
 *   1. `statement_timeout` is no longer a client startup parameter (which a
 *      transaction-mode pooler does not replay onto the reused server
 *      connection); it is applied to the ROLE, which every backend inherits.
 *   2. No request-path code issues a session-scoped `SET`, and every temporary
 *      table is `ON COMMIT DROP`, so nothing session-scoped can survive a
 *      connection swap.
 *
 * The live proof against a real PgBouncer binary is
 * `scripts/verify_pgbouncer_pooling.ts`; it needs PgBouncer installed, which is
 * an operator install, so it is not part of the suite.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import { buildPoolConfig } from '../server/db';
import {
  CURRENT_STATEMENT_TIMEOUT_SQL,
  ROLE_STATEMENT_TIMEOUT_DDL_SQL,
  ensureRoleStatementTimeout,
  readRoleStatementTimeout,
  statementTimeoutValue,
} from '../server/src/db/statementTimeout';

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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (role setting)';

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && /\.(ts|mjs|js)$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe('PgBouncer transaction-mode readiness (SCALE-3)', () => {
  after(async () => {
    if (pool && dbReachable) await pool.end();
  });

  test('the pool no longer carries a per-connection statement timeout', () => {
    const config = buildPoolConfig() as Record<string, unknown>;
    assert.equal('statement_timeout' in config, false, 'statement_timeout must not ride on the client connection');
    assert.equal('options' in config, false, 'no startup `options` parameter either');
    assert.equal(typeof config.statementTimeoutMs, 'number', 'the value is still read, for the role setting');
  });

  test('the role DDL is built by PostgreSQL, not by string concatenation', () => {
    assert.match(ROLE_STATEMENT_TIMEOUT_DDL_SQL, /format\('ALTER ROLE %I SET statement_timeout = %L'/);
    assert.equal(statementTimeoutValue(30_000), '30000ms');
    assert.equal(statementTimeoutValue(0), '0', '0 still means disabled');
  });

  test('the role setting applies to a NEW connection and is restored afterwards', { skip: skipNoDb }, async () => {
    const client = await pool!.connect();
    let previousRoleValue: string | null = null;
    let applied = false;
    try {
      previousRoleValue = await readRoleStatementTimeout(client);
      const result = await ensureRoleStatementTimeout(client, 12_345, () => undefined);
      applied = true;
      assert.equal(result.target, '12345ms');

      // A brand-new backend must inherit it: that is the whole point of moving it
      // off the client startup packet.
      const fresh = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await fresh.connect();
      try {
        const seen = await fresh.query(CURRENT_STATEMENT_TIMEOUT_SQL);
        assert.equal(seen.rows[0].value, '12345ms', 'a new connection inherits the role setting');
      } finally {
        await fresh.end();
      }

      // Idempotent: the second call must not issue another ALTER.
      const again = await ensureRoleStatementTimeout(client, 12_345, () => undefined);
      assert.equal(again.changed, false, 'an unchanged role is left alone');
    } finally {
      if (applied) {
        // Put the role back exactly as it was: the configured value, or no
        // setting at all when there was none.
        const ddl = previousRoleValue
          ? await client.query(
              `SELECT format('ALTER ROLE %I SET statement_timeout = %L', current_user, $1::text) AS ddl`,
              [previousRoleValue]
            )
          : await client.query(`SELECT format('ALTER ROLE %I RESET statement_timeout', current_user) AS ddl`);
        await client.query(ddl.rows[0].ddl);
      }
      client.release();
    }
  });

  test('no session-scoped SET or session state in the request path', () => {
    const roots = ['server/src/models', 'server/src/controllers', 'server/src/services'];
    const offenders: string[] = [];
    for (const file of roots.flatMap((root) => walk(root))) {
      const text = fs.readFileSync(file, 'utf8');
      // `SET LOCAL`, `SET ... TO DEFAULT` inside a transaction and
      // `set_config(..., true)` are transaction-scoped and pool-safe. An UPDATE's
      // `SET col = …` is not session state, so only session GUC names count.
      const sessionSet =
        /\bSET\s+(?:SESSION\s+)?(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|search_path|application_name|timezone|client_encoding|datestyle)\b/i;
      if (sessionSet.test(text)) offenders.push(`${file}: session SET (${sessionSet.exec(text)![0]})`);
      if (/\bSET\s+ROLE\s+[a-z_"]/i.test(text)) offenders.push(`${file}: SET ROLE`);
      if (/\bSET\s+SESSION\s+AUTHORIZATION\b/i.test(text)) offenders.push(`${file}: SET SESSION AUTHORIZATION`);
      if (/set_config\s*\([^)]*,\s*false\s*\)/i.test(text)) offenders.push(`${file}: set_config(..., false)`);
      if (/pg_advisory_lock\s*\(/.test(text)) offenders.push(`${file}: session advisory lock`);
      if (/^\s*LISTEN\s+[a-z_"]/im.test(text)) offenders.push(`${file}: LISTEN`);
      if (/\bPREPARE\s+[a-z_]+\s+(?:AS\s+)?[a-z_]*\(/i.test(text) || /\bPREPARE\s+TRANSACTION\b/i.test(text)) {
        offenders.push(`${file}: PREPARE`);
      }
    }
    assert.deepEqual(offenders, [], 'request-path SQL must not keep session state');
  });

  test('every temporary table is dropped at COMMIT', () => {
    const files = walk('server/src');
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const matches = text.match(/CREATE TEMP(?:ORARY)? TABLE[^;`]*/gi) || [];
      for (const statement of matches) {
        if (!/ON COMMIT DROP/i.test(statement)) offenders.push(`${file}: ${statement.slice(0, 80)}`);
      }
    }
    assert.deepEqual(offenders, [], 'a temp table without ON COMMIT DROP outlives its transaction on a pooled backend');
  });
});
