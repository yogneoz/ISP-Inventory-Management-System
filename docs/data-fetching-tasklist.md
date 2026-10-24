# Data-fetching fixes — working task list

_Updated 2026-10-24 · source of findings: [data-fetching-audit.md](data-fetching-audit.md)_

This is the working checklist for the 2026-10-24 data-fetching audit. The audit
holds the "why" and the evidence; this file holds the tasks, the order, and the
status. Update **both** the checkbox and the status board in the same commit that
ships a task.

## How to work from this file

1. **One task per commit**, with its ID in the subject:
   `DF-01: page the customer directory server-side`.
2. **Tick the task and its status row in the same commit.** A task is `done`
   only when every acceptance bullet is true.
3. **Read the audit section named in the task first.** If the code has moved and
   the audit is now wrong, correct the audit in the same commit.
4. **Do not widen a task.** If it grows, split it into `DF-01a` / `DF-01b` here,
   ship the smaller one, and leave the rest visible.
5. **Never bypass the C1/C2 hydration gate** or replace a server-authoritative
   read with a client-side filter of a bootstrap slice.
6. **Tests must create their own fixtures.** CI runs against a schema-only
   database — never rely on seeded rows (see SESSION_NOTES 2026-10-24).
7. **Stop point after every task:** `npx tsc --noEmit`, the targeted tests, the
   full `npm test` (which includes the docs-count gate), then update
   `SESSION_NOTES.md` with the next ID if you stop for the day.

## Status board

| ID | Task | Findings | Severity | Status | Depends on |
|----|------|----------|----------|--------|------------|
| DF-01 | Restore the Customer Master Directory (server-side paging) | P0-1 | P0 | `done` | — |
| DF-02 | Refresh the product catalog after save/re-activation | P1-1 | P1 | `done` | — |
| DF-03 | One shared serial-register cache, invalidated by events | P1-2 | P1 | `done` | — |
| DF-04 | Surface paged-register fetch failures | P1-3 | P1 | `todo` | — |
| DF-05 | Give `financialSummary` a refresh path | P1-4 | P1 | `todo` | — |
| DF-06 | Complete the SSE domain coverage (shipments, recalculation) | P2-1, P2-2 | P2 | `todo` | — |
| DF-07 | Include the fiscal year in the GET dedup key | P2-3 | P2 | `todo` | — |
| DF-08 | Sequence guards for ledgers and opening registers | P2-4, P2-5 | P2 | `todo` | — |
| DF-09 | Clamp a register page when the row set shrinks | P2-6 | P2 | `todo` | — |
| DF-10 | BS calendar fallbacks and the BS-date gate | P2-7, P2-8 | P2 | `todo` | DF-06 (for live calendar events) |
| DF-11 | Distinguish "failed to load" from "empty" on setup lists | P2-9 | P2 | `todo` | — |
| DF-12 | Cleanup: full reload, N+1 fetches, dead state, dedup of serial fetch | P2-10, P3-1…P3-5 | P2/P3 | `todo` | DF-03, DF-05 (soft) |

Legend: `todo` · `wip` · `blocked` · `done`.

---

## DF-01 — Restore the Customer Master Directory (P0)

**Status: `done` (2026-10-24).** The server contract, screen, export path and tests
landed: paged/filtered `GET /api/customers` envelope, server-driven pagination and
KPIs, load-error banner with Retry, all-rows CSV export. Evidence and suite/tsc
numbers are in `SESSION_NOTES.md` under "DF-01 shipped".

**Problem.** The screen expects `{ data, page, pageSize, totalItems }` and sends
`page`/`pageSize`/`status`, but `GET /api/customers` returns a bare array and
ignores all three. `(envelope as { data? }).data` is therefore always
`undefined`, so the directory shows "No Customer Records Found" and every KPI
reads zero. Introduced by `d53cc8d` (2026-10-05).

