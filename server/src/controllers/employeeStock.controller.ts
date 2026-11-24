/**
 * Employee stock custody API — the ledger behind My Stock and the employee
 * profile's Equipment section.
 *
 *   GET  /api/employee-stock            holdings (branch-scoped, optional filters)
 *   GET  /api/employee-stock/movements  one employee's log
 *   POST /api/employee-stock/issue      branch stock -> employee  (`stock-out`)
 *   POST /api/employee-stock/return     employee -> branch stock  (`consumable-issue-reverse`)
 *   POST /api/employee-stock/consume    used on a job, gone      (`consumable-issue-reverse`)
 *   POST /api/employee-stock/loss       write-off with a reason  (`stock-out`)
 *
 * Every write derives its branch from the caller's session scope, never from a
 * browser claim, and every response is `private, no-store` like the neighbouring
 * registers. The quantity rules live in the repository's guarded UPDATEs and in
 * the holdings projection, so a retry cannot double-write or go negative.
 */
import type { Request, Response } from 'express';
import { resolveBranchScope } from './accounting.controller';
import {
  EmployeeStockRefusal,
  consumeEmployeeStock,
  employeeBranchId,
  issueEmployeeStock,
  listCustodyEmployees,
  listEmployeeStockHoldings,
  listEmployeeStockMovements,
  recordEmployeeStockLoss,
  returnEmployeeStock,
  transferEmployeeStock,
  type EmployeeStockMovementType,
  type MovementInput,
} from '../models/employeeStock.repo';

const MAX_QUANTITY = 100000;

function text(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function actorEmail(req: any): string {
  const user = req.user || {};
  return String(user.email || user.name || user.id || 'unknown');
}

/**
 * The branch ids a read may span. `null` means every branch (head office), which
 * is how the neighbouring registers express an unscoped read.
 */
function readableBranchIds(scope: { branchId?: string; allowed?: Set<string>; empty?: boolean }): string[] | null {
  if (scope.allowed && scope.allowed.size > 0) return [...scope.allowed];
  if (scope.branchId) return [scope.branchId];
  return null;
}

function refusalStatus(code: EmployeeStockRefusal['code']): number {
  switch (code) {
    case 'INSUFFICIENT_BRANCH_STOCK':
    case 'INSUFFICIENT_HOLDING':
    case 'CROSS_BRANCH_TRANSFER':
      return 409;
    case 'REASON_REQUIRED':
    case 'SAME_EMPLOYEE':
      return 400;
    default:
      return 400;
  }
}

function handleRefusal(error: unknown, res: Response, next: (err?: any) => void) {
  if (error instanceof EmployeeStockRefusal) {
    return res.status(refusalStatus(error.code)).json({ message: error.message, code: error.code });
  }
  return next(error);
}

export async function get_employeeStock(req: Request, res: Response): Promise<any> {
  const scope = resolveBranchScope(req as any, res);
  if (!scope) return;
  if (scope.empty) return res.status(403).json({ message: 'Forbidden: no branch is assigned to this account.' });
  const rows = await listEmployeeStockHoldings({
    branchIds: readableBranchIds(scope),
    employeeId: text(req.query.employeeId, 50) || undefined,
    productId: text(req.query.productId, 50) || undefined,
  });
  res.set('Cache-Control', 'private, no-store');
  res.json(rows);
}

/**
 * GET /api/employee-stock/employees — the roster the custody actions pick from.
 *
 * Same `employee-stock-view` gate as the holdings it sits beside, and the same
 * branch scope: a manager handing units to a technician can name that person
 * without being granted the whole HR employee register.
 */
export async function get_employeeStockEmployees(req: Request, res: Response): Promise<any> {
  const scope = resolveBranchScope(req as any, res);
  if (!scope) return;
  if (scope.empty) return res.status(403).json({ message: 'Forbidden: no branch is assigned to this account.' });
  const rows = await listCustodyEmployees(readableBranchIds(scope));
  res.set('Cache-Control', 'private, no-store');
  res.json(rows);
}

export async function get_employeeStockMovements(req: Request, res: Response): Promise<any> {
  const scope = resolveBranchScope(req as any, res);
  if (!scope) return;
  if (scope.empty) return res.status(403).json({ message: 'Forbidden: no branch is assigned to this account.' });
  const employeeId = text(req.query.employeeId, 50);
  if (!employeeId) return res.status(400).json({ message: 'employeeId is required.' });
  const rows = await listEmployeeStockMovements({
    branchIds: readableBranchIds(scope),
    employeeId,
    limit: Number(req.query.limit) || undefined,
  });
  res.set('Cache-Control', 'private, no-store');
  res.json(rows);
}

interface ParsedMovement extends MovementInput {
  type: EmployeeStockMovementType;
}

/** Shared body validation for the four movements. */
function parseMovement(req: Request, res: Response): ParsedMovement | null {
  const body = req.body || {};
  const employeeId = text(body.employeeId, 50);
  if (!employeeId) {
    res.status(400).json({ message: 'employeeId is required.' });
    return null;
  }
  const productId = text(body.productId, 50);
  if (!productId) {
    res.status(400).json({ message: 'productId is required.' });
    return null;
  }
  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) {
    res.status(400).json({ message: `quantity must be a whole number between 1 and ${MAX_QUANTITY}.` });
    return null;
  }
  return {
    employeeId,
    productId,
    branchId: '',
    quantity,
    workOrderId: text(body.workOrderId, 50),
    reason: text(body.reason, 1000),
    actor: actorEmail(req as any),
    type: 'ISSUE',
  };
}

