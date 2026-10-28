# WTY-4 — capture what the supplier owes us

Status: `[ ]` not started · Round 9
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

- [ ] Invoice: the prefilled expiry equals purchase date + the product's vendor
      term for 12, 0 and 24 months; a 31 Jan start lands on the clamped
      month-end.
- [ ] Invoice: changing the purchase date updates an untouched expiry and leaves
      a touched one alone; changing the product does the same; a regression test
      pins the dirty-date rule.
- [ ] Invoice: an expiry before the purchase date is refused (client and API);
      a quantity-only line creates no coverage.
- [ ] Receipt writes one VENDOR row per received serial with the invoice source
      and supplier; a rolled-back receipt leaves none.
- [ ] Purchase return supersedes exactly the rows from that invoice, leaving
      other purchases current.
- [ ] Fixed asset create/edit writes/updates one current VENDOR row keyed by tag;
      disposal supersedes it; `npx tsc --noEmit` clean.

## Out of scope

Seller coverage (WTY-5) and the registers (WTY-6). Claims/RMA stays parked.
