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
    assert.equal(typeof before.defaultRows!.subledger, 'number', 'the subledger DEFAULT is reported too');

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

  /**
   * SCALE-3's first table conversion: `gl_subledger_entries` is RANGE-partitioned
   * by `entry_date_ad`, provisioned from the same month function the journals
   * use, and guarded like the rest of the ledger. The conversion is a shadow
   * table + swap (migration 0034), so this checks the shape the database
   * actually ended up with, not the DDL that was meant to run.
   */
  test('the subledger ledger is partitioned by entry date, provisioned and guarded', { skip: skipNoDb }, async () => {
    const kind = await pool!.query(
      `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'gl_subledger_entries'`
    );
    assert.equal(kind.rows[0]?.relkind, 'p', 'gl_subledger_entries must be a partitioned parent');

    const children = await pool!.query(
      `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_class c
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'gl_subledger_entries'
        ORDER BY c.relname`
    );
    const months = children.rows.filter((row: any) => row.bound && row.bound !== 'DEFAULT');
    assert.ok(months.length > 0, 'the conversion created a child for every month the rows occupy');

    // A conversion that left rows behind in the catch-all would have lost the
    // pruning it exists for; the count is exact because DEFAULT must be empty.
    const defaults = await pool!.query('SELECT count(*)::int AS n FROM gl_subledger_entries_default');
    assert.equal(defaults.rows[0].n, 0, 'no converted row may sit in the DEFAULT partition');

    const written = await pool!.query(
      `SELECT to_char(entry_date_ad, 'YYYY-MM') AS ym, count(*)::int AS n
         FROM gl_subledger_entries GROUP BY 1 ORDER BY n DESC LIMIT 1`
    );
    assert.ok(written.rows.length > 0, 'the fixture database holds posted subledger rows');
    const month = String(written.rows[0].ym);
    const start = `${month}-01`;
    const boundary = new Date(`${start}T00:00:00Z`);
    boundary.setUTCMonth(boundary.getUTCMonth() + 1);
    const next = boundary.toISOString().slice(0, 10);

    // One month's total must touch exactly one child. enable_seqscan is off so
    // the plan is the partition choice rather than a cost comparison.
    await pool!.query('BEGIN');
    try {
      await pool!.query('SET LOCAL enable_seqscan = off');
      const plan = await pool!.query(
        `EXPLAIN (COSTS OFF) SELECT sum(debit), sum(credit) FROM gl_subledger_entries
          WHERE entry_date_ad >= DATE '${start}' AND entry_date_ad < DATE '${next}'`
      );
      const text = plan.rows.map((row: any) => Object.values(row)[0]).join('\n');
      const touched = [...new Set(text.match(/gl_subledger_entries_[0-9]{6}/g) || [])];
      assert.deepEqual(touched, [`gl_subledger_entries_${month.replace('-', '')}`], `one month, one child:\n${text}`);
      assert.doesNotMatch(text, /gl_subledger_entries_default/, 'the catch-all is never read for a dated month');
    } finally {
      await pool!.query('ROLLBACK');
    }

    // The append-only guard reaches the child, not only the parent: DML aimed
    // straight at the month is refused unless the purge switch is set.
    const child = months.find((row: any) => row.name === `gl_subledger_entries_${month.replace('-', '')}`);
    assert.ok(child, 'the busiest month must have its own child');
    await pool!.query('BEGIN');
    try {
      await pool!.query("SET LOCAL inventory.allow_ledger_purge = 'off'");
      await assert.rejects(
        pool!.query(
          `UPDATE ${child!.name} SET credit = credit + 1 WHERE entry_date_ad >= DATE '${start}' AND entry_date_ad < DATE '${next}'`
        ),
        /append-only/,
        'a child partition must refuse an UPDATE of a posted row'
      );
    } finally {
      await pool!.query('ROLLBACK');
    }
  });

  test('the month function provisions the subledger child with the journal children', () => {
    const source = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
    assert.match(
      source,
      /CREATE TABLE IF NOT EXISTS gl_subledger_entries_default\s+PARTITION OF gl_subledger_entries DEFAULT/,
      'a fresh install declares the DEFAULT catch-all'
    );
    const journalFn = source.slice(source.indexOf('CREATE OR REPLACE FUNCTION ensure_journal_month_partition'));
    assert.match(
      journalFn.slice(0, journalFn.indexOf('END;')),
      /PERFORM ensure_subledger_month_partition\(p_date\)/,
      'the posting path provisions all three ledger tables from one call'
    );
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
