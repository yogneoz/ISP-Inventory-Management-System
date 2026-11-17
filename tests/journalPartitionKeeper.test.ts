/**
 * Worklist A1 — the partition window is kept ahead of the calendar while the
 * process is up.
 *
 * `boot/dbBoot.ts` provisions the window once per boot and 2026-11-17 measured
 * that it is the only caller besides the CLI, so a process that stays up past
 * the three-month lookahead would return to creating the current month with DDL
 * inside a user's transaction. The keeper re-runs the same idempotent job on a
 * timer: leader-only across workers, local on a single-worker install, and it
 * never throws into the timer.
 *
 * PROVES, with no database (a stub client):
 *   1. a tick provisions the window and logs the summary;
 *   2. a month PostgreSQL refuses is reported, the other months are still
 *      created, and the tick does not throw;
 *   3. a second worker holding the shared lock skips the tick instead of
 *      duplicating the DDL;
 *   4. without Redis the single worker still runs the tick locally;
 *   5. the timer is armed once, a second start returns the running keeper, and
 *      `stop()` prevents further ticks.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { PartitionSqlClient } from '../server/src/boot/journalPartitions';
import { partitionWindow } from '../server/src/boot/journalPartitions';
import {
  runJournalPartitionKeeperTick,
  startJournalPartitionKeeper,
} from '../server/src/boot/journalPartitionKeeper';
import { MemorySharedStore, configureSharedStore } from '../server/src/state/sharedStore';

const NOW = new Date('2031-06-15T00:00:00Z');
const EXPECTED = partitionWindow(NOW);

/** Minimal stand-in for the pool: catalog reads, the DDL function, nothing else. */
function stubClient(options: { rejectMonths?: string[] } = {}) {
  const existing = new Set<string>(['gl_journals_default', 'gl_journal_lines_default']);
  const reject = new Set(options.rejectMonths ?? []);
  const created: string[] = [];
  const client: PartitionSqlClient & { created: string[] } = {
    created,
    async query(text: string, params?: unknown[]) {
      if (text.includes('to_regclass')) {
        const name = String(params?.[0]);
        return { rows: [{ reg: existing.has(name) ? name : null }] } as any;
      }
      if (text.includes('ensure_journal_month_partition')) {
        const key = String(params?.[0]).slice(0, 7).replace('-', '');
        if (reject.has(key)) throw new Error(`partition for ${key} refused: dirty DEFAULT`);
        existing.add(`gl_journals_${key}`);
        existing.add(`gl_journal_lines_${key}`);
        created.push(key);
        return { rows: [] } as any;
      }
      if (text.includes('FROM gl_journals_default')) {
        return { rows: [{ journals: 0, lines: 0 }] } as any;
      }
      if (text.includes('relpartbound')) return { rows: [] } as any;
      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    },
  };
  return client;
}

describe('journal partition keeper (A1)', () => {
  test('a tick provisions the whole window and reports it', async () => {
    // A memory store is what a single-worker install runs with: the keeper must
    // still do the work there.
    configureSharedStore(new MemorySharedStore());
    const client = stubClient();
    const logs: string[] = [];
    const outcome = await runJournalPartitionKeeperTick(client, {
      now: () => NOW,
      log: (line) => logs.push(line),
      warn: (line) => logs.push(line),
    });
    assert.equal(outcome, 'provisioned');
    assert.deepEqual([...client.created].sort(), [...EXPECTED].sort());
    assert.ok(
      logs.some((line) => line.includes('kept ahead') && line.includes('203105..203109')),
      `expected a window summary, got ${JSON.stringify(logs)}`
    );
  });

  test('a refused month is reported and the remaining months are still created', async () => {
    configureSharedStore(new MemorySharedStore());
    const client = stubClient({ rejectMonths: ['203106'] });
    const logs: string[] = [];
    const outcome = await runJournalPartitionKeeperTick(client, {
      now: () => NOW,
      log: (line) => logs.push(line),
      warn: (line) => logs.push(line),
    });
    assert.equal(outcome, 'provisioned', 'a refused month must not fail the tick');
    assert.deepEqual(
      [...client.created].sort(),
      EXPECTED.filter((key) => key !== '203106').sort()
    );
    assert.ok(logs.some((line) => line.includes('203106') && line.includes('refused')));
    assert.ok(logs.some((line) => line.includes('need attention')));
  });

  test('a second worker holding the lock skips instead of duplicating the DDL', async () => {
    const store = new MemorySharedStore('redis');
    configureSharedStore(store);
    await store.setNxPx('isp:lock:journal-partitions', 'worker-b', 60_000);
    const client = stubClient();
    const outcome = await runJournalPartitionKeeperTick(client, { now: () => NOW, log: () => {}, warn: () => {} });
    assert.equal(outcome, 'skipped');
    assert.deepEqual(client.created, [], 'the follower runs no DDL');
  });

  test('without Redis the single worker still runs the tick', async () => {
    configureSharedStore(new MemorySharedStore());
    const client = stubClient();
    const outcome = await runJournalPartitionKeeperTick(client, { now: () => NOW, log: () => {}, warn: () => {} });
    assert.equal(outcome, 'provisioned');
    assert.ok(client.created.length > 0);
  });

  test('the timer is armed once, and stop() ends it', async () => {
    configureSharedStore(new MemorySharedStore());
    const client = stubClient();
    const options = { intervalMs: 10, now: () => NOW, log: () => {}, warn: () => {} };
    const keeper = startJournalPartitionKeeper(client, options);
    assert.equal(startJournalPartitionKeeper(client, options), keeper, 'a second start reuses the running keeper');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const afterTicks = client.created.length;
    assert.ok(afterTicks > 0, 'the timer fired');
    keeper.stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(client.created.length, afterTicks, 'no tick runs after stop()');
    // Leave the module ready for another test file run.
    startJournalPartitionKeeper(client, options).stop();
  });
});
