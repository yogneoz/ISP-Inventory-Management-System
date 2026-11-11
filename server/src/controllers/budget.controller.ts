/**
 * Budget HTTP surface. Reads share the ledger's `gl-view` gate; writes require
 * `gl-chart-manage` because a budget is master data, not a posting. Branch
 * scope always comes from the session (or a branch the session may access),
 * never from an unvalidated body/query claim.
 */
import type { Response } from 'express';
import { getPgConnected, pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { ApiError } from '../errors/ApiError';
import { getUserFromReq } from '../middleware/auth';
import { logAuditEvent } from '../services/audit.service';
import { isUniqueViolation } from '../services/accounting.service';
import {
  buildBudgetBranchUtilisation,
  buildBudgetOverspendAlerts,
  buildBudgetVariance,
  setBudgetLock,
  buildBudgetVarianceLines,
  readBudget,
  readBudgetHistory,
  readBudgetVersion,
  restoreBudgetVersion,
  saveBudget,
} from '../services/budget.service';
import {
  copyBudget,
  exportBudgetCsv,
  importBudgetCsv,
} from '../services/budgetTransfer.service';
import {
  buildBudgetDepartmentVariance,
  readBudgetAllocation,
  saveBudgetAllocation,
} from '../services/budgetAllocation.service';
import { resolveBranchScope } from './accounting.controller';

function actorOf(req: any): string | null {
  const user = getUserFromReq(req);
  return user.email || user.name || null;
}

function queryText(req: any, field: string): string {
  return typeof req.query?.[field] === 'string' ? req.query[field].trim() : '';
}

/** GET /api/accounting/budgets — one branch's budget plus editor pick lists. */
export async function get_budget(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty || !scope.branchId) {
    throw new ApiError(400, 'Choose a branch to view or edit its budget.');
  }
  const budget = await readBudget(
    pgPool,
    queryText(req, 'fiscalYearId'),
    scope.branchId
  );
  return res.json(budget);
}

/** GET /api/accounting/budgets/history — immutable version list. */
export async function get_budgetHistory(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty || !scope.branchId) {
    throw new ApiError(400, 'Choose a branch to view its budget history.');
  }
  const history = await readBudgetHistory(
    pgPool,
    queryText(req, 'fiscalYearId'),
    scope.branchId
  );
  return res.json(history);
}

/** GET /api/accounting/budgets/history/:versionId — one stored version. */
export async function get_budgetVersion(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty || !scope.branchId) {
    throw new ApiError(400, 'Choose a branch to view a budget version.');
  }
  const version = await readBudgetVersion(
    pgPool,
    queryText(req, 'fiscalYearId'),
    scope.branchId,
    req.params?.versionId
  );
  return res.json(version);
}

/** POST /api/accounting/budgets/history/:versionId/restore — append a new
 *  snapshot of the current state, then put the selected version back. */
export async function post_budgetRestore(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const body = req.body || {};
  const scope = resolveBranchScope(req, res, body.branchId);
  if (!scope) return;
  if (scope.empty || !scope.branchId || scope.branchId === 'ALL') {
    throw new ApiError(400, 'Choose a branch to restore its budget.');
  }

  try {
    const restored = await withTransaction(async (client) => {
      const result = await restoreBudgetVersion(
        client,
        {
          fiscalYearId: body.fiscalYearId,
          branchId: scope.branchId,
          versionId: req.params?.versionId,
        },
        actorOf(req)
      );
      await logAuditEvent(
        req,
        'RESTORE_GL_BUDGET',
        'ACCOUNTING',
        `Restored budget version ${result.restoredVersion} for FY ${result.budget.fiscalYearCode} ${result.budget.branchName}`,
        undefined,
        client
      );
      return result;
    });
    return res.json(restored);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        409,
        'This budget was changed by another user. Reload its history and try again.'
      );
    }
    throw err;
  }
}

/** PUT /api/accounting/budgets — replace open-period budget lines. */
export async function put_budget(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const body = req.body || {};
  const scope = resolveBranchScope(req, res, body.branchId);
  if (!scope) return;
  if (scope.empty || !scope.branchId) {
    throw new ApiError(400, 'Choose a branch to view or edit its budget.');
  }

  try {
    const budget = await withTransaction(async (client) => {
      const saved = await saveBudget(
        client,
        {
          fiscalYearId: body.fiscalYearId,
          branchId: scope.branchId,
          lines: body.lines,
        },
        actorOf(req)
      );
      await logAuditEvent(
        req,
        'SAVE_GL_BUDGET',
        'ACCOUNTING',
        `Saved budget ${saved.fiscalYearCode} ${saved.branchName} (${saved.lines.length} line${saved.lines.length === 1 ? '' : 's'})`,
        undefined,
        client
      );
      return saved;
    });
    return res.json(budget);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        409,
        'This budget was changed by another user. Reload it and try again.'
      );
    }
    throw err;
  }
}

