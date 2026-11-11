/**
 * Manual cash-flow forecast input HTTP surface.
 *
 * Reads share the forecast's `gl-view` gate; writes require `gl-post`. Branch
 * scope is resolved from the session (never trusted from the body), and every
 * write is audited in the same transaction as the row.
 */
import type { Response } from 'express';
import { pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { ApiError } from '../errors/ApiError';
import { getUserFromReq } from '../middleware/auth';
import { logAuditEvent } from '../services/audit.service';
import {
  createCashFlowManualInput,
  deleteCashFlowManualInput,
  getCashFlowManualInput,
  listCashFlowManualInputs,
  updateCashFlowManualInput,
} from '../services/cashFlowManualInput.service';
import { resolveBranchScope } from './accounting.controller';

function actorOf(req: any): string | null {
  const user = getUserFromReq(req);
  return user.email || user.name || null;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store');
}

function concreteBranch(value: unknown): string {
  const branchId = typeof value === 'string' ? value.trim() : '';
  if (!branchId || branchId === 'ALL') {
    throw new ApiError(400, 'A concrete branch is required for a manual cash-flow input.');
  }
  return branchId;
}

/** GET /api/accounting/cash-flow/manual-inputs?branchId= */
export async function get_cashFlowManualInputs(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  noStore(res);
  if (scope.empty) return res.json({ inputs: [], count: 0 });
  const inputs = await listCashFlowManualInputs(pgPool, scope.branchId || null);
  return res.json({ inputs, count: inputs.length });
}

/** POST /api/accounting/cash-flow/manual-inputs */
export async function post_cashFlowManualInput(req: any, res: Response): Promise<any> {
  const branchId = concreteBranch(req.body?.branchId);
  const scope = resolveBranchScope(req, res, branchId);
  if (!scope) return;
  if (scope.empty) throw new ApiError(403, 'This account is not assigned to any branch.');
  if (scope.branchId && scope.branchId !== branchId) {
    throw new ApiError(403, 'Forbidden: this account is not authorized for the requested branch.');
  }

  const input = await withTransaction(async (client) => {
    const created = await createCashFlowManualInput(
      client,
      { ...(req.body || {}), branchId },
      actorOf(req)
    );
    await logAuditEvent(
      req,
      'CREATE_CASH_FLOW_MANUAL_INPUT',
      'ACCOUNTING',
      `Created manual cash-flow ${created.direction.toLowerCase()} ${created.id} for ${created.branchCode} on ${created.expectedDateAD}`,
      undefined,
      client
    );
    return created;
  });
  noStore(res);
  return res.status(201).json(input);
}

/** PATCH /api/accounting/cash-flow/manual-inputs/:id */
export async function patch_cashFlowManualInput(req: any, res: Response): Promise<any> {
  const id = String(req.params?.id || '').trim();
  if (!id) throw new ApiError(400, 'A manual cash-flow input id is required.');
  const existing = await getCashFlowManualInput(pgPool, id);
  if (!existing) throw new ApiError(404, 'Manual cash-flow input not found.');
  const scope = resolveBranchScope(req, res, existing.branchId);
  if (!scope) return;
  if (scope.empty) throw new ApiError(403, 'This account is not assigned to any branch.');

  const updated = await withTransaction(async (client) => {
    const row = await updateCashFlowManualInput(client, id, req.body || {}, actorOf(req));
    await logAuditEvent(
      req,
      'UPDATE_CASH_FLOW_MANUAL_INPUT',
      'ACCOUNTING',
      `Updated manual cash-flow input ${row.id} for ${row.branchCode} on ${row.expectedDateAD}`,
      undefined,
      client
    );
    return row;
  });
  noStore(res);
  return res.json(updated);
}

/** DELETE /api/accounting/cash-flow/manual-inputs/:id */
export async function delete_cashFlowManualInput(req: any, res: Response): Promise<any> {
  const id = String(req.params?.id || '').trim();
  if (!id) throw new ApiError(400, 'A manual cash-flow input id is required.');
  const existing = await getCashFlowManualInput(pgPool, id);
  if (!existing) throw new ApiError(404, 'Manual cash-flow input not found.');
  const scope = resolveBranchScope(req, res, existing.branchId);
  if (!scope) return;
  if (scope.empty) throw new ApiError(403, 'This account is not assigned to any branch.');

  const deleted = await withTransaction(async (client) => {
    const result = await deleteCashFlowManualInput(client, id);
    await logAuditEvent(
      req,
      'DELETE_CASH_FLOW_MANUAL_INPUT',
      'ACCOUNTING',
      `Deleted manual cash-flow input ${existing.id} for ${existing.branchCode} on ${existing.expectedDateAD}`,
      undefined,
      client
    );
    return result;
  });
  noStore(res);
  return res.json(deleted);
}
