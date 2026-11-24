/**
 * Monthly partitions for the log tables (worklist A7).
 *
 * `audit_logs` and `transaction_logs` are RANGE-partitioned by `timestamp_ad`
 * (migration 0032) for the same reason the GL ledgers are: retention has to be
 * a DETACH, not a DELETE, and a month's rows should never be scattered through
 * one ever-growing heap. The write path provisions its own month through the
 * `route_log_month_partition()` trigger, and this module is the provisioned
 * half of the invariant: it keeps a window of months ahead of the calendar,
 * reports the state of both tables, and drains rows that fell back to DEFAULT.
 *
 * A log write that cannot create its month still succeeds — the row lands in
 * DEFAULT and is reported here. That is deliberately the opposite of failing the
 * business write, which is why the dirty-DEFAULT check and the repair path are
 * part of this slice rather than a follow-up.
 */
import { businessDateAD } from '../../../shared/businessDate';
import { type PartitionSqlClient, partitionWindow } from './journalPartitions';

export const LOG_TABLES = ['audit_logs', 'transaction_logs'] as const;
export type LogTable = (typeof LOG_TABLES)[number];

export interface LogPartitionOptions {
  now?: Date;
  monthsBehind?: number;
  monthsAhead?: number;
}

export interface LogTableStatus {
  table: LogTable;
  /** Window months whose child partition exists. */
  present: string[];
  /** Window months with no child partition yet. */
  missing: string[];
  /** Rows held by `<table>_default`. */
  defaultRows: number;
  /**
   * Rows in DEFAULT with no `timestamp_ad`. They cannot be routed to a month and
   * are reported separately so a dirty DEFAULT is never blamed on them.
   */
  undatedRows: number;
}

export interface LogPartitionStatus {
  window: string[];
  tables: LogTableStatus[];
}

export interface LogPartitionFailure {
  table: LogTable;
  month: string;
  message: string;
}

export interface LogPartitionReport extends LogPartitionStatus {
  /** `<table>_YYYYMM` children this run created. */
  created: string[];
  failed: LogPartitionFailure[];
}

/** Row counts per DEFAULT child, split by whether the row can be routed. */
export interface LogDefaultSummary {
  table: LogTable;
  defaultRows: number;
  undatedRows: number;
  /** Months present in DEFAULT that already have a child (rows are movable). */
  monthsWithChild: string[];
  /** Months present in DEFAULT with no child yet (the DDL has to run first). */
  monthsWithoutChild: string[];
}

export interface LogRepairResult {
  applied: boolean;
  before: LogDefaultSummary[];
  moved: number;
  /** DEFAULT rows left behind; only the undated ones should survive an apply. */
  after: LogDefaultSummary[];
  failures: string[];
}

/**
 * Months each client has already provisioned, so the steady-state write path
 * costs no extra round trip. Keyed per client (a Pool or a PoolClient), not per
 * process: two pools can point at different databases, and a month provisioned
 * in one says nothing about the other.
 */
let ensuredMonths = new WeakMap<object, Set<string>>();

function monthsFor(client: PartitionSqlClient): Set<string> {
  const key = client as unknown as object;
  let seen = ensuredMonths.get(key);
  if (!seen) {
    seen = new Set<string>();
    ensuredMonths.set(key, seen);
  }
  return seen;
}

/**
 * Provision the month a write is about to use. This is the app-side half of the
 * partition story, mirroring how the GL posting path calls
 * `ensure_journal_month_partition` before its INSERT: PostgreSQL refuses to run
 * `CREATE TABLE ... PARTITION OF` inside the statement that inserts into the
 * same table, so the DDL has to be its own statement in the same transaction.
 */
export async function ensureLogMonthPartition(
  client: PartitionSqlClient,
  table: LogTable,
  at: Date | string = new Date()
): Promise<void> {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return;
  const key = `${table}_${date.toISOString().slice(0, 7).replace('-', '')}`;
  const seen = monthsFor(client);
  if (seen.has(key)) return;
  await client.query('SELECT ensure_log_month_partition($1, $2::timestamptz)', [table, date.toISOString()]);
  seen.add(key);
}

/** Test seam: forget which months this process has provisioned. */
export function resetEnsuredLogMonths(): void {
  ensuredMonths = new WeakMap<object, Set<string>>();
}

