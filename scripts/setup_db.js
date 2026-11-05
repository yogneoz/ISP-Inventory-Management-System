// ============================================================================
// PostgreSQL setup entry point (`npm run setup:pg`).
//
// Responsibilities, in order:
//   1. Load .env so setup uses the SAME credentials the server uses.
//   2. Ensure PostgreSQL is reachable (falls back to scripts/setup_postgres.sh
//      on Linux/macOS when it is not).
//   3. Clear every operational table while PRESERVING the Nepali BS calendar
//      (bs_calendar_years, bs_day_records). `--keep-data` skips this.
//   4. Apply scripts/schema.sql (idempotent).
//   5. Hand the seeding itself to scripts/seed_verification_data.ts, the ONE
//      dataset definition, so `npm run setup:pg` and `npm run seed:verify`
//      can never seed two different worlds.
//
// The wipe deliberately runs BEFORE the schema pass: schema.sql rewrites CHECK
// constraints with ADD CONSTRAINT, which validates existing rows, so a stale
// row from an older schema would otherwise abort the reset (and the server
// boot, which applies the same file).
// ============================================================================

import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const { Pool } = pg;

const DB_CONFIG = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'inventory_db',
  user: process.env.POSTGRES_USER || 'inventory_user',
  password: process.env.POSTGRES_PASSWORD || 'securepassword',
};

const KEEP_DATA = process.argv.includes('--keep-data');

async function tryConnect(retries = 3, delayMs = 1500) {
  const pool = new Pool({ ...DB_CONFIG, connectionTimeoutMillis: 4000 });
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return pool;
    } catch (err) {
      if (attempt === retries) {
        await pool.end().catch(() => {});
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

function runShellInstaller() {
  const scriptPath = path.join(process.cwd(), 'scripts', 'setup_postgres.sh');
  if (!fs.existsSync(scriptPath)) return false;
  try {
    console.log('🔧 Attempting automated shell installer (scripts/setup_postgres.sh)...');
    execSync(`bash "${scriptPath}"`, { stdio: 'inherit', timeout: 600000 });
    return true;
  } catch (err) {
    console.warn('⚠️ Shell installer notice:', err?.message || err);
    return false;
  }
}

async function applySchema(client) {
  const schemaPath = path.join(process.cwd(), 'scripts', 'schema.sql');
  if (!fs.existsSync(schemaPath)) throw new Error(`schema.sql not found at ${schemaPath}`);
  // One multi-statement simple query: PostgreSQL parses it natively, so
  // semicolons in comments or literals can never break client-side splitting.
  await client.query(fs.readFileSync(schemaPath, 'utf8'));
  console.log('✅ Database schema applied (scripts/schema.sql).');
}

async function wipeOperationalData(client) {
  const preserved = new Set(['bs_calendar_years', 'bs_day_records', 'fiscal_years']);
  const tables = (
    await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
    )
  ).rows.map((r) => r.table_name);
  const wipeTables = tables.filter((t) => !preserved.has(t));
  if (wipeTables.length > 0) {
    await client.query(`TRUNCATE TABLE ${wipeTables.join(', ')} RESTART IDENTITY CASCADE`);
    console.log(`🗑  Truncated ${wipeTables.length} tables (Nepali BS calendar preserved).`);
  }
  if (tables.includes('fiscal_years')) {
    // Plain DELETE (not TRUNCATE) so bs_day_records.fiscal_year_id is SET NULL
    // by the FK action instead of the calendar being wiped by CASCADE.
    await client.query('DELETE FROM fiscal_years');
    console.log('🗑  Removed fiscal years (BS calendar rows preserved, re-linked by the seeder).');
  }
}

function runDatasetSeeder() {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxCli)) {
    throw new Error(
      'tsx is not installed (node_modules/tsx/dist/cli.mjs missing). Run `npm install` first, then `npm run setup:pg`.'
    );
  }
  const args = [tsxCli, path.join('scripts', 'seed_verification_data.ts'), '--keep-data', '--skip-schema'];
  execFileSync(process.execPath, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      POSTGRES_HOST: DB_CONFIG.host,
      POSTGRES_PORT: String(DB_CONFIG.port),
      POSTGRES_DB: DB_CONFIG.database,
      POSTGRES_USER: DB_CONFIG.user,
      POSTGRES_PASSWORD: DB_CONFIG.password,
    },
  });
}

console.log('------------------------------------------------------------------');
console.log('🛠️  Automated PostgreSQL Setup Engine');
console.log(`🎯 Target: ${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
console.log('------------------------------------------------------------------');

async function runSetup() {
  let pool;
  try {
    pool = await tryConnect();
    console.log('✅ Connected to PostgreSQL.');
  } catch (err) {
    console.warn('⚠️ Could not connect to PostgreSQL:', err.message);
    runShellInstaller();
    try {
      pool = await tryConnect();
      console.log('✅ Connected to PostgreSQL (after installer attempt).');
    } catch (retryErr) {
      console.error('❌ PostgreSQL is not reachable and the automated installer did not help.');
      console.error('   Start PostgreSQL and re-run: npm run setup:pg');
      console.error('   Connection details:', JSON.stringify({ ...DB_CONFIG, password: '***' }));
      process.exit(1);
    }
  }

  const client = await pool.connect();
  try {
    if (KEEP_DATA) {
      console.log('🗑  --keep-data passed: skipping the wipe.');
    } else {
      await wipeOperationalData(client);
    }
    await applySchema(client);
  } finally {
    client.release();
    await pool.end();
  }

  runDatasetSeeder();
  console.log('🎉 PostgreSQL setup verified and operational!');
}

runSetup().catch((err) => {
  console.error('❌ Setup failed:', err);
  process.exit(1);
});
