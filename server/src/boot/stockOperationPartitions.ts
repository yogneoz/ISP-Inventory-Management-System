/**
 * Monthly partitions for `stock_operations` (SCALE-3).
 *
 * The table is RANGE-partitioned by `date_ad` (migration 0035) so a month or a
 * fiscal year prunes to the months it names, and so retention can detach a
 * closed month instead of deleting through one heap. The write path provisions
 * its own month through `ensure_stock_operation_month_partition()` before the
 * insert; this module is the provisioned half of the invariant and the reporting
 * half an operator keys on:
 *
 *   - it keeps the same window the journal provisioner uses (the shared
 *     `partitionWindow`, so every partitioned table covers the same months);
 *   - it creates the child through the SAME SQL function the write path calls,
 *     so the two can never disagree about the child's shape;
 *   - it reports rows sitting in `stock_operations_default`, because those
 *     cannot be pruned and block the month from ever being attached.
 *
 * There is deliberately no repair path here: a row in DEFAULT can be moved by
 * the normal write path only for a new document, and a backdated existing one is
 * refused by the identity trigger. The check reports it so an operator can
 * decide, exactly like the journal DEFAULT report.
 */
import { type PartitionSqlClient, partitionWindow } from './journalPartitions';

export interface StockOperationPartitionOptions {
  now?: Date;
  monthsBehind?: number;
  monthsAhead?: number;
}

export interface StockOperationPartitionStatus {
  /** Every month key in the window, oldest first, as YYYYMM. */
  window: string[];
  /** Window months whose child table exists. */
  present: string[];
  /** Window months that still need provisioning. */
  missing: string[];
  /** Rows held by `stock_operations_default`. */
  defaultRows: number;
  /** Every existing child and the range PostgreSQL reports for it. */
  children: Array<{ name: string; bound: string | null }>;
}

export interface StockOperationPartitionFailure {
  month: string;
  message: string;
}

export interface StockOperationPartitionReport extends StockOperationPartitionStatus {
  /** Month keys whose partitions this run created. */
  created: string[];
  failed: StockOperationPartitionFailure[];
}

async function tableExists(client: PartitionSqlClient, name: string): Promise<boolean> {
  const result = await client.query('SELECT to_regclass($1) AS reg', [name]);
  return Boolean(result.rows[0]?.reg);
}

/** Read-only view. Catalog lookups plus one count on the DEFAULT child. */
export async function stockOperationPartitionStatus(
  client: PartitionSqlClient,
  options: StockOperationPartitionOptions = {}
): Promise<StockOperationPartitionStatus> {
  const window = partitionWindow(options.now ?? new Date(), options);
  const present: string[] = [];
  const missing: string[] = [];
  for (const key of window) {
    if (await tableExists(client, `stock_operations_${key}`)) present.push(key);
    else missing.push(key);
  }
  let defaultRows = 0;
  if (await tableExists(client, 'stock_operations_default')) {
    const counted = await client.query('SELECT count(*)::int AS n FROM stock_operations_default');
    defaultRows = Number(counted.rows[0]?.n) || 0;
  }
  const children = await client.query(
    `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'stock_operations'
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
 * and the loop carries on, exactly like the journal and log provisioners.
 */
export async function provisionStockOperationPartitions(
  client: PartitionSqlClient,
  options: StockOperationPartitionOptions = {}
): Promise<StockOperationPartitionReport> {
  const now = options.now ?? new Date();
  const window = partitionWindow(now, options);
  const created: string[] = [];
  const failed: StockOperationPartitionFailure[] = [];

  for (const key of window) {
    if (await tableExists(client, `stock_operations_${key}`)) continue;
    try {
      await client.query('SELECT ensure_stock_operation_month_partition($1::date)', [
        `${key.slice(0, 4)}-${key.slice(4, 6)}-01`,
      ]);
      created.push(key);
    } catch (err: any) {
      failed.push({ month: key, message: err?.message || String(err) });
    }
  }

  const status = await stockOperationPartitionStatus(client, { ...options, now });
  return { ...status, created, failed };
}

/** True when the DEFAULT child holds rows that a month partition should own. */
export function defaultStockOperationPartitionIsDirty(status: StockOperationPartitionStatus): boolean {
  return status.defaultRows > 0;
}

/** One-line summary for the boot log and the CLI. */
export function describeStockOperationPartitions(report: StockOperationPartitionReport): string {
  const window = `${report.window[0]}..${report.window[report.window.length - 1]}`;
  const created = report.created.length ? report.created.join(', ') : 'none';
  const failed = report.failed.length ? `, failed ${report.failed.map((entry) => entry.month).join(', ')}` : '';
  return `window ${window}, created ${created}, DEFAULT ${report.defaultRows} row(s)${failed}`;
}
