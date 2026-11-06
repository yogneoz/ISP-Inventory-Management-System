/**
 * Bill-terms master HTTP surface. The list is readable under `gl-view`; writes
 * require `gl-bill-terms-manage`. A term used by a party or a posted invoice cannot be
 * deleted — retire it instead, so history never points at a missing policy.
 */
import type { Response } from 'express';
import { getPgConnected, pgPool } from '../app';
import { logAuditEvent } from '../services/audit.service';
import { booleanFlag } from '../utils/booleanFlag';
import { ApiError } from '../errors/ApiError';
import {
  BILL_TERM_DELETE_SQL,
  BILL_TERM_INSERT_SQL,
  BILL_TERM_UPDATE_SQL,
  billTermInsertParams,
  billTermUpdateParams,
} from '../models/billTerms.repo';
import {
  billTermUsageCount,
  findBillTermByCode,
  findBillTermById,
  listBillTerms,
} from '../services/billTerms.service';
import { billTerms, setBillTerms } from '../state/runtimeState';
import { MAX_BILL_TERM_DAYS } from '../../../shared/billTerms';
import type { BillTerm } from '../../../client/src/types';

function optionalInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > MAX_BILL_TERM_DAYS) {
    throw new ApiError(400, `${label} must be a whole number between 0 and ${MAX_BILL_TERM_DAYS}.`);
  }
  return numeric;
}

function optionalPercent(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    throw new ApiError(400, 'Discount percent must be between 0 and 100.');
  }
  return numeric;
}

function parseBillTerm(body: Record<string, any>, existing?: BillTerm): BillTerm {
  const code = String(body.code ?? existing?.code ?? '').trim().toUpperCase();
  const name = String(body.name ?? existing?.name ?? '').trim();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,29}$/.test(code)) {
    throw new ApiError(
      400,
      'A bill-term code is required: 1–30 letters, digits, hyphens or underscores.'
    );
  }
  if (!name) throw new ApiError(400, 'A bill-term name is required.');
  if (name.length > 150) throw new ApiError(400, 'Bill-term name must be 150 characters or fewer.');

  const dueDays = optionalInteger(body.dueDays ?? existing?.dueDays ?? 0, 'Due days') ?? 0;
  const discountDays = optionalInteger(
    body.discountDays !== undefined ? body.discountDays : existing?.discountDays,
    'Discount days'
  );
  const discountPercent = optionalPercent(
    body.discountPercent !== undefined ? body.discountPercent : existing?.discountPercent
  );

  return {
    id: existing?.id || String(body.id || '').trim() || `bt-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    code,
    name,
    dueDays,
    discountDays,
    discountPercent,
    active: booleanFlag(body.active, existing?.active ?? true),
    isDemo: existing?.isDemo ?? false,
  };
}

async function assertCodeAvailable(term: BillTerm): Promise<void> {
  const conflict = await findBillTermByCode(term.code);
  if (conflict && conflict.id !== term.id) {
    throw new ApiError(409, `Bill-term code '${term.code}' is already in use.`);
  }
}

function remember(term: BillTerm): void {
  const exists = billTerms.some((row) => row.id === term.id);
  setBillTerms(
    exists ? billTerms.map((row) => (row.id === term.id ? term : row)) : [...billTerms, term]
  );
}

/** GET /api/accounting/bill-terms?includeInactive=1 */
export async function get_billTerms(req: any, res: Response): Promise<any> {
  const includeInactive = String(req.query?.includeInactive ?? '1') !== '0';
  return res.json(await listBillTerms(includeInactive));
}

/** POST /api/accounting/bill-terms */
export async function post_billTerm(req: any, res: Response): Promise<any> {
  const term = parseBillTerm(req.body || {});
  await assertCodeAvailable(term);
  if (getPgConnected()) {
    await pgPool.query(BILL_TERM_INSERT_SQL, billTermInsertParams(term));
  }
  remember(term);
  await logAuditEvent(
    req,
    'CREATE_BILL_TERM',
    'ACCOUNTING',
    `Created bill terms ${term.code} ${term.name} (${term.dueDays} days)`
  );
  return res.status(201).json(term);
}

/** PATCH /api/accounting/bill-terms/:id */
export async function patch_billTerm(req: any, res: Response): Promise<any> {
  const id = String(req.params?.id || '').trim();
  if (!id) throw new ApiError(400, 'A bill-term id is required.');
  const existing = await findBillTermById(id);
  if (!existing) throw new ApiError(404, 'Bill terms not found.');
  const term = parseBillTerm(req.body || {}, existing);
  await assertCodeAvailable(term);
  if (getPgConnected()) {
    await pgPool.query(BILL_TERM_UPDATE_SQL, billTermUpdateParams(term, id));
  }
  remember(term);
  await logAuditEvent(
    req,
    'UPDATE_BILL_TERM',
    'ACCOUNTING',
    `Updated bill terms ${term.code} ${term.name} (${term.dueDays} days, ${term.active ? 'active' : 'inactive'})`
  );
  return res.json(term);
}

/** DELETE /api/accounting/bill-terms/:id */
export async function delete_billTerm(req: any, res: Response): Promise<any> {
  const id = String(req.params?.id || '').trim();
  if (!id) throw new ApiError(400, 'A bill-term id is required.');
  const existing = await findBillTermById(id);
  if (!existing) throw new ApiError(404, 'Bill terms not found.');
  const used = await billTermUsageCount(id);
  if (used > 0) {
    throw new ApiError(
      409,
      `'${existing.name}' is used by ${used} party or invoice record(s). Retire it instead of deleting it.`
    );
  }
  if (getPgConnected()) {
    await pgPool.query(BILL_TERM_DELETE_SQL, [id]);
  }
  setBillTerms(billTerms.filter((term) => term.id !== id));
  await logAuditEvent(
    req,
    'DELETE_BILL_TERM',
    'ACCOUNTING',
    `Deleted bill terms ${existing.code} ${existing.name}`
  );
  return res.json({ deleted: true, id });
}
