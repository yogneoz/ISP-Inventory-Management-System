# WTY-1 — warranty term arithmetic, schema and the coverage record

Status: `[x]` done (2026-10-28) · `7b93e6f` · Started 2026-10-28 · Round 9
Order: 1 · Depends on: none. Blocks every other WTY item.

## Why

Today the app stores **no** warranty data. `server/src/models/inventory.repo.ts`
computes `issued_date_ad + 12 months` for CPE
([`WARRANTY_MONTHS = 12`](../../server/src/models/inventory.repo.ts#L920)) and
`acquisition_date_ad + 12 months` for fixed assets, and the one directory screen
unions the two and calls the result "Warranty Valid Products". There is no
vendor term on a purchase, no seller term on an issue, no product default, no
per-unit history and no audited correction path. `warrantyMonths` on the client
device type is dead — the API never writes it.

The visible symptom (screenshot, 2026-10-28): the directory showed
*Total 3 / Expired 3* but an empty table, because its default filter is
`VALID` and every seeded asset was acquired 2024-04-15. The live database
confirmed the screen was reading correctly; the data and the model were the
problem.

## Decision (ERP research, 2026-10-28)

Mainstream ERPs persist a term **and** the resulting dates, and keep supplier
and customer warranty separate: SAP warranty types with counters and equipment
dates, Oracle coverage duration + contract start/end/expiration, NetSuite
calculated/fixed/lifetime terms with a stored expiration, Dynamics asset
warranty start/end, ERPNext warranty period in days + serial expiry date.

**Capture the exact expiry date.** Store `start_date_ad`, `end_date_ad`
(authoritative) and `term_months` (the snapshot used to prefill/derive), plus
`start_basis`. A shared calendar-month helper clamps month-end (31 Jan + 1 month
→ 28/29 Feb) so client and server cannot disagree. Changing a product default
never rewrites existing coverage.

## Scope

- `shared/warrantyTerm.ts` — the one date rule both sides import:
  `isAdDate`, `addCalendarMonths` (month-end clamp), `defaultWarrantyEnd`,
  `isValidWarrantyRange`, `warrantyDaysRemaining`, `warrantyStateFor`
  (`VALID` > 30 days, `EXPIRING_SOON` 0–30, `EXPIRED` < 0), `warrantyStatusLabel`,
  `DEFAULT_WARRANTY_MONTHS = 12`, `MAX_WARRANTY_MONTHS = 120`,
  `EXPIRING_SOON_DAYS = 30`.
- `client/src/types/index.ts` — `WarrantyCoverageType`, `WarrantyItemCategory`,
  `WarrantyStartBasis`, `WarrantyCoverageRecord`, `WarrantyCoverageRow`,
  `WarrantyRegisterPage`; `Product.vendorWarrantyMonths` /
  `sellerWarrantyMonths`.
- `scripts/schema.sql` — new `warranty_coverages` table (the 38th) and the
  `products` defaults, created for fresh databases and `ALTER ... IF NOT EXISTS`
  for existing ones.
- `server/src/state/runtimeState.ts` — the demo-mode mirror
  (`warrantyCoverages` / `setWarrantyCoverages`), deliberately **not** a
  bootstrap or cache slice.
- Idempotent legacy backfill flagged `LEGACY_12_MONTH`: one VENDOR row per
  fixed asset (`acquisition_date_ad + 12 months`) and one SELLER row per CPE
  device (`issued_date_ad + 12 months`), skipped where a current row already
  exists.

## Data model

`warranty_coverages` — one row per coverage period:

- `coverage_type` `VENDOR | SELLER`
- `item_category` `CPE | FIXED_ASSET | SOLD_PRODUCT`
- `product_id`, `product_name`, `serial_number` (normalised upper)
- `asset_id`, `device_record_id`, `branch_id`
- `party_id`, `party_name` — supplier or customer
- `source_type`, `source_id`, `source_number`
- `start_date_ad`, `end_date_ad`, `term_months`, `start_basis`
  (`INVOICE_DATE | ACQUISITION_DATE | ISSUE_DATE | SALE_DATE | LEGACY_12_MONTH | MANUAL`)
- `notes`, `is_current`, `superseded_at`, `is_demo`, audit columns
- `CHECK (end_date_ad >= start_date_ad)`, term `0..120`
- unique current coverage per `(coverage_type, serial_number) WHERE is_current`;
  reissue/receipt supersedes the previous row in the same transaction instead
  of overwriting history
- indexes on `(coverage_type, is_current, end_date_ad)` and
  `(branch_id, coverage_type, is_current, end_date_ad)`

`products` gains `vendor_warranty_months` and `seller_warranty_months`
(`INT NOT NULL DEFAULT 12`, `0` = no warranty) as **defaults only**.

Why a table, not columns: both registers need one source, direct sales have no
customer-device row to hang a column on, and exchanges/reissues need period
history.

## Acceptance checklist

- [x] `shared/warrantyTerm.ts` clamps month-end (31 Jan + 1 → 28/29 Feb), rejects
      invalid dates/terms, and `warrantyStateFor` matches the 30-day rule; a
      focused suite covers the boundary days (`tests/warrantyTerm.test.ts`).
- [x] The schema adds the table and both product columns for a fresh database
      **and** for a pre-existing one; the schema parity/drift guards pass.
- [x] The partial unique index allows one current row per type + serial and the
      backfill is idempotent (second run inserts nothing, existing current rows
      are respected).
- [x] The demo mirror exists and is not part of `BOOTSTRAP_TABLES`, `CACHE_LOADS`
      or any slice; the payload guards stay green.
- [x] `npx tsc --noEmit` clean.

## Verified locally (2026-10-28)

- `npx tsc --noEmit` clean.
- `tests/warrantyTerm.test.ts`, `tests/warrantySchema.guard.test.ts` and
  `tests/schemaSource.parity.test.ts`: **20 tests, 20 pass, 0 fail**.
- `tests/schema.drift.guard.test.ts`: **2 pass** against the live PostgreSQL
  (the table and both product columns exist in both the file and the database).
- Applying `scripts/schema.sql` twice to the live database left the coverage
  count at **3 → 3 → 3** with **0 duplicate current rows**, proving the backfill
  is re-runnable.

## Out of scope

The capture paths (WTY-4/5), the registers (WTY-6), demo seed data (WTY-7) and
docs (WTY-8). Claims/RMA stays parked.
