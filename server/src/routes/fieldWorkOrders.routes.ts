/**
 * Field capture routes — technician work orders.
 *
 * One operation, `field-work-order`, guards the whole surface: it is the screen
 * a technician opens, and the reads and writes belong together (the list is
 * useless without completing a visit). The seeded matrix grants it to
 * SUPER_ADMIN, HEAD_OFFICE_ADMIN, BRANCH_MANAGER, FRONT_DESK and
 * FIELD_TECHNICIAN; every route is still branch-scoped inside the controller.
 */
import type { Express } from 'express';
import {
  get_fieldWorkOrder,
  get_fieldWorkOrders,
  patch_fieldWorkOrderAssign,
  post_fieldWorkOrder,
  post_fieldWorkOrderCancel,
  post_fieldWorkOrderComplete,
} from '../controllers/fieldWorkOrders.controller';
import { requirePermission } from '../app';

export function registerFieldWorkOrderRoutes(app: Express) {
  app.get('/api/field-work-orders', requirePermission('field-work-order'), async (req, res, next) => {
    get_fieldWorkOrders(req as any, res as any).catch(next);
  });

  app.get('/api/field-work-orders/:id', requirePermission('field-work-order'), async (req, res, next) => {
    get_fieldWorkOrder(req as any, res as any).catch(next);
  });

  app.post('/api/field-work-orders', requirePermission('field-work-order'), async (req, res, next) => {
    post_fieldWorkOrder(req as any, res as any).catch(next);
  });

  app.patch('/api/field-work-orders/:id/assign', requirePermission('field-work-order'), async (req, res, next) => {
    patch_fieldWorkOrderAssign(req as any, res as any).catch(next);
  });

  app.post('/api/field-work-orders/:id/complete', requirePermission('field-work-order'), async (req, res, next) => {
    post_fieldWorkOrderComplete(req as any, res as any).catch(next);
  });

  app.post('/api/field-work-orders/:id/cancel', requirePermission('field-work-order'), async (req, res, next) => {
    post_fieldWorkOrderCancel(req as any, res as any).catch(next);
  });
}
