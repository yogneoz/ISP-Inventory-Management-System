/**
 * Payroll routes. The employee picker's bounded search accepts `gl-view` or
 * `gl-post`. The employee master reads use `hr-employee-view` (or the legacy
 * `gl-payroll-manage`), and writes use `hr-employee-manage` (or the legacy
 * grant), so HR access can be granted without payroll posting. Run reads accept
 * `gl-view` or the HR/payroll grants so HR can follow the draft it prepared;
 * posting/payment stays on `gl-payroll-post`. Payslips and the register use the
 * same run-read gate and are refused before posting by the controller.
 */
import type { Express } from 'express';
import { requirePermission, requirePermissionAny } from '../middleware';
import {
  delete_payrollRunDraft,
  get_employee,
  get_employeeLedger,
  get_employeeUserOptions,
  get_employees,
  get_payrollRun,
  get_payrollRunBankFile,
  get_payrollRunPayslip,
  get_payrollRunPayslips,
  get_payrollRunRegister,
  get_payrollPostings,
  get_payrollRuns,
  patch_employee,
  post_employee,
  post_payrollPayment,
  post_payrollRun,
  post_payrollRunApprove,
  post_payrollRunDraft,
  post_payrollRunPost,
  search_employees,
} from '../controllers/payroll.controller';
import { get_payslipPrint } from '../controllers/pdf.controller';

export function registerPayrollRoutes(app: Express) {
  // Bounded employee picker for the voucher form. A manual poster may search
  // this slim projection without the employee master; it excludes PAN, SSF and
  // bank details, and the model clamps the page size.
  app.get('/api/employees/search', requirePermissionAny('gl-view', 'gl-post'), async (req, res, next) => {
    search_employees(req as any, res as any).catch(next);
  });
  // Employee master (branch-scoped by the registry and re-checked in-handler).
  // `gl-payroll-manage` remains accepted so existing payroll managers do not
  // lose access before the hr-* defaults are rolled out to their roles.
  app.get('/api/employees', requirePermissionAny('hr-employee-view', 'gl-payroll-manage'), async (req, res, next) => {
    get_employees(req as any, res as any).catch(next);
  });
  app.get('/api/employees/user-options', requirePermissionAny('hr-employee-manage', 'gl-payroll-manage'), async (req, res, next) => {
    get_employeeUserOptions(req as any, res as any).catch(next);
  });
  // Detail read shares the list's gate; the controller masks PII unless the
  // caller also holds the manage grant (or the legacy payroll grant).
  app.get('/api/employees/:id', requirePermissionAny('hr-employee-view', 'gl-payroll-manage'), async (req, res, next) => {
    get_employee(req as any, res as any).catch(next);
  });
  app.post('/api/employees', requirePermissionAny('hr-employee-manage', 'gl-payroll-manage'), async (req, res, next) => {
    post_employee(req as any, res as any).catch(next);
  });
  app.patch('/api/employees/:id', requirePermissionAny('hr-employee-manage', 'gl-payroll-manage'), async (req, res, next) => {
    patch_employee(req as any, res as any).catch(next);
  });
  app.get('/api/employees/:id/ledger', requirePermission('gl-view'), async (req, res, next) => {
    get_employeeLedger(req as any, res as any).catch(next);
  });

  // Payroll runs: one journal per posted run, one payment journal when paid.
  // The Finance postings register is a stricter read than a generic run read,
  // so it must be registered before `/:id` and is gated on `gl-view` alone.
  app.get('/api/payroll-runs/postings', requirePermission('gl-view'), async (req, res, next) => {
    get_payrollPostings(req as any, res as any).catch(next);
  });
  app.get(
    '/api/payroll-runs',
    requirePermissionAny('gl-view', 'hr-employee-manage', 'gl-payroll-manage'),
    async (req, res, next) => {
      get_payrollRuns(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/payroll-runs/:id',
    requirePermissionAny('gl-view', 'hr-employee-manage', 'gl-payroll-manage'),
    async (req, res, next) => {
      get_payrollRun(req as any, res as any).catch(next);
    }
  );
  // Payslips and the register are read-only projections of posted run-line
  // snapshots. They share the run-read gate; the controller refuses DRAFT and
  // APPROVED runs with a 409 and repeats the branch check.
  const payrollOutputRead = requirePermissionAny(
    'gl-view',
    'hr-employee-manage',
    'gl-payroll-manage'
  );
  app.get('/api/payroll-runs/:id/payslips', payrollOutputRead, async (req, res, next) => {
    get_payrollRunPayslips(req as any, res as any).catch(next);
  });
  app.get(
    '/api/payroll-runs/:id/payslips/:employeeId/print',
    payrollOutputRead,
    async (req, res, next) => {
      get_payslipPrint(req as any, res as any).catch(next);
    }
  );
  app.get('/api/payroll-runs/:id/payslips/:employeeId', payrollOutputRead, async (req, res, next) => {
    get_payrollRunPayslip(req as any, res as any).catch(next);
  });
  app.get('/api/payroll-runs/:id/register', payrollOutputRead, async (req, res, next) => {
    get_payrollRunRegister(req as any, res as any).catch(next);
  });
  // The bank file is the one output that necessarily carries every account
  // number, so it deliberately does not use the broader run-read gate.
  app.get(
    '/api/payroll-runs/:id/bank-file',
    requirePermissionAny('hr-employee-manage', 'gl-payroll-manage'),
    async (req, res, next) => {
      get_payrollRunBankFile(req as any, res as any).catch(next);
    }
  );
  app.post('/api/payroll-runs', requirePermission('gl-payroll-post'), async (req, res, next) => {
    post_payrollRun(req as any, res as any).catch(next);
  });
  // Generated runs: HR prepares a DRAFT; Finance approves, posts and pays.
  // The manual direct-post route above stays for imported/legacy payroll.
  app.post(
    '/api/payroll-runs/draft',
    requirePermissionAny('hr-employee-manage', 'gl-payroll-manage'),
    async (req, res, next) => {
      post_payrollRunDraft(req as any, res as any).catch(next);
    }
  );
  app.post('/api/payroll-runs/:id/approve', requirePermission('gl-payroll-post'), async (req, res, next) => {
    post_payrollRunApprove(req as any, res as any).catch(next);
  });
  app.post('/api/payroll-runs/:id/post', requirePermission('gl-payroll-post'), async (req, res, next) => {
    post_payrollRunPost(req as any, res as any).catch(next);
  });
  app.delete(
    '/api/payroll-runs/:id',
    requirePermissionAny('hr-employee-manage', 'gl-payroll-manage'),
    async (req, res, next) => {
      delete_payrollRunDraft(req as any, res as any).catch(next);
    }
  );
  app.post('/api/payroll-runs/:id/pay', requirePermission('gl-payroll-post'), async (req, res, next) => {
    post_payrollPayment(req as any, res as any).catch(next);
  });
}
