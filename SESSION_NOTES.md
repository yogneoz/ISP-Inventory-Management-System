# SESSION NOTES — for next session

_Date: 2026-10-28 · Branch: main · Tests: 1412/1412 green with a DB (all run in CI too; the two unconditional skips are Windows-only real-signal checks that Linux CI runs — no DB-dependent skips since the PG service container landed)_

> **Current state (2026-10-27, DOC-1/CPE-2/B1/B2/CPE-3/SER-1/SER-2/TRIM-1/SUM-1/VOL-1/VOL-2/BUDGET-1/BOOT-1/VOL-3/VOL-4a/VOL-4b/SN-1/ASSET-1/EXCH-1/READ-1/CDR-1/CDR-2).** All DF-01…DF-17
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
> [parked.md](worklist/parked.md).
> **Round 6 closed on 2026-10-27**
> ([archive](worklist/done/2026-10-27-round-6.md)): CDR-1 (`c147d99`, CI run
> 180) retired the legacy bare-array `GET /api/customer-devices` route, its
> handler and its 2,000-row query, replacing the test that pinned the array
> with a 404 assertion and a source guard; the paged/overview/warranty/exchange
> reads are untouched.
> **Round 7 closed on 2026-10-27**
> ([archive](worklist/done/2026-10-27-round-7.md)): CDR-2 (`46fefb6`, CI run
> 184) retired `/api/bootstrap/local?key=customerDevices` — the last legacy
> device read, 431.5 KiB gzip at the 12k model — by moving its mapping to
> `CACHE_ONLY_TABLES` so the operational cache keeps the mirror; the key
> answers 410 Gone.
> **Round 8 closed on 2026-10-28**
> ([archive](worklist/done/2026-10-28-round-8.md)): the bug & loop audit
> ([doc](docs/bug-loop-audit-2026-10-27.md)) fixed the stock-audit count loss
> (AUD-1 `fbcd013`), the permission-matrix publish order (AUD-2 `6df8ed7`) and
> unbounded line quantities in the UI and the API (AUD-3 `053a898`, QTY-1
> `f1c1131`), and the close pass fixed the two hardening items it had recorded
> as unguarded (AUD-4, AUD-5); a newly published `qs` advisory was cleared by
> the lockfile pin `67e7d47`. **No round is active.** The payload work
> is finished — the remaining-array measurement found no item to open, and the
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
  the first session through the Round 8 close, newest first.
- New entries: prepend below the separator in the current year's file. This
  root file stays short (current state + index) and keeps the gated
  `Tests: N/N` claim read by
  [scripts/docsTestCounts.ts](scripts/docsTestCounts.ts).
