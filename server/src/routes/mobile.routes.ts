/**
 * `/api/v1/*` — the mobile client's surface (PulseHR).
 *
 * Reads the app already had a screen for reuse the employee self-service
 * handlers, so the phone and the web ESS page return one shape from one
 * implementation. The new handlers cover what only a phone does: login with a
 * refresh token, the bootstrap payload, the sync cursor, a geofenced punch, a
 * device binding, an FCM token, the offline queue's claims/delegations, a
 * versioned work-order completion and a location breadcrumb batch.
 *
 * `/api/v1/auth/login` is the only unauthenticated route; every other route is
 * behind `requireAuth`, and the controller re-derives the employee from the
 * token on each request.
 */
import type { Express } from 'express';
import { requireAuth } from '../middleware';
import { auditSensitiveRead, requireSensitiveAuth } from '../middleware/sensitiveAuth';
import {
  get_hrSelfServiceAttendance,
  get_hrSelfServiceDocuments,
  get_hrSelfServiceLeave,
  get_hrSelfServicePayslips,
  post_hrSelfServiceLeave,
  post_hrSelfServiceLeaveCancel,
} from '../controllers/hrSelfService.controller';
import {
  post_hrLeaveRequestApprove,
  post_hrLeaveRequestReject,
} from '../controllers/hrLeave.controller';
import {
  get_v1Approvals,
  get_v1Bootstrap,
  get_v1Claim,
  get_v1JobEvidence,
  get_v1Jobs,
  get_v1Profile,
  get_v1SensitiveProfile,
  get_v1SyncPull,
  get_v1VanStock,
  post_v1ApprovalDecision,
  post_v1Claim,
  post_v1SyncPush,
  post_v1Delegation,
  post_v1DeviceRegister,
  post_v1FcmToken,
  post_v1JobAssign,
  post_v1JobEvidence,
  post_v1LocationBatch,
  post_v1Login,
  post_v1Logout,
  post_v1Punch,
  post_v1ReAuth,
  post_v1Refresh,
  post_v1WorkOrderComplete,
  put_v1Contact,
} from '../controllers/mobile.controller';