/** POST /api/accounting/budgets/lock — explicitly lock or unlock a budget. */
export async function post_budgetLock(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const body = req.body || {};
  const scope = resolveBranchScope(req, res, body.branchId);
  if (!scope) return;
  if (scope.empty || !scope.branchId || scope.branchId === 'ALL') {
    throw new ApiError(400, 'Choose a branch to lock its budget.');
  }

  const result = await withTransaction(async (client) => {
    const locked = await setBudgetLock(
      client,
      {
        fiscalYearId: body.fiscalYearId,
        branchId: scope.branchId,
        locked: body.locked,
      },
      actorOf(req)
    );
    if (locked.status !== 'UNCHANGED') {
      await logAuditEvent(
        req,
        locked.status === 'LOCKED' ? 'LOCK_GL_BUDGET' : 'UNLOCK_GL_BUDGET',
        'ACCOUNTING',
        `${locked.status === 'LOCKED' ? 'Locked' : 'Unlocked'} budget FY ${locked.budget.fiscalYearCode} for ${locked.budget.branchName}`,
        undefined,
        client
      );
    }
    return locked;
  });
  return res.json(result);
}

/** POST /api/accounting/budgets/copy — copy one year's budget forward. */
export async function post_budgetCopy(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const body = req.body || {};
  const scope = resolveBranchScope(req, res, body.branchId);
  if (!scope) return;
  if (scope.empty || !scope.branchId) {
    throw new ApiError(400, 'Choose a branch to copy its budget.');
  }

  try {
    const copied = await withTransaction(async (client) => {
      const result = await copyBudget(
        client,
        {
          sourceFiscalYearId: body.sourceFiscalYearId,
          targetFiscalYearId: body.targetFiscalYearId,
          branchId: scope.branchId,
          replace: body.replace,
        },
        actorOf(req)
      );
      if (result.status !== 'UNCHANGED') {
        await logAuditEvent(
          req,
          'COPY_GL_BUDGET',
          'ACCOUNTING',
          `Copied budget ${result.sourceFiscalYearCode} to ${result.targetFiscalYearCode} for ${result.branchName} (${result.copiedLines} line${result.copiedLines === 1 ? '' : 's'}, ${result.status.toLowerCase()})`,
          undefined,
          client
        );
      }
      return result;
    });
    return res.json(copied);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        409,
        'This budget was changed by another user. Reload it and try again.'
      );
    }
    throw err;
  }
}

/** POST /api/accounting/budgets/import — validated all-or-nothing CSV import. */
export async function post_budgetImport(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const body = req.body || {};
  const scope = resolveBranchScope(req, res, body.branchId);
  if (!scope) return;
  if (scope.empty || !scope.branchId) {
    throw new ApiError(400, 'Choose a branch to import its budget.');
  }

  const result = await withTransaction(async (client) => {
    const imported = await importBudgetCsv(
      client,
      {
        fiscalYearId: body.fiscalYearId,
        branchId: scope.branchId,
        csv: body.csv,
        replace: body.replace,
      },
      actorOf(req)
    );
    if (imported.status !== 'REFUSED' && imported.status !== 'UNCHANGED') {
      await logAuditEvent(
        req,
        'IMPORT_GL_BUDGET',
        'ACCOUNTING',
        `Imported budget ${imported.budget?.fiscalYearCode || body.fiscalYearId} for ${imported.budget?.branchName || scope.branchId} (${imported.importedLines} line${imported.importedLines === 1 ? '' : 's'}, ${imported.status.toLowerCase()})`,
        undefined,
        client
      );
    }
    return imported;
  });
  return res.status(result.httpStatus).json(result);
}

/** GET /api/accounting/budgets/export — CSV that round-trips into import. */
export async function get_budgetExport(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty || !scope.branchId) {
    throw new ApiError(400, 'Choose a branch to export its budget.');
  }

  const { filename, csv } = await exportBudgetCsv(
    pgPool,
    queryText(req, 'fiscalYearId'),
    scope.branchId
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(csv);
}

