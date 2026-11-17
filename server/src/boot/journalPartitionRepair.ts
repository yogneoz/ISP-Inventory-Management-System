/**
 * Move rows out of the DEFAULT journal partitions (worklist A5).
 *
 * `DEFAULT` is the catch-all the partitioned ledger was created with. Rows that
 * land there cannot be pruned, and PostgreSQL refuses to attach a monthly child
 * for a month `DEFAULT` already holds rows in — so a dirty `DEFAULT` is both a
 * retention defect and the reason a month can never be provisioned. Until now
 * the code could only *detect* it (`check:partitions`, the boot warning) and the
 * audit doc called the fix a manual step. This is that step, automated.
 *
 * The repair is one transaction and deletes nothing that is not reinserted:
 *
 *   1. stage the rows of both DEFAULT children in temporary tables;
 *   2. clear DEFAULT — the ledger's append-only trigger has a documented purge
 *      switch (`inventory.allow_ledger_purge`), set with `SET LOCAL` so it is
 *      scoped to this transaction;
 *   3. create the months with the SAME function the posting path uses;
 *   4. reinsert through the parent, so PostgreSQL routes by the partition key;
 *   5. verify every staged row is readable from the parent again before COMMIT.
 *
 * Why not `DETACH PARTITION …` as the audit note suggested: a line in
 * `gl_journal_lines_default` references its journal row by the composite key, so
 * detaching the journals DEFAULT is refused with "removing partition … violates
 * foreign key constraint", and dropping the detached table's FK does not
 * round-trip through ATTACH. Staging reaches the identical end state — DEFAULT
 * empty and still attached, every row in its month — without touching the
 * membership of any other month.
 *
 * The registry-sync triggers are disabled for the reinsert only: the registry
 * rows already exist (the original insert created them) and the trigger is a
 * plain INSERT, so replaying it would collide. They are re-enabled before
 * COMMIT, and any failure rolls the whole thing back, DDL included.
 */
import {
  journalPartitionStatus,
  defaultPartitionIsDirty,
  type JournalPartitionCounts,
  type PartitionSqlClient,
} from './journalPartitions';

export interface PartitionRepairOptions {
  /** Execute the repair. Without it the call only reports the plan. */
  apply?: boolean;
  /** Reference instant for the post-repair status window. */
  now?: Date;
}

export interface PartitionRepairReport {
  /** True only when the repair actually ran and moved rows. */
  repaired: boolean;
  reason: 'clean' | 'planned' | 'repaired';
  dirtyBefore: JournalPartitionCounts | null;
  /** Months found in the DEFAULT rows, as YYYYMM, sorted. */
  months: string[];
  journalsMoved: number;
  linesMoved: number;
  dirtyAfter: JournalPartitionCounts | null;
}

const REGISTRY_TRIGGERS: Array<[table: string, trigger: string]> = [
  ['gl_journals', 'trg_gl_journals_registry_sync'],
  ['gl_journal_lines', 'trg_gl_journal_lines_registry_sync'],
];

/** Months present in the DEFAULT children, plus a count of undated rows. */
async function defaultMonths(client: PartitionSqlClient): Promise<{ months: string[]; undated: number }> {
  const result = await client.query(
    `SELECT month, SUM(undated)::int AS undated
       FROM (
         SELECT to_char(journal_date_ad, 'YYYYMM') AS month,
                CASE WHEN journal_date_ad IS NULL THEN 1 ELSE 0 END AS undated
           FROM gl_journals_default
         UNION ALL
         SELECT to_char(journal_date_ad, 'YYYYMM') AS month,
                CASE WHEN journal_date_ad IS NULL THEN 1 ELSE 0 END AS undated
           FROM gl_journal_lines_default
       ) rows
      GROUP BY month`
  );
  const months: string[] = [];
  let undated = 0;
  for (const row of result.rows as Array<{ month: string | null; undated: number }>) {
    if (row.month === null) undated += Number(row.undated) || 0;
    else months.push(String(row.month));
  }
  return { months: [...new Set(months)].sort(), undated };
}

