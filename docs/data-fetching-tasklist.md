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
| DF-04 | Surface paged-register fetch failures | P1-3 | P1 | `done` | — |
| DF-05 | Give `financialSummary` a refresh path | P1-4 | P1 | `done` | — |
| DF-06 | Complete the SSE domain coverage (shipments, recalculation) | P2-1, P2-2 | P2 | `done` | — |
| DF-07 | Include the fiscal year in the GET dedup key | P2-3 | P2 | `done` | — |
| DF-08 | Sequence guards for ledgers and opening registers | P2-4, P2-5 | P2 | `done` | — |
| DF-09 | Clamp a register page when the row set shrinks | P2-6 | P2 | `done` | — |
| DF-10 | BS calendar fallbacks and the BS-date gate | P2-7, P2-8 | P2 | `done` | DF-06 (for live calendar events) |
| DF-11 | Distinguish "failed to load" from "empty" on setup lists | P2-9 | P2 | `done` | — |
| DF-12 | Cleanup: full reload, N+1 fetches, dead state, dedup of serial fetch | P2-10, P3-1…P3-5 | P2/P3 | `done` | DF-03, DF-05 (soft) |
| DF-13 | Refresh the Financial Statements branch matrix with the live summary | F-1 | P1 | `done` | DF-05, DF-12 |
| DF-14 | Refresh party ledgers on live and local ledger events | F-2 | P2 | `done` | — |
| DF-15 | Distinguish a failed serial lookup from "not in the register" | F-3 | P2 | `done` | — |
| DF-16 | Branch-safe, retryable exchange device read (one shared cache) | F-4 | P2 | `done` | DF-03 (pattern) |
| DF-17 | Silent-read cleanup: settings backfill, sellable serials, permission resync | F-5 | P3 | `done` | — |

Legend: `todo` · `wip` · `blocked` · `done`.

## Post-audit follow-up — TRIM-1 (done 2026-10-25)

The quick-search modal was the last screen filtering whole bootstrap slices in
the browser (products, POs, PIs, shipments, assets, customer devices, stock).
That is bounded only by how much data an install happens to hold; for a
nationwide deployment (12k+ customers and growing, thousands of documents a
year) it is both a startup-weight and a per-keystroke problem.

`GET /api/global-search?q=&branchId=` now answers it: **5 rows per group**, a
hard 2–80 character query window, six independent `LIMIT` reads, and a response
containing only the fields the modal renders. Scope is a server decision — a
branch role is pinned to its own branch (omitting `branchId` cannot widen it;
another branch is `403`), a global role may pass `ALL`, and `x-fiscal-year-id`
scopes the document/asset/device groups. `%` and `_` are escaped before the
LIKE. POs/PIs reuse the B2 `search_text` projection; products, shipments,
assets and customer devices got trigram GIN expression indexes whose
expressions the queries repeat verbatim. The modal debounces 250 ms, discards
superseded responses, and shows a distinct retryable error instead of “no
results”. Suppliers and branches stay local — they are the two small reference
lists the shell already carries.

Evidence: [globalSearch.api.test.ts](../tests/globalSearch.api.test.ts) (real
HTTP + PostgreSQL: 401/400, cap, branch widening + 403, FY scope, wildcard
escaping, genuine miss) and [globalSearchContract.test.ts](../tests/globalSearchContract.test.ts)
(no whole-slice props, no client cap, retryable error, six capped SQL groups,
indexes present). `StockMovementLedger` keeps its no-fetch prop contract.

C4 (one hydration entry point) was assessed in the same pass and parked: the
URL is built in one place and App has a single hydrate path through it (see
[architecture-backlog.md](architecture-backlog.md) §C4).

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

**Status: `done` (2026-10-24).** PO, PI, SI, Returns and Consumables render one
shared `RegisterLoadError` notice above their tables with the real error and a
Retry that re-runs that register's own page fetch. The fallback stays but is
labelled as cached, and the three export paths abort (disabled button +
visible message) instead of silently writing the visible page. Live evidence
is in `SESSION_NOTES.md` under "DF-04 shipped".

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