**Decision (taken here):** keep the client's paged design and make the server
contract real. Paging belongs on the server for a directory that can grow; the
alternative (revert the client to an array) would leave the 15-row cap and a
dead status filter in place.

**Files**

- `server/src/models/masterdata.repo.ts` — `buildCustomerListQuery` gains
  `status`, `page`, `pageSize`, an `ORDER BY`, `LIMIT/OFFSET`, and a sibling
  `buildCustomerCountQuery` with the identical `WHERE`.
- `server/src/controllers/masterdata.controller.ts` — `get_customers` reads and
  clamps the params (page ≥ 1, pageSize 1–100, default 15; status
  `ACTIVE|INACTIVE|ALL`), applies the same filters/slice to the demo-mode array,
  and returns the envelope.
- `client/src/services/api/inventory.ts` — `getCustomers` adds `status`, and its
  return type becomes **only** the envelope.
- `client/src/features/sales/CustomerMasterDirectory.tsx` — replace the frozen
  `useState(1)` / `useState(15)` with real page state, keep the server total,
  drive `TablePagination` from server values, remove the second client-side
  slicing path, render `loadError`.
- `tests/masterdata.repo.test.ts` — query-builder cases.
- A live-DB HTTP test in the style of the existing suites: envelope shape, page
  2, status filter, branch scope, and a count that matches the filtered set.

**Acceptance**

- With 16+ customers, page 2 returns the next rows and the footer's total is the
  server's filtered total.
- The status filter changes the **server** result (assert the request, not just
  the screen); search and branch still work.
- A fetch failure keeps the last good page visible **and** shows the error.
- After create/update/delete the current page reloads and the App slices refresh
  (the existing `onCustomersChanged`).
- No other caller of `api.getCustomers` exists (grep before changing the type).

**Verify**

```
npx tsc --noEmit
node --import tsx --test tests/masterdata.repo.test.ts
npm test
```

**Risk.** Medium: an HTTP contract change. The only consumer is this screen
(`grep -rn "getCustomers" client/src`), so the blast radius is one file plus its
screen.

---

## DF-02 — Refresh the product catalog after save/re-activation (P1-1)

**Status: `done` (2026-10-24).** The catalog now re-reads after its own saves and on
tab re-activation, keeps the last rows on failure with a visible Retry banner, and
both mounts are pinned by the keep-mounted guard. Live evidence is in
`SESSION_NOTES.md` under "DF-02 shipped".

**Problem.** `ProductManagement` owns a local `catalog` fetched once per branch.
Saves go out through `onCreateProduct`/`onUpdateProduct`/`onDeleteProduct`
props; the component never appends the returned row and never refetches, so the
new/edited product is absent from the list until a branch switch or reload. App
mounts two instances (`all-stock`, `product-master`), each with its own catalog.

**Files**

- `client/src/features/inventory/ProductManagement.tsx` — after a successful
  save, bump a local `catalogVersion` and include it in the catalog effect's
  deps. Also add `useActivationKey(mode)` to the same deps so leaving and
  returning to the tab refetches.
- Optional (only if the remote-staleness case is in scope): a
  `catalogRefreshKey` prop from App, bumped on the `PRODUCTS` SSE domain, so
  another user's product edit reaches the open tab. Do not add a `products`
  prop just to force renders.

**Acceptance**

- Create a product in each of the two tabs: it appears immediately in that
  tab's list without a branch switch or reload.
- Edit and delete behave the same.
- Switching to another tab and back refetches once (no loop).
- `catalogLoadError` is rendered (see DF-11); a failed refetch keeps the old
  rows and shows the notice.

**Verify**

```
npx tsc --noEmit && npm test
```
plus a manual pass in the two tabs.

**Risk.** Low.

---

## DF-03 — One shared serial-register cache (P1-2)

**Status: `done` (2026-10-24).** The app-wide cache lives in
`services/serialRegisterCache.ts` (React hook + singleton) with its pure,
unit-tested core in `services/serialRegisterStore.ts`; App invalidates it from
the SSE burst and every full refresh. Live evidence is in `SESSION_NOTES.md`
under "DF-03 shipped".

