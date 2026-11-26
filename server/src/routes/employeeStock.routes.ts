/**
 * Employee stock custody routes.
 *
 * The read side is one operation, `employee-stock-view` — the My Stock panel and
 * the employee profile's Equipment section read the same ledger. The writes
 * reuse the inventory controls they already are: issuing, reporting and writing
 * off stock move it out of a branch (`stock-out` and the manager's
 * `custody-writeoff`), while returning or consuming units move custody back into
 * a branch or onto a job (`consumable-issue-reverse`). Installing a held unit at
 * a customer is a write: it needs the visit control that installs it
 * (`field-work-order`) or the asset register's deploy control (`assets-manage`),
 * never just the read grant. Every route is branch-scoped inside the controller.
 */
import type { Express } from 'express';
import {
  get_employeeStock,
  get_employeeStockAssets,
  get_employeeStockEmployees,
  get_employeeStockMovements,
  get_employeeStockTieOut,
  post_employeeStockAudit,
  post_employeeStockConsume,
  post_employeeStockInstall,
  post_employeeStockIssue,
  post_employeeStockLoss,
  post_employeeStockLossReport,
  post_employeeStockReturn,
  post_employeeStockTransfer,
} from '../controllers/employeeStock.controller';
import { requirePermission } from '../app';

export function registerEmployeeStockRoutes(app: Express) {
  app.get('/api/employee-stock', requirePermission('employee-stock-view'), async (req, res, next) => {
    get_employeeStock(req as any, res as any).catch(next);
  });

  app.get('/api/employee-stock/movements', requirePermission('employee-stock-view'), async (req, res, next) => {
    get_employeeStockMovements(req as any, res as any).catch(next);
  });

  // Reconciliation of the two books is a read of the same ledger.
  app.get('/api/employee-stock/tieout', requirePermission('employee-stock-view'), async (req, res, next) => {
    get_employeeStockTieOut(req as any, res as any).catch(next);
  });

  // The people custody can name: the same view gate as the holdings, because
  // handing units to a technician must not require the HR employee register.
  app.get(
    '/api/employee-stock/employees',
    requirePermission('employee-stock-view'),
    async (req, res, next) => {
      get_employeeStockEmployees(req as any, res as any).catch(next);
    }
  );

  // Taking a unit off the shelf into a person's custody is a deployment, so it
  // needs `stock-deploy` — not `stock-out`, which the technician holds to write
  // consumables down. This is what stops a technician issuing CPE to themselves.
  app.post('/api/employee-stock/issue', requirePermission('stock-deploy'), async (req, res, next) => {
    post_employeeStockIssue(req as any, res as any, next).catch(next);
  });

  app.post('/api/employee-stock/return', requirePermission('consumable-issue-reverse'), async (req, res, next) => {
    post_employeeStockReturn(req as any, res as any, next).catch(next);
  });

  app.post('/api/employee-stock/consume', requirePermission('consumable-issue-reverse'), async (req, res, next) => {
    post_employeeStockConsume(req as any, res as any, next).catch(next);
  });

  // Writing a unit off against a person is a manager's decision, not the
  // holder's: `custody-writeoff` is false for FIELD_TECHNICIAN and FRONT_DESK, so
  // the technician who dropped a unit can only report it (below).
  app.post(
    '/api/employee-stock/loss',
    requirePermission('stock-deploy'),
    requirePermission('custody-writeoff'),
    async (req, res, next) => {
      post_employeeStockLoss(req as any, res as any, next).catch(next);
    }
  );

  // The holder's own report: it creates a pending approval request and writes
  // nothing off. Filing a claim on stock is a stock control, not a read — an
  // auditor who can view the ledger must not be able to open one.
  app.post('/api/employee-stock/loss-report', requirePermission('stock-out'), async (req, res, next) => {
    post_employeeStockLossReport(req as any, res as any, next).catch(next);
  });

  // The whole units a person holds (their fixed_assets rows), with the work
  // order and customer each was dispatched for.
  app.get('/api/employee-stock/assets', requirePermission('employee-stock-view'), async (req, res, next) => {
    get_employeeStockAssets(req as any, res as any).catch(next);
  });

  // Issuing a held CPE to the visit's customer — the same service the web and
  // mobile completions call. The technician installs through the visit they
  // close (`field-work-order`); this desk action is a deployment, so it needs
  // `stock-deploy`. The holder check inside the service is an extra guard, not
  // the gate: a view grant alone must never install anything.
  app.post('/api/employee-stock/install', requirePermission('stock-deploy'), async (req, res, next) => {
    post_employeeStockInstall(req as any, res as any, next).catch(next);
  });

  // A counted stock take can issue (surplus) or write off (shortfall): both are
  // shelf departures, so it needs the deploy authority and the write-off control
  // the same way the loss route does.
  app.post(
    '/api/employee-stock/audit',
    requirePermission('stock-deploy'),
    requirePermission('custody-writeoff'),
    async (req, res, next) => {
      post_employeeStockAudit(req as any, res as any, next).catch(next);
    }
  );

  // Custody moving to a colleague stays inside the branch: the units were
  // issued from its shelf once, so `stock-out` is the control it already is.
  app.post('/api/employee-stock/transfer', requirePermission('stock-out'), async (req, res, next) => {
    post_employeeStockTransfer(req as any, res as any, next).catch(next);
  });
}
