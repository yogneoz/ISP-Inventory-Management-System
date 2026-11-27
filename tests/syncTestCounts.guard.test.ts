/**
 * The count-sync script edits prose in three documents, so the two ways it can
 * go wrong are pinned here: rewriting a sentence that is NOT a current-state
 * claim (a historical "449/449 tests pass" must stay true forever), and missing
 * a sentence the gate does check (which leaves the next `npm test` red).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rewriteLine, syncText } from '../scripts/syncTestCounts';

test('sync counts: the Tests: N/N header field has both halves rewritten', () => {
  const { line, changed } = rewriteLine('- **Tests: 2940/2940** (0 failing)', 2955);
  assert.equal(line, '- **Tests: 2955/2955** (0 failing)');
  assert.equal(changed, 2);
});

test('sync counts: every current-state phrasing the gate knows is rewritten', () => {
  const cases: Array<[string, string]> = [
    ['  full 2940-test suite against a PostgreSQL 18 container', '  full 2955-test suite against a PostgreSQL 18 container'],
    ['drift guards — 2940 tests; CI runs', 'drift guards — 2955 tests; CI runs'],
    ['2. `npm test` — 2940 tests against a real PostgreSQL 18', '2. `npm test` — 2955 tests against a real PostgreSQL 18'],
    ['the suite now 2940 tests', 'the suite now 2955 tests'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(rewriteLine(input, 2955).line, expected, input);
  }
});

test('sync counts: historical records are left alone', () => {
  // Per the gate's scope contract these document a run that happened and stay
  // correct forever, so rewriting them would falsify the record.
  const historical = [
    '- **449/449 tests pass** on the fixed tree',
    'suite stood at 2,933 tests (2,910 pass, 23 skipped, 0 fail)',
    '522 node:test tests',
    'the +4 tests -> 380/380 arc',
  ];
  for (const line of historical) {
    assert.deepEqual(rewriteLine(line, 2955), { line, changed: 0 }, line);
  }
});

test('sync counts: syncing is idempotent and reports what it changed', () => {
  const doc = [
    'Tests: 2940/2940',
    'full 2940-test suite',
    '449/449 tests pass',
  ].join('\n');
  const first = syncText(doc, 2955);
  assert.equal(first.changed, 3);
  assert.match(first.text, /^Tests: 2955\/2955$/m);
  const second = syncText(first.text, 2955);
  assert.equal(second.text, first.text);
  assert.equal(second.changed, 3);
});
