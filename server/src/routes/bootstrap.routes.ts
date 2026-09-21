/**
 * Bootstrap routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerBootstrapRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { get_bootstrap } from '../controllers/bootstrap.controller';
import {
  approvalRequests,
  branches,
  categories,
  companyProfile,
  computeTradingFromOps,
  damageRecords,
  fiscalYears,
  getDataVersion,
  getPgConnected,
  permissionMatrix,
  pickCurrentFiscalYear,
  products,
  purchaseInvoices,
  purchaseOrders,
  serialLogs,
  setPgConnected,
  shipments,
  stockOperations,
  suppliers,
  toCalendarDate,
  transactionLogs,
  users,
  vendorPayments,
} from '../app';
import { fetchOpeningStock, fetchOperationalData, parseSerialHistory, pgPool } from '../app';
import { fetchFiscalYears, setIsPgConnected } from '../app';

export function registerBootstrapRoutes(app: Express) {
app.get('/api/bootstrap', async (req, res, next) => { get_bootstrap(req as any, res as any).catch(next); });

}
