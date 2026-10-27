# Round 5 — stock-screen scale, and closing the read path

Created 2026-10-27 · Status: `[~]` in progress · Previous round:
[done/2026-10-27-round-4.md](../done/2026-10-27-round-4.md)

## Why this round

Rounds 1–4 finished the login payload. The 2026-10-27 watch-list measurement
([numbers](../done/2026-10-27-round-4.md#measured)) then closed the remaining
arrays as payload items: the return registers are ≈ 203 kB gzip combined and
already read paged endpoints, damage is fiscal-year scoped and stays below the
devices array even at an impossible upper bound. **Another payload round is not
justified**, and this round does not open one.

Two things the payload work left behind are worth a round:

- **The stock screens are quadratic in the stock array.** `inventory_stock` is
  the one array that can still grow (catalog × branches on a global read), and
  the screens that consume it look rows up with `stock.find(...)` inside
  product × branch loops — 30 sites across 8 screens. Some of those loops are
  recomputed on every render, so a keystroke in a search box or one count edit
  in the physical audit walks the whole array. That is measurable today at any
  payload size, and fixing it is the cheapest way to learn whether the array
  needs a paged read at all.
- **The read path has one dead limb.** EXCH-1 moved the last consumer off the
  bounded `GET /api/customer-devices` array, which leaves the client wrapper
  and its `api` entry with no caller. It is small, but it is exactly the kind
  of leftover that quietly comes back if nothing pins it.

See [../parked.md](../parked.md): A5, A4b, B3, B4 and C4 stay parked with their
recorded triggers; none is reopened by this round.

## Schedule

| Order | ID | Task | Status | Effort | Depends on |
|---|---|---|---|---|---|
| 1 | [READ-1](READ-1.md) | Delete the orphaned bare-array device read from the client surface | `[x]` done (`8cdd09b`, CI run 174) | 0.5–1 h | — |
| 2 | [STOCK-1](STOCK-1.md) | Measure the stock-array lookups, then index them out of the screens | `[~]` implemented 2026-10-27, gates green, awaiting commit | 3–4 h | READ-1 (warm-up, no shared code) |
| 3 | [STOCK-2](STOCK-2.md) | Gate: re-measure the global stock read and decide paged-vs-array | `[ ]` | 1 h | STOCK-1 (needs the post-fix numbers) |

**Total:** about half a day of work plus the measurement time. This is a small
round on purpose: the large payload work is finished, and the honest next step
is to remove the cost that is already visible rather than to repeat a round
whose measurement said no.

## Order and stop points

1. **READ-1** — remove the dead client path and pin it with a guard. Stop: no
   client code can reach the bare device array; the existing exchange suite and
   the device-register source guard still pass. **Done 2026-10-27 (`8cdd09b`).**
2. **STOCK-1 stage A — measure.** Build the jsdom probe with 2,000 products ×
   20 branches (40,000 stock rows) and record the baseline: Branch Stock first
   render (ALL branch), one keystroke in its local search, one count edit in
   Physical Stock Audit. Stop: baseline numbers are written down before any
   screen changes.
3. **STOCK-1 stage B — index.** One shared `Map` helper, used at the 8 screens;
   memoise the derivations that currently run in the render body. Stop: the
   probe's after numbers are recorded, every screen renders the same rows, and
   the existing suites (physical audit, branch stock, dashboard, registers) pass
   unchanged.
4. **STOCK-2 — decide, do not build.** Re-measure the global login with real
   catalog/branch counts. Record GO (open a paged stock read as its own round)
   or NO-GO (keep the array, keep the trigger). Stop: the decision and its
   numbers are in the note and in [parked.md](../parked.md) if it is a NO-GO.
5. **Round close** — full gates, archive this folder under `done/`, update the
   indexes and the session notes.

Do not start STOCK-2's paged read inside STOCK-1. STOCK-1 must be able to land
and be reverted on its own; a server migration hidden inside a client
optimisation is how a "small fix" becomes an unaudited read-path change.

## Gates for this round

- `npx tsc --noEmit`
- Targeted tests per item, plus the full `npm test` at round close
- `npm run check:no-inline-sql` and `npm run check:no-raw-dialogs`
- `npm run build` and `npm run check:bundle-budget` for the client changes
  (STOCK-1 adds a helper to the entry chunk; the entry has ≈ 1.3 kB of headroom)
- A recorded before/after measurement for STOCK-1 and a recorded GO/NO-GO for
  STOCK-2

## Out of scope

A5, A4b, B3, B4 and C4 stay parked. The return arrays, damage and
`inventory_stock` stay **payload** watch items — the measurement already
answered them. Also not in this round, with reasons in the close note:
finishing the mirror retirement (the remaining readers are the PG-down demo
fallbacks), splitting `handoff.md`, and sharding the test suite.
