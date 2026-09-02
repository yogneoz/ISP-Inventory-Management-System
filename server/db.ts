import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool: RealPgPool } = pg;

// Keep PostgreSQL DATE columns as plain 'YYYY-MM-DD' strings end-to-end.
// pg's default parser converts DATE to a JS Date at *local* midnight of the
// server process, and the resulting JSON (UTC ISO) makes the AD date shift by
// a day when clients display it (e.g. 2026-08-31 NPT reads back as
// '2026-08-30T18:15:00.000Z'). The app treats AD calendar dates as plain
// strings everywhere (client DateField, BS conversion, SQL ::text casts), so
// the DATE value must pass through untouched.
pg.types.setTypeParser(1082, (value: string) => value);
export let isPgConnected = false;
export function setIsPgConnected(status: boolean) {
  isPgConnected = status;
}

export function getIsPgConnected() {
  return isPgConnected;
}

export let realPoolInstance: any = null;

try {
  if (process.env.DATABASE_URL || process.env.POSTGRES_HOST) {
    realPoolInstance = new RealPgPool({
      connectionString: process.env.DATABASE_URL || undefined,
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB || 'inventory_db',
      user: process.env.POSTGRES_USER || 'inventory_user',
      password: process.env.POSTGRES_PASSWORD || 'securepassword',
      connectionTimeoutMillis: 2000,
      max: 20,
      idleTimeoutMillis: 30000,
    });
  }
} catch (_e) {}

/**
 * Rechecks a previously unavailable pool. This lets the API recover after
 * PostgreSQL is started or briefly restarted without requiring an app restart.
 */
export async function ensurePostgresConnection(): Promise<boolean> {
  if (!realPoolInstance) return false;

  try {
    await realPoolInstance.query('SELECT 1');
    isPgConnected = true;
    return true;
  } catch (_e) {
    isPgConnected = false;
    return false;
  }
}

export const pgPool = {
  async query(text: string, params?: any[]) {
    if (!isPgConnected || !realPoolInstance) {
      throw new Error('PostgreSQL is not connected. Database operations are unavailable.');
    }
    try {
      return await realPoolInstance.query(text, params);
    } catch (err: any) {
      // Only connection-level failures mark the pool as disconnected. SQL-level
      // errors (FK violations, constraint failures, ...) must not take the whole
      // database layer offline for subsequent queries.
      const sqlState: string = typeof err?.code === 'string' ? err.code : '';
      const isConnectionError =
        !sqlState ||
        sqlState.startsWith('08') ||
        sqlState.startsWith('53') ||
        sqlState.startsWith('57') ||
        sqlState.startsWith('58') ||
        /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|connection|timeout/i.test(err?.message || '');
      if (isConnectionError) isPgConnected = false;
      console.error('PostgreSQL query failed:', err?.message || err);
      throw err;
    }
  },
  async connect() {
    if (!realPoolInstance) {
      throw new Error('PostgreSQL connection is not configured.');
    }
    return realPoolInstance.connect();
  }
};
