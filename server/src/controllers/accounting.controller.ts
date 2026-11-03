/**
 * Accounting ledger HTTP surface — chart of accounts, posting defaults,
 * monthly periods, manual journals and control-account reconciliation.
 *
 * Branch scope is resolved from the session, never trusted from the query
 * string alone: a branch account can only read/post its own branches even if
 * it forges `branchId`. The app-level `enforceBranchAccess` middleware is the
 * first line (it also guards `/accounting/journals/:id` via the branch-scope
 * registry); the controller repeats the check so a future route registration
 * mistake cannot silently widen the ledger.
 */
import type { Response } from 'express';
import { getPgConnected, pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { logAuditEvent } from '../services/audit.service';
import { getUserFromReq } from '../middleware/auth';
import { ApiError } from '../errors/ApiError';
import {
  ACCOUNT_GROUP_LIST_SQL,
  ACCOUNT_LIST_SQL,
  PERIOD_LIST_SQL,
  buildJournalCountQuery,
  buildJournalPageQuery,
  type JournalListOptions,
} from '../models/accounting.repo';
import {
  createAccount,
  createAccountGroup,
  createPeriod,
  deleteAccount,
  deleteAccountGroup,
  isForeignKeyViolation,
  isUniqueViolation,
  postJournal,
  readJournal,
  reconcileControlAccount,
  setPeriodStatus,
  updateAccount,
  updateAccountGroup,
} from '../services/accounting.service';
import {
  buildBalanceSheet,
  buildProfitAndLoss,
  buildStatementGroupLines,
  buildTrialBalance,
  buildTrialBalanceAccountLines,
  buildTrialBalanceGroupLines,
  resolveStatementWindow,
  type StatementGroupDrilldownMode,
  type StatementMode,
} from '../services/accountingStatements.service';
import { buildCashBook } from '../services/accountingCashBook.service';
import { buildAging, type AgingType } from '../services/accountingAging.service';
import { postOpeningBalances } from '../services/accountingClosing.service';

export interface BranchScope {
  /** The concrete filter/default branch; undefined for a global account. */
  branchId?: string;
  /** Every branch this account may read; undefined for a global account. */
  allowed?: Set<string>;
  empty?: boolean;
}

/**
 * The branch filter this request may use. Returns null after writing a 403.
 * Global accounts may use a concrete branch or ALL; branch accounts are pinned
 * to a branch they are assigned to, defaulting to their primary branch.
 */
export function resolveBranchScope(req: any, res: Response): BranchScope | null {
  const user = req.user;
  const raw = typeof req.query?.branchId === 'string' ? req.query.branchId.trim() : '';
  if (!user || user.role === 'SUPER_ADMIN' || user.role === 'HEAD_OFFICE_ADMIN' || user.branchId === 'ALL') {
    return { branchId: raw && raw !== 'ALL' ? raw : undefined };
  }
  const allowed = new Set<string>([user.branchId || '', ...(user.allowedBranchIds || [])].filter(Boolean));
  if (allowed.size === 0) return { empty: true };
  if (raw === 'ALL') {
    res.status(403).json({ message: 'Forbidden: branch users cannot access all branches.' });
    return null;
  }
  if (raw && !allowed.has(raw)) {
    res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
    return null;
  }
  return { branchId: raw || user.branchId || [...allowed][0], allowed };
}

function actorOf(req: any): string | null {
  const user = getUserFromReq(req);
  return user.email || user.name || null;
}

async function inTransaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(fn);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'That accounting record already exists.');
    }
    if (isForeignKeyViolation(err)) {
      throw new ApiError(409, 'That accounting record is still in use and cannot be deleted.');
    }
    throw err;
  }
}

/** GET /api/accounting/groups */
export async function get_accountGroups(_req: any, res: Response): Promise<any> {
  const rows = (await pgPool.query(ACCOUNT_GROUP_LIST_SQL)).rows;
  return res.json(rows);
}

/** POST /api/accounting/groups */
export async function post_accountGroup(req: any, res: Response): Promise<any> {
  const group = await inTransaction(async (client) => {
    const created = await createAccountGroup(client, req.body || {});
    await logAuditEvent(
      req,
      'CREATE_GL_ACCOUNT_GROUP',
      'ACCOUNTING',
      `Created account group ${created.code} ${created.name} (${created.accountType}/${created.statementGroup})`,
      undefined,
      client
    );
    return created;
  });
  return res.status(201).json(group);
}

