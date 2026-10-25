# SESSION NOTES — for next session

_Date: 2026-10-25 · Branch: main · Tests: 1210/1210 green with a DB (all run in CI too; the two unconditional skips are Windows-only real-signal checks that Linux CI runs — no DB-dependent skips since the PG service container landed)_

> **Current state (2026-10-25, DOC-1/CPE-2/B1/B2/CPE-3).** All DF-01…DF-17 work,
> the bootstrap trim follow-up, A3, A4a, CPE-1, CPE-2, B1, B2 and CPE-3 are done.
> B2 shipped the combined trigram search projection, so all eight item searches
> share one indexed `search_text` column per table; B3/B4 stay parked. CPE-3
> resolved decision D1 and made the fixed asset, CPE row, serial register and
> stock move together, with the collection credit keyed on the asset id. **A5 is
> not started** and is deliberately last; A4b waits for it. SER-1 is next in the
> temporary `worklist.md` but needs decisions D2/D3 first.
> Older “Remaining …” paragraphs below are chronological notes, not a live
> backlog; where they conflict with this note, the code and the worklist win.

## ✅ CPE-3 shipped — the fixed asset follows the CPE lifecycle, once per asset (2026-10-25)

**Decision D1 (recorded first).** A CPE collection returns the linked fixed
asset to `ACTIVE` with every assignment field and `device_serial` cleared, keeps
the prior assignment in `assignment_notes`, and credits one unit of branch stock
only when the deployment proved a `STOCK_OUT` for that product/tag. The credit
is keyed on the fixed-asset id, so the approval path, the direct status PATCH
and the asset-unassign screen cannot each add a unit. An exchange keeps the tag
and customer, moves `device_serial` to the replacement, records the old → new
serial, and posts the replacement's `STOCK_OUT` in the same transaction as the
old unit's disposition (RESTOCK / DAMAGE / DISPOSED).

**Fix.** [cpeAssetLifecycle.service.ts](server/src/services/cpeAssetLifecycle.service.ts)
is the single owner of that rule. `misc.controller` (approval execution),
`inventory.controller` `patch_status` (asset unassign) and `patch_status2`
(collection statuses), and `post_exchange` all call it inside their existing
transactions. New repo SQL locks the asset by id or by serial/tag, applies the
collect/move, proves the deployment, and resolves the replacement's product;
`STOCK_RETURN_FROM_ASSET_SQL` now returns the new quantity so the ledger's
before/after are the committed truth. Legacy CPE rows with no linked asset are
keyed by the CPE row id (request number as fallback), so approval execution and
a direct status PATCH also agree. Failure paths now restore the in-memory row and map
`OperationError` (for example the empty-replacement-stock `409`) instead of
answering a generic 500.

**Tests.** `tests/cpeAssetLifecycle.test.ts` on real PostgreSQL: collect once,
collect twice (no second credit), unlinked collection keyed by its CPE row, exchange
moves serial and deducts the replacement, empty replacement stock refuses and
rolls back, a forced failure rolls back asset + stock + ledger, and
exchange→collect ends `ACTIVE` with stock balanced. The CPE status-PATCH HTTP
suite now seeds a linked asset and asserts the patch returns it to `ACTIVE`
with one asset-keyed credit; the exchange concurrency suite and the MAC-conflict
HTTP suite were updated to expect the replacement's stock-out.

