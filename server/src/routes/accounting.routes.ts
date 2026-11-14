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
  get_bsLedgerSummary,
  get_balanceSheet,
  get_balanceSheetMovement,
  get_branchBalanceSheet,
  get_branchProfitAndLoss,
  get_cashFlow,
  get_cashFlowForecast,
  get_cashFlowForecastExport,
  get_cashBook,
  get_bankPosition,
  get_fiscalYearBalances,
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
  search_accounts,
} from '../controllers/accounting.controller';
import {
  delete_cashFlowManualInput,
  get_cashFlowManualInputs,
  patch_cashFlowManualInput,
  post_cashFlowManualInput,
} from '../controllers/cashFlowForecast.controller';
import {
  delete_recurringTemplate,
  get_periodChecklist,
  get_recurringTemplate,
  get_recurringTemplatePreview,
  get_recurringTemplates,
  patch_periodChecklistItem,
  patch_recurringTemplate,
  post_recurringTemplate,
  post_recurringTemplateRun,
} from '../controllers/recurringClose.controller';
import {
  get_budget,
  get_budgetAllocation,
  get_budgetDepartmentVariance,
  get_budgetExport,
  get_budgetHistory,
  get_budgetVariance,
  get_budgetVarianceAlerts,
  get_budgetVarianceLines,
  get_budgetVarianceUtilisation,
  get_budgetVersion,
  post_budgetCopy,
  post_budgetLock,
  post_budgetImport,
  post_budgetRestore,
  put_budget,
  put_budgetAllocation,
} from '../controllers/budget.controller';
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
  get_cashFlowPrint,
  get_profitAndLossPrint,
  get_trialBalancePrint,
} from '../controllers/pdf.controller';
import {
  post_cashClose as post_dailyCashClose,
  post_reopenCashClose as post_reopenDailyCashClose,
  get_cashClose as get_dailyCashClose,
  get_cashCloseConsolidated as get_dailyCashCloseConsolidated,
} from '../controllers/cashClose.controller';
import {
  get_bankReconciliation,
  post_bankReconciliationImport,
  post_bankReconciliationLock,
  post_bankReconciliationMatch,
  post_bankReconciliationReopen,
  post_bankReconciliationSession,
  post_bankReconciliationUnmatch,
} from '../controllers/bankReconciliation.controller';
import {
  get_walletReconciliation,
  post_walletReconciliationImport,
  post_walletReconciliationMatch,
  post_walletSettlement,
} from '../controllers/walletSettlement.controller';
import { get_inventoryReconciliation } from '../controllers/inventoryReconciliation.controller';

