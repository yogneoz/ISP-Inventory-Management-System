// ============================================================================
// The destructive schema reset, in ONE transaction.
//
// `setup:pg` used to wipe and apply schema.sql on one connection and then record
// the migration ledger in a second process. A recorder that stopped partway (for
// example on 0011's role CHECK) therefore committed the wipe and the schema but
// not the ledger, and the database was left one migration run away from a boot
// that could not succeed. `seed:verify` was worse: it seeded rows without
// recording the ledger at all, so the next boot replayed 0011 against accounts
// carrying roles that 0011 predates.
//
// Everything here runs inside ONE transaction: the wipe, the schema pass and
// every pending migration. Either the reset lands complete — no rows and a
// ledger that names the newest migration — or it rolls back and the database is
// byte for byte what it was before the command. This module never inserts a
// business row, so no caller can seed ahead of the ledger it produces.
// ============================================================================
import type { PoolClient } from 'pg';
import { runSchemaMigrations } from '../../server/src/boot/migrations';
import { wipeOperationalData } from './applyVerificationSeed';

export interface ResetSchemaOptions {
  /** The text of scripts/schema.sql: the baseline the ledger records. */
  baselineSql: string;
  /** scripts/migrations. */
  migrationsDir: string;
  /**
   * false keeps existing rows (`--keep-data`) but still records the ledger, so
   * a seed cannot run against a database whose migrations are behind. Defaults
   * to true: the destructive reset that `setup:pg -- --force` performs.
   */
  wipe?: boolean;
}

export interface ResetSchemaResult {
  /** Tables emptied by the wipe, in the query's order. */
  wipedTables: string[];
  baselineSource: string | null;
  applied: string[];
  currentVersion: string | null;
}

/**
 * Wipe (unless disabled), apply the baseline schema and record every pending
 * migration, atomically. Throws after rolling back, leaving the caller's
 * database untouched; the caller decides whether the command may continue to
 * seed.
 */
export async function resetSchema(
  client: PoolClient,
  options: ResetSchemaOptions
): Promise<ResetSchemaResult> {
  await client.query('BEGIN');
  try {
    // The wipe runs BEFORE the schema pass: schema.sql rewrites CHECK
    // constraints with ADD CONSTRAINT, which validates existing rows, so a row
    // from an older schema would otherwise abort the reset. It also means an old
    // migration that validates rows (0011's role CHECK) can finish on the empty
    // tables left behind.
    const wipedTables = options.wipe === false ? [] : await wipeOperationalData(client);
    await client.query(options.baselineSql);
    const migrations = await runSchemaMigrations(client, {
      baselineSql: options.baselineSql,
      migrationsDir: options.migrationsDir,
      transaction: 'outer',
    });
    await client.query('COMMIT');
    return {
      wipedTables,
      baselineSource: migrations.baselineSource,
      applied: migrations.applied,
      currentVersion: migrations.currentVersion,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
