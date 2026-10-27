# ASSET-1 — fixed assets leave the bootstrap; the registers page

Status: `[x]` done (2026-10-27) · Created 2026-10-27 · Estimate 3–5 days
Round: [Round 4](README.md) · Order: 1

## Problem

`fixed_assets` is the last whole table of the customer/device class on the
login path:

- `fetchOperationalData` selects every fixed asset for the scope with **no cap
  and no fiscal-year filter** (assets are long-term and persist across years),
  and `GET /api/bootstrap` serialises the whole array as `assets`.
- App keeps it in state and hands the same array to **19 screens** — the
  dashboard, the Fixed Asset Register, Asset Deployments, the Depreciation
  Register, Financial Statements, the FY closing wizard and the stock-operation
  panels.
- Every capitalized unit adds a row (the asset upsert and the CPE lifecycle
  create them) and nothing removes old rows, so the array grows with the
  installed base — 12k units at the modelled 1×, 120k nationally — and never
  ages out by fiscal year.
- The registers compute depreciation in the browser from cost, method, rate and
  date ([depreciation.ts](../../client/src/utils/depreciation.ts)), so the
  dashboard, statements and closing diagnostics need the whole array to total a
  single number.

At 29 aliased columns per row, this is wider than the device rows VOL-4b
removed, and it is the last array whose size follows the country.

## Scope

`fixed_assets` only. Depreciation stays the same rule — it is shared, not
rewritten. The write paths (asset upsert, CPE lifecycle, deploys, unassign,
recalculation) are untouched.

## Steps

- [x] **1. One depreciation rule.** Move `calculateFixedAssetValues` to
  `shared/depreciation.ts`; the client util re-exports it and the server
  aggregates import the same function, so a total can never disagree with the
  rows it summarises.
- [x] **2. Paged reads in one place.** `GET /api/fixed-assets/page` returns
  `{ data, page, pageSize, totalItems }` with branch, status, category,
  assigned-only, text (tag/name/invoice/supplier/assignee/serial) and
  acquisition-date filters; `pageSize` capped at 200, stable order
  (`created_at DESC, id DESC`), and `all=1` is the bounded CSV/report read with
  a `truncated` flag. `GET /api/fixed-assets/overview` returns per-status
  counts and formula totals (cost, accumulated depreciation, NBV) at an
  `asOf` date, `byBranch=1` for the statements, plus the closing fields
  (active count, missing-rate count and first tags, annual depreciation with
  the 15% default). `GET /api/fixed-assets/available` is the deployment
  picker's bounded ACTIVE/unassigned read (cap + truncation flag), and
  `GET /api/fixed-assets/lookup` resolves one asset by id, tag or serial.
- [x] **3. Scope is a server decision.** The session's allowed branches are
  applied in SQL (`branch_id = ANY(...)`) exactly like VOL-3/4a/4b; naming a
  branch outside the account is 403, not a silently filtered read.
- [x] **4. Index the search and the page.** Reuse the existing
  `idx_assets_global_trgm` expression verbatim as `FA_SEARCH_TEXT_SQL`, and add
  a `(branch_id, created_at DESC, id DESC)` btree for the stable page.
- [x] **5. Client registers.** The Fixed Asset Register and Asset Deployments
  page/filter through the server; the Depreciation Register takes its grouped
  summary and its date-wise page from the server instead of grouping the whole
  array in the browser.
- [x] **6. Aggregates.** The dashboard KPI, Financial Statements (per branch,
  current and prior-year as-of dates) and the FY closing diagnostics read the
  overview; their numbers match the old client computation.
- [x] **7. Panels.** The stock-operation host gets `availableStockAssets` from
  `/available` and resolves a ledger item's asset with `/lookup`; no panel
  filters the whole table.
- [x] **8. Remove from bootstrap.** No `assets` in the payload, no
  `fetchTable(...assets)` in the fan-out. `BOOTSTRAP_TABLES.assets` stays so an
  older client's `/api/bootstrap/local?key=assets` still answers (honest `503`
  when the live read fails). App drops its `assets` state and the 19 props;
  unused props go with it.
- [x] **9. Gates and measurement.** `tsc`, targeted suites, full `npm test`,
  convention guards, build, bundle budget; a 1×/10× measurement of the removed
  payload and the new reads.

