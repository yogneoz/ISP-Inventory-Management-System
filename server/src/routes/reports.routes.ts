/**
 * Reports routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerReportsRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { get_financialSummary } from '../controllers/reports.controller';
import {
  assetRegister,
  computeTradingFromOps,
  fiscalYears,
  getPgConnected,
  inventoryStock,
  mutable,
  pickCurrentFiscalYear,
  products,
  purchaseInvoices,
  stockOperations,
} from '../app';
import { pgPool } from '../app';

export function registerReportsRoutes(app: Express) {
app.get('/api/reports/financial-summary', async (req, res, next) => { get_financialSummary(req as any, res as any).catch(next); });

}
