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
import { getPgConnected, setActiveUser, users, verifyPassword, issueAuthToken, branches, hashPassword, setUsers, withReplaced, withPrepended, logAuditEvent, withAppended, setAuditTrail, auditTrail, withTransaction } from '../app';
import { consumeSetupToken, setupTokenFromRequest, verifySetupToken } from '../boot/setupToken';
import { pgPool } from '../app';
import {
  USER_FIND_BY_EMAIL_SQL,
  USER_UPDATE_PASSWORD_SQL,
  USER_COUNT_SQL,
  USER_SUPER_ADMIN_EXISTS_SQL,
  USER_EMAIL_TAKEN_SQL,
  SUPER_ADMIN_SETUP_LOCK_SQL,
  USER_SUPER_ADMIN_CLAIM_SQL,
  superAdminInsertParams,
  USER_FIND_BY_ID_OR_EMAIL_SQL,
  USER_LINKED_AVATAR_SQL,
  USER_EMAIL_TAKEN_BY_OTHER_SQL,
  USER_UPDATE_PROFILE_SQL,
  userUpdatePasswordParams,
  USER_CLEAR_MUST_CHANGE_SQL,
} from '../models/auth.repo';
import type { AuditLog, User } from '../../../client/src/types';
import { todayBs } from '../utils/bsDate';
import { rememberSessionVersion } from '../state/sessionVersion';

/**
 * POST /api/auth/login
 */
