# WTY-5 — capture what we promise the customer

Status: `[ ]` not started · Round 9
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
sale date may change before submit); end ≥ start; `0` months means no coverage
row and the screen says "No warranty"; validation is identical client and API.

## Acceptance checklist

- [ ] Assignment writes exactly one SELLER row per serial with the customer,
      branch, device record and assignment source; a failed assignment leaves
      none.
- [ ] Product sale writes one row per sold serial with the sales-invoice source;
      an exchange creates a row for the new serial and supersedes the old one;
      collection/refund leaves no current SELLER row for that device.
- [ ] Prefill = start + the product's seller term for 12, 0 and 24; a touched
      expiry survives an issue/sale date change (regression test).
- [ ] The customer-device badge and register read the stored coverage and the
      old `issued_date + 12` computation is gone from the read path.
- [ ] `npx tsc --noEmit` clean; existing exchange/unassign/sale suites green.

## Out of scope

Vendor coverage (WTY-4), the two new registers (WTY-6), and warranty claims/RMA.