**Verification.** `npx tsc --noEmit` clean and the affected suites green. The full run: `npm test` — 1210 tests against a real PostgreSQL 16
service container, 1208 pass, 2 Windows-only skips, 0 fail. Suite now 1210 tests;
docs counts green. (The header's `Tests: 1210/1210` is the same run.)

## ✅ B2 shipped — one trigram projection serves all eight item searches (2026-10-25)

**Problem.** B1 measured eight `items::text` substring scans (five register
predicates plus three serial-rename pre-selects). At 120k rows four took more
than a second (1.25–4.09 s), and the register predicates ORed header columns
with the JSONB blob, so an items-only index could not be used: an unindexed
header branch forced a sequential scan.

**Fix.** `scripts/schema.sql` now creates `pg_trgm` and gives each searched
table one stored generated projection, `search_text`, holding the lower-cased
concatenation of exactly the columns its old predicate searched:

| Table | Folded into `search_text` |
|---|---|
| `purchase_orders` | `po_number`, `supplier_name`, `items` |
| `purchase_invoices` | `invoice_number`, `vendor_bill_number`, `supplier_name`, `items` |
| `shipments` | `items` |
| `stock_operations` | `reference_number`, `technician_name`, `work_order_ref`, `reason`, `items` |
| `purchase_returns` | `return_number`, `original_invoice_number`, `supplier_name`, `items` |
| `sales_returns` | `return_number`, `original_invoice_number`, `customer_name`, `items` |

Each table gets a `gin (search_text gin_trgm_ops)` index. `sales_invoices`
carries `items` but has no item-search query, so it is deliberately excluded.
The runtime parity block adds every column with
`ALTER TABLE … ADD COLUMN IF NOT EXISTS … GENERATED … STORED` before the
`IF NOT EXISTS` indexes, so an existing database upgrades on its next boot and
a fresh install declares the columns in `CREATE TABLE` directly.

All eight call sites now emit one lower-cased `search_text LIKE $n` instead of
the column-by-column OR: `buildPurchaseOrderWhere`,
`buildPurchaseInvoiceWhere`, `buildPurchaseReturnWhere`,
`buildStockOperationWhere`, `buildSalesReturnWhere`, and the three-table serial
pre-select in `cascadeRenameJsonbTables` (its parameters are lower-cased to
match the generated column). `grep -rn 'items::text' server/src` is now empty.

**Verification.** Targeted repo/serial/schema tests are green, followed by the
full suite: **1203 tests, 1201 pass, 2 skipped, 0 fail**, docs-count gate green
at 1203. A fresh scratch database (`inventory_bench_b2`, schema-only, then
12k seeded stock operations) measured the real stock-operation count: at 12k
rows the old predicate and the projection both used a Seq Scan (54.7 ms →
17.9 ms); after growing to 120k rows the old predicate stayed on a Seq Scan at
**265.2 ms**, while `search_text LIKE` switched to a **Bitmap Heap Scan at
15.4 ms** and returned the same single row. That is the B1 shape reproduced
against the shipped schema, not a replay of B1's richer four-object dataset.
The upgrade path was exercised separately: a database built from the pre-B2
`HEAD` schema was seeded with 12k stock operations, then the new schema was
applied. All six columns and six indexes appeared, the same serial search
still matched exactly one row, a second apply was a clean no-op, and the count
used a Bitmap Heap Scan at 9.5 ms; the full first apply took ~4.7 s at 12k
rows, so treat the generated-column rewrite as a one-time maintenance cost that
grows with table size.

**Where.** `scripts/schema.sql` (extension, six columns, six indexes, runtime
ALTERs), `server/src/models/{procurement,inventory,sales}.repo.ts`,
`server/src/services/serials.service.ts`, and the repo/serial/schema tests.
Backlog §B2 now records the delivered shape and numbers.

## ✅ B1 measured — item search degrades with rows; B2 is a GO on the combined expression (2026-10-25)

**Result.** Eight `items::text` scans were measured with
`EXPLAIN (ANALYZE, BUFFERS)` on scratch database `inventory_bench_b1`
(PostgreSQL 18.6, `scripts/schema.sql` unchanged) at a modelled 1× year and
10×: 4k/40k purchase orders, 4k/40k purchase invoices, 6k/60k shipments,
12k/120k stock operations, 12k/120k sales invoices, 600/6k purchase returns,
900/9k sales returns. At 10× four scans exceeded one second: stock operations
1.25 s, serial rename PI 2.51 s, shipments 4.09 s and stock operations 2.88 s.
The 1× stock-operation scan already took 302 ms and the three serial scans
250–759 ms. Register page queries tracked the scan (SO 293 ms at 1×, 1.22 s at
10×), and a register request runs the same `WHERE` about three times, so the
10× stock-operation screen pays ~3.7 s of scans before rendering. A second full
run varied individual p50s but kept the ranking and every >1 s result.

**Decision.** **B2 GO; B3/B4 parked.** A bare `items::text` trigram GIN is not
enough: the five register predicates OR the items field with unindexed header
columns, and a scratch spot check confirmed the planner kept a 284.6 ms seq
scan. A GIN on the combined
`lower(coalesce(header…,'') || ' ' || … || items::text)` expression used a
Bitmap Index Scan and ran the same 12k-row scan in 5.5 ms. B2 shipped that
expression as a generated stored column in `schema.sql` and now points all
eight scans at it (see the B2 entry above). Threshold recorded: p95 > 150 ms at
modelled 1× volume, or a >50k-row sequential scan at 10×.

**Where.** Full dataset, 1×/10× tables, plan shapes, reproducible SQL and
variance are in `docs/architecture-backlog.md` §B1; the worklist then pointed at
B2, which is now delivered. This B1 slice itself made no schema or application
change. Targeted docs-count guard green (8/8); a docs-only slice does not need
the full suite.

## ✅ CPE-2 shipped — MAC conflicts are a readable 409 and the dead status vocabulary is gone (2026-10-25)

**Problem.** `CDR_DUPLICATE_CHECK_SQL` checked `device_serial` and
`pon_serial` only. A MAC owned by another row reached
`uq_customer_device_mac_address` and surfaced as a raw `500` from create or
exchange. Separately, `DISCONNECTED` and `RETURNED` were still accepted as new
values even though the live flow writes `ROUTER_COLLECTED` for a collection and
`REFUND`/`IN_STOCK` for a return.

**Fix.** The duplicate probe now covers a non-empty `mac_address` by its
canonical 12-hex key (so `a4c3f0b1d2e3` collides with
`A4:C3:F0:B1:D2:E3`, while non-MAC text is compared literally) and returns the
matched field. Create and exchange probe before any write and return `409`
with a message naming the field; `findCdrDuplicate` is the single rule shared by
the PG probe, the demo mirror and the exchange pre-flight. The exchange now
hydrates a blank PON/MAC from the register **before** the probe — previously a
serial-only payload skipped the MAC half and could still reach the unique
index.

**Vocabulary count.** A live query found **zero** rows in `DISCONNECTED` or
`RETURNED` (and no approval rows requesting either), so both values were pruned
from every write path: create and status PATCH refuse them with a readable
`400`, approval submission and execution refuse a legacy requested status
before mutating anything, and the UI no longer offers or special-cases them.
The type union and read path keep the values so a pre-cleanup row, if one is
ever imported, remains readable; the live vocabulary is `ROUTER_COLLECTED`,
`REFUND` and `IN_STOCK`.

**Tests.** `tests/cdrDuplicates.test.ts` (7 unit tests: canonical MAC, serial/PON
case and trim, empties, self-exclusion, 409 copy, PG-row mapping) and
`tests/cpeMacConflict.test.ts` (7 HTTP cases against real PostgreSQL:
duplicate create, new create, legacy PATCH, legacy approval submission,
duplicate exchange, register-hydrated duplicate exchange, successful exchange).
`tests/inventory.repo.test.ts` pins the probe SQL, and
`tests/cdrSerialSync.test.ts` pins that legacy statuses no longer map into
`serial_log`. Full suite green; `npx tsc --noEmit` clean.

## ✅ CPE-1 shipped — the CPE status PATCH has a manager audience (2026-10-25)

**Problem.** `PATCH /api/customer-devices/:id/status` had no role gate. The
global operational-permission middleware has no `customer-devices` rule, so any
authenticated role that could reach the branch could flip a rental to
`REFUND`/`IN_STOCK` and rewrite its `serial_log` status without the approval
workflow. The app-level branch middleware also cannot resolve `req.params.id`
before Express routes the request, so it did not protect this id-only path.

**Fix.** The route now uses `requireRole(...CPE_STATUS_ROLES)`: the shared CPE
manager base (`SUPER_ADMIN`, `HEAD_OFFICE_ADMIN`, `BRANCH_MANAGER`) plus
`INVENTORY_MANAGER`. The exchange lookup/exchange/refusal routes use the same
base plus `FIELD_TECHNICIAN`, so the two audiences cannot drift. The status
handler re-checks the record's branch before touching either the mirror or
PostgreSQL and returns `403` for a branch-bound actor outside that branch.
CPE-1 deliberately left status normalization (`DISCONNECTED` →
`ROUTER_COLLECTED`) and the audit event unchanged; CPE-2 later removed that dead
alias from the write path.

**Tests.** `tests/cpeStatusAuthz.test.ts` (4 HTTP cases against real
PostgreSQL): no token → 401; `FRONT_DESK` (which holds `customers-manage` but
must use approval) → 403 with both rows unchanged; an allowed `BRANCH_MANAGER`
against another branch's record → 403 with both rows unchanged; and
`INVENTORY_MANAGER` → 200, `REFUND` on the customer-device row and `IN_STOCK`
with the customer attribution cleared on `serial_log`. The exchange audience pin
now asserts the shared constant keeps `FIELD_TECHNICIAN`.

**Verification.** The suite was green on that head: the `npm test` run against a
real PostgreSQL 16 service container executed 1203 tests, 1201 pass, 2
Windows-only skips, 0 fail; `npx tsc --noEmit` clean.

## ✅ Bootstrap trim follow-up — KPI counts, open-PO picker and FY wizard read scoped rows (2026-10-25)

**Problem.** The deferred purchase slices stopped shipping in the full
bootstrap in October, but the dashboard tile, sidebar badges, notification
panel, vendor-bill PO picker and FY closing wizard still received the whole
`purchaseOrders` / `purchaseInvoices` / `shipments` arrays from
`/api/bootstrap/local`. That kept the byte cost and meant every one of those
surfaces re-filtered the same fiscal-year ledger on the client.

**Fix.** Three consumers moved to purpose-scoped reads:

1. **KPI counts.** New `services/procurementPendingStore.ts` (pure,
   scope-keyed) + `procurementPendingCache.ts` (React hook + paged fetch) load
   only open POs (`DRAFT/APPROVED/SENT/IN_PROGRESS/PURCHASED`) and the unpaid
   bill count (`totalItems − PAID`) for the header branch + selected FY. One
   shared request feeds the sidebar badges, dashboard tile and notification
   panel; a scope switch clears the previous branch/FY before the new read, a
   failed read keeps the last good counts, and App shows a Retry notice. PO/PI
   mutations and shipment receipts invalidate the cache from the SSE handler
   and `refreshAllData`; sign-out resets it. App imports the cache dynamically
   after first paint so the new store does not grow the startup chunk (the
   bundle budget had failed by 2.3 kB; now 311.9 kB of the 320 kB budget).
2. **Vendor-bill PO picker.** `PurchaseInvoiceForm` no longer takes the whole
   `purchaseOrders` array: it reads a **separate** scoped store instance keyed
   by the bill's own destination branch + fiscal year, so the link dialog lists
   only open POs for the branch/FY the bill is being written in, with a
   loading/error notice and Retry inside the dialog. A separate instance is
   deliberate: reusing the KPI store would let a destination-branch change in
   the form rewrite the shell's header-branch badge scope. Both stores reset on
   sign-out and invalidate on the same procurement/shipment events.
3. **FY closing wizard.** It now loads its own POs, vendor bills and shipments
   for the fiscal year being closed (its selected year can differ from the
   header FY), on tab activation and on procurement/shipment events. It keeps
   the last loaded documents for that FY on failure, shows a Retry notice and a
   synthetic "Fiscal-Year Purchase Documents: Unavailable" diagnostic, and
   blocks Step 1's Next while the read is loading or failed — instead of
   reporting an unverified year as "Ready". It also lost the string-summing
   VAT bug the scoped rows exposed (`"02925.00" + "16250.00"`), now coerced.

**Server.** `GET /api/purchase-orders` accepts a comma-separated `status`
(one value keeps the old `status = $n` shape; several become
`status = ANY($n::text[])`), and `GET /api/shipments` accepts optional
`branchId` / `dateFromAD` / `dateToAD` (either end of the transfer + dispatch
date range). Both builders and the wizard now have repo/API tests. No route
gating changed: these are the same authenticated GETs the deferred bootstrap
slices used, with the same branch/FY scope the old props carried; the client
still filters the ALL-branch dashboard/alerts through the user's allowed
branches.

**Tests.** `tests/procurementPendingStore.test.ts` (8): scope-key identity,
open-status filtering, unpaid-count aggregation, one-request dedupe, abandoned
scope responses never paint, failure keeps last-good rows, Retry clears the
error, invalidation refetches only with a subscriber, and no request without a
FY range. `tests/procurement.repo.test.ts` + `tests/shipments.repo.test.ts` cover
the new WHERE shapes. `tests/registerRefreshDomains.test.ts` pins the wizard's
three scoped calls + activation/SSE/Retry wiring and the form's cache read.
Suite **1184 tests, 1182 pass, 2 Windows-only skips, 0 fail**; `npx tsc --noEmit`
clean.

**Live verification (real PostgreSQL, running app).** ALL branches: dashboard
1 Pending PO, sidebar total 3 (1 PO + 2 unpaid bills). WH001: 1 PO + 1 bill →
badge 2; BRH01: 0 POs + 1 bill → badge 1. Vendor-bill dialog listed the one
open WH001 PO; switching the form's destination branch to BRH01 emptied the
picker (BRH01 has none) while the header badge stayed at 2 — the picker's
separate store never re-scoped the KPI counts. The wizard's Step 1 showed "1 Open" for the current FY and VAT
19,175 across 2 bills. Forced KPI failure: banner with Retry appeared and the
badge kept its last value; Retry cleared it. Forced wizard failure: Retry
notice, cached "1 Open", `Unavailable` diagnostic and disabled Next; Retry
restored the diagnostics. Network log showed only the scoped requests
(`status=…&dateFrom…&pageSize=1`, `all=1` for the wizard, shipment range).

**Scope note.** The deferred slices remain in `/api/bootstrap/local` and still
feed `StockMovementLedger` (pinned no-fetch), global search, the PO/PI
registers' prop-driven read-only bits and other wholesale consumers; these
three were the remaining per-consumer migrations named in the earlier note.

## ✅ A4a shipped — a typed route table behind AppRoutes (2026-10-25)

**Problem.** App rendered 67 `<KeepMounted>` blocks inline, each repeating the
same `visible[...]` wiring, and kept the tab permission table in a root-local
constant. The render tree and the access rule were two declarations of the same
tabs.

**Fix.** `routes/appRoutes.tsx` defines `AppRoute` and `screenRoute(key,
element)`, which attaches the RBAC operation(s) and the Super-Admin flag from
the new `routes/tabPermissions.ts`; `AppRoutes` renders the table through
`KeepMountedRoot`/`KeepMounted` with identical never-mount/hide semantics. App
builds one 67-entry `screenRoutes` array and renders `<AppRoutes … />`; its
local `TAB_PERMISSIONS`/`SUPER_ADMIN_ONLY_TABS` copies are gone and
`canAccessTab` delegates to `isTabAccessible`.

**Scope note.** This is A4a, not all of A4: the element construction still
lives in App, because moving it out needs a typed deps contract for ~100
props/handlers that A5's store owns. A4 stays unchecked in the backlog with
that remainder stated.

**Verified.** `tests/appRouteRegistry.test.ts` (5 tests): the table is declared
once with 67 unique keys and every key is a real NavTab; the permission tables
moved and each entry carries them; AppRoutes is the only route-level
keep-mounted renderer; an `enabled: false` route never mounts even when active;
and switching routes mounts each once, hides the previous one and reuses the
node on return. A6's route-tree test still passes through the registry;
`npx tsc --noEmit` clean; full suite **1184 tests, 1182 pass, 2 Windows-only
skips, 0 fail**.

## ✅ A3 shipped — session and scope have one owner (2026-10-25)

**Problem.** App.tsx held the signed-in user, root user, RBAC matrix, app
settings, date mode, selected branch, selected fiscal year and the fiscal-year
list in its own `useState`. Every root refactor (A4's route registry, screen
extraction) had to thread nine values and their setters through props, which is
why the root kept growing instead of shrinking.

**Fix.** `contexts/SessionContext.tsx` owns the five session values and
`contexts/ScopeContext.tsx` the two scope values plus the fiscal-year list; both
expose typed hooks that throw outside their provider. `App` reads them
(`useSession()` / `useScope()`) and keeps no state for any of them.
`contexts/AppProviders.tsx` is the one provider composition, used by `main.tsx`
and by the A6 route-tree harness, so the test can never miss a provider the
browser has. Screens keep their props for this slice; a guard fails if a
feature screen imports either context, preventing a half-migration.

**Verified.** `tests/sessionScopeContexts.test.ts` (5 tests): App imports and
calls both hooks with no `useState` for the nine values; each provider owns its
values and its hook fails loudly outside the provider; main and the harness
share `AppProviders`; no file under `client/src/features` imports the contexts;
and a mounted probe reads seeded values then updates date mode, branch,
fiscal-year list and app settings through the providers. A6's route-tree test
still passes through the shared composition; `npx tsc --noEmit` clean; full
suite **1168 tests, 1166 pass, 2 Windows-only skips, 0 fail**.

## ✅ A6 shipped — a route-tree smoke test, not only source pins (2026-10-25)

**Problem.** Every client fix since DF-13 is pinned by reading source text,
because there was no way to mount the real route tree under `node:test`. That
is exactly what makes A3/A4 (session/scope contexts, route registry) risky: a
refactor that remounts a screen loses drafts, scroll positions and fetched
chunks, and nothing behavioural would notice.

**Fix.** `tests/harness/appRouteTreeProbe.tsx` mounts the real `App` inside the
providers `main.tsx` uses (`DarkModeProvider` + `DialogProvider`) under jsdom,
seeds a SUPER_ADMIN session, and replaces the `api` singleton's mount-time
methods with fixtures — no network, no module mocking. A fake `EventSource`
covers the SSE subscription. `tests/appRouteTree.test.ts` drives navigation
through the app's own `NAVIGATE_TAB_EVENT` (the toast "open tab" path), types a
draft into Assign Fixed Asset's product search, switches to the Dashboard and
back, then asserts the SAME DOM node is still there with the value intact. A
remount replaces the node, so the assertion fails. `App.tsx`'s
`import.meta.env.DEV` reads were made node-test-safe (the same `?.` guard
Sidebar already used) and `tests/harness/dom.ts` now exposes jsdom's
`localStorage` / `sessionStorage` globals.

**Verified.** `tests/appRouteTree.test.ts` (1 test) passes with zero
`act(...)` warnings; `npx tsc --noEmit` clean; full suite **1163 tests, 1161
pass, 2 Windows-only skips, 0 fail**. The test is picked up by `npm test`'s
existing `tests/*.test.ts` glob, so CI runs it with no new script — A6's
done-when. It proves the hidden-not-unmounted contract; each screen's data
freshness stays with that screen's own tests/guards.

## ✅ U-2 shipped — one searchable control for the large directories (2026-10-25)

**Problem.** U-1 fixed the customer field on three forms, but four screens were
still rendering an entire directory as native `<option>`s: `CustomersManagement`
and `CustomerLedger` for customers (App still passed both the full ~12k array),
`AssignAssetPanel` and `ConsumableIssuePanel` for POP / fiber locations. That is
thousands of DOM nodes per form, clipped inside the table's scroll container.

**Fix.** `components/common/SearchPicker.tsx` is now the one interaction core:
minimum query length, debounce, stale-response guard, keyboard navigation,
clear/revert on Escape, a fixed-position portal for scroll containers, and an
explicit failure state with Retry (never "no matches" on a failed read).
`CustomerPicker` and the new `LocationPicker` are thin wrappers, so debounce,
outside-click and failure copy cannot drift per form. Customers stay
server-searched through the paged `/api/customers`; locations filter the
already-loaded bootstrap directory (a small POP/node list, no request per
keystroke), capped at 20 rows matched on name, address or contact.
`CustomersManagement` and `CustomerLedger` no longer take the `customers` array
from App; `LedgerView` keeps its native select for VendorLedger. Issue
Consumables and Assign Fixed Asset pass `portal` so the listbox escapes the
table's horizontal scroller.

**Verified.** `tests/searchPickerPortal.test.ts` (1: renders from body and
selects), `tests/locationPicker.test.ts` (4: type filter, 20-row cap, clear,
failure shape) and `tests/directoryPickers.test.ts` (5 wiring pins: no
`customers.map`, both screens no longer take the array, both wrappers delegate
to the core). Suite **1162 tests, 1160 pass, 2 Windows-only skips, 0 fail**;
`npx tsc --noEmit` clean. Live on the dev app: in Assign Fixed Asset, typing
`Example` into POP / Network Location listed the three POP server rooms with
their address and contact (no full option list), while the committed row stayed
`Example Location 2`; in Issue Consumables, typing `Exam` in the per-line
customer field issued `GET /api/customers?query=Exam&page=1&pageSize=20` → 200
and rendered the four Example customers in a body-level portal, unclipped by
the table; Escape reverted the field to the committed selection. No records
were written.

## ✅ U-1 shipped — one searchable customer picker (2026-10-24)

**Problem.** The customer field already searched, but each copy filtered the
full `customers` bootstrap array: `SalesInvoices` and `ProductSalePanel` held
two near-identical inline pickers (each capped its own list), while
`AssignAssetPanel` still rendered every customer as a native `<option>`. At
~12k customers that is thousands of DOM nodes per form and an unusable
scroll list.

**Fix.** `components/common/CustomerPicker.tsx` is now the one control: 2+
characters, debounced, server-searched through the existing paged
`/api/customers` endpoint, capped at 20 rows, with keyboard navigation, an
explicit failure state + Retry (never “no matches” on a failed read), and a
stale-response guard. The screen supplies the API method
(`search={api.searchCustomers}`), so the per-screen surface pins still see the
read. `AssignAssetPanel`, `SalesInvoices` and `ProductSalePanel` all use it;
the old inline copies and their full-array filters are gone. The deployment
line also keeps the picked directory row, so submit no longer depends on the
customer still being in a stale bootstrap snapshot. No new screen, so the
screen-count tables did not change; the three surface pins gained
`searchCustomers`.

**Verified.** `tests/customerPicker.test.ts` (5 jsdom cases: minimum length +
debounce, click/clear, failed search + Retry, keyboard selection, slow-response
discard). Live on the dev app: typing `Example` in Assign Fixed Asset issued
`GET /api/customers?query=Example&page=1&pageSize=20`, listed the four
directory rows with phone/address, and selected
`Example Customer 1 (CUS-10291)`; the same control rendered and searched in
Product Sale and Create Sales Invoice. Form reset afterwards; no records were
written. Suite **1152 tests, 1150 pass, 2 Windows-only skips, 0 fail**;
`npx tsc --noEmit` clean.

## ✅ DF-13…DF-17 close-out review (2026-10-24)

Re-read every acceptance bullet against the shipped code and checked the docs
and guards for claims that no longer describe it. Stale statements in the docs
and guards were corrected, and one residual was closed:

- **Failed-bootstrap serial list (DF-17 residual).** The successful bootstrap
  path is what called `loadSellableSerials`; when the bootstrap itself failed
  after a branch switch, the loader never ran and the previous branch's units
  stayed in the Sell-to-Customer form. `refreshAllData`'s non-401 catch now
  calls the same loading path when the branch scope differs, so the old rows
  are cleared and the new branch is either read or reported with a Retry.
  Pinned by two added assertions in `tests/df17SilentReads.test.ts` (count
  unchanged at 6 tests).
- **Register-guard header.** `tests/registerRefreshDomains.test.ts` still said
  “50 → 65 screens”, “12 GET … (11 top-level + nested)” and “7 write-only /
  36 zero-call”; it also used the pre-DF-14 constant name. It now matches the
  table: **66** screens (**55** pinned in the table + **11** elsewhere), **13**
  mount-refetch entries (12 top-level + Calendar Health), **6** write-only
  pins, and **30** table entries that make no server call of their own.
- **Audit “found sound” block** no longer reads as if the party ledgers lack
  refresh triggers, and it distinguishes the ledgers' live counters from the
  opening registers' activation/Retry refresh.
- **Task list** now records the close-out cross-checks and the residual under
  DF-17; the audit's F-5 fix summary names the failed-bootstrap path.
- **Manual forced-failure pass (2026-10-24, running dev app).** An in-page
  fetch shim returned 503 for `/api/bootstrap` and `/api/serial-log`, then the
  header switched Branch 1 → Warehouse. The bootstrap 503 was followed by
  `GET /api/serial-log?branchId=WH001&status=IN_STOCK` → 503 from the new
  failure path; the form showed the **empty-state** “Could not load sellable
  serials” notice, so Branch 1's rows had been cleared rather than carried
  over. Re-enabling only serial-log and pressing Retry returned WH001's 5
  `IN_STOCK` rows and cleared the notice while the bootstrap banner stayed
  503. Shim removed; header restored to All Branches; real bootstrap and
  serial reads returned 200.

`npx tsc --noEmit` clean; the `df13`, `df14`, `df15`, `df17`,
`exchangeDevices` and `registerRefreshDomains` tests pass; full suite
**1152 tests, 1150 pass, 2 Windows-only skips, 0 fail** (docs-count gate
included).

## ✅ DF-17 shipped — the last three silent reads are visible and retryable (2026-10-24)

**Problem.** Three failures were still indistinguishable from valid data: the
cached-payload settings backfill dropped `/api/settings` errors (the app ran on
`{}` defaults, so the company-wide blind count read false while the database
may hold true); a failed sellable-serial read kept the previous branch's units,
so the Sell-to-Customer form offered serials the server would refuse; and a
rejected permission save whose re-read also failed left the rejected edits
looking trustworthy.

**Fix.** Settings: `loadSettingsFromServer` records `settingsBackfillError` and
App renders a “company settings” `LoadStateNotice` with Retry; the audit
screen's company-wide blind toggle is disabled and reads `UNKNOWN` while the
setting is unknown or still loading. Sellable serials: `loadSellableSerials`
clears the list the moment the branch scope changes, records
`sellableSerialsError`, and `SalesInvoices` renders a retryable notice and
refuses to pin a serial to “not in inventory” when the list is unread (App
passes the state to both render sites). Permissions:
`resyncMatrixFromServer` records `matrixResyncError`, a `saveBlocked` flag
disables Save and Reset, and the notice offers Retry; a successful re-read
applies the server matrix through the existing update event.

**Verified.** `tests/df17SilentReads.test.ts` (6 source pins: the backfill
loader and notice, the toggle's unknown state, branch-scope clearing and the
form's gate/notice, and the permission resync/disabled-Save wiring). Full suite
**1152 tests, 1150 pass, 2 Windows-only skips, 0 fail**; `npx tsc --noEmit`
clean. The manual forced-failure limitation was closed by the close-out
review's run above (bootstrap + serial-log 503s, then a Retry that repopulated
WH001); all three remain UI wiring around existing fetch paths, pinned at
source like the other screen-level fixes (A6).

## ✅ DF-16 shipped — one branch-safe, retryable exchange-device read (2026-10-24)

**Problem.** Every StockOperations host fetched the exchange tab's deployed
customer devices itself (up to 11 mounted hosts), and a failed read only logged
to the console: `exchangeCustomerDevices` was replaced on success, so a failed
branch switch kept the previous branch's units on screen under the new branch's
name, with no notice and no Retry.

**Fix.** `services/exchangeDeviceStore.ts` is a pure per-branch cache (one
request per scope, request tokens, a cleared scope plus error on failure) and
`services/exchangeDeviceCache.ts` binds it to React through
`useSyncExternalStore`. The host uses `useExchangeDevices(selectedBranchId)`
and passes rows/loading/error/retry through the panel context; the panel
renders `LoadStateNotice` with a Retry, no longer claims “no devices match”
while the read failed, and refreshes the shared list after a successful
exchange instead of calling `api.getCustomerDevices` itself. App invalidates
the cache on `CUSTOMER_DEVICES` / `ASSETS` SSE bursts and full refreshes, and
resets it on sign-out.

**Verified.** `tests/exchangeDevices.test.ts` (12 tests): 8 store tests (shared
read per branch, branch-switch isolation, failure clears + error + Retry,
coalesced invalidation, superseded answers, sign-out reset, scope keys) and 4
wiring pins (App invalidation/reset, host cache use with no direct fetch,
panel notice/refresh, one shared store). Updated pins:
`registerRefreshDomains.test.ts` (the host now makes no server call and the
panel no longer fetches devices) and `df12Cleanup.test.ts` (post-exchange
refresh goes through the cache). Full suite **1141 tests, 1139 pass, 2
Windows-only skips, 0 fail**; `npx tsc --noEmit` clean. No manual two-host pass
with a forced failure was run; the cache behaviour is covered by the pure store
tests and the wiring by source pins.

## ✅ DF-15 shipped — a failed serial lookup is no longer “not in the register” (2026-10-24)

**Problem.** `DeviceSerialInput` mapped every rejected lookup to `not-found`,
and both exchange dialogs pre-mapped the rejection to `null`
(`.catch(() => null)`). A 500/503/dropped request therefore read exactly like
the register's definitive “no such unit” — with no Retry — inviting a re-scan of
a valid serial or an escalation for the wrong reason.

**Fix.** `DeviceSerialState` gained `lookup-failed`, rendered amber as “Could
not check the register” with a Retry that re-runs `resolve`. The catch now
reads the status `fetchJson` attaches to the rejection: only 404 sets
`not-found`. Both dialogs pass the inline rejection through to the field and
stop the submit path with the shared `SERIAL_LOOKUP_FAILED_MESSAGE` on a
non-404, before any refusal or audit report; a real 404 still goes through
`describeReplacementRefusal`.

**Verified.** `tests/df15SerialLookupFailure.test.ts` (8 tests): pure status
classification (404 vs 500/503/403/transport), a rendered failure state whose
Retry re-issues the lookup, a rendered 404 that still says “Not in the serial
register for this branch” with no Retry, a resolved row still filling PON/MAC
in canonical form, and the two dialogs' wiring. Full suite **1129 tests, 1127
pass, 2 Windows-only skips, 0 fail**; `npx tsc --noEmit` clean. The failed-read
path was exercised through the component itself (jsdom), not a live outage.

## ✅ DF-14 shipped — party ledgers follow live ledger events (2026-10-24)

**Problem.** Both ledgers fetched only on party change and tab re-activation,
and App passed no refresh key: recording a payment, reversing one or posting a
return anywhere else updated the bootstrap invoice slices but left the open
ledger at its activation-time closing balance until the operator left and
re-entered the tab.

**Fix.** `VendorLedger` takes the procurement register counter
(`registerRefresh.purchaseInvoices`); `CustomerLedger` takes the sales counter
plus the shared returns counter (a posted or cancelled credit note moves the
receivable too). Both include the counter(s) in their fetch effect, so a burst
re-reads the selected party in place while the tab is open. The read stays a
no-op while no party is selected, and — following DF-13's `useTabActive`
precedent — a hidden keep-mounted tab skips it; the next activation already
re-runs the fetch. The DF-08 sequence guard and the Load button are unchanged.

**Verified.** `tests/df14LedgerRefresh.test.ts` (4 tests) pins the props, the
effect dependencies, both no-request guards (empty picker, hidden tab), App's
counter wiring and the retained sequence guard. The register guard's wiring
check now counts per render site instead of app-wide (a counter can feed two
components since DF-14), and `MOUNT_REFETCH_NO_SSE_KEY` became
`MOUNT_REFETCH_SCREENS` with the two ledgers exempted from “no register
wiring” and pinned positively by the new test. Full suite **1121 tests,
1119 pass, 2 Windows-only skips, 0 fail**; `npx tsc --noEmit` clean. No manual
browser pass was run; the ledgers' fetch is an ESM API import with no
behavioural harness (A6), hence the source pin.

## ✅ DF-13 shipped — Financial Statements follows the live summary (2026-10-24)

**Problem.** `FinancialStatements` fetched its per-branch matrix only on tab
activation and `figuresFor` preferred that map over the `financialSummary`
prop. DF-05 keeps the prop fresh on every owning domain, so the activation-time
map shadowed the live value: a sale/payment/purchase posted elsewhere left the
statement matrix unchanged while the closing wizard moved.

**Fix.** The batch effect now re-runs when `financialSummary` changes, and the
memoized statement/comparison tables depend on it too (the fallback path was
keeping a stale closure). A new `useTabActive` hook skips the prop-driven read
while the keep-mounted tab is hidden, so a stock edit elsewhere no longer
issues a branch × FY batch nobody can see; the next activation re-runs it. The
map is deliberately not cleared on a FY switch — its keys include the FY id,
and clearing would make the prior-year column fall back to the current summary
mid-read. Activation and Retry still trigger the batch.

**Verified.** `tests/df13StatementsRefresh.test.ts` pins the visible-only
read, the `financialSummary` dependencies and the remaining triggers; the new
`useTabActive` hook has a render test in `tests/keepMountedRenderCount.test.ts`
and the Retry dep pin in `tests/closeoutResiduals.test.ts` was updated. Full suite
**1117 tests, 1115 pass, 2 Windows-only skips, 0 fail**; `npx tsc --noEmit`
clean. No manual browser pass was run for this task; the screen's fetch is an
ESM API import with no behavioural harness (A6), hence the source pin.

## ✅ Fresh data-fetching pass — all five follow-ups shipped (2026-10-24)

A second read-only pass over the self-fetching screens, the cached-bootstrap
path and every client failure branch found five gaps not covered by DF-01…DF-12
or bootstrap trim step 5. Evidence and line references are in
[data-fetching-audit.md §9](docs/data-fetching-audit.md#9-follow-up-pass--2026-10-24-after-df-12-and-bootstrap-trim-step-5);
the work items are DF-13…DF-17 in
[data-fetching-tasklist.md](docs/data-fetching-tasklist.md). The pass itself
changed no code; all five have since shipped as DF-13…DF-17 (above).

1. **P1 — Financial Statements shadows the live summary.** ✅ **Fixed by
   DF-13.** The branch matrix was fetched on activation only and preferred over
   the freshly refreshed `financialSummary` prop, hiding DF-05's live value
   behind older per-branch numbers.
2. **P2 — Party ledgers do not refresh while visible.** ✅ **Fixed by DF-14.**
   Both ledgers take the existing register counters and re-read the selected
   party while the tab is visible; a hidden tab skips the read.
3. **P2 — Serial lookup failures read as "not in register".** ✅ **Fixed by
   DF-15.** Only a 404 sets `not-found`; other rejections show a retryable
   "could not check the register" state, and the dialogs stop swallowing them.
4. **P2 — Exchange device list is stale across failed branch switches** and is
   fetched once per mounted stock host. ✅ **Fixed by DF-16.** One shared,
   per-branch cache; a failed or unloaded branch is empty (never the previous
   branch's units) with a retryable notice, and 11 hosts share one request.
5. **P3 — Three silent reads:** cached-payload settings backfill, the sellable
   serial list after a branch switch, and the permission-save resync. ✅
   **Fixed by DF-17.** Each records a retryable failure, the blind-audit toggle
   reads UNKNOWN while settings are unknown, the sellable list clears on a
   branch change, and Save stays disabled until the permission matrix is read.

## ✅ Bootstrap trim step 5 — PO/PI/shipment/vendor-payment mirrors are demo-only (2026-10-24)

**Problem.** The registers read PostgreSQL, but mutation paths still trusted the
in-memory mirrors first: PO update/delete/status, the linked-PO and duplicate-bill
pre-checks, invoice-payment and vendor-payment reversal, shipment receive/cancel/
undo pre-checks, approval-driven transfer cancellation, purchase returns, and the
purchase-invoice date an asset inherits. A mirror row that another instance had
already deleted could answer "not found" for a live row, or supply a different
payment/invoice set. Register GETs also fell back to the mirror whenever their
SQL read threw, hiding a database outage behind a stale snapshot.

**Fix.** Every one of those sites now reads PostgreSQL when connected and keeps
the mirror only for PG-down demo mode (`!getPgConnected()`):

1. `put_Id` loads the PO by id (404 when it is gone instead of echoing the
   request body), `delete_Id` resolves the PO and its linked invoice in PG,
   and `patch_status` returns the row it just updated.
2. Bill create resolves the linked PO and duplicate number in PG; vendor-bill
   and vendor-payment reversals resolve the invoice and its POSTED payments in
   PG; purchase returns resolve their original invoice in PG.
3. Shipment receive/cancel/undo pre-checks use `SHIPMENT_FIND_ONE_SQL`, the
   approval cancellation uses `SHIPMENT_FIND_CANDIDATES_SQL`, and the demo
   receive settlement is gated so the PG credit can no longer be applied twice.
4. PO/PI/shipment/vendor-payment/return register reads now return a retryable
   500 on a database error instead of the stale mirror. The vendor ledger's
   silent "using cache" fallback is gone.

**Tests.** `tests/bootstrapTrimStep5.test.ts` (5 tests) pins every converted
site, the receive double-apply gate, and the new single-row SQL shapes. Suite
now 1152 tests, 0 fail; `npx tsc --noEmit` clean.

## ✅ Branch-scoped stock availability fixed (2026-10-24)

**Symptom.** In Assign Fixed Asset, selecting Branch 2 as the fulfilling
branch showed `0 in stock` for ONU002 and refused the deployment, while the
Serial Log Register showed `SN-ONU002-0005` as IN_STOCK at BRH01. PostgreSQL
was right and agreed with itself (`inventory_stock` 2 units at BRH01; two
IN_STOCK serial rows).

**Root cause.** `/api/bootstrap?branchId=…` scopes its `stock` array to the
HEADER's branch (14 rows, all WH001, confirmed against the running server),
but the stock-operation and dispatch forms let the operator target any
allowed branch and computed availability with
`stock.filter(st => st.branchId === <form branch>)`. The serial register was
fetched unscoped (`{ all: true }`), so the two gates contradicted each other
for exactly the branches the bootstrap payload never carried. No stock
arithmetic was wrong.

**Fix.** `services/branchStockStore.ts` + `branchStockCache.ts`: one shared
cache of `GET /api/stock?branchId=<branch>` reads for every branch the user
may operate on, one in-flight request per branch, failures keep the last rows
and surface `BranchStockNotice` with a Retry. `StockOperations` and
`CreateShipmentForm` merge those rows over the header snapshot (the snapshot
stays authoritative for its own branch, so a past fiscal year's opening
snapshot still governs that branch); App invalidates the cache on full
refresh and on every SSE burst that writes stock.

**Verified live** (super admin, header WH001, fulfilling BRH01): ONU002 now
reads `2 in stock`, `SN-ONU002-0005` resolves as IN_STOCK at BRH01 with its
PON/MAC, a forced `/api/stock` failure shows the retry notice while keeping
`2 in stock`, and Retry clears it. 5 new tests in `tests/branchStock.test.ts`.

## ✅ Remaining close-out residuals fixed (2026-10-24)

1. **BS health-panel guard.** The integrity read now takes a latest-only
ticket (`utils/latestOnly`), so a slow older response can neither paint the
report nor settle the spinner, and a completed repair invalidates reads already
in flight so its fresh re-audit wins.
2. **Customer-device read failures.** `CustomersManagement` and
`CustomerMasterDirectory` used to keep stale rows (or show a real-looking zero)
when their `GET /api/customer-devices` read failed. Both now keep an error,
render the shared `LoadStateNotice`, and Retry re-runs the read; the directory
can pass custom copy, so it says the assigned-hardware counts may be 0 rather
than claiming the list is empty.
3. **Batch summaries in parallel.** The reports batch no longer walks its
branch × FY pairs serially: a new `server/src/utils/mapWithConcurrency` runs
three pairs at a time in input order, bounded so nine aggregate queries per
pair cannot monopolise the 20-connection pool. The live batch tests still pass.

Evidence: `tests/closeoutResiduals.test.ts` and `tests/mapWithConcurrency.test.ts`
(5 tests: order, bound, empty list, rejection, invalid limit). Suite now 1152
tests, 0 fail; `npx tsc --noEmit` clean.

A follow-up pass over the three screens found two missed loading/retry states,
both fixed: the statements batch error had no Retry of its own (now a button
that re-runs the batch and disables while it runs), and `CustomersManagement`'s
empty table still said "no matching customer devices" when the read itself had
failed (now it points at the Retry, and the notice sits above the stat cards
whose zeroes it explains). Its CSV export is disabled while the read is in
error, so a stale row set cannot be written as this filter's answer. The
directory's hardware notice moved above its summary cards for the same reason.

## ✅ Locations new-location branch follows the user (2026-10-24)

The close-out review's first residual is fixed. `LocationsManagement` seeds a
new location's branch from `branches[0]` when it mounts, which is the
hard-coded `WH001` before the bootstrap arrives and "whichever branch sorts
first" after it — wrong for an operator on another branch. The screen now takes
`currentUser` (App passes it) and `defaultLocationBranchId()` prefers the user's
own branch when the master list contains it, then the first branch, then the
legacy `WH001`. An effect keeps an untouched form on that default as the branch
list lands and after a profile switch; choosing a branch in the select stops
the sync, and a successful save returns to following the default.

Evidence: `tests/locationDefaults.test.ts` (4 pure rule cases + 2 wiring pins).
At that point the suite held 1184 tests, 0 fail; `npx tsc --noEmit` clean.

## ✅ Data-fetching list closed — DF-01…DF-12 all shipped (2026-10-24)

All twelve tasks are `done` on `main`, one commit each, and every one has a
green `typecheck-and-test` run on its own head (twelve consecutive successes).
The close-out review in `docs/data-fetching-tasklist.md` re-checked the
cross-task invariants: five paged registers carry the error notice + page clamp
+ render-phase reset; no `window.location.reload` call survives; every
`StockOperations` host refreshes through App; the statements matrix uses the
single batch call; server and client domain maps still agree; and the paged
`GET /api/customers` envelope is documented in README and handoff with no other
caller expecting the old array.

One residual has since been fixed (the Locations default branch, above).
Remaining minors, none a regression from this work: the BS health panel still
lacks a sequence guard, the two customer-device registers keep stale rows
without a notice on their own failed read, and the batch summary resolves pairs
sequentially inside one request. _(Superseded 2026-10-25: all three were fixed
in “Remaining close-out residuals fixed” above; do not reopen them.)_

One review-driven hardening is on disk, not yet committed: the page-reset hook
now compares against STATE instead of a ref, so an aborted render cannot record
a filter change whose page reset never happened. `tests/df12Cleanup.test.ts`
still passes (7 tests) and `npx tsc --noEmit` is clean.

## ✅ DF-12 shipped — cleanup: no full reloads, one summary request, no dead paging state (2026-10-24)

Six audit leftovers, verified by the new `tests/df12Cleanup.test.ts` (7 tests)
and the live batch coverage in `tests/financialSummary.test.ts` (3 tests).

1. Device exchange, asset deployment and damage reversal no longer call
   `window.location.reload()`. The two stock-ops panels take App's
   `refreshAllData` through `StockOperationsContext.onRefreshData` (exchange
   still refetches its own device list first), and the damage screen takes
   `onReverseStockOperation`, App's handler that reverses AND refreshes. A
   mutation in one tab no longer throws away every other tab's form state.
2. Financial Statements issued one request per branch × fiscal year. New
   `GET /api/reports/financial-summaries?branchIds=…&fiscalYearIds=…` returns
   every pair keyed `branchId|fiscalYearId`; the screen makes ONE call
   (`getFinancialSummaries`) and keeps the same error line. Moving that path
   onto the shared `fetchFinancialSummaryFromDb` producer exposed a real drift:
   the old inline SQL omitted the posted purchase-return term, so the report
   overstated AP by the returns total (fixture: 1730 instead of 1430). Both
   endpoints now share the producer, and a live test pins the subtraction.
3. DF-03's serial cache still serves all 11 StockOperations hosts from one
   request — `tests/serialRegisterCache.test.ts` + `registerRefreshDomains`
   green (48 tests).
4. The five server-paged registers reset the page in a second effect, so one
   filter change fetched the old page and then page 1. New
   `client/src/utils/useFilterPageReset.ts` snaps during render (React's
   adjust-state-on-prop-change pattern, the one `useClientPagination` already
   uses): one request, nothing on mount, and a manual page change still sticks.
5. `useActivationKey` takes a `NavTab`, so a typo cannot silently compare
   against a tab that never activates; its render-phase ref writes are now
   documented.
6. Removed the constant `devicesPage`/`devicesPageSize` state and the
   write-only total/error setters from Customers Management and the Customer
   Master Directory.

At that point the suite held 1184 tests, 0 fail; `npx tsc --noEmit` clean. Limitation: no manual
browser pass over the three reload sites — they are covered by the wiring pins
and the panels' existing tests.

## ✅ DF-11 shipped — setup lists say which failure they hit (2026-10-24)

Category, UoM, Locations and Document Numbering logged their load failure to
the console and rendered an empty list, so a stopped server or a 500 looked
exactly like "nothing is configured". Category/UoM/Locations also discarded
their loading flag, so the empty state flashed before the first response.

New `client/src/components/common/LoadStateNotice.tsx` covers both states: an
initial load shows a spinner (`Loading categories…`) instead of the empty state,
and a failed read shows a rose notice naming the list, the server message, and
whether cached rows remain (`Nothing is shown below — this is not an empty
list` vs `Showing the last loaded rows — they may be out of date`) with a Retry
that re-runs the same loader and spins/disabled while that retry is in flight.
A successful load clears the error, which unmounts the notice; a re-activation
refetch with rows already on screen shows no spinner. All four screens keep a
read `loading` flag and a `loadError` string, and their empty slot now says
"could not be loaded — use Retry above" instead of implying zero rows. Category
and UoM switch their header subtitle, Locations its four KPI values, and
Document Numbering its configured-count badge, when the read failed.

Product Management already rendered its catalog error with Retry (DF-02); its
second, write-only `categoryLoadError` state is gone, and the category-option
effect no longer carries a try/catch around pure derivation.

Evidence: new `tests/loadStateNotice.test.ts` (11 tests: six React render
assertions for spinner/alert/cached copy/retry-in-flight/clear, four screen
wiring pins including the real loading flag and the error-aware empty copy, and
Product Management's rendered catalog error + removed dead flag). Suite now
1152 tests, 0 fail; `npx tsc --noEmit` clean. Limitation: no manual
server-stop/forced-500 browser pass; the states are exercised through the
component render and the screens' wiring. Next: **DF-12** (cleanup: reload-free
exchange refresh, batch financial summaries, dead device pagination state).

## ✅ DF-10 shipped — BS calendar failures are visible and the BS-date gate follows the real day (2026-10-24)

Two problems, one cause: the screens that depend on the BS calendar never
learned when it changed or whether it could be read.

*The fallbacks were silent.* `BsCalendarUtility` and `NepaliFiscalManagement`
caught every fetch failure, swapped in the compiled client calendar and
rendered it exactly like server data — an operator could seed a year against
bundled defaults believing they came from the database. Both now keep a
`calendarLoadError`, show a persistent rose notice ("Could not read the calendar
database — the values below are bundled defaults, not server data", with the
server message and a Retry), and clear it on the next successful read. They
also re-read on the app-wide calendar signal, not just on tab re-activation.

*The gate checked the wrong day and never re-ran.* The stock-operation gate in
`StockOperations` and `DamagedStockTracking` computed "today" with
`toISOString().slice(0,10)` — UTC — so between 00:00 and 05:45 Nepal time it
validated **yesterday**'s BS record. It ran once per mount, so an admin seeding
the missing month in another tab left every stock screen locked until a reload.
The check now lives in `client/src/utils/bsCalendarGate.ts`
(`useBsCalendarGate`, used by both screens): it checks
`localTodayAD()` from the new `client/src/utils/localDate.ts` (the helper moved
out of `SalesInvoices`), shows a *checking* state instead of a stale verdict,
re-runs on tab activation and on `bsCalendarRefresh`'s
`inventory_bs_calendar_updated` event, which App fires exactly when a
`BS_CALENDAR` / `RECALC` burst syncs its mirror. The gate still falls back to
the strict compiled calendar when the server is unreachable — an outage cannot
silently open it. The damaged-stock write-off date now uses the local day too.

Evidence: new `tests/bsCalendarGate.test.ts` (8 tests: the Nepal-midnight UTC
bug, the local-day boundary, the gate's found/missing/failed-read rule, and a
real React render proving a mount check plus a re-check on the calendar
event). `tests/registerRefreshDomains.test.ts` gained a wiring guard (+1 test)
pinning the App broadcast, both screens' `calendarVersion` dependency and their
failure notice, and its two stock-screen surface pins were retightened to the
shared hook. At that point the suite held 1184 tests, 0 fail; `npx tsc --noEmit` clean.
Limitation: no live browser run with the server stopped or a clock forced to
00:15 NPT; both are covered at the helper/hook level, with the screens' wiring
pinned by source. Next: **DF-11** (distinguish "failed to load" from "empty" on
the setup lists).

## ✅ DF-09 shipped — a shrinking register snaps back to its last page (2026-10-24)

The six server-paged registers kept their `page` when a delete shrank the
filtered total. The next fetch asked for a page the server no longer had, the
table emptied, and the footer could read "Showing 76–75 of 60" until the
operator clicked back.

`TablePagination` now exports `clampPage(page, pageCount)` and a
`useServerPageClamp(page, pageSize, totalItems, setPage)` hook. The hook returns
the clamped page for display immediately, and snaps the state to the new last
page once when the total shrinks (the `page !== safePage` guard prevents a clamp
loop), so the follow-up fetch requests a page that exists. It is wired into
Purchase Orders, Purchase Invoices, Sales Invoices, the shared Returns Register,
the Serial Log Register and the Consumables panel. Page-size changes still reset
to page 1, and a zero total stays on page 1 rather than page 0.

Evidence: new `tests/serverPageClamp.test.ts` (5 tests: pure clamping including
an empty set, plus a real React render where a 61→60 total snaps page 5 to 4, a
31→0 total lands on page 1, and a still-covered page does not move). Suite now
1152 tests, 0 fail; `npx tsc --noEmit` clean. Limitation: no manual delete on a
multi-page register was run; the clamp is exercised through the hook the six
registers share. Next: **DF-10** (BS calendar fallbacks and the BS-date gate).

## ✅ DF-08 shipped — sequence guards for the ledgers and opening registers (2026-10-24)

The two party ledgers and the two opening registers fetch on a selection and had
no request sequencing: choosing supplier A then B (or fiscal year 1 then 2)
quickly let A's slower response land last, so the screen showed the previous
party/year under the current selection. A stale failure could also clear the
current rows, and a stale success could settle the loading flag while the
current request was still running.

New `client/src/utils/latestOnly.ts` is a small ticket guard: `begin()` takes a
new ticket and invalidates every older one, and only the newest ticket may
write data, raise an error or clear loading. `VendorLedger`, `CustomerLedger`,
`OpeningStockManager` and `VendorOpeningBalances` each hold one guard in a ref
and gate their fetch's data/error/loading writes, including the refetches after
saves and manual loads.

Evidence: `tests/latestOnly.test.ts` (6 tests: ticket ordering, guard
independence, a slow older response losing to the newer selection, a stale
failure staying silent and keeping the rows, and loading settling only for the
current request). At that point the suite held 1184 tests, 0 fail; `npx tsc --noEmit` clean.
Limitation: no browser pass with artificially delayed responses was run; the
guard behaviour is covered by the async tests. Next: **DF-09** (clamp a
register page when the row set shrinks).

## ✅ DF-07 shipped — the GET dedup key includes the fiscal year (2026-10-24)

`fetchJson` coalesces concurrent identical GETs by user + branch + URL. The
fiscal year never appears in the URL — it travels only as the
`x-fiscal-year-id` header — so when a user switched fiscal years, the new
year's list fetches joined the old year's still-in-flight requests and painted
the previous year's rows. The key now ends with the active fiscal year: identical
same-scope GETs still coalesce (no duplicate list traffic), and a post-switch
request always fetches its own body.

Evidence: new `tests/apiDedup.test.ts` (4 tests with a mocked fetch: same-year
coalescing, cross-year separation with out-of-order responses, branch/user
identity retained, in-flight-only dedup). The suite was run against the old key
to confirm it fails there (2 failures) and passes on the new one. Suite now
1152 tests, 0 fail; `npx tsc --noEmit` clean. Next: **DF-08** (sequence guards
for the ledgers and opening registers).

## ✅ DF-06 shipped — shipment receipts and recalculation jobs refresh every surface they rewrite (2026-10-24)

The `SHIPMENTS` domain refreshed `shipments`, `stock` and (since DF-05) the
financial summary, but receiving a transfer also writes `TRANSFER_IN`
`transaction_logs` rows and flips `serial_log` rows. The Stock Movement Ledger
kept its pre-receipt rows until a reload, and the paged Serial Log Register
never re-fetched. `SHIPMENTS` now also refreshes the `transactionLogs` slice
and bumps the `serialLog` register alongside `purchaseOrders`, which it already
refreshed; the shared serial-register cache was already invalidated for this
domain by DF-03.

The admin recalculation jobs had the same gap. *Recalculate Live Stock*,
*Recalculate Fixed Assets* and *Backfill Ledger Balances* broadcast `RECALC`,
which refreshed only `stock` and `assets`, so the movement ledger kept the
placeholder before/after balances the backfill had just corrected. *Rebuild BS
Calendar Days* regenerates the server's day-by-day lookup rows and broadcasts
no calendar event. `RECALC` now refreshes `transactionLogs` too, and a `RECALC`
burst re-reads the BS calendar mirror exactly like `BS_CALENDAR` does, so the
client's copy of the AD↔BS authority follows the rebuild.

A register mapped by two domains in one burst is still bumped once: the counter
is a refresh trigger, not a tally, and one increment re-runs its paged fetch.

Evidence: `tests/registerRefreshDomains.test.ts` pins
`SHIPMENTS → ['purchaseOrders', 'serialLog']`, both `transactionLogs` slice
additions in `App.tsx`'s `DOMAIN_STATE_KEYS`, and the RECALC branch that
re-reads the calendar mirror; the existing multi-domain burst expectation was
corrected for the second `serial_log` writer. At that point the suite held 1184 tests, 0 fail;
`npx tsc --noEmit` clean. Limitation: no literal two-browser SSE session was
run; the server side is unchanged (the same broadcast/domain plumbing already
proven by the sync tests), and the new client mappings are pinned by the
tests above. Next: **DF-07** (include the fiscal year in the GET dedup key).

## ✅ DF-05 shipped — financialSummary has a live refresh path (2026-10-24)

`financialSummary` used to exist only inside a full bootstrap, so another
client's sale, payment or purchase left this tab's closing-wizard totals and
financial-statement fallback stale until a reload. The rule now lives once in
`server/src/services/financialSummary.service.ts`: the bootstrap feeds it the
rows it already fetched, and `GET /api/bootstrap/local?key=financialSummary`
serves the same object from nine aggregate reads (inventory/opening stock,
assets, invoice totals, vendor opening balances, posted payments, posted
returns, damage, STOCK_OUT lines and product cost) instead of re-running the
24-query operational fan-out. Both paths resolve the same branch/FY scope:
date ranges for invoices, returns, damage and sales, the FY id for opening
balances, opening stock for past/closed years, and the current year's code
reported independently of the view scope. AP keeps the posted-return term, so
the live slice cannot disagree with the bootstrap's numbers.

App refreshes the slice for `SALES`, `PROCUREMENT`, `STOCK`,
`STOCK_OPERATIONS`, `SHIPMENTS`, `FISCAL` and `RECALC`; the shared notice
labels it "financial summary" if the refresh fails.

Cost, measured on the dev DB against an in-process Express app (6 alternating
requests, same branch/FY): median **43.1 ms** for the summary slice vs **80.3
ms** for the full bootstrap, and the slice ships one object instead of every
ledger. That is well inside the debounce budget, so no further lightweight-SQL
fallback is needed.

Evidence: new `tests/financialSummary.test.ts` (9 tests: the pure rule, AP
returns/draft exclusions, trading isolation, source wiring for both producers
and all seven App domains, plus live-DB HTTP cases — 401, slice≡bootstrap for
the same scope, a just-committed invoice visible on the next read, and a
second branch seeing zeros). At that point the suite held 1184 tests, 0 fail. Next: **DF-06**
(complete the SSE domain coverage for shipments and recalculation).

## ✅ DF-04 shipped — paged-register failures are visible, exports refuse partial files (2026-10-24)

PO, PI, SI, Returns and Consumables no longer hide a failed page request. Each
renders the shared `RegisterLoadError` notice above its table with the actual
error and a Retry that re-runs that register's own page fetch; while the retry
is in flight the button is disabled and spinning, and the next successful fetch
clears the notice. The client-filtered fallback stays so the screen degrades
usefully, but it is now labelled as cached rows that may be out of date or
filtered differently. Purchase Invoices also renders the fallback rows now — it
previously counted the fallback but mapped the empty server page, so the table
looked blank.

CSV export on PO, PI and Consumables is disabled while the register is in an
error state, and each export now aborts with a visible "Export failed … No file
was written." message when its full-register fetch fails, instead of silently
writing the visible page as if it were the whole filtered set.

Evidence: new `tests/registerLoadError.test.ts` (9 tests: notice content, cached
wording, Retry invocation/disabled state, per-register wiring, and the export
guard) plus `npx tsc --noEmit`. Live pass on the dev app with simulated fetch
failures: Purchase Orders, Sales Invoices and Consumables each showed the rose
notice with the error and cached rows, Export CSV disabled, and Retry restored
the register and re-enabled export once the network recovered. On Consumables,
a failing full-register (`all=1`) fetch on export showed "Export failed … No
file was written." and downloaded nothing. At that point the suite held 1184 tests, 0 fail. Next:
**DF-05** (give `financialSummary` a refresh path).

## ✅ DF-01 shipped — Customer Master Directory restored (2026-10-24)

`GET /api/customers` now always returns `{ data, page, pageSize, totalItems, activeItems,
totalCreditLimit }` and applies `branchId`, `query`, `status`, `page`/`pageSize` in SQL (page clamped
≥ 1, pageSize 1–100 default 15); `all=1` returns the full filtered set for CSV export. The screen's
`TablePagination` is driven by the server response, every filter change resets to page 1, and a delete
that empties the last page steps back one. A failed fetch keeps the last good page visible under a
rose error banner with Retry (and an explicit "could not be loaded" empty state when there is nothing
to keep), instead of the old silent blank table. The KPI cards read the server's filtered
`totalItems`/`activeItems`/`totalCreditLimit` — not counts of the visible 15 rows — and CSV export
requests every filtered row rather than exporting one page. The client wrapper's type is now the
envelope only; the directory is its sole caller.

Evidence: `tests/masterdata.repo.test.ts` (query-builder cases rewritten for the new WHERE/limit/offset
and the aggregate sibling) and the new `tests/customerPaging.api.test.ts` (9 live-DB HTTP cases:
envelope shape, page 2, status/branch/search filters, page-size clamp, `all=1`, and a fixture-created
row set — no seeded data). At that point the suite held 1184 tests, 1012 pass, 2 unconditional Windows-only skips, 0 fail;
`npx tsc --noEmit` clean. Next: **DF-02** (refresh the product catalog after save).

## ✅ DF-02 shipped — product catalog refreshes after save (2026-10-24)

`ProductManagement` owns a local catalog fetch, so the App-level `refreshAllData()` never
reached either list: a created/edited product stayed invisible until a branch switch or
reload. The component now bumps a local `catalogVersion` after its own create, edit and
delete and includes it in the catalog effect, and it opts into
`useActivationKey(mode)` so the keep-mounted tabs refetch once when re-activated. The
catalog surface and its two tab keys (`all-stock`, `product-master`) are pinned in
`tests/registerRefreshDomains.test.ts`.

A failed catalog fetch keeps the last loaded rows and shows a rose "Could not load the
product catalog" banner with Retry (the empty state says the catalog could not be
loaded rather than "no matching items").

Live pass on the dev app as superadmin: created a product in Product Master and saw it
immediately; edited its name/category and saw the row update; created one in All
Available Stock and saw it in the full list; deleted both and saw the rows go. Tab
switches produced exactly one `GET /api/products` each (no loop, counted through a
fetch wrapper), and a rejected product fetch kept all rows plus the banner until Retry.
All test rows were removed afterwards (DB back to its 14 products).

At that point the suite held 1184 tests, 1012 pass, 2 unconditional Windows-only skips, 0 fail;
`npx tsc --noEmit` clean. Next: **DF-03** (one shared serial-register cache).

## ✅ DF-03 shipped — one shared serial-register cache (2026-10-24)

The 11 mounted StockOperations hosts each fetched `GET /api/serial-log?all=1`
once behind a latch and never invalidated it, and CreateShipmentForm kept its
own copy: a serial received or sold elsewhere stayed "unknown" (or falsely
IN_STOCK / IN_TRANSIT) for the session, so stock gates refused valid units or
accepted gone ones until a reload.

`services/serialRegisterCache.ts` now exposes a singleton store (pure core in
`serialRegisterStore.ts`): one snapshot, at most one in-flight fetch, first
consumer loads and the rest share it. App invalidates it from the SSE burst for
any `serial_log`-writing domain (`STOCK`, `STOCK_OPERATIONS`, `SERIALS`,
`PROCUREMENT`, `SALES`, `SHIPMENTS`, `CUSTOMER_DEVICES`, `ASSETS` — pinned in
`utils/registerRefreshDomains.ts`) and from `refreshAllData`. StockOperations and
CreateShipmentForm read the shared snapshot instead of fetching their own; a
failed refresh keeps the last rows and shows an amber Retry banner, and the
stock gate now says "Serial Register Unavailable" instead of the old false
"no device with that serial exists" while the register is unreachable.

Live pass on the dev app: opened all 11 stock tabs → exactly **one** register GET
(counted with a fetch wrapper); the header refresh → one more; a forced failure
showed the banner on the visible stock tab and on Create Shipment with rows
retained, and Retry cleared it with one successful GET; the shipment form
mounted without an extra GET. Unit tests cover dedup across 11 consumers,
envelope parsing, invalidation with late-response discard, failure keeping the
last snapshot, and no fetch without subscribers.

At that point the suite held 1184 tests, 1019 pass, 2 unconditional Windows-only skips, 0 fail;
`npx tsc --noEmit` clean. Next: **DF-04** (surface paged-register fetch failures).

## ⭐ Data-fetching audit → tracked task list (2026-10-24)

A read-only audit of every screen's fetch/refresh path ([docs/data-fetching-audit.md](docs/data-fetching-audit.md))
found one P0 — the Customer Master Directory renders zero rows because the client expects a paged
envelope that `GET /api/customers` has never returned — plus four P1s (product catalog stale after
save, a session-old serial-availability snapshot behind seven stock forms, paged registers silently
falling back to partial data on failure, and a financial summary with no realtime refresh path) and
fifteen P2/P3 findings.

The work is broken into twelve independently shippable tasks with solutions, files, acceptance
criteria and verification in **[docs/data-fetching-tasklist.md](docs/data-fetching-tasklist.md)**.
No production code or tests were changed for the audit. Next stop: **DF-01** (restore the customer
directory), then DF-02; update the task file's checkbox and status row in the same commit as each fix.

## ⭐ CI's schema-only database is provisioned by the suites, not by the workflow (2026-10-24)

The GitHub run for `1432446` failed in `npm test` with ten annotations, and nothing it touched
was the cause: the CI service container is built from `scripts/schema.sql`, which contains no
`INSERT` at all, while a developer's `inventory_db` has been seeded by `npm run setup:pg`.
Three live-DB suites read that seed data, so they only ever passed locally:
`bsCalendarMirrorInvariant` (live test, "bs_calendar_years must be seeded"),
`exchangeRefusalAudit` and `assignmentExchange.concurrency` (both, "seed data must provide a
serial-tracked product"). CI was last green on 2026-10-15 (`6597f09`); `e42ccfc` added the
calendar live test and every push since has been red.

The fix belongs in the tests — the rule `tests/fixtures/referenceData.ts` already states — not
in a CI seed step that would hide the same gap from the next suite:

- `tests/exchangeRefusalAudit.test.ts` and `tests/assignmentExchange.concurrency.test.ts`
  insert their own serial-tracked product (`rfa-prod` / `asx-prod`) and register it in the
  in-memory catalogue with `setProducts(...)`, then delete the row and restore the catalogue in
  `after()`. No seeded product is read any more.
- `tests/bsCalendarMirrorInvariant.test.ts` builds a throwaway `inventory_bs_mirror_test`
  database from `schema.sql` and seeds it with the bundled calendar through the server's own
  `buildBsDayRecordsForYear()` (batched inserts, AD date as PK with the later year winning).
  The client generator is still compared against server-written rows, but the app database — a
  developer's or a CI container's — is never read or written.

Verified by creating a schema-only database locally (exactly CI's state) and running those
three files against it: **14/14 pass**, where CI had ten failures. The full suite is unchanged
at 1000 tests.

The remaining CI failure was a teardown race, not a data dependency. `bootstrapFiscalYearHonesty`
(or `fiscalYearFirstCreation` in other runs) failed at FILE level with "test failed" and no test
name. It reproduces locally when the database-creating suites run together:

    Test hook "before" at tests\fiscalYearFirstCreation.test.ts:108:3 generated asynchronous
    activity after the test ended ... "error: terminating connection due to administrator command"
    ✖ tests\fiscalYearFirstCreation.test.ts

Both suites closed their pools and then ran `pg_terminate_backend` on the throwaway database
before dropping it. An idle pooled client killed by that command makes `pg` emit an `error` on
the pool; with no listener, node turns it into an uncaughtException and fails the whole file even
though every test in it passed. Both suites (and the calendar suite added above) now attach
`error` listeners to their own pools and to the app's `realPoolInstance`, and they try a plain
`DROP DATABASE` first — terminating lingering backends only when that drop fails — so the
terminate is off the common path. Stress run: 10 consecutive rounds of the three DB-creating
suites, 0 failures (the old teardown failed one round in three).

With `npm test` finally reaching the end of the gate list, the **audit gate** failed on
advisories published since the last time that gate actually ran (the earlier red runs skipped
it): `body-parser` <1.20.9 / <2.4.0 (GHSA-27r3-jxmh-p828) and `vite` <=6.4.3 (the launch-editor
and middleware advisories). `npm audit fix` cleared all three inside the existing semver
ranges — `body-parser` 2.3.0→2.4.0 with express's nested copy 1.20.8→1.20.9, and `vite`
6.4.3→6.4.5 — and touched only `package-lock.json`; `package.json` is unchanged. Verified:
`npm audit --omit=dev` clean, `npm run build` green, full suite still 1000/998/0/2.

## ⭐ The shell owns its own state, so a modal no longer re-renders the tab tree (A2, 2026-10-23)

A1 stopped a root re-render from re-rendering every opened screen, but the root still
re-rendered on things that are not data at all: the sidebar drawer, the barcode scanner, the
global search overlay, the notification panel, the profile modal and the dismissed-notification
ids all lived in `App`. Opening one rebuilt every tab element in App's render — a lot of work
whose only visible effect was one overlay appearing.

- **`client/src/components/layout/AppShell.tsx`** now owns those six pieces of state. `App`
renders `<AppShell>` with the data props it already had, the bootstrap `banners` and the
workspace `<main>` (tab tree included) as **elements**. A shell state change re-renders the
shell, and React receives the same `children` element object, so the tab tree is skipped
entirely — A1's element cache then keeps the screens themselves from re-rendering. Nothing
about freshness changes: every array, the branch/fiscal-year scope, `activeTab` and the shared
`searchQuery` still arrive as props.
- **The badges moved with the ids that silence them.** The low-stock / PO / approval /
shipment counts read `dismissedNotificationIds`, so they moved next to it; `App` no longer
computes them. `handleClearAllNotifications` moved unchanged (the BS-coverage notification is
still collected there).
- **Screens ask the shell, they don't receive setters.** Help Documentation used to be handed
`onOpenBarcodeModal`/`onOpenSearchModal` from App — passing them through the shell would have
put shell state back into App's render. It now calls `useShellOverlays().openBarcodeScanner()`
([ShellOverlayContext.tsx](../client/src/contexts/ShellOverlayContext.tsx)); the context value
is memoised on the never-changing setters, so a shell state change cannot re-render a consumer,
and the default is a no-op for screens rendered outside the shell. `onNavigateTab` keeps its
one job (tab changes are App's); its old `barcode-scanner` branch is gone with the setter.
- **The shortcuts moved with the overlays they open** (Alt+H/B/S/D, Ctrl+K), including the
"not while typing in a field" and fiscal-year-closing-wizard guards, and the notification panel
still closes on `NAVIGATE_TAB_EVENT` — but from the shell's own listener now, since the panel is
its state.

Measured, not inferred ([tests/appShellRenderCount.test.ts](../tests/appShellRenderCount.test.ts),
5 tests, real `AppShell` around a counting workspace): sidebar toggle, opening the search
overlay, opening the notification panel, Alt+B, Alt+H and Ctrl+K all leave the workspace at
**1 render** — the mount — while the DOM visibly reacts (backdrop, overlay input, panel title,
scanner). A data change still reaches it: 2 renders and the new rows/banner value in the DOM,
which is the regression this refactor could have caused.

Two harness lessons, both real bugs in the first draft of that test: jsdom's `querySelector`
misses attribute values containing `&` (`button[title="Notifications & Reorder Alerts"]`,
`input[placeholder^="Scan Barcode or Search & Enter"]`) even though `querySelectorAll` finds
them — the test now matches attributes in JS. And `assert.equal(element, null)` on failure asks
Node to diff a DOM node whose `__reactFiber` back-pointer is circular, which **exhausted the
heap** instead of reporting an assertion; failures are asserted as booleans now.

A fourth test pins the shape so the root cannot quietly take the state back: `App.tsx` must
not contain any of the six shell flags, must render `<AppShell>`, and the shell must own
`useState`. The fifth drives Escape, the sixth focus return.

**Escape closes the overlay on top (same day).** A browser pass found the cheat sheet
promising "Esc — Close Active Modal or Dropdown" while none of the four shell overlays handled
it: `GlobalSearchModal` even prints "Tip: Press ESC to close" and had no listener. `AppShell`
now keeps a recency stack of the overlays it owns (barcode, search, notifications, profile —
reconciled after every open/close render, so an X or a backdrop click removes the entry too)
and closes the most recently opened one. The handler runs **before** the "typing in a field"
shortcut guard, because the global search input is exactly where Escape is pressed; with no
overlay open the key is left alone for the screen underneath (no `preventDefault`). Stacking is
explicit in the test: drawer first, search on top → Escape closes the search and leaves the
drawer, the next Escape closes the drawer. The header's **account menu** is a dropdown, not a
shell overlay, so `Header` closes it itself with a listener bound only while the menu is open —
that completes the cheat sheet's "or Dropdown" half. When an overlay is opened ON TOP of the menu
(Ctrl+K while the account menu is open), one press must still close one thing: `AppShell` passes
`isShellOverlayOpen` and the menu's handler bails out, so the overlay closes first and the menu
waits for the next press. Covered by the Escape test (menu open → search open → two presses).

**Closing an overlay hands focus back to the control that opened it (same day).** Closing the
search dialog with Escape dropped focus on `<body>`, which resets a keyboard user to the top of
the document (the dialogs have no focus trap either). `AppShell` now records
`document.activeElement` when an overlay OPENS — synchronously in the open helper, before the
modal's own autofocus can become the "origin" — and restores it on every open→closed
transition, whichever path closed it (Escape, the X, the backdrop, picking a result, or the
`NAVIGATE_TAB_EVENT` that closes the drawer). If the recorded origin has unmounted — the profile
modal is opened from an account-menu item that disappears with the menu — focus falls back to
the header control marked `data-shell-trigger`, so it still lands on the profile chip, not
`<body>`. Alt+B from nowhere focuses the header camera button for the same reason.

One behaviour change fell out of this, and it is a bug fix in its own right: the desktop header
search field opened the Global Search overlay on **focus**. Restoring focus to it after Escape
would therefore reopen the overlay instantly, and tabbing through the header used to hijack the
screen with a modal. It now opens on click or typing only (both still call the shell).

Also: `Sidebar`'s dev-only gallery gate is `import.meta.env?.DEV` — `import.meta.env` only
exists under Vite, and the render tests mount it in Node.

Tests: `tests/appShellRenderCount.test.ts` (6, includes focus return). Verification:
`npx tsc --noEmit` clean; `npm run build` green; full suite 1000 tests, 998 pass, 0 fail,
2 skipped; docs-count gate green at 1000. Backlog A2 ticked. Next stop point: **A6** (client test harness + route-tree smoke
test), which gates A3/A4.

## ⭐ One BS calendar integrity engine (API + CLI + boot), provisional years, and no invented dates anywhere (2026-10-17)

Six asks, one thread: make the calendar's honesty a *service* instead of a promise.

**1. `server/src/services/bsCalendarIntegrity.service.ts` — the engine.** One pure core, one I/O shell.
`buildPatroExpectations(years)` expands the bundled patro into the day-by-day truth; `auditBsCalendar(client,
{ years, todayAD })` takes the database handle AND the truth AND "today", so the API, `npm run
audit:bs-dates` and the boot check all run the same code with different inputs (the tests drive it with a
synthetic patro and an in-memory fake, which is why `today` and the reference data are parameters rather
than imports). Eleven finding kinds (`year_config_mismatch`, `year_unverified`, `year_span_mismatch`,
`day_missing`, `day_label`, `day_derived`, `day_outside_calendar`, `stored_bs_value`,
`fiscal_year_boundary`, `fiscal_year_link`, `fiscal_year_current`), each with a stable id, a
current/expected pair, and a `fixable` flag that is TRUE only when the correct value is derivable (from
the patro day, or from the row's own AD date). Application is the same engine: `applyBsCalendarFixes`
re-derives each selected fix server-side inside one transaction, refuses anything not derivable, then
re-audits — the count it returns is the fresh audit, not an assumption. The endpoint never accepts a
value from the browser, only finding ids.

**2. Endpoints + panel.** `GET /api/bs-calendar/integrity` (audit) and `POST
/api/bs-calendar/integrity/apply` (optional `{ ids }`), behind the same role rule as every other
`/bs-calendar/` route. The in-app face is the **Calendar Health** panel
(`client/src/features/finance/BsCalendarHealthPanel.tsx`) at the top of BS Calendar Utility: a summary
(seeded years, patro-verified years, day rows vs patro days, stored BS values checked, provisional
years, patro years missing from the DB), the findings table with stored vs correct, per-row **Fix** for
derivable rows, **Fix all N derivable**, and an explicit line for the rows that are reported rather than
repaired (a year the unpublished patro does not cover, a date with no AD counterpart). Non-writers see
what is wrong but no Fix button. After a repair the panel hands the fresh report back up, so the year
table underneath re-reads itself.

**3. Provisional future-year seeding.** `server/src/services/bsCalendarSeed.service.ts` decides a new
year's Baisakh 1: supplied = `start_ad_source = 'patro'`; otherwise derived from the closest seeded year
below (its end + 1), never the old `${year - 57}-04-14` guess — and if the derived start lands on the
patro's own Baisakh 1 for a published year, the year is verifiably NOT provisional. `is_provisional`
then stays true until the patro confirms it, and the flag is visible in three places: the seed response,
the coverage warning (`getProvisionalYears()` in the client mirror), and the integrity audit (which
reports a provisional year whose start is actually patro data as a fixable `year_unverified`). Columns
added to `bs_calendar_years` (`start_ad_source`, `is_provisional`) with `ALTER TABLE ... IF NOT EXISTS`
so an existing database picks them up on the next boot.

**4. No more `2083-04-16 BS`.** That literal was a real (wrong) date for all but one day, and it reached
stored BS columns. Both copies are gone — the server's `BS_DATE_FALLBACK` and the client conversion's
invalid-input branch, which also stored itself through `CustomersManagement`
(`issuedDateBS: convertADToBS(issuedDateAD).formattedBSShort`). Both sides now carry the same literal,
`BS not seeded`: the server's resolvers return it, `isBsDateMissing()` treats it as missing (so a stored
marker can never read back as a date), and the client shows it in `formatBSDate`/`formatDualDate` and
returns it for an AD value that is not a date at all (`yearBS/monthBS/dayBS = 0`, so no caller can read
the marker as a seeded month). `convertADToBS('')` no longer means "today": only an omitted argument
does. `tests/bsDateMarker.test.ts` pins the shared literal and refuses a drifting second copy;
`tests/bs_date.guard.test.ts` stays green because the engine's own docstring no longer quotes a date.

**4b. …and the guard now covers the client too.** `tests/bs_date.guard.test.ts` used to scan only
`server/src` (`.ts`), which is why the client's copy of that date could sit there and be stored. It now
also scans `client/src` — `.ts` AND `.tsx`, because the offender was a screen-reachable utility — through
the same pattern (`findHardcodedClientBsDates` shares the regex with `findHardcodedBsDates`), so the two
rules cannot drift and cannot disagree about what a hardcoded BS date is. The client allowlist is EMPTY
ON PURPOSE: the fabricated date lived in `client/src/utils/nepaliCalendar.ts`, so exempting any client
file would have exempted the file that regressed the rule. The only thing that was in the way was a
comment in that file quoting an example BS date — rephrased, not exempted. Verified by injection: adding
`'2083-04-16 BS'` to the calendar utility fails the live-tree test with
`utils/nepaliCalendar.ts:27 → '2083-04-16 BS'`, and removing it goes green again.

**5. Calendar changes broadcast.** `resolveDomain` maps the calendar module to `BS_CALENDAR`; App.tsx
lists it in `DOMAIN_STATE_KEYS` with an EMPTY slice list (there is no bootstrap slice to re-fetch) plus an
explicit `syncBsCalendarMirrorRef.current()`, so a seed, a bulk seed, a year edit, a range sync or a
repair resyncs every open client's calendar mirror immediately instead of on the next mount — and
`tests/registerRefreshDomains.test.ts` now counts it as a known, declared no-register domain.

**6. The client's day check is a real day-record check.** `hasExactBSDayRecord` used to test whether the
date fell inside a configured year's span — a SPAN test — while the server read `bs_day_records`, so a
year with a wrong month array passed the client gate and got a 400 from the server. It now asks
`exactAdDateSet()` (the memoized client twin of `SELECT ad_date FROM bs_day_records`), which is the
question the server answers, and its docstring says so (keeping the note about what the old span test
got wrong, pinned by `tests/bsDateMarker.test.ts`).

Tests: `tests/bsCalendarIntegrity.test.ts` (engine: patro comparison, findings, apply, refusal to invent),
`tests/bsCalendarPatroData.test.ts` (the bundled reference, month by month), `tests/bsDateMarker.test.ts`
(marker, client/server day agreement over ~2,000 days plus both edges, provisional seeding) — suite now
900 tests, 0 fail.

## ⭐ BS 2085 checked month by month, every stored BS date audited, and one file to rule them all (2026-10-16)

**BS 2085's internal months — left “unverified” by the 2084 arc — were also wrong**, and in the same
way: the year *starts* right (2028-04-13) but four of its twelve months had the wrong length, so the
last eight months were labelled a day late. Patro read month by month (Hamro Patro
`hamropatro.com/calendar/2085/<month>`, cross-checked with bhitta.app month pages, nepcalendar.com
and nepalicalendar.rat32.com):

| BS 2085 month | Baisakh 1 AD | Days | The copy that shipped |
|---|---|---|---|
| Baisakh | 2028-04-13 | 31 | same |
| Jestha | 2028-05-14 | 32 | same |
| Ashadh | 2028-06-15 | 31 | same |
| Shrawan | 2028-07-16 | **32** | said 31 |
| Bhadra | 2028-08-17 | **30** | said 31 |
| Ashwin | 2028-09-16 | **31** | said 30 |
| Kartik | 2028-10-17 | 30 | same |
| Mangsir | 2028-11-16 | 30 | same |
| Poush | 2028-12-16 | 29 | same |
| Magh | 2029-01-14 | 30 | same |
| Falgun | 2029-02-13 | **30** | said 29 |
| Chaitra | 2029-03-15 | **30** | said 31 |

So BS 2085 is `[31,32,31,32,30,31,30,30,29,30,30,30]` = **366 days**, ending 2029-04-13, with
**Baisakh 1 2086 = 2029-04-14**. BS **2080** had the same class of defect (Poush and Magh 30 days;
the patro has 29 — `[31,32,31,32,31,30,30,30,29,29,30,30]`). 2078, 2079, 2081, 2082 and 2083 were
re-checked and are correct.

**One copy, four readers.** The calendar now lives in exactly one hand-maintained file,
`shared/bsCalendarYears.json` (with its `_source` / `_contract` provenance), read by
`client/src/utils/nepaliCalendar.ts` (the bundled defaults, the `DateField` grid, the presets),
`server/src/config/bsCalendar.ts` (the fallback cache + day-record generation), `scripts/setup_db.js`
(the seeder that writes `bs_calendar_years`/`bs_day_records`) and `tsconfig.json`
(`resolveJsonModule`). The two “+ Seed <year> BS” preset rows now derive their year list and month
arrays from `getSeedPresetYears()` / `getBundledBsYearMonths()` instead of carrying literals, and
`getCalendarBounds()`' empty-store fallback computes its bounds from the bundled data instead of
restating them (its old literals claimed the calendar ended at a day Chaitra 2085 does not have).
`tests/bsCalendarPatroData.test.ts` (+14 tests) pins every patro month start for 2080/2084/2085,
the tiling of consecutive years, the single-source contract (server defaults and client bundle must
be projections of the file, the seeder must `JSON.parse(fs.readFileSync(...))` it and must not
inline arrays, no screen may carry `y === <year> ?` literals) and that **every fiscal-year BS label
in both seed files is a day the patro has and matches its own AD date**.

**The audit (`npm run audit:bs-dates`, `-- --apply` to write).** A repeatable script — not a
throwaway — that diffs the database against the single source in four passes: `bs_calendar_years`,
`bs_day_records` labels *and* their derived `fiscal_year`/`quarter` codes, every `*_bs` column in
the schema (27 of them) against the patro, and `fiscal_years` boundaries/labels. Findings it
corrected, all in one transaction:
- 2,922 day records: 0 mislabelled, but **4 stale derived codes** — days whose label changed when
  2080/2084 were fixed (2027-07-16 stopped being Shrawan 1 of 2084 and became Ashadh 32, which is a
  different fiscal year and quarter);
- the only `*_bs` value in the whole schema that pointed at a day the patro does not have was
  `fiscal_years.end_date_bs`;
- **fiscal-year AD boundaries were a day early from 2081-82 on.** A Nepali fiscal year runs
  Shrawan 1 → the day before the next Shrawan 1, but the seed claimed `2025-07-16` — Ashadh **32**
  of 2082 — as the start of a year whose own label says Shrawan 1, and each year's last day
  belonged to the next year. Ashadh has 32 days in 2082/2083/2084, which is where the drift began.
  Four rows (`fy-2`..`fy-5`) were realigned with their BS labels derived from the new AD dates
  (`2082-03-32 BS` etc.), `bs_day_records.fiscal_year_id` was re-linked by AD overlap (1 linked, 2
  cleared), and `is_current` re-derived (2083-84 still contains today). Checked first: the database
  holds demo data only and **no row of any transactional table sits on a moved boundary day**, so
  nothing re-filed between years.

**Still open (out of calendar coverage, reported by the audit rather than guessed):** `fy-6`
(2085-86) ends 2029-07-15, past the last seeded BS day (2085-12-30 = 2029-04-13), so neither its
`end_date_ad` nor its `end_date_bs` can be derived yet — seed BS 2086 from the patro and re-run
`npm run audit:bs-dates -- --apply` to close it. `tests/bsCalendarCoverageGuidance.test.ts` had
encoded the old 2085 length (`maxBS 2085-12-31`, a day that does not exist); it now asserts
`2085-12-30`, which is also the real end of the coverage countdown.

## ⭐ BS 2084 was a month-by-month error, and 2026-10-15's “either/or” was both wrong (2026-10-16)

The previous arc left the 2084 question open and framed it as a fork: *either* Chaitra 2084 is 29
days *or* BS 2085 starts 2028-04-14, since the seeded array claimed 366 days from 2027-04-14. The
answer the printed patro and four online patros give is a third option: **BS 2084 is 365 days, but
its months are arranged differently from every copy in this repo** — so the *year boundary* was
right while half the year's day labels were not.

Verified against the published patro, read month by month (Hamro Patro
`hamropatro.com/calendar/2084/<month>`, cross-checked with nepcalendar.com, bhitta.app and
nepalicalendar.rat32.com — all four agree on every date below):

| BS 2084 month | Baisakh 1 AD | Days | Checks against today's copy |
|---|---|---|---|
| Baisakh | 2027-04-14 | 31 | same |
| Jestha | 2027-05-15 | 31 | same |
| Ashadh | 2027-06-15 | **32** | copy split the 63 days as 31+32, patro as 32+31 |
| Shrawan | 2027-07-17 | 31 | copy said 2027-07-16 |
| Bhadra | 2027-08-17 | 31 | same |
| Ashwin | 2027-09-17 | 30 | same |
| Kartik | 2027-10-17 | 30 | copy said 2027-10-18 |
| Mangsir | 2027-11-16 | 30 | copy said 2027-11-17, 29 days |
| Poush | 2027-12-16 | 29 | copy said 30 days |
| Magh | 2028-01-14 | 30 | copy said 2028-01-15, 29 days |
| Falgun | 2028-02-13 | 30 | copy said 2028-02-14 |
| Chaitra | 2028-03-14 | 30 | copy said 2028-03-15 |

So the patro array is `[31,31,32,31,31,30,30,30,29,30,30,30]` = 365 days, ending **2028-04-12**,
with BS 2085-01-01 the next day (**13 April 2028**). Chaitra 30 is not a leap-year extra day: the
leap-like effect belongs to the **AD** year (2028 is a Gregorian leap year, which is why Baisakh 1
lands on 13 April), and the 366-day years in this range are BS 2081 (2024-04-13 → 2025-04-13) and
BS 2085.

**Four copies, four answers, none of them the patro's:** the client bundle, both “+ Seed 2084 BS”
UI presets and the server defaults said `[31,31,31,32,31,31,30,29,30,29,30,30]` while the seed
script said `[31,31,31,32,31,31,30,29,30,30,30,30]` — and the seed script is the copy that actually
seeded `bs_calendar_years`, which is why the 366-day story and the phantom 2028-04-13 overlap
existed at all. All four copies plus the live row now carry the patro array. The 182 mislabelled
`bs_day_records` rows of 2084 were corrected **in place** (row count stays 2,922 and every
`fiscal_year_id` link survives — labels move, rows do not), so no schedule referenced by a document
changed identity and the overlap warning is gone.

**Pinned by `tests/bsCalendarPatroData.test.ts` (+6 tests):** the twelve 2084 month starts, the
365-day/2028-04-12 end, BS 2085-01-01 = 2028-04-13, consecutive seeded years tiling the AD calendar
with no gap and no overlap, and the drift gate that actually matters — the client bundle, the
server defaults, the `setup_db.js` seed list and both UI presets must carry identical year data, so
a hand-edited copy can never disagree with the rest again.

**Still unverified at the time — both now closed at the top of this file:** BS 2085's *internal*
months (only its 31-day Baisakh and its 2028-04-13 start were checked then; the follow-up arc read
all twelve from the patro and found four wrong), and the fiscal-year seed writing `2083-12-31 BS` as
an end date when Chaitra 2083 has 30 days (the audit replaced every such label with the value
derived from its own AD boundary). 2078-2083 agree with the patro at every month start probed,
including today (2083-06-30 = 2026-10-16) and BS 2083 Kartik 1 = 2026-10-18.

## ⭐ A refused BS date now names the screen that fixes it — and warns before it bites (2026-10-15)

**Before:** every unseeded-date refusal ended at "please contact your system administrator for BS
month seeding"; the two screens that named a destination pointed at *System Settings*, a menu this
app does not have (the real group is Administration & Governance); and **nothing** warned that
calendar coverage was running out. The first sign of an unseeded BS year was a refused invoice on
the day the last mapped BS day passed — with an admin who never knew to seed it.

**Now — four layers, pinned by `tests/bsCalendarCoverageGuidance.test.ts` (+16 tests):**
1. `bsDateOr400` classifies the refusal (`bsDateReason`: `DAY_NOT_SEEDED` vs
   `BEFORE_/AFTER_CALENDAR_COVERAGE`) and quotes the span it measured, so a gap (re-seed the
   months) is no longer answered with the instructions for an expired calendar (seed the next BS
   year). The payload carries `calendarCoverage`. Both inline gates — shipment dispatch and
   stock-op create — route through the shared resolver, so no call site can drop the context.
2. `fetchJson` turns `bsDateMissing` into a toast **with an action button**: Super Admin →
   BS Calendar Utility, Head Office Admin → Nepali Fiscal Management (the same seeder, on the tab
   that role can actually reach). `App` validates the target through `canAccessTab` before
   switching, so a toast can never land someone on a screen their role cannot open.
3. `getBsCalendarCoverage()` (client) derives days-remaining + status
   (OK / WARNING ≤180d / CRITICAL ≤30d / EXPIRED / UNSEEDED) from the synced mirror. The
   Dashboard shows the countdown card with a **Seed BS Calendar** button, and the notification
   bell carries the same alert (dismissible, and cleared by Clear All). Memoized on a calendar
   store revision, so the per-render callers are O(1) rather than rebuilding ~2,900 day rows.
4. The menu path is one exported constant (`BS_SEEDING_MENU_PATH`), so the seven screens that
   block on an unseeded date cannot drift apart again.

**Also fixed in passing:** `getCalendarBounds()`'s empty-store fallback claimed the calendar ends
2029-04-12; the last mapped AD day is 2029-04-13 (BS 2085-12-30 once 2085 was corrected — the
fallback now derives its bounds from `shared/bsCalendarYears.json` instead of restating them). The docs also said *System
Settings → Maintenance & Data Management* for the demo-data clear; it is **Administration &
Governance → Data Recalculation & Repair**.

### The client calendar mirror listed one more day than the database (2026-10-15)

The dashboard badge said **2,923 days pre-mapped** while `bs_day_records` held **2,922 rows**.
Cause, measured against the live DB rather than reasoned about: `generateCalendarDatabase()`
emitted a record per (year, day) and concatenated the years, so a year whose month array overruns
its successor produced two records for one AD date.

```
BS 2084 = [31,31,31,32,31,31,30,29,30,30,30,30] = 366 days from 2027-04-14
BS 2085 starts                                             2028-04-13
→ 2028-04-13 claimed as 2084-12-30 AND 2085-01-01
```

The database never had the ambiguity — `bs_day_records.ad_date` is the PRIMARY KEY and every seed
path inserts `ON CONFLICT (ad_date) DO UPDATE` year by year, so the later year wins and the table
stores 2085-01-01. Both sides now apply that same rule: the mirror is keyed by AD date (later BS
year replaces the earlier claim, keeping chronological order) and the overlap is `console.warn`ed
once per calendar revision with the exact dates and years, so the underlying bad data stays visible
instead of being silently swallowed. Pinned by `tests/bsCalendarMirrorInvariant.test.ts`
(+5 tests) — the mirror holds one record per AD date, overlaps resolve to the later year, the client
generator and the server's in-memory calendar agree day for day, and the mirror built from
`bs_calendar_years` (exactly as App.tsx bootstraps it) equals `bs_day_records` in both count and
per-date content against a live PostgreSQL.

**Settled 2026-10-16 — and the honest fork above was the wrong question both ways:** the 2084 array
itself was wrong (see the section at the top of this file). It is now the patro array, so the shipped
calendar has **no overlap left** and the later-year tie-break below is defensive only — still proven,
now against a synthetic overlapping pair instead of live bad data.

**Still operator-owned, not code:** somebody must seed each new BS year before Baisakh 1 of that
year — with the shipped calendar that is **14 April 2029**, now visible on the dashboard months
before it arrives instead of discovered on the day.

## ⭐ An unusable fiscal-year master is not a database outage (2026-10-15)

**The defect the last arc recorded instead of fixing is now closed at the source.** `GET /api/bootstrap`
resolved the fiscal year it scopes the payload to and then read `selectedFiscalYear.id` unguarded. With no
fiscal year flagged current — or with an explicit `?fiscalYearId=` naming a year that does not exist — that
read threw a `TypeError` into the handler's own `catch`, which answered
`503 {"message":"PostgreSQL became unavailable while loading application data. Restart the database and try
again."}`. The database was up the entire time, and an operator following that message restarts PostgreSQL,
re-checks DSNs and reads connection logs for a fault that is really one checkbox in Fiscal Year Management.

**The rule now, and it is three different answers for three different problems.**
`selectBootstrapFiscalYear()` ([server/src/utils/fiscalYear.ts](server/src/utils/fiscalYear.ts)) resolves the
year or says *why* it could not:

- explicit `fiscalYearId` that does not exist → **400** `fiscalYearNotFound` naming the id. Deliberately not a
  silent fall-back to another year: serving a view the caller did not ask for is the same class of lie;
- `fiscal_years` empty → **409** "No fiscal year is configured…", naming Fiscal Year Management as the fix;
- rows exist but none carries `is_current` → **409** "No fiscal year is flagged as current…". Not an unscoped
  200: an every-year payload in an accounting system is silently wrong numbers, which is worse than a refusal;
- **503 stays for the case it describes** — a connection that genuinely failed.

**The client was telling the same lie.** `DatabaseSetupBanner` infers reachability from the bootstrap payload
itself, so ANY refusal that stopped that payload rendered as "PostgreSQL Database Setup Required … PostgreSQL
Offline": a connected database blamed for a configuration problem. The client now shows the server's own
message in [client/src/components/common/BootstrapBlockedBanner.tsx](client/src/components/common/BootstrapBlockedBanner.tsx)
(verbatim, with the HTTP status, a Retry and a dismiss), forces the setup banner's `isConnected` only on the
400/409 that prove the application answered, keeps 503 on the database, leaves 401 to the expired-session
flow, and clears the whole thing on the next successful load.

**Verified on the interface, not just in the handler.**
[tests/bootstrapFiscalYearHonesty.test.ts](tests/bootstrapFiscalYearHonesty.test.ts) (6 tests) drives the real
app over real HTTP against a throwaway database built from `scripts/schema.sql` alone, walking four states:
schema-only → 409 + 400, master with none current → 409, one flagged current → 200, explicit non-current year
→ 200 that still reports which year IS current. Every non-200 body is asserted free of the outage claim. Run
against the PRE-fix controller it reproduces the lie exactly — `expected the honest 409, got 503:
{"message":"PostgreSQL became unavailable while loading application data…"}` on all four cases — so the test
can actually fail. Then end-to-end in a browser: a dev server booted against its own throwaway database with
`is_current` cleared, logged in as `superadmin@example.com`, showed
"Application data is not loading (HTTP 409) — No fiscal year is flagged as current, so there is no default
view to load. Open Fiscal Year Management, flag one year as current, then reload." with the PostgreSQL setup
banner ABSENT; flagging `fy-3` and pressing Retry cleared the banner and loaded FY 2082-83 from the live read.

**Also in this arc.** CI now sets a test-only `AUTH_TOKEN_SECRET`, so the per-process warning that opens every
test process
stops firing for an environment that cannot have the problem it describes (nothing restarts, nothing is
multi-instance); the warning itself is untouched for real installs. [handoff.md](handoff.md) claimed a secret
is "generated and stored on first boot" — nothing in the repo writes one, so that now says what the code does
(per-process random secret, every restart invalidates all login tokens, set it in `.env`).

**Branch audit (reported, nothing deleted).** All four local branches — `ISP-Inventory-Management-System-b1`,
`-b2`, `refactor/psql-only-reads`, `agents/hi-what-is-your-skill` — and all three of their remote counterparts
are strict ANCESTORS of `main` (`git merge-base --is-ancestor` = yes, 0 commits not in `main`), i.e. `main`
contains every commit they have; `b2`'s local tip (`d681b3d`) and its remote tip (`4eedc43`) are both
contained. No stashes, one worktree, `main` level with `origin/main`.

**Gates.** `tsc` 0; **817 tests / 205 suites / 815 pass / 2 skipped / 0 fail** with the docs-count gate green at
817; build, bundle budget, no-inline-SQL and no-raw-dialogs all clean.

## ⭐ CI is green on a FRESH database, and a red run now annotates itself (2026-10-15)

**The 14 failures diagnosed last session are fixed at the source — in the tests, not the CI step.** Every
one of them was the same shape of bug: the suite ran against a database created by applying
`scripts/schema.sql` and nothing else, while a booted server (`dbBoot`) and a dev install
(`npm run setup:pg`) always seed reference data FIRST — the demo branch master (`WH001`/`BRH01`), the
fiscal-year master, and the BS (Nepali) calendar in `bs_day_records`. So the failures were data-shaped and
named nothing useful: `bsDateOr400()` 400s every dated write ("BS date is not available for <today>"), an
`inventory_stock.branch_id` FK violation aborted receiveLane403's whole `before` hook (cancelling its 9
tests), and `GET /api/bootstrap` answered 503.

**Reproduced exactly, then closed.** Built a throwaway database from `schema.sql` alone: the same 14 tests
in the same 5 files failed with the same messages as CI (`serialGateHttp` on `ECONNREFUSED` port 0,
salesInvoiceCancel's BS 400 + a `customer_payments.payment_date_bs` NOT NULL violation from its own fixture
SQL, bootstrapTrim 503). One shared fixture now provisions what those suites need —
[tests/fixtures/referenceData.ts](tests/fixtures/referenceData.ts): `ensureDemoBranches()` (the rows `dbBoot`
inserts), `ensureFiscalYearMaster()`, and `ensureBsDayRecords()` / `ensureReferenceData()` which DERIVE the
BS day row from the bundled `DEFAULT_BS_YEARS_SERVER` calendar through `buildBsDayRecordsForYear()` — the
same mapping `setup_db.js` writes. Nothing is a hardcoded BS literal, so a fixture cannot disagree with a
real install or trip the C4 guard, and every statement is `ON CONFLICT DO NOTHING/DO UPDATE` so parallel
files can provision the same rows. A date outside the bundled calendar THROWS instead of skipping.

Same database, after: 0 failures. Full suite on it: `tsc` 0, **811 tests, 809 pass, 2 skipped, 0 fail**
(the 2 skips are the Windows-only real-signal checks), docs gate green at 811.

**Two real defects were hiding behind the fixture work.** (1) `serialGateHttp` set a `skippable` latch inside
`before()` and skipped on it in `test()`, but the skip option is evaluated when `test()` is CALLED during
collection — before any hook runs — so the latch was always `undefined` and the suite failed with
`ECONNREFUSED` instead of skipping; the fixture that always resolves removed the need for the latch
entirely. (2) The bootstrap controller dereferences `selectedFiscalYear.id` unguarded while its own later
use is `pickCurrentFiscalYear(...)?.code` — with no fiscal year configured it threw, fell into the
503 branch and told the user *"PostgreSQL is unavailable"*, which is false. `pickCurrentFiscalYear()` returns
`undefined` whenever nothing is flagged current, a state a super admin can create by deleting/never setting
fiscal years. Left as-is deliberately (the fixture seeds the fiscal-year master, so CI no longer reaches it)
and recorded rather than silently "fixed": the honest behaviour there — 200 unscoped, or an explicit "no
fiscal year configured" — is a product decision, and it is the kind of thing that should get its own test.
**→ That decision was taken and shipped the same day: see the entry at the top of this file (400 for a
nonexistent `fiscalYearId`, 409 for an unusable master, 503 only for a real outage).**

**A red CI run is now diagnosable without authentication.** Job logs need an authenticated API request,
which is what made the last red build unreadable from an ordinary `git`/HTTP workflow. `npm test` already
captures the reporter output; on a non-zero exit it now hands that output to
[scripts/ciTestAnnotations.ts](scripts/ciTestAnnotations.ts), which prints one `::error file=…,line=…`
annotation per failing test (GitHub renders them on the run page and in the Summary tab) and appends a
job-summary table listing every failure. Guessed parser formats would have been worse than none, so it is
pinned to REAL captured reporter output in [tests/ciTestAnnotations.test.ts](tests/ciTestAnnotations.test.ts)
(12 tests, both the spec and TAP reporters). Two deliberate properties: it runs only when `GITHUB_ACTIONS` is
set (elsewhere the workflow commands are terminal noise, and the spec reporter already names every failure),
and it can never change the exit status — the runner still exits with the suite's own code, so a parser
problem costs diagnostics, never a masked or invented failure. Node ships no `github` reporter to lean on
(`node:test/reporters` exports only dot/junit/spec/tap/lcov; `--test-reporter=github` tries to import a
*package* named `github` and crashes) — a test pins that assumption so a future Node can retire the parser.

**Green in real CI, and the last red step was not the tests.** The pushed commit ran on
ubuntu-latest with the PostgreSQL 16 service container: `npm test` (`LIVE_DRAIN_REQUIRE_REAL_SIGNAL=1`, real
SIGTERM, fresh database) passed, as did typecheck, both convention guards, the build and the bundle budget.
The one red step was `npm audit --omit=dev`, for a `source-map-js` advisory
(GHSA-68fv-2mgg-jv7q) published against a `main` nobody had touched — it had never been reached before,
because the suite failed ahead of it since run 84. Fixed the way this repo's dependency policy says to fix
a transitive: an `overrides` entry (`source-map-js@^1.2.2`), not a dependency bump. The vulnerable package
is nobody's direct dependency — it arrives through `@tailwindcss/vite` and `postcss`, and it counts as
production because tailwindcss/vite is a production dependency. `npm audit` is now clean in both scopes
and the lockfile moved by exactly those six lines.

**That layer found its own bug, in CI, on the first push — and the failure was readable.** One test failed
on Linux and nothing else: the TAP fixture is a verbatim Windows capture, whose ABSOLUTE path cannot be
relativized against the Linux workspace, so the parser correctly left it absolute while the assertion
expected a relative path. Reproduced locally by pointing `GITHUB_WORKSPACE` at a Linux path (exact same
actual value as CI), then fixed by letting the caller pin the workspace the capture came from — the parser
now takes an optional `workspace` and the test passes it, while the CLI keeps resolving
`$GITHUB_WORKSPACE` vs. cwd. The regression CI hit is pinned as an assertion too: a path outside the
workspace is never passed off as relative. Worth noting *how* this arrived: the run page named the suite,
the file, the line and the reason without a job log, and the annotation step reported
`annotated 1 failure entry` — the thing this session built, diagnosing the thing this session built.

## ⭐ Failed boot now exits 1 — a dead instance can no longer look "online" (2026-10-14)

[server/index.ts](server/index.ts) (+34 / −5) and a new guard,
[tests/bootFailureExit.test.ts](tests/bootFailureExit.test.ts).

The boot handler ended with `console.error(...); process.exitCode = 1;`. Setting the exit code only
*asks* Node to exit once the event loop drains — and after a failure that happens past the connect
(`client = await pgPool.connect()` is never released, so the pool holds a live socket and its idle
timer), the loop never drains: the process stayed ALIVE with a pending exit code. pm2 reported that
instance `online` and `docker run --restart always` kept the container `Up` while every request was
refused, so neither supervisor ever restarted it.

Measured A/B on the same failure (a post-connect boot failure, injected through an env-gated probe line
that was removed again), same build pipeline: old handler → still alive at the 25s mark (`timeout` killed
it, exit 124); new handler → `FATAL: server failed to start — exiting with code 1` and exit **1** in under
a second. The reason is written with `fs.writeSync(2, …)` instead of `console.error`, because stderr to a
pipe (pm2 logs, docker logs) is asynchronous and `process.exit` can drop a queued write — a crash-loop
with no reason attached is worse than no log. A listen failure (EADDRINUSE, EACCES) now routes through the
same handler instead of surfacing as a bare uncaught `error` event.

Guard (3 tests, ~4s): boots the real entry (`tsx server/index.ts`) against a closed port and asserts the
process exits BY ITSELF with code 1 and says why, plus a source pin that the boot entry may never go back
to an exit-code-only handler (parsed, not grepped, so the explanatory comment cannot self-trip). Honest
scope note: a *pre-connect* failure (refused connection) exits by itself even under the OLD handler, so the
behavioural test discriminates through the FATAL line while the source pin carries the linger regression —
both were verified to FAIL with the old handler reinstated.

Deliberate trade-off: with a dead database the instance now restarts forever instead of sitting alive while
serving nothing. That is the point — `pm2 status` / `docker ps` should show the truth — and it matches the
fail-closed posture the HTTP layer already enforces (`requirePostgres` → 503).

### Follow-up — the same terminal path now covers runtime fatalities and signals (2026-10-14)

The boot fix left two other ways this process could end badly. Both now route through one lifecycle
module, [server/src/boot/lifecycle.ts](server/src/boot/lifecycle.ts), with [server/index.ts](server/index.ts)
reduced to wiring (the hard-exit pins in [tests/bootFailureExit.test.ts](tests/bootFailureExit.test.ts) moved
with the code — same assertions, new home, plus a new pin that the entry funnels into the shared path).

**1. Runtime fatalities.** `uncaughtException` / `unhandledRejection` had no handler, so the process died on
Node's default dump (exit 1, raw stack, no say in when). They now write the same synchronously-written
`FATAL: <phase> — exiting with code 1` line first and exit 1 **in production**. In development the same
failure is logged loudly and the process KEEPS SERVING — measured before choosing it, not assumed:
`tsx watch` does not restart a crashed child (probe: one crash, no second start within the timeout), so
exiting there would leave `npm run dev` dead until a file changes. The dev line says the state may be
inconsistent and to restart before trusting the instance.

**2. SIGTERM/SIGINT.** There was no signal handling anywhere in `server/`: every `pm2 reload`,
`docker stop` and Ctrl-C killed the process outright, cutting responses mid-flight. Measured A/B on an
otherwise identical server: in-flight response `ECONNRESET`, process exit `{code: null, signal: SIGTERM}`.
Now `shutdown()` stops accepting immediately (so the drain can actually reach zero), ends live SSE streams
(they never complete on their own), lets in-flight responses finish, closes the pool and exits 0. What keeps
the drain correct rather than slow: in-flight requests are COUNTED (`request` → `finish`/`close`, attached
at boot) instead of waiting on `server.close`'s callback, which never fires while a client keeps a socket
pooled — so a healthy shutdown exits in ~70ms with a browser tab connected, and only a request that genuinely
never completes waits out `SHUTDOWN_TIMEOUT_MS` (default 10s, env-tunable), after which the leftover sockets
are force-closed and the exit is still 0. A second signal during a stuck drain exits 1 immediately instead of
waiting for pm2's SIGKILL; a fatality during the drain is still reported as a crash; a signal during boot
(before the listener exists) exits 0 without pretending to drain. `ecosystem.config.js` sets
`kill_timeout: 15000`, because pm2's default (1600ms) SIGKILLs before the drain can finish.

**Guards (18 tests, ~9s, no database).** [tests/lifecycleShutdown.test.ts](tests/lifecycleShutdown.test.ts)
drives the module through injected seams (a fake exit that throws, captured writer/logger) against real http
servers: in-flight response completes + new connections refused + exit 0, a hung request force-closed at the
configured bound, SSE streams ended, second signal exits 1, boot-window signal exits 0.
[tests/lifecycleProcess.test.ts](tests/lifecycleProcess.test.ts) runs
[tests/fixtures/lifecycleProbe.ts](tests/fixtures/lifecycleProbe.ts) as a real child process (bare http
server + the lifecycle, still no PostgreSQL): production exits 1 by itself with the reason on stderr for both
fatality kinds, development stays alive, SIGTERM finishes the in-flight response and exits 0, a second signal
exits 1, `SHUTDOWN_TIMEOUT_MS` bounds the drain. Signals reach the probe over stdin as `process.emit`,
because Windows cannot deliver a POSIX signal to a child at all; the single test that uses real OS delivery
is skipped on Windows and runs in Linux CI. Discrimination was checked against the old behaviour: plain Node
exits 1 in development (so "keeps serving" fails without the handler), prints no `FATAL:` line (so the format
assertion fails), and the old server's in-flight response is cut with `ECONNRESET` with the exit reported as a
signal (so the drain assertions fail).

**The live check that closes the loop (CI, 2026-10-14).** The seams above prove the *decisions*; nothing
proved them on the real entry under a real signal. [tests/lifecycleLiveDrain.test.ts](tests/lifecycleLiveDrain.test.ts)
(1 test, ~6s, Linux CI only, and required to run there — see the skip-as-failure note below) creates its own
throwaway database (`inventory_drain_test`, dropped after), boots
[server/index.ts](server/index.ts) against it in the deployment's own shape (`NODE_ENV=production`, with the
discrete `POSTGRES_*` options pinned to the throwaway so no precedence question can aim the boot at the
application database — measured on pg 8.23: `connectionString` wins over them), provisions its own login
account (CI databases are FRESH — the suite may never assume seeded users), and then sends a REAL `SIGTERM`.

Overlap is proven, not slept: the login POST declares its `Content-Length` and withholds the last bytes, so
express's body parser is still waiting and the handler has not run. The child's own shutdown line must
therefore read `draining 1 in-flight request(s)` — that count IS the proof — and the withheld bytes are
released only AFTER the signal, so the login (scrypt verify plus a real `users` query) must still answer:
asserted 200 with a usable token, which doubles as proof that the pool stays usable during the drain. The
process must then have exited 0 by itself (not by signal, not by the test's fail-safe) with the port
released.

Discrimination was measured, not assumed: completing the body ahead of the signal makes the child log
`draining 0 in-flight request(s)` and the test fails on exactly that line; aiming the child's boot at a
second bootable database makes the isolation query fail with `relation "users" does not exist`, so the check
cannot quietly degrade into asserting against the application database. Both probes ran in temporary copies
that were deleted afterwards.

The check's remaining hole was that its only real-signal run lived in Linux CI, where nothing forced it to
actually *run*: a runner-image change, a missing service container or a user without `CREATEDB` would have
turned the proof into a green skip that nobody reads. `LIVE_DRAIN_REQUIRE_REAL_SIGNAL=1` is now set on the
`npm test` step, and under it every skip in this file becomes a failure naming the unmet precondition
(platform, `DATABASE_URL`, reachability, `CREATE DATABASE`); local and dev runs leave it unset and skip as
before. Verified both ways: with the variable on this Windows box the check exits 1 with
`process.platform is "win32"`, and a temporary copy that pretends to be POSIX-capable skipped an unreachable
PostgreSQL with exit 0 unset but failed with `connect ECONNREFUSED 127.0.0.1:59999` when set. Full suite
after the change: `tsc` 0, **811 tests, 809 pass, 2 skipped, 0 fail**, docs gate green at 811.

**Ran it on Linux, which is the only place it counts.** The real-signal path had only ever been *argued*;
`gh` does not exist here, Docker and WSL2 do not work on this machine, and CI job logs need authentication.
A throwaway branch (`diag/ci-logs`, deleted afterwards) ran the suite on ubuntu-latest and committed the
output back into that branch, where plain `git` can read it — the whole job log, no token, no truncation.
Result: `✔ a real SIGTERM lets an in-flight request complete, then the process exits 0 (2474ms)` — the check
RUNS and PASSES on Linux against the PostgreSQL service container with `LIVE_DRAIN_REQUIRE_REAL_SIGNAL=1`,
which is precisely the claim this session could not make before.

**That run also exposed why CI had never been green since Oct 5.** `npm test` never finished: all 8 tests in
[tests/lifecycleProcess.test.ts](tests/lifecycleProcess.test.ts) passed and `tsx --test` still had not exited
150s later, so run 100 sat in the npm test step for 86 minutes and could never report anything. Isolating the
file with `--test-name-pattern`, one test per run, named the culprit exactly: the two *development* tests,
which SIGKILLed the probe. Two fixes, both measured in CI: the parent's end of the child's stdin pipe is
now destroyed on exit (on Linux it outlives the child and stays active; this file is the only one holding
such a pipe, and my own live-drain check uses `stdio: ['ignore', ...]` — which is why it always exited), and
the survivor is stopped with SIGTERM + `assert exit 0` instead of SIGKILL (a stronger claim than "we killed
it", and it removes the unresolved promise that held the runner). Windows keeps the hard kill, because it
cannot deliver a POSIX signal at all. Verified in CI: every one-test run exits 0, the file exits 0 in 5.5s,
and `npm test` exits on its own with its real result. `ci.yml` also gained `timeout-minutes: 30` so a future
wedge fails in minutes instead of burning the 360-minute default.

The same Linux logs show the suite is still RED for reasons that predate this work (first failing run: #84,
Oct 5). 14 tests across 5 files fail because they expect state that exists in a seeded development database
but not in CI's fresh one: `bs_day_records` is empty (so the BS date gate 400s every dated operation —
salesInvoiceCancel 7, shipmentAuthz 1) and the demo branches `WH001`/`BRH01` are absent (an
`inventory_stock.branch_id` FK violation aborts receiveLane403's whole `before` hook). serialGateHttp
already knows it cannot run without a seeded BS day, sets `skippable`, but returns before it listens while
its tests only honour `skipNoDb`, so they fail with `ECONNREFUSED` on port 0 instead of skipping; and
bootstrapTrim gets a 503 from the bootstrap controller while the app's pool has no established connection in
that process. Recorded here rather than fixed in place: it is its own piece of work.

## ⭐ dist/server.cjs boot fix, junk/dead-code sweep, ledger dedup (2026-10-14)

**+270 / −1,131** tracked lines across 43 code files, plus two new files
([LedgerView.tsx](client/src/components/common/LedgerView.tsx) and the boot guard test) and four doc edits;
closed by the usual gates: `tsc` 0, **811/811 + docs gate**, `npm run build`, `check:no-inline-sql`,
`check:no-raw-dialogs`.

**The production bundle could not boot at all — now it does.** `dist/server.cjs` (what `npm start`, pm2's
`ecosystem.config.js` and the Dockerfile run) died during startup with
`PostgreSQL startup failed: The "path" argument must be of type string or an instance of URL. Received
undefined`, thrown by `loadSchemaSql()`: esbuild lowers `import.meta` to an **empty object** in cjs output,
so `fileURLToPath(import.meta.url)` was `fileURLToPath(undefined)` — and it threw while COMPUTING the
candidate list, before the loader's `process.cwd()` candidate could be tried, so the boot could not recover.
`npm run dev` stayed healthy (tsx is real ESM), which is exactly why nothing here caught it: every test
imports the sources and none of them ever boots the bundle. dbBoot now resolves its directory through
`__dirname` in the bundle and the started script under tsx/ESM, with `process.cwd()` still first. Proven on
the built artifact, both directions: the pre-fix bundle printed the TypeError and never listened; the fixed
one logs the schema sync + seeds/caches/permission matrix, listens on :3000 and answers `/api/health` 200
and `/` 200 text/html. The esbuild `"import.meta" is not available with the "cjs" output format` warning is
gone with it. New guard: [serverBundleBoot.guard.test.ts](tests/serverBundleBoot.guard.test.ts) — four
source pins (no server source may read `import.meta`; both runtime resolvers; the cwd-first candidate order;
and "the start command is still the CJS bundle" so the premise stays honest) — verified to FAIL with the
original line reinstated.

**Nothing unreachable is left.** A type-checker pass over all 1,463 module exports now reports **zero**
exports that no other file references (was 8). Removed: three SQL constants no code executed
(`STOCK_RETURN_QOH_SQL` — already superseded by `STOCK_RETURN_QOH_BATCH_SQL` — plus
`SERIAL_LOG_LOCK_HISTORY_SQL` and `LOCATION_UPDATE_SQL`), the `QueryExecutor` interface duplicated into
three repos where nothing used it (only `bootstrap.repo.ts`'s copy is live, so their `QueryResult`
imports went too), the duplicate `getDocumentNumberConfigs` in
[documentNumbering.ts](client/src/utils/documentNumbering.ts) (the live one is `services/api/inventory.ts`
→ `api.getDocumentNumberConfigs`), and the vestigial `INVENTORY_OPERATIONS` operation-id registry in
`permissionMatrixData.ts`. That last one is the interesting one: the DB seed walks
`Object.entries(DEFAULT_PERMISSIONS_MATRIX)`, so a parallel id list could only drift out of sync with
nothing to notice — the register-audience guard now pins the seed loop in `dbBoot.ts` instead and asserts
the list never comes back. The earlier pass in this sweep removed 228 unused import specifiers (the route
files still imported the in-memory state and `pgPool` they stopped reading when the controllers took over),
the unreferenced `isOperationAllowedForRole` / `isBranchAllowedForUser` copies, the deprecated `nprFormat`
aliases and the damage-service leftovers. A whitespace-only tidy pass followed, so the reformatted import
blocks carry no filler lines.

**The duplicate *.tsx pair is one document now.** `CustomerLedger.tsx` (330) and `VendorLedger.tsx` (327)
were ~80% the same file — same filter card, same four score cards, same seven-column table with an opening
and a closing row, same CSV export — differing only in vocabulary and color direction (a receivable is
healthy positive, a payable healthy negative). Both are now 142-line configs rendering
[LedgerView.tsx](client/src/components/common/LedgerView.tsx) (395 lines), placed under components/common
so it stays out of the screen-count and screen-surface tables. Each screen keeps its own
`useActivationKey('customer-ledger' | 'vendor-ledger')` and its own `api.getCustomerLedger` /
`api.getVendorLedger` call, so the register-refresh pins still point at real code. Both also stopped
accepting a `selectedBranchId` prop they ignored, and App no longer passes one. Verified as rendered output,
not just types: both configurations, both screens and the vendor empty state were rendered through
`react-dom/server` — party code, Invoice-vs-Bill badge, AD/BS date column, opening/closing rows, score-card
labels and export labels all match the old markup.

**Junk docs and artifacts.** `docs/audit-report-2026-09-30.md` (orphan snapshot quoting 470/470 tests and a
recommendation `run_tests.mjs` has since implemented), `NOTE-merge-sales-form.md` (status DONE; every open
follow-up has since closed — the old product-sale block is gone, the SSE token is read inside `connect()`,
and `App.tsx` no longer carries the dead `serialLogs` state) and 143 KB of `.freebuff/preview.log*` tool
artifacts are gone. `UPDATEPROCESS.md`'s no-inline-SQL sample output no longer quotes a controller count
that drifts every time a domain moves. Nothing deleted here was still referenced by a file or a test.

## ⭐ Serial register Slice 2 DELIVERED (2026-10-13) — one gate, no silent skips

Every endpoint that draws a unit out of branch stock now resolves its serials through ONE server-enforced
rule — [serialGate.service.ts](server/src/services/serialGate.service.ts) — against `serial_log`, under the
operation's own row lock. Unknown serial, unit already sold/assigned/damaged, or held at another branch →
typed refusal (`SerialGateError` → `400`) naming the register's own reason. Wired:

- **sales** — stopped being its own second implementation of the rule (keeps its claim `SI_CLAIM_SERIAL_SQL`,
  because Sales Returns flips it back symmetrically);
- **fixed-asset deploy-from-stock** — used to look the serial up and **silently skip** the register flip when
  it was absent, deploying against branch stock anyway;
- **stock operations** (DAMAGE / PULLOUT / STOCK_OUT / CONSUMABLE_ISSUE) — used to match the **in-memory
  `customer_device_records` mirror outside the transaction**; now the register, locked, and the demo-mode
  (PG-down) path runs the same rule against the register mirror so both modes refuse identically.

Deliberate boundary: the gate owns **resolution and refusal**; the lifecycle transition stays with its owner
so reversals stay symmetric. Pullout / consumable issue / product stock-out resolve but flip no status — the
register vocabulary has no such state and neither reversal path restores a serial, so flipping them now would
strand a unit as permanently unsellable. That transition + its reversal is the next step.

Also fixed: the deploy path wrote the asset into the in-memory register **before** its transaction, so a
now-refused deploy would leave a phantom asset — the mirror write moved after the commit.

Evidence: [tests/serialGate.service.test.ts](tests/serialGate.service.test.ts) (16 pure rules tests, no DB) and
[tests/serialGateHttp.test.ts](tests/serialGateHttp.test.ts) (5 HTTP checks against real PostgreSQL: unknown
serial refused and moves **no** stock / records **no** operation; `CUSTOMER_ASSIGNED` refused by state;
other-branch refused by branch; valid `IN_STOCK` posts and consumes; deploy-from-stock with an unknown serial
refused instead of silently deploying).

## ⭐ Serial register Slice 1 DELIVERED (2026-10-13) — purchases write the register

`POST /api/purchase-invoices` is now the live writer of `serial_log`: one row per received unit, in
the invoice's own transaction, so a unit bought this session is `IN_STOCK` and **sellable without a
restart**. What else shipped:

- **Rejections before any write** (`400`, nothing posts): blank device serial, a serial-tracked line
  whose serial count ≠ quantity, `SERIAL_MAC_PON` without PON or MAC, and repeated device serial /
  PON / MAC inside one bill. A unit already registered is `409` — except a `RETURNED_TO_VENDOR` row,
  which is re-activated in place keeping its id and history.
- **The register's uniqueness now matches CDR.** `uq_serial_log_pon_serial` and
  `uq_serial_log_mac_address` (partial, non-empty only) were added in [scripts/schema.sql](scripts/schema.sql)
  inside a guarded `DO $$` block — a legacy DB with duplicates logs a WARNING and still boots. This
  closes the check-then-write race the owner probes alone cannot; `23505` now maps to a readable `409`.
- **The purchase form stopped inventing identity.** The random `SN-<SKU>-<random>` serial and random
  PON are gone; quantity changes seed empty per-unit rows, and posting is blocked until each slot has
  a real device serial (plus PON/MAC for `SERIAL_MAC_PON`).
- **Deleting a bill takes its register rows with it**, keyed on the bill's own serials — never on
  `source_type`/`source_id`, which a later sale/deploy rewrites — and returns `409` if a unit has
  since moved.

Live evidence (real HTTP API, dev server + PostgreSQL 16): **15/15 acceptance checks**, including the
headline "buy it and sell it without restarting"; concurrency probe — five simultaneous bills sharing
one PON → exactly 1 posted, 4 clean `400`s, 0 `500`s, 1 register row. Suite 771/771.

Also fixed while verifying: `scripts/schema.sql` had an **earlier** `transaction_logs_change_type_check`
rewrite whose list omitted the cancellation types, so an ALTER that validates existing rows aborted the
whole file — and since `dbBoot` applies the file verbatim at **every** start, a database that had merely
deleted a purchase invoice could not boot at all. All rewrites now carry the identical value set, and
`tests/schemaSource.parity.test.ts` guards that they never diverge again. `setup_db.js` also reset in
the wrong order (wipe before the schema ALTERs).

Slices 2–5 (one server-enforced branch/status gate, transfer integrity, the shared pick-only serial
input, backfill demoted to a maintenance action) are still open — see
[docs/serial-register-audit.md](docs/serial-register-audit.md#6a-slice-1--delivered-2026-10-13).
_(Superseded 2026-10-25: Slices 2, 3 and 4 are delivered. **Only Slice 5**, the
boot-backfill demotion, remains open; see the temporary `worklist.md`.)_

## ⭐ Serial register: audit + agreed 5-slice plan (2026-10-13, read-only)

> **Superseded 2026-10-25 (DOC-1).** This section is the audit as written on
> 2026-10-13. Its findings were fixed by Slices 1–4 (2026-10-13 … 2026-10-20);
> only Slice 5's boot-backfill demotion remains open. Retained for history — do
> not re-implement the fixes.

A read-only audit of where device serials are really created —
[docs/serial-register-audit.md](docs/serial-register-audit.md). Headline findings, all
code- and API-evidenced and **not yet fixed**:

- **`serial_log` is a boot-time projection, not a live ledger.** The only row-creating
  paths are `backfillSerialLog()` (boot), the serial-rename service and the demo seed;
  `SERIAL_LOG_INSERT_SQL` / `SERIAL_LOG_UPDATE_SQL` are exported and imported but have no
  call site. Every other writer flips a row it assumes exists.
- **Purchasing does not register serials.** `POST /api/purchase-invoices` stores the pairs
  in `items` JSONB and receives stock; nothing writes `serial_log`, so a unit bought this
  session is invisible to the sales gate ("only IN_STOCK units can be sold") until restart.
  The purchase form is also the only serial surface with no validation, and it invents
  `SN-<SKU>-<random>` + a random PON.
- **Assign Fixed Asset validates the (serial, PON) pair client-side only**; `post_assets`
  accepts an unknown serial and silently skips the register flip. The panel still pre-fills
  a random serial and a constant MAC, and its existing-asset branch still fabricates a
  serial and fires a second `createCustomerDevice`.
- **Transfers are register-blind** — `shipments.controller.ts` has no serial handling at
  all; `IN_TRANSIT` / received serial states exist only via the boot backfill.

Agreed contract (confirmed with the user): PI is the **only** writer, every other screen is
pick-only against an `IN_STOCK` row at the acting branch, `tracking_type` drives which
fields are required, and no form may invent identity. Delivery is sliced — (1) PI upserts
register rows transactionally, (2) one server-enforced branch/status gate, (3) dispatch
claims `IN_STOCK → IN_TRANSIT` and receive lands it, (4) shared serial picker across the 13
screens + a read-only lookup usable by branch roles, (5) backfill demoted to an explicit
maintenance action. Slice 1 is the first move: it unblocks selling freshly purchased stock.

## ⭐ CPE register: deploy-from-stock writes the customer row atomically + Actions audit (2026-10-13)

The Customer Device Serials "Actions" audit
([docs/cpe-actions-audit.md](docs/cpe-actions-audit.md)) — every button traced through the code
AND driven live in the browser. Six defects fixed, five round trips executed:

- **Deploy-from-stock now creates the rental-CPE row server-side, in the same
  transaction** as the stock deduction and the serial flip. The Assign Fixed Asset
  panel used to fire a SECOND request (`createCustomerDevice`) after `POST
  /api/assets` committed, so a failure or race left `serial_log` saying
  `CUSTOMER_ASSIGNED` with no row in the customer directory. The panel instead
  forwards `devicePonSerial` / `deviceMacAddress` (columns only the endpoint can
  store) and makes one request. Verified live: one `POST /api/assets` produced both
  registers agreeing.
- **A plain INSERT cannot re-rent a unit.** `uq_customer_device_device_serial`
  rejected the second row for the same serial and rolled back the whole deployment
  (`500 duplicate key …`) — caught by running the browser round trip, not by reading
  the code. Deploy and exchange now write serial-keyed (`CDR_SERIAL_ROW_SQL` +
  `CDR_REDEPLOY_BY_SERIAL_SQL`: no row → insert, closed row → re-activate in place
  keeping the row id, active row → leave alone), with `upsertCdrMirror` as the
demo-mode twin.
- **Exchange moved no stock at all**, though the form promises "Restock to Branch
  (+1 Stock)" and "Quarantined RMA Stock": restocked units vanished from branch
  inventory and RMA units never reached the damaged bucket. Both dispositions now
  credit the right bucket and write a ledger row (verified live: RESTOCK →
  `quantity_on_hand` +1; DAMAGE → `damaged_qty` +1).
- **The Exchange form pre-filled a random serial and a constant MAC**, so the
  second exchange from the form died on `uq_customer_device_mac_address`. Both
  fields start empty (🎲 Auto-Gen stays as an explicit opt-in); a serial/PON owned
  by another device now returns 409 before any state is touched.
- **The customer-device register never re-fetched**: `registerRefresh.customerDevices`
  was bumped by the SSE handler but no consumer received it, so an approved
  disconnect left the row on its pre-approval `RENTAL` badge until a page reload.
  Both consumers (the register and the customer master directory counts) are wired,
  and `ASSETS` events refresh the register too (that endpoint writes it now).
- **Multi-unit serialized bin lines duplicated one physical device** (same serial on
  every unit + fabricated serials for the extra CDR rows); only the first unit
  carries the identity now.

Residual gaps are listed in the audit doc — the biggest is that the Exchange
replacement unit's own stock is neither validated nor deducted (a 1-for-1 swap is
assumed within the fulfilling branch), and `PATCH /api/customer-devices/:id/status`
carries no role guard while the sibling exchange route does.

## ⭐ UX fixes from the damage walkthrough: central API-failure toast + real `inert` (2026-10-10)

Two defects the damage-then-reverse walkthrough surfaced in the CLIENT:

- **Silent server rejections (fixed centrally):** a failed save died as an
  unhandled promise rejection — the damage form neither saved nor explained
  why (walkthrough: `Insufficient inventory … Available: 0` on a 400). Rather
  than patching each call site, the request pipeline now owns it:
  `fetchJson` (services/api/http.ts) attaches a toast intent to EVERY failed
  request and broadcasts `inventory_api_toast` for failed MUTATIONS; the new
  global `components/common/ToastHost.tsx` (mounted once in App.tsx) renders
  it — one toast at a time, auto-dismiss, `role=status` + aria-live.
  Deliberate scope: **401 is NOT toasted** (the expired-session flow owns it)
  and **GETs are NOT toasted** (background refreshes — a DB outage would spam
  a toast every poll).
  The four stock-op panels (LabelDamage, CreatePullout, ProductSale,
  ConsumableIssue) gained a `catch { return; }` around `onCreateOperation`
  that exists ONLY to stop their success path (clear form / success dialog /
  tab switch) after a rejected write — the toast is already shown centrally,
  and the panel's items stay editable for a retry.
- **`inert` was a no-op (fixed):** KeepMounted passed `inert: ''`, which
  React 19 warns about ("Received an empty string for a boolean attribute")
  AND treats as **false** — so hidden keep-mounted tabs were never inert. Now
  `inert={!visible}`: verified live, all 66 hidden tab wrappers report
  `inert === true`.
- **Serial validation stays MANDATORY (message only):** the walkthrough's
  "can't tag a serialized product" is by design for serial-track products —
  `validateSourceBranchStockAndSerials` still hard-blocks a serial that is not
  IN_STOCK at that branch, but the dialog now says WHY, whether the serial
  exists elsewhere (registered at another branch / wrong status / not
  registered at all), and the exact next step (Customer Device Serials →
  receive into that branch → retry).

Verified in the browser against the real server: a deliberate 400 on the
Damage form shows the server's own message as a toast and the form keeps its
items. Gates: `tsc` 0, `npm test` 672/672 (docs gate green), `build` 0.

## ⭐ Receive-lane 403s over real HTTP — found + closed an ungated receive endpoint (2026-10-10)

The four-register audience contract had only ever been pinned at SOURCE level
(registerAudienceContract asserts route-file strings). This pass proves it
over real HTTP — and writing the tests exposed a real hole:

- **HOLE (fixed): `POST /api/stock-operations/:id/receive` had NO server-side
  permission check** — no route gate, no handler check, nothing past global
  auth. `PulloutBinsPanel` only SHOWS the Receive button when the role holds
  `wh-receive-pullouts`, so every role that saw it was fine — but ACCOUNTANT /
  FIELD_TECHNICIAN / AUDITOR (all `false` in the default matrix) could call the
  endpoint directly and credit warehouse stock. Fix: `requirePermission('wh-receive-pullouts')`
  on the route, exactly mirroring the client gate (inventory.routes.ts).
- **Proven by `tests/receiveLane403.test.ts` (+8 tests → 672/672):**
  (1) 401 on both receive endpoints without a token; (2) ROUTE layer — a role
  holding neither lane op is 403 on the shipment receive with zero state change;
  (3) ROUTE layer regression — same 403 on the stock-operation receive (proved
  to bite: removing the gate makes the test fail with 403!==200… i.e. the
  receipt succeeded); (4/7) POSITIVE — each lane's holder really settles stock;
  (5/6) HANDLER layer — the shipment handler re-checks the destination's OWN
  lane op (warehouse dest → `wh-receive-pullouts`, branch dest →
  `branch-transfer-receive`), so a Permission Management toggle stays
  authoritative per destination lane even though the route gate is an OR.
  The two layers are made distinguishable with a SYNTHETIC matrix (PO gets the
  warehouse lane only, FD the branch-transfer lane only) — the defaults give
  both ops identical role sets, which would hide which layer rejected.
- **Test-fixture lesson:** the handler classifies the destination lane through
  the IN-MEMORY `branches` cache (is_headquarters / code / name + the literal
  `WH001`), and tests never run dbBoot — a private fixture branch is invisible
  there, so every destination silently classifies as a branch lane. Destinations
  in the fixture use the real demo branches `WH001` (head office) / `BRH01`;
  only the source branch (`rlt-src`) and all rows keyed by the `rlt-prod`
  product are private, so parallel test files are untouched.
- **Preview walkthrough (damage mark → reverse, live in the running app):**
  verified end-to-end as SUPER_ADMIN on localhost:3000 against real PG.
  Label Local Damaged Stock (PTC001 @ BRH01, qty 1) → POST /api/stock-operations
  200, stock 41→40 on-hand / 1→2 damaged, ledger entry `DMG-BRH01-202610100001-1`
  (DAMAGE −1), damage record created. Then Damaged Stock Matrix → cell's
  "Reverse a wrong damage entry" → picked the op's record (the demo seed
  record DMR-PTC001-BRH01-001 listed alongside was left untouched) → reason
  prompt → Reverse & Restore → stock restored 40→41 / 2→1, ledger
  `…-REV` (DAMAGE_REVERSED +1), op + damage record CANCELLED, demo record
  still IDENTIFIED. Net-zero round trip confirmed in all three places
  (inventory_stock, transaction_logs, damage_records).
  **UX finding (not fixed here):** the damage form's server-side rejections
  (e.g. "Insufficient inventory … Available: 0" when a product has 0 damaged
  units at the chosen branch — the form only labels stock ALREADY counted
  damaged) surface ONLY as an unhandled promise rejection in the console:
  `handleSubmitDamageTag` has no try/catch and no toast, so the form just
  silently does nothing. Also: serialized products cannot be tagged at all
  unless a matching IN_STOCK customer_device_records row exists at that
  branch (the demo DB has none), so the walkthrough used a QUANTITY_ONLY SKU.

## ⭐ Mandatory BS dates — client auto-lookup + server derive-or-400 + schema hardening (2026-10-10)

Full-project audit found every spot where a BS date could go NULL, empty, or
fictitious, then closed all three classes (+8 tests → 664/664):

**Audit result (schema 24 BS columns — 10 NOT NULL, 14 nullable):
holes fixed:**
- `shipments.received_date_bs` stored NULL on receipt when the calendar day
  was unseeded → now `bsDateOr400` (derive from bs_day_records for the
  receipt's own AD date, 400 bsDateMissing when unseeded).
- Client `|| ''` payload gaps: AssignAssetPanel (assets/customer devices),
  FixedAssetRegister, DamagedStockTracking disposal, + CreateShipmentForm /
  PurchaseOrderForm / PurchaseInvoiceForm switched from bare convertADToBS
  to the new `ensureBSDayForAD()` (nepaliCalendar) — resolves from the
  synced seeded calendar and BLOCKS with the BS-seeding toast when the day
  has no exact record.
- Vendor/customer payments: fell back to `BS_DATE_FALLBACK '2083-04-16 BS'`
  (fictitious) and even reused the linked invoice's BS as the payment date →
  derive-or-400 for paymentDateBS AND chequeDateAD/chequeDateBS.
- PI/SI/PR/SR create + SI cancel stamps: `resolveBsDateForLedger` fallback
  replaced by `bsDateOr400` (server-derived, client BS never overrides —
  PI create moves the resolved value after `...req.body` so the spread
  can't shadow it).
- Asset create: acquisition/assignment/linked-PI BS derive-or-400 gates;
  txn stamp `|| ''` gone. FY create derives its BS period server-side
  (client values only for unseeded boundary days, e.g. a future FY start).
- Repo param builders (procurement + sales) THROW on a missing BS instead
  of persisting the fallback (ledger-row builders included).
- Schema migration (idempotent DO block in scripts/schema.sql): backfills
  NULL/empty BS from bs_day_records joins, then tightens ONLY where clean —
  payment_date_bs + timestamp_bs now NOT NULL on all 4 tables; conditional
  CHECKs: shipments received, cheque pairs ×2, stock_operations date_bs
  <> '', fixed_assets acquisition/assignment, cdr issued. Verified live:
  6 CHECK constraints present, 0 remaining nulls.

Test-fixture lessons: fixtures must now carry real BS dates (the throw-loud
repo builders reject BS-less inputs — that's the contract); the
salesInvoiceCancel customer-payment fixture derives its BS from
bs_day_records inline. `BS_DATE_FALLBACK` remains ONLY for display-path
ledger rendering (todayBs when a calendar gap hits an audit row).

## ⭐ Shipment authorization hardening — VULN-001/2/3 fixed, VERIFY-001 answered (2026-10-10)

Security review of the permission/branch-scoping chain found three
high-confidence holes; all three are now fixed with HTTP-layer regression
tests (`tests/shipmentAuthz.test.ts`, +8 tests → 656/656):

- **VULN-001 (stock fabrication):** branch gates only validated the fields
  the CLIENT sent — omitting `sourceBranchId` on POST /api/shipments passed
  every check, skipped the INTER_BRANCH stock deduction (the guard is
  `&& newShipment.sourceBranchId` and the spread erased the WH001 default),
  and receiving such a "ghost dispatch" credited destination stock that was
  never deducted — unlimited stock from the lowest role. Fix: post_shipments
  now authorizes on the EFFECTIVE branch ids (missing source defaults to the
  CALLER'S OWN branch and is stamped after the spread), 400s out-of-scope
  effective branches, and post_receive 400s receipts of null-source legacy
  rows (they never deducted anything).
- **VULN-002 (ungated cancel):** POST /api/shipments/:id/cancel had no
  permission gate (only global requireAuth + branch scoping) — any
  authenticated role in branch scope could force a source-stock refund,
  bypassing both the matrix (cancel-receive is gated; cancel was not) and
  the client-side approval flow. Fix: new `shipment-cancel` matrix op
  (creator parity with shipment-create; ACCOUNTANT/FIELD_TECH/AUDITOR
  false) + `requirePermission('shipment-cancel')` on the route; the audit
  actor now comes from req.user, never `req.body.user` (spoofable) — same
  fix applied to cancel-receive's undo note.
- **VULN-003 (id overwrite IDOR):** create accepted client-supplied ids and
  `ON CONFLICT (id) DO UPDATE SET status, items` overwrote ANY existing
  shipment. Fix: SHIPMENT_FIND_FOR_OVERWRITE_SQL looks up the collision; a
  branch-bound caller gets 403 unless the existing row touches their own
  branches; in-scope overwrites still work and don't re-deduct.
- **VERIFY-001 ANSWER (no over-block — and a dead-code discovery):** the
  hypothesized `branchId 'ALL'` over-block does NOT exist at runtime:
  `enforceBranchAccess`'s by-id resource lookup is DEAD CODE under
  Express 4 — `req.params` is `{}` in `app.use` middleware (empirically
  verified), so the lookup never executes for ANY :id route. Object-level
  enforcement actually happens in the handlers (post_receive's
  destination-affinity), and HQ-wide accounts receive fine (test pins 200).
  ⚠️ If anyone "revives" that lookup (e.g. Express 5 upgrade), the test
  fails loudly. Note the implication for other resources (stock, assets,
  customer-devices): their by-id branch checks in enforceBranchAccess are
  also inert — handler-level checks are the real line of defense.

Matrix note: `shipment-cancel` seeds idempotently via
DEFAULT_PERMISSIONS_MATRIX (ON CONFLICT DO NOTHING), shows up in Permission
Management automatically (ops derive from INVENTORY_OPERATIONS).
Test-file note: use a UNIQUE fixture prefix per test file — node --test
runs files in parallel and shipmentCancelReceive's `DELETE ... LIKE
'crtest-%'` wiped this file's fixtures when they shared the prefix.

## ⭐ Mirror retirement step 4 COMPLETE — serialLogs mirror is demo-mode only (2026-10-09)

The last unfinished half of step 4 (Arc 6 had shipped the FOR UPDATE half):
five narrow `serialLogs` mirror sites still decided or mutated state on every
request even when PG was connected, where the authoritative write/check had
already run inside the same request's transaction:
- post_assets deploy flip IN_STOCK → CUSTOMER/POP_ASSIGNED (controller ~724)
- patch_status unassign restore (`restoreInMemorySerial` ~811)
- damage create quarantine (`quarantineInMemorySerials` ~1132)
- damage reverse restore (`restoreInMemorySerials` ~1334)
- serial-edit clash pre-check + mirror rename (serialEdit.handler ~356/367)

Fix: every site is now gated on `!getPgConnected()` — the mirror serves
PG-down demo mode ONLY. With PG connected the same request already ran
SERIAL_LOG_ASSIGN_ON_DEPLOY_SQL / SERIAL_LOG_RESTORE_ON_UNASSIGN_SQL /
quarantineSerialsInDb / restoreSerialsInDb / the serial-edit duplicate checks
+ cascading-update tx, and cacheRefreshHook re-derives serialLogs from PG
truth before the response is sent (serial_log ∈ CACHE_LOADS; its `apply`
unconditionally reassigns, no rows.length guard) — so the mirror writes were
pure redundancy, and the register reads are PG-backed anyway.

Bonus correctness fix: the serial-edit clash pre-check ran AFTER the PG
rename transaction committed, so a stale mirror row could 409 a rename
PostgreSQL had already accepted. Gating removes that hazard entirely.

Guard: new `tests/serialLogsMirrorGate.test.ts` (+3 tests, +14 assertions →
648/648): source pins all five sites inside an `!getPgConnected()` scope and
pins that the serial_log cache-load `apply` still reassigns from PG rows (the
reconciliation the gate depends on). docs/mirror-audit.md step 4 marked
DONE — retirement steps 1–4 all complete; step 5 (consumer-driven bootstrap
trim) is the last, and it's byte-plumbing, not correctness.

## ⭐ Four-register audience contract — lane permissions, branch scoping, view-only report (2026-10-09)

Kept all four warehouse registers (Receive Inbound Stock & Pullouts,
Receive Branch Stock Transfer, Shipment & Transfer Register, Warehouse
Pullout Report) and enforced each one's audience end-to-end instead of
merging them. Permission chain verified live: Permission Management PUT →
applyServerMatrix → `inventory_permissions_updated` → App re-render →
Sidebar/TAB_PERMISSIONS re-evaluate, server matrix seeded from the client
defaults at boot — so enable=show / disable=hide already works for any op
that HAS an entry; `pullout-report-view` was the one missing entry (the
report had no gate at all), so it was added to INVENTORY_OPERATIONS +
default row + Permission Management, and both nav layers now gate on it.

Server: new `requirePermissionAny(...ops)` OR-middleware (requirePermission
now delegates, matrix + branch-flag logic single-sourced);
POST /api/shipments/:id/receive accepts wh-receive-pullouts OR
branch-transfer-receive, and post_receive adds the real enforcement —
destination affinity (receiver operates the destination branch, HQ-wide
accounts excepted) plus the destination lane's own matrix op, which is what
makes the Permission toggles authoritative per lane. GET /api/shipments
gained requireAuth (it was the only unauthenticated shipments endpoint) and
now scopes branch-bound accounts to shipments touching their branches
(HQ/SUPER see everything; bootstrap already delivered the same scope to the
UI — this closes the raw-API hole). Register 3's Receive button is now
lane+scope gated (FIELD_TECH/ACCOUNTANT/AUDITOR get view-only rows, matching
what the server would 403), and its CANCEL PENDING matcher now recognizes
all three cancel-approval types like ReceiveTransferPanel does. Register 4
is genuinely view-only: PULLOUT_REPORT mode strips onReceiveOperation from
the StockOperations context (PulloutBinsPanel's Receive button gates on it)
and the tab bar returns null so the report can't hop into dispatch/receive
panels. Sidebar badges are lane-scoped (warehouse inbound + pending pullouts
vs the active branch's inbound) instead of one shared in-transit number.

Key finding for the pending "combine the registers' duplicated code" work:
the handler diff shows the cancel flows are NOT duplicates — the register
cancels a RECEIPT (cancelReceiveShipment, CANCEL_RECEIVE_TRANSFER,
RECEIVED→IN_TRANSIT) while ReceiveTransferPanel cancels an IN-TRANSIT leg
(cancelShipment, CANCEL_TRANSFER, →CANCELLED + source refund). Only the
receive-verification workflow (~120 handler lines + modal) is a true
duplicate with behavioral drift (panel guards ensureBsDateAvailable, register
doesn't) — extracting THAT is the safe follow-up; the cancel shells must
stay parameterized by operation, not merged.

✅ DONE (2026-10-09): receive-verification extracted to
`client/src/components/common/ReceiveVerificationModal.tsx` —
`useReceiveVerification` (state + open/qty/serial/notes/confirm handlers,
optional ensureBsDateAvailable gate, notify sink for failures) +
`ReceiveVerificationModal` (the shared ~215-line UI). ShipmentRegister
(1,169 → 859) and ReceiveTransferPanel (1,232 → 931) both inject their own
BS-date gate/toast and keep only their cancel flows locally. The former
silent-failure drift is gone too: confirm now catches and toasts instead of
swallowing the rejection. Component lives under components/common (not
features/), so no screen-count or SCREEN_SURFACE_PINS changes — their pinned
call surfaces are unchanged (receive flows call only the injected callback).

Guard: new `tests/registerAudienceContract.test.ts` (+9 source pins across
routes/middleware/controller/matrix/sidebar/App/StockOperations/register).
Suite 635 → 644; 11 docs-count spots refreshed. Gates: tsc 0, 644/644 +
docs gate, build, no-inline-sql.

## ⭐ Shipments decomposed — register + create-shipment subcomponents; host 2,186 → 398 lines (2026-10-09)

The 2,186-line Shipments.tsx split into three files along its two sub-tabs:
`ShipmentRegister.tsx` (now 859 lines after the receive-workflow extraction — metrics, report filters, table + CSV
export + pagination, and the receive / cancel-receive modal flows; the
screen's three api.* fallbacks cancelReceiveShipment, createApprovalRequest,
cancelApprovalRequest moved with their handlers, so its SCREEN_SURFACE_PINS
entry took them over from the host), `CreateShipmentForm.tsx` (~547 — the
inter-branch transfer form: branch pair, barcode entry, serial bin,
validation, dispatch — fetch-free like PurchaseInvoiceForm, submits through
App callbacks only), and `Shipments.tsx` (398, was 2,186 — host chrome:
PageHeader + header search, sub-tab bar with both count badges, manifest
viewer modal, floating toast, activeTab sync; the duplicate second activeTab
effect was dropped with the split).

State split follows what the chrome renders: the host keeps the 5 filter
primitives + filteredShipments (the header search input AND the REGISTER
badge read them — hoisting also keeps typing at one commit), `lines`
(CREATE badge), tab/viewing/toast state; the register owns its modal and
pagination state, the form owns branch pair + notes. Both children render
inside KeepMounted wrappers keyed on internalTab, so sub-tab switches behave
exactly like the old component-level state — pagination page, open
verification modals and the half-filled form all survive (a plain
conditional render would reset them). The manifest viewer deliberately stays
in the host: a keep-mounted wrapper's display:none would hide the modal
while internalTab === 'VIEW'. Also deleted: the unreachable
`{false && <>…}` duplicate create-form modal (~265 lines of dead JSX).

Guard: a new registerRefreshDomains test pins both KeepMounted wirings, the
hoisted draft bin + host-filtered badge, and the host's zero-call surface;
SCREEN_SURFACE_PINS now reads Shipments: [], ShipmentRegister: [the 3
fallbacks], CreateShipmentForm: []. Coverage 63 → 65 screens (table 52 →
54) — README/handoff/SESSION_NOTES tallies updated; suite 634 → 635 (+1
guard test), 11 docs-count spots refreshed. Gates: tsc 0, 635/635 + docs
gate, build.

## ⭐ Keystroke coalescing — one commit per register search keystroke (2026-10-08)

Typing in a register search box fired TWO commits per keystroke; both are now
coalesced into one by moving the two hook-bridge syncs out of passive effects
and into React's "adjusting state when a prop changes" pattern (adjust DURING
RENDER so the correction lands in the SAME commit as the value that triggered
it):
(1) FilterCard's `setDraft(searchValue)` effect — the controlled/uncontrolled
draft buffer — synced one commit late on every `searchValue` change (even when
the draft already matched, because an equal-value setState from a passive
effect does not bail out); (2) `useClientPagination`'s `setPageState(1)` reset
effect — re-rendered even when the page was already 1 (same non-bailout), and
on page > 1 needed a whole second commit to snap back. Attribution was proven
with a temporary dev Profiler + an effect log: commit 1 = search state,
commit 2 = the effect syncs. Verification in the browser (dev React, 40 seeded
rows): header search typing 3 keystrokes → exactly 3 commits (was 6); typing
on page 2 → 1 commit with the page reset landing in the same commit (range
"16–30 of 40" → "1–15 of 40" in that commit); FilterCard's debounced input →
1 light draft commit per keystroke + 1 apply commit, no redundant sync
commit; Clear button + header↔draft mirroring parity confirmed. Both syncs
were MOVED, not deleted (the draft still mirrors external searchValue
changes; the page still snaps to 1 on filter change), and all 24
`useClientPagination` consumers keep identical semantics — their resetKeys
are render-stable (unstable ones would already have looped the old effect).
Guard: `tests/searchSingleCommit.test.ts` (3 source pins — render-adjust
present in both files, effect-based syncs absent, draft sync still present).
Note: React 19.3 strips `Profiler onRender` from production builds entirely
(0 occurrences in `react-dom-client.production.js`), so production commit
profiling needs dispatch-window wall-clock timing instead. Suite now 635
tests, 0 fail (tsc 0, build).

---

## ⭐ Bootstrap trim — stockOperations/purchaseOrders/purchaseInvoices out of the payload (2026-10-08)

Backlog item 5 done. The three big ledgers no longer ship in
`GET /api/bootstrap`: they are trimmed from the response while
`financialSummary` keeps computing FROM them server-side (AP, damage loss,
VAT, trading summary). Client-side, `refreshAllData` now fires
`hydrateDeferredSlices` after every full bootstrap — three parallel
`GET /api/bootstrap/local?key=<slice>` calls (the exact endpoint the
SSE targeted refresh already uses), so all wholesale consumers —
dashboard/notification KPIs, FY closing wizard, PI PO dropdown, movement
ledger, StockOperations' 12 render sites, global search, financial
statements/VAT/audit reports, returns — keep identical data and
identical freshness; the self-fetching registers never needed the payload.
`BootstrapState` marks the three fields optional (serialLogs precedent).
New guard `tests/bootstrapTrim.test.ts` (6 tests): 2 source pins (controller
no longer serializes the keys; App wires DEFERRED_BOOTSTRAP_SLICES + the
hydrate call) + 4 HTTP proofs against real PG (payload omits exactly those
keys with financialSummary intact; each key still served by
bootstrap/local). Anti-test proof: against pre-trim code all 3 structural
guards fail while the pre-existing slice endpoints keep passing.
Docs: README register table + envelope note, handoff bootstrap section,
trim-list comment rewritten. Gates: tsc 0, 631/631 + docs gate, build.
NOTE: wholesale loading itself continues for the non-register consumers
(moving them to per-consumer paged fetches — wizard FY-scoped, dropdown
open-POs, KPI counts — is the follow-up that would actually cut bytes;
the movement ledger is pinned no-fetch, so it must keep receiving props).
That follow-up shipped on 2026-10-25 (top entry); the slice remains for the
movement ledger and global search.
Left uncommitted.

---

## ⭐ Mirror retirement step 3 — PG-first reads (legacy GET, receive/reverse, rename, exchange) (2026-10-08)

Backlog item 2 done. When PG is connected these four sites now read
PostgreSQL first, with the mirror demoted to demo/PG-down fallback:
(1) legacy `GET /api/stock-operations` (no filters) — previously served
the mirror while the paged path read PG; (2) the receive pre-check;
(3) the damage + consumable reverse guards — via new
`STOCK_OPERATION_FIND_BY_ID_SQL` (repo layer, `STOCK_OP_SELECT_COLUMNS`
aliased full row); (4) `post_exchange`'s full-row read and the
`handleUpdateSerials` rename lookup. Dual-writes preserved: the mirror
copy of an exchanged old record and the received-status flip are now
written explicitly when the read came from PG; the rename still cascades
the mirror in place. New HTTP integration suite `tests/mirrorStep3.test.ts`
(5 tests, real createApp + real PG, skips without DATABASE_URL): PG-only
ops appear in the legacy GET, PG status beats the stale mirror, mirror-only
ops don't leak, receive → 409, reverse → 400 (pre-fix code ran a real
second reversal!), exchange/rename responses seed from PG. Verified the
guards bite: against pre-fix code 4 fail in the full run and the rename
fails in isolation (`'Stale Customer'` vs `'PG Customer'`).
docs/mirror-audit.md findings 4 + 6, retirement order 1–3 and the stale
vendorOpeningBalances rows refreshed (backlog item 7 closed). Still
mirror-first (out of step-3 scope): `patch_status2` status reads, the
`post_customerDevices` duplicate checks, the `misc.controller` approval
lookup. Gates: tsc 0, 625/625 + docs gate, build. Left uncommitted.
NEXT: mirror step 4 remnants (serialLogs' 3 narrow uses) or the
PhysicalStockAudit/Shipments decompositions.

---

## ⭐ StockOperations §G commit 2 — state clusters relocated into panels; host 3,063 → 492 lines (2026-10-08)

Second §G commit: every per-panel state cluster (form fields, submit
handlers, panel-local fetch effects) moved out of
StockOperations.tsx into its owning stockops/*Panel.tsx through the
existing StockOperationsContext setters — pure relocation, no behavior
change; panels destructure exactly what their JSX uses. The host now
cross-tab chrome only: activeTab + initialType sync, the BS-date
availability check, branch filter, the exchange-tab device fetch (the
tab-bar counter), toast, and the submit-flow tab resets. Two more host
pieces extracted: the sub-tab bar → stockops/StockOperationsTabBar.tsx
(249 lines, pinned as the 63rd feature screen) and pure view
derivations → stockops/stockOperationViews.ts (118 lines). Host:
3,063 → 492 lines, 79 → 9 hook sites (target was ~400; the remainder
is the 11 render-site switch + chrome). Guard updates deliberate, not
weakened: the host's surface pin is now its two chrome reads
(`getBsDayRecordByAdDate` + `getCustomerDevices`), the ten submit
mutations moved onto the five mutating panels' own SCREEN_SURFACE_PINS,
and the mount-once `assignSerialLogCache` pin relocated to
AssignAssetPanel; StockOperationsTabBar added to SCREEN_SURFACE_PINS
(coverage 62 → 63). Docs tallies updated (README, handoff,
SESSION_NOTES). All gates green: tsc 0, client noUnusedLocals 0
(baseline 7 → 0), 620/620 + docs gate, build, bundle budget
283.9/320 kB gz. NEXT: same recipe for PhysicalStockAudit (2,552
lines) and Shipments (2,186 lines).

---

## ⭐ §G follow-up: 3 tail panels were name-shifted (label-damage form missing) — fixed + full sidebar walkthrough (2026-10-06)

User reported the damage-label form missing. Root cause: the original
tail spans run LOGS → CREATE_PULLOUT → LABEL_DAMAGE in file order, but
panel names were assigned per an assumed CREATE_PULLOUT → LABEL_DAMAGE
→ LOGS order, so CreatePulloutPanel held the LOGS JSX, LabelDamagePanel
held CREATE_PULLOUT, and LogsPanel held the label-damage form — tsc and
every guard stayed green (contents were each verbatim-correct contiguous
spans; only names were off). Fixed by rotating the three files' contents
to their names (imports/destructures travel with content; exports and
doc comments renamed). Verified all 12 panels' normalized JSX equals
their HEAD 1915de1 span exactly (the two remaining diffs were only an
inner fragment wrapper — semantically identical).

Then walked EVERY sidebar menu in the real browser (dev server on :3000,
superadmin@example.com, PG seeded): 66/66 menu entries render their
correct screen — 61 with matching visible headings, the two
purchase-return entries (hidden by a mid-walk sidebar re-render on the
first pass) and the table-first Damaged Stock Matrix verified on retry,
and each of the 12 StockOperations tabs verified down to its panel
heading (Label Local Damaged Stock → "Label Local Damaged Stock" form,
Create Warehouse Pullout Bin → the pullout-bin form, etc.). Console
shows only pre-login 401s + a benign React `inert` warning — no render
errors, no error boundaries. Presence-only per the user's instruction:
no form functions were exercised.

---

## ⭐ StockOperations §G split EXECUTED — commit 1 "pure move" (2026-10-06, uncommitted)

User: "do necessary steps for better performance and maintainability" →
executed the §G decomposition. StockOperations.tsx: 5,966 → 3,063 lines;
12 verbatim tab-panel JSX blocks moved to
features/inventory/stockops/*Panel.tsx via a single context:
StockOperationsContext.ts (StockOperationsCtx, 131 data/handler members +
56 setter members) — host assembles the ctx object and wraps its return
in the provider; panels destructure exactly what their JSX uses and the
host renders them through `switch (activeTab)`. Host keeps ALL state,
handlers and every api.* call, so the three guard pins (12-method surface
pin, consumable-register render-site guard, single mount-once
getSerialLogs) hold in the host unchanged; panels pinned in
SCREEN_SURFACE_PINS (11 × `[]`, ConsumablesRegisterPanel:
`['getStockOperations']` for its export-all button). Screen coverage
50 → 62; docs tallies updated (README, handoff, SESSION_NOTES). User
cautioned to check the sidebar/menu wiring before removing anything: all
11 App.tsx render sites and all 12 forms verified intact, and the 40
"unused" flags were only generator-added import statements — user
approved removing them (shared components verified still used in 11–33
other files; no form, component, or state touched). All gates green:
tsc 0, client noUnusedLocals 0, 620/620 + docs gates, build, bundle
budget 284.3/320 kB gz, no-raw-dialogs, no-inline-sql. Left uncommitted.
NEXT: §G commit 2 — relocate state clusters into panels to shrink the
host toward ~400 lines; then the same recipe for PhysicalStockAudit and
Shipments.

---

## ⭐ StockOperations decomposition audit — analysis written to FRONTEND-AUDIT §G (2026-10-06)

User: "Audit client side project and suggest for breaking the component. I
think stock operation has almost 8k line of codes." Measured: it is 5,966
lines (largest component; App.tsx next at 3,018), 79 useState, 12 tab
panels (~2,950 JSX), rendered 11 times by App.tsx — so 11 full instances
ride in the keep-mounted shell. Proposed: split by tab panel into
features/inventory/stockops/*Panel.tsx (12 panels + shared/), keep
StockOperations.tsx as a ~400-line host, move state with panels, move the
three guard pins with the code (surface pin, consumable-register
render-site guard, single-serial-fetch assertion), App.tsx untouched.
Two-commit sequencing (pure move, then state relocation), same recipe
afterwards for PhysicalStockAudit (2,552) and Shipments (2,186).
Full proposal + size map: FRONTEND-AUDIT.md §G. No code changed.

---

## ⭐ Tab-switch perf measured before/after keep-mounted — 2 real defects found and fixed (2026-10-06)

Task: "Measure tab-switch performance before and after the keep-mounted
refactor (remounts, chunk loads, time-to-interactive) and document results
in SESSION_NOTES." Method: built the pre-refactor tree (4a02ded) in a
git worktree and both trees' production bundles, served them on
NODE_ENV=production servers (:3001 before / :3002 after, same PG), drove
identical click sequences in a real browser (5 tabs: Category, UoM,
Vendor Ledger, Financial Statements, Product Master + dashboard), and
measured with PerformanceObserver (longtask) + MutationObserver (DOM
counter) + resource timing.

The measurement EXPOSED TWO DEFECTS in the shipped refactor, both fixed:
(1) useActivationKey incremented on EVERY render while visible, so any
state update re-ran the fetch effect — observed live as CategoryManagement
refetching /api/categories in an endless loop (~25 GETs/800ms). Now the
key only moves on a hidden→visible transition. (2) KeepMounted rendered
children unconditionally, so every tab render site (67) — and every lazy
chunk — mounted at startup — contradicting the documented
first-activation design and paying the whole app's chunks+mounts+fetches
on page load. KeepMounted now
renders null until its tab's first visibility (everVisible ref), so a
never-opened tab costs nothing.

Measured results (production builds, identical data, same machine):

| Metric (per RE-activation switch) | BEFORE (remount) | AFTER (keep-mounted) |
|---|---|---|
| DOM nodes replaced (unmount+mount) | 688–1004 per switch (e.g. Category +353/−335, Product Master +873/−139, dashboard +333/−871) | **0** (FinancialStatements' 6-node chart swap only) |
| Lazy chunk fetches | 0 (module cache) | 0 |
| Long tasks (>50 ms) during switch | 0 in these passes (remount work split into sub-50 ms tasks) | 0 |
| API GETs | self-fetch screens 1–5 (remount refetch) | identical 1–5 (deliberate useActivationKey refetch) |
| Scroll/form state on return | LOST (typed Category search wiped — proven live) | **PRESERVED** (same input survived 2 switches) |
| First activation of a tab | chunk fetch + mount (identical both variants; 21 feature chunks for dashboard+5 tabs) | identical |
| Startup | 17 feature chunks (dashboard's static dep graph only), ~1.35 MB transfer | same — AFTER the defect-2 fix; BEFORE the fix it fetched every screen chunk and mounted all 67 tab containers at load |

Net: tab switches stop destroying and rebuilding 300–900 DOM nodes and
cannot lose in-progress form state; network behavior is unchanged by
design (the 11 mount-refetch screens still refetch on re-activation via
useActivationKey, now transition-safe). Lab cleaned up: worktree removed,
measurement servers stopped (an empty ../ISP-pre-keepmounted dir may
linger if a process handle holds it — safe to delete). Re-verified after
both fixes: tsc 0, client --noUnusedLocals 0, 620/620 + docs gate,
build/budget/no-raw-dialogs/no-inline-sql green. No test-count change.

---

## ⭐ Mirror-read audit — one serving-layer violation found and fixed (2026-10-06)

Task: "Audit the server for any remaining reads of the demoted in-memory
mirrors outside the documented fallback chain and fix or report them."
Method: scanned every balanced res.json/status/send body in server/src
(excluding runtimeState/app/dbBoot/bootstrap.controller) for references to
the 30 runtime-state mirrors. Result: every HTTP-serving mirror read except
one is the documented live-first + cache-fallback pattern
(`if (getPgConnected()) try PG → return; catch → log; res.json(mirror)`) —
inventory (stock/ops), procurement (POs/invoices/vendor payments),
masterdata (uoms/suppliers/products/categories), shipments, admin (branches/
doc-number configs/fiscal years), all only serving the mirror when PG is
down or the live read failed. The one violation: GET /api/permissions
served the in-memory permissionMatrix unconditionally — while #7 made the
bootstrap paths serve the matrix live. FIXED in permissions.controller.ts:
get_permissions now reads live via PERMISSION_MATRIX_SELECT_SQL +
rowsToPermissionMatrix, falling back to the mirror only if the live read
fails (same shape as the other live-first GETs). Write-path echoes (PUT
responses returning the just-updated cache, which the post-write hook
re-derives from PG anyway) and the per-request authz read in
middleware/index.ts (enforceOperationalPermissions reading the mirror hot
path, documented operational-cache purpose) are unchanged by design.
Observations (pre-existing, reported not fixed): admin.controller's
set-current-fiscal-year mutates the fiscalYears mirror objects in place
(fy.isCurrent) instead of re-deriving — write-path, works in degraded
no-PG mode; permissions.routes.ts and bootstrap.routes.ts import
permissionMatrix without using it (same class as the 12 pre-existing
server-side TS6133s). Re-verified: tsc 0, 620/620 + docs gate.

---

## ⭐ Mount-refetch screens now refetch on tab re-activation (2026-10-06)

User: "Wire useActivationKey into the 11 mount-refetch screens so their
lists refetch on every tab re-activation, updating the test pins
deliberately." All 11 MOUNT_REFETCH_NO_SSE_KEY screens (BsCalendarUtility,
CustomerLedger, DocumentNumbering, FinancialStatements, NepaliFiscalManagement,
OpeningStockManager, VendorLedger, VendorOpeningBalances, CategoryManagement,
UomManagement, LocationsManagement) now call
useActivationKey('<their tab key>') and carry the key in their fetch effect's
deps, so the list refetches on first activation AND on every re-activation of
the (now keep-mounted) tab. Tab keys pinned in a new
MOUNT_REFETCH_ACTIVATION_TABS table in tests/registerRefreshDomains.test.ts
and cross-checked three ways per screen: the useActivationKey argument, the
activationKey dep in the fetch effect, and the matching visible['<key>']
render site in App.tsx (a wrong/missing key or dropped dep fails with a
precise message). The screens stay whole-list and register-unwired — the
existing mount-refetch guard test only gained the activation-key assertions
and was renamed to say so. KeepMounted.tsx doc comments updated (no longer
"reserved/none wired"); README/handoff/SESSION_NOTES reworded to "all 11
refetch on re-activation"; the suite-count claims moved 619→620 for the new
pin test (docs gate green). Re-verified: tsc 0, client --noUnusedLocals 0,
620/620 + docs gate, build/budget/no-raw-dialogs/no-inline-sql green.

---

## ⭐ Tab-switch churn refactor — keep-mounted tabs (committed 1915de1, 2026-10-05)

User: "Refactor the 66 conditional tab renders to keep-mounted with SWR-style
caching so tab switches don't remount and re-fetch". New
client/src/components/common/KeepMounted.tsx: KeepMountedRoot wraps all tab
renders right after the boot-ternary in App.tsx and tracks the ever-mounted
tab set (never-activated tabs are still NOT rendered); KeepMounted wraps each
tab's element and hides it with display:none + aria-hidden + inert instead of
unmounting it. All 67 conditional render sites in App.tsx
(`{activeTab === 'x' && (` … `)}`) converted to
`<KeepMounted visible={visible['x'] === true}>` (65 via regex + dashboard and
approvals by hand; dev-statcard keeps `&& import.meta.env.DEV` in visible).
Effect: tab switches no longer remount screens — React state, form inputs,
scroll position and lazy chunks all survive a switch. Data freshness is
per-screen and unchanged by the container: props-driven screens stay live via
bootstrap-slice props; the six SSE-wired registers keep reacting to
registerRefresh counters while hidden; the 11 mount/selection self-fetch
screens keep their first-activation fetch and can opt in to
refetch-on-reactivation via the new useActivationKey(tabKey) hook (all 11
now wired — see the NEWEST entry above; see MOUNT_REFETCH_NO_SSE_KEY). Guard
test MOUNT_REFETCH_NO_SSE_KEY still passes unchanged (those screens remain
mount-once); screen tallies unchanged (50 screens; 39 + 11 pins intact).
Re-verified: tsc 0, client --noUnusedLocals 0, 619/619 + docs gate, build/
budget/no-raw-dialogs/no-inline-sql green. No test-count change.

---

## ⭐ Improvement #7 — mirror-drift structural fix IMPLEMENTED (committed 4a02ded, 2026-10-05)

User: "ok, do it" (after FRONTEND-AUDIT §F documented #7 as a recommendation).
GET /api/bootstrap now reads the permission matrix live from PostgreSQL
(new PERMISSION_MATRIX_SELECT_SQL + rowsToPermissionMatrix in
permissions.repo.ts). GET /api/bootstrap/local serves EVERY slice live
from PG: new fetchBootstrapSlice(pool, key, scope) in bootstrap.repo.ts
resolves the payload key through the shared BOOTSTRAP_TABLES configs so a
targeted slice returns exactly what a full bootstrap would (auditLogs
keeps its 200-row payload cap, companyProfile its single row); the
permission matrix folds from its own SELECT, appSettings keeps the
settings-repo SELECT. In-memory mirrors are demoted to operational cache
for other controllers + last-resort fallback when the live read throws
(prev behavior preserved, unknown key can never 500). Effect: manual DB
edits, second server instances and missed cache refreshes can no longer
be served stale. Re-verified: tsc 0, client --noUnusedLocals 0
(server bootstrap controller noise unchanged: same 12 pre-existing
TS6133s as HEAD), 619/619 + docs gate, build/budget/no-raw-dialogs/
no-inline-sql green. No test-count change.

---

## ⭐ NEWEST: Sync-architecture improvements #1–#6 implemented (UNCOMMITTED, 2026-10-05)

User: "proceed for all and improvement recommendations from A to Z" (after the
sync audit found gaps G1–G7). Implemented: #1 reconnect gap-fill (CONNECTED
reconciles `dataVersion` vs `serverDataVersionRef` → refreshAllData; 30s
`/api/sync/version` polling via new `getSyncVersion()` while the stream is
down), #2 broadcasts for PERMISSIONS/SETTINGS/DOC_NUMBER_UPDATED (new
`PERMISSIONS`/`SETTINGS` domains in syncDomains + App DOMAIN_STATE_KEYS; new
mirrorSlices/PG slice serving in bootstrap.controller), #3 AUDIT_LOGGED
emitted from logAuditEvent, #4 SseDomainBurst is set-based (multi-domain
bursts → targeted multi-domain plan, unknown still falls back to full),
#5 exponential backoff 1s→30s ±20% jitter + immediate reconnect on
visibilitychange/online + onStatus callback, #6 BroadcastChannel
multi-tab event relay + cross-tab LOGOUT. #7 (structural mirror drift) is
documented as a recommendation in FRONTEND-AUDIT.md §F, not implemented.
Suite moved **618 → 619** (burst tests rewritten for Set semantics, net +1);
docs counts updated. Full verification green: tsc 0, client --noUnusedLocals
0, 619/619 + docs gate, build, bundle budget, no-raw-dialogs, no-inline-sql.

---

## ⭐ NEWEST: Dead-API cleanup + cancel-receive built + returns/sales-invoices wired as paged registers (UNCOMMITTED)

User: “previously you said there are dead api what are they? … Audit it
properly” → full audit, then chose cancel-receive → *implement properly* and
dead APIs → *remove + wire returns paged*. Suite: **583/583 green** (557 at
`f113806` + 11 cancel-receive + 2 guard pins + 13 new returns tests),
docs-count gate green, screen claims now 50 total / 39 table / 11
pinned-elsewhere.

### Phase 1 — cancel-receive built for real (was an always-400 stub)
- `shipments.repo.ts`: `shipmentReceivedQty()` + `SHIPMENT_UNDO_RECEIVE_*_SQL`
  (guarded stock undo: `quantity_on_hand >= qty` or the UPDATE no-ops).
- `shipments.controller.ts` `post_cancelReceive`: 400 unless RECEIVED/
  DISCREPANCY, 404 unknown, `FOR UPDATE` re-check inside the transaction,
  in-memory mirror kept in sync, audit `CANCEL_RECEIVE_TRANSFER`.
- `misc.controller.ts` approval path: a CANCEL_RECEIVE_TRANSFER approval now
  performs the same stock undo (was a silent no-op); route gained
  `requirePermission('branch-transfer-cancel-receive')` (op already in the
  permission matrix); client `cancelReceiveShipment` now posts
  `/cancel-receive` instead of `/cancel` (which rejected RECEIVED).
- Tests: +5 repo unit, +6 HTTP (`tests/shipmentCancelReceive.test.ts`,
  `crtest-` fixtures seeded in DB **and** the in-memory cache, cleaned in
  after(): undo, one-shot guard, 404/401/403, approval-path revert).

### Phase 2 — purchase-returns / sales-returns / sales-invoices wired paged
- Server: `PurchaseReturnQueryOptions` + WHERE/count/paged builders in
  `procurement.repo.ts`; `SalesReturn*` + `SalesInvoice*` builders in
  `sales.repo.ts`; all three GET controllers grew the PO-style paged branch
  (`?page` → `{data,page,pageSize,totalItems}`, bare → legacy array, `all=1`
  → whole filtered set, filters without `page` → filtered array).
- **The anomaly, root-caused**: `?page=N&query=…` returned a plain ARRAY.
  Cause: the heredoc pipeline that wrote the builders had stripped every `$`
  from `${params.length}` (SQL became `LIKE 1` → `text ~~ integer` error) and
  every `\d` from the AD-date regexes; the controller's `catch` swallowed it
  and fell through to the legacy array, silently defeating paging. Fixed both
  files (restored `$${params.length}` + `\d{4}-\d{2}-\d{2}`), re-probed all
  13 filter/page/all combos live → envelopes everywhere. NOTE for future
  shell writes: this toolchain eats backslashes — build `\` with
  `String.fromCharCode(92)` or use the str_replace tool for code with regexes/
  `$` placeholders.
- Client: `sales.ts` `getSalesInvoices/getPurchaseReturns/getSalesReturns`
  revived with the full paged param set; `ReturnsRegister` LIST tab and
  `SalesInvoices` now self-fetch one server page (seq-guarded `loadRetPage`/
  `loadSiPage`, filter→page-1 snap, prop-array fallback on fetch error,
  internal refresh-key bump after create/cancel/approve/payment).
- SSE wiring: `RegisterRefreshKey` += `returnsRegister`, `salesInvoices`;
  `DOMAIN_REGISTER_KEYS` PROCUREMENT += returnsRegister, SALES += both;
  `bumpAllRegisterRefresh` + App.tsx init + `sseRefreshKey` at all 6 render
  sites (4 ReturnsRegister, 2 SalesInvoices). Guard test updated: REGISTER_KEYS,
  deepEquals, bumpAll records, paged-tripwire (6 screens), surface pins moved
  to PINNED_ELSEWHERE with two new dedicated wiring tests (35/35).

### Phase 3 — dead code removed
- 9 dead routes gone (GET /api/assets, /api/users, /api/audit-trail,
  /api/company-profile, PUT /api/locations/:id, /api/fiscal-years/:id,
  /api/document-number-configs/:id, POST /api/serial-log, PATCH
  /api/customer-devices/:id/serials) + the unreachable duplicate pair in
  admin.routes and the duplicate PATCH + 2nd/3rd GET lookup in
  inventory.routes; 12 orphaned controller handlers deleted (~414 lines:
  get_users, put_Id3/4, get_companyProfile(+2), put_companyProfile2,
  get_assets, get_lookup2/3, post_serialLog, masterdata put_Id2,
  get_auditTrail). `COMPANY_PROFILE_UPSERT_NO_STAMP_SQL` stays — pinned by
  `tests/admin.repo.test.ts` (comment updated, unused import dropped).
- 19 dead client service fns + their barrel entries deleted (getCompanyProfile,
  getCurrentUser, getFiscalYears, updateFiscalYear, getStock, getAssets,
  updateDocumentNumberConfig, getAuditLogs, getTransactionLogs,
  createSerialLogEntry, getCustomers, getApprovalRequests, getBranches,
  getSuppliers, getUsers, getProducts, getVendorPayments, getShipments,
  updateLocation) — each re-verified zero callers first. Smoke-covered GETs
  kept (stock/branches/products/suppliers/customers/fiscal-years/shipments/
  vendor-payments/approval-requests/transaction-logs/doc-number-configs…).

### Phase 4 — tests + docs
- `tests/returns.api.test.ts` (7 HTTP): envelope for ?page on all three,
  REGRESSION pin that query/status/date/branch + page stays an envelope (the
  fall-through bug), legacy arrays without ?page, all=1, out-of-range page,
  401 unauthenticated.
- `tests/returnsPaged.repo.test.ts` (8 unit): `$N`↔param bijection (the
  stripped-`$` class), LIKE/status/date mapping + shape gate, count/list WHERE
  parity, LIMIT/OFFSET clamps.
- README: Paged Register Endpoints table +3 rows (“these seven”), register-
  refresh section now “six registers” + render-site list + tripwire wording;
  handoff: §15.7 six registers, tripwire, audit footnote CLOSED; 11 test-count
  claims 557→583; screen claims 41/9→39/11 (handoff + this file).

## DB-integrity audit + database docs corrected + first-deploy hardening (pushed `f113806`)

User asked for a database-integrity audit, doc corrections, and proof that a
first deployment never fails. Suite: 557/557 green; docs-count gate green.

### Integrity audit
- `npm run integrity:check` → PASS (stock quantities, device identifiers,
  fiscal-year ownership, safeguards all healthy).
- Live `inventory_db` verified: **34 base tables / 595 columns / 223 indexes**
  — matches schema.sql exactly; `tests/schema.drift.guard.test.ts` ran (NOT
  skipped) and passed against the live DB.

### Doc corrections — "30 tables" was wrong (real = 34)
- README + handoff claimed **30 tables in 7 places** (tree comments, step 3,
  §5.1 heading, quick-ref row). All corrected to **34**; handoff §5.1 gained
  the 4 missing rows: sales_invoices, customer_payments, purchase_returns,
  sales_returns (columns verified against schema.sql).
- SESSION_NOTES' "30 tables" mentions are Arc-13 HISTORY (state at that time)
  — deliberately left alone; the docs-count gate exempts historical records.
- Sweep for other stale DB numbers (indexes/columns/constraints) — none found.

### First-deploy hardening — both setup scripts now read `.env`
- README Step 2 tells users to configure `.env`, but NEITHER setup script read
  it: a first deploy with custom creds silently fell back to `securepassword`.
  - `scripts/setup_db.js`: `dotenv.config({quiet:true})` before DB_CONFIG
    (dotenv never overrides real env vars — `POSTGRES_DB=... npm run setup:pg`
    still wins). Remember dotenv v17's banner poisons command substitution —
    ALWAYS `quiet:true`.
  - `scripts/setup_postgres.sh`: new `load_env_file()` — parses simple
    KEY=VALUE lines (strips CR/quotes, skips comments/blank), never overrides
    already-set vars, never `source`s the file (so `$(...)` in .env is NOT
    executed). Regex `^([A-Za-z_][A-Za-z0-9_]*)=(.*)$` — an earlier case-glob
    version broke on single-letter keys → `unbound variable`.
  - README Step 3 gained a "Config source" callout documenting the loader +
    env-var precedence.
- Static verification: `bash -n setup_postgres.sh` OK, `node --check
  setup_db.js` OK; loader probed in bash (CRLF strip, quote strip, pre-set
  env not overridden, `$(touch /tmp/pwned)` NOT executed, single-char keys OK).
- **Real first-deploy proof**: created empty throwaway DB
  `inventory_firstdeploy_test` → `POSTGRES_DB=inventory_firstdeploy_test npm
  run setup:pg` → **exit 0**: schema applied atomically, all seeds succeeded,
  "34 tables" verified, demo rows present. Throwaway DB dropped after.
- `setup_postgres.sh` remains fully idempotent (6-step main: detect/install →
  ensure running → configure_database → run_schema_migration with
  ON_ERROR_STOP=1 + post-verify → test_connection → run_node_seeder), so
  re-running on an existing box is a no-op upgrade path too.

## Duplication audit (phases 1–4) + CI fresh-install proof (pushed `60acf84`…`e8f8de4`, CI green)

Long-running duplication-audit plan executed across four phases plus one CI
hardening step. All pushed to main; client+server `tsc --noEmit` clean,
504/504 tests, bundle budget OK (275.7/320 kB gz startup).

### Phase 1 — shared formatting/nav/styles (`60acf84`)
Consolidated repeated money formatting into `fmtMoney` (nprFormat),
navigation helpers and form styles; exposed the Shipment & Transfer Register.

### Phase 2 — schema.sql becomes the single schema source (`2cbf891`)
`server/src/boot/dbBoot.ts` no longer carries the ~1,000-line inline DDL
template literal — it executes `scripts/schema.sql` via `loadSchemaSql()`
(resolves repo-root file; cwd walk for bundled `dist/server.cjs`). The
former dbBoot-only runtime statements (legacy index aliases, serial-log
ALTERs, currency backfill, fiscal-year default drop, vendor-payment FY
backfill) were ported into schema.sql's "RUNTIME PARITY SECTION".
Guard: `tests/schemaSource.parity.test.ts` (3 tests: no inline DDL in
dbBoot, ported statements present, exactly 36 tables). File-parsing only —
runs everywhere, no DB needed.

### Phase 3 — CACHE_LOADS derived from columnMappings (`2234b5e`)
One table description (`columnMappings.ts`) now feeds both bootstrap and
the operational cache; guard `tests/cacheLoads.parity.test.ts` (3 tests).

### Phase 4 — create-forms extracted out of the register screens (`2b1d54c`)
- `PurchaseOrders.tsx` 1,693 → **995** lines; new `PurchaseOrderForm.tsx`
  (776). `PurchaseInvoices.tsx` 2,712 → **1,452**; new
  `PurchaseInvoiceForm.tsx` (1,320 — includes the PO-link selection +
  checklist modals that used to live in the register's JSX tail).
- Registers keep: paged list, filters, CSV export, VIEW tab, payment /
  products modals, tab-bar. Forms own all form state, totals, submit.
- Contracts: PO form gets `editingPO` (edit entry point keeps its
  IN_PROGRESS/CANCELLED/RECEIVED alert guard, then just `setEditingPO(po)`),
  reports back via `onSaved`/`onCancel`. PI form is create-only: remounts
  fresh per tab switch (no reset needed), `onSaved` (refresh register) +
  `onClose` (navigate back after the 3s success message).
- `OrderFormLine` is declared in PurchaseOrderForm.tsx and **re-export**
  from PurchaseOrders.tsx (App.tsx imports it from there — don't break it).
- Dead code swept while thinning (all were dead at HEAD, surfaced by
  `--noUnusedLocals`): write-only `poLoading`/`piLoading`/`reversalId`/
  `reversalReason`, unused `supplierSearchQuery`, unused `stock` prop on the
  PI form, fully-unreferenced `handleMarkInvoicePaid`, unused
  `useClientPagination`/`useDarkMode` imports in the registers.
- **Pre-existing bug fixed** in the PO-checklist badge: a `` `${isExact ?
  …}` `` interpolation had been mangled into a literal string (badge
  rendered garbage classNames, `isExact`/`isExceed` were dead vars). Now a
  proper emerald/rose/amber conditional with `dark:` variants — worth a
  visual check of *Create Purchase Bill → Link from PO*.
- LESSONS: (1) repo files mix line endings — `PurchaseOrders.tsx` is CRLF,
  `PurchaseInvoices.tsx` is LF; surgery scripts must not assume CRLF
  everywhere. (2) One-off extraction scripts must capture ALL regions
  before deleting any (index invalidation) and delete bottom-up. (3) The
  surgery scripts were one-off and deleted after use — don't re-add them.

### CI fresh-install proof — phase-2 guarantee now enforced on every push (`e8f8de4`)
`scripts/verify_fresh_install.mjs` (+ npm script `verify:fresh-install`,
CI step in `.github/workflows/ci.yml` right after the psql schema-apply):
1. Creates two throwaway DBs (`inventory_fresh_reference` /
   `inventory_fresh_boot`; requires CREATEDB — CI service user and local
   inventory_user both have it).
2. Reference: `scripts/schema.sql` applied directly. Boot: DB left EMPTY,
   then the REAL server (`tsx server/index.ts`, NODE_ENV=production,
   PORT_TO_BOOT=3557) is spawned so **dbBoot executes schema.sql itself**;
   readiness via `GET /api/health`.
3. Diffs both runtime schemas across 7 categories — tables, columns (exact
   format_type/nullability/default/identity), constraints, indexes,
   triggers, sequences, views — and exits 1 with a precise diff on drift.
   Cleanup in finally: kill child → wait exit → `pg_terminate_backend` →
   DROP (plain, then WITH (FORCE) fallback).
- Verified BOTH directions: pass = 34 tables / 595 columns / 362
  constraints / 223 indexes / 14 triggers identical; fail = injected a
  runtime ALTER into dbBoot → caught as "only in booted DB" + exit 1, DBs
  still cleaned up.
- BUGS found while building (both fixed): (a) the server child was spawned
  BEFORE the throwaway DBs were created — fast tsx boots raced and connected
  to a nonexistent DB; spawn only after creation. (b) `DROP ... WITH
  (FORCE)` can't always terminate the dying server's pool backends
  ("permission denied to terminate process") — terminate backends first.
- Editing schema.sql does NOT create drift between the two sides (both get
  the same file) — the script proves *runtime DDL stays out of dbBoot*, not
  that schema.sql matches some external truth.

## Arc 18 — accounting-accuracy wording audit + closing-wizard corrections (pushed `334b22e`)

User asked to scan the app for screens that overstate accounting accuracy (after the
Financial Overview reframe). Findings and fixes:

1. **FiscalYearClosingWizard — WORST OFFENDER, now fixed (code + wording)**:
   Step 3 computed "Total Billed Purchase Invoices" as `inventoryValue × 1.15` (an
   INVENTED revenue figure from an arbitrary 15% markup) and derived "Net Surplus
   Transferred to Retained Earnings" from it. Now: `closingMetrics.totalSalesRevenue`
   added from `financialSummary.totalSalesRevenue` (real posted STOCK_OUT sales);
   Step 3 shows Posted Sales Revenue − COGS − schedule depreciation = "Estimated Net
   Surplus (NOT a retained-earnings transfer)" with an amber no-GL disclaimer.
2. **Wizard's downloadable "IRD Audit Certificate" claimed "OFFICIALLY CLOSED &
   AUDIT LOCKED" and "Approved for IRD Filing"** — a client-side txt cannot approve
   anything. Now: "Fiscal_Closing_Snapshot_FY_*.txt" with "CLOSED IN SYSTEM
   (management lock — not a statutory audit)", unaudited-figures banner, real sales
   line, and "NOT approved for statutory/tax filing — consult a professional
   accountant". Step 6 renamed "Lock Period & Closing Snapshot"; "Compliance Seal"
   wording removed.
3. **HelpDocumentation year-end walkthrough** — synced to the reframed wizard
   (6 steps, no IRD-certificate/trial-balance claims; "Depreciation Schedule Totals"
   instead of "Journal"). No Trial Balance/IRD/Retained-Earnings refs remain in help.
4. **PermissionManagement** — `fin-statements` description now "Financial Overview
   (management view…) — not statutory accounting".
5. **AuditTrailReports** — removed dead accounting code (totalAssets/netEquity
   computed but never rendered).
6. **Confirmed already honest (no change)**: StockValuation ("Potential Gross Profit"
   properly hedged), VatRegister (input tax credit from real invoices).

LESSON (extends Arc 17's rule): the overstatement pattern was **compliance-styled
wording over management data** — fabricated figures (×1.15), statutory certificates,
"retained earnings transfers" that never post. Rule: any financial figure must be
either posted/derived from real records OR explicitly labeled "estimate/management
view"; never claim IRD/statutory/audit approval the system cannot perform.

### DECISION — full accounting ERP / general ledger: DECLINED (2026-09-26, do not re-litigate)
- User explicitly decided NOT to build a general ledger / complete accounting ERP.
  Context: the app is going LIVE ON THE INTERNET, but that does NOT change this —
  do not suggest building a GL, chart of accounts, journal entries, AR/AP ledgers,
  or "real trial balance" in any future session.
- Rationale: statutory correctness (immutable journals, balancing trial balance,
  audit-grade trail) is a second product with permanent legal-risk maintenance
  burden; real accounting software serves the external parties better.
- The BOUNDED alternatives, if ever wanted, are export-oriented only: Tally voucher
  export (accountant imports into real accounting software), VAT return helper
  (format existing input/output tax data for IRD), Accounts Receivable tracking
  (customer ledger + receipts + aging — operational, not statutory). Any of these
  must stay additive and must NOT evolve into posting GL entries.
- The "management view" honesty rule above is the permanent contract for financial
  wording in this app.

Verified: typecheck, build + budget gate, 449/449. Pushed `334b22e`.

## Arc 17 — accordion sidebar + ERP-style Financial Overview + reframe (pushed `318198e` + `cac943e`, CI green)

Two user-facing arcs in one push:

### Sidebar redesign (accordion model)
- Single always-visible column; groups expand INLINE (accordion) — no flyout, no back
  button, no collapse button, no push-mode layout shifting (old `sidebar-push-main`
  CSS + `isSubPanelExpanded` wiring deleted from App.tsx/index.css).
- Menu consolidated 11 → 8 groups (Overview absorbs Serial & Device Tracking; Finance
  absorbs Fixed Assets + Opening Register; Inventory absorbs Import/Export stock; Help
  becomes a footer link). Global search filters items across ALL groups (`/` to focus);
  header has an Expand-all/Collapse-all toggle labeled "EXPAND / COLLAPSE MENU".
- Width: w-72 (288px; 15.5rem ≤1366px); long labels WRAP instead of truncating.

### Financial statements → ERP-style "Financial Overview" (tab id unchanged)
Three iterations landed on the ERP-standard pattern (how SAP/NetSuite/QuickBooks do it):
1. **Statement view** — ONE entity per statement via a "Statement of" dropdown (any
   branch or All-Branches consolidated); columns are PERIODS (current FY | prior FY |
   variance when the "Compare with <prior-FY>" toggle is on). Table width is fixed —
   NEVER grows with branch count. Prior-FY fixed-asset NBV = depreciation schedule
   evaluated at the prior FY's END date (closing position).
2. **Branch Comparison view** — branch-vs-branch analysis lives here: rows = branches
   (grows DOWNWARD), 8 KPI columns, sticky first column, consolidated row pinned,
   per-branch prior-year Total-Assets deltas (▲/▼).
3. **⚠️ REFRAME (decision, `cac943e`)** — the report has NO general ledger behind it:
   equity was a plug (assets − liabilities), no cash/receivables/capital accounts, P&L
   stops at gross surplus. Every FIGURE is real but the statement was not statutory.
   Decision: keep the data, drop the misleading wording. Renamed: menu label
   "Financial Overview"; titles "STATEMENT OF FINANCIAL POSITION" / "TRADING SUMMARY"
   with amber "Management View — not a statutory balance sheet" tagline; "SOURCES OF
   FUNDS", "Net Asset Position (balancing figure — not from a general ledger)",
   "Vendor Payables"; CSV exports `Financial_Overview_Position_*` /
   `Financial_Overview_Trading_Summary_*`. Tab id `financial-statements` and
   permission key `fin-statements` UNCHANGED (no permission-matrix breakage).
   DO NOT re-name these back to "Balance Sheet"/"Net Equity" — if statutory reporting
   is ever needed, build a real GL first (expense journal, receivables, cash,
   capital accounts).

Verified: typecheck, build + budget gate, live production preview both views, 449/449.

## Arc 16 — deep code splitting (pushed `fdfe03c`, CI green — startup payload −96 kB gz, bundler trap documented)

Follow-up to Arc 15's vendor split: the ~358 kB gz startup graph (index.js + static
imports) shrank to **~262 kB gz** (index.js alone: 38 kB → 11.7 kB gz). Two changes:

1. **17 more screens lazy-loaded** in `client/src/App.tsx` (Reorder/Valuation/Ledger/
   Warranty/Category/UoM/Import/Export stock; all finance registers + closing wizard +
   doc numbering + opening stock + vendor ledger/openings; ImportCustomers, Locations,
   ApprovalWorkflowCenter, ClearDemoDataView, DataRecalculationMaintenance) — all with
   the shared `TabLoadingFallback` spinner. Still eager BY DESIGN: Dashboard,
   ProductManagement, StockOperations (11 render sites), PurchaseOrders,
   SerialLogRegister, BranchStockTracking, modals.

2. **⚠️ BUNDLER TRAP — shared modules swallowed into feature chunks** (vite.config.ts):
   Rollup placed the shared `DateField` component INSIDE the FixedAssetRegister chunk,
   so every screen importing DateField (StockOperations, PurchaseOrders, most inventory
   screens) transitively pulled a 40 kB finance screen into its static import graph —
   invisible in source code, visible only by parsing the emitted chunks
   (`grep 'from"./chunk"' dist/assets/*.js`). Fix: file-level `shared-*` chunks for ALL
   `src/components|utils|hooks|contexts` modules. LESSON: after changing manualChunks,
   ALWAYS audit the emitted import graph, not just chunk sizes — a chunk can be small
   while being wrongly wired into everything.

Verification pattern that worked: parse `dist/assets/index-*.js` for
`from"./X"` static imports (the true startup set), then assert each lazy chunk is
absent. Production smoke + 433/433 tests pass.

## Arc 15 — deps modernization + bundle split + CI build/audit gates (backlog #3 + #7 CLOSED, pushed `5318809`, CI green)

Three arcs landed as commits `d9cd443` (exceljs + vendor split + motion removal) and
`5318809` (CI gates).

**Backlog #3 closed — xlsx → exceljs (in `d9cd443`):**
- `xlsx@0.18.5` (Prototype Pollution + ReDoS, no fixed version) REMOVED; replaced with
  `exceljs@4.4.0` behind `client/src/utils/excel.ts` (`readFirstSheetRows` /
  `buildTemplateWorkbook`). The helper preserves xlsx's exact `sheet_to_json(defval:'')`
  contract — empty cells → `''`, numbers as full-precision strings — so the BS calendar
  parser in `BsCalendarUtility.tsx` needed no logic changes, only the I/O layer swapped.
- `tests/excel.helper.test.ts` (4 tests) proves roundtrip + numeric-precision equivalence.
- `npm audit` now **0 vulnerabilities** (was 5 moderate + unfixable xlsx highs); fixes
  via package.json `overrides`: exceljs's transitive `uuid@^11.1.1`, `qs@6.16.0` for
  express/body-parser.

**Vendor bundle split (in `d9cd443`):**
- The 943 kB (272 kB gz) monolithic `vendor` chunk came from two bugs:
  1. `manualChunks` checked `id.includes('react')` BEFORE `lucide-react` — the substring
     'react' swallowed every icon into vendor-react. Fixed with boundary-anchored regexes
     (`/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/.]/`), lucide checked first.
  2. `App.tsx` had zero `React.lazy` — exceljs (940 kB!) rode in the startup vendor chunk
     via statically-imported `BsCalendarUtility`. Now lazy with `<Suspense>` at both
     render sites; exceljs lives in `vendor-excel`, downloaded only on first visit to the
     BS calendar tabs.
- Result: startup payload dropped ~656 kB raw / ~190 kB gz. `vendor-react` 69 kB gz,
  `vendor-icons` 12.7 kB gz (now actually exists), `vendor-excel` 270 kB gz on-demand.

**Dead dependency removed (in `d9cd443`):** `motion` (framer-motion) uninstalled after a
full frontend audit — zero imports/JSX usage in all 87 client source files; animations are
pure CSS (Tailwind transitions; no @keyframes even). No vendor-motion chunk was ever
emitted because Rollup tree-shook it. LESSON: grep before assuming a dependency is used.

**Backlog #7 closed — CI build + audit gates (in `5318809`):**
CI's gate list is now complete:
1. `npx tsc --noEmit` — type errors
2. At that point `npm test` ran 1184 tests against a real PostgreSQL 16 service container (drift guard,
   concurrency proofs, HTTP positive paths — zero skips)
3. `check:no-inline-sql` — repo-layer convention
4. **NEW** `npm run build` — vite + esbuild production bundles (catches bundling-only
   breakage)
5. **NEW** `npm audit --omit=dev` — non-zero exit on any production-dependency advisory
   (deliberately NOT gating on dev deps; they surface in local audits)

Remaining backlog: #5 (login/branch-scoping HTTP integration tests — partially covered),
Redis event bus (parked by design decision), mirror-retirement steps 3–4.

## Arc 14 — SSE auth + helmet + JSON_BODY_LIMIT (backlog #2 CLOSED, pushed `ab0e130`, CI #36 green)

The whole chain was shipped across commits `2547c35` (feature), `d1d0d3f` + `ab0e130`
(CI fixes), landing run **#36: success**.

What closed backlog #2:
- **SSE auth** (`server/src/middleware/sseAuth.ts`): `/api/sync/stream` AND `/api/sync/version`
  were in app.ts's publicRoutes bypass — free live change feed for anyone. Now `requireSseAuth`
  accepts the standard HMAC token via `Authorization: Bearer` OR `?token=` query param
  (EventSource cannot send headers — the client `client/src/services/api/sync.ts` appends the
  token from localStorage `inventory_auth_token`). 401 BEFORE any SSE handshake (no stream
  headers, no sseClients entry, no keep-alive timer). Token-in-URL tradeoff accepted for the
  trusted-LAN single-server deployment; same 8h credential as every other request.
- **helmet 8.3.0** app-wide in createApp(): CSP, nosniff, X-Frame-Options, COOP/CORP.
  **HSTS disabled + CSP `upgrade-insecure-requests` removed** — DELIBERATE, the app serves
  plain HTTP on the company LAN; HSTS on http:// is ignored/misleading. Re-enable when a
  TLS proxy is added.
- **JSON_BODY_LIMIT enforced** in `express.json({ limit })` (default 1mb; .env.example's
  documented value now actually works). Found via tests: body-parser's 413 was masked as 500
  by errorHandler — fixed by passing through 4xx `status`/`statusCode` on non-ApiError errors.
- **SSE connection cap** (`server/src/middleware/sseRateLimit.ts`): per-IP CONCURRENT streams
  (default 6) via attempt-on-connect + **revoke-on-close** (res 'close'/'finish') — the window
  only ever holds open streams, so it behaves like a true concurrency cap, not a request-rate
  cap (a rate cap would lock out long-lived legitimate sessions). 429+Retry-After; env
  `SSE_MAX_CONNECTIONS_PER_IP` / `SSE_RATE_LIMIT_DISABLED` (documented in .env.example).
  Wired: `/sync/stream` runs `sseConnectionLimit → requireSseAuth` (cap checked before HMAC),
  other `/sync/*` just requireSseAuth.
- **19 new HTTP-layer integration tests** on real Express apps on ephemeral ports
  (`tests/sseAuth.guard.test.ts`, `tests/httpHardening.test.ts`, `tests/sseRateLimit.test.ts`)
  — the repo's first tests that exercise the actual middleware chain, not fake req/res.

### ⚠️ CI lesson from runs #34/#35 (READ BEFORE ADDING POSITIVE-PATH HTTP TESTS)

Requests admitted by the auth/body gates flow through `requirePostgres`, which returns **503
in CI (no PostgreSQL service)**. Any integration test asserting a 200 through the full chain
MUST be `{ skip: !dbReachable && '…' }` where `dbReachable` is a top-of-file `SELECT 1` probe
(see the three test files above for the exact pattern). Rejection paths (401/429/413) run
BEFORE the DB gate and execute in CI — keep those unskipped so CI still guards them.
Verification trick: `mv .env .env.bak && npm test && mv .env.bak .env` reproduces CI locally
(GitHub job logs 403 for unauthenticated curl, so you cannot read them remotely). Local no-DB
result: 407 pass / 12 skipped / 0 fail.

Backlog after this arc:
3. xlsx 0.18.5 unfixable high advisory — DONE (Arc 15, exceljs migration).
4. Numeric env-var guard helper — DONE (commit `629d569`, envGuard.ts).
5. Integration tests for auth/branch-scoping middleware — PARTIALLY covered now: the SSE
   hardening tests exercise requireAuth/requireSseAuth via HTTP; login + branch-scoping
   still untested at HTTP layer. ← NEXT
7. CI never runs vite build / npm audit — DONE (Arc 15, commit `5318809`).

## Arc 13 — schema.sql drift fix + drift guard (DONE, pushed `bc5817c`, CI #32 green)

The user confirmed the live database has **30 tables**. A column-level diff of
`information_schema.columns` against `scripts/schema.sql` found exactly ONE gap:
`purchase_orders.status_override VARCHAR(30)` existed in the live DB only via an
`ALTER TABLE ... ADD COLUMN` at the bottom of schema.sql — the CREATE TABLE block omitted
it, so a FRESH database built from the script alone would silently miss the column.

Fixes (commit `bc5817c`):
- schema.sql: `status_override VARCHAR(30)` declared inside CREATE TABLE purchase_orders
  (right after `status`), matching the live type exactly.
- `server/src/boot/dbBoot.ts`: runtime DDL now also adds the column (idempotent), and the
  stale boot logs "(28 tables)" / "All 29 Database tables" corrected to 30.
- `tests/schema.drift.guard.test.ts` — NEW regression guard, runs in every `npm test`:
  parses every schema.sql CREATE TABLE block and compares against the live DB's
  information_schema (4 assertions: tables↔blocks, live columns ⊆ block, block columns ⊆
  live, 30-table count pinned). READ-ONLY (information_schema only). Failure message names
  the exact missing table.column. Skips without a reachable DB (CI stays green).

Proofs run this arc:
- Column diff post-fix: 30 tables, 486 columns, ZERO drift.
- Fresh-install proof: applied the FULL schema.sql verbatim to throwaway DB
  `inventory_freshinstall_test` (dropped after) — 30 tables + 174 indexes came up with
  ZERO errors, and every column's type/length/nullability matched the live DB exactly.
  (174 vs 125 explicit CREATE INDEX statements = 125 + 30 PKs + 19 UNIQUE-constraint
  indexes PostgreSQL creates automatically. NOT drift.)
- First diff attempt showed ~970 false mismatches — that was psql's CRLF output breaking
  the parser (`tr -d '\r'` fixed it). If a future drift check explodes with nonsense,
  suspect line endings first.

Commits pushed `3dcab7b..bc5817c`, CI run #32 on `bc5817c`: success, all steps green.

## Arc 12 — app.ts extraction (backlog item #6, DONE, pushed `b31446a`)

**Decision first: the app will stay SINGLE-INSTANCE on the company's own server — no further
scale-out work.** The user explicitly cancelled multi-server scaling; the earlier architecture
assessment (Redis pub/sub, multi-instance rate-limit store) is parked, not scheduled.

The 3,386-line app.ts monolith is now a **246-line composition root + facade**. ZERO caller
changes: routes/controllers still `import { … } from '../app'` and get live ESM bindings.

New module map:
- `server/src/state/runtimeState.ts` — ALL shared mutable state as `export let` live bindings
  (users, branches, products, … + isPgConnected/dataVersion via getPgConnected/getDataVersion),
  setters, CACHE_LOADS, hydrateOperationalData, refreshOperationalCache. THE key insight: ESM
  `export let` bindings stay live through re-exports, so `export * from` was NOT needed —
  app.ts explicitly re-exports each name. Only runtimeState may assign the bindings.
- `server/src/boot/dbBoot.ts` (1,246 lines) — schema DDL sync, seedInitialPostgresData,
  loadPermissionMatrixFromDb, backfillSerialLog, exports syncDatabaseAndIndexes.
- `server/src/realtime/sse.ts` — sseClients Set + broadcastChange (Redis pub/sub plugs in here later).
- `server/src/db/transactions.ts` — withTransaction/withConnection.
- `server/src/services/audit.service.ts` — logAuditEvent (imports state/sse/auth directly).
- `server/src/utils/docNumber.ts` — generateStandardTransactionId, issueNextDocNumber,
  normalizeDocTypeCode, padSequence. `server/src/services/serverDocNumber.ts` — C2 atomic claim.
- `server/src/utils/fiscalYear.ts` — toCalendarDate/pickCurrentFiscalYear (pure) + FY code/id
  resolvers taking fiscalYears as param (app.ts binds the live cache).
- `server/src/utils/trading.ts` — computeTradingFromOps (pure).
- `server/src/controllers/permissions.core.ts` — VALID_ROLES, validateRole,
  requireStockOperationPermission.
- `server/src/services/serialEdit.handler.ts` — handleUpdateSerials + runSerialEditCapture
  (NOT in controllers/ — it holds raw SQL; the no-inline-SQL guard scans controllers/ and
  would fail CI).
- `server/src/services/superAdminAuth.service.ts` — verifySuperAdminCredentials.
- `server/src/routes/fiscal.routes.ts` — registerLeftoverFiscalRoutes (opening-stock + vendor-
  opening-balance endpoints). Uses `routes/fiscal.auditAccess.ts` setLogAuditEvent() shim to
  get logAuditEvent without importing app.ts (cycle avoidance).
- `server/src/middleware/cacheRefreshHook.ts` — the res.json-wrapping cache-refresh middleware.
- `models/procurement.repo.ts` — VENDOR_PAYMENT_SELECT moved here (repo = correct home for SQL).
- middleware/index.ts now re-exports getUserFromReq + verifyPassword from './auth'.

Gotchas hit (worth knowing for future extraction work):
- The file tools CANNOT patch-replace a 3.4k-line file (diff too large) — delete + fresh write works.
- `server/src/<subdir>/x.ts` imports db via `../../db` (NOT `../../../db` — that's for server/src files).
- write_file occasionally drops the `instructions` field — retry with it present.
- Boot test: real server on :3210 booted, health OK, login OK, all 29 tables synced, caches
  hydrated (14 products / 28 stock rows / 52 stock ops). Ambient leftover server on :3000 still
  running from an old session (WS port 24678 conflict warning in boot log is harmless).

Remaining app.ts content: PORT parsing, createApp (middleware pipeline), registerAllRoutes,
providerSupplierIdFromName, sharedStateAccessors conformance object, getFiscalYearCode/IdForDate
wrappers. Facade header documents the full module map for new code.

## Full-project audit + calculation fixes (this session, COMMITTED + PUSHED through `bc5817c`)

Landed after the notes below were written. All pushed; CI green through run #32 on `bc5817c`.

### Arc 1 — Mirror retirement steps 1+2 (DONE)
- `vendorOpeningBalances` mirror fully deleted: declaration, setter (+ sharedState.ts
  interface + SharedStateAccessors entry), CACHE_LOADS entry, boot-log mention.
- Step 2 needed NO code: all five GETs (uom, locations, categories, auditTrail,
  approvalRequests) were ALREADY PG-first in masterdata/misc.controller — the audit doc's
  "serves mirror" findings are stale (pre-modularization line refs). Mirror fallbacks
  remaining there are intended PG-down demo mode. docs/mirror-audit.md still says
  otherwise — update it when convenient.

### Arc 3 — C1: server-side recompute of financial aggregates (DONE)
New pure module `server/src/utils/money.ts` (all arithmetic in server JS; DB stores
results via parameterized SQL only). Helpers: `num`, `roundMoney`, `clamp`,
`computeOperationTotalValue(items, resolveUnitCost)`,
`computeLegacyOperationTotalValue(quantityChanged, costPerUnit)`, `computeBillTotals(items,
discountInput?)` → {grossSubtotal, discount, netSubtotal, taxableAmount, nonTaxableAmount,
vatAmount, grandTotal}.

Wired into three write endpoints; client-supplied aggregates are now ignored:
- `post_stockOperations`: totalValue = Σ |qty| × resolved unit cost (chain: item.unitCost →
  item.costPerUnit → req costPerUnit → product.costPrice → 0, matching the movement
  ledger). Legacy single-line shape recomputed too.
- `post_purchaseOrders`: subtotal/tax/total from line primitives (qty × unitPrice,
  taxRate/isTaxExempt); per-line discounts clamped to line gross. No PO-level discount
  exists yet, so no discountInput is passed.
- `post_purchaseInvoices`: newInv.taxableAmount/vatAmount/nonTaxableAmount/grandTotal/
  subtotalAmount recomputed BEFORE both the mirror write and piUpsertParams. Client's
  `totalDiscount` kept (legitimate business input like qty/price) but clamped to [0, gross]
  and allocated across lines proportionally (matches client allocation). Taxability from
  item.taxRate>0 / isTaxExempt; rate defaults to 13% VAT.
- Already-clean paths verified and left alone: computeTradingFromOps (read-path),
  post_reconcileAudit netFinancialImpact, buildDamageRecordInsert.
- 18 new tests in `tests/money.test.ts` → 358/358.

### Arc 11 — login rate limiting (audit backlog #1, DONE)
Audit said "rate limiting: NONE exists; env vars documented but unimplemented". Now
implemented, dependency-free (no new packages):
- `server/src/utils/rateLimiter.ts`: sliding-window `RateLimiter` (per-key buckets,
  hits age out individually, rejected attempts NOT recorded — they never extend a
  block; lazy pruning bounds memory; injectable clock for tests) + `attempt`/`revoke`/
  `reset` + `buildRateLimitKey(scope, req, account?)` (req.ip → socket → 'unknown')
  + `buildAccountRateLimitKey(scope, account)`.
- `server/src/middleware/authRateLimit.ts`: `createAuthRateLimit({scope,
  accountFrom})` with TWO independent buckets: **ip** (counts ALL attempts — stops
  one host spraying accounts) and **account** (GLOBAL across ips, FAILURE-ONLY —
  recorded optimistically, revoked after a non-4xx response via res.json wrap). A
  distributed attack on one account is throttled at scope:account:<email> without
  letting attackers lock the account out (successes clear their own hit) and without
  collateral lockout of other accounts. 429 + Retry-After (seconds) + JSON body;
  fail-open on limiter errors (availability > strictness); env:
  AUTH_RATE_LIMIT_MAX (10) / AUTH_RATE_LIMIT_WINDOW_MS (900000 = 15 min) /
  AUTH_RATE_LIMIT_DISABLED — documented in .env.example.
- Wired: `/api/auth/login` AND `/api/auth/forgot-password` (also abusable) in
  auth.routes.ts. In-memory state resets on restart — single-process OK; multi-
  instance needs the shared store (Redis pub/sub task).
- Tests (+19 → 399/399): limiter core (slide/retry/no-extend/prune/revoke/config
  guards), key builders, middleware (429 on ip exhaustion w/ account rotation,
  global failure-only account bucket, no collateral lockout, fail-open, scope
  isolation). REAL-SERVER smoke (temp script, deleted): booted createApp +
  registerAllRoutes, 5× login → 401 401 401 401 401, 6th → 429 + Retry-After: 60 +
  message, different account same ip → 429.
- Design catch during TDD: first draft keyed the second bucket as scope:ip:account —
  a strict subset of the ip bucket, useless against ip rotation. Global failure-only
  per-account bucket is the OWASP-style fix.

### Arc 10 — real-PG concurrency proof for C3 stock locking (DONE)
`tests/stock.concurrency.test.ts`: replays the EXACT C3 transaction body of
post_stockOperations (BEGIN → STOCK_LOCK_FOR_UPDATE_SQL → re-verify from locked rows →
STOCK_CONSUME_QOH_SQL / STOCK_DAMAGE_APPLY_SQL → COMMIT) against a live PostgreSQL on a
throwaway DB (inventory_stock_concurrency_test; app DB untouched; drops in teardown;
skips without a DB). Four proofs: (1) two parallel stock-outs of the LAST unit →
EXACTLY one 'posted', one 'rejected', final qoh 0; (2) the loser is rejected at the
re-verify step after the winner commits and leaves NO partial state; (3) same for a
parallel DAMAGE race — exactly one unit moves usable→damaged (final qoh 0, damaged 1);
(4) plentiful stock: parallel postings BOTH succeed (locks serialize but never block
legitimate work), final qoh exact. Debug note: test 3 initially failed with
['rejected','rejected'] — test-order state leakage (test 2 had consumed the contested
unit), fixed by resetting the row in the test itself; the lock pattern was never at
fault. +4 tests → 380/380.

### Arc 9 — real-PG concurrency proof for the doc-number claim (DONE)
`tests/docnumber.concurrency.test.ts`: integration test against a LIVE PostgreSQL
proving `DOC_NUMBER_CONFIG_CLAIM_SQL` (the statement post_generateNext and
generateNextDocNumberForServer-style claims rely on) cannot double-issue numbers:
24 parallel claims must return 24 DISTINCT, GAPLESS numbers (exactly 1..24), every
before/after pair consistent (after = before + 1), formatted numbers unique, counter
ends at 25, and two sequential batches never overlap. Isolation: creates throwaway DB
`inventory_concurrency_test` (never touches inventory_db), drops it in teardown; when
no PostgreSQL is reachable the tests SKIP (t.skip), so CI/demo environments stay green.
Run #29-style CI will not exercise it; local dev with .env DATABASE_URL does.
Debug note: the first failing run was a TEST bug — the duplicate-check message called
`befores.sort(...)` in place, mutating the array and desyncing it from completion-
ordered afters (assertion messages must not mutate their operands). A standalone probe
of the raw SQL (24/24 unique, gapless, zero torn pairs) confirmed the atomic claim is
flawless. +2 tests → 376/376.

### Arc 8 — C4 regression guard test (DONE)
`tests/bs_date.guard.test.ts`: pure core `findHardcodedBsDates(sources, serverRoot?)`
scans every .ts under server/src for QUOTED 'YYYY-MM-DD BS' literals and fails for any
outside the allowlist (utils/bsDate.ts = sanctioned BS_DATE_FALLBACK;
config/seedData.ts = fiscal-year seed rows). Broader than the original 2083-04-16/22
offenders: ANY fixed BS date literal is the same bug class, so the regex covers all
YYYY-MM-DD BS values. Only quoted literals count — bsCalendar's educational prose
("send dateBS=2083-05-14 BS") and comments stay legal. Live-tree test walks the real
server/src (relativizes absolute paths before allowlist matching — Windows-safe).
5 unit tests + 1 live-tree test → 374/374.

### Arc 7 — post_generateNext atomic claim (last doc-number race closed, DONE)
`admin.controller.post_generateNext` (Fiscal Year Management > Document Numbering
"Generate Next" button) previously did read-then-increment: mirror-first config read,
then `DOC_NUMBER_CONFIG_INCREMENT_SQL` with a computed value — two concurrent callers
could both read nextNumber=N and both write N+1, issuing the same number twice.
Now, when `autoIncrement !== false`, it FIRST tries `DOC_NUMBER_CONFIG_CLAIM_SQL`
(admin.repo.ts): `UPDATE document_number_configs SET next_number =
next_number + 1 WHERE id = $1 RETURNING next_number - 1 AS next_number_before,
next_number AS next_number_after, prefix, suffix, min_digits` — same C2 pattern as
generateNextDocNumberForServer. Returned before-value is the number this caller
consumes; mirror is synced to the after-value. Falls back to the legacy mirror path
only when the claim fails (DB down) or the doc type has no DB row; read-only preview
(`autoIncrement === false`) never touches the counter. +1 test (SQL shape) → 368/368.

### Arc 6 — C3: row-level locking for stock writes (mirror step 4, DONE)
`inventory.repo.ts` gained `STOCK_LOCK_FOR_UPDATE_SQL` + `stockLockForUpdateParams`:
set-based `SELECT s.product_id, … quantity_on_hand, damaged_qty, reserved_qty FROM
inventory_stock s JOIN unnest(…) targets … ORDER BY s.product_id FOR UPDATE`. Products
deduplicated; ORDER BY gives deterministic lock acquisition (no deadlocks). MUST run
inside the caller's transaction (locks held to commit).

Wired as lock-and-re-verify inside the PG transactions:
- `post_stockOperations`: FIRST statement in the tx for consuming ops (DAMAGE / PULLOUT /
  STOCK_OUT / CONSUMABLE_ISSUE) — locks every (product, branch) row, re-verifies
  qoh (or damaged_qty for `condition === 'DAMAGED_STOCK'` pullouts) from the returned
  DB rows, throws a retry-able "Insufficient … in the database" error if short. The
  mirror pre-flight stays as a fast user-facing check; the tx now guarantees the
  verdict. The guarded UPDATEs (… >= qty) remain as a belt-and-braces backstop.
- `post_reverse`: locks the damaged rows right before STOCK_REVERSE_DAMAGE_BATCH_SQL
  and re-verifies damaged_qty per delta from DB truth (mirror pre-flight
  `validateReversalAvailability` can race a concurrent reversal of the same batch).
  The batched restore's `rowCount !== deltas.length` guard stays as backstop.
- Outcome: concurrent writers now serialize per stock row and the accept/reject
  decision always reflects committed DB state, not a mirror snapshot. All decisions
  still happen inside the existing withTransaction scopes — no new transaction
  boundaries, no extra round-trips beyond one set-based SELECT.
- Tests: +3 (lock SQL shape, dedup/broadcast params, empty-id filtering) → 367/367.

### Arc 5 — C4 extended to ALL remaining hardcoded BS dates (DONE)
The four follow-up sites plus, opportunistically, every other literal in the server:
- `logAuditEvent` (app.ts) is SYNC and called from ~30 places, so it now uses the new
  `todayBs()` — a SYNC resolver answering from the in-memory bs_day_records cache that
  `hydrateBsCalendarFromDb` keeps in sync with PostgreSQL at boot/reconnect. Same data
  as the async path, minus the round-trip. bsCalendar.ts gained a
  `getInMemoryBsDayRecords()` getter (live binding across modules).
- PROFILE_SWITCHED audit row (auth.controller): `todayBs()`.
- Approval-request rows (misc.controller ×4): requestedAtBS, processedAtBS in
  post_process and post_cancel, and the PULLOUT txn on approval — all `todayBs()`.
- issuedDateBS fallbacks (inventory.controller): post_customerDevices CDR upsert and the
  post_exchange replacement-device record — `todayBs()` (was '2083-04-16/28 BS').
- BONUS (same class, cheap because async): post_assets acquisition/purchase-invoice BS
  fallbacks and post_purchaseInvoices invoiceDateBS fallback now derive from the
  actually-stored AD date via `await resolveBsDateForLedger(adDate)` instead of a fixed
  literal — previously a backdated asset got today's BS date regardless.
- Last-resort literals (procurement post_pay, piTxnLogParams) now reference the shared
  `BS_DATE_FALLBACK` constant from utils/bsDate.ts — one source of truth for the
  fallback value; bs_day_records is always tried first on those paths.
- Net effect: **no '2083-04-xx BS' literals remain anywhere in server/src outside
  utils/bsDate.ts** (seedData/bsCalendar own their legitimate seed-calendar data).
- Tests still 364/364 (c1.e2e covers dateBS shape via stock ops).

### Arc 4 — C2 + C4 fixed, C1 verified E2E (DONE)
- **C2 (race-safe doc numbering):** `generateNextDocNumberForServer` (app.ts) is now
  async and claims the sequence atomically via `UPDATE document_number_configs SET
  next_number = next_number + 1 ... RETURNING next_number, prefix, suffix, min_digits`.
  The returned number = claimed seq − 1 (the value THIS caller consumes; no
  double-increment), and the in-memory mirror is synced to the DB counter. Offline/demo
  mode now falls back to `generateStandardTransactionId` (timestamp-based) instead of the
  racy in-memory counter with fire-and-forget persistence. It had NO other callers, so
  the async signature change is safe. Note: admin.controller's `post_generateNext` has a
  similar read-then-increment pattern — it awaits the DB increment, but the read is from
  a mirror-first config; candidate for the same atomic UPDATE later (left as-is).
- **C4 (BS dates):** new `server/src/utils/bsDate.ts` — `resolveBsDateForLedger(adDate?)`
  resolves "YYYY-MM-DD BS" from bs_day_records via `findBsDayRecordForAdDate` (PG →
  in-memory fallback → `BS_DATE_FALLBACK` '2083-04-16 BS' last resort). Wired into
  `patch_Id` (3 rows: damage ledger, damage-record adjustment DB + mirror, manual-
  adjustment ledger) and `post_reconcileAudit` (audit ledger + audit shortage damage
  record) — all hardcoded '2083-04-16/22 BS' strings there are gone.
  REMAINDER (same class, out of the agreed C4 scope, still hardcoded): app.ts:logAuditEvent,
  auth.controller PROFILE_SWITCHED, misc.controller approval-request rows ×4,
  procurement.controller post_pay last-resort fallback (already tries bs_day_records
  first), piTxnLogParams invoiceDateBS fallback, inventory.controller:1404 issuedDateBS
  fallback. All are sync-only display fallbacks except logAuditEvent (sync, called
  everywhere) — converting it needs a wider refactor.
- **C1 verified E2E:** new `tests/c1.e2e.test.ts` (6 tests) calls the REAL controller
  functions with tampered payloads in demo mode (PG down): fake `totalValue: 999999` on
  stock ops, tampered `subtotalAmount/taxAmount/totalAmount` header + per-line
  `subtotal/taxAmount: 999` on POs, `grandTotal: 1` + negative/over-gross `totalDiscount`
  on PIs. Server recomputes correct values in every case (e.g. DAMAGE total = 320 not
  1,000,000; PI net 1055 / taxable 870 / VAT 113.1 / grand 1157.1). Also found+fixed a
  gap while writing these tests: post_purchaseOrders previously spread `...req.body`
  AFTER the computed totals, letting a client header total override the recompute —
  totals now applied after the spread (orderDateAd/orderDateBs normalization preserved).
- Tests: +6 → 364/364.

### Arc 2 — Project audit → calculation-accuracy fixes B1–B5 (DONE, with decisions)
Full audit found 13 verified-correct calc paths, 5 bugs, 4 caveats (C1–C4). All bugs fixed:

- **B1 reversal ledger truth:** `STOCK_REVERSE_DAMAGE_BATCH_SQL` now has
  `RETURNING product_id, quantity_on_hand`; `post_reverse` builds the DAMAGE_REVERSED
  ledger INSIDE the tx from those rows via new pure helper
  `buildReversalLedgerFromRestoredRows` (damage.service.ts): quantityBefore = restored −
  qty, quantityAfter = returned value. Stale mirror no longer feeds the ledger. PG-down
  demo path keeps old `buildReversalLedgerWithStock` behavior.
- **B2 damage-pool ledger sign:** new pure helper `buildDamagePoolLedgerChange(before,
  after)` (damage.service.ts) — pool increase = negative change, decrease = positive,
  no-op = 0. Used by `patch_Id`'s DAMAGE ledger row; invariant before+changed=after now
  holds. Old code wrote `-Math.abs(damDiff)` which inverted decreases and invented
  `-(damagedQty||1)` on no-ops.
- **B3 PI ledger id collisions:** `piTxnLogParams(inv, item, branchId, itemIndex = 0)` —
  ids are now `txn-<ts>-<productId>-<index>`. Call site loops with index. Prevents silent
  ledger-row loss when one invoice repeats a product or two invoices commit in the same ms.
- **B4 audit reconcile stock-wins (DECISION: counted total is authoritative):**
  `post_reconcileAudit` now ALSO subtracts `min(damagedQty, |delta|)` from `damaged_qty`
  in inventory_stock (new `STOCK_RECONCILE_DAMAGED_ADJUST_SQL` +
  `stockReconcileDamagedAdjustParams` in inventory.repo.ts) when it writes the audit
  shortage damage record, and updates the mirror `stk.damagedQty` to match. Register and
  stock no longer double-count a shortage. If info-only semantics ever preferred, revert
  the two added statements.
- **B5 depreciation rewrite (DECISION: annual column = CURRENT-year charge):**
  `client/src/utils/depreciation.ts` rewritten: all methods use whole-month convention;
  declining methods' annual = F(t) − F(t−12mo) of the accumulated function (year 2 of
  40% DB on 100k now shows 24,000, not the constant 40,000); reducing-balance accumulated
  = formula value (authoritative for compounding method — stored value intentionally NOT
  used there); SL accrues linearly by months; accumulated capped at cost, NBV floored at 0;
  degenerate inputs (no cost/rate, as-of < acquisition) keep stored values verbatim.
  13 new tests in `tests/depreciation.test.ts`.
- Tests: +18 (damage-pool ledger, PI id uniqueness, depreciation) → 340/340.

**Remaining caveats: NONE.** C1–C4 all DONE (C1 server-side recompute + E2E-verified;
C2 atomic doc-number claim; C3 row-level locking, this arc; C4 bs_day_records-derived
BS dates everywhere). Residual known-limitations noted elsewhere: post_generateNext
read-then-increment pattern in admin.controller; BS display fallbacks that cannot see
unseeded calendar days use BS_DATE_FALLBACK.

### Also from the audit — prioritized backlog (beyond the mirror roadmap)
1. ~~Rate limiting: NONE exists; env vars documented but unimplemented (login brute-forceable).~~ DONE (Arc 11).
2. ~~SSE endpoint `/api/sync/stream` has NO requireAuth; no helmet/security headers;
   JSON_BODY_LIMIT documented but express.json() at default.~~ DONE (Arc 14: SSE auth via
   header-or-query HMAC token, helmet with LAN-safe config, JSON_BODY_LIMIT enforced with 413
   passthrough, per-IP concurrent-stream cap).
3. xlsx 0.18.5 unfixable high advisory (client-side parsing) — evaluate exceljs.
4. Numeric env-var guard helper (PORT=0 trap class) — do before rate limiting.
5. Integration tests for auth/branch-scoping middleware (zero HTTP-layer tests today).
6. ~~app.ts extraction plan (state → plumbing → schema/boot → serial flows → leftover routes).~~ DONE (Arcs 12–13; note: with the user's single-instance decision, the Redis pub/sub task is PARKED, not pending).
7. CI never runs vite build / npm audit; no ESLint.

## Earlier session (all pushed)

1. **`cd4112f`** — api.ts split into per-domain modules (`client/src/services/api/`:
   http/auth/bootstrap/inventory/procurement/finance/admin/sync + barrel). Zero call-site
   changes — imports of `../services/api` resolve to the folder's index.ts.
2. **`cd4112f` (same commit)** — reversal transaction batching: damage + consumable reversals
   now use set-based unnest UPDATEs + multi-row ledger inserts
   (`STOCK_REVERSE_DAMAGE_BATCH_SQL`, `STOCK_RETURN_QOH_BATCH_SQL`, `DAMAGE_RECORD_CANCEL_BATCH_SQL`,
   `buildTxnMultiRowInsertSql` in inventory.repo.ts). Verified live end-to-end.
3. **`9ae25d5`** — improvement #2: SSE events carry a `domain` tag (`server/src/syncDomains.ts`);
   client refreshes only affected bootstrap slices via `GET /api/bootstrap/local?key=…`;
   unknown domains / mixed bursts fall back to full bootstrap. Mapping pinned by
   `tests/syncDomains.test.ts`.
4. **`1e373fa`** — mirror audit deliverable: `docs/mirror-audit.md` (classification + retirement order).
5. **`7804306`** — PORT validation fix (ambient `PORT=0` in this shell harness made the server
   bind an ephemeral port; non-positive/garbage now falls back to 3000).
6. **`edcc4ea`** — README updated for all of the above.

## ⚠️ Environment quirks for the new session

- **This shell exports `PORT=0`** — any server start reads it; code now guards, but keep in
  mind for other tools. `PORT=3000 npx tsx server/index.ts` no longer required but harmless.
- Dev server may still be running on :3000 from last session (check `netstat -ano | grep :3000`).
  A server started by a previous Freebuff session dies when the session restarts — restart it.
- Login for API smoke tests: `superadmin@example.com` / `Demo@123` (demo users from seed).
  DB: `PGPASSWORD=securepassword psql -h localhost -U inventory_user -d inventory_db`.
- `/tmp` paths don't work for node in this Git Bash — use project-relative temp files.
- ripgrep tool in code_search intermittently fails (rg.exe ENOENT) — fall back to
  `run_terminal_command` grep.

## Remaining improvement tasks (in recommended order)

### 1. Mirror retirement steps 1+2 — DONE, see ⭐ Arc 1 above

### 2. Mirror retirement step 3 (MEDIUM) — ✅ DONE (2026-10-08, see ⭐ entry at top)
- Invert `customerDeviceRecords` mirror-first reads → PG-first in rename/exchange flows —
  DONE (`handleUpdateSerials` + `post_exchange`; dual-writes preserved).
- Point `stockOperations` find-by-id at PG + serve the legacy `get_stockOperations` GET
  live from PG — DONE (`STOCK_OPERATION_FIND_BY_ID_SQL`; guarded by `tests/mirrorStep3.test.ts`).

### 3. Mirror retirement step 4 — ✅ DONE (2026-10-09, see ⭐ entry at top)
- Stock pre-flight race + friendlier errors: done earlier (Arc 6 — C3
  lock-and-re-verify with `STOCK_LOCK_FOR_UPDATE_SQL` inside the write tx).
- `serialLogs` mirror narrow uses: done (2026-10-09) — all five sites (deploy
  flip, unassign restore, damage quarantine, damage-reverse restore,
  serial-edit clash pre-check + rename) gated to PG-down demo mode; guarded
  by `tests/serialLogsMirrorGate.test.ts`.

### 4. Redis Pub/Sub event bus — DECLINED (decided 2026-09-26, do not re-litigate)
- Decision: NOT needed for this deployment. Rationale: single Node process
  (`node dist/server.cjs` via PM2) — every SSE client is in that process and
  `broadcastChange()` writes to it directly; Redis Pub/Sub only pays off with multiple
  server instances behind a load balancer. Internal LAN system: tens of clients, not
  thousands. The unused REDIS_URL/SSE_REDIS_CHANNEL placeholders were removed from
  `.env.example`.
- IF multi-instance scaling ever happens, the change is contained: `broadcastChange`
  (server/src/realtime/sse.ts) already funnels every event through one function — swap
  its write loop for publish + subscribe fan-out (`ioredis`), keep the in-memory Set
  for local connections.

### 5. Bootstrap trim continuation (consumer-driven) — ✅ DONE (2026-10-08, see ⭐ entry at top)
- `stockOperations` / `purchaseOrders` / `purchaseInvoices` are now TRIMMED from the bootstrap
  payload; wholesale consumers are fed by deferred `GET /api/bootstrap/local` slices fired from
  `refreshAllData` (guarded by `tests/bootstrapTrim.test.ts`). Registers self-fetch as before.
- Follow-up (bytes, not plumbing) — ✅ DONE (2026-10-25, see the top entry): wizard FY-scoped
  rows, PI dropdown open POs and KPI counts now read scoped endpoints; the shared slice still
  feeds StockMovementLedger (pinned no-fetch), global search and the registers.

### 6. Smaller follow-ups
- **Env var audit — DONE (2026-10-02).** `.env.example` now documents ONLY
  vars the code reads. Wired `PG_POOL_MAX` + `PG_CONNECT_TIMEOUT_MS` (guarded
  pool sizing via `buildPoolConfig()` in `server/db.ts`) and `TRUST_PROXY`
  (`createApp` → `app.set('trust proxy', …)`, so `req.ip` — the login
  rate-limit and SSE per-IP cap key — honours X-Forwarded-For behind a proxy;
  off unless the value is exactly 1/true). Deleted 11 documented-but-unread
  vars whose features do not exist: REQUIRE_POSTGRES, STRICT_PASSWORD_POLICY,
  MIN_PASSWORD_LENGTH, LOGIN_RATE_LIMIT_MAX, API_RATE_LIMIT_MAX,
  DISABLE_RATE_LIMIT, LOG_LEVEL, APP_URL, REQUIRE_MIGRATIONS, SEED_DUMMY_DATA,
  PM2_INSTANCES. Added the missing `RETURNS_APPROVAL_THRESHOLD_NPR`. Guards:
  `tests/envDocs.guard.test.ts` (documented ⇒ read, known-dead list never
  returns, wired knobs stay documented) + `tests/envWiring.test.ts` (the knobs
  reach the pool and the Express app). NOT scheduled: a global API rate
  limiter and a password-strength policy — deliberately removed, not deferred.
- **Doc-number domain — CLOSED (2026-10-02, accept eventual consistency):** document
  counter changes have no SSE domain mapping (fire-and-forget PG updates in
  issueNextDocNumber) and the client NEVER previews document numbers — the server
  issues them atomically inside the mutation transaction and forms show static
  'DN-…'/'CN-…' placeholders (e.g. ReturnsRegister.tsx ~110). A DOCUMENT_NUMBERING
  domain would therefore have ZERO consumers, so it was not added; the only visible
  effect of a doc-number mutation is the register's own refresh (registers now
  refresh via the SSE wiring below).
- **Registers + SSE — DONE (2026-10-02, extended same day):** all FOUR self-fetching
  paged registers now refresh on matching SSE domain events. App.tsx holds a
  `registerRefresh` counter object bumped inside the existing debounced SSE handler
  (targeted branch maps domains via `DOMAIN_REGISTER_KEYS`; the unknown/mixed
  full-refresh fallback bumps all four). Wiring: Serial Log keeps the existing
  `refreshKey` prop (STOCK, STOCK_OPERATIONS, SERIALS, PROCUREMENT, CUSTOMER_DEVICES,
  ASSETS domains); PurchaseOrders and PurchaseInvoices gained an optional
  `sseRefreshKey` prop in their paged-fetch effect deps (POs: PROCUREMENT + SHIPMENTS;
  PIs: PROCUREMENT); the consumable register inside StockOperations (server-paged
  CONSUMABLE_ISSUE rows via `loadConsumableRegisterPage` — the audit's 4th register,
  previously stale-prone) gained the same optional `sseRefreshKey` prop on all 11
  StockOperations render sites (STOCK_OPERATIONS domain: creation +
  REVERSE_CONSUMABLE_ISSUE / REVERSE_STOCK_DAMAGE). The domain → register mapping
  lives in `client/src/utils/registerRefreshDomains.ts` (standalone, no imports) and
  is pinned by `tests/registerRefreshDomains.test.ts` — including a guard that every
  domain the server can broadcast is either register-mapped or declared no-register.
  Still single-EventSource in App.tsx — no new SSE subscriptions (per-IP stream cap).
- **PROCUREMENT bootstrap slice widened (2026-10-02):** `DOMAIN_STATE_KEYS.PROCUREMENT`
  now also carries `purchaseReturns`, `stock`, `transactionLogs` — previously a
  purchase return (applyPurchaseReturnEffects, procurement.controller.ts ~1184) could
  deduct stock, write PR_TXN_LOG rows and flip serials while the targeted SSE refresh
  re-fetched none of those slices. All purchase-return flows tag module PROCUREMENT
  (~1298/1357/1416), so they stay targeted. (SALES is now mapped too — see the
  SALES SSE domain entry below.)
- **CRLF warnings on new files — DONE (2026-10-02):** `.gitattributes` now
  pins `* text=auto eol=lf` (+ explicit binary list, `*.sh` forced LF). The
  repo already stored every tracked file as LF, so this created ZERO content
  diffs — it only stops the traps: `core.autocrlf=true` had left 135 working
  files CRLF and 4 (schema.sql, setup_db.js, demo_dataset.js,
  procurement.repo.ts) MIXED in one file. Editing a file with a CRLF-emitting
  tool can no longer produce a spurious diff.
- **Strict TypeScript — DONE (2026-10-02):** `"strict": true` in tsconfig.json
  (now a CI gate via `npx tsc --noEmit`). It cost exactly 11 fixes: nullable
  `companyProfile` passed to the CSV printer (`exportUtils` `companyInfo` now
  accepts `null`), optional `UnitOfMeasure.isBaseUnit` (`updateUomParams`
  already coerced with `Boolean()` — the signature just hadn't caught up), the
  `res.json` async override in `cacheRefreshHook` (documented cast: the
  refresh really does settle before the body is flushed), a `never[]` test
  fixture, one nullable `notes`, and `normalizedMacAddress ?? undefined` on
  the two mirror writes. LESSON: widening `oldMacAddress` to `string | undefined`
  cascaded into 6 more errors and was the WRONG fix — the domain type
  (`SerialRenameInput.oldMacAddress: string`, `''` when absent) is the
  invariant, so line 169 now does `customerRecord.macAddress ?? ''` instead of
  letting `undefined` leak in. Fix the type at the source; don't propagate
  the hole.
- **Live SSE verification + full re-verification — PASSED (2026-10-02):**
  browser walkthrough on the running dev server (superadmin, Consumables
  Register tab): POST /api/stock-operations (CONSUMABLE_ISSUE, prod-fcn001
  ×1 on WH001) → 201; within ~1s and with NO manual refresh the consumable
  register re-ran its paged fetch (GET /api/stock-operations?type=
  CONSUMABLE_ISSUE&page=1&pageSize=20 → 200) and showed the new
  CON-WH001-202610020002 row (9→10 records), while the targeted branch
  re-fetched the four STOCK_OPERATIONS bootstrap slices (stockOperations,
  stock, transactionLogs, damageRecords via /api/bootstrap/local?key=…).
  Reversal via POST /api/stock-operations/:id/reverse-consumable → 200
  flipped the row to "Reversed" through the same SSE path; stock qty
  net-zero (190→189→190). Probe rows deleted from PG afterwards; UI back
  to 9 records on remount. Full re-verification green: npm test (tsc
  --noEmit + 522 node:test tests, 0 fail), npm run build, npm run
  check:bundle-budget (startup 278.5 kB gz vs 320 kB budget).
- **Header refresh covers paged registers — DONE (2026-10-02):** the
  header "Refresh realtime stock and logs" button (refreshAllData in
  App.tsx) re-fetched bootstrap slices but never bumped the four
  `registerRefresh` counters, so the self-fetching paged registers
  (Serial Log, Purchase Orders, Purchase Invoices, consumable
  register) stayed stale on manual refresh until the next SSE event
  or remount. Fix: extracted a pure `bumpAllRegisterRefresh(prev)`
  helper into `client/src/utils/registerRefreshDomains.ts` (module
  stays standalone/import-free); `refreshAllData` now calls
  `setRegisterRefresh(bumpAllRegisterRefresh)` before its fetch (so
  registers refresh even if the bootstrap call fails), and the SSE
  unknown/mixed fallback now relies on refreshAllData's bump instead
  of its own inline all-four increment (removed as redundant — the
  fallback's only refresh path IS refreshAllData). Pinned by 4 new
  tests in `tests/registerRefreshDomains.test.ts` (all four keys
  incremented, arbitrary counter values, purity/immutability, exact
  key coverage; at that point the suite held 1184 tests, 0 fail). Live-verified:
  direct PG insert of a CONSUMABLE_ISSUE row (no SSE broadcast)
  left the consumable register stale at "9 records"; clicking the
  header Refresh button re-ran the register's paged fetch and
  showed "1–10 of 10" with the probe row on top;  probe row deleted afterwards, register back to 9 on the next refresh.
- **SALES SSE domain mapped — DONE (2026-10-02):** `SALES: 'SALES'` added to
  `DOMAIN_BY_MODULE` (server/src/syncDomains.ts) — previously every sales event
  (logAuditEvent broadcasts type=action, entity='SALES') resolved to an unknown
  domain and triggered a full-bootstrap fallback. `DOMAIN_STATE_KEYS.SALES` in
  App.tsx now targets the five slices sales mutations actually touch:
  `salesInvoices` (invoice insert + amount_paid on customer payments),
  `salesReturns` (return create/cancel/approve), `stock` (invoice deduction,
  return restock/re-deduction), `transactionLogs` (SI/SR ledger rows) and
  `damageRecords` (non-restockable returns route units into the damage register
  via SR_DAMAGE_INSERT_SQL). `customers` is deliberately EXCLUDED — sales
  mutations never UPDATE the customers table (payments land in the
  customer_payments sub-ledger, which has no bootstrap slice; the customer
  ledger is a dedicated endpoint). serial_log flips (SR_SERIAL_FLIP_SQL on
  posted/cancelled returns) are covered by the paged-register mapping instead:
  `SALES: ['serialLog']` in `client/src/utils/registerRefreshDomains.ts`
  (serialLogs was trimmed from the bootstrap payload entirely, so it can only
  refresh via the Serial Log register's own paged fetch). SalesInvoices.tsx and
  ReturnsRegister.tsx are pure presentation components fed by App-level state,
  so the slice refresh keeps them live with no extra wiring. Tests: 'SALES'
  added to the AUDIT_MODULES vocabulary + sales resolveDomain cases in
  tests/syncDomains.test.ts; SALES serialLog assertion in
  tests/registerRefreshDomains.test.ts (the guard test would otherwise fail
  once SALES entered DOMAIN_BY_MODULE). Live-verified on the dev server:
  POST /api/sales-invoices (prod-adp001 ×1, WH001) → 201, then exactly five
  targeted GETs /api/bootstrap/local?key=salesInvoices|salesReturns|stock|
  transactionLogs|damageRecords (NO full /api/bootstrap), stock 210→208 in PG;
  probe invoices/txn rows deleted and stock restored afterwards. npm test green
  (526 pass, 0 fail). Note: tsx watch did NOT pick up the server-side
  syncDomains.ts edit — the dev server needed a manual restart before the new
  mapping took effect (client hot-reloaded, server didn't).
- **SSE fallback integration test — DONE (2026-10-02):** the debounced
  SSE handler's burst → refresh-plan decision (accumulate `lastDomain`
  across the 250ms window; mixed or unknown → full bootstrap) was
  extracted from App.tsx into `client/src/utils/registerRefreshDomains.ts`
  as `SseDomainBurst` (`observe(domain?)` + `flush(isKnownDomain)` →
  `{mode:'targeted',domains:[d]}` | `{mode:'full'}`, flush resets the
  window); App.tsx's sync-stream effect now uses it — behavior-identical,
  but the shipping code is the tested code. A new describe block in
  `tests/registerRefreshDomains.test.ts` feeds REAL server events through
  `resolveDomain` → the accumulator → the plan and asserts the fallback
  contract end-to-end: unknown-domain bursts, mixed multi-domain bursts
  (known+known and known+unknown), domain-less events and 3-domain bursts
  all resolve `{mode:'full'}`, and the fallback's action — refreshAllData's
  `setRegisterRefresh(bumpAllRegisterRefresh)` — bumps all four
  `registerRefresh` counters from any starting values. Contrast tests pin
  that single-domain bursts stay targeted and bump ONLY their mapped
  registers (the all-four increment is exclusive to the fallback), that a
  repeated same-domain burst coalesces to one targeted plan, and that
  flush() resets the accumulator so a new debounce window starts clean.
  A source guard reads the real App.tsx and pins the wiring
  (`new SseDomainBurst()`, `burst.observe(event?.domain)`, `burst.flush(`, 
  the `refreshAllDataRef.current()` fallback, and
  `setRegisterRefresh(bumpAllRegisterRefresh)` inside refreshAllData) so
  the extraction can't silently be reverted. At that point the suite held 1184 tests, 0 fail
  (tsc --noEmit clean).
- **Paged-tab staleness audit — CLOSED (2026-10-02, nothing to wire):**
  audited the remaining paged/fetching tabs for the four-register
  pattern (self-fetched server-paged data outside the bootstrap
  slices, invisible to the SSE handler). None matched it:
  - **Stock Movement Ledger** (`stock-ledger` →
    StockMovementLedger.tsx, 848 lines): ZERO api calls; the only
    useEffect syncs the branch filter. `useClientPagination` over
    arrays derived from props (transactionLogs, stockOperations,
    damageRecords, stock, shipments, purchaseOrders). Every prop
    slice is refreshed by the domain that mutates it (STOCK →
    stock/damageRecords/transactionLogs; STOCK_OPERATIONS →
    +stockOperations; PROCUREMENT → +purchaseOrders; SHIPMENTS →
    +shipments; SALES → stock/transactionLogs/damageRecords).
    Key detail: the ledger prefers persisted transaction-log rows
    over the stock_operations feed, and STOCK-domain-only
    mutations (manual adjustments, patch_Id) still write a
    transaction_logs row (TXN_INSERT_NOW_SQL, changeType
    MANUAL_ADJUSTMENT, inventory.controller.ts ~278), so the
    ledger's primary feed is refreshed even by STOCK-only
    broadcasts.
  - **Asset Deployments** (`asset-deployments` → AssetDeployments.tsx,
    325 lines): zero api calls, zero effects; client pagination over
    the `assets` prop. ASSETS domain → assets slice (deploy/unassign
    broadcasts module FIXED_ASSETS → ASSETS); RECALC also covers
    assets. Its only mutation (onUnassignAsset → handleUpdateAssetStatus)
    awaits the API then calls refreshAllData.
  - **Damaged Stock Report** (`damage-report`): a StockOperations
    instance (initialType="DAMAGE_REPORT" → DAMAGE_TRACKING tab).
    The damage-log register paginates CLIENT-side over the
    `operations` prop — the code comments it "without any
    server-side window" (StockOperations.tsx ~2197). The ONLY
    self-fetch in StockOperations is loadConsumableRegisterPage
    (CONSUMABLE_ISSUE rows), whose effect deps already include
    sseRefreshKey (~2085), and this render site already passes
    sseRefreshKey={registerRefresh.consumableRegister} (wired in
    the registers arc). STOCK_OPERATIONS domain refreshes the
    stockOperations slice itself.
  - Bonus, **Damaged Stock Matrix** (`damaged-stock` →
    DamagedStockTracking.tsx, 1290 lines): renders from the
    damageRecords/stock props; its only api calls are the BS-calendar
    availability check on mount (not business data) and a
    stock-operation lookup inside the reversal flow (followed by
    window.location.reload). Disposal write-off routes through
    onCreateOperation → handleCreateOperation → refreshAllData.
  Conclusion: the only server-paged fetch in this corner of the app
  (the consumable register shared by the damage-report tab) was
  already wired; these tabs are pure presentation over bootstrap
  slices, so no DOMAIN_REGISTER_KEYS entries or props were needed.
  Mutation-side coverage is via the App-level
  handlers (handleCreateOperation / handleUpdateStockLevel /
  handleUpdateAssetStatus all `await api.*` then refreshAllData),
  with SSE covering every other client.
  Addendum (2026-10-02, follow-up request): a source-guard test in
  tests/registerRefreshDomains.test.ts ("Paged-tab audit guard —
  no self-fetching data loads") now pins this: StockMovementLedger
  and AssetDeployments must keep ZERO api.* calls, and
  DamagedStockTracking's api surface must stay exactly
  {getBsDayRecordByAdDate, getStockOperations, reverseStockOperation,
  createStockOperation} (BS-calendar gate / reversal lookup +
  mutation / disposal write-off — none loads rendered data) with its
  sole useEffect pinned to the mount-only BS check. Any future
  refactor of these tabs to server-paged self-fetch (the
  loadConsumableRegisterPage pattern) fails the suite and forces an
  explicit SSE-wiring decision. At that point the suite held 1184 tests, 0 fail.
- **Feature-screen coverage guard + register surface pins — DONE (2026-10-03,
  pushed `68d9234`):** the paged-tab source-guard now covers the whole client.
  (1) The remaining self-fetching registers are pinned in
  tests/registerRefreshDomains.test.ts: PurchaseOrders (`getPurchaseOrders`
  only — mutations are App callbacks), PurchaseInvoices (`getPurchaseInvoices`
  + the three payment-modal calls), SerialLogRegister (`getSerialLogs`,
  `lookupSerial`, both serial-edit mutations — NOTE its wiring prop is
  `refreshKey`, not `sseRefreshKey`), and StockOperations' full 12-method
  allowlist with its assignSerialLogCache fetch pinned as the ONE serial-log
  host fetch — mount-once (`[]` deps, `assignSerialLogLoaded` guarded),
  deliberately NOT sse-wired (bootstrap excludes serialLogs; refresh is by
  remount). Every App.tsx render site must pass its register counter (2 PO,
  2 PI, 1 SerialLogRegister, 11 StockOperations, 4 ReturnsRegister,
  2 SalesInvoices) — a newly added unwired mount fails.
  (2) NEW — all 66 screens under client/src/features are pinned: a
  SCREEN_SURFACE_PINS table (55 screens) + the 11 pinned above; an unpinned
  new screen fails coverage, and each pinned screen must match its exact
  surface. Surfaces use serverCallsIn = `api.*` methods + NAMED
  `services/api` imports, because the audit found FinancialStatements.tsx
  imports getFinancialSummary directly — a bare `api.*` scan misses that,
  so every earlier pin switched to the combined helper.
  (3) Tripwires: raw fetch/axios/EventSource banned in every screen;
  `pageSize:` request keys allowed ONLY in the six wired registers (a seventh
  server-paged fetch = a register missing its sseRefreshKey); the 11
  mount/selection self-fetch screens (ledgers, BS calendars, Category/Uom/
  Locations, doc numbering, FinancialStatements…) stay whole-list and
  unwired BY DESIGN (since the keep-mounted tab refactor below they no
  longer remount on a tab switch — first-activation fetch + stays mounted;
  all 11 now refetch on every tab re-activation via useActivationKey(tabKey)
  in their fetch effect's deps — see the NEWEST entry above) and
  may not grow partial
  wiring without a full DOMAIN_REGISTER_KEYS decision. Audit footnote CLOSED:
  SalesInvoices.tsx + ReturnsRegister.tsx now fetch their own server-paged
  rows (getSalesInvoices / getPurchaseReturns + getSalesReturns) and are
  pinned as SSE-wired registers (surface + effect deps + every render site),
  no longer pinned `[]`. Proven by probe in both directions (injected named
  import / `pageSize:` / unpinned new screen / raw fetch → 4 precise
  failures, then reverted). At that point the suite held 1184 tests, 0 fail.
- **Docs-count guard — DONE (2026-10-03):** `npm test` now ends with a gate
  (scripts/run_tests.mjs → scripts/docsTestCounts.ts) that parses THIS run's
  real suite size from the runner's own summary line and fails if any
  CURRENT-STATE test-count claim in README/handoff/SESSION_NOTES disagrees.
  It caught two strays on day one (a `433` and a `535` left in older bullets
  after the previous refresh). Historical records ("449/449 tests pass",
  "522 node:test tests", "(3 tests)" per-file counts) are deliberately out of
  scope — only five explicit phrasings claim the current size, and the scope
  contract lives in the script header: add a pattern only if the sentence
  would be wrong after the next commit adds a test. Classification is
  unit-tested plus a live cross-doc consistency check in
  tests/docsCounts.guard.test.ts. Screen tallies quoted in these docs
  (total / table / pinned-elsewhere counts) are pinned the same way by a
  live check in tests/registerRefreshDomains.test.ts, so a screen added or
  reclassified without updating the prose fails too. At that point the suite held 1184 tests, 0 fail.

## Key files touched this arc (for context)

- `client/src/services/api/*` (new structure), `client/src/App.tsx` (SSE handler ~line 470,
  DOMAIN_STATE_KEYS map, syncScopeRef)
- `server/src/app.ts` (broadcastChange + resolveDomain import), `server/src/syncDomains.ts`
- `server/src/controllers/bootstrap.controller.ts` (get_bootstrapLocal), routes file
- `server/src/models/inventory.repo.ts` (batched SQL), `inventory.controller.ts` (reversals)
- `docs/mirror-audit.md` — READ THIS FIRST for retirement work (step-2 findings,
  vendorOpeningBalances and step-3 rows refreshed 2026-10-08 — retirement order 1–3 now DONE)
- `client/src/utils/depreciation.ts` + `tests/depreciation.test.ts` (B5)
- `client/src/utils/registerRefreshDomains.ts` + `tests/registerRefreshDomains.test.ts`
  (SSE domain → paged-register mapping, extracted for testability)
- `server/src/services/damage.service.ts` (B1/B2 helpers), `server/src/models/procurement.repo.ts` (B3)

---

## 2026-10-19 — Serial input & transfer integrity (plan slices A–F)

Delivered the approved serial-input plan (see `docs/serial-input-improvements-plan.md` §8).

- **MAC canonicalisation:** one shared `shared/macAddress.ts` (`normalizeMacAddress`,
  `macKey`, `isMacAddress`) used by client and server; applied at purchase entry, the
  register write, the serial gate's comparisons, sales verification and lookup-by-MAC.
  `tests/macAddress.test.ts` pins separator/case/idempotence/non-MAC cases.
- **Purchase bill:** MAC required, **PON optional** (stored `NULL` when blank) for
  `SERIAL_MAC_PON`; per-unit slots now seed `macAddress` (they never did — that is why
  the MAC box was demanded but appeared empty); punch order Device → MAC → PON with
  blur/Enter canonicalisation. `requiresPonAndMac` → `requiresMac`.
- **One device key:** `serialGate.service` gained `hydrateSerialEntries`, which fills
  blank PON/MAC from the locked register row before any rule runs; the blanket
  `requirePon` was removed from `planSerialGateEntries` and from the sales claim. A
  PON/MAC the caller really sent is still checked.
- **One-field UX:** new `client/src/components/common/DeviceSerialInput.tsx` (with
  `findRegisterRow` / `classifyRegisterRow`) adopted on sales, shipment create, stock-op
  pullout/transfer/damage/product-sale, assign fixed asset, device exchange, customer
  assignment and CPE exchange. **All 10 invented-identity generators removed**; customer
  assignment derives product/PON/MAC from the register row.
- **Transfer register integrity (Slice 3):** dispatch `IN_STOCK → IN_TRANSIT`,
  receive `IN_TRANSIT → IN_STOCK` at the destination, cancel back to `IN_STOCK` at the
  source, undo-receipt back to `IN_TRANSIT` — all inside the existing transactions and
  mirrored in demo mode. Received serials are recorded per item, so a short receipt
  leaves the undelivered units in transit; dispatch plans through the shared gate, so
  the server also refuses a serial-tracked line with no serials.
- **Availability hardening:** per-product aggregate checks in the client validator, the
  shipment create path, `post_assets` and the locked stock-op re-check, returning `400`
  with available/requested via the new `server/src/utils/operationError.ts`; serialized
  assign lines pinned to quantity 1; `post_customerDevices` resolves the assigned unit
  through the shared gate (IN_STOCK at the branch).
- **Docs:** `docs/serial-register-audit.md` §6c records Slices 3–4 as delivered and
  closes the "transfers are register-blind" finding; handoff §17 summarises the changes.

Verification: `npx tsc --noEmit` clean; full suite **900 tests, 898 pass, 0 fail,
2 skipped** (the two pre-existing Windows-only real-signal checks); docs-count gate
green (all current-state counts updated to 900).
Residual: `post_exchange` still trusts the client's replacement serial at the API level
(the form picks from the register), and plan Slice 5 (demote the boot serial backfill to
a maintenance action) stays open.

## ⭐ Device exchange now draws its replacement from the register (2026-10-20)

Closing the last defence-in-depth gap from the serial-input pass. `post_exchange`
used to trust `newDeviceSerial` from the body: the customer-device row could name
a unit the register never received, or one held at another branch, and the
`SERIAL_LOG_SYNC_ON_CDR_SQL` UPDATE would silently no-op while the CDR row
claimed the device. The PG-contract test kept that shape alive because it posted
a replacement with no register row at all.

What changed:
- **Gate (server/src/controllers/inventory.controller.ts).** The replacement must
  be an `IN_STOCK` row of the fulfilling branch. Checked twice: a pre-flight
  before any mirror mutation (so a refusal is a clean `400` with the mirrors
  untouched), then again with `SERIAL_GATE_LOCK_SQL`'s `FOR UPDATE` inside the
  exchange transaction (so a concurrent consumer cannot slip in between). The
  product is deliberately NOT matched — a replacement may be a different model —
  while a PON/MAC the caller did send is still compared.
- **Hydration.** A blank PON/MAC is filled from the register row
  (`SERIAL_LOG_IDENTITY_BY_SERIAL_SQL`, new in `inventory.repo.ts`), so a
  one-field client payload produces a complete CDR row. Demo mode uses the
  in-memory mirror row for the same fill.
- **Rollback + status.** The mirrors (old record status/notes and the inserted
  replacement) are captured before the writes and restored if PG refuses after
  them; the handler no longer turns a `SerialGateError` into a `500` — it returns
  the gate's `400` and logs only real 5xx failures (an expected refusal should
  not print a stack trace).
- **Test (tests/mirrorStep3.test.ts).** The fixture now seeds a real `serial_log`
  row for `M3-NEW-EX` (IN_STOCK, with a MAC the test does not send) plus a
  `CUSTOMER_ASSIGNED` decoy. Proves: the IN_STOCK exchange succeeds and the new
  CDR row carries the register's MAC (hydration), the `CUSTOMER_ASSIGNED` one is
  refused `400` with no CDR row and no change to the earlier exchange.

Verification: `npx tsc --noEmit` clean; `tests/mirrorStep3.test.ts` 6/6;
`check:no-inline-sql` clean (the new SQL lives in the repo, not the controller);
full suite 911 tests, 909 pass, 0 fail, 2 skipped; docs-count gate green at 911.

## ⭐ Two simultaneous exchanges cannot both take the same replacement (2026-10-20)

The gate added in the previous entry made a *single* exchange prove its unit, but
nothing pinned what happens when two operators reach the same IN_STOCK serial at
the same time — the exact failure mode a register exists to prevent. New
`tests/exchange.concurrency.test.ts` (HTTP, real PostgreSQL, skips without a DB)
fires both requests through `Promise.all` and asserts the invariant instead of an
interleaving:

- exactly one `201`; the loser is refused `400` by the register gate when the two
  transactions overlap, or `409` by the duplicate check when it arrives after the
  winner committed (first run of the test exercised the `409` path, which is why
  the assertion accepts either — both are correct refusals, and the run-to-run
  difference is real);
- exactly one customer-device row for the contested serial, carrying the
  register's PON and the MAC the request never sent (server hydration);
- the register holds it as `CUSTOMER_ASSIGNED`, and only the winner's old record
  is `EXCHANGED` — the loser's own record stays `RENTAL`;
- a second case holds the row in an uncommitted transaction, commits mid-request,
  and proves the exchange is still refused with no customer record written.

One real bug surfaced while writing it: the rollback I added earlier restored a
whole-array snapshot of the CDR mirror, so a loser could erase a concurrent
winner's mirror row. It now removes only the id this request inserted
(`customerDeviceRecords.filter(r => r.id !== rejectedId)`).

Verification: `npx tsc --noEmit` clean; the new file 2/2 in three consecutive
runs; full suite 911 tests, 909 pass, 0 fail, 2 skipped; docs-count gate green
at 911.

## ⭐ One serial, two claims — and refusals that name the unit (2026-10-21)

The exchange gate proved a single exchange could not take an unstocked unit, and
the previous entry proved two exchanges could not take the same one. Four gaps
around it closed together.

- **Assignment vs exchange, one serial, same instant —
  `tests/assignmentExchange.concurrency.test.ts`.** The two paths reach the same
  register row through different endpoints, so the row (`FOR UPDATE`) is what
  serialises them. `Promise.all` fires `POST /api/customer-devices` and
  `POST /api/customer-devices/exchange` for the same IN_STOCK unit and asserts the
  invariant: exactly one `201`, the loser refused `400` (gate) or `409` (duplicate
  check, when it arrives after the winner commits); exactly one customer record
  names the serial and it belongs to the winner; the register ends
  `CUSTOMER_ASSIGNED`; stock drops by exactly one when the ASSIGNMENT won and not
  at all when the EXCHANGE won (an exchange consumes stock already decremented at
  receipt); the loser's own rental stays `RENTAL`.
- **Both dialogs now name the serial, its real status and the branch —
  `client/src/utils/serialRefusal.ts`.** One `describeReplacementRefusal` mirrors
  the server's `describeGateViolation` phrasing, so the Stock Operations panel and
  the Customers modal cannot drift: "ONU002-0007 is CUSTOMER ASSIGNED at Branch 1
  (Head Office) to Walk Customer — only IN_STOCK units can be issued as a
  replacement." Unknown, wrong-status, wrong-branch and wrong-product stay
  distinct (`tests/serialRefusal.test.ts`).
- **Refusal shown once.** `exchangeCustomerDevice` takes
  `{ silentErrorToast: true }` from both dialogs; `fetchJson` gained a `silent`
  config that suppresses the global mutation toast, so the sentence appears in the
  dialog that owns the decision instead of twice (once in a toast that then
  expires while the dialog still reads). `tests/apiToastSilencing.test.ts` pins
  it behaviourally: a silent refusal still carries `error.toast` for the dialog,
  but broadcasts nothing; the default and a plain GET keep their old behaviour.
- **Unknown serials resolved by the server, not the mount-once cache.** Both
  dialogs call `api.lookupExchangeSerial` before refusing. This needed its own
  route: `GET /api/inventory/serials/lookup` sits behind
  `edit-device-serials`, which FIELD_TECHNICIAN and BRANCH_MANAGER — the two
  roles that actually do field exchanges — do not hold. A probe as a field
  technician returned `403` on that route, i.e. the old wording would have
  survived for the exact operators it was meant to help.
  `GET /api/customer-devices/exchange/lookup` carries the exchange role list and a
  read-only handler; because its path falls under the branch-scoped read guard,
  the client sends the exchange `branchId`. A unit held outside the operator's
  branches returns its state and branch but never the customer holding it; HQ
  roles see the full row. `tests/exchange.concurrency.test.ts` pins the audience
  and the client path (`get_exchangeLookup`, `branchId` appended).
- **Serial resolved while typing.** `DeviceSerialInput` now resolves after a
  400 ms pause instead of only on blur/Enter, so the register status and the
  hydrated PON/MAC appear before the operator leaves the field. The inline hint
  uses the register's real status ("CUSTOMER ASSIGNED — not IN_STOCK") and
  names the holding branch instead of the old generic "already out of stock".
  A late lookup is discarded when the field has moved on
  (`latestSerial.current !== typed`), so a slow answer for A cannot overwrite B
  — the one hazard of resolving on every keystroke.

One behavioural note: the exchange handler no longer restores the whole
in-memory CDR array on rollback (it removes only the id this request inserted).
That fix came with the previous entry's concurrency test; the assignment test
would have caught the regression, since a restore would erase the assignment
that won.

Verification: `npx tsc --noEmit` clean; `tests/serialRefusal.test.ts`,
`tests/apiToastSilencing.test.ts`, `tests/exchange.concurrency.test.ts`,
`tests/assignmentExchange.concurrency.test.ts` and
`tests/registerRefreshDomains.test.ts` green; live probe against the dev
database: field technician `200` with `branchId` (real status), `403` without it
(branch-scoped read guard), `403` on the edit lookup, `404` for an unknown serial,
and a foreign-branch unit returning `CUSTOMER_ASSIGNED` + branch with
`customerName` masked (HQ saw the name). Full suite 940 tests, 938 pass, 0 fail,
2 skipped; docs-count gate green at 940.

## ⭐ A refused replacement leaves a trail (2026-10-21)

The exchange gate and both dialogs now name a refused unit, but a refusal that
only exists on one operator's screen is invisible: the same serial can be
claimed from three branches in an afternoon and nobody can see the pattern.
Refusals are now audit events — `DEVICE_EXCHANGE_REFUSED` on module
`CPE_MANAGEMENT`, with the serial, the register's **own** status and branch, the
actor, and the reason.

- **Two entry points, one record.** The dialogs pre-flight a replacement, so
  most refusals never reach the server; they report the attempt to
  `POST /api/customer-devices/exchange/refusal` (exchange roles only — AUDITOR
  gets `403` and writes nothing). The endpoint audits and returns `204`; it never
  mutates anything else. Server-side refusals — the register gate's `400`, the
  duplicate check's `409`, a `422` — are audited from `post_exchange`'s catch,
  and the early duplicate branch audits before it answers (that path returns
  rather than throws, so it would otherwise skip the catch).
- **The register is the witness.** `logExchangeRefusal` re-resolves the serial
  (`resolveSerialRow`) instead of recording the client's claim: the details line
  carries the status the register holds (`CUSTOMER_ASSIGNED`, `UNKNOWN` for a
  serial never received) and the branch holding it. A field technician's report
  therefore cannot invent a status; it only records that the attempt happened.
- **Committed with the refusal.** The audit insert is awaited on the pool, not
  fire-and-forget, so the row exists by the time the operator (or a test) sees the
  response. An audit failure is logged and never turns a clean refusal into a
  `500`.
- **What it costs:** one extra indexed serial read and one insert per refused
  attempt. Accepted deliberately — a refusal is rare, and this is the only
  signal that separates a typo from a unit being claimed twice.

Tests: `tests/exchangeRefusalAudit.test.ts` (5, real PostgreSQL) — dialog
refusal records serial/status/branch/actor; an unseen serial is `UNKNOWN`; an
AUDITOR gets `403` with no row; a gate refusal on submit is audited against the
submitting admin; and the `409` duplicate path is audited too, not only the gate.
`tests/registerRefreshDomains.test.ts` pins `reportExchangeRefusal` in both
dialogs' server-call surface.

Verification: `npx tsc --noEmit` clean; the five audit tests plus the refusal,
toast and surface suites green; full suite 940 tests, 938 pass, 0 fail, 2 skipped;
docs-count gate green at 940.

## ⭐ One serial, every event: the audit trail has a serial focus (2026-10-21)

The refusal trail existed but could only be watched, not searched: the Audit
Trail screen renders the bootstrap slice (the newest 200 audit rows), so a unit
whose last claim was three weeks ago simply was not on the screen. The screen now
takes a device serial and reads that unit's whole history from the server.

- **`GET /api/audit-trail?serial=…`** (`get_auditTrail` in the misc controller,
  query built in `misc.repo.ts`). It matches the serial inside `details ILIKE`,
  where every serial event already records it (claims, exchanges, refusals,
  corrections), returns newest first, and caps at 500 rows
  (`AUDIT_TRAIL_DEFAULT_LIMIT` 200 / `AUDIT_TRAIL_MAX_LIMIT` 500). The term is
  LIKE-escaped (`escapeLikeTerm` + `ESCAPE ''`), so a typed `%` is a serial
  character, not "everything". Gated by `requirePermission('admin-audit')` — the
  same operation the sidebar and App use to show the screen.
- **Branch scoping is the handler's, not the client's.** Non-global roles read
  their own + allowed branches (`branch_id = ANY($1)`); asking for a foreign
  `branchId` is a `403`, and an account with no branch scope short-circuits to
  `[]` instead of an unfiltered read. An empty scope still generates
  `WHERE FALSE`, so the repo can never fall back to a full scan.
- **The screen keeps the live list as its base state.** Typing debounces 300 ms;
  serial rows replace the bootstrap slice only while a serial is applied, a failed
  read falls back to the slice with an inline note, and clearing the box goes
  straight back to the SSE-refreshed prop. A status line reports
  "N events for SN … (newest/oldest first)" and counts refused attempts;
  `DEVICE_EXCHANGE_REFUSED` rows are amber and carry an icon, and the order toggle
  flips to oldest-first so a supervisor can read the story chronologically. CSV
  export follows the filtered list, not the raw prop.

Tests: `tests/misc.repo.test.ts` pins the SQL (serial before limit, escaped
wildcards, `ANY($1)` branch array, `WHERE FALSE` for an empty scope).
`tests/exchangeRefusalAudit.test.ts` (now 8, real PostgreSQL) proves the read:
every event for the unit newest-first, `403` for a role without `admin-audit`, and
a foreign-branch auditor sees `[]`, plus `403` on an explicit foreign `branchId`.
`tests/registerRefreshDomains.test.ts` pins `getAuditTrail` as the screen's only
server call, with the reason it is a search rather than a duplicated list.

Verification: `npx tsc --noEmit` clean; full suite 940 tests, 938 pass, 0 fail,
2 skipped; docs-count gate green at 940.

## ⭐ Production refuses to boot on an ephemeral auth secret (D1/D2, 2026-10-21)

`middleware/auth.ts` signs login tokens with `AUTH_TOKEN_SECRET` and falls back
to a per-process `crypto.randomBytes(32)` value when it is unset. That fallback is
right for `tsx watch` and wrong for production: pm2 restarts this process at 1 GB,
so every restart silently logged everyone out, and a second instance could never
verify the first's tokens. Nothing enforced the variable — the module only printed
a warning — so a deployment could run that way indefinitely.

- **One pure validator** (`server/src/boot/authSecret.ts`): production requires a
  non-blank secret, not one of the template values published in `.env.example`
  (compared case-insensitively), and at least 32 characters. Each refusal carries
  the reason plus the `randomBytes(32)` command to generate a real one; the
  too-short message names the length and never echoes the value. Development and
  test still return `ok` so the ephemeral fallback (and its warning) survives.
- **Checked before anything opens.** `server/index.ts` calls it after
  `lifecycle.install()` and before `startServer()`, routing a refusal through the
  existing `failBoot` path: `FATAL: server failed to start` on stderr and a hard
  exit 1, no database connection attempted, no port opened. Importing the app
  still evaluates `auth.ts`, but no token can be signed before the process dies.
- **Docs tell the truth now.** `.env.example` calls the variable REQUIRED in
  production and shows the generation command; README's "all optional" heading
  and handoff's "nothing generates-or-persists one for you" text were corrected.
- **Collateral call sites.** `scripts/verify_fresh_install.mjs` boots the real
  entry in production, so it now passes a throwaway ≥32-character secret (with a
  comment); the Dockerfile and the README Docker block state that the container
  exits on start without a real one. Dev and test are untouched.

Tests: `tests/authSecretGuard.test.ts` (8) — five pure-validator cases (dev/test
allowed; missing/blank; every placeholder; short without echoing; 32+ accepted)
and a real production boot with an explicitly EMPTY secret (dotenv never overrides
an existing key, so a developer `.env` cannot fake a pass) proving exit 1, the
message, and that the PostgreSQL phase never starts. `tests/bootFailureExit.test.ts`
now supplies a valid secret so it keeps testing the database failure it exists for.

Verification: `npx tsc --noEmit` clean; the new and neighbouring boot/env suites
green; full suite 940 tests, 938 pass, 0 fail, 2 skipped; docs-count gate green at
940. Backlog D1/D2 ticked in `docs/architecture-backlog.md`.

## ⭐ The single-process constraint is written down, not implied (D3, 2026-10-22)

`ecosystem.config.js` has always pinned `instances: 1` / `exec_mode: 'fork'` with a two-line
comment that said sessions, caches and SSE are process-local. That comment is the only thing
standing between a scaling "fix" and silent staleness, and it never said what would break or
what to move first. D3 puts the full constraint where a deployer meets the knob.

- **README → _Single process only (do not raise `instances`)_** (Production Deployment, right
after the PM2 step): a table of the three unshared concerns — operational caches in
`runtimeState.ts` (each worker refreshes only after its own committed write, so a save handled
by the other worker stays invisible), SSE fan-out in `realtime/sse.ts` (an event reaches only
the clients connected to the worker that handled it), and the per-process rate-limit/connection
buckets in `authRateLimit.ts` / `sseRateLimit.ts` (N workers multiply the configured budget) —
plus the one `AUTH_TOKEN_SECRET` every worker must share, and the four prerequisites for
cluster mode: shared cache store, pub/sub for `broadcastChange`, shared limiters, and a proxy
that does not cut long-lived streams (`proxy_read_timeout` above the 25 s keep-alive).
- **`ecosystem.config.js`** now names that README section in the `instances: 1` comment, so the
next editor cannot read the number without the reason.
- **handoff §14.2** repeats the constraint in the PM2 section and links both the README section
and the backlog item.

Tests: `tests/singleInstance.guard.test.ts` (4) — file parsing only: the pm2 config must stay one
fork-mode worker (a `2`/`max` value fails) and name the README section; the README section must
name all four source files, all three consequences and every cluster prerequisite, and link D3;
handoff must repeat it and link both places; the backlog must have D3 ticked with a Done row that
points at this test. Documentation that drifts now fails the suite instead of misleading a
deployer.

Verification: `npx tsc --noEmit` clean; full suite 944 tests, 942 pass, 0 fail, 2 skipped;
docs-count gate green at 944. Backlog D1–D3 ticked in `docs/architecture-backlog.md`; **C1 is next**
(per-slice `idle / loading / ready / error` status, with the last good rows kept on failure).

## ⭐ Per-slice bootstrap status: a failed refresh is visible, not silent (C1, 2026-10-22)

Three deferred ledgers and every SSE-targeted slice fetch ended in
`.catch(() => null)`. GET failures are deliberately never toasted (`http.ts`), so a
slice that failed looked exactly like a slice that was still loading and exactly like a
ledger that is genuinely empty — the rows on screen stayed (good) but nothing said they
were no longer current (bad). C1 replaces that silence with one per-slice status table.

- **`client/src/services/bootstrapSlices.ts`** — a pure, import-free reducer: per key
`{ status: idle | loading | ready | error, dataVersion?, error?, errorDismissed? }`.
The `dataVersion` is the one that produced the rows currently on screen and is KEPT on
failure, so "last good data" survives; `beginSliceLoad` keeps the error too, which is why
the notice does not blink out mid-retry. A retry that fails with the SAME message stays
dismissed; a different message re-surfaces it.
- **One loader for both paths.** App's `fetchBootstrapSlice(key, branchId, fiscalYearId)`
marks loading → fetches `GET /api/bootstrap/local?key=` → applies the payload on success
(recording the version and advancing `serverDataVersionRef`) or marks the key `error`
with the server's message. `hydrateDeferredSlices` and the SSE targeted branch both call
it, so a failure behaves identically wherever the refetch came from — the C1 requirement
that the deferred keys and targeted refreshes share one state.
- **A payload proves only what it carried.** `applyBootstrapData` marks ready the keys
present in the request; the full bootstrap does not include the three deferred ledgers,
so their errors survive it until their own fetch succeeds. The instant pre-hydration from
the 2-minute cache passes `{ fromCache: true }` and marks NOTHING — a cached snapshot is
display data, never proof of freshness.
- **One notice, not a toast storm.** `client/src/components/common/BootstrapSliceNotice.tsx`
renders every undismissed failure as a single amber, `role="status"` banner: the friendly
slice names, the server's reason (or a count when several failed), and the explicit line
that nothing was cleared. One Retry re-fetches every failed slice for the CURRENT branch/FY
from `syncScopeRef` (never a stale closure) and spins while any slice is loading; one X
dismisses them all.

Tests: `tests/bootstrapSlices.test.ts` (10) — the reducer's transitions, version retention
across failures, payload-only readiness after a full bootstrap, dismissal vs re-appearance,
immutability, labels, and source pins that both hydration paths use the one loader and the
notice keeps its single retry/dismiss wiring. C2 (scope guards + version monotonicity) and
C3 (broader hydration coverage) remain open.

Verification: `npx tsc --noEmit` clean; `npm run build` green; full suite 954 tests,
952 pass, 0 fail, 2 skipped; docs-count gate green at 954. Backlog C1 ticked;
**C2 is next** (stamp `branchId|fiscalYearId|seq`, discard stale responses, never apply an
older `dataVersion`).

## ⭐ A slice response for a view you already left is discarded (C2, 2026-10-22)

C1 made a failed refresh visible; C2 closes the other silent corruption. A deferred slice
or targeted refresh requested for one branch/fiscal year could land after the user
switched, painting the new view with the previous view's rows — no error, no indicator.
The full bootstrap had a sequence guard; the slice paths had nothing.

- **`SliceRequestGate`** (same module as C1): `begin(key, scope)` stamps a request with
`scope = branchId|fiscalYearId` (an absent scope is `ALL`, mirroring the API) and a
monotonic `seq` per key. Before a payload is applied, `decide(request, currentScope,
responseVersion)` returns `apply`, `superseded`, `stale-scope` or `older-version`.
- **`stale-scope`** — the user switched branch/FY while the request was in flight; the
payload belongs to the view they left. The response is dropped, the loading flag is settled,
and the notice is NOT raised (a failure or success from an abandoned view is not news about
the current one). `syncScopeRef` is the current-view source, the same one the SSE handler
already trusts.
- **`superseded`** — a newer request for the same key exists (two refreshes in a row). Its
response must not touch the key's status or data; the newer request owns both.
- **`older-version`** — same view, but the payload's `dataVersion` is older than the version
last applied for THAT key (out-of-order arrival). Equal versions still apply. Versions are
per key, and a full bootstrap records its version for every key it carried
(`noteApplied`), so a targeted request that started before the bootstrap and returned
after it cannot overwrite newer rows.
- **Status hygiene:** `settleSliceDiscarded` turns the `loading` flag set by `beginSliceLoad`
back into the truth — `ready` with the still-displayed version, the retained `error`, or
`idle` when nothing ever loaded — so a discarded request cannot leave the Retry button
disabled forever.

Tests: `tests/bootstrapSlices.test.ts` grew to 19 (9 new): current-view apply; stale scope
with a *newer* version; supersession; older vs equal versions; per-key isolation; a
bootstrap version blocking a slower slice; `ALL` scope-key mapping; status settlement; and a
wiring pin that `decide` runs before `applyBootstrapData` and that the bootstrap records
applied versions. Live check in the running dev server: with a 4 s delay injected on
ALL-branch `stock` responses, starting a refresh and switching to BRH01 200 ms later left
the screen on BRH01's 15 rows when the delayed ALL payload landed at 4 s — the 16-row ALL
payload was discarded, with no notice.

Verification: `npx tsc --noEmit` clean; `npm run build` green; full suite 963 tests,
961 pass, 0 fail, 2 skipped; docs-count gate green at 963. Backlog C2 ticked;
**C3 is next** (hydration tests for the remaining behaviours, e.g. the full-bootstrap
sequence guard and SSE burst → refresh plans).

## ⭐ The hydration reducer and gate, tested together with out-of-order arrivals (C3, 2026-10-22)

C1's tests checked the status reducer one call at a time and C2's checked one gate decision
at a time. Neither proved the two compose into what a user sees — and the original bugs
were exactly ORDERING bugs, which unit calls in a comfortable sequence cannot catch. C3
adds `tests/hydrationFlow.test.ts`: eight scenarios that drive both modules in App's order
(begin → decide → apply/error/settle) and resolve the stamped requests out of order.

- **A small harness, not a copy of App.** `HydrationHarness` holds the reducer state, the
`SliceRequestGate`, the current scope and an `applied` log of what would be painted; its
methods follow the contract App's `fetchBootstrapSlice` implements, which
`bootstrapSlices.test.ts` pins. The scenarios therefore exercise the real reducer and
real gate, with arrival order controlled by the test instead of the network.
- **Scenarios:** bootstrap then a slower older slice payload (discarded, stays on v100);
branch switch with the old response arriving both before the new request (stale-scope) and
after it (superseded), asserting the new view's rows are the only ones painted; two bursts
for one key where the earlier response is superseded and must not paint; the full
failure → notice → dismissal → same failure quiet → success clears lifecycle; a failure
from an abandoned view never raising a notice in the new one; per-key version monotonicity
with equal versions still applying; a deferred ledger error surviving a full bootstrap
that does not carry it; and discarded-request settlement in all three prior states
(idle, ready-with-version, retained error).

Tests: `tests/hydrationFlow.test.ts` (8). Existing source guards (`bootstrapTrim`,
`registerRefreshDomains`, and the C1/C2 wiring pins) still pass unchanged; C4 (the optional
single hydration entry point) remains parked, and A/B are untouched.

Verification: `npx tsc --noEmit` clean; `npm run build` green; full suite 971 tests,
969 pass, 0 fail, 2 skipped; docs-count gate green at 971. Backlog C3 ticked.
Next stop point: **A1** (memoize kept-mounted screens) unless C4 is chosen deliberately.

## ⭐ Kept-mounted screens stop re-rendering on unrelated root state (A1, 2026-10-23)

The keep-mounted container (2026-10-05) stopped tab switches from REMOUNTING screens, but
App rebuilds every tab element on every render — a keystroke in the global search box was
enough — so React re-rendered every screen the user had ever opened, hidden tabs included.
A1 fixes that at the container boundary instead of rewriting the 3,294-line root.

- **`client/src/utils/screenElementMemo.ts`** — one slot cache per `KeepMounted` instance. A
slot returns the *identical element object* while the screen's type and shallow-equal props
are unchanged; React then bails out of that subtree (`prevChild === nextChild`). Any real
data change is a new value, so the screen re-renders exactly as before.
- **Callbacks are proxied, not compared.** App defines its handlers inline, so their identity
changes on every render — comparing them would disable the cache entirely. Each function prop
becomes a stable proxy that forwards to the newest closure: the element keeps its identity
and a click still runs against current state (no stale props). Pinned by the
"newest closure" test.
- **Lazy tabs:** a `React.Suspense` wrapper is rebuilt (its `fallback` element is fresh each
render) but its child screen is the memoised element, so the screen subtree still bails out.
- **No App.tsx change:** all 67 tabs already render through `<KeepMounted>`, which is where
the cache lives. A guard asserts the tab count and that every tab's child is an element
(directly, or one Suspense deep) — the shape the cache can address.

Measured, not inferred from source text: `tests/harness/{dom,mount,keepMountedProbe}` mount
the same probe tree twice — once through the pre-A1 container (`{everVisible ? children :
null}`), once through the shipped one — and count **screen body executions** in a real
`react-dom` render (jsdom). Ten keystrokes after visiting all four tabs: **40 screen renders
before, 10 after**; the only screen that still re-renders is the one consuming the query.
Tab switching produces identical render counts in both modes, `useActivationKey` still ticks
on re-activation (2 on the second activation), and a rows change still reaches all four
screens.

Tests: `tests/screenElementMemo.test.ts` (14) + `tests/keepMountedRenderCount.test.ts` (9).
Two devDependencies: `jsdom` + `@types/jsdom` (the measurement needs a real DOM — this is the
first piece of the A6 harness, not a runtime dependency).

Verification: `npx tsc --noEmit` clean; `npm run build` green; full suite 1000 tests,
998 pass, 0 fail, 2 skipped; docs-count gate green at 1000. Backlog A1 ticked.
Next stop point: **A2** (move shell-only UI state out of the data tree), then A6 before A3/A4.


