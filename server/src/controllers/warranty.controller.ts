/**
 * WTY-1 warranty registers. Two paged reads (supplier/inbound and seller/
 * outbound) over one stored coverage table, plus the audited edit endpoint.
 *
 * Branch scope is resolved from the session exactly like the paged device read,
 * so a forged or omitted branchId cannot widen a branch account.
 */
import type { Response } from 'express';
import { getPgConnected, pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { logAuditEvent } from '../services/audit.service';
import { getUserFromReq } from '../middleware/auth';
import {
  buildWarrantyCountQuery,
  buildWarrantyExportQuery,
  buildWarrantyPageQuery,
  buildWarrantySummaryQuery,
  WARRANTY_FIND_BY_ID_SQL,
  WARRANTY_FIND_RECORD_BY_ID_SQL,
  warrantyStateForMirror,
  type WarrantyQueryOptions,
} from '../models/warranty.repo';
import {
  correctWarrantyCoverage,
  correctWarrantyCoverageMirror,
  normalizeTermMonths,
  warrantyDateError,
} from '../services/warranty.service';
import { branches, warrantyCoverages } from '../state/runtimeState';
import { isAdDate, warrantyStateFor } from '../../../shared/warrantyTerm';

const DEFAULT_PAGE_SIZE = 15;
const MAX_PAGE_SIZE = 200;

interface Scope {
  branchId?: unknown;
  branchScope?: string[];
  empty?: boolean;
}

function resolveWarrantyScope(req: any, res: Response): Scope | null {
  const user = req.user;
  const branchId = req.query?.branchId;
  if (user && user.role !== 'SUPER_ADMIN' && user.role !== 'HEAD_OFFICE_ADMIN') {
    const allowed = new Set<string>([user.branchId || '', ...(user.allowedBranchIds || [])].filter(Boolean));
    const requested =
      typeof branchId === 'string' && branchId !== 'ALL' && branchId.trim() !== '' ? branchId : undefined;
    if (requested && !allowed.has(requested)) {
      res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
      return null;
    }
    if (allowed.size === 0) return { empty: true };
    return requested ? { branchId: requested } : { branchScope: [...allowed] };
  }
  return { branchId };
}

function paging(query: any): { page: number; pageSize: number } {
  const page = Math.max(1, Math.trunc(Number(query?.page)) || 1);
  const size = Math.trunc(Number(query?.pageSize)) || DEFAULT_PAGE_SIZE;
  return { page, pageSize: Math.max(1, Math.min(MAX_PAGE_SIZE, size)) };
}

function queryOptions(req: any, coverageType: 'VENDOR' | 'SELLER', scope: Scope): WarrantyQueryOptions {
  return {
    coverageType,
    branchId: scope.branchId,
    branchScope: scope.branchScope,
    query: req.query?.query,
    status: req.query?.status,
    category: req.query?.category,
    startFrom: req.query?.startFrom ?? req.query?.from,
    startTo: req.query?.startTo ?? req.query?.to,
  };
}

interface MirrorRow {
  id: string;
  coverageType: 'VENDOR' | 'SELLER';
  itemCategory: 'CPE' | 'FIXED_ASSET' | 'SOLD_PRODUCT';
  productId?: string | null;
  productName: string;
  serialNumber: string;
  branchId?: string | null;
  branchName?: string | null;
  partyName?: string | null;
  sourceType: string;
  sourceId?: string | null;
  sourceNumber?: string | null;
  startDateAD: string;
  endDateAD: string;
  termMonths?: number | null;
  startBasis: string;
  notes?: string | null;
  isDemo?: boolean;
  /** RETURNED marks a retired row (return/correction), not a date state. */
  warrantyState: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'RETURNED';
  daysRemaining: number;
  retiredReason?: string | null;
  retiredRef?: string | null;
}

function mirrorRows(opts: WarrantyQueryOptions, branchNames: Map<string, string>): MirrorRow[] {
  const status = typeof opts.status === 'string' ? opts.status.trim().toUpperCase() : '';
  const category = typeof opts.category === 'string' ? opts.category.trim().toUpperCase() : '';
  const q = typeof opts.query === 'string' ? opts.query.trim().toLowerCase() : '';
  const from = typeof opts.startFrom === 'string' ? opts.startFrom : '';
  const to = typeof opts.startTo === 'string' ? opts.startTo : '';
  const scope = Array.isArray(opts.branchScope) ? new Set(opts.branchScope) : null;
  // The Returned filter reads the retired population; every other view reads
  // current coverage. Same split as the SQL builder.
  const retired = status === 'RETURNED';
  return warrantyCoverages
    .filter((row) => (retired ? !row.isCurrent : row.isCurrent) && row.coverageType === opts.coverageType)
    .filter((row) => {
      if (scope) {
        if (scope.size === 0 || !scope.has(String(row.branchId || ''))) return false;
      } else if (typeof opts.branchId === 'string' && opts.branchId !== 'ALL' && row.branchId !== opts.branchId) {
        return false;
      }
      if (category && category !== 'ALL' && row.itemCategory !== category) return false;
      if (from && (!row.startDateAD || row.startDateAD < from)) return false;
      if (to && (!row.startDateAD || row.startDateAD > to)) return false;
      if (q) {
        const hay = [row.productName, row.serialNumber, row.partyName, row.sourceNumber, branchNames.get(String(row.branchId || '')) || '']
          .map((value) => String(value || '').toLowerCase())
          .join(' ');
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .map((row) => {
      const state = row.isCurrent ? warrantyStateForMirror(row.endDateAD) : 'RETURNED';
      const end = Date.parse(`${row.endDateAD}T00:00:00Z`);
      const today = new Date();
      const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      return {
        id: row.id,
        coverageType: row.coverageType,
        itemCategory: row.itemCategory,
        productId: row.productId,
        productName: row.productName,
        serialNumber: row.serialNumber,
        branchId: row.branchId,
        branchName: branchNames.get(String(row.branchId || '')) || row.branchId || '',
        partyName: row.partyName,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        sourceNumber: row.sourceNumber,
        startDateAD: row.startDateAD,
        endDateAD: row.endDateAD,
        termMonths: row.termMonths,
        startBasis: row.startBasis,
        notes: row.notes,
        isDemo: row.isDemo,
        warrantyState: state,
        daysRemaining: Math.round((end - todayUTC) / 86_400_000),
        retiredReason: row.retiredReason ?? null,
        retiredRef: row.retiredRef ?? null,
      };
    })
    .filter((row) => {
      if (status === 'VALID' || status === 'EXPIRING_SOON' || status === 'EXPIRED' || status === 'RETURNED') {
        return row.warrantyState === status;
      }
      return true;
    })
    .sort((a, b) => (a.endDateAD === b.endDateAD ? a.id.localeCompare(b.id) : a.endDateAD.localeCompare(b.endDateAD)));
}

/**
 * The PG-less twin of the three register queries: same filters, same
 * soonest-expiry ordering, same status rule and the same KPI population. Kept
 * exported so the parity test can compare it with the SQL path on one fixture
 * instead of trusting a comment.
 */
export function buildWarrantyMirrorPage(
  opts: WarrantyQueryOptions,
  page: number,
  pageSize: number
): {
  data: ReturnType<typeof mirrorRows>;
  totalItems: number;
  counts: { total: number; valid: number; expiring: number; expired: number };
} {
  const branchNames = new Map<string, string>(branches.map((branch) => [branch.id, branch.name]));
  const all = mirrorRows(opts, branchNames);
  const counts = {
    total: all.length,
    valid: all.filter((row) => row.warrantyState === 'VALID').length,
    expiring: all.filter((row) => row.warrantyState === 'EXPIRING_SOON').length,
    expired: all.filter((row) => row.warrantyState === 'EXPIRED').length,
  };
  const status = typeof opts.status === 'string' ? opts.status.trim().toUpperCase() : '';
  const filtered = ['VALID', 'EXPIRING_SOON', 'EXPIRED', 'RETURNED'].includes(status)
    ? all.filter((row) => row.warrantyState === status)
    : all;
  const start = (page - 1) * pageSize;
  return { data: filtered.slice(start, start + pageSize), totalItems: filtered.length, counts };
}

async function listWarranty(req: any, res: Response, coverageType: 'VENDOR' | 'SELLER'): Promise<any> {
  const scope = resolveWarrantyScope(req, res);
  if (!scope) return;
  const { page, pageSize } = paging(req.query);
  // ?all=1 is the CSV export: every filtered row, never the visible page.
  // The response stays the same envelope so one client shape reads both.
  const wantsAll = String(req.query?.all ?? '') === '1';
  const opts = queryOptions(req, coverageType, scope);
  if (scope.empty) {
    return res.json({
      data: [],
      page: 1,
      pageSize,
      totalItems: 0,
      counts: { total: 0, valid: 0, expiring: 0, expired: 0 },
    });
  }

  if (getPgConnected()) {
    try {
      const rowsQuery = wantsAll
        ? buildWarrantyExportQuery(opts)
        : buildWarrantyPageQuery(opts, page, pageSize);
      const countQuery = buildWarrantyCountQuery(opts);
      const summaryQuery = buildWarrantySummaryQuery(opts);
      const [rows, count, summary] = await Promise.all([
        pgPool.query(rowsQuery.sql, rowsQuery.params as any[]),
        pgPool.query(countQuery.sql, countQuery.params as any[]),
        pgPool.query(summaryQuery.sql, summaryQuery.params as any[]),
      ]);
      return res.json({
        data: rows.rows,
        page: wantsAll ? 1 : page,
        pageSize: wantsAll ? rows.rows.length : pageSize,
        totalItems: Number(count.rows[0]?.count) || 0,
        counts: {
          total: Number(summary.rows[0]?.total) || 0,
          valid: Number(summary.rows[0]?.valid) || 0,
          expiring: Number(summary.rows[0]?.expiring) || 0,
          expired: Number(summary.rows[0]?.expired) || 0,
        },
      });
    } catch (err: any) {
      console.error('Error reading the warranty register from DB:', err);
      return res.status(500).json({ message: 'Could not load the warranty register from the database. Reload to retry.' });
    }
  }

  // Demo mode: the coverage mirror is the source of truth.
  const mirror = buildWarrantyMirrorPage(opts, wantsAll ? 1 : page, wantsAll ? Number.MAX_SAFE_INTEGER : pageSize);
  return res.json({
    ...mirror,
    page: wantsAll ? 1 : page,
    pageSize: wantsAll ? mirror.totalItems : pageSize,
  });
}

/** GET /api/warranties/vendor */
export async function get_warrantyVendor(req: any, res: Response): Promise<any> {
  return listWarranty(req, res, 'VENDOR');
}

/** GET /api/warranties/seller */
export async function get_warrantySeller(req: any, res: Response): Promise<any> {
  return listWarranty(req, res, 'SELLER');
}

function allowedForRow(req: any, branchId: unknown): boolean {
  const user = req.user;
  if (!user || user.role === 'SUPER_ADMIN' || user.role === 'HEAD_OFFICE_ADMIN') return true;
  const allowed = new Set<string>([user.branchId || '', ...(user.allowedBranchIds || [])].filter(Boolean));
  return allowed.has(String(branchId || ''));
}

/** PATCH /api/warranties/:id — correct the exact dates or notes. */
export async function patch_warrantyCoverage(req: any, res: Response): Promise<any> {
  try {
    const id = String(req.params?.id || '').trim();
    if (!id) return res.status(400).json({ message: 'A coverage id is required.' });
    const startDateAD = String(req.body?.startDateAD || '').trim();
    const endDateAD = String(req.body?.endDateAD || '').trim();
    const dateError = warrantyDateError(startDateAD, endDateAD);
    if (dateError) return res.status(400).json({ message: dateError });
    if (!isAdDate(startDateAD) || !isAdDate(endDateAD)) {
      return res.status(400).json({ message: 'Warranty dates must be real calendar dates.' });
    }
    const termMonths = normalizeTermMonths(req.body?.termMonths);
    if (termMonths === undefined) {
      return res.status(400).json({ message: 'Warranty term must be between 0 and 120 months.' });
    }
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim().slice(0, 500) : null;
    const actor = getUserFromReq(req).email || getUserFromReq(req).name || null;

    if (getPgConnected()) {
      const found = await pgPool.query(WARRANTY_FIND_RECORD_BY_ID_SQL, [id]);
      const row = found.rows[0];
      if (!row) return res.status(404).json({ message: 'Warranty coverage not found.' });
      if (!allowedForRow(req, row.branchId)) {
        return res.status(403).json({ message: 'Forbidden: this coverage is outside your branch scope.' });
      }
      // Supersede + insert + audit commit together. A correction is never an
      // in-place overwrite: the replaced period stays queryable by its dates.
      const newId = await withTransaction(async (client) => {
        const replacementId = await correctWarrantyCoverage(client, {
          record: row,
          startDateAD,
          endDateAD,
          termMonths: termMonths ?? null,
          notes,
          actor,
        });
        await logAuditEvent(
          req,
          'UPDATE_WARRANTY_COVERAGE',
          'INVENTORY',
          `Warranty ${row.coverageType} ${row.serialNumber}: ${row.startDateAD}→${row.endDateAD} corrected to ${startDateAD}→${endDateAD} (superseded ${id})`,
          undefined,
          client
        );
        return replacementId;
      });
      const updated = await pgPool.query(WARRANTY_FIND_BY_ID_SQL, [newId]);
      return res.json(updated.rows[0]);
    }

    const existing = warrantyCoverages.find((row) => row.id === id && row.isCurrent);
    if (!existing) return res.status(404).json({ message: 'Warranty coverage not found.' });
    if (!allowedForRow(req, existing.branchId)) {
      return res.status(403).json({ message: 'Forbidden: this coverage is outside your branch scope.' });
    }
    const newId = correctWarrantyCoverageMirror({
      record: existing,
      startDateAD,
      endDateAD,
      termMonths: termMonths ?? null,
      notes,
      actor,
    });
    if (!newId) return res.status(404).json({ message: 'Warranty coverage not found.' });
    logAuditEvent(
      req,
      'UPDATE_WARRANTY_COVERAGE',
      'INVENTORY',
      `Warranty ${existing.coverageType} ${existing.serialNumber}: corrected to ${startDateAD}→${endDateAD} (superseded ${id})`
    );
    const updated = warrantyCoverages.find((row) => row.id === newId)!;
    return res.json({
      ...updated,
      warrantyState: warrantyStateFor(updated.endDateAD),
      daysRemaining: Math.round(
        (Date.parse(`${updated.endDateAD}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000
      ),
    });
  } catch (err: any) {
    console.error('Error updating warranty coverage:', err);
    return res.status(500).json({ message: 'Could not save the warranty coverage.' });
  }
}
