/**
 * Monthly journal partition provisioning (SCALE-3, first slice).
 *
 * `gl_journals` and `gl_journal_lines` have been RANGE-partitioned by
 * `journal_date_ad` since migration 0003, but the only creator was
 * `ensure_journal_month_partition(p_date)` called from the posting path for the
 * month being written. That means a fresh install had nothing but the DEFAULT
 * catch-all until the first posting, and every new month was created by DDL
 * inside a user's transaction while they waited on an ACCESS EXCLUSIVE lock.
 *
 * This job is the provisioned half of the worklist invariant "partitioning is
 * provisioned, not just declared": it creates the current month plus a
 * lookahead window (default 3 months), keeps the DEFAULT partitions as a safety
 * net, and reports how many rows are sitting in them. It is idempotent — the
 * SQL function is `CREATE TABLE IF NOT EXISTS` — so it runs on every boot and
 * on demand from `npm run check:partitions`.
 *
 * Deliberately NOT here: detaching/archiving closed-year partitions. That is a
 * destructive retention decision (`fiscal_year_balances` keeps the year-end
 * snapshot, but the ledger rows are still the audit trail), so it stays a
 * documented operator step with its own trigger, not an automatic boot job.
 *
 * One interaction to know: PostgreSQL refuses to attach a month partition whose
 * range is already represented in DEFAULT ("the default partition would be
 * violated by some row"), so provisioning that month fails until those rows are
 * moved out. The status reports the DEFAULT counts precisely so an operator can
 * tell that case from a merely missing month.
 */

/** A pg-compatible client: anything with query(). Pool or PoolClient. */
export interface PartitionSqlClient {
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
}

export interface JournalPartitionWindow {
  /** Reference instant for the window. Defaults to now. */
  now?: Date;
  /** Months before the reference month to keep present. Default 1. */
  monthsBehind?: number;
  /** Months after the reference month to pre-create. Default 3. */
  monthsAhead?: number;
}

export interface JournalPartitionCounts {
  journals: number;
  lines: number;
  /**
   * Rows in `gl_subledger_entries_default`. The subledger parent is provisioned
   * from the same month function (SCALE-3), so a month can only be missing its
   * subledger child when it is missing its journal children too — but a row
   * that landed in DEFAULT still defeats pruning for every subledger read.
   */
  subledger: number;
}

export interface JournalPartitionStatus {
  /** Every month key in the window, oldest first, as YYYYMM. */
  window: string[];
  /** Window months whose tables exist. */
  present: string[];
  /** Window months that still need provisioning. */
  missing: string[];
  /** Row counts held by the DEFAULT catch-all partitions, or null when absent. */
  defaultRows: JournalPartitionCounts | null;
  /** Every existing child partition and the range PostgreSQL reports for it. */
  children: Array<{ name: string; bound: string | null }>;
}

export interface JournalPartitionFailure {
  /** The month whose DDL threw, as YYYYMM. */
  month: string;
  /** The PostgreSQL message, kept verbatim for the operator. */
  message: string;
}

export interface JournalPartitionReport extends JournalPartitionStatus {
  /** Month keys whose partitions this run created. */
  created: string[];
  /**
   * Months whose DDL threw. Almost always a dirty DEFAULT partition: PostgreSQL
   * refuses to attach a month whose range the DEFAULT already holds rows in
   * ("the default partition would be violated by some row"). Recording the
   * failure per month instead of aborting keeps the other months provisioned.
   */
  failed: JournalPartitionFailure[];
}

const DEFAULT_MONTHS_BEHIND = 1;
const DEFAULT_MONTHS_AHEAD = 3;

function monthStart(reference: Date, offset: number): Date {
  return new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + offset, 1));
}

/** The partition-name suffix the SQL function uses (to_char(p_date, 'YYYYMM')). */
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The month keys this job owns: `monthsBehind` months before the reference
 * month, the reference month, then `monthsAhead` months after it.
 */
export function partitionWindow(now: Date = new Date(), options: JournalPartitionWindow = {}): string[] {
  const behind = Math.max(0, options.monthsBehind ?? DEFAULT_MONTHS_BEHIND);
  const ahead = Math.max(0, options.monthsAhead ?? DEFAULT_MONTHS_AHEAD);
  const keys: string[] = [];
  for (let offset = -behind; offset <= ahead; offset += 1) {
    keys.push(monthKey(monthStart(now, offset)));
  }
  return keys;
}

async function tableExists(client: PartitionSqlClient, name: string): Promise<boolean> {
  const result = await client.query('SELECT to_regclass($1) AS reg', [name]);
  return Boolean(result.rows[0]?.reg);
}

/**
 * A month is provisioned only when BOTH children exist: a header without its
 * lines child is the half-created state an interrupted run leaves behind, and
 * treating it as present would hide the month whose journal lines have nowhere
 * to go but DEFAULT.
 */