export async function repairDefaultPartitions(
  client: PartitionSqlClient,
  options: PartitionRepairOptions = {}
): Promise<PartitionRepairReport> {
  const before = await journalPartitionStatus(client, { now: options.now });
  const dirtyBefore = before.defaultRows;
  if (!dirtyBefore || !defaultPartitionIsDirty(before)) {
    return {
      repaired: false,
      reason: 'clean',
      dirtyBefore,
      months: [],
      journalsMoved: 0,
      linesMoved: 0,
      dirtyAfter: dirtyBefore,
    };
  }

  const { months, undated } = await defaultMonths(client);
  if (undated > 0) {
    throw new Error(
      `DEFAULT holds ${undated} row(s) with no journal_date_ad. A partitioned row must have a date; ` +
        'correct those rows before repairing, because the month they belong to cannot be derived.'
    );
  }
  if (months.length === 0) {
    throw new Error('DEFAULT reports rows but no month could be read from them — refusing to touch it.');
  }

  if (!options.apply) {
    return {
      repaired: false,
      reason: 'planned',
      dirtyBefore,
      months,
      journalsMoved: dirtyBefore.journals,
      linesMoved: dirtyBefore.lines,
      dirtyAfter: dirtyBefore,
    };
  }

  await client.query('BEGIN');
  try {
    // The ledger's append-only trigger has a documented purge switch; use it
    // rather than disabling the guard. SET LOCAL is scoped to this transaction
    // and every DELETE happens inside it, so a rollback leaves the ledger as it
    // was.
    await client.query(`SET LOCAL inventory.allow_ledger_purge = 'on'`);
    for (const [table, trigger] of REGISTRY_TRIGGERS) {
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }

    await client.query('CREATE TEMP TABLE repair_journals_stage (LIKE gl_journals INCLUDING DEFAULTS)');
    await client.query('CREATE TEMP TABLE repair_lines_stage (LIKE gl_journal_lines INCLUDING DEFAULTS)');
    await client.query('INSERT INTO repair_journals_stage SELECT * FROM gl_journals_default');
    await client.query('INSERT INTO repair_lines_stage SELECT * FROM gl_journal_lines_default');

    // Lines first: the composite FK would otherwise cascade them away with their
    // journals.
    await client.query('DELETE FROM gl_journal_lines_default');
    await client.query('DELETE FROM gl_journals_default');

    // Same function the posting path calls: the children can never disagree
    // about their shape with the ones a posting would have created.
    for (const month of months) {
      await client.query('SELECT ensure_journal_month_partition($1::date)', [
        `${month.slice(0, 4)}-${month.slice(4, 6)}-01`,
      ]);
    }

    // Parents first: `gl_journal_lines` has a composite FK to the journal row.
    await client.query('INSERT INTO gl_journals SELECT * FROM repair_journals_stage');
    await client.query('INSERT INTO gl_journal_lines SELECT * FROM repair_lines_stage');

    // Every staged row must be readable from the parent again before COMMIT; a
    // row that did not land would be silent ledger data loss.
    const landed = await client.query(`
      SELECT
        (SELECT count(*)::int FROM repair_journals_stage s
           WHERE EXISTS (SELECT 1 FROM gl_journals g
                          WHERE g.id = s.id AND g.journal_date_ad = s.journal_date_ad)) AS journals,
        (SELECT count(*)::int FROM repair_lines_stage s
           WHERE EXISTS (SELECT 1 FROM gl_journal_lines l
                          WHERE l.id = s.id AND l.journal_date_ad = s.journal_date_ad)) AS lines,
        (SELECT count(*)::int FROM repair_journals_stage) AS staged_journals,
        (SELECT count(*)::int FROM repair_lines_stage) AS staged_lines`);
    const counts = landed.rows[0] as {
      journals: number;
      lines: number;
      staged_journals: number;
      staged_lines: number;
    };
    if (counts.journals !== counts.staged_journals || counts.lines !== counts.staged_lines) {
      throw new Error(
        `repair aborted: ${counts.staged_journals - counts.journals} journal and ` +
          `${counts.staged_lines - counts.lines} line row(s) did not land in their month partition.`
      );
    }

    for (const [table, trigger] of REGISTRY_TRIGGERS) {
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
    await client.query('COMMIT');

    const after = await journalPartitionStatus(client, { now: options.now });
    return {
      repaired: true,
      reason: 'repaired',
      dirtyBefore,
      months,
      journalsMoved: dirtyBefore.journals,
      linesMoved: dirtyBefore.lines,
      dirtyAfter: after.defaultRows,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
