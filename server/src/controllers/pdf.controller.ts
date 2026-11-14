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
import { PI_FIND_BY_ID_SQL, PO_PRINT_SELECT_SQL } from '../models/procurement.repo';
import { SI_FIND_ONE_SQL } from '../models/sales.repo';
import { loadPayrollOutput } from './payroll.controller';
import {
  buildBalanceSheet,
  buildCashFlow,
  buildProfitAndLoss,
  buildTrialBalance,
  resolveStatementWindow,
  type StatementMode,
} from '../services/accountingStatements.service';
import {
  buildInvoicePdf,
  buildPayslipPdf,
  buildPurchaseOrderPdf,
  buildStatementPdf,
  type PdfCompany,
} from '../services/pdf.service';
import { isBsDateMissing, resolveBsDateForLedger } from '../utils/bsDate';
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

type PrintableStatementMode = Exclude<StatementMode, 'BALANCE_SHEET_MOVEMENT'>;

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

/** GET /api/purchase-orders/:id/print */
export async function get_purchaseOrderPrint(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 100);
  if (!id) throw new ApiError(400, 'A purchase order id or number is required.');
  const po = (await pgPool.query(PO_PRINT_SELECT_SQL, [id])).rows[0];
  if (!po) throw new ApiError(404, 'Purchase order not found.');
  if (!canReadRecordBranch(req, res, String(po.branchId))) return;

  const buffer = await buildPurchaseOrderPdf({
    po,
    company: await loadCompany(),
    branchName: branchLabel(String(po.branchId)),
  });
  sendPdf(res, buffer, `purchase-order-${po.poNumber}.pdf`);
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
        : mode === 'CASH_FLOW'
          ? await buildCashFlow(pgPool, window)
          : await buildBalanceSheet(pgPool, window);

  // A printed statement is an official Nepali report: derive both period
  // boundaries from bs_day_records so the header carries AD and BS. An unseeded
  // day is omitted (the header shows the AD date alone) — never a fabricated BS.
  const [toBS, fromBS] = await Promise.all([
    resolveBsDateForLedger(window.to),
    window.from ? resolveBsDateForLedger(window.from) : Promise.resolve(null),
  ]);
  const bsOrNull = (value: string | null | undefined) =>
    value && !isBsDateMissing(value) ? value : null;

  const buffer = await buildStatementPdf({
    kind: mode,
    statement,
    company: await loadCompany(),
    branchName: scope.branchId ? branchLabel(scope.branchId) : 'All branches',
    fromBS: bsOrNull(fromBS),
    toBS: bsOrNull(toBS),
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

/** GET /api/accounting/statements/cash-flow/print */
export async function get_cashFlowPrint(req: any, res: Response): Promise<any> {
  return printStatement(req, res, 'CASH_FLOW');
}

/** GET /api/payroll-runs/:id/payslips/:employeeId/print */
export async function get_payslipPrint(req: any, res: Response): Promise<any> {
  const employeeId = text(req.params?.employeeId, 50);
  if (!employeeId) throw new ApiError(400, 'An employee id or code is required.');
  const loaded = await loadPayrollOutput(req, res);
  if (!loaded) return;
  const line = loaded.lines.find(
    (row: any) => String(row.employeeId) === employeeId || String(row.employeeCode) === employeeId
  );
  const payslip = loaded.output.payslips.find(
    (row) => row.employeeId === employeeId || row.employeeCode === employeeId
  );
  if (!line || !payslip) throw new ApiError(404, 'This employee is not part of the payroll run.');

  const buffer = await buildPayslipPdf({
    run: loaded.run,
    line,
    payslip,
    employee: { ...payslip, name: payslip.employeeName },
    company: await loadCompany(),
    branchName: loaded.run.branchName,
  });
  sendPdf(res, buffer, `payslip-${loaded.run.runNo}-${line.employeeCode}.pdf`);
}
