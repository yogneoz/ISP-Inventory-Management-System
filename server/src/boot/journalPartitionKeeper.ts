/**
 * Keeps the journal partition window ahead of the calendar (worklist A1).
 *
 * `boot/dbBoot.ts` provisions one month behind and three ahead once per boot.
 * That is correct for a process that restarts monthly and wrong for one that
 * does not: 2026-11-17 measured only two callers of the provisioning job (the
 * boot and the CLI), so a server that stays up past the lookahead silently
 * returns to creating the current month with DDL under an ACCESS EXCLUSIVE lock
 * inside the user's transaction — the exact cost the provisioning slice removed.
 * This keeper re-runs the SAME idempotent job on a timer. It never carries a
 * second copy of the window logic or the DDL.
 *
 * Leadership: with Redis the tick takes the shared `journal-partitions` lock, so
 * one worker runs the DDL and the others skip cleanly. Without Redis there is
 * one worker, so it runs locally — the same convention `withStartupLeadership`
 * uses for the boot job.
 *
 * Failure policy: a tick never throws into the timer. A month PostgreSQL refuses
 * (a dirty DEFAULT) is logged and retried on the next tick, and a database that
 * is briefly unreachable must not become an unhandled rejection that kills the
 * process.
 */
import { createSharedLock } from '../state/sharedLock';
import { isRedisSharedState } from '../state/sharedStore';
import {
  defaultPartitionIsDirty,
  describeJournalPartitions,
  provisionJournalPartitions,
  type PartitionSqlClient,
} from './journalPartitions';
import {
  defaultLogPartitionIsDirty,
  describeLogPartitions,
  provisionLogPartitions,
  repairLogDefaultPartitions,
} from './logPartitions';

/**
 * Six hours. The window is months wide, so drift between ticks is harmless; the
 * point is that the job keeps running without a restart, not that it runs often.
 */
export const PARTITION_KEEPER_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOCK_KEY = 'journal-partitions';
const LOCK_TTL_MS = 10 * 60 * 1000;

export interface PartitionKeeperOptions {
  /** Override the tick interval (tests). */
  intervalMs?: number;
  /** Reference instant for the window; defaults to "now" per tick. */
  now?: () => Date;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export type PartitionKeeperOutcome = 'provisioned' | 'skipped' | 'failed';

/**
 * One tick: leader-only across workers, local on a single-worker install, and
 * never throws.
 */
export async function runJournalPartitionKeeperTick(
  client: PartitionSqlClient,
  options: PartitionKeeperOptions = {}
): Promise<PartitionKeeperOutcome> {
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const now = options.now ? options.now() : new Date();

  const run = async (): Promise<PartitionKeeperOutcome> => {
    try {
      const report = await provisionJournalPartitions(client, { now });
      // The log tables share the window and the same idempotent DDL functions;
      // keeping them here means one timer owns every partitioned table (A7).
      const logs = await provisionLogPartitions(client, { now });
      const logSummary = describeLogPartitions(logs);
      if (logs.failed.length || defaultLogPartitionIsDirty(logs)) {
        warn(`⚠️  Log partitions need attention: ${logSummary}`);
        for (const failure of logs.failed) {
          warn(`   ${failure.table} ${failure.month} was not created: ${failure.message}`);
        }
        // A dated row in DEFAULT is a write that arrived before its month was
        // provisioned (a backdated entry, or a server that outlived the
        // lookahead). Moving it into its month here is what keeps DEFAULT from
        // becoming a permanent parking lot — the write itself never fails.
        if (defaultLogPartitionIsDirty(logs)) {
          const repaired = await repairLogDefaultPartitions(client, { apply: true });
          if (repaired.failures.length) {
            for (const failure of repaired.failures) warn(`   log repair: ${failure}`);
          } else {
            log(`   log repair moved ${repaired.moved} row(s) out of DEFAULT`);
          }
        }
      } else {
        log(`✅ Log partitions kept ahead: ${logSummary}`);
      }
      const summary = describeJournalPartitions(report);
      if (report.failed.length || defaultPartitionIsDirty(report)) {
        warn(`⚠️  Journal partitions need attention: ${summary}`);
      } else {
        log(`✅ Journal partitions kept ahead: ${summary}`);
      }
      for (const failure of report.failed) {
        warn(`   month ${failure.month} was not created: ${failure.message}`);
      }
      return 'provisioned';
    } catch (err: any) {
      warn(`Journal partition keeper tick failed: ${err?.message || err}`);
      return 'failed';
    }
  };

  if (!isRedisSharedState()) return run();
  const result = await createSharedLock().withLock(LOCK_KEY, LOCK_TTL_MS, run);
  return result.acquired ? (result.value as PartitionKeeperOutcome) : 'skipped';
}

let active: { stop(): void } | null = null;

/**
 * Start the keeper. Idempotent — a second call returns the running keeper rather
 * than arming a second timer — and unref'd so it never holds the event loop open.
 */
export function startJournalPartitionKeeper(
  client: PartitionSqlClient,
  options: PartitionKeeperOptions = {}
): { stop(): void } {
  if (active) return active;
  const intervalMs = options.intervalMs ?? PARTITION_KEEPER_INTERVAL_MS;
  const timer = setInterval(() => {
    void runJournalPartitionKeeperTick(client, options);
  }, intervalMs);
  timer.unref?.();
  const keeper = {
    stop(): void {
      clearInterval(timer);
      if (active === keeper) active = null;
    },
  };
  active = keeper;
  return keeper;
}
