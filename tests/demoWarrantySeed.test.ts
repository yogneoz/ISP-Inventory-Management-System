/**
 * WTY-7 demo warranty fixture, clear order and legacy-backfill proof.
 *
 * Three separate risks this pins:
 *
 *  1. FIXTURE — the demo seed has to exercise the registers, not decorate them:
 *     both sides must show valid, expiring and expired rows on a FRESH seed,
 *     dates must be derived from the run date (a fixed acquisition date turned
 *     every seeded asset expired within a year), and one current row per
 *     type + serial. Building the dataset is cheap and needs no database, so
 *     the shape is asserted directly rather than by squinting at a screen.
 *  2. CLEAR ORDER — warranty_coverages references products, fixed assets and
 *     device records. It is cleared first so its demo rows are counted before
 *     an FK cascade can hide them (asserted in admin.repo.test.ts too; here the
 *     concern is that the seeder actually persists what the fixture builds).
 *  3. BACKFILL — the legacy 12-month INSERTs in scripts/schema.sql are
 *     extracted and run TWICE inside one rolled-back transaction on the real
 *     database. That proves the statements are idempotent, mark their rows
 *     LEGACY_12_MONTH, and leave a unit already captured by an operator alone
 *     (the NOT EXISTS guard) — without applying the whole schema to a shared
 *     test database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

import { buildDemoDataset } from '../scripts/demo_dataset.js';
import {
  addCalendarMonths,
  isAdDate,
  todayAd,
  warrantyDaysRemaining,
  warrantyStateFor,
} from '../shared/warrantyTerm';
import { INITIAL_MASTER_BRANCHES } from '../server/src/config/seedData';

dotenv.config();

const branches = INITIAL_MASTER_BRANCHES.map((b) => ({ ...b, isHeadquarters: Boolean(b.isHeadquarters) }));
const dataset = buildDemoDataset(branches);

type Coverage = {
  id: string;
  coverageType: 'VENDOR' | 'SELLER';
  itemCategory: string;
  productId?: string | null;
  productName: string;
  serialNumber: string;
  assetId?: string | null;
  branchId?: string | null;
  startDateAD: string;
  endDateAD: string;
  termMonths?: number | null;
  startBasis: string;
  notes?: string;
  isCurrent: boolean;
  isDemo: boolean;
};

const coverages = dataset.warrantyCoverages as Coverage[];

describe('demo warranty fixture', () => {
  test('both registers carry valid, expiring and expired rows on a fresh seed', () => {
    assert.ok(coverages.length >= 6, `expected a populated fixture, got ${coverages.length}`);
    const today = todayAd();
    for (const type of ['VENDOR', 'SELLER'] as const) {
      const states = new Set(
        coverages.filter((c) => c.coverageType === type).map((c) => warrantyStateFor(c.endDateAD, today))
      );
      assert.deepEqual(
        [...states].sort(),
        ['EXPIRED', 'EXPIRING_SOON', 'VALID'],
        `${type} coverage must exercise all three register states`
      );
    }
  });

  test('every coverage is a real, ordered range and matches its term snapshot', () => {
    for (const coverage of coverages) {
      assert.ok(isAdDate(coverage.startDateAD), `${coverage.id}: invalid start ${coverage.startDateAD}`);
      assert.ok(isAdDate(coverage.endDateAD), `${coverage.id}: invalid expiry ${coverage.endDateAD}`);
      assert.ok(coverage.endDateAD >= coverage.startDateAD, `${coverage.id}: expiry precedes start`);
      assert.equal(coverage.isCurrent, true, `${coverage.id}: demo rows are current`);
      assert.equal(coverage.isDemo, true, `${coverage.id}: demo rows must be is_demo = TRUE`);
      if (coverage.termMonths !== null && coverage.termMonths !== undefined) {
        assert.equal(
          coverage.endDateAD,
          addCalendarMonths(coverage.startDateAD, coverage.termMonths),
          `${coverage.id}: expiry must equal start + term (the shared calendar-month rule)`
        );
      }
    }
  });

  test('one current row per coverage type + serial (the partial unique index)', () => {
    const keys = coverages.map((c) => `${c.coverageType}:${c.serialNumber.toUpperCase()}`);
    assert.equal(new Set(keys).size, keys.length, 'duplicate current coverage in the demo dataset');
    assert.equal(new Set(coverages.map((c) => c.id)).size, coverages.length, 'duplicate coverage id');
  });

  test('dates are derived from the seed run, not frozen on a 2024 acquisition', () => {
    // The failure this prevents: every seeded asset acquired on one old date,
    // so the old warranty screen counted three expired rows and default-filtered
    // them away. Relative dates keep the fixture meaningful as time passes.
    const assets = dataset.assetRegister as Array<{ id: string; acquisitionDateAD: string }>;
    assert.ok(new Set(assets.map((a) => a.acquisitionDateAD)).size > 1, 'assets must not share one acquisition date');
    for (const asset of assets) {
      assert.ok(asset.acquisitionDateAD >= '2025-01-01', `${asset.id} was still seeded with a 2024 date`);
    }

    for (const coverage of coverages) {
      const remaining = warrantyDaysRemaining(coverage.endDateAD);
      assert.ok(remaining !== null, `${coverage.id}: unreadable expiry`);
      // 500 days of history and 2 years of future is enough headroom for every
      // state while proving the dates move with the run date.
      assert.ok(coverage.startDateAD >= shift(-500), `${coverage.id}: start is further back than the seed window`);
      assert.ok(coverage.endDateAD <= shift(800), `${coverage.id}: expiry is further ahead than the seed window`);
    }
  });

  test('fixed-asset supplier coverages start on the asset acquisition date', () => {
    const assets = new Map((dataset.assetRegister as Array<{ id: string; acquisitionDateAD: string }>).map((a) => [a.id, a]));
    const assetCoverages = coverages.filter((c) => c.coverageType === 'VENDOR' && c.assetId);
    assert.ok(assetCoverages.length > 0, 'the fixture must capture supplier coverages for fixed assets');
    for (const coverage of assetCoverages) {
      const asset = assets.get(coverage.assetId!);
      assert.ok(asset, `${coverage.id}: unknown asset ${coverage.assetId}`);
      assert.equal(
        coverage.startDateAD,
        asset!.acquisitionDateAD,
        `${coverage.id}: supplier coverage must start with the asset`
      );
    }
  });

  test('the product defaults demonstrate a 0-month and a 24-month term', () => {
    const products = dataset.products as Array<{ id: string; vendorWarrantyMonths?: number; sellerWarrantyMonths?: number }>;
    assert.ok(products.some((p) => p.vendorWarrantyMonths === 0), 'a no-warranty product default is missing');
    assert.ok(products.some((p) => p.vendorWarrantyMonths === 24), 'a 24-month product default is missing');
    assert.ok(products.some((p) => p.sellerWarrantyMonths === 0), 'a 0-month seller default is missing');
    assert.ok(products.some((p) => p.sellerWarrantyMonths === 24), 'a 24-month seller default is missing');
  });

  test('the demo seeder persists the fixture and counts the table', () => {
    const seeder = fs.readFileSync(path.resolve('scripts/setup_db.js'), 'utf8');
    assert.match(seeder, /INSERT INTO warranty_coverages/, 'setup_db.js must seed the coverage fixture');
    assert.match(seeder, /warranty_coverages WHERE is_demo/, 'the demo summary must count coverage rows');
    assert.match(
      seeder,
      /vendor_warranty_months, seller_warranty_months/,
      'the product insert must carry the warranty defaults'
    );
    assert.match(seeder, /p\.vendorWarrantyMonths \?\? 12/, 'products without a term must fall back to 12 months');
  });
});

/** AD date `offset` days from today — the same window the fixture builds with. */
function shift(offset: number): string {
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Legacy backfill — real PostgreSQL, real statements, rolled back
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

/**
 * The three legacy INSERTs exactly as shipped. Splitting the schema text keeps
 * the test tied to the real statements rather than a retyped copy that could
 * drift; the assertion below fails loudly if the section is ever reshaped.
 */
function legacyBackfillStatements(): string[] {
  const schema = fs.readFileSync(path.resolve('scripts/schema.sql'), 'utf8');
  const marker = schema.indexOf('WTY-1 legacy warranty backfill');
  assert.ok(marker > 0, 'scripts/schema.sql lost the WTY-1 backfill section marker');
  const section = schema.slice(marker);
  const statements = [...section.matchAll(/INSERT INTO warranty_coverages[\s\S]*?ON CONFLICT DO NOTHING;/g)].map(
    (match) => match[0]
  );
  assert.equal(statements.length, 3, `expected the 3 legacy INSERTs, found ${statements.length}`);
  return statements;
}

const TEST_TAG_LEGACY = 'WTY7-LEGACY-ASSET';
const TEST_TAG_CAPTURED = 'WTY7-CAPTURED-ASSET';
const ACQUISITION = '2024-01-10';

describe('legacy warranty backfill against PostgreSQL', () => {
  test('twice-applied schema backfill is idempotent, marked LEGACY_12_MONTH and preserves capture', { skip: skipNoDb }, async () => {
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      // Branch master: the app seeds WH001; ensure it exists without relying on
      // whatever else a shared test database happens to hold.
      await client.query(
        `INSERT INTO branches (id, code, name, location, is_headquarters, active, is_demo)
         VALUES ('WH001', 'WH001', 'Branch 1 (Head Office)', 'Example Location 1', TRUE, TRUE, TRUE)
         ON CONFLICT (id) DO NOTHING`
      );

      await client.query(
        `INSERT INTO fixed_assets (
           id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs,
           acquisition_cost, net_book_value, supplier_name, invoice_no, is_demo
         ) VALUES
           ('wty7-asset-legacy', $1, 'Backfill probe asset', 'IT Equipment', 'WH001', $2, '2080-09-26 BS', 1000, 1000, 'Example Supplier', 'WTY7-INV-LEGACY', TRUE),
           ('wty7-asset-captured', $3, 'Captured probe asset', 'IT Equipment', 'WH001', $2, '2080-09-26 BS', 2000, 2000, 'Example Supplier', 'WTY7-INV-CAPTURED', TRUE)`,
        [TEST_TAG_LEGACY, ACQUISITION, TEST_TAG_CAPTURED]
      );

      // The operator already captured this unit — the backfill must not touch it.
      await client.query(
        `INSERT INTO warranty_coverages (
           id, coverage_type, item_category, product_name, serial_number, asset_id, branch_id,
           source_type, start_date_ad, end_date_ad, term_months, start_basis, is_current, is_demo
         ) VALUES ('wty7-captured-coverage', 'VENDOR', 'FIXED_ASSET', 'Captured probe asset', $1,
           'wty7-asset-captured', 'WH001', 'MANUAL', $2, $3, 36, 'MANUAL', TRUE, TRUE)`,
        [TEST_TAG_CAPTURED, ACQUISITION, addCalendarMonths(ACQUISITION, 36)]
      );

      const statements = legacyBackfillStatements();
      for (const statement of statements) await client.query(statement);

      const afterFirst = await coverageRows(client);
      const firstLegacy = afterFirst.find((row) => row.serial_number === TEST_TAG_LEGACY);
      assert.ok(firstLegacy, 'the backfill must create a coverage row for an uncovered asset');
      assert.equal(firstLegacy!.start_basis, 'LEGACY_12_MONTH');
      assert.equal(firstLegacy!.term_months, 12);
      assert.equal(firstLegacy!.coverage_type, 'VENDOR');
      assert.equal(firstLegacy!.is_current, true);
      assert.equal(
        firstLegacy!.end_date_ad,
        addCalendarMonths(ACQUISITION, 12),
        'legacy expiry is the old 12-month rule from the acquisition date'
      );

      const captured = afterFirst.filter((row) => row.serial_number === TEST_TAG_CAPTURED);
      assert.equal(captured.length, 1, 'an already-captured unit must not gain a second current row');
      assert.equal(captured[0].id, 'wty7-captured-coverage');
      assert.equal(captured[0].start_basis, 'MANUAL', 'the operator-corrected row must be preserved');

      const firstCount = afterFirst.filter((row) => row.serial_number === TEST_TAG_LEGACY || row.serial_number === TEST_TAG_CAPTURED).length;

      // Second apply: every statement must be a no-op for these units.
      for (const statement of statements) await client.query(statement);
      const afterSecond = await coverageRows(client);
      const secondCount = afterSecond.filter((row) => row.serial_number === TEST_TAG_LEGACY || row.serial_number === TEST_TAG_CAPTURED).length;
      assert.equal(secondCount, firstCount, 'a second schema apply must not insert more coverage rows');
      assert.equal(
        afterSecond.filter((row) => row.serial_number === TEST_TAG_LEGACY).length,
        1,
        'exactly one legacy row per unit'
      );
      assert.equal(
        afterSecond.filter((row) => row.serial_number === TEST_TAG_CAPTURED && row.is_current).length,
        1,
        'exactly one current row for the captured unit'
      );
    } finally {
      // Rolled back on purpose: the test proves the shipped SQL, it does not
      // commit probe rows to the shared database.
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

async function coverageRows(client: pg.PoolClient): Promise<Array<{
  id: string;
  coverage_type: string;
  serial_number: string;
  start_basis: string;
  term_months: number | null;
  end_date_ad: string;
  is_current: boolean;
}>> {
  const result = await client.query(
    `SELECT id, coverage_type, serial_number, start_basis, term_months,
            end_date_ad::text AS end_date_ad, is_current
       FROM warranty_coverages
      WHERE serial_number = ANY($1)`,
    [[TEST_TAG_LEGACY, TEST_TAG_CAPTURED]]
  );
  return result.rows;
}
