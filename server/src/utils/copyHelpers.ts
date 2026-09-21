// Pure copy-helpers for the readonly operational cache. Each returns a NEW
// array, never mutating the previous generation (safe under concurrent
// request reads). `mutable()` is the documented escape hatch for legacy
// demo-mode behaviors that only run when PostgreSQL is unreachable.

/**
 * Pure copy-helpers for the readonly operational cache. Each returns a NEW
 * array, never mutating the previous generation (safe under concurrent
 * request reads). `mutable()` is the documented escape hatch for legacy
 * demo-mode (non-PG) in-memory behaviors that only run when isPgConnected
 * is false; in PG mode those mirror writes are discarded by the next
 * refreshOperationalCache() swap.
 */
export function withPrepended<T>(arr: readonly T[], item: T): T[] {
  return [item, ...arr];
}
export function withAppended<T>(arr: readonly T[], item: T): T[] {
  return [...arr, item];
}
export function withReplaced<T>(arr: readonly T[], index: number, item: T): T[] {
  if (index < 0 || index >= arr.length) return [...arr];
  const next = arr.slice();
  next[index] = item;
  return next;
}
export function withSorted<T>(arr: readonly T[], compare: (a: T, b: T) => number): T[] {
  return [...arr].sort(compare);
}
export function mutable<T>(arr: readonly T[]): T[] {
  return arr as T[];
}
