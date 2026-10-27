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
- [round-7/](round-7/README.md) — the active round (created 2026-10-27):
  CDR-2 retires the last legacy device read, the `customerDevices` bootstrap
  slice, and splits its mapping so the operational cache keeps the mirror.
  Round 6 closed and is archived under [done/](done/README.md).
- [done/](done/README.md) — completed rounds, kept for reference. Never delete.

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

**Round 7** is active — [round-7/README.md](round-7/README.md): its one item,
[CDR-2](round-7/CDR-2.md), shipped on 2026-10-27 (`46fefb6`, CI run 184) — the
`customerDevices` bootstrap slice, the last legacy device read, left by CDR-1
for an older bundle, is retired and its mapping is cache-only
(`CACHE_ONLY_TABLES`), so the operational cache keeps the mirror while the
slice key answers 410 Gone. Round 7's close pass is the next step. Round 6
closed on 2026-10-27 — see
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