**Status: `done` (2026-10-24).** One pure rule in
`services/financialSummary.service.ts` feeds both the full bootstrap and a new
aggregate producer behind `GET /api/bootstrap/local?key=financialSummary`;
the slice applies the same branch/FY scope (date-range rows, FY opening
balances, opening stock for past years) without re-running the 24-query
operational fan-out. App re-fetches it for `SALES`, `PROCUREMENT`, `STOCK`,
`STOCK_OPERATIONS`, `SHIPMENTS`, `FISCAL` and `RECALC`. Live evidence and the
cost measurement are in `SESSION_NOTES.md` under "DF-05 shipped".

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

**Status: `done` (2026-10-24); slice superseded by VOL-1 (2026-10-26).**
`SHIPMENTS` refreshed the `transactionLogs` slice (a receipt writes `TRANSFER_IN`
rows) and bumped the `serialLog` register alongside `purchaseOrders`; `RECALC`
refreshed `transactionLogs` and re-read the BS calendar mirror, covering
live-stock and fixed-asset recalculation, the ledger-balance backfill and
*Rebuild BS Calendar Days*. Evidence and suite numbers are in `SESSION_NOTES.md`
under "DF-06 shipped". VOL-1 removed the slice: the three ledger screens read
`/api/transaction-logs` themselves, and the same domains now bump the
`transactionLog` register counter.

**Problem.** `SHIPMENTS` refreshes only `shipments`+`stock` (and only the
`purchaseOrders` register), but receiving writes `transaction_log` rows and
flips `serial_log`. `RECALC` refreshes only `stock`+`assets`, but the admin
endpoints rebuild BS day records and backfill movement-ledger balances.

**Files**

- `client/src/App.tsx` (DF-06 state; VOL-1 removed the slice) —
  `SHIPMENTS` included `transactionLogs`; `RECALC` included `transactionLogs`;
  the BS mirror sync runs when a `RECALC` burst arrives.
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

**Status: `done` (2026-10-24).** `cacheKey` now ends with the active fiscal
year, so a GET issued after a fiscal-year switch can no longer join the
still-in-flight pre-switch request; identical same-scope GETs still coalesce.
Evidence and suite numbers are in `SESSION_NOTES.md` under "DF-07 shipped".

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

**Status: `done` (2026-10-24).** A shared `utils/latestOnly.ts` ticket guard is
held in a ref by `VendorLedger`, `CustomerLedger`, `OpeningStockManager` and
`VendorOpeningBalances`; only the newest request may paint data, raise its
error or settle loading. Evidence and suite numbers are in `SESSION_NOTES.md`
under "DF-08 shipped".

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

**Status: `done` (2026-10-24).** `TablePagination` exports `clampPage` and a
`useServerPageClamp` hook, wired into the six server-paged registers; a
shrinking total snaps the state to the new last page, a zero total stays on
page 1, and page-size changes still reset to page 1. Evidence and suite numbers
are in `SESSION_NOTES.md` under "DF-09 shipped".

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

**Status: `done` (2026-10-24).** Both BS screens keep a `calendarLoadError` and
render a persistent "the values below are bundled defaults, not server data"
notice with Retry; they re-read on the app-wide calendar signal (`bsCalendarRefresh`)
as well as on activation. The stock gate moved into `utils/bsCalendarGate.ts`
(`useBsCalendarGate`, shared by Stock Operations and Damaged Stock Tracking): it
checks the local day (`utils/localDate.ts`, extracted from SalesInvoices), shows
a checking state, re-runs on activation and on the calendar event, and still
falls back to the strict compiled calendar when the server is unreachable.
Evidence and suite numbers are in `SESSION_NOTES.md` under "DF-10 shipped".

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

**Status: `done` (2026-10-24).** New `components/common/LoadStateNotice.tsx` renders
an initial-load spinner or a retryable failure notice; Category, UoM, Locations and
Document Numbering now keep a read loading flag and a `loadError`, retry their own
loader, and their empty slot/header says the list could not be loaded instead of
implying zero rows. Product Management's catalog error was already rendered; its
write-only category error state is removed. Evidence and suite numbers are in
`SESSION_NOTES.md` under "DF-11 shipped".

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

