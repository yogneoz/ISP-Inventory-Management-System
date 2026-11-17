/**
 * Repair a dirty DEFAULT journal partition (worklist A5).
 *
 *   npm run repair:partitions            # report the plan; changes nothing
 *   npm run repair:partitions -- --apply # detach, create the months, reinsert, reattach
 *
 * The work itself lives in `server/src/boot/journalPartitionRepair.ts`, so this
 * command and any future boot-time path share one implementation. Exit codes:
 *   0 — DEFAULT was already clean, or the repair finished with an empty DEFAULT;
 *   1 — the repair finished but DEFAULT still reports rows (should be impossible);
 *   2 — bad invocation, no database, or the repair refused/rolled back.
 */
import 'dotenv/config';
import pg from 'pg';
import { repairDefaultPartitions } from '../server/src/boot/journalPartitionRepair';

const apply = process.argv.includes('--apply');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('repair:partitions — set DATABASE_URL to reach PostgreSQL.');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });

try {
  const report = await repairDefaultPartitions(pool, { apply });
  const dirty = report.dirtyBefore;
  const summary = dirty ? `${dirty.journals} journal / ${dirty.lines} line row(s)` : 'absent (no DEFAULT child)';

  if (report.reason === 'clean') {
    console.log(`DEFAULT is empty (${summary}) — nothing to repair.`);
    process.exitCode = 0;
  } else {
    console.log(`DEFAULT holds ${summary}.`);
    console.log(`  months to provision : ${report.months.join(', ')}`);
    console.log(`  rows to move        : ${report.journalsMoved} journal / ${report.linesMoved} line`);
    if (report.reason === 'planned') {
      console.log('  planned only — re-run with --apply to stage, clear DEFAULT, create the months and reinsert.');
      process.exitCode = 0;
    } else {
      const after = report.dirtyAfter;
      console.log(`  moved               : ${report.journalsMoved} journal / ${report.linesMoved} line`);
      console.log(`  DEFAULT after       : ${after ? `${after.journals} journal / ${after.lines} line` : 'absent'}`);
      const stillDirty = Boolean(after && (after.journals > 0 || after.lines > 0));
      if (stillDirty) {
        console.error('✗ the repair completed but DEFAULT still holds rows — re-run check:partitions.');
        process.exitCode = 1;
      } else {
        console.log('✅ repair complete: every row is in its month partition and DEFAULT is reattached empty.');
        process.exitCode = 0;
      }
    }
  }
} catch (err: any) {
  console.error('repair:partitions failed (transaction rolled back):', err?.message || err);
  process.exitCode = 2;
} finally {
  await pool.end().catch(() => {});
}
