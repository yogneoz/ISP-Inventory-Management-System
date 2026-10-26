/**
 * VOL-3 — shipments left the bootstrap payload.
 *
 * PROVES (no DB needed):
 *   1. The list builder keeps its legacy no-filter shape, and its new filters
 *      (branch scope, status list, direction, search, warehouse destinations,
 *      pending-only) compile into the WHERE clause in a deterministic order.
 *   2. Paging is bounded and stable: LIMIT/OFFSET params, id tiebreaker, and a
 *      hard cap on pageSize and on the legacy-array limit.
 *   3. Count and summary builders share exactly the page's WHERE clause, so the
 *      register's total and the KPI histogram can never disagree with it.
 *   4. The PG-down mirror applies the same semantics as the SQL (branch scope,
 *      dates, status, direction, pending-only, destination list, search).
 *   5. Route/consumer wiring: the page and overview reads are authenticated,
 *      the bootstrap controller no longer serializes shipments, the register
 *      pages through the API, and the shell/dashboard read the overview.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildShipmentListSql,
  buildShipmentCountSql,
  buildShipmentSummarySql,
  filterShipmentsMirror,
  normalizeShipmentStatuses,
  escapeShipmentSearch,
  SHIPMENT_LIST_SQL,
} from '../server/src/models/shipments.repo';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(relativePath), 'utf8');

describe('shipment list filters', () => {
  test('no options keeps the legacy query exactly', () => {
    assert.deepEqual(buildShipmentListSql(), { sql: SHIPMENT_LIST_SQL, params: [] });
    assert.match(SHIPMENT_LIST_SQL, / FROM shipments ORDER BY created_at DESC$/);
  });

  test('a branch account is pinned to an explicit branch list on both ends', () => {
    const scoped = buildShipmentListSql({ branchScope: ['BR01', 'BR02'] });
    assert.match(
      scoped.sql,
      / WHERE \(source_branch_id = ANY\(\$1\) OR destination_branch_id = ANY\(\$1\)\)/
    );
    assert.deepEqual(scoped.params, [['BR01', 'BR02']]);
  });

  test('an empty branch scope reads nothing instead of everything', () => {
    const scoped = buildShipmentListSql({ branchScope: [] });
    assert.match(scoped.sql, / WHERE FALSE/);
    assert.deepEqual(scoped.params, []);
  });

  test('status accepts a comma list and drops ALL/duplicates', () => {
    assert.deepEqual(normalizeShipmentStatuses('in_transit, RECEIVED,ALL,in_transit'), ['IN_TRANSIT', 'RECEIVED']);
    assert.deepEqual(normalizeShipmentStatuses(['a', ' b ', '']), ['A', 'B']);
    assert.deepEqual(normalizeShipmentStatuses(undefined), []);

    const pending = buildShipmentListSql({ status: 'IN_TRANSIT,DISCREPANCY' });
    assert.match(pending.sql, /WHERE status = ANY\(\$1\)/);
    assert.deepEqual(pending.params, [['IN_TRANSIT', 'DISCREPANCY']]);
    // 'ALL' is the register's default and must not emit a filter at all.
    assert.deepEqual(buildShipmentListSql({ status: 'ALL' }).params, []);
  });

  test('pendingOnly excludes every final status', () => {
    const q = buildShipmentListSql({ pendingOnly: true });
    assert.match(q.sql, /WHERE status NOT IN \('RECEIVED', 'DELIVERED', 'CANCELLED'\)/);
  });

  test('direction narrows to the source or destination end of the branch', () => {
    const outbound = buildShipmentListSql({ branchId: 'BR01', direction: 'CREATED' });
    assert.match(outbound.sql, / AND source_branch_id = \$2/);
    assert.deepEqual(outbound.params, ['BR01', 'BR01']);

    const inbound = buildShipmentListSql({ branchId: 'BR01', direction: 'RECEIVED' });
    assert.match(inbound.sql, / AND destination_branch_id = \$2/);

    // Without a single branch, the direction still means "has a source/dest".
    assert.match(buildShipmentListSql({ direction: 'CREATED' }).sql, /WHERE source_branch_id IS NOT NULL/);
    assert.match(buildShipmentListSql({ direction: 'RECEIVED' }).sql, /WHERE destination_branch_id IS NOT NULL/);
  });

  test('warehouse destinations become an ANY list', () => {
    const q = buildShipmentListSql({ destinationBranchIds: ['WH001', 'WH002'] });
    assert.match(q.sql, /WHERE destination_branch_id = ANY\(\$1\)/);
    assert.deepEqual(q.params, [['WH001', 'WH002']]);
  });

  test('search escapes LIKE wildcards and spans tracking code, branches and items', () => {
    assert.equal(escapeShipmentSearch('50%_off'), '50\\%\\_off');
    const q = buildShipmentListSql({ search: 'ST-100%' });
    assert.match(q.sql, /tracking_code ILIKE \$1 ESCAPE/);
    assert.match(q.sql, /source_branch_name, ''\) ILIKE \$1 ESCAPE/);
    assert.match(q.sql, /destination_branch_name, ''\) ILIKE \$1 ESCAPE/);
    assert.match(q.sql, /items::text, ''\) ILIKE \$1 ESCAPE/);
    assert.deepEqual(q.params, ['%ST-100\\%%']);
  });
});

describe('shipment paging bounds', () => {
  test('a page appends LIMIT/OFFSET and a stable id tiebreaker', () => {
    const q = buildShipmentListSql({ pageSize: 25, offset: 50 });
    assert.match(q.sql, / ORDER BY created_at DESC, id DESC LIMIT \$1 OFFSET \$2$/);
    assert.deepEqual(q.params, [25, 50]);
  });

  test('pageSize and the legacy limit are hard-capped', () => {
    assert.deepEqual(buildShipmentListSql({ pageSize: 5000 }).params, [500]);
    assert.deepEqual(buildShipmentListSql({ limit: 999999 }).params, [5000]);
    // No page/limit keeps the unbounded legacy shape (the FY wizard's year scope).
    assert.deepEqual(buildShipmentListSql({ branchId: 'BR01' }).params, ['BR01']);
  });

  test('count and summary reuse the page WHERE clause', () => {
    const opts = { branchScope: ['BR01'], status: 'IN_TRANSIT', search: 'ST' };
    const page = buildShipmentListSql(opts);
    const count = buildShipmentCountSql(opts);
    const summary = buildShipmentSummarySql(opts);
    const where = page.sql.slice(page.sql.indexOf(' WHERE '), page.sql.indexOf(' ORDER BY'));
    assert.ok(count.sql.endsWith(where), 'count must filter exactly like the page');
    assert.ok(summary.sql.includes(where), 'summary must filter exactly like the page');
    assert.deepEqual(count.params, page.params);
    assert.deepEqual(summary.params, page.params);
    assert.match(count.sql, /^SELECT count\(\*\)::int AS count FROM shipments/);
    assert.match(summary.sql, / GROUP BY status$/);
  });
});

describe('mirror twin (PG-down demo mode)', () => {
  const rows = [
    { id: 'a', trackingCode: 'ST-1', sourceBranchId: 'WH001', destinationBranchId: 'BR01', dispatchDateAD: '2026-10-01', status: 'IN_TRANSIT', items: [{ productName: 'Router' }], createdAt: '2026-10-01T10:00:00Z' },
    { id: 'b', trackingCode: 'ST-2', sourceBranchId: 'BR01', destinationBranchId: 'BR02', dispatchDateAD: '2026-10-05', status: 'RECEIVED', items: [{ productName: 'Switch' }], createdAt: '2026-10-05T10:00:00Z' },
    { id: 'c', trackingCode: 'ST-3', sourceBranchId: 'WH001', destinationBranchId: 'BR02', dispatchDateAD: '2026-09-20', status: 'CANCELLED', items: [{ productName: 'ONT' }], createdAt: '2026-09-20T10:00:00Z' },
  ];

  test('scopes to either end of the branch', () => {
    assert.deepEqual(filterShipmentsMirror(rows, { branchId: 'BR01' }).map((r) => r.id), ['b', 'a']);
    assert.deepEqual(filterShipmentsMirror(rows, { branchScope: [] }).map((r) => r.id), []);
  });

  test('applies dates, status, pending-only, direction and warehouse destinations', () => {
    assert.deepEqual(filterShipmentsMirror(rows, { dateFromAD: '2026-10-01' }).map((r) => r.id), ['b', 'a']);
    assert.deepEqual(filterShipmentsMirror(rows, { status: 'RECEIVED' }).map((r) => r.id), ['b']);
    assert.deepEqual(filterShipmentsMirror(rows, { pendingOnly: true }).map((r) => r.id), ['a']);
    assert.deepEqual(filterShipmentsMirror(rows, { destinationBranchIds: ['BR02'] }).map((r) => r.id), ['b', 'c']);
    assert.deepEqual(filterShipmentsMirror(rows, { branchId: 'BR01', direction: 'CREATED' }).map((r) => r.id), ['b']);
  });

  test('searches tracking code, branch names and item lines', () => {
    assert.deepEqual(filterShipmentsMirror(rows, { search: 'st-3' }).map((r) => r.id), ['c']);
    assert.deepEqual(filterShipmentsMirror(rows, { search: 'router' }).map((r) => r.id), ['a']);
  });

  test('orders newest first with an id tiebreaker', () => {
    const sameDay = [
      { id: 'x', dispatchDateAD: '2026-10-01', status: 'IN_TRANSIT', createdAt: '2026-10-01T00:00:00Z' },
      { id: 'y', dispatchDateAD: '2026-10-01', status: 'IN_TRANSIT', createdAt: '2026-10-01T00:00:00Z' },
    ];
    assert.deepEqual(filterShipmentsMirror(sameDay, {}).map((r) => r.id), ['y', 'x']);
  });
});

describe('VOL-3 wiring', () => {
  test('the page and overview reads are authenticated routes', () => {
    const routes = read('server/src/routes/shipments.routes.ts');
    assert.match(routes, /app\.get\('\/api\/shipments\/page', requireAuth/);
    assert.match(routes, /app\.get\('\/api\/shipments\/overview', requireAuth/);
  });

  test('the bootstrap payload no longer carries shipments', () => {
    const controller = read('server/src/controllers/bootstrap.controller.ts');
    const payload = controller.slice(controller.lastIndexOf('return res.json({'), controller.lastIndexOf('} catch'));
    assert.ok(!/\bshipments\s*:/.test(payload), 'bootstrap must not serialize the transfer history');
    const repo = read('server/src/models/bootstrap.repo.ts');
    assert.ok(
      !/fetchTable\(pool, BOOTSTRAP_TABLES\.shipments/.test(repo),
      'the bootstrap fan-out must not read the shipment ledger'
    );
  });

  test('the register pages its own reads instead of receiving a filtered array', () => {
    const register = read('client/src/features/procurement/ShipmentRegister.tsx');
    assert.match(register, /api\s*\.\s*getShipmentPage\(/);
    assert.match(register, /refreshToken/, 'the register must re-run its page on an SSE/full refresh');
    assert.ok(!/filteredShipments/.test(register), 'the host-filtered array is gone');
    const host = read('client/src/features/procurement/Shipments.tsx');
    assert.ok(!/shipments:\s*Shipment\[\]/.test(host), 'the host no longer takes the whole ledger as a prop');
    assert.match(host, /useShipmentOverview/);
  });

  test('the shell, dashboard and App read the bounded overview', () => {
    assert.match(read('client/src/App.tsx'), /useShipmentOverview\(selectedBranchId\)/);
    assert.match(read('client/src/features/dashboard/Dashboard.tsx'), /useShipmentOverview\(selectedBranchId\)/);
    assert.match(read('client/src/services/shipmentOverviewCache.ts'), /getShipmentOverview\(scope\)/);
  });
});
