# Warranty recovery follow-up — task note

**Status:** Done
**Created:** 2026-11-11
**Updated:** 2026-11-11

## Goal

Close the recovery loop after a warranty claim leaves the branch: show which
vendor RMAs are still outstanding, which expected credits are still short, and
whether the vendor credit the claim says it received was actually posted to AP.
The view must reuse the existing claims and ledger, not create a second credit
record.

## Delivered

- `shared/warrantyRecovery.ts` owns the read-only rules: RMA age/buckets
  (`0–7`, `8–14`, `15–30`, `31+`), the cents-safe credit shortfall, recovery
  state labels, and `warrantyRecoveryState()`:
  - a shortfall with nothing received is `PENDING`;
  - a shortfall after a partial receipt is `PARTIAL`;
  - a fully received credit with no linked journal, or a linked journal whose
    AP debit differs from the received amount, is `POSTING_MISMATCH`;
  - a fully received and matching credit is `RECONCILED`;
  - no expected or received credit is `NONE`.
- `server/src/models/warrantyClaim.repo.ts` adds paged, count, summary, RMA
  aging and vendor-grouped recovery queries. Recovery is derived from
  `warranty_claims` plus the debit side of the linked `gl_journal_lines`; the
  claim header remains the authority for expected/received credit and the
  journal remains the authority for what was actually posted. No recovery table
  or duplicated credit field was added.
- `server/src/controllers/warrantyClaim.controller.ts` exposes
  `GET /api/warranty-claims/recovery` with branch scope, coverage side, search,
  `onlyShortfall`, `outstandingRma`, paging and the existing `warranty-view`
  permission. It is registered before `/:id` so the path cannot be captured as
  a claim id.
- `client/src/services/api/warrantyClaims.ts` and the API barrel expose the
  typed recovery query/page.
- `client/src/components/inventory/warranty/WarrantyRecoveryPanel.tsx` adds the
  read-only **Recovery** tab inside both existing warranty registers. It shows
  expected/received/posted/shortfall KPIs, a reconciliation banner, RMA aging
  buckets, vendor recovery totals, a filtered/paged recovery queue and the
  `POSTING_MISMATCH`/`PARTIAL`/`PENDING`/`RECONCILED` state.
- Two supporting indexes in `scripts/schema.sql`:
  `idx_warranty_claim_recovery_rma` and
  `idx_warranty_claim_recovery_credit`.

## Acceptance criteria

- **Outstanding RMA aging is visible and exact.** The summary's outstanding
  count, age and bucket come from the claim's `SENT_TO_VENDOR` state and
  `sent_to_vendor_date_ad`; resolved claims return no RMA age.
- **Expected, received and posted credit stay distinct.** The page returns all
  three plus the derived shortfall; the AP figure is the debit total of the
  linked journal, not a value copied onto the claim.
- **Partial and posting-mismatch recoveries are distinguishable.** The shared
  state function and API response expose `PARTIAL` and `POSTING_MISMATCH`
  separately.
- **One branch's recovery cannot leak into another's.** The route reuses the
  claims branch resolver; a branch user requesting another branch gets 403 and
  an unaffiliated account gets an empty page.
- **The register, not a new top-level route, owns the workflow.** The Recovery
  tab is mounted in the existing Suppliers/Sellers Warranty registers.
- **Read-only.** There is no recovery write endpoint. Claim transitions and
  journals remain the only mutation paths.

## Verification

- `NODE_ENV=test npx tsx --test tests/warrantyClaims.api.test.ts` — 5/5 pass
  over real HTTP and a throwaway PostgreSQL database. The recovery case proves
  expected 3,200 / received 500 / posted 500 / shortfall 2,700, one outstanding
  RMA, no posting exceptions, a partial credit row, branch 403/ALL isolation,
  paging, both filters and the unauthenticated 401.
- `NODE_ENV=test npx tsx --test tests/warrantyClaims.ui.test.ts` — 2/2 pass:
  the existing claims tab plus the new Recovery tab with aging, vendor recovery,
  queue and `Partial credit`.
- `npx tsc --noEmit` — clean. `tests/uiUxSweep20261030.test.ts` — 4/4 pass,
  including the 10 px type floor that caught the panel's initial 9 px label.
- Schema drift/source, branch-scope, BS-date and the rest of the guard suite are
  included in the full run below.
- `NODE_ENV=test npm test` — 2,148 tests across 483 suites, 2,146 pass, 2
  Windows-only real-signal skips, 0 fail, exit 0; the docs-count gate matched
  2148.
- Current-code dev server on port 3000 (restarted after this slice):
  `/api/health` 200; unauthenticated `GET /api/warranty-claims/recovery` 401;
  authenticated `GET /api/warranty-claims/recovery?page=1&pageSize=2` 200 with
  the expected empty paged envelope and zero summary; the served
  `WarrantyRegister.tsx` module 200 and contains `WarrantyRecoveryPanel` and the
  `RECOVERY`/`Recovery` tab. Both recovery indexes exist on the local database
  and no probe listener remains on port 3101.

## Next action

No work remains for this slice. A vendor portal or automated recovery write-off
would need its own initiative.
