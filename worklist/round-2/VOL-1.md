# VOL-1 — take `transactionLogs` off the bootstrap

Status: `[~]` implemented, all gates green, awaiting commit · Created 2026-10-26 ·
Finished 2026-10-26 · Client + server
Round: [Round 2](README.md) · Order: 2

## Problem

`transactionLogs` was the bootstrap array that grows with every stock movement.
It was scoped only by fiscal year — **no branch filter** — and `fetchTable`
applied no cap, so every login and every full refresh downloaded the whole
year's movement history. At national volume (Nepal-wide, well past 12k
customers) that array is hundreds of thousands of rows.

Only three screens consumed it:

| Consumer | Old use | Delivered read |
|---|---|---|
| [Dashboard](../../client/src/features/dashboard/Dashboard.tsx) | `slice(0, 8)` — eight recent rows | `page=1&pageSize=8`, branch/FY scoped, retryable |
| [AuditTrailReports](../../client/src/features/finance/AuditTrailReports.tsx) | client pagination over the whole array; CSV export | server paging (15/page) + scoped, capped export |
| [StockMovementLedger](../../client/src/features/inventory/StockMovementLedger.tsx) | merged three arrays, then paged | one bounded FY/branch window (5,000 rows) merged once, with a visible cap notice |

## Delivered

### Contract

- `GET /api/transaction-logs` gained `page`, `pageSize`, `all=1`, `dateFromAD`,
  `dateToAD` and `order=asc|desc`, returning
  `{ data, page, pageSize, totalItems, capped }`. A request with none of the
  page parameters still gets the legacy bare array (now capped at
  `TXN_LOG_LEGACY_LIMIT = 2,000`), so no unknown caller breaks.
- [buildTransactionLogQuery / buildTransactionLogCountQuery](../../server/src/models/misc.repo.ts)
  share one WHERE builder; the date upper bound is a half-open `+ 1 day`
  range, so the last day's rows are not dropped.
- Branch scope is a server decision. A non-global account that omits
  `branchId` reads `branch = ANY(allowed branches)`; another branch is `403`;
  `branchId=ALL` is refused by the shared branch middleware (`403`), so a
  branch account cannot widen the read by copying the old client's `ALL`.
- `all=1` is capped at `TXN_LOG_EXPORT_CAP = 5,000` and reports
  `capped: true` with the untruncated `totalItems`. Both consumers surface the
  cap; neither silently exports or renders a truncated page.
- Demo mode (no PostgreSQL) applies the same scope, filters, ordering, offset
  and caps to the in-memory mirror.

### Consumers

- **Dashboard** reads its own eight rows for `selectedBranchId` + fiscal year
  and re-runs on `registerRefresh.transactionLog`, `sseRefreshKey`, branch or
  FY change, with loading / retryable error.
- **Audit Trail → Stock Transactions** is server-paged (15/page), keeps the
  newest-first/oldest-first toggle, resets to page 1 on scope change, clamps a
  stale page, and re-runs on the same refresh key.
- **Stock Movement Ledger** reads one bounded window (`all=1`, 5,000 rows) for
  the selected FY/branch and merges the stock-operation and damage-record
  arrays it still receives. The existing `referenceDocId` / damage
  reconciliation runs once over that window; the UI states the cap. This is
  **option (b)** from the plan: a true server-side three-way union needs
  `stock_operations` and `damage_records` paged/joined server-side first, and
  both still arrive through the bootstrap today. Recorded reason: (a) would
  have doubled this slice's scope and could not be parity-tested without
  changing those reads too. Revisit (a) when `stock_operations` itself leaves
  the bootstrap.
- `transactionLog` is now the eighth paged-register counter in
  [registerRefreshDomains.ts](../../client/src/utils/registerRefreshDomains.ts).
  `STOCK`, `STOCK_OPERATIONS`, `PROCUREMENT`, `SALES`, `SHIPMENTS`,
  `CUSTOMER_DEVICES`, `ASSETS` and `RECALC` bump it; the full-refresh fallback
  bumps it with every other counter.

### Bootstrap