export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  try {
    if (getPgConnected()) {
      const dbRes = await pgPool.query(USER_FIND_BY_EMAIL_SQL, [cleanEmail]);
      const dbUser = dbRes.rows[0];
      const passwordCheck = dbUser ? verifyPassword(String(password || ''), dbUser.password) : { valid: false };
      if (!dbUser || !passwordCheck.valid) {
        throw new ApiError(401, 'Invalid email or password.');
      }
      // A valid password on a deactivated account is still a refusal: an
      // employee's login is suspended with their employment record, and a
      // suspended or locked account stays closed until an administrator opens
      // it. Without this, deactivation only ended the current session.
      if (String(dbUser.status || 'active') !== 'active') {
        throw new ApiError(403, 'This account is not active. Contact an administrator.');
      }

      if (passwordCheck.upgradedHash) {
        await pgPool.query(USER_UPDATE_PASSWORD_SQL, userUpdatePasswordParams(passwordCheck.upgradedHash, dbUser.id));
        dbUser.password = passwordCheck.upgradedHash;
      }
      // The header avatar is the linked employee's self-service photo. It is
      // read here, not in USER_SELECT_COLUMNS, so the RETURNING-based setup and
      // profile statements keep working unchanged.
      const avatar = (await pgPool.query(USER_LINKED_AVATAR_SQL, [dbUser.id])).rows[0];
      setActiveUser(dbUser);
      await rememberSessionVersion(dbUser);
      const { password: _, ...userWithoutPass } = dbUser;
      res.json({
        user: { ...userWithoutPass, avatarUrl: avatar?.avatarUrl ?? null },
        token: issueAuthToken(dbUser),
      });
      return;
    }

    const localUser = users.find((u) => u.email.toLowerCase() === cleanEmail);
    const passwordCheck = localUser ? verifyPassword(String(password || ''), localUser.password || '') : { valid: false };
    if (!localUser || !passwordCheck.valid) {
      throw new ApiError(401, 'Invalid email or password.');
    }
    if (String(localUser.status || 'active') !== 'active') {
      throw new ApiError(403, 'This account is not active. Contact an administrator.');
    }
    if (passwordCheck.upgradedHash) localUser.password = passwordCheck.upgradedHash;
    setActiveUser(localUser);
    await rememberSessionVersion(localUser);
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
      const { rows } = await pgPool.query(USER_COUNT_SQL);
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
  const { name, email, password, branchId } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!cleanName || !cleanEmail || !password) {
    res.status(400).json({ message: 'Name, email, and password are required.' });
    return;
  }

  const hqBranchId = branchId || branches[0]?.id || 'WH001';
  const allowedBranches = branches.map((b) => b.id);

  if (getPgConnected()) {
    // An installed system answers 409 before the token is even considered: a
    // request that could never be authorized must not be told which secret it
    // was missing.
    let existingAdmin: any;
    try {
      existingAdmin = await pgPool.query(USER_SUPER_ADMIN_EXISTS_SQL);
    } catch (err: any) {
      console.error('Super Admin setup probe failed:', err?.message || err);
      return res.status(503).json({
        message: 'Unable to verify setup state because PostgreSQL is unavailable. Try again when the database is online.',
      });
    }
    if (existingAdmin.rowCount) {
      return res.status(409).json({ message: 'Super Admin setup is already complete. Please sign in instead.' });
    }

    // C1: this endpoint is public because the first account has to come from
    // somewhere, so possession of the one-time boot token is what proves the
    // caller can reach the server's console. Without it, anyone who can reach
    // the URL could create the highest-privilege account.
    if (!verifySetupToken(setupTokenFromRequest(req))) {
      return res.status(403).json({
        message:
          'A setup token is required to create the first Super Admin. It was printed in the server log at boot, or is set as SETUP_TOKEN in the environment.',
        setupTokenRequired: true,
      });
    }

    try {
      const claim = await withTransaction(async (client: any) => {
        // Serialises concurrent first-launch claims; the statement itself
        // repeats both guards, so exactly one caller can ever create the first
        // account and an existing row is never adopted.
        await client.query(SUPER_ADMIN_SETUP_LOCK_SQL);
        const emailTaken = await client.query(USER_EMAIL_TAKEN_SQL, [cleanEmail]);
        if (emailTaken.rowCount) return { status: 'email-taken' as const };
        const inserted = await client.query(
          USER_SUPER_ADMIN_CLAIM_SQL,
          superAdminInsertParams(
            `usr-sa-${Date.now()}`,
            cleanEmail,
            hashPassword(password),
            cleanName,
            hqBranchId,
            allowedBranches
          )
        );
        if (!inserted.rows[0]) return { status: 'already' as const };
        return { status: 'created' as const, user: inserted.rows[0] as User };
      });

      if (claim.status === 'email-taken') {
        return res.status(409).json({
          message:
            'That email already belongs to an account. Sign in with it, or use a different address for the Super Admin.',
        });
      }
      if (claim.status === 'already') {
        return res.status(409).json({ message: 'Super Admin setup is already complete. Please sign in instead.' });
      }

      const savedUser = claim.user;
      consumeSetupToken();
      setUsers(withPrepended(users, savedUser));
      setActiveUser(savedUser);
      await logAuditEvent(req, 'CREATE_SUPER_ADMIN', 'AUTH', `Super Admin account initialized: ${savedUser.name} (${savedUser.email})`);
      await rememberSessionVersion(savedUser);

      const { password: _, ...userWithoutPass } = savedUser;
      return res.status(201).json({ user: userWithoutPass, token: issueAuthToken(savedUser) });
    } catch (err: any) {
      console.error('Error setting up Super Admin in DB:', err);
      return res.status(503).json({
        message: 'Unable to set up Super Admin because PostgreSQL is unavailable. Try again when the database is online.',
      });
    }
  }

  // Demo mode (PostgreSQL down): the same token gate and the same "never adopt
  // an existing account" rule, applied to the in-memory user list.
  if (!verifySetupToken(setupTokenFromRequest(req))) {
    return res.status(403).json({
      message:
        'A setup token is required to create the first Super Admin. It was printed in the server log at boot, or is set as SETUP_TOKEN in the environment.',
      setupTokenRequired: true,
    });
  }
  if (users.some((u) => u.role === 'SUPER_ADMIN')) {
    return res.status(409).json({ message: 'Super Admin setup is already complete. Please sign in instead.' });
  }
  if (users.some((u) => String(u.email || '').toLowerCase() === cleanEmail)) {
    return res.status(409).json({
      message: 'That email already belongs to an account. Sign in with it, or use a different address for the Super Admin.',
    });
  }

  const localUser: User = {
    id: `usr-sa-${Date.now()}`,
    email: cleanEmail,
    password: hashPassword(password),
    name: cleanName,
    role: 'SUPER_ADMIN',
    branchId: hqBranchId,
    allowedBranchIds: allowedBranches,
    canSwitchUser: true,
  };
  consumeSetupToken();
  setUsers(withPrepended(users, localUser));
  setActiveUser(localUser);
  await rememberSessionVersion(localUser);
  const { password: _, ...localUserWithoutPass } = localUser;
  return res.status(201).json({ user: localUserWithoutPass, token: issueAuthToken(localUser) });
}

