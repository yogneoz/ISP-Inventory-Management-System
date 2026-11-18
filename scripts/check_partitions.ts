/**
 * Journal partition check and provisioning (SCALE-3).
 *
 * The worklist's verification command for the enterprise-scale round is
 * `node scripts/check_partitions.mjs`, with the acceptance "provisioning creates
 * 12 months of children idempotently and a second run is a no-op". This is that
 * command, kept in TypeScript so it calls the SAME provisioning module the
 * server boots with instead of a second copy of the DDL.
 *
 * Read-only by default. It exits non-zero when the lookahead window is
 * incomplete or when the DEFAULT catch-all holds rows, which is what CI and an
 * operator alert should key on:
 *
 *   npm run check:partitions            # report; exit 1 on a gap or a dirty DEFAULT
 *   npm run check:partitions -- --apply # create the window first, then report
 *   npm run check:partitions -- --from 2025-01-01 --months-ahead 12
 *
 * `--from` is the reference date: the window is `from - months-behind` through
 * `from + months-ahead`, so a historical install can be backfilled forward one
 * month at a time without waiting for the calendar.
 *
 * It never detaches or drops a partition: retention/archival is a deliberate
 * operator action, not a side effect of a health check.
 */
import 'dotenv/config';
import pg from 'pg';
import {
  defaultPartitionIsDirty,
  journalPartitionStatus,
  provisionJournalPartitions,
} from '../server/src/boot/journalPartitions';
import type { JournalPartitionReport } from '../server/src/boot/journalPartitions';
import {
  defaultLogPartitionIsDirty,
  logPartitionStatus,
  provisionLogPartitions,
} from '../server/src/boot/logPartitions';
import type { LogPartitionReport } from '../server/src/boot/logPartitions';
import {
  defaultStockOperationPartitionIsDirty,
  provisionStockOperationPartitions,
  stockOperationPartitionStatus,
} from '../server/src/boot/stockOperationPartitions';
import type { StockOperationPartitionReport } from '../server/src/boot/stockOperationPartitions';
import {
  defaultSerialLogPartitionIsDirty,
  provisionSerialLogPartitions,
  serialLogPartitionStatus,
} from '../server/src/boot/serialLogPartitions';
import type { SerialLogPartitionReport } from '../server/src/boot/serialLogPartitions';

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function intArg(flag: string, fallback: number): number {
  const raw = argValue(flag);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 120) {
    console.error(`check:partitions — ${flag} expects an integer 0..120, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return parsed;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const from = argValue('--from');
  const now = from ? new Date(`${from}T00:00:00Z`) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`check:partitions — --from expects YYYY-MM-DD, got ${JSON.stringify(from)}`);
    process.exit(2);
  }
  const options = {
    now,
    monthsBehind: intArg('--months-behind', 1),
    monthsAhead: intArg('--months-ahead', 3),
  };

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString && !process.env.POSTGRES_HOST) {
    console.error('check:partitions — set DATABASE_URL (or POSTGRES_HOST) to reach PostgreSQL.');
    process.exit(2);
  }

  const pool = new pg.Pool({
    connectionString: connectionString || undefined,
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'inventory_db',
    user: process.env.POSTGRES_USER || 'inventory_user',
    password: process.env.POSTGRES_PASSWORD || 'securepassword',
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  try {
    const report: JournalPartitionReport = apply
      ? await provisionJournalPartitions(pool, options)
      : { ...(await journalPartitionStatus(pool, options)), created: [], failed: [] };

    const window = `${report.window[0]} .. ${report.window[report.window.length - 1]}`;
    console.log(`Journal partitions — window ${window}`);
    console.log(`  present : ${report.present.length ? report.present.join(', ') : '(none)'}`);
    console.log(`  missing : ${report.missing.length ? report.missing.join(', ') : '(none)'}`);
    if (apply) console.log(`  created : ${report.created.length ? report.created.join(', ') : '(none — already provisioned)'}`);
    console.log(
      `  DEFAULT : ${report.defaultRows ? `${report.defaultRows.journals} journal / ${report.defaultRows.lines} line / ${report.defaultRows.subledger} subledger row(s)` : 'absent'}`
    );

    // A month can be missing because nothing created it yet, or because the DDL
    // was refused (a dirty DEFAULT). The reason is what an operator acts on, so
    // print it rather than only the symptom.
    for (const failure of report.failed) {
      console.error(`✗ month ${failure.month} could not be created: ${failure.message}`);
    }

    // The log tables share the window and the same check (worklist A7).
    const logReport: LogPartitionReport = apply
      ? await provisionLogPartitions(pool, options)
      : { ...(await logPartitionStatus(pool, options)), created: [], failed: [] };
    console.log('Log partitions (audit_logs, transaction_logs)');
    for (const entry of logReport.tables) {
      console.log(
        `  ${entry.table}: present ${entry.present.length ? entry.present.join(', ') : '(none)'};` +
          ` missing ${entry.missing.length ? entry.missing.join(', ') : '(none)'};` +
          ` DEFAULT ${entry.defaultRows} row(s) (${entry.undatedRows} undated)`
      );
    }
    if (apply) {
      console.log(`  created : ${logReport.created.length ? logReport.created.join(', ') : '(none — already provisioned)'}`);
    }
    for (const failure of logReport.failed) {
      console.error(`✗ ${failure.table} month ${failure.month} could not be created: ${failure.message}`);
    }
    // The operational register shares the same window and provisioning function
    // as the write path (worklist SCALE-3).
    const stockOpReport: StockOperationPartitionReport = apply
      ? await provisionStockOperationPartitions(pool, options)
      : { ...(await stockOperationPartitionStatus(pool, options)), created: [], failed: [] };
    console.log('Stock operation partitions (stock_operations)');
    console.log(
      `  present : ${stockOpReport.present.length ? stockOpReport.present.join(', ') : '(none)'};` +
        ` missing ${stockOpReport.missing.length ? stockOpReport.missing.join(', ') : '(none)'};` +
        ` DEFAULT ${stockOpReport.defaultRows} row(s)`
    );
    if (apply) {
      console.log(`  created : ${stockOpReport.created.length ? stockOpReport.created.join(', ') : '(none — already provisioned)'}`);
    }
    for (const failure of stockOpReport.failed) {
      console.error(`✗ stock_operations month ${failure.month} could not be created: ${failure.message}`);
    }
    const stockOpDirty = defaultStockOperationPartitionIsDirty(stockOpReport);
    if (stockOpDirty) {
      console.error(
        `✗ ${stockOpReport.defaultRows} stock operation row(s) are in stock_operations_default: their dates` +
          ' cannot be pruned, and PostgreSQL refuses to attach a month whose range DEFAULT already holds' +
          ' rows in. Move them into their month partitions, then re-run.'
      );
    }
    const stockOpGaps = stockOpReport.missing.length;

    // The serial register shares the same window and provisioning function as
    // its write paths (worklist SCALE-3).
    const serialReport: SerialLogPartitionReport = apply
      ? await provisionSerialLogPartitions(pool, options)
      : { ...(await serialLogPartitionStatus(pool, options)), created: [], failed: [] };
    console.log('Serial register partitions (serial_log)');
    console.log(
      `  present : ${serialReport.present.length ? serialReport.present.join(', ') : '(none)'};` +
        ` missing ${serialReport.missing.length ? serialReport.missing.join(', ') : '(none)'};` +
        ` DEFAULT ${serialReport.defaultRows} row(s)`
    );
    if (apply) {
      console.log(`  created : ${serialReport.created.length ? serialReport.created.join(', ') : '(none — already provisioned)'}`);
    }
    for (const failure of serialReport.failed) {
      console.error(`✗ serial_log month ${failure.month} could not be created: ${failure.message}`);
    }
    const serialDirty = defaultSerialLogPartitionIsDirty(serialReport);
    if (serialDirty) {
      console.error(
        `✗ ${serialReport.defaultRows} serial register row(s) are in serial_log_default: their dates` +
          ' cannot be pruned, and PostgreSQL refuses to attach a month whose range DEFAULT already holds' +
          ' rows in. Move them into their month partitions, then re-run.'
      );
    }
    const serialGaps = serialReport.missing.length;

    const logDirty = defaultLogPartitionIsDirty(logReport);
    if (logDirty) {
      console.error(
        '✗ log DEFAULT partitions hold dated rows. Run `npm run repair:partitions -- --apply` to move them into' +
          ' their month partitions (a DEFAULT row cannot be pruned and blocks the month from being attached).'
      );
    }
    const logGaps = logReport.tables.filter((entry) => entry.missing.length > 0);

    const dirty = defaultPartitionIsDirty(report);
    // The subledger parent is provisioned from the same month function, so a
    // row in its DEFAULT means a posting bypassed the journal call entirely.
    const subledgerDirty = (report.defaultRows?.subledger ?? 0) > 0;
    if (subledgerDirty) {
      console.error(
        `✗ ${report.defaultRows!.subledger} subledger row(s) are in gl_subledger_entries_default: their dates` +
          ' cannot be pruned and they block that month from being attached. Move them into their month' +
          ' partitions before re-running.'
      );
    }
    if (dirty) {
      console.error(
        `✗ ${report.defaultRows!.journals} journal row(s) and ${report.defaultRows!.lines} line row(s) are in the` +
          ' DEFAULT partition: their dates cannot be pruned, and PostgreSQL refuses to attach a month whose' +
          ' range DEFAULT already holds rows in. Move those rows into their month partitions, then re-run' +
          ' (see docs/database-optimization-audit-2026-11-17.md).'
      );
    }
    if (report.missing.length) {
      console.error(
        apply
          ? `✗ ${report.missing.length} month(s) still have no partition after --apply: ${report.missing.join(', ')}`
          : `✗ ${report.missing.length} month(s) in the window have no partition (${report.missing.join(', ')}). Run with --apply.`
      );
    }
    process.exitCode =
      dirty ||
      subledgerDirty ||
      logDirty ||
      stockOpDirty ||
      serialDirty ||
      report.missing.length ||
      logGaps.length ||
      stockOpGaps ||
      serialGaps
        ? 1
        : 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

await main().catch((err) => {
  console.error('check:partitions failed:', err?.message || err);
  process.exit(1);
});
