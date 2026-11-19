/**
 * Wiring pin for the two-OS-process API-key RPM proof.
 *
 * The proof itself needs a real PostgreSQL, a real Redis and two spawned
 * processes, so it is a script (`npm run verify:apikey-rpm`), like
 * `verify:redis-invalidation`. This test is the cheap, deterministic pin that
 * the proof cannot be quietly weakened or unwired:
 *
 *   - the script exists and is reachable from `package.json`;
 *   - it really starts a SECOND OS process (the `worker-b` mode and the spawn);
 *   - it exercises both directions of the shared budget (A→B and B→A) plus the
 *     bucket-deletion control, so a per-process counter fails it;
 *   - it refuses to report success unless every assertion held.
 *
 * Running the script is the proof; this test is what keeps the proof honest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

test('the cross-process API-key RPM proof is wired and still tests both directions', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(
    pkg.scripts['verify:apikey-rpm'],
    'tsx scripts/verify_apikey_rpm.ts',
    'package.json must expose the proof as verify:apikey-rpm'
  );

  const script = read('scripts/verify_apikey_rpm.ts');
  assert.match(script, /process\.argv\[2\] === 'worker-b'/, 'the script must have a second-process mode');
  assert.match(script, /spawn\('npx', \['tsx', 'scripts\/verify_apikey_rpm\.ts', 'worker-b'\]/,
    'the parent must spawn worker B as a separate OS process');
  assert.match(script, /API_KEY_RPM_NAMESPACE/, 'the proof must inspect the real shared bucket namespace');
  assert.match(script, /worker B request 3 \(other OS process\)/, 'worker B must be the one that hits the shared cap');
  assert.match(script, /worker A request 3 \(A sees B usage too\)/, 'the reverse direction must be asserted too');
  assert.match(script, /after deleting the shared bucket/, 'the bucket-deletion control proves Redis is the counter');
  assert.match(script, /retry-after/i, 'the 429 must be checked for Retry-After');
  assert.match(script, /failures === 0 \? 0 : 1|process\.exit\(failures === 0 \? 0 : 1\)/,
    'the script must exit non-zero when an assertion fails');
  assert.doesNotMatch(script, /rpmLimit:\s*[3-9]/, 'a budget above 2 would not distinguish per-process counters');
});