- `transactionLogs` left `fetchOperationalData` and the `/api/bootstrap`
  response; `App.tsx` holds no `transactionLogs` state and passes no such prop.
  The mapping stays in [columnMappings.ts](../../server/src/models/columnMappings.ts)
  only so the server's in-memory operational cache (demo fallback, controller
  appends) still hydrates; it is no longer a bootstrap table.

## Payload measurement

Measured 2026-10-26 with `.tmp-vol1-payload.ts` (throwaway; 20,000-row sample
built from the real column projection, gzipped as one array):

| Volume model | Rows | Raw JSON removed | Gzip removed |
|---|---:|---:|---:|
| 1× (12k customers, ~100k movements/year) | 100,000 | 42.06 MB | 4.23 MB |
| 10× (120k customers, ~1M movements/year) | 1,000,000 | 420.60 MB | 42.33 MB |

Row cost: **441 B raw / 44.4 B gzip**. The current demo bootstrap, served
through the real app with a SUPER_ADMIN token, is **0.95 MB raw / 0.06 MB
gzip** and contains no `transactionLogs` key. At 1× the login payload therefore
drops by roughly 4.2 MB compressed; at 10× by roughly 42 MB. The array is gone
regardless of volume, so the cost no longer scales with movement history.

## Tests

- [transactionLogs.api.test.ts](../../tests/transactionLogs.api.test.ts) — source
  contract (bootstrap/App/screens), page slicing, `order=asc`, inclusive date
  range, branch pinning (`403` for another branch and for `ALL`), global read,
  `all=1` cap envelope, legacy array and `401`.
- [registerRefreshDomains.test.ts](../../tests/registerRefreshDomains.test.ts) —
  every writing domain bumps `transactionLog`; the existing targeted/full burst
  and audience tests still pass.
- `appShellRenderCount`, `appRouteTree`, `bootstrapSlices`,
  `registerAudienceContract`, `misc.repo` and `bootstrapTrim` green.
- `no_inline_sql` guard green (the new SQL lives in `misc.repo.ts`, params bound).

## Gates

- [x] `npx tsc --noEmit` clean.
- [x] Targeted HTTP/repo/source tests green (transactionLogs 7/7, misc.repo +
      registerRefresh + bootstrapTrim 88/88, app shell/route/bootstrap slices
      + audience 36/36, no-inline-sql + global search + customer paging +
      docs counts 42/42).
- [x] Full `npm test`: **1247 tests, 1245 pass, 0 fail, 2 Windows-only
      skips** (the runner's docs-count gate briefly failed on the old 1237
      claims; the counts are updated and re-checked).
- [x] `npm run build` clean; `check:bundle-budget` **313.2 kB** startup /
      **15.7 kB** entry (320 / 16).
- [x] `check:no-inline-sql` and `check:no-raw-dialogs` green.
- [ ] Commit hash — pending; the commit is a separate request.

## Acceptance

- [x] `/api/bootstrap` no longer contains `transactionLogs`.
- [x] Dashboard shows the latest eight rows for the selected branch, with a
      retryable error state.
- [x] Audit Trail pages, filters and exports exactly what it did before; an
      export is either complete or clearly capped.
- [x] Stock Movement Ledger shows one correctly ordered, deduplicated sequence
      over a bounded documented window, with the cap stated.
- [x] SSE stock/serial/sale events still refresh the visible ledger without a
      full bootstrap.
- [x] Payload before/after recorded at 1× and 10×; no client regression.
- [x] Docs updated; commit hash pending.

## Risks

| Risk | Mitigation |
|---|---|
| Merged ledger paging changes ordering or duplicates rows | The existing bridge rule is unchanged and runs once over the bounded window; cap notice states the window |
| CSV export silently truncates | `capped` + notice; on a failed full read the current page is exported and the notice says so |
| A hidden screen still reads the prop | Source-contract test for the bootstrap payload, App and all three screens |
| SSE refresh silently stops updating the ledger | Every writing domain maps to `transactionLog`, pinned by the mapping test |
| Endpoint grows a second unfiltered full read | Legacy branch is capped at 2,000; unknown callers cannot ask for unbounded data |
