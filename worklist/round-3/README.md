# Round 3 — finish the login path

Created 2026-10-26 · Status: `[~]` in progress · Previous round:
[done/2026-10-26-round-2.md](../done/2026-10-26-round-2.md)

## Why this round

Round 2 removed what the client *receives*, but the full bootstrap still pays
for ledgers it never sends. At national volume (12k customers at 1×, 120k at
10×, Nepal-wide) the remaining cost is linear in the customer base and the
fiscal year's operations:

- [fetchOperationalData](../../server/src/models/bootstrap.repo.ts#L171) still
  selects every `purchase_orders`, `purchase_invoices`, `stock_operations` and
  `vendor_payments` row for the scope, with no cap.
- The bootstrap response omits the purchase orders, purchase invoices and stock
  operations, and no client state reads `vendorPayments`; the three ledger
  queries feed only `computeFinancialSummary`, and `purchaseOrders` is fetched
  and never referenced.
- `shipments`, `customers` and `customerDevices` are still shipped whole and
  grow with transfers and the customer base.

The parked structural items are not the limit. A5 would move arrays between
owners; A4b is A5's consequence; B3/B4 need an item-level report. This round
finishes the read path instead, in ascending consumer risk. See
[parked.md](../parked.md) for the decisions we are deliberately not taking.

## Schedule

| Order | ID | Task | Status | Effort | Depends on |
|---|---|---|---|---|---|
| 1 | [BOOT-1](BOOT-1.md) | Full-bootstrap summary via SQL; drop the unshipped ledger queries | `[x]` done (`ad59a38`) | 1–2 days | — |
| 2 | [VOL-3](VOL-3.md) | Take `shipments` off the bootstrap (paged endpoint + KPI reads) | `[x]` done (`acafd52`) | 2–4 days | BOOT-1 (same fan-out) |
| 3 | [VOL-4a](VOL-4a.md) | Take `customers` off the bootstrap (server search in pickers) | `[x]` done (`d2c017f`) | 2–3 days | VOL-3 (App prop plumbing) |
| 4 | [VOL-4b](VOL-4b.md) | Take `customerDevices` off the bootstrap (paged register reads) | `[x]` done | 3–5 days | VOL-4a (shared paging pattern) |
| 5 | SN-1 | Split `SESSION_NOTES.md` by year under `docs/session-notes/` | `[ ]` | 0.5 day | Round close (file passes ~5,000 lines) |

**Total:** about 1.5–2 weeks. BOOT-1 is server-only and pays back the most per
line changed: it removes the largest per-login row read and one array no client
reads. VOL-3/VOL-4 follow the same pattern as VOL-1/VOL-2 and need a payload
measurement before and after.

## Order and stop points

1. **BOOT-1** — switch the full bootstrap to `fetchFinancialSummaryFromDb`,
   drop the four unshipped queries, keep the pure rule under a real parity
   matrix, and record rows/time at 1× and 10×. Stop: response contract
   unchanged except the unread `vendorPayments` key, summary equals the slice.
2. **VOL-3** — shipments only. Done when no `shipments` is in `/api/bootstrap`,
   the register pages through `/api/shipments/page`, and the shell/dashboard
   read `/api/shipments/overview`. In-flight rows are always included; older
   history is the register's paged record.
3. **VOL-4a → VOL-4b** — customers first (pickers move to the existing paged
   search), then customer devices (paged register). Stop: neither key in
   `/api/bootstrap`; a customer outside page 1 is selectable, and the device
   register pages/filters server-side. **Both landed 2026-10-26.**
4. **Round close** — full gates, archive this folder under `done/`, update the
   indexes and SESSION_NOTES, and finish SN-1 in the same close.

Do not start VOL-4b before VOL-4a: both touch the Sales/Stock pickers, and
doing them together makes a payload regression hard to attribute.

## Gates for this round

- `npx tsc --noEmit`
- Targeted tests per item, plus the full `npm test` at round close
- `npm run check:no-inline-sql` and `npm run check:no-raw-dialogs`
- `npm run build` and `npm run check:bundle-budget` for any client change
- A recorded 1×/10× measurement for each item: rows/queries and wall time for
  BOOT-1, gzip payload removed for VOL-3/VOL-4

## Out of scope

[A5, A4b, B3, B4 and C4](../parked.md) stay parked. The PhysicalStockAudit and
Shipments decompositions, the `--noUnusedParameters` sweep and an operations
runbook are all real work, but none is a user-visible or scale limit right now;
do not fold them into this round.
