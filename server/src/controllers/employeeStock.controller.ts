/**
 * Employee stock custody API — the ledger behind My Stock and the employee
 * profile's Equipment section.
 *
 *   GET  /api/employee-stock            holdings (branch-scoped, optional filters)
 *   GET  /api/employee-stock/movements  one employee's log
 *   GET  /api/employee-stock/tieout     the log and the projection, reconciled
 *   POST /api/employee-stock/issue      branch stock -> employee  (`stock-deploy`)
 *   POST /api/employee-stock/return     employee -> branch stock  (`consumable-issue-reverse`)
 *   POST /api/employee-stock/consume    used on a job, gone      (`consumable-issue-reverse`)
 *   POST /api/employee-stock/loss       write-off with a reason  (`stock-deploy` + `custody-writeoff`)
 *   POST /api/employee-stock/audit      counted stock take       (`stock-deploy` + `custody-writeoff`)
 *
 * Every write derives its branch from the caller's session scope, never from a
 * browser claim, and every response is `private, no-store` like the neighbouring
 * registers. The quantity rules live in the repository's guarded UPDATEs and in
 * the holdings projection, so a retry cannot double-write or go negative.
 */
import type { Request, Response } from 'express';
import { resolveBranchScope } from './accounting.controller';
import { businessDateAD } from '../../../shared/businessDate';
import { SerialCustodyRefusal } from '../services/serialCustody.service';
import { CustodyInstallRefusal } from '../services/custodyInstall.service';
import {
  EmployeeStockRefusal,
  auditEmployeeStock,
  consumeEmployeeStock,
  custodyTieOut,
  employeeBranchId,
  installEmployeeCustodyAsset,
  issueEmployeeStock,
  listCustodyEmployees,
  listEmployeeCustodyAssets,
  listEmployeeStockHoldings,
  listEmployeeStockMovements,
  recordEmployeeStockLoss,
  reportEmployeeStockLoss,
  returnEmployeeStock,
  transferEmployeeStock,
  type CustodyAuditLine,
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
  // A serial that is not the unit this movement names is the caller's mistake,
  // not a server fault: answer with its own status and code.
  if (error instanceof SerialCustodyRefusal) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  if (error instanceof CustodyInstallRefusal) {
    return res.status(error.status).json({ message: error.message, code: error.code });
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
  // Serialised units: the identity is the point of the move, so one serial per
  // unit is required. A quantity-only product simply sends none.
  const serials = Array.isArray(body.deviceSerials)
    ? body.deviceSerials.map((value: unknown) => String(value ?? '').trim()).filter(Boolean).slice(0, MAX_QUANTITY)
    : text(body.deviceSerial, 100)
      ? [String(text(body.deviceSerial, 100))]
      : [];
  if (serials.length > 0 && serials.length !== quantity) {
    res.status(400).json({
      message: `A serialised movement needs exactly one device serial per unit: ${quantity} unit(s), ${serials.length} serial(s).`,
      code: 'SERIAL_COUNT_MISMATCH',
    });
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
    serials,
    customerId: text(body.customerId, 50),
    customerName: text(body.customerName, 200),
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
  const serials = Array.isArray(body.deviceSerials)
    ? body.deviceSerials.map((value: unknown) => String(value ?? '').trim()).filter(Boolean).slice(0, MAX_QUANTITY)
    : [];
  if (serials.length > 0 && serials.length !== quantity) {
    return res.status(400).json({
      message: `A serialised transfer needs exactly one device serial per unit: ${quantity} unit(s), ${serials.length} serial(s).`,
      code: 'SERIAL_COUNT_MISMATCH',
    });
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
      serials,
    });
    res.set('Cache-Control', 'private, no-store');
    res.status(201).json(transfer);
  } catch (error) {
    handleRefusal(error, res, next);
  }
}

/**
 * GET /api/employee-stock/tieout — the two books, side by side.
 *
 * `held` is the projection, `movementSum` is the signed log rebuilt from the
 * same rows, and `branchOnHand` is the shelf the product left. An issue that
 * touched the shelf and not the log (or the reverse) is a non-zero `drift` here
 * instead of a silent difference nobody reconciles.
 */
export async function get_employeeStockTieOut(req: Request, res: Response): Promise<any> {
  const scope = resolveBranchScope(req as any, res);
  if (!scope) return;
  if (scope.empty) return res.status(403).json({ message: 'Forbidden: no branch is assigned to this account.' });
  const tieOut = await custodyTieOut({
    branchIds: readableBranchIds(scope),
    employeeId: text(req.query.employeeId, 50) || undefined,
    productId: text(req.query.productId, 50) || undefined,
  });
  res.set('Cache-Control', 'private, no-store');
  res.json(tieOut);
}

