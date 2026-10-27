# STOCK-2 — the gate: re-measure the global stock read, decide paged vs array

Status: `[ ]` not started · Created 2026-10-27 · Estimate 1 h · **Decision only**
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

- [ ] **1. Re-measure the row width** if the mapping changed since 2026-10-27
  (`columnMappings.ts` → `stock`); otherwise reuse the recorded number and say so.
- [ ] **2. Compute the global read** at the real catalog × branch counts, in
  raw and gzip, and compare it against the ≈ 1 MiB trigger.
- [ ] **3. Weigh the consumer count.** A paged stock read means touching every
  `stock={stock}` consumer in [App.tsx](../../../client/src/App.tsx); list them
  and estimate the migration honestly (Round 4's ASSET-1 is the reference for
  a 19-consumer migration).
- [ ] **4. Record the verdict** in this note: **GO** (with the target payload,
  the screen order and why the client fix is not enough) or **NO-GO** (with the
  measured numbers and the trigger restated).
- [ ] **5. Write it where it is read.** Either way: the worklist watch list and
  [../parked.md](../parked.md) get the verdict and its reason, so the next
  planning pass starts from a decision instead of the same open question.

## Acceptance

- A GO/NO-GO is recorded with the measured payload, the real volumes used, and
  the consumer list — or an explicit "volumes unavailable" if they are still
  unknown, in which case the verdict is NO-GO-for-now and the trigger stays.
- Nothing in `server/` or `client/` changes. If the verdict is GO, the work is
  scoped as its own round, not started here.

## Out of scope

Building the paged stock read, any new endpoint, any screen migration. This item
spends an hour to prevent a multi-day migration from being started on an assumed
number.
