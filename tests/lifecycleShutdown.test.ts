/**
 * The process-lifecycle contract, with no PostgreSQL and no real exit.
 *
 * `server/index.ts` used to have exactly one terminal path (a failed boot) and
 * NO path for the other two ways a Node server ends: a runtime fatality
 * (uncaughtException / unhandledRejection) and a signal. Every `pm2 reload`,
 * `docker stop` and Ctrl-C therefore cut in-flight requests mid-response, and
 * a runtime error relied on Node's default dump-and-die.
 *
 * These tests drive server/src/boot/lifecycle.ts through its injected seams
 * (a fake exit that throws instead of terminating, a captured writer/logger)
 * against REAL http servers, so the drain decisions are measured rather than
 * asserted from the source:
 *
 *   - a response already being written finishes, new connections are refused;
 *   - an idle keep-alive socket does NOT hold the drain to its full timeout
 *     (the reason in-flight requests are counted instead of waiting on
 *     `server.close`'s callback, which never fires while a client keeps a
 *     socket pooled);
 *   - a request that never completes is force-closed at the timeout;
 *   - a second signal abandons the drain and exits 1;
 *   - SSE streams are ended up front, because they never complete on their own;
 *   - a fatal exits 1 in production but only logs in development (`tsx watch`
 *     does not restart a crashed child, so exiting there kills `npm run dev`
 *     until someone touches a file).
 *
 * tests/lifecycleProcess.test.ts covers the same wiring across a real process
 * boundary (real exit codes, real stderr), including a real SIGTERM on
 * platforms that can deliver one.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { createLifecycle, ExitCalled } from '../server/src/boot/lifecycle';
import type { Lifecycle, LifecycleDeps } from '../server/src/boot/lifecycle';
import { sseClients } from '../server/src/realtime/sse';

/** Records what production would have written and exited with. */
function makeLifecycle(overrides: Partial<LifecycleDeps> = {}): {
  lifecycle: Lifecycle;
  fatalLines: string[];
  lines: string[];
  exits: number[];
  poolCloses: () => number;
} {
  const fatalLines: string[] = [];
  const lines: string[] = [];
  const exits: number[] = [];
  let poolCloses = 0;
  const lifecycle = createLifecycle({
    closePool: async () => {
      poolCloses += 1;
    },
    exit: (code: number): never => {
      exits.push(code);
      throw new ExitCalled(code);
    },
    writeFatalLine: (text) => fatalLines.push(text),
    log: (text) => lines.push(text),
    ...overrides,
  });
  return { lifecycle, fatalLines, lines, exits, poolCloses: () => poolCloses };
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** Raw client (not fetch) so the socket's fate after the drain is observable. */
function request(port: number, path: string): { body: Promise<string>; destroy: () => void } {
  const req = http.request({ host: '127.0.0.1', port, path });
  const body = new Promise<string>((resolve, reject) => {
    req.on('response', (res) => {
      const chunks: string[] = [];
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => chunks.push(chunk));
      res.on('end', () => resolve(chunks.join('')));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
  req.end();
  return { body, destroy: () => req.destroy() };
}

/** One refused connection: ECONNREFUSED is the only acceptable answer. */
function probeRefused(port: number): Promise<string> {
  return new Promise((resolve) => {
    const probe = http.request({ host: '127.0.0.1', port, path: '/after-shutdown' });
    probe.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
    probe.on('response', () => resolve('accepted'));
    probe.end();
  });
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

describe('graceful shutdown', () => {
  test('drains an in-flight response, refuses new connections, exits 0', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const { server, port } = await listen(async (_req, res) => {
      entered += 1;
      await gate;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('finished');
    });

    // 5s drain budget: if the implementation waited on `server.close`'s
    // callback instead of the in-flight count, this test would take 5s.
    const { lifecycle, lines, exits, poolCloses } = makeLifecycle({ drainTimeoutMs: 5_000 });
    lifecycle.attachServer(server);

    const inflight = request(port, '/slow');
    await waitFor(() => entered === 1, 'the request handler to start');

    const startedAt = Date.now();
    const shutdown = lifecycle.shutdown('SIGTERM');
    // Observed below with assert.rejects; the immediate handler keeps node:test
    // from reporting the exit seam's throw as an unhandled rejection while this
    // test is busy asserting the drain.
    shutdown.catch(() => {});
    await waitFor(() => lines.some((line) => line.includes('draining 1 in-flight')), 'the drain to start');

    assert.equal(
      await probeRefused(port),
      'ECONNREFUSED',
      'the listener must stop accepting as soon as the signal arrives — otherwise the drain can never reach zero'
    );

    release();
    assert.equal(await inflight.body, 'finished', 'an in-flight response must not be cut');

    await assert.rejects(
      shutdown,
      (err: unknown) => err instanceof ExitCalled && err.code === 0,
      'a clean shutdown must exit 0'
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed < 2_000,
      `shutdown took ${elapsed}ms — an idle keep-alive socket must not hold the drain to its full ` +
        'timeout (in-flight requests are counted for exactly this reason)'
    );
    assert.deepEqual(exits, [0]);
    assert.equal(poolCloses(), 1, 'the pool must be released before the exit');
    assert.equal(lifecycle.inFlight(), 0);
  });

  test('a request that never completes is force-closed at the drain timeout', async () => {
    const { server, port } = await listen(() => {
      /* never responds */
    });
    const { lifecycle, lines, exits } = makeLifecycle({ drainTimeoutMs: 150 });
    lifecycle.attachServer(server);

    const hung = request(port, '/hang');
    hung.body.catch(() => {}); // its rejection is asserted below
    await waitFor(() => lifecycle.inFlight() === 1, 'the hung request to be counted');

    const startedAt = Date.now();
    await assert.rejects(
      lifecycle.shutdown('SIGTERM'),
      (err: unknown) => err instanceof ExitCalled && err.code === 0,
      'a shutdown that has to force-close connections still exits 0'
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 3_000, `the drain must be bounded by SHUTDOWN_TIMEOUT_MS, took ${elapsed}ms`);
    assert.ok(
      lines.some((line) => /Drain exceeded 150ms with 1 request\(s\) still running/.test(line)),
      `the forced close must say what was cut, got:\n${lines.join('\n')}`
    );
    assert.deepEqual(exits, [0]);
    // The destroyed socket's 'close' event lands a tick later; the counter must
    // settle rather than remembering the request that was cut.
    await waitFor(() => lifecycle.inFlight() === 0, 'the cut request to be released from the count');
  });

  test('an SSE stream is ended up front so it cannot hold the drain open', async () => {
    const { server } = await listen((_req, res) => res.end('ok'));
    const { lifecycle, lines } = makeLifecycle({ drainTimeoutMs: 200 });
    lifecycle.attachServer(server);

    const ended: string[] = [];
    const fakeClient = {
      end: () => ended.push('end'),
      write: () => true,
    } as unknown as import('express').Response;
    sseClients.add(fakeClient);
    try {
      await assert.rejects(
        lifecycle.shutdown('SIGTERM'),
        (err: unknown) => err instanceof ExitCalled && err.code === 0
      );
    } finally {
      sseClients.delete(fakeClient);
    }

    assert.deepEqual(ended, ['end'], 'the live stream must be closed, not left dangling');
    assert.equal(sseClients.has(fakeClient), false);
    assert.ok(
      lines.some((line) => line.includes('Ending 1 live SSE stream')),
      `the count of ended streams must be logged, got:\n${lines.join('\n')}`
    );
  });

  test('a second signal abandons the drain and exits 1', async () => {
    const { server, port } = await listen(() => {
      /* never responds */
    });
    const { lifecycle, fatalLines, lines, exits } = makeLifecycle({ drainTimeoutMs: 5_000 });
    lifecycle.attachServer(server);

    const hung = request(port, '/hang');
    hung.body.catch(() => {});
    await waitFor(() => lifecycle.inFlight() === 1, 'the hung request to be counted');

    const first = lifecycle.shutdown('SIGTERM');
    first.catch(() => {});
    await waitFor(() => lines.some((line) => line.includes('draining 1 in-flight')), 'the drain to start');

    await assert.rejects(
      lifecycle.shutdown('SIGINT'),
      (err: unknown) => err instanceof ExitCalled && err.code === 1,
      'a second signal must not wait for the drain that is already stuck'
    );
    assert.match(
      fatalLines.join(''),
      /FATAL: second SIGINT while shutting down/,
      'the abandoned drain must be reported, not silently dropped'
    );

    // Unblock the first drain so the test leaves nothing running.
    hung.destroy();
    await first.catch(() => {});
    assert.deepEqual(exits, [1, 0], 'the second signal exits 1, then the drained one exits 0');
  });

  test('a signal before the listener exists exits 0 without pretending to drain', async () => {
    const { lifecycle, lines, exits, poolCloses } = makeLifecycle();
    await assert.rejects(
      lifecycle.shutdown('SIGTERM'),
      (err: unknown) => err instanceof ExitCalled && err.code === 0
    );
    assert.deepEqual(exits, [0]);
    assert.equal(poolCloses(), 0, 'nothing was drained, so the pool path must not be reached');
    assert.ok(
      lines.some((line) => line.includes('before the server was listening')),
      'the boot-window signal must say why there was nothing to drain'
    );
  });
});

/**
 * `target.emit` is how these tests reach the installed handlers. With the test
 * exit seam an exit THROWS (that is what `never` means here), so the throw has
 * to be caught to observe it; a real process.exit would simply not return.
 */
function emitHarness(target: EventEmitter, event: string, err: unknown): unknown {
  try {
    target.emit(event, err);
    return null;
  } catch (caught) {
    return caught;
  }
}

describe('runtime fatality', () => {
  test('an uncaught exception exits 1 and writes the reason synchronously', () => {
    const { lifecycle, fatalLines, exits } = makeLifecycle({ exitOnFatal: true });
    const target = new EventEmitter();
    lifecycle.install(target);

    const caught = emitHarness(target, 'uncaughtException', new Error('boom'));

    assert.ok(caught instanceof ExitCalled && caught.code === 1, 'the handler must exit 1');
    assert.deepEqual(exits, [1]);
    assert.match(
      fatalLines.join(''),
      /FATAL: uncaughtException — exiting with code 1\nError: boom/,
      'the cause must be in the FATAL line: a crash loop with no reason is worse than no log'
    );
  });

  test('an unhandled rejection is a runtime fatality too', () => {
    const { lifecycle, fatalLines, exits } = makeLifecycle({ exitOnFatal: true });
    const target = new EventEmitter();
    lifecycle.install(target);

    const caught = emitHarness(target, 'unhandledRejection', new Error('nope'));

    assert.ok(caught instanceof ExitCalled && caught.code === 1);
    assert.deepEqual(exits, [1], 'since Node 15 an unhandled rejection is fatal by default; say so in our format');
    assert.match(fatalLines.join(''), /FATAL: unhandledRejection/);
  });

  test('in development the failure is loud but the process keeps serving', () => {
    const { lifecycle, fatalLines, lines, exits } = makeLifecycle({ exitOnFatal: false });
    const target = new EventEmitter();
    lifecycle.install(target);

    const uncaught = emitHarness(target, 'uncaughtException', new Error('boom'));
    const rejection = emitHarness(target, 'unhandledRejection', new Error('nope'));

    assert.equal(uncaught, null, 'development must not exit on an uncaught exception');
    assert.equal(rejection, null, 'development must not exit on an unhandled rejection');
    assert.deepEqual(
      exits,
      [],
      'exiting here would leave `npm run dev` dead: tsx watch does not restart a crashed child'
    );
    assert.match(fatalLines.join(''), /FATAL: uncaughtException/);
    assert.match(
      fatalLines.join(''),
      /server kept running \(NODE_ENV is not "production"\)/,
      'the log must say the process survived AND that its state may be inconsistent'
    );
    assert.match(fatalLines.join(''), /FATAL: unhandledRejection/);
    assert.equal(lines.length, 0, 'a fatal is not a progress line');
  });

  test('a fatality during the drain is not swallowed by the in-progress shutdown', async () => {
    const { server, port } = await listen(() => {
      /* never responds */
    });
    const { lifecycle, fatalLines, lines, exits } = makeLifecycle({
      drainTimeoutMs: 5_000,
      exitOnFatal: true,
    });
    lifecycle.attachServer(server);
    const target = new EventEmitter();
    lifecycle.install(target);

    const hung = request(port, '/hang');
    hung.body.catch(() => {});
    await waitFor(() => lifecycle.inFlight() === 1, 'the hung request to be counted');

    const first = lifecycle.shutdown('SIGTERM');
    first.catch(() => {});
    await waitFor(() => lines.some((line) => line.includes('draining 1 in-flight')), 'the drain to start');

    const caught = emitHarness(target, 'uncaughtException', new Error('during-drain'));

    assert.ok(caught instanceof ExitCalled && caught.code === 1);
    assert.deepEqual(exits, [1], 'a crash while draining must still be reported as a crash');
    assert.match(fatalLines.join(''), /FATAL: uncaughtException while shutting down/);

    hung.destroy();
    await first.catch(() => {});
  });

  test('the fatal writer refuses to re-enter once an exit is in progress', () => {
    const { lifecycle, fatalLines, exits } = makeLifecycle({ exitOnFatal: true });
    // A second fatal can only be reached through the exit seam throwing, which
    // is what a real process.exit never does — assert the guard directly so a
    // future refactor cannot drop it.
    assert.throws(() => lifecycle.fatal('first', new Error('one')));
    assert.throws(() => lifecycle.fatal('second', new Error('two')));
    assert.deepEqual(exits, [1, 1]);
    assert.equal(fatalLines.length, 1, 'the context written a moment ago must not be overwritten');
  });
});
