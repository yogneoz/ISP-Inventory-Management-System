# Data-fetching audit — every page

_2026-10-24 · HEAD `930cf8c` · read-only audit; no code changed._

**Working checklist and status: [data-fetching-tasklist.md](data-fetching-tasklist.md)** —
twelve shippable tasks (DF-01…DF-12) with solutions, files, acceptance
criteria and the suggested order. Update that file as fixes land; this audit
stays the evidence and rationale.

Scope: how every screen gets its data, when it re-fetches, what it does when a
fetch fails, and whether a mutation elsewhere in the app (same tab or another
client) can leave it showing old rows. Server handlers were read only to
confirm what a client call actually receives.

**Headline:** one page is empty right now because its client expects a paged
envelope the server has never returned (**P0**), one setup page goes stale after
every save, the serial-availability gates use a session-old snapshot, and the
paged registers silently substitute partial data when their fetch fails. The
shared bootstrap / SSE machinery (C1/C2 gate, sequence guards, reconnect
gap-fill, multi-tab relay) is in good shape.

Method: static code-path tracing of every `api.*` call site plus the four data
paths below. No live browser session was run for this audit; each finding names
the exact lines that prove it, and the P0 is reproduced by code inspection only
(see its "Verify" line).

---

## 1. How data reaches a screen

There are five paths. Which one a screen uses decides what can make it stale.

