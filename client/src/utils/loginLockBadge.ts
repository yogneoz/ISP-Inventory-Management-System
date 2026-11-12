/**
 * The sidebar's "N locked" badge.
 *
 * The sign-in limiter lives in the server's memory and its only read is
 * `GET /api/auth/rate-limit`, gated on `admin-users`. Polling from App would
 * re-render the whole tab tree on every tick, so the count lives in this tiny
 * external store instead: one read on mount, one when the window regains
 * focus, and the Login Locks screen republishes what it already fetched after
 * a load or a release. A failed read leaves the last known count alone.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../services/api';

let count = 0;
const listeners = new Set<() => void>();

export const getLoginLockCount = (): number => count;

export const subscribeLoginLockCount = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const publishLoginLockCount = (next: number): void => {
  const safe = Number.isFinite(next) ? Math.max(0, Math.trunc(next)) : 0;
  if (safe === count) return;
  count = safe;
  for (const listener of listeners) listener();
};

export const refreshLoginLockCount = async (): Promise<number> => {
  try {
    const res = await api.getRateLimitBlocks();
    publishLoginLockCount(Array.isArray(res?.blocks) ? res.blocks.length : 0);
  } catch {
    // Signed out, offline or not an administrator: the badge keeps its last
    // value; the Login Locks screen is where a failure is reported.
  }
  return count;
};

/** Subscribes the rail to the count and keeps it fresh while it is visible. */
export const useLoginLockCount = (enabled: boolean): number => {
  const current = useSyncExternalStore(subscribeLoginLockCount, getLoginLockCount, getLoginLockCount);

  useEffect(() => {
    if (!enabled) {
      publishLoginLockCount(0);
      return;
    }
    void refreshLoginLockCount();
    const onFocus = () => {
      void refreshLoginLockCount();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled]);

  return enabled ? current : 0;
};
