// ============================================================================
// Fresh-demo reset: wipe ALL records from every table EXCEPT the Nepali (BS)
// calendar reference tables, then reseed the example/dummy dataset.
//
//   node scripts/reset_fresh_demo.mjs
//   node scripts/reset_fresh_demo.mjs --dry-run   (report only, no changes)
//
// PRESERVED (real reference data, never treated as dummy):
//   * bs_calendar_years   (Bikram Sambat year summaries)
//   * bs_day_records      (day-by-day AD <-> BS calendar)
//
// DELETED (everything else): users, branches, locations, suppliers,
// products, categories, stock, fixed assets, POs, invoices, shipments,
// customers, devices, approvals, stock operations, audit/transaction logs,
// opening stock, fiscal years, company profile, UOMs, doc number configs.
//
// RESEEDED by scripts/setup_db.js (fiscal years, BS calendar upserts, UOMs,
// doc configs, example company profile, example branches WH001/BRH01,
// example users superadmin@example.com et al. with is_demo = TRUE, and the
// demo operational dataset).
//
// After running, RESTART the server (`npm run dev`) so its in-memory caches
// re-hydrate from the database, then log in with:
//   superadmin@example.com / Demo@123
// ============================================================================

import pg from 'pg';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_CONFIG = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'inventory_db',
  user: process.env.POSTGRES_USER || 'inventory_user',
  password: process.env.POSTGRES_PASSWORD || 'securepassword',
};

const DRY_RUN = process.argv.includes('--dry-run');

// Nepali-date related tables: REAL reference data - never deleted, never
// labelled as dummy data.
const PRESERVED_TABLES = ['bs_calendar_years', 'bs_day_records'];

// Known real-data signatures scanned for after the reset (PII guard).
const PII_PATTERN =
  'inventory|\\.net\\.np|Urlabari|Biratchowk|Birtamode|Chulachuli|Kathmandu|Pokhara|Lalitpur|' +
  'Shrestha|Dhimal|Khatiwada|Chaudhary|Adhikari|Thapa|Karki|Gurung|' +
  'Nabin|Sandesh|Bidhya|Sanjiwani|Ramesh|Sunita|Binod|Prakash|Deepak|Suman|' +
  'Aarav|Pooja|Subash|Bina|Suresh|Bikash|Anita|Manoj';

const pool = new pg.Pool({ ...DB_CONFIG, connectionTimeoutMillis: 4000 });

try {
  await pool.query('SELECT 1');
} catch (err) {
  console.error('❌ Cannot connect to PostgreSQL:', err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Inventory current state
// ---------------------------------------------------------------------------
const tablesRes = await pool.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
);
const allTables = tablesRes.rows.map((r) => r.table_name);
const wipedTables = allTables.filter((t) => !PRESERVED_TABLES.includes(t));

console.log('==================================================================');
console.log(`🧹 Fresh-demo reset ${DRY_RUN ? '(DRY RUN - no changes will be made)' : '(LIVE)'}`);
console.log(`🎯 Target: ${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
console.log('==================================================================');
console.log('\n📊 Current row counts:');
for (const t of allTables) {
  const c = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
  const marker = PRESERVED_TABLES.includes(t) ? '  [PRESERVED - Nepali calendar]' : '  [will be wiped]';
  console.log(`   ${t.padEnd(32)} ${String(c.rows[0].n).padStart(7)}  ${marker}`);
}

if (DRY_RUN) {
  console.log('\n🏁 Dry run complete. Re-run without --dry-run to perform the reset.');
  await pool.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Wipe everything except the Nepali calendar tables
//
// IMPORTANT: fiscal_years must NOT be TRUNCATEd – bs_day_records has a FK to
// it and PostgreSQL TRUNCATE ... CASCADE does not honour the ON DELETE SET
// NULL action (it would wipe the Nepali calendar too). Instead fiscal_years
// rows are removed with a plain DELETE, which does honour ON DELETE SET NULL
// and just nulls bs_day_records.fiscal_year_id (re-linked by the reseed).
// ---------------------------------------------------------------------------
const wipeTables = wipedTables.filter((t) => t !== 'fiscal_years');
console.log(`\n🗑  Truncating ${wipeTables.length + 1} tables (preserving: ${PRESERVED_TABLES.join(', ')}...`);
await pool.query(`TRUNCATE TABLE ${wipeTables.join(', ')} RESTART IDENTITY CASCADE`);
await pool.query('DELETE FROM fiscal_years');
console.log('🗑  Done.');

// ---------------------------------------------------------------------------
// 3. Reseed master + example + demo data via the standard setup script
// ---------------------------------------------------------------------------
console.log('\n🌱 Reseeding via scripts/setup_db.js ...');
try {
  const out = execFileSync(process.execPath, ['scripts/setup_db.js'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(out);
} catch (err) {
  console.error('❌ Reseed failed:', err.message);
  if (err.stdout) console.log(err.stdout);
  if (err.stderr) console.error(err.stderr);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. Verify: row counts + PII scan
// ---------------------------------------------------------------------------
console.log('\n📊 Row counts after reset:');
for (const t of allTables) {
  const c = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
  console.log(`   ${t.padEnd(32)} ${c.rows[0].n}`);
}

console.log('\n🔍 PII scan (searching wiped tables for real names/emails/locations)...');
let piiHits = 0;
for (const t of wipedTables) {
  const colsRes = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
       AND data_type IN ('character varying', 'text', 'name')`,
    [t]
  );
  for (const col of colsRes.rows) {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${t} WHERE ${col.column_name}::text ~* $1`,
      [PII_PATTERN]
    );
    if (r.rows[0].n > 0) {
      piiHits += r.rows[0].n;
      console.log(`   ⚠️  ${t}.${col.column_name}: ${r.rows[0].n} matching row(s)`);
    }
  }
}

const bsRes = await pool.query(
  'SELECT (SELECT COUNT(*)::int FROM bs_calendar_years) AS y, (SELECT COUNT(*)::int FROM bs_day_records) AS d'
);
console.log(`\n📅 Nepali calendar preserved: ${bsRes.rows[0].y} year rows, ${bsRes.rows[0].d} day rows.`);

if (piiHits > 0) {
  console.log(`\n❌ PII scan found ${piiHits} suspect row(s) - review the lines above.`);
  await pool.end();
  process.exit(1);
}

console.log('\n✅ Reset complete: no real names/emails/locations remain in the database.');
console.log('   Next: restart the server (npm run dev), then log in with');
console.log('   superadmin@example.com / Demo@123');
await pool.end();