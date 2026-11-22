/**
 * `/api/partner/v1/*` (external portal ingest) and `/api/admin/integration/*`
 * (its governance).
 *
 * Ingest routes are API-key only by construction: the controller resolves the
 * partner from `req.apiKey`, so a human session token gets 401 there even if it
 * reaches the route. The operation gates below are the key's least-privilege
 * scope — a key without `sales-invoice-create` cannot create a service invoice.
 *
 * The admin routes sit behind the same seeded `admin-api-keys` grant the API
 * Creator uses, so whoever may mint a partner key may also bind it.
 */
import type { Express } from 'express';
import { requireAuth, requirePermission, requirePermissionAny, requireRole } from '../middleware';
import {
  get_integrationOutbox,
  get_integrationPartners,
  patch_integrationPartner,
  post_integrationDeliver,
  post_integrationOutboxReplay,
  post_integrationPartner,
  post_integrationPushHr,
  post_integrationPushStock,
  post_partnerConsumption,
  post_partnerCustomer,
  post_partnerSubscription,
} from '../controllers/partner.controller';

export function registerPartnerRoutes(app: Express) {
  // --- inbound ingest --------------------------------------------------------
  app.post(
    '/api/partner/v1/customers',
    requirePermissionAny('customers-manage'),
    (req, res, next) => {
      post_partnerCustomer(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/partner/v1/subscriptions',
    requirePermissionAny('sales-invoice-create'),
    (req, res, next) => {
      post_partnerSubscription(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/partner/v1/stock/consumptions',
    requirePermissionAny('stock-out'),
    (req, res, next) => {
      post_partnerConsumption(req as any, res as any).catch(next);
    }
  );

  // --- governance ------------------------------------------------------------
  app.get(
    '/api/admin/integration/partners',
    requireRole('SUPER_ADMIN'),
    requirePermission('admin-api-keys'),
    requireAuth,
    (req, res, next) => {
      get_integrationPartners(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/admin/integration/partners',
    requireRole('SUPER_ADMIN'),
    requirePermission('admin-api-keys'),
    requireAuth,
    (req, res, next) => {
      post_integrationPartner(req as any, res as any).catch(next);
    }
  );
  app.patch(
    '/api/admin/integration/partners/:id',
    requireRole('SUPER_ADMIN'),
    requirePermission('admin-api-keys'),
    (req, res, next) => {
      patch_integrationPartner(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/admin/integration/outbox',
    requireRole('SUPER_ADMIN'),
    requirePermission('admin-api-keys'),
    (req, res, next) => {
      get_integrationOutbox(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/admin/integration/outbox/:id/replay',
    requireRole('SUPER_ADMIN'),
    requirePermission('admin-api-keys'),
    (req, res, next) => {
      post_integrationOutboxReplay(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/admin/integration/deliver',
    requireRole('SUPER_ADMIN'),
    requirePermission('admin-api-keys'),
    (req, res, next) => {
      post_integrationDeliver(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/admin/integration/partners/:id/push/stock',
    requireRole('SUPER_ADMIN'),
    requirePermission('admin-api-keys'),
    (req, res, next) => {
      post_integrationPushStock(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/admin/integration/partners/:id/push/hr',
    requireRole('SUPER_ADMIN'),
    requirePermission('admin-api-keys'),
    (req, res, next) => {
      post_integrationPushHr(req as any, res as any).catch(next);
    }
  );
}