/**
 * POST /api/employee-stock/audit — a counted stock take replaces the holding.
 *
 * A shortfall is written off as a LOSS (the reason is the only place the story
 * is told); a surplus is issued again, because units found in a technician's
 * hands came off the branch shelf. Both movements rebuild the projection, so a
 * count can only ever move the ledger, never leave it stale. Lines counted equal
 * to the holding write nothing.
 */
export async function post_employeeStockAudit(
  req: Request,
  res: Response,
  next: (err?: any) => void
): Promise<any> {
  const body = (req.body || {}) as any;
  const employeeId = text(body.employeeId, 50);
  if (!employeeId) {
    return res.status(400).json({ message: 'Name the employee whose stock was counted.', code: 'EMPLOYEE_REQUIRED' });
  }
  const reason = text(body.reason, 1000);
  if (!reason) {
    return res.status(400).json({ message: 'A stock audit needs a reason.', code: 'REASON_REQUIRED' });
  }

  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items: CustodyAuditLine[] = [];
  for (const raw of rawItems) {
    const productId = text(raw?.productId, 50);
    const counted = Number(raw?.countedQuantity);
    if (!productId) {
      return res.status(400).json({ message: 'Every counted line needs a product.', code: 'PRODUCT_REQUIRED' });
    }
    if (!Number.isInteger(counted) || counted < 0 || counted > MAX_QUANTITY) {
      return res.status(400).json({
        message: `A counted quantity must be a whole number of units between 0 and ${MAX_QUANTITY}.`,
        code: 'INVALID_QUANTITY',
      });
    }
    items.push({ productId, countedQuantity: counted });
  }
  if (items.length === 0) {
    return res.status(400).json({ message: 'Add at least one counted product line.', code: 'ITEMS_REQUIRED' });
  }

  const scope = resolveBranchScope(req as any, res, body.branchId);
  if (!scope) return;
  if (scope.empty) return res.status(403).json({ message: 'Forbidden: no branch is assigned to this account.' });

  // Derive the branch from the person being counted, never from the browser.
  let branchId: string | null = null;
  try {
    branchId = await employeeBranchId(employeeId);
  } catch (error) {
    return handleRefusal(error, res, next);
  }
  if (!branchId) return res.status(400).json({ message: 'That employee does not exist.', code: 'UNKNOWN_EMPLOYEE' });
  if (scope.branchId && scope.branchId !== branchId) {
    return res.status(403).json({ message: 'Forbidden: that employee is not in this branch.' });
  }
  if (scope.allowed && scope.allowed.size > 0 && !scope.allowed.has(branchId)) {
    return res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
  }

  try {
    const result = await auditEmployeeStock({
      employeeId,
      branchId,
      items,
      reason,
      actor: actorEmail(req as any),
    });
    res.set('Cache-Control', 'private, no-store');
    res.status(201).json(result);
  } catch (error) {
    handleRefusal(error, res, next);
  }
}

/**
 * GET /api/employee-stock/assets — the whole units a person holds.
 *
 * The second half of My Stock: a serialised unit with a `fixed_assets` row is
 * owned by that row, so it is read here rather than through the quantity
 * projection. The row carries the work order and its customer, because that is
 * what the technician needs before the visit and what the install stamps.
 */
export async function get_employeeStockAssets(req: Request, res: Response): Promise<any> {
  const scope = resolveBranchScope(req as any, res);
  if (!scope) return;
  if (scope.empty) return res.status(403).json({ message: 'Forbidden: no branch is assigned to this account.' });
  const rows = await listEmployeeCustodyAssets({
    branchIds: readableBranchIds(scope),
    employeeId: text(req.query.employeeId, 50) || undefined,
  });
  res.set('Cache-Control', 'private, no-store');
  res.json(rows);
}

/**
 * POST /api/employee-stock/install — issue a held CPE to the visit's customer.
 *
 * The same service the web and mobile completions call, so this action cannot
 * produce a different ledger: one transaction moves the asset, the serial, the
 * customer-device row and the seller warranty, and clears the custody. The
 * holder check inside the service is the authorization — a technician can only
 * install the unit they actually hold, whatever the payload claims.
 */
