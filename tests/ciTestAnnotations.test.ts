/**
 * CI test-failure annotations — the parser behind `::error` annotations and the
 * job summary (scripts/ciTestAnnotations.ts).
 *
 * Why this suite exists: the annotation step is only useful if it reads the
 * reporter output the runner actually produces. A hand-rolled parser that
 * silently matches nothing would leave CI just as undiagnosable as before,
 * while looking green — so the fixtures below are REAL reporter output captured
 * from this repo's runner (node 24.20, `npx tsx --test`, spec and TAP
 * reporters), and the parser is asserted against them.
 *
 * The GitHub reporter caveat is pinned too: `--test-reporter=github` is not a
 * Node built-in (node:test/reporters exports only dot/junit/spec/tap/lcov), so
 * `::error` lines have to be emitted by hand.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as reporters from 'node:test/reporters';
import {
  parseFailingTests,
  parseTotals,
  toAnnotations,
  toStepSummary,
  normalizePath,
} from '../scripts/ciTestAnnotations';

/** Verbatim spec-reporter output: one failing subtest and the suite that
 *  aggregates it, plus the counters that follow. Captured 2026-10-15. */
const SPEC_OUTPUT = [
  '✖ failing tests:',
  '',
  'test at tests\\bootstrapTrim.test.ts:134:5',
  '✖ GET /api/bootstrap omits the three ledgers but keeps financialSummary (169.0295ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  '  ',
  '  503 !== 200',
  '  ',
  '      at TestContext.<anonymous> (D:\\inventory-dev\\ISP-Inventory-Management-System\\tests\\bootstrapTrim.test.ts:136:14)',
  '      at async Test.run (node:internal/test_runner/test:1404:7) {',
  '    generatedMessage: true,',
  '    code: \'ERR_ASSERTION\',',
  '    actual: 503,',
  '    expected: 200,',
  '    operator: \'strictEqual\'',
  '  }',
  '',
  'test at tests\\receiveLane403.test.ts:92:1',
  '✖ receive lane 403s (route gate + handler lane gate) (348.6995ms)',
  '  error: insert or update on table "inventory_stock" violates foreign key constraint "inventory_stock_branch_id_fkey"',
  '      at D:\\inventory-dev\\ISP-Inventory-Management-System\\node_modules\\pg-pool\\index.js:45:11',
  '      at async SuiteContext.<anonymous> (D:\\inventory-dev\\ISP-Inventory-Management-System\\tests\\receiveLane403.test.ts:130:5) {',
  '    length: 295,',
  "    severity: 'ERROR',",
  "    code: '23503',",
  '    detail: \'Key (branch_id)=(BRH01) is not present in table "branches".\',',
  '    hint: undefined,',
  '  }',
  '',
  'test at tests\\shipmentAuthz.test.ts:205:3',
  '✖ VULN-001 create: omitted sourceBranchId defaults to the caller\'s branch and deducts it (154.1643ms)',
  '  \'test did not finish before its parent and was cancelled\'',
  '',
  'ℹ tests 797',
  'ℹ suites 195',
  'ℹ pass 783',
  'ℹ fail 3',
  'ℹ skipped 2',
].join('\n');

/** The checkout the capture below was made in. TAP reports ABSOLUTE paths, so
 *  the parser can only relativize them against the workspace they came from —
 *  without this the assertion would depend on which machine runs the suite
 *  (Linux CI found that out the first time). */
const CAPTURE_WORKSPACE = 'D:\\inventory-dev\\ISP-Inventory-Management-System';

/** Verbatim TAP-reporter output for the same failure (node 24.20), including
 *  the escaped Windows path and the nested suite entry that must NOT be
 *  annotated a second time. Captured 2026-10-15. */
