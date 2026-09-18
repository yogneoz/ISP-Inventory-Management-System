// ============================================================================
// Inventory-ERP Automated PostgreSQL Setup Engine (Node.js/pg)
//
// Responsibilities:
//   1. Ensure the PostgreSQL server is reachable (falls back to the shell
//      installer script on Linux/macOS when it is not).
//   2. Apply scripts/schema.sql (idempotent - safe to re-run).
//   3. CLEAR all existing data EXCEPT the Nepali BS calendar reference
//      tables (bs_calendar_years, bs_day_records) so seeding always starts
//      from a clean slate. Use --keep-data to skip this step.
//   4. Seed master data (fiscal years, BS calendar, UOMs, doc number configs,
//      company profile, branches, example users) – the seeded branches,
//      users and fiscal years are flagged is_demo = TRUE so the clear-demo
//      action can remove and re-seed them.
//   5. Seed the dummy operational dataset with is_demo = TRUE (products,
//      stock, fixed assets, purchase orders, suppliers, categories).
//   6. Backfill fiscal_year_id on transactional rows from their AD dates.
//
// Safety: if a table already contains REAL (is_demo = FALSE) rows the demo
// seeder skips that table unless you pass --force. The server itself never
// seeds dummy data at runtime; this script is the only demo-data entry point.
// ============================================================================

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import pg from 'pg';
import { buildDemoDataset } from './demo_dataset.js';

const { Pool } = pg;

const DB_CONFIG = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'inventory_db',
  user: process.env.POSTGRES_USER || 'inventory_user',
  password: process.env.POSTGRES_PASSWORD || 'securepassword',
};

const FORCE = process.argv.includes('--force');
const KEEP_DATA = process.argv.includes('--keep-data');

const NEPALI_MONTHS_EN = [
  'Baisakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'
];

const NEPALI_MONTHS_NP = [
  'वैशाख', 'जेठ', 'असार', 'श्रावण', 'भाद्र', 'असोज',
  'कार्तिक', 'मंसिर', 'पुस', 'माघ', 'फागुन', 'चैत'
];

const DAYS_OF_WEEK_EN = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];

const DAYS_OF_WEEK_NP = [
  'आईटबार', 'सोमबार', 'मंगलबार', 'बुधबार', 'बिहिबार', 'शुक्रबार', 'शनिबार'
];

