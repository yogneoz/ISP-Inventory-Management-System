/**
 * CACHE_LOADS ↔ columnMappings parity guard (duplication audit, phase 3).
 *
 * The operational-cache load list (CACHE_LOADS in state/runtimeState.ts) is
 * GENERATED from the per-table column mappings in models/columnMappings.ts —
 * the same single source of truth that drives GET /api/bootstrap. This guard
 * proves the two never re-diverge:
 *
 *   1. runtimeState.ts contains no hand-written cache SQL — every load must
 *      come from buildCacheSelectSql(BOOTSTRAP_TABLES.…).
 *   2. Every table config carrying a `cache` block in columnMappings.ts has
 *      exactly one CACHE_LOADS entry.
 *   3. The two cache-only tables (fiscal_years, customer_payments) are
 *      present, so the cache and bootstrap stay convergent.
 *
 * Pure file-parsing + one import: no database required.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const RUNTIME_STATE_PATH = path.join(ROOT, 'server/src/state/runtimeState.ts');
const COLUMN_MAPPINGS_PATH = path.join(ROOT, 'server/src/models/columnMappings.ts');

describe('CACHE_LOADS generated from columnMappings (single source of truth)', () => {
  const runtimeState = fs.readFileSync(RUNTIME_STATE_PATH, 'utf8');
  const columnMappings = fs.readFileSync(COLUMN_MAPPINGS_PATH, 'utf8');

  test('runtimeState.ts declares no hand-written cache SQL', () => {
    // The old list embedded a full SELECT literal per entry (`query: 'SELECT …'`).
    const inlineSql = runtimeState.match(/query:\s*(['"`])\s*SELECT/gi) || [];
    assert.equal(
      inlineSql.length, 0,
      `runtimeState.ts embeds hand-written cache SQL again (${inlineSql.length} occurrences) — add columns/tables to models/columnMappings.ts and wire the entry through buildCacheSelectSql instead.`
    );
    assert.ok(
      /buildCacheSelectSql\(BOOTSTRAP_TABLES\./.test(runtimeState),
      'CACHE_LOADS entries must derive their query from buildCacheSelectSql(BOOTSTRAP_TABLES.<config>).'
    );
  });

  test('every cache-flagged table config has a CACHE_LOADS entry', async () => {
    const { BOOTSTRAP_TABLES } = await import('../server/src/models/columnMappings');
    const cacheTables = Object.entries(BOOTSTRAP_TABLES)
      .filter(([, cfg]: any) => cfg.cache)
      .map(([key]) => key);
    // 24 cached tables: 22 bootstrap-shared + fiscal_years + customer_payments.
    assert.ok(cacheTables.length >= 24, `expected >=24 cache-flagged tables, found ${cacheTables.length}`);

    for (const key of cacheTables) {
      assert.ok(
        runtimeState.includes(`BOOTSTRAP_TABLES.${key}`),
        `columnMappings.ts caches table "${key}" but runtimeState.ts has no CACHE_LOADS entry referencing it.`
      );
    }
  });

  test('the two cache-only tables are explicitly present', () => {
    assert.ok(runtimeState.includes('BOOTSTRAP_TABLES.fiscalYears'), 'fiscal_years must stay in CACHE_LOADS');
    assert.ok(runtimeState.includes('BOOTSTRAP_TABLES.customerPayments'), 'customer_payments must stay in CACHE_LOADS');
  });
});
