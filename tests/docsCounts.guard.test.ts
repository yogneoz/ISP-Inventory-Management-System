/**
 * Unit tests for the docs-count gate (scripts/docsTestCounts.ts).
 *
 * The gate itself runs in scripts/run_tests.mjs right after the suite
 * passes: it compares every CURRENT-STATE test-count claim in
 * README.md / handoff.md / SESSION_NOTES.md against the run's real suite
 * size, so a stale number fails `npm test` instead of misleading the next
 * reader. These tests pin the classification contract: which phrasings
 * count as current-state claims (and must therefore be kept fresh), and
 * which are historical records that must stay legal forever.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DOCS_FILES,
  checkDocsCounts,
  collectClaims,
  findCountClaims,
} from '../scripts/docsTestCounts';

describe('docs-count gate — current-state claim detection', () => {
  test('every current-state phrasing is detected with file:line and value', () => {
    const text = [
      '_Date: 2026-10-03 · Tests: 548/548 green with a DB_', // both halves of the pair
      '  full 548-test suite against a PostgreSQL 16 service container',
      '  drift/concurrency guards — 548 tests; CI runs',
      '2. `npm test` — 548 tests against a real PostgreSQL 16 service container',
      '  key coverage; suite now 548 tests, 0 fail). Live-verified:',
      '  explicit SSE-wiring decision. Suite now 548 tests, 0 fail.',
    ].join('\n');

    const claims = findCountClaims(text, 'x.md');
    assert.deepEqual(
      claims.map((c) => c.count),
      [548, 548, 548, 548, 548, 548, 548]
    );
    assert.deepEqual(
      claims.map((c) => c.line),
      [1, 1, 2, 3, 4, 5, 6]
    );
    // All agree with the real suite size → gate passes.
    assert.deepEqual(checkDocsCounts(548, [{ file: 'x.md', text }]), []);
  });

  test('a stale number fails naming file:line, the claim and the real count', () => {
    const text = '2. `npm test` — 433 tests against a real PostgreSQL 16';
    const errors = checkDocsCounts(554, [{ file: 'README.md', text }]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /README\.md:1 claims 433 tests but this run executed 554/);
    assert.match(errors[0], /CI gate list/);
  });

  test('a split Tests: N/N header pair is caught even when the first half matches', () => {
    const text = '_Date: Tests: 554/548 green with a DB_';
    const errors = checkDocsCounts(554, [{ file: 'SESSION_NOTES.md', text }]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /SESSION_NOTES\.md:1 claims 548 tests but this run executed 554/);
    assert.match(errors[0], /2nd half/);
  });

  test('historical records are NOT current-state claims — they stay legal forever', () => {
    const text = [
      '504/504 tests, bundle budget OK (275.7/320 kB gz startup).',
      'absent. Production smoke + 433/433 tests pass.',
      '- Tests: +3 (lock SQL shape, dedup/broadcast params) → 367/367.',
      '  --noEmit + 522 node:test tests, 0 fail), npm run build,',
      'Guard: `tests/schemaSource.parity.test.ts` (3 tests: no inline DDL in',
      'flawless. +2 tests → 376/376.',
      '- Tests: +18 (damage-pool ledger, PI id uniqueness) → 340/340.',
    ].join('\n');
    assert.deepEqual(findCountClaims(text), []);
    // Even with a wildly different real count, nothing is flagged.
    assert.deepEqual(checkDocsCounts(9999, [{ file: 'SESSION_NOTES.md', text }]), []);
  });

  test('the real docs agree with each other on one current suite size', () => {
    // Live cross-doc consistency: every current-state claim in the three
    // docs must be the same number. (run_tests.mjs then pins that number
    // to the real suite size on every `npm test`.)
    const docs = DOCS_FILES.map((file) => ({
      file,
      text: fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'),
    }));
    const claims = collectClaims(docs);
    assert.ok(
      claims.length >= 9,
      `expected the known current-state claims across the three docs, found ${claims.length}`
    );
    const disagreements = claims.filter((c) => c.count !== claims[0].count);
    assert.deepEqual(
      disagreements.map((c) => `${c.file}:${c.line}=${c.count}`),
      [],
      `docs disagree about the suite size: ${claims
        .map((c) => `${c.file}:${c.line}=${c.count}`)
        .join(', ')}`
    );
  });
});