**Problem.** Every mounted `StockOperations` instance (App mounts **11**) and
`CreateShipmentForm` fetch `getSerialLogs({all:true})` once behind a
`serialRegisterLoaded` latch and never invalidate it. Seven stock panels and the
dispatch form use that snapshot to decide whether a serial is available. A
received transfer stays "IN_TRANSIT" for the session; a sold serial stays
"IN_STOCK" until the server refuses it.

**Files**

- New `client/src/services/serialRegisterCache.ts` — one in-flight fetch, one
  snapshot, `getSerialRegister()`, `invalidateSerialRegister()`, and a subscribe
  hook used by consumers. Invalidate on every domain that writes `serial_log`:
  `STOCK`, `STOCK_OPERATIONS`, `SERIALS`, `PROCUREMENT`, `SALES`, `SHIPMENTS`,
  `CUSTOMER_DEVICES`, `ASSETS`.
- `client/src/App.tsx` — invalidate from the SSE handler (the same place that
  bumps `registerRefresh`) and from `refreshAllData`.
- `client/src/features/inventory/StockOperations.tsx` — delete the latch; read
  the shared cache and pass it through the context unchanged.
- `client/src/features/procurement/CreateShipmentForm.tsx` — delete its own
  latch; read the same cache.
- New unit test for the cache (dedup, invalidate, late-response discard).

**Acceptance**

- A shipment received by another client/user makes its serials acceptable to
  dispatch without a reload, within one SSE debounce window.
- A serial sold elsewhere no longer appears as available.
- Opening 11 stock tabs produces **one** `GET /api/serial-logs` for the
  register, not 11 (check DevTools or a request counter in the test).
- A failed fetch leaves the previous snapshot and surfaces an error to the
  panels that gate on it (do not silently gate on `[]`).

**Verify**

```
npx tsc --noEmit
node --import tsx --test tests/serialRegisterCache.test.ts
npm test
```

**Risk.** Medium: the gate is safety-relevant. The server remains the authority;
this only removes client-side false refusals/acceptances.

---

## DF-04 — Surface paged-register fetch failures (P1-3)

**Problem.** PO, PI, SI, Returns and Consumables catch a failed page fetch and
render a client-filtered fallback with no notice. The error states exist but are
never rendered. Counts, KPI cards and export are then based on a different row
set than the server query.

**Files**

- `client/src/features/procurement/PurchaseOrders.tsx`
- `client/src/features/procurement/PurchaseInvoices.tsx`
- `client/src/features/sales/SalesInvoices.tsx`
- `client/src/features/sales/ReturnsRegister.tsx`
- `client/src/features/inventory/stockops/ConsumablesRegisterPanel.tsx`

**Solution**

- Render the existing `*LoadError` above the table, using Serial Log's pattern
  (`SerialLogRegister.tsx` renders `loadError` inline): "Could not load this
  page — showing previously fetched rows. Retry".
- Keep the fallback (better than a blank table) but label it as cached.
- Disable "Export all" while the page request is in error, or make the export
  abort with the error instead of silently exporting the visible rows.
- Clear the error on the next successful page fetch.

**Acceptance**

- Force a 500 (or stop the server) while a register is open: the error is
  visible, the last good rows remain, Retry re-runs the page fetch.
- The export button cannot silently emit a partial file.
- Successful fetch removes the notice.

**Verify**

```
npx tsc --noEmit && npm test
```
plus a manual 500 / server-stop pass per register.

**Risk.** Low.

---

## DF-05 — Give `financialSummary` a refresh path (P1-4)

**Problem.** `financialSummary` is computed only in the full bootstrap and has
no `/api/bootstrap/local` key and no domain entry. Another user's sale/payment/
purchase therefore leaves this tab's closing-wizard totals and financial
statements fallback stale until a manual refresh.