async function tableExists(client: PartitionSqlClient, name: string): Promise<boolean> {
  const result = await client.query('SELECT to_regclass($1) AS reg', [name]);
  return Boolean(result.rows[0]?.reg);
}

function monthKeyFromDate(month: string): string {
  return month.replace(/-/g, '').slice(0, 6);
}

async function defaultSummary(client: PartitionSqlClient, table: LogTable): Promise<LogDefaultSummary> {
  const child = `${table}_default`;
  if (!(await tableExists(client, child))) {
    return { table, defaultRows: 0, undatedRows: 0, monthsWithChild: [], monthsWithoutChild: [] };
  }
  const totals = await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE timestamp_ad IS NULL)::int AS undated
       FROM ${child}`
  );
  const months = await client.query(
    `SELECT to_char(date_trunc('month', timestamp_ad), 'YYYY-MM') AS month, count(*)::int AS rows
       FROM ${child}
      WHERE timestamp_ad IS NOT NULL
      GROUP BY 1
      ORDER BY 1`
  );
  const withChild: string[] = [];
  const withoutChild: string[] = [];
  for (const row of months.rows) {
    const key = monthKeyFromDate(String(row.month));
    if (await tableExists(client, `${table}_${key}`)) withChild.push(String(row.month));
    else withoutChild.push(String(row.month));
  }
  return {
    table,
    defaultRows: Number(totals.rows[0]?.total) || 0,
    undatedRows: Number(totals.rows[0]?.undated) || 0,
    monthsWithChild: withChild,
    monthsWithoutChild: withoutChild,
  };
}

/** Read-only view of both log tables. Catalog queries plus exact DEFAULT counts. */
export async function logPartitionStatus(
  client: PartitionSqlClient,
  options: LogPartitionOptions = {}
): Promise<LogPartitionStatus> {
  const window = partitionWindow(options.now ?? new Date(), options);
  const tables: LogTableStatus[] = [];
  for (const table of LOG_TABLES) {
    const present: string[] = [];
    const missing: string[] = [];
    for (const key of window) {
      if (await tableExists(client, `${table}_${key}`)) present.push(key);
      else missing.push(key);
    }
    const summary = await defaultSummary(client, table);
    tables.push({
      table,
      present,
      missing,
      defaultRows: summary.defaultRows,
      undatedRows: summary.undatedRows,
    });
  }
  return { window, tables };
}

/**
 * Create every missing month in the window for both tables. Idempotent: a second
 * run reports `created: []`. A month blocked by a dirty DEFAULT is reported and
 * the loop carries on, exactly like the journal provisioner.
 */
export async function provisionLogPartitions(
  client: PartitionSqlClient,
  options: LogPartitionOptions = {}
): Promise<LogPartitionReport> {
  const now = options.now ?? new Date();
  const window = partitionWindow(now, options);
  const created: string[] = [];
  const failed: LogPartitionFailure[] = [];

  for (const table of LOG_TABLES) {
    for (const key of window) {
      if (await tableExists(client, `${table}_${key}`)) continue;
      try {
        await client.query('SELECT ensure_log_month_partition($1, $2::timestamptz)', [
          table,
          `${key.slice(0, 4)}-${key.slice(4, 6)}-01T00:00:00Z`,
        ]);
        created.push(`${table}_${key}`);
      } catch (err: any) {
        failed.push({ table, month: key, message: err?.message || String(err) });
      }
    }
  }

  const status = await logPartitionStatus(client, { ...options, now });
  return { ...status, created, failed };
}

/** True when a DEFAULT child holds rows that a month partition should own. */
export function defaultLogPartitionIsDirty(status: LogPartitionStatus): boolean {
  return status.tables.some((entry) => entry.defaultRows - entry.undatedRows > 0);
}

/** One-line summary for the boot log and the CLI. */
export function describeLogPartitions(report: LogPartitionReport): string {
  const window = `${report.window[0]}..${report.window[report.window.length - 1]}`;
  const created = report.created.length ? report.created.join(', ') : 'none';
  const defaults = report.tables
    .map((entry) => `${entry.table} ${entry.defaultRows} row(s)`)
    .join(' / ');
  const failed = report.failed.length
    ? `, failed ${report.failed.map((entry) => `${entry.table}_${entry.month}`).join(', ')}`
    : '';
  return `window ${window}, created ${created}, DEFAULT ${defaults}${failed}`;
}

async function summaries(client: PartitionSqlClient): Promise<LogDefaultSummary[]> {
  const result: LogDefaultSummary[] = [];
  for (const table of LOG_TABLES) result.push(await defaultSummary(client, table));
  return result;
}

/**
 * Move DEFAULT rows into their month partitions.
 *
 * Plan mode (default) only reports. Apply mode stages the DEFAULT rows in a
 * temporary table, empties DEFAULT, provisions the months they belong to and
 * reinserts through the parent so PostgreSQL routes each row. The staging step
 * is not optional: PostgreSQL refuses to attach a month whose range DEFAULT
 * already holds rows in, so the rows must be out of the way first.
 *
 * Emptying DEFAULT is a DELETE against a table whose rows are append-only, so it
 * runs inside the sanctioned purge switch — the same `SET LOCAL` pair the ledger
 * repair uses — and the whole repair is one transaction: a failure leaves the
 * rows where they were.
 */
export async function repairLogDefaultPartitions(
  client: PartitionSqlClient,
  options: LogPartitionOptions & { apply?: boolean } = {}
): Promise<LogRepairResult> {
  const apply = options.apply === true;
  const before = await summaries(client);
  const failures: string[] = [];
  let moved = 0;

  const blocked = before.some((entry) => entry.defaultRows - entry.undatedRows > 0);
  if (!apply || !blocked) {
    return { applied: false, before, moved: 0, after: before, failures };
  }

  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL inventory.allow_ledger_purge = 'on'`);
    for (const table of LOG_TABLES) {
      const child = `${table}_default`;
      if (!(await tableExists(client, child))) continue;
      await client.query(`CREATE TEMP TABLE log_repair_stage ON COMMIT DROP AS SELECT * FROM ${child}`);
      await client.query(`DELETE FROM ${child}`);
      await client.query('SELECT ensure_log_month_partition($1, $2::timestamptz)', [
        table,
        `${businessDateAD()}T00:00:00Z`,
      ]).catch(() => undefined);
      // Provision one child per month the staged rows occupy, then reinsert
      // through the parent so each row lands in its own month.
      const months = await client.query(
        `SELECT DISTINCT to_char(date_trunc('month', timestamp_ad), 'YYYY-MM') AS month
           FROM log_repair_stage WHERE timestamp_ad IS NOT NULL ORDER BY 1`
      );
      for (const row of months.rows) {
        const key = monthKeyFromDate(String(row.month));
        await client.query('SELECT ensure_log_month_partition($1, $2::timestamptz)', [
          table,
          `${key.slice(0, 4)}-${key.slice(4, 6)}-01T00:00:00Z`,
        ]);
      }
      const staged = await client.query('SELECT count(*)::int AS n FROM log_repair_stage');
      const counted = Number(staged.rows[0]?.n) || 0;
      await client.query(`INSERT INTO ${table} SELECT * FROM log_repair_stage`);
      // Every staged row must be findable through the parent after the reinsert;
      // a row that landed nowhere would be a silent loss of history.
      const missing = await client.query(
        `SELECT count(*)::int AS n
           FROM log_repair_stage s
           LEFT JOIN ${table} t ON t.id = s.id AND t.timestamp_ad = s.timestamp_ad
          WHERE t.id IS NULL`
      );
      const lost = Number(missing.rows[0]?.n) || 0;
      if (lost > 0) {
        throw new Error(`${table}: ${lost} staged row(s) did not reach the partitioned table`);
      }
      moved += counted;
      await client.query('DROP TABLE log_repair_stage');
    }
    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    failures.push(err?.message || String(err));
    return { applied: false, before, moved: 0, after: before, failures };
  }

  const after = await summaries(client);
  for (const entry of after) {
    if (entry.defaultRows - entry.undatedRows > 0) {
      failures.push(`${entry.table}: ${entry.defaultRows - entry.undatedRows} dated row(s) still in DEFAULT`);
    }
  }
  return { applied: true, before, moved, after, failures };
}

