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
import { allowedBranchScope } from '../middleware/branchScope';
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import {
  ACCOUNT_BY_ID_SQL,
  ACCOUNT_GROUP_LIST_SQL,
  ACCOUNT_LIST_SQL,
  FISCAL_YEAR_BALANCES_LIST_SQL,
  FISCAL_YEAR_BALANCE_HEADER_SQL,
  JOURNAL_BY_ID_SQL,
  PERIOD_LIST_SQL,
  SETTLEMENT_ACCOUNTS_SQL,
  buildAccountSearchQuery,
  buildJournalCountQuery,
  buildJournalPageQuery,
  buildJournalKeysetQuery,
  type JournalListOptions,
} from '../models/accounting.repo';
import { decodeKeysetCursor, encodeKeysetCursor, cursorTimestamp, keysetEnvelope, keysetLimit, requireLargeTableScope } from '../utils/keysetCursor';
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
  reverseJournal,
  updateAccount,
  updateAccountGroup,
} from '../services/accounting.service';
import {
  buildBalanceSheet,
  buildBalanceSheetMovement,
  buildBranchBalanceSheetMatrix,
  buildBranchProfitAndLossMatrix,
  buildBsLedgerSummary,
  buildCashFlow,
  buildProfitAndLoss,
  buildStatementGroupLines,
  buildTrialBalance,
  buildTrialBalanceAccountLines,
  buildTrialBalanceGroupLines,
  loadStatementBranches,
  resolveStatementWindow,
  type StatementGroupDrilldownMode,
  type StatementMode,
} from '../services/accountingStatements.service';
import { buildCashBook } from '../services/accountingCashBook.service';
import { buildAging, type AgingType } from '../services/accountingAging.service';
import {
  buildCashFlowForecast,
  cashFlowForecastCsv,
} from '../services/accountingCashFlowForecast.service';
import { postOpeningBalances, type OpeningRegisterKey } from '../services/accountingClosing.service';
import {
  closePeriodWithChecklist,
  reopenPeriodWithChecklist,
} from '../services/recurringClose.service';

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
export function resolveBranchScope(
  req: any,
  res: Response,
  branchIdOverride?: unknown
): BranchScope | null {
  const user = req.user;
  const requested = branchIdOverride !== undefined ? branchIdOverride : req.query?.branchId;
  const raw = typeof requested === 'string' ? requested.trim() : '';
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

/**
 * GET /api/accounting/accounts/search?q=&kind=&limit= — bounded ledger lookup
 * for the searchable pickers. Requires a ledger reader or a manual voucher
 * poster, because both entry surfaces need the same chart rows.
 */
export async function search_accounts(req: any, res: Response): Promise<any> {
  const query = typeof req.query?.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  if (!query) return res.json([]);
  const rawKind = String(req.query?.kind || '').toUpperCase();
  const kind =
    rawKind === 'CASH_BANK' || rawKind === 'CASH' || rawKind === 'BANK' || rawKind === 'WALLET'
      ? rawKind
      : null;
  const { sql, params } = buildAccountSearchQuery({
    query,
    kind,
    limit: Number(req.query?.limit) || 20,
  });
  return res.json((await pgPool.query(sql, params as any[])).rows);
}

/**
 * The active cash/bank ledgers a payment document can settle through. This is
 * deliberately narrower than the chart: payment roles such as sales-invoice
 * create and inv-pay need the picker without receiving every ledger account.
 */
export async function get_settlementAccounts(_req: any, res: Response): Promise<any> {
  return res.json((await pgPool.query(SETTLEMENT_ACCOUNTS_SQL)).rows);
}

/** POST /api/accounting/accounts */
export async function post_account(req: any, res: Response): Promise<any> {
  const requestedOwner = typeof req.body?.branchId === 'string' ? req.body.branchId.trim() : '';
  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  if (requestedOwner && allowed && !allowed.has(requestedOwner)) {
    return res.status(403).json({ message: 'Forbidden: this ledger cannot belong to another branch.' });
  }
  const account = await inTransaction(async (client) => {
    const created = await createAccount(client, req.body || {});
    await logAuditEvent(
      req,
      'CREATE_GL_ACCOUNT',
      'ACCOUNTING',
      `Created ledger account ${created.code} ${created.name}` +
        (created.isControl ? ` (${created.subledgerType} control)` : '') +
        (created.postingRole ? ` as ${created.postingRole}` : '') +
        (created.accountKind && created.accountKind !== 'OTHER' ? ` [${created.accountKind}]` : ''),
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
  const existing = (await pgPool.query(ACCOUNT_BY_ID_SQL, [accountId])).rows[0];
  if (!existing) throw new ApiError(404, 'Account not found.');
  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  const requestedOwner = typeof req.body?.branchId === 'string' ? req.body.branchId.trim() : '';
  for (const owner of [existing.branchId, requestedOwner].filter(Boolean)) {
    if (allowed && !allowed.has(owner)) {
      return res.status(403).json({ message: 'Forbidden: this ledger belongs to another branch.' });
    }
  }
  const account = await inTransaction(async (client) => {
    const updated = await updateAccount(client, accountId, req.body || {});
    await logAuditEvent(
      req,
      'UPDATE_GL_ACCOUNT',
      'ACCOUNTING',
      `Updated ledger account ${updated.code} ${updated.name}` +
        ` (${updated.accountKind || 'OTHER'}, posting role ${updated.postingRole || 'none'}, ${updated.isActive ? 'active' : 'inactive'})`,
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

/**
 * POST /api/accounting/periods/:id/close
 *
 * The close checklist is part of the close transaction, not a client-side
 * warning. Required tasks must be DONE; an override reason is the only way to
 * close with them open, and that override is audited separately.
 */
export async function post_closePeriod(req: any, res: Response): Promise<any> {
  const periodId = String(req.params?.id || '').trim();
  if (!periodId) throw new ApiError(400, 'A period id is required.');
  const closing = await inTransaction(async (client) => {
    const result = await closePeriodWithChecklist(
      client,
      periodId,
      actorOf(req),
      req.body?.overrideReason
    );
    await logAuditEvent(
      req,
      result.overridden
        ? 'CLOSE_ACCOUNTING_PERIOD_OVERRIDE'
        : 'CLOSE_ACCOUNTING_PERIOD',
      'ACCOUNTING',
      result.overridden
        ? `Closed accounting period ${result.period.periodKey} with checklist override: ${result.overrideReason}`
        : `Closed accounting period ${result.period.periodKey}`,
      undefined,
      client
    );
    return result;
  });
  return res.json({
    ...closing.period,
    overridden: closing.overridden,
    inventoryOverridden: closing.inventoryOverridden,
    inventoryDifference: closing.inventoryDifference,
    incompleteRequired: closing.incompleteRequired,
  });
}

/** POST /api/accounting/periods/:id/reopen */
export async function post_reopenPeriod(req: any, res: Response): Promise<any> {
  const periodId = String(req.params?.id || '').trim();
  if (!periodId) throw new ApiError(400, 'A period id is required.');
  const reopening = await inTransaction(async (client) => {
    const result = await reopenPeriodWithChecklist(client, periodId, actorOf(req));
    await logAuditEvent(
      req,
      'REOPEN_ACCOUNTING_PERIOD',
      'ACCOUNTING',
      `Reopened accounting period ${result.period.periodKey}`,
      undefined,
      client
    );
    return result;
  });
  return res.json(reopening.period);
}

/** GET /api/accounting/journals — branch-scoped page, newest first. */
export async function get_journals(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  const { cursor, limit } = req.query || {};
  const wantsCursor = cursor !== undefined || limit !== undefined;
  if (wantsCursor && !requireLargeTableScope(res, {
    branchId: scope.branchId, dateFrom: req.query?.from, dateTo: req.query?.to, report: true,
  })) return;
  const parsedCursor = cursor === undefined ? undefined : decodeKeysetCursor(cursor, 'gl_journals', 3);
  if (cursor !== undefined && !parsedCursor) {
    return res.status(400).json({ code: 'INVALID_CURSOR', message: 'The journal cursor is invalid. Reload the list and retry.' });
  }
  const pageSize = Math.max(1, Math.min(200, Math.trunc(Number(req.query?.pageSize)) || 25));
  const page = Math.min(
    Math.max(1, Math.floor(10000 / pageSize)),
    Math.max(1, Math.trunc(Number(req.query?.page)) || 1)
  );
  if (scope.empty) {
    return wantsCursor
      ? res.json(keysetEnvelope([], null, false))
      : res.json({ data: [], page, pageSize, totalItems: 0 });
  }
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
  if (wantsCursor) {
    const size = keysetLimit(limit, 25, 200);
    const q = buildJournalKeysetQuery(
      opts,
      parsedCursor
        ? [String(parsedCursor[0]), String(parsedCursor[1]), String(parsedCursor[2])]
        : undefined,
      size
    );
    const r = await pgPool.query(q.sql, q.params as any[]);
    const hasMore = r.rows.length > size;
    const rows = hasMore ? r.rows.slice(0, size) : r.rows;
    const items = rows.map((row: any) => ({
      ...row,
      exchangeRate: Number(row.exchangeRate),
      totalDebit: Number(row.totalDebit),
      totalCredit: Number(row.totalCredit),
    }));
    const last = items[items.length - 1];
    const nextCursor = hasMore && last
      ? encodeKeysetCursor('gl_journals', [
          cursorTimestamp(last.journalDateAD).slice(0, 10),
          String(last.journalNo ?? ''),
          String(last.id),
        ])
      : null;
    return res.json(keysetEnvelope(items, nextCursor, hasMore));
  }
  const pageQuery = buildJournalPageQuery(opts);
  const countQuery = buildJournalCountQuery(opts);
  const [rows, count] = await Promise.all([
    pgPool.query(pageQuery.sql, pageQuery.params as any[]),
    pgPool.query(countQuery.sql, countQuery.params as any[]),
  ]);
  return res.json({
    data: rows.rows.map((row: any) => ({
      ...row,
      exchangeRate: Number(row.exchangeRate),
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
 * POST /api/accounting/journals/:id/reverse — post a contra voucher for a
 * posted manual/cash voucher. The original stays POSTED and auditable; the
 * contra nets the ledger to zero, so statements need no status exception.
 */
export async function post_reverseJournal(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) {
    return res.status(403).json({ message: 'Forbidden: this account has no branch scope.' });
  }
  const journalId = String(req.params?.id || '').trim();
  if (!journalId) throw new ApiError(400, 'A journal id is required.');

  const reversed = await inTransaction(async (client) => {
    const original = (await client.query(JOURNAL_BY_ID_SQL, [journalId])).rows[0];
    if (!original) throw new ApiError(404, 'Journal not found.');
    const inScope = scope.allowed
      ? scope.allowed.has(original.branchId)
      : !scope.branchId || original.branchId === scope.branchId;
    if (!inScope) {
      throw new ApiError(403, 'Forbidden: this journal belongs to another branch.');
    }
    const result = await reverseJournal(client, journalId, {
      journalDateAD: req.body?.journalDateAD,
      reason: req.body?.reason,
      actor: actorOf(req),
    });
    const journal = await readJournal(client, result.id);
    await logAuditEvent(
      req,
      'REVERSE_ACCOUNTING_JOURNAL',
      'ACCOUNTING',
      `Reversed journal ${original.journalNo} with ${result.journalNo} on ${journal.journalDateAD}: ${String(req.body?.reason || '').trim().slice(0, 300)}`,
      journal.branchId,
      client
    );
    return journal;
  });
  return res.status(201).json(reversed);
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
  const registerRaw = typeof req.body?.register === 'string' ? req.body.register.trim().toLowerCase() : 'gl';
  if (registerRaw !== 'gl' && registerRaw !== 'customer') {
    return res.status(400).json({ message: 'Opening balances accept only the GL or customer register.' });
  }
  const register = registerRaw as OpeningRegisterKey;
  const posted = await inTransaction(async (client) => {
    const result = await postOpeningBalances(client, {
      branchId: branchAccount ? scope.branchId : requestedBranch,
      lines: Array.isArray(req.body?.lines) ? req.body.lines : [],
      actor: actorOf(req),
      sourceKey: register,
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

/** GET /api/accounting/statements/bs-summary — BS month/quarter ledger view */
export async function get_bsLedgerSummary(req: any, res: Response): Promise<any> {
  const window = await statementWindow(req, res, 'PROFIT_AND_LOSS');
  if (!window) return;
  return res.json(await buildBsLedgerSummary(pgPool, window));
}

/**
 * GET /api/accounting/fiscal-years/:id/balances — the immutable snapshot a
 * close wrote. This is the bounded year-end read: it never rescans journals.
 * A branch account sees only its branch; a global account may narrow to one
 * branch or read every branch. Before Phase 1 a closed year had no snapshot,
 * so those years answer 404 rather than pretending an empty trial balance.
 */
export async function get_fiscalYearBalances(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  const fiscalYearId = String(req.params?.id || '').trim();
  if (!fiscalYearId) throw new ApiError(400, 'A fiscal year id is required.');
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');

  const fiscalYear = (await pgPool.query(FISCAL_YEAR_BALANCE_HEADER_SQL, [fiscalYearId])).rows[0];
  if (!fiscalYear) return res.status(404).json({ message: 'Fiscal year not found.' });

  let rows: any[] = [];
  if (!scope.empty) {
    rows = (
      await pgPool.query(FISCAL_YEAR_BALANCES_LIST_SQL, [
        fiscalYearId,
        scope.branchId ?? null,
      ])
    ).rows;
  }
  if (rows.length === 0) {
    return res.status(404).json({
      message: `Fiscal year ${fiscalYear.code} has no close snapshot in this scope.`,
    });
  }

  const totals = rows.reduce(
    (sum, row) => {
      sum.preCloseDebit = roundMoney(sum.preCloseDebit + Number(row.preCloseDebit));
      sum.preCloseCredit = roundMoney(sum.preCloseCredit + Number(row.preCloseCredit));
      sum.preCloseBalance = roundMoney(sum.preCloseBalance + Number(row.preCloseBalance));
      sum.closeDebit = roundMoney(sum.closeDebit + Number(row.closeDebit));
      sum.closeCredit = roundMoney(sum.closeCredit + Number(row.closeCredit));
      sum.postCloseBalance = roundMoney(sum.postCloseBalance + Number(row.postCloseBalance));
      return sum;
    },
    {
      preCloseDebit: 0,
      preCloseCredit: 0,
      preCloseBalance: 0,
      closeDebit: 0,
      closeCredit: 0,
      postCloseBalance: 0,
    }
  );

  return res.json({
    fiscalYear,
    branchId: scope.branchId ?? 'ALL',
    rows: rows.map((row) => ({
      ...row,
      preCloseDebit: Number(row.preCloseDebit),
      preCloseCredit: Number(row.preCloseCredit),
      preCloseBalance: Number(row.preCloseBalance),
      closeDebit: Number(row.closeDebit),
      closeCredit: Number(row.closeCredit),
      postCloseBalance: Number(row.postCloseBalance),
    })),
    totals,
    balanced: {
      preClose: roundMoney(totals.preCloseDebit - totals.preCloseCredit) === 0,
      postClose:
        roundMoney(
          totals.preCloseDebit + totals.closeDebit - totals.preCloseCredit - totals.closeCredit
        ) === 0,
    },
  });
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
 * GET /api/accounting/statements/balance-sheet-movement — opening, period and
 * closing figures. This is additive: the statutory closing statement above
 * keeps its point-in-time contract and does not accept `from`.
 */
export async function get_balanceSheetMovement(req: any, res: Response): Promise<any> {
  const window = await statementWindow(req, res, 'BALANCE_SHEET_MOVEMENT');
  if (!window) return;
  return res.json(await buildBalanceSheetMovement(pgPool, window));
}

/**
 * GET /api/accounting/statements/branch-profit-and-loss — one P&L/Trading
 * matrix for every branch in the session's ledger scope. Columns are built by
 * the same per-branch P&L service as the individual statement.
 */
export async function get_branchProfitAndLoss(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  const window = await resolveStatementWindow(pgPool, req.query || {}, 'PROFIT_AND_LOSS', {
    branchId: scope.branchId || null,
    empty: Boolean(scope.empty),
  });
  const branches = await loadStatementBranches(pgPool, scope.allowed);
  return res.json(
    await buildBranchProfitAndLossMatrix(
      pgPool,
      { ...window, branchId: null, empty: Boolean(scope.empty) },
      branches
    )
  );
}

/**
 * GET /api/accounting/statements/branch-balance-sheet — one closing or movement
 * balance-sheet matrix for every branch in the session's ledger scope. The
 * closing matrix uses the statutory per-branch statement; the movement matrix
 * uses the per-branch opening/period/closing read and exposes its period change.
 */
export async function get_branchBalanceSheet(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const view = String(req.query?.view || 'CLOSING').toUpperCase();
  if (view !== 'CLOSING' && view !== 'MOVEMENT') {
    throw new ApiError(400, 'Balance-sheet view must be CLOSING or MOVEMENT.');
  }
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  const window = await resolveStatementWindow(
    pgPool,
    req.query || {},
    view === 'MOVEMENT' ? 'BALANCE_SHEET_MOVEMENT' : 'BALANCE_SHEET',
    {
      branchId: scope.branchId || null,
      empty: Boolean(scope.empty),
    }
  );
  const branches = await loadStatementBranches(pgPool, scope.allowed);
  return res.json(
    await buildBranchBalanceSheetMatrix(
      pgPool,
      { ...window, branchId: null, empty: Boolean(scope.empty) },
      branches,
      view
    )
  );
}

/** GET /api/accounting/statements/cash-flow */
export async function get_cashFlow(req: any, res: Response): Promise<any> {
  const window = await statementWindow(req, res, 'CASH_FLOW');
  if (!window) return;
  return res.json(await buildCashFlow(pgPool, window));
}

function forecastMinCash(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ApiError(400, 'Minimum cash must be a non-negative number.');
  }
  return parsed;
}

/**
 * GET /api/accounting/statements/cash-flow/forecast — forward weekly cash flow
 * from the same aging open items and posted cash balance as the statement. A
 * balance-sheet window gives the as-of date and rejects a period start, so the
 * forecast cannot silently use a different date from the cash position it
 * opens at.
 */
export async function get_cashFlowForecast(req: any, res: Response): Promise<any> {
  const window = await statementWindow(req, res, 'BALANCE_SHEET');
  if (!window) return;
  return res.json(
    await buildCashFlowForecast(pgPool, {
      asOf: window.to,
      branchId: window.branchId,
      empty: window.empty,
      weeks: req.query?.weeks,
      minCash: forecastMinCash(req.query?.minCash),
    })
  );
}

/** GET /api/accounting/statements/cash-flow/forecast/export — the same forecast as CSV. */
export async function get_cashFlowForecastExport(req: any, res: Response): Promise<any> {
  const window = await statementWindow(req, res, 'BALANCE_SHEET');
  if (!window) return;
  const forecast = await buildCashFlowForecast(pgPool, {
    asOf: window.to,
    branchId: window.branchId,
    empty: window.empty,
    weeks: req.query?.weeks,
    minCash: forecastMinCash(req.query?.minCash),
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="cash-flow-forecast-${forecast.asOf}.csv"`
  );
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(cashFlowForecastCsv(forecast));
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
 * GET /api/accounting/cash-book?kind=CASH|BANK|WALLET — the branch's custody
 * ledger book for a window, built from the same posted journal lines as the
 * statements. Omitted kind keeps the legacy combined cash+bank view.
 */
export async function get_cashBook(req: any, res: Response): Promise<any> {
  const window = await statementWindow(req, res, 'TRIAL_BALANCE');
  if (!window) return;
  const rawKind = String(req.query?.kind || '').toUpperCase();
  if (rawKind && !['CASH', 'BANK', 'WALLET', 'CASH_BANK'].includes(rawKind)) {
    throw new ApiError(400, 'Cash-book kind must be CASH, BANK, WALLET or CASH_BANK.');
  }
  const accountId = typeof req.query?.accountId === 'string' ? req.query.accountId.trim() : null;
  return res.json(
    await buildCashBook(pgPool, window, {
      kind: (rawKind || undefined) as 'CASH' | 'BANK' | 'WALLET' | 'CASH_BANK' | undefined,
      accountId: accountId || null,
    })
  );
}

/**
 * GET /api/accounting/bank-position — every BANK ledger's company balance with
 * the selected branch's movement shown separately. This is the bank read the
 * daily cash close deliberately no longer contains.
 */
export async function get_bankPosition(req: any, res: Response): Promise<any> {
  const window = await statementWindow(req, res, 'TRIAL_BALANCE');
  if (!window) return;
  const accountId = typeof req.query?.accountId === 'string' ? req.query.accountId.trim() : null;
  return res.json(await buildCashBook(pgPool, window, { kind: 'BANK', accountId: accountId || null }));
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
