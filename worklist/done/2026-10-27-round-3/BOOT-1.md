# BOOT-1 — the bootstrap stops paying for what it does not ship

Status: `[x]` done (`ad59a38`) · Created 2026-10-26 ·
Estimate 1–2 days · Server only
Round: [Round 3](README.md) · Order: 1

## Problem

Round 2 removed `transactionLogs` and `salesInvoices` from what the client
receives. The full bootstrap still loads several ledgers it never sends:

- [fetchOperationalData](../../../server/src/models/bootstrap.repo.ts#L171) selects
  every `purchase_orders`, `purchase_invoices`, `stock_operations` and
  `vendor_payments` row for the fiscal year / branch, with no cap.
- [get_bootstrap](../../../server/src/controllers/bootstrap.controller.ts#L76)
  uses `purchase_invoices` and `stock_operations` only to feed
  `computeFinancialSummary`; [the response](../../../server/src/controllers/bootstrap.controller.ts#L130)
  omits those three arrays. `pgPurchaseOrders` is declared and never read at
  all.
- `vendorPayments` is still serialized in the response, but no client state,
  type or screen reads it — the only `client/src` mention is the PROCUREMENT
  refresh-domain list.

At the modelled 10× volume this is the same order of work SUM-1 measured for
the slice path (27.4 MiB of `STOCK_OUT` line JSON), before counting the other
operation types and the invoice rows — repeated on every login and every full
refresh, then discarded. The SQL aggregates already exist and are exercised by
the slice, the batch report endpoint and `tests/tradingTotals.test.ts`.

## Scope

Server only: the bootstrap controller and repository. No client rendering
change; the one visible contract change is dropping `vendorPayments`, which the
client never consumed.

## Steps

- [x] **1. Switch the full bootstrap to the SQL summary.** Call
      `fetchFinancialSummaryFromDb` with the same branch/FY scope, current-year
      code and `useOpeningStock` flag the slice uses; delete the
      `computeFinancialSummary` call and the `pgInvoices`/`pgOps` bindings it
      needed.
- [x] **2. Drop the queries.** Remove `purchaseOrders`, `purchaseInvoices`,
      `stockOperations`, `vendorPayments` and the now-unused
      `fetchVendorOpeningBalanceTotal` from `fetchOperationalData`; update its
      return type, the controller comment and the `bootstrap/local` fallback
      note. Every removed key keeps its `BOOTSTRAP_TABLES` mapping, so
      `GET /api/bootstrap/local?key=<key>` still serves an older client.
- [x] **3. Remove the dead payload key.** Stop serializing `vendorPayments`;
      remove it from App's `PROCUREMENT` refresh-domain list (it would fetch a
      slice nothing applies) and from any bootstrap payload test that names it.
- [x] **4. Keep the pure rule honest.** `computeFinancialSummary` stays as the
      parity oracle; update its JSDoc and extend the live test to rebuild its
      source from the same fixture rows and compare all eight fields with the
      bootstrap response, not only trading.
- [x] **5. Measure.** Record query count before/after and rows/wall time at the
      modelled 1× and 10× volumes (reuse the B1/SUM-1 fixture shape), plus the
      gzip bytes of the removed `vendorPayments` array.
- [x] **6. Gates.** `npx tsc --noEmit`, the financial-summary/bootstrap/repo
      tests, full `npm test`, `check:no-inline-sql`, `check:no-raw-dialogs`,
      build and bundle budget.

## Measurement (2026-10-26)

A throwaway scratch-schema benchmark (`.tmp-boot1-bench.ts`, removed after the
run) seeded the four ledgers with the real column shape and a four-line `items`
JSON document, then timed the old four-ledger read against
`fetchFinancialSummaryFromDb` on the same connection:

| Volume | Rows | Row text removed | Old four-ledger read | New SQL summary |
|---|---:|---:|---:|---:|
| 1× (100k movements, 12k invoices/POs, 30k payments) | 154,000 | 63.1 MB | **1,803 ms** median (1,525 best), all 154k rows in Node | **187 ms** median (154 best) |
| 10× (1M movements, 120k invoices/POs, 300k payments) | 1,540,000 | 632.4 MB | **not materializable** — the pool connection dropped under the 1.54M-row read | **1,402 ms** median (1,247 best) at 70 MB RSS |

The 10× old-path failure is the finding, not a measurement gap: the previous
login path pulled 632 MB of row text into Node and computed the summary there.
The new path never transfers those rows, and at 1× it is 9.6× faster. The
summary SQL itself is unindexed in this scratch schema, so the new times are an
upper bound; SUM-1 measured the trading aggregate alone at 357 ms for 120k
operations with the real indexes.

Per login the full bootstrap now runs **18 fan-out queries + 8 summary
aggregates** instead of **23 fan-out queries** whose four ledger reads carried
all the rows above. The removed `vendorPayments` response key alone accounted
for 1.6 MB / 16.2 MB of row text at 1×/10×; no client state or screen read it.

## Acceptance

- [x] The full bootstrap's `financialSummary` equals the slice's for the same
      branch/FY, and the live test rebuilds the pure rule from the same rows and
      matches all eight fields.
- [x] `fetchOperationalData` no longer reads the four ledgers or the opening
      balance; the login fan-out is 18 queries, not 23.
- [x] `/api/bootstrap` no longer contains `vendorPayments`; no client state,
      prop or refresh domain references it.
- [x] `GET /api/bootstrap/local?key=purchaseOrders|purchaseInvoices|stockOperations|vendorPayments`
      still answers through the table mappings; a mapping-read failure now
      answers 503 for those keys instead of an empty payload.
- [x] 1×/10× measurements recorded above and in SESSION_NOTES.
- [x] Commit hash recorded when committed.

## Gates (2026-10-26)

- `npx tsc --noEmit` clean.
- Full `npm test`: **1255 tests, 1253 pass, 0 fail, 2 Windows-only skips**;
  docs-count gate matched 1255.
- Targeted financial-summary/bootstrap/cache/returns/transaction suites
  **61/61 pass**.
- `check:no-inline-sql` and `check:no-raw-dialogs` green.
- `npm run build` clean; `check:bundle-budget` **279.0 kB / 15.7 kB** (320 / 17).

## Risks

| Risk | Mitigation |
|---|---|
| SQL and pure summary drift | The live test rebuilds the pure source from the seeded rows and compares all eight fields; trading parity already has its own matrix |
| A hidden consumer needed an unshipped array | The three keys are absent from the client payload/types today; the slice endpoint still serves them by key |
| Removing `purchaseOrders` breaks the `bootstrap/local` fallback | It has a `BOOTSTRAP_TABLES` mapping, so the live slice read answers first; the fallback only covered unknown keys |
| Opening-stock years value differently | Pass `useOpeningStock: !isCurrent`, exactly as the slice does, and keep the existing past-year fixture |
| The existing summary-agreement test becomes tautological | Replace its source pin with the pure-vs-SQL fixture comparison above, and assert the controller uses the SQL producer |

## Close-out

Committed as `ad59a38` ("Stop loading ledgers the bootstrap never ships") and
pushed to `main`; the same commit removed the unreferenced `FRONTEND-AUDIT.md`.
CI run
[40280256078](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/40280256078)
(`typecheck-and-test`) passed in 330 s.
