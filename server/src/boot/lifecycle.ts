/**
 * lifecycle.ts — the ONE terminal-exit path for the server process.
 *
 * Three ways this process can end, all of them routed through the same writer
 * and the same exit, so a supervisor (pm2, Docker) sees the same shape of
 * evidence in every case:
 *
 *   1. FAILED BOOT — `fatal('server failed to start', err)`. The pool holds
 *      open sockets, so `process.exitCode = 1` alone leaves the event loop
 *      un-drained: the process lingers and pm2/Docker report a healthy
 *      instance while every request fails. Must hard-exit 1.
 *   2. RUNTIME FATALITY — `uncaughtException` / `unhandledRejection`. Node
 *      would already exit 1 on both (unhandled rejections throw since 15), but
 *      it exits with a raw stack trace and with no say in WHEN. Routing them
 *      here means: the reason is written synchronously in this project's
 *      FATAL format (never lost to an async stderr pipe), and the exit is a
 *      deliberate decision rather than a side effect. In development the
 *      process deliberately KEEPS RUNNING instead — `tsx watch` does not
 *      restart a dead child, so exiting on the first typo would leave
 *      `npm run dev` dead until someone touches a file.
 *   3. SIGNAL — SIGTERM/SIGINT. These were previously unhandled, so every
 *      `pm2 reload`, `docker stop` and Ctrl-C cut in-flight requests
 *      mid-response. Now the listener stops accepting, SSE streams are ended,
 *      in-flight requests finish (bounded), the pool closes, and the exit is 0.
 *
 * Why in-flight requests are COUNTED rather than inferred from
 * `server.close(cb)`: that callback only runs once every socket is gone, and a
 * client holding an idle keep-alive socket (every browser tab, every undici
 * pool) keeps it pending — the drain would always run to its full timeout on a
 * perfectly healthy shutdown. Counting `request` → `finish`/`close` measures
 * the thing being protected (responses actually being written); linger-free
 * sockets are then dropped by `closeAllConnections` once the count hits zero.
 *
 * `attachServer` must be called as soon as the listener exists (boot time),
 * not at shutdown: requests already in flight when the signal arrives were
 * counted before it arrived and must not be cut.
 *
 * The module is DB-free and takes its writer/logger/exit as injectable seams,
 * so every behaviour here is unit-testable without PostgreSQL or a real exit.
 */
import fs from 'fs';
import type { Server } from 'http';
import { intFromEnv } from '../utils/envGuard';
import { sseClients } from '../realtime/sse';

/** How long in-flight requests get to finish before their sockets are cut. */
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
/** How long the pg pool gets to close before the exit proceeds anyway. */
const POOL_CLOSE_TIMEOUT_MS = 2_000;
/** Final grace for the listener's 'close' event after its sockets are cut. */
const CLOSE_SETTLE_TIMEOUT_MS = 1_000;

export interface LifecycleDeps {
  /** Releases PostgreSQL connections. Injected to keep this module DB-free. */
  closePool(): Promise<void>;
  /** Test seams; production uses the defaults (sync fd writes, process.exit). */
  drainTimeoutMs?: number;
  exitOnFatal?: boolean;
  writeFatalLine?(text: string): void;
  log?(text: string): void;
  exit?(code: number): never;
}

/**
 * The subset of `process` this module needs — satisfied by EventEmitter too.
 * `any[]` mirrors Node's own listener signature: the args are passed through
 * untouched, and narrowing them (e.g. to `unknown[]`) would reject `process`
 * itself as an argument.
 */
export interface ProcessLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export interface Lifecycle {
  /** Registers the listener and starts counting in-flight requests. */
  attachServer(server: Server): void;
  /** Logs the reason synchronously and exits 1. Never returns. */
  fatal(phase: string, err: unknown): never;
  /** Drains, closes the pool, exits 0. Second call exits 1 immediately. */
  shutdown(signal: string): Promise<void>;
  /** Wires uncaughtException/unhandledRejection/SIGTERM/SIGINT. */
  install(target?: ProcessLike): () => void;
  /** Requests currently being handled — the drain's unit of work. */
  inFlight(): number;
}

