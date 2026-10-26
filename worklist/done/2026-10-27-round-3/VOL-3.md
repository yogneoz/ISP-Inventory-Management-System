# VOL-3 — shipments leave the bootstrap; the register pages

Status: `[x]` done (`acafd52`) · Created 2026-10-26 · Estimate 2–4 days
Round: [Round 3](README.md) · Order: 2 · Depends on BOOT-1

## Problem

`shipments` was the last whole-ledger array left in `GET /api/bootstrap`
alongside customers and customer devices. It grows with every transfer the
network has ever dispatched, and at the modelled national volume it would make
the login payload grow without bound for a register that never needed the whole
history at once:

- The register filtered the entire fiscal year in the browser
  ([Shipments.tsx](../../../client/src/features/procurement/Shipments.tsx)), then
  paginated the filtered copy client-side.
- The shell badges, header count, dashboard KPI, notification center and both
  receive lanes derived their numbers from that same array.
- `GET /api/shipments` already existed for the FY closing wizard, but it read
  every matching row and then filtered branch scope in JavaScript — a branch
  account could not *see* other rows, but the server still transferred them.

## Scope

Shipments only. Customers and customer devices stay for VOL-4a/4b.

## Steps

- [x] **1. Paged read.** `GET /api/shipments/page` returns
      `{ data, page, pageSize, totalItems }`; `pageSize` defaults to 25 and is
      capped at 200, with a stable `(created_at, id)` order so a page boundary
      cannot slide between requests. Filters: branch (either end), direction
      (`CREATED`/`RECEIVED`), status list, free text (tracking code, branch
      names, item lines), dispatch-date range and destination-branch list
      (warehouse lane).
- [x] **2. Scoped overview.** `GET /api/shipments/overview` returns exact
      per-status `counts`, the total, every still-in-flight row (bounded at
      1,000, with `pendingCapped`) and the latest 200 rows. The shell badges,
      header count, dashboard KPI, notification center and receive lanes read
      this one small snapshot.
- [x] **3. Server-side branch scope.** Scope is resolved from the session and
      applied in SQL (`source_branch_id = ANY(...) OR destination_branch_id =
      ANY(...)`); naming a branch outside the account is a 403 instead of a
      silently-filtered read. This replaces the post-read JavaScript filter in
      the old `get_shipments`.
- [x] **4. Bounded legacy read.** `GET /api/shipments` keeps its bare-array
      contract (the FY closing wizard's year scope) but caps at 2,000 rows and
      accepts the same filters.
- [x] **5. Client store.** `shipmentOverviewStore.ts` (React-free, tested) +
      `shipmentOverviewCache.ts` (subscription hook) share one snapshot per
      branch scope with a single in-flight request; scope changes discard the
      previous branch's late answer. `App` derives its bounded `shipments`
      window from it, so the badge/notification/receive code keeps its shape
      while the payload is bounded.
- [x] **6. Register pages.** `ShipmentRegister` fetches its own page with the
      existing filter card, uses server totals and the shared exact counts for
      the KPI cards, exports a bounded snapshot of the current filters, and
      re-runs on the new `shipments` register-refresh key (SSE `SHIPMENTS` /
      `APPROVALS` and every full refresh).
- [x] **7. Remove from bootstrap.** No `shipments` in the payload, no
      `fetchTable(...shipments)` in the fan-out, optional in `BootstrapData`.
      The `BOOTSTRAP_TABLES` mapping stays, so an older client's
      `/api/bootstrap/local?key=shipments` still answers.
- [x] **8. Gates.** `tsc`, targeted suites, full `npm test`, guards, build and
      bundle budget; docs counts updated.

## Measurement (2026-10-26)

A throwaway benchmark (`.tmp-vol3-bench.ts`, removed after the run) built a
TEMP table shaped like `shipments` with a four-line item document per transfer,
then read it the way the old bootstrap fan-out did (every row, every column,
`ORDER BY created_at DESC`) and the way the new reads do:

| Volume | Rows | Old payload (JSON) | Old payload (gzip) | Old read | Page read (25 rows) | Overview read |
|---|---:|---:|---:|---:|---:|---:|
| 1× | 20,000 | **17.2 MB** | **0.31 MB** | **781 ms** | 129 ms | 127 ms |
| 10× | 200,000 | **173.0 MB** | **3.12 MB** | **5,035 ms** | 439 ms | 1,159 ms |

The transfer history is extremely regular, so it gzips to 16 bytes/row — but the
server still had to materialise and serialize all 173 MB at 10× on **every
login**, and the client still had to hold and filter 200,000 objects. The new
path transfers at most 200 register rows, plus one overview of ≤1,000 in-flight
rows and the latest 200. The benchmark table is unindexed, so the page/overview
times are an upper bound for the real schema (`idx_shipments_global_trgm` and the
created-at ordering already exist).

The full-bootstrap fan-out is now **17 queries** (18 after BOOT-1, 23 at the
start of Round 2), and the two new reads run only on the screens that need them.

## Acceptance

- [x] `/api/bootstrap` has no `shipments` key and the fan-out does not read it.
- [x] The register pages through `/api/shipments/page`; no page ever transfers
      more than 200 rows (`pageSize` cap proven over HTTP).
- [x] Dashboard/shell counts come from `/api/shipments/overview`.
- [x] A branch account sees only its branches, and a foreign `branchId` is 403.
- [x] The FY closing wizard keeps working on the bounded legacy read.
- [x] PG-down demo mode applies the same filters as SQL (mirror twin tested).

## Gates (2026-10-26)

- `npx tsc --noEmit` clean.
- Targeted page/overview/store/register/bootstrap suites **109/109 pass**.
- Full `npm test`: **1286 tests, 1284 pass, 0 fail, 2 Windows-only skips**;
  docs-count gate matched 1286.
- `check:no-inline-sql` and `check:no-raw-dialogs` green.
- `npm run build` clean; `check:bundle-budget` **279.9 kB / 15.8 kB** (320 / 17).

## Risks

| Risk | Mitigation |
|---|---|
| A hidden consumer needed the full history | Every consumer listed above is on the overview or a page; the legacy array still serves the wizard |
| Branch accounts lose multi-branch readability | The overview scopes to the header branch; the app-level branch guard already required a branch filter |
| Receive lanes show a bounded history window | Both lanes include every in-flight row; the panel says so and points at the paged register |
| A page boundary duplicates/skips rows | Stable `(created_at, id)` order whenever a page/limit is requested |
| Search on item JSON is slow at 10× | Bounded by status/date/branch first; `idx_shipments_global_trgm` already backs the global search on the same column |

## Close-out

Committed as `acafd52` ("Page the transfer register off the bootstrap") and
pushed to `main`. [CI run 40288667413](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/40288667413)
(`typecheck-and-test`) passed in 327 s; the note and run record landed in
`d085efe` ([run 40289472496](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/40289472496), 328 s).
