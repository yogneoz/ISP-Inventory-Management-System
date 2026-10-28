# WTY-3 — product warranty defaults

Status: `[x]` done (2026-10-28) · `cf84fa1` · Started 2026-10-28 · Round 9
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

- [x] Create without terms stores 12/12; explicit 0 stores 0; 24 stores 24.
      `tests/productWarranty.api.test.ts` reads the row back from PostgreSQL and
      the catalog endpoint, so the defaults are proven through the real HTTP
      surface, not just the handler.
- [x] `1.5`, `-1`, `121`, `"abc"` each return 400 and change nothing — on
      create every bad term is refused with a message naming the 0–120 range and
      leaves no product row; on edit each refusal leaves the stored row
      byte-identical.
- [x] Edit with one term omitted keeps that column's stored value; edit updates
      both when supplied. `null`/`''` on edit means "keep", never "reset to
      12" — the regression the missing column mapping would have caused.
- [x] The product modal shows both fields with the stored values, explains 0,
      and refuses an out-of-range entry client-side before the request.
      `tests/productWarrantyForm.test.ts` mounts the real screen: a new SKU
      starts at 12/12; editing loads 24/0; entering 121 blocks the submit with a
      field-named alert and no API call; correcting to 3 submits once with both
      terms in the payload (including the 0) and closes the modal.
- [x] Existing product tests and the master-data guards stay green;
      `npx tsc --noEmit` clean.

## Verified locally (2026-10-28)

- `npx tsc --noEmit` — clean.
- `tests/productWarranty.api.test.ts` (6) + `tests/productWarrantyForm.test.ts`
  (2) — **8 tests, 8 pass, 0 fail**.
- `tests/masterdata.repo.test.ts` (28 tests) — green after the product cache
  mapping and the 17-param `productUpdateParams` contract were updated; the
  added assertion proves an explicit `0` survives the update params instead of
  being coerced to the 12-month default.
- Full `npm test` — **1515 tests, 1513 pass, 0 fail, 2 Windows-only skips**,
  docs-count gate at 1515 after this slice's doc bump.

## Out of scope

Using the defaults to create coverage (WTY-4/5) and any retroactive rewrite of
existing coverage.
