/**
 * Record the schema migration baseline after `setup:pg` applies schema.sql.
 *
 * `setup:pg` builds the current schema and then seeds demo data. If it leaves
 * `schema_migrations` empty, the next server boot detects the current shape,
 * adopts the baseline, and replays every numbered migration against a database
 * that already contains current-role accounts. Older migrations can then fail
 * their role CHECK constraints (for example 0011 predates LOAN_PAYABLE).
 *
 * This script runs after the schema pass and before the seeder inserts accounts,
 * so the empty ledger tables let the numbered migrations apply cleanly and boot
 * sees a complete migration history.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import { runSchemaMigrations } from '../server/src/boot/migrations';

dotenv.config({ quiet: true });

function connectionString(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = process.env.POSTGRES_USER || 'inventory_user';
  const password = process.env.POSTGRES_PASSWORD || 'securepassword';
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.POSTGRES_PORT || '5432';
  const database = process.env.POSTGRES_DB || 'inventory_db';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

const pool = new pg.Pool({ connectionString: connectionString(), max: 1 });
try {
  const client = await pool.connect();
  try {
    const result = await runSchemaMigrations(client, {
      baselineSql: fs.readFileSync(path.resolve('scripts/schema.sql'), 'utf8'),
      migrationsDir: path.resolve('scripts/migrations'),
    });
    console.log(
      `schema-migrations: baseline ${result.baselineSource || 'already recorded'}; ` +
        `applied ${result.applied.length ? result.applied.join(', ') : 'none'}; ` +
        `current ${result.currentVersion || 'none'}`
    );
  } finally {
    client.release();
  }
} finally {
  await pool.end().catch(() => undefined);
}
