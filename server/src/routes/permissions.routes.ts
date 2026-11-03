/**
 * Permissions routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerPermissionsRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { create_permission_set, delete_permission_set, get_my_permissions, get_operation_permission_overrides, get_permission_sets, get_permissions, get_user_access_summaries, get_user_permission_overrides, put_permissions, put_user_permission_overrides, put_user_permission_sets, update_permission_set } from '../controllers/permissions.controller';
import { requireRole } from '../app';

export function registerPermissionsRoutes(app: Express) {
app.get('/api/permissions', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN'), async (req, res, next) => { get_permissions(req as any, res as any).catch(next); });

app.put('/api/permissions', requireRole('SUPER_ADMIN'), async (req, res, next) => { put_permissions(req as any, res as any).catch(next); });

// Phase 1 of docs/permission-overrides-plan.md. `/me` is for every signed-in
// account (the global auth middleware already ran); the admin reads/writes are
// deliberately SUPER_ADMIN-only, not `admin-users`, so a Head Office Admin who
// manages staff cannot grant themselves operations.
app.get('/api/permissions/me', async (req, res, next) => { get_my_permissions(req as any, res as any).catch(next); });

// Matrix-cell drill-down: one operation + one role, active direct exceptions
// only. SUPER_ADMIN-only because it names every account with an exception.
app.get('/api/permissions/operation-overrides', requireRole('SUPER_ADMIN'), async (req, res, next) => { get_operation_permission_overrides(req as any, res as any).catch(next); });

// One bulk read for the Users register cards. Registered before the per-user
// route so `/api/users/access-summary` can never be read as a user id.
app.get('/api/users/access-summary', requireRole('SUPER_ADMIN'), async (req, res, next) => { get_user_access_summaries(req as any, res as any).catch(next); });

app.get('/api/users/:id/permission-overrides', requireRole('SUPER_ADMIN'), async (req, res, next) => { get_user_permission_overrides(req as any, res as any).catch(next); });

app.put('/api/users/:id/permission-overrides', requireRole('SUPER_ADMIN'), async (req, res, next) => { put_user_permission_overrides(req as any, res as any).catch(next); });

// Phase 2 of docs/permission-overrides-plan.md: named bundles of grants that
// several users can share. Definitions are SUPER_ADMIN-only for the same reason
// as the per-user write: an admin who manages staff must not grant themselves
// operations by editing a reusable bundle. Membership replacement is separate
// from the override write so one save can never silently do both.
app.get('/api/permission-sets', requireRole('SUPER_ADMIN'), async (req, res, next) => { get_permission_sets(req as any, res as any).catch(next); });

app.post('/api/permission-sets', requireRole('SUPER_ADMIN'), async (req, res, next) => { create_permission_set(req as any, res as any).catch(next); });

app.put('/api/permission-sets/:id', requireRole('SUPER_ADMIN'), async (req, res, next) => { update_permission_set(req as any, res as any).catch(next); });

app.delete('/api/permission-sets/:id', requireRole('SUPER_ADMIN'), async (req, res, next) => { delete_permission_set(req as any, res as any).catch(next); });

app.put('/api/users/:id/permission-sets', requireRole('SUPER_ADMIN'), async (req, res, next) => { put_user_permission_sets(req as any, res as any).catch(next); });

}
