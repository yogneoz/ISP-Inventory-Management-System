/**
 * Shipments routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerShipmentsRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { get_shipments, get_shipmentsPage, get_shipmentOverview, post_shipments, post_receive, post_cancel, post_cancelReceive } from '../controllers/shipments.controller';
import { requirePermission, requirePermissionAny, requireAuth } from '../app';

export function registerShipmentsRoutes(app: Express) {
app.get('/api/shipments', requireAuth, async (req, res, next) => { get_shipments(req as any, res as any).catch(next); });

// Register/overview reads (VOL-3): the transfer list no longer rides the
// bootstrap payload. `/page` is the server-paged register; `/overview` is the
// small scoped snapshot (exact status counts + actionable rows) the shell
// badges, dashboard KPI and notification center read. Both resolve branch
// scope from the session, so a branch account cannot widen its read.
app.get('/api/shipments/page', requireAuth, async (req, res, next) => { get_shipmentsPage(req as any, res as any).catch(next); });

app.get('/api/shipments/overview', requireAuth, async (req, res, next) => { get_shipmentOverview(req as any, res as any).catch(next); });

app.post('/api/shipments', requirePermission('shipment-create'), async (req, res, next) => { post_shipments(req as any, res as any).catch(next); });

app.post('/api/shipments/:id/receive', requirePermissionAny('wh-receive-pullouts', 'branch-transfer-receive'), async (req, res, next) => { post_receive(req as any, res as any).catch(next); });

app.post('/api/shipments/:id/cancel', requirePermission('shipment-cancel'), async (req, res, next) => { post_cancel(req as any, res as any).catch(next); });

app.post('/api/shipments/:id/cancel-receive', requirePermission('branch-transfer-cancel-receive'), async (req, res, next) => { post_cancelReceive(req as any, res as any).catch(next); });

}
