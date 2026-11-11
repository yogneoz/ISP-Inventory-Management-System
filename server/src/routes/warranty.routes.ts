/**
 * WTY-1 routes — the two warranty registers and the audited correction.
 * Registration order is preserved by app.ts calling this after the inventory
 * routes it complements.
 */
import type { Express } from 'express';
import { get_warrantySeller, get_warrantyVendor, patch_warrantyCoverage } from '../controllers/warranty.controller';
import {
  get_warrantyRecovery,
  get_warrantyClaim,
  get_warrantyClaims,
  patch_warrantyClaimStatus,
  post_warrantyClaim,
} from '../controllers/warrantyClaim.controller';
import { requirePermission } from '../app';

export function registerWarrantyRoutes(app: Express) {
  // Both registers read the same coverage table, filtered by coverage_type.
  // `warranty-view` is a read op; editing a stored date is `warranty-edit`.
  app.get('/api/warranties/vendor', requirePermission('warranty-view'), async (req, res, next) => {
    get_warrantyVendor(req as any, res as any).catch(next);
  });

  app.get('/api/warranties/seller', requirePermission('warranty-view'), async (req, res, next) => {
    get_warrantySeller(req as any, res as any).catch(next);
  });

  app.patch('/api/warranties/:id', requirePermission('warranty-edit'), async (req, res, next) => {
    patch_warrantyCoverage(req as any, res as any).catch(next);
  });

  // Claims/RMA sit beside the coverage registers. The list and detail read
  // `warranty-view`; opening a claim and advancing its state need
  // `warranty-edit`, the same operation that already owns coverage correction.
  app.get('/api/warranty-claims', requirePermission('warranty-view'), async (req, res, next) => {
    get_warrantyClaims(req as any, res as any).catch(next);
  });

  // Recovery is a derived read: RMA age, credit shortfall and the posted AP
  // credit are joined from the existing claim header and journal, never copied.
  app.get('/api/warranty-claims/recovery', requirePermission('warranty-view'), async (req, res, next) => {
    get_warrantyRecovery(req as any, res as any).catch(next);
  });

  app.post('/api/warranty-claims', requirePermission('warranty-edit'), async (req, res, next) => {
    post_warrantyClaim(req as any, res as any).catch(next);
  });

  app.patch('/api/warranty-claims/:id/status', requirePermission('warranty-edit'), async (req, res, next) => {
    patch_warrantyClaimStatus(req as any, res as any).catch(next);
  });

  app.get('/api/warranty-claims/:id', requirePermission('warranty-view'), async (req, res, next) => {
    get_warrantyClaim(req as any, res as any).catch(next);
  });
}