// BS calendar coverage 2078-2085 (kept in sync with the server calendar).
const DEFAULT_BS_YEARS = [
  { yearBS: 2078, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2021-04-14' },
  { yearBS: 2079, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2022-04-14' },
  { yearBS: 2080, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2023-04-14' },
  { yearBS: 2081, daysInMonths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], startAD: '2024-04-13' },
  { yearBS: 2082, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2025-04-14' },
  { yearBS: 2083, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2026-04-14' },
  { yearBS: 2084, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 30, 30, 30], startAD: '2027-04-14' },
  { yearBS: 2085, daysInMonths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], startAD: '2028-04-13' },
];

// Fiscal years. isCurrent is intentionally left for the seeder to compute:
// exactly one row may carry is_current = TRUE (enforced by the
// uq_fiscal_years_single_current partial unique index).
const DEFAULT_FISCAL_YEARS = [
  { id: 'fy-1', code: '2080-81', startDateAD: '2023-07-17', endDateAD: '2024-07-15', startDateBS: '2080-04-01 BS', endDateBS: '2080-12-31 BS', isClosed: true },
  { id: 'fy-2', code: '2081-82', startDateAD: '2024-07-16', endDateAD: '2025-07-15', startDateBS: '2081-04-01 BS', endDateBS: '2081-12-31 BS', isClosed: true },
  { id: 'fy-3', code: '2082-83', startDateAD: '2025-07-16', endDateAD: '2026-07-15', startDateBS: '2082-04-01 BS', endDateBS: '2082-12-31 BS', isClosed: false },
  { id: 'fy-4', code: '2083-84', startDateAD: '2026-07-16', endDateAD: '2027-07-15', startDateBS: '2083-04-01 BS', endDateBS: '2083-12-31 BS', isClosed: false },
  { id: 'fy-5', code: '2084-85', startDateAD: '2027-07-16', endDateAD: '2028-07-15', startDateBS: '2084-04-01 BS', endDateBS: '2084-12-31 BS', isClosed: false },
  { id: 'fy-6', code: '2085-86', startDateAD: '2028-07-16', endDateAD: '2029-07-15', startDateBS: '2085-04-01 BS', endDateBS: '2085-12-31 BS', isClosed: false },
];

// EXAMPLE/DUMMY branch master (is_demo = TRUE) - no real branch data.
// Mirrors the server's INITIAL_MASTER_BRANCHES so demo rows have valid branch
// foreign keys even on a database that has never run the server.
const DEFAULT_BRANCHES = [
  { id: 'WH001', code: 'WH001', name: 'Branch 1 (Head Office)', location: 'Example Location 1', phone: '9800000000', isHeadquarters: true },
  { id: 'BRH01', code: 'BRH01', name: 'Branch 2', location: 'Example Location 2', phone: '9800000001', isHeadquarters: false },
];

// EXAMPLE/DUMMY user accounts (is_demo = TRUE) so the application is fully
// testable out of the box. Shared demo password: Demo@123 (see README.md).
// Mirrors the server's INITIAL_EXAMPLE_USERS (seeded with the same ids so the
// two seeders never create duplicate accounts).
const EXAMPLE_USER_PASSWORD = 'Demo@123';
const DEFAULT_EXAMPLE_USERS = [
  { id: 'usr-ex-superadmin', email: 'superadmin@example.com', name: 'Super Admin', role: 'SUPER_ADMIN', branchId: 'WH001', canSwitchUser: true },
  { id: 'usr-ex-branch1', email: 'branch1@example.com', name: 'Branch 1 Manager', role: 'BRANCH_MANAGER', branchId: 'WH001', canSwitchUser: false },
  { id: 'usr-ex-branch2', email: 'branch2@example.com', name: 'Branch 2 Manager', role: 'BRANCH_MANAGER', branchId: 'BRH01', canSwitchUser: false },
  { id: 'usr-ex-inventory1', email: 'inventory1@example.com', name: 'Inventory Manager 1', role: 'INVENTORY_MANAGER', branchId: 'WH001', canSwitchUser: false },
  { id: 'usr-ex-accountant1', email: 'accountant1@example.com', name: 'Accountant 1', role: 'ACCOUNTANT', branchId: 'WH001', canSwitchUser: false },
  { id: 'usr-ex-frontdesk1', email: 'frontdesk1@example.com', name: 'Front Desk 1', role: 'FRONT_DESK', branchId: 'BRH01', canSwitchUser: false },
];

function formatNepaliFiscalYearCode(yearBS, monthBS) {
  let startYear = yearBS;
  if (monthBS < 4) {
    startYear = yearBS - 1;
  }
  const endYearShort = String(startYear + 1).slice(-2);
  return `${startYear}-${endYearShort}`;
}

function getNepaliQuarter(monthBS) {
  if (monthBS >= 4 && monthBS <= 6) return 'Q1';
  if (monthBS >= 7 && monthBS <= 9) return 'Q2';
  if (monthBS >= 10 && monthBS <= 12) return 'Q3';
  return 'Q4';
}

const FISCAL_YEAR_CODE_TO_ID = Object.fromEntries(DEFAULT_FISCAL_YEARS.map((fy) => [fy.code, fy.id]));

function todayADString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

// Last-resort attempt to provision the PostgreSQL server itself. Only useful
// on Linux/macOS hosts (or Windows with an available bash); the call is
// wrapped in a try/catch so it can never crash the Node-based setup.
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
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`schema.sql not found at ${schemaPath}`);
  }
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  // The entire schema file is sent to PostgreSQL as ONE multi-statement
  // simple query. The server parses the SQL natively, so semicolons inside
  // comments or string literals can never break client-side statement
  // splitting. The script is fully idempotent (CREATE ... IF NOT EXISTS,
  // ALTER TABLE ... ADD COLUMN IF NOT EXISTS) and is applied atomically:
  // either the complete v3.0 schema lands or nothing does, so a partially
  // migrated schema state can never occur.
  try {
    await client.query(schemaSql);
    console.log('✅ Database schema applied (scripts/schema.sql, single atomic multi-statement query).');
  } catch (err) {
    console.error('❌ Schema application failed:', err.message);
    throw new Error(`Failed to apply scripts/schema.sql: ${err.message}`);
  }
}

// Verifies the v3.0 enterprise columns exist so a stale schema fails loudly.
async function ensureEnterpriseColumns(client) {
  const checks = [
    { table: 'products', column: 'is_demo', label: 'demo tracking' },
    { table: 'stock_operations', column: 'fiscal_year_id', label: 'fiscal-year FK' },
    { table: 'purchase_orders', column: 'is_demo', label: 'demo tracking' },
  ];
  for (const c of checks) {
    const res = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [c.table, c.column]
    );
    if (res.rows.length === 0) {
      throw new Error(`Schema check failed: ${c.table}.${c.column} missing (${c.label}). Re-run schema migration.`);
    }
  }
}

// Upserts the fiscal-year master rows (structural fields only) and makes sure
// exactly one fiscal year is flagged current: the one containing today. If an
// admin already chose a current year in the app, that choice is respected.
async function seedFiscalYears(client) {
  for (const fy of DEFAULT_FISCAL_YEARS) {
    await client.query(
      `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, TRUE)
       ON CONFLICT (id) DO UPDATE SET
         code = EXCLUDED.code,
         start_date_ad = EXCLUDED.start_date_ad,
         end_date_ad = EXCLUDED.end_date_ad,
         start_date_bs = EXCLUDED.start_date_bs,
         end_date_bs = EXCLUDED.end_date_bs,
         is_demo = EXCLUDED.is_demo`,
      [fy.id, fy.code, fy.startDateAD, fy.endDateAD, fy.startDateBS, fy.endDateBS, fy.isClosed]
    );
  }

  const alreadyCurrent = await client.query('SELECT COUNT(*) AS count FROM fiscal_years WHERE is_current = TRUE');
  if (parseInt(alreadyCurrent.rows[0].count, 10) > 0) {
    console.log('✅ Fiscal years present and a current fiscal year is already set (left untouched).');
    return;
  }

  const today = todayADString();
  const current = await client.query(
    `SELECT id FROM fiscal_years
     WHERE $1::date BETWEEN start_date_ad AND end_date_ad
     ORDER BY start_date_ad DESC LIMIT 1`,
    [today]
  );
  const fallback = current.rows[0]
    ? current.rows[0]
    : (await client.query('SELECT id FROM fiscal_years ORDER BY end_date_ad DESC LIMIT 1')).rows[0];

  if (fallback) {
    await client.query('UPDATE fiscal_years SET is_current = TRUE WHERE id = $1', [fallback.id]);
    const detail = await client.query('SELECT code FROM fiscal_years WHERE id = $1', [fallback.id]);
    console.log(`✅ Flagged fiscal year ${detail.rows[0].code} as current (contains ${today}).`);
  }
}

