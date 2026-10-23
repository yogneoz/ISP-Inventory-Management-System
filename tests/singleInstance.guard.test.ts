/**
 * D3 guard — the single-process constraint stays true in config and in docs.
 *
 * pm2 runs ONE fork-mode worker ([ecosystem.config.js]), and that is a
 * correctness requirement, not a small-server default: the operational caches
 * refresh after this process's own writes only, SSE fan-out reaches only the
 * clients connected to the worker that handled the change, and the auth/SSE
 * rate-limit buckets count per process. Raising `instances` produces silent
 * staleness and missed refreshes — no error, no log line — so the only place
 * that can prevent it is documentation next to the knob, plus this guard.
 *
 * PROVES (file parsing only — no server, no database):
 *   1. `ecosystem.config.js` still declares exactly one worker in fork mode and
 *      names the README section that explains why.
 *   2. The README section names every process-local concern, the shared secret,
 *      each prerequisite for cluster mode, and links this backlog item.
 *   3. `handoff.md` repeats the constraint and points at the same places.
 *   4. The backlog records D3 as done with the evidence.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (relativePath: string): string => fs.readFileSync(path.resolve(ROOT, relativePath), 'utf8');

/** Slice of `text` from `start` (inclusive) to the next `end` after it. */
function section(text: string, start: string, end: string, file: string): string {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `${file} must contain the section heading ${JSON.stringify(start)}`);
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `${file} must end that section with ${JSON.stringify(end)}`);
  return text.slice(from, to);
}

const README_HEADING = '### Single process only (do not raise `instances`)';
const README_ANCHOR = 'single-process-only-do-not-raise-instances';
const BACKLOG_ANCHOR = 'd3-document-the-single-instance-constraint';

describe('single-instance constraint (backlog D3)', () => {
  test('pm2 still runs one fork-mode worker and points at the README section', () => {
    const config = read('ecosystem.config.js');
    assert.match(config, /instances:\s*1\s*,/, 'ecosystem.config.js must keep instances: 1');
    assert.match(config, /exec_mode:\s*'fork'/, 'one worker means fork mode, not cluster');
    assert.doesNotMatch(
      config,
      /instances:\s*(?:max|['"]max['"]|[2-9]|\d{2,})/,
      'a second worker breaks cache coherence, SSE fan-out and the effective rate limits — ' +
        'move those to shared infrastructure first (README, "Single process only")'
    );
    assert.ok(
      config.includes('Single process only'),
      'the instances comment must name the README section so the next editor finds the reason'
    );
  });

  test('the README section names every process-local concern and cluster prerequisite', () => {
    const readme = read('README.md');
    const body = section(readme, README_HEADING, '### Step 5: Configure Nginx Reverse Proxy & SSL', 'README.md');

    // Where the unshared state lives, so the claim can be checked against code.
    for (const needle of [
      'server/src/state/runtimeState.ts',
      'server/src/realtime/sse.ts',
      'server/src/middleware/authRateLimit.ts',
      'server/src/middleware/sseRateLimit.ts',
    ]) {
      assert.ok(body.includes(needle), `the section must name ${needle} as process-local state`);
    }

    // What a second worker actually breaks — the reason the constraint exists.
    for (const consequence of ['stale rows', 'only to clients connected', 'silently multiply']) {
      assert.ok(body.includes(consequence), `the section must state the consequence: ${consequence}`);
    }

    // One secret for every worker, and every prerequisite for cluster mode.
    assert.ok(body.includes('AUTH_TOKEN_SECRET'), 'the section must require one shared AUTH_TOKEN_SECRET');
    for (const prerequisite of ['shared store', 'publish/subscribe', 'proxy_read_timeout']) {
      assert.ok(body.includes(prerequisite), `the section must list the prerequisite: ${prerequisite}`);
    }

    assert.ok(
      body.includes(`docs/architecture-backlog.md#${BACKLOG_ANCHOR}`),
      'the section must link the backlog item that records the decision'
    );
  });

  test('handoff.md repeats the constraint and links the same places', () => {
    const handoff = read('handoff.md');
    const start = handoff.indexOf('One process, by design');
    assert.notEqual(start, -1, 'handoff.md §14.2 must carry the single-process note');
    const body = handoff.slice(start, start + 2500);

    assert.ok(body.includes('runtimeState.ts'), 'the note must name the operational caches');
    assert.ok(body.includes('broadcastChange'), 'the note must name the SSE write loop that needs pub/sub');
    assert.ok(body.includes('AUTH_TOKEN_SECRET'), 'the note must state that all workers share one secret');
    assert.ok(body.includes(`README.md#${README_ANCHOR}`), 'the note must link the README section');
    assert.ok(body.includes(`docs/architecture-backlog.md#${BACKLOG_ANCHOR}`), 'the note must link D3');
  });

  test('the backlog records D3 as done', () => {
    const backlog = read('docs/architecture-backlog.md');
    assert.match(
      backlog,
      /\[x\] D3\s+document the single-instance constraint\s+\(2026-10-22\)/,
      'D3 must be ticked in the Status block with its completion date'
    );
    const d3 = section(backlog, '### D3 — Document the single-instance constraint', '\n## C —', 'docs/architecture-backlog.md');
    assert.ok(d3.includes('**Done 2026-10-22**'), 'D3 needs a Done row naming what shipped');
    assert.ok(
      d3.includes('singleInstance.guard.test.ts'),
      'the Done row must point at the test that keeps the documentation honest'
    );
  });
});
