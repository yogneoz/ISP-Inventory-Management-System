# WTY-6 — Suppliers Warranty and Sellers Warranty registers

Status: `[x]` done (2026-10-29) · `5abf19e` · Round 9
Order: 6 · Depends on WTY-2 (API) and the capture slices for meaningful data.

## Why

The retired "View Warranty Products" screen unions CPE and assets, recomputes
12 months in the browser and lands on an empty table whenever the default
`VALID` filter misses the seed data. The replacement shows the two contractual
sides separately, reads the server-computed state, and never presents a blank
table as if no units existed.

## Scope

**Client API** (`client/src/services/api/warranty.ts` + `api/index.ts` export)

- `fetchVendorWarranties(query)` / `fetchSellerWarranties(query)` returning the
  paged payload with counts, and `updateWarrantyCoverage(id, input)`.

**Suppliers Warranty** (`client/src/features/inventory/SupplierWarrantyRegister.tsx`)

- KPIs: covered units, valid, expiring ≤ 30 days, expired — whole filtered
  population, labelled as such.
- Filters: search (serial/tag, product, supplier, source), status, category
  (CPE / Fixed Asset), start-date range, branch. **Default: all statuses.**
- Columns: Product & Category, Serial/Tag, Supplier, Source, Start, Warranty
  Expiry, Status, Branch, Edit.
- Server-paged with the shared pagination component; distinct empty states for
  "no coverage captured yet" vs "filters match nothing".

**Sellers Warranty** (`client/src/features/inventory/SellerWarrantyRegister.tsx`)

- KPIs: issued units, valid, expiring, expired.
- Filters: search (customer, serial, product, source), status, type (Rental CPE
  / Sold Product), start-date range, branch. **Default: all statuses.**
- Columns: Customer, Product, Serial, Source, Start (issue / sale), Warranty
  Expiry, Status, Branch, Edit.

**Shell**

- New tabs `supplier-warranty` / `seller-warranty` in `Sidebar.tsx`,
  `App.tsx` route map and `tabPermissions.ts` (`warranty-view`).
- One shared edit modal (`warranty/WarrantyEditModal.tsx`): exact start/expiry
  dates, term read-only snapshot shown, notes; saves through PATCH, surfaces the
  API error, refreshes the page and the KPIs; a 403 says the account may not
  correct dates.
- Retired `WarrantyProducts.tsx`, its nav entry, its route and
  `GET /api/customer-devices/warranty`, together with the demo mirror, the SQL
  union builders (`WARRANTY_ITEMS_CTE`, `buildWarrantyDirectoryQuery`, count and
  summary) and the client wrapper.
- Register-refresh: both tabs re-read on the existing `customerDevices` counter
  (CUSTOMER_DEVICES / ASSETS / capture events). The correction itself refetches
  locally after the supersede; no new SSE domain was needed.

## Acceptance checklist

- [x] Both screens render KPIs, filters and rows from a fixture through the real
      API contract; the default filter is all statuses (regression from the
      screenshot). `tests/warrantyRegisters.test.ts` mounts both screens through
      `tests/harness/mount.tsx`, stubs only the network boundary, and asserts the
      initial call carries no `status` while the control reads `ALL`.
- [x] Empty states differ between "nothing captured" and "no match"; both show
      the applied filters. The captured-empty state names the capture path and
      the filter summary; the no-match state names the filters and says clear
      them. Both render the same `Search/Status/Category/Start` summary.
- [x] Paging and every filter round-trip through the server (branch included);
      branch accounts never see another branch's rows. The render test drives
      search (Enter), status, type, start date, branch and Next-page and asserts
      the exact arguments; the branch-isolation and forged-branch refusals are
      proven over real HTTP + PostgreSQL in `tests/warranty.api.test.ts` (WTY-2).
- [x] The edit modal saves a corrected expiry, refuses a reversed range inline,
      and a role without `warranty-edit` sees no Edit control and gets the API
      403 surfaced. The save asserts the PATCH payload and that the register
      refetches rather than patching the superseded row; the reversed case
      asserts zero PATCH calls; a stubbed 403 renders "may not correct warranty
      dates".
- [x] The retired screen, route, nav entry and endpoint are gone; a source guard
      fails if either returns. `retired warranty directory` in
      `tests/warrantyRegisters.test.ts` checks the file, App, Sidebar, routes,
      controller, repo and client wrapper, and pins both new tabs to
      `warranty-view`.
- [x] Screen render tests follow the existing `tests/harness/mount.tsx` style;
      `npx tsc --noEmit`, `check:no-raw-dialogs` and the bundle budget pass.

## Verified locally (2026-10-29)

- `npx tsc --noEmit` — clean.
- `npx tsx --test tests/warrantyRegisters.test.ts` — **10 tests, 10 pass,
  0 fail**: 7 render/contract tests (both sides, KPIs, filters/paging, empty
  states, correction, 403, view-only role) and 3 retirement guards.
- `npx tsx --test tests/registerRefreshDomains.test.ts
  tests/docsCounts.guard.test.ts` — **52 + 8 pass** after pinning the shared
  register and the two screens (and updating the 67 → 70 screen count).
- `npx tsx --test tests/customerDevicesOffBootstrap.test.ts
  tests/inventory.repo.test.ts tests/appRouteTree.test.ts
  tests/warranty.api.test.ts` — **87 pass, 0 fail**; the warranty API's branch,
  permission and supersede proofs still pass against PostgreSQL.
- `npx tsx --test tests/appRouteRegistry.test.ts
  tests/screenElementMemo.test.ts` — **19 pass** after the tab count 68 → 69
  (one warranty tab became two).
- Full `npm test` — **1558 tests, 1556 pass, 0 fail, 2 Windows-only skips**;
  docs-count gate green at 1558; `npx tsc --noEmit` clean.
- `npm run check:no-inline-sql` — clean (17 controller files).
  `npm run check:no-raw-dialogs` — clean (171 client files).
  `npm run check:bundle-budget` — OK (entry 15.9 kB gz of 17; startup 283.3 kB
  gz of 320).
- Behaviour observed through the mounted screens, not just compilation: the
  default read has no status filter; a status/type/date/search/page change
  reaches the API with the branch and the expected arguments; a correction sends
  the typed exact expiry and refetches; a reversed range never reaches the API;
  a 403 is shown as a permission refusal; a view-only role is offered no edit.
  The server-side branch isolation, permission gate and audited supersede were
  exercised earlier over real HTTP against PostgreSQL in WTY-2 and still pass.

## Implementation notes

- The two screens are thin declarations of one shared `WarrantyRegister`
  (`coverageType` = VENDOR / SELLER); all fetch, KPI, paging, filtering and empty
  state live in one place, and the modal is shared.
- Nothing re-derives an expiry from a term: the stored `endDateAD` and the
  server's `warrantyState`/`daysRemaining` are rendered directly. The term is a
  read-only snapshot in the modal.
- The seller "Start (issue / sale)" column uses the coverage's canonical start
  rather than duplicating the same date into an "Issue Date" column.

## Out of scope

Claims/RMA, exporting the registers, and any new dashboard KPI.
