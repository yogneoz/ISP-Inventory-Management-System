/**
 * WTY-1 routes — the two warranty registers and the audited correction.
 * Registration order is preserved by app.ts calling this after the inventory
 * routes it complements.
 */
import type { Express } from 'express';
import { get_warrantySeller, get_warrantyVendor, patch_warrantyCoverage } from '../controllers/warranty.controller';
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
}
