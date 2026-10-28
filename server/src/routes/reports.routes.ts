/**
 * Reports routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerReportsRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { requirePermission } from '../middleware';
import { get_financialSummary, get_financialSummaries } from '../controllers/reports.controller';
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

export function registerReportsRoutes(app: Express) {
// Financial statements are an operation, not a read every signed-in role gets:
// the UI gates the tab on `fin-statements`, so the API enforces the same gate
// (otherwise a field-technician token could read company figures the screen
// never shows them).
app.get('/api/reports/financial-summary', requirePermission('fin-statements'), async (req, res, next) => { get_financialSummary(req as any, res as any).catch(next); });
// Batch form (DF-12): every branch × fiscal-year pair the statements screen
// needs, in one request.
app.get('/api/reports/financial-summaries', requirePermission('fin-statements'), async (req, res, next) => { get_financialSummaries(req as any, res as any).catch(next); });

}