export function registerAccountingRoutes(app: Express) {
  // Chart of accounts + posting defaults.
  app.get('/api/accounting/groups', requirePermission('gl-view'), async (req, res, next) => {
    get_accountGroups(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/groups', requirePermission('gl-chart-manage'), async (req, res, next) => {
    post_accountGroup(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/groups/:id', requirePermission('gl-chart-manage'), async (req, res, next) => {
    patch_accountGroup(req as any, res as any).catch(next);
  });
  app.delete('/api/accounting/groups/:id', requirePermission('gl-chart-manage'), async (req, res, next) => {
    delete_accountGroup(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/accounts', requirePermission('gl-view'), async (req, res, next) => {
    get_accounts(req as any, res as any).catch(next);
  });
  // Bounded ledger lookup for searchable pickers. A manual voucher poster may
  // read it without holding the full chart-read grant, because the entry form
  // cannot be completed without choosing a ledger.
  app.get(
    '/api/accounting/accounts/search',
    requirePermissionAny('gl-view', 'gl-post'),
    async (req, res, next) => {
      search_accounts(req as any, res as any).catch(next);
    }
  );
  // Payment and voucher forms need the cash/bank picker without the full
  // chart. Ledger viewers, manual voucher posters, receipt writers and payment
  // writers may read it. The response is only the active CASH/BANK ledgers.
  app.get(
    '/api/accounting/settlement-accounts',
    requirePermissionAny('gl-view', 'gl-post', 'sales-invoice-create', 'inv-pay'),
    async (req, res, next) => {
      get_settlementAccounts(req as any, res as any).catch(next);
    }
  );
  app.post('/api/accounting/accounts', requirePermission('gl-chart-manage'), async (req, res, next) => {
    post_account(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/accounts/:id', requirePermission('gl-chart-manage'), async (req, res, next) => {
    patch_account(req as any, res as any).catch(next);
  });
  app.delete('/api/accounting/accounts/:id', requirePermission('gl-chart-manage'), async (req, res, next) => {
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
  app.post('/api/accounting/subledgers/generate', requirePermission('gl-subledger-manage'), async (req, res, next) => {
    post_generateSubledgers(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/subledgers', requirePermission('gl-subledger-manage'), async (req, res, next) => {
    post_subledger(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/subledgers/:id', requirePermission('gl-subledger-manage'), async (req, res, next) => {
    patch_subledger(req as any, res as any).catch(next);
  });
  app.delete('/api/accounting/subledgers/:id', requirePermission('gl-subledger-manage'), async (req, res, next) => {
    delete_subledger(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/chart-health', requirePermission('gl-view'), async (req, res, next) => {
    get_chartHealth(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/chart-defaults', requirePermission('gl-chart-manage'), async (req, res, next) => {
    post_chartDefaults(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/posting-defaults', requirePermission('gl-view'), async (req, res, next) => {
    get_postingDefaults(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/bill-terms', requirePermission('gl-view'), async (req, res, next) => {
    get_billTerms(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/bill-terms', requirePermission('gl-bill-terms-manage'), async (req, res, next) => {
    post_billTerm(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/bill-terms/:id', requirePermission('gl-bill-terms-manage'), async (req, res, next) => {
    patch_billTerm(req as any, res as any).catch(next);
  });
  app.delete('/api/accounting/bill-terms/:id', requirePermission('gl-bill-terms-manage'), async (req, res, next) => {
    delete_billTerm(req as any, res as any).catch(next);
  });

  // Analytical dimensions and narration text. Cost centres are required to be
  // active and branch-compatible when a journal line names them; narrations
  // are quick-pick text and are never stored as a journal foreign key.
  app.get('/api/accounting/cost-centers', requirePermission('gl-view'), async (req, res, next) => {
    get_costCenters(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/cost-centers', requirePermission('gl-dimension-manage'), async (req, res, next) => {
    post_costCenter(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/cost-centers/:id', requirePermission('gl-dimension-manage'), async (req, res, next) => {
    patch_costCenter(req as any, res as any).catch(next);
  });
  app.delete('/api/accounting/cost-centers/:id', requirePermission('gl-dimension-manage'), async (req, res, next) => {
    delete_costCenter(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/narrations', requirePermission('gl-view'), async (req, res, next) => {
    get_narrationTemplates(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/narrations', requirePermission('gl-dimension-manage'), async (req, res, next) => {
    post_narrationTemplate(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/narrations/:id', requirePermission('gl-dimension-manage'), async (req, res, next) => {
    patch_narrationTemplate(req as any, res as any).catch(next);
  });
  app.delete('/api/accounting/narrations/:id', requirePermission('gl-dimension-manage'), async (req, res, next) => {
    delete_narrationTemplate(req as any, res as any).catch(next);
  });

  // Budgets: account-level monthly amounts per fiscal year + branch. The read
  // is the same posted-ledger gate as every other finance register; a save is
  // chart/master-data work and is audited. The variance route is registered
  // before the single-budget read so `/budgets/variance` is never mistaken for
  // a fiscal-year id.
  app.get('/api/accounting/budgets/history', requirePermission('gl-view'), async (req, res, next) => {
    get_budgetHistory(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/budgets/history/:versionId', requirePermission('gl-view'), async (req, res, next) => {
    get_budgetVersion(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/budgets/history/:versionId/restore', requirePermission('gl-chart-manage'), async (req, res, next) => {
    post_budgetRestore(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/budgets/variance/alerts', requirePermission('gl-view'), async (req, res, next) => {
    get_budgetVarianceAlerts(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/budgets/variance/utilisation', requirePermission('gl-view'), async (req, res, next) => {
    get_budgetVarianceUtilisation(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/budgets/allocation', requirePermission('gl-view'), async (req, res, next) => {
    get_budgetAllocation(req as any, res as any).catch(next);
  });
  app.put('/api/accounting/budgets/allocation', requirePermission('gl-chart-manage'), async (req, res, next) => {
    put_budgetAllocation(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/budgets/variance/departments', requirePermission('gl-view'), async (req, res, next) => {
    get_budgetDepartmentVariance(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/budgets/variance/lines', requirePermission('gl-view'), async (req, res, next) => {
    get_budgetVarianceLines(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/budgets/variance', requirePermission('gl-view'), async (req, res, next) => {
    get_budgetVariance(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/budgets/export', requirePermission('gl-view'), async (req, res, next) => {
    get_budgetExport(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/budgets/lock', requirePermission('gl-chart-manage'), async (req, res, next) => {
    post_budgetLock(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/budgets/copy', requirePermission('gl-chart-manage'), async (req, res, next) => {
    post_budgetCopy(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/budgets/import', requirePermission('gl-chart-manage'), async (req, res, next) => {
    post_budgetImport(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/budgets', requirePermission('gl-view'), async (req, res, next) => {
    get_budget(req as any, res as any).catch(next);
  });
  app.put('/api/accounting/budgets', requirePermission('gl-chart-manage'), async (req, res, next) => {
    put_budget(req as any, res as any).catch(next);
  });

  // Recurring journals and the month-end close checklist. A template is
  // branch-owned and previewable; generating one still goes through the normal
  // balanced-journal service and its closed-period gate. Checklist writes use
  // the same close permission as the period gate they feed.
  app.get('/api/accounting/recurring-templates', requirePermission('gl-view'), async (req, res, next) => {
    get_recurringTemplates(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/recurring-templates', requirePermission('gl-post'), async (req, res, next) => {
    post_recurringTemplate(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/recurring-templates/:id/preview', requirePermission('gl-view'), async (req, res, next) => {
    get_recurringTemplatePreview(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/recurring-templates/:id', requirePermission('gl-view'), async (req, res, next) => {
    get_recurringTemplate(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/recurring-templates/:id', requirePermission('gl-post'), async (req, res, next) => {
    patch_recurringTemplate(req as any, res as any).catch(next);
  });
  app.delete('/api/accounting/recurring-templates/:id', requirePermission('gl-post'), async (req, res, next) => {
    delete_recurringTemplate(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/recurring-templates/:id/run', requirePermission('gl-post'), async (req, res, next) => {
    post_recurringTemplateRun(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/periods/:id/checklist', requirePermission('gl-view'), async (req, res, next) => {
    get_periodChecklist(req as any, res as any).catch(next);
  });
  app.patch('/api/accounting/periods/:id/checklist/:itemId', requirePermission('gl-close'), async (req, res, next) => {
    patch_periodChecklistItem(req as any, res as any).catch(next);
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
  app.post('/api/accounting/journals/:id/reverse', requirePermission('gl-reverse'), async (req, res, next) => {
    post_reverseJournal(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/reconciliations', requirePermission('gl-view'), async (req, res, next) => {
    get_reconciliation(req as any, res as any).catch(next);
  });

  // Opening balances: one balanced trial balance per branch, posted into the
  // earliest open period through the same journal helper as everything else.
  app.post('/api/accounting/opening-balances', requirePermission('gl-opening-post'), async (req, res, next) => {
    post_openingBalances(req as any, res as any).catch(next);
  });

  // The immutable snapshot written by a year-end close. Bounded read, same
  // gl-view gate and branch-scope resolution as the financial statements.
  app.get('/api/accounting/fiscal-years/:id/balances', requirePermission('gl-view'), async (req, res, next) => {
    get_fiscalYearBalances(req as any, res as any).catch(next);
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
  // Opening/period/closing movement view. It is intentionally separate from
  // the point-in-time statement above, which must keep rejecting `from`.
  app.get('/api/accounting/statements/balance-sheet-movement', requirePermission('gl-view'), async (req, res, next) => {
    get_balanceSheetMovement(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/statements/branch-profit-and-loss', requirePermission('gl-view'), async (req, res, next) => {
    get_branchProfitAndLoss(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/statements/branch-balance-sheet', requirePermission('gl-view'), async (req, res, next) => {
    get_branchBalanceSheet(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/statements/bs-summary', requirePermission('gl-view'), async (req, res, next) => {
    get_bsLedgerSummary(req as any, res as any).catch(next);
  });
  app.get('/api/accounting/statements/cash-flow', requirePermission('gl-view'), async (req, res, next) => {
    get_cashFlow(req as any, res as any).catch(next);
  });
  // Forward weekly cash-flow forecast and its CSV export. Same gl-view gate
  // and balance-sheet as-of/branch resolution as the cash-flow statement.
  app.get(
    '/api/accounting/statements/cash-flow/forecast/export',
    requirePermission('gl-view'),
    async (req, res, next) => {
      get_cashFlowForecastExport(req as any, res as any).catch(next);
    }
  );
  app.get(
    '/api/accounting/statements/cash-flow/forecast',
    requirePermission('gl-view'),
    async (req, res, next) => {
      get_cashFlowForecast(req as any, res as any).catch(next);
    }
  );
  // Manual forecast adjustments are branch-owned planning rows. The list uses
  // the same gl-view gate as the forecast; writes are ledger-post work and are
  // audited. The by-id route is also guarded by the branch-scope registry.
  app.get(
    '/api/accounting/cash-flow/manual-inputs',
    requirePermission('gl-view'),
    async (req, res, next) => {
      get_cashFlowManualInputs(req as any, res as any).catch(next);
    }
  );
  app.post(
    '/api/accounting/cash-flow/manual-inputs',
    requirePermission('gl-post'),
    async (req, res, next) => {
      post_cashFlowManualInput(req as any, res as any).catch(next);
    }
  );
  app.patch(
    '/api/accounting/cash-flow/manual-inputs/:id',
    requirePermission('gl-post'),
    async (req, res, next) => {
      patch_cashFlowManualInput(req as any, res as any).catch(next);
    }
  );
  app.delete(
    '/api/accounting/cash-flow/manual-inputs/:id',
    requirePermission('gl-post'),
    async (req, res, next) => {
      delete_cashFlowManualInput(req as any, res as any).catch(next);
    }
  );
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
  app.get('/api/accounting/statements/cash-flow/print', requirePermission('gl-view'), async (req, res, next) => {
    get_cashFlowPrint(req as any, res as any).catch(next);
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
  // Bank custody read: company balance per bank account plus the selected
  // branch's movement. Separate from the cash book and the daily cash close.
  app.get('/api/accounting/bank-position', requirePermission('gl-view'), async (req, res, next) => {
    get_bankPosition(req as any, res as any).catch(next);
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
  app.post('/api/accounting/cash-close', requirePermission('gl-cash-close'), async (req, res, next) => {
    post_dailyCashClose(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/cash-close/:id/reopen', requirePermission('gl-cash-close'), async (req, res, next) => {
    post_reopenDailyCashClose(req as any, res as any).catch(next);
  });

  // Bank reconciliation: statement import, matching, unmatched report and the
  // period lock/reopen gate. Reads share gl-view with every other ledger
  // register; writes use the existing cash/bank control grant.
  // ACC-3 provider clearing: settlement posting, provider statement import and
  // settlement matching. Company-wide, like the bank workspace; reads `gl-view`,
  // writes the existing cash/bank control grant `gl-cash-close`.
  app.get('/api/accounting/wallet-reconciliation', requirePermission('gl-view'), async (req, res, next) => {
    get_walletReconciliation(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/wallet-settlements', requirePermission('gl-cash-close'), async (req, res, next) => {
    post_walletSettlement(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/wallet-reconciliation/import', requirePermission('gl-cash-close'), async (req, res, next) => {
    post_walletReconciliationImport(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/wallet-reconciliation/lines/:id/match', requirePermission('gl-cash-close'), async (req, res, next) => {
    post_walletReconciliationMatch(req as any, res as any).catch(next);
  });

  app.get('/api/accounting/inventory-reconciliation', requirePermission('gl-view'), async (req, res, next) => {
    get_inventoryReconciliation(req as any, res as any).catch(next);
  });

  app.get('/api/accounting/bank-reconciliation', requirePermission('gl-view'), async (req, res, next) => {
    get_bankReconciliation(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/bank-reconciliation/import', requirePermission('gl-cash-close'), async (req, res, next) => {
    post_bankReconciliationImport(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/bank-reconciliation/lines/:id/match', requirePermission('gl-cash-close'), async (req, res, next) => {
    post_bankReconciliationMatch(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/bank-reconciliation/lines/:id/unmatch', requirePermission('gl-cash-close'), async (req, res, next) => {
    post_bankReconciliationUnmatch(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/bank-reconciliation/sessions', requirePermission('gl-cash-close'), async (req, res, next) => {
    post_bankReconciliationSession(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/bank-reconciliation/sessions/:id/lock', requirePermission('gl-cash-close'), async (req, res, next) => {
    post_bankReconciliationLock(req as any, res as any).catch(next);
  });
  app.post('/api/accounting/bank-reconciliation/sessions/:id/reopen', requirePermission('gl-cash-close'), async (req, res, next) => {
    post_bankReconciliationReopen(req as any, res as any).catch(next);
  });
}