| # | Path | Trigger | Who refreshes it |
|---|------|---------|-------------------|
| 1 | **Full bootstrap** `/api/bootstrap` | mount, branch/FY switch, every App mutation handler, SSE fallback | `refreshAllData()` ([App.tsx:763](../client/src/App.tsx#L763)) |
| 2 | **Deferred slices** `purchaseOrders`, `purchaseInvoices`, `stockOperations` | right after every full bootstrap | `hydrateDeferredSlices` ([App.tsx:701](../client/src/App.tsx#L701)) and targeted SSE |
| 3 | **Targeted slice** `/api/bootstrap/local?key=…` | SSE domain event | `fetchBootstrapSlice` + C2 gate ([App.tsx:663](../client/src/App.tsx#L663)) |
| 4 | **Self-fetching paged register** (PO, PI, SI, returns, serial log, consumables) | filters/page change, `sseRefreshKey`, local `*RefreshKey` | the domain → register mapping ([registerRefreshDomains.ts:57](../client/src/utils/registerRefreshDomains.ts#L57)) |
| 5 | **Self-fetching screen** (ledgers, opening registers, setup lists, BS calendar) | `useActivationKey(tab)` / selection / filter + Load | refetches when the tab is re-activated, and nowhere else |

Path 5 is the weak one: a keep-mounted tab does not remount, so an
activation-keyed screen is deliberately frozen while it is visible. That is
fine for slow-moving configuration, but it means any screen on path 5 that
another user can change live needs either an SSE key or an explicit refresh.

---

## 2. P0 — broken now

### P0-1. Customer Master Directory always renders zero customers

**Fixed by DF-01 (2026-10-24).** The server now returns and honours the paged
envelope, and the screen pages, filters, exports and reports load errors against
it. See [data-fetching-tasklist.md](data-fetching-tasklist.md#df-01--restore-the-customer-master-directory-p0).
The findings below are the pre-fix evidence.

The client switched to a paged envelope on 2026-10-05 (`d53cc8d`) but the server
endpoint still returns a bare array.

- Client asks for a page and reads `.data`:
  [CustomerMasterDirectory.tsx:255-256](../client/src/features/sales/CustomerMasterDirectory.tsx#L255-L256)
  (page/pageSize frozen at `1`/`15`),
  [:273-282](../client/src/features/sales/CustomerMasterDirectory.tsx#L273-L282)
  (`setCustomersRows((envelope as { data?: … }).data || [])`).
- `getCustomers` does not normalise the response, it returns whatever
  `fetchJson` parsed:
  [inventory.ts:334-356](../client/src/services/api/inventory.ts#L334-L356).
- The handler answers `res.json(r.rows)` — an **array** — and the demo-mode
  branch answers `res.json(list)`, also an array:
  [masterdata.controller.ts:477-484](../server/src/controllers/masterdata.controller.ts#L477-L484),
  [:517](../server/src/controllers/masterdata.controller.ts#L517).
- `array.data` is `undefined`, so `customersRows` is always `[]`; the table
  renders "No Customer Records Found"
  ([CustomerMasterDirectory.tsx:530-540](../client/src/features/sales/CustomerMasterDirectory.tsx#L530-L540))
  and every KPI on the page reads 0.
- The page/pageSize/status parameters are all ignored server-side
  (`buildCustomerListQuery` reads only `branchId` and `query`:
  [masterdata.repo.ts:236-255](../server/src/models/masterdata.repo.ts#L236-L255)),
  so the status filter is a no-op even once rows appear.

There is no fallback prop: App passes only `branches`, `currentUser`,
`refreshKey`, `onCustomersChanged`, navigation callbacks
([App.tsx:1985-1995](../client/src/App.tsx#L1985-L1995)).

**Impact:** the customer master is unusable; create/update/delete succeed but
the list stays empty. The Sell-to-Customer picker is unaffected (it reads the
bootstrap `customers` slice).

**Fix shape:** pick one contract. Simplest: make the server paged
(`page`, `pageSize`, `status` → `{ data, page, pageSize, totalItems }`, one
`COUNT(*)` + `LIMIT/OFFSET`) and delete the frozen page state on the client;
or keep the array and revert the client to it. Do not keep both.

**Verify:** one authenticated `GET /api/customers?page=1&pageSize=15` while the
dev server runs — the body should be the envelope, then the screen should list
rows.

---

## 3. P1 — stale or misleading in normal use

### P1-1. Product Master Catalog does not show a product you just saved

`ProductManagement` owns a local `catalog` fetched once per branch
([ProductManagement.tsx:166-190](../client/src/features/inventory/ProductManagement.tsx#L166-L190),
deps `[selectedBranchId]`). Save goes out through the parent's handler
([:386-390](../client/src/features/inventory/ProductManagement.tsx#L386-L390));
the parent refreshes the bootstrap but passes no product list back
([App.tsx:1783-1792](../client/src/App.tsx#L1783-L1792),
[:1796-1805](../client/src/App.tsx#L1796-L1805)). The component neither appends
the saved row nor refetches. The new/edited product appears only after a branch
switch or a reload — and the `all-stock` view uses a second instance with its
own stale catalog.

**Fix shape:** refetch the catalog after a successful save (an `onSaved`
callback that bumps a local `refreshKey`), or append the returned record the
way Category/UoM do. Do not add a `products` prop back just to force renders.

### P1-2. Serial-availability gates run on a mount-once snapshot

`StockOperations` loads `serial_log` once per component instance and never
invalidates it:

- [StockOperations.tsx:143-153](../client/src/features/inventory/StockOperations.tsx#L143-L153)
  (`serialRegisterLoaded` latch, `[]` deps) — App mounts **11** instances of
  this host.
- [CreateShipmentForm.tsx:73-81](../client/src/features/procurement/CreateShipmentForm.tsx#L73-L81)
  has its own copy of the same latch.

Those rows are the client-side availability check for product sale, pullout,
transfer, damage labelling, asset assignment, device exchange and shipment
dispatch (all panels consume `serialRegister` from the context:
[ProductSalePanel.tsx:30](../client/src/features/inventory/stockops/ProductSalePanel.tsx#L30),
[CreateTransferPanel.tsx:25](../client/src/features/inventory/stockops/CreateTransferPanel.tsx#L25),
[AssignAssetPanel.tsx:31](../client/src/features/inventory/stockops/AssignAssetPanel.tsx#L31)).

`sseRefreshKey` is passed to the host but only the Consumables Register consumes
it ([ConsumablesRegisterPanel.tsx:151](../client/src/features/inventory/stockops/ConsumablesRegisterPanel.tsx#L151)),
so a received transfer stays "IN_TRANSIT" in that cache for the session: the
dispatch forms refuse a serial that is physically on the shelf, with no way to
recover short of a reload. A sold serial stays "IN_STOCK" until the server
rejects the second attempt.

**Fix shape:** one shared `serial_log` snapshot (or none) + invalidate it on
`SERIALS`, `SHIPMENTS`, `STOCK`, `STOCK_OPERATIONS`, `CUSTOMER_DEVICES`,
`ASSETS`, `SALES`, `PROCUREMENT` via the existing counters; keep the server as
the authority.

### P1-3. Paged registers silently substitute partial data on failure

PO, PI, SI, Returns and Consumables all catch a failed page fetch and render a
client-filtered fallback instead of the server page — with no notice:

- [PurchaseOrders.tsx:179-190](../client/src/features/procurement/PurchaseOrders.tsx#L179-L190)
- [PurchaseInvoices.tsx:199-210](../client/src/features/procurement/PurchaseInvoices.tsx#L199-L210)
- [SalesInvoices.tsx:597-610](../client/src/features/sales/SalesInvoices.tsx#L597-L610)
- [ReturnsRegister.tsx:339-340](../client/src/features/sales/ReturnsRegister.tsx#L339-L340)
- [ConsumablesRegisterPanel.tsx:160-161](../client/src/features/inventory/stockops/ConsumablesRegisterPanel.tsx#L160-L161)

`poLoadError` / `piLoadError` / `siLoadError` / `retLoadError` /
`consumableRegisterError` are only used to choose the fallback, never rendered.
The fallback is filtered from the deferred bootstrap slice, whose row set and
ordering need not match the server query, so counts, KPI cards and "Showing X–Y
of Z" can all be wrong while looking current. The PO export inherits the same
fallback and exports just the rows on screen when the export-all request fails
([PurchaseOrders.tsx:214-227](../client/src/features/procurement/PurchaseOrders.tsx#L214-L227)).

Serial Log does this correctly: it renders `loadError`
([SerialLogRegister.tsx:604](../client/src/features/inventory/SerialLogRegister.tsx#L604)).
The fix is to reuse that pattern: one error line above the table (and disable
export-all) whenever the page fetch failed.

### P1-4. `financialSummary` has no realtime refresh path

`financialSummary` is computed only inside the full bootstrap
([bootstrap.controller.ts:134-172](../server/src/controllers/bootstrap.controller.ts#L134-L172)).
It is not in `BOOTSTRAP_TABLES`
([columnMappings.ts:58](../server/src/models/columnMappings.ts#L58)), so
`/api/bootstrap/local?key=financialSummary` throws, and no client domain lists
it ([App.tsx:922-955](../client/src/App.tsx#L922-L955)). When **another** user
posts a sale, payment or purchase, this tab's
[Fiscal Year Closing Wizard](../client/src/features/finance/FiscalYearClosingWizard.tsx#L237)
totals and the Financial Statements fallback
([FinancialStatements.tsx:241](../client/src/features/finance/FinancialStatements.tsx#L241))
stay at their old values until a manual full refresh. Locally performed
mutations are fine because App handlers call `refreshAllData()`.

**Fix shape:** either a `financialSummary` slice on `/api/bootstrap/local`
(compute it server-side from the same query the bootstrap uses) and add it to
every domain that affects it, or have those two screens fetch
`/api/reports/financial-summary` themselves on activation/SSE instead of
trusting a bootstrap-only prop.

---

## 4. P2 — races and silent degradation

1. **Shipment receipt does not refresh two ledgers it writes.**
   `SHIPMENTS` maps to `['shipments','stock']`
   ([App.tsx:933](../client/src/App.tsx#L933)) and, for registers, only
   `purchaseOrders`
   ([registerRefreshDomains.ts:57](../client/src/utils/registerRefreshDomains.ts#L57)).
   Receiving a transfer writes `TRANSFER_IN` transaction rows and flips
   serials `IN_TRANSIT → IN_STOCK`
   ([shipments.controller.ts:560-619](../server/src/controllers/shipments.controller.ts#L560-L619)).
   The Stock Movement Ledger and Serial Log Register therefore stay stale after
   another client receives a shipment.

2. **Recalculation domain covers only stock + assets.**
   `RECALC: ['stock','assets']`
   ([App.tsx:942](../client/src/App.tsx#L942)). The admin endpoints log
   `SYSTEM` → `RECALC`, including *Rebuild BS Calendar Days*
   ([admin.controller.ts:552](../server/src/controllers/admin.controller.ts#L552))
   and *Backfill Ledger Balances*
   ([:502](../server/src/controllers/admin.controller.ts#L502)). So an open BS
   calendar keeps its old day table, and the movement ledger keeps its old
   before/after balances, even though the server rebuilt them. `BS_CALENDAR`
   and `transactionLogs` are missing from the `RECALC` list.

3. **GET dedup can serve pre-mutation / previous-FY data.**
   `cacheKey` includes user and branch but not the fiscal-year header
   ([http.ts:102](../client/src/services/api/http.ts#L102)). A GET issued
   immediately after a mutation (or after a FY switch) joins the still-in-flight
   pre-mutation request and receives its body. The `finally` only removes the
   entry after it settles, so this is a real window, not a cache.

4. **Party ledgers can paint the previous party.**
   `VendorLedger` / `CustomerLedger` have no sequence guard
   ([VendorLedger.tsx:37-62](../client/src/features/finance/VendorLedger.tsx#L37-L62),
   [CustomerLedger.tsx:37-62](../client/src/features/finance/CustomerLedger.tsx#L37-L62)).
   Selecting supplier A then B quickly, A's slower response can land last and
   render A's rows under B's name.

5. **Opening registers can paint the previous fiscal year.**
   Same missing guard after a quick FY switch
   ([OpeningStockManager.tsx:119-136](../client/src/features/finance/OpeningStockManager.tsx#L119-L136),
   [VendorOpeningBalances.tsx:100-117](../client/src/features/finance/VendorOpeningBalances.tsx#L100-L117)).
   An older response resolves after the newer one and overwrites it.

6. **Registers keep a page that no longer exists.**
   None of the paged registers clamps `page` when `totalItems` shrinks after a
   delete (no `setXPage(Math.min(...))` exists; `TablePagination` does not clamp
   either — [TablePagination.tsx:111-115](../client/src/components/common/TablePagination.tsx#L111-L115)).
   Delete the last row on page 3 and the next fetch asks for page 3, gets `[]`,
   and the footer shows a `rangeStart` past `rangeEnd` ("Showing 76–75 of 60")
   until the operator clicks back.

7. **BS Calendar screens hide fetch failures behind a different dataset.**
   On any error both screens fall back to the compiled client calendar
   ([BsCalendarUtility.tsx:197](../client/src/features/finance/BsCalendarUtility.tsx#L197),
   [:207](../client/src/features/finance/BsCalendarUtility.tsx#L207),
   [NepaliFiscalManagement.tsx:184](../client/src/features/finance/NepaliFiscalManagement.tsx#L184),
   [:194](../client/src/features/finance/NepaliFiscalManagement.tsx#L194)).
   The operator cannot tell "database empty/failed" from "calendar really looks
   like this", and can seed/edit against the fallback. They also only refetch on
   tab activation, so a `BS_CALENDAR` event from another admin updates App's
   in-memory mirror but not these screens' year/day tables.

8. **The BS-date gate is checked once per mount, on the UTC date.**
   [StockOperations.tsx:193-208](../client/src/features/inventory/StockOperations.tsx#L193-L208)
   and [DamagedStockTracking.tsx:97-110](../client/src/features/inventory/DamagedStockTracking.tsx#L97-L110)
   compute "today" with `new Date().toISOString().split('T')[0]` and run in a
   `[]` effect. Before 05:45 NPT that is yesterday's AD date; after a midnight
   rollover, or after an admin seeds the missing month, the gate keeps its
   initial verdict until a reload. A correct local-date helper (`localTodayAD`)
   already exists, but it is private to
   [SalesInvoices.tsx:48](../client/src/features/sales/SalesInvoices.tsx#L48);
   the gate has to share it instead of using the UTC slice.

9. **Setup screens cannot distinguish "empty" from "failed".**
   Category, UoM, Locations and Document Numbering log the load failure to the
   console and render an empty table with no message
   ([CategoryManagement.tsx:42-48](../client/src/features/inventory/CategoryManagement.tsx#L42-L48),
   [UomManagement.tsx:35-41](../client/src/features/inventory/UomManagement.tsx#L35-L41),
   [LocationsManagement.tsx:42-49](../client/src/features/settings/LocationsManagement.tsx#L42-L49),
   [DocumentNumbering.tsx:53-58](../client/src/features/finance/DocumentNumbering.tsx#L53-L58)).
   In Category/UoM/Locations the `loading` state is destructured as
   `[, setLoading]`, so there is not even a spinner. Product Management keeps
   `catalogLoadError`/`categoryLoadError` in write-only holes
   ([ProductManagement.tsx:155](../client/src/features/inventory/ProductManagement.tsx#L155),
   [:163](../client/src/features/inventory/ProductManagement.tsx#L163)).

10. **Device exchange reloads the whole page.**
    After a successful exchange the panel refetches devices, then calls
    `window.location.reload()`
    ([DeviceExchangePanel.tsx:132-137](../client/src/features/inventory/stockops/DeviceExchangePanel.tsx#L132-L137)).
    That discards unsaved form state in every other keep-mounted tab and proves
    the normal refresh path is not trusted for this mutation.

---

## 5. P3 — efficiency and hygiene

1. **N+1 financial fetches.** Financial Statements issues
   `branches × fiscal-years` requests (two FYs) on every activation
   ([FinancialStatements.tsx:206-228](../client/src/features/finance/FinancialStatements.tsx#L206-L228)).
   One per-branch server endpoint (or one request with all branch ids) removes
   the fan-out.
2. **Eleven serial-register downloads per session.**
   Every mounted `StockOperations` instance fetches `getSerialLogs({all:true})`
   once ([StockOperations.tsx:150](../client/src/features/inventory/StockOperations.tsx#L150));
   App mounts 11 hosts. Move the fetch to App/a shared cache (which P1-2 needs
   anyway).
3. **Redundant first fetch on paged registers.** The "filter change resets the
   page" effect runs on mount too, so a register fetches page 1, then fetches
   page 1 again when the reset settles
   ([SalesInvoices.tsx:197-207](../client/src/features/sales/SalesInvoices.tsx#L197-L207)).
4. **`useActivationKey` mutates refs during render and keys on a string.**
   ([KeepMounted.tsx:132-150](../client/src/components/common/KeepMounted.tsx#L132-L150)).
   A typo in the tab-key literal silently disables every refetch for that screen
   (there are 11 call sites); the render-phase ref writes are fragile under
   concurrent rendering even though they behave today.
5. **Dead pagination/error state for customer devices.**
   `devicesPage`/`devicesPageSize` are never set, and the total/error setters are
   write-only
   ([CustomersManagement.tsx:110-114](../client/src/features/sales/CustomersManagement.tsx#L110-L114),
   [CustomerMasterDirectory.tsx:300-330](../client/src/features/sales/CustomerMasterDirectory.tsx#L300-L330)).
   Either wire them or remove them.

---

## 6. What is verified correct

Worth keeping intact while fixing the above:

- **C1/C2 hydration gate** — per-slice status, stale-scope discard, version
  monotonicity ([bootstrapSlices.ts](../client/src/services/bootstrapSlices.ts)).
- **Sequence guards** in PO, PI, SI, Returns, Serial Log, Consumables and Audit
  Trail; superseded responses never paint.
- **Explicit error rendering** in Serial Log, both ledgers, opening registers,
  BS integrity panel, Audit Trail and Financial Statements.
- **Reconnect gap-fill** — `/api/sync/version` polling, `CONNECTED` version
  comparison, exponential backoff with jitter, multi-tab relay
  ([sync.ts](../client/src/services/api/sync.ts)).
- **Branch/date scoping** is server-side for every paged endpoint (registers no
  longer filter a giant prop array).

---

## 7. Per-page matrix

Legend: **props** = bootstrap slice; **deferred** = slice hydrated after
bootstrap; **paged** = path 4; **self** = path 5; **form** = no read of its own.

| Tab / screen | Data path | Verdict |
|---|---|---|
| Executive Dashboard | props (stock, products, POs, shipments, logs, assets) | Live via targeted slices. `financialSummary` prop is unused here. |
| Global search, notifications, help | props / static | Hydration only; no defect found. |
| All Available Stock, Branch Stock | props stock/products | Fine. |
| Stock Movement Ledger | props transactionLogs + ops/damage | Fixed by DF-06: `SHIPMENTS` and `RECALC` refresh `transactionLogs`. |
| Physical Stock Audit | props stock + appSettings | Fine. |
| Reorder Stock, Stock Valuation, Warranty, Asset Deployments | props | Fine. |
| Import / Export Stock | props | Fine. |
| Serial Log Register | paged | Seq + error correct; page clamp missing (P2-6). Shipment-receipt refresh fixed by DF-06. |
| Product Master Catalog | self catalog | Stale after every save (P1-1); error state dead (P2-9). |
| Category / UoM Management | self list | Silent failure, no loading UI (P2-9). |
| Customer Master Directory | self paged | **P0: always empty**; status filter ignored. |
| Customer Device Serials | self devices + props customers | No paging defect (endpoint is unpaged) but dead page/error state (P3-5). |
| Locations | self list | Silent failure (P2-9); default branch captured before branches load. |
| Device Exchange | StockOperations host | Mount-once serial snapshot (P1-2); full page reload (P2-10). |
| Purchase Orders, Purchase Invoices | paged | Guards fine; silent fallback (P1-3); page clamp (P2-6). |
| Purchase / Sales Returns Register | paged | Same as above. |
| Sales Invoices | paged | Same as above. |
| Consumables Register | paged | Same; also depends on the shared serial cache for its form host. |
| Create PO / Purchase Invoice / Sales Invoice / Returns | form | Derived from props; no defect found beyond the stale supplier/branch sync notes. |
| Create Shipment / Create Transfer / Pullout / Damage Label / Product Sale / Assign Asset | form + `serialRegister` | Validation uses the session-old snapshot (P1-2). |
| Shipment Register, Receive Inbound, Asset Deployments, Suppliers | props | Fine (host refreshes via `refreshAllData`). |
| Financial Statements | self (direct `getFinancialSummary`) | Cancel flag + error are correct; N+1 requests (P3-1); summary prop stale cross-client (P1-4). |
| Vendor / Customer Ledger | self | Party-switch race (P2-4); filters apply on Load by design. |
| Opening Stock, Vendor Opening Balances | self | FY-switch race (P2-5). |
| VAT Register, Fixed Asset Register, Depreciation Schedule, Fiscal Year Closing | props | Closing-wizard totals depend on the stale financial summary (P1-4). |
| Document Numbering Setup | self list | Silent failure (P2-9). |
| BS Calendar Utility, Nepali Fiscal & BS Calendar | self | Silent fallback to compiled calendar; no live BS event refresh (P2-7). |
| BS Calendar health panel | self | Error surfaced correctly; no sequence guard (minor). |
| Audit Activities Log | props + debounced serial fetch | Seq guard + error correct. |
| Company Setup, Users, Permissions, Branches, Approvals, Clear Demo Data | props / mutation handlers | Fine; permission save re-reads the server matrix on failure. |
| Data Recalculation & Repair | mutations + `onRefreshData` | Local refresh correct; other clients' movement ledger and BS mirror now follow `RECALC` (DF-06). |

---

## 8. Suggested fix order

One commit per batch, and each batch should leave `npm test` + the docs gate
green. No batch needs a dependency.

1. **P0** — settle the `/api/customers` contract (server paged envelope) and
   rewire the directory to the real page/total/status params. Add a repo test
   for the query builder + one HTTP test for the envelope. This is the only
   page that is outright broken.
2. **P1-1** — refresh the product catalog after save (local `refreshKey`
   bumped by the save handler).
3. **P1-2** — one shared serial-register cache, re-fetched from the existing
   domain counters; stop each host fetching its own copy.
4. **P1-3** — render the fetch error above each paged register; disable
   export-all while the page request is in error. Reuse Serial Log's pattern.
5. **P1-4** — a `financialSummary` slice (server + client) or a self-fetch in
   the two consumers, then add it to the owning domains.
6. **P2-1/P2-2** — extend the domain maps: `SHIPMENTS → transactionLogs,
   serialLog`; `RECALC → transactionLogs, BS_CALENDAR`; add BS calendar
   handling to the RECALC branch. Then a mapping test (extend
   `registerRefreshDomains.test.ts`) that fails when a domain's writes are not
   covered. **Landed as DF-06 (2026-10-24):** `SHIPMENTS` refreshes
   `transactionLogs` plus the `serialLog`/`purchaseOrders` registers, and
   `RECALC` refreshes `transactionLogs` and re-reads the BS mirror. Live
   calendar events for the BS screens themselves remain DF-10.
7. **P2-3** — fiscal year in `cacheKey` (one line) plus a unit test for the
   dedup key.
8. **P2-4/P2-5** — sequence guards in the two ledgers and the two opening
   registers (copy the `useRef` + `seq !== ref.current` pattern from
   `SerialLogRegister`).
9. **P2-6** — clamp the page when `pageCount < page` inside each register.
10. **P2-7/P2-8/P2-9** — replace the silent fallbacks with a visible notice and
    a refresh action; use `localTodayAD()`; surface load errors in the setup
    lists.

Anything that touches the client today is pinned only by source-text guards —
there is no behavioural client test suite (backlog item **A6**). The safest
order is P0/P1 first, with small reflector tests where a pure function exists
(customer query builder, domain map, dedup key), rather than growing the pin
files.

---

## Appendix — commands used

```
ls client/src/features
grep -rc "api\.[a-zA-Z]*(" --include=*.tsx client/src/features
grep -rn "useEffect" --include=*.tsx client/src/features
grep -rn "sseRefreshKey|RefreshKey" client/src/features
git blame -L 268,282 client/src/features/sales/CustomerMasterDirectory.tsx
git show d53cc8d -- server/src/controllers/masterdata.controller.ts
```

Server handlers read for contract checks: `masterdata.controller.ts`
(`get_customers`), `bootstrap.controller.ts` (`get_bootstrap`,
`get_bootstrapLocal`), `columnMappings.ts` (`BOOTSTRAP_TABLES`),
`admin.controller.ts` (recalculation audit modules), `shipments.controller.ts`
(receipt writes).
