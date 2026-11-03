/**
 * Payroll routes. Reads use the ledger's `gl-view` gate, writes use `gl-post`
 * for run posting/payment and `gl-manage` for the employee master, so payroll
 * follows the same permission vocabulary as the rest of finance rather than
 * adding a payroll-only operation nobody can grant.
 */
import type { Express } from 'express';
import { requirePermission } from '../middleware';
import {
  get_employeeLedger,
  get_employees,
  get_payrollRun,
  get_payrollRuns,
  patch_employee,
  post_employee,
  post_payrollPayment,
  post_payrollRun,
} from '../controllers/payroll.controller';
import { get_payslipPrint } from '../controllers/pdf.controller';

export function registerPayrollRoutes(app: Express) {
  // Employee master (branch-scoped by the registry and re-checked in-handler).
  app.get('/api/employees', requirePermission('gl-view'), async (req, res, next) => {
    get_employees(req as any, res as any).catch(next);
  });
  app.post('/api/employees', requirePermission('gl-manage'), async (req, res, next) => {
    post_employee(req as any, res as any).catch(next);
  });
  app.patch('/api/employees/:id', requirePermission('gl-manage'), async (req, res, next) => {
    patch_employee(req as any, res as any).catch(next);
  });
  app.get('/api/employees/:id/ledger', requirePermission('gl-view'), async (req, res, next) => {
    get_employeeLedger(req as any, res as any).catch(next);
  });

  // Payroll runs: one journal per posted run, one payment journal when paid.
  app.get('/api/payroll-runs', requirePermission('gl-view'), async (req, res, next) => {
    get_payrollRuns(req as any, res as any).catch(next);
  });
  app.get('/api/payroll-runs/:id', requirePermission('gl-view'), async (req, res, next) => {
    get_payrollRun(req as any, res as any).catch(next);
  });
  // A payslip is a projection of the posted run line, not a separate payload:
  // same gl-view gate as the run read and the same branch guard on the run id.
  app.get('/api/payroll-runs/:id/payslips/:employeeId/print', requirePermission('gl-view'), async (req, res, next) => {
    get_payslipPrint(req as any, res as any).catch(next);
  });
  app.post('/api/payroll-runs', requirePermission('gl-post'), async (req, res, next) => {
    post_payrollRun(req as any, res as any).catch(next);
  });
  app.post('/api/payroll-runs/:id/pay', requirePermission('gl-post'), async (req, res, next) => {
    post_payrollPayment(req as any, res as any).catch(next);
  });
}
