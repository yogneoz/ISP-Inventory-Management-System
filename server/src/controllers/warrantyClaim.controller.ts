/**
 * Warranty claims / RMA HTTP layer.
 *
 * Reads and writes are branch custody. A branch account may only open a claim
 * against a coverage in its own branch, and the by-id routes are additionally
 * guarded by the branch-scope registry. Every write is audited in the same
 * transaction as the claim/event/stock change.
 */
import type { Response } from 'express';
import {
  getPgConnected,
  getUserFromReq,
  logAuditEvent,
  pgPool,
  withTransaction,
} from '../app';
import {
  buildWarrantyClaimCountQuery,
  buildWarrantyClaimPageQuery,
  buildWarrantyClaimSummaryQuery,
  buildWarrantyRecoveryAgingQuery,
  buildWarrantyRecoveryCountQuery,
  buildWarrantyRecoveryPageQuery,
  buildWarrantyRecoverySummaryQuery,
  buildWarrantyRecoveryVendorQuery,
  WARRANTY_CLAIM_CREDIT_JOURNAL_SQL,
  WARRANTY_CLAIM_EVENT_SELECT_SQL,
  WARRANTY_CLAIM_FIND_SQL,
} from '../models/warrantyClaim.repo';
import {
  createWarrantyClaim,
  findClaimForTransition,
  transitionWarrantyClaim,
} from '../services/warrantyClaim.service';
import {
  WARRANTY_RMA_AGING_BUCKETS,
  warrantyCreditShortfall,
  warrantyRecoveryState,
  warrantyRmaAgingBucket,
} from '../../../shared/warrantyRecovery';

interface ClaimScope {
  branchId?: unknown;
  branchScope?: string[];
  empty?: boolean;
  global?: boolean;
}

const DEFAULT_PAGE_SIZE = 15;
const MAX_PAGE_SIZE = 200;

function resolveScope(req: any, res: Response): ClaimScope | null {
  const user = req.user;
  if (user && user.role !== 'SUPER_ADMIN' && user.role !== 'HEAD_OFFICE_ADMIN') {
    const allowed = [
      ...new Set<string>([user.branchId || '', ...(user.allowedBranchIds || [])].filter(Boolean)),
    ];
    const requested =
      typeof req.query?.branchId === 'string' && req.query.branchId !== 'ALL'
        ? req.query.branchId.trim()
        : '';
    if (requested && !allowed.includes(requested)) {
      res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
      return null;
    }
    if (allowed.length === 0) return { empty: true, branchScope: [] };
    return requested
      ? { branchId: requested, branchScope: [requested] }
      : { branchScope: allowed };
  }
  return {
    global: true,
    branchId: typeof req.query?.branchId === 'string' ? req.query.branchId : undefined,
  };
}

function allowedForBranch(scope: ClaimScope, branchId: unknown): boolean {
  if (scope.global) return true;
  return Array.isArray(scope.branchScope) && scope.branchScope.includes(String(branchId || ''));
}

async function claimDetail(id: string): Promise<any | null> {
  const row = (await pgPool.query(WARRANTY_CLAIM_FIND_SQL, [id])).rows[0];
  if (!row) return null;
  const [events, credit] = await Promise.all([
    pgPool.query(WARRANTY_CLAIM_EVENT_SELECT_SQL, [id]),
    row.journalId ? pgPool.query(WARRANTY_CLAIM_CREDIT_JOURNAL_SQL, [row.journalId]) : Promise.resolve({ rows: [] } as any),
  ]);
  const vendorCredit = credit.rows[0]
    ? {
        journalId: credit.rows[0].id,
        journalNo: credit.rows[0].journalNo,
        amount: Number(credit.rows[0].amount) || 0,
        reconciled:
          Math.abs((Number(credit.rows[0].amount) || 0) - (Number(row.receivedCredit) || 0)) < 0.005,
      }
    : null;
  return { ...row, events: events.rows, vendorCredit };
}

