# WTY-7 — demo coverage, backfill proof and the clear order

Status: `[x]` 2026-10-29 · Commit `7c56a6c` · Round 9
Order: 7 · Depends on WTY-1/4/5.

## Why

The screenshot's empty register was partly a data problem: every seeded asset
was acquired on one old date, so all three rows were expired and the old screen
default-filtered them away. A demo database has to exercise both sides and all
three states, with dates relative to the seed run so the fixture does not rot.
The clear path must also remove coverage rows or re-seeding leaves orphans.

## Scope

- Seed VENDOR rows for purchased serials and fixed assets, and SELLER rows for
  issued/sold serials, with a deliberate spread: **valid** (expiry well ahead),
  **expiring** (inside 30 days) and **expired** (behind today), on both sides,
  using `seedData` helpers so every date is derived from the run date.
- Seed at least one product with a 0-month term and one with 24 months so the
  product-default UI is demonstrable.
- Add `warranty_coverages` to the demo-data clear order (child of products /
  assets / device records) and to the seeded-table count.
- Verify the legacy backfill on an existing database: run the schema twice, then
  confirm it remains idempotent and marks the rows `LEGACY_12_MONTH`; confirm it
  skips a row already superseded by capture.
- Confirm clearing demo data and re-seeding yields exactly one current row per
  type + serial (no duplicate-current violation).

## Acceptance checklist

- [x] A fresh demo seed shows non-zero valid, expiring and expired counts on
      **both** registers, and no row's state disagrees with its expiry.
- [x] Seed dates are computed from the run date (no fixed 2024 timestamps).
- [x] Clear-demo removes coverage rows before their parents and re-seeding is
      clean; the demo-clear test suite covers the order.
- [x] The schema can be applied twice on an existing database with the backfill
      producing no duplicates and preserving operator-corrected rows.
- [x] `npm run seed` / the documented demo reset still completes.

## What changed

- `scripts/demo_dataset.js` — run-date helpers (`shiftDays`,
  `addMonthsClamped`, `bsLabel` from the single BS calendar) and 8 coverage
  rows: 3 fixed-asset VENDOR rows acquired -420/-340/-30 days (expired /
  expiring / valid on the 12-month term), 2 purchased ONU VENDOR rows (24
  months from the purchase invoice date) and 3 SELLER rows for units sold 60
  days ago (24-month valid, 20-days-out expiring, 5-days-ago expired).
  Fixed-asset acquisition dates (and their serial history) now move with the
  seed run instead of freezing on 2024-04-15; the BS labels are derived from
  `shared/bsCalendarYears.json`.
- Product defaults: `SPL001` is 0/0 months, `ONU001` is 24/24, everything else
  stays 12/12, and `setup_db.js` now writes `vendor_warranty_months` /
  `seller_warranty_months` on the product insert.
- `scripts/setup_db.js` — inserts the coverage fixture after its FK targets
  with a targetless `ON CONFLICT DO NOTHING`, and counts it in the demo
  summary.
- `server/src/models/admin.repo.ts` — `warranty_coverages` is the FIRST demo
  table cleared, before products, fixed assets, serials and device records.

## Gate evidence (2026-10-29) — committed as `7c56a6c`

- `npx tsc --noEmit` — clean.
- New `tests/demoWarrantySeed.test.ts` — the fixture tests plus the live
  backfill test: **8/8 pass**. The seeded suite (with `admin.repo.test.ts`) is
  **54/54**; the backfill test extracts the three real INSERTs from
  `scripts/schema.sql`, runs them twice in a rolled-back transaction, and
  asserts `LEGACY_12_MONTH` / 12 months for an uncovered asset, no second row
  on the second apply, and the operator's `MANUAL` 36-month row preserved.
- Full `npm test` — **1567 tests, 1565 pass, 0 fail, 2 Windows-only skips**
  (the new suite is included); `npx tsc --noEmit` clean.
- Throwaway `inventory_wty7_check` database, fresh `node scripts/setup_db.js`:
  `warranty_coverages 8`; VENDOR **expired 1 / expiring 1 / valid 3**, SELLER
  **1 / 1 / 1**; **0** duplicate current rows; `ONU001` 24/24 and `SPL001`
  0/0.
- The REAL `POST /api/admin/clear-demo-data` controller against that scratch
  DB removed `warranty_coverages: 8` first (products 14 / assets 3 / serials 13
  in the same response, total 111). Re-running the documented seed afterwards
  produced the same 8 rows, all three states on both registers and **0**
  duplicate current rows.
- Re-applying `scripts/schema.sql` after a demo seed: coverage count **8 → 8**,
  `LEGACY_12_MONTH` rows **0 → 0**, duplicate current rows **0** — the legacy
  backfill ignores the captured demo units rather than shadowing them.
- Docs-count gate updated to the real 1567 suite size.

## Out of scope

Production data migration beyond the idempotent backfill, and claims/RMA demo
records.