/** PATCH /api/accounting/groups/:id — correct a group's label or display order. */
export async function patch_accountGroup(req: any, res: Response): Promise<any> {
  const groupId = String(req.params?.id || '').trim();
  if (!groupId) throw new ApiError(400, 'An account group id is required.');
  const group = await inTransaction(async (client) => {
    const updated = await updateAccountGroup(client, groupId, req.body || {});
    await logAuditEvent(
      req,
      'UPDATE_GL_ACCOUNT_GROUP',
      'ACCOUNTING',
      `Updated account group ${updated.code} ${updated.name} (sort ${updated.sortOrder})`,
      undefined,
      client
    );
    return updated;
  });
  return res.json(group);
}

/** DELETE /api/accounting/groups/:id — only an empty group may be removed. */
export async function delete_accountGroup(req: any, res: Response): Promise<any> {
  const groupId = String(req.params?.id || '').trim();
  if (!groupId) throw new ApiError(400, 'An account group id is required.');
  const group = await inTransaction(async (client) => {
    const removed = await deleteAccountGroup(client, groupId);
    await logAuditEvent(
      req,
      'DELETE_GL_ACCOUNT_GROUP',
      'ACCOUNTING',
      `Deleted account group ${removed.code} ${removed.name}`,
      undefined,
      client
    );
    return removed;
  });
  return res.json({ deleted: true, id: group.id });
}

/** GET /api/accounting/accounts */
export async function get_accounts(req: any, res: Response): Promise<any> {
  const includeInactive = String(req.query?.includeInactive ?? '') === '1';
  const rows = (await pgPool.query(ACCOUNT_LIST_SQL)).rows.filter(
    (row: any) => includeInactive || row.isActive
  );
  return res.json(rows);
}

/** POST /api/accounting/accounts */
export async function post_account(req: any, res: Response): Promise<any> {
  const account = await inTransaction(async (client) => {
    const created = await createAccount(client, req.body || {});
    await logAuditEvent(
      req,
      'CREATE_GL_ACCOUNT',
      'ACCOUNTING',
      `Created ledger account ${created.code} ${created.name}` +
        (created.isControl ? ` (${created.subledgerType} control)` : '') +
        (created.postingRole ? ` as ${created.postingRole}` : ''),
      undefined,
      client
    );
    return created;
  });
  return res.status(201).json(account);
}

/** PATCH /api/accounting/accounts/:id — rename, set/clear a posting default or retire. */
export async function patch_account(req: any, res: Response): Promise<any> {
  const accountId = String(req.params?.id || '').trim();
  if (!accountId) throw new ApiError(400, 'An account id is required.');
  const account = await inTransaction(async (client) => {
    const updated = await updateAccount(client, accountId, req.body || {});
    await logAuditEvent(
      req,
      'UPDATE_GL_ACCOUNT',
      'ACCOUNTING',
      `Updated ledger account ${updated.code} ${updated.name}` +
        ` (posting role ${updated.postingRole || 'none'}, ${updated.isActive ? 'active' : 'inactive'})`,
      undefined,
      client
    );
    return updated;
  });
  return res.json(account);
}

/** DELETE /api/accounting/accounts/:id — unused accounts only; history stays. */
export async function delete_account(req: any, res: Response): Promise<any> {
  const accountId = String(req.params?.id || '').trim();
  if (!accountId) throw new ApiError(400, 'An account id is required.');
  const account = await inTransaction(async (client) => {
    const removed = await deleteAccount(client, accountId);
    await logAuditEvent(
      req,
      'DELETE_GL_ACCOUNT',
      'ACCOUNTING',
      `Deleted ledger account ${removed.code} ${removed.name}`,
      undefined,
      client
    );
    return removed;
  });
  return res.json({ deleted: true, id: account.id });
}

