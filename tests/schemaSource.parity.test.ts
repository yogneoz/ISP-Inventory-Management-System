/**
 * Static schema-source parity guard (duplication audit, phase 2).
 *
 * dbBoot.ts executes scripts/schema.sql as its single schema source of truth.
 * This guard proves the two never drift apart again:
 *
 *   1. dbBoot no longer contains an inline CREATE TABLE / CREATE INDEX /
 *      CREATE TRIGGER / ALTER TABLE block (the old 1,000-line template
 *      literal) — it must load the file instead.
 *   2. The dbBoot-only runtime statements (legacy index aliases, serial-log
 *      ALTERs, currency backfill, fiscal_year default drop, vendor_payments
 *      fiscal-year backfill) that were ported into schema.sql's
 *      "RUNTIME PARITY SECTION" are still present there.
 *
 * Pure file-parsing: no database required, runs in CI and locally.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const DB_BOOT_PATH = path.join(ROOT, 'server/src/boot/dbBoot.ts');
const SCHEMA_SQL_PATH = path.join(ROOT, 'scripts/schema.sql');

describe('dbBoot.ts ↔ scripts/schema.sql single-source-of-truth guard', () => {
  const dbBoot = fs.readFileSync(DB_BOOT_PATH, 'utf8');
  const schemaSql = fs.readFileSync(SCHEMA_SQL_PATH, 'utf8');

  test('dbBoot.ts loads scripts/schema.sql instead of declaring DDL inline', () => {
    assert.ok(
      /loadSchemaSql\(\)/.test(dbBoot),
      'dbBoot.ts must call loadSchemaSql() (the schema.sql loader).'
    );
    assert.ok(
      /schema\.sql/.test(dbBoot),
      'dbBoot.ts must reference scripts/schema.sql.'
    );
    // The old inline schema was a giant template literal with DDL keywords.
    const inlineDdl = dbBoot.match(/CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|CREATE OR REPLACE TRIGGER|CREATE OR REPLACE FUNCTION/g) || [];
    assert.equal(
      inlineDdl.length, 0,
      `dbBoot.ts contains inline DDL again (${inlineDdl.length} statements) — add schema changes to scripts/schema.sql instead of re-inlining a second schema.`
    );
  });

  test('schema.sql carries the ported runtime-parity statements', () => {
    const normalized = schemaSql.replace(/\s+/g, ' ').toUpperCase();

    const required = [
      // Legacy index-name aliases kept for old deployments.
      'CREATE INDEX IF NOT EXISTS IDX_STOCK_PROD_BRANCH ON INVENTORY_STOCK(PRODUCT_ID, BRANCH_ID)',
      'CREATE INDEX IF NOT EXISTS IDX_ASSETS_TAG ON FIXED_ASSETS(TAG_NUMBER)',
      'CREATE INDEX IF NOT EXISTS IDX_ASSETS_BRANCH ON FIXED_ASSETS(BRANCH_ID)',
      'CREATE INDEX IF NOT EXISTS IDX_ASSETS_STATUS ON FIXED_ASSETS(STATUS)',
      'CREATE INDEX IF NOT EXISTS IDX_ORDERS_NUM ON PURCHASE_ORDERS(PO_NUMBER)',
      'CREATE INDEX IF NOT EXISTS IDX_ORDERS_BRANCH ON PURCHASE_ORDERS(BRANCH_ID)',
      'CREATE INDEX IF NOT EXISTS IDX_ORDERS_STATUS ON PURCHASE_ORDERS(STATUS)',
      'CREATE INDEX IF NOT EXISTS IDX_INVOICES_NUM ON PURCHASE_INVOICES(INVOICE_NUMBER)',
      'CREATE INDEX IF NOT EXISTS IDX_INVOICES_STATUS ON PURCHASE_INVOICES(PAYMENT_STATUS)',
      'CREATE INDEX IF NOT EXISTS IDX_SHIPMENTS_TRACK ON SHIPMENTS(TRACKING_CODE)',
      'CREATE INDEX IF NOT EXISTS IDX_SHIPMENTS_SRC_DST ON SHIPMENTS(SOURCE_BRANCH_ID, DESTINATION_BRANCH_ID)',
      'CREATE INDEX IF NOT EXISTS IDX_CUSTOMERS_ID ON CUSTOMER_RECORDS(CUSTOMER_ID)',
      'CREATE INDEX IF NOT EXISTS IDX_CUSTOMERS_BRANCH ON CUSTOMER_RECORDS(BRANCH_ID)',
      'CREATE INDEX IF NOT EXISTS IDX_DEVICE_SERIALS ON CUSTOMER_DEVICE_RECORDS(DEVICE_SERIAL, PON_SERIAL, MAC_ADDRESS)',
      'CREATE INDEX IF NOT EXISTS IDX_DEVICE_BRANCH ON CUSTOMER_DEVICE_RECORDS(BRANCH_ID, STATUS)',
      'CREATE INDEX IF NOT EXISTS IDX_APPROVAL_STATUS ON APPROVAL_REQUESTS(STATUS, BRANCH_ID)',
      'CREATE INDEX IF NOT EXISTS IDX_APPROVAL_TYPE ON APPROVAL_REQUESTS(TYPE)',
      'CREATE INDEX IF NOT EXISTS IDX_BS_DAYS_DATE ON BS_DAY_RECORDS(BS_DATE)',
      'CREATE INDEX IF NOT EXISTS IDX_BS_DAYS_YM ON BS_DAY_RECORDS(BS_YEAR, BS_MONTH)',
      'CREATE INDEX IF NOT EXISTS IDX_SERIAL_LOG_DEVICE_SERIAL ON SERIAL_LOG((LOWER(TRIM(DEVICE_SERIAL))))',
      'CREATE INDEX IF NOT EXISTS IDX_SHIPMENTS_DISPATCH_DATE ON SHIPMENTS(DISPATCH_DATE_AD)',
      'CREATE INDEX IF NOT EXISTS IDX_STOCK_OPS_DATE ON STOCK_OPERATIONS(DATE_AD)',
      // Runtime ALTERs ported from dbBoot.
      'ALTER TABLE CATEGORIES ADD COLUMN IF NOT EXISTS CREATED_AT',
      'ALTER TABLE FISCAL_YEARS ADD COLUMN IF NOT EXISTS IS_DEMO',
      'ALTER TABLE USERS ADD COLUMN IF NOT EXISTS IS_DEMO',
      'ALTER TABLE BRANCHES ADD COLUMN IF NOT EXISTS IS_DEMO',
      'ALTER TABLE BRANCHES ADD COLUMN IF NOT EXISTS ALLOW_WAREHOUSE_TRANSFER',
      'ALTER TABLE LOCATIONS ADD COLUMN IF NOT EXISTS IS_DEMO',
      'ALTER TABLE SERIAL_LOG ADD COLUMN IF NOT EXISTS FISCAL_YEAR_ID',
      'ALTER TABLE SERIAL_LOG ADD COLUMN IF NOT EXISTS IS_DEMO',
      'ALTER TABLE SERIAL_LOG ADD COLUMN IF NOT EXISTS CREATED_BY',
      'ALTER TABLE SERIAL_LOG ADD COLUMN IF NOT EXISTS UPDATED_BY',
      'ALTER TABLE SERIAL_LOG ADD COLUMN IF NOT EXISTS UPDATED_AT',
      // Backfills / one-time fixes.
      'WHERE CURRENCY_CODE IS NULL OR CURRENCY_CODE',
      'ALTER TABLE STOCK_OPERATIONS ALTER COLUMN FISCAL_YEAR DROP DEFAULT',
      'UPDATE VENDOR_PAYMENTS SET FISCAL_YEAR_ID',
    ];
    for (const fragment of required) {
      assert.ok(
        normalized.includes(fragment),
        `scripts/schema.sql is missing the ported runtime statement: "${fragment}" — it ran in dbBoot before the consolidation and must stay in the schema source of truth.`
      );
    }
  });

  test('schema.sql still declares all 36 tables (fresh-install completeness)', () => {
    const tables = new Set(
      (schemaSql.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) || []).map((s) => s.replace('CREATE TABLE IF NOT EXISTS ', ''))
    );
    assert.equal(tables.size, 36, `schema.sql should declare exactly 36 tables, found ${tables.size}`);
  });
});