export function registerMobileRoutes(app: Express) {
  // --- auth -----------------------------------------------------------------
  app.post('/api/v1/auth/login', (req, res, next) => {
    post_v1Login(req as any, res as any).catch(next);
  });
  app.post('/api/v1/auth/refresh', (req, res, next) => {
    post_v1Refresh(req as any, res as any).catch(next);
  });
  app.post('/api/v1/auth/logout', (req, res, next) => {
    post_v1Logout(req as any, res as any).catch(next);
  });
  // Sensitive screens ask for the password again and receive a short-lived
  // elevation token; the session token alone can never read a payslip.
  app.post('/api/v1/auth/re-auth', requireAuth, (req, res, next) => {
    post_v1ReAuth(req as any, res as any).catch(next);
  });

  // --- bootstrap + sync ------------------------------------------------------
  app.get('/api/v1/workplace/bootstrap', requireAuth, (req, res, next) => {
    get_v1Bootstrap(req as any, res as any).catch(next);
  });
  app.get('/api/v1/sync/pull', requireAuth, (req, res, next) => {
    get_v1SyncPull(req as any, res as any).catch(next);
  });
  app.post('/api/v1/sync/push', requireAuth, (req, res, next) => {
    post_v1SyncPush(req as any, res as any).catch(next);
  });

  // --- attendance ------------------------------------------------------------
  app.post('/api/v1/workplace/attendance/punch', requireAuth, (req, res, next) => {
    post_v1Punch(req as any, res as any).catch(next);
  });
  app.get('/api/v1/attendance', requireAuth, (req, res, next) => {
    get_hrSelfServiceAttendance(req as any, res as any).catch(next);
  });

  // --- leave -----------------------------------------------------------------
  app.get('/api/v1/leaves', requireAuth, (req, res, next) => {
    get_hrSelfServiceLeave(req as any, res as any).catch(next);
  });
  app.post('/api/v1/leaves/requests', requireAuth, (req, res, next) => {
    post_hrSelfServiceLeave(req as any, res as any).catch(next);
  });
  app.post('/api/v1/leaves/requests/:id/cancel', requireAuth, (req, res, next) => {
    post_hrSelfServiceLeaveCancel(req as any, res as any).catch(next);
  });
  // Supervisor decisions keep the HR register's manage gate; the phone is only a
  // second client for the same rule, not a new approval path.
  app.post('/api/v1/leaves/requests/:id/review', requireAuth, (req, res, next) => {
    const approve = req.body?.approve;
    // A missing flag must never decide for the supervisor: without this an
    // offline replay with a stripped body would silently REJECT a request.
    if (typeof approve !== 'boolean') {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: '`approve` must be true (approve) or false (reject).',
        retryable: false,
        details: { field: 'approve' },
      });
      return;
    }
    const handler = approve ? post_hrLeaveRequestApprove : post_hrLeaveRequestReject;
    handler(req as any, res as any).catch(next);
  });

  // --- profile, payslips, documents ------------------------------------------
  // The everyday card carries no PAN/SSF/bank/salary; those fields have their
  // own route behind re-authentication below.
  app.get('/api/v1/profile', requireAuth, (req, res, next) => {
    get_v1Profile(req as any, res as any).catch(next);
  });
  app.get('/api/v1/hr/me/sensitive', requireAuth, requireSensitiveAuth, (req, res, next) => {
    get_v1SensitiveProfile(req as any, res as any).catch(next);
  });
  app.put('/api/v1/employees/me/contact', requireAuth, (req, res, next) => {
    put_v1Contact(req as any, res as any).catch(next);
  });
  app.get(
    '/api/v1/payslips',
    requireAuth,
    requireSensitiveAuth,
    auditSensitiveRead('MOBILE_SENSITIVE_VIEW', 'Payslips'),
    (req, res, next) => {
      get_hrSelfServicePayslips(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/v1/documents',
    requireAuth,
    requireSensitiveAuth,
    auditSensitiveRead('MOBILE_SENSITIVE_VIEW', 'Documents'),
    (req, res, next) => {
      get_hrSelfServiceDocuments(req as any, res as any).catch(next);
    }
  );

  // --- device, notifications -------------------------------------------------
  app.post('/api/v1/devices/register', requireAuth, (req, res, next) => {
    post_v1DeviceRegister(req as any, res as any).catch(next);
  });
  app.post('/api/v1/notifications/fcm-token', requireAuth, (req, res, next) => {
    post_v1FcmToken(req as any, res as any).catch(next);
  });

  // --- field operations ------------------------------------------------------
  app.post('/api/v1/workplace/jobs/:id/complete', requireAuth, (req, res, next) => {
    post_v1WorkOrderComplete(req as any, res as any).catch(next);
  });
  // Dispatch (and re-dispatch) with the two stated rules; a supervisor may
  // waive either one with a reason, and the order records that it happened.
  app.post('/api/v1/workplace/jobs/:id/assign', requireAuth, (req, res, next) => {
    post_v1JobAssign(req as any, res as any).catch(next);
  });
  // Proof of work: the photo or signature captured on site.
  app.get('/api/v1/workplace/jobs/:id/evidence', requireAuth, (req, res, next) => {
    get_v1JobEvidence(req as any, res as any).catch(next);
  });
  app.post('/api/v1/workplace/jobs/:id/evidence', requireAuth, (req, res, next) => {
    post_v1JobEvidence(req as any, res as any).catch(next);
  });
  app.post('/api/v1/workplace/claims', requireAuth, (req, res, next) => {
    post_v1Claim(req as any, res as any).catch(next);
  });
  app.get('/api/v1/workplace/claims/:id', requireAuth, (req, res, next) => {
    get_v1Claim(req as any, res as any).catch(next);
  });
  app.post('/api/v1/workplace/delegations', requireAuth, (req, res, next) => {
    post_v1Delegation(req as any, res as any).catch(next);
  });
  app.post('/api/v1/workplace/location/batch', requireAuth, (req, res, next) => {
    post_v1LocationBatch(req as any, res as any).catch(next);
  });

  // --- field queue and van ---------------------------------------------------
  app.get('/api/v1/workplace/jobs', requireAuth, (req, res, next) => {
    get_v1Jobs(req as any, res as any).catch(next);
  });
  app.get('/api/v1/workplace/stock', requireAuth, (req, res, next) => {
    get_v1VanStock(req as any, res as any).catch(next);
  });

  // --- approvals -------------------------------------------------------------
  app.get('/api/v1/workplace/approvals', requireAuth, (req, res, next) => {
    get_v1Approvals(req as any, res as any).catch(next);
  });
  app.post('/api/v1/workplace/approvals/:kind/:id', requireAuth, (req, res, next) => {
    post_v1ApprovalDecision(req as any, res as any).catch(next);
  });
}
