# STOCK-2 — the gate: re-measure the global stock read, decide paged vs array

Status: `[x]` decided (2026-10-27) · `9fec135` · CI run 177 success — **NO-GO today, GO-on-evidence** (conditions below) · Created 2026-10-27 · Estimate 1 h · **Decision only**
Round: [Round 5](README.md) · Order: 3 · Depends on STOCK-1 (post-fix numbers)

## Why this exists

The 2026-10-27 watch-list measurement left exactly one trigger open:

> revisit `inventory_stock` when a global (ALL-scope) login's stock array passes
> ≈ 1 MiB gzip (catalog × branches ≈ 2,000 × 20), or when a stock screen needs
> server-side search/paging — and re-measure first.

The model landed **on** the line (≈ 5.46 MiB raw / 1.03 MiB gzip at
2,000 × 20), but those counts are stated assumptions, not recorded volumes —
the demo DB holds 18 products, 3 branches and 32 stock rows. A trigger that
fires only under an assumption is not a decision. [STOCK-1](STOCK-1.md) then
removes the client-side cost that would otherwise be confused with a payload
problem.

**Re-measured 2026-10-27 (this item).** The width was re-derived against the
local demo database through the real `BOOTSTRAP_TABLES.stock` mapping
(`select id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty,
incoming_qty, min_reorder_level from inventory_stock`, serialized and gzipped):
**163.7 B raw / 15.4 B gzip per row** on 28 rows of a 14-product / 2-branch
fixture. That is a *different* fixture from the recorded 143 B / 27 B — shorter
ids raise the raw figure, and the demo's many zero quantities compress better —
so the honest band is **≈ 143–164 B raw and ≈ 15–27 B gzip per row**, and the
global read at 2,000 × 20 straddles the trigger instead of clearly passing it:

| Volume model | Rows | Raw | Gzip |
|---|---|---|---|
| 500 × 20 | 10,000 | 1.56 MiB | **150–264 KiB** |
| 2,000 × 20 | 40,000 | 6.25 MiB | **0.59–1.03 MiB** |
| 5,000 × 20 | 100,000 | 15.61 MiB | **1.47–2.57 MiB** |
| 2,000 × 50 | 100,000 | 15.61 MiB | **1.47–2.57 MiB** |
| 5,000 × 50 | 250,000 | 39.03 MiB | **3.67–6.44 MiB** |

This item therefore produces a **decision**, not a feature: either the paged
stock read is justified and becomes the next round's large item, or the array
stays with its trigger intact and nobody reopens it on a hunch.

## Inputs

- Real catalog size and branch count (the one fact the repo does not hold —
  everything else is measurable locally).
- The post-STOCK-1 probe numbers: does a full-scope stock screen still feel
  slow, or was the quadratic scan the whole story?
- The watch-list row: 143 B raw / 27 B gzip per stock row, measured through the
  real `BOOTSTRAP_TABLES` mapping.

## Steps

- [x] **1. Re-measure the row width.** The mapping is unchanged (8 aliases,
  branch-scoped, no fiscal-year filter); the width was re-derived from the demo
  DB as above. Result: a band, not a point.
- [x] **2. Compute the global read at modelled volumes** — table above. 2,000 × 20
  is 0.59–1.03 MiB gzip, i.e. it may or may not cross ≈ 1 MiB.
- [x] **3. Weigh the consumer count: 32 `stock={stock}` consumers across 32
  distinct screens** ([App.tsx](../../../client/src/App.tsx)), and several need
  more than a page: `physical-stock-audit` mutates every product's count,
  `reorder-stock`/`create-po` aggregate deficits across branches,
  `stock-valuation` and `dashboard` total values, `export-stock` exports the
  whole matrix, and the **shell low-stock badge + notification center** need a
  company-wide count on every render. A paged stock read is therefore an
  ASSET-1-sized round (3–5 days) **plus** a new stock overview/aggregate
  endpoint for the badge, since no page can answer it.
- [x] **4. Verdict: NO-GO today, GO-on-evidence.** Not because the cost is
  small, but because the one fact the decision needs — the real catalogue and
  branch count — is not in this repo, and the model straddles the line.
- [x] **5. Written where it is read:** the [worklist watch list](../../README.md)
  and [../parked.md](../../parked.md).

## Verdict and its firing conditions

**NO-GO now.** Nothing in `server/` or `client/` changes; the array stays.

The round should be opened when **either** condition is met:

1. **Payload:** a real login's `stock` slice measures **≥ 1 MiB gzip** in the
   target deployment (that is ≥ ~2,000 products × 20 branches at the measured
   27 B/row, or ≥ ~3,500 × 20 at 15.4 B/row). How to check: read the bootstrap
   response's gzip size for the `stock` key, or count `products` × `branches`
   active in the deployment and multiply by the band above.
2. **Reach:** a stock screen must search or page beyond what the client filter
   can carry in one snapshot — practically, an ALL-scope catalogue well past
   ~5,000 products, where the client filter's own pass over the array becomes
   the bottleneck again (STOCK-1 removed the quadratic lookups, not the linear
   filter).

If condition 1 is met the item is **stronger than any payload item this project
has removed so far** (shipments 300 kB gzip was the largest); if it is not, the
array is catalog-sized in the common branch-scoped case and should stay.

## Acceptance

- A GO/NO-GO is recorded with the measured payload, the real volumes used, and
  the consumer list — or an explicit "volumes unavailable" if they are still
  unknown, in which case the verdict is NO-GO-for-now and the trigger stays.
  **Done: volumes unavailable (demo DB holds 14 products / 2 branches); the
  verdict is conditional and both conditions are stated above.**
- Nothing in `server/` or `client/` changes. If the verdict is GO, the work is
  scoped as its own round, not started here. **Nothing changed.**

## Recorded

The verdict landed in `9fec135` (2026-10-27): this note, the
[worklist watch list](../../README.md) and [../parked.md](../../parked.md). CI run 177
finished green in 367 s (40480395060) — the docs-only commit still exercised the
fresh-install proof, `tsc`, the full 1354-test suite, both convention guards,
build, bundle budget and `npm audit`. Nothing in `server/` or `client/` changed,
as the acceptance required.

## Out of scope

Building the paged stock read, any new endpoint, any screen migration. This item
spends an hour to prevent a multi-day migration from being started on an assumed
number.
