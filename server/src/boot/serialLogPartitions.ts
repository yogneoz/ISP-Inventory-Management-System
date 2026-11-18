/**
 * Monthly partitions for `serial_log` (SCALE-3).
 *
 * The register is RANGE-partitioned by `created_at` (migration 0036) — the
 * document date each insert already carries: the purchase/receive paths write
 * NOW(), the reconcile backfill writes the source document's date. Monthly
 * children let a register page prune to the months it names and let retention
 * detach a closed period instead of deleting through one heap.
 *
 * The write paths provision their own month through
 * `ensure_serial_log_month_partition()` before the insert; this module is the
 * provisioned half (same window as the ledger and log provisioners, same SQL
 * function) and the reporting half: rows in `serial_log_default` cannot be
 * pruned and block a month from ever being attached, so they are counted and
 * reported rather than silently tolerated.
 */
import { type PartitionSqlClient, partitionWindow } from './journalPartitions';

export interface SerialLogPartitionOptions {
  now?: Date;
  monthsBehind?: number;
  monthsAhead?: number;
}

export interface SerialLogPartitionStatus {
  window: string[];
  present: string[];
  missing: string[];
  defaultRows: number;
  children: Array<{ name: string; bound: string | null }>;
}

export interface SerialLogPartitionFailure {
  month: string;
  message: string;
}

export interface SerialLogPartitionReport extends SerialLogPartitionStatus {
  created: string[];
  failed: SerialLogPartitionFailure[];
}

async function tableExists(client: PartitionSqlClient, name: string): Promise<boolean> {
  const result = await client.query('SELECT to_regclass($1) AS reg', [name]);
  return Boolean(result.rows[0]?.reg);
}

/** Read-only view: catalog lookups plus one count on the DEFAULT child. */
export async function serialLogPartitionStatus(
  client: PartitionSqlClient,
  options: SerialLogPartitionOptions = {}
): Promise<SerialLogPartitionStatus> {
  const window = partitionWindow(options.now ?? new Date(), options);
  const present: string[] = [];
  const missing: string[] = [];
  for (const key of window) {
    if (await tableExists(client, `serial_log_${key}`)) present.push(key);
    else missing.push(key);
  }
  let defaultRows = 0;
  if (await tableExists(client, 'serial_log_default')) {
    const counted = await client.query('SELECT count(*)::int AS n FROM serial_log_default');
    defaultRows = Number(counted.rows[0]?.n) || 0;
  }
  const children = await client.query(
    `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'serial_log'
      ORDER BY c.relname`
  );
  return {
    window,
    present,
    missing,
    defaultRows,
    children: children.rows.map((row: any) => ({ name: String(row.name), bound: row.bound ?? null })),
  };
}

/**
 * Create every missing month in the window. Idempotent (the SQL function is
 * `CREATE TABLE IF NOT EXISTS`). A month blocked by a dirty DEFAULT is reported
 * and the loop carries on, like the journal, log and stock-operation
 * provisioners.
 */
export async function provisionSerialLogPartitions(
  client: PartitionSqlClient,
  options: SerialLogPartitionOptions = {}
): Promise<SerialLogPartitionReport> {
  const now = options.now ?? new Date();
  const window = partitionWindow(now, options);
  const created: string[] = [];
  const failed: SerialLogPartitionFailure[] = [];

  for (const key of window) {
    if (await tableExists(client, `serial_log_${key}`)) continue;
    try {
      await client.query('SELECT ensure_serial_log_month_partition($1::date)', [
        `${key.slice(0, 4)}-${key.slice(4, 6)}-01`,
      ]);
      created.push(key);
    } catch (err: any) {
      failed.push({ month: key, message: err?.message || String(err) });
    }
  }

  const status = await serialLogPartitionStatus(client, { ...options, now });
  return { ...status, created, failed };
}

/** True when the DEFAULT child holds rows that a month partition should own. */
export function defaultSerialLogPartitionIsDirty(status: SerialLogPartitionStatus): boolean {
  return status.defaultRows > 0;
}

/** One-line summary for the boot log and the CLI. */
export function describeSerialLogPartitions(report: SerialLogPartitionReport): string {
  const window = `${report.window[0]}..${report.window[report.window.length - 1]}`;
  const created = report.created.length ? report.created.join(', ') : 'none';
  const failed = report.failed.length ? `, failed ${report.failed.map((entry) => entry.month).join(', ')}` : '';
  return `window ${window}, created ${created}, DEFAULT ${report.defaultRows} row(s)${failed}`;
}
