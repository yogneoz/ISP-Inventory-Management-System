# STOCK-1 — index the stock-array lookups out of the screens

Status: `[ ]` not started · Created 2026-10-27 · Estimate 3–4 h
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

- [ ] **1. Baseline.** Add the probe, record the three numbers in this note.
- [ ] **2. One helper.** Add `indexStockByProductBranch(rows)` (and the audit-row
  equivalent) returning a `Map` keyed by product + branch, in a shared utility
  under [client/src/utils/](../../../client/src/utils/). Pure, unit-tested,
  no React, no server.
- [ ] **3. The two hot screens.** Branch Stock and Physical Stock Audit use the
  index and memoise the derivations that currently run in the render body. No
  prop or DOM changes; identical rows and totals.
- [ ] **4. The remaining consumers.** Dashboard, All Available Stock, Damaged
  Stock, Reorder Stock and Stock Valuation move to the index where they scan per
  product × branch. Leave single lookups (`stock.find(s => s.id === id)`) alone —
  they are not the problem and rewriting them adds risk.
- [ ] **5. After numbers.** Re-run the probe, record them next to the baseline,
  and state the ratio.
- [ ] **6. Gates.** `tsc`; the physical-audit, branch-stock, dashboard and
  register suites; `check:no-raw-dialogs`; build and bundle budget.

## Acceptance

- The probe shows the three measurements improved, with the numbers recorded in
  this note (no claim without a measurement).
- Every screen renders the same rows, totals and exports as before — the
  existing suites pass without weakening an assertion.
- One helper, not eight private copies; its unit tests cover the key shape, the
  missing pair, and duplicate rows.
- No behaviour or prop change: this item is invisible to a user except in speed.

## Out of scope

No server read changes, no new endpoint, no prop removal, no paging. Whether the
stock array itself should be paged is [STOCK-2](STOCK-2.md)'s decision, taken
with these numbers in hand.
