type SqlExecutor = { query: (text: string, params?: any[]) => Promise<any> };
type PurgeHandle = SqlExecutor & { connect?: () => Promise<any>; release?: () => void };

/**
 * Delete audit rows that a test fixture created.
 *
 * `audit_logs` is append-only in the database (worklist A7): a DELETE or UPDATE
 * without the purge switch raises. Test cleanup is a legitimate removal of its
 * own evidence, so it goes through the same schema-sanctioned switch the ledger
 * purge uses — `SET LOCAL inventory.allow_ledger_purge = 'on'` inside one
 * transaction — instead of the guard being loosened for everyone.
 *
 * The caller's pool or client is used, and a transaction pins one connection for
 * the SET LOCAL and the DELETE; a pool-level BEGIN would not.
 */
export async function purgeAuditLogs(
  db: PurgeHandle,
  sql: string,
  params: unknown[] = []
): Promise<void> {
  // A PoolClient also exposes connect(), so presence of `connect` is not enough
  // to tell it from a Pool; only a pool has no release().
  const ownsClient = typeof db.release !== 'function' && typeof db.connect === 'function';
  const client: PurgeHandle = ownsClient ? await db.connect!() : db;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL inventory.allow_ledger_purge = 'on'`);
    await client.query(sql, params as any[]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    if (ownsClient) client.release?.();
  }
}
