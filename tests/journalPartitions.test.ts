/**
 * SCALE-3 — monthly journal partitions are provisioned, not just declared.
 *
 * The ledger tables have been RANGE-partitioned since migration 0003, but the
 * only creator was `ensure_journal_month_partition()` on the posting path: a
 * fresh install had a DEFAULT catch-all and a new month was created by DDL
 * inside whichever user posted first. `boot/journalPartitions.ts` provisions a
 * window (current month plus lookahead) at boot and on demand.
 *
 * PROVES, against a real PostgreSQL when one is reachable:
 *   1. the window is contiguous and anchored on the reference month;
 *   2. provisioning fills exactly the months the status reported missing;
 *   3. a second run creates nothing (idempotent — the acceptance line in the
 *      worklist says a second run must be a no-op);
 *   4. after provisioning the window has no gaps and each child's bound covers
 *      its own month, so a row for that month can only land in the child;
 *   5. the DEFAULT partitions are reported with real row counts.
 *
 * The window used here is the real one (today ± lookahead): those partitions
 * are exactly what a production boot creates, so the test leaves the database
 * in the state the product wants. It deliberately creates NO far-future window
 * — a journal partition cannot be dropped while `gl_journal_lines` references
 * it (the inherited FK depends on the child), so a test that made one would
 * leave an undeletable table behind.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  describeJournalPartitions,
  journalPartitionStatus,
  monthKey,
  partitionWindow,
  provisionJournalPartitions,
} from '../server/src/boot/journalPartitions';
import type { PartitionSqlClient } from '../server/src/boot/journalPartitions';

dotenv.config();

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (partition DDL)';

describe('journal partition provisioning', () => {
  after(async () => {
    if (pool && dbReachable) await pool.end();
  });

  test('the window is contiguous and anchored on the reference month', () => {
    assert.deepEqual(partitionWindow(new Date('2031-06-15T00:00:00Z')), [
      '203105',
      '203106',
      '203107',
      '203108',
      '203109',
    ]);
    assert.equal(monthKey(new Date('2031-01-31T23:00:00Z')), '203101');
    assert.equal(monthKey(new Date('2031-12-01T00:00:00Z')), '203112');
    // A zero window is the reference month only; the range never inverts.
    assert.deepEqual(
      partitionWindow(new Date('2031-06-15T00:00:00Z'), { monthsBehind: 0, monthsAhead: 0 }),
      ['203106']
    );
  });

  test('provisioning fills exactly the months the status reported missing', { skip: skipNoDb }, async () => {
    const before = await journalPartitionStatus(pool!);
    assert.equal(before.window.length, 5, 'current month plus one behind and three ahead');
    assert.ok(before.defaultRows, 'the DEFAULT children exist after the baseline schema');
    assert.equal(typeof before.defaultRows!.journals, 'number');
    assert.equal(typeof before.defaultRows!.lines, 'number');

    const report = await provisionJournalPartitions(pool!);
    assert.deepEqual([...report.created].sort(), [...before.missing].sort(), 'only the gaps are created');
    assert.deepEqual(report.missing, [], 'no gap remains in the window');
    assert.deepEqual([...report.present].sort(), [...report.window].sort());
  });

  test('a second run is a no-op', { skip: skipNoDb }, async () => {
    const again = await provisionJournalPartitions(pool!);
    assert.deepEqual(again.created, [], 'provisioning is idempotent');
    assert.deepEqual(again.missing, []);
    assert.deepEqual(again.failed, [], 'a healthy window refuses no month');
  });

  /**
   * A dirty DEFAULT makes PostgreSQL reject the ATTACH for that month. The job
   * must record it and keep going: the operator's next boot still gets the
   * other months instead of losing the whole window to one poisoned one.
   *
   * Stubbed rather than run against the database on purpose. Emulating the
   * refusal for real means inserting a journal row dated in a partitionless
   * month (it lands in DEFAULT) and then provisioning past it — and the
   * partitions such a test creates cannot be dropped again while
   * `gl_journal_lines` references them. What is under test here is the loop's
   * isolation, not PostgreSQL's constraint, so the constraint is the stub.
   */
  test('a month whose DDL is refused is reported and the rest of the window still gets provisioned', async () => {
    const existing = new Set(['gl_journals_203106', 'gl_journal_lines_203106']);
    const attempted: string[] = [];
    const stub: PartitionSqlClient = {
      async query(text: string, params?: any[]) {
        if (text.includes('to_regclass')) {
          const name = String(params?.[0]);
          return { rows: [{ reg: existing.has(name) ? name : null }] };
        }
        if (text.includes('ensure_journal_month_partition')) {
          const month = String(params?.[0]).slice(0, 7).replace('-', '');
          attempted.push(month);
          if (month === '203107') {
            throw new Error(
              'updated partition constraint for default partition "gl_journals_default" would be violated by some row'
            );
          }
          existing.add(`gl_journals_${month}`);
          existing.add(`gl_journal_lines_${month}`);
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    const report = await provisionJournalPartitions(stub, {
      now: new Date('2031-06-15T00:00:00Z'),
      monthsBehind: 0,
      monthsAhead: 2,
    });

    assert.deepEqual(
      attempted,
      ['203107', '203108'],
      'the complete month is skipped, and the month after the refused one is still attempted'
    );
    assert.deepEqual(report.created, ['203108'], 'the failure did not abandon the rest of the window');
    assert.deepEqual(report.failed.map((entry) => entry.month), ['203107']);
    assert.match(report.failed[0].message, /default partition/, 'the operator keeps PostgreSQL\'s own reason');
    assert.deepEqual(report.missing, ['203107'], 'a refused month is reported missing, never silently present');
    assert.deepEqual(report.present, ['203106', '203108']);
    assert.match(describeJournalPartitions(report), /failed 203107/, 'the boot log names the month');
  });

  test('each child covers exactly its own month, so rows cannot fall through', { skip: skipNoDb }, async () => {
    const status = await journalPartitionStatus(pool!);
    for (const key of status.window) {
      const year = key.slice(0, 4);
      const month = Number(key.slice(4, 6));
      const next =
        month === 12 ? `${Number(year) + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const start = `${year}-${String(month).padStart(2, '0')}-01`;

      for (const table of [`gl_journals_${key}`, `gl_journal_lines_${key}`]) {
        const child = status.children.find((entry) => entry.name === table);
        assert.ok(child, `${table} must be a child partition`);
        assert.ok(child!.bound && child!.bound.includes(start), `${table} bound starts at ${start}: ${child!.bound}`);
        assert.ok(child!.bound && child!.bound.includes(next), `${table} bound ends at ${next}: ${child!.bound}`);
      }
    }
  });

  test('the CLI entry point shares this module instead of a second copy of the DDL', () => {
    const source = readFileSync(new URL('../scripts/check_partitions.ts', import.meta.url), 'utf8');
    assert.match(source, /from '\.\.\/server\/src\/boot\/journalPartitions'/, 'the script imports the boot module');
    assert.doesNotMatch(source, /CREATE TABLE/, 'the script must not carry its own partition DDL');
    assert.match(source, /process\.exitCode\s*=/, 'the check must fail the command when it finds a gap');
  });

  test('the server provisions the window during boot', () => {
    const boot = readFileSync(new URL('../server/src/boot/dbBoot.ts', import.meta.url), 'utf8');
    assert.match(boot, /provisionJournalPartitions\(client\)/, 'the boot path must provision, not only the posting path');
    assert.match(boot, /defaultPartitionIsDirty/, 'a dirty DEFAULT partition must be visible in the boot log');
  });
});
