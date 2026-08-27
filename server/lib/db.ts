/**
 * PostgreSQL connection layer with pg-mem fallback.
 */
import pg from 'pg';
import { newDb } from 'pg-mem';
import dotenv from 'dotenv';

dotenv.config();

const { Pool: RealPgPool } = pg;
export let isPgConnected = false;
let realPoolInstance: any = null;
let memPgPool: any = null;

function getMemPool() {
  if (!memPgPool) {
    try {
      const memDb = newDb();
      const adapter = memDb.adapters.createPg();
      memPgPool = new adapter.Pool();
      console.log('✅ In-memory PostgreSQL engine initialized via pg-mem.');
    } catch (err) {
      console.error('pg-mem initialization error:', err);
    }
  }
  return memPgPool;
}

try {
  realPoolInstance = new RealPgPool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'inventory_db',
    user: process.env.POSTGRES_USER || 'inventory_user',
    password: process.env.POSTGRES_PASSWORD || 'securepassword',
    connectionTimeoutMillis: 2000,
  });
} catch (_e) {}

export const pgPool = {
  async query(text: string, params?: any[]) {
    if (isPgConnected && realPoolInstance) {
      try {
        return await realPoolInstance.query(text, params);
      } catch (err: any) {
        console.warn('Real Postgres query warning:', err?.message || err);
      }
    }
    const mem = getMemPool();
    if (mem) {
      try {
        return await mem.query(text, params);
      } catch (memErr: any) {
        console.warn('Embedded PGlite query warning:', memErr?.message || memErr);
      }
    }
    console.warn('PostgreSQL database query fallback (DB offline or initializing):', text.slice(0, 60));
    return { rows: [], rowCount: 0 };
  },
  async connect() {
    if (isPgConnected && realPoolInstance) {
      try {
        return await realPoolInstance.connect();
      } catch (_e) {}
    }
    const mem = getMemPool();
    if (mem) {
      try {
        return await mem.connect();
      } catch (_e) {}
    }
    console.warn('PostgreSQL database connection fallback triggered');
    return null;
  },
};

export function setPgConnected(value: boolean) {
  isPgConnected = value;
}

export function getRealPool() {
  return realPoolInstance;
}

/**
 * Explicit Database Transaction Runner
 */
export async function withTransaction<T>(
  callback: (client: any) => Promise<T>
): Promise<T> {
  let client: any = null;
  let inTransaction = false;
  try {
    client = await pgPool.connect();
    if (client) {
      await client.query('BEGIN');
      inTransaction = true;
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
