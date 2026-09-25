/**
 * Super Admin re-authorization gate extracted from app.ts (backlog item #6 —
 * app.ts extraction). Fiscal period lock/unlock requires a verified Super
 * Admin email + password (server-side check, independent of the session
 * role). Tries PostgreSQL first, falls back to the in-memory user cache.
 */
import { pgPool } from '../../db';
import { verifyPassword } from '../middleware/auth';
import { users, getPgConnected } from '../state/runtimeState';

export async function verifySuperAdminCredentials(
  emailInput: unknown,
  passwordInput: unknown
): Promise<{ ok: boolean; email?: string; message?: string }> {
  const cleanEmail = typeof emailInput === 'string' ? emailInput.trim().toLowerCase() : '';
  const password = String(passwordInput || '');
  if (!cleanEmail || !password) {
    return { ok: false, message: 'Super Admin email and password are required to authorize this action.' };
  }

  if (getPgConnected()) {
    try {
      const dbRes = await pgPool.query(
        'SELECT id, email, password, role FROM users WHERE LOWER(email) = LOWER($1)',
        [cleanEmail]
      );
      const dbUser = dbRes.rows[0];
      if (!dbUser || dbUser.role !== 'SUPER_ADMIN') {
        return { ok: false, message: 'Authorization failed: only a Super Admin account can lock or unlock a fiscal period.' };
      }
      const check = verifyPassword(password, dbUser.password);
      if (!check.valid) return { ok: false, message: 'Authorization failed: invalid Super Admin email or password.' };
      if (check.upgradedHash) {
        await pgPool
          .query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [
            check.upgradedHash,
            dbUser.id,
          ])
          .catch((e: any) => console.error('users password hash upgrade failed:', e?.message || e));
      }
      return { ok: true, email: dbUser.email };
    } catch (_err) {
      // fall through to the in-memory user list if the DB query fails
    }
  }

  const localUser = users.find((u) => u.email.toLowerCase() === cleanEmail);
  if (!localUser || localUser.role !== 'SUPER_ADMIN') {
    return { ok: false, message: 'Authorization failed: only a Super Admin account can lock or unlock a fiscal period.' };
  }
  const check = verifyPassword(password, localUser.password || '');
  if (!check.valid) return { ok: false, message: 'Authorization failed: invalid Super Admin email or password.' };
  return { ok: true, email: localUser.email };
}