async function monthIsProvisioned(client: PartitionSqlClient, key: string): Promise<boolean> {
  const header = await tableExists(client, `gl_journals_${key}`);
  const lines = header ? await tableExists(client, `gl_journal_lines_${key}`) : false;
  return header && lines;
}

async function defaultPartitionRows(client: PartitionSqlClient): Promise<JournalPartitionCounts | null> {
  if (!(await tableExists(client, 'gl_journals_default'))) return null;
  if (!(await tableExists(client, 'gl_journal_lines_default'))) return null;
  const hasSubledgerDefault = await tableExists(client, 'gl_subledger_entries_default');
  const result = await client.query(
    `SELECT
       (SELECT count(*)::int FROM gl_journals_default) AS journals,
       (SELECT count(*)::int FROM gl_journal_lines_default) AS lines,
       ${hasSubledgerDefault ? '(SELECT count(*)::int FROM gl_subledger_entries_default)' : '0'} AS subledger`
  );
  const row = result.rows[0] || {};
  return {
    journals: Number(row.journals) || 0,
    lines: Number(row.lines) || 0,
    subledger: Number(row.subledger) || 0,
  };
}

async function childPartitions(client: PartitionSqlClient): Promise<Array<{ name: string; bound: string | null }>> {
  const result = await client.query(
    `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname IN ('gl_journals', 'gl_journal_lines', 'gl_subledger_entries')
      ORDER BY c.relname`
  );
  return result.rows.map((row: any) => ({ name: String(row.name), bound: row.bound ?? null }));
}

/**
 * Read-only view of the partition state. Safe to run on a production database:
 * catalog queries plus two `count(*)` on the DEFAULT partitions. Those are
 * expected to be empty, which makes the count trivial; a `DEFAULT` that has
 * grown large is already a pruning defect, and the exact number is what an
 * operator needs to size the fix, so the read stays exact rather than bounded.
 */
export async function journalPartitionStatus(
  client: PartitionSqlClient,
  options: JournalPartitionWindow = {}
): Promise<JournalPartitionStatus> {
  const window = partitionWindow(options.now ?? new Date(), options);
  const present: string[] = [];
  const missing: string[] = [];
  for (const key of window) {
    if (await monthIsProvisioned(client, key)) present.push(key);
    else missing.push(key);
  }
  return {
    window,
    present,
    missing,
    defaultRows: await defaultPartitionRows(client),
    children: await childPartitions(client),
  };
}

/**
 * Create every month in the window. Idempotent: a second run reports
 * `created: []`. The month's DDL comes from the single SQL function the posting
 * path already uses, so the two can never disagree about the child shape.
 *
 * `now` is a parameter so the window is testable without waiting for a month
 * boundary. A fixed reference date also lets an operator backfill a month they
 * know is missing (`--from`, see scripts/check_partitions.ts).
 */
export async function provisionJournalPartitions(
  client: PartitionSqlClient,
  options: JournalPartitionWindow = {}
): Promise<JournalPartitionReport> {
  const now = options.now ?? new Date();
  const window = partitionWindow(now, options);
  const created: string[] = [];
  const failed: JournalPartitionFailure[] = [];

  for (const key of window) {
    // A complete month already matches what the function would create, so skip
    // the DDL entirely instead of re-running CREATE TABLE IF NOT EXISTS (two
    // round trips) for every month on every boot.
    if (await monthIsProvisioned(client, key)) continue;
    // The function is keyed on a date inside the month, so pass the first day;
    // it creates the missing child of a half-created month as well.
    //
    // Per-month isolation: a month blocked by a dirty DEFAULT must not cost the
    // operator the rest of the window. The failure is reported, the month stays
    // in `missing`, and the loop carries on.
    try {
      await client.query('SELECT ensure_journal_month_partition($1::date)', [
        `${key.slice(0, 4)}-${key.slice(4, 6)}-01`,
      ]);
      created.push(key);
    } catch (err: any) {
      failed.push({ month: key, message: err?.message || String(err) });
    }
  }

  const status = await journalPartitionStatus(client, { ...options, now });
  return { ...status, created, failed };
}

/** One-line summary for the boot log. */
export function describeJournalPartitions(report: JournalPartitionReport): string {
  const window = `${report.window[0]}..${report.window[report.window.length - 1]}`;
  const created = report.created.length ? report.created.join(', ') : 'none';
  const defaults = report.defaultRows
    ? `${report.defaultRows.journals} journal / ${report.defaultRows.lines} line / ${report.defaultRows.subledger} subledger row(s)`
    : 'absent';
  const failed = report.failed.length ? `, failed ${report.failed.map((entry) => entry.month).join(', ')}` : '';
  return `window ${window}, created ${created}, DEFAULT ${defaults}${failed}`;
}

/** True when the DEFAULT catch-all holds rows: pruning is defeated for those. */
export function defaultPartitionIsDirty(report: JournalPartitionStatus): boolean {
  return Boolean(report.defaultRows && (report.defaultRows.journals > 0 || report.defaultRows.lines > 0));
}
