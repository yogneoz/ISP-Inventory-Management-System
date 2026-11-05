/**
 * Legacy warranty backfill proof.
 *
 * The demo-fixture half of this file went away with `scripts/demo_dataset.js`
 * (replaced by scripts/seed/verificationDataset.ts, which seeds no warranty
 * rows). What remains is the part that never depended on the fixture: the
 * legacy 12-month INSERTs in scripts/schema.sql are extracted and run TWICE
 * inside one rolled-back transaction on the real database. That proves the
 * statements are idempotent, mark their rows LEGACY_12_MONTH, and leave a unit
 * already captured by an operator alone (the NOT EXISTS guard) — without
 * applying the whole schema to a shared test database.
 *
 * The clear-order guarantee (warranty_coverages cleared before the tables it
 * references) is asserted in tests/admin.repo.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

import { addCalendarMonths } from '../shared/warrantyTerm';

dotenv.config();

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
