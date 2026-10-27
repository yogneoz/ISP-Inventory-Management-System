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
- `round-N/` — the active round, when there is one. **None right now**: Round 4
  closed on 2026-10-27 and its folder is archived under [done/](done/README.md).
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

**No round is active.** Round 4 closed on 2026-10-27 — see
[done/2026-10-27-round-4.md](done/2026-10-27-round-4.md): `fixed_assets` left
the bootstrap ([ASSET-1](done/2026-10-27-round-4/ASSET-1.md), `3efd446`) and the
Device Exchange picker moved to the paged device read
([EXCH-1](done/2026-10-27-round-4/EXCH-1.md), `3d7afe4`). Round 3 closed the day
before ([done/2026-10-27-round-3.md](done/2026-10-27-round-3.md)). The next
round is not scoped yet: start from the measured watch list below and
[parked.md](parked.md) — do not open a parked item without its recorded
trigger, and add the new evidence there first.

Recorded watch items — **measured 2026-10-27** before Round 5 planning, so
none is an open question any more. `inventory_stock` (product × branch),
`damageRecords` and the two return registers are the only uncapped arrays
left; at the recorded volumes the return registers are ≈ 203 kB gzip combined
at 1× (and both already read paged endpoints — the arrays are only the
degraded fallback), damage is ≤ 653 kB gzip at 1× even if every stock
operation were a damage row, and a branch's stock array is catalog-sized. **No Round 5 payload
item is justified.** The one trigger to keep: revisit `inventory_stock` when a
global (ALL-scope) login's stock array passes ≈ 1 MiB gzip (catalog × branches
≈ 2,000 × 20), or when a stock screen needs server-side search/paging. Full
numbers and limits in
[docs/session-notes/2026.md](../docs/session-notes/2026.md#-round-5-watch-list-measured--none-of-the-remaining-arrays-earns-an-item-2026-10-27).
