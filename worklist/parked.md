# Parked decisions

Reviewed 2026-10-26 against the code, after Round 1 closed. These are deliberate
“not now”, not forgotten work. Do not reopen one without its trigger; add the
new evidence here first.

Permanent detail: [architecture-backlog.md](../docs/architecture-backlog.md),
[SESSION_NOTES.md](../SESSION_NOTES.md), [serial-register-audit.md](../docs/serial-register-audit.md).

| ID | Decision | Status | Reopen trigger |
|---|---|---|---|
| **A5** | Data store for the operational arrays (Zustand/Jotai or `useBootstrapData`) | **Deferred** (D4, 2026-10-25) | A real-browser profile shows root commits over the 16 ms frame budget, or A4b's typed deps contract becomes the priority. **Not** because the root is large. |
| **A4b** | Route element factory (move element construction out of App) | **Leave alone; record A4 as complete at A4a** | Only if A5 reopens and provides the typed deps contract. There is no standalone value. |
| **B3** | Read-only item projection tables | **Parked** | An item-level report or join actually needs it. If [SUM-1](round-2/SUM-1.md) misses its 10× target, a **single-table** `stock_operation_items` projection is the narrow fallback first. |
| **B4** | Full JSONB normalization | **Parked** | A product decision that item-level joins/writes are required. B1/B2/B3 have not demanded it. |
| **C4** | One hydration entry point (`hydrate()`/`refresh()`) | **Parked** | A second `bootstrap/local` caller appears, or a screen bypasses the slice gate. |
| **SN-1** | Split `SESSION_NOTES.md` by year under `docs/session-notes/` | **Not started** | The root file passes ~5,000 lines or finding the current state takes more than a minute. Round 2 keeps new detail in this folder so it does not keep growing. |

## Why A5 stays deferred

D4 measured the root’s own work at ~2.1 ms for all 67 route elements, and the
production-browser check showed a stock update fetching only the four targeted
slices, zero long tasks and an unchanged frame cadence. A1’s element memo and
A2’s shell split already prevent unrelated screens from re-rendering. A store
would move 23 arrays between owners; it would **not** reduce what the bootstrap
downloads, which is the limit that grows with customers, branches and years.
That is what [Round 2](round-2/README.md) addresses instead.

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
aggregating in SQL ([SUM-1](round-2/SUM-1.md)) than by adding seven projection
tables. A projection only earns its write path when a report needs item-level
filters or joins, or when the aggregate itself cannot meet its target.
