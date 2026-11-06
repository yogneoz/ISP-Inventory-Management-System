/**
 * Payroll routes. Reads use the ledger's `gl-view` gate, employee-master writes
 * use `gl-payroll-manage`, and run posting/payment uses `gl-payroll-post`, so a
 * role can maintain payroll without gaining manual-journal posting (or post a
 * run without being able to edit the employee master).
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
  app.post('/api/employees', requirePermission('gl-payroll-manage'), async (req, res, next) => {
    post_employee(req as any, res as any).catch(next);
  });
  app.patch('/api/employees/:id', requirePermission('gl-payroll-manage'), async (req, res, next) => {
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
  app.post('/api/payroll-runs', requirePermission('gl-payroll-post'), async (req, res, next) => {
    post_payrollRun(req as any, res as any).catch(next);
  });
  app.post('/api/payroll-runs/:id/pay', requirePermission('gl-payroll-post'), async (req, res, next) => {
    post_payrollPayment(req as any, res as any).catch(next);
  });
}
