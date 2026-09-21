/**
 * Auth routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerAuthRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { get_setupStatus, post_setupSuperadmin, post_forgotPassword, get_me, post_switchProfile, put_profile } from '../controllers/auth.controller';
import {
  auditTrail,
  branches,
  getPgConnected,
  hashPassword,
  issueAuthToken,
  logAuditEvent,
  setActiveUser,
  setAuditTrail,
  setUsers,
  users,
  verifyPassword,
  withAppended,
  withPrepended,
  withReplaced,
} from '../app';
import { pgPool } from '../app';
import { login as forwardLogin } from '../controllers/auth.controller';
import { ApiError } from '../errors/ApiError';
import type { AuditLog, User } from '../../../client/src/types';

export function registerAuthRoutes(app: Express) {
app.get('/api/auth/setup-status', async (req, res, next) => { get_setupStatus(req as any, res as any).catch(next); });

app.post('/api/auth/setup-superadmin', async (req, res, next) => { post_setupSuperadmin(req as any, res as any).catch(next); });

app.post('/api/auth/forgot-password', async (req, res, next) => { post_forgotPassword(req as any, res as any).catch(next); });



app.post('/api/auth/login', (req, res, next) => {
  forwardLogin(req as any, res as any).catch((err) => next(err));
});

app.get('/api/auth/me', async (req, res, next) => { get_me(req as any, res as any).catch(next); });

app.post('/api/auth/switch-profile', async (req, res, next) => { post_switchProfile(req as any, res as any).catch(next); });

app.put('/api/auth/profile', async (req, res, next) => { put_profile(req as any, res as any).catch(next); });

}
