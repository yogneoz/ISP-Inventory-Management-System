/**
 * The lifecycle across a REAL process boundary.
 *
 * lifecycleShutdown.test.ts proves the drain decisions with injected seams.
 * This file proves the things only a real process can show:
 *
 *   - an uncaught exception / unhandled rejection actually exits with code 1
 *     (not a signal, not a timeout) and the reason is on stderr;
 *   - in development the SAME failure leaves the process alive, because
 *     `tsx watch` does not restart a crashed child and an exit there would
 *     leave `npm run dev` dead until someone touches a file;
 *   - a SIGTERM lets an in-flight response finish and exits 0;
 *   - a second signal during a stuck drain exits 1 without waiting it out;
 *   - SHUTDOWN_TIMEOUT_MS actually bounds the drain.
 *
 * The probe (tests/fixtures/lifecycleProbe.ts) wires the lifecycle to a bare
 * http server, so none of this needs PostgreSQL. Signals are delivered over
 * the probe's stdin via `process.emit`, which invokes exactly the listeners a
 * real signal would; the one test that uses real OS delivery is skipped on
 * Windows, where Node cannot deliver a POSIX signal to a child at all.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';

const ROOT = process.cwd();
/** Long enough to cover a tsx boot plus a deliberately-stuck drain. */
const EXIT_TIMEOUT_MS = 45_000;

const tsxCli = (() => {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli');
  } catch {
    return path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  }
})();

interface ProbeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
}

interface Probe {
  child: ChildProcess;
  output: () => string;
  exited: Promise<ProbeExit>;
  hasExited: () => boolean;
  /** Sends a signal NAME over stdin; the probe turns it into process.emit. */
  signal: (name: 'SIGTERM' | 'SIGINT') => void;
}

function spawnProbe(mode: string, env: NodeJS.ProcessEnv): Probe {
  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    [tsxCli, path.join('tests', 'fixtures', 'lifecycleProbe.ts'), mode],
    {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  let output = '';
  let exited = false;
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));

  const exitedPromise = new Promise<ProbeExit>((resolve, reject) => {
    // A fail-safe: if the probe hangs, kill it so the assertion below reports a
    // SIGKILL rather than the suite hanging forever.
    const failSafe = setTimeout(() => child.kill('SIGKILL'), EXIT_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(failSafe);
      exited = true;
      resolve({ code, signal, ms: Date.now() - startedAt });
    });
    child.on('error', (err) => {
      clearTimeout(failSafe);
      reject(err);
    });
  });

  return {
    child,
    output: () => output,
    exited: exitedPromise,
    hasExited: () => exited,
    signal: (name) => {
      child.stdin?.write(`${name}\n`);
    },
  };
}

async function waitForOutput(probe: Probe, pattern: RegExp, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (pattern.test(probe.output())) return;
    if (probe.hasExited()) break;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(
    `timed out waiting for ${label} (${pattern})${probe.hasExited() ? ' — the probe exited' : ''}\n` +
      probe.output().slice(-2_000)
  );
}

async function probePort(probe: Probe): Promise<number> {
  await waitForOutput(probe, /PROBE LISTENING \d+/, 'the probe server to listen');
  const match = probe.output().match(/PROBE LISTENING (\d+)/);
  assert.ok(match, `the probe must announce its port:\n${probe.output()}`);
  return Number(match[1]);
}

