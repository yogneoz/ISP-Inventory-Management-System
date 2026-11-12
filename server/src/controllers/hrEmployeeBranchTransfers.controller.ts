/**
 * Directory-wide employee branch-transfer log.
 *
 * GET /api/hr/branch-transfers?branchId=&dateFrom=&dateTo=
 *
 * The branch scope is re-derived from the session. A caller may narrow to one
 * authorized branch, but may never widen past their scope by naming ALL or by
 * omitting the filter. Date bounds are inclusive AD dates; omitted bounds mean
 * the whole recorded history within the 500-row read ceiling.
 */
import type { Response } from 'express';
import { getPgConnected, pgPool } from '../app';
import { ApiError } from '../errors/ApiError';
import { getUserFromReq } from '../middleware/auth';
import { allowedBranchScope } from '../middleware/branchScope';
import {
  buildEmployeeBranchTransferLogQuery,
} from '../models/hrEmployeeBranchTransfers.repo';

const TRANSFER_FILTERS = new Set(['branchId', 'dateFrom', 'dateTo']);

function parseDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, `${label} must be a real date in YYYY-MM-DD form.`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new ApiError(400, `${label} must be a real date in YYYY-MM-DD form.`);
  }
  return value;
}

function readFilters(req: any): {
  branchId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
} {
  const query = req.query || {};
  for (const key of Object.keys(query)) {
    if (!TRANSFER_FILTERS.has(key)) {
      throw new ApiError(400, `Unknown transfer filter "${key}".`);
    }
  }
  for (const key of TRANSFER_FILTERS) {
    const value = query[key];
    if (value !== undefined && typeof value !== 'string') {
      throw new ApiError(400, `Repeated or structured transfer filter "${key}" is not allowed.`);
    }
  }

  const rawBranch = typeof query.branchId === 'string' ? query.branchId.trim() : '';
  const branchId = rawBranch && rawBranch !== 'ALL' ? rawBranch.slice(0, 50) : null;
  const dateFrom = query.dateFrom ? parseDate(query.dateFrom, 'dateFrom') : null;
  const dateTo = query.dateTo ? parseDate(query.dateTo, 'dateTo') : null;
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new ApiError(400, 'dateFrom must be on or before dateTo.');
  }
  return { branchId, dateFrom, dateTo };
}

/** GET /api/hr/branch-transfers */
export async function get_hrEmployeeBranchTransfers(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');

  const filters = readFilters(req);
  const user = req.user || getUserFromReq(req);
  const allowed = allowedBranchScope(user);

  if (filters.branchId && allowed !== null && !allowed.has(filters.branchId)) {
    throw new ApiError(403, 'Forbidden: this account is not authorized for the requested branch.');
  }
  if (allowed !== null && allowed.size === 0) {
    return res.json([]);
  }

  const { sql, params } = buildEmployeeBranchTransferLogQuery({
    branchId: filters.branchId,
    branchScope: filters.branchId
      ? null
      : allowed === null
        ? null
        : [...allowed],
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
  });

  const { rows } = await pgPool.query(sql, params);
  return res.json(rows);
}