**Files**

- `server/src/controllers/bootstrap.controller.ts` — extract the summary
  computation into one function used by `get_bootstrap`, and serve
  `financialSummary` from `get_bootstrapLocal` (`key=financialSummary`) with the
  same branch/FY scope.
- `server/src/models/columnMappings.ts` — no table mapping is needed; document
  the computed key next to `BOOTSTRAP_TABLES`.
- `client/src/App.tsx` — add `financialSummary` to the domains that change it:
  `SALES`, `PROCUREMENT`, `STOCK`, `STOCK_OPERATIONS`, `SHIPMENTS`, `FISCAL`,
  `RECALC`.
- `client/src/features/finance/FiscalYearClosingWizard.tsx`,
  `client/src/features/finance/FinancialStatements.tsx` — consumers already read
  the prop; verify they re-render on the slice update.

**Acceptance**

- Two clients, same branch/FY: A posts a sales invoice; B's closing-wizard
  totals update after the debounce without a manual refresh.
- Switching branch/FY still scopes the summary correctly (no cross-scope paint;
  the C2 gate must accept it).
- Measure the slice cost once (`Server-Timing` / a log) — if it is heavy enough
  to stall a burst, fall back to a dedicated lightweight SQL summary rather than
  re-running the operational-data fetch.

**Verify**

```
npx tsc --noEmit && npm test
```
plus the two-client check above.

**Risk.** Medium: an extra server read on several domains. Confirm cost before
shipping.

---

## DF-06 — Complete the SSE domain coverage (P2-1, P2-2)

**Problem.** `SHIPMENTS` refreshes only `shipments`+`stock` (and only the
`purchaseOrders` register), but receiving writes `transaction_log` rows and
flips `serial_log`. `RECALC` refreshes only `stock`+`assets`, but the admin
endpoints rebuild BS day records and backfill movement-ledger balances.

**Files**

- `client/src/App.tsx` — `SHIPMENTS: ['shipments','stock','transactionLogs']`;
  `RECALC: ['stock','assets','transactionLogs']`; trigger the BS mirror sync when
  a `RECALC` burst arrives (the `BS_CALENDAR` special-case already exists for
  that domain).
- `client/src/utils/registerRefreshDomains.ts` — `SHIPMENTS: ['purchaseOrders',
  'serialLog']`.
- `tests/registerRefreshDomains.test.ts` — pin both additions.

**Acceptance**

- Two clients: A receives a transfer; B's Stock Movement Ledger and Serial Log
  Register show the new rows without a manual refresh.
- A runs *Rebuild BS Calendar Days* / *Backfill Ledger Balances*; B's BS screens
  and movement ledger refresh after the burst.
- Existing mapping tests still pass.

**Verify**

```
npx tsc --noEmit
node --import tsx --test tests/registerRefreshDomains.test.ts
npm test
```

**Risk.** Low–medium: more slices per burst. The debounce already coalesces;
watch one burst in DevTools.

---

## DF-07 — Include the fiscal year in the GET dedup key (P2-3)

**Problem.** `cacheKey` is user + branch + URL. A GET issued after a fiscal-year
switch can join the still-in-flight pre-switch request and receive its body.

**Files**

- `client/src/services/api/http.ts` — add `currentFiscalYearId` to `cacheKey`.
- A unit test with a mocked `fetch`: requests with different FY headers are not
  coalesced; identical ones are.

**Acceptance**

- The test fails on the old key and passes on the new one.
- No request-count regression on ordinary lists.

**Verify**

```
npx tsc --noEmit && node --import tsx --test tests/apiDedup.test.ts && npm test
```

**Risk.** Very low.

---

## DF-08 — Sequence guards for ledgers and opening registers (P2-4, P2-5)

**Problem.** Four screens have no request sequencing: switching party (ledgers)
or fiscal year (opening registers) quickly can let an older response land last
and render the wrong party/year.

**Files**

