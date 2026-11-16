/**
 * Session revocation shared across workers (SCALE-1).
 *
 * `users.ver` is still a fingerprint of the credential-bearing row, so a
 * password reset, role change, branch change or deactivation changes it. The
 * fingerprint is now cached at `session:ver:<userId>` in Redis and written by
 * every mutation that can change it. `authenticateUser`/`requireSseAuth` read
 * that key before accepting a token; a miss falls back to the local DB mirror
 * once and repopulates. A revoked account is therefore invalid on every worker
 * immediately, not only on the worker that handled the change.
 */
import type { User } from '../../../client/src/types';
import { getSharedStore, isRedisSharedState, SharedStateUnavailableError } from './sharedStore';
import { sessionFingerprint } from '../middleware/auth';
import { pgPool } from '../../db';
import { USER_SELECT_COLUMNS } from '../models/auth.repo';

const SESSION_VERSION_TTL_MS = 24 * 60 * 60 * 1000;

function keyFor(userId: string): string {
  return `session:ver:${userId}`;
}

/** Login / switch / profile update: make the new fingerprint visible to all workers. */
export async function rememberSessionVersion(user: Partial<User> & { status?: string }): Promise<void> {
  if (!isRedisSharedState() || !user?.id || !user.password) return;
  await getSharedStore().set(keyFor(user.id), sessionFingerprint(user), SESSION_VERSION_TTL_MS);
}

/** Delete/deactivate: remove the fingerprint so the DB fallback cannot accept it either. */
export async function invalidateSessionVersion(userId: string): Promise<void> {
  if (!isRedisSharedState() || !userId) return;
  await getSharedStore().del(keyFor(userId));
}

/** Alias used by admin/HR writes: the next request will read the new DB row. */
export const revokeSessionVersion = invalidateSessionVersion;

/**
 * Shared counterpart of sessionStillValid. It deliberately mirrors the local
 * rule: an unknown account is valid (request-level tests and pre-hydration
 * boot), an inactive cache row is never valid, and a token without `ver` is
 * legacy. A Redis miss performs the one DB-mirror fallback and writes it back.
 */
export async function sessionStillValidShared(
  user: { id?: string; ver?: string },
  cache: readonly Partial<User>[]
): Promise<boolean> {
  const cached = cache.find((row: any) => row.id === user.id) as any;
  if (!cached) return true;
  if (String(cached.status || 'active') !== 'active') return false;
  if (!user.ver) return true;

  const fingerprint = sessionFingerprint(cached);
  if (!isRedisSharedState()) return fingerprint === user.ver;

  const stored = await getSharedStore().get(keyFor(String(user.id)));
  if (stored !== null) return stored === user.ver;

  // One authoritative fallback on a miss. The process-local cache may be
  // stale on this worker, so a miss must not repopulate from it: read the row
  // once, cache the result, and refuse a row that no longer exists.
  let fallback = fingerprint;
  try {
    const result = await pgPool.query(
      `SELECT ${USER_SELECT_COLUMNS} FROM users WHERE id = $1`,
      [String(user.id)]
    );
    const row: any = result.rows[0];
    if (!row) return false;
    if (String(row.status || 'active') !== 'active') return false;
    fallback = sessionFingerprint(row);
  } catch (err: any) {
    throw new SharedStateUnavailableError(
      `Session fingerprint fallback failed: ${err?.message || err}`
    );
  }
  await getSharedStore().set(keyFor(String(user.id)), fallback, SESSION_VERSION_TTL_MS);
  return fallback === user.ver;
}
