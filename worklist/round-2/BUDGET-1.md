# BUDGET-1 — startup bundle headroom decision

Status: `[x]` decided 2026-10-26 — trim the eager registers, raise the entry
guard by 1 kB · Created 2026-10-26 · Client only
Round: [Round 2](README.md) · Order: 4 · Commit `6060532`

## Trigger

The note said to act when the budget failed or the total headroom fell below
~8 kB after the first client change in the round. After VOL-2:

```
entry:         15.6 kB gz (budget 16 kB)   → 0.4 kB headroom
startup total: 313.2 kB gz (budget 320 kB)  → 6.8 kB headroom
75 chunks in the startup graph, 34 on-demand
```

That is under the 8 kB floor and leaves the entry 0.4 kB from failing on the
next shell change, so the decision was due now — not speculatively.

## Largest startup contributors (measured)

| Chunk | gzip |
|---|---:|
| `vendor-react` | 67.7 kB |
| `feature-inventory-StockOperations` (eager by design) | 38.6 kB |
| entry (`index-*.js`) | 15.6 kB |
| `vendor-icons` | 13.0 kB |
| `feature-sales-CustomersManagement` | 12.1 kB |
| `feature-inventory-ProductManagement` (eager by design) | 10.3 kB |
| `shared-common-GlobalSearchModal` | 9.2 kB |
| `feature-dashboard-Dashboard` (eager by design) | 8.4 kB |
| `feature-settings-CompanySetupManagement` | 7.2 kB |
| `feature-inventory-SerialLogRegister` | 6.9 kB |
| `feature-sales-CustomerMasterDirectory` | 6.9 kB |
| `feature-procurement-PurchaseOrders` (eager by design) | 6.8 kB |
| `feature-settings-PermissionManagement` | 6.8 kB |
| `feature-finance-FixedAssetRegister` | 4.5 kB |
| `feature-inventory-BranchStockTracking` | 3.4 kB |

The four screens the note names as deliberately eager are in the graph for a
reason and stayed. Five registers were eager with no such reason: their static
imports simply sat beside the eager block, even though no first paint renders
them and every comparable register (Purchase/Sales Invoices, Returns, Shipments,
Import/Export, stock audits) is already `React.lazy`.

## Decision

**Trim, plus a deliberate 1 kB entry-budget raise. The 320 kB total stays.**

1. **Moved five registers behind `React.lazy`** — named, because their
   first-visit behaviour now includes a chunk fetch behind the existing
   `TabLoadingFallback`:
   - `BranchStockTracking` — 3.4 kB gzip
   - `FixedAssetRegister` — 4.5 kB
   - `CustomersManagement` (Customer Devices register) — 12.1 kB
   - `CustomerMasterDirectory` — 6.9 kB
   - `SerialLogRegister` — 6.9 kB

   **33.8 kB gzip** left the startup graph. Dashboard, ProductManagement,
   StockOperations and PurchaseOrders remain eager; no other screen's first
   visit changed.
2. **Entry budget 16 → 17 kB.** The entry chunk is the App shell/routing itself
   (15.7 kB now) and grew legitimately from 11.7 kB at the 2026-09 baseline as
   the route table, SSE/refresh logic and bootstrap-slice handling landed. The
   raise is not hiding an eager import — those were removed first — and 1.3 kB
   is about five shell-sized changes. Screen weight belongs in lazy chunks.
3. **Total budget unchanged at 320 kB.** The trim restored the headroom the
   guard exists to protect; raising the total would have erased it.

## Result

```
Startup chunk set: 69 chunks (was 75)
  entry:         15.7 kB gz (budget 17 kB)    → 1.3 kB headroom
  startup total: 279.0 kB gz (budget 320 kB)  → 41.0 kB headroom
  on-demand (dynamic-only, not budgeted): 39 chunks (was 34)
```

## Gates

- [x] `npx tsc --noEmit` clean.
- [x] Full `npm test`: **1254 tests, 1252 pass, 0 fail, 2 Windows-only
      skips**; docs-count gate matched 1254.
- [x] `npm run build` clean.
- [x] `npm run check:bundle-budget`: 279.0 kB / 15.7 kB (320 / 17).
- [x] `check:no-inline-sql` and `check:no-raw-dialogs` green.
- [x] Commit `6060532`; the hash is recorded in the round tracker.

## Acceptance

- [x] The budget passes with at least ~8 kB of total headroom (41.0 kB), and
      the accidental eager weight is removed.
- [x] The decision, contributors, measured before/after and the named screens
      are recorded here and in the script comment.
- [x] No screen's first-visit behaviour changed without being named above.
- [x] The total guard was not raised; the entry guard was raised deliberately
      with dated measurements after the trim.

## Risks

| Risk | Mitigation |
|---|---|
| A lazy register feels slower on first visit | Each is 3.4–12.1 kB gzip behind the app's standard fallback; they are not first-paint screens |
| The entry guard hides future shell growth | 1.3 kB is deliberately small; a breach still fails, and screen weight must go to lazy chunks |
| A later eager import re-inflates the graph | The same static-closure budget check stays in CI at 320 kB total |
