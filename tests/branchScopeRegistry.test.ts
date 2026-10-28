/**
 * Branch-scope registry guard (regression test).
 *
 * The by-id branch rules used to be an inline table list inside
 * `enforceBranchAccess`. A table added to the schema later could be forgotten
 * there and its records stayed reachable across branches — the AUTHZ-1 class of
 * bug. The list is now declarative (`server/src/middleware/branchScope.ts`),
 * and this test parses `scripts/schema.sql`: every table that declares a branch
 * column must be either guarded in `BRANCH_SCOPED_RESOURCES` or explicitly
 * exempted in `BRANCH_SCOPE_EXEMPTIONS` with a written reason. A new
 * branch-scoped table therefore fails CI until someone makes that decision.
 *
 * Read-only, no database: schema.sql is the source of truth the fresh-install
 * path builds from (and `schema.drift.guard.test.ts` keeps it in step with a
 * live database).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  BRANCH_SCOPE_COLUMNS,
  BRANCH_SCOPE_EXEMPTIONS,
  BRANCH_SCOPED_READ_PATHS,
  BRANCH_SCOPED_RESOURCES,
} from '../server/src/middleware/branchScope';

const SCHEMA_SQL_PATH = path.resolve('scripts/schema.sql');
const MIDDLEWARE_PATH = path.resolve('server/src/middleware/index.ts');

interface TableColumns {
  [table: string]: Set<string>;
}

/** Parse every CREATE TABLE IF NOT EXISTS block out of schema.sql. */
function parseSchemaSql(sqlText: string): TableColumns {
  const tables: TableColumns = {};
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sqlText)) !== null) {
    const name = m[1];
    const cols = new Set<string>();
    for (const line of m[2].split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--')) continue;
      if (/^(PRIMARY KEY|UNIQUE|CONSTRAINT|CHECK|FOREIGN KEY)/i.test(trimmed)) continue;
      const cm = trimmed.match(/^(\w+)\s+(.+?),?$/);
      if (cm && !['PRIMARY', 'UNIQUE', 'CONSTRAINT', 'FOREIGN', 'CHECK'].includes(cm[1].toUpperCase())) {
        cols.add(cm[1].toLowerCase());
      }
    }
    tables[name] = cols;
  }
  return tables;
}

const schemaTables = parseSchemaSql(fs.readFileSync(SCHEMA_SQL_PATH, 'utf8'));
const guardedTables = new Set(BRANCH_SCOPED_RESOURCES.map((resource) => resource.table));
const exemptTables = new Set(BRANCH_SCOPE_EXEMPTIONS.map((exemption) => exemption.table));

describe('branch-scope registry', () => {
  test('schema.sql parses (sanity: the source this guard reads)', () => {
    assert.ok(Object.keys(schemaTables).length >= 30, 'expected the full schema.sql table set to parse');
    for (const column of BRANCH_SCOPE_COLUMNS) {
      assert.ok(
        Object.values(schemaTables).some((cols) => cols.has(column)),
        `BRANCH_SCOPE_COLUMNS names "${column}", which no table declares — update the list`
      );
    }
  });

  test('every table with a branch column is guarded by id or explicitly exempted', () => {
    const unaccounted: string[] = [];
    for (const [table, cols] of Object.entries(schemaTables)) {
      const branchCols = BRANCH_SCOPE_COLUMNS.filter((column) => cols.has(column));
      if (branchCols.length === 0) continue;
      if (guardedTables.has(table) || exemptTables.has(table)) continue;
      unaccounted.push(`${table} (${branchCols.join(', ')})`);
    }
    assert.deepEqual(
      unaccounted,
      [],
      'Every table that carries a branch column must be listed in BRANCH_SCOPED_RESOURCES ' +
        "(records refused by id across branches) or in BRANCH_SCOPE_EXEMPTIONS with the reason its " +
        'branch protection lives elsewhere. Unaccounted: ' +
        unaccounted.join('; ')
    );
  });

  test('guarded resources name real tables and declare real branch columns', () => {
    for (const resource of BRANCH_SCOPED_RESOURCES) {
      assert.ok(resource.prefix.startsWith('/') && !resource.prefix.endsWith('/'), `bad prefix "${resource.prefix}"`);
      const cols = schemaTables[resource.table];
      assert.ok(cols, `BRANCH_SCOPED_RESOURCES names table "${resource.table}", which schema.sql does not declare`);
      assert.ok(resource.columns.length > 0, `"${resource.table}" declares no branch columns`);
      for (const column of resource.columns) {
        assert.ok(cols.has(column), `"${resource.table}.${column}" is declared as a branch column but absent from schema.sql`);
      }
      assert.ok(
        resource.columns.some((column) => (BRANCH_SCOPE_COLUMNS as readonly string[]).includes(column)),
        `"${resource.table}" is guarded, but none of its declared columns is a branch column`
      );
    }
  });

  test('exemptions are real tables with a written reason and are not also guarded', () => {
    for (const exemption of BRANCH_SCOPE_EXEMPTIONS) {
      assert.ok(schemaTables[exemption.table], `BRANCH_SCOPE_EXEMPTIONS names unknown table "${exemption.table}"`);
      assert.ok(
        !guardedTables.has(exemption.table),
        `"${exemption.table}" is both guarded and exempted — remove one entry`
      );
      assert.ok(
        exemption.reason.trim().length >= 40,
        `"${exemption.table}" needs a substantive reason: say where its branch protection comes from`
      );
    }
  });

  test('prefixes and tables are declared once', () => {
    const prefixes = BRANCH_SCOPED_RESOURCES.map((resource) => resource.prefix);
    assert.equal(new Set(prefixes).size, prefixes.length, 'duplicate resource prefix in BRANCH_SCOPED_RESOURCES');
    const tables = BRANCH_SCOPED_RESOURCES.map((resource) => resource.table);
    assert.equal(new Set(tables).size, tables.length, 'duplicate table in BRANCH_SCOPED_RESOURCES');
    for (const readPath of BRANCH_SCOPED_READ_PATHS) {
      assert.ok(readPath.startsWith('/') && !readPath.endsWith('/'), `bad branch-scoped read path "${readPath}"`);
    }
    assert.equal(
      new Set(BRANCH_SCOPED_READ_PATHS).size,
      BRANCH_SCOPED_READ_PATHS.length,
      'duplicate path in BRANCH_SCOPED_READ_PATHS'
    );
  });

  test('the middleware consumes the registry instead of re-declaring the table list', () => {
    const source = fs.readFileSync(MIDDLEWARE_PATH, 'utf8');
    assert.ok(
      source.includes('findBranchScopedResource'),
      'enforceBranchAccess must resolve records through the registry (findBranchScopedResource)'
    );
    assert.ok(
      !/resourceTables/.test(source),
      'the inline resourceTables list is back — move the entry into server/src/middleware/branchScope.ts'
    );
  });
});