// Seeds the BS calendar year summaries + day-by-day records. The
// fiscal_year_id FK is populated when the derived code has a matching
// fiscal-year master row (NULL for years outside the seeded FY range).
async function seedBsCalendar(client) {
  for (const yData of DEFAULT_BS_YEARS) {
    await client.query(
      `INSERT INTO bs_calendar_years (year_bs, days_in_months, start_ad)
       VALUES ($1, $2, $3)
       ON CONFLICT (year_bs) DO UPDATE SET
         days_in_months = EXCLUDED.days_in_months,
         start_ad = EXCLUDED.start_ad`,
      [yData.yearBS, yData.daysInMonths, yData.startAD]
    );

    let runningDate = new Date(`${yData.startAD}T00:00:00Z`);
    for (let monthIdx = 0; monthIdx < 12; monthIdx += 1) {
      const monthBS = monthIdx + 1;
      const daysInMonth = yData.daysInMonths[monthIdx] || 30;

      for (let dayBS = 1; dayBS <= daysInMonth; dayBS += 1) {
        const adDateStr = runningDate.toISOString().split('T')[0];
        const dayOfWeekIndex = runningDate.getUTCDay();

        const padMonth = monthBS < 10 ? `0${monthBS}` : `${monthBS}`;
        const padDay = dayBS < 10 ? `0${dayBS}` : `${dayBS}`;
        const bsDateStr = `${yData.yearBS}-${padMonth}-${padDay}`;

        const fyCode = formatNepaliFiscalYearCode(yData.yearBS, monthBS);
        const fyId = FISCAL_YEAR_CODE_TO_ID[fyCode] || null;
        const qtr = getNepaliQuarter(monthBS);

        await client.query(
          `INSERT INTO bs_day_records (
             ad_date, bs_date, bs_year, bs_month, bs_month_name, bs_month_name_np,
             bs_day, day_of_week_name, day_of_week_name_np, fiscal_year, fiscal_year_id, quarter, is_weekend
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (ad_date) DO UPDATE SET
             bs_date = EXCLUDED.bs_date,
             bs_year = EXCLUDED.bs_year,
             bs_month = EXCLUDED.bs_month,
             bs_month_name = EXCLUDED.bs_month_name,
             bs_month_name_np = EXCLUDED.bs_month_name_np,
             bs_day = EXCLUDED.bs_day,
             day_of_week_name = EXCLUDED.day_of_week_name,
             day_of_week_name_np = EXCLUDED.day_of_week_name_np,
             fiscal_year = EXCLUDED.fiscal_year,
             fiscal_year_id = EXCLUDED.fiscal_year_id,
             quarter = EXCLUDED.quarter,
             is_weekend = EXCLUDED.is_weekend`,
          [
            adDateStr,
            bsDateStr,
            yData.yearBS,
            monthBS,
            NEPALI_MONTHS_EN[monthIdx],
            NEPALI_MONTHS_NP[monthIdx],
            dayBS,
            DAYS_OF_WEEK_EN[dayOfWeekIndex],
            DAYS_OF_WEEK_NP[dayOfWeekIndex],
            fyCode,
            fyId,
            qtr,
            dayOfWeekIndex === 6,
          ]
        );

        runningDate.setUTCDate(runningDate.getUTCDate() + 1);
      }
    }
  }
  console.log('✅ BS calendar years & day records populated (with fiscal_year_id links).');
}

async function seedUnitOfMeasures(client) {
  const defaultUOMs = [
    { id: 'uom-pcs', name: 'Pieces', symbol: 'Pcs', type: 'Count', isBaseUnit: true },
    { id: 'uom-kg', name: 'Kilogram', symbol: 'Kg', type: 'Weight', isBaseUnit: true },
    { id: 'uom-gm', name: 'Gram', symbol: 'Gm', type: 'Weight', isBaseUnit: false },
    { id: 'uom-mt', name: 'Meter', symbol: 'Mt', type: 'Length', isBaseUnit: true },
    { id: 'uom-cm', name: 'Centimeter', symbol: 'Cm', type: 'Length', isBaseUnit: false },
    { id: 'uom-ltr', name: 'Liter', symbol: 'Ltr', type: 'Volume', isBaseUnit: true },
    { id: 'uom-ml', name: 'Milliliter', symbol: 'Ml', type: 'Volume', isBaseUnit: false },
    { id: 'uom-box', name: 'Box', symbol: 'Box', type: 'Count', isBaseUnit: false },
  ];
  for (const uom of defaultUOMs) {
    const byId = await client.query('SELECT 1 FROM uom WHERE id = $1', [uom.id]);
    if (byId.rows.length > 0) continue;
    const byName = await client.query('SELECT id FROM uom WHERE name = $1', [uom.name]);
    if (byName.rows.length > 0) {
      // The server may already have seeded this UOM under its own id (e.g.
      // uom-1). Adopt the existing row instead of violating name uniqueness.
      await client.query(
        'UPDATE uom SET symbol = $2, type = $3, is_base_unit = $4 WHERE id = $1',
        [byName.rows[0].id, uom.symbol, uom.type, uom.isBaseUnit]
      );
      continue;
    }
    await client.query(
      `INSERT INTO uom (id, name, symbol, type, is_base_unit)
       VALUES ($1, $2, $3, $4, $5)`,
      [uom.id, uom.name, uom.symbol, uom.type, uom.isBaseUnit]
    );
  }
  console.log('✅ Default Units of Measure seeded.');
}

