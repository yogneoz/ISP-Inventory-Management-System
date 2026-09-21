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
import { getPgConnected, setActiveUser, users, verifyPassword, issueAuthToken, branches, hashPassword, setUsers, withReplaced, withPrepended, logAuditEvent, withAppended, setAuditTrail, auditTrail } from '../app';
import { pgPool } from '../app';
import type { AuditLog, User } from '../../../client/src/types';

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
/** Forwarded from auth.routes.ts (get_setupStatus). */
export async function get_setupStatus(req: any, res: Response): Promise<any> {
if (getPgConnected()) {
    try {
      const { rows } = await pgPool.query('SELECT COUNT(*) AS count, COUNT(CASE WHEN role = \'SUPER_ADMIN\' THEN 1 END) AS sa_count FROM users');
      const count = parseInt(rows[0]?.count || '0', 10);
      const saCount = parseInt(rows[0]?.sa_count || '0', 10);
      return res.json({
        isFirstLaunch: count === 0 || saCount === 0,
        userCount: count,
        hasSuperAdmin: saCount > 0,
      });
    } catch (_err) {}
  }
  const hasSA = users.some((u) => u.role === 'SUPER_ADMIN');
  const userCount = users.length;
  res.json({
    isFirstLaunch: userCount === 0 || !hasSA,
    userCount,
    hasSuperAdmin: hasSA,
  });

}

/** Forwarded from auth.routes.ts (post_setupSuperadmin). */
export async function post_setupSuperadmin(req: any, res: Response): Promise<any> {
const { name, email, password, branchId } = req.body;
  if (!name || !email || !password) {
    res.status(400).json({ message: 'Name, email, and password are required.' });
    return;
  }

  const hqBranchId = branchId || branches[0]?.id || 'WH001';
  const cleanEmail = email.trim().toLowerCase();
  const allowedBranches = branches.map((b) => b.id);
  let targetId = `usr-sa-${Date.now()}`;

  if (getPgConnected()) {
    try {
      const existingAdmin = await pgPool.query("SELECT 1 FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1");
      if (existingAdmin.rowCount) {
        res.status(409).json({ message: 'Super Admin setup is already complete. Please sign in instead.' });
        return;
      }
      const dbCheck = await pgPool.query(
        `SELECT id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser"
         FROM users
         WHERE LOWER(email) = LOWER($1) OR role = 'SUPER_ADMIN'
         ORDER BY created_at ASC LIMIT 1`,
        [cleanEmail]
      );

      let savedUser: User;
      if (dbCheck.rows.length > 0) {
        targetId = dbCheck.rows[0].id;
        const upRes = await pgPool.query(
          `UPDATE users SET
             email = $1,
             password = $2,
             name = $3,
             role = 'SUPER_ADMIN',
             branch_id = $4,
             allowed_branch_ids = $5,
             can_switch_user = true
           WHERE id = $6
           RETURNING id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser"`,
          [cleanEmail, hashPassword(password), name.trim(), hqBranchId, allowedBranches, targetId]
        );
        savedUser = upRes.rows[0];
        if (!savedUser) {
          const retryRes = await pgPool.query(
            `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user)
             VALUES ($1, $2, $3, $4, 'SUPER_ADMIN', $5, $6, true)
             ON CONFLICT (email) DO UPDATE SET
               password = EXCLUDED.password,
               name = EXCLUDED.name,
               role = 'SUPER_ADMIN',
               branch_id = EXCLUDED.branch_id,
               allowed_branch_ids = EXCLUDED.allowed_branch_ids,
               can_switch_user = true
             RETURNING id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser"`,
            [targetId, cleanEmail, hashPassword(password), name.trim(), hqBranchId, allowedBranches]
          );
          savedUser = retryRes.rows[0];
        }
      } else {
        const insRes = await pgPool.query(
          `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user)
           VALUES ($1, $2, $3, $4, 'SUPER_ADMIN', $5, $6, true)
           ON CONFLICT (email) DO UPDATE SET
             password = EXCLUDED.password,
             name = EXCLUDED.name,
             role = 'SUPER_ADMIN',
             branch_id = EXCLUDED.branch_id,
             allowed_branch_ids = EXCLUDED.allowed_branch_ids,
             can_switch_user = true
           RETURNING id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser"`,
          [targetId, cleanEmail, hashPassword(password), name.trim(), hqBranchId, allowedBranches]
        );
        savedUser = insRes.rows[0];
      }

      if (!savedUser) {
        throw new Error('Database did not return the Super Admin record after setup. Verify the users table schema and database connection.');
      }

      const idx = users.findIndex((u) => u.id === savedUser.id || u.email.toLowerCase() === cleanEmail || u.role === 'SUPER_ADMIN');
      setUsers(idx !== -1 ? withReplaced(users, idx, savedUser) : withPrepended(users, savedUser));

      setActiveUser(savedUser);
      logAuditEvent(req, 'CREATE_SUPER_ADMIN', 'AUTH', `Super Admin account initialized/updated: ${name} (${cleanEmail})`);

      const { password: _, ...userWithoutPass } = savedUser;
      res.status(201).json({ user: userWithoutPass, token: issueAuthToken(savedUser) });
      return;
    } catch (err: any) {
      console.error('Error setting up Super Admin in DB:', err);
      return res.status(503).json({
        message: 'Unable to set up Super Admin because PostgreSQL is unavailable. Try again when the database is online.',
      });
    }
  }

  if (users.some((u) => u.role === 'SUPER_ADMIN')) {
    res.status(409).json({ message: 'Super Admin setup is already complete. Please sign in instead.' });
    return;
  }
  const existingUser = users.find((u) => u.email.toLowerCase() === cleanEmail);
  const localUser: User = {
    id: existingUser?.id || targetId,
    email: cleanEmail,
    password: hashPassword(password),
    name: name.trim(),
    role: 'SUPER_ADMIN',
    branchId: hqBranchId,
    allowedBranchIds: allowedBranches,
    canSwitchUser: true,
  };
  const existingIdx = existingUser ? users.indexOf(existingUser) : -1;
  setUsers(existingIdx !== -1 ? withReplaced(users, existingIdx, localUser) : withPrepended(users, localUser));
  setActiveUser(localUser);
  const { password: _, ...localUserWithoutPass } = localUser;
  res.status(201).json({ user: localUserWithoutPass, token: issueAuthToken(localUser) });
  return;

}

