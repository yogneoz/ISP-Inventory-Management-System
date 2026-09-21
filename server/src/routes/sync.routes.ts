/**
 * Sync routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerSyncRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { get_stream, get_version } from '../controllers/sync.controller';
import {
  getDataVersion,
  sseClients,
} from '../app';

export function registerSyncRoutes(app: Express) {
app.get('/api/sync/stream', async (req, res, next) => { get_stream(req as any, res as any).catch(next); });

app.get('/api/sync/version', async (req, res, next) => { get_version(req as any, res as any).catch(next); });

}
