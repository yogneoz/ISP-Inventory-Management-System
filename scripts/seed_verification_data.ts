// ============================================================================
// `npm run seed:verify` — wipe the operational data, keep the Nepali BS
// calendar, and seed the verification dataset (two fiscal years, four branches,
// 20 customers each, 5 pcs of every stocked product, and the ledger figures the
// brief names).
//
//   node/tsx scripts/seed_verification_data.ts            full reset + seed
//   tsx scripts/seed_verification_data.ts --keep-data     seed without wiping
//   tsx scripts/seed_verification_data.ts --skip-schema   skip schema.sql
//
// scripts/setup_db.js calls this same file with --skip-schema --skip-verify
// after its own schema pass, so `npm run setup:pg` and `npm run seed:verify`
// can never drift into two different datasets.
// ============================================================================
import dotenv from 'dotenv';
import pg from 'pg';
import {
  applySchema,
  applyVerificationSeed,
  verifySeededDatabase,
  wipeOperationalData,
} from './seed/applyVerificationSeed';
import { buildVerificationDataset, checkDatasetInvariants } from './seed/verificationDataset';

dotenv.config({ quiet: true } as any);

const { Pool } = pg;

const DB_CONFIG = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'inventory_db',
  user: process.env.POSTGRES_USER || 'inventory_user',
  password: process.env.POSTGRES_PASSWORD || 'securepassword',
};

const KEEP_DATA = process.argv.includes('--keep-data');
const SKIP_SCHEMA = process.argv.includes('--skip-schema');
const SKIP_VERIFY = process.argv.includes('--skip-verify');

async function main() {
  const dataset = buildVerificationDataset();
  const invariantErrors = checkDatasetInvariants(dataset);
  if (invariantErrors.length > 0) {
    console.error('❌ Verification dataset does not satisfy its own rules:');
    for (const error of invariantErrors) console.error(`   • ${error}`);
    process.exit(1);
  }

  console.log('------------------------------------------------------------------');
  console.log('🧪 Verification dataset seeder');
  console.log(`🎯 Target: ${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
  console.log('------------------------------------------------------------------');

  const pool = new Pool({ ...DB_CONFIG, connectionTimeoutMillis: 8000 });
  const client = await pool.connect();
  try {
    if (!KEEP_DATA) {
      const wiped = await wipeOperationalData(client);
      console.log(`🗑  Cleared ${wiped.length} tables (Nepali BS calendar preserved: bs_calendar_years, bs_day_records).`);
    } else {
      console.log('🗑  --keep-data: existing rows left in place (inserts skip conflicts).');
    }

    if (!SKIP_SCHEMA) {
      await applySchema(client);
      console.log('📋 scripts/schema.sql applied (idempotent).');
    }

    console.log('🌱 Seeding masters, documents, stock and ledger...');
    const summary = await applyVerificationSeed(client, dataset);
    console.log(`✅ Seeded: ${JSON.stringify(summary)}`);
    console.log(`🔑 Login accounts: superadmin@example.com … auditor@example.com (password Demo@123)`);

    if (!SKIP_VERIFY) {
      const { ok, report } = await verifySeededDatabase(client);
      console.log('\n📊 Verification report');
      console.log(`   AR ${report.ar}  AP ${report.ap}  Inventory ${report.inventory}  Cash+Bank ${report.cashAndBank}`);
      console.log(`   Equity ${report.equity}  Fixed assets ${report.fixedAssets}  Prepaid ${report.prepaid}`);
      console.log('   Per-branch trial balance:', report.perBranch.map((r: any) => `${r.branch}=${r.difference}`).join(' '));
      console.log('   Stock per branch:', report.stock.map((r: any) => `${r.branch_id}: ${r.rows} rows @ ${r.min_qty}–${r.max_qty} pcs`).join(' | '));
      console.log('   Counts:', JSON.stringify(report.counts));
      if (!ok) {
        console.error('❌ Seeded figures do not match the verification targets.');
        process.exit(1);
      }
      console.log('✅ Every target matches (AR 10,000 / AP 15,000 / Inventory 20,000 / Cash+Bank 10,000 / Equity 50,000).');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
