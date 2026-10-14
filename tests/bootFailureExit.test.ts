/**
 * Regression: a boot that FAILS must exit the process, non-zero.
 *
 * `server/index.ts` used to end with
 *
 *     startServer().catch((err) => {
 *       console.error(err?.message || err);
 *       process.exitCode = 1;          // ← never taken, no handles close
 *     });
 *
 * Setting `process.exitCode` only asks Node to exit with that code once the
 * event loop drains. A boot failure that happened AFTER the pg Pool connected
 * (schema/seed/cache errors, a listen failure, anything past the connect) left
 * the pool's sockets and the listener's handle open, so the loop never drained:
 * the process stayed ALIVE with a pending exit code. pm2 reported the instance
 * "online" and `docker run --restart always` kept the container "Up" while
 * every request failed — a corpse both supervisors considered healthy, so
 * neither ever restarted it. (Measured on the pre-fix bundle: a post-connect
 * failure was still alive at the 25s mark; the fixed one exits 1 immediately.)
 *
 * PROVES, by running the real boot entry against an unreachable database:
 *   1. the process exits BY ITSELF with code 1 — not killed by this test, and
 *      not still running when the test's patience runs out;
 *   2. the reason is actually written out (fs.writeSync on fd 2, because
 *      stderr to a pipe is asynchronous and a crash-loop with no reason in
 *      `pm2 logs` / `docker logs` is worse than no log at all).
 *
 * Determinism: DATABASE_URL and the discrete POSTGRES_* options both point at
 * a closed port (db.ts passes the discrete ones alongside the connection
 * string, and pg lets them override it), so the boot can never reach a real
 * database regardless of the host .env. No live PostgreSQL is required.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
/** Nothing can be listening here — port 1 needs root and no test opens it. */
const UNREACHABLE_PG_PORT = 1;
/** Generous: the boot entry imports express + vite + pg under tsx. */
const EXIT_TIMEOUT_MS = 60_000;

const tsxCli = (() => {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli');
  } catch {
    return path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  }
})();

interface BootAttempt {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  ms: number;
}

/**
 * Real `process.exitCode` property reads/writes in a file — the explanatory
 * comment above the handler mentions the old code, and a comment must not be
 * what fails this pin.
 */
const processExitCodeUses = (source: string, file: string): number[] => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'exitCode' &&
      node.expression.getText(sf) === 'process'
    ) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
};

/** Boot the real entry against an unreachable PostgreSQL and capture the exit. */
function bootWithUnreachableDatabase(): Promise<BootAttempt> {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [tsxCli, path.join('server', 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: `postgres://inventory_user:securepassword@127.0.0.1:${UNREACHABLE_PG_PORT}/inventory_db`,
      POSTGRES_HOST: '127.0.0.1',
      POSTGRES_PORT: String(UNREACHABLE_PG_PORT),
      PG_CONNECT_TIMEOUT_MS: '1000',
      PORT: '5199',
      // Production: no Vite middleware branch — this test only needs the boot.
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  return new Promise<BootAttempt>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), EXIT_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, ms: Date.now() - startedAt });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('failed boot exits the process instead of lingering', () => {
  let boot: BootAttempt;

  before(async () => {
    boot = await bootWithUnreachableDatabase();
  });

  test('the process exits by itself with code 1 (a supervisor must see a crash)', () => {
    assert.notEqual(
      boot.signal,
      'SIGKILL',
      `the boot process was still alive after ${EXIT_TIMEOUT_MS / 1000}s and had to be killed — ` +
        `a failed boot must exit on its own, or pm2/Docker keep reporting a live instance\n` +
        boot.output.slice(-2000)
    );
    assert.equal(
      boot.code,
      1,
      `expected exit code 1, got ${boot.code} (signal ${boot.signal}) after ${boot.ms}ms\n` +
        boot.output.slice(-2000)
    );
  });

  // The behavioural check above covers the pre-connect failure (a refused
  // connection leaves no open handle, so even the old code exited there). The
  // LINGER itself needs the source-level pin: it only appears when a failure
  // happens after the pool connected, and the cause is exactly "rely on
  // process.exitCode instead of exiting".
  test('the boot-failure handler cannot regress to a pending exitCode', () => {
    const source = fs.readFileSync(path.resolve(ROOT, 'server/index.ts'), 'utf8');
    assert.deepEqual(
      processExitCodeUses(source, 'server/index.ts'),
      [],
      'a failed boot must not rely on process.exitCode — the pg Pool keeps handles open, the ' +
        'event loop never drains, and the process lingers as an instance pm2/Docker call healthy'
    );
    assert.match(
      source,
      /function failBoot\(err: unknown\): never/,
      'the boot-failure handler must exist and never return'
    );
    assert.ok(
      source.includes("startServer().catch(failBoot)"),
      'the boot promise must funnel into failBoot'
    );
    assert.ok(
      source.includes("server.on('error', failBoot)"),
      'a listen failure (EADDRINUSE, EACCES) is a boot failure too'
    );
    assert.ok(
      /return lifecycle\.fatal\('server failed to start', err\)/.test(source),
      'failBoot must funnel into the shared fatal path — a failed boot is just one phase of it'
    );

    // The hard-exit mechanics moved to src/boot/lifecycle.ts so that the same
    // path can serve runtime fatalities and signals, and so it is testable
    // without a database or a real process exit. The contract asserted here is
    // unchanged, only its home moved; the behavioural test above still proves
    // the end-to-end exit code, and lifecycleShutdown.test.ts proves the seam.
    const lifecycleSource = fs.readFileSync(
      path.resolve(ROOT, 'server/src/boot/lifecycle.ts'),
      'utf8'
    );
    assert.ok(
      /fs\.writeSync\(2,/.test(lifecycleSource),
      'the reason must be written synchronously: stderr to a pipe (pm2/docker logs) is async and ' +
        'process.exit would drop it'
    );
    assert.ok(
      /process\.exit\(code\)/.test(lifecycleSource),
      'the default exit must be the real process.exit — a shared fatal path that only sets a ' +
        'pending exit code would reintroduce the lingering corpse'
    );
    assert.match(
      lifecycleSource,
      /return exit\(1\)/,
      'the fatal path must hard-exit with code 1'
    );
  });

  test('the failure reason reaches stderr before the exit', () => {
    assert.match(
      boot.output,
      /FATAL: server failed to start/,
      'the exit must be announced with a FATAL line on stderr'
    );
    assert.match(
      boot.output,
      /PostgreSQL startup failed/,
      'the log must name the failing stage, not just the exit code'
    );
    assert.match(boot.output, /ECONNREFUSED/, 'the underlying connection error must be preserved');
  });
});
