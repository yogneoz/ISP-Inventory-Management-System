# WTY-5 — capture what we promise the customer

Status: `[x]` done (2026-10-29) · Round 9
Order: 5 · Depends on WTY-1/2/3.

## Why

The outbound warranty starts at issue/sale, not at purchase, and it is a
separate promise from the supplier's. The app currently derives it from the CPE
issue date at read time, so a negotiated 6- or 24-month term cannot be recorded
and an exchange silently restarts a 12-month clock. Each flow below must write
the seller row in the same transaction that creates or moves the unit, and must
supersede the previous period instead of editing it.

## Scope

| Flow | Capture | Writes |
|---|---|---|
| Assign Customer Device (`stockops/AssignAssetPanel.tsx`, `inventory.controller.ts`) | **Sellers warranty expiry**, prefilled `issueDateAD + product.sellerWarrantyMonths` | one SELLER row per issued serial, `item_category = CPE`, party = customer, source = assignment, `start_basis = ISSUE_DATE` |
| Product sale (`stockops/ProductSalePanel.tsx`, sales controller) | per-line sellers expiry prefilled from `saleDateAD + term` | one SELLER row per sold serial, `item_category = SOLD_PRODUCT`, party = customer, source = sales invoice |
| Exchange / redeploy (`stockops/DeviceExchangePanel.tsx`) | sellers expiry prefilled for the replacement unit | new SELLER row for the new serial; the old unit's current row superseded |
| Device collected / refunded (`unassignRestock`, returns) | — | current SELLER row for that device record superseded |
| Customer-device register | read | shows the **stored** seller coverage, never `issued_date + 12` |

Rules common to every row: date dirty-tracked exactly like WTY-4 (the issue or
sale date may change before submit); end ≥ start; validation is identical client
and API.

### Every capture surface gets an explicit coverage switch