// Document number configurations. The server issues document numbers itself
// using document_sequence_daily as `{DOC_TYPE}-{BRANCH_CODE}-{YYYYMMDD}{NNNN}`
// (e.g. PO-BRC01-202609150001). Only the `prefix` remains user-editable and it
// is just the human label; the actual code placed in front of the branch code
// is the leading alphanumeric token of the prefix (PO-2081- -> PO). These 22
// configs mirror server.ts INITIAL_DOCUMENT_NUMBER_CONFIGS exactly.
async function seedDocumentConfigs(client) {
  const defaultDocConfigs = [
    { id: 'PO', documentType: 'Purchase Order', prefix: 'PO-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for vendor purchase requisitions and official purchase orders.' },
    { id: 'PI', documentType: 'Purchase Invoice / Bill', prefix: 'PI-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for supplier purchase invoices and tax bills.' },
    { id: 'GRN', documentType: 'Goods Receipt Note (GRN)', prefix: 'GRN-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used when warehouse receives inbound stock shipments.' },
    { id: 'DN', documentType: 'Purchase Return & Debit Note', prefix: 'DN-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for returning defective goods to vendors and supplier debit notes.' },
    { id: 'INV', documentType: 'Sales & POS Invoice', prefix: 'INV-2081-', suffix: '', minDigits: 5, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for POS sales bills and customer sales tax invoices.' },
    { id: 'QUO', documentType: 'Sales Quotation & Proforma Invoice', prefix: 'QUO-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for issuing formal price quotes and proforma invoices to clients.' },
    { id: 'CN', documentType: 'Sales Return & Credit Note', prefix: 'CN-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for customer product returns and VAT credit note adjustments.' },
    { id: 'ST', documentType: 'Inter-Branch Stock Transfer', prefix: 'ST-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for branch-to-branch stock transfers and dispatches.' },
    { id: 'SA', documentType: 'Stock Adjustment & Audit', prefix: 'SA-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used during physical stock audits and inventory reconciliations.' },
    { id: 'DC', documentType: 'Damage & Pullout Claim', prefix: 'DC-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for damaged stock write-offs and pullout dispatches.' },
    { id: 'CPI', documentType: 'Consumable Product Issue', prefix: 'CPI-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for internal material consumption, office supplies, and store use requisitions.' },
    { id: 'EXC', documentType: 'Device Exchange & Replacement', prefix: 'EXC-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for customer device trade-ins, replacement swaps, and exchange vouchers.' },
    { id: 'WC', documentType: 'Warranty Service & Repair Slip', prefix: 'WC-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for customer repair jobs, device service intake, and warranty claims.' },
    { id: 'FAA', documentType: 'Fixed Asset Assignment & Transfer', prefix: 'FAA-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for assigning company assets to staff, custody handovers, and department transfers.' },
    { id: 'FAR', documentType: 'Fixed Asset Capitalization & Register', prefix: 'FAR-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for logging newly capitalized fixed assets into company asset register.' },
    { id: 'JV', documentType: 'Journal Voucher', prefix: 'JV-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for manual general ledger transactions and depreciation entries.' },
    { id: 'PV', documentType: 'Payment Disbursement Voucher', prefix: 'PV-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for supplier bill payments, operational expenses, and bank disbursements.' },
    { id: 'RV', documentType: 'Cash & Bank Receipt Voucher', prefix: 'RV-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for customer payments, advance collections, and bank deposits.' },
    { id: 'CP', documentType: 'Cash Payment', prefix: 'CP-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for cash payment disbursements to suppliers and vendors.' },
    { id: 'CR', documentType: 'Cash Receive', prefix: 'CR-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for cash receipts received from customers.' },
    { id: 'BP', documentType: 'Bank Payment', prefix: 'BP-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for bank transfer and cheque payment disbursements to suppliers.' },
    { id: 'BR', documentType: 'Bank Receive', prefix: 'BR-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for bank transfer and cheque receipts received from customers.' },
  ];
  for (const config of defaultDocConfigs) {
    await client.query(
      `INSERT INTO document_number_configs (
         id, document_type, prefix, suffix, min_digits, starting_number, next_number, reset_every_fiscal_year, notes
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         document_type = EXCLUDED.document_type,
         prefix = EXCLUDED.prefix,
         suffix = EXCLUDED.suffix,
         min_digits = EXCLUDED.min_digits,
         starting_number = EXCLUDED.starting_number,
         next_number = EXCLUDED.next_number,
         reset_every_fiscal_year = EXCLUDED.reset_every_fiscal_year,
         notes = EXCLUDED.notes`,
      [config.id, config.documentType, config.prefix, config.suffix, config.minDigits, config.startingNumber, config.nextNumber, config.resetEveryFiscalYear, config.notes || '']
    );
  }
  console.log('✅ Document number configurations seeded (22 types, daily per-branch numbering).');
}

async function seedCompanyProfile(client) {
  const companyCheck = await client.query('SELECT COUNT(*) AS count FROM company_profile');
  if (parseInt(companyCheck.rows[0].count, 10) > 0) return;
  // Ensure newly introduced currency/address columns exist even on an older schema.
  await client.query(
    `ALTER TABLE company_profile
       ADD COLUMN IF NOT EXISTS currency_code VARCHAR(10) DEFAULT 'NPR',
       ADD COLUMN IF NOT EXISTS currency_locale VARCHAR(20) DEFAULT 'en-IN',
       ADD COLUMN IF NOT EXISTS currency_position VARCHAR(10) DEFAULT 'before',
       ADD COLUMN IF NOT EXISTS currency_decimals INT DEFAULT 2,
       ADD COLUMN IF NOT EXISTS postal_code VARCHAR(30)`
  );
  await client.query(
    `INSERT INTO company_profile (
       id, name, legal_name, address, city, country, phone, email, currency_symbol, currency_code, currency_locale, currency_position, currency_decimals, default_tax_rate
     )
     VALUES ('COMP-001', 'Inventory Management System', 'Inventory Management System (Demo)', 'Kathmandu, Nepal', 'Kathmandu', 'Nepal', '', '', 'NPR', 'NPR', 'en-IN', 'before', 2, 13.00)
     ON CONFLICT (id) DO NOTHING`
  );
  console.log('✅ Default company profile seeded.');
}

async function seedBranches(client) {
  // is_demo column is added by the server startup migration; ensure it here
  // too so a bare `npm run setup:pg` works on an empty database.
  await client.query(`ALTER TABLE branches ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE`);
  await client.query(`ALTER TABLE branches ADD COLUMN IF NOT EXISTS allow_warehouse_transfer BOOLEAN NOT NULL DEFAULT TRUE`);
  for (const b of DEFAULT_BRANCHES) {
    await client.query(
      `INSERT INTO branches (id, code, name, location, phone, is_headquarters, active, allow_procurement, allow_warehouse_transfer, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, TRUE, TRUE, TRUE) ON CONFLICT (id) DO NOTHING`,
      [b.id, b.code, b.name, b.location, b.phone, b.isHeadquarters]
    );
  }
  console.log(`✅ Branch master data ensured (${DEFAULT_BRANCHES.length} branches, is_demo = TRUE).`);
}

// Seeds the example/dummy user accounts (is_demo = TRUE). Passwords use the
// same scrypt format as the server's hashPassword so login works immediately.
// Existing accounts (matched by email) are never overwritten.
async function seedExampleUsers(client) {
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE`);
  for (const u of DEFAULT_EXAMPLE_USERS) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(EXAMPLE_USER_PASSWORD, salt, 64).toString('hex');
    const allowedBranchIds = u.role === 'SUPER_ADMIN' ? DEFAULT_BRANCHES.map((b) => b.id) : [u.branchId];
    await client.query(
      `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) ON CONFLICT (email) DO NOTHING`,
      [u.id, u.email, `scrypt$${salt}$${hash}`, u.name, u.role, u.branchId, allowedBranchIds, u.canSwitchUser]
    );
  }
  console.log(`✅ Example user accounts ensured (${DEFAULT_EXAMPLE_USERS.length} accounts, demo password ${EXAMPLE_USER_PASSWORD}, is_demo = TRUE).`);
}

// Real-data guard: returns the number of non-demo rows in a table.
async function countRealRows(client, table) {
  const res = await client.query(`SELECT COUNT(*) AS count FROM ${table} WHERE is_demo = FALSE`);
  return parseInt(res.rows[0].count, 10);
}

// Seeds the dummy operational dataset (is_demo = TRUE). Each table is only
// seeded when it contains no real (is_demo = FALSE) rows, unless --force is
// passed. Demo rows use their own id namespace so they can coexist with real
// data without collisions.
async function seedDemoData(client) {
  const summary = {};
  const skipTable = async (table) => {
    const real = await countRealRows(client, table);
    if (real > 0 && !FORCE) {
      console.log(`⏭️  ${table}: ${real} real row(s) present - demo seed skipped (use --force to override).`);
      return true;
    }
    return false;
  };

  const dataset = buildDemoDataset(DEFAULT_BRANCHES);

  if (!(await skipTable('suppliers'))) {
    for (const s of dataset.suppliers) {
      await client.query(
        `INSERT INTO suppliers (id, name, contact_person, phone, email, address, pan_vat_number, rating, status, is_demo, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', TRUE, 'setup:pg demo seeder')
         ON CONFLICT (id) DO NOTHING`,
        [s.id, s.name, s.contactPerson, s.phone, s.email, s.address, s.panVatNumber, s.rating]
      );
    }
    summary.suppliers = dataset.suppliers.length;
  }

  if (!(await skipTable('categories'))) {
    for (const c of dataset.categories) {
      await client.query(
        `INSERT INTO categories (id, name, code, description, is_special_tracked, is_demo, created_by)
         VALUES ($1, $2, $3, $4, $5, TRUE, 'setup:pg demo seeder')
         ON CONFLICT (id) DO NOTHING`,
        [c.id, c.name, c.code, c.description, c.isSpecialTracked || false]
      );
    }
    summary.categories = dataset.categories.length;
  }

  if (!(await skipTable('products'))) {
    for (const p of dataset.products) {
      await client.query(
        `INSERT INTO products (id, sku, barcode, name, category, product_group, unit, cost_price, selling_price, tax_rate, min_reorder_level, requires_serial_tracking, tracking_type, description, status, is_demo, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'ACTIVE', TRUE, 'setup:pg demo seeder')
         ON CONFLICT (id) DO NOTHING`,
        [p.id, p.sku, p.barcode, p.name, p.category, p.productGroup, p.unit, p.costPrice, p.sellingPrice, p.taxRate, p.minReorderLevel, p.requiresSerialTracking, p.trackingType, p.description]
      );
    }
    summary.products = dataset.products.length;
  }

  if (!(await skipTable('inventory_stock'))) {
    for (const st of dataset.inventoryStock) {
      await client.query(
        `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level, is_demo, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, 'setup:pg demo seeder')
         ON CONFLICT (id) DO NOTHING`,
        [st.id, st.productId, st.branchId, st.quantityOnHand, st.damagedQty, st.reservedQty, st.incomingQty, st.minReorderLevel]
      );
    }
    summary.inventory_stock = dataset.inventoryStock.length;
  }

  // Seed damage_records table (proper damage tracking with audit trail)
  if (!(await skipTable('damage_records'))) {
    for (const dm of (dataset.damageRecords || [])) {
      await client.query(
        `INSERT INTO damage_records (id, damage_reference, product_id, branch_id, quantity_damaged, unit_cost, total_cost, damage_date_ad, damage_date_bs, damage_reason, status, disposal_date_ad, disposal_date_bs, disposal_method, salvage_value, gl_account_code, write_off_loss, approved_by, notes, fiscal_year_id, is_demo, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, TRUE, $21)
         ON CONFLICT (id) DO NOTHING`,
        [
          dm.id, dm.damageReference, dm.productId, dm.branchId, dm.quantityDamaged,
          dm.unitCost, dm.totalCost, dm.damageDateAD, dm.damageDateBS, dm.damageReason,
          dm.status, dm.disposalDateAD, dm.disposalDateBS, dm.disposalMethod,
          dm.salvageValue, dm.glAccountCode, dm.writeOffLoss, dm.approvedBy, dm.notes,
          dm.fiscalYearId, dm.createdBy
        ]
      );
    }
    summary.damage_records = (dataset.damageRecords || []).length;
  }

  // Seed locations table
  if (!(await skipTable('locations'))) {
    for (const loc of (dataset.locations || [])) {
      await client.query(
        `INSERT INTO locations (id, name, type, branch_id, address, coordinates, contact_person, contact_phone, notes, active_assets_count, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [loc.id, loc.name, loc.type, loc.branchId, loc.address, JSON.stringify(loc.coordinates || {}), loc.contactPerson, loc.contactPhone, loc.notes, loc.activeAssetsCount || 0]
      );
    }
    summary.locations = (dataset.locations || []).length;
  }

  // Seed customer_records table
  if (!(await skipTable('customer_records'))) {
    for (const cust of (dataset.customerRecords || [])) {
      await client.query(
        `INSERT INTO customer_records (id, customer_id, customer_name, username, contact_number, branch_id, address, email, status, credit_limit, assigned_devices_count, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [cust.id, cust.customerId, cust.customerName, cust.username, cust.contactNumber, cust.branchId, cust.address, cust.email, cust.status, cust.creditLimit || 0, cust.assignedDevicesCount || 0]
      );
    }
    summary.customer_records = (dataset.customerRecords || []).length;
  }

  if (!(await skipTable('fixed_assets'))) {
    for (const a of dataset.assetRegister) {
      const serviceDate = new Date(`${a.placedInServiceDateAD || a.acquisitionDateAD}T00:00:00`);
      const today = new Date();
      const monthsElapsed = Math.max(
        0,
        (today.getFullYear() - serviceDate.getFullYear()) * 12 +
          (today.getMonth() - serviceDate.getMonth()) +
          (today.getDate() >= serviceDate.getDate() ? 0 : -1)
      );
      const annualDepreciation = Number(a.acquisitionCost || 0) * Number(a.depreciationRatePercent || 0) / 100;
      const accumulatedDepreciation = Math.min(
        Number(a.acquisitionCost || 0),
        annualDepreciation * monthsElapsed / 12
      );
      const netBookValue = Math.max(0, Number(a.acquisitionCost || 0) - accumulatedDepreciation);
      await client.query(
        `INSERT INTO fixed_assets (id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs, purchase_invoice_date_ad, purchase_invoice_date_bs, capitalization_date_ad, placed_in_service_date_ad, acquisition_cost, depreciation_method, depreciation_rate_percent, accumulated_depreciation, net_book_value, status, product_id, is_demo, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'ACTIVE', $17, TRUE, 'setup:pg demo seeder')
         ON CONFLICT (id) DO NOTHING`,
        [a.id, a.tagNumber, a.name, a.category, a.branchId, a.acquisitionDateAD, a.acquisitionDateBS, a.purchaseInvoiceDateAD || a.acquisitionDateAD, a.purchaseInvoiceDateBS || a.acquisitionDateBS, a.capitalizationDateAD || a.acquisitionDateAD, a.placedInServiceDateAD || a.acquisitionDateAD, a.acquisitionCost, a.depreciationMethod, a.depreciationRatePercent, accumulatedDepreciation, netBookValue, a.productId || null]
      );
    }
    summary.fixed_assets = dataset.assetRegister.length;
  }

  if (!(await skipTable('purchase_orders'))) {
    for (const po of dataset.purchaseOrders) {
      await client.query(
        `INSERT INTO purchase_orders (id, po_number, supplier_id, supplier_name, branch_id, order_date_ad, order_date_bs, expected_delivery_date_ad, status, subtotal_amount, tax_amount, total_amount, notes, items, is_demo, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE, 'setup:pg demo seeder')
         ON CONFLICT (id) DO NOTHING`,
        [po.id, po.poNumber, po.supplierId || null, po.supplierName, po.branchId, po.orderDateAD, po.orderDateBS, po.expectedDeliveryDateAD, po.status, po.subtotalAmount, po.taxAmount, po.totalAmount, po.notes, JSON.stringify(po.items)]
      );
    }
    summary.purchase_orders = dataset.purchaseOrders.length;
  }

  // Seed purchase_invoices demo rows (is_demo = TRUE) so Accounts Payable has
  // realistic vendor bills for payment recording and the vendor ledger.
  if (!(await skipTable('purchase_invoices'))) {
    const demoInvoices = dataset.purchaseInvoices || [];
    for (const inv of demoInvoices) {
      const itemsJson = JSON.stringify(inv.items || []);
      await client.query(
        `INSERT INTO purchase_invoices (
           id, invoice_number, po_reference_id, vendor_bill_number, supplier_id, supplier_name, branch_id,
           invoice_date_ad, invoice_date_bs, due_date_ad, due_date_bs, taxable_amount, vat_amount,
           non_taxable_amount, grand_total, payment_status, payment_method, amount_paid, notes, items, is_demo, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, TRUE, 'setup:pg demo seeder')
         ON CONFLICT (id) DO NOTHING`,
        [
          inv.id, inv.invoiceNumber, inv.poReferenceId || null, inv.vendorBillNumber || null,
          inv.supplierId || null, inv.supplierName, inv.branchId,
          inv.invoiceDateAD, inv.invoiceDateBS, inv.dueDateAD || null, inv.dueDateBS || null,
          inv.taxableAmount || 0, inv.vatAmount || 0, inv.nonTaxableAmount || 0,
          inv.grandTotal || 0, inv.paymentStatus || 'UNPAID', inv.paymentMethod || 'CREDIT',
          inv.amountPaid || 0, inv.notes || '', itemsJson,
        ]
      );
    }
    summary.purchase_invoices = demoInvoices.length;
  }

  // Seed vendor_payments demo rows (is_demo = TRUE) — the sub-ledger entries
  // behind the Vendor Ledger report and invoice payment history.
  if (!(await skipTable('vendor_payments'))) {
    const demoPayments = dataset.vendorPayments || [];
    for (const p of demoPayments) {
      await client.query(
        `INSERT INTO vendor_payments (
           id, payment_number, supplier_id, supplier_name, branch_id, invoice_id, invoice_number,
           payment_date_ad, payment_date_bs, amount, payment_method, bank_name, bank_branch,
           account_number, cheque_number, cheque_date_ad, cheque_date_bs, transaction_reference,
           notes, status, reversal_reason, reversed_by, reversed_at_ad, original_payment_id,
           fiscal_year_id, is_demo, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, TRUE, $26)
         ON CONFLICT (id) DO NOTHING`,
        [
          p.id, p.paymentNumber, p.supplierId || null, p.supplierName, p.branchId,
          p.invoiceId || null, p.invoiceNumber || null,
          p.paymentDateAD, p.paymentDateBS || null, p.amount, p.paymentMethod || 'CASH',
          p.bankName || null, p.bankBranch || null, p.accountNumber || null,
          p.chequeNumber || null, p.chequeDateAD || null, p.chequeDateBS || null,
          p.transactionReference || null, p.notes || null, p.status || 'POSTED',
          p.reversalReason || null, p.reversedBy || null, p.reversedAtAD || null,
          p.originalPaymentId || null, p.fiscalYearId || null, p.createdBy || 'System Seeder',
        ]
      );
    }
    summary.vendor_payments = demoPayments.length;
  }

  if (Object.keys(summary).length === 0) {
    console.log('⏭️  Demo data seeding skipped: all operational tables already contain real data (no --force).');
  } else {
    console.log(`✅ Demo dataset seeded with is_demo = TRUE: ${JSON.stringify(summary)}`);
  }
}

// Fills fiscal_year_id on every transactional row that has none yet, deriving
// the fiscal year from the record's AD date. Safe to re-run (only touches
// rows where fiscal_year_id IS NULL).
async function backfillFiscalYearIds(client) {
  const tables = [
    { table: 'fixed_assets', dateCol: 'acquisition_date_ad' },
    { table: 'purchase_orders', dateCol: 'order_date_ad' },
    { table: 'purchase_invoices', dateCol: 'invoice_date_ad' },
    { table: 'vendor_payments', dateCol: 'payment_date_ad' },
    { table: 'shipments', dateCol: 'dispatch_date_ad' },
    { table: 'stock_operations', dateCol: 'date_ad' },
    { table: 'customer_device_records', dateCol: 'issued_date_ad' },
    { table: 'approval_requests', dateCol: 'requested_at_ad' },
    { table: 'transaction_logs', dateCol: 'timestamp_ad' },
    { table: 'audit_logs', dateCol: 'timestamp_ad' },
  ];
  let total = 0;
  for (const { table, dateCol } of tables) {
    const res = await client.query(
      `UPDATE ${table} t
       SET fiscal_year_id = fy.id
       FROM fiscal_years fy
       WHERE t.fiscal_year_id IS NULL
         AND t.${dateCol} IS NOT NULL
         AND t.${dateCol}::date >= fy.start_date_ad
         AND t.${dateCol}::date <= fy.end_date_ad`,
    );
    total += res.rowCount || 0;
  }
  console.log(`✅ fiscal_year_id backfilled on ${total} row(s).`);
}

console.log('------------------------------------------------------------------');
console.log('🛠️  Automated PostgreSQL Setup Engine (Node.js/pg)');
console.log(FORCE ? '⚠️  Running with --force: demo data will be seeded even alongside real data' : '');
console.log(`🎯 Target: ${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
console.log('------------------------------------------------------------------');

async function runSetup() {
  // 1. Connect (with a shell-installer fallback for bare Linux/macOS hosts).
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
      console.error('   Connection details:', JSON.stringify(DB_CONFIG));
      process.exit(1);
    }
  }

  const client = await pool.connect();
  try {
    // 2. Schema (idempotent).
    console.log('📋 Applying database schema from scripts/schema.sql...');
    await applySchema(client);
    await ensureEnterpriseColumns(client);

    // 3. Wipe all operational data (except Nepali BS calendar tables)
    //    so seeding always starts from a clean slate.  Tables are truncated
    //    with CASCADE (FK ordering is handled automatically).
    //    Pass --keep-data to skip the wipe (useful when the database holds
    //    real data that must not be touched).
    //
    //    IMPORTANT: fiscal_years must NOT be TRUNCATEd – bs_day_records has
    //    a FK to it and PostgreSQL TRUNCATE ... CASCADE does not honour the
    //    ON DELETE SET NULL action (it would wipe the Nepali calendar too).
    //    Instead fiscal_years rows are removed with a plain DELETE, which
    //    does honour ON DELETE SET NULL, so bs_day_records.fiscal_year_id is
    //    simply nulled and later re-linked by seedBsCalendar().
    if (KEEP_DATA) {
      console.log('🗑  --keep-data passed: skipping data wipe (preserving existing rows).');
    } else {
      const preservedTables = new Set(['bs_calendar_years', 'bs_day_records', 'fiscal_years']);
      const tblRes = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
      );
      const wipeTables = tblRes.rows
        .map((r) => r.table_name)
        .filter((t) => !preservedTables.has(t));
      if (wipeTables.length > 0) {
        await client.query(`TRUNCATE TABLE ${wipeTables.join(', ')} RESTART IDENTITY CASCADE`);
        console.log(`🗑  Truncated ${wipeTables.length} tables (preserved Nepali BS calendar + fiscal_years).`);
      }
      // Plain DELETE (not TRUNCATE) so bs_day_records.fiscal_year_id is
      // SET NULL via the FK action instead of the calendar being wiped.
      await client.query('DELETE FROM fiscal_years');
      console.log('🗑  Removed all fiscal years (Nepali calendar rows preserved, will re-link).');
    }

    // 4. Master data (real, is_demo = FALSE).
    console.log('📅 Seeding fiscal years & Bikram Sambat calendar...');
    await seedFiscalYears(client);
    await seedBsCalendar(client);
    await seedUnitOfMeasures(client);
    await seedDocumentConfigs(client);
    await seedCompanyProfile(client);
    await seedBranches(client);
    await seedExampleUsers(client);

    // 5. Dummy operational dataset (is_demo = TRUE).
    console.log('🧪 Seeding demo dataset (is_demo = TRUE)...');
    await seedDemoData(client);

    // 6. Fiscal-year linkage for historical rows.
    await backfillFiscalYearIds(client);

    // Verify & summarize.
    const res = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    );
    console.log(`\n📊 Configured PostgreSQL database has ${res.rows.length} tables:`);
    res.rows.forEach((row, i) => {
      console.log(`   ${i + 1}. ${row.table_name}`);
    });

    const demoCounts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM products WHERE is_demo)        AS products,
        (SELECT COUNT(*) FROM inventory_stock WHERE is_demo) AS stock,
        (SELECT COUNT(*) FROM fixed_assets WHERE is_demo)    AS assets,
        (SELECT COUNT(*) FROM purchase_orders WHERE is_demo) AS orders,
        (SELECT COUNT(*) FROM purchase_invoices WHERE is_demo) AS invoices,
        (SELECT COUNT(*) FROM vendor_payments WHERE is_demo) AS vendor_payments,
        (SELECT COUNT(*) FROM damage_records WHERE is_demo)  AS damage_records
    `);
    console.log(`\n📌 Demo rows now in database: ${JSON.stringify(demoCounts.rows[0])}`);
    console.log('🎉 PostgreSQL setup verified and operational!');
    console.log(`📌 Connection URL: postgres://${DB_CONFIG.user}:${DB_CONFIG.password}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
  } finally {
    client.release();
    await pool.end();
  }
}

runSetup().catch((err) => {
  console.error('❌ Setup failed:', err);
  process.exit(1);
});
