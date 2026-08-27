/**
 * Route module: auth
 */
import { Router } from 'express';
import * as store from '../store';
import { pgPool, isPgConnected, withTransaction } from '../lib/db';
import {
  requireRole,
  requireAuth,
  logAuditEvent,
  sanitizeUser,
  findUserByIdOrEmail,
  migrateUserPasswordIfNeeded,
  getUserFromReq,
} from '../lib/auth';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  createSession,
  destroySession,
  destroyUserSessions,
  extractBearerToken,
  getTodayBsStamp,
  normalizeRole,
  MIN_PASSWORD_LENGTH,
  getSession,
} from '../lib/authUtils';
import {
  broadcastChange,
  dataVersion,
  setDataVersion,
  bumpDataVersion,
  addSseClient,
  removeSseClient,
  forEachSseClient,
} from '../lib/sync';
import { getGenAIClient } from '../lib/ai';
import type {
  User,
  Supplier,
  Branch,
  Product,
  CompanyProfile,
  InventoryStock,
  Asset,
  PurchaseOrder,
  PurchaseInvoice,
  Shipment,
  StockOperation,
  FiscalYear,
  AuditLog,
  TransactionLog,
  CustomerDeviceRecord,
  CustomerRecord,
  ApprovalRequest,
  Category,
  UnitOfMeasure,
  LocationRecord,
} from '../../src/types';

const router = Router();

router.get('/api/auth/setup-status', async (req, res) => {
  if (isPgConnected) {
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
  const hasSA = store.users.some((u) => u.role === 'SUPER_ADMIN');
  const userCount = store.users.length;
  res.json({
    isFirstLaunch: userCount === 0 || !hasSA,
    userCount,
    hasSuperAdmin: hasSA,
  });
});

router.post('/api/auth/setup-superadmin', async (req: any, res: any) => {
  const { name, email, password, branchId } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email, and password are required.' });
  }

  const strength = validatePasswordStrength(password);
  if (!strength.ok) {
    return res.status(400).json({ message: strength.message });
  }

  const hqBranchId = branchId || store.branches[0]?.id || 'WH001';
  const cleanEmail = email.trim().toLowerCase();
  const allowedBranches = store.branches.map((b) => b.id);
  let targetId = `usr-sa-${Date.now()}`;
  const hashed = await hashPassword(password);

  if (isPgConnected) {
    try {
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
          [cleanEmail, hashed, name.trim(), hqBranchId, allowedBranches, targetId]
        );
        savedUser = upRes.rows[0];
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
          [targetId, cleanEmail, hashed, name.trim(), hqBranchId, allowedBranches]
        );
        savedUser = insRes.rows[0];
      }

      const idx = store.users.findIndex((u) => u.id === savedUser.id || u.email.toLowerCase() === cleanEmail || u.role === 'SUPER_ADMIN');
      if (idx !== -1) store.users[idx] = savedUser;
      else store.users.unshift(savedUser);

      store.setActiveUser(savedUser);
      store.saveDataStore();
      const session = createSession(savedUser as any);
      logAuditEvent(req, 'CREATE_SUPER_ADMIN', 'AUTH', `Super Admin account initialized/updated: ${name} (${cleanEmail})`);
      return res.status(201).json({ user: sanitizeUser(savedUser), token: session.token });
    } catch (err: any) {
      console.error('Error setting up Super Admin in DB:', err);
    }
  }

  const existingIdx = store.users.findIndex((u) => u.email.toLowerCase() === cleanEmail || u.role === 'SUPER_ADMIN');
  let newSuperAdmin: User;
  if (existingIdx !== -1) {
    store.users[existingIdx].name = name.trim();
    store.users[existingIdx].email = cleanEmail;
    store.users[existingIdx].password = hashed;
    store.users[existingIdx].role = 'SUPER_ADMIN';
    store.users[existingIdx].branchId = hqBranchId;
    store.users[existingIdx].allowedBranchIds = allowedBranches;
    store.users[existingIdx].canSwitchUser = true;
    newSuperAdmin = store.users[existingIdx];
  } else {
    newSuperAdmin = {
      id: targetId,
      email: cleanEmail,
      password: hashed,
      name: name.trim(),
      role: 'SUPER_ADMIN' as const,
      branchId: hqBranchId,
      allowedBranchIds: allowedBranches,
      canSwitchUser: true,
    };
    store.users.unshift(newSuperAdmin);
  }

  store.saveDataStore();
  store.setActiveUser(newSuperAdmin);
  const session = createSession(newSuperAdmin as any);
  logAuditEvent(req, 'CREATE_SUPER_ADMIN', 'AUTH', `Super Admin account initialized/updated: ${name} (${cleanEmail})`);
  res.status(201).json({ user: sanitizeUser(newSuperAdmin), token: session.token });
});

router.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body;
  const user = store.users.find((u) => u.email.toLowerCase() === (email || '').toLowerCase().trim());

  if (!user) {
    return res.status(404).json({ message: 'No registered user account found with this email address.' });
  }

  const adminUser = store.users.find((u) => u.role === 'SUPER_ADMIN') || store.users[0];
  logAuditEvent(req, 'FORGOT_PASSWORD_REQUEST', 'AUTH', `Password reset request submitted for ${user.name} (${user.email})`);

  res.json({
    success: true,
    userName: user.name,
    adminEmail: adminUser?.email || 'superadmin@izone.net.np',
    message: `Reset request logged for ${user.name}. Please contact your System Administrator (${adminUser?.email || 'superadmin@izone.net.np'}) or ask your Manager to reset your password in User & Staff Management.`,
  });
});