export async function post_employeeStockInstall(
  req: Request,
  res: Response,
  next: (err?: any) => void
): Promise<any> {
  const body = (req.body || {}) as any;
  const employeeId = text(body.employeeId, 50);
  if (!employeeId) {
    return res.status(400).json({ message: 'Name the technician holding the unit.', code: 'EMPLOYEE_REQUIRED' });
  }
  const assetId = text(body.assetId, 50);
  const workOrderId = text(body.workOrderId, 50);
  if (!assetId || !workOrderId) {
    return res
      .status(400)
      .json({ message: 'An installation needs the asset and the work order it was dispatched for.', code: 'INSTALL_TARGET_REQUIRED' });
  }

  const scope = resolveBranchScope(req as any, res, body.branchId);
  if (!scope) return;
  if (scope.empty) return res.status(403).json({ message: 'Forbidden: no branch is assigned to this account.' });

  let branchId: string | null = null;
  try {
    branchId = await employeeBranchId(employeeId);
  } catch (error) {
    return handleRefusal(error, res, next);
  }
  if (!branchId) return res.status(400).json({ message: 'That employee does not exist.', code: 'UNKNOWN_EMPLOYEE' });
  if (scope.branchId && scope.branchId !== branchId) {
    return res.status(403).json({ message: 'Forbidden: that employee is not in this branch.' });
  }
  if (scope.allowed && scope.allowed.size > 0 && !scope.allowed.has(branchId)) {
    return res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
  }

  const dateAD = text(body.dateAD, 10) || businessDateAD();
  try {
    const installed = await installEmployeeCustodyAsset({
      assetId,
      employeeId,
      workOrderId,
      dateAD,
      dateBS: text(body.dateBS, 20) || undefined,
      actor: actorEmail(req as any),
    });
    res.set('Cache-Control', 'private, no-store');
    res.status(201).json(installed);
  } catch (error) {
    handleRefusal(error, res, next);
  }
}

/**
 * POST /api/employee-stock/loss-report — the holder reports a loss.
 *
 * A technician may not write stock off (`custody-writeoff` is the manager's
 * operation); they may only say what happened. The report is an approval request
 * carrying the product, quantity and serials, and a manager executes it into the
 * LOSS movement — so the ledger entry is always a second person's decision.
 */
export async function post_employeeStockLossReport(
  req: Request,
  res: Response,
  next: (err?: any) => void
): Promise<any> {
  const body = (req.body || {}) as any;
  const employeeId = text(body.employeeId ?? body.holderEmployeeId, 50);
  if (!employeeId) {
    return res.status(400).json({ message: 'Name the employee holding the units.', code: 'EMPLOYEE_REQUIRED' });
  }
  const productId = text(body.productId, 50);
  if (!productId) return res.status(400).json({ message: 'productId is required.', code: 'PRODUCT_REQUIRED' });
  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) {
    return res.status(400).json({ message: `quantity must be a whole number between 1 and ${MAX_QUANTITY}.` });
  }
  const reason = text(body.reason, 1000);
  if (!reason) {
    return res.status(400).json({ message: 'A loss report needs a reason.', code: 'REASON_REQUIRED' });
  }
  const serials = Array.isArray(body.deviceSerials)
    ? body.deviceSerials.map((value: unknown) => String(value ?? '').trim()).filter(Boolean)
    : [];

  const scope = resolveBranchScope(req as any, res, body.branchId);
  if (!scope) return;
  if (scope.empty) return res.status(403).json({ message: 'Forbidden: no branch is assigned to this account.' });

  let branchId: string | null = null;
  try {
    branchId = await employeeBranchId(employeeId);
  } catch (error) {
    return handleRefusal(error, res, next);
  }
  if (!branchId) return res.status(400).json({ message: 'That employee does not exist.', code: 'UNKNOWN_EMPLOYEE' });
  if (scope.branchId && scope.branchId !== branchId) {
    return res.status(403).json({ message: 'Forbidden: that employee is not in this branch.' });
  }
  if (scope.allowed && scope.allowed.size > 0 && !scope.allowed.has(branchId)) {
    return res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
  }

  const user = (req as any).user || {};
  try {
    const report = await reportEmployeeStockLoss({
      employeeId,
      branchId,
      productId,
      productName: text(body.productName, 255) || null,
      quantity,
      serials,
      reason,
      actor: { email: user.email || null, name: user.name || null, role: user.role || null },
    });
    res.set('Cache-Control', 'private, no-store');
    res.status(201).json({
      requestId: report.request.id,
      requestNumber: report.requestNumber,
      status: report.request.status,
      message:
        'Loss reported. A manager approves it before the units leave the account — nothing was written off.',
    });
  } catch (error) {
    handleRefusal(error, res, next);
  }
}
