# Worklist

Working tracker for the current and future batches. Created 2026-10-26.

## Why this exists

`SESSION_NOTES.md` is the chronological decision log (4,500+ lines). Task
checklists, step order and acceptance details do not belong there: they grow
the file and go stale. This folder holds the working plan; SESSION_NOTES keeps
one short entry per completed item and a link here.

The permanent record stays where a reader expects it: the code and schema,
[architecture-backlog.md](../docs/architecture-backlog.md), the per-domain
audits under `docs/`, [handoff.md](../handoff.md) and SESSION_NOTES. This folder
is the plan, not a second source of truth.

## Layout

- [parked.md](parked.md) — decisions we are not acting on, with the trigger to
  reopen each one.
- [done/](done/README.md) — completed rounds, kept for reference. Never delete.
- **No active round.** Round 9 (the two-sided warranty registers) closed on
  2026-10-29 — [close note](done/2026-10-29-round-9.md), per-slice notes in
  [done/2026-10-29-round-9/](done/2026-10-29-round-9/README.md). Round 8 (the
  bug & loop audit) closed on 2026-10-28
  ([note](done/2026-10-28-round-8.md)).

## Status vocabulary

| Mark | Meaning |
|---|---|
| `[ ]` | not started |
| `[~]` | in progress |
| `[x]` | done (acceptance checked, gates run) |
| `[—]` | parked or deliberately not doing |

A note is done only when its acceptance checklist is ticked, the gates below
have passed, and the commit hash is recorded in the note.

## Working rules

1. One slice per note; one commit per slice, with the ID in the subject
   (`SUM-1: ...`).
2. Update the note as work happens. Tick an acceptance line only after running
   it, not when the code is written.
3. Permanent docs win. Update the code, `docs/` and SESSION_NOTES in the same
   commit; this folder only points at them.
4. Gates before done: `npx tsc --noEmit`, the item's tests, the full `npm test`
   at round close, `check:no-inline-sql`, `check:no-raw-dialogs`, and
   `check:bundle-budget` when client code changed.
5. Do not reopen a parked item without its recorded trigger. Add new evidence
   to [parked.md](parked.md) first.
6. Keep SESSION_NOTES to a short outcome plus a link. If the detail matters,
   it belongs here.

## Session notes (SN-1, done 2026-10-27)

Round 3 executed the split: entries live by year under
[docs/session-notes/](../docs/session-notes/README.md) (2026 for now), newest
first, and the root [SESSION_NOTES.md](../SESSION_NOTES.md) keeps only the
current state plus the index, so it stays short. New entries prepend to the
current year's file; a completed item adds one short entry there, not a
checklist here.

## Active work