function request(port: number, requestPath: string): { body: Promise<string>; destroy: () => void } {
  const req = http.request({ host: '127.0.0.1', port, path: requestPath });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Both fatal modes, with the expectations that differ between NODE_ENVs. */
const FATAL_MODES = [
  { mode: 'fatal-throw', phase: 'uncaughtException', marker: 'probe-boom' },
  { mode: 'fatal-reject', phase: 'unhandledRejection', marker: 'probe-rejection' },
] as const;

describe('runtime fatality in a real process', () => {
  for (const { mode, phase, marker } of FATAL_MODES) {
    test(`${phase}: production exits 1 by itself and names the cause`, async () => {
      const probe = spawnProbe(mode, { NODE_ENV: 'production' });
      const exit = await probe.exited;

      assert.equal(
        exit.signal,
        null,
        `the process must exit on its own, not be killed — it was still alive after ${exit.ms}ms\n` +
          probe.output().slice(-2_000)
      );
      assert.equal(exit.code, 1, `expected exit code 1, got ${exit.code}\n${probe.output().slice(-2_000)}`);
      assert.match(probe.output(), new RegExp(`FATAL: ${phase} — exiting with code 1`));
      assert.match(probe.output(), new RegExp(marker), 'the originating error must survive into the log');
    });

    test(`${phase}: development logs it but keeps the dev server alive`, async () => {
      const probe = spawnProbe(mode, { NODE_ENV: 'development' });
      await waitForOutput(probe, new RegExp(`FATAL: ${phase}`), 'the fatal line');

      // The handler has already run; now prove the process survived it.
      await delay(1_500);
      assert.equal(
        probe.hasExited(),
        false,
        'development must not exit: tsx watch does not restart a crashed child, so an exit here leaves ' +
          `npm run dev dead until a file changes\n${probe.output().slice(-2_000)}`
      );
      assert.match(
        probe.output(),
        /state may be inconsistent, restart before trusting this instance/,
        'a surviving process must be told its state is suspect, not just that something failed'
      );

      probe.child.kill('SIGKILL');
      await probe.exited;
    });
  }
});

describe('signal-driven shutdown in a real process', () => {
  test('SIGTERM lets an in-flight response finish and exits 0', async () => {
    const probe = spawnProbe('serve', { NODE_ENV: 'production', SHUTDOWN_TIMEOUT_MS: '5000' });
    const port = await probePort(probe);

    const inflight = request(port, '/slow');
    await waitForOutput(probe, /PROBE INFLIGHT/, 'the request to be in flight');
    probe.signal('SIGTERM');

    assert.equal(
      await inflight.body,
      'slow-done',
      'the response being written when the signal arrived must complete'
    );
    const exit = await probe.exited;
    assert.equal(exit.signal, null, 'a handled signal must not kill the process');
    assert.equal(exit.code, 0, `a drained shutdown exits 0, got ${exit.code}\n${probe.output().slice(-2000)}`);
    assert.match(probe.output(), /Received SIGTERM — draining 1 in-flight request\(s\)/);
    assert.match(probe.output(), /Shutdown complete — exiting 0/);
  });

  test('a second signal abandons a stuck drain and exits 1', async () => {
    const probe = spawnProbe('serve', { NODE_ENV: 'production', SHUTDOWN_TIMEOUT_MS: '10000' });
    const port = await probePort(probe);

    const hung = request(port, '/hang');
    hung.body.catch(() => {});
    await waitForOutput(probe, /PROBE INFLIGHT/, 'the hung request to be in flight');
    probe.signal('SIGTERM');
    await waitForOutput(probe, /draining 1 in-flight/, 'the drain to start');
    probe.signal('SIGTERM');

    const exit = await probe.exited;
    assert.equal(exit.code, 1, `the abandoned drain must be a crash, got ${exit.code}`);
    assert.match(probe.output(), /FATAL: second SIGTERM while shutting down/);
    assert.ok(
      exit.ms < 8_000,
      `it must not wait out the 10s drain before reporting (took ${exit.ms}ms)`
    );
  });

  test('SHUTDOWN_TIMEOUT_MS bounds the drain and force-closes what is left', async () => {
    const probe = spawnProbe('serve', { NODE_ENV: 'production', SHUTDOWN_TIMEOUT_MS: '300' });
    const port = await probePort(probe);

    const hung = request(port, '/hang');
    hung.body.catch(() => {});
    await waitForOutput(probe, /PROBE INFLIGHT/, 'the hung request to be in flight');
    const startedAt = Date.now();
    probe.signal('SIGTERM');

    const exit = await probe.exited;
    assert.equal(exit.code, 0, 'a forced close is still a clean shutdown, not a crash');
    assert.match(probe.output(), /Drain exceeded 300ms with 1 request\(s\) still running/);
    assert.ok(
      Date.now() - startedAt < 5_000,
      'the configured bound must be what ends the drain, not the fail-safe'
    );
  });

  test(
    'a real OS SIGTERM (not process.emit) drains and exits 0',
    {
      skip:
        process.platform === 'win32'
          ? 'Windows cannot deliver a POSIX signal to a child — Node terminates it instead of running ' +
            'the handlers, so real-signal delivery is covered on Linux (CI) only'
          : false,
    },
    async () => {
      const probe = spawnProbe('serve', { NODE_ENV: 'production', SHUTDOWN_TIMEOUT_MS: '5000' });
      const port = await probePort(probe);

      const inflight = request(port, '/slow');
      await waitForOutput(probe, /PROBE INFLIGHT/, 'the request to be in flight');
      probe.child.kill('SIGTERM');

      assert.equal(await inflight.body, 'slow-done');
      const exit = await probe.exited;
      assert.equal(exit.signal, null, 'the SIGTERM handler must win over the default kill');
      assert.equal(exit.code, 0);
    }
  );
});
