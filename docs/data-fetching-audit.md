# Data-fetching audit — every page

_2026-10-24 · HEAD `930cf8c` · read-only audit; no code changed._

**Working checklist and status: [data-fetching-tasklist.md](data-fetching-tasklist.md)** —
the original twelve tasks (DF-01…DF-12) plus the five from the 2026-10-24
follow-up pass (DF-13…DF-17), with solutions, files, acceptance criteria and
the suggested order. Update that file as fixes land; this audit stays the
evidence and rationale.

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
   **Fixed by DF-07 (2026-10-24) for the fiscal-year half.**
   `cacheKey` includes user and branch but not the fiscal-year header
   ([http.ts:102](../client/src/services/api/http.ts#L102)). A GET issued
   immediately after a mutation (or after a FY switch) joins the still-in-flight
   pre-mutation request and receives its body. The `finally` only removes the
   entry after it settles, so this is a real window, not a cache.

4. **Party ledgers can paint the previous party.**
   **Fixed by DF-08 (2026-10-24).**
   `VendorLedger` / `CustomerLedger` had no sequence guard
   ([VendorLedger.tsx:37-62](../client/src/features/finance/VendorLedger.tsx#L37-L62),
   [CustomerLedger.tsx:37-62](../client/src/features/finance/CustomerLedger.tsx#L37-L62)).
   Selecting supplier A then B quickly, A's slower response can land last and
   render A's rows under B's name.

5. **Opening registers can paint the previous fiscal year.**
   **Fixed by DF-08 (2026-10-24).**
   Same missing guard after a quick FY switch
   ([OpeningStockManager.tsx:119-136](../client/src/features/finance/OpeningStockManager.tsx#L119-L136),
   [VendorOpeningBalances.tsx:100-117](../client/src/features/finance/VendorOpeningBalances.tsx#L100-L117)).
   An older response resolves after the newer one and overwrites it.

6. **Registers keep a page that no longer exists.**
   **Fixed by DF-09 (2026-10-24).**
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
5. **Dead pagination/error state for customer devices.** **Fixed by VOL-4b
   (2026-10-26):** the register's page/pageSize/total and both error states are
   live, server-backed values; the directory stopped holding a device array at
   all and renders the SQL count that travels with each customer row.
   ([CustomersManagement.tsx:110-114](../client/src/features/sales/CustomersManagement.tsx#L110-L114),
   [CustomerMasterDirectory.tsx:300-330](../client/src/features/sales/CustomerMasterDirectory.tsx#L300-L330)).

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
| Executive Dashboard | props (stock, products, POs, shipments) + self recent activity + fixed-asset overview | Live via targeted slices; the eight latest movements are read from `GET /api/transaction-logs` (VOL-1) and the asset KPI reads `GET /api/fixed-assets/overview` (ASSET-1), so no asset array is held. `financialSummary` prop is unused here. |
| Global search, notifications, help | props / static | Hydration only; no defect found. |
| All Available Stock, Branch Stock | props stock/products | Fine. |
| Stock Movement Ledger | self transaction-log window + ops/damage | Fixed by DF-06, then superseded by VOL-1 (2026-10-26): the screen reads a bounded `/api/transaction-logs` window; the bootstrap slice is gone. |
| Physical Stock Audit | props stock + appSettings | Fine. |
| Reorder Stock, Stock Valuation | props | Fine. (Warranty moved to its own paged read — see below.) |
| Asset Deployments | self paged (ASSET-1) | Reads `GET /api/fixed-assets/page?assigned=1` with branch/type/location/search filters and the bounded export; the register no longer filters an asset array. |
| Import / Export Stock | props stock/products; devices paged (VOL-4b) | The serialized-device preview pages and the CSV export asks for the filtered set (`all=1`, capped at 20k with a reported `truncated`). |
| Serial Log Register | paged | Seq + error correct; page clamp fixed by DF-09. Shipment-receipt refresh fixed by DF-06. |
| Product Master Catalog | self catalog | Stale after every save (P1-1); error state dead (P2-9). |
| Category / UoM Management | self list | Silent failure, no loading UI (P2-9). |
| Customer Master Directory | self paged | DF-01 restored the paged envelope; VOL-4a (2026-10-26) made the search trigram-indexed and branch-scoped from the session, and this is now the app's only customer read. |
| Customer Device Serials | self paged (VOL-4b) | `GET /api/customer-devices/page` + `/overview`: filters, stable `(created_at, id)` order, exact KPI counts, and a truncation flag on the capped CSV export. A customer is chosen through `CustomerPicker`, never resolved from an array. |
| Warranty Valid Products | self paged (VOL-4b) | The screen reads `GET /api/customer-devices/warranty`, a SQL union of rented CPE and fixed assets with the warranty state computed and filtered in SQL; no whole-table scan remains. |
| Locations | self list | Load failure surfaced by DF-11; a new location's branch now follows the signed-in user once the branch list loads (close-out fix). |
| Device Exchange | self paged (EXCH-1) | The picker reads `GET /api/customer-devices/page` (RENTAL/ACTIVE, header branch, the typed term searched server-side, 50-row page + matching total) through the shared cache, so an older unit beyond the old 2,000-row cap is still reachable and exchangeable (the bare-array route itself was retired in CDR-1). The previous page stays on screen while a new term loads; a branch switch or a failed read clears it. Mount-once serial snapshot (P1-2) still applies to the replacement check. |
| Purchase Orders, Purchase Invoices | paged | Guards fine; fetch failures render the retryable notice and exports refuse a partial file (DF-04); page clamp fixed by DF-09. |
| Purchase / Sales Returns Register | paged | Same as above. VOL-2 (2026-10-26) replaced the sales form's invoice `<select>` over the bootstrap array with a server-side `SearchPicker` over `GET /api/sales-invoices` (number or customer); the purchase kind keeps its slice. |
| Sales Invoices | paged | Same as above. VOL-2 (2026-10-26) removed the failed-fetch fallback over the bootstrap array; a failed page keeps the rows on screen plus the retryable notice. |
| Consumables Register | paged | Same; also depends on the shared serial cache for its form host. |
| Create PO / Purchase Invoice / Sales Invoice / Returns | form | Derived from props; no defect found beyond the stale supplier/branch sync notes. |
| Create Shipment / Create Transfer / Pullout / Damage Label / Product Sale / Assign Asset | form + `serialRegister` | Validation uses the session-old snapshot (P1-2). VOL-4a: Product Sale and Assign Asset keep the `CustomerRecord` their picker returned; Product Sale starts with no customer selected. |
| Shipment Register, Receive Inbound, Suppliers | props | Fine (host refreshes via `refreshAllData`). |
| Financial Statements | self (direct `getFinancialSummary` + fixed-asset overview) | Cancel flag + error are correct; N+1 requests (P3-1, now also the current and prior-year overview reads); summary prop stale cross-client (P1-4). ASSET-1: the fixed-asset NBV line reads `GET /api/fixed-assets/overview?byBranch=1` at both as-of dates, never an asset array. |
| Vendor / Customer Ledger | self | Party-switch sequence guard added by DF-08; filters apply on Load by design. |
| Opening Stock, Vendor Opening Balances | self | FY-switch sequence guard added by DF-08. |
| Fixed Asset Register, Depreciation Schedule | self paged (ASSET-1) | Both page/filter on the server and read KPI totals and the grouped summary from `/overview`; the date-wise lots page too. The export is the bounded `all=1` read. |
| VAT Register, Fiscal Year Closing | props + fixed-asset overview | Closing-wizard asset diagnoses and depreciation totals now come from `/overview` (ASSET-1), not a local asset array; the summary-prop staleness note (P1-4) still applies to the other figures. |
| Document Numbering Setup | self list | Silent failure (P2-9). |
| BS Calendar Utility, Nepali Fiscal & BS Calendar | self | Silent fallback to compiled calendar; no live BS event refresh (P2-7). |
| BS Calendar health panel | self | Error surfaced correctly; latest-only guard added at close-out (a slow older read cannot paint over a newer report or a repair's re-audit). |
| Audit Activities Log | props + debounced serial fetch | Seq guard + error correct. |
| Company Setup, Users, Permissions, Branches, Approvals, Clear Demo Data | props / mutation handlers | Fine; permission save re-reads the server matrix on failure. |
| Data Recalculation & Repair | mutations + `onRefreshData` | Local refresh correct; other clients' movement ledger and BS mirror now follow `RECALC` (DF-06). |

---

## 7a. Post-audit — VOL-4a customers leave the bootstrap (2026-10-26)

`customer_records` was the last unbounded master array on `GET /api/bootstrap`.
The fan-out no longer reads it and the payload has no `customers` key; the
`BOOTSTRAP_TABLES` mapping stays so an older bundle's
`/api/bootstrap/local?key=customers` still answers. At the modelled 1× (12k
rows) the national payload was 3.34 MB JSON / 284 kB gzip; at 10× (120k rows)
it was 33.72 MB / 2.84 MB gzip, materialised before first render on every
login. It is now zero until someone types in a picker, and then at most 20 rows.

The directory search moved from six ORed `LOWER(col) LIKE '%term%'`
predicates (a sequential scan per debounced keystroke) to one concatenated,
lower-cased expression behind `idx_customer_records_search_trgm`, with a
`(branch_id, customer_name, customer_id)` btree for the stable page order. On a
TEMP table of the same shape: 406 ms → 32 ms at 120k rows (13×), and `EXPLAIN`
shows the bitmap index scan at both volumes. Branch scope is applied in SQL from
the session (`branch_id = ANY(...)`) on top of the route guard, so a branch
role can neither omit it nor forge another branch, and `searchCustomers` now
sends the shell's active branch — before VOL-4a the shared picker 403'd for
every branch user.

Evidence: [customersOffBootstrap.test.ts](../tests/customersOffBootstrap.test.ts)
(bootstrap has no key while the local slice still answers; branch omission /
forged branch refused; a page-2 customer is selectable; no client screen holds
the directory) and [masterdata.repo.test.ts](../tests/masterdata.repo.test.ts)
(the indexed expression, `branchScope` pinning, and the aggregate sharing the
same WHERE).

---

## 7b. Post-audit — VOL-4b customer devices leave the bootstrap (2026-10-26)

`customer_device_records` is one row per deployed/rented unit, so it grows with
the customer base. The bootstrap fan-out no longer reads it and the payload has
no `customerDevices` key; the `BOOTSTRAP_TABLES` mapping stays so an older
bundle's `/api/bootstrap/local?key=customerDevices` still answers. On a TEMP
table of the same shape, the removed national array was **4.68 MB JSON / 435 kB
gzip at 1× (12k rows)** and **46.95 MB / 4.05 MB gzip at 10× (120k)**, on every
login. A branch-scoped read was still 335 kB / 3.36 MB.

The register now reads `GET /api/customer-devices/page` (branch, status, text,
product, issued-date filters; `pageSize` capped at 200; stable `created_at DESC,
id DESC` order) and its KPI cards read exact per-status counts from
`/overview`. The search uses the same concatenated expression as
`idx_customer_devices_global_trgm` (a `(branch_id, created_at DESC, id DESC)`
btree backs the page), and `EXPLAIN` on a 120k TEMP table shows the trigram
bitmap scan at 86 ms for a broad serial prefix, while a 10%-matching name
search resolves in 2 ms through the page index. The warranty directory got its
own paged union (`/warranty`) because its state is derived from the commissioned
date: 36 ms at 12k / 128 ms at 120k for the page plus the four exact state
counts. The CSV export requests `all=1`, caps at 20,000 rows and returns
`truncated` instead of silently exporting the first page.

Branch scope is a server decision on every read (the route guard plus
`branch_id = ANY(...)` from the session), so a branch role can neither omit the
parameter nor forge another branch. The seven former consumers are gone: the
customer directory takes the per-customer count that rides its paged customer
row and fetches only an expanded customer's bounded serials; the export screen
pages its preview; the stock-operation assign/exchange panels and the shipment
form read the shared serial register (with the server lookup as the fallback);
the shell prop, the clear-demo array and the App state are removed.

Evidence: [customerDevicesOffBootstrap.test.ts](../tests/customerDevicesOffBootstrap.test.ts)
(bootstrap has no key while the local slice answers; page 2 reachable; cap
enforced; branch omission/forgery refused; overview counts; the warranty union
at all four boundary days against `getWarrantyInfo`; a real 20,001-row export
reports truncation) and [inventory.repo.test.ts](../tests/inventory.repo.test.ts)
(the indexed expression, paging/export caps, overview/status semantics and the
warranty SQL shape).

---

## 8. Suggested fix order

One commit per batch, and each batch should leave `npm test` + the docs gate
green. No batch needs a dependency.

1. **P0** — settle the `/api/customers` contract (server paged envelope) and
   rewire the directory to the real page/total/status params. Add a repo test
   for the query builder + one HTTP test for the envelope. This is the only
   page that is outright broken. **Landed as DF-01 (2026-10-24):** the paged
   envelope, status filtering, client paging and a visible load error are in,
   pinned by `tests/customerPaging.api.test.ts` and the render tests.
2. **P1-1** — refresh the product catalog after save (local `refreshKey`
   bumped by the save handler). **Landed as DF-02 (2026-10-24):** a local
   `catalogVersion` plus activation refetch on both mounts, and the catalog
   error is rendered instead of discarded.
3. **P1-2** — one shared serial-register cache, re-fetched from the existing
   domain counters; stop each host fetching its own copy. **Landed as DF-03
   (2026-10-24):** one singleton store serves all 11 hosts and the dispatch
   form; `tests/serialRegisterCache.test.ts` pins the single in-flight read.
4. **P1-3** — render the fetch error above each paged register; disable
   export-all while the page request is in error. Reuse Serial Log's pattern.
   **Landed as DF-04 (2026-10-24):** the shared `RegisterLoadError` names the
   failed page, retries it, and exports abort instead of writing a partial file.
5. **P1-4** — a `financialSummary` slice (server + client) or a self-fetch in
   the two consumers, then add it to the owning domains. **Landed as DF-05
   (2026-10-24):** `GET /api/bootstrap/local?key=financialSummary` is live and
   the owning domains re-fetch it; DF-12 later put the reports endpoint on the
   same producer.
6. **P2-1/P2-2** — extend the domain maps: `SHIPMENTS → transactionLogs,
   serialLog`; `RECALC → transactionLogs, BS_CALENDAR`; add BS calendar
   handling to the RECALC branch. Then a mapping test (extend
   `registerRefreshDomains.test.ts`) that fails when a domain's writes are not
   covered. **Landed as DF-06 (2026-10-24):** `SHIPMENTS` refreshes
   `transactionLogs` plus the `serialLog`/`purchaseOrders` registers, and
   `RECALC` refreshes `transactionLogs` and re-reads the BS mirror. Live
   calendar events for the BS screens themselves landed as DF-10. **Superseded
   by VOL-1 (2026-10-26):** `transactionLogs` left the bootstrap; the same
   domains now bump the `transactionLog` paged-register counter.
7. **P2-3** — fiscal year in `cacheKey` (one line) plus a unit test for the
   dedup key. **Landed as DF-07 (2026-10-24):** `tests/apiDedup.test.ts` pins
   same-year coalescing, cross-year separation and the existing branch/user
   identity.
8. **P2-4/P2-5** — sequence guards in the two ledgers and the two opening
   registers (copy the `useRef` + `seq !== ref.current` pattern from
   `SerialLogRegister`). **Landed as DF-08 (2026-10-24)** as one shared
   `utils/latestOnly.ts` ticket guard, unit-tested in `tests/latestOnly.test.ts`
   and used by all four screens.
9. **P2-6** — clamp the page when `pageCount < page` inside each register.
   **Landed as DF-09 (2026-10-24)** as one shared `clampPage` +
   `useServerPageClamp` in `TablePagination`, tested in
   `tests/serverPageClamp.test.ts` and wired into all six server-paged
   registers.
10. **P2-7/P2-8/P2-9** — replace the silent fallbacks with a visible notice and
    a refresh action; use `localTodayAD()`; surface load errors in the setup
    lists. **Landed as DF-10 (BS screens) and DF-11 (setup lists):** a failed
    calendar read is labelled, the gate checks today's LOCAL date and re-checks
    on activation, and Category/UoM/Locations/Document Numbering render the
    retryable `LoadStateNotice` instead of an empty list.

Anything that touches the client today is pinned only by source-text guards —
there is no behavioural client test suite (backlog item **A6**). The safest
order is P0/P1 first, with small reflector tests where a pure function exists
(customer query builder, domain map, dedup key), rather than growing the pin
files.

---

## 9. Follow-up pass — 2026-10-24 (after DF-12 and bootstrap trim step 5)

A second read-only pass over the screens that fetch their own data, the
bootstrap cache path and every client `catch` that does not render anything.
DF-01…DF-12 and bootstrap trim step 5 are assumed shipped; this pass looks for
what those tasks left behind. Method: trace every self-fetching effect's
dependency list and failure branch, then compare the screen's refresh triggers
with the SSE domains and local `refreshAllData()` calls that write the same
data. No browser session was run; every finding names the current lines.

### F-1 (P1). Financial Statements keeps its old branch matrix and shadows the live summary

**Fixed by DF-13 (2026-10-24).** `financialSummary` is now a trigger for the
batch and a dependency of both rendered-table memos; a new `useTabActive` keeps
the prop-driven refetch to the visible tab. The finding below is the pre-fix
evidence.

`FinancialStatements` loads the per-branch summaries once per activation
([FinancialStatements.tsx:203-227](../client/src/features/finance/FinancialStatements.tsx#L203-L227);
deps end at `activationKey` + `summariesRetryKey`). `figuresFor` then prefers
the stored map over the prop for every active branch
([FinancialStatements.tsx:236](../client/src/features/finance/FinancialStatements.tsx#L236)).

DF-05 gave `financialSummary` a live slice and App re-fetches it on every
domain that moves it, but this screen never re-runs its batch when that prop
changes. Because the map wins, the refreshed prop is only a fallback for a
branch/FY pair that was never fetched — not the numbers on screen. Another
client's sale/payment/purchase (or a local one performed in another tab) leaves
the statement matrix at the activation-time values while the closing wizard
updates. A failed batch also keeps the old map with only a small error line.

**Fix (shipped):** refetch the pairs when the `financialSummary` identity
changes, depend on it in the statement/comparison memos, and skip the read
while the keep-mounted tab is hidden. The map is not cleared on a FY switch:
its keys already include the FY id, and clearing it would make a prior-year
column fall back to the current summary mid-read. DF-13.

### F-2 (P2). Party ledgers do not refresh while visible

**Fixed by DF-14 (2026-10-24).** `VendorLedger` now takes the procurement
register counter and `CustomerLedger` the sales plus returns counters; both
re-read the selected party when the counter moves, skip the read while no
party is picked or the keep-mounted tab is hidden, and keep the DF-08
sequence guard. The finding below is the pre-fix evidence.

Both ledgers re-run only when the party changes or the tab is re-activated
([VendorLedger.tsx:73-78](../client/src/features/finance/VendorLedger.tsx#L73-L78),
[CustomerLedger.tsx:74-79](../client/src/features/finance/CustomerLedger.tsx#L74-L79)),
and App passes no refresh key
([App.tsx:2914](../client/src/App.tsx#L2914),
[:2920](../client/src/App.tsx#L2920)). `PROCUREMENT` and `SALES` SSE events
update the invoice/payment slices, and local mutations call `refreshAllData()`
(which bumps every register counter), but neither reaches the open ledger.
Recording a payment, reversing one or posting a return in another tab therefore
leaves the selected party's closing balance stale until the operator leaves and
re-enters the tab. Filters applying on Load is intentional and not a defect.

**Fix (shipped):** pass the existing register counters (`purchaseInvoices` for
the vendor ledger, `salesInvoices` + `returnsRegister` for the customer ledger)
and include them in the fetch effect; the effect returns early while no party
is selected or the tab is hidden (`useTabActive`), and the next activation
already re-runs the read. The customer ledger keeps its two counters because a
credit note moves the receivable even when no invoice event accompanies it.
DF-14.

### F-3 (P2). A failed serial lookup is rendered as "not in the register"

**Fixed by DF-15 (2026-10-24).** The field now has `lookup-failed` (amber,
with Retry), and only a 404 sets `not-found`. Both exchange dialogs let the
rejection through to the field and stop the submit with retry copy on a
non-404, so no refusal or audit report is invented from a failed read. The
finding below is the pre-fix evidence.

`DeviceSerialInput` catches a rejected lookup and sets `not-found`
([DeviceSerialInput.tsx:186-203](../client/src/components/common/DeviceSerialInput.tsx#L186-L203)),
whose text is "Not in the serial register for this branch". The exchange
screens collapse the same rejection to `null` before it even reaches the
component ([DeviceExchangePanel.tsx:393-397](../client/src/features/inventory/stockops/DeviceExchangePanel.tsx#L393-L397),
[CustomersManagement.tsx:1673-1676](../client/src/features/sales/CustomersManagement.tsx#L1673-L1676)).
The server distinguishes a real miss (404) from a failed lookup (500/503)
([inventory.controller.ts:2462-2467](../server/src/controllers/inventory.controller.ts#L2462-L2467)),
but the operator sees the same definitive "does not exist" for a database
outage, a permission failure or a dropped request — with no Retry. That invites
re-scanning, duplicate entry work, or escalation for the wrong reason.

**Fix (shipped):** a distinct `lookup-failed` state with a Retry, the exchange
callers propagating the rejection instead of mapping it to no-row (inline and
submit), and the plain 404 "not found" wording kept as the only `not-found`
path. DF-15.

### F-4 (P2). Exchange tab's deployed-device read fails silently and can show another branch

**Fixed by DF-16 (2026-10-24).** One shared per-branch cache (`useExchangeDevices`)
replaces the per-host read: a branch switch cannot show the previous branch's
rows, a failed read clears the scope and surfaces a `LoadStateNotice` with
Retry in the exchange panel, and every mounted host shares one request per
branch. App invalidates it on the CPE/asset SSE domains and full refreshes,
and resets it on sign-out. The finding below is the pre-fix evidence.

The exchange host fetches customer devices on branch change and only logs a
failure ([StockOperations.tsx:392-405](../client/src/features/inventory/StockOperations.tsx#L392-L405)).
`exchangeCustomerDevices` starts as `[]` and is replaced only on success, so a
failed switch keeps the previous branch's deployed units; the tab counter and
the device picker then render them as the current branch
([DeviceExchangePanel.tsx:178](../client/src/features/inventory/stockops/DeviceExchangePanel.tsx#L178),
[:219](../client/src/features/inventory/stockops/DeviceExchangePanel.tsx#L219)).
There is no error notice or Retry. App mounts up to 11 `StockOperations` hosts,
so the same list is also fetched once per host, not shared.

**Fix (shipped):** the read moved into one shared per-branch cache (the shape
of `branchStockCache`), with per-scope request tokens, a cleared scope plus an
visible error on failure, Retry in the exchange panel, and App-side
invalidation for the domains that write CPE rows. 11 hosts now produce one
request per branch. DF-16.

### F-5 (P3). Three remaining silent read failures

**Fixed by DF-17 (2026-10-24).** Each surface now records its failure and
renders a retryable notice: the settings backfill (with the blind-audit toggle
disabled and `UNKNOWN`), the sellable-serial list (cleared on a branch change,
with the serial gate refusing to guess), and the permission-save resync (Save
and Reset disabled until the server matrix is read). The close-out review
closed one path the first cut missed: when the *bootstrap* fails after a branch
switch, the loader was never reached, so the re-read now runs from the failure
path too. The findings below are the pre-fix evidence.

1. **Cached-bootstrap settings backfill.** When a cached payload predates the
   settings slices, App fetches `/api/settings` and discards any failure
   ([App.tsx:627-638](../client/src/App.tsx#L627-L638)). The app then runs with
   `{}` — for example `companyWideBlindCount` silently reads false while the
   database may hold true, and nothing says the configuration is unknown.
2. **Sellable-serial list.** The bootstrap path fetches the IN_STOCK serials for
   the Sell-to-Customer form and only `console.error`s a failure
   ([App.tsx:812-824](../client/src/App.tsx#L812-L824)). `inventorySerials`
   keeps the list from the previous branch, so after a failed branch switch the
   form offers units that the server will refuse.
3. **Permission-save resync.** After a rejected save, the editor re-reads the
   server matrix but swallows a failure
   ([PermissionManagement.tsx:507-514](../client/src/features/settings/PermissionManagement.tsx#L507-L514),
   [:536-541](../client/src/features/settings/PermissionManagement.tsx#L536-L541)).
   The save error is visible, but the checkbox state still shows the rejected
   edits with no way to know the server's actual matrix.

**Fix (shipped):** one small retryable load notice per surface — plus disabling
the blind-audit toggle while the settings are unknown — and the sellable-serial
list clears on a branch change rather than keeping another branch's rows. The
permission editor treats a failed resync as an unknown matrix and keeps its
write buttons disabled. DF-17.

### What this pass re-checked and found sound

- Deferred-slice gate: per-slice status, stale-scope discard and version
  monotonicity still hold.
- `financialSummary` slice and its owning domains (DF-05) are live; the
  statements screen's own map above now follows that prop (DF-13), and the
  later follow-ups (DF-14…DF-17) leave the summary producer untouched.
- Paged registers still render `RegisterLoadError`, abort partial exports, clamp
  pages and sequence-guard their responses (DF-04/09).
- Setup lists, customer-device screens, BS calendar screens, branch stock cache
  and the BS-date gate keep their DF-10/11 and close-out notices.
- The party ledgers keep their latest-only guards and now follow their
  register counters (DF-14); the opening registers keep the same guards, with
  activation/Retry as their refresh triggers.
- Bootstrap trim step 5 removed the last server mirror reads; this pass found
  no client consumer that now silently receives a missing slice.

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
