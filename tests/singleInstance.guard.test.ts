/**
 * SCALE-1 guard — horizontal workers have shared state, not a single-process
 * correctness requirement.
 *
 * PROVES (file parsing only — no server, no database):
 *   1. pm2 runs cluster mode with `instances: 'max'`, and the config requires
 *      Redis for a clustered production process.
 *   2. README documents the shared pieces, the fail-closed controls, and the
 *      still-per-worker reference caches that SCALE-4 owns.
 *   3. The runtime wires Redis into auth limits, session fingerprints, locks,
 *      SSE pub/sub and graceful shutdown.
 *   4. The old "one fork worker" guard cannot quietly return.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertSharedStateForWorkers } from '../server/src/state/sharedStore';

const ROOT = process.cwd();
const read = (relativePath: string): string => fs.readFileSync(path.resolve(ROOT, relativePath), 'utf8');

function section(text: string, start: string, end: string, file: string): string {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `${file} must contain the section heading ${JSON.stringify(start)}`);
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `${file} must end that section with ${JSON.stringify(end)}`);
  return text.slice(from, to);
}

const README_HEADING = '### Horizontal workers and shared state';

describe('SCALE-1 horizontal workers', () => {
  test('pm2 uses cluster mode and requires Redis', () => {
    const config = read('ecosystem.config.js');
    assert.match(config, /instances:\s*['"]max['"]/, 'the production config must scale workers');
    assert.match(config, /exec_mode:\s*'cluster'/, 'cluster mode is what makes instances:max meaningful');
    assert.match(config, /REDIS_(TLS_)?URL/, 'the config must name the Redis requirement');
    assert.doesNotMatch(config, /instances:\s*1\s*,/, 'the old single-worker constraint must not return');
    assert.doesNotMatch(config, /exec_mode:\s*'fork'/, 'fork mode keeps every worker single-process');
  });

  test('README documents shared state, fail modes and the SCALE-4 boundary', () => {
    const readme = read('README.md');
    const body = section(readme, README_HEADING, '### Step 5: Configure Nginx Reverse Proxy & SSL', 'README.md');

    for (const needle of [
      'server/src/middleware/authRateLimit.ts',
      'server/src/middleware/sseRateLimit.ts',
      'server/src/state/sessionVersion.ts',
      'server/src/state/sharedLock.ts',
      'server/src/realtime/sse.ts',
      'isp:sse:changes',
      'session:ver',
      'SET NX PX',
      'SHARED_STATE_UNAVAILABLE',
      'SCALE-4',
    ]) {
      assert.ok(body.includes(needle), `the section must document ${needle}`);
    }
    assert.match(body, /fail\s+\*\*closed\*\*/, 'security limits must state the fail-closed behaviour');
    assert.ok(body.includes('REDIS_URL'), 'the section must name the required deployment variable');
  });

  test('runtime wires Redis into every shared concern', () => {
    const store = read('server/src/state/sharedStore.ts');
    assert.match(store, /from 'redis'/, 'the shared store must use the redis package');
    assert.match(store, /REDIS_TLS_URL/);
    assert.match(store, /REDIS_URL/);
    assert.match(store, /SharedStateUnavailableError/, 'unavailable shared state must be explicit');

    const auth = read('server/src/middleware/authRateLimit.ts');
    assert.match(auth, /SharedRateLimiter/);
    assert.match(auth, /SHARED_STATE_UNAVAILABLE/);

    const sse = read('server/src/realtime/sse.ts');
    assert.match(sse, /\.publish\(/);
    assert.match(sse, /\.subscribe\(/);

    const lifecycle = read('server/src/boot/lifecycle.ts');
    assert.match(lifecycle, /closeShared/);
    assert.match(lifecycle, /closeSharedBounded/);
  });

  test('a production boot refuses to start without Redis, at any worker count', () => {
    // Presence is this guard's half of the contract; reachability belongs to
    // initializeSharedState, which throws when the named server does not answer.
    assert.throws(
      () => assertSharedStateForWorkers({ NODE_ENV: 'production' }),
      /NODE_ENV=production requires Redis: set REDIS_URL/
    );
    assert.throws(
      () => assertSharedStateForWorkers({ NODE_ENV: 'production', WEB_CONCURRENCY: '4' }),
      /requires Redis/
    );
    assert.doesNotThrow(() =>
      assertSharedStateForWorkers({ NODE_ENV: 'production', REDIS_URL: 'redis://127.0.0.1:6379' })
    );
    assert.doesNotThrow(() =>
      assertSharedStateForWorkers({ NODE_ENV: 'production', REDIS_TLS_URL: 'rediss://example.test:6380' })
    );
    // Development and test keep the in-process store: `npm test` must stay
    // runnable without a Redis daemon, and this is the only place that is legal.
    assert.doesNotThrow(() => assertSharedStateForWorkers({ NODE_ENV: 'development' }));
    assert.doesNotThrow(() => assertSharedStateForWorkers({ NODE_ENV: 'test' }));
  });

  test('the old single-instance premise is gone', () => {
    const handoff = read('handoff.md');
    assert.doesNotMatch(handoff, /One process, by design/, 'handoff must not claim a single process is required');
    const guard = read('tests/singleInstance.guard.test.ts');
    assert.match(guard, /instances:\s*['"]max['"]/);
  });
});
