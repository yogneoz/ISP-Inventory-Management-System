/**
 * Auth controller — HTTP orchestration for authentication endpoints.
 * Routes forward here; payload basics are validated, the app-level shared
 * state and data access are invoked, and responses are sent. Business rules
 * live in services/, DB access in repositories/models/.
 *
 * Errors are thrown as ApiError and converted to HTTP responses by the
 * central error middleware (errors/errorHandler.ts). PostgreSQL failures are
 * converted to the endpoint's established 503 response; everything else
 * propagates.
 */
import type { Request, Response } from 'express';
import { ApiError } from '../errors/ApiError';
import { getPgConnected, setActiveUser, users, verifyPassword, issueAuthToken } from '../app';
import { pgPool } from '../app';

/**
 * POST /api/auth/login
 */
export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  try {
    if (getPgConnected()) {
      const dbRes = await pgPool.query(
        'SELECT id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users WHERE LOWER(email) = LOWER($1)',
        [cleanEmail]
      );
      const dbUser = dbRes.rows[0];
      const passwordCheck = dbUser ? verifyPassword(String(password || ''), dbUser.password) : { valid: false };
      if (!dbUser || !passwordCheck.valid) {
        throw new ApiError(401, 'Invalid email or password.');
      }

      if (passwordCheck.upgradedHash) {
        await pgPool.query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [passwordCheck.upgradedHash, dbUser.id]);
        dbUser.password = passwordCheck.upgradedHash;
      }
      setActiveUser(dbUser);
      const { password: _, ...userWithoutPass } = dbUser;
      res.json({ user: userWithoutPass, token: issueAuthToken(dbUser) });
      return;
    }

    const localUser = users.find((u) => u.email.toLowerCase() === cleanEmail);
    const passwordCheck = localUser ? verifyPassword(String(password || ''), localUser.password || '') : { valid: false };
    if (!localUser || !passwordCheck.valid) {
      throw new ApiError(401, 'Invalid email or password.');
    }
    if (passwordCheck.upgradedHash) localUser.password = passwordCheck.upgradedHash;
    setActiveUser(localUser);
    const { password: _, ...userWithoutPass } = localUser;
    res.json({ user: userWithoutPass, token: issueAuthToken(localUser) });
  } catch (err: any) {
    // Re-throw structured errors untouched so the central handler maps them
    // to their intended status (401 stays 401).
    if (err instanceof ApiError) throw err;
    console.error('PostgreSQL login query failed:', err?.message || err);
    res.status(503).json({
      message: 'Unable to verify credentials because PostgreSQL is unavailable. Try again when the database is online.',
    });
  }
}
