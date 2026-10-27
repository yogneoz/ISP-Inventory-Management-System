# SESSION NOTES — for next session

_Date: 2026-10-27 · Branch: main · Tests: 1354/1354 green with a DB (all run in CI too; the two unconditional skips are Windows-only real-signal checks that Linux CI runs — no DB-dependent skips since the PG service container landed)_

> **Current state (2026-10-27, DOC-1/CPE-2/B1/B2/CPE-3/SER-1/SER-2/TRIM-1/SUM-1/VOL-1/VOL-2/BUDGET-1/BOOT-1/VOL-3/VOL-4a/VOL-4b/SN-1/ASSET-1/EXCH-1/READ-1).** All DF-01…DF-17
> work, the bootstrap trim follow-up, A3, A4a, CPE-1, CPE-2, B1, B2, CPE-3,
> SER-1, SER-2, TRIM-1, SUM-1, VOL-1, VOL-2, BUDGET-1, Round 3
> (BOOT-1, VOL-3, VOL-4a, VOL-4b) and Round 4's ASSET-1/EXCH-1 are implemented.
> **Round 2 closed on 2026-10-26** ([archive](worklist/done/2026-10-26-round-2.md));
> **Round 3 closed on 2026-10-27** ([archive](worklist/done/2026-10-27-round-3.md)).
> **Round 4 closed on 2026-10-27** ([archive](worklist/done/2026-10-27-round-4.md)):
> ASSET-1 (`3efd446`) took `fixed_assets` off the payload and EXCH-1 (`3d7afe4`)
> moved the Device Exchange picker to the paged device read, both CI green.
> **Round 5 closed on 2026-10-27**
> ([archive](worklist/done/2026-10-27-round-5.md)): READ-1 (`8cdd09b`) deleted
> the orphaned bare-array device read, so no client code can reach the capped
> 2,000-row endpoint; STOCK-1 (`9009f9c`) indexed the stock-array lookups out of
> the stock screens (≈ 746× on the product × branch derivation, totals
> unchanged); and the STOCK-2 gate recorded **NO-GO today, GO-on-evidence**
> (`9fec135`) for a paged `inventory_stock`, with both firing conditions in
> [parked.md](worklist/parked.md). No round is active. The payload work is
> finished — the remaining-array measurement found no item to open, and the
> `inventory_stock` trigger is recorded in [2026.md](docs/session-notes/2026.md). The
> notes are split by year (**SN-1**): entries live in
> [docs/session-notes/2026.md](docs/session-notes/2026.md), this file is the
> current-state index. C4 is explicitly parked (one `bootstrap/local` call site
> already; see the architecture backlog §C4). B2 shipped the combined trigram
> search projection, so all eight item searches share one indexed `search_text`
> column per table; B3/B4 stay parked. CPE-3 resolved D1 and made the fixed
> asset, CPE row, serial register and stock move together. SER-1 resolved D2:
> pullout/consumable/sale now issue their units to `IN_TRANSIT`/`CONSUMED`/`SOLD`,
> each with a reversal. SER-2 resolved D3: boot no longer backfills the serial
> register; the pass is an explicit SUPER_ADMIN maintenance action. **D4
> (2026-10-25) defers A5**: measurements do not show user-visible root cost, so
> A5 is not started and A4b stays blocked behind it; reopen A5 only on the
> recorded trigger (D4 in the 2026 notes).
> Older “Remaining …” paragraphs in the 2026 file are chronological notes, not a
> live backlog; where they conflict with this index, the code wins.

## Where the history lives

- [docs/session-notes/README.md](docs/session-notes/README.md) — the folder
  index and the rule for where new entries go.
- [docs/session-notes/2026.md](docs/session-notes/2026.md) — every entry from
  the first session through the Round 5 close, newest first.
- New entries: prepend below the separator in the current year's file. This
  root file stays short (current state + index) and keeps the gated
  `Tests: N/N` claim read by
  [scripts/docsTestCounts.ts](scripts/docsTestCounts.ts).