/** Forwarded from auth.routes.ts (post_forgotPassword). */
export async function post_forgotPassword(req: any, res: Response): Promise<any> {
const { email } = req.body;
  const user = users.find((u) => u.email.toLowerCase() === (email || '').toLowerCase().trim());

  // One response body for a known and an unknown address. Answering 404 (or
  // naming the account and the administrator) for a known one is unauthenticated
  // account enumeration, and this endpoint is reachable before sign-in.
  if (user) {
    await logAuditEvent(req, 'FORGOT_PASSWORD_REQUEST', 'AUTH', `Password reset request submitted for ${user.name} (${user.email})`);
  }

  res.json({
    success: true,
    message:
      'If an account exists for that email, the reset request has been logged. Contact your System Administrator or ask your Manager to reset the password in User & Staff Management.',
  });

}

/** Forwarded from auth.routes.ts (get_me). */
export async function get_me(req: any, res: Response): Promise<any> {
const authenticatedUser = (req as any).user;
  if (!authenticatedUser) {
    res.status(401).json({ message: 'Not authenticated' });
    return;
  }
  // The session fingerprint is server-side bookkeeping; it is not part of the
  // user record the client stores.
  const { ver: _ver, ...user } = authenticatedUser;
  res.json(user);

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
        USER_FIND_BY_ID_OR_EMAIL_SQL,
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
    timestampBS: todayBs(), // C4: from bs_day_records cache, not a hardcoded date
  } as AuditLog));

  // A switched profile carries its own linked employee photo.
  const avatar = (await pgPool.query(USER_LINKED_AVATAR_SQL, [user.id])).rows[0];
  await rememberSessionVersion(user);
  const { password: _, ...userWithoutPass } = user;
  res.json({
    user: { ...userWithoutPass, avatarUrl: avatar?.avatarUrl ?? null },
    token: issueAuthToken(user, sessionRoot),
  });

}

