/**
 * Lightweight SQL migration runner.
 *
 * Tracks applied files in schema_migrations.
 * Place ordered files in scripts/migrations/*.sql (e.g. 001_init.sql).
 */
import fs from 'fs';
import path from 'path';
import { pgPool, isPgConnected, isDurableSqlBackend } from './db';
import { logger } from './logger';

const MIGRATIONS_DIR = path.join(process.cwd(), 'scripts', 'migrations');

async function ensureMigrationsTable(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(150) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum VARCHAR(64)
    );
  `);
}

function listMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function checksum(content: string): string {
  // simple non-crypto checksum for drift detection
  let h = 0;
  for (let i = 0; i < content.length; i++) h = (h * 31 + content.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/**
 * Apply pending migrations when on durable Postgres.
 * Safe no-op offline / pg-mem / test without PG.
 */
export async function runMigrations(): Promise<{ applied: string[]; skipped: boolean }> {
  if (!isPgConnected || !isDurableSqlBackend()) {
    return { applied: [], skipped: true };
  }

  const files = listMigrationFiles();
  if (files.length === 0) {
    logger.info({ msg: 'migrations_none', dir: MIGRATIONS_DIR });
    return { applied: [], skipped: false };
  }

  const client = await pgPool.connect();
  const applied: string[] = [];
  try {
    await ensureMigrationsTable(client);
    const existing = await client.query('SELECT id FROM schema_migrations');
    const done = new Set((existing.rows || []).map((r: any) => r.id));

    for (const file of files) {
      if (done.has(file)) continue;
      const full = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(full, 'utf8');
      const sum = checksum(sql);

      logger.info({ msg: 'migration_apply', file });
      try {
        await client.query('BEGIN');
        // Run file contents (may contain multiple statements)
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
          [file, sum]
        );
        await client.query('COMMIT');
        applied.push(file);
      } catch (err: any) {
        try {
          await client.query('ROLLBACK');
        } catch (_e) {}
        logger.error({ msg: 'migration_failed', file, error: err?.message || String(err) });
        throw err;
      }
    }

    if (applied.length) {
      logger.info({ msg: 'migrations_applied', count: applied.length, files: applied });
    } else {
      logger.info({ msg: 'migrations_up_to_date' });
    }
    return { applied, skipped: false };
  } finally {
    if (client && typeof client.release === 'function') client.release();
  }
}

export function getMigrationsDir() {
  return MIGRATIONS_DIR;
}