**Status: `done` (2026-10-24).** No `window.location.reload()` left in the
client: device exchange and asset deployment refresh through App's
`refreshAllData` (new `onRefreshData` on the stock-operations context), damage
reversal through App's refreshing reverse handler. Financial Statements makes
one batch request (`GET /api/reports/financial-summaries`) instead of
`branches × 2`, and the report path now shares
`fetchFinancialSummaryFromDb` — which also fixed its missing purchase-return
term. New `utils/useFilterPageReset.ts` snaps a paged register during render,
so a filter change costs one request. `useActivationKey` is typed as `NavTab`.
Dead `devicesPage`/`devicesPageSize` and write-only device state removed.
Evidence and suite numbers are in `SESSION_NOTES.md` under "DF-12 shipped".

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

## Follow-up pass (2026-10-24, after DF-12 and bootstrap trim step 5)

Five findings from the fresh pass in
[data-fetching-audit.md §9](data-fetching-audit.md#9-follow-up-pass--2026-10-24-after-df-12-and-bootstrap-trim-step-5).
They are independent of each other; ship in the order below unless a screen
owner reorders them. DF-13 through DF-17 are done.

## DF-13 — Financial Statements follows the live summary (F-1, P1)

**Status: `done` (2026-10-24).** The batch effect now takes `financialSummary`
as a trigger, and the memoized statement/comparison tables depend on it too, so
the fallback path cannot keep a stale closure. A new `useTabActive` hook keeps
the prop-driven read to the visible tab: a hidden Statements screen no longer
issues a branch × FY batch for every stock edit nobody is looking at, and the
next activation re-runs it. The activation key and Retry still trigger the
batch. Pinned by `tests/df13StatementsRefresh.test.ts`, the `useTabActive`
render test in `tests/keepMountedRenderCount.test.ts`, and the updated Retry
dep pin in `tests/closeoutResiduals.test.ts`.

**Problem.** The per-branch `summaryMap` was fetched only on tab activation
and preferred over the `financialSummary` prop, so DF-05's live value was
hidden behind the activation-time map.

**Fix.** `financialSummary` is a dependency of the batch effect and of both
rendered-table memos; `useTabActive('financial-statements')` skips the read
while the keep-mounted tab is hidden; activation and Retry keep working. The
map is intentionally not cleared on a FY switch: its keys include the FY id,
and clearing it would make the prior-year column fall back to the current
summary while the fresh batch is in flight.

**Acceptance**

- With the statements tab visible, a sale/payment posted from another tab (or
  simulated by replacing the `financialSummary` prop) re-fetches the branch
  pairs and the matrix moves to the new figures.
- A failed re-fetch keeps the last good matrix **and** the error line; Retry
  re-runs it.
- Leaving and re-entering the tab makes one batch request (no loop); a hidden
  tab issues none on a prop change.

**Verify.** `npx tsc --noEmit && npm test`, plus a two-tab manual pass.

**Risk.** Low. The effect already owns cancellation; this adds one dependency.

---

## DF-14 — Party ledgers refresh on ledger events (F-2, P2)

**Status: `done` (2026-10-24).** `VendorLedger` takes
`sseRefreshKey={registerRefresh.purchaseInvoices}`; `CustomerLedger` takes
`sseRefreshKey={registerRefresh.salesInvoices}` and
`returnsRefreshKey={registerRefresh.returnsRegister}`. Both include the key(s)
in the fetch effect, so a procurement/sales/return burst re-reads the selected
party in place. The read stays a no-op with no party selected, and a hidden
keep-mounted tab skips it (`useTabActive`, DF-13's precedent) — the next
activation re-runs it. Pinned by `tests/df14LedgerRefresh.test.ts`;
`registerRefreshDomains.test.ts` now counts the wiring per render site (a
counter can feed two screens) and names the mount-refetch list
`MOUNT_REFETCH_SCREENS`, with the two ledgers positively pinned instead of
banned from carrying a counter.

**Problem.** Both ledgers fetch on party change and tab activation only, and
App passes no refresh key. A payment, reversal or return recorded elsewhere
leaves the closing balance stale until the tab is re-entered. Filters applying
on Load stays by design.

**Fix.** Pass the existing register counters into the two screens
(`purchaseInvoices` for the vendor ledger, `salesInvoices` and
`returnsRegister` for the customer ledger) and include the key in the fetch
effect when a party is selected. Do not refetch when the picker is empty.

**Acceptance**

- With a party selected, a procurement event re-fetches the vendor ledger and a
  sales/return event re-fetches the customer ledger (one request per burst).
- Changing the party or pressing Load still behaves as today.
- No request is issued while no party is selected.

**Verify.** `npx tsc --noEmit && npm test`.

**Risk.** Low; reuses the established register counters.

---

## DF-15 — Failed serial lookup is not "not found" (F-3, P2)

**Status: `done` (2026-10-24).** `DeviceSerialState` gained `lookup-failed`,
rendered in amber as “Could not check the register” with a Retry that re-runs
`resolve`. The catch reads the status `fetchJson` attaches to the rejection:
only 404 sets `not-found`. Both exchange dialogs stop pre-mapping rejections
to `null` — the inline field receives the error, and the submit path stops with
`SERIAL_LOOKUP_FAILED_MESSAGE` on a non-404 instead of inventing a refusal (and
never reports that guess to the audit trail); a real 404 still goes through
`describeReplacementRefusal`. Pinned by `tests/df15SerialLookupFailure.test.ts`
(8 tests: pure classification, Retry re-issues, 404 wording, resolved
PON/MAC and status/branch, and the two dialogs' source wiring).

**Problem.** `DeviceSerialInput` maps a rejected lookup to `not-found`
([DeviceSerialInput.tsx:186-203](../client/src/components/common/DeviceSerialInput.tsx#L186-L203))
and the exchange callers pre-map failures to `null`. A 500/503 therefore reads
"Not in the serial register for this branch" with no Retry.

**Fix.** Add a `lookup-failed` state ("Could not check the register — Retry")
with a Retry that re-runs `resolve`, let the two callers stop swallowing the
rejection, and keep 404 as the only `not-found` path.

**Acceptance**

- A rejected lookup shows the failure state and its Retry; pressing Retry
  re-issues the lookup.
- A real 404 still shows "Not in the serial register for this branch".
- A resolved row still fills PON/MAC and reports status/branch.

**Verify.** `npx tsc --noEmit && npm test`; exercise one exchange form with a
forced lookup failure.

**Risk.** Low, but the state machine gains one branch — update the unit test for
`classifyRegisterRow` if one exists.

---

## DF-16 — Exchange deployed-device read is branch-safe and retryable (F-4, P2)

**Status: `done` (2026-10-24).** A new `exchangeDeviceStore` / React binding
(`useExchangeDevices`) is one shared, per-branch cache fed by
`api.getCustomerDevices`: rows are keyed by branch, so the header switch shows
an empty list until the new branch's own read lands, a failed read clears that
scope (never the previous branch's units) and reports the message, and Retry
re-reads it. Up to 11 mounted hosts now share one request per branch. App
invalidates on `CUSTOMER_DEVICES` / `ASSETS` SSE bursts and every full
refresh, and resets on sign-out. The exchange panel renders `LoadStateNotice`
with the retry, refuses to claim “no devices match” while the read failed, and
refreshes the shared list after a successful exchange instead of fetching it
itself. Pinned by `tests/exchangeDevices.test.ts` (8 store tests + 4 wiring).

**Problem.** The host fetch logs failures only
([StockOperations.tsx:392-405](../client/src/features/inventory/StockOperations.tsx#L392-L405)),
keeps the previous branch's devices on a failed switch, and is duplicated by
every mounted host (up to 11). The exchange counter and picker then present a
stale list as current.

**Fix.** Move the read to one shared per-branch cache (same shape as
`branchStockCache`), clear the rows when the branch changes, and surface a
`LoadStateNotice` with Retry in the exchange panel. Keep the server as the
authority.

**Acceptance**

- Switching the header branch clears the old exchange list immediately; a
  failure shows the notice and leaves an empty, clearly-failed list (never the
  previous branch's units).
- Retry re-reads the new branch.
- Opening several stock hosts produces one request per branch, not one per
  host.

**Verify.** `npx tsc --noEmit && npm test`; two-host manual pass with a forced
failure.

**Risk.** Medium: new shared state plus one context field. Do not change the
exchange mutation itself.

---

## DF-17 — Remaining silent reads (F-5, P3)

**Status: `done` (2026-10-24).** All three surfaces now report a failure with a
Retry: the cached-payload `/api/settings` backfill records its error and renders
a “company settings” notice, while the audit screen's company-wide blind toggle
is disabled and reads `UNKNOWN` until the read succeeds; the sellable-serial
loader clears the previous branch's rows the moment the scope changes, records
its error, and the Sell-to-Customer form renders a retryable notice and refuses
to pin a serial to “not in inventory” when the list is unread; the permission
desync failure is recorded, its notice offers Retry, and Save/Reset stay
disabled until a successful re-read. Pinned by
`tests/df17SilentReads.test.ts` (6 tests). The close-out review below closed
one residual in the same task: a bootstrap that fails after a branch switch
skipped the loader entirely, so the old branch's rows survived; the failure
path now re-reads the new scope through the same clearing loader.

**Problem.** Three failures are still indistinguishable from valid empty data:

1. App's cached-payload settings backfill drops `/api/settings` failures
   ([App.tsx:627-638](../client/src/App.tsx#L627-L638)), so settings silently
   fall back to defaults.
2. The sellable-serial read logs and keeps the previous branch's list
   ([App.tsx:812-824](../client/src/App.tsx#L812-L824)), so the Sell-to-Customer
   form can offer units from the wrong branch.
3. A rejected permission save re-reads the server matrix but swallows a failure
   ([PermissionManagement.tsx:507-514](../client/src/features/settings/PermissionManagement.tsx#L507-L514),
   [:536-541](../client/src/features/settings/PermissionManagement.tsx#L536-L541)),
   leaving the rejected edits on screen as if they might be saved.

**Fix.** Surface each with a retryable message on its own screen (or disable the
control until the read succeeds), and clear branch-scoped lists on a failed
branch change. Keep each change local; this is three small fixes, not a shared
abstraction.

**Acceptance**

- A failed settings backfill shows a settings-unknown notice with Retry; the
  blind-audit toggle cannot silently claim the default.
- A failed sellable-serial read after a branch switch leaves no old-branch rows
  and tells the operator the list is unavailable; Retry repopulates it.
- A rejected permission save whose resync also fails says the server matrix is
  unknown and keeps Save disabled until a successful re-read.

**Verify.** `npx tsc --noEmit && npm test`; force each read failure.

**Risk.** Low, three independent surfaces.

---

## Close-out review (2026-10-24)

All twelve tasks are `done` and on `main`. Each shipped as its own commit
(`7b7d8ff` DF-01 … `7d3228a` DF-12) with a green `typecheck-and-test` run on
its exact head — twelve consecutive successes, including typecheck, the full
suite against the PostgreSQL service container, the fresh-install schema-parity
boot, both convention guards, the production builds, the bundle budget and
`npm audit`. The suite closed at **1104 tests, 0 fail** (2 Windows-only skips).

Cross-checks run for this review:

- The five paged registers each carry `RegisterLoadError`, `useServerPageClamp`
  and `useFilterPageReset`; no register still runs the mount-era page-reset
  effect.
- `grep -rn "window.location.reload" client/src` returns only prose; every
  `StockOperations` host passes `onRefreshData`.
- `getFinancialSummary` is no longer called for the statements matrix; the
  batch path and the JSON shape agree with the single read (live test).
- Server `DOMAIN_BY_MODULE` and client `DOMAIN_REGISTER_KEYS` still agree on
  the `SHIPMENTS` / `RECALC` / `BS_CALENDAR` domains DF-06 and DF-10 added.
- `GET /api/customers`' paged envelope is documented in both README and
  handoff, and no other caller expects the old bare array.

### Residuals — all closed after the review

1. **Locations default branch.** `LocationsManagement` takes `currentUser`; a
   new location defaults to the user's own branch whenever the master list has
   it, follows the list as the bootstrap arrives, and never overwrites an
   explicit pick. `tests/locationDefaults.test.ts` (6 tests).
2. **BS health-panel sequence guard.** The integrity read takes a latest-only
   ticket, so a slow older response can neither paint the report nor settle the
   spinner, and a repair invalidates reads already in flight.
   `tests/closeoutResiduals.test.ts` plus the shared guard's own tests.
3. **Customer-device stale rows.** Both customer screens keep their last rows
   on a failed device read but now say so through the shared load notice, with
   a Retry that re-runs the read (the directory's copy names the assigned-
   hardware counts specifically). Same test file.
4. **Sequential batch pairs.** The reports batch runs its branch × FY pairs
   through the new bounded `mapWithConcurrency` (3 at a time, order
   preserved), instead of one after another — kept bounded so nine aggregate
   queries per pair cannot monopolise the 20-connection pool.
   `tests/mapWithConcurrency.test.ts`.

A follow-up pass over those screens found two missed states and fixed them:
the statements batch error now has its own Retry (and disables while the batch
runs), and the customer device register's empty row says the read failed
instead of "no matching devices" — the notice now sits above the stat cards it
explains, and CSV export is disabled while the read is in error. The
directory's hardware-count notice moved above its summary cards for the same
reason. All pinned in `tests/closeoutResiduals.test.ts`.

A single read without `fiscalYearId` still resolves the current FY — matching
both the bootstrap slice and the client, which always sends one.

---

## Follow-up close-out review — DF-13…DF-17 (2026-10-24)

All five follow-ups are `done` and on `main` (`7b842ab` DF-13, `d14544d`
DF-14…DF-17) with green `typecheck-and-test` runs. This review re-read every
acceptance bullet against the shipped code, re-ran `npx tsc --noEmit`, the five
task test files and the full suite, and checked the docs and guards for claims
that no longer describe the code.

Cross-checks that held:

- Statements: `financialSummary` is a dependency of the batch effect **and**
  both rendered-table memos; a hidden tab issues no batch; a failed batch keeps
  the last map with its error and Retry.
- Ledgers: App passes the purchase-invoice counter to the vendor ledger and the
  sales + returns counters to the customer ledger; both skip empty pickers and
  hidden tabs and keep the DF-08 latest-only guard.
- Serial lookup: only a 404 sets `not-found`; `lookup-failed` owns the Retry;
  both exchange dialogs stop on a non-404 without writing an audit refusal.
- Exchange devices: one store instance, one read per branch scope across the 11
  `StockOperations` hosts; a failed scope is empty with a notice and Retry; App
  invalidates on `CUSTOMER_DEVICES`/`ASSETS` and resets on sign-out.
- Silent reads: the settings notice and `UNKNOWN` toggle, the sellable-list
  notice and gate, and the permission resync/Save-disabled path all render the
  states their tasks describe; the resync matrix propagates through the
  existing permissions event.
- Guards/docs: the register guard's header now says 66 screens / 13
  mount-refetch entries (it still said 65 / 12 and the pre-DF-14 constant name),
  the screen-count claims in `handoff.md` (66 total, 55 table, 11 elsewhere)
  still match, and the audit's “found sound” section no longer implies the
  ledgers lack refresh triggers.

Residual closed in this review:

1. **Sellable serials on a failed bootstrap.** The successful bootstrap path
   called `loadSellableSerials`, which is what clears the previous branch's
   rows; a failed bootstrap skipped it, so the original DF-17 symptom survived
   in that path. `refreshAllData`'s non-401 catch now calls the same loader when
   the branch scope differs, which clears first and then either repopulates or
   shows its own retryable error. Pinned by two added assertions in
   `tests/df17SilentReads.test.ts` (not a new test, so the suite stays at
   **1147 tests**).

## Suggested sequence

Two-week shape, but ship in whatever order you like as long as DF-01 is first:

```
Correctness:   DF-01 → DF-02 → DF-04 → DF-08 → DF-09
Freshness:     DF-03 → DF-06 → DF-07 → DF-05
Polish:        DF-10 → DF-11 → DF-12
Follow-up:     DF-13 → DF-14 → DF-15 → DF-16 → DF-17
```

The follow-up line is the 2026-10-24 fresh pass: DF-13 first because it was the
one remaining place where DF-05's live summary is fetched and then shadowed,
then DF-14; the rest are independent and can ship in any order.

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
