/**
 * WTY-1 — schema and payload-boundary guards.
 *
 * The coverage table is the first new table since the bootstrap work closed,
 * so it must not quietly become a payload slice. It is also created for new and
 * existing databases alike: a fresh CREATE TABLE alone would leave an upgraded
 * database without the product defaults. These file-parsing assertions run
 * without PostgreSQL and fail on the edit that forgets either half.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(relative), 'utf8');

describe('warranty_coverages schema source', () => {
  const schema = read('scripts/schema.sql');
  const normalized = schema.replace(/\s+/g, ' ');

  test('declares the table, its dates, the state columns and the one-current-per-unit rule', () => {
    assert.match(schema, /CREATE TABLE IF NOT EXISTS warranty_coverages/);
    assert.match(schema, /coverage_type VARCHAR\(10\) NOT NULL CHECK \(coverage_type IN \('VENDOR', 'SELLER'\)\)/);
    assert.match(schema, /start_date_ad DATE NOT NULL/);
    assert.match(schema, /end_date_ad DATE NOT NULL/);
    assert.match(schema, /CHECK \(end_date_ad >= start_date_ad\)/);
    assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS uq_warranty_current_unit/);
    assert.match(normalized, /ON warranty_coverages \(coverage_type, serial_number\) WHERE is_current = TRUE/);
  });

  test('product defaults exist for a fresh table and for an upgraded one', () => {
    assert.match(schema, /vendor_warranty_months INT NOT NULL DEFAULT 12/);
    assert.match(schema, /seller_warranty_months INT NOT NULL DEFAULT 12/);
    assert.match(schema, /ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor_warranty_months/);
    assert.match(schema, /ALTER TABLE products ADD COLUMN IF NOT EXISTS seller_warranty_months/);
  });

  test('the legacy backfill is flagged, guarded and idempotent per side', () => {
    const backfills = schema.match(/'LEGACY_12_MONTH'/g) || [];
    assert.ok(backfills.length >= 3, 'expected legacy VENDOR rows (asset + purchased serial) and SELLER rows');
    assert.match(normalized, /WHERE w\.coverage_type = 'VENDOR' AND w\.serial_number = UPPER\(TRIM\(a\.tag_number\)\) AND w\.is_current = TRUE/);
    assert.match(normalized, /WHERE w\.coverage_type = 'SELLER' AND w\.serial_number = UPPER\(TRIM\(c\.device_serial\)\) AND w\.is_current = TRUE/);
    const conflictGuards = schema.match(/ON CONFLICT DO NOTHING/g) || [];
    assert.ok(conflictGuards.length >= 3, 'every legacy backfill must be safe to re-run');
  });
});

describe('the coverage mirror stays out of the login payload', () => {
  test('no bootstrap mapping, cache load or bootstrap slice names the coverage table', () => {
    for (const file of [
      'server/src/models/columnMappings.ts',
      'server/src/controllers/bootstrap.controller.ts',
      'client/src/services/bootstrapSlices.ts',
    ]) {
      const source = read(file);
      assert.ok(
        !source.includes('warranty_coverages') && !source.includes('warrantyCoverages'),
        `${file} must not map or load warranty coverages — both registers self-fetch`
      );
    }
  });

  test('the demo mirror exists for PG-down mode', () => {
    const state = read('server/src/state/runtimeState.ts');
    assert.match(state, /export let warrantyCoverages/);
    assert.match(state, /export function setWarrantyCoverages/);
  });
});
