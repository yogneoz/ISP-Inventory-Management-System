/**
 * Monthly partitions for `sales_invoices` (SCALE-3).
 *
 * The sales register is RANGE-partitioned by `invoice_date_ad` (migration 0039)
 * so a month or a fiscal year prunes to the months it names and retention can
 * detach a closed period. The write path provisions its own month through
 * `ensure_sales_invoice_month_partition()` before the insert; this module is the
 * provisioned half (same window and same SQL function as the other partitioned
 * tables) and the reporting half: rows in `sales_invoices_default` cannot be
 * pruned, so they are counted and reported instead of silently tolerated.
 */
import { type PartitionSqlClient, partitionWindow } from './journalPartitions';

export interface SalesInvoicePartitionOptions {
  now?: Date;
  monthsBehind?: number;
  monthsAhead?: number;
}

export interface SalesInvoicePartitionStatus {
  window: string[];
  present: string[];
  missing: string[];
  defaultRows: number;
  children: Array<{ name: string; bound: string | null }>;
}

export interface SalesInvoicePartitionFailure {
  month: string;
  message: string;
}

export interface SalesInvoicePartitionReport extends SalesInvoicePartitionStatus {
  created: string[];
  failed: SalesInvoicePartitionFailure[];
}

async function tableExists(client: PartitionSqlClient, name: string): Promise<boolean> {
  const result = await client.query('SELECT to_regclass($1) AS reg', [name]);
  return Boolean(result.rows[0]?.reg);
}

/** Read-only view: catalog lookups plus one count on the DEFAULT child. */
export async function salesInvoicePartitionStatus(
  client: PartitionSqlClient,
  options: SalesInvoicePartitionOptions = {}
): Promise<SalesInvoicePartitionStatus> {
  const window = partitionWindow(options.now ?? new Date(), options);
  const present: string[] = [];
  const missing: string[] = [];
  for (const key of window) {
    if (await tableExists(client, `sales_invoices_${key}`)) present.push(key);
    else missing.push(key);
  }
  let defaultRows = 0;
  if (await tableExists(client, 'sales_invoices_default')) {
    const counted = await client.query('SELECT count(*)::int AS n FROM sales_invoices_default');
    defaultRows = Number(counted.rows[0]?.n) || 0;
  }
  const children = await client.query(
    `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'sales_invoices'
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
 * and the loop carries on, like the other provisioners.
 */
export async function provisionSalesInvoicePartitions(
  client: PartitionSqlClient,
  options: SalesInvoicePartitionOptions = {}
): Promise<SalesInvoicePartitionReport> {
  const now = options.now ?? new Date();
  const window = partitionWindow(now, options);
  const created: string[] = [];
  const failed: SalesInvoicePartitionFailure[] = [];

  for (const key of window) {
    if (await tableExists(client, `sales_invoices_${key}`)) continue;
    try {
      await client.query('SELECT ensure_sales_invoice_month_partition($1::date)', [
        `${key.slice(0, 4)}-${key.slice(4, 6)}-01`,
      ]);
      created.push(key);
    } catch (err: any) {
      failed.push({ month: key, message: err?.message || String(err) });
    }
  }

  const status = await salesInvoicePartitionStatus(client, { ...options, now });
  return { ...status, created, failed };
}

/** True when the DEFAULT child holds rows that a month partition should own. */
export function defaultSalesInvoicePartitionIsDirty(status: SalesInvoicePartitionStatus): boolean {
  return status.defaultRows > 0;
}

/** One-line summary for the boot log and the CLI. */
export function describeSalesInvoicePartitions(report: SalesInvoicePartitionReport): string {
  const window = `${report.window[0]}..${report.window[report.window.length - 1]}`;
  const created = report.created.length ? report.created.join(', ') : 'none';
  const failed = report.failed.length ? `, failed ${report.failed.map((entry) => entry.month).join(', ')}` : '';
  return `window ${window}, created ${created}, DEFAULT ${report.defaultRows} row(s)${failed}`;
}