/** Forwarded from auth.routes.ts (put_profile). */
export async function put_profile(req: any, res: Response): Promise<any> {
  const authenticatedUser = (req as any).user;
  if (!authenticatedUser) {
    res.status(401).json({ message: 'Not authenticated' });
    return;
  }

  const { name, email, branchId, newPassword, currentPassword } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const cleanBranchId = typeof branchId === 'string' ? branchId.trim() : '';
  const nextPassword = typeof newPassword === 'string' ? newPassword : '';

  const wantsName = Boolean(cleanName) && cleanName !== String(authenticatedUser.name || '');
  const wantsEmail =
    Boolean(cleanEmail) && cleanEmail !== String(authenticatedUser.email || '').toLowerCase();
  const wantsBranch =
    Boolean(cleanBranchId) && cleanBranchId !== String(authenticatedUser.branchId || '');
  const wantsPassword = nextPassword.length > 0;

  if (!wantsName && !wantsEmail && !wantsBranch && !wantsPassword) {
    const { ver: _ver, ...unchanged } = authenticatedUser;
    return res.json(unchanged);
  }

  if (wantsPassword && nextPassword.length < 8) {
    return res.status(400).json({ message: 'The new password must be at least 8 characters long.' });
  }

  // Identity, scope and credential changes require proof of the CURRENT
  // password. A signed token lives eight hours, so without this a stolen token
  // could rewrite the address the account signs in with.
  const requiresCurrentPassword = wantsEmail || wantsPassword || wantsBranch;
  if (requiresCurrentPassword && !currentPassword) {
    return res.status(400).json({
      message: 'Enter your current password to change your email, branch or password.',
      currentPasswordRequired: true,
    });
  }

  // PostgreSQL is the authority for the stored credential; the in-memory cache
  // mirrors it, so demo mode (database down) still has a row to check.
  let stored: any = null;
  if (getPgConnected()) {
    try {
      stored =
        (await pgPool.query(USER_FIND_BY_ID_OR_EMAIL_SQL, [String(authenticatedUser.id), ''])).rows[0] ||
        null;
    } catch (err: any) {
      console.error('Profile read failed:', err?.message || err);
      return res.status(503).json({
        message: 'Unable to read your account because PostgreSQL is unavailable. Try again when the database is online.',
      });
    }
    if (!stored) {
      return res.status(401).json({ message: 'Your account no longer exists. Sign in again.' });
    }
  } else {
    stored = users.find((u) => u.id === authenticatedUser.id) || null;
    if (!stored) {
      return res.status(401).json({ message: 'Your account no longer exists. Sign in again.' });
    }
  }

  if (requiresCurrentPassword) {
    const check = verifyPassword(String(currentPassword || ''), String(stored.password || ''));
    if (!check.valid) {
      return res.status(401).json({ message: 'The current password is incorrect.', currentPasswordInvalid: true });
    }
  }

  const passwordHash = wantsPassword ? hashPassword(nextPassword) : null;
  let savedUser: User;

  if (getPgConnected()) {
    try {
      savedUser = await withTransaction(async (client: any) => {
        if (wantsEmail) {
          const taken = await client.query(USER_EMAIL_TAKEN_BY_OTHER_SQL, [
            cleanEmail,
            String(authenticatedUser.id),
          ]);
          if (taken.rowCount) {
            throw new ApiError(409, 'That email already belongs to another account.');
          }
        }
        // One statement for the whole profile: name, address, branch and
        // credential commit together or not at all.
        const result = await client.query(USER_UPDATE_PROFILE_SQL, [
          String(authenticatedUser.id),
          wantsName ? cleanName : null,
          wantsEmail ? cleanEmail : null,
          wantsBranch ? cleanBranchId : null,
          passwordHash,
        ]);
        if (!result.rows[0]) throw new ApiError(404, 'Your account no longer exists.');
        // Replacing the one-time password clears the first-sign-in requirement.
        if (wantsPassword) {
          await client.query(USER_CLEAR_MUST_CHANGE_SQL, [String(authenticatedUser.id)]);
        }
        return { ...(result.rows[0] as User), mustChangePassword: wantsPassword ? false : (result.rows[0] as any).mustChangePassword };
      });
    } catch (err: any) {
      // A deliberate refusal (duplicate address, vanished account) is a status
      // the caller must see, not an exception for the error middleware.
      if (err instanceof ApiError) {
        return res.status(err.status).json({ message: err.message });
      }
      // The unique constraint is the race-safe backstop behind the probe above.
      if ((err as any)?.code === '23505') {
        return res.status(409).json({ message: 'That email already belongs to another account.' });
      }
      console.error('Profile update failed:', err?.message || err);
      return res.status(503).json({
        message: 'Unable to save your profile because PostgreSQL is unavailable. Try again when the database is online.',
      });
    }
  } else {
    const idx = users.findIndex((u) => u.id === authenticatedUser.id);
    if (idx === -1) {
      return res.status(401).json({ message: 'Your account no longer exists. Sign in again.' });
    }
    if (
      wantsEmail &&
      users.some(
        (u) => u.id !== authenticatedUser.id && String(u.email || '').toLowerCase() === cleanEmail
      )
    ) {
      return res.status(409).json({ message: 'That email already belongs to another account.' });
    }
    savedUser = {
      ...users[idx],
      name: wantsName ? cleanName : users[idx].name,
      email: wantsEmail ? cleanEmail : users[idx].email,
      branchId: wantsBranch ? cleanBranchId : users[idx].branchId,
      password: passwordHash || users[idx].password,
      mustChangePassword: wantsPassword ? false : users[idx].mustChangePassword,
    } as User;
  }

  // Mirror the committed row into the operational cache through the setter (the
  // old code mutated the shared array in place, which the type system forbids
  // and which silently diverged from PostgreSQL).
  const cachedIdx = users.findIndex((u) => u.id === savedUser.id);
  setUsers(
    cachedIdx === -1 ? withPrepended(users, savedUser) : withReplaced(users, cachedIdx, savedUser)
  );
  setActiveUser(savedUser);

  await logAuditEvent(
    req,
    'UPDATE_OWN_PROFILE',
    'AUTH',
    `Profile updated for ${savedUser.email}${wantsName ? ' (name)' : ''}${wantsEmail ? ' (email)' : ''}` +
      `${wantsBranch ? ` (branch → ${savedUser.branchId})` : ''}${wantsPassword ? ' (password changed)' : ''}`
  );

  // The session fingerprint covers email, role, branch and password, so this
  // edit retires every other live token. Hand the caller a fresh one so they
  // are not signed out by their own change.
  await rememberSessionVersion(savedUser);
  const { password: _password, ver: _ver, ...userWithoutPass } = savedUser as any;
  return res.json({ ...userWithoutPass, token: issueAuthToken(savedUser) });
}

