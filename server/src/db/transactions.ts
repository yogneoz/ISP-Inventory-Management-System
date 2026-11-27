/**
 * Explicit database transaction helpers extracted from app.ts (backlog
 * item #6 — app.ts extraction). Thin, stateless wrappers over the shared
 * pg pool.
 */
import { pgPool } from '../../db';
import { recordTransactionRetry } from './transactionMetrics';
import { markRequestWrote } from './readRouting';

/**
 * One attempt of the transaction runner. Extracted so the retry wrapper below
 * can replay the whole callback without changing what a single attempt does.
 */
async function runTransactionOnce<T>(callback: (client: any) => Promise<T>): Promise<T> {
  let client: any = null;
  let inTransaction = false;
  try {
    client = await pgPool.connect();
    if (client) {
      // SCALE-3: an explicit transaction may write, and a read inside it must
      // see the transaction's own work. Marking the request here (rather than
      // trying to sniff every statement the callback sends) keeps every later
      // replica-eligible read of this request on the primary.
      markRequestWrote();
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
 * SQLSTATEs PostgreSQL aborts one participant of, rather than failing the
 * statement: a deadlock (40P01) and a serialization failure (40001).
 */
const RETRYABLE_TRANSACTION_CODES = new Set(['40P01', '40001']);
const TRANSACTION_ATTEMPTS = 3;

/**
 * Replays `run` when PostgreSQL aborts the attempt with one of
 * RETRYABLE_TRANSACTION_CODES.
 *
 * The write path and the statement read path must retry the same aborts, the
 * same number of times, with the same backoff and the same counters — otherwise
 * the read side keeps surfacing a 500 for a collision the write side already
 * survives. `label` only names the replay in the log line.
 *
 * Exported for callers outside those two runners that drive the same contended
 * DDL directly: the partition suites create a fixture month with
 * `ensure_*_month_partition()` on their own pool, and without this loop a
 * sibling suite provisioning a neighbouring month at the same moment aborted
 * them with 40P01.
 */
export async function replayOnContention<T>(label: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (err: any) {
      const code = String(err?.code || '');
      if (attempt >= TRANSACTION_ATTEMPTS || !RETRYABLE_TRANSACTION_CODES.has(code)) {
        throw err;
      }
      // The aborted attempt released every lock it held, so a short jittered
      // pause is enough — and the jitter keeps the two victims from colliding
      // again in lockstep.
      recordTransactionRetry(code);
      const delayMs = 10 * attempt + Math.floor(Math.random() * 20);
      console.warn(
        `${label} aborted by ${code} (attempt ${attempt}/${TRANSACTION_ATTEMPTS}); retrying in ${delayMs} ms.`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Explicit Database Transaction Runner
 * Executes a sequence of SQL queries inside an explicit BEGIN...COMMIT / ROLLBACK block.
 *
 * A deadlock is detectable and PostgreSQL resolves it by aborting one
 * transaction — it is not a bug in either request, and the victim's work was
 * rolled back, so replaying it is the documented remedy. Accounting postings
 * contend on shared fiscal-year and period rows, so two concurrent requests can
 * collide even when each is correct on its own; retrying here keeps one of them
 * from surfacing as a 500 (and from making the suite flaky). The callback must
 * therefore be replay-safe: DB work only, no external side effects.
 */
export async function withTransaction<T>(
  callback: (client: any) => Promise<T>
): Promise<T> {
  return replayOnContention('Transaction', () => runTransactionOnce(callback));
}

/**
 * Read-path replay for the financial statements.
 *
 * A statement read holds only AccessShareLock, but PostgreSQL still picks a
 * deadlock victim by cost, and it can be the reader: the posting path creates a
 * month partition on demand (`SELECT ensure_journal_month_partition(date)`,
 * which is DDL and takes AccessExclusiveLock on the journal parents) while a
 * statement is reading the same tables, and the two lock orders can close a
 * cycle. The write path has always replayed its half of that collision; without
 * the same replay the reader surfaced as a 500 for a conflict that is not a bug
 * in the request — and it is exactly what made shard 1 of the suite flaky.
 *
 * Nothing a read wrote can be lost by re-running it, and the callback must stay
 * a pure read: it is replayed from the start.
 */
export async function withReadReplay<T>(run: () => Promise<T>): Promise<T> {
  return replayOnContention('Statement read', run);
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
