# Round 2 — national-volume read path

Created 2026-10-26 · Status: `[~]` in progress · Previous round:
[done/2026-10-25-round-1.md](../done/2026-10-25-round-1.md)

## Why this round

The parked architecture items are not the national-scale limit. A5 would move
arrays between owners, A4b would move element construction, and B3/B4 would add
item tables no report needs. What grows with 12k+ customers, more branches and
more years is **how much the read path loads and re-parses**:

- `transactionLogs` enters the bootstrap company-wide for the fiscal year, with
  no row cap; the Dashboard renders eight of them.
- `salesInvoices` enters the bootstrap for one consumer, the Returns register's
  invoice lookup; the customer ledger already reads its own scoped endpoint.
- `financialSummary` ships every `STOCK_OUT` line JSON for the scope to Node on
  seven refresh domains, and parses it to two numbers.

This round takes those three paths off the login payload or out of the hot
refresh, in that order of risk. See [parked.md](../parked.md) for the decisions
we are deliberately not taking.

## Schedule

| Order | ID | Task | Status | Effort | Depends on |
|---|---|---|---|---|---|
| 1 | [SUM-1](SUM-1.md) | Aggregate trading revenue/COGS in SQL | `[x]` shipped (`4a2946b`) | 1–2 days | — |
| 2 | [VOL-1](VOL-1.md) | Take `transactionLogs` off the bootstrap | `[ ]` | 3–5 days | SUM-1 (shares the summary slice's refresh path) |
| 3 | [VOL-2](VOL-2.md) | Take `salesInvoices` off the bootstrap | `[ ]` | 1–2 days | VOL-1 (same bootstrap plumbing) |
| 4 | [BUDGET-1](BUDGET-1.md) | Startup bundle headroom decision | `[—]` hold | 0.5 day | First client change that hits the budget |

**Total:** about 1–1.5 weeks. SUM-1 is server-only and independent, so it can
land first and is the best warm-up. VOL-1 is the largest payload win; VOL-2 is
small and follows the same pattern. BUDGET-1 stays on hold until a client-side
change actually needs the headroom; do not raise the budget speculatively.

## Order and stop points

1. **SUM-1** — measure, implement, parity-test, record 1×/10× numbers. Stop:
   full suite green, docs updated, SESSION_NOTES entry.
2. **VOL-1a → VOL-1d** — one consumer at a time; remove the slice last. Stop:
   no `transactionLogs` in `/api/bootstrap`, payload measured before/after.
3. **VOL-2** — Returns register lookup only. Stop: no `salesInvoices` in
   `/api/bootstrap`, returns flow still finds old invoices.
4. **Round close** — full gates, move this folder to `done/`, update the index
   and SESSION_NOTES with one short summary.

Do not start VOL-2 before VOL-1d: both touch the same bootstrap table list and
the same App state, and doing them together makes a payload regression hard to
attribute.

## Gates for this round

- `npx tsc --noEmit`
- Targeted tests per item, plus the full `npm test` at round close
- `npm run check:no-inline-sql` and `npm run check:no-raw-dialogs`
- `npm run build` and `npm run check:bundle-budget` for any client change
- A recorded payload measurement (rows and compressed size at modelled 1× and
  10×) for VOL-1/VOL-2, and a recorded p95 for SUM-1

## Out of scope

[A5, A4b, B3, B4 and C4](../parked.md) stay parked. Do not fold structural work
into this round; a payload change is already broad enough to test.
