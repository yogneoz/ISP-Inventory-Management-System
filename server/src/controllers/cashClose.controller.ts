/**
 * Daily cash close HTTP surface — today's branch cash position, the
 * consolidated branch table, and the counted close/reopen actions.
 *
 * Reads are `gl-view`; close and reopen are `gl-post`. The branch scope comes
 * from the session and is re-checked here even though `enforceBranchAccess`
 * already rejects another branch's `branchId`, so a future route registration
 * cannot widen a close by accident.
 *
 * Every figure comes from the posted cash/bank journal lines via
 * cashClose.service; this controller only validates input and owns the
 * transaction/audit boundary.
 */
import type { Response } from 'express';
import { getPgConnected, pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { ApiError } from '../errors/ApiError';
import { logAuditEvent } from '../services/audit.service';
import { allowedBranchScope } from '../middleware/branchScope';
import { getUserFromReq } from '../middleware/auth';
import { roundMoney } from '../utils/money';
import {
  buildCashPosition,
  cashCloseTodayAD,
  closeCashDay,
  readCashCloseById,
  reopenCashDay,
  requireCashCloseDate,
} from '../services/cashClose.service';

interface CashScope {
  /** Null on a consolidated read; a concrete id everywhere else. */
  branchId: string | null;
  /** `null` means every branch (a global account). */
  branchScope: string[] | null;
  empty?: boolean;
}

function actorOf(req: any): string | null {
  const user = getUserFromReq(req);
  return user.email || user.name || null;
}

function requireDb(): void {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A concrete branch this request may act on, or a 403/400 after responding. */
function resolveBranch(
  req: any,
  res: Response,
  raw: string
): { branchId: string; branchScope: string[] | null } | null {
  const user = req.user;
  if (!user) {
    res.status(401).json({ message: 'Unauthorized: Authentication required' });
    return null;
  }
  const allowed = allowedBranchScope(user);
  if (allowed) {
    if (allowed.size === 0) {
      res.status(403).json({ message: 'This account is not assigned to any branch.' });
      return null;
    }
    if (raw === 'ALL') {
      res.status(403).json({ message: 'Forbidden: branch users cannot access all branches.' });
      return null;
    }
    if (raw && !allowed.has(raw)) {
      res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
      return null;
    }
    const branchId = raw || user.branchId || [...allowed][0];
    if (!allowed.has(branchId)) {
      res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
      return null;
    }
    return { branchId, branchScope: [branchId] };
  }
  if (!raw || raw === 'ALL') {
    throw new ApiError(400, 'Name the branch whose cash should be read or closed.');
  }
  return { branchId: raw, branchScope: [raw] };
}

/** The branches a consolidated read may roll up: all, or the session's set. */
function resolveConsolidatedScope(req: any, res: Response): CashScope | null {
  const user = req.user;
  if (!user) {
    res.status(401).json({ message: 'Unauthorized: Authentication required' });
    return null;
  }
  const allowed = allowedBranchScope(user);
  if (allowed && allowed.size === 0) {
    res.status(403).json({ message: 'This account is not assigned to any branch.' });
    return null;
  }
  return {
    branchId: null,
    branchScope: allowed ? [...allowed] : null,
  };
}

/** GET /api/accounting/cash-close?branchId=&dateAD= */
export async function get_cashClose(req: any, res: Response): Promise<any> {
  requireDb();
  const dateAD = req.query?.dateAD ? requireCashCloseDate(req.query.dateAD) : cashCloseTodayAD();
  const scope = resolveBranch(req, res, text(req.query?.branchId));
  if (!scope) return;
  const position = await buildCashPosition(pgPool, {
    dateAD,
    branchScope: scope.branchScope,
    branchId: scope.branchId,
  });
  const branch = position.branches.find((row) => row.branchId === scope.branchId);
  if (!branch) throw new ApiError(404, `Branch ${scope.branchId} does not exist.`);
  return res.json({ dateAD, branchId: scope.branchId, branch, totals: position.totals });
}

/** GET /api/accounting/cash-close/consolidated?dateAD= */
export async function get_cashCloseConsolidated(req: any, res: Response): Promise<any> {
  requireDb();
  const dateAD = req.query?.dateAD ? requireCashCloseDate(req.query.dateAD) : cashCloseTodayAD();
  const scope = resolveConsolidatedScope(req, res);
  if (!scope) return;
  const position = await buildCashPosition(pgPool, {
    dateAD,
    branchScope: scope.branchScope,
    branchId: null,
  });
  return res.json({ ...position, branchId: 'ALL' });
}

function countedClosingValue(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    throw new ApiError(400, 'countedClosing is required: enter the cash counted at close.');
  }
  const counted = roundMoney(Number(value));
  if (!Number.isFinite(counted) || counted < 0) {
    throw new ApiError(400, 'countedClosing must be a non-negative amount.');
  }
  if (counted > 99_999_999_999.99) {
    throw new ApiError(400, 'countedClosing exceeds the ledger limit.');
  }
  return counted;
}

/**
 * POST /api/accounting/cash-close
 * Body: { branchId, dateAD?, countedClosing }
 */
export async function post_cashClose(req: any, res: Response): Promise<any> {
  requireDb();
  const dateAD = req.body?.dateAD ? requireCashCloseDate(req.body.dateAD) : cashCloseTodayAD();
  const scope = resolveBranch(req, res, text(req.body?.branchId));
  if (!scope) return;
  const countedClosing = countedClosingValue(req.body?.countedClosing);

  const closed = await withTransaction(async (client) => {
    const close = await closeCashDay(client, {
      branchId: scope.branchId,
      dateAD,
      countedClosing,
      actor: actorOf(req),
    });
    await logAuditEvent(
      req,
      'CLOSE_DAILY_CASH',
      'ACCOUNTING',
      `Closed daily cash for ${scope.branchId} on ${dateAD}: expected NPR ${close.expectedClosing.toFixed(2)}, counted NPR ${close.countedClosing.toFixed(2)}, variance NPR ${close.variance.toFixed(2)}.`,
      scope.branchId,
      client
    );
    return close;
  });

  return res.status(201).json(closed);
}

/** POST /api/accounting/cash-close/:id/reopen */
export async function post_reopenCashClose(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id);
  if (!id) throw new ApiError(400, 'A daily cash close id is required.');

  const reopened = await withTransaction(async (client) => {
    const existing = await readCashCloseById(client, id);
    const allowed = allowedBranchScope(req.user);
    if (allowed && !allowed.has(existing.branchId)) {
      throw new ApiError(403, 'Forbidden: this daily cash close belongs to another branch.');
    }
    const close = await reopenCashDay(client, { id, actor: actorOf(req) });
    await logAuditEvent(
      req,
      'REOPEN_DAILY_CASH',
      'ACCOUNTING',
      `Reopened daily cash close for ${close.branchId} on ${close.businessDateAD} (counted NPR ${close.countedClosing.toFixed(2)}).`,
      close.branchId,
      client
    );
    return close;
  });

  return res.json(reopened);
}

