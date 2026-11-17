/**
 * Reconcile a recorded migration checksum with the current file ONLY after the
 * migration's schema effects have been verified in the live database.
 *
 * This is not a migration bypass and it does not rewrite applied SQL. It is for
 * the narrow case where a numbered migration's file was corrected after it ran
 * (for example, the LEND-1 table file gained its BS-date columns, which 0023
 * then backfills). The version row keeps its original source/applied_at; only
 * the stale checksum is refreshed so the runner can proceed to the next
 * forward-only migration.
 *
 * Usage: npx tsx scripts/reconcile_migration_checksums.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { migrationChecksum } from '../server/src/boot/migrations';

dotenv.config({ quiet: true });

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'scripts', 'migrations');

/** Checks that the live schema already contains the migration's effects. */
const VERIFIERS: Record<string, (client: pg.PoolClient) => Promise<void>> = {
  '0030_hot_table_storage': async (client) => {
    const result = await client.query(`
      SELECT relname, reloptions
        FROM pg_class
       WHERE relname IN ('inventory_stock', 'document_sequence_daily')
    `);
    for (const table of ['inventory_stock', 'document_sequence_daily']) {
      const options = String(result.rows.find((row: any) => row.relname === table)?.reloptions || '');
      if (!options.includes('fillfactor=80') || !options.includes('autovacuum_vacuum_scale_factor=0.02')) {
        throw new Error(`0030 cannot be reconciled: ${table} is missing its storage parameters.`);
      }
    }
  },
  '0022_lenders_and_loans': async (client) => {
    const result = await client.query(`
      SELECT
        to_regclass('public.lenders') IS NOT NULL AS lenders,
        to_regclass('public.loans') IS NOT NULL AS loans
    `);
    const row = result.rows[0] || {};
    if (!row.lenders || !row.loans) {
      throw new Error('0022 cannot be reconciled: lenders/loans tables are missing.');
    }
  },
};

/**
 * The same digest the runner records, imported rather than re-implemented: a
 * repaired row must agree with what the next boot recomputes, and a comment-only
 * difference is not a mismatch at all any more (worklist A4).
 */
function checksum(sql: string): string {
  return migrationChecksum(sql);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set.');
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const recorded = await client.query(
      'SELECT version, checksum, source FROM schema_migrations ORDER BY version'
    );
    const files = new Map<string, string>();
    for (const file of fs.readdirSync(MIGRATIONS_DIR)) {
      if (!/^\d{4}_.*\.sql$/.test(file)) continue;
      files.set(
        file.replace(/\.sql$/, ''),
        checksum(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
      );
    }

    const mismatches = recorded.rows.filter((row) => {
      const current = files.get(row.version);
      return current && current !== row.checksum;
    });
    if (mismatches.length === 0) {
      console.log('migration checksums: nothing to reconcile');
      return;
    }

    await client.query('BEGIN');
    try {
      for (const row of mismatches) {
        const verify = VERIFIERS[row.version];
        if (!verify) {
          throw new Error(
            `Migration ${row.version} differs from its recorded checksum and has no verifier. ` +
              'Add a schema verifier before reconciling it.'
          );
        }
        await verify(client);
        const current = files.get(row.version)!;
        await client.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [
          row.version,
          current,
        ]);
        console.log(
          `migration checksum reconciled: ${row.version} ` +
            `(${row.checksum.slice(0, 12)}… -> ${current.slice(0, 12)}…)`
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
