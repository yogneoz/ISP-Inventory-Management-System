/**
 * Accounting outbox maintenance (MyWorkplace v2).
 *
 *   npm run accounting-outbox:pending          # what is owed, oldest first
 *   npm run accounting-outbox:flush            # post everything owed
 *   npm run accounting-outbox:flush -- --limit 20
 *
 * `pending` exits 1 while work is owed, so a cron or a health probe can alarm on
 * it. `flush` exits 1 when any row failed, printing the reason it recorded — a
 * chart without the expense/payable posting roles names the remedy rather than
 * guessing an account.
 */
import 'dotenv/config';
import { flushAccountingOutbox, listAccountingOutbox } from '../server/src/services/accountingOutbox.service';
import { OUTBOX_PENDING_COUNT_SQL } from '../server/src/models/accountingOutbox.repo';
import { ensurePostgresConnection, pgPool } from '../server/db';

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

async function pending(): Promise<number> {
  const rows = await listAccountingOutbox({ limit: Number(argValue('--limit')) || 50 });
  const count = Number((await pgPool.query(OUTBOX_PENDING_COUNT_SQL, [null])).rows[0]?.count || 0);
  const owed = rows.filter((row) => ['QUEUED', 'FAILED'].includes(String(row.status)));
  console.log(`accounting outbox: ${count} owed, ${rows.length} recent row(s) shown`);
  for (const row of owed) {
    console.log(
      `  ${row.status.padEnd(8)} ${row.source_type}:${row.source_id} ${row.amount} ${row.currency}` +
        ` attempts=${row.attempts}${row.last_error ? ` last_error="${row.last_error}"` : ''}`
    );
  }
  return count;
}

async function flush(): Promise<number> {
  const result = await flushAccountingOutbox({ limit: Number(argValue('--limit')) || 50 });
  console.log(
    `accounting outbox flush: posted ${result.posted}, failed ${result.failed}, remaining ${result.remaining}`
  );
  for (const error of result.errors) {
    console.log(`  FAILED ${error.id}: ${error.message}`);
  }
  return result.failed;
}

async function main(): Promise<void> {
  // Standalone process: the shared app pool answers no query until a boot has
  // proven the database reachable, and a CLI has no boot. Without this probe
  // every command "failed" with DB_UNAVAILABLE and the flush posted nothing.
  if (!(await ensurePostgresConnection())) {
    throw new Error('PostgreSQL is not reachable; nothing was queued or posted.');
  }
  const command = process.argv[2] || 'pending';
  if (command === 'pending') {
    process.exitCode = (await pending()) > 0 ? 1 : 0;
    return;
  }
  if (command === 'flush') {
    process.exitCode = (await flush()) > 0 ? 1 : 0;
    return;
  }
  console.error(`Unknown command "${command}". Use pending or flush.`);
  process.exitCode = 2;
}

// The pool is the shared server pool; the process exits once main() settles, so
// there is nothing to close by hand here.
main().catch((error) => {
  console.error('accounting-outbox failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