function paging(query: any): { page: number; pageSize: number } {
  const page = Math.max(1, Math.trunc(Number(query?.page)) || 1);
  const pageSize = Math.max(
    1,
    Math.min(MAX_PAGE_SIZE, Math.trunc(Number(query?.pageSize)) || DEFAULT_PAGE_SIZE)
  );
  return { page, pageSize };
}

function emptyRecoveryPage(page: number, pageSize: number) {
  return {
    data: [],
    page,
    pageSize,
    totalItems: 0,
    summary: {
      claims: 0,
      openClaims: 0,
      outstandingRmas: 0,
      expectedCredit: 0,
      receivedCredit: 0,
      postedCredit: 0,
      shortfall: 0,
      shortfallClaims: 0,
      postingExceptions: 0,
      reconciled: true,
    },
    aging: WARRANTY_RMA_AGING_BUCKETS.map((bucket) => ({
      bucket: bucket.key,
      label: bucket.label,
      claims: 0,
      expectedCredit: 0,
      receivedCredit: 0,
      shortfall: 0,
    })),
    vendors: [],
  };
}

/** GET /api/warranty-claims */
export async function get_warrantyClaims(req: any, res: Response): Promise<any> {
  const scope = resolveScope(req, res);
  if (!scope) return;
  const { page, pageSize } = paging(req.query);
  if (scope.empty) {
    return res.json({
      data: [],
      page: 1,
      pageSize,
      totalItems: 0,
      counts: { total: 0, open: 0, reported: 0, withVendor: 0, resolved: 0, closed: 0, rejected: 0 },
    });
  }
  if (!getPgConnected()) {
    return res.status(503).json({ message: 'Warranty claims need the PostgreSQL database.' });
  }
  const opts = {
    branchId: scope.branchId,
    branchScope: scope.branchScope,
    query: req.query?.query,
    status: req.query?.status,
    openOnly: req.query?.open,
    coverageType: req.query?.coverageType,
  };
  try {
    const pageQuery = buildWarrantyClaimPageQuery(opts, page, pageSize);
    const countQuery = buildWarrantyClaimCountQuery(opts);
    const summaryQuery = buildWarrantyClaimSummaryQuery(opts);
    const [rows, count, summary] = await Promise.all([
      pgPool.query(pageQuery.sql, pageQuery.params as any[]),
      pgPool.query(countQuery.sql, countQuery.params as any[]),
      pgPool.query(summaryQuery.sql, summaryQuery.params as any[]),
    ]);
    const s = summary.rows[0] || {};
    return res.json({
      data: rows.rows,
      page,
      pageSize,
      totalItems: Number(count.rows[0]?.count) || 0,
      counts: {
        total: Number(s.total) || 0,
        open: Number(s.open) || 0,
        reported: Number(s.reported) || 0,
        withVendor: Number(s.withVendor) || 0,
        resolved: Number(s.resolved) || 0,
        closed: Number(s.closed) || 0,
        rejected: Number(s.rejected) || 0,
      },
    });
  } catch (error: any) {
    console.error('Error reading warranty claims:', error);
    return res.status(500).json({ message: 'Could not load warranty claims.' });
  }
}