**Completed outside a round — all-screen UI/UX sweep (2026-10-30).** The
2026-10-29 audit covered 9 screens and left ~60 unknown; this pass drove all 68
registered routes at 390/1067/1440 px (204 readings) with a temporary CDP
sweep. The first pass flagged 19 readings on 8 screens. Three systemic causes
covered most of them: `PageHeader` truncated titles and descriptions
("Damaged Stock Matri…" at 1440), `StatCard` truncated KPI labels
("TOTAL INVENTORY …" at 1067), and 102 labels sat at `text-[9px]` below the
10 px floor. All three are fixed at the shared component (or the whole source,
for the type floor), plus screen-specific fixes: Fiscal Year Closing step
titles, Consumable Issue's three-column phone grid, the Approvals centre's
missing `<h2>` and mouse-only KPI filters, keyboard-operable permission group
headers, In-App Help nav labels, Company Setup presets/preview, and dashboard
branch/product names. The re-run has zero clipped text, overflow, off-screen or
mouse-only controls and console/HTTP errors. A follow-up raised every click
target to the 24 px floor — enforced on `button` in px so the density tiers
cannot shrink it — and moved the text-link/icon-only actions onto the shared
`linkButton`/`iconButton` tokens: the measured 26/45/60 sub-22 px targets are
0/0/0. Only the phone zoom tier's effective 9.36 px text (12 px source) stays
outside the pass/fail flag. Guarded by
`tests/uiUxSweep20261030.test.ts` (4 tests); report
[docs/ui-ux-audit-2026-10-30.md](../docs/ui-ux-audit-2026-10-30.md). Not
covered there: modals, dark mode, axe/contrast, screen readers, print,
Firefox/Safari. Detail:
[2026 session note](../docs/session-notes/2026.md#-all-screen-uiux-sweep--68-screens-three-widths-2026-10-30).

**Completed outside a round — boot-timing launch retry (2026-10-30).** The
GitHub runner intermittently starts headless Chrome without writing
`DevToolsActivePort`, which reddened the boot-timing gate on runs 214 and
41012427181 while every other step passed. The gate now retries the launch up
to three times, tearing down the failed browser and its profile between
attempts, and still fails with the real cause when all attempts are exhausted.
`tests/bootTimingRetry.test.ts` pins the bounded behavior, and CI
[run 41022526555](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/41022526555)
is green on `2246c20` (attempt 1, so the retry added no wait to a healthy
launch; the record commit `29aa797` is green on attempt 1 as well,
[run 41025819587](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/41025819587)).
Detail:
[2026 session note](../docs/session-notes/2026.md#-boot-timing-launch-retry-2026-10-30).

**Completed outside a round — sales-form consolidation (2026-10-30).** Stock
Operations' Product Sale to Customer was a second counter-sale form that could
only sell quantity-tracked stock; it is retired (panel, route, tab, menu entry,
type and pins) and Create Sales Invoice is the one sale surface, now carrying
the in-card header, branch-scoped picker, readable payment labels and per-line
seller-warranty capture; the print detail and both CSV exports carry its
coverage and AD/BS expiry. Pinned by `tests/salesFormConsolidation.test.ts`,
and CI [run 41012427181](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/41012427181)
is green on `ed6e32c` (attempt 2, after the known Chrome-launch flake). Detail:
[2026 session note](../docs/session-notes/2026.md#-sales-form-consolidation-2026-10-30).

**Completed outside a round — production boot-paint gate (2026-10-29).**
`eff9074` keeps the static splash until the saved screen commits, preloads that
tab and applies the cached bootstrap before paint; CI now runs the
headless-Chrome frame check after the production build, with a seeded demo
database and a 12 s budget. [Run 209](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/40881397737)
is green on every step (7m18s). Detail and measurements:
[2026 session note](../docs/session-notes/2026.md#-production-boot-paint-and-its-ci-gate-2026-10-29).
No round was opened and the remaining UI/UX pass is not started.

**Completed outside a round — warranty register CSV export (2026-10-30).**
Both registers export their whole filtered population through the registers'
existing `?all=1` shape (same WHERE and order as the page read, without
`LIMIT/OFFSET`), so a CSV can no longer be one page of rows. Each file carries
coverage start and expiry in AD **and** BS, the state in the register's words,
the signed days remaining (blank for a retired row), the retirement reason and
CN/DN, source, branch and notes. Pinned by `tests/warrantyExport.test.ts`
(12 tests) and the export-query case in `tests/warranty.repo.test.ts`. Detail:
[2026 session note](../docs/session-notes/2026.md#-warranty-register-csv-export-ad-and-bs-2026-10-30).

**Round 9 closed on 2026-10-29** — the two-sided warranty build. Every slice
(`WTY-1`…`WTY-8`) shipped with its own note and commit; the compact record is
[done/2026-10-29-round-9.md](done/2026-10-29-round-9.md) and the per-slice
notes are archived in
[done/2026-10-29-round-9/](done/2026-10-29-round-9/README.md). The round now
stores the supplier's promise and the customer's promise as separate coverage
periods with exact expiry dates, captures them at purchase/asset/issue/sale/
exchange, and shows them in the Suppliers Warranty and Sellers Warranty
registers. Claims/RMA is recorded as the next module with its trigger, not open
work. **No round is active.** Round 8 closed on 2026-10-28 — see
[done/2026-10-28-round-8.md](done/2026-10-28-round-8.md): the bug & loop audit
([docs/bug-loop-audit-2026-10-27.md](../docs/bug-loop-audit-2026-10-27.md))
shipped AUD-1 (`fbcd013`, run 188), AUD-2 (`6df8ed7`, run 189) and AUD-3
(`053a898`, run 190), plus its API follow-up QTY-1 (`f1c1131`, green under run
192 after the `qs` pin `67e7d47` unblocked the audit step), and the close pass
fixed the two hardening items the audit had recorded as unguarded (AUD-4,
AUD-5). The close pass shipped as `7621a20` (CI run 193). No audit item is
open. Round 7 closed on 2026-10-27 — see
[done/2026-10-27-round-7.md](done/2026-10-27-round-7.md): its one item,
[CDR-2](done/2026-10-27-round-7/CDR-2.md) (`46fefb6`, CI run 184), retired the
`customerDevices` bootstrap slice — the last legacy device read, left by CDR-1
for an older bundle — and moved its mapping to a cache-only one
(`CACHE_ONLY_TABLES`), so the operational cache keeps the device mirror while
the slice key answers 410 Gone; the measurement also showed a branch account
that omitted `branchId` read the whole country through the slice, where the
paged route refuses it. The recorded boundaries for a future round are the
`customers` slice (it needs the same mapping split) and the
`/api/bootstrap/local` branch-guard observation. Round 6 closed on 2026-10-27 —
see
[done/2026-10-27-round-6.md](done/2026-10-27-round-6.md): its one item,
[CDR-1](done/2026-10-27-round-6/CDR-1.md) (`c147d99`, CI run 180), retired the
legacy bare-array `GET /api/customer-devices` route that READ-1 had left for an
older bundle — the route, handler and 2,000-row query are gone, a 404 and a
source guard pin the retirement, and the paged/overview/warranty/exchange reads
are untouched. Round 5 closed on 2026-10-27 — see
[done/2026-10-27-round-5.md](done/2026-10-27-round-5.md): the orphaned
bare-array device read is gone
([READ-1](done/2026-10-27-round-5/READ-1.md), `8cdd09b`), the stock-array
lookups are indexed out of the screens
([STOCK-1](done/2026-10-27-round-5/STOCK-1.md), `9009f9c`; ≈ 746× on the
product × branch derivation) and the paged-vs-array question is decided rather
than built ([STOCK-2](done/2026-10-27-round-5/STOCK-2.md), `9fec135`). It was
deliberately a small round: the payload work is finished. Round 4 closed the
same day — see
[done/2026-10-27-round-4.md](done/2026-10-27-round-4.md): `fixed_assets` left
the bootstrap ([ASSET-1](done/2026-10-27-round-4/ASSET-1.md), `3efd446`) and the
Device Exchange picker moved to the paged device read
([EXCH-1](done/2026-10-27-round-4/EXCH-1.md), `3d7afe4`). Round 3 closed the day
before ([done/2026-10-27-round-3.md](done/2026-10-27-round-3.md)). Do not open a
parked item without its recorded trigger; add the new evidence to
[parked.md](parked.md) first.

Recorded watch items — **measured 2026-10-27** before Round 5 planning, and
`inventory_stock` was re-measured and decided at the
[STOCK-2](done/2026-10-27-round-5/STOCK-2.md) gate, so none is an open question
any more. `damageRecords` and the two return
registers are the only uncapped arrays left; at the recorded volumes the return
registers are ≈ 203 kB gzip combined at 1× (and both already read paged
endpoints — the arrays are only the degraded fallback), damage is ≤ 653 kB gzip
at 1× even if every stock operation were a damage row, and a branch's stock
array is catalog-sized. **No payload item is justified today.**

`inventory_stock` **NO-GO today, GO-on-evidence** (STOCK-2, 2026-10-27): the
re-measured row width is ≈ 143–164 B raw / 15–27 B gzip, so a global ALL-scope
read is 0.59–1.03 MiB gzip at 2,000 × 20 — straddling the ≈ 1 MiB trigger — and
the deployment's real catalogue and branch count are not recorded anywhere in
this repo (the demo DB holds 14 products / 2 branches). Open the round when
**either** a real login's `stock` slice measures ≥ 1 MiB gzip in the target
deployment, **or** an ALL-scope catalogue well past ~5,000 products makes the
client-side filter the bottleneck again. The migration is ASSET-1-sized: 32
screens plus a new stock overview endpoint, because the shell badge and the
notification center need a company-wide count that no page can answer. Full
numbers and limits in
[docs/session-notes/2026.md](../docs/session-notes/2026.md#-round-5-watch-list-measured--none-of-the-remaining-arrays-earns-an-item-2026-10-27).
