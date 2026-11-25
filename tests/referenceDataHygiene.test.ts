/**
 * The demo branch/fiscal-year master the fixtures seed belongs to the RUN, not
 * to the database.
 *
 * `tests/fixtures/referenceData.ts` writes WH001/BRH01 and the 2080-81/2081-82
 * fiscal years so a suite can run against a schema-only database (the CI
 * model). Against a developer database that already owns its master, nothing
 * removed them: after a full `npm test` the seeded install carried two extra
 * branches, two extra fiscal years and the journals, daily sequence counters
 * and GL period balances suites had posted against them.
 *
 * PROVES:
 *   1. `removeDemoMasterRows()` removes the demo rows it is GIVEN, together
 *      with the rows that point at them — a branch's locations and daily
 *      document counter, a fiscal year's GL period.
 *   2. It leaves the demo rows it was NOT given (and their dependents) in
 *      place — that is what keeps a CI shard, or an install whose master
 *      predates the run, untouched by the runner's clean-up.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createThrowawayDatabase,
  dropThrowawayDatabase,
  type ThrowawayDatabase,
} from './fixtures/throwawayDatabase';
import {
  ensureDemoBranches,
  ensureFiscalYearMaster,
  removeDemoMasterRows,
} from './fixtures/referenceData';

const TEST_DB = 'inventory_hygiene_test';

describe('demo-master clean-up', () => {
  let throwaway: ThrowawayDatabase | null = null;

  before(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) return;
    throwaway = await createThrowawayDatabase(base, TEST_DB);
    await ensureDemoBranches(throwaway.pool);
    await ensureFiscalYearMaster(throwaway.pool);
    await throwaway.pool.query(
      `INSERT INTO locations (id, name, type, branch_id)
       VALUES ('hyg-loc-wh', 'Hygiene WH', 'STORE', 'WH001'),
              ('hyg-loc-br', 'Hygiene BR', 'STORE', 'BRH01')`
    );
    await throwaway.pool.query(
      `INSERT INTO document_sequence_daily (branch_id, doc_type, date_ad)
       VALUES ('WH001', 'SALES', '2026-11-25')`
    );
    await throwaway.pool.query(
      `INSERT INTO gl_periods (id, fiscal_year_id, period_key, start_date_ad, start_date_bs, end_date_ad, end_date_bs)
       VALUES ('glp-hyg', 'fy-1', '2080-01', '2023-07-17', '2080-04-01', '2023-08-16', '2080-04-32')`
    );
  });

  after(async () => {
    if (!throwaway) return;
    await dropThrowawayDatabase(throwaway.adminPool, TEST_DB);
  });

  const count = async (sql: string) => (await throwaway!.pool.query(sql)).rows.length;

  test('removes the demo rows it is given, with the rows that point at them', async () => {
    assert.ok(throwaway, 'the clean-up proof needs a database');
    const result = await removeDemoMasterRows(throwaway!.pool, ['WH001'], ['fy-1']);
    assert.equal(result.remaining.branches, 0, 'no demo branch row is left behind');
    assert.equal(result.remaining.fiscalYears, 0, 'no demo fiscal-year row is left behind');

    assert.equal(await count(`SELECT 1 FROM branches WHERE id = 'WH001'`), 0);
    assert.equal(await count(`SELECT 1 FROM locations WHERE id = 'hyg-loc-wh'`), 0);
    assert.equal(await count(`SELECT 1 FROM document_sequence_daily WHERE branch_id = 'WH001'`), 0);
    assert.equal(await count(`SELECT 1 FROM fiscal_years WHERE id = 'fy-1'`), 0);
    assert.equal(await count(`SELECT 1 FROM gl_periods WHERE id = 'glp-hyg'`), 0);
  });

  test('leaves the demo rows it was not given, and their dependents, alone', async () => {
    assert.ok(throwaway, 'the clean-up proof needs a database');
    const result = await removeDemoMasterRows(throwaway!.pool, [], ['fy-2']);
    assert.equal(result.remaining.fiscalYears, 0);

    assert.equal(await count(`SELECT 1 FROM branches WHERE id = 'BRH01'`), 1);
    assert.equal(await count(`SELECT 1 FROM locations WHERE id = 'hyg-loc-br'`), 1);
    assert.equal(await count(`SELECT 1 FROM fiscal_years WHERE id = 'fy-2'`), 0);
    assert.equal(await count(`SELECT 1 FROM fiscal_years WHERE id = 'fy-3'`), 1);
  });
});