const TAP_OUTPUT = [
  'TAP version 13',
  '    # Subtest: GET /api/bootstrap omits the three ledgers but keeps financialSummary',
  '        not ok 1 - GET /api/bootstrap omits the three ledgers but keeps financialSummary',
  '          ---',
  '          duration_ms: 124.6926',
  "          type: 'test'",
  "          location: 'D:\\\\inventory-dev\\\\ISP-Inventory-Management-System\\\\tests\\\\bootstrapTrim.test.ts:134:5'",
  "          failureType: 'testCodeFailure'",
  '          error: |-',
  '            Expected values to be strictly equal:',
  '            ',
  '            503 !== 200',
  '            ',
  "          code: 'ERR_ASSERTION'",
  "          name: 'AssertionError'",
  '          ...',
  '    not ok 3 - HTTP against real PostgreSQL',
  '      ---',
  '      duration_ms: 169',
  "      type: 'suite'",
  "      location: 'D:\\\\inventory-dev\\\\ISP-Inventory-Management-System\\\\tests\\\\bootstrapTrim.test.ts:102:3'",
  "      error: '1 subtest failed'",
  '      ...',
  '1..1',
  '# tests 6',
  '# pass 5',
  '# fail 1',
  '# skipped 0',
].join('\n');

describe('CI test annotations — spec reporter', () => {
  test('reads every failing test with its file, line and reason', () => {
    const failures = parseFailingTests(SPEC_OUTPUT);
    assert.equal(failures.length, 3);

    assert.deepEqual(failures[0], {
      file: 'tests/bootstrapTrim.test.ts',
      line: 134,
      title: 'GET /api/bootstrap omits the three ledgers but keeps financialSummary',
      reason: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 503 !== 200',
    });

    // A suite-level failure (its error line is the finding) is kept: the suite
    // name is the only clue that a `before` hook died. The pg error object the
    // reporter dumps underneath it (`length`, `severity`, `code`, `detail`,
    // `hint`) is bookkeeping and must not reach the annotation.
    assert.equal(failures[1].line, 92);
    assert.equal(
      failures[1].reason,
      'error: insert or update on table "inventory_stock" violates foreign key constraint "inventory_stock_branch_id_fkey"'
    );

    // A cancelled subtest reports a quoted sentence; the quotes come off.
    assert.equal(failures[2].reason, 'test did not finish before its parent and was cancelled');
  });

  test('the reason never leaks stack frames or structured fields', () => {
    const [first] = parseFailingTests(SPEC_OUTPUT);
    assert.ok(!first.reason.includes('TestContext.<anonymous>'), 'stack frames must be dropped');
    assert.ok(!first.reason.includes('generatedMessage'), 'structured fields must be dropped');

    // The same rule for a Postgres error object: the message survives, the
    // dump does not.
    const suiteReason = parseFailingTests(SPEC_OUTPUT)[1].reason;
    for (const noise of ['length:', 'severity:', 'code:', 'detail:', 'hint:', 'pg-pool']) {
      assert.ok(!suiteReason.includes(noise), `'${noise}' must not reach the annotation`);
    }
  });

  test('totals come from the counters, not from the failure list', () => {
    assert.deepEqual(parseTotals(SPEC_OUTPUT), { tests: 797, pass: 783, fail: 3, skipped: 2 });
  });

  test('a green run parses to nothing rather than to a false failure', () => {
    const green = '✔ a passing test (2.1ms)\n\nℹ tests 1\nℹ suites 1\nℹ pass 1\nℹ fail 0\nℹ skipped 0';
    assert.deepEqual(parseFailingTests(green), []);
    assert.deepEqual(parseTotals(green), { tests: 1, pass: 1, fail: 0, skipped: 0 });
  });
});

describe('CI test annotations — TAP reporter', () => {
  test('reads the failing test and skips the aggregating suite entry', () => {
    const failures = parseFailingTests(TAP_OUTPUT, CAPTURE_WORKSPACE);
    assert.equal(failures.length, 1, 'the suite entry only aggregates its subtests');
    assert.deepEqual(failures[0], {
      file: 'tests/bootstrapTrim.test.ts',
      line: 134,
      title: 'GET /api/bootstrap omits the three ledgers but keeps financialSummary',
      reason: 'Expected values to be strictly equal: 503 !== 200',
    });
  });

  test('an absolute path outside the workspace is never passed off as relative', () => {
    // The discriminator Linux CI caught: TAP prints absolute paths, so a
    // workspace that does not contain them must leave them alone rather than
    // invent a relative path (an annotation pointing at the wrong file is worse
    // than one GitHub cannot link).
    const [failure] = parseFailingTests(TAP_OUTPUT, '/home/runner/work/repo/repo');
    assert.equal(failure.file, 'D:/inventory-dev/ISP-Inventory-Management-System/tests/bootstrapTrim.test.ts');
  });

  test('totals come from the TAP counters', () => {
    assert.deepEqual(parseTotals(TAP_OUTPUT), { tests: 6, pass: 5, fail: 1, skipped: 0 });
  });
});

