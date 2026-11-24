/**
 * Reset the schema and record the migration ledger, in ONE transaction.
 *
 * `npm run setup:pg` runs this after the destructive guard and before the
 * seeder:
 *
 *   tsx scripts/record_schema_migrations.ts            # wipe + schema + ledger
 *   tsx scripts/record_schema_migrations.ts --keep-data # keep rows, still record
 *
 * Why the whole reset is one transaction: this script used to record the ledger
 * in a second process, after the wipe and schema.sql had already committed. When
 * the recorder stopped partway — 0011's role CHECK rejecting a seeded
 * LOAN_PAYABLE account is the case that broke this workstation — the database
 * kept the wipe and the schema but not the ledger, so the next boot or seed ran
 * migrations against rows that made them fail again.
 *
 * Why it must run before any row is inserted: boot adopts the current shape and
 * then applies every unrecorded migration. Seeding first (as `seed:verify` used
 * to) leaves rows that an older migration's CHECK rejects, which is exactly the
 * unbootable state this script exists to prevent.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import { resetSchema } from './seed/resetSchema';

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

const keepData = process.argv.includes('--keep-data');
const pool = new pg.Pool({ connectionString: connectionString(), max: 1 });
try {
  const client = await pool.connect();
  try {
    const result = await resetSchema(client, {
      baselineSql: fs.readFileSync(path.resolve('scripts/schema.sql'), 'utf8'),
      migrationsDir: path.resolve('scripts/migrations'),
      wipe: !keepData,
    });
    console.log(
      `schema-reset: wiped ${keepData ? 'none (--keep-data)' : `${result.wipedTables.length} tables`}; ` +
        `baseline ${result.baselineSource || 'already recorded'}; ` +
        `applied ${result.applied.length ? result.applied.join(', ') : 'none'}; ` +
        `current ${result.currentVersion || 'none'}`
    );
  } finally {
    client.release();
  }
} catch (err) {
  console.error(
    'schema-reset: rolled back — the database still holds the rows, schema and ledger it had before this command.'
  );
  console.error((err as Error)?.message || err);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
