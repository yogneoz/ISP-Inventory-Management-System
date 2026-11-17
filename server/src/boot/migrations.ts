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

function checksumRaw(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

/**
 * Comments are prose, not schema (worklist A4). A numbered migration is frozen
 * once applied, but "frozen" has to mean its STATEMENTS: on 2026-11-17 rewording
 * 0030's comments stopped every boot with "changed after it was applied" and
 * needed a hand-written reconciliation. The recorded checksum therefore hashes
 * the SQL with comments removed.
 *
 * The scanner knows the three places where `--` or `/*` is not a comment:
 * single-quoted strings (with `''` escapes), double-quoted identifiers, and
 * dollar-quoted bodies (`$$ … $$`, `$tag$ … $tag$`). A dollar-quoted body is
 * copied verbatim — a comment inside a function body is part of that body — so
 * this can never merge two statements into one hash.
 */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '$') {
      const match = /^(\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        out += sql.slice(i, end);
        i = end;
        continue;
      }
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += quote;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            out += quote + quote;
            j += 2;
            continue;
          }
          out += quote;
          j += 1;
          break;
        }
        out += sql[j];
        j += 1;
      }
      i = j;
      continue;
    }

    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
          continue;
        }
        if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      // A removed block comment would glue two tokens together; a space is what
      // PostgreSQL itself sees (`SELECT/*c*/1` is `SELECT 1`).
      out += ' ';
      continue;
    }

    // Whitespace outside a literal is formatting, not a statement: a removed
    // comment must not change the hash by leaving its newline behind, so every
    // run collapses to a single space. Inside string literals, quoted
    // identifiers and dollar-quoted bodies the branches above copied the text
    // verbatim, so their whitespace is untouched and a literal edit still
    // changes the checksum.
    if (/\s/.test(ch)) {
      if (out.length > 0 && out[out.length - 1] !== ' ') out += ' ';
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.trim();
}

/** The checksum recorded for a numbered migration: statements, not comments. */
export function migrationChecksum(sql: string): string {
  return checksumRaw(stripSqlComments(sql));
}

/**
 * Digests an earlier runner may have recorded for this file. Two conventions
 * exist in real installs:
 *
 *   raw     — the whole file, comments included (the runner before A4);
 *   naive   — the file with comments removed and whitespace left exactly as it
 *             was, which is what the development ledger was written with.
 *
 * Both are accepted exactly once and replaced by the canonical digest, so an
 * existing install keeps booting without a hand-written reconciliation. Neither
 * can match a changed statement: a statement edit alters the digest under every
 * one of these transformations.
 */
function legacyChecksums(sql: string): string[] {
  const naive = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  return [checksumRaw(sql), checksumRaw(naive)];
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
      checksumRaw(baselineSql),
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
    const sqlChecksum = migrationChecksum(sql);

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
        // migrations are immutable once recorded — statements, not comments.
        if (migration.version !== BASELINE_VERSION && recorded !== sqlChecksum) {
          // An installation that applied this migration under an earlier
          // convention recorded a different digest. Accept it exactly once and
          // re-record the canonical, comment-insensitive checksum, so prose
          // edits stop breaking the boot while a statement edit still fails.
          if (legacyChecksums(sql).includes(recorded)) {
            await client.query(
              'UPDATE schema_migrations SET checksum = $2 WHERE version = $1',
              [migration.version, sqlChecksum]
            );
            await client.query('COMMIT');
            continue;
          }
          throw new Error(
            `Migration ${migration.version} changed after it was applied ` +
              `(recorded ${recorded.slice(0, 12)}…, file ${sqlChecksum.slice(0, 12)}…). ` +
              'Only comments may change in an applied migration; a statement change needs a new migration.'
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
