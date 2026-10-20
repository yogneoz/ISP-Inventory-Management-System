/**
 * BS calendar / BS-date audit — `npm run audit:bs-dates`.
 *
 * Thin CLI over the ONE engine (server/src/services/bsCalendarIntegrity.service.ts)
 * that the API, the Calendar Health panel in the BS Calendar Utility and the
 * boot check all use. The rules live there; this file only connects, prints and
 * sets the exit code, so the terminal can never disagree with the UI.
 *
 * Usage:
 *   npx tsx scripts/audit_bs_calendar_dates.ts            # report only (exit 1 on fixable findings)
 *   npx tsx scripts/audit_bs_calendar_dates.ts --apply    # write the derivable corrections
 *
 * --apply only ever rewrites values that are DERIVABLE from the patro-verified
 * calendar (shared/bsCalendarYears.json) or from a row's own AD date; anything
 * else is reported and left untouched rather than guessed. It runs in one
 * transaction, so a failure leaves the database as it was.
 */
import 'dotenv/config';
import pg from 'pg';
import { applyBsCalendarFixes, auditBsCalendar } from '../server/src/services/bsCalendarIntegrity.service';

const APPLY = process.argv.includes('--apply');
const DETAIL_LIMIT = 12;

/**
 * Connection resolution. An explicit POSTGRES_DB (the same variable the seeder
 * and the server read) WINS over DATABASE_URL: passing both to pg lets the
 * connection string's database win silently, so `POSTGRES_DB=other
 * npm run audit:bs-dates -- --apply` would have written to the application
 * database while printing nothing to say so. The resolved target is printed
 * from the server itself, so the operator always sees which database is being
 * audited — or corrected.
 */
const EXPLICIT_DB = process.env.POSTGRES_DB;
const pool = new pg.Pool(
  EXPLICIT_DB
    ? {
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
        database: EXPLICIT_DB,
        user: process.env.POSTGRES_USER || 'inventory_user',
        password: process.env.POSTGRES_PASSWORD || 'securepassword',
        connectionTimeoutMillis: 4000,
      }
    : {
        connectionString: process.env.DATABASE_URL || undefined,
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
        database: 'inventory_db',
        user: process.env.POSTGRES_USER || 'inventory_user',
        password: process.env.POSTGRES_PASSWORD || 'securepassword',
        connectionTimeoutMillis: 4000,
      }
);

const client = await pool.connect();
try {
  const target = (
    await client.query(
      "SELECT current_database() AS db, COALESCE(inet_server_addr()::text, 'local') AS host, inet_server_port() AS port"
    )
  ).rows[0];
  console.log(
    `Auditing ${target.host}:${target.port}/${target.db}${APPLY ? ' (APPLY)' : ''}` +
      `${EXPLICIT_DB ? ' [POSTGRES_DB]' : ' [DATABASE_URL]'}\n`
  );

  if (APPLY) await client.query('BEGIN');
  const result = APPLY
    ? await applyBsCalendarFixes(client)
    : { applied: [], skipped: [], report: await auditBsCalendar(client) };

  if (APPLY) {
    if (result.applied.length === 0) {
      console.log('no derivable findings to apply.');
    } else {
      for (const fix of result.applied) console.log(`  fixed: ${fix.title}`);
    }
    for (const skip of result.skipped) console.log(`  skipped ${skip.id}: ${skip.reason}`);
    console.log('');
  }

  const { report } = result;
  console.log('=== findings ===');
  for (const finding of report.findings) {
    const mark = finding.fixable ? 'FIXABLE' : 'REPORT ';
    console.log(`  [${mark}] ${finding.severity === 'error' ? '!' : '~'} ${finding.title}`);
    console.log(`            ${finding.detail}`);
    if (finding.expected) console.log(`            expected: ${finding.expected}`);
  }
  if (report.findings.length === 0) console.log('  the stored calendar matches the patro data');

  console.log('\n=== summary ===');
  console.log(`  years seeded:                  ${report.summary.yearsSeeded}`);
  console.log(`  years verified by the patro:   ${report.summary.yearsCoveredByPatro}`);
  console.log(`  patro years missing from db:   ${report.summary.yearsMissingFromDb.join(', ') || 'none'}`);
  console.log(`  provisional years:             ${report.summary.provisionalYears.join(', ') || 'none'}`);
  console.log(`  day rows:                      ${report.summary.dayRows} (patro days: ${report.summary.patroDays})`);
  console.log(`  day rows outside the patro:    ${report.summary.dayRowsOutsidePatro}`);
  console.log(`  stored "*_bs" values checked:  ${report.summary.storedBsValuesChecked}`);
  console.log(`  findings:                      ${report.summary.total} (${report.summary.errors} error, ${report.summary.warnings} warning)`);
  console.log(`  derivable (fixable):           ${report.summary.fixable}`);
  console.log(`  reported, never guessed:       ${report.summary.total - report.summary.fixable}`);

  if (APPLY) {
    if (result.applied.length > 0) await client.query('COMMIT');
    console.log(
      result.applied.length > 0
        ? `\n${result.applied.length} correction(s) applied; ${report.summary.fixable} derivable finding(s) remain.`
        : ''
    );
  } else if (report.summary.fixable > 0) {
    console.log(`\n${report.summary.fixable} finding(s) are fixable — re-run with --apply to write them.`);
    process.exitCode = 1;
  } else {
    console.log('\nno fixable findings.');
  }
} catch (err) {
  if (APPLY) await client.query('ROLLBACK').catch(() => undefined);
  throw err;
} finally {
  client.release();
  await pool.end();
}
