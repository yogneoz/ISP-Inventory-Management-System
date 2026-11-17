/**
 * The bootstrap payload version, shared across workers (SCALE-4's real gap).
 *
 * OPS-2 made every successful write advance `stateVersion`, and the bootstrap
 * controller derives its weak ETag from it. That counter lived only in
 * `runtimeState.ts`, i.e. per worker: with `ecosystem.config.js` running
 * `instances: 'max'`, a write handled by worker A left worker B's counter — and
 * therefore its ETag — untouched, so B could answer `304 Not Modified` for a
 * payload that had already changed. Nothing else in the validator is
 * worker-local (there is no post-write cache reload to invalidate), so this
 * counter was the whole gap.
 *
 *   - single worker / no Redis -> the in-memory counter, exactly as before;
 *   - Redis                    -> `isp:state:version`, INCR on write, GET before
 *                                 the validator is computed;
 *   - any store error          -> fall back to the local counter: a stale 304
 *                                 for a moment is the pre-change behaviour and
 *                                 must never fail a request.
 *
 * Agreement, not monotonic growth, is what makes a validator correct. Workers
 * disagreeing about the value is the bug; the absolute number means nothing.
 *
 * Residual, accepted: the write is recorded from `res.on('finish')` without
 * being awaited (the response is already on the wire), so a client that
 * revalidates within one Redis round trip of its own write can still get a 304.
 * The next write closes the window, and `user.ver` in the ETag scope already
 * covers changes to the caller's own role, scope and status.
 */
import { getSharedStore } from './sharedStore';
import { bumpStateVersion, getStateVersion, setStateVersion } from './runtimeState';

/** The Redis key that holds the cluster-wide payload version. */
export const STATE_VERSION_KEY = 'isp:state:version';

let warned = false;

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`Bootstrap version: ${message} (falling back to this worker's counter).`);
}

/**
 * Adopt the cluster counter before the ETag is computed. Also seeds the key on
 * the first call of a fresh Redis, so the counter starts from this worker's
 * value instead of jumping to 1 and colliding with an older validator.
 */
export async function adoptSharedStateVersion(): Promise<number> {
  const store = getSharedStore();
  if (store.kind !== 'redis') return getStateVersion();
  try {
    const raw = await store.get(STATE_VERSION_KEY);
    if (raw === null) {
      await store.set(STATE_VERSION_KEY, String(getStateVersion()));
      return getStateVersion();
    }
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) setStateVersion(parsed);
    return getStateVersion();
  } catch (err: any) {
    warnOnce(err?.message || String(err));
    return getStateVersion();
  }
}

/**
 * Record one committed write. The shared INCR is the authoritative value when
 * Redis answers; otherwise the local counter is still bumped so a single-worker
 * install (and the fail-open path) keeps invalidating its own ETags.
 */
export async function recordWriteStateVersion(): Promise<number> {
  const store = getSharedStore();
  if (store.kind !== 'redis') {
    bumpStateVersion();
    return getStateVersion();
  }
  try {
    const next = await store.incr(STATE_VERSION_KEY);
    setStateVersion(next);
    return next;
  } catch (err: any) {
    warnOnce(err?.message || String(err));
    bumpStateVersion();
    return getStateVersion();
  }
}