/** Forwarded from auth.routes.ts (post_forgotPassword). */
export async function post_forgotPassword(req: any, res: Response): Promise<any> {
const { email } = req.body;
  const user = users.find((u) => u.email.toLowerCase() === (email || '').toLowerCase().trim());
  
  if (!user) {
    res.status(404).json({ message: 'No registered user account found with this email address.' });
    return;
  }

  const adminUser = users.find((u) => u.role === 'SUPER_ADMIN') || users[0];
  logAuditEvent(req, 'FORGOT_PASSWORD_REQUEST', 'AUTH', `Password reset request submitted for ${user.name} (${user.email})`);

  res.json({
    success: true,
    userName: user.name,
    adminEmail: adminUser?.email || 'superadmin@example.com',
    message: `Reset request logged for ${user.name}. Please contact your System Administrator (${adminUser?.email || 'superadmin@example.com'}) or ask your Manager to reset your password in User & Staff Management.`,
  });

}

/** Forwarded from auth.routes.ts (get_me). */
export async function get_me(req: any, res: Response): Promise<any> {
const authenticatedUser = (req as any).user;
  if (!authenticatedUser) {
    res.status(401).json({ message: 'Not authenticated' });
    return;
  }
  res.json(authenticatedUser);

}

/** Forwarded from auth.routes.ts (post_switchProfile). */
export async function post_switchProfile(req: any, res: Response): Promise<any> {
// A valid signed session and explicit switch permission are required.
  // After a server restart the browser may still hold a stale local session;
  // rejecting here forces a clean re-login instead of a broken switch.
  const activeProfile = (req as any).user;
  if (!activeProfile) {
    res.status(401).json({ message: 'Not authenticated. Log in again to switch profiles.' });
    return;
  }

  // Authorization gate:
  //  - A profile that itself has switch permission may switch (canSwitchUser).
  //  - A profile that is SUPER_ADMIN may always switch.
  //  - An impersonated profile may switch *back* to its root (the account that
  //    initiated the session) when the root granted switching or is SUPER_ADMIN.
  const isActiveSuperAdmin = activeProfile.role === 'SUPER_ADMIN';
  const rootAllowed =
    Boolean(activeProfile.rootId) &&
    (Boolean(activeProfile.rootCanSwitchUser) || activeProfile.rootRole === 'SUPER_ADMIN');
  if (!activeProfile.canSwitchUser && !isActiveSuperAdmin && !rootAllowed) {
    res.status(403).json({ message: 'Profile switching is not enabled for this account.' });
    return;
  }

  const { targetUserId } = req.body;
  const targetEmail = typeof req.body?.targetEmail === 'string' ? req.body.targetEmail.trim() : '';
  let user: any = null;

  // PostgreSQL is the source of truth for user profiles. The in-memory user
  // list can be stale (users created/edited after boot, or a data reset),
  // which previously caused "Target user profile not found" on switch.
  // The frontend sends the target email alongside the id so a re-created
  // account (new id after a demo data reset) can still be resolved.
  if (getPgConnected() && (targetUserId || targetEmail)) {
    try {
      const dbRes = await pgPool.query(
        'SELECT id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users WHERE id = $1 OR LOWER(email) = LOWER($2) LIMIT 1',
        [String(targetUserId || ''), String(targetEmail || '')]
      );
      user = dbRes.rows[0] || null;
    } catch (err: any) {
      console.error('PostgreSQL switch-profile lookup failed:', err?.message || err);
    }
  }

  // Fallback to the in-memory mirror when PostgreSQL is unavailable.
  if (!user) {
    user =
      users.find((u) => u.id === targetUserId || u.email === targetUserId || u.email.toLowerCase() === targetEmail.toLowerCase()) || null;
  }

  if (!user) {
    res.status(404).json({ message: 'Target user profile not found.' });
    return;
  }

  // Keep the in-memory user list in sync with the database row.
  const memIdx = users.findIndex((u) => u.id === user.id);
  setUsers(memIdx >= 0
    ? withReplaced(users, memIdx, { ...users[memIdx], ...user })
    : withAppended(users, user));

  const previousUser = activeProfile;
  setActiveUser(user);

  // Resolve the session root marker for the next token:
  //  - Switching back to the root collapses the marker to null (fresh root session).
  //  - Otherwise carry the existing root marker forward (preserves the chain).
  const rootId = previousUser?.rootId || '';
  const rootEmail = previousUser?.rootEmail || '';
  const targetIsRoot =
    Boolean(rootId) &&
    (user.id === rootId || (rootEmail && user.email?.toLowerCase() === rootEmail.toLowerCase()));
  const sessionRoot = targetIsRoot
    ? null
    : rootId
      ? { id: rootId, email: rootEmail, canSwitchUser: previousUser?.rootCanSwitchUser, role: previousUser?.rootRole }
      : previousUser?.id && previousUser.id !== user.id
        ? { id: previousUser.id, email: previousUser.email, canSwitchUser: previousUser.canSwitchUser, role: previousUser.role }
        : null;

  setAuditTrail(withPrepended(auditTrail, {
    id: `aud-${Date.now()}`,
    userEmail: user.email,
    userName: user.name,
    action: 'PROFILE_SWITCHED',
    module: 'AUTH',
    details: `Session profile switched from ${previousUser?.email || 'System'} (${previousUser?.role}) to ${user.email} (${user.role})`,
    timestampAD: new Date().toISOString(),
    timestampBS: '2083-04-16 BS',
  } as AuditLog));

  const { password: _, ...userWithoutPass } = user;
  res.json({ user: userWithoutPass, token: issueAuthToken(user, sessionRoot) });

}

/** Forwarded from auth.routes.ts (put_profile). */
export async function put_profile(req: any, res: Response): Promise<any> {
const authenticatedUser = (req as any).user;
  if (!authenticatedUser) {
    res.status(401).json({ message: 'Not authenticated' });
    return;
  }
  const { name, email, branchId, newPassword } = req.body;

  const idx = users.findIndex((u) => u.id === authenticatedUser.id);
  if (idx !== -1) {
    if (name) users[idx].name = name;
    if (email) users[idx].email = email;
    if (branchId) users[idx].branchId = branchId;
    if (newPassword) users[idx].password = hashPassword(newPassword);
    setActiveUser(users[idx]);

    if (newPassword && getPgConnected()) {
      pgPool.query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [users[idx].password, users[idx].id])
        .catch((err) => console.error('Error updating profile password:', err));
    }
  }

  const responseUser = idx !== -1 ? users[idx] : authenticatedUser;
  const { password: _, ...userWithoutPass } = responseUser;
  res.json(userWithoutPass);

}

