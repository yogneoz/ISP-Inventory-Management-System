#!/usr/bin/env node
/**
 * SCALE-2 synthetic fixture — SCRATCH DATABASE ONLY.
 *
 * Seeds the large-table shapes the pagination and bootstrap measurements are
 * about, using server-side `generate_series` so the client never materializes
 * millions of rows:
 *
 *   customers       5,000,000
 *   sales_invoices  1,000,000
 *   gl_journal_lines 10,000,000
 *   stock_operations 5,000,000
 *   branches              500
 *
 * Safety: the target must come from SCALE_FIXTURE_DATABASE_URL (never
 * DATABASE_URL), its database name must contain `_scale`, and `--yes` is
 * required. There is no flag to bypass either check. Rows are tagged with the
 * `scale-fixture-` prefix and removed by --cleanup.
 *
 * Usage:
 *   createdb inventory_scale
 *   DATABASE_URL=postgres://.../inventory_scale npm run db:setup
 *   SCALE_FIXTURE_DATABASE_URL=postgres://.../inventory_scale \
 *     node scripts/seed_scale_fixture.mjs --yes
 *   SCALE_FIXTURE_DATABASE_URL=... node scripts/seed_scale_fixture.mjs --cleanup
 *
 * Options: --customers N --invoices N --journal-lines N --stock-operations N
 *          --branches N --cleanup --yes --dry-run
 */
import pg from 'pg';

const args = process.argv.slice(2);
function numberFlag(name, fallback) {
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  const value = Number(args[at + 1]);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`${name} needs a non-negative integer`);
    process.exit(2);
  }
  return value;
}
const cleanup = args.includes('--cleanup');
const dryRun = args.includes('--dry-run');
const confirmed = args.includes('--yes');
const counts = {
  branches: numberFlag('--branches', 500),
  customers: numberFlag('--customers', 5_000_000),
  invoices: numberFlag('--invoices', 1_000_000),
  journalLines: numberFlag('--journal-lines', 10_000_000),
  stockOperations: numberFlag('--stock-operations', 5_000_000),
  // The log tables are what the BRIN question is about (A7 put the BRIN there):
  // seed them wide enough that the planner has a real choice to make.
  auditLogs: numberFlag('--audit-logs', 2_000_000),
  transactionLogs: numberFlag('--transaction-logs', 1_000_000),
};

const url = process.env.SCALE_FIXTURE_DATABASE_URL;
if (!url) {
  console.error('SCALE_FIXTURE_DATABASE_URL is required; DATABASE_URL is never used for this fixture.');
  process.exit(2);
}
let databaseName = '';
try {
  databaseName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
} catch {
  console.error('SCALE_FIXTURE_DATABASE_URL is not a valid PostgreSQL URL.');
  process.exit(2);
}
if (!/_scale(?:$|_)/i.test(databaseName)) {
  console.error(
    `Refusing to seed '${databaseName}': the database name must contain '_scale' (for example inventory_scale).`
  );
  process.exit(2);
}
if (!cleanup && !dryRun && !confirmed) {
  console.error('Refusing to write millions of rows without --yes. Use --dry-run to inspect the plan.');
  process.exit(2);
}

