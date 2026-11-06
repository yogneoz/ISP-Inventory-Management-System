/**
 * PDF print endpoints.
 *
 * These handlers are read-only projections of documents that already exist in
 * the registers and the ledger. They do not recompute totals: an invoice PDF
 * prints the stored document aggregates and per-line primitives, and a
 * statement PDF prints the same object the JSON statement endpoint returns.
 *
 * Branch scope is checked twice: the app-level `enforceBranchAccess` middleware
 * guards the `:id` paths by table, and each handler repeats the check against
 * the record's own branch so a future route registration cannot widen the
 * document. The route-level permission gate is declared beside each route.
 */
import type { Response } from 'express';
import { branches, getPgConnected, pgPool } from '../app';
import { ApiError } from '../errors/ApiError';
import { allowedBranchScope } from '../middleware/branchScope';
import { COMPANY_PROFILE_SELECT_SQL } from '../models/admin.repo';
import { PI_FIND_BY_ID_SQL } from '../models/procurement.repo';
import { SI_FIND_ONE_SQL } from '../models/sales.repo';
import {
  EMPLOYEE_BY_ID_SQL,
  PAYROLL_LINES_BY_RUN_SQL,
  PAYROLL_RUN_BY_ID_SQL,
} from '../models/payroll.repo';
import {
  buildBalanceSheet,
  buildProfitAndLoss,
  buildTrialBalance,
  resolveStatementWindow,
  type StatementMode,
} from '../services/accountingStatements.service';
import {
  buildInvoicePdf,
  buildPayslipPdf,
  buildStatementPdf,
  type PdfCompany,
} from '../services/pdf.service';
import { resolveBranchScope } from './accounting.controller';

function requireDb(): void {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
}

function text(value: unknown, max = 100): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function branchLabel(branchId: string): string {
  return branches.find((branch) => branch.id === branchId)?.name || branchId;
}

async function loadCompany(): Promise<PdfCompany> {
  const row = (await pgPool.query(COMPANY_PROFILE_SELECT_SQL)).rows[0];
  return row || { name: 'Inventory Management System' };
}

/**
 * A record outside the caller's branch scope is a 403, not a 404: the caller
 * can see the record exists but may not read it. `allowedBranchScope` returns
 * null for a global account and an empty set for an unassigned branch account.
 */
function canReadRecordBranch(req: any, res: Response, branchId: string): boolean {
  const allowed = allowedBranchScope(req.user);
  if (!allowed) return true;
  if (allowed.size === 0 || !allowed.has(branchId)) {
    res.status(403).json({ message: 'Forbidden: this document belongs to another branch.' });
    return false;
  }
  return true;
}

type PrintableStatementMode = Exclude<StatementMode, 'CASH_FLOW'>;

function sendPdf(res: Response, buffer: Buffer, filename: string): void {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, '-');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${safe}"`);
  res.setHeader('Content-Length', String(buffer.length));
  // Financial documents are per-session data; never cache them in a shared proxy.
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(buffer);
}

/** GET /api/sales-invoices/:id/print */
export async function get_salesInvoicePrint(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 100);
  if (!id) throw new ApiError(400, 'A sales invoice id or number is required.');
  const invoice = (await pgPool.query(SI_FIND_ONE_SQL, [id])).rows[0];
  if (!invoice) throw new ApiError(404, 'Sales invoice not found.');
  if (!canReadRecordBranch(req, res, String(invoice.branchId))) return;

  const buffer = await buildInvoicePdf({
    kind: 'SALES_INVOICE',
    document: invoice,
    company: await loadCompany(),
    branchName: branchLabel(String(invoice.branchId)),
  });
  sendPdf(res, buffer, `sales-invoice-${invoice.invoiceNumber}.pdf`);
}

/** GET /api/purchase-invoices/:id/print */
export async function get_purchaseInvoicePrint(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 100);
  if (!id) throw new ApiError(400, 'A purchase invoice id is required.');
  const invoice = (await pgPool.query(PI_FIND_BY_ID_SQL, [id])).rows[0];
  if (!invoice) throw new ApiError(404, 'Purchase invoice not found.');
  if (!canReadRecordBranch(req, res, String(invoice.branchId))) return;

  const buffer = await buildInvoicePdf({
    kind: 'PURCHASE_BILL',
    document: invoice,
    company: await loadCompany(),
    branchName: branchLabel(String(invoice.branchId)),
  });
  sendPdf(res, buffer, `purchase-bill-${invoice.invoiceNumber}.pdf`);
}

async function printStatement(req: any, res: Response, mode: PrintableStatementMode): Promise<any> {
  requireDb();
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  const window = await resolveStatementWindow(pgPool, req.query || {}, mode, {
    branchId: scope.branchId || null,
    empty: Boolean(scope.empty),
  });
  const statement =
    mode === 'TRIAL_BALANCE'
      ? await buildTrialBalance(pgPool, window)
      : mode === 'PROFIT_AND_LOSS'
        ? await buildProfitAndLoss(pgPool, window)
        : await buildBalanceSheet(pgPool, window);

  const buffer = await buildStatementPdf({
    kind: mode,
    statement,
    company: await loadCompany(),
    branchName: scope.branchId ? branchLabel(scope.branchId) : 'All branches',
  });
  sendPdf(res, buffer, `${mode.toLowerCase().replace(/_/g, '-')}-${window.to}.pdf`);
}

/** GET /api/accounting/statements/trial-balance/print */
export async function get_trialBalancePrint(req: any, res: Response): Promise<any> {
  return printStatement(req, res, 'TRIAL_BALANCE');
}

/** GET /api/accounting/statements/profit-and-loss/print */
export async function get_profitAndLossPrint(req: any, res: Response): Promise<any> {
  return printStatement(req, res, 'PROFIT_AND_LOSS');
}

/** GET /api/accounting/statements/balance-sheet/print */
export async function get_balanceSheetPrint(req: any, res: Response): Promise<any> {
  return printStatement(req, res, 'BALANCE_SHEET');
}

/** GET /api/payroll-runs/:id/payslips/:employeeId/print */
export async function get_payslipPrint(req: any, res: Response): Promise<any> {
  requireDb();
  const runId = text(req.params?.id, 50);
  const employeeId = text(req.params?.employeeId, 50);
  if (!runId || !employeeId) throw new ApiError(400, 'A payroll run and employee are required.');

  const run = (await pgPool.query(PAYROLL_RUN_BY_ID_SQL, [runId])).rows[0];
  if (!run) throw new ApiError(404, 'Payroll run not found.');
  if (!canReadRecordBranch(req, res, String(run.branchId))) return;

  const lines = (await pgPool.query(PAYROLL_LINES_BY_RUN_SQL, [runId])).rows;
  const line = lines.find(
    (row: any) => String(row.employeeId) === employeeId || String(row.employeeCode) === employeeId
  );
  if (!line) throw new ApiError(404, 'This employee is not part of the payroll run.');
  const employee = (await pgPool.query(EMPLOYEE_BY_ID_SQL, [line.employeeId])).rows[0] || null;

  const buffer = await buildPayslipPdf({
    run,
    line,
    employee,
    company: await loadCompany(),
    branchName: branchLabel(String(run.branchId)),
  });
  sendPdf(res, buffer, `payslip-${run.runNo}-${line.employeeCode}.pdf`);
}
