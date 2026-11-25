/**
 * Run-owned clean-up for the demo master an unattended `npm test` seeds.
 *
 * `tests/fixtures/referenceData.ts` seeds the demo master — WH001/BRH01 and the
 * 2080-81/2081-82 fiscal years — so suites can run against a schema-only
 * database, which is exactly what CI provides (`scripts/schema.sql` plus
 * `scripts/seedShardCalendar.ts`). Pointed at a developer database that already
 * owns its master, the same fixture left those rows behind, next to the
 * install's real branches and two fiscal years, along with the journals, daily
 * sequence counters and GL period balances suites had posted against them.
 *
 * Why this lives in the runner rather than in a suite: node:test runs test
 * FILES concurrently, so any single suite's teardown would delete a branch a
 * sibling file is still using. `scripts/run_tests.mjs` is the only process that
 * sees every suite finish, so it takes the snapshot before the run and asks for
 * the removal afterwards. Only demo ids that were ABSENT in the snapshot are
 * ever passed to the removal, so a database whose master predates the run (CI's
 * shard calendar step, a seeded install) is never a candidate.
 *
 * Usage:
 *   tsx scripts/testDbHygiene.ts snapshot <file>   # before the suite
 *   tsx scripts/testDbHygiene.ts cleanup  <file>   # after the suite
 *
 * Never throws on a database problem: hygiene must not turn a green suite red.
 * It reports what it could not remove instead, and the caller keeps its own
 * exit status.
 */
import fs from 'node:fs';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  DEMO_MASTER_BRANCH_IDS,
  DEMO_MASTER_FISCAL_YEAR_IDS,
  removeDemoMasterRows,
} from '../tests/fixtures/referenceData';

dotenv.config({ quiet: true });

interface DemoMasterSnapshot {
  branches: string[];
  fiscalYears: string[];
}

const mode = process.argv[2];
const snapshotPath = process.argv[3];

if ((mode !== 'snapshot' && mode !== 'cleanup') || !snapshotPath) {
  console.error('test-hygiene: usage: tsx scripts/testDbHygiene.ts <snapshot|cleanup> <file>');
  process.exit(2);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('test-hygiene: DATABASE_URL is required');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString, max: 2 });

async function presentDemoIds(): Promise<DemoMasterSnapshot> {
  const branches = await pool.query('SELECT id FROM branches WHERE id = ANY($1::text[])', [
    DEMO_MASTER_BRANCH_IDS,
  ]);
  const fiscalYears = await pool.query(
    'SELECT id FROM fiscal_years WHERE id = ANY($1::text[])',
    [DEMO_MASTER_FISCAL_YEAR_IDS]
  );
  return {
    branches: branches.rows.map((row: { id: string }) => row.id),
    fiscalYears: fiscalYears.rows.map((row: { id: string }) => row.id),
  };
}

try {
  if (mode === 'snapshot') {
    const snapshot = await presentDemoIds();
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
    console.log(
      `test-hygiene: snapshot taken — demo master already present: ${snapshot.branches.length} branch(es), ` +
        `${snapshot.fiscalYears.length} fiscal year(s)`
    );
  } else {
    let snapshot: DemoMasterSnapshot | null = null;
    try {
      snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as DemoMasterSnapshot;
    } catch {
      console.warn('test-hygiene: no usable snapshot from this run — skipping clean-up');
    }
    if (snapshot) {
      const present = await presentDemoIds();
      const createdBranches = present.branches.filter((id) => !snapshot!.branches.includes(id));
      const createdFiscalYears = present.fiscalYears.filter(
        (id) => !snapshot!.fiscalYears.includes(id)
      );
      if (createdBranches.length === 0 && createdFiscalYears.length === 0) {
        console.log('test-hygiene: this run added no demo master rows — nothing to remove');
      } else {
        console.log(
          `test-hygiene: this run added demo master rows (${createdBranches.join(', ') || 'no branches'}` +
            `${createdFiscalYears.length ? `; ${createdFiscalYears.join(', ')}` : ''}) — removing them`
        );
        const result = await removeDemoMasterRows(
          pool,
          createdBranches,
          createdFiscalYears,
          (message) => console.log(message)
        );
        if (result.remaining.branches > 0 || result.remaining.fiscalYears > 0) {
          console.warn(
            `test-hygiene: ${result.remaining.branches} demo branch row(s) and ` +
              `${result.remaining.fiscalYears} demo fiscal-year row(s) still reference-held; ` +
              'inspect the database before the next run.'
          );
        } else {
          console.log(`test-hygiene: database restored to its pre-run master (${result.deletedRows} row(s) removed)`);
        }
      }
    }
  }
} catch (err: any) {
  console.warn(`test-hygiene: ${mode} step skipped: ${err?.message || err}`);
} finally {
  // Only the cleanup pass owns the file's lifetime: the snapshot is what the
  // cleanup reads minutes later, so unlinking here would delete it before use.
  if (mode === 'cleanup') {
    try {
      fs.unlinkSync(snapshotPath);
    } catch {
      /* best effort: a leftover temp file is harmless */
    }
  }
  await pool.end().catch(() => undefined);
}
