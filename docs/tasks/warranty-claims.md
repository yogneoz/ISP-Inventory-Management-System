# Warranty claims/RMA lifecycle — task note

**Status:** Done
**Created:** 2026-11-08
**Updated:** 2026-11-11

## Goal

Track a warranty claim from customer report through vendor recovery, replacement
or credit, with stock and ledger consequences.

## Delivered

- `scripts/schema.sql` section 17a-1 adds `warranty_claims` and
  `warranty_claim_events` (95 tables in the schema). A partial unique index
  allows one open claim per `(coverage_type, serial_number)` and the status
  columns carry the same CHECK constraint as the shared state machine.
- `shared/warrantyClaim.ts` owns the states, labels and transitions:
  `REPORTED → APPROVED/REJECTED → SENT_TO_VENDOR → REPLACED/REPAIRED/CREDITED
  → CLOSED`. A client can only present edges the server accepts; `REJECTED`
  and `CLOSED` are terminal.
- `server/src/models/warrantyClaim.repo.ts` provides the paged register,
  detail/raw row with `FOR UPDATE`, open-unit lookup, event timeline and the
  vendor-credit journal tie-out.
- `server/src/services/warrantyClaim.service.ts` performs every transition in
  the caller's transaction:
  - `SENT_TO_VENDOR` moves the reported serial to `RETURNED_TO_VENDOR` and
    stores the RMA reference/date.
  - `REPLACED` reserves an `IN_STOCK` serial in the same branch, consumes
    exactly one stock unit, writes one `STOCK_OUT` transaction, and assigns the
    replacement to the claim customer.
  - `REPAIRED` returns exactly one unit to branch stock and moves the serial to
    `IN_STOCK`.
  - `CREDITED` records the received credit and, when requested, posts a
    `WARRANTY_RECOVERY` journal Dr `AP_CONTROL` / Cr `STOCK_EXPENSE`; the claim
    stores the journal id and the detail exposes the posted/reconciled amount.
  - `CLOSED` is only reachable after a resolution; every transition appends a
    timeline event with actor, note and date.
- `server/src/controllers/warrantyClaim.controller.ts` and
  `server/src/routes/warranty.routes.ts` expose the register (`GET
  /api/warranty-claims`), detail (`GET /api/warranty-claims/:id`), create and
  transition endpoints under `warranty-view` / `warranty-edit`, with branch
  scope and audit logging.
- `client/src/features/inventory/warranty/WarrantyRegister.tsx` mounts a
  **Claims / RMA** tab in both the Suppliers and Sellers Warranty registers.
  `client/src/components/inventory/warranty/WarrantyClaimsPanel.tsx` provides
  the claim KPIs, search/status/open filters, SLA age, paging, detail timeline,
  vendor recovery card, create form and next-transition forms.
- `DEMO_DATA_TABLES` clears `warranty_claims` before `warranty_coverages`, so a
  demo cleanup cannot orphan claims or hide them behind an FK cascade.

## Out of scope

- Vendor portal and automated RMA shipping labels.
- Warranty cost accrual accounting (separate finance decision).

## Acceptance criteria

- **One open claim per serial/coverage.** Met by the partial unique index and
  the service's pre-check; a duplicate create returns 409 and the API test
  proves no second row is written.
- **Every state change is audited and visible.** Met: each transition writes
  `warranty_claim_events` in the same transaction, and the detail response
  returns the ordered timeline; the API test asserts the reported event and
  the UI test renders it.
- **Replacement reduces stock exactly once.** Met: the replacement path locks
  the stock row, refuses an existing `txn-warranty-replace-<claim>` ledger, and
  writes one `STOCK_OUT` row. The API test asserts quantity −1 and the ledger
  quantity −1.
- **Closing without resolution is refused.** Met by the shared transition table
  and a 409 response; the API test asserts the refusal for a `REPORTED` claim.
- **Claim totals reconcile to any vendor credit posted.** Met by
  `WARRANTY_CLAIM_CREDIT_JOURNAL_SQL`; the API test asserts a 500 debit and 500
  credit journal, `reconciled: true`, and the linked journal number.
- **Register + detail with filters and SLA.** Met by the mounted Claims tab:
  the UI test asserts the vendor-side query, searchable register, `9d` SLA,
  detail timeline and the APPROVED/REJECTED next actions.

## Verification

- Schema applied to the local PostgreSQL; `tests/schema.drift.guard.test.ts`
  reports 95 tables, `tests/schemaSource.parity.test.ts` reports 95 tables and
  `tests/financeBsDateWriteGuard.test.ts` is clean.
- `NODE_ENV=test npx tsx --test tests/warrantyClaims.api.test.ts` — 4/4 pass
  over real HTTP and a throwaway PostgreSQL database:
  duplicate open refusal/event timeline; replacement exactly once and RMA
  bucket; repair return and a balanced/reconciled vendor-credit journal; branch
  scope, permissions and status filters.
- `NODE_ENV=test npx tsx --test tests/warrantyClaims.ui.test.ts` — 1/1 pass:
  Claims / RMA tab, vendor-side query, SLA, detail timeline and transitions.
- `NODE_ENV=test npx tsx --test tests/admin.repo.test.ts` — 46/46 pass,
  including demo-clear order for claims before coverages.
- `npx tsc --noEmit` — clean.
- `NODE_ENV=test npm test` — 2,146 tests across 483 suites, 2,144 pass,
  2 Windows-only real-signal skips, 0 fail, exit 0; the docs-count gate matched
  2146.
- Current-code dev server on port 3000 (restarted 2026-11-11): `GET
  /api/warranty-claims?branchId=ALL&page=1&pageSize=1` returned 200 with an
  authenticated probe token and an empty claim page; the unauthenticated route
  returned 401. The served `WarrantyRegister.tsx` module contains the
  `Claims / RMA` tab and `WarrantyClaimsPanel`; only ports 3000 and Vite's HMR
  24678 are listening.

## Next action

No work remains for this slice. A vendor portal or automated RMA labels would
need their own initiative.