- `client/src/features/finance/VendorLedger.tsx`
- `client/src/features/finance/CustomerLedger.tsx`
- `client/src/features/finance/OpeningStockManager.tsx`
- `client/src/features/finance/VendorOpeningBalances.tsx`
- Optional shared helper `client/src/utils/latestOnly.ts` (a ref counter +
  `isCurrent()`), unit-tested once and used by all four; prefer this over four
  copies.

**Acceptance**

- With a delayed first response, the second selection wins; the wrong party/FY
  never paints.
- A stale failure does not clear the current rows or show its error.
- Loading settles only for the current request.

**Verify**

```
npx tsc --noEmit
node --import tsx --test tests/latestOnly.test.ts
npm test
```

**Risk.** Low.

---

## DF-09 — Clamp a register page when the row set shrinks (P2-6)

**Problem.** PO/PI/SI/Returns/Serial Log/Consumables keep `page` after a delete
shrinks the total. The next fetch asks for a page that no longer exists, the
table empties, and the footer can show "Showing 76–75 of 60".

**Files**

- The six registers, plus `client/src/components/common/TablePagination.tsx`
  only if a defensive display clamp is wanted (source state must still clamp to
  avoid the empty fetch).
- A pure `clampPage(page, pageCount)` helper test (or extend the pagination
  helper).

**Acceptance**

- Delete the only row on the last page: the register shows the new last page
  and a coherent range; no empty-page fetch loop.
- Changing page size still resets to page 1.
- Server total 0 shows the empty state, not page 0.

**Verify**

```
npx tsc --noEmit && npm test
```
plus a manual delete on a >1-page register.

**Risk.** Low; watch for a clamp effect loop.

---

## DF-10 — BS calendar fallbacks and the BS-date gate (P2-7, P2-8)

**Problem.** Both BS screens silently fall back to the compiled client calendar
on any fetch failure and only refetch on tab activation. The stock-operation
BS-date gate runs once per mount on the **UTC** date, so before 05:45 NPT it
checks yesterday, and it stays locked after an admin seeds the missing month.

**Files**

- `client/src/features/finance/BsCalendarUtility.tsx`
- `client/src/features/finance/NepaliFiscalManagement.tsx`
- `client/src/features/inventory/StockOperations.tsx`
- `client/src/features/inventory/DamagedStockTracking.tsx`

**Solution**