console.log('SCALE-2 fixture plan', { databaseName, ...counts, cleanup, dryRun });
if (dryRun) process.exit(0);

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (cleanup) {
    // audit_logs is append-only (A7), so the fixture removes its own rows through
    // the same schema-sanctioned switch the ledger purge uses, in one
    // transaction with the rest of the teardown.
    await client.query('BEGIN');
    await client.query("SET LOCAL inventory.allow_ledger_purge = 'on'");
    await client.query("DELETE FROM gl_journal_lines WHERE id LIKE 'scale-fixture-%'");
    await client.query("DELETE FROM sales_invoices WHERE id LIKE 'scale-fixture-%'");
    await client.query("DELETE FROM stock_operations WHERE id LIKE 'scale-fixture-%'");
    await client.query("DELETE FROM customer_records WHERE id LIKE 'scale-fixture-%'");
    await client.query("DELETE FROM gl_journals WHERE id LIKE 'scale-fixture-%'");
    await client.query("DELETE FROM branches WHERE id LIKE 'scale-fixture-%'");
    await client.query("DELETE FROM audit_logs WHERE id LIKE 'scale-fixture-%'");
    await client.query("DELETE FROM transaction_logs WHERE id LIKE 'scale-fixture-%'");
    await client.query('COMMIT');
    console.log('fixture rows removed');
  } else {
    const schema = await client.query(`
      SELECT
        to_regclass('public.branches') IS NOT NULL AS branches,
        to_regclass('public.customer_records') IS NOT NULL AS customers,
        to_regclass('public.sales_invoices') IS NOT NULL AS invoices,
        to_regclass('public.gl_journals') IS NOT NULL AS journals,
        to_regclass('public.gl_journal_lines') IS NOT NULL AS journal_lines,
        to_regclass('public.stock_operations') IS NOT NULL AS stock_operations,
        to_regclass('public.gl_accounts') IS NOT NULL AS accounts
    `);
    const missing = Object.entries(schema.rows[0]).filter(([, ok]) => !ok).map(([name]) => name);
    if (missing.length) {
      console.error('Target does not have the application schema; missing:', missing.join(', '));
      process.exitCode = 1;
    } else {
      const fy = await client.query(
        'SELECT id FROM fiscal_years ORDER BY is_current DESC, start_date_ad DESC LIMIT 1'
      );
      const period = await client.query(
        'SELECT id FROM gl_periods ORDER BY period_key DESC LIMIT 1'
      );
      const account = await client.query('SELECT id FROM gl_accounts ORDER BY code ASC LIMIT 1');
      if (!fy.rows[0] || !period.rows[0] || !account.rows[0]) {
        console.error('Scratch database needs at least one fiscal year, GL period and GL account.');
        process.exitCode = 1;
      } else {
        const fiscalYearId = fy.rows[0].id;
        const periodId = period.rows[0].id;
        const accountId = account.rows[0].id;

        // A partial earlier run may already own the branches; counts.branches can
        // therefore be 0 while rows still need a branch to reference. Everything
        // below assigns rows with a modulo of this value.
        const branchTotal = Math.max(
          counts.branches,
          Number((await client.query("SELECT count(*) FROM branches WHERE id LIKE 'scale-fixture-%'")).rows[0].count)
        );
        if (branchTotal === 0 && counts.customers + counts.invoices + counts.stockOperations > 0) {
          console.error('Scale fixture needs at least one scale-fixture branch; pass --branches.');
          process.exit(1);
        }

        await client.query(
          `INSERT INTO branches (id, code, name, location, active, is_demo)
           SELECT 'scale-fixture-br-' || g, 'SF' || lpad(g::text, 4, '0'),
                  'Scale Fixture Branch ' || g, 'Fixture District ' || g, true, false
           FROM generate_series(1, $1) g
           ON CONFLICT (id) DO NOTHING`,
          [counts.branches]
        );

        await client.query(
          `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, status)
           SELECT 'scale-fixture-cus-' || g,
                  'SCUS-' || lpad(g::text, 9, '0'),
                  'Scale Customer ' || g,
                  '98' || lpad((g % 100000000)::text, 8, '0'),
                  'scale-fixture-br-' || (1 + (g % $1)),
                  'ACTIVE'
           FROM generate_series(1, $2) g`,
          [branchTotal, counts.customers]
        );

        // SCALE-3: the invoice register is partitioned by invoice_date_ad, so the
        // fixture provisions every month it is about to write (the write path
        // does the same for real sales; this is a bulk insert straight into the
        // table, so it has to do it explicitly).
        await client.query(
          `SELECT ensure_sales_invoice_month_partition(m)
             FROM (SELECT DISTINCT date_trunc('month', DATE '2020-01-01' + (g % 2200))::date AS m
                     FROM generate_series(1, $1) g) months`,
          [counts.invoices]
        );

        await client.query(
          `INSERT INTO sales_invoices
             (id, invoice_number, customer_name, branch_id, invoice_date_ad, invoice_date_bs,
              grand_total, taxable_amount, vat_amount, payment_status, items)
           SELECT 'scale-fixture-inv-' || g,
                  'SINV-' || lpad(g::text, 9, '0'),
                  'Scale Customer ' || g,
                  'scale-fixture-br-' || (1 + (g % $1)),
                  DATE '2020-01-01' + (g % 2200),
                  '2076-01-01',
                  (g % 100000)::numeric / 100,
                  (g % 90000)::numeric / 100,
                  (g % 9000)::numeric / 100,
                  'PAID',
                  '[]'::jsonb
           FROM generate_series(1, $2) g`,
          [branchTotal, counts.invoices]
        );

        // A small journal header set keeps the 10M lines FK-valid without
        // requiring 10M headers; the line query is what the fixture measures.
        await client.query(
          `INSERT INTO gl_journals
             (id, journal_no, journal_date_ad, journal_date_bs, fiscal_year_id, period_id,
              branch_id, source_type, memo)
           SELECT 'scale-fixture-jr-' || g,
                  'SJV-' || lpad(g::text, 6, '0'),
                  DATE '2020-01-01' + (g % 2200),
                  '2076-01-01',
                  $1, $2, 'scale-fixture-br-1', 'MANUAL', 'Scale fixture journal'
           FROM generate_series(1, $3) g
           ON CONFLICT DO NOTHING`,
          [fiscalYearId, periodId, Math.min(1000, counts.journalLines)]
        );

        await client.query(
          `INSERT INTO gl_journal_lines
             (id, journal_id, journal_date_ad, journal_date_bs, line_no, account_id, branch_id,
              debit, credit, memo)
           SELECT 'scale-fixture-line-' || g,
                  'scale-fixture-jr-' || (1 + (g % $1)),
                  -- Must equal the referenced journal's date: the ledger's
                  -- (journal_id, journal_date_ad) foreign key is composite
                  -- because gl_journals is partitioned by the date.
                  DATE '2020-01-01' + ((1 + (g % $1)) % 2200),
                  '2076-01-01',
                  g,
                  $2,
                  'scale-fixture-br-1',
                  CASE WHEN g % 2 = 0 THEN 100 ELSE 0 END,
                  CASE WHEN g % 2 = 0 THEN 0 ELSE 100 END,
                  'Scale fixture line'
           FROM generate_series(1, $3) g`,
          [Math.min(1000, counts.journalLines), accountId, counts.journalLines]
        );

        await client.query(
          `INSERT INTO stock_operations
             (id, reference_number, type, reason, date_ad, date_bs, branch_id, status)
           SELECT 'scale-fixture-op-' || g,
                  'SOP-' || lpad(g::text, 9, '0'),
                  'STOCK_OUT',
                  'Scale fixture operation',
                  DATE '2020-01-01' + (g % 2200),
                  '2076-01-01',
                  'scale-fixture-br-' || (1 + (g % $1)),
                  'LOGGED'
           FROM generate_series(1, $2) g`,
          [branchTotal, counts.stockOperations]
        );

        // The BRIN question is about the two log tables (A7): seed them across 24
        // months, provisioning each month through the function the write path
        // uses, so the measurement scans real month partitions instead of one
        // DEFAULT child.
        if (counts.auditLogs > 0 || counts.transactionLogs > 0) {
          await client.query(
            `SELECT ensure_log_month_partition('audit_logs', d::timestamptz)
               FROM generate_series(TIMESTAMPTZ '2024-03-01', TIMESTAMPTZ '2026-02-01', INTERVAL '1 month') d`
          );
          await client.query(
            `SELECT ensure_log_month_partition('transaction_logs', d::timestamptz)
               FROM generate_series(TIMESTAMPTZ '2024-03-01', TIMESTAMPTZ '2026-02-01', INTERVAL '1 month') d`
          );
          if (counts.auditLogs > 0) {
            await client.query(
              `INSERT INTO audit_logs (id, user_email, user_name, action, module, details, timestamp_ad, timestamp_bs)
               SELECT 'scale-fixture-aud-' || g,
                      'scale@fixture',
                      'Scale Fixture',
                      'SCALE_FIXTURE',
                      'SYSTEM',
                      'scale fixture audit row ' || g,
                      TIMESTAMPTZ '2024-03-01' + (g::numeric / $1 * INTERVAL '730 days'),
                      '2080-11-12'
               FROM generate_series(1, $1) g`,
              [counts.auditLogs]
            );
          }
          if (counts.transactionLogs > 0) {
            await client.query(
              `INSERT INTO transaction_logs
                 (id, transaction_number, change_type, quantity_before, quantity_changed, quantity_after,
                  branch_id, timestamp_ad, timestamp_bs, created_by)
               SELECT 'scale-fixture-txn-' || g,
                      'STXN-' || lpad(g::text, 9, '0'),
                      'MANUAL_ADJUSTMENT',
                      0, 1, 1,
                      'scale-fixture-br-1',
                      TIMESTAMPTZ '2024-03-01' + (g::numeric / $1 * INTERVAL '730 days'),
                      '2080-11-12',
                      'scale@fixture'
               FROM generate_series(1, $1) g`,
              [counts.transactionLogs]
            );
          }
        }

        await client.query(
          `ANALYZE branches;
           ANALYZE customer_records;
           ANALYZE sales_invoices;
           ANALYZE gl_journals;
           ANALYZE gl_journal_lines;
           ANALYZE stock_operations;
           ANALYZE audit_logs;
           ANALYZE transaction_logs;`
        );
        console.log('fixture seeded');
      }
    }
  }
} finally {
  await client.end();
}
