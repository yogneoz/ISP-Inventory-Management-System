/**
 * Throwaway PostgreSQL database for integration suites that must not share the
 * application database.
 *
 * A year-end close or a branch fixture left behind in the shared database is
 * visible to every other suite via company-wide statements — the exact bug
 * that forced the opening/closing suite off the shared database. Suites that
 * own global state (fiscal years, branches, control-account fixtures) use this
 * helper instead: it drops and recreates a named database, applies
 * scripts/schema.sql and nothing else, and returns a pool pointed at it.
 *
 * The caller must set `process.env.DATABASE_URL` to the returned `url` BEFORE
 * dynamically importing `server/src/app` (db.ts builds its pool at module
 * load), and must end `db.realPoolInstance` before dropping the database.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const SCHEMA_SQL_PATH = path.resolve('scripts/schema.sql');

export interface ThrowawayDatabase {
  /** Connection to the `postgres` maintenance database, used for the drop. */
  adminPool: pg.Pool;
  /** Connection to the throwaway database itself. */
  pool: pg.Pool;
  url: string;
}

/** Parse DATABASE_URL and swap the database name. */
export function withDbName(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function assertDbName(dbName: string): void {
  if (!/^[a-z][a-z0-9_]*$/i.test(dbName)) {
    throw new Error(`throwawayDatabase: unsafe database name "${dbName}"`);
  }
}

export async function createThrowawayDatabase(
  baseUrl: string,
  dbName: string
): Promise<ThrowawayDatabase> {
  assertDbName(dbName);
  const url = withDbName(baseUrl, dbName);
  const adminPool = new pg.Pool({
    connectionString: withDbName(baseUrl, 'postgres'),
    max: 2,
    connectionTimeoutMillis: 2000,
  });
  adminPool.on('error', () => undefined);
  await adminPool.query('SELECT 1');

  // A stale throwaway from an earlier run can hold connections; nothing else
  // owns this database, so terminate and recreate it.
  await adminPool
    .query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    )
    .catch(() => undefined);
  await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await adminPool.query(`CREATE DATABASE ${dbName}`);

  const schemaClient = new pg.Client({ connectionString: url });
  await schemaClient.connect();
  try {
    await schemaClient.query(fs.readFileSync(SCHEMA_SQL_PATH, 'utf8'));
  } finally {
    await schemaClient.end();
  }

  const pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000 });
  // Dropping the database while an idle client is attached emits a terminating
  // notice on the pool; absorb it (queries still reject normally in tests).
  pool.on('error', () => undefined);
  return { adminPool, pool, url };
}

export async function dropThrowawayDatabase(
  adminPool: pg.Pool | null,
  dbName: string
): Promise<void> {
  if (!adminPool) return;
  assertDbName(dbName);
  try {
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } catch {
    await adminPool
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName]
      )
      .catch(() => undefined);
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined);
  }
  await adminPool.end().catch(() => undefined);
}