/** Raised by the test exit seam so a test can observe the code a real exit would use. */
export class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
    this.name = 'ExitCalled';
  }
}

/** Exit seam that throws instead of terminating — for tests only. */
export function throwingExit(): (code: number) => never {
  return (code: number): never => {
    throw new ExitCalled(code);
  };
}

/**
 * `FATAL: <phase> — <action>\n<detail>\n`. The detail is the full stack when
 * there is one: a crash-loop log without the originating frame is nearly
 * useless when the failure happens inside a request handler.
 */
export function formatFatal(
  phase: string,
  err: unknown,
  action = 'exiting with code 1'
): string {
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  return `FATAL: ${phase} — ${action}\n${detail}\n`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * stderr writes to a PIPE (pm2 logs, docker logs) are asynchronous, so
 * console.error followed immediately by process.exit can lose the message
 * entirely — and a crash-loop with no reason attached is worse than no log.
 * fs.writeSync on fd 2 is synchronous, so the cause always reaches the log.
 */
function defaultWriteFatalLine(text: string): void {
  try {
    fs.writeSync(2, text);
  } catch {
    console.error(text);
  }
}

/** Same reasoning for progress lines, which are followed by an exit too. */
function defaultWriteLine(text: string): void {
  try {
    fs.writeSync(1, `${text}\n`);
  } catch {
    console.log(text);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const writeFatalLine = deps.writeFatalLine ?? defaultWriteFatalLine;
  const log = deps.log ?? defaultWriteLine;
  const drainTimeoutMs =
    deps.drainTimeoutMs ??
    intFromEnv('SHUTDOWN_TIMEOUT_MS', DEFAULT_DRAIN_TIMEOUT_MS, { min: 0, max: 300_000 });
  // Production exits on a runtime fatality; development logs and keeps serving
  // (see the header note on tsx watch).
  const exitOnFatal = deps.exitOnFatal ?? process.env.NODE_ENV === 'production';

  let server: Server | null = null;
  let inFlight = 0;
  let idleWaiters: (() => void)[] = [];
  let fatalInProgress = false;
  let shuttingDown = false;

  function attachServer(target: Server): void {
    server = target;
    target.on('request', (_req, res) => {
      inFlight += 1;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        inFlight -= 1;
        if (inFlight <= 0) {
          const waiters = idleWaiters;
          idleWaiters = [];
          for (const waiter of waiters) waiter();
        }
      };
      // 'finish' fires when the response is handed to the socket; 'close' also
      // catches a client that vanishes mid-response (an aborted request must
      // not keep the drain waiting).
      res.on('finish', finish);
      res.on('close', finish);
    });
  }

  function waitForIdle(): Promise<void> {
    if (inFlight <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => idleWaiters.push(resolve));
  }

  function fatal(phase: string, err: unknown): never {
    // A second fatal while already exiting must not re-enter the formatter: it
    // would clear the screen-worth of context written a moment ago.
    if (fatalInProgress) exit(1);
    fatalInProgress = true;
    writeFatalLine(formatFatal(phase, err));
    return exit(1);
  }

  function runtimeFatal(kind: string, err: unknown): void {
    if (shuttingDown) {
      // Nothing sane can be finished at this point; report and abandon.
      fatal(`${kind} while shutting down`, err);
    }
    if (!exitOnFatal) {
      writeFatalLine(
        formatFatal(
          kind,
          err,
          'server kept running (NODE_ENV is not "production") — state may be ' +
            'inconsistent, restart before trusting this instance'
        )
      );
      return;
    }
    fatal(kind, err);
  }

  function closeSseClients(): void {
    if (sseClients.size === 0) return;
    log(`Ending ${sseClients.size} live SSE stream(s) — they never complete on their own`);
    for (const client of sseClients) {
      try {
        client.end();
      } catch (_err) {
        // Already gone; the drain does not care either way.
      }
    }
    sseClients.clear();
  }

  async function closePoolBounded(): Promise<void> {
    try {
      const didClose = await Promise.race([
        deps.closePool().then(() => true),
        delay(POOL_CLOSE_TIMEOUT_MS).then(() => false),
      ]);
      if (!didClose) log(`pg pool did not close within ${POOL_CLOSE_TIMEOUT_MS}ms — continuing`);
    } catch (err) {
      log(`pg pool close failed during shutdown — continuing: ${describe(err)}`);
    }
  }

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      // pm2 sends SIGINT then SIGKILL after kill_timeout; a stuck drain should
      // not have to wait for the SIGKILL to be reported as abnormal.
      fatal(
        `second ${signal} while shutting down`,
        new Error('shutdown was already in progress — abandoning the drain')
      );
    }
    shuttingDown = true;

    const target = server;
    if (!target) {
      log(`Received ${signal} before the server was listening — nothing to drain; exiting 0`);
      return exit(0);
    }

    log(
      `Received ${signal} — draining ${inFlight} in-flight request(s), up to ${drainTimeoutMs}ms`
    );
    closeSseClients();

    // Stop accepting immediately: a refused connection is a clear answer, and
    // it is the only way the drain can actually reach zero in-flight work.
    let settleClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      settleClosed = resolve;
    });
    target.close(() => settleClosed());
    target.closeIdleConnections();

    let forcedClose = false;
    let forcedTimer: NodeJS.Timeout | undefined;
    const forced = new Promise<void>((resolve) => {
      forcedTimer = setTimeout(() => {
        forcedClose = true;
        resolve();
      }, drainTimeoutMs);
    });

    await Promise.race([waitForIdle(), forced]);
    // Clear it even when the drain finished early: a pending 10s timer holds
    // the event loop open (and would keep a test process alive) for no reason.
    clearTimeout(forcedTimer);
    if (forcedClose) {
      log(
        `Drain exceeded ${drainTimeoutMs}ms with ${inFlight} request(s) still running — ` +
          'force-closing those connections'
      );
    }
    // Sockets kept alive for a future request (and any SSE stream just ended)
    // hold the listener's 'close' event open without doing any work.
    target.closeAllConnections();
    await Promise.race([closed, delay(CLOSE_SETTLE_TIMEOUT_MS)]);

    await closePoolBounded();
    log('Shutdown complete — exiting 0');
    return exit(0);
  }

  function install(target: ProcessLike = process): () => void {
    const onUncaught = (err: unknown): void => runtimeFatal('uncaughtException', err);
    const onRejection = (reason: unknown): void => runtimeFatal('unhandledRejection', reason);
    const onSignal = (signal: string) => (): void => {
      // `shutdown` only rejects when the exit seam throws instead of exiting
      // (a second signal, or a test): handling it here keeps a rejected
      // shutdown from surfacing as an unhandled rejection.
      void shutdown(signal).catch((err: unknown) => {
        // ExitCalled means an exit was already requested — nothing left to do.
        if (err instanceof ExitCalled) return;
        fatal(`${signal} shutdown failed`, err);
      });
    };
    const onSigterm = onSignal('SIGTERM');
    const onSigint = onSignal('SIGINT');

    target.on('uncaughtException', onUncaught);
    target.on('unhandledRejection', onRejection);
    target.on('SIGTERM', onSigterm);
    target.on('SIGINT', onSigint);

    return () => {
      target.off('uncaughtException', onUncaught);
      target.off('unhandledRejection', onRejection);
      target.off('SIGTERM', onSigterm);
      target.off('SIGINT', onSigint);
    };
  }

  return { attachServer, fatal, shutdown, install, inFlight: () => inFlight };
}
