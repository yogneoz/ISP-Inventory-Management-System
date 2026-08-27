/**
 * PostgreSQL connection layer.
 *
 * Modes (priority order):
 *  1. `postgres` — real PostgreSQL is reachable (PRIMARY source of truth)
 *  2. `pg-mem`   — in-process SQL engine for schema-compatible demos
 *  3. `memory`   — no SQL backend (routes use store arrays + JSON file only)
 *
 * When mode is `postgres`, writes must succeed against real PG. Silent
 * fall-through to empty results is disabled for that mode so data cannot
 * appear "saved" when it was not persisted.
 */
import pg from 'pg';
import { newDb } from 'pg-mem';
import dotenv from 'dotenv';

dotenv.config();

const { Pool: RealPgPool } = pg;

export type DbMode = 'postgres' | 'pg-mem' | 'memory';

export let isPgConnected = false; // true only for REAL postgres
export let dbMode: DbMode = 'memory';

let realPoolInstance: pg.Pool | null = null;
let memPgPool: any = null;
let initDone = false;

function buildRealPool(): pg.Pool | null {
  try {
    const connectionString = process.env.DATABASE_URL;
    if (connectionString && !connectionString.includes('://user:pass')) {
      return new RealPgPool({
        connectionString,
        connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 30000,
        max: Number(process.env.PG_POOL_MAX || 10),
      });
    }
    return new RealPgPool({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB || 'inventory_db',
      user: process.env.POSTGRES_USER || 'inventory_user',
      password: process.env.POSTGRES_PASSWORD || 'securepassword',
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      max: Number(process.env.PG_POOL_MAX || 10),
    });
  } catch (err) {
    console.warn('Failed to construct PostgreSQL pool:', err);
    return null;
  }
}

function getMemPool() {
  if (!memPgPool) {
    try {
      const memDb = newDb({ autoCreateForeignKeyIndices: true });
      // pg-mem lacks some PG extensions; ignore CREATE EXTENSION failures at query time
      const adapter = memDb.adapters.createPg();
      memPgPool = new adapter.Pool();
      console.log('✅ In-memory PostgreSQL engine initialized via pg-mem.');
    } catch (err) {
      console.error('pg-mem initialization error:', err);
    }
  }
  return memPgPool;
}

realPoolInstance = buildRealPool();

/**
 * Probe real Postgres and set dbMode. Safe to call repeatedly.
 */
export async function initDatabaseConnection(): Promise<DbMode> {
  if (initDone && dbMode === 'postgres') return dbMode;

  // 1) Try real PostgreSQL
  if (realPoolInstance) {
    try {
      const client = await realPoolInstance.connect();
      try {
        const r = await client.query('SELECT 1 AS ok');
        if (r?.rows?.[0]?.ok === 1 || r?.rows?.[0]?.ok === '1') {
          isPgConnected = true;
          dbMode = 'postgres';
          initDone = true;
          console.log('✅ Database mode: real PostgreSQL (primary write path).');
          return dbMode;
        }
      } finally {
        client.release();
      }
    } catch (err: any) {
      const msg = err?.code === 'ECONNREFUSED'
        ? 'connection refused (is Postgres running?)'
        : (err?.message || String(err));
      console.warn(`⚠️  Real PostgreSQL unreachable — will use fallback. (${msg})`);
      isPgConnected = false;
    }
  }

  // 2) pg-mem fallback (SQL-compatible offline demo)
  const allowMem = process.env.DISABLE_PG_MEM !== 'true';
  if (allowMem) {
    const mem = getMemPool();
    if (mem) {
      dbMode = 'pg-mem';
      isPgConnected = false; // NOT real PG — routes that require durable writes should check isPgConnected
      initDone = true;
      console.log('ℹ️  Database mode: pg-mem (ephemeral SQL, not durable).');
      return dbMode;
    }
  }

  dbMode = 'memory';
  isPgConnected = false;
  initDone = true;
  console.log('ℹ️  Database mode: pure memory + JSON file store.');
  return dbMode;
}