/** GET /api/accounting/posting-defaults — role → account mapping for later postings. */
export async function get_postingDefaults(_req: any, res: Response): Promise<any> {
  const rows = (await pgPool.query(ACCOUNT_LIST_SQL)).rows;
  const defaults: Record<string, any> = {};
  for (const row of rows) {
    if (!row.postingRole) continue;
    defaults[row.postingRole] = {
      accountId: row.id,
      accountCode: row.code,
      accountName: row.name,
      accountType: row.accountType,
      statementGroup: row.statementGroup,
      isControl: row.isControl,
      subledgerType: row.subledgerType,
    };
  }
  return res.json({ defaults });
}

/** GET /api/accounting/periods */
export async function get_periods(req: any, res: Response): Promise<any> {
  const fiscalYearId =
    typeof req.query?.fiscalYearId === 'string' && req.query.fiscalYearId.trim()
      ? req.query.fiscalYearId.trim()
      : null;
  const rows = (await pgPool.query(PERIOD_LIST_SQL, [fiscalYearId])).rows;
  return res.json(rows);
}

/** POST /api/accounting/periods */
export async function post_period(req: any, res: Response): Promise<any> {
  const period = await inTransaction(async (client) => {
    const created = await createPeriod(client, req.body || {});
    await logAuditEvent(
      req,
      'CREATE_ACCOUNTING_PERIOD',
      'ACCOUNTING',
      `Opened accounting period ${created.periodKey} (${created.startDateAD} → ${created.endDateAD})`,
      undefined,
      client
    );
    return created;
  });
  return res.status(201).json(period);
}

/** POST /api/accounting/periods/:id/close */
export async function post_closePeriod(req: any, res: Response): Promise<any> {
  const periodId = String(req.params?.id || '').trim();
  if (!periodId) throw new ApiError(400, 'A period id is required.');
  const period = await inTransaction(async (client) => {
    const closing = await setPeriodStatus(client, periodId, 'CLOSED', actorOf(req));
    await logAuditEvent(
      req,
      'CLOSE_ACCOUNTING_PERIOD',
      'ACCOUNTING',
      `Closed accounting period ${closing.periodKey}`,
      undefined,
      client
    );
    return closing;
  });
  return res.json(period);
}

/** POST /api/accounting/periods/:id/reopen */
export async function post_reopenPeriod(req: any, res: Response): Promise<any> {
  const periodId = String(req.params?.id || '').trim();
  if (!periodId) throw new ApiError(400, 'A period id is required.');
  const period = await inTransaction(async (client) => {
    const reopening = await setPeriodStatus(client, periodId, 'OPEN', actorOf(req));
    await logAuditEvent(
      req,
      'REOPEN_ACCOUNTING_PERIOD',
      'ACCOUNTING',
      `Reopened accounting period ${reopening.periodKey}`,
      undefined,
      client
    );
    return reopening;
  });
  return res.json(period);
}

/** GET /api/accounting/journals — branch-scoped page, newest first. */
export async function get_journals(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  const page = Math.max(1, Math.trunc(Number(req.query?.page)) || 1);
  const pageSize = Math.max(1, Math.min(200, Math.trunc(Number(req.query?.pageSize)) || 25));
  if (scope.empty) return res.json({ data: [], page, pageSize, totalItems: 0 });
  const opts: JournalListOptions = {
    branchId: scope.branchId,
    periodId: typeof req.query?.periodId === 'string' ? req.query.periodId : undefined,
    status: req.query?.status,
    from: req.query?.from,
    to: req.query?.to,
    query: req.query?.query,
    page,
    pageSize,
  };
  const pageQuery = buildJournalPageQuery(opts);
  const countQuery = buildJournalCountQuery(opts);
  const [rows, count] = await Promise.all([
    pgPool.query(pageQuery.sql, pageQuery.params as any[]),
    pgPool.query(countQuery.sql, countQuery.params as any[]),
  ]);
  return res.json({
    data: rows.rows.map((row: any) => ({
      ...row,
      totalDebit: Number(row.totalDebit),
      totalCredit: Number(row.totalCredit),
    })),
    page,
    pageSize,
    totalItems: Number(count.rows[0]?.count) || 0,
  });
}

/** GET /api/accounting/journals/:id */
export async function get_journal(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  const id = String(req.params?.id || '').trim();
  if (!id) throw new ApiError(400, 'A journal id is required.');
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const journal = await readJournal(pgPool, id);
  if (!journal) return res.status(404).json({ message: 'Journal not found.' });
  const inScope = scope.allowed
    ? scope.allowed.has(journal.branchId)
    : !scope.branchId || journal.branchId === scope.branchId;
  if (scope.empty || !inScope) {
    return res.status(403).json({ message: 'Forbidden: this journal belongs to another branch.' });
  }
  return res.json(journal);
}

