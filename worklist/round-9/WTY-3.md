# WTY-3 — product warranty defaults

Status: `[~]` in progress (scaffold on disk, no gates run) · Started 2026-10-28 · Round 9
Order: 3 · Depends on WTY-1 (columns + types); feeds WTY-4 and WTY-5.

## Why

Every capture screen prefills an expiry. Without a per-product default the
prefill would fall back to one hard-coded 12 months again — the exact coupling
this round removes. The defaults are **defaults only**: a created coverage
snapshots its term, so a later product edit never rewrites history.

## Scope

- `server/src/controllers/masterdata.controller.ts` — `POST /api/products` and
  `PUT /api/products/:id` accept `vendorWarrantyMonths` and
  `sellerWarrantyMonths`. Whole months only, `0..120`; `0` means no warranty.
  Missing on create → 12; missing on edit → keep the stored value. Anything
  non-integer, negative or > 120 is a 400 naming the field, never a silent
  clamp. Persisted through `productUpdateParams` /
  `PRODUCT_INSERT` builders.
- `client/src/features/inventory/ProductManagement.tsx` — two number fields in
  the product modal (Supplier warranty months / Seller warranty months, 0–120,
  helper text explaining 0), prefilled to 12 on create, shown on edit, validated
  before submit, and present in the payload for both create and edit.
- API/repo tests for the validation matrix and the round-trip; a render test
  that the fields load with the stored values and block a bad term.

## Acceptance checklist

- [ ] Create without terms stores 12/12; explicit 0 stores 0; 24 stores 24.
- [ ] `1.5`, `-1`, `121`, `"abc"` each return 400 and change nothing.
- [ ] Edit with one term omitted keeps that column's stored value; edit updates
      both when supplied.
- [ ] The product modal shows both fields with the stored values, explains 0,
      and refuses an out-of-range entry client-side before the request.
- [ ] Existing product tests and the master-data guards stay green;
      `npx tsc --noEmit` clean.

## Out of scope

Using the defaults to create coverage (WTY-4/5) and any retroactive rewrite of
existing coverage.