function activeSqlPool(): any | null {
  if (dbMode === 'postgres' && realPoolInstance) return realPoolInstance;
  if (dbMode === 'pg-mem') return getMemPool();
  return null;
}

export const pgPool = {
  /**
   * Run a SQL query against the active backend.
   * In `postgres` mode, errors are thrown (no silent empty result).
   * In fallback modes, returns empty rows on failure to keep demos alive.
   */
  async query(text: string, params?: any[]) {
    const pool = activeSqlPool();

    if (dbMode === 'postgres' && realPoolInstance) {
      try {
        return await realPoolInstance.query(text, params);
      } catch (err: any) {
        console.error('PostgreSQL query error:', err?.message || err, text.slice(0, 80));
        throw err;
      }
    }

    if (pool) {
      try {
        return await pool.query(text, params);
      } catch (memErr: any) {
        // pg-mem often rejects extensions / some DDL — soft-warn
        const msg = memErr?.message || String(memErr);
        if (!/extension/i.test(msg)) {
          console.warn('Embedded SQL query warning:', msg);
        }
        // For non-postgres modes, don't crash reads
        if (/^\s*(SELECT|WITH)\b/i.test(text)) {
          return { rows: [], rowCount: 0 };
        }
        throw memErr;
      }
    }

    console.warn('No SQL backend available for query:', text.slice(0, 60));
    if (dbMode === 'postgres') {
      throw new Error('PostgreSQL primary backend is not connected');
    }
    return { rows: [], rowCount: 0 };
  },

  async connect() {
    if (dbMode === 'postgres' && realPoolInstance) {
      return realPoolInstance.connect();
    }
    const pool = activeSqlPool();
    if (pool && typeof pool.connect === 'function') {
      try {
        return await pool.connect();
      } catch (_e) {}
    }
    if (dbMode === 'postgres') {
      throw new Error('PostgreSQL primary backend is not connected');
    }
    console.warn('SQL connection fallback: no client available');
    return null;
  },
};

export function setPgConnected(value: boolean) {
  isPgConnected = value;
  if (value) dbMode = 'postgres';
}

export function setDbMode(mode: DbMode) {
  dbMode = mode;
  isPgConnected = mode === 'postgres';
}

export function getRealPool() {
  return realPoolInstance;
}

export function getDbMode(): DbMode {
  return dbMode;
}

export function isDurableSqlBackend(): boolean {
  return dbMode === 'postgres';
}

/**
 * Explicit transaction runner.
 * Uses real PG client when available; otherwise runs callback with pgPool
 * without BEGIN/COMMIT (best-effort for pg-mem / memory).
 */
export async function withTransaction<T>(
  callback: (client: any) => Promise<T>
): Promise<T> {
  let client: any = null;
  let inTransaction = false;
  try {
    client = await pgPool.connect();
    if (client && typeof client.query === 'function') {
      try {
        await client.query('BEGIN');
        inTransaction = true;
      } catch (_e) {
        inTransaction = false;
      }
    }
    const targetClient = client || pgPool;
    const result = await callback(targetClient);
    if (inTransaction && client) {
      await client.query('COMMIT');
    }
    return result;
  } catch (err) {
    if (inTransaction && client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.warn('Transaction rollback error:', rollbackErr);
      }
    }
    throw err;
  } finally {
    if (client && typeof client.release === 'function') {
      try {
        client.release();
      } catch (_e) {}
    }
  }
}

export async function getDbHealth(): Promise<{
  mode: DbMode;
  durable: boolean;
  ping?: string;
}> {
  const health: { mode: DbMode; durable: boolean; ping?: string } = {
    mode: dbMode,
    durable: dbMode === 'postgres',
  };
  if (dbMode === 'postgres' && realPoolInstance) {
    try {
      const r = await realPoolInstance.query('SELECT 1 AS ok');
      health.ping = r?.rows?.[0]?.ok != null ? 'ok' : 'unknown';
    } catch (err: any) {
      health.ping = `error: ${err?.message || err}`;
    }
  } else if (dbMode === 'pg-mem') {
    health.ping = 'pg-mem';
  } else {
    health.ping = 'memory-only';
  }
  return health;
}