/** POST /api/accounting/journals — post one balanced manual journal. */
export async function post_journal(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) {
    return res.status(403).json({ message: 'Forbidden: this account has no branch scope.' });
  }
  const requestedBranch = typeof req.body?.branchId === 'string' ? req.body.branchId.trim() : '';
  const branchAccount = Boolean(scope.allowed);
  if (branchAccount && requestedBranch && requestedBranch !== scope.branchId) {
    return res.status(403).json({ message: 'Forbidden: this journal is outside your branch scope.' });
  }
  const posted = await inTransaction(async (client) => {
    const result = await postJournal(client, {
      ...(req.body || {}),
      // A global account posts to the branch it named; a branch account posts
      // to its resolved scope even when the body omitted the field.
      branchId: branchAccount ? scope.branchId : requestedBranch,
      actor: actorOf(req),
      isDemo: false,
    });
    const journal = await readJournal(client, result.id);
    await logAuditEvent(
      req,
      'POST_ACCOUNTING_JOURNAL',
      'ACCOUNTING',
      `Posted journal ${result.journalNo} on ${journal.journalDateAD} for ${journal.branchId}: debit ${Number(journal.totalDebit).toFixed(2)} = credit ${Number(journal.totalCredit).toFixed(2)}`,
      journal.branchId,
      client
    );
    return journal;
  });
  return res.status(201).json(posted);
}

/**
 * POST /api/accounting/opening-balances — bring one branch's trial balance
 * into the earliest open period exactly once. The route gate is gl-post and
 * the branch scope check mirrors post_journal: a branch account may only post
 * its own branch even when the body names another one.
 */
export async function post_openingBalances(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) {
    return res.status(403).json({ message: 'Forbidden: this account has no branch scope.' });
  }
  const requestedBranch = typeof req.body?.branchId === 'string' ? req.body.branchId.trim() : '';
  const branchAccount = Boolean(scope.allowed);
  if (branchAccount && requestedBranch && requestedBranch !== scope.branchId) {
    return res.status(403).json({ message: 'Forbidden: this opening balance is outside your branch scope.' });
  }
  const posted = await inTransaction(async (client) => {
    const result = await postOpeningBalances(client, {
      branchId: branchAccount ? scope.branchId : requestedBranch,
      lines: Array.isArray(req.body?.lines) ? req.body.lines : [],
      actor: actorOf(req),
    });
    const journal = await readJournal(client, result.id);
    await logAuditEvent(
      req,
      'POST_OPENING_BALANCES',
      'ACCOUNTING',
      `Posted opening balances for ${journal.branchId} as journal ${result.journalNo} in ${result.periodKey}`,
      journal.branchId,
      client
    );
    return journal;
  });
  return res.status(201).json(posted);
}

/**
 * Resolve the statement window from the request, using the same session
 * branch scope as every other ledger read. A statement is PostgreSQL-only,
 * like the journal detail.
 */
async function statementWindow(req: any, res: Response, mode: StatementMode) {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const scope = resolveBranchScope(req, res);
  if (!scope) return null;
  return resolveStatementWindow(pgPool, req.query || {}, mode, {
    branchId: scope.branchId || null,
    empty: Boolean(scope.empty),
  });
}

/** GET /api/accounting/statements/trial-balance */
export async function get_trialBalance(req: any, res: Response): Promise<any> {
  const window = await statementWindow(req, res, 'TRIAL_BALANCE');
  if (!window) return;
  return res.json(await buildTrialBalance(pgPool, window));
}

/** GET /api/accounting/statements/profit-and-loss */
export async function get_profitAndLoss(req: any, res: Response): Promise<any> {
  const window = await statementWindow(req, res, 'PROFIT_AND_LOSS');
  if (!window) return;
  return res.json(await buildProfitAndLoss(pgPool, window));
}

/** GET /api/accounting/statements/balance-sheet */
export async function get_balanceSheet(req: any, res: Response): Promise<any> {
  const window = await statementWindow(req, res, 'BALANCE_SHEET');
  if (!window) return;
  return res.json(await buildBalanceSheet(pgPool, window));
}

