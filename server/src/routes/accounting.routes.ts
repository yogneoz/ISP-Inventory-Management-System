/**
 * Accounting ledger routes. Registration order is preserved by app.ts calling
 * this after the operational routes; every route is permission-gated and the
 * journal record path is additionally branch-guarded by the registry.
 */
import type { Express } from 'express';
import { requirePermission } from '../middleware';
import {
  delete_account,
  delete_accountGroup,
  get_accountGroups,
  get_accounts,
  get_aging,
  get_balanceSheet,
  get_cashBook,
  get_journal,
  get_journals,
  get_periods,
  get_postingDefaults,
  get_profitAndLoss,
  get_reconciliation,
  get_statementAccountLines,
  get_statementGroupLines,
  get_trialBalance,
  patch_account,
  patch_accountGroup,
  post_account,
  post_accountGroup,
  post_closePeriod,
  post_journal,
  post_openingBalances,
  post_period,
  post_reopenPeriod,
} from '../controllers/accounting.controller';
import {
  get_balanceSheetPrint,
  get_profitAndLossPrint,
  get_trialBalancePrint,
} from '../controllers/pdf.controller';
import {
  post_cashClose as post_dailyCashClose,
  post_reopenCashClose as post_reopenDailyCashClose,
  get_cashClose as get_dailyCashClose,
  get_cashCloseConsolidated as get_dailyCashCloseConsolidated,
} from '../controllers/cashClose.controller';

export function registerAccountingRoutes(app: Express) {
  // Chart of accounts + posting defaults.
  app.get('/api/accounting/groups', requirePermission('gl-view'), async (req, res, next) => {
    get_accountGroups(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/groups', requirePermission('gl-manage'), async (req, res, next) => {
    post_accountGroup(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/groups/:id', requirePermission('gl-manage'), async (req, res, next) => {
    patch_accountGroup(req as any, res as any).catch(next);
  });
  app.delete('/api/accounting/groups/:id', requirePermission('gl-manage'), async (req, res, next) => {
    delete_accountGroup(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/accounts', requirePermission('gl-view'), async (req, res, next) => {
    get_accounts(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/accounts', requirePermission('gl-manage'), async (req, res, next) => {
    post_account(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/accounts/:id', requirePermission('gl-manage'), async (req, res, next) => {
    patch_account(req as any, res as any).catch(next);
  });
  app.delete('/api/accounting/accounts/:id', requirePermission('gl-manage'), async (req, res, next) => {
    delete_account(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/posting-defaults', requirePermission('gl-view'), async (req, res, next) => {
    get_postingDefaults(req as any, res as any).catch(next);
  });

  // Monthly periods.
  app.get('/api/accounting/periods', requirePermission('gl-view'), async (req, res, next) => {
    get_periods(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/periods', requirePermission('gl-close'), async (req, res, next) => {
    post_period(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/periods/:id/close', requirePermission('gl-close'), async (req, res, next) => {
    post_closePeriod(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/periods/:id/reopen', requirePermission('gl-close'), async (req, res, next) => {
    post_reopenPeriod(req as any, res as any).catch(next);
  });

  // Journals + control-account reconciliation.
  app.get('/api/accounting/journals', requirePermission('gl-view'), async (req, res, next) => {
    get_journals(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/journals/:id', requirePermission('gl-view'), async (req, res, next) => {
    get_journal(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/journals', requirePermission('gl-post'), async (req, res, next) => {
    post_journal(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/reconciliations', requirePermission('gl-view'), async (req, res, next) => {
    get_reconciliation(req as any, res as any).catch(next);
  });

  // Opening balances: one balanced trial balance per branch, posted into the
  // earliest open period through the same journal helper as everything else.
  app.post('/api/accounting/opening-balances', requirePermission('gl-post'), async (req, res, next) => {
    post_openingBalances(req as any, res as any).catch(next);
  });

  // Financial statements, read from the posted journal lines. Same gl-view
  // gate as every other ledger read; the controller resolves branch scope.
  app.get('/api/accounting/statements/trial-balance', requirePermission('gl-view'), async (req, res, next) => {
    get_trialBalance(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/statements/profit-and-loss', requirePermission('gl-view'), async (req, res, next) => {
    get_profitAndLoss(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/statements/balance-sheet', requirePermission('gl-view'), async (req, res, next) => {
    get_balanceSheet(req as any, res as any).catch(next);
  });
  // Drill-down behind one group subtotal: same gl-view gate, same branch/date
  // resolution, and the same POSTED lines the statement was built from.
  app.get('/api/accounting/statements/group-lines', requirePermission('gl-view'), async (req, res, next) => {
    get_statementGroupLines(req as any, res as any).catch(next);
  });
  // Drill-down behind one account row: same gate and scope, plus a
  // debit-positive running balance on each POSTED line.
  app.get('/api/accounting/statements/account-lines', requirePermission('gl-view'), async (req, res, next) => {
    get_statementAccountLines(req as any, res as any).catch(next);
  });

  // Printable copies of the same three statements. Same gl-view gate and the
  // same branch/date resolution as the JSON endpoints above.
  app.get('/api/accounting/statements/trial-balance/print', requirePermission('gl-view'), async (req, res, next) => {
    get_trialBalancePrint(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/statements/profit-and-loss/print', requirePermission('gl-view'), async (req, res, next) => {
    get_profitAndLossPrint(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/statements/balance-sheet/print', requirePermission('gl-view'), async (req, res, next) => {
    get_balanceSheetPrint(req as any, res as any).catch(next);
  });

  // AR/AP aging: party open items through an as-of date, bucketed by days past
  // due, with unapplied credits and the control-account tie-out on the same
  // response. Same gl-view gate as every other ledger read.
  app.get('/api/accounting/aging', requirePermission('gl-view'), async (req, res, next) => {
    get_aging(req as any, res as any).catch(next);
  });

  // Cash/bank book: opening, receipts, payments and closing per account, plus
  // the movement detail, from the same posted lines as the balance sheet.
  app.get('/api/accounting/cash-book', requirePermission('gl-view'), async (req, res, next) => {
    get_cashBook(req as any, res as any).catch(next);
  });

  // Daily cash close: today's branch position, the company roll-up, and the
  // counted close/reopen. Figures are the same posted cash/bank lines the cash
  // book and balance sheet read; close/reopen need the ledger write gate.
  app.get('/api/accounting/cash-close', requirePermission('gl-view'), async (req, res, next) => {
    get_dailyCashClose(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/cash-close/consolidated', requirePermission('gl-view'), async (req, res, next) => {
    get_dailyCashCloseConsolidated(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/cash-close', requirePermission('gl-post'), async (req, res, next) => {
    post_dailyCashClose(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/cash-close/:id/reopen', requirePermission('gl-post'), async (req, res, next) => {
    post_reopenDailyCashClose(req as any, res as any).catch(next);
  });
}
