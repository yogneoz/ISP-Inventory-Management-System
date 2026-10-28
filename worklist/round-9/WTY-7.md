# WTY-7 — demo coverage, backfill proof and the clear order

Status: `[ ]` not started · Round 9
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

- [ ] A fresh demo seed shows non-zero valid, expiring and expired counts on
      **both** registers, and no row's state disagrees with its expiry.
- [ ] Seed dates are computed from the run date (no fixed 2024 timestamps).
- [ ] Clear-demo removes coverage rows before their parents and re-seeding is
      clean; the demo-clear test suite covers the order.
- [ ] The schema can be applied twice on an existing database with the backfill
      producing no duplicates and preserving operator-corrected rows.
- [ ] `npm run seed` / the documented demo reset still completes.

## Out of scope

Production data migration beyond the idempotent backfill, and claims/RMA demo
records.
