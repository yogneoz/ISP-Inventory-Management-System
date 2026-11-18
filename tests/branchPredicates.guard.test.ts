/**
 * SCALE-3 — branch-predicate CI guard.
 *
 * The worklist asked for a mechanical check that new SQL on the partitioned
 * tables carries a `branch_id` predicate (the review checklist, not a runtime
 * substitute). These tests pin the guard in both directions: the dangerous shape
 * fails, every legitimate key form passes, and the in-scope table list comes from
 * `scripts/schema.sql` so a new partitioned table cannot be added quietly.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  BRANCH_PREDICATE_EXEMPTIONS,
  findBranchPredicateViolations,
  mutationKind,
  partitionedBranchTables,
  scanProject,
  sqlLiterals,
} from '../scripts/check_branch_predicates';

const TABLES = ['gl_journals', 'serial_log', 'sales_invoices'];

describe('branch predicates — detection', () => {
  test('a status-only UPDATE over a partitioned table is a violation', () => {
    const source = "const SQL = `UPDATE serial_log SET status = 'LOST' WHERE status = 'IN_STOCK'`;";
    const violations = findBranchPredicateViolations(source, 'x.repo.ts', TABLES);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].table, 'serial_log');
    assert.equal(violations[0].line, 1);
  });

  test('branch_id, the row id, a natural key or the source document all pass', () => {
    const accepted = [
      "UPDATE serial_log SET status = 'LOST' WHERE branch_id = $1",
      'UPDATE serial_log SET status = $1 WHERE id = $2',
      'UPDATE serial_log SET status = $1 WHERE device_serial = $2',
      'DELETE FROM sales_invoices WHERE invoice_number = $1',
      'UPDATE serial_log SET status = $1 WHERE source_id = $2 AND status = $3',
      'INSERT INTO gl_journals (id, branch_id) VALUES ($1, $2)',
    ];
    for (const statement of accepted) {
      const violations = findBranchPredicateViolations('x(`' + statement + '`)', 'x.repo.ts', TABLES);
      assert.deepEqual(violations, [], `must accept: ${statement}`);
    }
  });

  test('reads and comments are out of scope — the guard is about mutations', () => {
    const source = [
      '// UPDATE serial_log SET status = $1 without a key is only prose here',
      '/* DELETE FROM serial_log is also prose */',
      'const read = `SELECT * FROM serial_log WHERE status = $1`;',
    ].join('\n');
    assert.deepEqual(findBranchPredicateViolations(source, 'x.repo.ts', TABLES), []);
    assert.equal(mutationKind('SELECT 1'), null);
    assert.equal(mutationKind('  INSERT INTO x'), 'INSERT');
  });

  test('an exemption only applies to its own file and statement', () => {
    const statement = 'INSERT INTO gl_journals SELECT * FROM staging';
    const exemptions = [{ file: 'boot/repair.ts', startsWith: statement, reason: 'boot repair' }];
    assert.deepEqual(
      findBranchPredicateViolations('x(`' + statement + '`)', 'server/src/boot/repair.ts', TABLES, exemptions),
      []
    );
    assert.equal(
      findBranchPredicateViolations('x(`' + statement + '`)', 'server/src/models/other.repo.ts', TABLES, exemptions)
        .length,
      1,
      'a different file does not inherit the exemption'
    );
  });

  test('a statement split over several template lines is still one statement', () => {
    const source = [
      'const SQL = `UPDATE serial_log',
      "  SET status = 'LOST'",
      '  WHERE status = $1`;',
    ].join('\n');
    const violations = findBranchPredicateViolations(source, 'x.repo.ts', TABLES);
    assert.equal(violations.length, 1, 'multi-line SQL must be judged as a whole');
    assert.equal(violations[0].line, 1);
  });

  test('literals keep their line numbers through comments and escapes', () => {
    const source = ["const a = 1; // one", "const b = 'it\\'s';", 'const c = `SELECT id FROM branches`;'].join('\n');
    const literals = sqlLiterals(source);
    assert.equal(literals.length, 1);
    assert.equal(literals[0].line, 3);
  });
});

describe('branch predicates — the schema decides the scope', () => {
  test('every PARTITION BY RANGE table with a branch_id is in scope', () => {
    const schema = [
      'CREATE TABLE IF NOT EXISTS a_part (',
      '    id text,',
      '    branch_id text,',
      '    date_ad date',
      ') PARTITION BY RANGE (date_ad);',
      'CREATE TABLE IF NOT EXISTS global_part (',
      '    id text,',
      '    date_ad date',
      ') PARTITION BY RANGE (date_ad);',
      'CREATE TABLE IF NOT EXISTS plain (',
      '    id text,',
      '    branch_id text',
      ');',
    ].join('\n');
    assert.deepEqual(partitionedBranchTables(schema), ['a_part']);
  });

  test('the real project is clean and the table list is the partitioned branch set', () => {
    const { tables, violations } = scanProject();
    assert.deepEqual(violations, [], 'no committed mutation lacks a branch key or an exemption');
    assert.ok(tables.includes('gl_journals') && tables.includes('serial_log'), `unexpected scope: ${tables}`);
    assert.equal(tables.length, 8, `the partitioned branch-scoped tables changed: ${tables.join(', ')}`);
  });

  test('every exemption still matches a statement (no dead entries)', () => {
    for (const exemption of BRANCH_PREDICATE_EXEMPTIONS) {
      assert.ok(fs.existsSync(exemption.file), `${exemption.file} no longer exists`);
      assert.ok(exemption.reason.length > 20, `${exemption.file} exemption needs a reason`);
      assert.ok(exemption.startsWith.length >= 20, `${exemption.file} exemption needs a stable prefix`);
    }
  });
});