## Acceptance

- [x] `/api/bootstrap` has no `assets` key and the fan-out does not read
  `fixed_assets`.
- [x] No client screen holds or filters the whole asset table.
- [x] The registers' page, filters and totals come from the server; an asset
  outside page 1 is reachable.
- [x] Dashboard NBV, statement figures and closing diagnostics equal the old
  client computation on the same fixture (depreciation parity —
  `tests/fixedAssetsOffBootstrap.test.ts`).
- [x] A branch account cannot read another branch's assets, by omission or by a
  forged `branchId` (the controller resolves the session scope; a named foreign
  branch is 403, an empty allowed set reads `FALSE`/`[]`).
- [x] A deployment picker sees every assignable asset it can act on (bounded,
  with truncation reported above the cap).
- [x] `GET /api/bootstrap/local?key=assets` still answers for older clients
  (mapped table + honest 503 when the live read fails).
- [x] Exports report truncation instead of silently stopping at a page.

## Result

- Server: `shared/depreciation.ts` is the only rule; `fixedAssets.repo.ts`
  builds the paged/count/export/aggregate/available/lookup SQL;
  `fixedAssets.controller.ts` serves `/page` (incl. `all=1`), `/overview`
  (`byBranch`, `groupBy=master`, `categories`), `/available` and `/lookup`, with
  the demo mirror applying the same scope/filters/paging; the fan-out and
  payload no longer read or carry `fixed_assets`.
- Client: Fixed Asset Register, Asset Deployments and Depreciation Register page
  and filter server-side; Dashboard, Financial Statements and the FY closing
  wizard read `/overview`; StockOperations reads the shared bounded
  `/available` cache; App holds no `assets` state and passes no asset prop.
- Wiring: `RegisterRefreshKey.fixedAssets`; `ASSETS` and `RECALC` bump it; every
  asset render site takes `refreshToken={registerRefresh.fixedAssets}`.
- Exports: all three CSV exports (Fixed Asset Register, Asset Deployments,
  date-wise Depreciation) fetch the bounded `all=1` report and alert when the
  server capped it at 20,000 rows, so a report never stops silently at a page.

## Measurement (2026-10-27, local demo database)

- Table size: 3 rows (demo DB). Measured serialized row width: **902 B**.
  At the modelled 1× (12k assets) the removed payload is **≈ 10.3 MiB**; at the
  national 120k it is **≈ 103 MiB** per login. Payload figure is an estimate
  from the measured width, not a server measurement.
- Median of 7 runs through the real PostgreSQL pool on this machine:
  page 1 (15 rows) **1.97 ms**; date-wise page **1.43 ms**; count **0.72 ms**;
  overview aggregate **0.71 ms**; branch-scoped overview **1.00 ms**;
  available picker **1.09 ms**. The demo table is tiny, so these prove the reads
  work, not national-scale latency; the page order and search are index-backed
  by `idx_fixed_assets_page` / `idx_assets_global_trgm`.
- Gates: `npx tsc --noEmit`; targeted suites (ASSET-1, refresh wiring,
  bootstrap trim, schema parity, DF-12/13, VOL-4b); `npm test`; `npm run
  check:no-inline-sql`; `npm run build`; `npm run check:bundle-budget`.

**Landed** as `3efd446` and pushed to `main`; CI run
[40440447352](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/40440447352)
(`typecheck-and-test`) green in 368 s — every step from the fresh-install proof
to the bundle-budget and `npm audit` gates passed.

## Risks

| Risk | Mitigation |
|---|---|
| Server totals drift from the rows the register computes | One shared depreciation function; a parity fixture compares row values and aggregates |
| A screen still reads the array through a prop | Source guard: no `assets=` bootstrap prop, no `.filter/.find/.map` over an `assets` array in a screen |
| The depreciation register groups the whole table | Its summary comes from the server aggregation; the date-wise view is paged |
| The closing wizard needs every asset | It reads aggregate fields (counts, sums, first missing-rate tags), not rows |
| A panel needs an asset it cannot see | `/lookup` is branch-scoped like the rest; a foreign branch answers 403/404, never another branch's row |
| Demo mode drifts from SQL | The mirror applies the same scope, filters, paging and shared depreciation rule; tested |
