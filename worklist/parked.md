# Parked decisions

Reviewed 2026-10-26 against the code, when Round 3 was planned, and
re-reviewed 2026-10-27 at the Round 3, Round 4, Round 5, Round 6 and Round 7
closes: every trigger below is still unmet. Rounds 3–4's payload work removed
arrays rather than changing an owner, Round 5's index work removed client-side
scans, Rounds 6–7 removed dead server reads (a route, then a bootstrap slice),
and no new root cost was measured. These are deliberate “not now”, not forgotten work.
Do not reopen one without its trigger; add the new evidence here first.

Permanent detail: [architecture-backlog.md](../docs/architecture-backlog.md),
[SESSION_NOTES.md](../SESSION_NOTES.md), [serial-register-audit.md](../docs/serial-register-audit.md).

| ID | Decision | Status | Reopen trigger |
|---|---|---|---|
| **A5** | Data store for the operational arrays (Zustand/Jotai or `useBootstrapData`) | **Deferred** (D4, 2026-10-25) | A real-browser profile shows root commits over the 16 ms frame budget, or A4b's typed deps contract becomes the priority. **Not** because the root is large. |
| **A4b** | Route element factory (move element construction out of App) | **Leave alone; record A4 as complete at A4a** | Only if A5 reopens and provides the typed deps contract. There is no standalone value. |
| **B3** | Read-only item projection tables | **Parked** | An item-level report or join actually needs it. If a future aggregate misses its 10× target, a **single-table** `stock_operation_items` projection is the narrow fallback first. |
| **B4** | Full JSONB normalization | **Parked** | A product decision that item-level joins/writes are required. B1/B2/B3 have not demanded it. |
| **C4** | One hydration entry point (`hydrate()`/`refresh()`) | **Parked** | A second `bootstrap/local` caller appears, or a screen bypasses the slice gate. |
| **SN-1** | Split `SESSION_NOTES.md` by year under `docs/session-notes/` | **Done** (2026-10-27, Round 3 close) — see [docs/session-notes/](../docs/session-notes/README.md) | — executed; the root keeps only the current state and index |
| **STOCK-2** | A paged `inventory_stock` read (+ a stock overview endpoint for the shell badge and notifications) | **NO-GO today, GO-on-evidence** (2026-10-27, [STOCK-2](done/2026-10-27-round-5/STOCK-2.md)) | A real login's `stock` slice measures **≥ 1 MiB gzip** in the target deployment, or an ALL-scope catalogue well past ~5,000 products makes the client-side filter the bottleneck. Re-measure the row width first — the band is ≈ 143–164 B raw / 15–27 B gzip per row, and the demo DB cannot answer it. |

## Why STOCK-2 is a conditional NO-GO

It is not a size judgement: at the modelled 2,000 products × 20 branches the
global stock read is 0.59–1.03 MiB gzip, which straddles the trigger, and if the
real volumes match that model the round would remove more per login than any
payload item so far (shipments, 300 kB gzip, was the largest). What is missing is
the one fact the repo cannot hold — the deployment's catalogue and branch count —
and [STOCK-1](done/2026-10-27-round-5/STOCK-1.md) already removed the
client-side cost (a 746× improvement in the product × branch derivation), so
there is no pressure to start on a hunch. The migration is also not a payload deletion like Rounds 2–4:
32 screens consume the array, and the shell badge and the notification center
need a company-wide count that only a new aggregate endpoint can serve.

## Why A5 stays deferred

D4 measured the root’s own work at ~2.1 ms for all 67 route elements, and the
production-browser check showed a stock update fetching only the four targeted
slices, zero long tasks and an unchanged frame cadence. A1’s element memo and
A2’s shell split already prevent unrelated screens from re-rendering. A store
would move 23 arrays between owners; it would **not** reduce what the bootstrap
downloads, which is the limit that grows with customers, branches and years.
That is what [Round 2](done/2026-10-26-round-2.md) addressed instead, and it closed
on 2026-10-26.

If a future volume design chooses a store as the vehicle for paged,
selectively-subscribed slices, A5 becomes that design’s implementation detail
and should be re-scoped then — not started as a standalone refactor.

## Why A4b is not “blocked work”

A4’s acceptance (“the route table is the only place a tab is declared”) holds
with A4a. A4b only relocates ~100 prop bindings from `App.tsx` into a factory,
with no behaviour change and no user-visible effect. Keeping it listed as
“blocked on A5” makes A4 read as unfinished when it is not. Mark A4 complete at
A4a in the backlog; keep A4b as an optional consequence of A5, not a pending
slice.

## Why B3/B4 stay parked

B2 removed every `items::text` scan; search is indexed and measured. B1 found no
report that needs item rows in SQL. The one place that still moves raw item
JSON — the financial summary's trading calculation — is better fixed by
aggregating in SQL ([SUM-1](done/2026-10-26-round-2.md)) than by adding seven
projection tables. A projection only earns its write path when a report needs item-level
filters or joins, or when the aggregate itself cannot meet its target.