/** GET /api/warranty-claims/recovery — read-only vendor recovery queue. */
export async function get_warrantyRecovery(req: any, res: Response): Promise<any> {
  const scope = resolveScope(req, res);
  if (!scope) return;
  const { page, pageSize } = paging(req.query);
  if (scope.empty) return res.json(emptyRecoveryPage(page, pageSize));
  if (!getPgConnected()) {
    return res.status(503).json({ message: 'Warranty recovery needs the PostgreSQL database.' });
  }
  const opts = {
    branchId: scope.branchId,
    branchScope: scope.branchScope,
    query: req.query?.query,
    coverageType: req.query?.coverageType,
    onlyShortfall: req.query?.onlyShortfall,
    outstandingRma: req.query?.outstandingRma,
  };
  try {
    const pageQuery = buildWarrantyRecoveryPageQuery(opts, page, pageSize);
    const countQuery = buildWarrantyRecoveryCountQuery(opts);
    const summaryQuery = buildWarrantyRecoverySummaryQuery(opts);
    const agingQuery = buildWarrantyRecoveryAgingQuery(opts);
    const vendorQuery = buildWarrantyRecoveryVendorQuery(opts);
    const [rows, count, summary, aging, vendors] = await Promise.all([
      pgPool.query(pageQuery.sql, pageQuery.params as any[]),
      pgPool.query(countQuery.sql, countQuery.params as any[]),
      pgPool.query(summaryQuery.sql, summaryQuery.params as any[]),
      pgPool.query(agingQuery.sql, agingQuery.params as any[]),
      pgPool.query(vendorQuery.sql, vendorQuery.params as any[]),
    ]);
    const s = summary.rows[0] || {};
    const summaryPayload = {
      claims: Number(s.claims) || 0,
      openClaims: Number(s.openClaims) || 0,
      outstandingRmas: Number(s.outstandingRmas) || 0,
      expectedCredit: Number(s.expectedCredit) || 0,
      receivedCredit: Number(s.receivedCredit) || 0,
      postedCredit: Number(s.postedCredit) || 0,
      shortfall: Number(s.shortfall) || 0,
      shortfallClaims: Number(s.shortfallClaims) || 0,
      postingExceptions: Number(s.postingExceptions) || 0,
      reconciled:
        (Number(s.shortfall) || 0) <= 0.005 && (Number(s.postingExceptions) || 0) === 0,
    };
    const agingByKey = new Map<string, any>(aging.rows.map((row: any) => [String(row.bucket), row]));
    return res.json({
      data: rows.rows.map((row: any) => {
        const rmaAgeDays = row.rmaAgeDays === null || row.rmaAgeDays === undefined
          ? null
          : Number(row.rmaAgeDays);
        const postedCredit = Number(row.postedCredit) || 0;
        const shortfall = warrantyCreditShortfall(row.expectedCredit, row.receivedCredit);
        return {
          ...row,
          rmaAgeDays,
          agingBucket: warrantyRmaAgingBucket(rmaAgeDays),
          postedCredit,
          shortfall,
          creditState: warrantyRecoveryState({
            expectedCredit: row.expectedCredit,
            receivedCredit: row.receivedCredit,
            postedCredit,
            journalId: row.journalId,
          }),
        };
      }),
      page,
      pageSize,
      totalItems: Number(count.rows[0]?.count) || 0,
      summary: summaryPayload,
      aging: WARRANTY_RMA_AGING_BUCKETS.map((bucket) => {
        const row = agingByKey.get(bucket.key) || {};
        return {
          bucket: bucket.key,
          label: bucket.label,
          claims: Number(row.claims) || 0,
          expectedCredit: Number(row.expectedCredit) || 0,
          receivedCredit: Number(row.receivedCredit) || 0,
          shortfall: Number(row.shortfall) || 0,
        };
      }),
      vendors: vendors.rows.map((row: any) => ({
        vendorName: row.vendorName || 'Unassigned',
        claims: Number(row.claims) || 0,
        expectedCredit: Number(row.expectedCredit) || 0,
        receivedCredit: Number(row.receivedCredit) || 0,
        postedCredit: Number(row.postedCredit) || 0,
        shortfall: Number(row.shortfall) || 0,
      })),
    });
  } catch (error: any) {
    console.error('Error reading warranty recovery:', error);
    return res.status(500).json({ message: 'Could not load warranty recovery.' });
  }
}

