/**
 * Write hook for the reference caches (worklist A3).
 *
 * Every master-data write goes through one of the setters in `runtimeState`, so
 * that is the single place that knows "this cache was just rewritten". A3 needs
 * exactly one thing from it: tell the other workers. The hook lives in its own
 * module with no imports so `runtimeState` does not have to import the shared
 * store — which would close a cycle back through `CACHE_LOADS` and the pool.
 */
export type ReferenceCacheWriteHook = (name: string) => void;

let hook: ReferenceCacheWriteHook | null = null;

/** Installed at boot by `state/cacheInvalidation`; `null` disables publishing. */
export function setReferenceCacheWriteHook(next: ReferenceCacheWriteHook | null): void {
  hook = next;
}

/**
 * Announce a reference-cache write. Never throws: a write must not fail because
 * the cache bus is unavailable — the local binding is already correct.
 */
export function notifyReferenceCacheWrite(name: string): void {
  if (!hook) return;
  try {
    hook(name);
  } catch {
    // Deliberately swallowed: publishing is best-effort fan-out.
  }
}
