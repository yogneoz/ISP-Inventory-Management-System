/**
 * The current fiscal year is derived, not hard-coded.
 *
 * `INITIAL_MASTER_FISCAL_YEARS` flags 2082-83 as current, which stopped being
 * true on 2026-07-17. Boot now seeds the flag from the business date and runs a
 * reconcile on every boot, so a database created (or seeded) before a rollover
 * does not keep pointing "current" at a year that has already ended.
 *
 * These tests own throwaway databases and never touch the application database.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import { reconcileCurrentFiscalYear } from '../server/src/boot/fiscalYearCurrent';
import { resolveCurrentFiscalYearId } from '../server/src/utils/fiscalYear';
import { INITIAL_MASTER_FISCAL_YEARS } from '../server/src/config/seedData';
import { ensureFiscalYearMaster } from './fixtures/referenceData';
import { businessDateAD } from '../shared/businessDate';

dotenv.config();

const ROOT = path.resolve('.');
const SCHEMA_SQL = fs.readFileSync(path.join(ROOT, 'scripts', 'schema.sql'), 'utf8');
const BASE_URL = process.env.DATABASE_URL;
const TEST_DB = 'inventory_fiscal_year_current_test';

const FY = (id: string, start: string, end: string, isCurrent: boolean, isClosed = false) => ({
  id,
  startDateAD: start,
  endDateAD: end,
  isCurrent,
  isClosed,
});

// The years the seed ships: 2082-83 ended 2026-07-16, 2083-84 runs to 2027-07-16.
const SEEDED = [
  FY('fy-1', '2023-07-17', '2024-07-15', false, true),
  FY('fy-2', '2024-07-16', '2025-07-16', false, true),
  FY('fy-3', '2025-07-17', '2026-07-16', true),
  FY('fy-4', '2026-07-17', '2027-07-16', false),
];

function withDbName(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

let admin: pg.Client | null = null;
let reachable = false;
if (BASE_URL) {
  const probe = new pg.Client({ connectionString: BASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
    reachable = true;
  } catch {
    reachable = false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}
const skipNoDb = !reachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

async function recreateDatabase(name: string): Promise<pg.Client> {
  assert.ok(admin);
  assert.ok(BASE_URL);
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name]
  );
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const client = new pg.Client({ connectionString: withDbName(BASE_URL, name) });
  await client.connect();
  return client;
}

async function insertYears(client: pg.Client, rows: ReturnType<typeof FY>[]): Promise<void> {
  await client.query('DELETE FROM fiscal_years');
  for (const row of rows) {
    await client.query(
      `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed)
       VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8)`,
      [row.id, row.id, row.startDateAD, row.endDateAD, row.startDateAD, row.endDateAD, row.isCurrent, row.isClosed]
    );
  }
}

describe('current fiscal year is derived from the business date', () => {
  test('the shipped constant no longer decides it: the flag moves to the year containing today', () => {
    // 2026-11-23 is inside 2083-84 (2026-07-17 .. 2027-07-16), not 2082-83.
    assert.equal(resolveCurrentFiscalYearId(SEEDED, '2026-11-23'), 'fy-4');
    // Before the rollover the constant was right, and nothing moves.
    assert.equal(resolveCurrentFiscalYearId(SEEDED, '2026-07-16'), null);
    assert.equal(resolveCurrentFiscalYearId(SEEDED, '2026-07-17'), 'fy-4');
  });

  test('resolves an absent flag, and refuses ambiguous or impossible data', () => {
    const noCurrent = SEEDED.map((year) => ({ ...year, isCurrent: false }));
    assert.equal(resolveCurrentFiscalYearId(noCurrent, '2026-11-23'), 'fy-4');

    const overlapping = [
      FY('a', '2026-07-17', '2027-07-16', false),
      FY('b', '2026-01-01', '2026-12-31', false),
    ];
    assert.equal(
      resolveCurrentFiscalYearId(overlapping, '2026-11-23'),
      null,
      'two open years contain today: do not guess'
    );

    const outsideAnyYear = [
      FY('a', '2023-07-17', '2024-07-15', true),
      FY('b', '2025-07-17', '2026-07-16', false),
    ];
    assert.equal(resolveCurrentFiscalYearId(outsideAnyYear, '2026-11-23'), null);
  });

  test('a current year that has not started yet is a deliberate choice and is left alone', () => {
    const forward = [
      FY('fy-3', '2025-07-17', '2026-07-16', false),
      FY('fy-4', '2026-07-17', '2027-07-16', true),
    ];
    assert.equal(
      resolveCurrentFiscalYearId(forward, '2026-06-01'),
      null,
      'an operator may open the next year early'
    );
  });

  test('boot never copies isCurrent from the constant again', () => {
    const boot = fs.readFileSync(path.join(ROOT, 'server/src/boot/dbBoot.ts'), 'utf8');
    assert.match(boot, /reconcileCurrentFiscalYear/, 'boot repairs a stale flag');
    assert.doesNotMatch(
      boot,
      /fy\.isCurrent \|\| false/,
      'the seeded flag must be derived from the business date'
    );
    // And the constant itself is what the decision is tested against above.
    assert.ok(INITIAL_MASTER_FISCAL_YEARS.some((fy) => fy.isCurrent), 'fixture documents the stale constant');
  });
});

describe('reconcileCurrentFiscalYear (real database)', { skip: skipNoDb }, () => {
  before(async () => {
    assert.ok(BASE_URL);
    admin = new pg.Client({ connectionString: withDbName(BASE_URL, 'postgres') });
    await admin.connect();
  });

  after(async () => {
    if (admin) {
      await admin
        .query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [TEST_DB]
        )
        .catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });

  test('moves a stale flag to the open year containing today, once', async () => {
    const client = await recreateDatabase(TEST_DB);
    try {
      await client.query(SCHEMA_SQL);
      await insertYears(client, SEEDED);

      const first = await reconcileCurrentFiscalYear(client as any, '2026-11-23');
      assert.equal(first.changed, true);
      assert.equal(first.id, 'fy-4');

      const rows = await client.query(
        'SELECT id FROM fiscal_years WHERE is_current ORDER BY id'
      );
      assert.deepEqual(rows.rows.map((row: any) => row.id), ['fy-4']);

      const second = await reconcileCurrentFiscalYear(client as any, '2026-11-23');
      assert.equal(second.changed, false, 'a second boot must not write again');
    } finally {
      await client.end();
    }
  });

  test('the shared test fixture seeds the year containing today as current', async () => {
    // tests/fixtures/referenceData.ts is the other store fed by
    // INITIAL_MASTER_FISCAL_YEARS: every suite that runs against a schema-only
    // database provisions its master rows there. It used to copy the
    // constant's stale isCurrent, so those suites ran against 2082-83 as
    // current even after the year had ended.
    const client = await recreateDatabase(TEST_DB);
    try {
      await client.query(SCHEMA_SQL);
      await ensureFiscalYearMaster(client);

      const today = businessDateAD();
      const expected = INITIAL_MASTER_FISCAL_YEARS.filter(
        (fy) => fy.startDateAD && fy.endDateAD && !fy.isClosed && today >= fy.startDateAD && today <= fy.endDateAD
      ).map((fy) => fy.id);
      const rows = await client.query('SELECT id FROM fiscal_years WHERE is_current ORDER BY id');
      assert.deepEqual(
        rows.rows.map((row: any) => row.id),
        expected,
        `the fixture must flag the year containing ${today}, like a real install`
      );

      const stale = await client.query("SELECT is_current FROM fiscal_years WHERE id = 'fy-3'");
      assert.equal(stale.rows[0].is_current, today >= '2025-07-17' && today <= '2026-07-16');
    } finally {
      await client.end();
    }
  });

  test('leaves a forward-opened current year untouched', async () => {
    const client = await recreateDatabase(TEST_DB);
    try {
      await client.query(SCHEMA_SQL);
      await insertYears(client, [
        FY('fy-3', '2025-07-17', '2026-07-16', false),
        FY('fy-4', '2026-07-17', '2027-07-16', true),
      ]);

      const result = await reconcileCurrentFiscalYear(client as any, '2026-06-01');
      assert.equal(result.changed, false);

      const rows = await client.query('SELECT id FROM fiscal_years WHERE is_current');
      assert.deepEqual(rows.rows.map((row: any) => row.id), ['fy-4']);
    } finally {
      await client.end();
    }
  });
});