/**
 * GET /api/accounting/statements/group-lines — the POSTED journal lines behind
 * one statement group subtotal, for the same branch and window as the
 * statement that displayed it. A trial-balance group also reports its opening
 * and period halves separately, because those two figures answer different
 * questions.
 */
export async function get_statementGroupLines(req: any, res: Response): Promise<any> {
  const rawStatement =
    typeof req.query?.statement === 'string' ? req.query.statement.trim().toUpperCase() : '';
  if (
    rawStatement !== 'PROFIT_AND_LOSS' &&
    rawStatement !== 'BALANCE_SHEET' &&
    rawStatement !== 'TRIAL_BALANCE'
  ) {
    throw new ApiError(
      400,
      'Statement must be PROFIT_AND_LOSS, BALANCE_SHEET or TRIAL_BALANCE.'
    );
  }
  const groupId = typeof req.query?.groupId === 'string' ? req.query.groupId.trim() : '';
  if (!groupId) throw new ApiError(400, 'An account group id is required.');

  const window = await statementWindow(req, res, rawStatement as StatementMode);
  if (!window) return;
  const limit = Number(req.query?.limit);
  const safeLimit = Number.isFinite(limit) ? limit : undefined;
  if (rawStatement === 'TRIAL_BALANCE') {
    return res.json(await buildTrialBalanceGroupLines(pgPool, window, groupId, safeLimit));
  }
  return res.json(
    await buildStatementGroupLines(
      pgPool,
      window,
      groupId,
      rawStatement as StatementGroupDrilldownMode,
      safeLimit
    )
  );
}

/**
 * GET /api/accounting/statements/account-lines — the POSTED lines behind one
 * trial-balance account row, for the same branch and window as the statement.
 * Like the group drill-down, opening lines precede `from` and period lines fall
 * inside `from`..`to`; each line also carries its debit-positive running
 * balance.
 */
export async function get_statementAccountLines(req: any, res: Response): Promise<any> {
  const accountId = typeof req.query?.accountId === 'string' ? req.query.accountId.trim() : '';
  if (!accountId) throw new ApiError(400, 'An account id is required.');

  const window = await statementWindow(req, res, 'TRIAL_BALANCE');
  if (!window) return;
  const limit = Number(req.query?.limit);
  const safeLimit = Number.isFinite(limit) ? limit : undefined;
  return res.json(await buildTrialBalanceAccountLines(pgPool, window, accountId, safeLimit));
}

/**
 * GET /api/accounting/aging — AR or AP open items through an as-of date,
 * bucketed by days past due, from the posted subledger. The response also
 * carries the control-account balance and the difference, so the caller can
 * see the tie-out rather than trusting the buckets alone.
 */
export async function get_aging(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  const rawType = typeof req.query?.type === 'string' ? req.query.type.trim().toUpperCase() : 'AR';
  if (rawType !== 'AR' && rawType !== 'AP') {
    throw new ApiError(400, 'Aging type must be AR or AP.');
  }
  const window = await resolveStatementWindow(pgPool, req.query || {}, 'BALANCE_SHEET', {
    branchId: scope.branchId || null,
    empty: Boolean(scope.empty),
  });
  return res.json(
    await buildAging(pgPool, {
      type: rawType as AgingType,
      asOf: window.to,
      branchId: window.branchId,
      empty: window.empty,
    })
  );
}

/**
 * GET /api/accounting/cash-book — the branch's cash/bank book for a window,
 * built from the same posted journal lines as the statements.
 */
export async function get_cashBook(req: any, res: Response): Promise<any> {
  const window = await statementWindow(req, res, 'TRIAL_BALANCE');
  if (!window) return;
  return res.json(await buildCashBook(pgPool, window));
}

/** GET /api/accounting/reconciliations?accountId=… */
export async function get_reconciliation(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) {
    return res.status(403).json({ message: 'Forbidden: this account has no branch scope.' });
  }
  const accountId = typeof req.query?.accountId === 'string' ? req.query.accountId.trim() : '';
  if (!accountId) throw new ApiError(400, 'A control account id is required.');
  const reconciliation = await reconcileControlAccount(pgPool, accountId, scope.branchId);
  return res.json(reconciliation);
}
