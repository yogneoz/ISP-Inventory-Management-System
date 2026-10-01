/**
 * Sales routes — sales invoices and sales returns. Registration order is
 * preserved by server.ts calling registerSalesRoutes(app) after the
 * procurement routes.
 */
import type { Express } from 'express';
import { get_salesInvoices, post_salesInvoices, get_salesReturns, post_salesReturns, post_salesReturnCancel, post_salesReturnApprove, get_customerLedger, post_customerPayments, post_customerPaymentReverse } from '../controllers/sales.controller';
import { requirePermission } from '../middleware';

export function registerSalesRoutes(app: Express) {
  app.get('/api/sales-invoices', async (req, res, next) => { get_salesInvoices(req as any, res as any).catch(next); });

  app.post('/api/sales-invoices', requirePermission('sales-invoice-create'), async (req, res, next) => { post_salesInvoices(req as any, res as any).catch(next); });

  app.get('/api/sales-returns', async (req, res, next) => { get_salesReturns(req as any, res as any).catch(next); });

  app.post('/api/sales-returns', requirePermission('sales-return-create'), async (req, res, next) => { post_salesReturns(req as any, res as any).catch(next); });

  app.post('/api/sales-returns/:id/cancel', requirePermission('sales-return-create'), async (req, res, next) => { post_salesReturnCancel(req as any, res as any).catch(next); });

  app.post('/api/sales-returns/:id/post', requirePermission('sales-return-create'), async (req, res, next) => { post_salesReturnApprove(req as any, res as any).catch(next); });

  app.get('/api/customers/:customerId/ledger', async (req, res, next) => { get_customerLedger(req as any, res as any).catch(next); });

  app.post('/api/customer-payments', requirePermission('sales-invoice-create'), async (req, res, next) => { post_customerPayments(req as any, res as any).catch(next); });

  app.post('/api/customer-payments/:id/reverse', requirePermission('sales-invoice-create'), async (req, res, next) => { post_customerPaymentReverse(req as any, res as any).catch(next); });
}
