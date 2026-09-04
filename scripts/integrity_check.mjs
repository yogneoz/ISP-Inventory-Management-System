import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || 'inventory_db',
  user: process.env.POSTGRES_USER || 'inventory_user',
  password: process.env.POSTGRES_PASSWORD,
  connectionTimeoutMillis: 3000,
});

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

try {
  const negativeStock = await pool.query(`
    SELECT COUNT(*)::int AS count FROM inventory_stock
    WHERE quantity_on_hand < 0 OR damaged_qty < 0 OR reserved_qty < 0 OR incoming_qty < 0
  `);
  check(negativeStock.rows[0].count === 0, 'Negative inventory quantity exists.');

  const duplicateSerials = await pool.query(`
    SELECT COUNT(*)::int AS count FROM (
      SELECT lower(trim(device_serial)) AS value FROM customer_device_records
      WHERE trim(device_serial) <> '' GROUP BY 1 HAVING COUNT(*) > 1
    ) duplicates
  `);
  const duplicatePons = await pool.query(`
    SELECT COUNT(*)::int AS count FROM (
      SELECT lower(trim(pon_serial)) AS value FROM customer_device_records
      WHERE trim(pon_serial) <> '' GROUP BY 1 HAVING COUNT(*) > 1
    ) duplicates
  `);
  const duplicateMacs = await pool.query(`
    SELECT COUNT(*)::int AS count FROM (
      SELECT lower(trim(mac_address)) AS value FROM customer_device_records
      WHERE mac_address IS NOT NULL AND trim(mac_address) <> '' GROUP BY 1 HAVING COUNT(*) > 1
    ) duplicates
  `);
  check(duplicateSerials.rows[0].count === 0, 'Duplicate device serials exist.');
  check(duplicatePons.rows[0].count === 0, 'Duplicate PON serials exist.');
  check(duplicateMacs.rows[0].count === 0, 'Duplicate MAC addresses exist.');

  const currentYears = await pool.query("SELECT COUNT(*)::int AS count FROM fiscal_years WHERE is_current = TRUE");
  check(currentYears.rows[0].count <= 1, 'Multiple fiscal years are marked current.');

  const missingFiscalIds = await pool.query(`
    SELECT COUNT(*)::int AS count FROM (
      SELECT fiscal_year_id FROM fixed_assets WHERE fiscal_year_id IS NULL
      UNION ALL SELECT fiscal_year_id FROM purchase_orders WHERE fiscal_year_id IS NULL
      UNION ALL SELECT fiscal_year_id FROM purchase_invoices WHERE fiscal_year_id IS NULL
      UNION ALL SELECT fiscal_year_id FROM shipments WHERE fiscal_year_id IS NULL
      UNION ALL SELECT fiscal_year_id FROM stock_operations WHERE fiscal_year_id IS NULL
      UNION ALL SELECT fiscal_year_id FROM customer_device_records WHERE fiscal_year_id IS NULL
    ) missing
  `);
  check(missingFiscalIds.rows[0].count === 0, 'Operational records are missing fiscal-year ownership.');

  const requiredObjects = await pool.query(`
    SELECT indexname AS name FROM pg_indexes
    WHERE indexname IN (
      'uq_customer_device_device_serial', 'uq_customer_device_pon_serial',
      'uq_customer_device_mac_address', 'uq_fiscal_years_single_current'
    )
    UNION ALL
    SELECT tgname AS name FROM pg_trigger
    WHERE tgname IN (
      'trg_purchase_invoices_fiscal_year', 'trg_shipments_fiscal_year',
      'trg_stock_operations_fiscal_year', 'trg_customer_devices_fiscal_year'
    )
  `);
  const names = new Set(requiredObjects.rows.map((row) => row.name));
  for (const name of [
    'uq_customer_device_device_serial', 'uq_customer_device_pon_serial',
    'uq_customer_device_mac_address', 'uq_fiscal_years_single_current',
    'trg_purchase_invoices_fiscal_year', 'trg_shipments_fiscal_year',
    'trg_stock_operations_fiscal_year', 'trg_customer_devices_fiscal_year',
  ]) check(names.has(name), `Required database integrity object is missing: ${name}.`);

  if (failures.length) {
    console.error('Integrity check failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('Integrity check passed: stock quantities, device identifiers, fiscal-year ownership, and database safeguards are healthy.');
  }
} catch (error) {
  console.error(`Integrity check could not run: ${error.message}`);
  process.exitCode = 2;
} finally {
  await pool.end();
}
