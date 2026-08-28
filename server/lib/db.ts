/**
 * PostgreSQL connection layer.
 *
 * Modes:
 *  1. `postgres` — real PostgreSQL (PRIMARY source of truth)
 *  2. `pg-mem`   — in-process SQL for demos (NOT durable)
 *  3. `memory`   — arrays + JSON file only (NOT durable)
 *
 * Production hardening:
 *  - NODE_ENV=production OR REQUIRE_POSTGRES=true → fail closed (no silent fallback)
 *  - ALLOW_DB_FALLBACK=true → explicitly permit pg-mem/memory even in production (not recommended)
 *  - Tests use fallback unless REQUIRE_POSTGRES=true
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

/** True when the process must not start without real Postgres. */
export function isPostgresRequired(): boolean {
  if (process.env.ALLOW_DB_FALLBACK === 'true') return false;
  if (process.env.REQUIRE_POSTGRES === 'true') return true;
  if (process.env.REQUIRE_POSTGRES === 'false') return false;
  // Production defaults to fail-closed
  return process.env.NODE_ENV === 'production';
}

function buildRealPool(): pg.Pool | null {
  try {
    const connectionString = process.env.DATABASE_URL;
    if (connectionString && connectionString.trim() && !connectionString.includes('://user:pass')) {
      return new RealPgPool({
        connectionString,
        connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 5000),
        idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
        max: Number(process.env.PG_POOL_MAX || 10),
      });
    }
    return new RealPgPool({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB || 'inventory_db',
      user: process.env.POSTGRES_USER || 'inventory_user',
      password: process.env.POSTGRES_PASSWORD || 'securepassword',
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 5000),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
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
 * Probe real Postgres and set dbMode.
 * Throws if Postgres is required but unreachable.
 */
export async function initDatabaseConnection(): Promise<DbMode> {
  if (initDone && dbMode === 'postgres') return dbMode;

  const required = isPostgresRequired();

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
      const msg =
        err?.code === 'ECONNREFUSED'
          ? 'connection refused (is Postgres running?)'
          : err?.message || String(err);
      if (required) {
        isPgConnected = false;
        dbMode = 'memory';
        initDone = true;
        throw new Error(
          `REQUIRE_POSTGRES: cannot reach PostgreSQL (${msg}). ` +
            `Set DATABASE_URL / POSTGRES_* correctly, or set ALLOW_DB_FALLBACK=true only for demos.`
        );
      }
      console.warn(`⚠️  Real PostgreSQL unreachable — will use fallback. (${msg})`);
      isPgConnected = false;
    }
  } else if (required) {
    initDone = true;
    throw new Error(
      'REQUIRE_POSTGRES: PostgreSQL pool could not be created. Check DATABASE_URL / POSTGRES_* env vars.'
    );
  }

  // 2) pg-mem fallback (never in required-postgres mode — already thrown above)
  const allowMem = process.env.DISABLE_PG_MEM !== 'true';
  if (allowMem) {
    const mem = getMemPool();
    if (mem) {
      dbMode = 'pg-mem';
      isPgConnected = false;
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
   * In fallback modes, SELECT failures return empty rows for demo resilience.
   */
  async query(text: string, params?: any[]) {
    if (dbMode === 'postgres' && realPoolInstance) {
      try {
        return await realPoolInstance.query(text, params);
      } catch (err: any) {
        console.error('PostgreSQL query error:', err?.message || err, text.slice(0, 80));
        throw err;
      }
    }

    const pool = activeSqlPool();
    if (pool) {
      try {
        return await pool.query(text, params);
      } catch (memErr: any) {
        const msg = memErr?.message || String(memErr);
        if (!/extension/i.test(msg)) {
          console.warn('Embedded SQL query warning:', msg);
        }
        if (/^\s*(SELECT|WITH)\b/i.test(text)) {
          return { rows: [], rowCount: 0 };
        }
        throw memErr;
      }
    }

    console.warn('No SQL backend available for query:', text.slice(0, 60));
    if (dbMode === 'postgres' || isPostgresRequired()) {
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
    if (dbMode === 'postgres' || isPostgresRequired()) {
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
  required: boolean;
  ping?: string;
  ready: boolean;
}> {
  const required = isPostgresRequired();
  const health: {
    mode: DbMode;
    durable: boolean;
    required: boolean;
    ping?: string;
    ready: boolean;
  } = {
    mode: dbMode,
    durable: dbMode === 'postgres',
    required,
    ready: dbMode === 'postgres',
  };

  if (dbMode === 'postgres' && realPoolInstance) {
    try {
      const r = await realPoolInstance.query('SELECT 1 AS ok');
      health.ping = r?.rows?.[0]?.ok != null ? 'ok' : 'unknown';
      health.ready = health.ping === 'ok';
    } catch (err: any) {
      health.ping = `error: ${err?.message || err}`;
      health.ready = false;
    }
  } else if (dbMode === 'pg-mem') {
    health.ping = 'pg-mem';
    health.ready = !required;
  } else {
    health.ping = 'memory-only';
    health.ready = !required;
  }
  return health;
}

/**
 * Re-check live connectivity (for readiness probes).
 * Does not change dbMode unless reconnect succeeds from a failed state.
 */
export async function pingPostgres(): Promise<boolean> {
  if (!realPoolInstance) return false;
  try {
    const client = await realPoolInstance.connect();
    try {
      const r = await client.query('SELECT 1 AS ok');
      return r?.rows?.[0]?.ok === 1 || r?.rows?.[0]?.ok === '1';
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}
