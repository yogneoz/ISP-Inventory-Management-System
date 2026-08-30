import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import pg from 'pg';

const { Pool } = pg;

const DB_CONFIG = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'inventory_db',
  user: process.env.POSTGRES_USER || 'inventory_user',
  password: process.env.POSTGRES_PASSWORD || 'securepassword',
};

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
  'आइतबार', 'सोमबार', 'मंगलबार', 'बुधबार', 'बिहीबार', 'शुक्रबार', 'शनिबार'
];

// Updated BS Years data with correct calendar for 2078-2085
const DEFAULT_BS_YEARS = [
  { yearBS: 2078, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2021-04-14' },
  { yearBS: 2079, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2022-04-14' },
  { yearBS: 2080, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2023-04-14' },
  { yearBS: 2081, daysInMonths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], startAD: '2024-04-13' },
  { yearBS: 2082, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2025-04-14' },
  { yearBS: 2083, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2026-04-14' },
  { yearBS: 2084, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2027-04-14' },
  { yearBS: 2085, daysInMonths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], startAD: '2028-04-13' },
];

// Updated Fiscal Years
const DEFAULT_FISCAL_YEARS = [
  { id: 'fy-1', code: '2080-81', startDateAD: '2023-07-17', endDateAD: '2024-07-15', startDateBS: '2080-04-01 BS', endDateBS: '2080-12-31 BS', isCurrent: false, isClosed: true },
  { id: 'fy-2', code: '2081-82', startDateAD: '2024-07-16', endDateAD: '2025-07-15', startDateBS: '2081-04-01 BS', endDateBS: '2081-12-31 BS', isCurrent: false, isClosed: true },
  { id: 'fy-3', code: '2082-83', startDateAD: '2025-07-16', endDateAD: '2026-07-15', startDateBS: '2082-04-01 BS', endDateBS: '2082-12-31 BS', isCurrent: true, isClosed: false },
  { id: 'fy-4', code: '2083-84', startDateAD: '2026-07-16', endDateAD: '2027-07-15', startDateBS: '2083-04-01 BS', endDateBS: '2083-12-31 BS', isCurrent: false, isClosed: false },
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

console.log('------------------------------------------------------------------');
console.log('🛠️  IZone Automated PostgreSQL Setup Engine (Node.js/pg)');
console.log('------------------------------------------------------------------');

async function runSetup() {
  // First attempt: try executing bash installer script to guarantee PostgreSQL server installation
  try {
    const scriptPath = path.join(process.cwd(), 'scripts', 'setup_postgres.sh');
    if (fs.existsSync(scriptPath)) {
      console.log('🔹 Running automated shell setup script...');
      execSync(`bash "${scriptPath}"`, { stdio: 'inherit' });
    }
  } catch (err) {
    console.log('ℹ️ Shell setup script notice:', err.message || err);
  }

  // Second step: Connect to PostgreSQL and verify schema execution
  console.log('🔌 Connecting to PostgreSQL instance...');
  const pool = new Pool({
    ...DB_CONFIG,
    connectionTimeoutMillis: 5000,
  });

  try {
    const client = await pool.connect();
    console.log('✅ Connected to PostgreSQL successfully!');

    const schemaPath = path.join(process.cwd(), 'scripts', 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      console.log('📜 Applying database tables & structure from schema.sql...');
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      
      // Split and execute statements to handle potential errors
      const statements = schemaSql.split(';').filter(stmt => stmt.trim());
      for (const stmt of statements) {
        try {
          await client.query(stmt + ';');
        } catch (err) {
          // Ignore "already exists" errors
          if (!err.message.includes('already exists')) {
            console.warn('⚠️ Warning executing statement:', err.message);
          }
        }
      }
      console.log('✅ All Database Tables, Indexes, and Constraints applied!');
    }

    // Seed BS Calendar & Fiscal Years
    console.log('📅 Seeding Bikram Sambat (BS) Calendar and Fiscal Years into PostgreSQL...');
    
    // Seed Fiscal Years
    for (const fy of DEFAULT_FISCAL_YEARS) {
      await client.query(
        `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           code = EXCLUDED.code,
           start_date_ad = EXCLUDED.start_date_ad,
           end_date_ad = EXCLUDED.end_date_ad,
           start_date_bs = EXCLUDED.start_date_bs,
           end_date_bs = EXCLUDED.end_date_bs,
           is_current = EXCLUDED.is_current,
           is_closed = EXCLUDED.is_closed;`,
        [fy.id, fy.code, fy.startDateAD, fy.endDateAD, fy.startDateBS, fy.endDateBS, fy.isCurrent, fy.isClosed]
      );
    }

    // Seed BS Calendar Years & BS Day Records
    for (const yData of DEFAULT_BS_YEARS) {
      await client.query(
        `INSERT INTO bs_calendar_years (year_bs, days_in_months, start_ad)
         VALUES ($1, $2, $3)
         ON CONFLICT (year_bs) DO UPDATE SET
           days_in_months = EXCLUDED.days_in_months,
           start_ad = EXCLUDED.start_ad;`,
        [yData.yearBS, yData.daysInMonths, yData.startAD]
      );

      // Generate days for this year
      let runningDate = new Date(yData.startAD);
      for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
        const monthBS = monthIdx + 1;
        const daysInMonth = yData.daysInMonths[monthIdx] || 30;

        for (let dayBS = 1; dayBS <= daysInMonth; dayBS++) {
          const adDateStr = runningDate.toISOString().split('T')[0];
          const dayOfWeekIndex = runningDate.getUTCDay();

          const padMonth = monthBS < 10 ? `0${monthBS}` : `${monthBS}`;
          const padDay = dayBS < 10 ? `0${dayBS}` : `${dayBS}`;
          const bsDateStr = `${yData.yearBS}-${padMonth}-${padDay}`;

          const fyCode = formatNepaliFiscalYearCode(yData.yearBS, monthBS);
          const qtr = getNepaliQuarter(monthBS);

          await client.query(
            `INSERT INTO bs_day_records (
               ad_date, bs_date, bs_year, bs_month, bs_month_name, bs_month_name_np,
               bs_day, day_of_week_name, day_of_week_name_np, fiscal_year, quarter, is_weekend
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
               quarter = EXCLUDED.quarter,
               is_weekend = EXCLUDED.is_weekend;`,
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
              qtr,
              dayOfWeekIndex === 6
            ]
          );

          runningDate.setDate(runningDate.getDate() + 1);
        }
      }
    }

    console.log('✅ BS Calendar Years & Day-by-Day Database Table populated successfully!');

    // Seed default UOM (Unit of Measure) data
    console.log('📦 Seeding default Units of Measure...');
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
      await client.query(
        `INSERT INTO uom (id, name, symbol, type, is_base_unit)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           symbol = EXCLUDED.symbol,
           type = EXCLUDED.type,
           is_base_unit = EXCLUDED.is_base_unit;`,
        [uom.id, uom.name, uom.symbol, uom.type, uom.isBaseUnit]
      );
    }

    console.log('✅ Default Units of Measure seeded!');

    // Seed default document number configurations
    console.log('📄 Seeding document number configurations...');
    const defaultDocConfigs = [
      { id: 'doc-po', documentType: 'PURCHASE_ORDER', prefix: 'PO-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true },
      { id: 'doc-pi', documentType: 'PURCHASE_INVOICE', prefix: 'PI-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true },
      { id: 'doc-ship', documentType: 'SHIPMENT', prefix: 'SHIP-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true },
      { id: 'doc-stockop', documentType: 'STOCK_OPERATION', prefix: 'SO-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true },
      { id: 'doc-appreq', documentType: 'APPROVAL_REQUEST', prefix: 'AR-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true },
    ];

    for (const config of defaultDocConfigs) {
      await client.query(
        `INSERT INTO document_number_configs (
           id, document_type, prefix, suffix, min_digits, starting_number, next_number, reset_every_fiscal_year
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           document_type = EXCLUDED.document_type,
           prefix = EXCLUDED.prefix,
           suffix = EXCLUDED.suffix,
           min_digits = EXCLUDED.min_digits,
           starting_number = EXCLUDED.starting_number,
           next_number = EXCLUDED.next_number,
           reset_every_fiscal_year = EXCLUDED.reset_every_fiscal_year;`,
        [config.id, config.documentType, config.prefix, config.suffix, config.minDigits, config.startingNumber, config.nextNumber, config.resetEveryFiscalYear]
      );
    }

    console.log('✅ Document number configurations seeded!');

    // Verify created tables
    const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    console.log('\n📊 Configured PostgreSQL Database Tables:');
    res.rows.forEach((row, i) => {
      console.log(`   ${i + 1}. ${row.table_name}`);
    });

    // Check if company profile exists and seed if empty
    const companyCheck = await client.query(`SELECT COUNT(*) FROM company_profile`);
    if (parseInt(companyCheck.rows[0].count) === 0) {
      console.log('🏢 Seeding default company profile...');
      await client.query(
        `INSERT INTO company_profile (
           id, name, legal_name, address, phone, email, currency_symbol, default_tax_rate
         )
         VALUES (
           'comp-1', 
           'IZone Enterprise', 
           'IZone Enterprise Pvt. Ltd.', 
           'Kathmandu, Nepal', 
           '+977-1-1234567', 
           'info@izonenepal.com', 
           'Rs.', 
           13.00
         )
         ON CONFLICT (id) DO NOTHING;`
      );
      console.log('✅ Company profile seeded!');
    }

    client.release();
    await pool.end();
    console.log('\n🎉 PostgreSQL setup verified and operational!');
    console.log(`📌 Connection URL: postgres://${DB_CONFIG.user}:${DB_CONFIG.password}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
  } catch (dbErr) {
    console.warn('⚠️ Could not connect directly to PostgreSQL on port 5432:');
    console.warn('  ', dbErr.message);
    console.warn('ℹ️ PostgreSQL is required before starting the Express server.');
  }
}

runSetup();