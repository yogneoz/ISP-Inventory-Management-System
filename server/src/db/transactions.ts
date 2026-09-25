/**
 * Explicit database transaction helpers extracted from app.ts (backlog
 * item #6 — app.ts extraction). Thin, stateless wrappers over the shared
 * pg pool.
 */
import { pgPool } from '../../db';

/**
 * Explicit Database Transaction Runner
 * Executes a sequence of SQL queries inside an explicit BEGIN...COMMIT / ROLLBACK block
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

/**
 * Runs `fn` with a dedicated pooled connection (no transaction). Use when a
 * multi-statement read needs one consistent connection (e.g. cache hydration)
 * but atomicity is not required; use withTransaction for writes.
 */
export async function withConnection<T>(
  callback: (client: any) => Promise<T>
): Promise<T> {
  const client = await pgPool.connect();
  try {
    return await callback(client);
  } finally {
    if (client && typeof client.release === 'function') {
      try {
        client.release();
      } catch (_e) {}
    }
  }
}
