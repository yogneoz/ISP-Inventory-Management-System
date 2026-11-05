/**
 * Accounting ledger routes. Registration order is preserved by app.ts calling
 * this after the operational routes; every route is permission-gated and the
 * journal record path is additionally branch-guarded by the registry.
 */
import type { Express } from 'express';
import { requirePermission, requirePermissionAny } from '../middleware';
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
  get_settlementAccounts,
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
  post_reverseJournal,
  post_reopenPeriod,
} from '../controllers/accounting.controller';
import {
  delete_billTerm,
  get_billTerms,
  patch_billTerm,
  post_billTerm,
} from '../controllers/billTerms.controller';
import {
  delete_subledger,
  get_chartHealth,
  get_subledgerEntries,
  get_subledgers,
  patch_subledger,
  post_chartDefaults,
  post_generateSubledgers,
  post_subledger,
} from '../controllers/subledgers.controller';
import {
  delete_costCenter,
  delete_narrationTemplate,
  get_costCenters,
  get_narrationTemplates,
  patch_costCenter,
  patch_narrationTemplate,
  post_costCenter,
  post_narrationTemplate,
} from '../controllers/accountingMasters.controller';
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
  // Payment forms need the cash/bank picker without the full chart. Any of the
  // three operations may read it: ledger viewers, receipt writers and payment
  // writers. The response is only the active CASH/BANK ledgers.
  app.get(
    '/api/accounting/settlement-accounts',
    requirePermissionAny('gl-view', 'sales-invoice-create', 'inv-pay'),
    async (req, res, next) => {
      get_settlementAccounts(req as any, res as any).catch(next);
    }
  );
  app.post('/api/accounting/accounts', requirePermission('gl-manage'), async (req, res, next) => {
    post_account(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/accounts/:id', requirePermission('gl-manage'), async (req, res, next) => {
    patch_account(req as any, res as any).catch(next);
  });
  app.delete('/api/accounting/accounts/:id', requirePermission('gl-manage'), async (req, res, next) => {
    delete_account(req as any, res as any).catch(next);
  });
  // Subledger master: one book per control account, plus the chart setup
  // health panel and its idempotent default repair.
  app.get('/api/accounting/subledgers', requirePermission('gl-view'), async (req, res, next) => {
    get_subledgers(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/subledgers/:id/entries', requirePermission('gl-view'), async (req, res, next) => {
    get_subledgerEntries(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/subledgers/generate', requirePermission('gl-manage'), async (req, res, next) => {
    post_generateSubledgers(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/subledgers', requirePermission('gl-manage'), async (req, res, next) => {
    post_subledger(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/subledgers/:id', requirePermission('gl-manage'), async (req, res, next) => {
    patch_subledger(req as any, res as any).catch(next);
  });
  app.delete('/api/accounting/subledgers/:id', requirePermission('gl-manage'), async (req, res, next) => {
    delete_subledger(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/chart-health', requirePermission('gl-view'), async (req, res, next) => {
    get_chartHealth(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/chart-defaults', requirePermission('gl-manage'), async (req, res, next) => {
    post_chartDefaults(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/posting-defaults', requirePermission('gl-view'), async (req, res, next) => {
    get_postingDefaults(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/bill-terms', requirePermission('gl-view'), async (req, res, next) => {
    get_billTerms(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/bill-terms', requirePermission('gl-manage'), async (req, res, next) => {
    post_billTerm(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/bill-terms/:id', requirePermission('gl-manage'), async (req, res, next) => {
    patch_billTerm(req as any, res as any).catch(next);
  });
  app.delete('/api/accounting/bill-terms/:id', requirePermission('gl-manage'), async (req, res, next) => {
    delete_billTerm(req as any, res as any).catch(next);
  });

  // Analytical dimensions and narration text. Cost centres are required to be
  // active and branch-compatible when a journal line names them; narrations
  // are quick-pick text and are never stored as a journal foreign key.
  app.get('/api/accounting/cost-centers', requirePermission('gl-view'), async (req, res, next) => {
    get_costCenters(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/cost-centers', requirePermission('gl-manage'), async (req, res, next) => {
    post_costCenter(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/cost-centers/:id', requirePermission('gl-manage'), async (req, res, next) => {
    patch_costCenter(req as any, res as any).catch(next);
  });
  app.delete('/api/accounting/cost-centers/:id', requirePermission('gl-manage'), async (req, res, next) => {
    delete_costCenter(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/narrations', requirePermission('gl-view'), async (req, res, next) => {
    get_narrationTemplates(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/narrations', requirePermission('gl-manage'), async (req, res, next) => {
    post_narrationTemplate(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/narrations/:id', requirePermission('gl-manage'), async (req, res, next) => {
    patch_narrationTemplate(req as any, res as any).catch(next);
  });
  app.delete('/api/accounting/narrations/:id', requirePermission('gl-manage'), async (req, res, next) => {
    delete_narrationTemplate(req as any, res as any).catch(next);
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
  app.post('/api/accounting/journals/:id/reverse', requirePermission('gl-post'), async (req, res, next) => {
    post_reverseJournal(req as any, res as any).catch(next);
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
