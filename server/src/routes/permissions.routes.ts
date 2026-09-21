/**
 * Permissions routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerPermissionsRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { get_permissions, put_permissions } from '../controllers/permissions.controller';
import {
  getUserFromReq,
  permissionMatrix,
  requireRole,
  setPermissionMatrix,
} from '../app';
import { pgPool } from '../app';

export function registerPermissionsRoutes(app: Express) {
app.get('/api/permissions', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN'), async (req, res, next) => { get_permissions(req as any, res as any).catch(next); });

app.put('/api/permissions', requireRole('SUPER_ADMIN'), async (req, res, next) => { put_permissions(req as any, res as any).catch(next); });

}
