# WTY-4 — capture what the supplier owes us

Status: `[x]` done (2026-10-28) · Round 9
Order: 4 · Depends on WTY-1/2/3.

## Why

An inbound purchase is the only moment the supplier's warranty is known. Today
it is not asked for; the directory later invents 12 months from the acquisition
or issue date. The supplier's term must be captured at the document that creates
the unit, per serial, in the same transaction as the stock receipt — otherwise a
failed receipt can leave a coverage row for stock that never arrived.

## Scope

**Purchase invoice** (`client/src/features/procurement/PurchaseInvoiceForm.tsx`,
`server/src/controllers/procurement.controller.ts`, `procurement.repo.ts`)

- Per serialised line: a **Suppliers warranty expires** date input, prefilled
  from `purchaseDateAD + product.vendorWarrantyMonths`.
- The prefill is dirty-tracked: changing the purchase date or re-selecting the
  product re-derives it **only while untouched**; an operator-entered date is
  never clobbered. Changing quantity does not reset it.
- Non-serialised (quantity-only) lines carry no per-unit coverage and say so.
- Submit validates end ≥ purchase date on the client and the API; the API
  returns 400 on a malformed or reversed date.
- On receipt, one VENDOR row per serial in the invoice's transaction:
  `item_category = CPE`, source = purchase invoice, party = supplier, branch =
  invoice branch, `start_basis = INVOICE_DATE`, term snapshot from the product.
- A purchase return / reversal supersedes the rows that invoice created.

**Fixed asset** (`client/src/features/finance/FixedAssetRegister.tsx` /
creation modal, `server/src/controllers/fixedAssets.controller.ts`,
`fixedAssets.repo.ts`)

- A **Supplier warranty expiry** field prefilled from
  `acquisitionDateAD + product.vendorWarrantyMonths` (12 when the product is not
  linked), dirty-tracked like the invoice.
- Create writes a VENDOR row keyed by the asset tag; editing the asset updates
  or supersedes its current VENDOR row rather than leaving two current rows.
- Disposal supersedes the current VENDOR row.

## Acceptance checklist

- [x] Invoice: the prefilled expiry equals purchase date + the product's vendor
      term for 12, 0 and 24 months; a 31 Jan start lands on the clamped
      month-end. `tests/warrantyCapture.test.ts` pins the arithmetic (31 Jan +
      1 month = 28 Feb, leap years keep 29), and the form's serial row carries
      the field (`#pi-warranty-{line}`).
- [x] Invoice: changing the purchase date updates an untouched expiry and leaves
      a touched one alone; changing the product does the same; a regression test
      pins the dirty-date rule. `applyWarrantyPrefill` is the one rule, called
      from the purchase-date change; a line without the field is untouched, and
      a quantity change never re-derives.
- [x] Invoice: an expiry before the purchase date is refused (client and API);
      a quantity-only line creates no coverage. The API refusal is the same
      `warrantyDateError` the edit endpoint uses, and it writes neither the
      invoice nor a row.
- [x] Receipt writes one VENDOR row per received serial with the invoice source
      and supplier; a rolled-back receipt leaves none. Proven over HTTP against
      PostgreSQL, including the 24-month product prefill, an explicit contract
      date that wins, and a duplicate-serial receipt that rolls back the unit it
      had already planned to cover.
- [x] Purchase return supersedes exactly the rows from that invoice, leaving
      other purchases current. `applyPurchaseReturnEffects` retires the
      invoice's VENDOR rows in the same transaction as the stock deduction.
- [x] Fixed asset create/edit writes/updates one current VENDOR row keyed by tag;
      disposal supersedes it; `npx tsc --noEmit` clean. The modal captures the
      expiry (dirty-tracked against the acquisition date), create writes it with
      the asset in one transaction, re-saving the asset supersedes the prior
      period, and `PATCH :id/status DISPOSED` retires the current row. Assets
      consumed from stock are not keyed twice: their units already carry the
      purchase invoice's coverage.

## Verified locally (2026-10-28)

- `npx tsc --noEmit` — clean.
- `npx tsx --test tests/warrantyCapture.test.ts
  tests/purchaseWarrantyCapture.api.test.ts tests/fixedAssetWarranty.api.test.ts
  tests/fixedAssetWarrantyForm.test.ts` — **17 tests, 17 pass, 0 fail**: 5
  prefill/validation, 6 invoice capture, 5 fixed-asset API, 1 asset-modal render
  test (the untouched expiry follows the acquisition date, a typed one does
  not).
- The receipt tests assert the stored row (type, category, branch, supplier,
  source document, start, exact expiry, term snapshot, current flag), a return
  that leaves another purchase current, and a failed receipt that leaves no
  invoice and no coverage.
- `tests/serialRegister.service.test.ts` was updated for the new `lineIndex` on
  a planned serial entry (the invoice needs it to bind a unit to its own line's
  expiry); its full suite is green.
- Full `npm test` — **1532 tests, 1530 pass, 0 fail, 2 Windows-only skips**;
  docs-count gate green at 1532; `npx tsc --noEmit` clean.

## Implementation notes

- `shared/` arithmetic is reused; the browser prefill lives in
  `client/src/utils/warrantyCapture.ts` so the invoice and asset modal cannot
  drift.
- `buildPurchaseWarrantyCaptures` (warranty.service) is pure: it validates the
  typed expiry against the invoice date and snapshots the product's term.
- `warranty_coverages` rows keep the one-current-per-unit invariant through the
  existing supersede statements; a new `WARRANTY_SUPERSEDE_BY_ASSET_SQL` retires
  a disposed asset's supplier row.

## Out of scope

Seller coverage (WTY-5) and the registers (WTY-6). Claims/RMA stays parked.