router.post('/api/auth/login', async (req: any, res: any) => {
  const { email, password } = req.body;
  const cleanEmail = (email || '').toLowerCase().trim();
  if (!cleanEmail || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  let candidate: User | null = null;

  if (isPgConnected) {
    try {
      const dbRes = await pgPool.query(
        'SELECT id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [cleanEmail]
      );
      if (dbRes.rows.length > 0) {
        candidate = dbRes.rows[0];
      }
    } catch (_err) {}
  }

  if (!candidate) {
    candidate = store.users.find((u) => u.email.toLowerCase() === cleanEmail) || null;
  }

  if (!candidate) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const ok = await verifyPassword(password, candidate.password);
  if (!ok) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  await migrateUserPasswordIfNeeded(candidate, password);

  // Keep memory store in sync
  const memIdx = store.users.findIndex((u) => u.id === candidate!.id || u.email.toLowerCase() === cleanEmail);
  if (memIdx !== -1) {
    store.users[memIdx] = { ...store.users[memIdx], ...candidate, password: candidate.password };
    candidate = store.users[memIdx];
  } else {
    store.users.push(candidate);
  }

  candidate.role = normalizeRole(candidate.role) as User['role'];
  store.setActiveUser(candidate);
  const session = createSession(candidate as any);
  // Attach session so audit trail records the real actor (not anonymous)
  (req as any).session = session;
  (req as any).user = {
    id: candidate.id,
    email: candidate.email,
    name: candidate.name,
    role: candidate.role,
    branchId: candidate.branchId,
    authenticated: true,
  };
  logAuditEvent(req, 'USER_LOGIN', 'AUTH', `User ${candidate.name} (${candidate.email}) signed in`);
  res.json({ user: sanitizeUser(candidate), token: session.token });
});

router.post('/api/auth/logout', (req: any, res: any) => {
  const token = extractBearerToken(req) || req.authToken;
  destroySession(token);
  store.setActiveUser(null);
  res.json({ success: true, message: 'Signed out successfully.' });
});

router.get('/api/auth/me', (req: any, res: any) => {
  if (!req.session || !req.user?.authenticated) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  const live = findUserByIdOrEmail(req.user.id) || findUserByIdOrEmail(req.user.email);
  if (!live) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  res.json(sanitizeUser(live));
});

// Profile Switching Endpoint — requires authenticated session + switch permission
router.post('/api/auth/switch-profile', (req: any, res: any) => {
  if (!req.session || !req.user?.authenticated) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const actor = findUserByIdOrEmail(req.session.rootUserId) || findUserByIdOrEmail(req.user.id);
  const canSwitch =
    actor &&
    (normalizeRole(actor.role) === 'SUPER_ADMIN' ||
      normalizeRole(actor.role) === 'INVENTORY_MANAGER' ||
      actor.canSwitchUser === true);

  if (!canSwitch) {
    return res.status(403).json({ message: 'Forbidden: your account is not permitted to switch profiles.' });
  }

  const { targetUserId } = req.body;
  const user = findUserByIdOrEmail(targetUserId);
  if (!user) {
    return res.status(404).json({ message: 'Target user profile not found.' });
  }

  const previousUser = req.user;
  store.setActiveUser(user);
  const rootId = req.session.rootUserId || req.session.userId;
  // Rotate session onto target while preserving root
  destroySession(req.authToken);
  const session = createSession(user as any, rootId);

  store.auditTrail.unshift({
    id: `aud-${Date.now()}`,
    userEmail: user.email,
    userName: user.name,
    action: 'PROFILE_SWITCHED',
    module: 'AUTH',
    details: `Session profile switched from ${previousUser?.email || 'System'} (${previousUser?.role}) to ${user.email} (${user.role})`,
    timestampAD: new Date().toISOString(),
    timestampBS: getTodayBsStamp(),
  });

  res.json({ user: sanitizeUser(user), token: session.token });
});

// Profile Update Endpoint
router.put('/api/auth/profile', async (req: any, res: any) => {
  if (!req.session || !req.user?.authenticated) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  const { name, email, branchId, newPassword } = req.body;
  const idx = store.users.findIndex((u) => u.id === req.user.id || u.email === req.user.email);
  if (idx === -1) {
    return res.status(404).json({ message: 'User not found' });
  }

  if (name) store.users[idx].name = name;
  if (email) store.users[idx].email = email;
  if (branchId) store.users[idx].branchId = branchId;
  if (newPassword) {
    const strength = validatePasswordStrength(newPassword);
    if (!strength.ok) {
      return res.status(400).json({ message: strength.message });
    }
    store.users[idx].password = await hashPassword(newPassword);
  }
  store.setActiveUser(store.users[idx]);

  if (isPgConnected) {
    try {
      if (newPassword) {
        await pgPool.query(
          'UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email), branch_id = COALESCE($3, branch_id), password = $4 WHERE id = $5',
          [name || null, email || null, branchId || null, store.users[idx].password, store.users[idx].id]
        );
      } else {
        await pgPool.query(
          'UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email), branch_id = COALESCE($3, branch_id) WHERE id = $4',
          [name || null, email || null, branchId || null, store.users[idx].id]
        );
      }
    } catch (err) {
      console.warn('Profile DB update note:', err);
    }
  }

  store.saveDataStore();
  res.json(sanitizeUser(store.users[idx]));
});

// UOM (Unit of Measure)

export default router;
