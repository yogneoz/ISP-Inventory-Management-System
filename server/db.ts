import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool: RealPgPool } = pg;
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

export const pgPool = {
  async query(text: string, params?: any[]) {
    if (!isPgConnected || !realPoolInstance) {
      throw new Error('PostgreSQL is not connected. Database operations are unavailable.');
    }
    try {
      return await realPoolInstance.query(text, params);
    } catch (err: any) {
      isPgConnected = false;
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
