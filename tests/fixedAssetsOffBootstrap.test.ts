/**
 * ASSET-1 — fixed assets leave the bootstrap.
 *
 * Pins the three properties that make the move safe:
 *
 *  1. SQL shape — branch scope, status whitelisting, the indexed text search,
 *     the assigned/available predicates, stable page order and the export caps.
 *  2. Aggregate parity — the server overview runs the SAME shared depreciation
 *     function the registers render, so dashboard/statement/closing totals can
 *     never disagree with the rows. The closing wizard's 15% fallback and
 *     active-asset rule are pinned here too.
 *  3. Wiring — the bootstrap payload no longer carries `assets`, the local
 *     slice endpoint still answers for older bundles, App holds no array, and
 *     every asset screen reads the paged/overview endpoints.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { calculateFixedAssetValues } from '../shared/depreciation';
import {
  FIXED_ASSET_AVAILABLE_MAX,
  FIXED_ASSET_EXPORT_MAX,
  FIXED_ASSET_PAGE_SIZE_DEFAULT,
  FIXED_ASSET_PAGE_SIZE_MAX,
  buildFixedAssetAvailableQuery,
  buildFixedAssetExportQuery,
  buildFixedAssetPageQuery,
  buildFixedAssetWhere,
  normalizeFixedAssetPaging,
} from '../server/src/models/fixedAssets.repo';
import {
  resolveFixedAssetScope,
  summarizeFixedAssetRows,
} from '../server/src/controllers/fixedAssets.controller';

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

/** One asset shaped like the aggregate projection. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    tagNumber: 'AST-1',
    branchId: 'BR-A',
    name: 'Router',
    category: 'IT Equipment',
    status: 'ACTIVE',
    acquisitionCost: 100000,
    depreciationMethod: 'STRAIGHT_LINE',
    depreciationRatePercent: 15,
    accumulatedDepreciation: 0,
    netBookValue: 100000,
    acquisitionDateAD: '2025-01-01',
    placedInServiceDateAD: '2025-01-01',
    ...overrides,
  };
}

describe('fixed-asset SQL builders', () => {
  test('branch scope, status whitelist and the indexed text search reach the WHERE', () => {
    const { whereSql, params } = buildFixedAssetWhere({
      branchScope: ['BR-A', 'BR-B'],
      status: 'active,bogus,disposed',
      query: '  ROUTER ',
    });
    assert.match(whereSql, /branch_id = ANY\(\$1\)/);
    assert.match(whereSql, /LIKE \$2/);
    assert.match(whereSql, /UPPER\(status\) = ANY\(\$3\)/);
    assert.deepEqual(params[0], ['BR-A', 'BR-B']);
    assert.deepEqual(params[2], ['ACTIVE', 'DISPOSED']);
    // The search term is lowercased and wrapped, never interpolated.
    assert.equal(params[1], '%router%');
  });

  test('the session scope decides: a forged branch is 403, an empty set reads nothing', () => {
    const fakeRes = () => {
      const captured: { status?: number; body?: unknown } = {};
      const res: any = {
        status(code: number) {
          captured.status = code;
          return res;
        },
        json(body: unknown) {
          captured.body = body;
          return res;
        },
      };
      return { res, captured };
    };

    // A branch account naming a branch it is not allowed: refused, not filtered.
    const foreign = fakeRes();
    const rejected = resolveFixedAssetScope(
      { user: { role: 'BRANCH_ADMIN', branchId: 'BR-A', allowedBranchIds: [] }, query: { branchId: 'BR-B' } },
      foreign.res
    );
    assert.equal(rejected, null);
    assert.equal(foreign.captured.status, 403);

    // No branch at all means the account's whole allowed set, never every row.
    const scoped = resolveFixedAssetScope(
      { user: { role: 'BRANCH_ADMIN', branchId: 'BR-A', allowedBranchIds: ['BR-B'] }, query: {} },
      fakeRes().res
    );
    assert.deepEqual(scoped, { branchScope: ['BR-A', 'BR-B'] });

    // An account with no allowed branch reads an empty set, not the table.
    const empty = resolveFixedAssetScope(
      { user: { role: 'BRANCH_ADMIN', branchId: '', allowedBranchIds: [] }, query: {} },
      fakeRes().res
    );
    assert.deepEqual(empty, { empty: true });

    // Head-office roles may name any branch; the query is passed through.
    const admin = resolveFixedAssetScope(
      { user: { role: 'HEAD_OFFICE_ADMIN', branchId: 'BR-A' }, query: { branchId: 'BR-B' } },
      fakeRes().res
    );
    assert.deepEqual(admin, { branchId: 'BR-B' });
  });

  test('an empty allowed-branch scope reads nothing (FALSE, not the whole table)', () => {
    const { whereSql, params } = buildFixedAssetWhere({ branchScope: [] });
    assert.match(whereSql, /\bFALSE\b/);
    assert.equal(params.length, 0);
  });

  test('assigned / available / location filters are server predicates', () => {
    const available = buildFixedAssetWhere({ available: true });
    assert.match(available.whereSql, /UPPER\(status\) = 'ACTIVE'/);
    assert.match(available.whereSql, /assigned_type IS NULL/);
    const assigned = buildFixedAssetWhere({
      assigned: true,
      assignedType: 'LOCATION',
      assignedLocationId: 'loc-9',
    });
    assert.match(assigned.whereSql, /assigned_type IS NOT NULL|ASSIGNED_TO_CUSTOMER/);
    assert.match(assigned.whereSql, /assigned_type = \$1/);
    assert.match(assigned.whereSql, /assigned_location_id = \$2/);
    assert.deepEqual(assigned.params, ['LOCATION', 'loc-9']);
  });

  test('a malformed date bound is dropped instead of reaching a DATE cast', () => {
    const { whereSql, params } = buildFixedAssetWhere({
      acquisitionFrom: '06/30/2025',
      acquisitionTo: '2025-06-30',
    });
    assert.doesNotMatch(whereSql, />=/);
    assert.match(whereSql, /<= \$1/);
    assert.deepEqual(params, ['2025-06-30']);
  });

  test('the register page is stable and capped; the date-wise order is invoice-date', () => {
    const created = buildFixedAssetPageQuery({}, 3, 15);
    assert.match(created.sql, /ORDER BY created_at DESC, id DESC/);
    assert.match(created.sql, /LIMIT 15 OFFSET 30/);

    const datewise = buildFixedAssetPageQuery({ sort: 'invoiceDate' }, 2, 50);
    assert.match(datewise.sql, /COALESCE\(purchase_invoice_date_ad, acquisition_date_ad\) DESC/);
    assert.match(datewise.sql, /LIMIT 50 OFFSET 50/);
  });

  test('paging is clamped and echoed; unknown sizes fall back', () => {
    assert.deepEqual(normalizeFixedAssetPaging(undefined, undefined), {
      page: 1,
      pageSize: FIXED_ASSET_PAGE_SIZE_DEFAULT,
    });
    assert.deepEqual(normalizeFixedAssetPaging(-2, 10_000), {
      page: 1,
      pageSize: FIXED_ASSET_PAGE_SIZE_MAX,
    });
  });

  test('exports and the deployment picker read one past their caps to detect truncation', () => {
    assert.match(buildFixedAssetExportQuery({}).sql, new RegExp(`LIMIT ${FIXED_ASSET_EXPORT_MAX + 1}\\b`));
    const available = buildFixedAssetAvailableQuery({});
    assert.match(available.sql, new RegExp(`LIMIT ${FIXED_ASSET_AVAILABLE_MAX + 1}\\b`));
    assert.match(available.sql, /ORDER BY tag_number ASC/);
    assert.match(available.sql, /UPPER\(status\) = 'ACTIVE'/);
  });
});

describe('fixed-asset aggregate parity with the registers', () => {
  const AS_OF = '2026-10-27';

  test('totals equal the shared depreciation rule applied to each row', () => {
    const rows = [
      row({ id: 'a1', acquisitionCost: 120000, depreciationRatePercent: 15 }),
      row({
        id: 'a2',
        branchId: 'BR-B',
        acquisitionCost: 80000,
        depreciationRatePercent: 20,
        depreciationMethod: 'REDUCING_BALANCE',
        acquisitionDateAD: '2024-04-01',
        placedInServiceDateAD: '2024-04-01',
      }),
      row({
        id: 'a3',
        acquisitionCost: 50000,
        depreciationRatePercent: 0,
        depreciationMethod: undefined,
        status: 'DISPOSED',
      }),
    ];
    const overview = summarizeFixedAssetRows(rows, AS_OF);

    const expected = rows.reduce(
      (acc, asset) => {
        const values = calculateFixedAssetValues({
          ...asset,
          acquisitionDateAD: asset.placedInServiceDateAD || asset.acquisitionDateAD,
          asOfDateAD: AS_OF,
        });
        acc.cost += asset.acquisitionCost;
        acc.accum += Number(values.accumulatedDepreciation);
        acc.nbv += Number(values.netBookValue);
        return acc;
      },
      { cost: 0, accum: 0, nbv: 0 }
    );

    assert.equal(overview.total, 3);
    assert.equal(overview.counts.ACTIVE, 2);
    assert.equal(overview.counts.DISPOSED, 1);
    assert.equal(overview.totals.acquisitionCost, expected.cost);
    assert.ok(Math.abs(overview.totals.accumulatedDepreciation - expected.accum) < 0.005);
    assert.ok(Math.abs(overview.totals.netBookValue - expected.nbv) < 0.005);
  });

  test('the closing summary keeps the 15% fallback over every asset and counts active rows', () => {
    const rows = [
      row({ id: 'a1', acquisitionCost: 100000, depreciationRatePercent: 15 }),
      row({ id: 'a2', acquisitionCost: 100000, depreciationRatePercent: 0, depreciationMethod: undefined }),
      row({ id: 'a3', acquisitionCost: 100000, status: 'DISPOSED', depreciationRatePercent: 15 }),
      row({ id: 'a4', acquisitionCost: 100000, status: 'MAINTENANCE', depreciationRatePercent: 15 }),
    ];
    const overview = summarizeFixedAssetRows(rows, AS_OF);
    // Every asset contributes (including disposed/maintenance), missing rate -> 15%.
    assert.equal(overview.closing.annualDepreciation, 60000);
    // Only non-disposed, non-maintenance rows count as active.
    assert.equal(overview.closing.activeCount, 2);
    assert.equal(overview.closing.missingRateCount, 1);
    assert.deepEqual(overview.closing.missingRateTags, ['AST-1']);
  });

  test('the grouped summary strips "(Lot Qty: N)" and sums lots per category', () => {
    const rows = [
      row({ id: 'a1', name: 'Router (Lot Qty: 4)', acquisitionCost: 10000 }),
      row({ id: 'a2', name: 'Router (Lot Qty: 6)', acquisitionCost: 20000 }),
      row({ id: 'a3', name: 'Switch', category: 'Network', acquisitionCost: 5000 }),
    ];
    const overview = summarizeFixedAssetRows(rows, AS_OF, false, true);
    assert.ok(overview.groups);
    const router = overview.groups.find((group) => group.masterName === 'Router');
    assert.ok(router, 'lots collapse onto the master title');
    assert.equal(router.lotCount, 2);
    assert.equal(router.totals.acquisitionCost, 30000);
    assert.equal(overview.groups.length, 2);
    assert.equal(overview.byBranch, undefined);
  });

  test('byBranch totals describe each branch and sum to the overview', () => {
    const rows = [
      row({ id: 'a1', branchId: 'BR-A', acquisitionCost: 10000 }),
      row({ id: 'a2', branchId: 'BR-A', acquisitionCost: 5000 }),
      row({ id: 'a3', branchId: 'BR-B', acquisitionCost: 7000 }),
    ];
    const overview = summarizeFixedAssetRows(rows, AS_OF, true);
    assert.ok(overview.byBranch);
    assert.equal(overview.byBranch.length, 2);
    assert.equal(overview.byBranch.find((b) => b.branchId === 'BR-A')?.total, 2);
    const sum = overview.byBranch.reduce((acc, b) => acc + b.totals.netBookValue, 0);
    assert.ok(Math.abs(sum - overview.totals.netBookValue) < 0.005);
  });
});

describe('fixed assets are off the login payload', () => {
  test('the bootstrap fan-out and payload carry no assets', () => {
    const repo = read('server/src/models/bootstrap.repo.ts');
    assert.doesNotMatch(repo, /fetchTable\(pool,\s*BOOTSTRAP_TABLES\.assets/);
    const payload = repo.slice(repo.indexOf('return {\n    branches,'));
    assert.doesNotMatch(payload.slice(0, 600), /\n\s*assets,/);
  });

  test('the local slice endpoint keeps answering for older bundles', () => {
    const controller = read('server/src/controllers/bootstrap.controller.ts');
    assert.match(controller, /assets: assetRegister/);
    assert.match(controller, /'assets'\]\.includes\(key\)/);
  });

  test('App holds no assets array and no screen takes an assets prop', () => {
    const app = read('client/src/App.tsx');
    assert.doesNotMatch(app, /const \[assets, setAssets\]/);
    assert.doesNotMatch(app, /if \(data\.assets\)/);
    assert.doesNotMatch(app, /\sassets=\{assets\}/);
    assert.match(app, /fixedAssets: 0,/);
  });

  test('the asset screens read the paged / overview endpoints', () => {
    const register = read('client/src/features/finance/FixedAssetRegister.tsx');
    assert.match(register, /api\.getFixedAssetPage\(/);
    assert.match(register, /api\.getFixedAssetOverview\(/);
    assert.match(register, /api\.getFixedAssetExport\(/);
    assert.match(register, /refreshToken/);

    const deployments = read('client/src/features/inventory/AssetDeployments.tsx');
    assert.match(deployments, /api\.getFixedAssetPage\(/);
    assert.match(deployments, /assigned:\s*true/);

    const depreciation = read('client/src/features/finance/DepreciationRegister.tsx');
    assert.match(depreciation, /groupBy:\s*'master'/);
    assert.match(depreciation, /api\.getFixedAssetPage\(/);

    const panel = read('client/src/features/inventory/stockops/AssignAssetPanel.tsx');
    assert.doesNotMatch(panel, /\bassets\.find\(/);
    assert.match(panel, /useAvailableFixedAssets|availableStockAssets/);

    // A capped export is reported, never silently cut at 20,000 rows.
    for (const screen of [register, deployments, depreciation]) {
      assert.match(screen, /exported\.truncated/);
      assert.match(screen, /export was capped at 20,000 rows/);
    }
  });
});
