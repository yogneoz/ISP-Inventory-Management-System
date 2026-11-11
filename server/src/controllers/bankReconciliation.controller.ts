/**
 * Bank reconciliation HTTP surface. Reads are gated by `gl-view`; imports,
 * matching and period lock/reopen are cash/bank control writes and share the
 * existing `gl-cash-close` grant. Every write is audited on the same
 * transaction as the row change.
 *
 * Reconciliation is company-wide because branches share one bank account and
 * the bank issues one statement per account. Branch-scoped users cannot open
 * this workspace; global users reconcile every branch's postings together.
 */
import type { Response } from 'express';
import { pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { ApiError } from '../errors/ApiError';
import { getUserFromReq } from '../middleware/auth';
import { logAuditEvent } from '../services/audit.service';
import {
  importBankStatement,
  lockBankReconciliationSession,
  matchBankStatementLine,
  readBankReconciliation,
  reopenBankReconciliationSession,
  saveBankReconciliationSession,
  unmatchBankStatementLine,
} from '../services/bankReconciliation.service';
import { resolveBranchScope } from './accounting.controller';

function actorOf(req: any): string | null {
  const user = getUserFromReq(req);
  return user.email || user.name || null;
}

function todayAD(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Bank reconciliation reads and writes the company's bank ledger. A concrete
 * branch cannot own the statement, so only an all-branches/global account may
 * use this workspace. The statement and session rows themselves carry no
 * branch; branch remains visible on each matched book line.
 */
function requireCompanyScope(req: any, res: Response): boolean {
  const scope = resolveBranchScope(req, res);
  if (!scope) return false;
  if (scope.empty) {
    res.status(403).json({ message: 'Forbidden: this account has no company branch scope.' });
    return false;
  }
  if (scope.branchId) {
    res.status(403).json({
      message: 'Bank reconciliation is company-wide. Switch to All Branches to reconcile the shared bank account.',
    });
    return false;
  }
  return true;
}

function periodFor(req: any) {
  const body = req.body || {};
  return {
    from: body.from ?? req.query?.from,
    to: body.to ?? req.query?.to ?? todayAD(),
  };
}

async function workspaceFor(accountId: unknown, from: unknown, to: unknown) {
  return readBankReconciliation(pgPool, { accountId, from, to });
}

/** GET /api/accounting/bank-reconciliation */
export async function get_bankReconciliation(req: any, res: Response): Promise<any> {
  if (!requireCompanyScope(req, res)) return;
  const workspace = await workspaceFor(
    req.query?.accountId,
    req.query?.from,
    req.query?.to ?? todayAD()
  );
  return res.json(workspace);
}

/** POST /api/accounting/bank-reconciliation/import */
export async function post_bankReconciliationImport(req: any, res: Response): Promise<any> {
  const body = req.body || {};
  if (!requireCompanyScope(req, res)) return;
  const period = periodFor(req);
  const result = await withTransaction(async (client) => {
    const imported = await importBankStatement(
      client,
      {
        accountId: body.accountId,
        content: body.content,
        format: body.format,
      },
      actorOf(req)
    );
    await logAuditEvent(
      req,
      'IMPORT_BANK_STATEMENT',
      'ACCOUNTING',
      `Imported ${imported.imported} statement line(s), skipped ${imported.duplicates} duplicate(s) from ${imported.source}.`,
      undefined,
      client
    );
    return imported;
  });
  const workspace = await workspaceFor(body.accountId, period.from, period.to);
  return res.json({ ...result, workspace });
}

/** POST /api/accounting/bank-reconciliation/lines/:id/match */
export async function post_bankReconciliationMatch(req: any, res: Response): Promise<any> {
  const body = req.body || {};
  if (!requireCompanyScope(req, res)) return;
  const period = periodFor(req);
  const result = await withTransaction(async (client) => {
    const matched = await matchBankStatementLine(client, {
      lineId: req.params?.id,
      journalLineId: body.journalLineId,
      actor: actorOf(req),
    });
    await logAuditEvent(
      req,
      'MATCH_BANK_STATEMENT_LINE',
      'ACCOUNTING',
      `Matched statement line ${matched.lineId} to ${matched.journalNo} for NPR ${matched.amount.toFixed(2)}.`,
      undefined,
      client
    );
    return matched;
  });
  const workspace = await workspaceFor(body.accountId, period.from, period.to);
  return res.json({ ...result, workspace });
}

/** POST /api/accounting/bank-reconciliation/lines/:id/unmatch */
export async function post_bankReconciliationUnmatch(req: any, res: Response): Promise<any> {
  const body = req.body || {};
  if (!requireCompanyScope(req, res)) return;
  const period = periodFor(req);
  const result = await withTransaction(async (client) => {
    const unmatched = await unmatchBankStatementLine(client, {
      lineId: req.params?.id,
      actor: actorOf(req),
    });
    await logAuditEvent(
      req,
      'UNMATCH_BANK_STATEMENT_LINE',
      'ACCOUNTING',
      `Unmatched statement line ${unmatched.lineId} from ${unmatched.previousJournalLineId} (NPR ${unmatched.amount.toFixed(2)}).`,
      undefined,
      client
    );
    return unmatched;
  });
  const workspace = await workspaceFor(body.accountId, period.from, period.to);
  return res.json({ ...result, workspace });
}

/** POST /api/accounting/bank-reconciliation/sessions */
export async function post_bankReconciliationSession(req: any, res: Response): Promise<any> {
  const body = req.body || {};
  if (!requireCompanyScope(req, res)) return;
  const session = await withTransaction(async (client) => {
    const saved = await saveBankReconciliationSession(client, {
      accountId: body.accountId,
      from: body.from,
      to: body.to,
      openingStatementBalance: body.openingStatementBalance,
      closingStatementBalance: body.closingStatementBalance,
      actor: actorOf(req),
    });
    await logAuditEvent(
      req,
      'SAVE_BANK_RECONCILIATION_SESSION',
      'ACCOUNTING',
      `Saved bank reconciliation ${saved.periodStart} to ${saved.periodEnd} (opening ${saved.openingStatementBalance.toFixed(2)}, closing ${saved.closingStatementBalance.toFixed(2)}).`,
      undefined,
      client
    );
    return saved;
  });
  const workspace = await workspaceFor(session.bankAccountId, session.periodStart, session.periodEnd);
  return res.json({ session, workspace });
}

/** POST /api/accounting/bank-reconciliation/sessions/:id/lock */
export async function post_bankReconciliationLock(req: any, res: Response): Promise<any> {
  if (!requireCompanyScope(req, res)) return;
  const result = await withTransaction(async (client) => {
    const locked = await lockBankReconciliationSession(client, {
      sessionId: req.params?.id,
      actor: actorOf(req),
    });
    if (locked.changed) {
      await logAuditEvent(
        req,
        'LOCK_BANK_RECONCILIATION_SESSION',
        'ACCOUNTING',
        `Locked bank reconciliation ${locked.session.periodStart} to ${locked.session.periodEnd}.`,
        undefined,
        client
      );
    }
    return locked;
  });
  const workspace = await workspaceFor(
    result.session.bankAccountId,
    result.session.periodStart,
    result.session.periodEnd
  );
  return res.json({ ...result, workspace });
}

/** POST /api/accounting/bank-reconciliation/sessions/:id/reopen */
export async function post_bankReconciliationReopen(req: any, res: Response): Promise<any> {
  const body = req.body || {};
  if (!requireCompanyScope(req, res)) return;
  const result = await withTransaction(async (client) => {
    const reopened = await reopenBankReconciliationSession(client, {
      sessionId: req.params?.id,
      reason: body.reason,
      actor: actorOf(req),
    });
    await logAuditEvent(
      req,
      'REOPEN_BANK_RECONCILIATION_SESSION',
      'ACCOUNTING',
      `Reopened bank reconciliation ${reopened.session.periodStart} to ${reopened.session.periodEnd}: ${reopened.reason}`,
      undefined,
      client
    );
    return reopened;
  });
  const workspace = await workspaceFor(
    result.session.bankAccountId,
    result.session.periodStart,
    result.session.periodEnd
  );
  return res.json({ ...result, workspace });
}
