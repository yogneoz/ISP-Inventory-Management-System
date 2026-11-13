/**
 * Versioned production schema runner.
 *
 * `scripts/schema.sql` remains the single baseline schema source. A fresh
 * database applies it once and records `0001_baseline`; an existing database
 * that already has the current core shape only records the baseline and skips
 * the DDL. Future changes are numbered files under `scripts/migrations/` and
 * are applied once each, in version order, under a PostgreSQL advisory lock.
 *
 * The ledger itself is deliberately plain SQL-supported metadata, not an ORM:
 * boot can therefore recover a legacy database before any application model is
 * loaded.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';

export const BASELINE_VERSION = '0001_baseline';
export const BASELINE_NAME = 'baseline schema.sql';

export type MigrationSource = 'BASELINE' | 'ADOPTED' | 'MIGRATION';

export interface MigrationRunResult {
  /** How the baseline was established, or null when it was already recorded. */
  baselineSource: MigrationSource | null;
  /** Versions applied by this run, in order. */
  applied: string[];
  /** Latest recorded version after the run. */
  currentVersion: string | null;
}

let currentVersion: string | null = null;

/** The last version established by this process, for the metrics endpoint. */
export function getSchemaVersion(): string | null {
  return currentVersion;
}

/** Test hook: the value is normally set by `runSchemaMigrations`. */
export function setSchemaVersionForTests(version: string | null): void {
  currentVersion = version;
}

const CREATE_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(100) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  source VARCHAR(20) NOT NULL CHECK (source IN ('BASELINE', 'ADOPTED', 'MIGRATION')),
  applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

const ADVISORY_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`;

function checksum(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

/** Whether a database already has the current baseline's core shape. */
async function hasCurrentBaselineShape(client: PoolClient): Promise<boolean> {
  const result = await client.query(`
    SELECT
      to_regclass('public.fiscal_years') IS NOT NULL AS fiscal_years,
      to_regclass('public.gl_journals') IS NOT NULL AS gl_journals,
      to_regclass('public.gl_subledger_entries') IS NOT NULL AS gl_subledger_entries,
      to_regclass('public.warranty_coverages') IS NOT NULL AS warranty_coverages,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'gl_journals'
          AND column_name = 'voucher_class'
      ) AS gl_voucher_class
  `);
  const row = result.rows[0] || {};
  return Boolean(
    row.fiscal_years &&
      row.gl_journals &&
      row.gl_subledger_entries &&
      row.warranty_coverages &&
      row.gl_voucher_class
  );
}

async function recordMigration(
  client: PoolClient,
  version: string,
  name: string,
  sqlChecksum: string,
  durationMs: number,
  source: MigrationSource
): Promise<void> {
  await client.query(
    `INSERT INTO schema_migrations (version, name, checksum, duration_ms, source)
     VALUES ($1, $2, $3, $4, $5)`,
    [version, name.slice(0, 200), sqlChecksum, Math.max(0, Math.round(durationMs)), source]
  );
}

async function establishBaseline(
  client: PoolClient,
  baselineSql: string
): Promise<MigrationSource | null> {
  await client.query('BEGIN');
  try {
    await client.query(ADVISORY_LOCK_SQL, ['inventory_schema_migrations']);
    const existing = await client.query(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [BASELINE_VERSION]
    );
    if (existing.rowCount) {
      await client.query('COMMIT');
      return null;
    }

    const startedAt = Date.now();
    let source: MigrationSource;
    if (await hasCurrentBaselineShape(client)) {
      source = 'ADOPTED';
    } else {
      // An empty or legacy database gets the full idempotent baseline once.
      await client.query(baselineSql);
      source = 'BASELINE';
    }
    await recordMigration(
      client,
      BASELINE_VERSION,
      BASELINE_NAME,
      checksum(baselineSql),
      Date.now() - startedAt,
      source
    );
    await client.query('COMMIT');
    return source;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

interface MigrationFile {
  version: string;
  name: string;
  filePath: string;
}

function listMigrationFiles(migrationsDir: string | null | undefined): MigrationFile[] {
  if (!migrationsDir || !fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{4}_[A-Za-z0-9_.-]+\.sql$/.test(entry.name))
    .map((entry) => ({
      version: entry.name.replace(/\.sql$/, ''),
      name: entry.name,
      filePath: path.join(migrationsDir, entry.name),
    }))
    .sort((a, b) => a.version.localeCompare(b.version));
}

async function applyPendingMigrations(
  client: PoolClient,
  migrationsDir: string | null | undefined
): Promise<string[]> {
  const applied: string[] = [];
  for (const migration of listMigrationFiles(migrationsDir)) {
    const sql = fs.readFileSync(migration.filePath, 'utf8');
    const sqlChecksum = checksum(sql);

    await client.query('BEGIN');
    try {
      await client.query(ADVISORY_LOCK_SQL, ['inventory_schema_migrations']);
      const existing = await client.query(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [migration.version]
      );
      if (existing.rowCount) {
        const recorded = String(existing.rows[0].checksum || '');
        // The baseline file is expected to evolve with schema.sql; numbered
        // migrations are immutable once recorded.
        if (migration.version !== BASELINE_VERSION && recorded !== sqlChecksum) {
          throw new Error(
            `Migration ${migration.version} changed after it was applied ` +
              `(recorded ${recorded.slice(0, 12)}…, file ${sqlChecksum.slice(0, 12)}…).`
          );
        }
        await client.query('COMMIT');
        continue;
      }

      const startedAt = Date.now();
      await client.query(sql);
      await recordMigration(
        client,
        migration.version,
        migration.name,
        sqlChecksum,
        Date.now() - startedAt,
        'MIGRATION'
      );
      await client.query('COMMIT');
      applied.push(migration.version);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }
  return applied;
}

async function readCurrentVersion(client: PoolClient): Promise<string | null> {
  const result = await client.query(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
  );
  return result.rows[0]?.version || null;
}

/**
 * Establish/verify the baseline and apply any pending numbered migrations.
 * Safe to call on every boot and against both empty and populated databases.
 */
export async function runSchemaMigrations(
  client: PoolClient,
  options: { baselineSql: string; migrationsDir?: string | null }
): Promise<MigrationRunResult> {
  await client.query(CREATE_MIGRATIONS_TABLE_SQL);
  const baselineSource = await establishBaseline(client, options.baselineSql);
  const applied = await applyPendingMigrations(client, options.migrationsDir);
  currentVersion = await readCurrentVersion(client);
  return { baselineSource, applied, currentVersion };
}
