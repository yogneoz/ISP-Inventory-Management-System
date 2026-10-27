# STOCK-1 — index the stock-array lookups out of the screens

Status: `[~]` implemented 2026-10-27, gates green — awaiting commit · Created 2026-10-27 · Estimate 3–4 h
Round: [Round 5](README.md) · Order: 2 · Depends on READ-1 (warm-up only)

## Problem

`inventory_stock` is the one bootstrap array that can still grow: a branch read
is catalog-sized and a global (`ALL`) read is catalog × branches, with no
fiscal-year scope to age rows out. Every screen that needs a quantity for a
(product, branch) pair looks it up by scanning the whole array:

```ts
const item = stock.find((st) => st.productId === prod.id && st.branchId === b.id);
```

Inside a product × branch loop that is `products × branches × stock`. At the
watch-list model of 2,000 products × 20 branches that is 40,000 stock rows and
**~1.6 billion** predicate evaluations for one pass. It is not a hypothetical:
the pattern is in 8 screens (30 call sites), and two of those passes are not
memoised at all.

- [BranchStockTracking.tsx:45](../../../client/src/features/inventory/BranchStockTracking.tsx#L45-L50)
  builds `productsWithStock` as `products.map` × `activeBranches.reduce` ×
  `stock.find` in the **render body**, so it re-runs on every render — including
  every keystroke in the local search that filters `visibleProducts`. The same
  scan repeats per CSV cell at
  [:78](../../../client/src/features/inventory/BranchStockTracking.tsx#L78) and
  [:98](../../../client/src/features/inventory/BranchStockTracking.tsx#L98).
- [PhysicalStockAudit.tsx:791](../../../client/src/features/inventory/PhysicalStockAudit.tsx#L791-L812)
  builds `consolidatedMatrix` the same way, including two `auditRows.find(...)`
  calls per branch, in a `useMemo` whose dependencies include `auditRows` — so
  one count edit recomputes the entire matrix whether or not the matrix tab is
  on screen. Its `initialAuditRows`
  ([:281](../../../client/src/features/inventory/PhysicalStockAudit.tsx#L281-L286))
  scans the array once per product too.
- The same shape appears in
  [Dashboard.tsx:233](../../../client/src/features/dashboard/Dashboard.tsx#L233)
  and [:558](../../../client/src/features/dashboard/Dashboard.tsx#L558),
  [ExportStock.tsx:135](../../../client/src/features/inventory/ExportStock.tsx#L135-L182),
  [DamagedStockTracking.tsx:223](../../../client/src/features/inventory/DamagedStockTracking.tsx#L223),
  [ReorderStockTracking.tsx](../../../client/src/features/inventory/ReorderStockTracking.tsx)
  and [StockValuation.tsx](../../../client/src/features/inventory/StockValuation.tsx).

Server paging would not fix this: a paged read gives the screen fewer rows, but
the same `find` inside a loop stays quadratic in whatever it does receive, and
20+ screens consume the array today. Fixing the lookups is independent of the
payload decision, and it is what makes
[STOCK-2](STOCK-2.md) answerable.

## Measurement first

Do not write the fix before the baseline is recorded. Build a jsdom probe in the
style of [keepMountedRenderCount.test.ts](../../../tests/keepMountedRenderCount.test.ts)
and [appShellRenderCount.test.ts](../../../tests/appShellRenderCount.test.ts):

- Fixture: 2,000 products × 20 branches = 40,000 stock rows (the watch-list
  model; note in the result that the demo DB holds 18 products / 3 branches /
  32 rows, so this is a scale fixture, not production data).
- Record, before and after: Branch Stock first render with `ALL` selected, one
  keystroke in its search box (the pass that re-runs in the render body), and
  one count edit in Physical Stock Audit (the `consolidatedMatrix` recompute).
- Keep the fixture deterministic and independent of the server: these are pure
  client derivations.

## Steps

- [x] **1. Baseline.** A temporary probe (deleted after the run) built 2,000
  products × 20 branches = 40,000 stock rows and timed the real screen and the
  pure derivations. Numbers below.
- [x] **2. One helper.** [stockIndex.ts](../../../client/src/utils/stockIndex.ts):
  `indexFirstBy`, `indexStockByProductBranch`, `stockRowAt`, `stockOnHandAt`,
  `stockDamagedAt`. Pure, no React, no server; 8 parity tests in
  [stockIndex.test.ts](../../../tests/stockIndex.test.ts) prove it returns what
  `stock.find` returned — including **first-match-wins on duplicates**, the
  NaN-vs-0 split for a row with a missing quantity field, numeric strings from
  SQL, and ids that could collide across a separator.
- [x] **3. The two hot screens.** Branch Stock and Physical Stock Audit build the
  index once (`useMemo` on `stock`), the totals derivation is memoised on
  `[products, activeBranches, stockIndex]`, and the audit matrix no longer runs
  two `auditRows.find` per branch (it indexes the audit rows once too). No prop
  or DOM change; the row/cell values were checked against the old expressions.
- [x] **4. The remaining consumers.** Dashboard (low-stock filter + both
  expandable breakdowns), All Available Stock (`getProductStock` and the
  per-product branch list, now grouped once), Damaged Stock, Reorder Stock and
  Stock Valuation all read through the index. The sweep also caught three
  consumers with the same defect that the plan had not listed: the shell's
  low-stock **badge** ([AppShell.tsx](../../../client/src/components/layout/AppShell.tsx)),
  the **notification center** alert derivation, the stock-movement ledger's
  closing-balance matrix, and App's `handleGroupLowStockPO` (indexed inside the
  handler, not as a new App hook). Single lookups by stock id (`Dashboard`'s
  adjustment modal) and the stock-op panels' per-row reads (bounded by the rows
  on screen) are left alone, as planned.
- [x] **5. After numbers.** Below, from the same probe after the change.
- [x] **6. Gates.** `tsc` clean; `stockIndex` 9/9; shell-render, route-tree and
  KeepMounted probes 26/26 with the helper. Full `npm test`: **1354 tests,
  1352 pass, 0 fail, 2 Windows-only skips** (321 suites) with the docs-count
  gate green at 1354; `check:no-raw-dialogs` (161 client files); production
  build clean; bundle budget OK at **15.8 kB entry / 281.6 kB startup** of
  17/320 (the helper costs 0.1 kB of entry).

## Acceptance

- The probe shows the three measurements improved, with the numbers recorded in
  this note (no claim without a measurement). **Measured above.**
- Every screen renders the same rows, totals and exports as before — the
  existing suites pass without weakening an assertion.
- One helper, not eight private copies; its unit tests cover the key shape, the
  missing pair, and duplicate rows.
- No behaviour or prop change: this item is invisible to a user except in speed.

## Measured (2026-10-27)

Fixture: 2,000 products × 20 branches = 40,000 stock rows, the watch-list model
(the demo DB holds 18 products / 3 branches / 32 rows, so this is a scale
fixture, not production data). Same script before and after; the numbers are one
warm run each.

| Derivation | Before | After | Ratio |
|---|---|---|---|
| Pure product totals (`products × branches × stock.find`) | **35,748 ms** | **47.9 ms** (one Map + 40,000 O(1) lookups) | ≈ 746× |
| Physical Audit consolidated matrix (same scan + two `auditRows.find` per branch) | **35,458 ms** | **52.4 ms** | ≈ 677× |
| Branch Stock **mount** (real component, jsdom) | **34,604 ms** | **338–406 ms** | ≈ 85–102× |
| Branch Stock **re-render** (one toggle click, same 20 rows) | **31,449 ms** | **121–171 ms** | ≈ 184–259× |
| Totals identical before/after | — | `same totals: true` | — |

The shell badge, the notification-center alerts, the ledger's closing matrix and
App's group-low-stock handler carried the same loop shape, so they belong to the
same 746× result rather than to a separate measurement; none of them was mounted
for a before/after screen number.

The residual 338–406 ms mount is jsdom rendering 20 rows × 20 branch cells plus
lucide icons, not the lookup: the derivation itself is the 47.9 ms row. The
audit-matrix figures time the **derivation** (its exact loop shape), not a
mounted screen — the screen renders every audit row unpaginated, so a mount
measurement would be dominated by jsdom DOM work and would not say anything
about the lookup.

## Out of scope

No server read changes, no new endpoint, no prop removal, no paging. Whether the
stock array itself should be paged is [STOCK-2](STOCK-2.md)'s decision, taken
with these numbers in hand.
