# SUM-1 — aggregate the financial summary's trading totals in SQL

Status: `[x]` shipped in `4a2946b` · Created 2026-10-26 · Estimate 1–2 days · Server only
Round: [Round 2](README.md) · Order: 1

## Problem

`GET /api/bootstrap/local?key=financialSummary` is refreshed on seven SSE
domains: `STOCK`, `STOCK_OPERATIONS`, `PROCUREMENT`, `SALES`, `SHIPMENTS`,
`FISCAL` and `RECALC` ([App.tsx:1023](../../client/src/App.tsx#L1023)). Each
refresh called `fetchFinancialSummaryFromDb`:

- [buildStockOutOpsQuery](../../server/src/models/reports.repo.ts#L232) selected
  every `STOCK_OUT` row's `items` JSON for the fiscal year / branch — no row cap.
- [financialSummary.service.ts:199](../../server/src/services/financialSummary.service.ts#L199)
  parsed every line in Node.
- `computeTradingFromOps` also ran `products.find` for every line, so the work
  was linear in sale lines times products.

At B1's modelled 10× volume (120k sales invoices) that was hundreds of thousands
of line objects shipped and parsed per refresh, to produce two numbers.

## Scope

Server only: repository query, service, tests, benchmark. No client change.

## Steps

- [x] **1. Pin the rule with a parity matrix first.** Added
      [tradingTotals.test.ts](../../tests/tradingTotals.test.ts): priced
      `totalValue`; missing or `0` `totalValue` falling back to
      `sellingPrice − discount`; a discount producing a negative total; a line
      with quantity but neither price field (skipped entirely, including COGS);
      `unitCost` present; `unitCost` missing resolved from the product; a
      deleted product (COGS 0); an asset-issue line; a multi-line operation;
      non-`STOCK_OUT` rows; negative/zero quantities; numeric strings; JSON
      null `totalValue`; a non-array `items` value; another branch and an
      out-of-range date.
- [x] **2. Add the aggregate query** as `buildTradingTotalsQuery(scope)` in
      [reports.repo.ts](../../server/src/models/reports.repo.ts), returning only
      `total_revenue` and `total_cogs`.
- [x] **3. Mirror the JS rule exactly.** `jsonb_to_recordset` reads each line
      once, `LEFT JOIN products p ON p.id::text = item."productId"` resolves
      the cost fallback without a uuid cast, and the line-skip is the two price
      fields both being NULL. `NULLIF(..., 0)` keeps the `Number(x) || fallback`
      behaviour for `totalValue`/`unitCost`; COGS accrues for `quantity > 0`
      even when revenue is 0.
- [x] **4. Switch the slice.** `fetchFinancialSummaryFromDb` now issues eight
      indexed reads and returns the two aggregate numbers; the pure
      `computeFinancialSummary`/`computeTradingFromOps` pair remains for the
      full bootstrap, and the parity test keeps the producers honest.
- [x] **5. Prove scope equality.** The new query uses the same `date_ad` range
      and optional `branch_id`; the parity suite includes another branch and an
      out-of-range row, and the repo test pins the parameter order
      (`startDateAD`, `endDateAD`, `branchId`).
- [x] **6. Measure.** On an isolated 12k/120k-row scratch schema with four-line
      sales, seven runs each:

      | Volume | Old payload | Old wall + Node parse | New wall | New p95 |
      |---|---|---|---|---|
      | 12k (1×) | 2.7 MiB | 86 ms + 17 ms ≈ 103 ms | 108 ms | 113 ms |
      | 120k (10×) | 27.4 MiB | 750 ms + 74 ms ≈ 824 ms | 357 ms | 406 ms |

      The first attempt expanded lines with `jsonb_array_elements` and cast
      each field; it was **slower than the old path** (1.8 s at 120k) and was
      replaced by the recordset. At 1× the new p95 (113 ms) is slightly better
      than the old total p95 (≈124 ms); at 10× it is ~2.3× faster and returns
      one row instead of 27.4 MiB. The trade-off is DB CPU: the aggregate is
      ~396 ms of execution at 120k versus the old 63 ms scan plus Node parsing.
      A write-time total is the next step only if DB CPU, not latency, becomes
      the constraint.
- [x] **7. Update docs.** Added the outcome to
      [architecture-backlog.md](../../docs/architecture-backlog.md) (the B3
      note) and a SESSION_NOTES entry; the B3 reopen condition now names the
      single-table projection / write-time total fallback.
- [x] **8. Gates.** `npx tsc --noEmit`, the financial-summary/repo/parity
      tests, full `npm test`, no-inline-SQL and no-raw-dialogs guards all pass.
      Recorded as `4a2946b`.

## Acceptance

- [x] The financial-summary slice response contains two numbers, not item JSON.
- [x] SQL totals equal `computeTradingFromOps` on the full parity matrix,
      including the zero/missing-field edge cases.
- [x] `financialSummary` still matches the full-bootstrap producer for the same
      scope (existing test).
- [x] 1× and 10× p50/p95 recorded; 1× p95 not regressed.
- [x] Docs updated; note moves with the round at close.
- [x] Commit hash recorded: `4a2946b`.

## Risks

| Risk | Mitigation |
|---|---|
| `totalValue: 0` vs missing vs `null` changes the fallback | Parity cases for all three; `jsonb_to_recordset` yields NULL for missing/null and the CASE falls back; JSON-null-with-a-price is covered |
| Product id cast fails on legacy/malformed JSON | Join on `p.id::text`, never cast the JSON value to uuid |
| Numeric strings or bad quantities | Numeric strings cast in the recordset and are covered; a truly non-numeric legacy value would now raise instead of silently becoming 0 — acceptable for app-written rows, and a one-table projection is the fallback if such data appears |
| The SQL and pure rule drift later | Both remain and the parity suite pins them; the builder JSDoc names the test |
| Huge `items` arrays make the aggregate itself slow | Measured at 10×; 357 ms end-to-end is better than the old 824 ms, and the next fallback is recorded |

## Status

Implemented in `reports.repo`/`financialSummary.service` and the new parity
suite. `npx tsc --noEmit`, the targeted financial-summary/repo/parity tests,
full `npm test` (two Windows-only skips), `check:no-inline-sql` and
`check:no-raw-dialogs` are green; docs are updated. Committed as `4a2946b`;
all acceptance lines are closed.