- BS screens: on error, show a persistent notice ("Could not read the calendar
  database — the values below are bundled defaults") and never present the
  fallback as if it came from the server. Refetch on the `BS_CALENDAR` event
  (App already re-reads its mirror) and on activation.
- Gate: extract the `localTodayAD` helper currently local to
  `client/src/features/sales/SalesInvoices.tsx:48` into
  `client/src/utils/localDate.ts`, use it instead of
  `toISOString().split('T')[0]`; re-check on activation and after a
  `BS_CALENDAR` event; show a checking state instead of a stale verdict.

**Acceptance**

- With the server stopped, both BS screens say the calendar could not be read;
  the fallback is labelled.
- Before 05:45 NPT, the gate checks today's local date (test the helper).
- Seed the missing month in another tab/screen, return: the gate unlocks
  without a reload.

**Verify**

```
npx tsc --noEmit && npm test
```
plus a manual timezone check (`TZ=Asia/Kathmandu` unit test for the helper).

**Risk.** Medium: date logic; keep the existing strict fallback (`hasExactBSDayRecord`).

---

## DF-11 — Distinguish "failed to load" from "empty" on setup lists (P2-9)

**Problem.** Category, UoM, Locations and Document Numbering log load failures
to the console and render an empty table. Product Management keeps its error
flags in write-only state. Category/UoM/Locations also discard their loading
flag, so there is no spinner.

**Files**

- `client/src/features/inventory/CategoryManagement.tsx`
- `client/src/features/inventory/UomManagement.tsx`
- `client/src/features/settings/LocationsManagement.tsx`
- `client/src/features/finance/DocumentNumbering.tsx`
- `client/src/features/inventory/ProductManagement.tsx`
- Optional new `client/src/components/common/LoadStateNotice.tsx` shared by the
  five so the copy and Retry behaviour cannot drift.

**Acceptance**

- Stop the server / force a 500: each screen says it could not load and offers
  Retry; it does not imply "0 categories" or "no locations configured".
- Loading shows a spinner/placeholder, not a flash of the empty state.
- A successful Retry clears the notice.
- Product Management's catalog error is actually rendered.

**Verify**

```
npx tsc --noEmit && npm test
```
plus a manual server-stop pass.

**Risk.** Low.

---

## DF-12 — Cleanup (P2-10, P3-1…P3-5)

Independent small items; split into `a/b` if any grows.

1. **Device exchange** — replace `window.location.reload()` with the normal
   refresh path (refetch devices + `refreshAllData`), so other tabs' unsaved
   state survives.
2. **Financial Statements N+1** — one request per branch × FY:
   `branches × 2` on every activation. Add a batch endpoint (or accept and
   document it if the branch count is small; measure first).
3. **Serial fetch dedup** — resolved by DF-03; verify App's 11 instances issue
   one request.
4. **Redundant first fetch** — the page-reset effect runs on mount; skip the
   first run or fold the reset into the filter setters.
5. **`useActivationKey` hardening** — type the key as `NavTab` (or take the tab
   from context) so a typo cannot silently disable refetches; document the
   render-phase ref writes or move to an effect if React's rules complain.
6. **Dead customer device pagination/error state** — remove `devicesPage`/
   `devicesPageSize` and the write-only setters, or wire them; do not leave
   state that suggests paging that does not exist.

**Acceptance**

- No `window.location.reload()` remains in `client/src/features`.
- A failed batch summary fetch still shows the error line.
- `npm test` and `grep -rn "devicesPage" client/src` agree with the chosen
  outcome.

---

## Suggested sequence

Two-week shape, but ship in whatever order you like as long as DF-01 is first:

```
Correctness:   DF-01 → DF-02 → DF-04 → DF-08 → DF-09
Freshness:     DF-03 → DF-06 → DF-07 → DF-05
Polish:        DF-10 → DF-11 → DF-12
```

Rationale: DF-01 is the only page that is outright broken. DF-02/04/08/09 are
self-contained and low-risk. DF-03 and DF-06 both concern shipment-event
freshness but are independent: DF-03 invalidates the shared serial cache from
the existing SSE handler (the `SHIPMENTS` domain already exists), while DF-06
adds the missing slice/register mappings for the other screens — ship either
first. DF-05 needs a cost check before it spreads to every domain. DF-10
benefits from DF-06's calendar handling but does not block on it.

## Definition of done (every task)

- [ ] Every acceptance bullet is true and was exercised the way a user does it.
- [ ] `npx tsc --noEmit` clean.
- [ ] Targeted tests added/updated and passing.
- [ ] `npm test` full suite green, including the docs-count gate.
- [ ] No new source-text-only guard when a pure function could be tested.
- [ ] This file's checkbox + status row updated in the same commit.
- [ ] If the fix changes a documented contract (e.g. `GET /api/customers`),
      README/handoff/API tables updated in the same commit.

## Notes / decisions

- **`GET /api/customers` contract:** paged envelope is the chosen direction
  (DF-01). This changes the response shape; the only client caller is the
  directory screen, and the API wrapper's type is narrowed with it.
- **Client behavioural tests:** there is still no route-tree test suite
  (backlog A6). DF-01, DF-03, DF-07, DF-08 and DF-09 can land with pure-function
  tests; the rest need manual passes. Do not grow the source-text pins instead.
- **Server-side paging** remains the rule for registers; do not reintroduce
  client filtering of whole bootstrap arrays.
- **No new dependencies** are needed for any task in this list.