/** GET /api/warranty-claims/:id */
export async function get_warrantyClaim(req: any, res: Response): Promise<any> {
  const scope = resolveScope(req, res);
  if (!scope) return;
  if (!getPgConnected()) return res.status(503).json({ message: 'Warranty claims need the PostgreSQL database.' });
  const id = String(req.params?.id || '').trim();
  if (!id) return res.status(400).json({ message: 'A claim id is required.' });
  const detail = await claimDetail(id);
  if (!detail) return res.status(404).json({ message: 'Warranty claim not found.' });
  if (!allowedForBranch(scope, detail.branchId)) {
    return res.status(403).json({ message: 'Forbidden: this claim is outside your branch scope.' });
  }
  return res.json(detail);
}

/** POST /api/warranty-claims */
export async function post_warrantyClaim(req: any, res: Response): Promise<any> {
  const scope = resolveScope(req, res);
  if (!scope) return;
  if (scope.empty) return res.status(403).json({ message: 'Forbidden: this account has no branch scope.' });
  if (!getPgConnected()) return res.status(503).json({ message: 'Warranty claims need the PostgreSQL database.' });
  const actor = getUserFromReq(req).email || getUserFromReq(req).name || null;
  try {
    const id = await withTransaction(async (client) => {
      const claimId = await createWarrantyClaim(client, {
        ...req.body,
        branchScope: scope.global ? null : scope.branchScope,
        actor,
      });
      const row = (await client.query(WARRANTY_CLAIM_FIND_SQL, [claimId])).rows[0];
      await logAuditEvent(
        req,
        'CREATE_WARRANTY_CLAIM',
        'INVENTORY',
        `Warranty ${row?.coverageType || ''} claim ${row?.claimNo || claimId} opened for serial ${row?.serialNumber || ''}`,
        row?.branchId || undefined,
        client
      );
      return claimId;
    });
    return res.status(201).json(await claimDetail(id));
  } catch (error: any) {
    if (error?.statusCode || error?.status) {
      return res.status(error.statusCode || error.status).json({ message: error.message });
    }
    if (String(error?.code) === '23505') {
      return res.status(409).json({ message: 'This serial already has an open claim for the same warranty.' });
    }
    console.error('Error creating warranty claim:', error);
    return res.status(500).json({ message: 'Could not open the warranty claim.' });
  }
}

/** PATCH /api/warranty-claims/:id/status */
export async function patch_warrantyClaimStatus(req: any, res: Response): Promise<any> {
  const scope = resolveScope(req, res);
  if (!scope) return;
  if (scope.empty) return res.status(403).json({ message: 'Forbidden: this account has no branch scope.' });
  if (!getPgConnected()) return res.status(503).json({ message: 'Warranty claims need the PostgreSQL database.' });
  const id = String(req.params?.id || '').trim();
  if (!id) return res.status(400).json({ message: 'A claim id is required.' });
  const actor = getUserFromReq(req).email || getUserFromReq(req).name || null;
  try {
    const result = await withTransaction(async (client) => {
      const claim = await findClaimForTransition(client, id);
      if (!claim) throw Object.assign(new Error('Warranty claim not found.'), { statusCode: 404 });
      if (!allowedForBranch(scope, claim.branchId)) {
        throw Object.assign(new Error('Forbidden: this claim is outside your branch scope.'), { statusCode: 403 });
      }
      const transition = await transitionWarrantyClaim(client, claim, { ...req.body, actor });
      const stock = transition.stockEffect
        ? `; ${transition.stockEffect.kind} ${transition.stockEffect.serialNumber} stock ${transition.stockEffect.quantityBefore}→${transition.stockEffect.quantityAfter}`
        : '';
      await logAuditEvent(
        req,
        'UPDATE_WARRANTY_CLAIM_STATUS',
        'INVENTORY',
        `Warranty claim ${claim.claimNo} ${claim.status}→${transition.status}${stock}`,
        claim.branchId,
        client
      );
      return transition;
    });
    return res.json({ ...(await claimDetail(id)), transition: result });
  } catch (error: any) {
    if (error?.statusCode || error?.status) {
      return res.status(error.statusCode || error.status).json({ message: error.message });
    }
    console.error('Error updating warranty claim:', error);
    return res.status(500).json({ message: 'Could not update the warranty claim.' });
  }
}