async function runMovement(
  req: Request,
  res: Response,
  next: (err?: any) => void,
  type: EmployeeStockMovementType
): Promise<any> {
  const parsed = parseMovement(req, res);
  if (!parsed) return;
  if (type === 'LOSS' && !parsed.reason) {
    return res.status(400).json({ message: 'A loss needs a reason.', code: 'REASON_REQUIRED' });
  }
  const scope = resolveBranchScope(req as any, res, req.body?.branchId);
  if (!scope) return;
  if (scope.empty) return res.status(403).json({ message: 'Forbidden: no branch is assigned to this account.' });

  // A branch account is pinned to its own branch; head office may name one, and
  // the employee's own branch is the default when no branch is named at all.
  let branchId = scope.branchId;
  if (!branchId) {
    try {
      const own = await employeeBranchId(parsed.employeeId);
      if (!own) return res.status(400).json({ message: 'That employee does not exist.', code: 'UNKNOWN_EMPLOYEE' });
      branchId = own;
    } catch (error) {
      return handleRefusal(error, res, next);
    }
  }
  if (scope.allowed && scope.allowed.size > 0 && !scope.allowed.has(branchId)) {
    return res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
  }

  const input: MovementInput = { ...parsed, branchId };
  try {
    const movement =
      type === 'ISSUE'
        ? await issueEmployeeStock(input)
        : type === 'RETURN'
          ? await returnEmployeeStock(input)
          : type === 'CONSUME'
            ? await consumeEmployeeStock(input)
            : await recordEmployeeStockLoss(input);
    res.set('Cache-Control', 'private, no-store');
    res.status(201).json(movement);
  } catch (error) {
    handleRefusal(error, res, next);
  }
}

export async function post_employeeStockIssue(req: Request, res: Response, next: any): Promise<any> {
  return runMovement(req, res, next, 'ISSUE');
}

export async function post_employeeStockReturn(req: Request, res: Response, next: any): Promise<any> {
  return runMovement(req, res, next, 'RETURN');
}

export async function post_employeeStockConsume(req: Request, res: Response, next: any): Promise<any> {
  return runMovement(req, res, next, 'CONSUME');
}

export async function post_employeeStockLoss(req: Request, res: Response, next: any): Promise<any> {
  return runMovement(req, res, next, 'LOSS');
}

/**
 * POST /api/employee-stock/transfer — custody moves person to person.
 *
 * The giver's branch decides the scope: a branch account may transfer only
 * inside its own branch, and head office may name any single branch. Crossing
 * branches is a 409 with the remedy named (return, then issue), not a silent
 * stock move.
 */
export async function post_employeeStockTransfer(req: Request, res: Response, next: any): Promise<any> {
  const body = req.body || {};
  const fromEmployeeId = text(body.fromEmployeeId ?? body.employeeId, 50);
  if (!fromEmployeeId) return res.status(400).json({ message: 'fromEmployeeId is required.' });
  const toEmployeeId = text(body.toEmployeeId, 50);
  if (!toEmployeeId) return res.status(400).json({ message: 'toEmployeeId is required.' });
  const productId = text(body.productId, 50);
  if (!productId) return res.status(400).json({ message: 'productId is required.' });
  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) {
    return res.status(400).json({ message: `quantity must be a whole number between 1 and ${MAX_QUANTITY}.` });
  }
  const reason = text(body.reason, 1000);
  if (!reason) {
    return res.status(400).json({ message: 'A custody transfer needs a reason.', code: 'REASON_REQUIRED' });
  }

  const scope = resolveBranchScope(req as any, res, body.branchId);
  if (!scope) return;
  if (scope.empty) return res.status(403).json({ message: 'Forbidden: no branch is assigned to this account.' });

  let branchId: string | null = null;
  try {
    branchId = await employeeBranchId(fromEmployeeId);
  } catch (error) {
    return handleRefusal(error, res, next);
  }
  if (!branchId) return res.status(400).json({ message: 'That employee does not exist.', code: 'UNKNOWN_EMPLOYEE' });
  if (scope.branchId && scope.branchId !== branchId) {
    return res.status(403).json({ message: 'Forbidden: the giving employee is not in this branch.' });
  }
  if (scope.allowed && scope.allowed.size > 0 && !scope.allowed.has(branchId)) {
    return res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
  }

  try {
    const transfer = await transferEmployeeStock({
      fromEmployeeId,
      toEmployeeId,
      productId,
      quantity,
      reason,
      actor: actorEmail(req as any),
    });
    res.set('Cache-Control', 'private, no-store');
    res.status(201).json(transfer);
  } catch (error) {
    handleRefusal(error, res, next);
  }
}
