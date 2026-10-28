/**
 * Procurement routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerProcurementRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { get_purchaseOrders, post_purchaseOrders, put_Id, delete_Id, patch_status, get_purchaseInvoices, post_purchaseInvoices, delete_Id2, post_pay, post_reversePayments, get_vendorPayments, get_payments, post_vendorPayments, post_reverse, get_ledger, get_purchaseReturns, post_purchaseReturns, post_purchaseReturnCancel, post_purchaseReturnApprove } from '../controllers/procurement.controller';
import { requirePermission, requirePermissionAny, requireRole } from '../app';
import { VENDOR_PAYMENT_SELECT, pgPool } from '../app';
import type { VendorPayment, VendorPaymentMethod } from '../../../client/src/types';

export function registerProcurementRoutes(app: Express) {
app.get('/api/purchase-orders', async (req, res, next) => { get_purchaseOrders(req as any, res as any).catch(next); });

app.post('/api/purchase-orders', requirePermission('po-create'), async (req, res, next) => { post_purchaseOrders(req as any, res as any).catch(next); });

app.put('/api/purchase-orders/:id', requirePermission('po-create'), async (req, res, next) => { put_Id(req as any, res as any).catch(next); });

app.delete('/api/purchase-orders/:id', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'PROCUREMENT_OFFICER'), requirePermission('po-delete'), async (req, res, next) => { delete_Id(req as any, res as any).catch(next); });

// Status transitions are a procurement action; an authenticated read role
// with no procurement operation must not be able to move a PO (AUTHZ-7).
app.patch('/api/purchase-orders/:id/status', requirePermissionAny('po-create', 'po-receive'), async (req, res, next) => { patch_status(req as any, res as any).catch(next); });

app.get('/api/purchase-invoices', async (req, res, next) => { get_purchaseInvoices(req as any, res as any).catch(next); });

app.post('/api/purchase-invoices', requirePermission('inv-create'), async (req, res, next) => { post_purchaseInvoices(req as any, res as any).catch(next); });

// Matches the client's `inv-delete` matrix row (Super Admin / Head Office
// Admin only); the old role list let an accountant delete an invoice the UI
// never offers them the action for (policy alignment).
app.delete('/api/purchase-invoices/:id', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN'), async (req, res, next) => { delete_Id2(req as any, res as any).catch(next); });

app.post('/api/purchase-invoices/:id/pay', requirePermission('inv-pay'), async (req, res, next) => { post_pay(req as any, res as any).catch(next); });

app.post('/api/purchase-invoices/:id/reverse-payments', requirePermission('inv-pay'), async (req, res, next) => { post_reversePayments(req as any, res as any).catch(next); });

app.get('/api/vendor-payments', async (req, res, next) => { get_vendorPayments(req as any, res as any).catch(next); });

app.get('/api/purchase-invoices/:id/payments', async (req, res, next) => { get_payments(req as any, res as any).catch(next); });

app.post('/api/vendor-payments', requirePermission('inv-pay'), async (req, res, next) => { post_vendorPayments(req as any, res as any).catch(next); });

app.post('/api/vendor-payments/:id/reverse', requirePermission('inv-pay'), async (req, res, next) => { post_reverse(req as any, res as any).catch(next); });

// The vendor ledger exposes payables and payment history. The UI gates it on
// `inv-pay`; without this gate any signed-in role could read it (AUTHZ-5).
app.get('/api/vendors/:supplierId/ledger', requirePermission('inv-pay'), async (req, res, next) => { get_ledger(req as any, res as any).catch(next); });

app.get('/api/purchase-returns', async (req, res, next) => { get_purchaseReturns(req as any, res as any).catch(next); });

app.post('/api/purchase-returns', requirePermission('purchase-return-create'), async (req, res, next) => { post_purchaseReturns(req as any, res as any).catch(next); });

app.post('/api/purchase-returns/:id/cancel', requirePermission('purchase-return-create'), async (req, res, next) => { post_purchaseReturnCancel(req as any, res as any).catch(next); });

app.post('/api/purchase-returns/:id/post', requirePermission('purchase-return-create'), async (req, res, next) => { post_purchaseReturnApprove(req as any, res as any).catch(next); });

}
