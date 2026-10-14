/**
 * Probe fixture for tests/lifecycleProcess.test.ts — NOT a test file itself
 * (scripts/run_tests.mjs globs `tests/*.test.ts`, so nothing under tests/fixtures
 * is picked up as a suite).
 *
 * It exists because the lifecycle behaviours worth proving end-to-end are
 * process-level ones: does an uncaught exception actually exit 1 with the
 * reason on stderr, does a drained SIGTERM actually let an in-flight response
 * finish and exit 0. Those need a real process with the real handlers
 * installed, and they need no PostgreSQL — this fixture wires the lifecycle to
 * a bare http server, so the suite stays hermetic.
 *
 * Signals arrive over stdin rather than from `child.kill()`: on Windows Node
 * cannot deliver a POSIX signal to a child (it terminates it instead of
 * running its handlers), and `process.emit('SIGTERM')` invokes exactly the
 * listeners real delivery would. The one test that does use a real signal is
 * skipped on Windows for that reason.
 *
 * Modes (argv[2]):
 *   fatal-throw   — throws from a timer       (uncaughtException)
 *   fatal-reject  — rejects with no handler   (unhandledRejection)
 *   serve         — http server + lifecycle, driven by stdin signal lines
 *   idle          — nothing happens (baseline for "still alive" assertions)
 *
 * stdout protocol consumed by the test: `PROBE LISTENING <port>`,
 * `PROBE INFLIGHT`.
 */
import http from 'node:http';
import { createLifecycle } from '../../server/src/boot/lifecycle';

const mode = process.argv[2] ?? 'idle';

// The pool seam closes nothing here — this fixture never opens a pool, and a
// real one would keep the probe's exit code from being attributable to the
// lifecycle.
const lifecycle = createLifecycle({ closePool: async () => {} });
lifecycle.install();

function stayAlive(): void {
  setInterval(() => {}, 1000);
}

if (mode === 'fatal-throw') {
  stayAlive();
  setTimeout(() => {
    throw new Error('probe-boom');
  }, 10);
} else if (mode === 'fatal-reject') {
  stayAlive();
  setTimeout(() => {
    // Deliberately unhandled: this is the event under test.
    void Promise.reject(new Error('probe-rejection'));
  }, 10);
} else if (mode === 'serve') {
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      process.stdout.write('PROBE INFLIGHT\n');
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('slow-done');
      }, 300);
      return;
    }
    if (req.url === '/hang') {
      // Never responds: the drain timeout is the only way out.
      process.stdout.write('PROBE INFLIGHT\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  server.listen(0, '127.0.0.1', () => {
    lifecycle.attachServer(server);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    process.stdout.write(`PROBE LISTENING ${port}\n`);
  });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line === 'SIGTERM' || line === 'SIGINT') process.emit(line);
    }
  });
} else {
  stayAlive();
  process.stdout.write('PROBE IDLE\n');
}
