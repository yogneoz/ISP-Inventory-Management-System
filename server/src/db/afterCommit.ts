/**
 * Post-commit side effects (audit 2026-11-28, finding C1).
 *
 * `logAuditEvent` used to broadcast its SSE events (and prepend the audit
 * mirror) the moment it built the row — which, on the transactional write path,
 * is *inside* BEGIN…COMMIT. Two consequences, both observable:
 *
 *  - a client received "invoice CREATED" and immediately re-read the slice
 *    against a database where the invoice did not exist yet, so the refresh
 *    came back without it and the row vanished from the screen;
 *  - a write that then failed (insufficient stock, closed period, deadlock
 *    victim) still told every connected client that something had happened,
 *    and left a phantom row in the in-process audit mirror.
 *
 * A broadcast is an assertion that a change is visible. It may only be made
 * once the transaction that produced the change has committed. This module is
 * that boundary: callers register a callback, and `withTransaction` runs them
 * after COMMIT and discards them on ROLLBACK.
 *
 * `AsyncLocalStorage` (not a module-global stack) because concurrent requests
 * interleave at every await: a plain variable would attach one request's
 * broadcast to another request's transaction.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type AfterCommitCallback = () => void;

interface AfterCommitStore {
  callbacks: AfterCommitCallback[];
  settled: boolean;
}

const storage = new AsyncLocalStorage<AfterCommitStore>();

/**
 * Runs `run` inside a fresh post-commit scope. Nested calls each get their own
 * scope, which is what `replayOnContention` needs: a retried attempt must not
 * inherit the callbacks of the attempt that was aborted.
 */
export async function runWithAfterCommit<T>(run: () => Promise<T>): Promise<T> {
  return storage.run({ callbacks: [], settled: false }, run);
}

/**
 * Registers `callback` to run when the surrounding transaction commits.
 *
 * Outside a transaction scope — the demo/no-PG path, CLI scripts, and anything
 * already past COMMIT — the callback runs immediately, so behaviour is
 * unchanged for callers that never had a transaction to wait for.
 */
export function registerAfterCommit(callback: AfterCommitCallback): void {
  const store = storage.getStore();
  if (!store || store.settled) {
    callback();
    return;
  }
  store.callbacks.push(callback);
}

/** Runs every registered callback, once, in registration order. */
export function flushAfterCommit(): void {
  const store = storage.getStore();
  if (!store || store.settled) return;
  store.settled = true;
  const pending = store.callbacks.splice(0);
  for (const callback of pending) {
    try {
      callback();
    } catch (err: any) {
      // A refused refresh must never turn a committed write into a 500: the
      // data is durable, the notification is best-effort.
      console.error('post-commit side effect failed:', err?.message || err);
    }
  }
}

/** Drops every registered callback: the transaction rolled back. */
export function discardAfterCommit(): void {
  const store = storage.getStore();
  if (!store) return;
  store.callbacks.length = 0;
  store.settled = true;
}
