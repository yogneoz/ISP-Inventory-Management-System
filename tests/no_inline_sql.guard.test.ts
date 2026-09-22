/**
 * Unit tests for the repo-layer guard (scripts/check_no_inline_sql.ts).
 * Exercises the pure detection core against synthetic sources and asserts
 * the live controllers tree is clean.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findInlineSql, looksLikeSql, findConnectionViolations } from '../scripts/check_no_inline_sql';
import { runAsScript } from '../scripts/check_no_inline_sql';
import * as path from 'node:path';
import * as fs from 'node:fs';

const CONTROLLERS_DIR = path.resolve(process.cwd(), 'server', 'src', 'controllers');

describe('no-inline-sql guard', () => {
  describe('looksLikeSql', () => {
    test('flags literal bodies that start with SQL keywords', () => {
      assert.equal(looksLikeSql('SELECT id FROM users'), true);
      assert.equal(looksLikeSql('INSERT INTO users (id) VALUES ($1)'), true);
      assert.equal(looksLikeSql('UPDATE users SET password = $1'), true);
      assert.equal(looksLikeSql('DELETE FROM users WHERE id = $1'), true);
    });

    test('is insensitive to leading whitespace and case', () => {
      assert.equal(looksLikeSql('  \n  select * from t'), true);
      assert.equal(looksLikeSql('DELETE  from t'), true);
    });

    test('does not flag plain prose, identifiers, or SQL fragments mid-text', () => {
      assert.equal(looksLikeSql('Permission matrix updated.'), false);
      assert.equal(looksLikeSql('someQuery.sql'), false);
      assert.equal(looksLikeSql('invalid SQL payload'), false);
      assert.equal(looksLikeSql('SELECTED items are highlighted'), false);
    });
  });

  describe('findInlineSql (synthetic sources)', () => {
    test('flags a backtick SELECT literal with its line number', () => {
      const src = [
        'import { pgPool } from "../app";',
        'export async function h() {',
        '  const res = await pgPool.query(',
        '    `SELECT id FROM users WHERE id = $1`,',
        '    ["u1"]',
        '  );',
        '}',
      ].join('\n');
      const v = findInlineSql(src, 'fake.controller.ts');
      assert.equal(v.length, 1);
      assert.equal(v[0].line, 4);
      assert.match(v[0].snippet, /^SELECT id FROM users/);
    });

    test('flags single- and double-quoted SQL strings', () => {
      const src = [
        "await pgPool.query('DELETE FROM permission_matrix');",
        'await pgPool.query("UPDATE t SET x = 1");',
      ].join('\n');
      const v = findInlineSql(src, 'fake.controller.ts');
      assert.equal(v.length, 2);
    });

    test('flags the literal head of a concatenation but not the repo expression', () => {
      const src = [
        'await pgPool.query(',
        '  `SELECT items FROM stock_operations` + whereClause(conds),',
        '  params',
        ');',
      ].join('\n');
      const v = findInlineSql(src, 'fake.controller.ts');
      assert.equal(v.length, 1);
      assert.match(v[0].snippet, /^SELECT items FROM stock_operations/);
    });

    test('does not flag executing repo-owned constants', () => {
      const src = [
        "import { USER_FIND_BY_EMAIL_SQL } from '../models/auth.repo';",
        'await pgPool.query(USER_FIND_BY_EMAIL_SQL, [email]);',
        'const q = buildStockListQuery(branchId);',
        'await pgPool.query(q.sql, q.params);',
      ].join('\n');
      assert.deepEqual(findInlineSql(src, 'fake.controller.ts'), []);
    });

    test('does not flag SQL-looking text inside comments', () => {
      const src = [
        '// SELECT * FROM not_code — architectural note',
        '/*',
        ' DELETE FROM also_not_code;',
        ' SELECT in a block comment',
        '*/',
        'res.json({ ok: true });',
      ].join('\n');
      assert.deepEqual(findInlineSql(src, 'fake.controller.ts'), []);
    });

    test('does not flag prose strings even with SQL-ish words after the start', () => {
      const src = "const msg = 'UPDATE your password from the profile page.';";
      assert.deepEqual(findInlineSql(src, 'fake.controller.ts'), []);
    });

    test('skips interpolations inside template literals', () => {
      const src = [
        'const label = `row ${x ? "SELECT via fallback" : "plain"} end`;',
        'const fine = `total ${n}`;',
      ].join('\n');
      assert.deepEqual(findInlineSql(src, 'fake.controller.ts'), []);
    });
  });

  describe('findConnectionViolations (synthetic sources)', () => {
    test('flags direct pool connect() calls', () => {
      const src = "const client = await pgPool.connect();\nconst c2 = realPoolInstance.connect();";
      const v = findConnectionViolations(src, 'fake.controller.ts');
      assert.equal(v.length, 2);
      assert.match(v[0].rule, /withTransaction\/withConnection/);
    });

    test('flags client-level BEGIN/COMMIT/ROLLBACK regardless of quote style', () => {
      const src = [
        "await client.query('BEGIN');",
        'await client.query("COMMIT");',
        'await client.query(`ROLLBACK`);',
      ].join('\n');
      assert.equal(findConnectionViolations(src, 'fake.controller.ts').length, 3);
    });

    test('flags pool-level BEGIN/COMMIT/ROLLBACK with the cross-connection rule', () => {
      const src = "await pgPool.query('BEGIN');\nawait pgPool.query('COMMIT');";
      const v = findConnectionViolations(src, 'fake.controller.ts');
      assert.equal(v.length, 2);
      assert.match(v[0].rule, /never atomic/);
    });

    test('does not flag withTransaction or ordinary queries', () => {
      const src = [
        "await withTransaction(async (client) => { await client.query(SOME_SQL, [id]); });",
        'await pgPool.query(SOME_REPO_SQL, params);',
        "const msg = 'ROLLBACK your changes from the UI'; // prose in a string",
      ].join('\n');
      assert.deepEqual(findConnectionViolations(src, 'fake.controller.ts'), []);
    });

    test('does not flag keywords inside comments', () => {
      const src = [
        '// pgPool.connect() is forbidden here — see docs',
        '/* client.query(\'BEGIN\') was the old pattern */',
        'await withTransaction(async (client) => {});',
      ].join('\n');
      assert.deepEqual(findConnectionViolations(src, 'fake.controller.ts'), []);
    });
  });

  describe('live controllers tree', () => {
    test('every controller file currently contains zero raw SQL literals', () => {
      assert.equal(fs.existsSync(CONTROLLERS_DIR), true, 'controllers dir must exist');
      const files = fs.readdirSync(CONTROLLERS_DIR).filter((f) => f.endsWith('.ts'));
      assert.ok(files.length >= 10, `expected the full controller set, found ${files.length}`);
      const violations = files.flatMap((f) =>
        findInlineSql(fs.readFileSync(path.join(CONTROLLERS_DIR, f), 'utf8'), f)
      );
      assert.deepEqual(violations, []);
    });

    test('every controller file acquires no connections and runs no hand-rolled transactions', () => {
      const files = fs.readdirSync(CONTROLLERS_DIR).filter((f) => f.endsWith('.ts'));
      const violations = files.flatMap((f) =>
        findConnectionViolations(fs.readFileSync(path.join(CONTROLLERS_DIR, f), 'utf8'), f)
      );
      assert.deepEqual(violations, []);
    });

    test('runAsScript exits 0 for the clean controllers directory', () => {
      assert.equal(runAsScript([CONTROLLERS_DIR]), 0);
    });

    test('runAsScript exits 1 when a seeded SQL violation is present', () => {
      const tmp = path.join(process.cwd(), '.tmp-guard-violation.controller.ts');
      fs.writeFileSync(
        tmp,
        'export async function bad() {\n  await pgPool.query(`SELECT 1 FROM doomed`);\n}\n'
      );
      try {
        assert.equal(runAsScript([tmp]), 1);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });

    test('runAsScript exits 1 when a seeded connection violation is present', () => {
      const tmp = path.join(process.cwd(), '.tmp-guard-connect.controller.ts');
      fs.writeFileSync(
        tmp,
        "export async function bad() {\n  const c = await pgPool.connect();\n}\n"
      );
      try {
        assert.equal(runAsScript([tmp]), 1);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });
  });
});
