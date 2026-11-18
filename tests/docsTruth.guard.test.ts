/**
 * Docs-truth guard.
 *
 * The 2026-11-04 audit claimed README's table count had been corrected to 57;
 * the schema actually has 120 top-level tables. A later reader also reasonably
 * asked whether the app had moved to Next.js — it had not. Both are cheap to
 * check from the tree itself, so they are pinned here rather than left to the
 * next audit:
 *
 *   1. README's stack sentence matches package.json (Express + Vite, no Next).
 *   2. Every README schema table-count claim equals schema.sql's top-level
 *      table count (partition children excluded).
 *   3. The architecture tree names the real client root, not a bare `src/`.
 *
 * Deliberately source-based, with no database: `npm test` must stay runnable on
 * a machine without PostgreSQL.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/**
 * Top-level tables declared by schema.sql: `CREATE TABLE` lines minus the
 * `PARTITION OF` children (`gl_journals_default`, `gl_journal_lines_default`),
 * which are storage for their parent, not separate tables.
 */
function countTopLevelTables(): number {
  return read('scripts/schema.sql')
    .split(/\r?\n/)
    .filter((line) => /^CREATE TABLE\b/i.test(line) && !/\bPARTITION OF\b/i.test(line))
    .length;
}

describe('docs truth — stack', () => {
  test('README names the runtime package.json actually declares', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    assert.ok(deps.express, 'package.json no longer declares Express');
    assert.ok(deps.vite, 'package.json no longer declares Vite');
    assert.equal(deps.next, undefined, 'package.json now declares Next.js; update the docs deliberately');

    const readme = read('README.md');
    assert.match(readme, /Node\.js\/Express/, 'README must name the real Node.js/Express backend');
    assert.doesNotMatch(readme, /Next\.js/i, 'README must not claim a Next.js stack');
  });
});

describe('docs truth — schema counts', () => {
  test('every README table-count claim matches schema.sql', () => {
    const actual = countTopLevelTables();
    // Pinned on purpose: a schema change must update README and this guard in
    // the same commit. Update the number here only after counting the new DDL.
    assert.equal(actual, 120, 'schema.sql top-level table count moved; update README and this guard');

    const readme = read('README.md');
    const claims: Array<{ pattern: RegExp; label: string }> = [
      { pattern: /migrate all \*\*(\d+) relational database tables\*\*/, label: 'setup feature line' },
      { pattern: /Schema DDL sync \((\d+) tables\)/, label: 'dbBoot tree line' },
      { pattern: /Full PostgreSQL schema — (\d+) tables/, label: 'schema.sql tree line' },
      { pattern: /all \*\*(\d+) tables\*\*/, label: 'setup step 2' },
    ];

    const found: number[] = [];
    for (const { pattern, label } of claims) {
      const match = readme.match(pattern);
      assert.ok(match, `README lost its table-count claim (${label}); restore it or update this guard`);
      found.push(Number(match[1]));
    }
    assert.deepEqual(
      found,
      claims.map(() => actual),
      `README table counts ${found.join(', ')} must all equal schema.sql's ${actual}`
    );
  });
});

describe('docs truth — architecture tree', () => {
  test('the frontend root is client/src, matching the repository layout', () => {
    const readme = read('README.md');
    assert.ok(fs.existsSync(path.join(ROOT, 'client', 'src')), 'client/src must exist');
    assert.match(readme, /├── client\/src\/\s+# React 19/, 'the tree must label the real client root');
    assert.doesNotMatch(readme, /├── src\/\s+# React 19/, 'a bare src/ root was removed from the tree');
  });
});