describe('CI test annotations — workflow commands', () => {
  test('emits one ::error per failure, anchored at the failing line', () => {
    const annotations = toAnnotations(parseFailingTests(SPEC_OUTPUT));
    assert.equal(annotations.length, 3);
    assert.equal(
      annotations[0],
      '::error file=tests/bootstrapTrim.test.ts,line=134,' +
        'title=GET /api/bootstrap omits the three ledgers but keeps financialSummary::' +
        // Only %, CR and LF are escaped in the message body — colons stay
        // readable there (only *property values* escape `:` and `,`).
        'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 503 !== 200'
    );
  });

  test('escapes the property characters GitHub requires', () => {
    const [annotation] = toAnnotations([
      { file: 'tests/a.test.ts', line: 7, title: 'a, b: c%d', reason: 'line one\nline two' },
    ]);
    assert.equal(
      annotation,
      '::error file=tests/a.test.ts,line=7,title=a%2C b%3A c%25d::line one%0Aline two'
    );
  });

  test('stays inside the runner annotation budget and prefers real reasons', () => {
    // The runner drops annotations past ~10 per step (50 per job), so a 60-entry
    // failure list must not silently lose the informative ones to cancelled
    // subtests that only say "did not finish".
    const failures = Array.from({ length: 12 }, (_, index) => ({
      file: 'tests/a.test.ts',
      line: index + 1,
      title: `cancelled ${index}`,
      reason: 'test did not finish before its parent and was cancelled',
    }));
    failures.push({ file: 'tests/b.test.ts', line: 42, title: 'the real failure', reason: 'AssertionError: 503 !== 200' });

    const annotations = toAnnotations(failures);
    assert.equal(annotations.length, 10, 'the default budget is the runner\'s per-step cap');
    assert.ok(
      annotations[0].includes('the real failure'),
      'a real reason must be annotated before cancelled subtests'
    );
    // An explicit limit still wins (and the summary is the complete channel).
    assert.equal(toAnnotations(failures, 100).length, 13);
  });

  test('path normalisation turns a workspace path into what annotations need', () => {
    assert.equal(
      normalizePath('D:\\ci\\repo\\tests\\a.test.ts', 'D:\\ci\\repo'),
      'tests/a.test.ts'
    );
    assert.equal(normalizePath('/home/runner/work/repo/tests/a.test.ts', '/home/runner/work/repo'), 'tests/a.test.ts');
    assert.equal(normalizePath('tests\\a.test.ts', '/unrelated'), 'tests/a.test.ts');
  });
});

describe('CI test annotations — job summary', () => {
  test('lists every failure with a link to its location', () => {
    const failures = parseFailingTests(SPEC_OUTPUT);
    const summary = toStepSummary(failures, parseTotals(SPEC_OUTPUT));
    assert.match(summary, /^## ❌ Test failures/);
    assert.match(summary, /3 of 797 tests failed \(783 passed, 2 skipped\)/);
    assert.match(summary, /\[`tests\/bootstrapTrim\.test\.ts:134`\]\(tests\/bootstrapTrim\.test\.ts#L134\)/);
    // Every failing test appears, even when annotations are capped.
    for (const failure of failures) assert.ok(summary.includes(failure.title), `${failure.title} missing from the summary`);
  });

  test('says so when the output could not be parsed, instead of inventing failures', () => {
    const summary = toStepSummary([], null);
    assert.match(summary, /no failing test could be read/i);
  });
});

describe('CI test annotations — the GitHub reporter is not a Node built-in', () => {
  test('node:test/reporters ships no github reporter, so annotations are emitted here', () => {
    assert.ok(
      !Object.keys(reporters).includes('github'),
      'if Node ever ships a github reporter, prefer --test-reporter=github in scripts/run_tests.mjs over this parser'
    );
  });
});
