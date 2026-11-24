/**
 * Employee stock custody routes.
 *
 * The read side is one operation, `employee-stock-view` — the My Stock panel and
 * the employee profile's Equipment section read the same ledger. The four writes
 * reuse the inventory controls they already are: issuing and writing off stock
 * move it out of a branch (`stock-out`), while returning or consuming units move
 * custody back into a branch or onto a job (`consumable-issue-reverse`). Every
 * route is branch-scoped inside the controller.
 */
import type { Express } from 'express';
import {
  get_employeeStock,
  get_employeeStockEmployees,
  get_employeeStockMovements,
  post_employeeStockConsume,
  post_employeeStockIssue,
  post_employeeStockLoss,
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

  // The people custody can name: the same view gate as the holdings, because
  // handing units to a technician must not require the HR employee register.
  app.get(
    '/api/employee-stock/employees',
    requirePermission('employee-stock-view'),
    async (req, res, next) => {
      get_employeeStockEmployees(req as any, res as any).catch(next);
    }
  );

  app.post('/api/employee-stock/issue', requirePermission('stock-out'), async (req, res, next) => {
    post_employeeStockIssue(req as any, res as any, next).catch(next);
  });

  app.post('/api/employee-stock/return', requirePermission('consumable-issue-reverse'), async (req, res, next) => {
    post_employeeStockReturn(req as any, res as any, next).catch(next);
  });

  app.post('/api/employee-stock/consume', requirePermission('consumable-issue-reverse'), async (req, res, next) => {
    post_employeeStockConsume(req as any, res as any, next).catch(next);
  });

  app.post('/api/employee-stock/loss', requirePermission('stock-out'), async (req, res, next) => {
    post_employeeStockLoss(req as any, res as any, next).catch(next);
  });

  // Custody moving to a colleague stays inside the branch: the units were
  // issued from its shelf once, so `stock-out` is the control it already is.
  app.post('/api/employee-stock/transfer', requirePermission('stock-out'), async (req, res, next) => {
    post_employeeStockTransfer(req as any, res as any, next).catch(next);
  });
}