/** GET /api/accounting/budgets/variance/alerts — dashboard overspend feed. */
export async function get_budgetVarianceAlerts(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) {
    throw new ApiError(403, 'No branch is assigned to this account.');
  }

  const alerts = await buildBudgetOverspendAlerts(pgPool, {
    fiscalYearId: queryText(req, 'fiscalYearId'),
    branchId: scope.branchId ?? null,
    from: queryText(req, 'from'),
    to: queryText(req, 'to'),
    limit: req.query?.limit,
  });
  return res.json(alerts);
}

/** GET /api/accounting/budgets/variance/utilisation — cards by branch. */
export async function get_budgetVarianceUtilisation(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) {
    throw new ApiError(403, 'No branch is assigned to this account.');
  }

  const utilisation = await buildBudgetBranchUtilisation(pgPool, {
    fiscalYearId: queryText(req, 'fiscalYearId'),
    branchId: scope.branchId ?? null,
    from: queryText(req, 'from'),
    to: queryText(req, 'to'),
  });
  return res.json(utilisation);
}

/** GET /api/accounting/budgets/variance/lines — POSTED lines behind one row. */
export async function get_budgetVarianceLines(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) {
    throw new ApiError(403, 'No branch is assigned to this account.');
  }

  const lines = await buildBudgetVarianceLines(pgPool, {
    fiscalYearId: queryText(req, 'fiscalYearId'),
    branchId: scope.branchId ?? null,
    accountId: queryText(req, 'accountId'),
    from: queryText(req, 'from'),
    to: queryText(req, 'to'),
    limit: req.query?.limit,
  });
  return res.json(lines);
}

/** GET /api/accounting/budgets/allocation — branch OPEX allocation profile. */
export async function get_budgetAllocation(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) throw new ApiError(403, 'No branch is assigned to this account.');
  if (!scope.branchId || scope.branchId === 'ALL') {
    throw new ApiError(400, 'Choose a branch to view its cost-centre allocation.');
  }

  const allocation = await readBudgetAllocation(
    pgPool,
    queryText(req, 'fiscalYearId'),
    scope.branchId
  );
  return res.json(allocation);
}

/** GET /api/accounting/budgets/variance/departments — tagged actuals by centre. */
export async function get_budgetDepartmentVariance(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) throw new ApiError(403, 'No branch is assigned to this account.');
  if (!scope.branchId || scope.branchId === 'ALL') {
    throw new ApiError(400, 'Choose a branch to view department utilisation.');
  }

  const departments = await buildBudgetDepartmentVariance(pgPool, {
    fiscalYearId: queryText(req, 'fiscalYearId'),
    branchId: scope.branchId,
    from: queryText(req, 'from'),
    to: queryText(req, 'to'),
  });
  return res.json(departments);
}

/** PUT /api/accounting/budgets/allocation — replace one branch's OPEX split. */
export async function put_budgetAllocation(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const body = req.body || {};
  const scope = resolveBranchScope(req, res, body.branchId);
  if (!scope) return;
  if (scope.empty || !scope.branchId || scope.branchId === 'ALL') {
    throw new ApiError(400, 'Choose a branch to save its cost-centre allocation.');
  }

  try {
    const saved = await withTransaction(async (client) => {
      const allocation = await saveBudgetAllocation(
        client,
        {
          fiscalYearId: body.fiscalYearId,
          branchId: scope.branchId,
          rules: body.rules,
        },
        actorOf(req)
      );
      await logAuditEvent(
        req,
        'SAVE_GL_BUDGET_ALLOCATION',
        'ACCOUNTING',
        `Saved OPEX cost-centre allocation for FY ${allocation.fiscalYearCode} ${allocation.branchName} (${allocation.rules.length} rule${allocation.rules.length === 1 ? '' : 's'})`,
        undefined,
        client
      );
      return allocation;
    });
    return res.json(saved);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        409,
        'This allocation was changed by another user. Reload it and try again.'
      );
    }
    throw err;
  }
}

/** GET /api/accounting/budgets/variance — budget vs POSTED actuals. */
export async function get_budgetVariance(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) {
    throw new ApiError(403, 'No branch is assigned to this account.');
  }

  const variance = await buildBudgetVariance(pgPool, {
    fiscalYearId: queryText(req, 'fiscalYearId'),
    branchId: scope.branchId ?? null,
    from: queryText(req, 'from'),
    to: queryText(req, 'to'),
  });
  return res.json(variance);
}
