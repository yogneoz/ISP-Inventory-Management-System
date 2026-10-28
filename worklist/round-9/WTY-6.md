# WTY-6 — Suppliers Warranty and Sellers Warranty registers

Status: `[ ]` not started · Round 9
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
- Columns: Customer, Product, Serial, Source, Issue Date, Start, Warranty
  Expiry, Status, Branch, Edit.

**Shell**

- New tabs `vendor-warranty` / `seller-warranty` in `Sidebar.tsx`,
  `App.tsx` route map and `tabPermissions.ts` (`warranty-view`).
- One shared edit modal (`warranty-edit`): exact start/expiry dates, term
  read-only snapshot shown, notes; saves through PATCH, surfaces the API error,
  refreshes the page and the KPIs; a 403 says the account may not correct dates.
- Retire `WarrantyProducts.tsx`, its nav entry, its route and
  `GET /api/customer-devices/warranty` (replace callers with the new read).
- Register-refresh wiring: warranty edits appear in the SSE refresh domain map
  if the existing domain contract needs it; otherwise a local refetch only.

## Acceptance checklist

- [ ] Both screens render KPIs, filters and rows from a fixture through the real
      API contract; the default filter is all statuses (regression from the
      screenshot).
- [ ] Empty states differ between "nothing captured" and "no match"; both show
      the applied filters.
- [ ] Paging and every filter round-trip through the server (branch included);
      branch accounts never see another branch's rows.
- [ ] The edit modal saves a corrected expiry, refuses a reversed range
      inline, and a role without `warranty-edit` sees no Edit control and gets
      the API 403 surfaced.
- [ ] The retired screen, route, nav entry and endpoint are gone; a source
      guard fails if either returns.
- [ ] Screen render tests follow the existing `tests/harness/mount.tsx` style;
      `npx tsc --noEmit`, `check:no-raw-dialogs` and the bundle budget pass.

## Out of scope

Claims/RMA, exporting the registers, and any new dashboard KPI.
