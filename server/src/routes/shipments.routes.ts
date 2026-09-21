/**
 * Shipments routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerShipmentsRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { get_shipments, post_shipments, post_receive, post_cancel, post_cancelReceive } from '../controllers/shipments.controller';
import {
  branches,
  detectDateTypeMismatch,
  findBsDayRecordForAdDate,
  getPgConnected,
  inventoryStock,
  issueNextDocNumber,
  logAuditEvent,
  requirePermission,
  setShipments,
  shipments,
  withPrepended,
  withReplaced,
  withTransaction,
} from '../app';
import { pgPool } from '../app';

export function registerShipmentsRoutes(app: Express) {
app.get('/api/shipments', async (req, res, next) => { get_shipments(req as any, res as any).catch(next); });

app.post('/api/shipments', requirePermission('shipment-create'), async (req, res, next) => { post_shipments(req as any, res as any).catch(next); });

app.post('/api/shipments/:id/receive', requirePermission('wh-receive-pullouts'), async (req, res, next) => { post_receive(req as any, res as any).catch(next); });

app.post('/api/shipments/:id/cancel', async (req, res, next) => { post_cancel(req as any, res as any).catch(next); });

app.post('/api/shipments/:id/cancel-receive', async (req, res, next) => { post_cancelReceive(req as any, res as any).catch(next); });

}
