/**
 * Fixed-asset read endpoints (ASSET-1).
 *
 * `fixed_assets` left the login payload. The registers page through
 * `/api/fixed-assets/page`, the dashboard/statement/closing aggregates read
 * `/api/fixed-assets/overview`, the deployment pickers read `/available`, and a
 * panel that knows one tag/id/serial resolves it with `/lookup`.
 *
 * Branch scope is a server decision: the controller resolves the session's
 * allowed branches and the SQL applies them (`branch_id = ANY(...)`), exactly
 * like the paged shipment/customer/device reads. A PG-down demo mirror applies
 * the same scope, filters and paging rules over the operational cache.
 */
import type { Response } from 'express';
import { assetRegister, getPgConnected, pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { ApiError } from '../errors/ApiError';
import { getUserFromReq } from '../middleware/auth';
import { allowedBranchScope } from '../middleware/branchScope';
import { logAuditEvent } from '../services/audit.service';
import { periodBounds } from '../services/accounting.service';
import {
  postFixedAssetDepreciationJournal,
  readFixedAssetCostValue,
  readFixedAssetDepreciationPosted,
} from '../services/cpePosting.service';
import { DEPRECIATION_RUN_LOCK_SQL, JOURNAL_FIND_BY_SOURCE_SQL } from '../models/accounting.repo';
import {
  FIXED_ASSET_AVAILABLE_MAX,
  FIXED_ASSET_EXPORT_MAX,
  FIXED_ASSET_DEPRECIATION_CANDIDATES_SQL,
  FIXED_ASSET_SET_DEPRECIATION_SQL,
  buildFixedAssetAggregateQuery,
  buildFixedAssetAvailableQuery,
  buildFixedAssetCountQuery,
  buildFixedAssetExportQuery,
  buildFixedAssetLookupQuery,
  buildFixedAssetPageQuery,
  buildFixedAssetWhere,
  normalizeFixedAssetPaging,
  normalizeFixedAssetStatuses,
  type FixedAssetQueryOptions,
} from '../models/fixedAssets.repo';
import { calculateFixedAssetValues } from '../../../shared/depreciation';
import { roundMoney } from '../utils/money';

interface FixedAssetTotals {
  acquisitionCost: number;
  accumulatedDepreciation: number;
  netBookValue: number;
}

interface FixedAssetClosing {
  activeCount: number;
  annualDepreciation: number;
  missingRateCount: number;
  missingRateTags: string[];
}

/** A depreciation-summary row: one master title inside one category. */
interface FixedAssetGroup {
  key: string;
  masterName: string;
  category: string;
  depreciationMethod: string;
  depreciationRatePercent: number;
  lotCount: number;
  totals: FixedAssetTotals;
}

/** Strip the register's "(Lot Qty: N)" suffix to find the master title. */
function cleanMasterName(name: unknown): string {
  const raw = String(name || '').trim();
  if (!raw) return 'Uncategorized Asset';
  return raw.replace(/\s*\(Lot Qty:\s*\d+\)/i, '').trim() || 'Uncategorized Asset';
}

const ZERO_TOTALS = (): FixedAssetTotals => ({ acquisitionCost: 0, accumulatedDepreciation: 0, netBookValue: 0 });

const todayAD = (): string => new Date().toISOString().slice(0, 10);

export function resolveFixedAssetScope(
  req: any,
  res: Response
): { branchId?: unknown; branchScope?: string[]; empty?: boolean } | null {
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

function fixedAssetQueryOptions(
  req: any,
  scope: { branchId?: unknown; branchScope?: string[] }
): FixedAssetQueryOptions {
  return {
    branchId: scope.branchId,
    branchScope: scope.branchScope,
    status: req.query?.status,
    category: req.query?.category,
    assigned: req.query?.assigned === '1' || req.query?.assigned === 'true',
    assignedType: req.query?.assignedType,
    assignedLocationId: req.query?.assignedLocationId,
    query: req.query?.query,
    acquisitionFrom: req.query?.acquisitionFrom,
    acquisitionTo: req.query?.acquisitionTo,
  };
}

const faNumber = (value: unknown): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

/** The shared rule, with the effective in-service date the registers use. */
function valuesFor(row: any, asOfDateAD: string) {
  return calculateFixedAssetValues({
    acquisitionCost: faNumber(row.acquisitionCost),
    acquisitionDateAD: String(row.placedInServiceDateAD || row.acquisitionDateAD || ''),
    asOfDateAD,
    depreciationMethod: row.depreciationMethod,
    depreciationRatePercent: faNumber(row.depreciationRatePercent),
    accumulatedDepreciation: faNumber(row.accumulatedDepreciation),
    netBookValue: faNumber(row.netBookValue),
  });
}

/**
 * Demo mirror of buildFixedAssetWhere: the same scope, status/category,
 * assigned/available, indexed search columns and in-service date window.
 */
function filterFixedAssetMirror(
  opts: FixedAssetQueryOptions,
  list: readonly any[] = assetRegister
): any[] {
  const statuses = normalizeFixedAssetStatuses(opts.status);
  const statusSet = new Set<string>(statuses);
  const scope = Array.isArray(opts.branchScope) ? new Set<string>(opts.branchScope) : null;
  const q = typeof opts.query === 'string' ? opts.query.trim().toLowerCase() : '';
  const category =
    typeof opts.category === 'string' && opts.category.trim() && opts.category !== 'ALL'
      ? opts.category.trim()
      : '';
  const from =
    typeof opts.acquisitionFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.acquisitionFrom.trim())
      ? opts.acquisitionFrom.trim()
      : '';
  const to =
    typeof opts.acquisitionTo === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.acquisitionTo.trim())
      ? opts.acquisitionTo.trim()
      : '';

  return list
    .filter((asset) => {
      if (scope) {
        if (scope.size === 0 || !scope.has(String(asset.branchId || ''))) return false;
      } else if (opts.branchId && opts.branchId !== 'ALL' && asset.branchId !== opts.branchId) {
        return false;
      }
      if (statusSet.size > 0 && !statusSet.has(String(asset.status || '').toUpperCase())) return false;
      if (category && String(asset.category || '') !== category) return false;
      if (
        (opts.assignedType === 'CUSTOMER' || opts.assignedType === 'LOCATION') &&
        String(asset.assignedType || '').toUpperCase() !== opts.assignedType
      ) {
        return false;
      }
      if (
        typeof opts.assignedLocationId === 'string' &&
        opts.assignedLocationId.trim() &&
        opts.assignedLocationId !== 'ALL' &&
        String(asset.assignedLocationId || '') !== opts.assignedLocationId.trim()
      ) {
        return false;
      }
      if (
        opts.assigned &&
        !(
          asset.assignedType ||
          String(asset.status || '').toUpperCase() === 'ASSIGNED_TO_CUSTOMER' ||
          String(asset.status || '').toUpperCase() === 'ASSIGNED_TO_LOCATION'
        )
      ) {
        return false;
      }
      if (
        opts.available &&
        !(
          String(asset.status || '').toUpperCase() === 'ACTIVE' &&
          !asset.assignedType &&
          !asset.assignedCustomerId &&
          !asset.assignedLocationId
        )
      ) {
        return false;
      }
      const date = String(asset.placedInServiceDateAD || asset.acquisitionDateAD || '').slice(0, 10);
      if (from && (!date || date < from)) return false;
      if (to && (!date || date > to)) return false;
      if (q) {
        const hay = [
          asset.tagNumber,
          asset.name,
          asset.category,
          asset.assignedCustomerName,
          asset.invoiceNo,
          asset.supplierName,
        ]
          .map((value) => String(value || '').toLowerCase())
          .join(' ');
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

/** Counts + formula totals + the FY-closing diagnostics, from one row set. */
function summarizeFixedAssetRows(
  rows: readonly any[],
  asOfDateAD: string,
  byBranch = false,
  groupByMaster = false
) {
  const counts: Record<string, number> = {};
  const groupMap = new Map<string, FixedAssetGroup>();
  const totals = ZERO_TOTALS();
  const closing: FixedAssetClosing = {
    activeCount: 0,
    annualDepreciation: 0,
    missingRateCount: 0,
    missingRateTags: [],
  };
  const branchMap = new Map<string, { branchId: string; total: number; totals: FixedAssetTotals }>();

  for (const row of rows) {
    const status = String(row.status || '').toUpperCase();
    if (status) counts[status] = (counts[status] || 0) + 1;

    const cost = faNumber(row.acquisitionCost);
    const rate = faNumber(row.depreciationRatePercent);
    const values = valuesFor(row, asOfDateAD);
    totals.acquisitionCost += cost;
    totals.accumulatedDepreciation += faNumber(values.accumulatedDepreciation);
    totals.netBookValue += faNumber(values.netBookValue);

    // The closing wizard's journal uses the 15% statutory fallback for a
    // missing rate, over EVERY asset; its precondition only looks at active
    // (non-disposed, non-maintenance) rows. Preserve both rules exactly.
    closing.annualDepreciation += cost * ((rate || 15) / 100);
    if (status !== 'DISPOSED' && status !== 'MAINTENANCE') {
      closing.activeCount += 1;
      if (!rate || rate <= 0 || !row.depreciationMethod) {
        closing.missingRateCount += 1;
        if (closing.missingRateTags.length < 3) {
          closing.missingRateTags.push(String(row.tagNumber || row.id || ''));
        }
      }
    }

    if (groupByMaster) {
      const masterName = cleanMasterName(row.name);
      const category = String(row.category || '');
      const key = `${category}___${masterName}`;
      let group = groupMap.get(key);
      if (!group) {
        group = {
          key,
          masterName,
          category,
          depreciationMethod: String(row.depreciationMethod || 'STRAIGHT_LINE'),
          depreciationRatePercent: rate,
          lotCount: 0,
          totals: ZERO_TOTALS(),
        };
        groupMap.set(key, group);
      }
      group.lotCount += 1;
      group.totals.acquisitionCost += cost;
      group.totals.accumulatedDepreciation += faNumber(values.accumulatedDepreciation);
      group.totals.netBookValue += faNumber(values.netBookValue);
    }

    if (byBranch) {
      const branchId = String(row.branchId || '');
      let entry = branchMap.get(branchId);
      if (!entry) {
        entry = { branchId, total: 0, totals: ZERO_TOTALS() };
        branchMap.set(branchId, entry);
      }
      entry.total += 1;
      entry.totals.acquisitionCost += cost;
      entry.totals.accumulatedDepreciation += faNumber(values.accumulatedDepreciation);
      entry.totals.netBookValue += faNumber(values.netBookValue);
    }
  }

  return {
    total: rows.length,
    counts,
    totals,
    closing,
    ...(byBranch ? { byBranch: [...branchMap.values()] } : {}),
    ...(groupByMaster ? { groups: [...groupMap.values()] } : {}),
  };
}

/** ASSET-1: the register's paged read; `all=1` is the bounded export. */
export async function get_fixedAssetsPage(req: any, res: Response): Promise<any> {
  const scope = resolveFixedAssetScope(req, res);
  if (!scope) return;
  const opts = fixedAssetQueryOptions(req, scope);
  const exportAll = req.query?.all === '1' || req.query?.all === 'true';
  const paging = normalizeFixedAssetPaging(req.query?.page, req.query?.pageSize);

  if (scope.empty) {
    return res.json({ data: [], page: 1, pageSize: paging.pageSize, totalItems: 0 });
  }

  if (getPgConnected()) {
    try {
      const list = exportAll ? buildFixedAssetExportQuery(opts) : buildFixedAssetPageQuery(opts, paging.page, paging.pageSize);
      const count = buildFixedAssetCountQuery(opts);
      const [rows, totals] = await Promise.all([
        pgPool.query(list.sql, list.params as any[]),
        pgPool.query(count.sql, count.params as any[]),
      ]);
      let data = rows.rows;
      const truncated = exportAll && data.length > FIXED_ASSET_EXPORT_MAX;
      if (truncated) data = data.slice(0, FIXED_ASSET_EXPORT_MAX);
      res.json({
        data,
        page: exportAll ? 1 : paging.page,
        pageSize: exportAll ? data.length : paging.pageSize,
        totalItems: Number(totals.rows[0]?.count) || 0,
        ...(exportAll ? { truncated } : {}),
      });
      return;
    } catch (err: any) {
      console.error('Error paging fixed assets from DB:', err);
      return res.status(500).json({ message: 'Could not load the fixed-asset register from the database. Reload to retry.' });
    }
  }

  const matching = filterFixedAssetMirror(opts);
  if (exportAll) {
    const truncated = matching.length > FIXED_ASSET_EXPORT_MAX;
    const data = truncated ? matching.slice(0, FIXED_ASSET_EXPORT_MAX) : matching;
    return res.json({ data, page: 1, pageSize: data.length, totalItems: matching.length, truncated });
  }
  const offset = (paging.page - 1) * paging.pageSize;
  res.json({
    data: matching.slice(offset, offset + paging.pageSize),
    page: paging.page,
    pageSize: paging.pageSize,
    totalItems: matching.length,
  });
}

/**
 * Exact status counts plus formula totals. The register KPIs, the dashboard,
 * Financial Statements (`byBranch=1`) and the FY closing diagnostics read it.
 */
export async function get_fixedAssetsOverview(req: any, res: Response): Promise<any> {
  const scope = resolveFixedAssetScope(req, res);
  if (!scope) return;
  const opts = { ...fixedAssetQueryOptions(req, scope), status: undefined };
  const asOfDateAD =
    typeof req.query?.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf.trim())
      ? req.query.asOf.trim()
      : todayAD();
  const byBranch = req.query?.byBranch === '1' || req.query?.byBranch === 'true';
  const groupByMaster = req.query?.groupBy === 'master';
  const withCategories = req.query?.categories === '1' || req.query?.categories === 'true';

  if (scope.empty) {
    return res.json({
      total: 0,
      counts: {},
      totals: ZERO_TOTALS(),
      closing: { activeCount: 0, annualDepreciation: 0, missingRateCount: 0, missingRateTags: [] },
      ...(byBranch ? { byBranch: [] } : {}),
    });
  }

  if (getPgConnected()) {
    try {
      const aggregate = buildFixedAssetAggregateQuery(opts);
      const categoryAggregate = withCategories
        ? buildFixedAssetAggregateQuery({ ...opts, category: undefined })
        : null;
      const [r, categoryRows] = await Promise.all([
        pgPool.query(aggregate.sql, aggregate.params as any[]),
        categoryAggregate
          ? pgPool.query(categoryAggregate.sql, categoryAggregate.params as any[])
          : Promise.resolve({ rows: [] as any[] }),
      ]);
      res.json({
        ...summarizeFixedAssetRows(r.rows, asOfDateAD, byBranch, groupByMaster),
        ...(withCategories
          ? { categories: [...new Set(categoryRows.rows.map((row: any) => String(row.category || '')).filter(Boolean))].sort() }
          : {}),
      });
      return;
    } catch (err: any) {
      console.error('Error aggregating fixed assets from DB:', err);
      return res.status(500).json({ message: 'Could not summarise the fixed-asset register. Reload to retry.' });
    }
  }

  const mirrorRows = filterFixedAssetMirror(opts);
  res.json({
    ...summarizeFixedAssetRows(mirrorRows, asOfDateAD, byBranch, groupByMaster),
    ...(withCategories
      ? {
          categories: [
            ...new Set(
              filterFixedAssetMirror({ ...opts, category: undefined }).map((row) => String(row.category || ''))
            ),
          ]
            .filter(Boolean)
            .sort(),
        }
      : {}),
  });
}

/** Deployment pickers: the branch's ACTIVE, unassigned units (bounded). */
export async function get_fixedAssetsAvailable(req: any, res: Response): Promise<any> {
  const scope = resolveFixedAssetScope(req, res);
  if (!scope) return;
  const opts = fixedAssetQueryOptions(req, scope);
  if (scope.empty) return res.json({ data: [], truncated: false });

  if (getPgConnected()) {
    try {
      const query = buildFixedAssetAvailableQuery(opts);
      const r = await pgPool.query(query.sql, query.params as any[]);
      const truncated = r.rows.length > FIXED_ASSET_AVAILABLE_MAX;
      res.json({ data: truncated ? r.rows.slice(0, FIXED_ASSET_AVAILABLE_MAX) : r.rows, truncated });
      return;
    } catch (err: any) {
      console.error('Error reading available fixed assets from DB:', err);
      return res.status(500).json({ message: 'Could not load the assignable fixed assets. Reload to retry.' });
    }
  }

  const matching = filterFixedAssetMirror({ ...opts, available: true }).sort((a, b) =>
    String(a.tagNumber || '').localeCompare(String(b.tagNumber || '')) || String(a.id).localeCompare(String(b.id))
  );
  const truncated = matching.length > FIXED_ASSET_AVAILABLE_MAX;
  res.json({ data: truncated ? matching.slice(0, FIXED_ASSET_AVAILABLE_MAX) : matching, truncated });
}

/** Resolve one asset by id, tag number or device serial, under the branch scope. */
export async function get_fixedAssetsLookup(req: any, res: Response): Promise<any> {
  const scope = resolveFixedAssetScope(req, res);
  if (!scope) return;
  const value = { id: req.query?.id, tagNumber: req.query?.tag ?? req.query?.tagNumber, serial: req.query?.serial };
  const hasValue = [value.id, value.tagNumber, value.serial].some(
    (candidate) => typeof candidate === 'string' && candidate.trim()
  );
  if (!hasValue) {
    return res.status(400).json({ message: 'Name an asset id, tag number or device serial.' });
  }
  if (scope.empty) return res.status(404).json({ message: 'Fixed asset not found.' });

  if (getPgConnected()) {
    try {
      const query = buildFixedAssetLookupQuery(fixedAssetQueryOptions(req, scope), value);
      const r = await pgPool.query(query.sql, query.params as any[]);
      if (!r.rows.length) return res.status(404).json({ message: 'Fixed asset not found.' });
      return res.json(r.rows[0]);
    } catch (err: any) {
      console.error('Error looking up a fixed asset from DB:', err);
      return res.status(500).json({ message: 'Could not look up the fixed asset. Retry shortly.' });
    }
  }

  const row = filterFixedAssetMirror(fixedAssetQueryOptions(req, scope)).find((asset) => {
    const matchesId = value.id && String(asset.id) === String(value.id).trim();
    const matchesTag = value.tagNumber && String(asset.tagNumber) === String(value.tagNumber).trim();
    const matchesSerial = value.serial && String(asset.deviceSerial) === String(value.serial).trim();
    return Boolean(matchesId || matchesTag || matchesSerial);
  });
  if (!row) return res.status(404).json({ message: 'Fixed asset not found.' });
  res.json(row);
}

/**
 * POST /api/fixed-assets/depreciation — post one branch's depreciation for a
 * calendar month.
 *
 * The run is idempotent per (asset, month): each asset's journal is keyed by
 * `<assetId>:<periodKey>`, a repeat run for a month that is already posted is
 * refused before anything writes, and the whole run holds a per-branch/period
 * advisory lock so two concurrent requests cannot both pass the check. The
 * charge is the method's cumulative depreciation at month end minus what the
 * ledger has already posted for that asset, so a skipped month is caught up
 * without ever double-charging one.
 */
export async function postFixedAssetDepreciation(req: any, res: Response): Promise<any> {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
  const branchId = typeof req.body?.branchId === 'string' ? req.body.branchId.trim() : '';
  if (!branchId || branchId === 'ALL') {
    return res.status(400).json({ message: 'Name the branch whose depreciation should run.' });
  }
  const scope = allowedBranchScope(req.user);
  if (scope && !scope.has(branchId)) {
    return res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
  }
  const rawPeriod =
    typeof req.body?.periodKey === 'string' && req.body.periodKey.trim()
      ? req.body.periodKey.trim()
      : typeof req.body?.dateAD === 'string'
        ? req.body.dateAD.trim().slice(0, 7)
        : '';
  if (!rawPeriod) {
    return res.status(400).json({ message: 'Name the period to depreciate as YYYY-MM.' });
  }
  const { periodKey, endDateAD } = periodBounds(rawPeriod);
  const actor = getUserFromReq(req)?.email || null;

  const run = await withTransaction(async (client) => {
    // Serialize the same branch+month across requests before the duplicate
    // check, so the check cannot be raced by a concurrent run.
    await client.query(DEPRECIATION_RUN_LOCK_SQL, [`fixed-asset-depreciation:${branchId}:${periodKey}`]);

    const candidates = (
      await client.query(FIXED_ASSET_DEPRECIATION_CANDIDATES_SQL, [branchId, endDateAD])
    ).rows as any[];

    for (const asset of candidates) {
      const posted = (
        await client.query(JOURNAL_FIND_BY_SOURCE_SQL, [
          'FIXED_ASSET_DEPRECIATION',
          `${asset.id}:${periodKey}`,
        ])
      ).rows[0];
      if (posted) {
        throw new ApiError(
          409,
          `Depreciation for ${periodKey} has already been posted for ${branchId} (journal ${posted.journalNo}). Re-running the same month would double-post.`
        );
      }
    }

    const postedJournals: Array<{ assetId: string; tagNumber: string; amount: number; journalNo: string }> = [];
    const updates: Array<{ assetId: string; accumulated: number; netBookValue: number }> = [];
    const skipped: Array<{ assetId: string; tagNumber: string; reason: string }> = [];

    for (const asset of candidates) {
      const cost = await readFixedAssetCostValue(client, String(asset.id));
      if (cost < 0.005) {
        skipped.push({
          assetId: String(asset.id),
          tagNumber: String(asset.tagNumber || ''),
          reason: 'no posted acquisition cost in the ledger',
        });
        continue;
      }
      const values = calculateFixedAssetValues({
        acquisitionCost: cost,
        acquisitionDateAD: String(asset.inServiceDateAD || '').slice(0, 10),
        asOfDateAD: endDateAD,
        depreciationMethod: asset.depreciationMethod,
        depreciationRatePercent: faNumber(asset.depreciationRatePercent),
        accumulatedDepreciation: 0,
        netBookValue: cost,
      });
      const target = roundMoney(Math.min(Math.max(faNumber(values.accumulatedDepreciation), 0), cost));
      const alreadyPosted = await readFixedAssetDepreciationPosted(client, String(asset.id));
      const amount = roundMoney(target - alreadyPosted);
      if (amount < 0.005) continue;

      const journal = await postFixedAssetDepreciationJournal(client, {
        assetId: String(asset.id),
        tagNumber: String(asset.tagNumber || ''),
        branchId,
        periodKey,
        dateAD: endDateAD,
        amount,
        actor,
      });
      if (!journal) continue;
      const accumulated = roundMoney(alreadyPosted + amount);
      const netBookValue = roundMoney(cost - accumulated);
      await client.query(FIXED_ASSET_SET_DEPRECIATION_SQL, [accumulated, netBookValue, asset.id]);
      postedJournals.push({
        assetId: String(asset.id),
        tagNumber: String(asset.tagNumber || ''),
        amount,
        journalNo: journal.journalNo,
      });
      updates.push({ assetId: String(asset.id), accumulated, netBookValue });
    }

    const total = roundMoney(postedJournals.reduce((sum, entry) => sum + entry.amount, 0));
    if (postedJournals.length > 0) {
      await logAuditEvent(
        req,
        'RUN_FIXED_ASSET_DEPRECIATION',
        'FIXED_ASSETS',
        `Posted depreciation for ${periodKey} at ${branchId}: ${postedJournals.length} asset(s), NPR ${total.toFixed(2)} total.`,
        branchId,
        client
      );
    }
    return { postedJournals, updates, skipped, total };
  });

  // The register reads its cached columns; keep the mirror equal to the ledger
  // immediately instead of waiting for the next cache refresh.
  for (const update of run.updates) {
    const row = assetRegister.find((asset) => String(asset.id) === update.assetId);
    if (row) {
      row.accumulatedDepreciation = update.accumulated;
      row.netBookValue = update.netBookValue;
    }
  }

  return res.status(run.postedJournals.length > 0 ? 201 : 200).json({
    periodKey,
    branchId,
    journalDateAD: endDateAD,
    posted: run.postedJournals,
    skipped: run.skipped,
    total: run.total,
    message:
      run.postedJournals.length > 0
        ? `Posted depreciation of NPR ${run.total.toFixed(2)} for ${run.postedJournals.length} asset(s) in ${periodKey}.`
        : run.skipped.length > 0
          ? `Nothing was posted for ${periodKey}: ${run.skipped.length} asset(s) are not capitalised in the ledger.`
          : `No further depreciation is due for ${periodKey}.`,
  });
}

// Re-exported for tests that pin the shared WHERE and the aggregate rules
// without hitting a database.
export { buildFixedAssetWhere, summarizeFixedAssetRows };
