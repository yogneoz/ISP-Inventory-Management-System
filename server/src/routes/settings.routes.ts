/**
 * Settings routes — server-backed replacement for the settings and
 * preferences that used to live only in browser localStorage.
 *
 *   GET  /api/settings    — company-wide settings + the caller's preferences
 *   PUT  /api/settings    — write company-wide settings (SUPER_ADMIN only)
 *   PUT  /api/preferences — patch the caller's own preferences (any user)
 *   PUT  /api/company-overview/card-order — set the caller's role's card order
 *   DELETE /api/company-overview/card-order — restore that role's default order
 *
 * Authentication is the global /api requireAuth middleware; these handlers
 * only add role/ownership rules. Registration order is preserved by
 * registerAllRoutes (app.ts), like the other extracted route modules.
 */
import type { Express } from 'express';
import {
  get_settings,
  put_settings,
  put_preferences,
  put_company_overview_card_order,
  delete_company_overview_card_order,
} from '../controllers/settings.controller';
import { requirePermissionAny, requireRole } from '../app';
import { COMPANY_OVERVIEW_ACCESS_OPERATIONS } from '../../../shared/companyOverview';

export function registerSettingsRoutes(app: Express) {
  app.get('/api/settings', async (req, res, next) => {
    get_settings(req as any, res as any).catch(next);
  });

  app.put('/api/settings', requireRole('SUPER_ADMIN'), async (req, res, next) => {
    put_settings(req as any, res as any).catch(next);
  });

  app.put('/api/preferences', async (req, res, next) => {
    put_preferences(req as any, res as any).catch(next);
  });

  app.put(
    '/api/company-overview/card-order',
    requirePermissionAny(...COMPANY_OVERVIEW_ACCESS_OPERATIONS),
    async (req, res, next) => {
      put_company_overview_card_order(req as any, res as any).catch(next);
    }
  );

  app.delete(
    '/api/company-overview/card-order',
    requirePermissionAny(...COMPANY_OVERVIEW_ACCESS_OPERATIONS),
    async (req, res, next) => {
      delete_company_overview_card_order(req as any, res as any).catch(next);
    }
  );
}