A blank date is ambiguous today, so each surface carries a **Warranty covered**
toggle (on when the product's term is > 0). Covered off hides/disables the date
and writes **no row**; covered on makes the date required (prefilled, editable).
The API contract is `{ warrantyCovered: boolean, warrantyEndDateAD: string | null }`:
`covered: false` skips, `covered: true` with a blank date is a 400 ("enter an
expiry or turn the warranty off") — never a silent fallback to the product
default. This is the only way an operator can say "no warranty" for one unit
while the product keeps a 12-month default for the rest.

A unit with no coverage is **absent** from `warranty_coverages`; the seller
register lists the issued/sold population left-joined to its current row so it
can render a distinct **No warranty** state, never an invented expiry and never
an "expired" badge. The audit log records the declared-none decision.

## Acceptance checklist

- [x] Assignment writes exactly one SELLER row per serial with the customer,
      branch, device record and assignment source; a failed assignment leaves
      none. Both `Assign Fixed Asset` branches are covered: the product line that
      deploys from stock (`POST /fixed-assets` with `deployFromStock`) and the
      ledger-asset line that calls `POST /customer-devices` — the coverage keys
      on the `customer_device_records` id each path creates. Proven over HTTP
      against PostgreSQL for the assignment route, including the refused issue
      that leaves no device row.
- [x] Product sale writes one row per sold serial with the sales-invoice source;
      an exchange creates a row for the new serial and supersedes the old one;
      collection/refund leaves no current SELLER row for that device. Both the
      retail `STOCK_OUT` operation and the sales invoice capture, and both
      reversals supersede the rows they created.
- [x] Prefill = start + the product's seller term for 12, 0 and 24; a touched
      expiry survives an issue/sale date change (regression test). The shared
      resolver pins 0 = no row and a typed date = exact expiry; the screens
      prefill through the same `warrantyEndFor` used by WTY-4.
- [x] **Coverage off writes no row** on every surface, and covered-on with a
      blank date is refused by both the screen and the API (regression test); a
      product default of 12 no longer re-derives a date the operator cleared.
      Invoice, asset, assignment, sale and exchange all take explicit
      `warrantyCovered`; the shared resolver refuses `true` + blank with the
      operator-facing message.
- [x] The customer-device badge and register read the stored coverage and the
      old `issued_date + 12` computation is gone from that read path. The page
      and export SQL left-join the current SELLER row and return a NULL state for
      a unit declared without one, so the register says "No warranty" instead of
      inventing a date. The legacy warranty directory still computes its own
      term and is retired by WTY-6; that is recorded below as the remaining gap.
- [x] `npx tsc --noEmit` clean; existing exchange/unassign/sale suites green.

## Verified locally (2026-10-29)

- `npx tsc --noEmit` — clean.
- `npx tsx --test tests/warrantyCapture.test.ts
  tests/sellerWarrantyCapture.api.test.ts tests/purchaseWarrantyCapture.api.test.ts
  tests/fixedAssetWarranty.api.test.ts tests/fixedAssetWarrantyForm.test.ts` —
  **23 tests, 23 pass, 0 fail** against PostgreSQL: 7 resolver/prefill, 7 seller
  HTTP, 8 supplier capture (the two WTY-4 suites plus the two new switch cases),
  and 2 asset-modal render tests (one new for the switch).
- Full `npm test` — **1549 tests, 1547 pass, 0 fail, 2 Windows-only skips**;
  docs-count gate green at 1549; `npx tsc --noEmit` clean.
- `npm run check:no-inline-sql` — clean (no new SQL outside the repo layer).
- Observed over real HTTP, not just status codes: the assignment row carries the
  CDR id, customer, branch, `ISSUE_DATE`, the exact typed expiry and stays
  current; a declared-none unit leaves zero rows; a covered unit with a blank
  date is a 400 that writes neither coverage nor device row; the register read
  returns the stored `2031-01-31` and `VALID`; collection leaves one superseded
  period; an exchange leaves the old serial with no current row and the
  replacement current with its own typed date; a retail sale writes a
  `SOLD_PRODUCT` row whose reversal retires it; a sales invoice writes its own
  `SALES_INVOICE` source and cancellation retires it.
- Known observation outside this slice: `CREATE_SALES_INVOICE` audit rows are
  rejected by `audit_logs_module_check` ('SALES' is not an allowed module), so
  that audit write fails silently. Pre-existing, untouched here; recorded so the
  next audit pass can fix it.

## Implementation notes

- `resolveWarrantyCoverage` in `shared/warrantyTerm.ts` is the one rule: explicit
  off → no row; explicit on + blank → error; typed date → validated and the
  stored term is `null` when the catalog term is 0 (no "0 months" beside a real
  expiry); unspecified `covered` keeps the legacy derive-from-term behaviour for
  older callers.
- `buildSellerCoverageCaptures` mirrors the purchase builder and is used by the
  asset deploy, customer-device issue, exchange, stock-out sale and sales
  invoice. Every write happens inside the transaction that creates/moves the
  unit; `writeSellerCoveragePlan` is the PG/mirror switch.
- The prefill is `warrantyEndFor(today, product.sellerWarrantyMonths)`, with the
  switch defaulting off for a 0-month product — so the "no warranty, buy it
  yourself" case has a real state instead of a silent 12-month guess.

## Audit findings (2026-10-29)

1. **Blank means "use the default", not "none".** `buildPurchaseWarrantyCaptures`
   falls back to the product term for a blank expiry, and the form treats a
   cleared field as valid (`warrantyEndFieldError` returns null for `''`).
   Probed headlessly: a 12-month product with the field cleared still writes
   `start + 12`; a 0-month product writes no row; a 0-month product with a typed
   date writes that date. So "no supplier warranty for this unit" is
   inexpressible unless the whole product is set to 0.
2. **`Assign Fixed Asset` has no warranty capture at all.** Neither branch sends
   a date (`createAsset({ deployFromStock: true })` and
   `createCustomerDevice`), and `supersedeSellerCoverageForDevice` has no
   caller — there is no SELLER write anywhere in the app. A rental CPE therefore
   shows the legacy invented 12 months, including on a 0-month product.
3. **The term snapshot can contradict the dates.** Both capture paths store
   `term_months = warrantyMonthsFor(product, …)` even when the operator typed a
   date; a 0-month product with a typed expiry stores `term_months = 0` beside a
   real expiry, and a 24-month product given a 36-month contract stores 24. The
   register would then print a term that disagrees with its own expiry column.
   Store the effective term when the date is typed (or `null` = "not derived"),
   and keep the product default only for the prefill.
4. **Two read paths still invent the term.** `inventory.repo.ts` computes
   `issued_date_ad + 12 months` (CPE) and `acquisition_date_ad + 12 months`
   (assets) for the old warranty directory, and `CustomersManagement.tsx` calls
   `getWarrantyInfo(rec.issuedDateAD, rec.warrantyMonths || 12)` with a field the
   API never returns. The fixed-asset modal likewise always prefills 12 and its
   hint says so; clearing it stores 12 because the server falls back to the
   unlinked-product default. These are WTY-5/6 work, not WTY-4 regressions.

## Out of scope

Vendor coverage (WTY-4), the two new registers (WTY-6), and warranty claims/RMA.
